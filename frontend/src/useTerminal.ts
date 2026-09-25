import { useCallback, useEffect, useRef, useState } from "react";

import {
  api, ApiError, errorCode, isRefusal, isRetryable, isThrottled, type PositionPayload,
} from "./api";
import { moment } from "./drawer";
import { describeError } from "./errors";
import { t } from "./i18n";
import { formatMoney, toCents } from "./money";
import { addOrphan, loadOrphans } from "./storage";
import type { Pairing, TerminalPayment } from "./types";

/**
 * How long the till waits between two questions to the server about the reader.
 *
 * The server is told as soon as SumUp calls back, so this is the fallback
 * rather than the mechanism — but it is the fallback that holds the whole
 * thing up on an installation SumUp cannot reach, which includes any pretix
 * that is not on a public HTTPS address. Two seconds is what a customer at a
 * counter reads as "immediately".
 *
 * Counted from the previous answer, not from the previous question: a status
 * request that takes four seconds — the server asking SumUp, SumUp being slow
 * — used to have the next two leave behind it, and a till could end up with a
 * handful in flight at once, each a request to SumUp on the server's side.
 */
export const TERMINAL_POLL_MS = 2000;

/**
 * How long a cancellation stays on screen once the server has said the reader
 * still has the basket.
 *
 * SumUp stops a reader asynchronously and confirms nothing, so the answer to
 * the cancel itself usually still reads "pending", and it is the next poll
 * that finds the payment cancelled, a second or two later. Past this the
 * reader has evidently not obeyed (a customer halfway through their PIN, a
 * request lost between the server and SumUp), and the screen goes back to
 * saying what is true: the reader is still waiting, and stopping it can be
 * asked again.
 */
export const TERMINAL_CANCEL_WAIT_MS = 10_000;

/**
 * How long the till goes without a word from the server before it offers a
 * way out of the wait.
 *
 * Until then the rule stands that a payment the till cannot see is a payment
 * still running: it must never announce a refusal for a card that was in fact
 * charged. But a till that holds to that forever holds a customer at the
 * counter for as long as the venue's network stays down, with no button that
 * does anything. Past this, the cashier is told to look at the reader itself
 * — the one screen that does know — and given the choice: wait, ask again, or
 * take the sale in cash.
 */
export const TERMINAL_UNANSWERED_MS = 15_000;

/**
 * How long the server keeps a reader for a payment still waiting on it.
 *
 * The server's own ``READER_HELD_FOR``: within it, a second payment on the
 * same reader is refused as "busy" rather than put over the first. It is what
 * makes it safe to take a payment left aside off the reader afterwards — see
 * useOrphanPayments — and what this till reads a "busy" answer against.
 */
export const READER_HELD_MS = 5 * 60_000;

/** The phases in which the reader may still have the basket, as far as this till knows. */
const UNSETTLED: ReadonlySet<TerminalState["phase"]> = new Set(["starting", "checking", "waiting"]);

export interface TerminalState {
  /** The payment this is about: its idempotency key, which the sale will carry too. */
  key: string;
  /**
   * `starting` while the reader is being asked, `checking` while the till
   * asks how a payment it was interrupted in has got on, `waiting` while the
   * customer has it in front of them, `paid` once the money has moved and
   * `failed` when it will not.
   */
  phase: "starting" | "checking" | "waiting" | "paid" | "failed";
  /** What the server priced and put on the reader. */
  amount: string | null;
  currency: string | null;
  /** Why it did not go through. Only ever set on `failed`. */
  message: string | null;
  /**
   * The till cannot reach the server for the moment.
   *
   * Which says nothing about the payment: the reader answers to SumUp, not to
   * this browser. So the wait goes on and the screen says so, because the one
   * thing that must never happen here is a till announcing a refusal for a
   * card that was in fact charged.
   */
  stalled: boolean;
  /**
   * The cashier has asked for the basket back off the reader, and the reader
   * has not answered yet. Only ever true while the payment is unsettled.
   *
   * Set the moment the button is pressed, not when the server answers: asking
   * SumUp takes the server two or three seconds, and a panel that stayed
   * exactly as it was for that long read as a till that had not heard the tap.
   */
  cancelling: boolean;
  /**
   * Nothing has been heard from the server about this payment for
   * ``TERMINAL_UNANSWERED_MS``: the panel offers the way out.
   */
  unanswered: boolean;
  /**
   * Who went quiet, when it was not the server itself: ``"sumup"`` while the
   * server answers but could not ask SumUp, ``"reader"`` once the reader has
   * moved on and nothing on this till can finish the payment any more. Only
   * the words of the way out change with it.
   */
  unansweredBy?: "sumup" | "reader";
  /** "Try again" has been pressed, and its question is on its way. */
  asking: boolean;
  /** Something to say beside the wait that is not a failure: a stop the server asked to delay. */
  notice: string | null;
}

