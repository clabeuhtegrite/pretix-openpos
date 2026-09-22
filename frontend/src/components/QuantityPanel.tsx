import { t } from "../i18n";
import type { CartLine } from "../types";

/**
 * How many, in one tap.
 *
 * A round is six beers, and six beers used to be six taps on the tile or five
 * on a "+". This is the same line's count, asked once: the numbers a bar
 * actually rings up are all here, and tapping one is the whole interaction —
 * no confirm, no keypad, no second thought.
 *
 * It stops at twelve on purpose. Past that the stepper on the line is still
 * there and is the honest way to count out a crate, whereas a pad big enough
 * for every case would push the useful numbers off the thumb's reach.
 */

/** What a bar rings up; anything rarer stays on the line's own stepper. */
const CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface Props {
  line: CartLine;
  onSetCount: (key: string, count: number) => void;
  onClose: () => void;
}

export default function QuantityPanel({ line, onSetCount, onClose }: Props) {
  const pick = (count: number) => {
    onSetCount(line.key, count);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel quantity-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("sale.quantity")}</h2>
        <p className="quantity-label">{line.label}</p>

        <div className="quantity-grid">
          {CHOICES.map((count) => (
            <button
              key={count}
              className={count === line.count ? "is-current" : ""}
              aria-pressed={count === line.count}
              disabled={line.available !== null && count > line.available}
              onClick={() => pick(count)}
            >
              {count}
            </button>
          ))}
        </div>

        <div className="pay-buttons">
          <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
            {t("payment.back")}
          </button>
          <button className="btn danger" style={{ flex: 1 }} onClick={() => pick(0)}>
            {t("sale.remove")}
          </button>
        </div>
      </div>
    </div>
  );
}
