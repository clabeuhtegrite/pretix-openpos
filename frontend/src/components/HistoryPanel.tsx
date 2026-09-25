import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import {
  cancellationKeys, clearCancellationResult, loadCancellationResult, saveCancellationResult,
} from "../cancellation";
import { describeError, unanswered } from "../errors";
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
   * Put a cancelled sale's lines back in the basket to be corrected.
   *
   * `credit` is the money the till is still holding for the customer, which
   * the corrected sale is settled against rather than by handing the whole
   * sale back across the counter — and `null` when it is holding none: a card
   * reader has already sent it back to their card, or the sale was cancelled
   * in pretix' back office, whose refund never goes through this drawer.
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
  /** This till on this event: what the keys and the kept answer belong to. */
  const scope = `${pairing.serial}:${pairing.event}`;
  const [lines, setLines] = useState<JournalLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The list is being fetched, which is what "Réessayer" waits on. */
  const [loading, setLoading] = useState(false);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * The answer to a cancellation, until the operator has acted on it — and
   * brought back when the panel is reopened before they had (see
   * saveCancellationResult).
   */
  const [done, setDone] = useState<CancelResult | null>(() => loadCancellationResult(scope));
  // One idempotency key per sale, kept across retries and on the device — see
  // cancellation.ts for what goes wrong when it is minted per press, or kept
  // only as long as the panel.
  const keys = useRef(cancellationKeys(scope)).current;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.history(pairing);
      setLines(data.results);
      setTruncated(data.truncated);
      setError(null);
    } catch (e) {
      setError(describeError(e));
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
      // Kept before it is shown: the next thing that happens may be a tap
      // beside the panel or iOS reloading the app, and this is the only
      // screen that says how much to hand back.
      saveCancellationResult(scope, result);
      setDone(result);
      setReason("");
      // The answer is the server's word that this sale is cancelled, so the
      // list says so now rather than when the reload below gets through. On
      // the network that just made a cancellation slow, that reload is the
      // next thing to fail — and a list still offering "Cancel this order" on
      // a sale whose money was just handed back invited a second press, which
      // comes back "already cancelled" with that same amount to hand back.
      setLines((current) =>
        current?.map((entry) =>
          entry.seq === line.seq ? { ...entry, cancelled: true, can_cancel: false } : entry,
        ) ?? current,
      );
      await load();
    } catch (e) {
      // A refusal is final, so the key has been spent; a network failure, a
      // server fault, a 408 or a 429 means we still do not know, or that
      // nothing was done — and the next press has to carry the same key to
      // find out (errors.ts, unanswered).
      if (!unanswered(e)) keys.settle(line.seq);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  /** One of the two ways out has been taken: the answer is no longer owed. */
  function acknowledge() {
    clearCancellationResult(scope);
    setDone(null);
  }

  /**
   * A tap beside the panel closes it — except over an answer that says how
   * much to hand back, or while a cancellation is on its way. Both used to be
   * lost to a stray touch: the amount, the correction, and with the in-flight
   * one, the only chance to see its answer.
   */
  function onBackdrop() {
    if (done || busy) return;
    onClose();
  }

  return (
    <div className="overlay overlay-top" onClick={onBackdrop}>
      <div className="panel history-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("history.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

        {done ? (
          (() => {
            // The reversing line says what was credited and how it was paid.
            // Read with the sale as a fallback all the same: an answer handed
            // back for a cancellation made elsewhere may have no line of its
            // own to show — one made in the back office is on no till — and
            // this screen is kept and restored, so a field it cannot do
            // without would take the whole panel down every time it opens.
            const reversed = done.cancellation ?? done.sale;
            const amount = reversed ? Math.abs(toCents(reversed.total)) : 0;
            const card = reversed?.payment_type === "card";
            const order = done.sale?.order ?? done.cancellation?.order ?? "";
            // The reader gave the money back by itself, so the till is holding
            // nothing for this customer: the corrected sale is charged in full
            // and there is nothing to count out of the drawer. The same when
            // SumUp said "not yet": the server keeps asking, and the card gets
            // the money then — handing it over as well would pay it twice.
            const waiting = done.card_refund === "pending";
            const sentBack =
              done.card_refund === "done" || done.card_refund === "already" || waiting;
            const stuck = done.card_refund === "failed";
            // Cancelled in pretix' back office: its journal line is on no till
            // and nothing left this drawer for it, so this till owes nothing and
            // holds nothing — whoever cancelled it there refunds it there. Told
            // "give 12 € back", an operator would pay the customer a second
            // time out of a drawer that never took the money back. Nothing in
            // the answer says otherwise, so nothing here claims it.
            const backOffice = done.by_back_office === true;
            // ...and with no figure at all, no figure is invented: "give
            // 0,00 € back" is not a thing to say to somebody holding a receipt.
            const nothingDue = sentBack || backOffice || !reversed;
            return (
              <div className="history-done">
                <div className="history-done-headline">
                  {backOffice
                    ? t("history.backOfficeTitle")
                    : done.already_cancelled
                      ? t("history.alreadyCancelledTitle")
                      : t("history.cancelled")}
                </div>
                {reversed && (
                  <div className="history-done-meta">
                    {t("history.cancelledMeta", { order, total: formatMoney(amount, currency) })}
                  </div>
                )}
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
                {backOffice && (
                  <div className="history-done-meta">{t("history.backOfficeRefund")}</div>
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
                          nothingDue ? null : { amountCents: amount, order: done.sale!.order },
                        );
                        acknowledge();
                        onClose();
                      }}
                    >
                      {t("history.correct")}
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      acknowledge();
                      setOpenSeq(null);
                      void load();
                    }}
                  >
                    {nothingDue
                      ? t("history.finish")
                      : t(card ? "history.refundCardAndFinish" : "history.refundCashAndFinish", {
                          total: formatMoney(amount, currency),
                        })}
                  </button>
                </div>
                {!backOffice && <div className="attendance-note">{t("history.correctHelp")}</div>}
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
              <>
                <div className="attendance-note">
                  {selected.cancelled ? t("history.alreadyCancelled") : t("history.notCancellable")}
                </div>
                {/* Cancelled by this till, whose answer never came back: the
                    key is still on the device, and sending it again hands back
                    that very cancellation — amount, credit note, correction —
                    rather than cancelling anything a second time. */}
                {selected.cancelled && keys.pending(selected.seq) && (
                  <>
                    <div className="attendance-note">{t("history.unanswered")}</div>
                    <button
                      className="btn primary"
                      style={{ marginTop: 12 }}
                      disabled={busy}
                      aria-busy={busy || undefined}
                      onClick={() => void cancel(selected)}
                    >
                      {busy ? t("history.loading") : t("history.resume")}
                    </button>
                  </>
                )}
              </>
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
