import { useState } from "react";

import { t } from "../i18n";
import { formatMoney, fromCents, toCents } from "../money";
import type { PaymentType } from "../types";

interface Props {
  totalCents: number;
  currency: string;
  denominations: string[];
  busy: boolean;
  error: string | null;
  /** Money already taken back off the customer, from a sale cancelled to be corrected. */
  credit?: { amountCents: number; order: string } | null;
  onConfirm: (paymentType: PaymentType, cashGiven: string | null) => void;
  onCancel: () => void;
}

export default function PaymentPanel({
  totalCents, currency, denominations, busy, error, credit, onConfirm, onCancel,
}: Props) {
  const [method, setMethod] = useState<PaymentType>("cash");
  // Digits only, read as cents. This is how a real till behaves: typing 1-2-3-4
  // means 12.34, and there is no decimal point to fumble mid-queue.
  const [entry, setEntry] = useState("");

  const creditCents = credit?.amountCents ?? 0;
  /**
   * What actually has to change hands.
   *
   * The order is still worth its full total and is recorded as such — the
   * credit is a drawer matter, not an order one. But nobody hands 20 € back
   * across the counter only to be given 17 € straight back: the operator wants
   * the difference, in the direction it goes.
   */
  const netCents = totalCents - creditCents;
  const dueCents = Math.max(netCents, 0);
  /** Credit left over once the new order is covered: money going back out. */
  const backCents = Math.max(-netCents, 0);

  const given = entry === "" ? null : parseInt(entry, 10);
  const change = given === null ? null : given - dueCents;
  const short = change !== null && change < 0;

  const press = (digit: string) => setEntry((current) => (current + digit).replace(/^0+/, "").slice(0, 8));

  return (
    <div className="overlay">
      <div className="panel pay-panel">
        <h2>{t("payment.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

        {/* Everything the operator taps to build the amount. Scrolls on a phone;
            what it produces is read off the pinned footer below. */}
        <div className="pay-body">
          <div className="pay-toggle">
            <button
              className="btn"
              aria-pressed={method === "cash"}
              onClick={() => setMethod("cash")}
              disabled={busy}
            >
              {t("payment.cash")}
            </button>
            <button
              className="btn"
              aria-pressed={method === "card"}
              onClick={() => setMethod("card")}
              disabled={busy}
            >
              {t("payment.card")}
            </button>
          </div>

          <div className="amount-display">
            <span>{t("payment.due")}</span>
            <span className="value">{formatMoney(totalCents, currency)}</span>
          </div>

          {credit && (
            <>
              <div className="amount-display credit">
                <span>{t("payment.credit", { order: credit.order })}</span>
                <span className="value">−{formatMoney(creditCents, currency)}</span>
              </div>
              <div className={`amount-display${backCents > 0 ? " change" : ""}`}>
                <span>{backCents > 0 ? t("payment.giveBack") : t("payment.stillDue")}</span>
                <span className="value">
                  {formatMoney(backCents > 0 ? backCents : dueCents, currency)}
                </span>
              </div>
            </>
          )}

          {method === "cash" ? (
            <>
              {/* Nothing left to take: the credit covers the corrected order, and
                  the keypad would only invite an entry that means nothing. */}
              {dueCents === 0 ? (
                <p style={{ lineHeight: 1.5, color: "var(--text-dim)" }}>
                  {t("payment.coveredByCredit")}
                </p>
              ) : (
                <>
                  <div className={`amount-display${short ? " short" : ""}`}>
                    <span>{t("payment.received")}</span>
                    <span className="value">{formatMoney(given ?? 0, currency)}</span>
                  </div>

                  <div className="quick-tender">
                    <button onClick={() => setEntry(String(dueCents))} disabled={busy}>
                      {t("payment.exact")}
                    </button>
                    {denominations.map((denomination) => (
                      <button
                        key={denomination}
                        onClick={() => setEntry(String(toCents(denomination)))}
                        disabled={busy}
                      >
                        {formatMoney(toCents(denomination), currency)}
                      </button>
                    ))}
                  </div>

                  <div className="keypad">
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                      <button key={digit} onClick={() => press(digit)} disabled={busy}>
                        {digit}
                      </button>
                    ))}
                    <button onClick={() => press("00")} disabled={busy}>
                      00
                    </button>
                    <button onClick={() => press("0")} disabled={busy}>
                      0
                    </button>
                    <button onClick={() => setEntry("")} disabled={busy} aria-label="clear">
                      ⌫
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <p style={{ lineHeight: 1.5 }}>
              {credit
                ? backCents > 0
                  ? t("payment.cardRefundPrompt", {
                      amount: formatMoney(backCents, currency),
                    })
                  : t("payment.cardChargePrompt", { amount: formatMoney(dueCents, currency) })
                : t("payment.cardPrompt")}
            </p>
          )}
        </div>

        {/* Pinned, whatever the keypad above is doing: the change to count out
            and the button that ends the sale are the two things that must never
            be a scroll away with a customer waiting. */}
        <div className="pay-actions">
          {method === "cash" && change !== null && change >= 0 && (
            <div className="amount-display change">
              <span>{t("payment.change")}</span>
              <span className="value">{formatMoney(change, currency)}</span>
            </div>
          )}

          <div className="pay-buttons">
            <button className="btn ghost" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>
              {t("payment.back")}
            </button>
            <button
              className="btn success"
              style={{ flex: 2 }}
              disabled={busy || (method === "cash" && short)}
              onClick={() => {
                if (method !== "cash") return onConfirm(method, null);
                if (!credit) {
                  return onConfirm(method, given !== null ? fromCents(given) : null);
                }
                // The order is funded by the credit plus whatever was handed over,
                // so that is what the server is told was received: it then works
                // out the same change the operator is about to count out, and the
                // journal reads as what happened — a refund applied to a new sale.
                return onConfirm(method, fromCents(creditCents + (given ?? dueCents)));
              }}
            >
              {busy
                ? t("payment.working")
                : method === "card"
                  ? t("payment.cardConfirm")
                  : t("payment.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
