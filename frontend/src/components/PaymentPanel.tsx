import { useState } from "react";

import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import { settle } from "../settlement";
import type { TerminalState } from "../useTerminal";
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
   * On `"declared"` the cashier takes the card in the card provider's own app
   * and tells the till it happened. On `"terminal"` the reader on the counter
   * does it, and the server will not record a card sale that reader did not
   * validate — so the panel drives the reader rather than asking the cashier
   * to confirm something they have not done yet.
   */
  cardMode: CardMode;
  /** The reader payment for this basket, while there is one. */
  terminal: TerminalState | null;
  /** Put the basket on the reader. Also the retry, after a refusal. */
  onTerminalStart: () => void;
  /** Take it back off, which is the cashier's only way out of a live payment. */
  onTerminalStop: () => void;
  busy: boolean;
  error: string | null;
  /** Money already taken back off the customer, from a sale cancelled to be corrected. */
  credit?: { amountCents: number; order: string } | null;
  /**
   * The cash drawer that is not open to take this payment, when there is one.
   *
   * The server refuses cash into a drawer nobody opened, so the panel says so
   * the moment cash is chosen — with the way to open it next to the words —
   * rather than letting the cashier count out change for a sale that will be
   * refused at the last tap.
   */
  drawer?: { name: string; stale: boolean } | null;
  onOpenDrawer?: () => void;
  /**
   * ``charged`` is what the reader actually took, when one did. Passed on
   * rather than left to the caller: the server priced the basket when it put
   * it on the reader, and that figure — not this app's, whose catalogue can
   * be a refresh behind — is the one the customer agreed to.
   */
  onConfirm: (
    paymentType: PaymentType,
    cashGiven: string | null,
    charged?: string,
  ) => void;
  onCancel: () => void;
}

/**
 * What the cashier reads out while the reader has the basket.
 *
 * Its own component because it is the one part of this panel that is not
 * arithmetic: it says where the payment has got to, and — when it did not
 * work — what happened and how to try again.
 */
function TerminalPrompt({
  terminal, currency, fallbackCents, onRetry,
}: {
  terminal: TerminalState | null;
  currency: string;
  /** The basket's own figure, until the server has priced it. */
  fallbackCents: number;
  onRetry: () => void;
}) {
  // Stop has been pressed and the reader has not answered yet. Said in place of
  // the request for a card, which the cashier has just decided against; the
  // bar goes on moving, because the wait is still the reader's.
  if (terminal?.cancelling) {
    return (
      <div className="pay-reader is-waiting is-stopping">
        <p className="pay-reader-prompt">{t("payment.readerStopping")}</p>
        {terminal.stalled && (
          <p className="pay-reader-note">{t("payment.readerStalled")}</p>
        )}
      </div>
    );
  }

  if (terminal === null || terminal.phase === "starting") {
    return (
      <p className="pay-reader is-waiting">{t("payment.readerStarting")}</p>
    );
  }

  if (terminal.phase === "failed") {
    return (
      <div className="pay-reader">
        <div className="error-banner">{terminal.message ?? t("payment.readerRefused")}</div>
        <button className="btn" style={{ marginTop: 12 }} onClick={onRetry}>
          {t("payment.readerRetry")}
        </button>
      </div>
    );
  }

  if (terminal.phase === "paid") {
    return <p className="pay-reader paid">{t("payment.readerPaid")}</p>;
  }

  // Waiting. The amount is the server's, which is the figure the reader is
  // showing the customer — not the basket's, which can be a catalogue behind.
  const asked = terminal.amount === null ? fallbackCents : toCents(terminal.amount);
  // Said twice, the two figures stop being read: "À payer 10,00 €" directly
  // above "Sur le lecteur 10,00 €" is one number wearing two labels, and it
  // is the row the cashier reads out to the customer. So it is shown only
  // when it is actually telling them something — when the server priced the
  // basket at something other than what this till had on screen, which is
  // exactly the moment somebody has to notice.
  const differs = asked !== fallbackCents;
  return (
    <div className="pay-reader is-waiting">
      {differs && (
        <div className="amount-display">
          <span>{t("payment.readerAsking")}</span>
          <span className="value">{formatMoney(asked, currency)}</span>
        </div>
      )}
      <p className="pay-reader-prompt">{t("payment.readerPrompt")}</p>
      {terminal.stalled && (
        <p className="pay-reader-note">{t("payment.readerStalled")}</p>
      )}
    </div>
  );
}

