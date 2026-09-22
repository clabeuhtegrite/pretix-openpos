import { useMemo, useState } from "react";

import { productKey } from "../basket";
import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import type { Catalog, CartLine } from "../types";
import QuantityPanel from "./QuantityPanel";

/** A single tappable button in the grid: an item, or one of its variations. */
interface Sellable {
  key: string;
  itemId: number;
  variationId: number | null;
  label: string;
  priceCents: number;
  available: number | null;
  /** The item's photo, which every variation of it shares. Usually unset. */
  picture: string | null;
}

function soldOut(product: Sellable): boolean {
  return product.available !== null && product.available <= 0;
}

/**
 * A product picture, as a CSS background value.
 *
 * Only what could end the string early is escaped — a quote, a backslash, a
 * newline — and the url is otherwise handed over exactly as the server gave
 * it. Percent-encoding the whole thing instead would corrupt any url that
 * already carries an escape of its own. pretix names these files itself, so a
 * quote in one is not an expected shape; this is simply the rule for putting
 * anything that came off a server inside a stylesheet.
 */
function pictureBackground(picture: string): string {
  const quoted = picture.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, "");
  return `url("${quoted}")`;
}

function flatten(catalog: Catalog): { id: string; name: string; products: Sellable[] }[] {
  return catalog.categories.map((category) => ({
    id: String(category.id ?? "none"),
    name: category.name,
    products: category.items
      .flatMap<Sellable>((item) =>
        item.variations.length
          ? item.variations.map((variation) => ({
              key: productKey(item.id, variation.id),
              itemId: item.id,
              variationId: variation.id,
              label: `${item.name} · ${variation.name}`,
              priceCents: toCents(variation.price),
              available: variation.available,
              picture: item.picture,
            }))
          : [
              {
                key: productKey(item.id, null),
                itemId: item.id,
                variationId: null,
                label: item.name,
                priceCents: toCents(item.price),
                available: item.available,
                picture: item.picture,
              },
            ],
      )
      // What is finished goes to the back of its own category rather than out
      // of the grid: the cashier still has to be able to see that the place
      // sells it and has run out, but not with their thumb. Sorting rather
      // than filtering also keeps every button where the eye left it for as
      // long as there is stock, which is the whole point of a fixed grid.
      .sort((a, b) => Number(soldOut(a)) - Number(soldOut(b))),
  }));
}

interface Props {
  catalog: Catalog;
  cart: CartLine[];
  currency: string;
  /** The two buttons that are not products; absent unless the organiser set them up. */
  customSale: { name: string } | null;
  depositBack: { name: string; priceCents: number } | null;
  onAdd: (product: Sellable) => void;
  onCustomSale: () => void;
  onDepositBack: () => void;
  onSetCount: (key: string, count: number) => void;
  onClear: () => void;
  onCharge: () => void;
}

