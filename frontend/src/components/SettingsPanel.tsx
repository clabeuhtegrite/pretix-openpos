import { useEffect, useState } from "react";

import { api } from "../api";
import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import type { Pairing, PosEvent, SummaryResponse, Takings } from "../types";

interface Props {
  pairing: Pairing;
  currency: string;
  cashier: string;
  onCashierChange: (name: string) => void;
  onRefresh: () => void;
  onUnpair: () => void;
  onClose: () => void;
  onEventChange: (slug: string) => void;
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
  pairing, currency, cashier, onCashierChange, onRefresh, onUnpair, onClose, onEventChange,
}: Props) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    api
      .summary(pairing)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        // The takings panel is informational; a failure here should not block
        // the operator from getting back to selling.
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

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
        {!summary && (
          <p style={{ color: "var(--text-dim)" }}>…</p>
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
