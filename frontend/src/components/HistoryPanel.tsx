import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../api";
import { locale, t } from "../i18n";
import { formatMoney, toCents } from "../money";
import { newNonce } from "../nonce";
import type { CancelResult, JournalLine, JournalPosition, Pairing } from "../types";

/**
 * Today's transactions on this till, and the way to undo one.
 *
 * Undoing is never an edit. Cancelling produces a credit note and a reversing
 * journal line, both of which stand next to the original sale rather than
 * replacing it; correcting an order then means ringing up a new one. That is
 * three documents where a spreadsheet would have had one line changed, and it
 * is exactly what makes the takings defensible afterwards.
 */

interface Props {
  pairing: Pairing;
  currency: string;
  cashier: string;
  /** Put the lines of a cancelled sale back in the basket, ready to be corrected. */
  onReuse: (positions: JournalPosition[]) => void;
  onClose: () => void;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function lineLabel(position: JournalPosition): string {
  return position.variation_name
    ? `${position.item_name} · ${position.variation_name}`
    : position.item_name;
}

export default function HistoryPanel({ pairing, currency, cashier, onReuse, onClose }: Props) {
  const [lines, setLines] = useState<JournalLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CancelResult | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.history(pairing);
      setLines(data.results);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.isNetwork ? t("error.offline") : String(e));
    }
  }, [pairing]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = lines?.find((line) => line.seq === openSeq) ?? null;

  async function cancel(line: JournalLine) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelSale(pairing, {
        seq: line.seq,
        // Minted per attempt and reused on retry, so a timeout cannot cancel twice.
        idempotency_key: newNonce(),
        cashier,
        reason: reason.trim(),
      });
      setDone(result);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay overlay-top" onClick={onClose}>
      <div className="panel history-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("history.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

        {done ? (
          <div className="history-done">
            <div className="history-done-headline">{t("history.cancelled")}</div>
            <div className="history-done-meta">
              {t("history.cancelledMeta", {
                order: done.sale?.order ?? "",
                total: formatMoney(Math.abs(toCents(done.cancellation.total)), currency),
              })}
            </div>
            {done.credit_note && (
              <div className="history-done-meta">
                {t("history.creditNote", { number: done.credit_note })}
              </div>
            )}
            {done.cancellation.payment_type === "card" && (
              <div className="history-warn">{t("history.refundCard")}</div>
            )}
            {done.cancellation.payment_type === "cash" && (
              <div className="history-warn">
                {t("history.refundCash", {
                  total: formatMoney(Math.abs(toCents(done.cancellation.total)), currency),
                })}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
              {done.sale && done.sale.positions.length > 0 && (
                <button
                  className="btn primary"
                  onClick={() => {
                    onReuse(done.sale!.positions);
                    onClose();
                  }}
                >
                  {t("history.reuse")}
                </button>
              )}
              <button
                className="btn ghost"
                onClick={() => {
                  setDone(null);
                  setOpenSeq(null);
                }}
              >
                {t("history.back")}
              </button>
            </div>
          </div>
        ) : selected ? (
          <>
            <div className="history-detail-head">
              <button className="btn ghost" onClick={() => setOpenSeq(null)}>
                ← {t("history.back")}
              </button>
            </div>
            <div className="history-meta">
              #{selected.seq} · {selected.order} · {time(selected.datetime)} ·{" "}
              {t(selected.payment_type === "cash" ? "payment.cash" : "payment.card")}
              {selected.cashier ? ` · ${selected.cashier}` : ""}
            </div>

            <table className="takings">
              <tbody>
                {selected.positions.map((position, i) => (
                  <tr key={i}>
                    <td>{lineLabel(position)}</td>
                    <td>×{position.count}</td>
                    <td>{formatMoney(toCents(position.line_total), currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>{t("sale.total")}</strong>
                  </td>
                  <td />
                  <td>
                    <strong>{formatMoney(toCents(selected.total), currency)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>

            {selected.can_cancel ? (
              <>
                <div className="field" style={{ marginTop: 18 }}>
                  <label htmlFor="reason">{t("history.reason")}</label>
                  <input
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t("history.reasonPlaceholder")}
                    autoComplete="off"
                  />
                  <div className="help">{t("history.cancelHelp")}</div>
                </div>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t("history.confirm", { order: selected.order }))) void cancel(selected);
                  }}
                >
                  {busy ? t("history.cancelling") : t("history.cancel")}
                </button>
              </>
            ) : (
              <div className="attendance-note">
                {selected.cancelled ? t("history.alreadyCancelled") : t("history.notCancellable")}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="history-list">
              {lines === null && <div className="search-note">{t("history.loading")}</div>}
              {lines?.length === 0 && <div className="search-note">{t("history.empty")}</div>}
              {lines?.map((line) => {
                const cancellation = line.kind === "cancellation";
                return (
                  <button
                    key={line.seq}
                    className={`history-row${cancellation ? " is-cancellation" : ""}`}
                    onClick={() => setOpenSeq(line.seq)}
                  >
                    <span className="history-row-main">
                      <span className="history-row-order">
                        {time(line.datetime)} · {line.order}
                      </span>
                      <span className="history-row-meta">
                        #{line.seq} ·{" "}
                        {t(line.payment_type === "cash" ? "payment.cash" : "payment.card")}
                        {cancellation ? ` · ${t("history.isCancellation", { seq: line.cancels_seq ?? 0 })}` : ""}
                        {line.cancelled ? ` · ${t("history.badgeCancelled")}` : ""}
                      </span>
                    </span>
                    <span className={`history-row-total${cancellation ? " is-negative" : ""}`}>
                      {formatMoney(toCents(line.total), currency)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="attendance-note">{t("history.scope")}</div>
          </>
        )}

        {!done && !selected && (
          <button className="btn primary" style={{ marginTop: 16 }} onClick={onClose}>
            {t("settings.close")}
          </button>
        )}
      </div>
    </div>
  );
}
