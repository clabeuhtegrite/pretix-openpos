import { describe, expect, it } from "vitest";

import { admitsAnyone, basketTotals, positionsOf, queuedResultOf, queuedSaleOf } from "./payment";
import type { CartLine, PendingPayment } from "./types";

/**
 * The arithmetic of a sale, shared by the screen that rings it up and the
 * relaunch that finishes it. Both must build the same request out of the same
 * basket, or a sale picked up after a reload is a different sale.
 */

const beer: CartLine = {
  key: "10:", itemId: 10, variationId: null, label: "Bière", unitPrice: 450, count: 2, available: null,
};
const ticket: CartLine = {
  key: "20:", itemId: 20, variationId: null, label: "Entrée", unitPrice: 1000, count: 1, available: null,
};
const cup: CartLine = {
  key: "refund:30", itemId: 30, variationId: null, label: "Gobelet rendu", unitPrice: -100,
  count: 2, available: null, refund: true,
};
const free: CartLine = {
  key: "custom:1", itemId: 40, variationId: null, label: "Dons", unitPrice: 500, count: 1,
  available: null, description: "Dons",
};

function payment(over: Partial<PendingPayment> = {}): PendingPayment {
  return {
    event: "festival", key: "k-1", stage: "sale", paymentType: "cash", cashGiven: "20.00",
    charged: null, cart: [beer, cup], credit: null, cashier: "Ana", admits: false, currency: "EUR",
    at: "2026-08-16T22:02:00.000Z", ...over,
  };
}

describe("the three figures of a basket", () => {
  it("are one and the same with no deposit handed back", () => {
    expect(basketTotals([beer, ticket])).toEqual({ total: 1900, soldCents: 1900, refundedCents: 0 });
  });

  it("part ways over cups returned: what changes hands, what is sold, what leaves the drawer", () => {
    expect(basketTotals([beer, cup])).toEqual({ total: 700, soldCents: 900, refundedCents: 200 });
  });
});

describe("the basket as the server wants it", () => {
  it("gives a figure only for the lines the server cannot price itself", () => {
    expect(positionsOf([beer, free, cup])).toEqual([
      { item: 10, variation: null, count: 2 },
      { item: 40, variation: null, count: 1, price: "5.00", description: "Dons" },
      { item: 30, variation: null, count: 2, refund: true },
    ]);
  });
});

describe("who a basket lets in", () => {
  it("is anyone buying an admission product", () => {
    expect(admitsAnyone([beer, ticket], [20])).toBe(true);
    expect(admitsAnyone([beer], [20])).toBe(false);
  });

  it("is nobody for a returned cup booked against one", () => {
    expect(admitsAnyone([{ ...cup, itemId: 20 }], [20])).toBe(false);
  });
});

describe("a payment kept for later", () => {
  it("goes in the queue under the payment's own key, at the moment it was paid", () => {
    const entry = queuedSaleOf(payment());

    expect(entry).toMatchObject({
      kind: "sale", id: "k-1", at: "2026-08-16T22:02:00.000Z", event: "festival",
      chargedTotal: "7.00", paymentType: "cash", cashGiven: "20.00", cashChange: "13.00",
      cashier: "Ana", admits: false, label: "2× Bière, 2× Gobelet rendu",
    });
    expect(entry.positions).toEqual([
      { item: 10, variation: null, count: 2, price: "4.50" },
      { item: 30, variation: null, count: 2, price: "-1.00", refund: true },
    ]);
    // No reader, no second figure.
    expect(entry).not.toHaveProperty("linesTotal");
  });

  it("carries the reader's figure, and the sum of its lines to check them against", () => {
    const entry = queuedSaleOf(payment({
      paymentType: "card", cashGiven: null, charged: "9.50", cart: [beer, free],
    }));

    expect(entry).toMatchObject({ chargedTotal: "9.50", linesTotal: "14.00", cashChange: null });
    expect(entry.positions[1]).toEqual({
      item: 40, variation: null, count: 1, price: "5.00", description: "Dons",
    });
  });

  it("reads like a server answer with no order code, because there is no order yet", () => {
    const entry = queuedSaleOf(payment({ admits: true }));

    expect(queuedResultOf(entry, [beer, cup])).toEqual({
      order: { code: "", total: "9.00" },
      journal_seq: 0,
      payment_type: "cash",
      cash_given: "20.00",
      cash_change: "13.00",
      datetime: "2026-08-16T22:02:00.000Z",
      replayed: false,
      checked_in: 1,
      checkin_errors: [],
      offline: true,
      deposit_refund: "2.00",
      net_total: "7.00",
    });
  });

  it("names no deposit and no admission when there are none", () => {
    const entry = queuedSaleOf(payment({ cart: [beer] }));

    expect(queuedResultOf(entry, [beer])).toMatchObject({ deposit_refund: null, checked_in: 0 });
  });
});
