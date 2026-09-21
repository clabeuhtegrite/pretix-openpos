import { useCallback, useEffect, useRef, useState } from "react";

import { api, isRetryable, type PositionPayload } from "./api";
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

  const apply = useCallback((payment: TerminalPayment) => {
    const money = { amount: payment.amount, currency: payment.currency };
    if (payment.status === "successful") {
      setState({ ...money, phase: "paid", message: null, stalled: false });
      onPaidRef.current(payment);
      return;
    }
    if (payment.status === "failed") {
      setState({
        ...money,
        phase: "failed",
        message: failureMessage(payment.failure),
        stalled: false,
      });
      return;
    }
    setState({ ...money, phase: "waiting", message: null, stalled: false });
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
      setState({ phase: "starting", amount: null, currency: null, message: null, stalled: false });
      try {
        apply(await api.terminalStart(pairing, { idempotency_key: key, positions }));
      } catch (err) {
        if (isRetryable(err)) {
          // The request may well have reached the reader — a lost answer and a
          // lost request look identical from here. Polling under the same key
          // finds out, and until it does the customer is asked for their card
          // rather than told of a failure that may not have happened.
          setState({
            phase: "waiting", amount: null, currency: null, message: null, stalled: true,
          });
          return;
        }
        setState({
          phase: "failed",
          amount: null,
          currency: null,
          message: describeError(err),
          stalled: false,
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
    try {
      apply(await api.terminalCancel(pairing, key));
    } catch (err) {
      if (isRetryable(err)) {
        // Same reasoning as above: not being able to ask is not an answer.
        setState((current) => (current ? { ...current, stalled: true } : current));
        return;
      }
      setState({
        phase: "failed", amount: null, currency: null, message: describeError(err), stalled: false,
      });
    }
  }, [pairing, apply]);

  /** Forget the attempt entirely — the panel is going back to its question. */
  const reset = useCallback(() => {
    keyRef.current = null;
    setState(null);
  }, []);

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
