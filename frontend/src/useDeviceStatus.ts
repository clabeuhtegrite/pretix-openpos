import { useCallback, useEffect, useRef } from "react";

import { api, ApiError, isRefusal } from "./api";
import { loadLastSync, loadQueue } from "./storage";
import type { DeviceStatus, Pairing } from "./types";

/**
 * How often a till that stays online tells the back office what it holds.
 *
 * Also the shortest gap between two reports sent for the network coming back:
 * see useDeviceStatus.
 */
export const STATUS_EVERY_MS = 60_000;

/**
 * How long after the queue changes the report goes out.
 *
 * A drain sends a whole queue in a few seconds, each sale moving the count;
 * one report once it has settled says the same as twenty along the way.
 */
export const STATUS_SETTLE_MS = 3_000;

/**
 * An instant as the server reads it — `toISOString()`, UTC, milliseconds — or
 * null for anything that is not one.
 *
 * What comes out of storage is whatever was written there, possibly by an
 * older build; the server turns down the whole report over one malformed
 * date, so it is set right here rather than sent as found.
 */
function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** What this device holds, read from the queue itself at the moment of sending. */
export function deviceStatus(): DeviceStatus {
  const sales = loadQueue().filter((entry) => entry.kind === "sale");
  const oldest = sales.reduce<number | null>((first, sale) => {
    const at = instant(sale.at);
    return at !== null && (first === null || at < first) ? at : first;
  }, null);
  const lastSync = instant(loadLastSync());
  return {
    pending_sales: sales.length,
    oldest_pending_at: oldest === null ? null : new Date(oldest).toISOString(),
    last_sync_at: lastSync === null ? null : new Date(lastSync).toISOString(),
    version: __APP_VERSION__,
  };
}

/**
 * The server saying no to this report as it stands, for good.
 *
 * A 400 is this build sending something the server does not take — a bug to
 * fix, not a moment to wait out — and a 401 or a 403 is this device, or this
 * organizer, not being one the server takes reports from at all.
 */
function turnedDown(error: unknown): boolean {
  return isRefusal(error) || (error instanceof ApiError && (error.status === 401 || error.status === 403));
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
 * At launch, every minute while the network stays, a few seconds after the
 * queue changes, and when the network comes back — unless a report left less
 * than a minute ago: on a network that comes and goes, every return would
 * otherwise be a report of its own, and the server counts every Open POS
 * request against the same per-device allowance as the sales. Silent: a
 * report that fails is sent again at the next occasion, and nothing about it
 * is the cashier's business — nor does it ever take the till offline (see
 * api.deviceStatus). `pending` is only the signal that the queue moved; what
 * is reported is read from the queue itself.
 *
 * A report the server turned down (see ``turnedDown``) is not sent again as
 * it was: the same body would only be refused again, every minute, for as
 * long as the till stays open. The next one goes once it has something new to
 * say — the queue moved, a drain finished — or once the till is paired again.
 */
export function useDeviceStatus(pairing: Pairing | null, online: boolean, pending: number): void {
  const sendingRef = useRef(false);
  /** When the last report left, whatever became of it. */
  const lastTryRef = useRef(0);
  /** The body of the last report the server turned down, while nothing has changed since. */
  const refusedRef = useRef<string | null>(null);

  // A pairing of its own: a device paired again starts from nothing, and
  // reports at once. Declared before the effects that send, so it runs first.
  useEffect(() => {
    lastTryRef.current = 0;
    refusedRef.current = null;
  }, [pairing]);

  const send = useCallback(async () => {
    if (!pairing || sendingRef.current) return;
    const status = deviceStatus();
    const body = JSON.stringify(status);
    if (body === refusedRef.current) return;
    sendingRef.current = true;
    lastTryRef.current = Date.now();
    try {
      await api.deviceStatus(pairing, status);
      refusedRef.current = null;
    } catch (error) {
      if (turnedDown(error)) refusedRef.current = body;
      // Anything else is silent, see above.
    } finally {
      sendingRef.current = false;
    }
  }, [pairing]);

  useEffect(() => {
    if (!pairing || !online) return;
    if (Date.now() - lastTryRef.current >= STATUS_EVERY_MS) void send();
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
