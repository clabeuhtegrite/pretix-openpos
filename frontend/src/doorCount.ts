import { loadDoorScans, saveDoorScans } from "./storage";
import type { DoorScans, QueuedCheckin, QueueEntry, ScanFigures } from "./types";

/**
 * The scanner's counter: the server's figure, plus what it cannot know yet.
 *
 * The server counts from pretix' own check-ins, which is what makes the figure
 * survive iOS reloading the page. Two things are missing from it at any given
 * moment, and both are added here rather than waited for:
 *
 * - scans answered online since the figure was asked for, which the next
 *   refresh — a second or so after every scan — will include;
 * - scans still in this device's queue, which the server has not heard of at
 *   all. The queue is on disk, so these survive a reload too.
 *
 * Pure, so the arithmetic can be tested without a camera or a network.
 */

export const NO_SCANS: ScanFigures = { admitted: 0, refused: 0, other: 0, offline: 0 };

export function addScans(a: ScanFigures, b: ScanFigures): ScanFigures {
  return {
    admitted: a.admitted + b.admitted,
    refused: a.refused + b.refused,
    other: a.other + b.other,
    offline: a.offline + b.offline,
  };
}

/** `a - b`, never below zero: a figure already taken away cannot go negative. */
export function subtractScans(a: ScanFigures, b: ScanFigures): ScanFigures {
  return {
    admitted: Math.max(a.admitted - b.admitted, 0),
    refused: Math.max(a.refused - b.refused, 0),
    other: Math.max(a.other - b.other, 0),
    offline: Math.max(a.offline - b.offline, 0),
  };
}

/**
 * The scans in a queue made for this event since a given moment.
 *
 * Every one of them was made offline, which is what `offline` counts. With no
 * moment to go by — the server has not given a first figure — the whole queue
 * for the event counts.
 */
export function queuedScans(queue: QueueEntry[], event: string, since: string | null): ScanFigures {
  const from = since === null ? -Infinity : Date.parse(since);
  const figures = { ...NO_SCANS };
  for (const entry of queue) {
    if (entry.kind !== "checkin" || entry.event !== event) continue;
    if (Date.parse(entry.at) < from) continue;
    if (entry.refused) {
      figures.refused += 1;
    } else if (entry.admits === false) {
      figures.other += 1;
    } else {
      figures.admitted += 1;
      figures.offline += 1;
    }
  }
  return figures;
}

export interface DoorCount {
  /** This device, tonight. */
  device: ScanFigures;
  /** People let in by every door tonight; null until the server has answered once. */
  evening: number | null;
}

/**
 * The counter on the scanning screen.
 *
 * `seen` is the queue as it stood when the server's figure came in, plus what
 * has been queued since — not the queue as it stands now. A drain takes scans
 * out of the queue a moment before the server's figure counts them, and a
 * counter read from the queue in between would drop by however many were just
 * sent, then climb back: the very figure this is meant to make trustworthy,
 * seen going backwards.
 */
export function doorCount(
  server: DoorScans | null,
  live: ScanFigures,
  seen: QueueEntry[],
  event: string,
): DoorCount {
  const unsent = addScans(live, queuedScans(seen, event, server?.since ?? null));
  return {
    device: addScans(server?.device ?? NO_SCANS, unsent),
    evening: server ? server.event.admitted + unsent.admitted : null,
  };
}

/** Scans of this event still waiting in the queue, whenever they were made. */
export function waitingScans(queue: QueueEntry[], event: string): number {
  return queue.filter((entry) => entry.kind === "checkin" && entry.event === event).length;
}

/**
 * Count a scan the drain has just handed to pretix into the figure kept on the
 * device.
 *
 * Until the server is asked again, that figure is the only place left to count
 * it: the scan has left the queue, and the figure was counted before it
 * arrived. The drain runs whether or not the scanning screen is open, so
 * without this a door phone that iOS reloaded with no network, after a drain
 * it did not see, opened on a count short of everything that drain had sent.
 */
export function countSent(entry: QueuedCheckin): void {
  const saved = loadDoorScans(entry.event);
  if (!saved) return;
  const sent = queuedScans([entry], entry.event, saved.since);
  saveDoorScans(entry.event, {
    ...saved,
    device: saved.device && addScans(saved.device, sent),
    event: addScans(saved.event, sent),
  });
}
