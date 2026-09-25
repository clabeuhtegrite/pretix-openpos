import { useEffect, useState } from "react";

import { api, errorCode } from "./api";
import { clearSnapshot, loadSnapshot, loadSnapshotPull, saveSnapshot, saveSnapshotPull } from "./storage";
import type { OfflineSnapshot, Pairing } from "./types";

/**
 * How often the guest list carried for a dropout is refreshed.
 *
 * Tickets are still being sold — online, and at the other tills — all evening.
 * A snapshot an hour old would start refusing people who bought their ticket
 * during the evening.
 */
export const SNAPSHOT_REFRESH_MS = 300_000;

/**
 * How soon the list may be pulled again when the network comes back.
 *
 * It is pulled whenever the network comes back, and "comes back" is also what
 * one failed request followed by one that got through looks like. On a
 * network that loses writes but not reads — a scan timing out on a busy
 * pretix, its head count answering — that alternates as fast as the requests
 * go. Tried against a real pretix, a door phone pulled the whole guest list
 * fifty times in two seconds; on the night, each pull is every ticket sold.
 *
 * The same holds between screens: a door stepping out to the grid to sell a
 * ticket and back is two screens taking turns, and each used to pull on
 * arrival. The last pull is kept on the device (storage.ts), so the gap holds
 * across both, and across a reload.
 */
export const SNAPSHOT_MIN_GAP_MS = 60_000;

/**
 * The guest list this till carries for a network dropout, kept fresh.
 *
 * Pulled for `listId` as soon as there is a pairing and a network, then again
 * every few minutes for as long as `active` holds. Whatever the device already
 * holds is returned straight away, so a till that starts with no network still
 * answers scans from the list it was last given.
 *
 * Run from two places, on purpose. The app itself runs it from the moment the
 * till is paired, for the list the door would scan on: before that, the list
 * was only ever fetched once somebody had opened the scanner while there was a
 * network — and a phone that lost the wifi before that moment had no guest
 * list at all, so its door stayed shut for the rest of the dropout. The door
 * screen runs it for the list actually on screen while it is open, and the app
 * stands down for that time, so the two never fetch side by side. The app
 * only runs it on a device whose role includes the door: a bar till has no
 * business carrying every guest's name and ticket secret.
 *
 * The refresh is timed from the last pull, whichever screen made it, rather
 * than from the moment this one appeared — otherwise a door that changes
 * screen more often than every five minutes would only ever pull on arrival.
 *
 * A server that answers `door_role_required` has taken the door away from this
 * device: what it holds is dropped, not kept "in case".
 */
export function useOfflineSnapshot(
  pairing: Pairing | null,
  listId: number | null,
  active: boolean,
): OfflineSnapshot | null {
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(loadSnapshot);

  useEffect(() => {
    if (!pairing || !listId || !active) return;
    const event = pairing.event;
    let cancelled = false;
    let timer = 0;

    /** When this list was last asked for, by any screen, if it was. */
    const lastPull = (): number | null => {
      const last = loadSnapshotPull();
      return last && last.event === event && last.list === listId ? last.at : null;
    };

    const pull = () => {
      saveSnapshotPull({ event, list: listId, at: Date.now() });
      api
        .offlineSnapshot(pairing, listId)
        .then((data) => {
          if (cancelled) return;
          saveSnapshot(data);
          setSnapshot(data);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (errorCode(error) === "door_role_required") {
            clearSnapshot();
            setSnapshot(null);
          }
          // Anything else: a stale snapshot beats none, and the previous one
          // stays.
        });
    };

    const schedule = () => {
      const since = Date.now() - (lastPull() ?? Date.now());
      // Clamped both ways: a clock set back must not push the next pull an
      // hour out, nor one set forward make it immediate forever.
      const wait = Math.min(SNAPSHOT_REFRESH_MS, Math.max(0, SNAPSHOT_REFRESH_MS - since));
      timer = window.setTimeout(() => {
        pull();
        schedule();
      }, wait);
    };

    const last = lastPull();
    const since = last === null ? Infinity : Date.now() - last;
    if (since < 0 || since >= SNAPSHOT_MIN_GAP_MS) pull();
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pairing, listId, active]);

  return snapshot;
}
