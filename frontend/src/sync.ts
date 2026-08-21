import { api, ApiError, isRetryable } from "./api";
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
 * Send everything queued for this event, oldest first.
 *
 * Stops at the first transport failure — the network went away again, and the
 * rest of the queue keeps its place in line.
 *
 * Entries belonging to another event are stepped over rather than sent: this
 * till was switched, and posting them here would file a sale against the wrong
 * event. They used to *stop* the drain, which meant one stranded entry at the
 * head held every later sale hostage — with a badge counting them and a "send
 * now" button that reported nothing and explained less. They are counted in the
 * report instead, so the operator is told what is waiting and what for.
 */
export async function drainQueue(pairing: Pairing): Promise<SyncReport> {
  const report: SyncReport = {
    sales: 0, checkins: 0, failed: 0, stranded: 0, offTariff: [], contested: [],
  };
  // Ids the server has already been asked about in this run. The queue is
  // re-read from storage on every turn — a sale made while the drain is running
  // appends to it — and without this the entry just handed over would be
  // offered again by the next read.
  const attempted = new Set<string>();

  for (;;) {
    // Oldest entry of this event that has not been through the loop yet.
    const entry = loadQueue().find(
      (candidate) => candidate.event === pairing.event && !attempted.has(candidate.id),
    );
    if (!entry) break;
    attempted.add(entry.id);

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

    // Re-read rather than trusting an earlier copy, for the same reason.
    saveQueue(loadQueue().filter((queued) => queued.id !== entry.id));
  }

  report.stranded = loadQueue().filter((queued) => queued.event !== pairing.event).length;
  return report;
}
