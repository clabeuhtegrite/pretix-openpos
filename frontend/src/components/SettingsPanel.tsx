import { useEffect, useState } from "react";

import { api } from "../api";
import { eventLabel } from "../events";
import { loadQueue } from "../storage";
import { t, tn } from "../i18n";
import { formatMoney, toCents } from "../money";
import { THEMES, type Theme } from "../theme";
import type { Pairing, PosEventList, SummaryResponse } from "../types";
import { useBackClose } from "../useBackClose";
import { UnavailableEvents } from "./EventChoice";
import TakingsPanel, { scopeLabel, TakingsLine } from "./TakingsPanel";

interface Props {
  pairing: Pairing;
  currency: string;
  cashier: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  sound: boolean;
  onSoundChange: (on: boolean) => void;
  onCashierChange: (name: string) => void;
  onRefresh: () => void;
  onUnpair: () => void;
  onClose: () => void;
  onEventChange: (slug: string) => void;
}

/** Label per theme, kept next to the list it labels. */
const THEME_LABELS: Record<Theme, "settings.themeSystem" | "settings.themeLight" | "settings.themeDark"> = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
};

/** The cash half of what is still queued, which is what the drawer holds. */
function queuedCash(entries: { paymentType: string; chargedTotal: string }[]): number {
  return entries
    .filter((entry) => entry.paymentType === "cash")
    .reduce((sum, entry) => sum + toCents(entry.chargedTotal), 0);
}

/**
 * Which event this device sells for, and every other one it could.
 *
 * Shown as soon as the list is in, not only once there is something to pick.
 * A device with a single event and a device whose other events were all out
 * of reach used to look exactly alike — no field at all — and the second is
 * the one somebody opens this panel to sort out, looking for a switch that
 * was simply not drawn.
 */
