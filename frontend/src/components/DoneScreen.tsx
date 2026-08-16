import { useEffect } from "react";

import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import type { SaleResult } from "../types";

/** How long a sale that needs nothing further stays on screen by itself. */
const AUTO_DISMISS_MS = 6000;

interface Props {
  sale: SaleResult;
  currency: string;
  onDismiss: () => void;
}

export default function DoneScreen({ sale, currency, onDismiss }: Props) {
  const changeCents = sale.cash_change === null ? 0 : toCents(sale.cash_change);
  const admitted = (sale.checked_in ?? 0) > 0;
  const checkinFailed = sale.checkin_errors.length > 0;

  // Hold the screen whenever the operator still has something to do — handing
  // back change, or dealing with a check-in that did not go through. Otherwise
  // get out of the way so the queue keeps moving.
  const needsAttention = changeCents > 0 || checkinFailed || Boolean(sale.offline);

  useEffect(() => {
    if (needsAttention) return;
    // Time to read the order code and let the customer see that it went
    // through. Tapping anywhere skips it, so this is a floor and not a wait:
    // the till is only ever held up by an operator who has not looked yet.
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [needsAttention, onDismiss]);

  const tone = checkinFailed ? " warn" : admitted ? "" : " no-checkin";

  return (
    <div className={`done${tone}`} onClick={needsAttention ? undefined : onDismiss}>
      <div className="headline">
        {checkinFailed ? t("done.checkinFailed") : admitted ? t("done.admitted") : t("done.sold")}
      </div>

      {changeCents > 0 && (
        <div className="change-box">
          <div>{t("done.change")}</div>
          <div className="value">{formatMoney(changeCents, currency)}</div>
        </div>
      )}

      <div className="meta">
        {sale.offline
          ? t("offline.saleQueued", {
              total: formatMoney(toCents(sale.order.total), currency),
            })
          : `${t("done.order")} ${sale.order.code} · #${sale.journal_seq} · ${formatMoney(
              toCents(sale.order.total),
              currency,
            )}`}
      </div>

      <button className="btn" onClick={onDismiss}>
        {t("done.next")}
      </button>
    </div>
  );
}
