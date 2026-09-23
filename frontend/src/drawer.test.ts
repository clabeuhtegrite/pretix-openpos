import { afterEach, describe, expect, it, vi } from "vitest";

import {
  briefOf, cashBlockedBy, countPayload, countTotal, denominationLabel, drawerIcon, emptyCount,
  moment,
} from "./drawer";
import { locale } from "./i18n";
import type { DrawerState } from "./types";

/**
 * The drawer as the rest of the till sees it: whether cash can be taken, and
 * what a count comes to. The panel that opens and closes it has its own suite.
 */

const EUR = [
  { value: "20.00", kind: "note" as const },
  { value: "0.50", kind: "coin" as const },
];

function state(over: Partial<DrawerState> = {}): DrawerState {
  return {
    drawer: {
      id: 3, name: "Bar", opening_float: "100.00", currency: "EUR", denominations: EUR,
    },
    session: null,
    last_closed: null,
    ...over,
  };
}

const session = {
  id: 9, opened_at: "2026-09-19T16:00:00Z", opened_by: "Ana", opening_float: "100.00",
  expected: "100.00", cash_sales: "0.00", cash_returned: "0.00", cash_in: "0.00", cash_out: "0.00",
  stale: false, movements: [], count: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("briefOf", () => {
  it("says a drawer with no opening running is closed", () => {
    expect(briefOf(state())).toEqual({ id: 3, name: "Bar", open: false, stale: false });
  });

  it("says a drawer with an opening running is open", () => {
    expect(briefOf(state({ session }))).toEqual({ id: 3, name: "Bar", open: true, stale: false });
  });

  it("carries over a drawer left open since an earlier day", () => {
    expect(briefOf(state({ session: { ...session, stale: true } }))?.stale).toBe(true);
  });

  it("has nothing to say about a device whose drawer was taken away", () => {
    expect(briefOf(state({ drawer: null }))).toBeNull();
  });
});

describe("cashBlockedBy", () => {
  const closed = { id: 3, name: "Bar", open: false, stale: false };

  it("blocks cash on a closed drawer", () => {
    expect(cashBlockedBy(closed, true)).toBe(closed);
  });

  it("blocks cash on a drawer left open since an earlier day", () => {
    const stale = { ...closed, open: true, stale: true };
    expect(cashBlockedBy(stale, true)).toBe(stale);
  });

  it("lets cash through an open drawer", () => {
    expect(cashBlockedBy({ ...closed, open: true }, true)).toBeNull();
  });

  it("lets cash through on a till with no drawer, or a server older than drawers", () => {
    expect(cashBlockedBy(null, true)).toBeNull();
    expect(cashBlockedBy(undefined, true)).toBeNull();
  });

  it("never blocks offline, where the server takes the sale anyway", () => {
    // The config is a cached one, and a sale rung up with no network is never
    // refused when it reaches the server: the customer has already paid.
    expect(cashBlockedBy(closed, false)).toBeNull();
  });
});

describe("a count", () => {
  it("starts note by note when the currency's notes and coins are known", () => {
    expect(emptyCount(EUR)).toEqual({ mode: "notes", counts: {}, entry: "" });
  });

  it("starts on the keypad for a currency the server has no notes for", () => {
    expect(emptyCount([]).mode).toBe("amount");
  });

  it("adds notes and coins up in cents", () => {
    const count = { mode: "notes" as const, counts: { "20.00": 3, "0.50": 5, "0.10": 0 }, entry: "" };

    expect(countTotal(count)).toBe(6250);
    expect(countPayload(count)).toEqual({
      amount: "62.50",
      // Rows left at zero say nothing, and are not sent.
      denominations: { "20.00": 3, "0.50": 5 },
    });
  });

  it("reads the keypad as cents, as the payment panel does", () => {
    const count = { mode: "amount" as const, counts: { "20.00": 3 }, entry: "12345" };

    expect(countTotal(count)).toBe(12345);
    // The rows kept from the other mode are not what was confirmed.
    expect(countPayload(count)).toEqual({ amount: "123.45" });
  });

  it("comes to nothing before anything is typed", () => {
    expect(countTotal({ mode: "amount", counts: {}, entry: "" })).toBe(0);
    expect(countPayload({ mode: "notes", counts: {}, entry: "" })).toEqual({ amount: "0.00" });
  });
});

describe("denominationLabel", () => {
  it("writes a note without its cents and a coin with them", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });

    expect(denominationLabel("50.00", "EUR")).toMatch(/^50\s€$/);
    expect(denominationLabel("0.50", "EUR")).toMatch(/^0,50\s€$/);
  });

  it("falls back to the bare figure for a currency code Intl refuses", () => {
    expect(denominationLabel("5.00", "not-a-currency")).toBe("5.00 not-a-currency");
  });
});

describe("drawerIcon", () => {
  it("picks the banknote of the currency, and the dollar for the rest", () => {
    expect(drawerIcon("EUR")).toBe("💶");
    expect(drawerIcon("GBP")).toBe("💷");
    expect(drawerIcon("JPY")).toBe("💴");
    expect(drawerIcon("CHF")).toBe("💵");
  });
});

describe("moment", () => {
  const evening = new Date(2026, 8, 19, 23, 30);
  const opened = new Date(2026, 8, 19, 18, 2);
  const clock = (at: Date) =>
    at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  it("gives the time alone for something that happened tonight", () => {
    expect(moment(opened.toISOString(), evening)).toBe(clock(opened));
  });

  it("keeps an opening from before midnight on the time alone at one in the morning", () => {
    const late = new Date(2026, 8, 20, 1, 0);

    expect(moment(opened.toISOString(), late)).toBe(clock(opened));
  });

  it("adds the day for a drawer left open last week", () => {
    const lastWeek = new Date(2026, 8, 12, 18, 2);
    const text = moment(lastWeek.toISOString(), evening);

    expect(text).not.toBe(clock(lastWeek));
    expect(text).toContain(clock(lastWeek));
    expect(text).toMatch(/12/);
  });

  it("reads the clock when not told the time", () => {
    const now = new Date();

    expect(moment(now.toISOString())).toBe(clock(now));
  });
});
