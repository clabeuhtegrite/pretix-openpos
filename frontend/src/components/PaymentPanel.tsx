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
  onConfirm: (paymentType: PaymentType, cashGiven: string | null) => void;
  onCancel: () => void;
}

export default function PaymentPanel({
  totalCents, currency, denominations, busy, error, onConfirm, onCancel,
}: Props) {
  const [method, setMethod] = useState<PaymentType>("cash");
  // Digits only, read as cents. This is how a real till behaves: typing 1-2-3-4
  // means 12.34, and there is no decimal point to fumble mid-queue.
  const [entry, setEntry] = useState("");

  const given = entry === "" ? null : parseInt(entry, 10);
  const change = given === null ? null : given - totalCents;
  const short = change !== null && change < 0;

  const press = (digit: string) => setEntry((current) => (current + digit).replace(/^0+/, "").slice(0, 8));

  return (
    <div className="overlay">
      <div className="panel">
        <h2>{t("payment.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

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

        {method === "cash" ? (
          <>
            <div className={`amount-display${short ? " short" : ""}`}>
              <span>{t("payment.received")}</span>
              <span className="value">{formatMoney(given ?? 0, currency)}</span>
            </div>

            <div className="quick-tender">
              <button onClick={() => setEntry(String(totalCents))} disabled={busy}>
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

            {change !== null && change >= 0 && (
              <div className="amount-display change">
                <span>{t("payment.change")}</span>
                <span className="value">{formatMoney(change, currency)}</span>
              </div>
            )}
          </>
        ) : (
          <p style={{ lineHeight: 1.5 }}>{t("payment.cardPrompt")}</p>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>
            {t("payment.back")}
          </button>
          <button
            className="btn success"
            style={{ flex: 2 }}
            disabled={busy || (method === "cash" && short)}
            onClick={() =>
              onConfirm(method, method === "cash" && given !== null ? fromCents(given) : null)
            }
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
  );
}
