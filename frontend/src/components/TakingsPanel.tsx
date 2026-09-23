import { locale, t, tn } from "../i18n";
import { formatMoney, toCents } from "../money";
import type { SummaryResponse, Takings, TakingsProduct } from "../types";

/**
 * What the event has taken, every way it is read at closing time.
 *
 * The figure at the top is the one people ask for; everything under it is
 * there to make it trustworthy, by showing what it is made of — which products,
 * which deposits, which devices — rather than asking anyone to take it on
 * faith. The sections add up to it, and the server guarantees that they do: a
 * section that did not would be a figure somebody could not reconcile.
 *
 * Read on a phone held upright at the door and on a tablet held sideways at
 * the bar. One column on the first; on the second, the products on the left
 * and everything else beside them, so the long list does not push the rest
 * three screens down.
 */

interface Props {
  summary: SummaryResponse | null;
  failed: boolean;
  busy: boolean;
  currency: string;
  /** What this device holds and the server has not heard of yet. */
  queued: { count: number; cashCents: number };
  onRefresh: () => void;
  onClose: () => void;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** "samedi 19 septembre", for a date of a series. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * An evening named by its date, which is a calendar date and not a moment:
 * read as midnight UTC it would land on the day before anywhere west of
 * Greenwich, so it is built from its parts, in local time.
 */
function evening(date: string): string {
  const [year, month, dayOfMonth] = date.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function productLabel(product: TakingsProduct): string {
  return product.variation_name ? `${product.name} · ${product.variation_name}` : product.name;
}

/** What the takings are about, under the title: the event, and the date of a series. */
export function scopeLabel(scope: SummaryResponse["scope"]): string {
  if (!scope.series) return scope.event;
  if (!scope.subevent) return `${scope.event} · ${t("takings.allDates")}`;
  // The date's own name is often the event's again ("Soirées"), and then the
  // day is what tells two of them apart.
  const name = scope.subevent.name && scope.subevent.name !== scope.event
    ? `${scope.subevent.name} · `
    : "";
  return `${scope.event} · ${name}${day(scope.subevent.date_from)}`;
}

/**
 * A line of the device and evening lists: a name, what it is made of, the sum.
 *
 * A list rather than a five-column table: on a phone held upright, "Cash" and
 * "Card" side by side leave the device's name a column two words wide.
 */
export function TakingsLine({
  name,
  current,
  takings,
  currency,
}: {
  name: string;
  current?: boolean;
  takings: Takings;
  currency: string;
}) {
  return (
    <li className="takings-line">
      <span className="takings-line-main">
        <span className="takings-line-name">
          {name}
          {current && (
            <>
              {" "}
              <span className="attendance-this">· {t("attendance.thisDevice")}</span>
            </>
          )}
        </span>
        {/* Each figure stays with its label: on a phone the line wraps, and
            "Carte" at the end of one line with its amount on the next reads
            as two things. */}
        <span className="takings-line-meta">
          <span>{tn("takings.salesCount", takings.count)}</span> ·{" "}
          <span>
            {t("summary.cash")} {formatMoney(toCents(takings.cash), currency)}
          </span>{" "}
          ·{" "}
          <span>
            {t("summary.card")} {formatMoney(toCents(takings.card), currency)}
          </span>
        </span>
      </span>
      <strong className="takings-line-total">
        {formatMoney(toCents(takings.total), currency)}
      </strong>
    </li>
  );
}

function Detail({ summary, currency }: { summary: SummaryResponse; currency: string }) {
  const money = (amount: string) => formatMoney(toCents(amount), currency);
  const { event, deposits } = summary;

  return (
    <div className="takings-columns">
      <section className="takings-section">
        <h3 className="attendance-subtitle">{t("takings.byProduct")}</h3>
        <table className="takings takings-products">
          <thead>
            <tr>
              <th>{t("takings.product")}</th>
              <th>{t("takings.quantity")}</th>
              <th>{t("takings.amount")}</th>
            </tr>
          </thead>
          {summary.categories.map((group) => (
            // One body per category, so the category's own row heads the
            // group for a screen reader as it does on the screen.
            <tbody key={group.id ?? "none"}>
              <tr className="takings-category">
                <th scope="rowgroup">{group.name ?? t("takings.uncategorised")}</th>
                <td>{group.count}</td>
                <td>{money(group.total)}</td>
              </tr>
              {group.items.map((product) => (
                <tr key={`${product.item}-${product.variation}`}>
                  <td>{productLabel(product)}</td>
                  <td>{product.count}</td>
                  <td>{money(product.total)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {summary.unallocated && (
          <div className="attendance-note">
            {t("takings.unallocated", { amount: money(summary.unallocated) })}
          </div>
        )}
      </section>

      <section className="takings-section">
        {deposits && (
          <>
            <h3 className="attendance-subtitle">{t("takings.deposits")}</h3>
            <table className="takings">
              <tbody>
                <tr>
                  <td>{t("takings.depositsTaken")}</td>
                  <td>{deposits.taken.count}</td>
                  <td>{money(deposits.taken.total)}</td>
                </tr>
                <tr>
                  <td>{t("takings.depositsReturned")}</td>
                  <td>{deposits.returned.count}</td>
                  <td>{money(deposits.returned.total)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th>{t("takings.depositsBalance")}</th>
                  <td />
                  <td>
                    <strong>{money(deposits.total)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="attendance-note">{t("takings.depositsExplain")}</div>
          </>
        )}

        <h3 className="attendance-subtitle">{t("takings.byDevice")}</h3>
        <ul className="takings-lines">
          {summary.devices.map((device, i) => (
            // By position: two tablets may well carry the same name.
            <TakingsLine
              key={i}
              name={device.name ?? t("attendance.backOffice")}
              current={device.current}
              takings={device}
              currency={currency}
            />
          ))}
        </ul>

        {summary.nights.length > 1 && (
          // Only for an event that ran several evenings. For one evening this
          // would be the total again, and on a festival it is the figure each
          // night's drawer was counted against.
          <>
            <h3 className="attendance-subtitle">{t("takings.byNight")}</h3>
            <ul className="takings-lines">
              {summary.nights.map((night) => (
                <TakingsLine
                  key={night.date}
                  name={evening(night.date)}
                  takings={night}
                  currency={currency}
                />
              ))}
            </ul>
            <div className="attendance-note">{t("takings.byNightExplain")}</div>
          </>
        )}

        {event.cancellations > 0 && (
          // Said out loud rather than left to be discovered: every amount on
          // this screen is net, so a product short by exactly a cancelled
          // sale is not short at all.
          <div className="attendance-note">
            {tn("takings.cancelled", event.cancellations, {
              amount: money(event.cancelled_total),
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default function TakingsPanel({
  summary,
  failed,
  busy,
  currency,
  queued,
  onRefresh,
  onClose,
}: Props) {
  const money = (amount: string) => formatMoney(toCents(amount), currency);
  const sold = summary !== null && summary.devices.length > 0;

  return (
    <div
      className="overlay overlay-top"
      onClick={(e) => {
        // Opened from inside the settings panel, whose own backdrop is an
        // ancestor in React's tree: a tap here would otherwise go on to close
        // the settings as well.
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="panel takings-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("takings.title")}</h2>

        {summary && <div className="takings-scope">{scopeLabel(summary.scope)}</div>}

        {!summary && !failed && (
          <p style={{ color: "var(--text-dim)" }}>{t("takings.loading")}</p>
        )}
        {!summary && failed && <div className="error-banner">{t("summary.failed")}</div>}

        {summary && (
          <>
            <div className="takings-figures">
              <div className="takings-figure is-total">
                <span className="takings-figure-label">{t("summary.total")}</span>
                <span className="takings-figure-value">{money(summary.event.total)}</span>
                <span className="takings-figure-caption">
                  {tn("takings.salesCount", summary.event.count)}
                </span>
              </div>
              <div className="takings-figure">
                <span className="takings-figure-label">{t("summary.cash")}</span>
                <span className="takings-figure-value">{money(summary.event.cash)}</span>
              </div>
              <div className="takings-figure">
                <span className="takings-figure-label">{t("summary.card")}</span>
                <span className="takings-figure-value">{money(summary.event.card)}</span>
              </div>
            </div>

            {sold ? (
              <Detail summary={summary} currency={currency} />
            ) : (
              <div className="attendance-note">{t("takings.empty")}</div>
            )}

            {summary.testmode && (
              <div className="attendance-note is-testmode">
                {tn("takings.testmode", summary.testmode.count, {
                  amount: money(summary.testmode.total),
                })}
              </div>
            )}
            {queued.count > 0 && (
              // The takings come from the server, so a sale encashed during a
              // dropout and still in the queue is not in them — while the
              // drawer already holds its cash.
              <div className="attendance-note">
                {tn("summary.queued", queued.count, {
                  amount: formatMoney(queued.cashCents, currency),
                })}
              </div>
            )}
            <div className="attendance-note">
              {t(summary.scope.series && summary.scope.subevent ? "takings.scopeSeries" : "takings.scope")}{" "}
              {t("takings.updated", { time: clock(summary.computed_at) })}
            </div>
          </>
        )}

        <div className="takings-actions">
          <button className="btn ghost" onClick={onRefresh} disabled={busy}>
            {busy ? t("takings.loading") : failed && !summary ? t("summary.retry") : t("attendance.refresh")}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
