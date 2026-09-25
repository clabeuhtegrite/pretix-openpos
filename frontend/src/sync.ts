import { ApiError, api, isRefusal, isRetryable, isThrottled } from "./api";
import { countSent } from "./doorCount";
import { describeError } from "./errors";
import { t } from "./i18n";
import { addFailure, loadQueue, saveLastSync, saveQueue } from "./storage";
import type { Pairing, QueueEntry, SyncHalt, SyncReport } from "./types";

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
 *
 * And a refusal is narrow: the server turning down *this* entry, with its
 * reasons (see ``isRefusal``). Everything else it can answer — the device
 * refused, an address that is not there, "not now" — stops the run and keeps
 * the whole queue as it was. A revoked tablet used to file every sale it held
 * as refused, one by one, and had nothing left to send once it was paired
 * again.
 */

/**
 * How long a run waits after "not now" when the server did not say how long.
 *
 * The same quarter of a minute as the till's own retry, so a rate limit with
 * no ``Retry-After`` costs nothing more than the next ordinary try.
 */
export const THROTTLED_WAIT_MS = 15_000;

async function replaySale(pairing: Pairing, entry: QueueEntry & { kind: "sale" }, report: SyncReport) {
  const result = await api.checkout(pairing, {
    idempotency_key: entry.id,
    positions: entry.positions,
    payment_type: entry.paymentType,
    cash_given: entry.cashGiven,
    cashier: entry.cashier,
    offline: {
      recorded_at: entry.at,
      charged_total: entry.linesTotal ?? entry.chargedTotal,
      // This device's clock now, beside its clock then: the server sets the
      // two against its own and corrects ``recorded_at`` by the difference,
      // so a tablet whose clock is off still files its sales in the right
      // evening — and no longer has them refused as dated in the future.
      sent_at: new Date().toISOString(),
    },
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
  if (entry.refused) {
    // Turned away at the door. pretix is told as it is told of any refusal a
    // scanning app made offline, so its history has the ticket, the moment and
    // the reason — the trace an online scan would have left by itself.
    await api.reportRefusal(pairing, {
      event: entry.event,
      list: entry.list,
      secret: entry.secret,
      reason: entry.refused,
      explanation: entry.explanation,
      datetime: entry.at,
      nonce: entry.id,
    });
    report.checkins += 1;
    return;
  }
  const result = await api.redeem(pairing, {
    secret: entry.secret,
    lists: [entry.list],
    // The same nonce the scan was made with, so pretix recognises a replay
    // rather than recording the person twice — including a scan whose live
    // attempt did reach pretix before its answer was lost.
    nonce: entry.id,
    // And the moment it happened, so the door's history is the door's history.
    datetime: entry.at,
    // Sent the way pretix expects an offline scan: recorded whatever it would
    // answer now, because the person walked in on the answer given at the
    // time, and marked as offline in its history and its export. Without it
    // these arrived looking like ordinary scans, and a ticket used at another
    // door in the meantime was written down as a refusal of somebody who was
    // already inside. pretix still flags that case, as an override.
    force: true,
  });
  report.checkins += 1;
  if (result.status !== "ok") {
    // Admitted at the door on the strength of the snapshot, refused even so:
    // the few things an override cannot get past, such as a code pretix no
    // longer knows at all. The person is inside either way — this is for the
    // organiser to know about.
    report.contested.push({
      name: entry.name || entry.secret.slice(0, 8),
      secret: entry.secret,
      reason: result.reason ?? result.status,
    });
  }
}

/**
 * Whether an entry can be sent from where this till stands now.
 *
 * A sale belongs to the event it was rung up for, and is posted to that
 * event's own checkout: one queued before the till was switched waits for it
 * to be switched back rather than be filed against the wrong event. A scan has
 * no such problem — it names its check-in list, the list belongs to one event,
 * and pretix takes it whichever event the till is on now. Holding scans back
 * with the sales is how a door phone moved on to the next evening kept the
 * previous one's entries to itself.
 */
export function sendable(entry: QueueEntry, event: string): boolean {
  return entry.kind === "checkin" || entry.event === event;
}

/**
 * Why the run stops here, from what stopped it.
 *
 * Every one of these keeps the entry and everything behind it in the queue;
 * they differ only in what the operator is told, and in when the next
 * automatic run may try again.
 */
function haltFor(error: unknown): SyncHalt {
  const message = describeError(error);
  if (isRetryable(error)) return { kind: "unreachable", message, retryAt: null };
  if (isThrottled(error)) {
    const wait = (error as ApiError).retryAfterMs ?? THROTTLED_WAIT_MS;
    return { kind: "wait", message, retryAt: Date.now() + wait };
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { kind: "device", message, retryAt: null };
  }
  return { kind: "other", message, retryAt: null };
}

/**
 * Send everything that can be sent, oldest first.
 *
 * Stops at the first answer that is not about the entry itself — the network
 * went away again, the device was turned away, the server asked for a moment
 * — and the rest of the queue keeps its place in line. The report says which.
 *
 * Sales belonging to another event are stepped over rather than sent: see
 * ``sendable``. They used to *stop* the drain, which meant one stranded entry at
 * the head held every later sale hostage — with a badge counting them and a
 * "send now" button that reported nothing and explained less. They are counted
 * in the report instead, so the operator is told what is waiting and what for.
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
    // Oldest entry that can go and has not been through the loop yet.
    const entry = loadQueue().find(
      (candidate) => sendable(candidate, pairing.event) && !attempted.has(candidate.id),
    );
    if (!entry) break;
    attempted.add(entry.id);

    try {
      if (entry.kind === "sale") {
        await replaySale(pairing, entry, report);
      } else {
        await replayCheckin(pairing, entry, report);
        countSent(entry);
      }
    } catch (error) {
      if (!isRefusal(error)) {
        report.halted = haltFor(error);
        break;
      }
      // A refusal with a reason: the server has spoken, so this entry will not
      // improve by being retried. Out of the queue and into the report — but
      // only once the report is on disk, or the sale would exist nowhere.
      const filed = addFailure({ entry, at: new Date().toISOString(), message: describeError(error) });
      if (!filed) {
        report.halted = { kind: "other", message: t("offline.storageFull"), retryAt: null };
        break;
      }
      report.failed += 1;
    }

    // Re-read rather than trusting an earlier copy, for the same reason.
    try {
      saveQueue(loadQueue().filter((queued) => queued.id !== entry.id));
    } catch {
      // Sent, and still in the queue: the next run sends it again under its
      // key, and the server answers it as the replay it is. Stopping here
      // keeps that to one entry rather than the whole queue.
      report.halted = { kind: "other", message: t("offline.storageFull"), retryAt: null };
      break;
    }
  }

  // Everything that could go went: the moment the back office is told as
  // "last synchronised" — see useDeviceStatus.
  if (!report.halted) saveLastSync(new Date().toISOString());
  report.stranded = loadQueue().filter((queued) => !sendable(queued, pairing.event)).length;
  return report;
}
