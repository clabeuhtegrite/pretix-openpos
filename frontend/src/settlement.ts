import { fromCents } from "./money";
import type { PaymentType } from "./types";

/**
 * What actually changes hands at the payment panel.
 *
 * Pulled out of the panel because it is the arithmetic that decides how much
 * cash leaves the drawer, and that deserves tests rather than a re-read under
 * pressure with a customer waiting.
 *
 * Two figures are in play and they are not the same. The **order** is worth its
 * full total and is recorded as such: an order settled partly by a credit is
 * still an order for the whole amount, and the journal has to say so. What the
 * **operator** wants to know is the difference, in the direction it goes —
 * nobody counts 20 € back across the counter only to be handed 17 € straight
 * back.
 *
 * The credit comes from a sale cancelled in order to be corrected. It has
 * already been taken off the customer, so it funds the new order before any
 * cash does.
 */
export interface Settlement {
  /** Cash the customer still has to hand over, after the credit is applied. */
  dueCents: number;
  /** Money going back out to them, when the credit more than covers the order. */
  backCents: number;
  /** Change to count out, or null when nothing has been tendered yet. */
  changeCents: number | null;
  /** True when what was tendered does not cover what is due. */
  short: boolean;
  /**
   * What the server is told was received, or null when nothing was.
   *
   * The credit is included: the server subtracts the order's own total from it
   * and arrives at the same change the operator is about to count out, so the
   * journal reads as what happened — a refund applied to a new sale.
   */
  cashGiven: string | null;
}

export function settle({
  totalCents,
  creditCents = 0,
  tenderedCents = null,
  method,
}: {
  totalCents: number;
  creditCents?: number;
  /** Digits typed on the keypad, read as cents; null when the field is empty. */
  tenderedCents?: number | null;
  method: PaymentType;
}): Settlement {
  const net = totalCents - creditCents;
  const dueCents = Math.max(net, 0);
  const backCents = Math.max(-net, 0);

  if (method !== "cash") {
    // The terminal is where the money moves; there is no amount to record and
    // no change to count.
    return { dueCents, backCents, changeCents: null, short: false, cashGiven: null };
  }

  const changeCents = tenderedCents === null ? null : tenderedCents - dueCents;
  const short = changeCents !== null && changeCents < 0;

  let cashGiven: string | null;
  if (creditCents > 0) {
    // Funded by the credit plus whatever was handed over. An empty keypad with
    // a credit in play means the customer paid the difference exactly — which
    // is also the only sensible reading of "confirm" with nothing typed.
    cashGiven = fromCents(creditCents + (tenderedCents ?? dueCents));
  } else {
    cashGiven = tenderedCents === null ? null : fromCents(tenderedCents);
  }

  return { dueCents, backCents, changeCents, short, cashGiven };
}
