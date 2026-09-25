import type {
  CartLine, Credit, DeviceDescription, DoorScans, OfflineSnapshot, OrphanPayment, Pairing,
  PendingMovement, PendingPayment, QueueEntry, SyncFailure,
} from "./types";

const PAIRING_KEY = "openpos.pairing.v1";
const DEVICE_REPORT_KEY = "openpos.deviceReport.v1";
const CASHIER_KEY = "openpos.cashier.v1";
const QUEUE_KEY = "openpos.queue.v1";
const FAILURES_KEY = "openpos.failures.v1";
const SNAPSHOT_KEY = "openpos.snapshot.v1";
const UPDATE_KEY = "openpos.updateTried.v1";
const BASKET_KEY = "openpos.basket.v1";
const REVOKE_KEY = "openpos.revoke.v1";
const PAYMENT_KEY = "openpos.payment.v1";
const ORPHANS_KEY = "openpos.orphans.v1";
const LAST_SYNC_KEY = "openpos.lastSync.v1";
const MOVEMENT_KEY = "openpos.drawerMove.v1";

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
 * File one refusal, and say whether it is on disk.
 *
 * The drain takes an entry out of the queue only once its refusal is kept
 * here: a refused sale that could be written nowhere used to be dropped from
 * the queue all the same, and then existed nowhere at all. Filed once per
 * entry, so a refusal filed by a run that could not then rewrite the queue is
 * not filed a second time when the next run meets the same entry.
 */
export function addFailure(failure: SyncFailure): boolean {
  const failures = loadFailures();
  if (failures.some((filed) => filed.entry.id === failure.entry.id)) return true;
  try {
    localStorage.setItem(FAILURES_KEY, JSON.stringify([...failures, failure]));
    return true;
  } catch {
    return false;
  }
}

/**
 * When a sync run last sent everything it could, for the back office.
 *
 * Reported with the queue itself (see useDeviceStatus): a device holding
 * sales that has not managed a full run for an hour is the one somebody
 * should go and look at.
 */
export function loadLastSync(): string | null {
  const saved = readJson<unknown>(LAST_SYNC_KEY, null);
  return typeof saved === "string" ? saved : null;
}

export function saveLastSync(at: string): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(at));
  } catch {
    // Only the report loses a figure.
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

/**
 * The last count of the event's scans the server gave this device.
 *
 * So a door that iOS reloads while the network is down opens on the event's
 * figure rather than on zero, which is the very complaint the server-side count
 * answers. Kept per event, for as long as there is one: the count is the whole
 * event's, not an evening's. `v2`, because a `v1` figure was tonight's alone.
 */
export function loadDoorScans(event: string): DoorScans | null {
  const saved = readJson<DoorScans | null>(`openpos.doorScans.v2.${event}`, null);
  return typeof saved?.event?.admitted === "number" ? saved : null;
}

export function saveDoorScans(event: string, scans: DoorScans): void {
  try {
    localStorage.setItem(`openpos.doorScans.v2.${event}`, JSON.stringify(scans));
  } catch {
    // Costs the figure after a reload with no network, and nothing else.
  }
}

const DOOR_LIST_PREFIX = "openpos.doorList.v1.";

/**
 * The check-in list last chosen at this event's door.
 *
 * It used to live in memory only, so every relaunch — iOS reclaiming the app
 * in the background, a reload for an update — put a door switched to the
 * guest list back on the event's default one, and nobody notices that until
 * somebody is turned away. Per event, because a list is one event's.
 * Whether the list still exists is for the caller to check: it may have been
 * deleted in pretix since.
 */
export function loadDoorList(event: string): number | null {
  const saved = readJson<unknown>(`${DOOR_LIST_PREFIX}${event}`, null);
  return typeof saved === "number" && Number.isInteger(saved) ? saved : null;
}

export function saveDoorList(event: string, list: number): void {
  try {
    localStorage.setItem(`${DOOR_LIST_PREFIX}${event}`, JSON.stringify(list));
  } catch {
    // The choice holds until the next relaunch, as it always used to.
  }
}

/** Every event's choice: the device is being handed back. */
export function clearDoorLists(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DOOR_LIST_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Nothing more to do about a storage that refuses to be read.
  }
}

