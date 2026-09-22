import { useEffect, useState } from "react";

import { api } from "../api";
import { eventDay } from "../events";
import { t } from "../i18n";
import type { Pairing, PosEvent, UnavailableEvent } from "../types";

/**
 * Events as a column of buttons, one tap each.
 *
 * The pairing screen's list, and the way out of an event that will not open.
 * The day under the name, because two evenings of one organiser are very
 * often called the same.
 */
export function EventButtons({
  events, onPick,
}: {
  events: PosEvent[];
  onPick: (slug: string) => void;
}) {
  return (
    <div className="event-list">
      {events.map((event) => (
        <button key={event.slug} type="button" onClick={() => onPick(event.slug)}>
          {event.name}
          <span className="slug">
            {[eventDay(event.date_from), event.testmode ? t("testmode") : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * An event named inside a sentence: "Bal (sam. 31 oct.)".
 *
 * The list's "Bal · sam. 31 oct." would put the abbreviation's full stop
 * against the sentence's own when it comes last.
 */
function inSentence(event: PosEvent): string {
  const day = eventDay(event.date_from);
  return day ? `${event.name} (${day})` : event.name;
}

/**
 * Why the events this device may reach but cannot sell for are not offered.
 *
 * Said by name. The event somebody is looking for, when the one they expected
 * is missing, is usually among these, and the fix is one tick in the back
 * office rather than a new pairing.
 */
export function UnavailableEvents({ events }: { events: UnavailableEvent[] }) {
  const disabled = events.filter((event) => event.reason === "plugin_disabled");
  // A reason this build does not know yet, from a server newer than itself:
  // still named, without claiming a cause that may not be the one.
  const other = events.filter((event) => event.reason !== "plugin_disabled");
  return (
    <>
      {disabled.length > 0 && (
        <div className="attendance-note">
          {t("events.pluginDisabled", { names: disabled.map(inSentence).join(", ") })}
        </div>
      )}
      {other.length > 0 && (
        <div className="attendance-note">
          {t("events.unavailable", { names: other.map(inSentence).join(", ") })}
        </div>
      )}
    </>
  );
}

/**
 * The way out of an event that will not open, when this device has another.
 *
 * Without it a till stuck on its event — Open POS switched off there, a series
 * with nothing on tonight — offered to retry for ever, or to unpair, which
 * costs a new code from the back office, while the event it was wanted for
 * was one tap away all along.
 */
export function OtherEvents({
  pairing, onPick,
}: {
  pairing: Pairing;
  onPick: (slug: string) => void;
}) {
  const [others, setOthers] = useState<PosEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .posEvents(pairing.organizer, pairing.token)
      .then((data) => {
        if (!cancelled) setOthers(data.results.filter((event) => event.slug !== pairing.event));
      })
      .catch(() => {
        // The screen already says what went wrong. With no list there is
        // simply no way out to offer, which is where it stood before.
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  if (others.length === 0) return null;
  return (
    <div style={{ marginTop: 22 }}>
      <div className="divider">{t("error.otherEvent")}</div>
      <EventButtons events={others} onPick={onPick} />
    </div>
  );
}
