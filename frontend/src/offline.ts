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
 * too. But no rules engine runs here, and nothing later than the snapshot is
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
): RedeemResult {
  if (!index || index.listId !== listId) {
    return { status: "error", reason: "offline_no_snapshot" };
  }
  const ticket = index.tickets.get(secret);
  if (!ticket) return { status: "error", reason: "invalid" };
  if (ticket.used || scannedHere.has(secret)) {
    return { status: "error", reason: "already_redeemed" };
  }
  return { status: "ok", position: { item: ticket.item, attendee_name: ticket.name } };
}
