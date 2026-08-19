import { newNonce } from "./nonce";

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
 */
export interface CancellationKeys {
  /** The key to send for this sale, minting one on first use. */
  for(seq: number): string;
  /** Drop it once the server has answered: the next cancellation is a new one. */
  settle(seq: number): void;
}

export function cancellationKeys(mint: () => string = newNonce): CancellationKeys {
  const keys = new Map<number, string>();
  return {
    for(seq) {
      const existing = keys.get(seq);
      if (existing !== undefined) return existing;
      const minted = mint();
      keys.set(seq, minted);
      return minted;
    },
    settle(seq) {
      keys.delete(seq);
    },
  };
}
