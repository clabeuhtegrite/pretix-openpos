import { useEffect, useState } from "react";

/**
 * How far this device's clock is from the server's, as last measured.
 *
 * It matters for one thing above all: a sale rung up with no network is
 * stamped with this device's clock, and replayed later with that stamp. A
 * tablet whose clock was set by hand — or never set at all — dates its sales
 * wrongly, and far enough off the server refuses them as "dated in the
 * future", or files them under the wrong evening. The server now corrects
 * what it can from ``sent_at``; this is for the volunteer, who can fix the
 * cause in ten seconds once somebody tells them.
 *
 * Module state rather than React state, because the measurements arrive from
 * the API layer — the config the till reads at launch and every minute, the
 * status report — and every screen that cares subscribes to the one figure.
 */

/**
 * The drift worth telling somebody about.
 *
 * Two minutes: well past anything a network round trip or a server under
 * load puts between two clocks, and well short of the five minutes after
 * which the server used to refuse a replayed sale outright.
 */
export const CLOCK_SKEW_WARN_MS = 2 * 60_000;

type Listener = (skewMs: number | null) => void;

const listeners = new Set<Listener>();
/** Device minus server, in milliseconds: positive when this device is ahead. */
let skew: number | null = null;

/**
 * Take one reading of the server's clock.
 *
 * The server read its clock somewhere between the request leaving and the
 * answer arriving, so the midpoint of the two is the best guess of what this
 * device's clock said at that instant — right to within half a round trip,
 * which is seconds at worst against a threshold of minutes. A server that
 * sent no time (one older than the field) is simply no reading.
 */
export function noteServerTime(serverTime: unknown, sentAt: number, receivedAt: number): void {
  if (typeof serverTime !== "string") return;
  const server = Date.parse(serverTime);
  if (!Number.isFinite(server)) return;
  const next = Math.round((sentAt + receivedAt) / 2 - server);
  if (next === skew) return;
  skew = next;
  for (const listener of listeners) listener(skew);
}

/** The last reading, or null when the server has not said. */
export function clockSkew(): number | null {
  return skew;
}

export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The drift, when it is worth a word on screen, else null.
 *
 * Re-renders only when the rounded minute changes: a reading arrives every
 * minute, a few milliseconds different each time, and a banner that
 * re-rendered for each one would be re-rendering the whole till for nothing.
 */
export function useClockSkew(): number | null {
  const [minutes, setMinutes] = useState(() => worthSaying(skew));

  useEffect(() => {
    // A reading may have landed between the first render and this effect.
    setMinutes(worthSaying(skew));
    return subscribeClock((next) => setMinutes(worthSaying(next)));
  }, []);

  return minutes;
}

/** Whole minutes of drift, signed like ``skew``, or null below the threshold. */
function worthSaying(value: number | null): number | null {
  if (value === null || Math.abs(value) < CLOCK_SKEW_WARN_MS) return null;
  return Math.round(value / 60_000);
}

/**
 * A drift of ``minutes`` as somebody reads it: "7 min", "2 h 05".
 *
 * Hours past the hour, because a tablet whose clock was set by hand is as
 * likely to be hours off as minutes — its time zone left on another
 * country's, and the hour then set to read right on it — and "185 min" is a
 * sum to do rather than a fact to read. A time zone alone moves nothing: the
 * clock underneath is the same instant everywhere, and that is what is read.
 */
export function formatDrift(minutes: number): string {
  const total = Math.abs(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${hours} h ${String(rest).padStart(2, "0")}`;
}
