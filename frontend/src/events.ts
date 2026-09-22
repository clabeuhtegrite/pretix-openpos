import { locale, t } from "./i18n";
import type { PosEvent } from "./types";

/**
 * The day an event is on, the way a volunteer says it: "sam. 19 sept."
 *
 * An organiser's events are very often called the same — the next one is a
 * copy of the last — and a list of identical names is no choice at all. The
 * year only when it is not this one, which is the only time it tells two
 * evenings apart.
 */
export function eventDay(iso: string | null, today = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** One line per event: its name, its day, and whether it is a rehearsal. */
export function eventLabel(event: PosEvent): string {
  return [event.name, eventDay(event.date_from), event.testmode ? t("testmode") : ""]
    .filter(Boolean)
    .join(" · ");
}
