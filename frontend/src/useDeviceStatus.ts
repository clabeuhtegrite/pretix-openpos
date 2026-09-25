import { useCallback, useEffect, useRef } from "react";

import { api } from "./api";
import { loadLastSync, loadQueue } from "./storage";
import type { DeviceStatus, Pairing } from "./types";

/** How often a till that stays online tells the back office what it holds. */
export const STATUS_EVERY_MS = 60_000;

/**
 * How long after the queue changes the report goes out.
 *
 * A drain sends a whole queue in a few seconds, each sale moving the count;
 * one report once it has settled says the same as twenty along the way.
 */
export const STATUS_SETTLE_MS = 3_000;

/** What this device holds, read from the queue itself at the moment of sending. */
export function deviceStatus(): DeviceStatus {
  const sales = loadQueue().filter((entry) => entry.kind === "sale");
  const oldest = sales.reduce<string | null>(
    (first, sale) => (first === null || sale.at < first ? sale.at : first),
    null,
  );
  return {
    pending_sales: sales.length,
    oldest_pending_at: oldest,
    last_sync_at: loadLastSync(),
    version: __APP_VERSION__,
  };
}

/**
 * Tell the back office, now and then, what this device has not sent yet.
 *
 * Sales rung up with no network exist on this tablet and nowhere else until
 * they are sent, and the only place anybody could see them was this tablet's
 * own badge. With this the back office sees them too — how many, since when,
 * and when the device last managed to send everything — which is what lets
 * somebody walk over to the right tablet before closing rather than find out
 * from a drawer that does not add up.
 *
 * At launch, whenever the network comes back, every minute while it stays,
 * and a few seconds after the queue changes. Silent: a report that fails is
 * sent again at the next occasion, and nothing about it is the cashier's
 * business — nor does it ever take the till offline (see api.deviceStatus).
 * `pending` is only the signal that the queue moved; what is reported is
 * read from the queue itself.
 */
export function useDeviceStatus(pairing: Pairing | null, online: boolean, pending: number): void {
  const sendingRef = useRef(false);

  const send = useCallback(async () => {
    if (!pairing || sendingRef.current) return;
    sendingRef.current = true;
    try {
      await api.deviceStatus(pairing, deviceStatus());
    } catch {
      // Silent, see above.
    } finally {
      sendingRef.current = false;
    }
  }, [pairing]);

  useEffect(() => {
    if (!pairing || !online) return;
    void send();
    const timer = window.setInterval(() => void send(), STATUS_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [pairing, online, send]);

  // Compared with the last value seen rather than skipped once: an effect
  // runs twice on mount under StrictMode, and "the first run" is not a thing
  // that can be told apart there.
  const lastPending = useRef(pending);
  useEffect(() => {
    if (pending === lastPending.current) return;
    lastPending.current = pending;
    if (!pairing || !online) return;
    const timer = window.setTimeout(() => void send(), STATUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pairing, online, pending, send]);
}