/** A basket's own figure, until the server has priced it: for a payment left aside unanswered. */
export interface ReaderFallback {
  amount: string;
  currency: string;
}

/**
 * Turn what the server recorded into something a cashier can read out.
 *
 * `failure` is SumUp's own word for how the transaction ended, kept raw in the
 * journal because that is what a support call will ask for. The handful that
 * actually reach a counter get a sentence; anything else is shown as it came,
 * which beats inventing a reason.
 */
export function failureMessage(failure: string): string {
  switch (failure.trim().toUpperCase()) {
    case "":
    case "FAILED":
      return t("payment.readerRefused");
    case "CANCELLED":
    case "CANCEL_FAILED":
      return t("payment.readerCancelled");
    case "TIMEOUT":
    case "TIMED_OUT":
      return t("payment.readerTimeout");
    default:
      return failure.trim();
  }
}

/**
 * What a "busy" answer means, which is not always what it says.
 *
 * The server refuses a payment on a reader that is still holding another one,
 * and says the other till has it. After the way out of an unanswered wait,
 * the payment holding the reader is quite likely this till's own, left aside a
 * minute ago — and "the other till" would send the cashier looking for a
 * colleague who does not exist.
 */
function busyMessage(event: string): string {
  const held = loadOrphans().find(
    (orphan) =>
      orphan.event === event &&
      !orphan.paid &&
      Date.now() - new Date(orphan.at).getTime() < READER_HELD_MS,
  );
  if (!held) return t("payment.readerTaken");
  return t("payment.readerHeldHere", {
    amount: formatMoney(toCents(held.amount), held.currency),
    time: moment(held.at),
  });
}

/**
 * Driving the card reader this till was given, and nothing else.
 *
 * The app cannot see the reader: it is driven through SumUp's cloud and
 * answers to the server. So this is a conversation with pretix about a machine
 * on the counter — put this basket on it, has anyone paid yet, take it back
 * off — and every screen the cashier sees is built from those answers.
 *
 * `onPaid` fires exactly once per payment, and it is what lets the sale be
 * recorded: the server will refuse a card sale on this till that no reader
 * payment stands behind, so nothing reaches the journal before this point. It
 * is handed the payment rather than left to read it off the state below,
 * because it fires in the same breath as the state is set — a caller reading
 * `state` there would still see the moment before the money moved.
 *
 * "Exactly once" is kept here, by key, and not left to the renders: two
 * answers saying "paid" can land back to back — a poll and the answer to a
 * stop pressed as the card was tapped — and the second used to record the
 * sale a second time before React had drawn the first.
 */
