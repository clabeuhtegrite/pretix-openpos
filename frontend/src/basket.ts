import { toCents } from "./money";
import type { Catalog, CartLine, JournalPosition } from "./types";

/**
 * Building and re-pricing baskets from a catalogue.
 *
 * Pure functions, out of App on purpose: they decide what a correction costs
 * and what a price change does to an open basket, which is exactly the kind of
 * thing to pin down with tests rather than re-read under pressure.
 *
 * Three kinds of line share one basket, told apart by their key:
 *
 * * ``<item>:<variation>`` — an ordinary product, priced from the catalogue.
 * * ``refund:<item>`` — a deposit handed back, priced at minus the catalogue.
 * * ``custom:<nonce>`` — a free amount, priced by the cashier and by nobody
 *   else, hence never merged with another line and never re-priced.
 */

/** The key of an ordinary product line. */
export function productKey(item: number, variation: number | null): string {
  return `${item}:${variation ?? ""}`;
}

/** The key of the line that hands a deposit back. One per product. */
export function refundKey(item: number): string {
  return `refund:${item}`;
}

/** The key of one free amount. Unique per line: two are two lines. */
export function customKey(nonce: string): string {
  return `custom:${nonce}`;
}

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
  positions.forEach((position, index) => {
    if (position.description) {
      // A free amount has no tariff to be re-priced from: the figure in the
      // journal is the only one it ever had. Carried over as it was written,
      // reason and all, so correcting the order keeps the line that most
      // needed explaining.
      lines.push({
        key: customKey(`journal-${index}`),
        itemId: position.item,
        variationId: null,
        label: position.item_name,
        unitPrice: toCents(position.unit_price),
        count: position.count,
        available: null,
        description: position.description,
      });
      return;
    }
    const key = productKey(position.item, position.variation);
    const product = sellable.get(key);
    if (!product) return;
    lines.push({
      key,
      itemId: position.item,
      variationId: position.variation,
      label: product.label,
      unitPrice: product.price,
      count: position.count,
      available: product.available,
    });
  });
  return lines;
}

/** Re-price an open basket against a freshly loaded catalogue. */
export function repriceCart(lines: CartLine[], catalog: Catalog): CartLine[] {
  const prices = sellableIndex(catalog);
  // A line whose product vanished from the catalogue keeps its price here; the
  // server refuses it at checkout, which is the answer that matters.
  return lines.map((line) => {
    // A free amount was priced by the cashier for a reason the catalogue knows
    // nothing about. Re-pricing it would silently replace what they typed with
    // the placeholder price of the product it is booked against.
    if (line.description) return line;
    const product = prices.get(
      line.refund ? productKey(line.itemId, null) : line.key,
    );
    if (!product) return line;
    // A deposit handed back is worth minus what a deposit costs, so a tariff
    // edited mid-evening moves both directions together.
    return { ...line, unitPrice: line.refund ? -product.price : product.price };
  });
}
