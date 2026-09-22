import { useEffect, useState } from "react";

import { api } from "../api";
import { loadQueue } from "../storage";
import { locale, t } from "../i18n";
import { formatMoney, toCents } from "../money";
import { THEMES, type Theme } from "../theme";
import type { Pairing, PosEvent, SummaryResponse, Takings } from "../types";

interface Props {
  pairing: Pairing;
  currency: string;
  cashier: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
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

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** The cash half of what is still queued, which is what the drawer holds. */
function queuedCash(entries: { paymentType: string; chargedTotal: string }[]): number {
  return entries
    .filter((entry) => entry.paymentType === "cash")
    .reduce((sum, entry) => sum + toCents(entry.chargedTotal), 0);
}

function TakingsRow({ label, takings, currency }: { label: string; takings: Takings; currency: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{takings.count}</td>
      <td>{formatMoney(toCents(takings.cash), currency)}</td>
      <td>{formatMoney(toCents(takings.card), currency)}</td>
      <td>
        <strong>{formatMoney(toCents(takings.total), currency)}</strong>
      </td>
    </tr>
  );
}

export default function SettingsPanel({
  pairing, currency, cashier, theme, onThemeChange, onCashierChange, onRefresh, onUnpair,
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
  const [events, setEvents] = useState<PosEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .posEvents(pairing.organizer, pairing.token)
      .then((data) => {
        if (!cancelled) setEvents(data.results);
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
  useEffect(() => {
    let cancelled = false;
    setSummaryFailed(false);
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
      });
    return () => {
      cancelled = true;
    };
  }, [pairing, attempt]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("settings.title")}</h2>

        {events && events.length > 1 && (
          <div className="field">
            <label htmlFor="event">{t("settings.event")}</label>
            <select
              id="event"
              className="select"
              value={pairing.event}
              onChange={(e) => onEventChange(e.target.value)}
            >
              {events.map((event) => (
                <option key={event.slug} value={event.slug}>
                  {event.name}
                  {event.testmode ? " · " + t("testmode") : ""}
                </option>
              ))}
            </select>
            <div className="help">{t("settings.eventHelp")}</div>
          </div>
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

        <h3 style={{ fontSize: 16, marginTop: 24 }}>{t("summary.title")}</h3>
        {summary ? (
          <table className="takings">
            <thead>
              <tr>
                <th />
                <th>{t("summary.sales")}</th>
                <th>{t("summary.cash")}</th>
                <th>{t("summary.card")}</th>
                <th>{t("summary.total")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.device && (
                <TakingsRow label={t("summary.thisTill")} takings={summary.device} currency={currency} />
              )}
              <TakingsRow label={t("summary.allTills")} takings={summary.event} currency={currency} />
            </tbody>
          </table>
        ) : null}
        {summary && summary.event.cancellations > 0 && (
          // Said out loud rather than left to be discovered: the amounts above
          // are net, so a drawer that is short by exactly a cancelled sale is
          // not short at all.
          <div className="attendance-note">
            {t("summary.cancellations", { n: summary.event.cancellations })}
          </div>
        )}
        {summary && (summary.event.deposit_refunds ?? 0) > 0 && (
          // Same reasoning, and the figure is easier to be surprised by: a
          // night of returned cups is money out of the drawer with not one
          // sale to show for it.
          <div className="attendance-note">
            {t("summary.depositRefunds", { n: summary.event.deposit_refunds ?? 0 })}
          </div>
        )}
        {summary && (
          // A till day starts at six in the morning, so a bar that closes at
          // 5:40 and counts the drawer at 6:15 reads zeros everywhere. True,
          // and useless without this line.
          <div className="attendance-note">
            {t("summary.since", { time: time(summary.since) })}
          </div>
        )}
        {queued.length > 0 && (
          <div className="attendance-note">
            {t("summary.queued", {
              n: queued.length,
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
    </div>
  );
}
