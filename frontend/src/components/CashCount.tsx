import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import { denominationLabel, type CountState } from "../drawer";
import type { Denomination } from "../types";

interface Props {
  value: CountState;
  onChange: (next: CountState) => void;
  currency: string;
  denominations: Denomination[];
  disabled?: boolean;
  /**
   * A figure the drawer usually holds, one tap away: the float, at opening.
   *
   * Offered on the keypad only. Counting note by note is how a figure gets
   * checked, and a button that filled the rows in would be a way round it.
   */
  usualCents?: number | null;
}

/** The most of one note or coin a drawer can hold, as far as the server is concerned. */
const MOST = 99999;

/**
 * Cash counted into or out of a drawer: note by note, or the total typed in.
 *
 * Controlled: the panel holds the count, so that the figure it shows in its
 * pinned footer and the one it sends are the same one, and so that stepping
 * back from a count to look at something does not lose it.
 */
export default function CashCount({
  value, onChange, currency, denominations, disabled, usualCents,
}: Props) {
  const setCount = (note: string, number: number) =>
    onChange({
      ...value,
      counts: { ...value.counts, [note]: Math.max(0, Math.min(MOST, number)) },
    });
  const press = (digit: string) =>
    onChange({ ...value, entry: (value.entry + digit).replace(/^0+/, "").slice(0, 8) });

  const group = (kind: Denomination["kind"], title: string) => {
    const rows = denominations.filter((denomination) => denomination.kind === kind);
    if (!rows.length) return null;
    return (
      <div className="count-group">
        <h3>{title}</h3>
        {rows.map(({ value: note }) => {
          const label = denominationLabel(note, currency);
          const number = value.counts[note] ?? 0;
          return (
            <div className="count-row" key={note}>
              <span className="count-note">{label}</span>
              <div className="stepper">
                <button
                  type="button"
                  aria-label={t("count.less", { note: label })}
                  onClick={() => setCount(note, number - 1)}
                  disabled={disabled || number === 0}
                >
                  −
                </button>
                <input
                  className="count-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  placeholder="0"
                  aria-label={t("count.howMany", { note: label })}
                  value={number === 0 ? "" : String(number)}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "");
                    setCount(note, digits === "" ? 0 : parseInt(digits, 10));
                  }}
                  // Selected on focus, so a figure is typed over rather than
                  // appended to: "4" into a row showing 3 means four, not 34.
                  onFocus={(e) => e.target.select()}
                  disabled={disabled}
                />
                <button
                  type="button"
                  aria-label={t("count.more", { note: label })}
                  onClick={() => setCount(note, number + 1)}
                  disabled={disabled}
                >
                  +
                </button>
              </div>
              <span className="count-subtotal">
                {number > 0 ? formatMoney(toCents(note) * number, currency) : ""}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="cash-count">
      {denominations.length > 0 && (
        <div className="segmented" role="group" aria-label={t("count.how")}>
          <button
            type="button"
            className="btn"
            aria-pressed={value.mode === "notes"}
            onClick={() => onChange({ ...value, mode: "notes" })}
            disabled={disabled}
          >
            {t("count.byNotes")}
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={value.mode === "amount"}
            onClick={() => onChange({ ...value, mode: "amount" })}
            disabled={disabled}
          >
            {t("count.byAmount")}
          </button>
        </div>
      )}

      {value.mode === "notes" ? (
        <div className="count-groups">
          {group("note", t("count.notes"))}
          {group("coin", t("count.coins"))}
        </div>
      ) : (
        <>
          {usualCents != null && (
            <div className="quick-tender">
              <button
                type="button"
                aria-pressed={value.entry !== "" && parseInt(value.entry, 10) === usualCents}
                onClick={() => onChange({ ...value, entry: String(usualCents) })}
                disabled={disabled}
              >
                {t("count.usual", { amount: formatMoney(usualCents, currency) })}
              </button>
            </div>
          )}
          <div className="keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button type="button" key={digit} onClick={() => press(digit)} disabled={disabled}>
                {digit}
              </button>
            ))}
            <button type="button" onClick={() => press("00")} disabled={disabled}>
              00
            </button>
            <button type="button" onClick={() => press("0")} disabled={disabled}>
              0
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...value, entry: "" })}
              disabled={disabled}
              aria-label="clear"
            >
              ⌫
            </button>
          </div>
        </>
      )}
    </div>
  );
}
