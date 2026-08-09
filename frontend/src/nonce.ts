/**
 * Random identifier for requests that must not be replayed.
 *
 * Used for the checkout idempotency key and the check-in nonce. crypto.randomUUID
 * needs a secure context, which the app has in production but not necessarily on
 * a bare-HTTP dev box — fall back rather than crash the till.
 */
export function newNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
