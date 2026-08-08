import { useMemo, useState } from "react";

import { t } from "../i18n";
import { formatMoney, toCents } from "../money";
import type { Catalog, CartLine } from "../types";

/** A single tappable button in the grid: an item, or one of its variations. */
interface Sellable {
  key: string;
  itemId: number;
  variationId: number | null;
  label: string;
  priceCents: number;
  available: number | null;
}

function flatten(catalog: Catalog): { id: string; name: string; products: Sellable[] }[] {
  return catalog.categories.map((category) => ({
    id: String(category.id ?? "none"),
    name: category.name,
    products: category.items.flatMap<Sellable>((item) =>
      item.variations.length
        ? item.variations.map((variation) => ({
            key: `${item.id}:${variation.id}`,
            itemId: item.id,
            variationId: variation.id,
            label: `${item.name} · ${variation.name}`,
            priceCents: toCents(variation.price),
            available: variation.available,
          }))
        : [
            {
              key: `${item.id}:`,
              itemId: item.id,
              variationId: null,
              label: item.name,
              priceCents: toCents(item.price),
              available: item.available,
            },
          ],
    ),
  }));
}

interface Props {
  catalog: Catalog;
  cart: CartLine[];
  currency: string;
  onAdd: (product: Sellable) => void;
  onSetCount: (key: string, count: number) => void;
  onClear: () => void;
  onCharge: () => void;
}

export default function SaleScreen({
  catalog, cart, currency, onAdd, onSetCount, onClear, onCharge,
}: Props) {
  const categories = useMemo(() => flatten(catalog), [catalog]);
  const [active, setActive] = useState<string>("all");

  const shown = active === "all" ? categories : categories.filter((c) => c.id === active);
  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.count, 0);

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
            ★
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
              <div className="line" key={line.key}>
                <div className="label">
                  {line.label}
                  <small>{formatMoney(line.unitPrice, currency)}</small>
                </div>
                <div className="stepper">
                  <button onClick={() => onSetCount(line.key, line.count - 1)} aria-label="−">
                    −
                  </button>
                  <span className="count">{line.count}</span>
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
        const soldOut = product.available !== null && product.available <= 0;
        return (
          <button
            key={product.key}
            className="product"
            disabled={soldOut}
            onClick={() => onAdd(product)}
          >
            <span className="name">{product.label}</span>
            <span className="price">{formatMoney(product.priceCents, currency)}</span>
            {soldOut ? (
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

export type { Sellable };