const ADMISSIONS_PREFIX = "openpos.admitted.v1.";

/** List id → ticket secret → when: `Admissions` in offline.ts, which says why. */
type AdmissionRecord = Record<string, Record<string, number>>;

/**
 * The tickets let in at this device, per event — see Admissions in offline.ts.
 *
 * Kept per event, and dropped with the guest list: a device that leaves the
 * event, or the door, has no use for either.
 */
export function loadAdmissions(event: string): AdmissionRecord {
  const saved = readJson<AdmissionRecord | null>(`${ADMISSIONS_PREFIX}${event}`, null);
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

export function saveAdmissions(event: string, admissions: AdmissionRecord): void {
  try {
    if (Object.keys(admissions).length) {
      localStorage.setItem(`${ADMISSIONS_PREFIX}${event}`, JSON.stringify(admissions));
    } else {
      localStorage.removeItem(`${ADMISSIONS_PREFIX}${event}`);
    }
  } catch {
    // Storage full: the record holds for as long as the door screen is open,
    // and the queue still covers what was admitted offline.
  }
}

export function clearAdmissions(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(ADMISSIONS_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Nothing more to do about a storage that refuses to be read.
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

const SNAPSHOT_PULL_KEY = "openpos.snapshotPull.v1";

/**
 * Forget the guest list, and when it was last asked for.
 *
 * Every name and every ticket secret of an event is not something a device
 * keeps once it has no business with that event's door: unpaired, moved to
 * another event, made a bar till, or told by the server that it is not a door.
 */
export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(SNAPSHOT_PULL_KEY);
  } catch {
    // Storage refused even this; nothing more can be done about it here.
  }
}

/** When a pull of the guest list last set off, for which event and list. */
export interface SnapshotPull {
  event: string;
  list: number;
  at: number;
}

/**
 * The last pull of the guest list, whoever made it.
 *
 * On disk rather than in the hook that pulls, because two screens pull —
 * the app while the door is closed, the door while it is open — and a reload
 * starts both from nothing: kept in each, a door stepping out to the grid and
 * back pulled the whole list at every round trip.
 */
export function loadSnapshotPull(): SnapshotPull | null {
  const saved = readJson<SnapshotPull | null>(SNAPSHOT_PULL_KEY, null);
  return typeof saved?.at === "number" && typeof saved.list === "number" ? saved : null;
}

export function saveSnapshotPull(pull: SnapshotPull): void {
  try {
    localStorage.setItem(SNAPSHOT_PULL_KEY, JSON.stringify(pull));
  } catch {
    // The next screen pulls a little early; the list itself is unaffected.
  }
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
 * Tokens of pairings this till has given up, until pretix has heard so.
 *
 * The token was already in this storage, under the pairing. It stays exactly
 * as long as it takes to tell pretix it is dead — see `useDeviceRevoke` — and
 * not a request longer.
 */
export function loadRevocations(): string[] {
  const saved = readJson<unknown>(REVOKE_KEY, []);
  return Array.isArray(saved)
    ? saved.filter((token): token is string => typeof token === "string" && token !== "")
    : [];
}

export function queueRevocation(token: string): void {
  const pending = loadRevocations();
  if (!pending.includes(token)) writeRevocations([...pending, token]);
}

export function forgetRevocation(token: string): void {
  writeRevocations(loadRevocations().filter((pending) => pending !== token));
}

function writeRevocations(tokens: string[]): void {
  try {
    if (tokens.length) localStorage.setItem(REVOKE_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(REVOKE_KEY);
  } catch {
    // Storage refused: the device stays active in the back office until
    // somebody revokes it there, which is where every unpairing used to end.
  }
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
  try {
    return localStorage.getItem(UPDATE_KEY);
  } catch {
    // Read at startup: a storage that refuses must not stop the till opening.
    return null;
  }
}

export function saveUpdateAttempt(version: string): void {
  try {
    localStorage.setItem(UPDATE_KEY, version);
  } catch {
    // Worst case the prompt is offered again after the reload. Harmless.
  }
}

const DOOR_RESUME_KEY = "openpos.resumeDoor.v1";

/**
 * How long "reopen the door" stays good for after an update reload.
 *
 * The reload itself takes seconds. Past a few minutes the app was not
 * started by that reload but by somebody, later, who may want the grid.
 */
export const DOOR_RESUME_KEEPS_FOR_MS = 5 * 60_000;

/**
 * The door screen was on when the app reloaded itself for an update.
 *
 * A door device opens on the scanner by itself, but a device that does both
 * jobs opens on the grid — and an update that lands while it is scanning
 * would otherwise leave the queue at the door facing a till. Written just
 * before the reload, read when the new build starts, and cleared once acted
 * upon.
 */
export function saveDoorResume(): void {
  try {
    localStorage.setItem(DOOR_RESUME_KEY, String(Date.now()));
  } catch {
    // The new build opens on the grid, one tap from the door.
  }
}

export function loadDoorResume(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(DOOR_RESUME_KEY) ?? NaN);
    // Either way round: a clock put back by the reload's few seconds is no
    // reason to ignore it, and one far off either way is not this reload's.
    return Number.isFinite(at) && Math.abs(now - at) <= DOOR_RESUME_KEEPS_FOR_MS;
  } catch {
    return false;
  }
}

export function clearDoorResume(): void {
  try {
    localStorage.removeItem(DOOR_RESUME_KEY);
  } catch {
    // Expires by itself; see DOOR_RESUME_KEEPS_FOR_MS.
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

/**
 * Whether a moment written down at ``at`` is still recent, by this device's clock.
 *
 * False for a date that does not parse and for one in the future — a clock
 * turned back since — because both are a record nothing can be concluded
 * from, and every caller's safe answer to "is this still the moment it was?"
 * is then no.
 */
function isRecent(at: string, withinMs: number): boolean {
  const age = Date.now() - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= withinMs;
}

/**
 * How long a payment interrupted by a reload is still the one in front of
 * somebody: the same half hour as the basket it was made from, for the same
 * reasons — see ``BASKET_KEEPS_FOR_MS``.
 *
 * An older one is not forgotten. A sale that was sent is queued, because the
 * money changed hands whatever became of the request; a reader payment is
 * kept aside and asked about, like any other the till walked away from.
 */
export const PAYMENT_RESUMES_WITHIN_MS = BASKET_KEEPS_FOR_MS;

/**
 * Write the payment down before its request leaves.
 *
 * Says whether it is on disk, and never throws: a till with a full disk still
 * sells online, where the server keeps the sale — what it loses is only the
 * ability to pick up a payment interrupted by a reload.
 */
export function savePendingPayment(payment: PendingPayment): boolean {
  try {
    localStorage.setItem(PAYMENT_KEY, JSON.stringify(payment));
    return true;
  } catch {
    return false;
  }
}

/** The payment that was on its way when the till last stopped, whoever it was for. */
export function loadPendingPayment(): PendingPayment | null {
  const saved = readJson<Partial<PendingPayment> | null>(PAYMENT_KEY, null);
  if (
    !saved ||
    typeof saved.key !== "string" ||
    typeof saved.event !== "string" ||
    (saved.stage !== "reader" && saved.stage !== "sale") ||
    !Array.isArray(saved.cart) ||
    typeof saved.at !== "string"
  ) {
    return null;
  }
  return saved as PendingPayment;
}

/** Whether a pending payment is still the one on screen, as opposed to a leftover. */
export function isResumable(payment: PendingPayment, event: string): boolean {
  return payment.event === event && isRecent(payment.at, PAYMENT_RESUMES_WITHIN_MS);
}

/**
 * Forget the payment on its way, once it has arrived or will not.
 *
 * With a key, only if it is still that payment: an answer for an attempt the
 * till has since moved on from must not wipe the record of the one after it.
 */
export function clearPendingPayment(key?: string): void {
  if (key !== undefined && loadPendingPayment()?.key !== key) return;
  try {
    localStorage.removeItem(PAYMENT_KEY);
  } catch {
    // Storage that cannot even delete: the record comes back at the next
    // launch, is sent again under its key, and the server answers it as the
    // replay it is.
  }
}

/**
 * How long a reader payment left aside is worth asking about.
 *
 * SumUp settles a reader checkout within minutes one way or the other; a day
 * is far past that, and bounds a list that would otherwise only grow on a
 * tablet whose server stopped knowing the keys — after a pairing, say.
 */
export const ORPHAN_KEEPS_FOR_MS = 24 * 3600_000;

/**
 * Reader payments left aside, still to be asked about or still to be read.
 *
 * A paid one stays until somebody has acknowledged it, whatever its age: it
 * is a customer who may have paid twice. The others fall off after
 * ``ORPHAN_KEEPS_FOR_MS``.
 */
export function loadOrphans(): OrphanPayment[] {
  const saved = readJson<unknown>(ORPHANS_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter(
    (orphan): orphan is OrphanPayment =>
      typeof orphan?.key === "string" &&
      typeof orphan.event === "string" &&
      typeof orphan.at === "string" &&
      (orphan.paid === true || isRecent(orphan.at, ORPHAN_KEEPS_FOR_MS)),
  );
}

function writeOrphans(orphans: OrphanPayment[]): void {
  try {
    if (orphans.length) localStorage.setItem(ORPHANS_KEY, JSON.stringify(orphans));
    else localStorage.removeItem(ORPHANS_KEY);
  } catch {
    // The payment is still in the back office's list of card payments with
    // no sale; this till only loses the chance to say so itself.
  }
}

export function addOrphan(orphan: OrphanPayment): void {
  const orphans = loadOrphans();
  if (!orphans.some((kept) => kept.key === orphan.key)) writeOrphans([...orphans, orphan]);
}

export function updateOrphan(key: string, changes: Partial<OrphanPayment>): void {
  writeOrphans(loadOrphans().map((orphan) => (orphan.key === key ? { ...orphan, ...changes } : orphan)));
}

export function dropOrphan(key: string): void {
  writeOrphans(loadOrphans().filter((orphan) => orphan.key !== key));
}

/**
 * Write a drawer movement down before it is sent.
 *
 * The key is the point: kept with the figures until the server has answered
 * for it, so a movement whose answer was lost is sent again as the same one —
 * after the panel was closed, after a reload, after the reason was retouched
 * — and the server hands back the entry it already made instead of making a
 * second one.
 */
export function savePendingMovement(movement: PendingMovement): void {
  try {
    localStorage.setItem(MOVEMENT_KEY, JSON.stringify(movement));
  } catch {
    // Kept in memory by the panel for as long as it stays open.
  }
}

/** The movement this device sent and never heard back about, if it is recent. */
export function loadPendingMovement(serial: string, event: string): PendingMovement | null {
  const saved = readJson<Partial<PendingMovement> | null>(MOVEMENT_KEY, null);
  if (
    !saved ||
    saved.serial !== serial ||
    saved.event !== event ||
    typeof saved.key !== "string" ||
    typeof saved.at !== "string" ||
    !isRecent(saved.at, PAYMENT_RESUMES_WITHIN_MS)
  ) {
    return null;
  }
  return saved as PendingMovement;
}

export function clearPendingMovement(): void {
  try {
    localStorage.removeItem(MOVEMENT_KEY);
  } catch {
    // It comes back at the next opening and is sent again under its key.
  }
}
