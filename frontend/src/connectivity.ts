import { useEffect, useState } from "react";

/**
 * Whether the server is reachable, judged by what actually happened.
 *
 * `navigator.onLine` is not that: it reports a link, not a server, and on a
 * venue's wifi a phone is very often "online" while attached to an access point
 * that leads nowhere. So the truth here comes from the requests themselves —
 * every call that reaches the server marks us up, every transport failure marks
 * us down — and the browser's own events are only ever taken as a hint to go
 * and check.
 */

type Listener = (online: boolean) => void;

const listeners = new Set<Listener>();
let online = typeof navigator === "undefined" || navigator.onLine !== false;
/** Set while a probe is in flight, so a burst of failures fires one check. */
let probing = false;

function publish(next: boolean): void {
  if (next === online) return;
  online = next;
  for (const listener of listeners) listener(online);
}

export function isOnline(): boolean {
  return online;
}

/** Called by the API layer on every answered request. */
export function markReachable(): void {
  publish(true);
}

/** Called by the API layer when a request never made it to the server. */
export function markUnreachable(): void {
  publish(false);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask the server whether it is there, cheaply.
 *
 * Deliberately not one of the app's own endpoints: this runs while offline,
 * possibly every few seconds, and must not depend on a device token still being
 * valid. A HEAD on the app shell is enough to tell a dead network from a live one.
 */
export async function probe(): Promise<boolean> {
  if (probing) return online;
  probing = true;
  try {
    await fetch(`/openpos/?probe=${Date.now()}`, { method: "HEAD", cache: "no-store" });
    markReachable();
  } catch {
    markUnreachable();
  } finally {
    probing = false;
  }
  return online;
}

/** How often to test the water while the app believes it is offline. */
const PROBE_INTERVAL_MS = 10_000;

export function useConnectivity(): boolean {
  const [state, setState] = useState(online);

  useEffect(() => {
    const unsubscribe = subscribe(setState);
    const onBrowserEvent = () => void probe();
    window.addEventListener("online", onBrowserEvent);
    window.addEventListener("offline", onBrowserEvent);

    // Only while down: a working till should not spend its night pinging.
    const timer = window.setInterval(() => {
      if (!online) void probe();
    }, PROBE_INTERVAL_MS);

    return () => {
      unsubscribe();
      window.removeEventListener("online", onBrowserEvent);
      window.removeEventListener("offline", onBrowserEvent);
      window.clearInterval(timer);
    };
  }, []);

  return state;
}