export function useTerminal(
  pairing: Pairing | null,
  onPaid: (payment: TerminalPayment, key: string) => void,
) {
  const [state, setState] = useState<TerminalState | null>(null);
  /** The latest state, for the callbacks that have to decide on it synchronously. */
  const stateRef = useRef(state);
  stateRef.current = state;
  const keyRef = useRef<string | null>(null);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  /** Every key onPaid has been called for. A set, not a flag: it outlives the attempt. */
  const paidKeysRef = useRef(new Set<string>());
  /** What the basket was put on the reader as, for asking again and for leaving it aside. */
  const attemptRef = useRef<{ positions: PositionPayload[]; fallback: ReaderFallback; at: string } | null>(
    null,
  );
  /** When the server last said anything about the payment on screen. */
  const heardAtRef = useRef(0);
  /** The key a start request is on its way for. */
  const startInFlightRef = useRef<string | null>(null);
  /** A stop pressed while the start was still on its way, to be sent once it lands. */
  const stopWantedRef = useRef<string | null>(null);
  /** The key of the payment a stop is being asked for, while it is being asked. */
  const cancelInFlightRef = useRef<string | null>(null);
  const cancelTimerRef = useRef<number | undefined>(undefined);
  /** The payment the reader has moved on from, if the one on screen is it — see sendCancel. */
  const movedOnRef = useRef<string | null>(null);

  /** Change the state of the payment `key`, and of no other. */
  const patch = useCallback((key: string, changes: Partial<TerminalState>) => {
    setState((current) => (current && current.key === key ? { ...current, ...changes } : current));
  }, []);

  const heard = useCallback(() => {
    heardAtRef.current = Date.now();
  }, []);

  const fail = useCallback(
    (key: string, message: string) => {
      patch(key, {
        phase: "failed", message, stalled: false, cancelling: false, unanswered: false, notice: null,
      });
    },
    [patch],
  );

  const apply = useCallback(
    (key: string, payment: TerminalPayment) => {
      // An answer about an attempt the till has moved on from: a start that
      // landed after the panel was closed, a poll overtaken by a retry. It
      // describes something that is no longer on screen.
      if (keyRef.current !== key) return;
      if (payment.status === "pending" && movedOnRef.current === key) {
        // Still open by SumUp's account, and no longer on the reader: an
        // answer, so heard, but not one that takes the way out away — nothing
        // on this till can finish this payment now.
        heard();
        patch(key, {
          amount: payment.amount, currency: payment.currency, phase: "waiting", message: null,
          stalled: false, cancelling: false, unanswered: true, unansweredBy: "reader",
        });
        return;
      }
      if (payment.status === "pending" && payment.sumup_unreachable) {
        // The server answered from what it last knew, because SumUp could not
        // be asked. That is no news of the payment, so it is not counted as
        // any: held long enough, the way out comes on as it would for a
        // server gone quiet, worded for SumUp.
        patch(key, {
          amount: payment.amount, currency: payment.currency, phase: "waiting", message: null,
          stalled: false, unansweredBy: "sumup",
        });
        return;
      }
      heard();
      const settled = {
        amount: payment.amount, currency: payment.currency, stalled: false, unanswered: false,
        unansweredBy: undefined, notice: null,
      };
      if (payment.status === "successful") {
        patch(key, { ...settled, phase: "paid", message: null, cancelling: false });
        if (!paidKeysRef.current.has(key)) {
          paidKeysRef.current.add(key);
          onPaidRef.current(payment, key);
        }
        return;
      }
      if (payment.status === "failed") {
        patch(key, {
          ...settled, phase: "failed", message: failureMessage(payment.failure), cancelling: false,
        });
        return;
      }
      // Still on the reader. A cancellation already asked for stays on screen:
      // "pending" is exactly what SumUp says in the moment before the reader
      // obeys, so it is no reason to go back to asking for a card.
      patch(key, { ...settled, phase: "waiting", message: null });
    },
    [heard, patch],
  );

  /**
   * Leave the payment on screen behind, for good.
   *
   * When the reader may still have it — nothing the server said has settled
   * it — it is written down to be asked about later rather than forgotten:
   * see useOrphanPayments. That only ever happens through the way out of an
   * unanswered wait; everywhere else the panel will not let go of a live
   * payment in the first place.
   */
  const reset = useCallback(() => {
    const current = stateRef.current;
    const attempt = attemptRef.current;
    if (pairing && current && attempt && UNSETTLED.has(current.phase) && current.key === keyRef.current) {
      addOrphan({
        event: pairing.event,
        key: current.key,
        at: attempt.at,
        amount: current.amount ?? attempt.fallback.amount,
        currency: current.currency ?? attempt.fallback.currency,
      });
    }
    keyRef.current = null;
    attemptRef.current = null;
    stopWantedRef.current = null;
    movedOnRef.current = null;
    window.clearTimeout(cancelTimerRef.current);
    stateRef.current = null;
    setState(null);
  }, [pairing]);

  const sendCancel = useCallback(
    async (key: string) => {
      if (!pairing) return;
      cancelInFlightRef.current = key;
      try {
        const payment = await api.terminalCancel(pairing, key);
        // Answered after the attempt it was about was dropped or retried: a
        // poll got there first, and the screen belongs to another attempt now.
        if (keyRef.current !== key) return;
        apply(key, payment);
        if (payment.status !== "successful" && payment.status !== "failed") {
          window.clearTimeout(cancelTimerRef.current);
          cancelTimerRef.current = window.setTimeout(() => {
            setState((current) =>
              current?.key === key && current.cancelling ? { ...current, cancelling: false } : current,
            );
          }, TERMINAL_CANCEL_WAIT_MS);
        }
      } catch (err) {
        if (keyRef.current !== key) return;
        if (errorCode(err) === "reader_moved_on") {
          // The reader has gone on to another payment — this till's next
          // customer, or the other till's — or this one has held it past its
          // five minutes, and the server left the reader alone rather than
          // stop somebody else's payment. The answer still says how this one
          // stands: charged, over, or open with nothing here able to finish
          // it, which is the way out — the payment is written down on the way
          // and followed up, in case the card goes through after all.
          window.clearTimeout(cancelTimerRef.current);
          movedOnRef.current = key;
          apply(key, (err as ApiError).body as TerminalPayment);
          return;
        }
        if (isRefusal(err)) {
          // No such payment, no reader on this till any more: answers, and
          // they end the wait.
          heard();
          fail(key, describeError(err));
          return;
        }
        if (isThrottled(err)) {
          // Nothing was asked of the reader. Said, and the stop goes back
          // under the cashier's thumb to be pressed again in a moment.
          patch(key, { cancelling: false, notice: describeError(err) });
          return;
        }
        // Not being able to ask is not an answer. The reader may well still
        // have the basket, so the way to ask again goes back on screen.
        patch(key, { stalled: true, cancelling: false });
      } finally {
        if (cancelInFlightRef.current === key) cancelInFlightRef.current = null;
      }
    },
    [pairing, apply, heard, fail, patch],
  );

  /** Send the basket to the reader under `key` — the first time, or again. */
  const ask = useCallback(
    async (key: string, positions: PositionPayload[]) => {
      if (!pairing) return;
      startInFlightRef.current = key;
      try {
        const payment = await api.terminalStart(pairing, { idempotency_key: key, positions });
        if (keyRef.current !== key) return;
        apply(key, payment);
        if (stopWantedRef.current === key) {
          stopWantedRef.current = null;
          // Stop was pressed while the basket was on its way. It is sent now
          // that the server has the payment, and not before: sent earlier, it
          // could reach the server first, be told there was nothing to stop,
          // and hand the cashier the cash button while the start landed a
          // second later and put the basket on the reader after all.
          if (payment.status === "pending") void sendCancel(key);
        }
      } catch (err) {
        if (keyRef.current !== key) return;
        // The reader is in the middle of somebody else's payment — two tills
        // behind one bar sharing one machine. Nothing was put on the reader
        // and nothing was charged, so this is a plain answer rather than an
        // unknown: the panel says so, the method toggle stays live, and the
        // sale goes through in cash or waits a moment.
        if (errorCode(err) === "terminal_busy") {
          heard();
          stopWantedRef.current = null;
          fail(key, busyMessage(pairing.event));
          return;
        }
        // ``terminal_unsure`` is the server saying the same thing about its own
        // leg: it could not get an answer out of SumUp, so the amount may be on
        // the reader with only the answer lost. It arrives as a 400 and is
        // emphatically not a refusal.
        const unsure = errorCode(err) === "terminal_unsure";
        if (isRetryable(err) || unsure) {
          // The request may well have reached the reader — a lost answer and a
          // lost request look identical from here. Polling under the same key
          // finds out, and until it does the customer is asked for their card
          // rather than told of a failure that may not have happened.
          if (unsure) {
            // The server itself did answer, though: it is SumUp it lost.
            heard();
            patch(key, { phase: "waiting", stalled: true, unanswered: false });
          } else {
            patch(key, { phase: "waiting", stalled: true });
          }
          if (stopWantedRef.current === key) {
            stopWantedRef.current = null;
            void sendCancel(key);
          }
          return;
        }
        // Anything else was answered before the reader was asked: a refusal
        // of the basket, of the device, or a "not now" (429). Nothing is on
        // the reader, and the next try is a fresh one.
        heard();
        stopWantedRef.current = null;
        fail(key, describeError(err));
      } finally {
        if (startInFlightRef.current === key) startInFlightRef.current = null;
        patch(key, { asking: false });
      }
    },
    [pairing, apply, heard, fail, patch, sendCancel],
  );

  /**
   * Put the basket on the reader under `key`, which the sale will carry too.
   *
   * A fresh key every time, minted by the caller: SumUp's reader checkout has
   * no idempotency of its own, so the key is what stops a second tap becoming
   * a second charge — and a *spent* key is what stops a retry after a refusal
   * from finding the refusal instead of starting again.
   */
  const start = useCallback(
    async (key: string, positions: PositionPayload[], fallback: ReaderFallback) => {
      if (!pairing) return;
      // Never reached from the panel, which will not start one payment over
      // another; kept safe all the same.
      if (keyRef.current !== null && keyRef.current !== key) reset();
      keyRef.current = key;
      attemptRef.current = { positions, fallback, at: new Date().toISOString() };
      stopWantedRef.current = null;
      movedOnRef.current = null;
      window.clearTimeout(cancelTimerRef.current);
      heard();
      const next: TerminalState = {
        key, phase: "starting", amount: null, currency: null, message: null, stalled: false,
        cancelling: false, unanswered: false, asking: false, notice: null,
      };
      stateRef.current = next;
      setState(next);
      await ask(key, positions);
    },
    [pairing, ask, heard, reset],
  );

  /**
   * Pick up a payment the till was interrupted in: a reload, a crash, iOS
   * reclaiming the app while the customer stood at the reader.
   *
   * The server is asked where it has got to rather than the reader being
   * asked again: a new request would be a new charge if the key were a new
   * one, and there is no knowing from here whether the customer has paid.
   * With `paid`, the till already knows the money moved — only the sale is
   * left to record, and that is the caller's to do: `onPaid` is not called.
   */
  const resume = useCallback(
    async (
      key: string,
      positions: PositionPayload[],
      fallback: ReaderFallback,
      at: string,
      paid?: TerminalPayment,
    ) => {
      if (!pairing) return;
      keyRef.current = key;
      attemptRef.current = { positions, fallback, at };
      stopWantedRef.current = null;
      movedOnRef.current = null;
      window.clearTimeout(cancelTimerRef.current);
      heard();
      const base: TerminalState = {
        key, phase: "checking", amount: null, currency: null, message: null, stalled: false,
        cancelling: false, unanswered: false, asking: false, notice: null,
      };
      if (paid) {
        paidKeysRef.current.add(key);
        const next: TerminalState = {
          ...base, phase: "paid", amount: paid.amount, currency: paid.currency,
        };
        stateRef.current = next;
        setState(next);
        return;
      }
      stateRef.current = base;
      setState(base);
      try {
        const payment = await api.terminalStatus(pairing, key);
        apply(key, payment);
      } catch (err) {
        if (keyRef.current !== key) return;
        if (isRefusal(err)) {
          // No payment under this key: the start never reached the server,
          // so nothing ever reached the reader either.
          heard();
          fail(key, describeError(err));
          return;
        }
        // Could not ask. Nobody knows when the server was last heard from —
        // the till was not running — so the way out is offered at once,
        // while the polls go on trying.
        patch(key, { phase: "waiting", stalled: true, unanswered: !isThrottled(err) });
      }
    },
    [pairing, apply, heard, fail, patch],
  );

  /**
   * Ask again about the payment on screen, under the same key.
   *
   * A start is what is sent, whatever the till last knew: the server answers
   * a key it already holds with how that payment stands, and one it never
   * received by putting the basket on the reader — which covers a start that
   * was lost on its way and one whose answer was, without having to know
   * which of the two happened.
   */
  const retry = useCallback(() => {
    const key = keyRef.current;
    const attempt = attemptRef.current;
    if (!pairing || !key || !attempt) return;
    patch(key, { asking: true, notice: null });
    void ask(key, attempt.positions);
  }, [pairing, ask, patch]);

  /**
   * Take the amount back off the reader.
   *
   * Best-effort, and what comes back is what actually happened rather than
   * what was asked for: a card tapped in the same second is a payment, and the
   * cashier has to be told that instead of a cancellation that did not occur.
   */
  const cancel = useCallback(async () => {
    const key = keyRef.current;
    if (!pairing || !key) {
      setState(null);
      return;
    }
    // One request at a time. A second tap while the first is on its way would
    // only ask SumUp the same thing twice.
    if (cancelInFlightRef.current === key || stopWantedRef.current === key) return;
    window.clearTimeout(cancelTimerRef.current);
    patch(key, { cancelling: true, notice: null });
    if (startInFlightRef.current === key) {
      // Held until the start has landed — see `ask`.
      stopWantedRef.current = key;
      return;
    }
    await sendCancel(key);
  }, [pairing, patch, sendCancel]);

  useEffect(() => () => window.clearTimeout(cancelTimerRef.current), []);

  /**
   * The polls, one after the other.
   *
   * Each question leaves two seconds after the previous one was answered —
   * or failed — and never while one is still out; the whole chain stops the
   * moment the payment is settled or the panel goes, and whatever is still
   * in flight then is aborted rather than left to answer nobody.
   */
  const pollKey = state?.phase === "waiting" ? state.key : null;
  useEffect(() => {
    if (!pairing || !pollKey) return;
    const key = pollKey;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const next = (delay: number) => {
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      controller = new AbortController();
      try {
        const payment = await api.terminalStatus(pairing, key, controller.signal);
        if (stopped) return;
        apply(key, payment);
        if (payment.status === "pending") next(TERMINAL_POLL_MS);
      } catch (err) {
        if (stopped) return;
        if (isRefusal(err)) {
          // A refusal the server understood — no such payment, no reader on
          // this till any more. Those are answers, and they end the wait.
          heard();
          fail(key, describeError(err));
          return;
        }
        if (isThrottled(err)) {
          // Asked too often. Nothing is known that was not known before;
          // the next question waits as long as the server asked.
          next(Math.max(TERMINAL_POLL_MS, (err as ApiError).retryAfterMs ?? 0));
          return;
        }
        // Anything else — no network, a fault, the device refused — is a
        // question that could not be answered. The reader carries on
        // regardless, and so does the wait. It is the server that has gone
        // quiet now, whatever it last said about SumUp.
        patch(key, { stalled: true, ...(movedOnRef.current === key ? {} : { unansweredBy: undefined }) });
        next(TERMINAL_POLL_MS);
      }
    };

    next(TERMINAL_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      (controller as AbortController | null)?.abort();
    };
  }, [pairing, pollKey, apply, heard, fail, patch]);

  /**
   * The watch on the server's silence.
   *
   * Every answer about the payment resets it; ``TERMINAL_UNANSWERED_MS``
   * without one turns the way out on, and the next answer turns it off
   * again, because then the till knows again how the payment stands.
   */
  const watchKey = state && UNSETTLED.has(state.phase) ? state.key : null;
  useEffect(() => {
    if (!watchKey) return;
    const timer = window.setInterval(() => {
      if (Date.now() - heardAtRef.current < TERMINAL_UNANSWERED_MS) return;
      setState((current) =>
        current?.key === watchKey && UNSETTLED.has(current.phase) && !current.unanswered
          ? { ...current, unanswered: true }
          : current,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [watchKey]);

  return { state, start, resume, retry, cancel, reset, abandon: reset };
}
