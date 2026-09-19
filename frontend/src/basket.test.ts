import { describe, expect, it } from "vitest";

import { basketFromJournal, customKey, productKey, refundKey, repriceCart } from "./basket";
import type { Catalog, CartLine, JournalPosition } from "./types";

/** Today's catalogue: the beer now costs 4.00, whatever the journal remembers. */
const catalog: Catalog = {
  categories: [
    {
      id: 1,
      name: "Bar",
      items: [
        {
          id: 10,
          name: "Bière",
          admission: false,
          picture: null,
          price: "4.00",
          available: 12,
          variations: [],
        },
        {
          id: 11,
          name: "T-shirt",
          admission: false,
          picture: null,
          price: null,
          available: null,
          variations: [{ id: 21, name: "M", price: "15.00", available: 3 }],
        },
      ],
    },
  ],
};

function journalLine(overrides: Partial<JournalPosition>): JournalPosition {
  return {
    item: 10,
    item_name: "Bière",
    variation: null,
    variation_name: null,
    count: 2,
    unit_price: "3.50",
    line_total: "7.00",
    ...overrides,
  };
}

describe("basketFromJournal", () => {
  it("prices from today's catalogue, not from what the journal recorded", () => {
    const lines = basketFromJournal([journalLine({})], catalog);
    expect(lines).toHaveLength(1);
    // The sale being corrected was made at 3.50; re-selling happens at 4.00.
    expect(lines[0].unitPrice).toBe(400);
    expect(lines[0].count).toBe(2);
    expect(lines[0].key).toBe("10:");
  });

  it("resolves variations to their own key, label and price", () => {
    const lines = basketFromJournal(
      [journalLine({ item: 11, variation: 21, count: 1 })],
      catalog,
    );
    expect(lines[0].key).toBe("11:21");
    expect(lines[0].label).toBe("T-shirt · M");
    expect(lines[0].unitPrice).toBe(1500);
  });

  it("drops products that have left the catalogue", () => {
    const lines = basketFromJournal([journalLine({ item: 99 })], catalog);
    expect(lines).toEqual([]);
  });

  it("carries a free amount over exactly as it was written", () => {
    // It has no tariff to be re-priced from — the cashier decided it — so the
    // journal's own figure is the only one it ever had. Re-pricing it from
    // the catalogue would quietly replace it with a placeholder.
    const lines = basketFromJournal(
      [journalLine({
        item: 30, item_name: "Divers", count: 1,
        unit_price: "12.50", line_total: "12.50", description: "Verre cassé",
      })],
      catalog,
    );

    expect(lines[0].unitPrice).toBe(1250);
    expect(lines[0].description).toBe("Verre cassé");
    expect(lines[0].label).toBe("Divers");
  });

  it("gives two free amounts two lines, even at the same price", () => {
    const broken = {
      item: 30, item_name: "Divers", count: 1,
      unit_price: "5.00", line_total: "5.00",
    };
    const lines = basketFromJournal(
      [
        journalLine({ ...broken, description: "Verre cassé" }),
        journalLine({ ...broken, description: "Don" }),
      ],
      catalog,
    );

    expect(new Set(lines.map((line) => line.key)).size).toBe(2);
  });
});

describe("the keys that tell the three kinds of line apart", () => {
  it("keys an ordinary product by item and variation", () => {
    expect(productKey(10, null)).toBe("10:");
    expect(productKey(11, 21)).toBe("11:21");
  });

  it("keys a returned deposit apart from the deposit being sold", () => {
    // Otherwise taking a deposit and handing one back would merge into a
    // single line and cancel each other out on screen.
    expect(refundKey(30)).not.toBe(productKey(30, null));
  });

  it("gives every free amount a key of its own", () => {
    expect(customKey("a")).not.toBe(customKey("b"));
  });
});

describe("repriceCart", () => {
  const line: CartLine = {
    key: "10:",
    itemId: 10,
    variationId: null,
    label: "Bière",
    unitPrice: 350,
    count: 3,
    available: 12,
  };

  it("moves an open basket to the freshly loaded tariff", () => {
    expect(repriceCart([line], catalog)[0].unitPrice).toBe(400);
  });

  it("leaves a vanished product's line alone for the server to refuse", () => {
    const vanished = { ...line, key: "99:", itemId: 99 };
    expect(repriceCart([vanished], catalog)[0].unitPrice).toBe(350);
  });

  it("moves a returned deposit with the tariff, in the other direction", () => {
    const back: CartLine = {
      ...line, key: refundKey(10), unitPrice: -350, refund: true,
    };

    expect(repriceCart([back], catalog)[0].unitPrice).toBe(-400);
  });

  it("leaves a free amount exactly as the cashier typed it", () => {
    // The product it is booked against has a placeholder price, and moving
    // the line onto it would silently charge that instead.
    const custom: CartLine = {
      ...line, key: customKey("n1"), unitPrice: 1250, description: "Verre cassé",
    };

    expect(repriceCart([custom], catalog)[0].unitPrice).toBe(1250);
  });
});