function EventField({
  list, current, deviceName, onChange,
}: {
  list: PosEventList;
  current: string;
  deviceName: string;
  onChange: (slug: string) => void;
}) {
  const unavailable = list.unavailable ?? [];
  const sellable = list.results.some((event) => event.slug === current);
  const here =
    list.results.find((event) => event.slug === current) ??
    unavailable.find((event) => event.slug === current);
  const hereLabel = here ? eventLabel(here) : current;

  if (!list.results.some((event) => event.slug !== current)) {
    return (
      <div className="field">
        <span className="field-label">{t("settings.event")}</span>
        <div className="field-value">{hereLabel}</div>
        {sellable && unavailable.length === 0 && (
          // Nothing else it could reach, so the answer is on the device
          // itself, in the back office — which is worth naming, because from
          // here "one event" and "no switch" look the same as a missing button.
          <div className="help">{t("settings.eventOnly", { device: deviceName })}</div>
        )}
        <UnavailableEvents events={unavailable} />
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor="event">{t("settings.event")}</label>
      <select
        id="event"
        className="select"
        value={current}
        onChange={(e) => onChange(e.target.value)}
      >
        {!sellable && (
          // Still open on an event it can no longer sell for, Open POS having
          // been switched off under it. Named for what it is, rather than
          // letting the select show the first of the others as if chosen.
          <option value={current} disabled>
            {hereLabel}
          </option>
        )}
        {list.results.map((event) => (
          <option key={event.slug} value={event.slug}>
            {eventLabel(event)}
          </option>
        ))}
      </select>
      <div className="help">{t("settings.eventHelp")}</div>
      <UnavailableEvents events={unavailable} />
    </div>
  );
}

export default function SettingsPanel({
  pairing, currency, cashier, theme, onThemeChange, sound, onSoundChange, onCashierChange,
  onRefresh, onUnpair,
  onClose, onEventChange,
}: Props) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  /**
   * What this till is still holding, which the figures below cannot know.
   *
   * The takings come from the server, so a sale encashed during a dropout and
   * still in the queue is not in them. At half past one somebody compares this
   * screen with the drawer and finds a difference with nothing on the screen
   * to explain it — while the badge that would have explained it lives in the
   * top bar, two screens away.
   */
  const [queued] = useState(() => loadQueue().filter((entry) => entry.kind === "sale"));
  const [events, setEvents] = useState<PosEventList | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  useBackClose(detailOpen, () => setDetailOpen(false));

  useEffect(() => {
    let cancelled = false;
    api
      .posEvents(pairing.organizer, pairing.token)
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {
        // The switcher is a convenience; failing to list events must not stop
        // the operator from reaching the rest of the panel.
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setSummaryFailed(false);
    setLoading(true);
    api
      .summary(pairing)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        // Still not a reason to block the operator from getting back to
        // selling — but not a reason to show three dots for ever either. This
        // is the closing-time screen, and at half past one a spinner that
        // never resolves is worse than a sentence saying what happened.
        if (!cancelled) setSummaryFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pairing, attempt]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("settings.title")}</h2>

        {events && (
          <EventField
            list={events}
            current={pairing.event}
            deviceName={pairing.deviceName}
            onChange={onEventChange}
          />
        )}

        <div className="field">
          <label htmlFor="cashier">{t("settings.cashier")}</label>
          <input
            id="cashier"
            value={cashier}
            onChange={(e) => onCashierChange(e.target.value)}
            autoCapitalize="words"
            autoComplete="off"
          />
          <div className="help">{t("settings.cashierHelp")}</div>
        </div>

        {/* Three buttons rather than a select: it is a choice of three, it is
            made with a thumb, and the answer is visible without opening
            anything. */}
        <div className="field">
          <span className="field-label">{t("settings.theme")}</span>
          <div className="segmented" role="group" aria-label={t("settings.theme")}>
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                className="btn"
                aria-pressed={theme === option}
                onClick={() => onThemeChange(option)}
              >
                {t(THEME_LABELS[option])}
              </button>
            ))}
          </div>
          <div className="help">{t("settings.themeHelp")}</div>
        </div>

        {/* The same two buttons as the palette above, because it is the same
            kind of answer and a till should not have two ways of saying yes. */}
        <div className="field">
          <span className="field-label">{t("settings.sound")}</span>
          <div className="segmented" role="group" aria-label={t("settings.sound")}>
            <button
              type="button"
              className="btn"
              aria-pressed={sound}
              onClick={() => onSoundChange(true)}
            >
              {t("settings.soundOn")}
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={!sound}
              onClick={() => onSoundChange(false)}
            >
              {t("settings.soundOff")}
            </button>
          </div>
          <div className="help">{t("settings.soundHelp")}</div>
        </div>

        <h3 style={{ fontSize: 16, marginTop: 24 }}>{t("summary.title")}</h3>
        {summary?.scope.series && (
          // Which date of the series, since the field above names only the
          // series: its takings are one date's, and the next one starts at zero.
          <div className="attendance-note" style={{ marginTop: -4, marginBottom: 6 }}>
            {scopeLabel(summary.scope)}
          </div>
        )}
        {summary && (
          // Lines rather than the five-column table this used to be: on a
          // phone held upright, the card column and the total ran off the
          // right-hand edge of the panel.
          <ul className="takings-lines">
            {summary.device && (
              <TakingsLine name={t("summary.thisTill")} takings={summary.device} currency={currency} />
            )}
            <TakingsLine name={t("summary.allTills")} takings={summary.event} currency={currency} />
          </ul>
        )}
        {queued.length > 0 && (
          <div className="attendance-note">
            {tn("summary.queued", queued.length, {
              amount: formatMoney(queuedCash(queued), currency),
            })}
          </div>
        )}
        {!summary && !summaryFailed && (
          <p style={{ color: "var(--text-dim)" }}>…</p>
        )}
        {!summary && summaryFailed && (
          <div className="attendance-note">
            {t("summary.failed")}{" "}
            <button className="btn ghost" onClick={() => setAttempt((n) => n + 1)}>
              {t("summary.retry")}
            </button>
          </div>
        )}
        {summary && (
          // The detail on a panel of its own: by product it runs as long as
          // the menu, and everything else on this screen would end up under it.
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => setDetailOpen(true)}
          >
            {t("summary.detail")}
          </button>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}>
          <button className="btn ghost" onClick={onRefresh}>
            {t("settings.refresh")}
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(t("settings.unpairConfirm"))) onUnpair();
            }}
          >
            {t("settings.unpair")} ({pairing.serial})
          </button>
          <button className="btn primary" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>

      {detailOpen && (
        <TakingsPanel
          summary={summary}
          failed={summaryFailed}
          busy={loading}
          currency={currency}
          queued={{ count: queued.length, cashCents: queuedCash(queued) }}
          onRefresh={() => setAttempt((n) => n + 1)}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  );
}
