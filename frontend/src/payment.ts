import type { PositionPayload } from "./api";
import { fromCents, toCents } from "./money";
import type { CartLine, PendingPayment, QueuedSale, SaleResult } from "./types";

/**
 * The arithmetic of a sale, outside the component that rings it up.
 *
 * Pulled out of App because a payment can now be finished by something other
 * than the screen it was started on — a relaunch picking up a sale that was
 * on its way — and the two must build exactly the same request out of exactly
 * the same basket.
 */

/**
 * Three figures, and they are only the same one when no deposit comes back.
 * `total` is what changes hands; `soldCents` is what the order is worth, and
 * is what pretix is told about; `refundedCents` is what leaves the drawer.
 */
export function basketTotals(cart: CartLine[]) {
  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.count, 0);
  const soldCents = cart.reduce(
    (sum, line) => sum + (line.refund ? 0 : line.unitPrice * line.count),
    0,
  );
  return { total, soldCents, refundedCents: soldCents - total };
}

/**
 * The basket as the server wants it: products and quantities.
 *
 * The same statement whether it is going to the card reader or to the
 * checkout, which is what makes the card charge and the order agree — the
 * reader is sent exactly what the order will be built from.
 */
export function positionsOf(cart: CartLine[]): PositionPayload[] {
  return cart.map((line) => ({
    item: line.itemId,
    variation: line.variationId,
    count: line.count,
    // The two lines the server cannot price on its own: a free amount comes
    // with its figure and its reason, a returned deposit only says that it
    // is one.
    ...(line.description
      ? { price: fromCents(line.unitPrice), description: line.description }
      : {}),
    ...(line.refund ? { refund: true } : {}),
  }));
}

/** Whether a basket lets anybody in, by the event's admission products. */
export function admitsAnyone(cart: CartLine[], admissionItems: number[]): boolean {
  const admission = new Set(admissionItems);
  // A returned cup lets nobody in, whatever product it is booked against.
  return cart.some((line) => !line.refund && admission.has(line.itemId));
}

/**
 * A payment that cannot reach the server now, as the queue keeps it.
 *
 * Under the payment's own key: if the request it replaces did reach the
 * server before its answer was lost, the replay finds the sale that was made
 * instead of making a second one.
 */
export function queuedSaleOf(payment: PendingPayment): QueuedSale {
  const { total } = basketTotals(payment.cart);
  const positions = payment.cart.map((line) => ({
    item: line.itemId,
    variation: line.variationId,
    count: line.count,
    // What the customer was charged, from the tariff this till had cached.
    // The server compares it with its own on replay and reports any gap.
    // Negative on a deposit handed back, which is the same statement of
    // fact pointing the other way.
    price: fromCents(line.unitPrice),
    ...(line.description ? { description: line.description } : {}),
    ...(line.refund ? { refund: true } : {}),
  }));
  return {
    kind: "sale",
    id: payment.key,
    at: payment.at,
    event: payment.event,
    positions,
    // What the reader took, when one did: the server priced this basket when
    // it put it on the reader, and that is the figure the customer agreed
    // to. Without it the receipt and the sync panel read out this app's own
    // total, which is not what the card paid.
    chargedTotal: payment.charged ?? fromCents(total),
    // ...and the sum of the lines beside it, which is what the replay's
    // checksum is made of: the server builds a reader sale from the basket
    // it pinned, not from these lines, whose prices can be a refresh behind.
    ...(payment.charged !== null ? { linesTotal: fromCents(total) } : {}),
    paymentType: payment.paymentType,
    cashGiven: payment.cashGiven,
    cashChange:
      payment.cashGiven === null
        ? null
        : fromCents(Math.max(toCents(payment.cashGiven) - total, 0)),
    cashier: payment.cashier,
    admits: payment.admits,
    label: payment.cart.map((line) => `${line.count}× ${line.label}`).join(", "),
  };
}

/**
 * A queued sale shaped like a server answer, so every screen downstream stays
 * unchanged; what it does not have is an order code, because no order exists
 * yet.
 */
export function queuedResultOf(entry: QueuedSale, cart: CartLine[]): SaleResult {
  const { soldCents, refundedCents } = basketTotals(cart);
  return {
    order: { code: "", total: fromCents(Math.max(soldCents, 0)) },
    journal_seq: 0,
    payment_type: entry.paymentType,
    cash_given: entry.cashGiven,
    cash_change: entry.cashChange,
    datetime: entry.at,
    replayed: false,
    // Nobody has been checked in server-side; the replay will do it. The
    // basket still decides whether a person walks in, which is what the
    // screen is about to say.
    checked_in: entry.admits ? 1 : 0,
    checkin_errors: [],
    offline: true,
    deposit_refund: refundedCents > 0 ? fromCents(refundedCents) : null,
    net_total: entry.chargedTotal,
  };
}
