import type { OfflineSnapshot, Pairing, QueueEntry, SyncFailure } from "./types";

const PAIRING_KEY = "openpos.pairing.v1";
const CASHIER_KEY = "openpos.cashier.v1";
const QUEUE_KEY = "openpos.queue.v1";
const FAILURES_KEY = "openpos.failures.v1";
const SNAPSHOT_KEY = "openpos.snapshot.v1";

/**
 * Ask the browser to keep this data.
 *
 * Storage can be evicted under pressure, and what is queued here is money that
 * exists nowhere else yet. Granting is at the browser's discretion — an
 * installed app is usually granted it — and failing is silent because there is
 * no answer an operator could act on mid-service.
 */
export function requestPersistence(): void {
  void navigator.storage?.persist?.().catch(() => {});
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The queue of what the till did while it could not reach the server.
 *
 * localStorage rather than IndexedDB on purpose: writes are synchronous, so a
 * sale is on disk before the operator sees it confirmed, with no window in
 * which a crash could swallow one. A night of sales is tens of kilobytes.
 */
export function loadQueue(): QueueEntry[] {
  return readJson<QueueEntry[]>(QUEUE_KEY, []);
}

export function saveQueue(entries: QueueEntry[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
  } catch {
    // Out of quota, or storage refused. Nothing sensible remains to be done
    // here; the caller reports it, because a sale that is not queued is a sale
    // that will not reach the server.
    throw new Error("queue-write-failed");
  }
}

export function enqueue(entry: QueueEntry): void {
  saveQueue([...loadQueue(), entry]);
}

/** Entries that the server refused on replay, kept until a human has seen them. */
export function loadFailures(): SyncFailure[] {
  return readJson<SyncFailure[]>(FAILURES_KEY, []);
}

export function saveFailures(failures: SyncFailure[]): void {
  try {
    localStorage.setItem(FAILURES_KEY, JSON.stringify(failures));
  } catch {
    // Losing the report is bad; losing the queue would be worse, and this is
    // the one of the two that can be reconstructed from the server.
  }
}

/**
 * The last catalogue and configuration this till was given.
 *
 * Kept so the app can be relaunched during an outage — a tablet whose battery
 * ran out mid-evening, a tab reloaded by mistake — instead of coming back as a
 * brick because it cannot ask what it sells. Stored per event: switching events
 * is what invalidates it, and a stale tariff for the wrong event would be worse
 * than none.
 */
export function loadCached<T>(kind: "config" | "catalog", event: string): T | null {
  return readJson<T | null>(`openpos.${kind}.v1.${event}`, null);
}

export function saveCached(kind: "config" | "catalog", event: string, value: unknown): void {
  try {
    localStorage.setItem(`openpos.${kind}.v1.${event}`, JSON.stringify(value));
  } catch {
    // Not fatal: it only costs the ability to start while offline.
  }
}

export function loadSnapshot(): OfflineSnapshot | null {
  return readJson<OfflineSnapshot | null>(SNAPSHOT_KEY, null);
}

export function saveSnapshot(snapshot: OfflineSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // A guest list too big for storage: scanning offline will say it has none
    // rather than pretend to hold half of it.
  }
}

export function clearSnapshot(): void {
  localStorage.removeItem(SNAPSHOT_KEY);
}

export function loadPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pairing;
    if (!parsed.token || !parsed.organizer || !parsed.event) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePairing(pairing: Pairing): void {
  localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

export function clearPairing(): void {
  localStorage.removeItem(PAIRING_KEY);
}

export function loadCashier(): string {
  return localStorage.getItem(CASHIER_KEY) ?? "";
}

export function saveCashier(name: string): void {
  localStorage.setItem(CASHIER_KEY, name);
}