export default function PaymentPanel({
  totalCents, currency, denominations, cardMode, terminal, onTerminalStart, onTerminalStop,
  busy, error, credit, drawer, onOpenDrawer, onConfirm, onCancel,
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

  // Card payments on this till go through the reader on the counter.
  const onReader = cardMode === "terminal";
  /**
   * Two baskets a reader cannot settle, and they are refused before the
   * customer is asked for a card rather than after.
   *
   * Money going *out* is the first: SumUp only refunds against a transaction
   * of its own, up to its amount, so there is no way to send money to a card
   * that nothing stands behind. A returned deposit comes out of the drawer.
   *
   * A credit from a cancelled sale is the second, for the same arithmetic seen
   * from the other side: the reader would charge the whole basket while the
   * till is holding money that belongs to the customer. Cash settles both
   * halves in one movement, which is what the drawer is for.
   */
  const readerCannot = onReader && (totalCents <= 0 || credit != null);
  const readerBusy =
    onReader && (terminal?.phase === "starting" || terminal?.phase === "waiting");
  /**
   * The card has been charged, whatever happened next.
   *
   * Normally nothing is visible here: the sale posts itself the moment the
   * reader reports the money, and the panel closes. It matters when that post
   * fails — an unreachable server, an error — because the panel then stays
   * open on a red banner with the question still on screen. The lock has to
   * outlast the waiting: one tap on "Espèces" and one on "Valider" would
   * record a cash sale for money that went on a card, and the drawer comes up
   * short by that amount at closing. A red banner is exactly when somebody
   * starts pressing things.
   */
  const readerPaid = onReader && terminal?.phase === "paid";
  const methodLocked = busy || readerBusy || readerPaid;
  /** Stop has been pressed, and the reader has not answered yet. */
  const stopping = readerBusy && terminal?.cancelling === true;

  /**
   * Answering the question, and — on a reader till — putting the basket on it.
   *
   * The reader is asked the moment "card" is chosen rather than on a later
   * confirmation: the customer is standing there with a card in their hand,
   * and a second button between them and the reader is a button nobody has a
   * reason to press.
   */
  const choose = (next: PaymentType) => {
    setMethod(next);
    if (next === "card" && onReader && !readerCannot) onTerminalStart();
  };

  const press = (digit: string) => setEntry((current) => (current + digit).replace(/^0+/, "").slice(0, 8));

  return (
    <div className="overlay">
      <div className="panel pay-panel">
        <h2>{t("payment.title")}</h2>

        {/* An error after the reader has taken the money is not an ordinary
            refusal: the customer has paid and pretix has no record of it. It
            should be impossible — the basket was pinned, the quota is forced,
            the total is not re-checked — but if it ever happens, somebody at
            the counter has to know rather than read "not recorded" and assume
            nothing was charged. */}
        {error && (
          <div className="error-banner">
            {terminal?.phase === "paid" ? `${t("payment.readerPaidNotRecorded")} ` : ""}
            {error}
          </div>
        )}

        {/* Everything the operator taps to build the amount. Scrolls on a phone;
            what it produces is read off the pinned footer below. */}
        <div className="pay-body">
          {/* Once answered the question stays on screen as a toggle, so a
              mis-tap is one tap to undo rather than a trip back to the basket. */}
          {method !== null && (
            <div className="pay-toggle">
              {/* Locked while the reader has the basket: the way out of a live
                  payment is cancelling it, not walking away from it. */}
              <button
                className="btn"
                aria-pressed={method === "cash"}
                onClick={() => choose("cash")}
                disabled={methodLocked}
              >
                {t("payment.cash")}
              </button>
              <button
                className="btn"
                aria-pressed={method === "card"}
                onClick={() => choose("card")}
                disabled={methodLocked}
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
                <button className="btn" onClick={() => choose("cash")} disabled={busy}>
                  {t("payment.cash")}
                </button>
                <button className="btn" onClick={() => choose("card")} disabled={busy}>
                  {t("payment.card")}
                </button>
              </div>
            </>
          ) : method === "cash" && drawer ? (
            <div className="pay-reader">
              <p className="pay-reader-prompt">
                {drawer.stale
                  ? t("payment.drawerStale", { name: drawer.name })
                  : t("payment.drawerClosed", { name: drawer.name })}
              </p>
              <button className="btn" style={{ marginTop: 12 }} onClick={onOpenDrawer}>
                {drawer.stale ? t("drawer.see") : t("drawer.openAction")}
              </button>
            </div>
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
          ) : onReader ? (
            readerCannot ? (
              <div className="error-banner">
                {credit != null ? t("payment.readerCredit") : t("payment.readerNoRefund")}
              </div>
            ) : (
              <TerminalPrompt
                terminal={terminal}
                currency={currency}
                fallbackCents={totalCents}
                onRetry={onTerminalStart}
              />
            )
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
          {method === "cash" && !drawer && change !== null && change >= 0 && (
            <div className="amount-display change">
              <span>{t("payment.change")}</span>
              <span className="value">{formatMoney(change, currency)}</span>
            </div>
          )}

          <div className="pay-buttons">
            {/* One tap takes the basket back off the reader, a second leaves.
                Never one tap for both: walking away from a live payment is how
                a card gets charged for a sale nobody recorded. */}
            <button
              className="btn ghost"
              style={{ flex: 1 }}
              onClick={readerBusy ? onTerminalStop : onCancel}
              // Leaving is not on offer once the card has been charged: the
              // only correct move is recording the sale, which is the button
              // beside this one.
              disabled={busy || readerPaid || stopping}
              aria-busy={stopping || undefined}
            >
              {stopping
                ? t("payment.readerStoppingShort")
                : readerBusy
                  ? t("payment.readerStop")
                  : t("payment.back")}
            </button>
            {/* Absent rather than disabled: the two buttons above are the step,
                and a greyed-out "Valider" beside them reads as a till that is
                stuck rather than as a question waiting for an answer. */}
            {method !== null &&
              (!(method === "card" && onReader) || readerPaid) &&
              !(method === "cash" && drawer) && (
              <button
                className="btn success"
                style={{ flex: 2 }}
                disabled={busy || (method === "cash" && short)}
                aria-busy={busy || undefined}
                onClick={() =>
                  // The third figure exists only when a reader took the money,
                  // and is only ever read in that case.
                  readerPaid && terminal?.amount
                    ? onConfirm(method, cashGiven, terminal.amount)
                    : onConfirm(method, cashGiven)
                }
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
