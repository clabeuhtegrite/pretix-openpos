import { describe, expect, it } from "vitest";

import { toCents } from "./money";
import { settle } from "./settlement";

/**
 * The arithmetic that decides how much cash leaves the drawer.
 *
 * The case worth guarding is the corrected order: a sale is cancelled, the
 * credit funds the replacement, and three different figures are in play at once
 * — what the order is worth, what the customer still owes, and what the server
 * is told was received. Getting the last one wrong does not show up on screen;
 * it shows up in the journal, days later, as change that was never given.
 */

describe("a plain cash sale", () => {
  it("asks for the total and works out the change", () => {
    const s = settle({ totalCents: 1700, tenderedCents: 2000, method: "cash" });
    expect(s.dueCents).toBe(1700);
    expect(s.backCents).toBe(0);
    expect(s.changeCents).toBe(300);
    expect(s.short).toBe(false);
    expect(s.cashGiven).toBe("20.00");
  });

  it("is not short on the exact amount", () => {
    const s = settle({ totalCents: 1700, tenderedCents: 1700, method: "cash" });
    expect(s.changeCents).toBe(0);
    expect(s.short).toBe(false);
  });

  it("is short until enough has been tendered", () => {
    const s = settle({ totalCents: 1700, tenderedCents: 1000, method: "cash" });
    expect(s.short).toBe(true);
    expect(s.changeCents).toBe(-700);
  });

  it("sends nothing when nothing was typed", () => {
    // An empty keypad is not "zero received": the server is left to record a
    // cash sale with no tendered amount, which is what a till that never
    // counted the money should say.
    const s = settle({ totalCents: 1700, tenderedCents: null, method: "cash" });
    expect(s.cashGiven).toBeNull();
    expect(s.changeCents).toBeNull();
    expect(s.short).toBe(false);
  });
});

describe("a card sale", () => {
  it("records no amount and no change", () => {
    const s = settle({ totalCents: 1700, tenderedCents: 2000, method: "card" });
    expect(s.cashGiven).toBeNull();
    expect(s.changeCents).toBeNull();
    expect(s.short).toBe(false);
  });

  it("still says what is due after a credit", () => {
    const s = settle({ totalCents: 1700, creditCents: 2000, method: "card" });
    expect(s.dueCents).toBe(0);
    expect(s.backCents).toBe(300);
  });
});

describe("an order corrected against a credit", () => {
  it("charges only the difference when the new order costs more", () => {
    const s = settle({ totalCents: 1700, creditCents: 1000, method: "cash" });
    expect(s.dueCents).toBe(700);
    expect(s.backCents).toBe(0);
  });

  it("hands back the difference when the new order costs less", () => {
    const s = settle({ totalCents: 1700, creditCents: 2000, method: "cash" });
    expect(s.dueCents).toBe(0);
    expect(s.backCents).toBe(300);
  });

  it("asks for nothing when the credit covers it exactly", () => {
    const s = settle({ totalCents: 1700, creditCents: 1700, method: "cash" });
    expect(s.dueCents).toBe(0);
    expect(s.backCents).toBe(0);
    expect(s.cashGiven).toBe("17.00");
  });

  it("counts the credit as received, so the order is settled in full", () => {
    // 20 € credited, 17 € order, nothing handed over: the server must see 20 €
    // received against a 17 € order, not 0 € against 17 €, or the order is
    // recorded as unpaid and the 3 € going back out belongs to nothing.
    const s = settle({ totalCents: 1700, creditCents: 2000, method: "cash" });
    expect(s.cashGiven).toBe("20.00");
  });

  it("adds what was handed over to the credit", () => {
    const s = settle({ totalCents: 1700, creditCents: 1000, tenderedCents: 1000, method: "cash" });
    expect(s.changeCents).toBe(300);
    expect(s.cashGiven).toBe("20.00");
  });
});

describe("the invariant the drawer is reconciled on", () => {
  /**
   * Whatever the panel shows the operator to count out, the server must arrive
   * at the same figure from what it was told — it computes change as received
   * minus the order's own total, and the journal is written from that.
   */
  const cases = [
    { totalCents: 1700, creditCents: 0, tenderedCents: 2000 },
    { totalCents: 1700, creditCents: 0, tenderedCents: 1700 },
    { totalCents: 1700, creditCents: 1000, tenderedCents: 1000 },
    { totalCents: 1700, creditCents: 1000, tenderedCents: null },
    { totalCents: 1700, creditCents: 2000, tenderedCents: null },
    { totalCents: 1700, creditCents: 1700, tenderedCents: null },
    { totalCents: 0, creditCents: 500, tenderedCents: null },
  ];

  for (const input of cases) {
    it(`holds for ${input.totalCents}c due, ${input.creditCents}c credited, ${input.tenderedCents}c tendered`, () => {
      const s = settle({ ...input, method: "cash" });
      const serverChange = toCents(s.cashGiven) - input.totalCents;
      // What the operator counts out is the change on screen, plus whatever the
      // credit hands back when it more than covered the order.
      expect(serverChange).toBe((s.changeCents ?? 0) + s.backCents);
      expect(serverChange).toBeGreaterThanOrEqual(0);
    });
  }
});