export default function SaleScreen({
  catalog, cart, currency, customSale, depositBack, onAdd, onCustomSale, onDepositBack,
  onSetCount, onClear, onCharge,
}: Props) {
  const categories = useMemo(() => flatten(catalog), [catalog]);
  const [active, setActive] = useState<string>("all");
  /** The basket line whose count is being asked for, by key. */
  const [counting, setCounting] = useState<string | null>(null);

  const shown = active === "all" ? categories : categories.filter((c) => c.id === active);
  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.count, 0);
  const countingLine = cart.find((line) => line.key === counting) ?? null;

  return (
    <div className="workspace">
      <div className="catalog">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            className="tab"
            aria-selected={active === "all"}
            onClick={() => setActive("all")}
          >
            {t("sale.all")}
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              role="tab"
              className="tab"
              aria-selected={active === category.id}
              onClick={() => setActive(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>

        <div className="grid">
          {/* Before the catalogue and outside the tabs, because neither of
              these belongs to a category and both have to be one tap away
              whichever one the operator is looking at. */}
          {customSale && (
            <button className="product is-action" onClick={onCustomSale}>
              <span className="name">{t("custom.tile")}</span>
              <span className="price">＋</span>
              <span className="stock">{customSale.name}</span>
            </button>
          )}
          {depositBack && (
            <button className="product is-action is-refund" onClick={onDepositBack}>
              <span className="name">{t("deposit.tile")}</span>
              <span className="price">
                −{formatMoney(depositBack.priceCents, currency)}
              </span>
              <span className="stock">{depositBack.name}</span>
            </button>
          )}
          {shown.map((category) => (
            <FragmentWithHeading
              key={category.id}
              heading={shown.length > 1 ? category.name : null}
              products={category.products}
              currency={currency}
              onAdd={onAdd}
            />
          ))}
        </div>
      </div>

      <div className="cart">
        <div className="cart-header">
          <span>{t("sale.cart")}</span>
          <span style={{ flex: 1 }} />
          {cart.length > 0 && (
            <button className="btn ghost" style={{ width: "auto" }} onClick={onClear}>
              {t("sale.clear")}
            </button>
          )}
        </div>

        <div className="cart-lines">
          {cart.length === 0 ? (
            <div className="cart-empty">{t("sale.empty")}</div>
          ) : (
            cart.map((line) => (
              <div
                className={`line${line.unitPrice < 0 ? " is-refund" : ""}`}
                key={line.key}
              >
                <div className="label">
                  {line.label}
                  <small>{formatMoney(line.unitPrice, currency)}</small>
                </div>
                <div className="stepper">
                  <button onClick={() => onSetCount(line.key, line.count - 1)} aria-label="−">
                    −
                  </button>
                  {/* The count is the shortest way to say "six", and it is
                      already where the eye is when the answer is wrong. */}
                  <button
                    className="count"
                    aria-label={t("sale.quantityOf", { label: line.label, n: line.count })}
                    onClick={() => setCounting(line.key)}
                  >
                    {line.count}
                  </button>
                  <button
                    onClick={() => onSetCount(line.key, line.count + 1)}
                    aria-label="+"
                    disabled={line.available !== null && line.count >= line.available}
                  >
                    +
                  </button>
                </div>
                <div className="amount">{formatMoney(line.unitPrice * line.count, currency)}</div>
              </div>
            ))
          )}
        </div>

        <div className="cart-footer">
          <div className="total-row">
            <span>{t("sale.total")}</span>
            <span className="amount">{formatMoney(total, currency)}</span>
          </div>
          <button className="btn primary" disabled={cart.length === 0} onClick={onCharge}>
            {t("sale.charge")}
          </button>
        </div>
      </div>

      {countingLine && (
        <QuantityPanel
          line={countingLine}
          onSetCount={onSetCount}
          onClose={() => setCounting(null)}
        />
      )}
    </div>
  );
}

function FragmentWithHeading({
  heading, products, currency, onAdd,
}: {
  heading: string | null;
  products: Sellable[];
  currency: string;
  onAdd: (p: Sellable) => void;
}) {
  return (
    <>
      {heading && <h2 className="section-title">{heading}</h2>}
      {products.map((product) => {
        const out = soldOut(product);
        return (
          <button
            key={product.key}
            className="product"
            disabled={out}
            onClick={() => onAdd(product)}
          >
            {/* A background rather than an <img>: the picture comes off the
                pretix server, and a till that has lost the network has to go
                on selling. A background that cannot load shows nothing at
                all, where an <img> shows a broken icon. The name and the
                price are what the cashier reads either way. */}
            {product.picture && (
              <span
                className="thumb"
                aria-hidden="true"
                style={{ backgroundImage: pictureBackground(product.picture) }}
              />
            )}
            <span className="name">{product.label}</span>
            <span className="price">{formatMoney(product.priceCents, currency)}</span>
            {out ? (
              <span className="stock low">{t("sale.soldOut")}</span>
            ) : product.available !== null && product.available <= 20 ? (
              <span className="stock low">{t("sale.left", { n: product.available })}</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

export { pictureBackground };
export type { Sellable };
