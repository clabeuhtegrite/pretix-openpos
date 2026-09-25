import type { OfflineSnapshot, OfflineTicket, RedeemResult } from "./types";

/**
 * Answering a scan from the guest list held on the device.
 *
 * Pure functions, out of the component on purpose: this is the code that
 * decides who walks in when there is no server to ask, and it has to be
 * testable without a camera, a browser or a network to cut.
 */

/** A snapshot rearranged for answering scans: one Map lookup per ticket. */
export interface SnapshotIndex {
  /** Which door this guest list belongs to. */
  listId: number;
  count: number;
  tickets: Map<string, OfflineTicket>;
}

/**
 * Index a snapshot by ticket secret.
 *
 * Built once when the snapshot changes rather than per scan: a guest list can
 * carry 20 000 tickets, and a linear search per scan is work the main thread
 * does while the camera is trying to hand it the next frame.
 */
export function indexSnapshot(snapshot: OfflineSnapshot | null): SnapshotIndex | null {
  if (!snapshot) return null;
  return {
    listId: snapshot.list.id,
    count: snapshot.tickets.length,
    tickets: new Map(snapshot.tickets.map((ticket) => [ticket.secret, ticket])),
  };
}

/**
 * Answer a scan from the guest list held on the device.
 *
 * Deliberately stricter than the server on one point and looser on another. An
 * unknown secret is refused, because the alternative is admitting anything
 * presented to a camera. A ticket the snapshot says is already used is refused
 * too, and so is one pretix refuses whatever the door: blocked, or outside the
 * moments it is valid between — read on this device's clock at the time of the
 * scan, so a ticket that becomes valid during the dropout walks in when it
 * does. But no rules engine runs here, and nothing later than the snapshot is
 * known — which is why every scan is queued and settled against the server the
 * moment there is one.
 *
 * A snapshot taken for another list answers nothing: the operator switched
 * doors during the dropout, and the old door's guest list would admit the
 * wrong people. Refusing with "no snapshot" is the honest answer.
 */
export function offlineVerdict(
  index: SnapshotIndex | null,
  listId: number,
  secret: string,
  scannedHere: Set<string>,
  now: number = Date.now(),
): RedeemResult {
  if (!index || index.listId !== listId) {
    return { status: "error", reason: "offline_no_snapshot" };
  }
  const ticket = index.tickets.get(secret);
  if (!ticket) return { status: "error", reason: "invalid" };
  // pretix' own order: what the ticket is, before whether it was used.
  if (ticket.blocked) return { status: "error", reason: "blocked" };
  if (
    (ticket.valid_from && now < Date.parse(ticket.valid_from)) ||
    (ticket.valid_until && now > Date.parse(ticket.valid_until))
  ) {
    return { status: "error", reason: "invalid_time" };
  }
  if (ticket.used || scannedHere.has(secret)) {
    return { status: "error", reason: "already_redeemed" };
  }
  return { status: "ok", position: { item: ticket.item, attendee_name: ticket.name } };
}

/**
 * Tickets let in at this device, by list: list id → ticket secret → when.
 *
 * What stops the guest list on the device from letting the same ticket in
 * twice. That list says who was inside when it was pulled; everybody this door
 * has admitted since — online, or from the list itself during a dropout — is
 * not in it yet. The queue used to be the only record of them, and the queue
 * empties the moment the network comes back: a door that sent its scans, lost
 * the network again and was reopened answered the same ticket green twice.
 * A ticket scanned online was never recorded at all.
 */
export type Admissions = Record<string, Record<string, number>>;

/**
 * How long a ticket let in here is remembered without the guest list saying so.
 *
 * Long enough for any evening, and the night after it; short enough that a
 * device used at the same event every weekend does not carry every ticket it
 * ever admitted. The guest list normally takes over within minutes: see
 * pruneAdmissions.
 */
export const ADMISSION_MEMORY_MS = 36 * 60 * 60 * 1000;

/** The same record with one more ticket in it. Never mutates `admissions`. */
export function recordAdmission(
  admissions: Admissions,
  listId: number,
  secret: string,
  at: number,
): Admissions {
  const list = String(listId);
  return { ...admissions, [list]: { ...admissions[list], [secret]: at } };
}

/**
 * What is still worth remembering.
 *
 * A ticket is forgotten once the guest list held for its door marks it used —
 * pretix has the entry, and the list now carries it — or once it is older
 * than ADMISSION_MEMORY_MS. Not merely once a newer list arrives: a scan made
 * offline only reaches pretix when the queue is sent, and a list pulled in
 * between still has the ticket unused. Returns `admissions` itself when
 * nothing changed, so a caller can skip the write.
 */
export function pruneAdmissions(
  admissions: Admissions,
  snapshot: OfflineSnapshot | null,
  now: number,
): Admissions {
  const used = new Set(
    snapshot ? snapshot.tickets.flatMap((ticket) => (ticket.used ? [ticket.secret] : [])) : [],
  );
  const heldFor = snapshot ? String(snapshot.list.id) : null;
  let changed = false;
  const kept: Admissions = {};
  for (const [list, tickets] of Object.entries(admissions)) {
    const keep: Record<string, number> = {};
    for (const [secret, at] of Object.entries(tickets)) {
      const expired = typeof at !== "number" || now - at > ADMISSION_MEMORY_MS;
      if (expired || (list === heldFor && used.has(secret))) changed = true;
      else keep[secret] = at;
    }
    if (Object.keys(keep).length) kept[list] = keep;
    else changed = true;
  }
  return changed ? kept : admissions;
}

/** The tickets let in on one list, for offlineVerdict. */
export function admittedOn(admissions: Admissions, listId: number): Set<string> {
  return new Set(Object.keys(admissions[String(listId)] ?? {}));
}
