import { useState } from "react";

import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import { settle } from "../settlement";
import type { CardMode, PaymentType } from "../types";

interface Props {
  /**
   * What changes hands: the basket, deposits handed back included.
   *
   * Negative when the drawer is the one paying out — a customer returning
   * cups and buying nothing, which is most of the queue at closing time.
   */
  totalCents: number;
  currency: string;
  denominations: string[];
  /**
   * How this till is allowed to take a card.
   *
   * On `"terminal"` the card button is shown refusing rather than hidden: the
   * cashier is standing in front of somebody holding a card, and "there is no
   * card button on this till" is not an answer they can give. The server
   * refuses the same payment either way — this is only what makes the refusal
   * legible before it costs a round trip.
   */
  cardMode: CardMode;
  busy: boolean;
  error: string | null;
  /** Money already taken back off the customer, from a sale cancelled to be corrected. */
  credit?: { amountCents: number; order: string } | null;
  onConfirm: (paymentType: PaymentType, cashGiven: string | null) => void;
  onCancel: () => void;
}

export default function PaymentPanel({
  totalCents, currency, denominations, cardMode, busy, error, credit, onConfirm, onCancel,
}: Props) {
  // Deliberately unanswered to begin with. A panel that opened on cash got
  // confirmed on cash: a card sale rung up as a cash one, and the drawer at
  // closing time the only thing that ever noticed. So the method is the first
  // thing the panel asks, and nothing else is shown until it has an answer.
  const [method, setMethod] = useState<PaymentType | null>(null);
  // Digits only, read as cents. This is how a real till behaves: typing 1-2-3-4
  // means 12.34, and there is no decimal point to fumble mid-queue.
  const [entry, setEntry] = useState("");

  const creditCents = credit?.amountCents ?? 0;
  const given = entry === "" ? null : parseInt(entry, 10);
  // Every figure on this panel — and the one the server is told — comes from
  // settlement.ts, which is where the arithmetic is pinned down by tests.
  const { dueCents, backCents, changeCents: change, short, cashGiven } = settle({
    totalCents,
    creditCents,
    tenderedCents: given,
    // While the question is still open only the two amounts below are read off
    // this, and what is due is the same arithmetic whichever way it is paid.
    method: method ?? "cash",
  });

  const press = (digit: string) => setEntry((current) => (current + digit).replace(/^0+/, "").slice(0, 8));

  return (
    <div className="overlay">
      <div className="panel pay-panel">
        <h2>{t("payment.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

        {/* Everything the operator taps to build the amount. Scrolls on a phone;
            what it produces is read off the pinned footer below. */}
        <div className="pay-body">
          {/* Once answered the question stays on screen as a toggle, so a
              mis-tap is one tap to undo rather than a trip back to the basket. */}
          {method !== null && (
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
          )}

          {/* A basket that nets out below zero has no amount due to state, and
              showing one as a minus figure reads as a price rather than as
              money going the other way. The row below says which direction. */}
          {totalCents >= 0 && (
            <div className="amount-display">
              <span>{t("payment.due")}</span>
              <span className="value">{formatMoney(totalCents, currency)}</span>
            </div>
          )}

          {credit && (
            <div className="amount-display credit">
              <span>{t("payment.credit", { order: credit.order })}</span>
              <span className="value">−{formatMoney(creditCents, currency)}</span>
            </div>
          )}

          {(credit || backCents > 0) && (
            <div className={`amount-display${backCents > 0 ? " change" : ""}`}>
              <span>{backCents > 0 ? t("payment.giveBack") : t("payment.stillDue")}</span>
              <span className="value">
                {formatMoney(backCents > 0 ? backCents : dueCents, currency)}
              </span>
            </div>
          )}

          {method === null ? (
            /* The amounts above are already on screen, so the operator asks the
               customer with the figure in front of them and answers here. */
            <>
              <p className="pay-question">{t("payment.chooseMethod")}</p>
              <div className="pay-choice">
                <button className="btn" onClick={() => setMethod("cash")} disabled={busy}>
                  {t("payment.cash")}
                </button>
                <button className="btn" onClick={() => setMethod("card")} disabled={busy}>
                  {t("payment.card")}
                </button>
              </div>
            </>
          ) : method === "cash" ? (
            <>
              {/* Nothing left to take: the credit covers the corrected order, and
                  the keypad would only invite an entry that means nothing. */}
              {dueCents === 0 ? (
                <p style={{ lineHeight: 1.5, color: "var(--text-dim)" }}>
                  {credit ? t("payment.coveredByCredit") : t("payment.nothingToTake")}
                </p>
              ) : (
                <>
                  <div className={`amount-display${short ? " short" : ""}`}>
                    <span>{t("payment.received")}</span>
                    <span className="value">{formatMoney(given ?? 0, currency)}</span>
                  </div>

                  {/* Each button stays lit while the amount it stands for is the
                      amount received, so a tap can be seen to land even when
                      there is no change to read off: a 10 € note for a 10 € beer. */}
                  <div className="quick-tender">
                    <button
                      aria-pressed={given === dueCents}
                      onClick={() => setEntry(String(dueCents))}
                      disabled={busy}
                    >
                      {t("payment.exact")}
                    </button>
                    {denominations.map((denomination) => (
                      <button
                        key={denomination}
                        aria-pressed={given === toCents(denomination)}
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
          ) : cardMode === "terminal" ? (
            <div className="error-banner">{t("payment.cardTerminalOnly")}</div>
          ) : (
            <p style={{ lineHeight: 1.5 }}>
              {backCents > 0
                ? t("payment.cardRefundPrompt", { amount: formatMoney(backCents, currency) })
                : credit
                  ? t("payment.cardChargePrompt", { amount: formatMoney(dueCents, currency) })
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
            {/* Absent rather than disabled: the two buttons above are the step,
                and a greyed-out "Valider" beside them reads as a till that is
                stuck rather than as a question waiting for an answer. */}
            {method !== null && !(method === "card" && cardMode === "terminal") && (
              <button
                className="btn success"
                style={{ flex: 2 }}
                disabled={busy || (method === "cash" && short)}
                onClick={() => onConfirm(method, cashGiven)}
              >
                {busy
                  ? t("payment.working")
                  : method === "card"
                    ? t("payment.cardConfirm")
                    : t("payment.confirm")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
