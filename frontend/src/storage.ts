import type {
  CartLine, Credit, DeviceDescription, OfflineSnapshot, Pairing, QueueEntry, SyncFailure,
} from "./types";

const PAIRING_KEY = "openpos.pairing.v1";
const DEVICE_REPORT_KEY = "openpos.deviceReport.v1";
const CASHIER_KEY = "openpos.cashier.v1";
const QUEUE_KEY = "openpos.queue.v1";
const FAILURES_KEY = "openpos.failures.v1";
const SNAPSHOT_KEY = "openpos.snapshot.v1";
const UPDATE_KEY = "openpos.updateTried.v1";
const BASKET_KEY = "openpos.basket.v1";

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

/**
 * What pretix was last told about this device, by the device it was told for.
 *
 * Kept with the device's serial so that a till unpaired and paired again as
 * another device never takes the first one's report for its own.
 */
export function loadDeviceReport(serial: string): DeviceDescription | null {
  const saved = readJson<{ serial?: string; description?: DeviceDescription } | null>(
    DEVICE_REPORT_KEY,
    null,
  );
  return saved?.serial === serial ? saved.description ?? null : null;
}

export function saveDeviceReport(serial: string, description: DeviceDescription): void {
  try {
    localStorage.setItem(DEVICE_REPORT_KEY, JSON.stringify({ serial, description }));
  } catch {
    // The report goes out once more at the next launch. Harmless.
  }
}

export function loadCashier(): string {
  return localStorage.getItem(CASHIER_KEY) ?? "";
}

export function saveCashier(name: string): void {
  localStorage.setItem(CASHIER_KEY, name);
}

/**
 * The server version this till last reloaded itself for.
 *
 * The update prompt compares the version the server reports against the one
 * baked into the running bundle. Normally a reload settles it. When it does
 * not — a deployment whose image carries a bundle older than the plugin
 * installed beside it — nothing the operator does will ever make the two
 * numbers agree, and without this the prompt sits in the topbar all evening
 * asking to be pressed again. Remembering the attempt turns it into one offer.
 */
export function loadUpdateAttempt(): string | null {
  return localStorage.getItem(UPDATE_KEY);
}

export function saveUpdateAttempt(version: string): void {
  try {
    localStorage.setItem(UPDATE_KEY, version);
  } catch {
    // Worst case the prompt is offered again after the reload. Harmless.
  }
}

/**
 * How long a basket left on screen is still the basket in front of somebody.
 *
 * The failure this exists to stop is the tablet reloading under an operator:
 * an iOS PWA killed in the background, a crash, a tap on refresh. That is
 * seconds to minutes, so anything older is an evening that has moved on.
 *
 * It matters most for the credit. Restoring a stale one would take money off
 * the next customer's total that belongs to somebody who left an hour ago —
 * real money out of the drawer. Losing a fresh one costs a trip back through
 * the history panel, which is annoying and recoverable. The two failures are
 * not the same size, so the window is short.
 */
export const BASKET_KEEPS_FOR_MS = 30 * 60_000;

interface SavedBasket {
  event: string;
  at: string;
  cart: CartLine[];
  credit: Credit | null;
}

/**
 * The basket being rung up, and the credit being spent on it.
 *
 * Written on every change rather than at chosen moments: a basket that
 * survives only the reloads somebody remembered to handle is a basket that
 * does not survive. The credit is the part that actually matters — it is
 * money the till is holding for a customer, and it exists nowhere else until
 * the corrected sale is recorded.
 */
export function saveBasket(event: string, cart: CartLine[], credit: Credit | null): void {
  try {
    if (cart.length === 0 && credit === null) {
      localStorage.removeItem(BASKET_KEY);
      return;
    }
    const saved: SavedBasket = { event, at: new Date().toISOString(), cart, credit };
    localStorage.setItem(BASKET_KEY, JSON.stringify(saved));
  } catch {
    // Out of space, or a browser that will not store. The basket is on screen
    // and the operator is standing in front of it; there is nothing to say.
  }
}

/**
 * What was on screen when this till was last running, if it is still relevant.
 *
 * Answers null for another event's basket and for a stale one — see
 * ``BASKET_KEEPS_FOR_MS`` — and drops what it will not return, so a basket
 * that has expired cannot come back after a second reload.
 */
export function loadBasket(event: string): { cart: CartLine[]; credit: Credit | null } | null {
  const saved = readJson<SavedBasket | null>(BASKET_KEY, null);
  if (!saved || saved.event !== event || !Array.isArray(saved.cart)) {
    return null;
  }
  const age = Date.now() - new Date(saved.at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > BASKET_KEEPS_FOR_MS) {
    clearBasket();
    return null;
  }
  return { cart: saved.cart, credit: saved.credit ?? null };
}

export function clearBasket(): void {
  localStorage.removeItem(BASKET_KEY);
}
