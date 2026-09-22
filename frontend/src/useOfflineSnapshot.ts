import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import { loadSnapshot, saveSnapshot } from "./storage";
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
 * stands down for that time, so the two never fetch side by side.
 */
export function useOfflineSnapshot(
  pairing: Pairing | null,
  listId: number | null,
  active: boolean,
): OfflineSnapshot | null {
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(loadSnapshot);
  /** When a pull for which list last set off, whatever came of it. */
  const pulledRef = useRef<{ listId: number; at: number } | null>(null);

  useEffect(() => {
    if (!pairing || !listId || !active) return;
    let cancelled = false;
    const pull = () => {
      pulledRef.current = { listId, at: Date.now() };
      api
        .offlineSnapshot(pairing, listId)
        .then((data) => {
          if (cancelled) return;
          saveSnapshot(data);
          setSnapshot(data);
        })
        .catch(() => {
          // A stale snapshot beats none; the previous one stays.
        });
    };
    const last = pulledRef.current;
    if (!last || last.listId !== listId || Date.now() - last.at >= SNAPSHOT_MIN_GAP_MS) pull();
    const timer = window.setInterval(pull, SNAPSHOT_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pairing, listId, active]);

  return snapshot;
}
