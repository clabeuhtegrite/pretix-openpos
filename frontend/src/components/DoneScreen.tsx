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
  // What the transaction came to, deposits handed back included. Older
  // servers do not send it, and for them the order is the whole story.
  const netCents = toCents(sale.net_total ?? sale.order.total);
  // Money owed to the customer with nothing taken in exchange: they returned
  // cups and bought nothing. Not change — there was no note to break.
  const giveBackCents = Math.max(-netCents, 0);

  // Hold the screen whenever the operator still has something to do — handing
  // back change or a deposit, or dealing with a check-in that did not go
  // through. Otherwise get out of the way so the queue keeps moving.
  const needsAttention =
    changeCents > 0 || giveBackCents > 0 || checkinFailed || Boolean(sale.offline);

  useEffect(() => {
    if (needsAttention) return;
    // Time to read the order code and let the customer see that it went
    // through. Tapping anywhere skips it, so this is a floor and not a wait:
    // the till is only ever held up by an operator who has not looked yet.
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [needsAttention, onDismiss]);

  const tone = checkinFailed ? " warn" : admitted ? "" : " no-checkin";
  const deposit = sale.deposit_refund ? toCents(sale.deposit_refund) : 0;
  // Cups came back and nothing was sold, so there is no order to name — and
  // "Sale recorded" would be a lie about what just happened.
  const soldNothing = deposit > 0 && sale.order.code === "" && !sale.offline;

  return (
    <div className={`done${tone}`} onClick={needsAttention ? undefined : onDismiss}>
      <div className="headline">
        {checkinFailed
          ? t("done.checkinFailed")
          : admitted
            ? t("done.admitted")
            : soldNothing
              ? t("done.depositOnly")
              : t("done.sold")}
      </div>

      {changeCents > 0 && (
        <div className="change-box">
          <div>{t("done.change")}</div>
          <div className="value">{formatMoney(changeCents, currency)}</div>
        </div>
      )}

      {/* The other reason to count money out, and the one that has no note to
          break: nothing was sold, so there is no change — there is a deposit
          to hand over. */}
      {giveBackCents > 0 && (
        <div className="change-box">
          <div>{t("done.giveBack")}</div>
          <div className="value">{formatMoney(giveBackCents, currency)}</div>
        </div>
      )}

      {/* Said out loud whenever a deposit came back on a sale, because the
          figures above are already net of it and nothing else would show it
          happened. Left out when the deposit is all there was: the headline
          and the amount have already said it twice. */}
      {deposit > 0 && !soldNothing && (
        <div className="meta">
          {t("done.depositBack", { total: formatMoney(deposit, currency) })}
        </div>
      )}

      <div className="meta">
        {sale.offline
          ? t("offline.saleQueued", { total: formatMoney(netCents, currency) })
          : soldNothing
            ? `#${sale.journal_seq}`
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
