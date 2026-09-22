/**
 * Money is handled as integer cents everywhere inside the app.
 *
 * A till adds up small amounts over and over, and binary floats drift: three
 * lines at 3.30 already land on 9.899999999999999. The API speaks decimal
 * strings, so we convert once at the edges and never let a float near a total.
 */

export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return Math.round(Number(value) * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A real minus sign, not a hyphen.
 *
 * Intl writes a negative amount with U+002D, which is a short dash a good deal
 * lighter than the digits beside it; the app types U+2212 wherever it writes
 * one itself, on the basket's "−" button and on the deposit tile. Two glyphs
 * for the same thing sat on the same screen. This one is the one to keep: at
 * arm's length across a room, the difference a cashier has to catch is between
 * money coming in and money going out, and the longer bar is the one that can
 * be seen.
 */
function realMinus(formatted: string): string {
  return formatted.replace(/\u002d/g, "\u2212");
}

export function formatMoney(cents: number, currency: string, locale?: string): string {
  try {
    return realMinus(
      new Intl.NumberFormat(locale ?? navigator.language, {
        style: "currency",
        currency,
      }).format(cents / 100),
    );
  } catch {
    // Unknown currency code: better a bare number than a crashed till.
    return realMinus(`${fromCents(cents)} ${currency}`);
  }
}
