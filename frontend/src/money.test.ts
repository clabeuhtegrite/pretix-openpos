import { describe, expect, it } from "vitest";

import { formatMoney, fromCents, toCents } from "./money";

describe("toCents", () => {
  it("parses the decimal strings the API speaks", () => {
    expect(toCents("4.00")).toBe(400);
    expect(toCents("3.30")).toBe(330);
    expect(toCents("0.10")).toBe(10);
  });

  it("treats absent values as zero", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("rounds away binary-float noise", () => {
    expect(toCents(9.899999999999999)).toBe(990);
  });
});

describe("fromCents", () => {
  it("always prints two decimals", () => {
    expect(fromCents(400)).toBe("4.00");
    expect(fromCents(990)).toBe("9.90");
    expect(fromCents(0)).toBe("0.00");
  });
});

describe("the drift this module exists to stop", () => {
  it("adds three lines at 3.30 to exactly 9.90", () => {
    // In floats: 3.3 + 3.3 + 3.3 === 9.899999999999999.
    const total = toCents("3.30") * 3;
    expect(fromCents(total)).toBe("9.90");
  });
});

describe("formatMoney", () => {
  it("formats through Intl for a known currency", () => {
    expect(formatMoney(330, "EUR", "en-US")).toBe("€3.30");
  });

  it("degrades to a bare number rather than crash on a broken code", () => {
    expect(formatMoney(100, "EURO", "en-US")).toBe("1.00 EURO");
  });

  it("writes a negative amount with a real minus sign", () => {
    // Intl writes U+002D, a hyphen shorter and lighter than the digits next to
    // it. The till types U+2212 everywhere it writes one itself, and across a
    // room that bar is the difference between money in and money out.
    expect(formatMoney(-330, "EUR", "en-US")).toBe("\u2212€3.30");
  });

  it("uses the same sign when it has fallen back to a bare number", () => {
    expect(formatMoney(-100, "EURO", "en-US")).toBe("\u22121.00 EURO");
  });
});
