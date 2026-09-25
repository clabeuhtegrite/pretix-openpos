import { ApiError, isRetryable } from "./api";
import { t } from "./i18n";

/**
 * A refusal of the device (401/403) that pretix did not write.
 *
 * pretix explains every refusal of its own in JSON — "Invalid token.", "Open
 * POS is not enabled for the event" — and those words are the useful ones. An
 * answer with none is a page from whatever stands in front of it: a CDN
 * challenging the request, a firewall, a proxy that wants a login. The API
 * layer can only call that one by its status, and "HTTP 403" is all the till
 * used to say. It is also not a revocation, so nothing on screen should read
 * like one.
 *
 * "Wordless" is the body the API layer found nothing in: a page or plain text
 * rather than JSON, no body at all, or JSON without a message it could read
 * (which is when it falls back to the bare status). An error built without a
 * body is left alone — that is not an answer from anywhere.
 */
export function wordlessRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) return false;
  return err.body === null || typeof err.body === "string" || err.message === `HTTP ${err.status}`;
}

/**
 * Whether a failure leaves the request's fate open — "not now" rather than
 * "no" — for the two screens that act on the difference themselves: a
 * cancellation keeps its key for the next press, and the door answers the scan
 * from its guest list.
 *
 * isRetryable covers the transport failures and the faults, where the server
 * may or may not have done the work and only the same key can find out. Two
 * 4xx answers are not refusals either, and neither did any work: 408, a proxy
 * that gave up waiting for the rest of the request, and 429, the server
 * turning the device away before reading what it asked. Treated as final, the
 * first cost a cancellation its key and the second a queue at the door.
 */
export function unanswered(err: unknown): boolean {
  return isRetryable(err) || (err instanceof ApiError && (err.status === 408 || err.status === 429));
}

/**
 * What to put on screen when a request did not work.
 *
 * A transport failure has no message worth reading — "Failed to fetch" tells a
 * cashier nothing — so it becomes the one sentence that is actually actionable
 * at a counter: the till cannot reach the server. A refusal (a 4xx) carries the
 * server's own words, which are written for this screen, and passes through.
 *
 * Some answers are neither, and used to reach the screen raw. A fault (5xx) is
 * almost never pretix speaking: it is a proxy's error page for a backend that
 * is restarting or overloaded, which the API layer can only render as
 * "HTTP 502" — and what an operator can do about it is the same whatever the
 * page said, try again in a moment. The status stays in the sentence because
 * it is what the person on the phone to the organiser will be asked for. Too
 * many requests (429) is the server asking the device to slow down; its own
 * body is framework prose about throttling, and the useful sentence is "wait a
 * few seconds", which is also all a retry needs. A 408 is a proxy that stopped
 * waiting for the request on a slow network: the same "try again". And a 401
 * or 403 without a word from pretix is said as a refusal from the server or
 * from something in front of it — see wordlessRefusal.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isNetwork) return t("error.offline");
    if (err.status === 408) return t("error.timeout");
    if (err.status === 429) return t("error.tooMany");
    if (err.status >= 500) return t("error.server", { status: err.status });
    if (wordlessRefusal(err)) return t("error.denied", { status: err.status });
    return err.message;
  }
  return String(err);
}
