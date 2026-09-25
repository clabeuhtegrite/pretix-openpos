import { newNonce } from "./nonce";
import type { CancelResult } from "./types";

/**
 * One idempotency key per sale being cancelled, held until it has been used.
 *
 * A cancellation carries a key for the same reason a sale does: the request can
 * time out after the server has already committed it, and the retry has to be
 * recognised as the same cancellation rather than attempted a second time. That
 * only works if the retry sends the *same* key — which is exactly what an
 * earlier version got wrong, minting a fresh one on every press. The server then
 * saw a new cancellation of an already-cancelled sale, answered "this sale has
 * already been cancelled", and the operator lost the credit-note screen and the
 * corrected-basket flow for a cancellation that had in fact gone through.
 *
 * So the key belongs to the sale, not to the attempt. It is minted the first
 * time a given journal entry is cancelled and kept until the server has
 * answered for it — success or refusal, both of which are final.
 *
 * Kept on the device, not in the panel. The next version still lost it: kept in
 * the history panel, it went with the panel — closed by a tap beside it, by the
 * back gesture, by iOS reloading the app — and the retry after a timeout was a
 * new cancellation again. On disk, per till and event, it survives all three.
 */
export interface CancellationKeys {
  /** The key to send for this sale, minting one on first use. */
  for(seq: number): string;
  /** Drop it once the server has answered: the next cancellation is a new one. */
  settle(seq: number): void;
  /**
   * Whether a cancellation of this sale went out from here and was never
   * answered — the one case where asking again is the only way to learn what
   * became of it.
   */
  pending(seq: number): boolean;
}

const KEYS_PREFIX = "openpos.cancelKeys.v1.";
const RESULT_PREFIX = "openpos.cancelResult.v1.";

/**
 * How long an answered cancellation waits on screen for the operator.
 *
 * The same half hour as a basket left on screen: past it, the customer it was
 * for has gone, and the history is the place to look it up.
 */
export const RESULT_KEEPS_FOR_MS = 30 * 60 * 1000;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused. The key still holds in memory for as long as the panel
    // is open, which is what there was before any of this was kept on disk.
  }
}

/**
 * The keys of one till on one event.
 *
 * `scope` names both — a sequence number is only unique within one device's
 * journal of one event, and a till paired again is a new device whose sale #12
 * is another sale.
 */
export function cancellationKeys(scope: string, mint: () => string = newNonce): CancellationKeys {
  const storageKey = `${KEYS_PREFIX}${scope}`;
  // Mirrored in memory, so a storage that refuses writes costs the keys across
  // a reload and nothing within one.
  const keys = new Map<string, string>();
  const saved = read<Record<string, unknown>>(storageKey);
  if (saved && typeof saved === "object") {
    for (const [seq, key] of Object.entries(saved)) {
      if (typeof key === "string") keys.set(seq, key);
    }
  }
  const persist = () => write(storageKey, keys.size ? Object.fromEntries(keys) : null);

  return {
    for(seq) {
      const existing = keys.get(String(seq));
      if (existing !== undefined) return existing;
      const minted = mint();
      keys.set(String(seq), minted);
      persist();
      return minted;
    },
    settle(seq) {
      if (keys.delete(String(seq))) persist();
    },
    pending(seq) {
      return keys.has(String(seq));
    },
  };
}

/**
 * The answer to a cancellation, until somebody has acted on it.
 *
 * It is the one screen that says how much to hand back, and it used to exist
 * only while the panel stayed open: a tap beside it dropped "Rendre 12,00 €"
 * and the correction with it, and nothing brought them back. Kept until the
 * operator picks one of the two ways out, and shown again when the panel is
 * reopened.
 */
export function saveCancellationResult(scope: string, result: CancelResult): void {
  write(`${RESULT_PREFIX}${scope}`, { result, at: Date.now() });
}

export function loadCancellationResult(scope: string, now = Date.now()): CancelResult | null {
  const saved = read<{ result?: CancelResult; at?: unknown }>(`${RESULT_PREFIX}${scope}`);
  if (!saved?.result?.cancellation || typeof saved.at !== "number") return null;
  if (now - saved.at > RESULT_KEEPS_FOR_MS) {
    write(`${RESULT_PREFIX}${scope}`, null);
    return null;
  }
  return saved.result;
}

export function clearCancellationResult(scope: string): void {
  write(`${RESULT_PREFIX}${scope}`, null);
}

/** Everything kept here, for every till and event: the device is being handed back. */
export function clearCancellations(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEYS_PREFIX) || key?.startsWith(RESULT_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // A storage that cannot be listed cannot be cleared either.
  }
}
