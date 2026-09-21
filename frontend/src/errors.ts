import { ApiError } from "./api";
import { t } from "./i18n";

/**
 * What to put on screen when a request did not work.
 *
 * A transport failure has no message worth reading — "Failed to fetch" tells a
 * cashier nothing — so it becomes the one sentence that is actually actionable
 * at a counter: the till cannot reach the server. Everything else already
 * carries the server's own words, which are written for this screen.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.isNetwork ? t("error.offline") : err.message;
  return String(err);
}
