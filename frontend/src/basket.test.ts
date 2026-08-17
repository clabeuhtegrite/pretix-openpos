import { describe, expect, it } from "vitest";

import { basketFromJournal, repriceCart } from "./basket";
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
});
