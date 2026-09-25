import { ApiError } from "./api";
import { t } from "./i18n";

/**
 * What to put on screen when a request did not work.
 *
 * A transport failure has no message worth reading — "Failed to fetch" tells a
 * cashier nothing — so it becomes the one sentence that is actually actionable
 * at a counter: the till cannot reach the server. A refusal (a 4xx) carries the
 * server's own words, which are written for this screen, and passes through.
 *
 * Two answers are neither, and used to reach the screen raw. A fault (5xx) is
 * almost never pretix speaking: it is a proxy's error page for a backend that
 * is restarting or overloaded, which the API layer can only render as
 * "HTTP 502" — and what an operator can do about it is the same whatever the
 * page said, try again in a moment. The status stays in the sentence because
 * it is what the person on the phone to the organiser will be asked for. Too
 * many requests (429) is the server asking the device to slow down; its own
 * body is framework prose about throttling, and the useful sentence is "wait a
 * few seconds", which is also all a retry needs.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isNetwork) return t("error.offline");
    if (err.status === 429) return t("error.tooMany");
    if (err.status >= 500) return t("error.server", { status: err.status });
    return err.message;
  }
  return String(err);
}
