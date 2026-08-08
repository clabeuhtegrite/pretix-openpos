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

export function formatMoney(cents: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale ?? navigator.language, {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    // Unknown currency code: better a bare number than a crashed till.
    return `${fromCents(cents)} ${currency}`;
  }
}
