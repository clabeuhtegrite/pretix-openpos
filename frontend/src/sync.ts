import { api, ApiError } from "./api";
import { isOnline } from "./connectivity";
import { loadFailures, loadQueue, saveFailures, saveQueue } from "./storage";
import type { Pairing, QueueEntry, SyncReport } from "./types";

/**
 * Draining what the till recorded while it had no network.
 *
 * Three rules, and everything else follows from them.
 *
 * **In order, one at a time.** The journal is a chain and the takings are read
 * in sequence; replaying a night in parallel would scramble both for no gain on
 * a queue this size.
 *
 * **Only remove what the server has taken.** Every entry carries the key that
 * makes it idempotent — an idempotency key for a sale, a nonce for a scan — so
 * a reply lost on the way back costs a duplicate request, never a duplicate
 * sale. An entry is dropped from the queue when, and only when, the server has
 * answered for it.
 *
 * **Never drop a refusal silently.** A sale the server will not accept is the
 * one thing an operator has to hear about, so it moves to a failures list that
 * survives restarts and is shown until someone has dealt with it.
 */

/**
 * Whether this failure means "not now" rather than "no".
 *
 * The distinction is the whole safety of the queue. A transport failure or any
 * fault from the server means the entry was not processed — or that we cannot
 * know, which comes to the same thing because every entry is idempotent — so it
 * keeps its place in line. Only a 4xx is the server understanding and refusing,
 * and that is the one case where retrying forever would hide a problem instead
 * of solving it.
 *
 * Getting this wrong in the lenient direction costs a duplicate request. Getting
 * it wrong the other way takes a paid sale out of the queue and it never
 * reaches pretix at all — which is exactly what an early version of this did.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.isNetwork || error.status >= 500);
}

async function replaySale(pairing: Pairing, entry: QueueEntry & { kind: "sale" }, report: SyncReport) {
  const result = await api.checkout(pairing, {
    idempotency_key: entry.id,
    positions: entry.positions,
    payment_type: entry.paymentType,
    cash_given: entry.cashGiven,
    cashier: entry.cashier,
    offline: { recorded_at: entry.at, charged_total: entry.chargedTotal },
  });
  report.sales += 1;
  for (const line of result.off_tariff ?? []) {
    report.offTariff.push({ order: result.order.code, ...line });
  }
}

async function replayCheckin(
  pairing: Pairing,
  entry: QueueEntry & { kind: "checkin" },
  report: SyncReport,
) {
  const result = await api.redeem(pairing, {
    secret: entry.secret,
    lists: [entry.list],
    // The same nonce the scan was made with, so pretix recognises a replay
    // rather than recording the person twice.
    nonce: entry.id,
    // And the moment it happened, so the door's history is the door's history.
    datetime: entry.at,
  });
  report.checkins += 1;
  if (result.status !== "ok") {
    // Admitted at the door on the strength of the snapshot, refused now: the
    // ticket was used elsewhere, or revoked after the snapshot was taken. The
    // person is inside either way — this is for the organiser to know about.
    report.contested.push({
      name: entry.name || entry.secret.slice(0, 8),
      secret: entry.secret,
      reason: result.reason ?? result.status,
    });
  }
}

/**
 * Send everything queued, oldest first.
 *
 * Stops at the first transport failure — the network went away again, and the
 * rest of the queue keeps its place in line.
 */
export async function drainQueue(pairing: Pairing): Promise<SyncReport> {
  const report: SyncReport = { sales: 0, checkins: 0, failed: 0, offTariff: [], contested: [] };
  let queue = loadQueue();

  while (queue.length > 0) {
    const [entry] = queue;
    if (entry.event !== pairing.event) {
      // Queued for another event on this same till. Left alone rather than
      // sent to the wrong one; switching back is what will drain it.
      break;
    }

    try {
      if (entry.kind === "sale") await replaySale(pairing, entry, report);
      else await replayCheckin(pairing, entry, report);
    } catch (error) {
      if (isRetryable(error)) break;
      // A refusal with a reason: the server has spoken, so this entry will not
      // improve by being retried. Out of the queue and into the report.
      report.failed += 1;
      saveFailures([
        ...loadFailures(),
        {
          entry,
          at: new Date().toISOString(),
          message: error instanceof ApiError ? error.message : String(error),
        },
      ]);
    }

    // Re-read rather than trusting our copy: a sale made during the drain has
    // been appended to the stored queue in the meantime.
    queue = loadQueue().filter((q) => q.id !== entry.id);
    saveQueue(queue);
  }

  return report;
}

/** True when there is something to send and somewhere to send it. */
export function hasPending(): boolean {
  return loadQueue().length > 0;
}

export function canSync(): boolean {
  return isOnline() && hasPending();
}
