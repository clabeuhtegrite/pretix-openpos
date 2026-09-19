import { useState } from "react";

import { t } from "../i18n";
import { formatMoney } from "../money";

/**
 * A price and a reason, typed at the counter.
 *
 * The one screen where the cashier decides what something costs, so it asks
 * for both halves and will not add the line without either: an amount with no
 * reason is the row nobody can account for at the end of the evening, and the
 * server refuses it anyway.
 *
 * The keypad is the payment panel's, digit for digit — 1-2-3-4 means 12.34 —
 * because it is the same thumb doing the same thing a minute earlier, and a
 * till with two different ways of typing an amount is a till that gets one of
 * them wrong.
 */

interface Props {
  currency: string;
  /** What the sale is booked against, shown so the operator knows where it lands. */
  productName: string;
  onAdd: (amountCents: number, reason: string) => void;
  onCancel: () => void;
}

export default function CustomSalePanel({ currency, productName, onAdd, onCancel }: Props) {
  const [entry, setEntry] = useState("");
  const [reason, setReason] = useState("");

  const amountCents = entry === "" ? 0 : parseInt(entry, 10);
  const trimmed = reason.trim();
  const ready = amountCents > 0 && trimmed !== "";

  const press = (digit: string) =>
    setEntry((current) => (current + digit).replace(/^0+/, "").slice(0, 8));

  return (
    <div className="overlay">
      <div className="panel pay-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("custom.title")}</h2>

        <div className="pay-body">
          <div className="amount-display">
            <span>{productName}</span>
            <span className="value">{formatMoney(amountCents, currency)}</span>
          </div>

          <div className="field">
            <label htmlFor="custom-reason">{t("custom.reason")}</label>
            <input
              id="custom-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("custom.reasonPlaceholder")}
              autoComplete="off"
              autoCapitalize="sentences"
            />
            <div className="help">{t("custom.reasonHelp")}</div>
          </div>

          <div className="keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button key={digit} onClick={() => press(digit)}>
                {digit}
              </button>
            ))}
            <button onClick={() => press("00")}>00</button>
            <button onClick={() => press("0")}>0</button>
            <button onClick={() => setEntry("")} aria-label="clear">
              ⌫
            </button>
          </div>
        </div>

        <div className="pay-actions">
          <div className="pay-buttons">
            <button className="btn ghost" style={{ flex: 1 }} onClick={onCancel}>
              {t("payment.back")}
            </button>
            <button
              className="btn success"
              style={{ flex: 2 }}
              disabled={!ready}
              onClick={() => onAdd(amountCents, trimmed)}
            >
              {t("custom.add")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
