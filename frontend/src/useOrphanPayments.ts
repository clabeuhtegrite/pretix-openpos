import { useCallback, useEffect, useRef, useState } from "react";

import { api, isRefusal } from "./api";
import { dropOrphan, loadOrphans, updateOrphan } from "./storage";
import type { OrphanPayment, Pairing } from "./types";
import { READER_HELD_MS } from "./useTerminal";

/** How often the till asks about the reader payments it left aside, while there are any. */
export const ORPHAN_CHECK_MS = 20_000;

/**
 * How young a payment left aside has to be for the till to take it off the reader.
 *
 * Stopping a payment stops *the reader* — SumUp has no other way — so it is
 * only safe while nothing else can be on it. The server guarantees that for
 * ``READER_HELD_MS`` after a payment was put on a reader: any other payment
 * for it is refused as "busy" meanwhile. A minute short of that, for the
 * till's clock and the time the request takes. Past it the server clears the
 * reader itself before the next payment, and all that is left to do here is
 * find out how it ended.
 */
export const ORPHAN_CANCEL_WITHIN_MS = READER_HELD_MS - 60_000;

/**
 * How old a payment left aside must be before "no such payment" is believed.
 *
 * Younger, the start may still have been on its way to the server when the
 * question overtook it.
 */
export const ORPHAN_UNKNOWN_AFTER_MS = 60_000;

/** One question about one payment left aside, and whatever follows from the answer. */
async function check(pairing: Pairing, orphan: OrphanPayment, readerBusy: boolean): Promise<void> {
  // The event it was taken on, which may not be the one the till is on now.
  const where = { ...pairing, event: orphan.event };
  const age = Date.now() - new Date(orphan.at).getTime();
  try {
    let payment = await api.terminalStatus(where, orphan.key);
    if (
      payment.status === "pending" &&
      !orphan.cancelAsked &&
      // Never while this till has a payment of its own on the reader: that
      // is the one thing a stop could take off it by mistake.
      !readerBusy &&
      age < ORPHAN_CANCEL_WITHIN_MS
    ) {
      // Still on the reader, asking a customer who has long been served in
      // cash. Asked once: written down first, so a reload in between does
      // not ask a second time.
      updateOrphan(orphan.key, { cancelAsked: true });
      payment = await api.terminalCancel(where, orphan.key);
    }
    if (payment.status === "successful") {
      updateOrphan(orphan.key, { paid: true, amount: payment.amount, currency: payment.currency });
    } else if (payment.status === "failed") {
      // Declined, timed out, cancelled: nobody was charged, nothing to say.
      dropOrphan(orphan.key);
    }
  } catch (err) {
    // The server does not know the key: the start never reached it, and
    // nothing ever reached the reader.
    if (isRefusal(err) && age > ORPHAN_UNKNOWN_AFTER_MS) dropOrphan(orphan.key);
    // Anything else is a question that could not be answered; the next
    // round asks it again.
  }
}

/**
 * The reader payments this till left aside, followed up until they settle.
 *
 * A payment is left aside through the way out of a wait the server stopped
 * answering (see useTerminal): the cashier took the sale in cash with the
 * reader possibly still asking for a card. Once the server answers again,
 * each one is asked about — taken off the reader if it is still there and
 * still recent, forgotten if it failed, and, if the card went through after
 * all, kept and shown until somebody has read it: that customer has paid
 * twice, and the refund is made from the back office, where the payment is
 * listed among the card payments with no sale.
 *
 * `readerBusy` is whether this till has a payment of its own on the reader
 * right now.
 */
export function useOrphanPayments(pairing: Pairing | null, online: boolean, readerBusy: boolean) {
  const [orphans, setOrphans] = useState<OrphanPayment[]>(loadOrphans);
  const busyRef = useRef(readerBusy);
  busyRef.current = readerBusy;
  const runningRef = useRef(false);
  /**
   * Whether anything is still on screen to be told, as opposed to whether the
   * run of the effect that asked is: a round outlives the run that started
   * it whenever the network flickers mid-round — or, under StrictMode, on
   * every launch — and the run after it skips its own first round while that
   * one is still out. What that round learned is the screen's to show.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pairing || !online) return;
    let stopped = false;

    const round = async () => {
      if (runningRef.current) return;
      // Read from storage each time: the terminal writes a new one there the
      // moment the cashier takes the way out.
      const open = loadOrphans().filter((orphan) => !orphan.paid);
      if (!open.length) return;
      runningRef.current = true;
      try {
        // One question at a time, like every other conversation the till has
        // with the server about its reader.
        for (const orphan of open) {
          if (stopped) break;
          await check(pairing, orphan, busyRef.current);
        }
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setOrphans(loadOrphans());
      }
    };

    // At once — the network has just come back, or the till has just started
    // — and then every little while for as long as any are left.
    void round();
    const timer = window.setInterval(() => void round(), ORPHAN_CHECK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pairing, online]);

  /** Somebody has read the warning: the back office has the rest. */
  const acknowledge = useCallback((key: string) => {
    dropOrphan(key);
    setOrphans(loadOrphans());
  }, []);

  return { latePaid: orphans.filter((orphan) => orphan.paid), acknowledge };
}
