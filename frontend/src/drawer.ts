import { locale } from "./i18n";
import { fromCents, toCents } from "./money";
import type { Denomination, DrawerBrief, DrawerState } from "./types";

/**
 * The cash drawer, as the rest of the till needs to know about it.
 *
 * The drawer panel is where a drawer is opened, counted and closed; what lives
 * here is the arithmetic of a count and the one question every other screen
 * asks, which is whether cash can be taken right now.
 */

/** What the config should say about the drawer, after the panel has read or changed it. */
export function briefOf(state: DrawerState): DrawerBrief | null {
  if (!state.drawer) return null;
  return {
    id: state.drawer.id,
    name: state.drawer.name,
    open: state.session !== null,
    stale: state.session?.stale ?? false,
  };
}

/**
 * The drawer that stops this till from taking cash right now, or null.
 *
 * Only ever said online. Offline, the config is whatever was cached, which may
 * be a drawer the other tablet opened an hour ago; and a sale rung up offline
 * is never refused when it reaches the server — the customer has paid, and
 * refusing would not take the cash back out of the drawer. Saying "closed"
 * there would stop a sale the server is going to take anyway.
 */
export function cashBlockedBy(
  drawer: DrawerBrief | null | undefined,
  online: boolean,
): DrawerBrief | null {
  if (!online || !drawer) return null;
  return !drawer.open || drawer.stale ? drawer : null;
}

/**
 * A count in progress: note by note, or the total typed straight in.
 *
 * Both are kept while the other is on screen, so switching to check a figure
 * does not throw away twenty rows of coins.
 */
export interface CountState {
  mode: "notes" | "amount";
  /** How many of each note and coin, keyed by value as the server spells it ("20.00"). */
  counts: Record<string, number>;
  /** Digits typed on the keypad, read as cents, as the payment panel does. */
  entry: string;
}

export function emptyCount(denominations: Denomination[]): CountState {
  // Note by note wherever the currency is known: it is how a drawer is
  // actually counted, and it is what makes a wrong total findable afterwards.
  return { mode: denominations.length ? "notes" : "amount", counts: {}, entry: "" };
}

/** What the count comes to, in cents. */
export function countTotal(state: CountState): number {
  if (state.mode === "amount") return state.entry === "" ? 0 : parseInt(state.entry, 10);
  return Object.entries(state.counts).reduce(
    (sum, [value, number]) => sum + toCents(value) * number,
    0,
  );
}

/** The count as the server takes it: the total, and the rows somebody filled in. */
export function countPayload(state: CountState): {
  amount: string;
  denominations?: Record<string, number>;
} {
  const amount = fromCents(countTotal(state));
  if (state.mode === "amount") return { amount };
  const rows = Object.entries(state.counts).filter(([, number]) => number > 0);
  return rows.length ? { amount, denominations: Object.fromEntries(rows) } : { amount };
}

/**
 * A note or a coin as it is printed on it: "50 €", "0,50 €".
 *
 * Not formatMoney, whose "50,00 €" is right for an amount and wrong for a
 * banknote, which nobody reads with its cents.
 */
export function denominationLabel(value: string, currency: string): string {
  const cents = toCents(value);
  try {
    return new Intl.NumberFormat(navigator.language, {
      style: "currency",
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${value} ${currency}`;
  }
}

/** The banknote that goes with the currency, for the drawer's button in the top bar. */
export function drawerIcon(currency: string): string {
  return ({ EUR: "💶", GBP: "💷", JPY: "💴" } as Record<string, string>)[currency] ?? "💵";
}

const HALF_A_DAY_MS = 12 * 60 * 60 * 1000;

/**
 * When something happened to the drawer, as short as it can be said.
 *
 * The time alone for tonight — "18:02", including an opening from before
 * midnight read at one in the morning — and the day with it for anything
 * older, which is exactly the drawer somebody forgot to close last Saturday.
 */
export function moment(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay || now.getTime() - at.getTime() < HALF_A_DAY_MS) return time;
  const day = at.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" });
  return `${day} ${time}`;
}
