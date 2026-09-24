import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorCode, isRetryable, type PositionPayload } from "./api";
import { describeError } from "./errors";
import { t } from "./i18n";
import type { Pairing, TerminalPayment } from "./types";

/**
 * How often the till asks the server what the reader has done.
 *
 * The server is told as soon as SumUp calls back, so this is the fallback
 * rather than the mechanism — but it is the fallback that holds the whole
 * thing up on an installation SumUp cannot reach, which includes any pretix
 * that is not on a public HTTPS address. Two seconds is what a customer at a
 * counter reads as "immediately".
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

export interface TerminalState {
  /**
   * `starting` while the reader is being asked, `waiting` while the customer
   * has it in front of them, `paid` once the money has moved and `failed` when
   * it will not.
   */
  phase: "starting" | "waiting" | "paid" | "failed";
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
   * has not answered yet. Only ever true while `starting` or `waiting`.
   *
   * Set the moment the button is pressed, not when the server answers: asking
   * SumUp takes the server two or three seconds, and a panel that stayed
   * exactly as it was for that long read as a till that had not heard the tap.
   */
  cancelling: boolean;
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
 */
export function useTerminal(
  pairing: Pairing | null,
  onPaid: (payment: TerminalPayment) => void,
) {
  const [state, setState] = useState<TerminalState | null>(null);
  const keyRef = useRef<string | null>(null);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  /** The key of the payment a stop is being asked for, while it is being asked. */
  const cancelInFlightRef = useRef<string | null>(null);
  const cancelTimerRef = useRef<number | undefined>(undefined);

  const apply = useCallback((payment: TerminalPayment) => {
    const money = { amount: payment.amount, currency: payment.currency };
    if (payment.status === "successful") {
      setState({ ...money, phase: "paid", message: null, stalled: false, cancelling: false });
      onPaidRef.current(payment);
      return;
    }
    if (payment.status === "failed") {
      setState({
        ...money,
        phase: "failed",
        message: failureMessage(payment.failure),
        stalled: false,
        cancelling: false,
      });
      return;
    }
    // Still on the reader. A cancellation already asked for stays on screen:
    // "pending" is exactly what SumUp says in the moment before the reader
    // obeys, so it is no reason to go back to asking for a card.
    setState((current) => ({
      ...money,
      phase: "waiting",
      message: null,
      stalled: false,
      cancelling: current?.cancelling ?? false,
    }));
  }, []);

  /**
   * Put the basket on the reader under `key`, which the sale will carry too.
   *
   * A fresh key every time, minted by the caller: SumUp's reader checkout has
   * no idempotency of its own, so the key is what stops a second tap becoming
   * a second charge — and a *spent* key is what stops a retry after a refusal
   * from finding the refusal instead of starting again.
   */
  const start = useCallback(
    async (key: string, positions: PositionPayload[]) => {
      if (!pairing) return;
      keyRef.current = key;
      window.clearTimeout(cancelTimerRef.current);
      setState({
        phase: "starting", amount: null, currency: null, message: null, stalled: false,
        cancelling: false,
      });
      try {
        apply(await api.terminalStart(pairing, { idempotency_key: key, positions }));
      } catch (err) {
        // The reader is in the middle of somebody else's payment — two tills
        // behind one bar sharing one machine. Nothing was put on the reader
        // and nothing was charged, so this is a plain answer rather than an
        // unknown: the panel says so, the method toggle stays live, and the
        // sale goes through in cash or waits a moment.
        if (errorCode(err) === "terminal_busy") {
          setState({
            phase: "failed",
            amount: null,
            currency: null,
            message: t("payment.readerTaken"),
            stalled: false,
            cancelling: false,
          });
          return;
        }
        // ``terminal_unsure`` is the server saying the same thing about its own
        // leg: it could not get an answer out of SumUp, so the amount may be on
        // the reader with only the answer lost. It arrives as a 400 and is
        // emphatically not a refusal.
        if (isRetryable(err) || errorCode(err) === "terminal_unsure") {
          // The request may well have reached the reader — a lost answer and a
          // lost request look identical from here. Polling under the same key
          // finds out, and until it does the customer is asked for their card
          // rather than told of a failure that may not have happened.
          setState((current) => ({
            phase: "waiting", amount: null, currency: null, message: null, stalled: true,
            cancelling: current?.cancelling ?? false,
          }));
          return;
        }
        setState({
          phase: "failed",
          amount: null,
          currency: null,
          message: describeError(err),
          stalled: false,
          cancelling: false,
        });
      }
    },
    [pairing, apply],
  );

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
    if (cancelInFlightRef.current === key) return;
    cancelInFlightRef.current = key;
    window.clearTimeout(cancelTimerRef.current);
    setState((current) =>
      current && (current.phase === "starting" || current.phase === "waiting")
        ? { ...current, cancelling: true }
        : current,
    );
    try {
      const payment = await api.terminalCancel(pairing, key);
      // Answered after the attempt it was about was dropped or retried: a poll
      // got there first, and the screen belongs to another attempt now.
      if (keyRef.current !== key) return;
      apply(payment);
      if (payment.status !== "successful" && payment.status !== "failed") {
        cancelTimerRef.current = window.setTimeout(() => {
          setState((current) =>
            current?.cancelling ? { ...current, cancelling: false } : current,
          );
        }, TERMINAL_CANCEL_WAIT_MS);
      }
    } catch (err) {
      if (keyRef.current !== key) return;
      if (isRetryable(err)) {
        // Same reasoning as above: not being able to ask is not an answer. The
        // reader may well still have the basket, so the way to ask again goes
        // back on screen.
        setState((current) =>
          current ? { ...current, stalled: true, cancelling: false } : current,
        );
        return;
      }
      setState({
        phase: "failed", amount: null, currency: null, message: describeError(err), stalled: false,
        cancelling: false,
      });
    } finally {
      if (cancelInFlightRef.current === key) cancelInFlightRef.current = null;
    }
  }, [pairing, apply]);

  /** Forget the attempt entirely — the panel is going back to its question. */
  const reset = useCallback(() => {
    keyRef.current = null;
    window.clearTimeout(cancelTimerRef.current);
    setState(null);
  }, []);

  useEffect(() => () => window.clearTimeout(cancelTimerRef.current), []);

  const phase = state?.phase;
  useEffect(() => {
    if (!pairing || phase !== "waiting") return;
    const key = keyRef.current;
    if (!key) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api
        .terminalStatus(pairing, key)
        .then((payment) => {
          if (!cancelled) apply(payment);
        })
        .catch((err) => {
          if (cancelled) return;
          if (isRetryable(err)) {
            setState((current) => (current ? { ...current, stalled: true } : current));
            return;
          }
          // A refusal the server understood — no such payment, no reader on
          // this till any more. Those are answers, and they end the wait.
          setState({
            phase: "failed",
            amount: null,
            currency: null,
            message: describeError(err),
            stalled: false,
            cancelling: false,
          });
        });
    }, TERMINAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pairing, phase, apply]);

  return { state, start, cancel, reset };
}
