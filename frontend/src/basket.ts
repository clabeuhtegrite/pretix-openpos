import { toCents } from "./money";
import type { Catalog, CartLine, JournalPosition } from "./types";

/**
 * Building and re-pricing baskets from a catalogue.
 *
 * Pure functions, out of App on purpose: they decide what a correction costs
 * and what a price change does to an open basket, which is exactly the kind of
 * thing to pin down with tests rather than re-read under pressure.
 */

/** Every sellable line of a catalogue, keyed like a cart line. */
function sellableIndex(catalog: Catalog) {
  const sellable = new Map<
    string,
    { label: string; price: number; available: number | null }
  >();
  for (const category of catalog.categories) {
    for (const item of category.items) {
      if (item.variations.length) {
        for (const variation of item.variations) {
          sellable.set(`${item.id}:${variation.id}`, {
            label: `${item.name} · ${variation.name}`,
            price: toCents(variation.price),
            available: variation.available,
          });
        }
      } else {
        sellable.set(`${item.id}:`, {
          label: item.name,
          price: toCents(item.price),
          available: item.available,
        });
      }
    }
  }
  return sellable;
}

/**
 * Turn the lines of a cancelled sale back into a basket.
 *
 * Priced from today's catalogue rather than from what the journal recorded: the
 * original figures belong to the sale that was reversed, and re-selling at them
 * would quietly resurrect yesterday's tariff. A product that has since left the
 * catalogue is dropped here — the server would refuse it at checkout anyway,
 * and it is better noticed with the basket open than at payment.
 */
export function basketFromJournal(
  positions: JournalPosition[],
  catalog: Catalog,
): CartLine[] {
  const sellable = sellableIndex(catalog);

  const lines: CartLine[] = [];
  for (const position of positions) {
    const key = `${position.item}:${position.variation ?? ""}`;
    const product = sellable.get(key);
    if (!product) continue;
    lines.push({
      key,
      itemId: position.item,
      variationId: position.variation,
      label: product.label,
      unitPrice: product.price,
      count: position.count,
      available: product.available,
    });
  }
  return lines;
}

/** Re-price an open basket against a freshly loaded catalogue. */
export function repriceCart(lines: CartLine[], catalog: Catalog): CartLine[] {
  const prices = sellableIndex(catalog);
  // A line whose product vanished from the catalogue keeps its price here; the
  // server refuses it at checkout, which is the answer that matters.
  return lines.map((line) => {
    const product = prices.get(line.key);
    return product ? { ...line, unitPrice: product.price } : line;
  });
}
