import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, isRetryable } from "../api";
import { cancellationKeys } from "../cancellation";
import { locale, t } from "../i18n";
import { formatMoney, toCents } from "../money";
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
  /**
   * Put the lines of a cancelled sale back in the basket, ready to be corrected.
   *
   * The credited amount travels with them: the corrected order is settled
   * against it rather than by handing the whole sale back across the counter.
   */
  /**
   * Put a cancelled sale's lines back in the basket to be corrected.
   *
   * `credit` is the money the till is still holding for the customer, which
   * the corrected sale is settled against — and `null` when it is holding
   * none, because a card reader has already sent it back to their card.
   */
  onReuse: (
    positions: JournalPosition[],
    credit: { amountCents: number; order: string } | null,
  ) => void;
  onClose: () => void;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function lineLabel(position: JournalPosition): string {
  // The reason wins over the product name on a free amount: "Divers" tells
  // the operator nothing, and it is the same word on every one of them.
  if (position.description) return position.description;
  return position.variation_name
    ? `${position.item_name} · ${position.variation_name}`
    : position.item_name;
}

export default function HistoryPanel({ pairing, currency, cashier, onReuse, onClose }: Props) {
  const [lines, setLines] = useState<JournalLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The list is being fetched, which is what "Réessayer" waits on. */
  const [loading, setLoading] = useState(false);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CancelResult | null>(null);
  // One idempotency key per sale, kept across retries — see cancellation.ts for
  // what goes wrong when it is minted per press instead.
  const keys = useRef(cancellationKeys()).current;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.history(pairing);
      setLines(data.results);
      setTruncated(data.truncated);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.isNetwork ? t("error.offline") : String(e));
    } finally {
      setLoading(false);
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
        // The key of this sale's cancellation, not of this attempt: a request
        // that times out after the server committed must come back as the same
        // cancellation, which is how the operator still gets the credit note
        // and the corrected basket instead of "already cancelled".
        idempotency_key: keys.for(line.seq),
        cashier,
        reason: reason.trim(),
      });
      keys.settle(line.seq);
      setDone(result);
      setReason("");
      await load();
    } catch (e) {
      // A refusal is final, so the key has been spent; a network failure or a
      // server fault means we still do not know, and the next press has to
      // carry the same key to find out.
      if (!isRetryable(e)) keys.settle(line.seq);
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
          (() => {
            const amount = Math.abs(toCents(done.cancellation.total));
            const card = done.cancellation.payment_type === "card";
            // The reader gave the money back by itself, so the till is holding
            // nothing for this customer: the corrected sale is charged in full
            // and there is nothing to count out of the drawer. The same when
            // SumUp said "not yet": the server keeps asking, and the card gets
            // the money then — handing it over as well would pay it twice.
            const waiting = done.card_refund === "pending";
            const sentBack =
              done.card_refund === "done" || done.card_refund === "already" || waiting;
            const stuck = done.card_refund === "failed";
            return (
              <div className="history-done">
                <div className="history-done-headline">{t("history.cancelled")}</div>
                <div className="history-done-meta">
                  {t("history.cancelledMeta", {
                    order: done.sale?.order ?? "",
                    total: formatMoney(amount, currency),
                  })}
                </div>
                {done.credit_note && (
                  <div className="history-done-meta">
                    {t("history.creditNote", { number: done.credit_note })}
                  </div>
                )}
                {sentBack && (
                  <div className="history-done-meta">
                    {t(waiting ? "history.refundPending" : "history.refundedToCard")}
                  </div>
                )}
                {/* Loud, and not a line of small print: a cancellation that
                    looks complete while the money is still on the customer's
                    card is the one thing nobody finds out about until the
                    customer does. */}
                {stuck && <div className="error-banner">{t("history.refundFailed")}</div>}

                {/*
                  Two ways out, and the money only moves on one of them. Telling
                  the operator to hand back the full amount before they have said
                  whether they are correcting the order is how you end up
                  counting 20 € out of the drawer and 17 € straight back into it.
                */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
                  {done.sale && done.sale.positions.length > 0 && (
                    <button
                      className="btn primary"
                      onClick={() => {
                        onReuse(
                          done.sale!.positions,
                          sentBack ? null : { amountCents: amount, order: done.sale!.order },
                        );
                        onClose();
                      }}
                    >
                      {t("history.correct")}
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      setDone(null);
                      setOpenSeq(null);
                      void load();
                    }}
                  >
                    {sentBack
                      ? t("history.finish")
                      : t(card ? "history.refundCardAndFinish" : "history.refundCashAndFinish", {
                          total: formatMoney(amount, currency),
                        })}
                  </button>
                </div>
                <div className="attendance-note">{t("history.correctHelp")}</div>
              </div>
            );
          })()
        ) : selected ? (
          <>
            <div className="history-detail-head">
              <button className="btn ghost" onClick={() => setOpenSeq(null)}>
                ← {t("history.back")}
              </button>
            </div>
            <div className="history-meta">
              #{selected.seq} ·{" "}
              {selected.kind === "deposit_refund" ? t("deposit.tile") : selected.order} ·{" "}
              {time(selected.datetime)} ·{" "}
              {t(selected.payment_type === "cash" ? "payment.cash" : "payment.card")}
              {selected.cashier ? ` · ${selected.cashier}` : ""}
            </div>

            {selected.testmode && (
              <div className="history-row-test">{t("history.badgeTestmode")}</div>
            )}

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
                  aria-busy={busy || undefined}
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
              {/* "Loading" only while it is: a list that could not be fetched
                  used to say so above and "Chargement…" here, for ever, with
                  no way to ask again short of closing the panel. */}
              {lines === null && !error && (
                <div className="search-note loading">{t("history.loading")}</div>
              )}
              {lines === null && error && (
                <button
                  className="btn"
                  onClick={() => void load()}
                  disabled={loading}
                  aria-busy={loading || undefined}
                >
                  {loading ? t("history.loading") : t("history.retry")}
                </button>
              )}
              {lines?.length === 0 && <div className="search-note">{t("history.empty")}</div>}
              {lines?.map((line) => {
                const cancellation = line.kind === "cancellation";
                const depositBack = line.kind === "deposit_refund";
                return (
                  <button
                    key={line.seq}
                    className={
                      `history-row${cancellation || depositBack ? " is-cancellation" : ""}` +
                      (line.cancelled ? " is-cancelled" : "") +
                      (line.testmode ? " is-testmode" : "")
                    }
                    onClick={() => setOpenSeq(line.seq)}
                  >
                    <span className="history-row-main">
                      <span className="history-row-order">
                        {time(line.datetime)}
                        {/* A deposit handed back has no order to name: pretix
                            cannot hold one. So it says what it is instead of
                            trailing a separator and a blank. */}
                        {" · "}
                        {depositBack ? t("deposit.tile") : line.order}
                      </span>
                      <span className="history-row-meta">
                        #{line.seq} ·{" "}
                        {t(line.payment_type === "cash" ? "payment.cash" : "payment.card")}
                        {cancellation ? ` · ${t("history.isCancellation", { seq: line.cancels_seq ?? 0 })}` : ""}
                        {line.cancelled ? ` · ${t("history.badgeCancelled")}` : ""}
                      </span>
                      {line.testmode && (
                        <span className="history-row-test">{t("history.badgeTestmode")}</span>
                      )}
                    </span>
                    <span
                      className={`history-row-total${
                        cancellation || depositBack ? " is-negative" : ""
                      }`}
                    >
                      {formatMoney(toCents(line.total), currency)}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Once, under the list, rather than on every row: the tag marks
                which lines, this says what it costs the reader to ignore. The
                risk being guarded against is a volunteer totting the column up
                as the night's takings. */}
            {lines?.some((line) => line.testmode) && (
              <div className="attendance-note is-testmode">{t("history.testmodeNote")}</div>
            )}

            <div className="attendance-note">
              {t("history.scopeEvent")}
              {truncated && <> {t("history.truncated", { n: lines?.length ?? 0 })}</>}
            </div>
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
