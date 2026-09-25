import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    terminalStart: vi.fn(),
    terminalStatus: vi.fn(),
    terminalCancel: vi.fn(),
  },
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: apiMock };
});

import { ApiError } from "./api";
import { moment } from "./drawer";
import { describeError } from "./errors";
import { t } from "./i18n";
import { formatMoney } from "./money";
import { addOrphan, loadOrphans } from "./storage";
import type { Pairing } from "./types";
import {
  failureMessage, TERMINAL_CANCEL_WAIT_MS, TERMINAL_POLL_MS, TERMINAL_UNANSWERED_MS, useTerminal,
} from "./useTerminal";

const pairing: Pairing = {
  token: "tok", organizer: "org", event: "ev", serial: "TILL1", deviceName: "Caisse bar",
};

/** The basket's own figure, which a payment left aside unanswered is remembered by. */
const basket = { amount: "12.00", currency: "EUR" };

function payment(status: "pending" | "successful" | "failed", failure = "") {
  return { status, amount: "12.34", currency: "EUR", failure };
}

/** A refusal as the server sends one: a 400 with its reasons. */
function refusal(detail: string, code?: string) {
  return new ApiError(400, detail, { detail: [detail], ...(code ? { code } : {}) });
}

/** The server's answer to a stop it did not send: the reader has moved on. */
function movedOn(status: "pending" | "successful" | "failed", failure = "") {
  const detail = "This payment is no longer the one on the card reader, so the reader was left alone.";
  return new ApiError(400, detail, {
    detail: [detail], code: "reader_moved_on", ...payment(status, failure), sumup_unreachable: false,
  });
}

/** A request whose answer the test hands over when it chooses to. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Let the next poll leave, and whatever it starts resolve. */
async function poll() {
  await act(async () => {
    vi.advanceTimersByTime(TERMINAL_POLL_MS);
  });
}

/** Let time pass with the reader on screen. */
async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.terminalStart.mockReset();
  apiMock.terminalStatus.mockReset();
  apiMock.terminalCancel.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("putting a basket on the reader", () => {
  it("waits for the cardholder once the reader has it", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [{ item: 1, variation: null, count: 1 }], basket);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.key).toBe("key-1");
    expect(result.current.state?.amount).toBe("12.34");
    expect(apiMock.terminalStart).toHaveBeenCalledWith(pairing, {
      idempotency_key: "key-1",
      positions: [{ item: 1, variation: null, count: 1 }],
    });
  });

  it("hands the payment and its key to its caller the moment the money moves", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStart.mockResolvedValue(payment("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(onPaid).toHaveBeenCalledWith(payment("successful"), "key-1");
    expect(result.current.state?.phase).toBe("paid");
  });

  it("goes on waiting when it cannot tell whether the reader was asked", async () => {
    // A lost answer and a lost request look identical from a tablet. The card
    // may be being charged right now, so the one thing that must not happen
    // here is a refusal on screen: it goes on asking instead.
    apiMock.terminalStart.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
  });

  it("treats the server not reaching SumUp as a payment still running", async () => {
    apiMock.terminalStart.mockRejectedValue(refusal("SumUp did not answer.", "terminal_unsure"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
  });

  it("says the reader is on the other till, and stops there", async () => {
    // Two tablets behind one bar sharing one machine. Nothing was put on the
    // reader and nothing was charged, so this is a plain answer rather than
    // the unknown above — and the cashier needs the one sentence that tells
    // them cash still works.
    apiMock.terminalStart.mockRejectedValue(
      refusal("The card reader is taking another payment.", "terminal_busy"),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.stalled).toBe(false);
    expect(result.current.state?.message).toBe(t("payment.readerTaken"));
  });

  it("names this till's own payment left aside when that is what holds the reader", async () => {
    // After the way out of an unanswered wait, "the other till" would send
    // the cashier looking for a colleague who does not exist.
    const at = new Date(Date.now() - 60_000).toISOString();
    addOrphan({ event: "ev", key: "old", at, amount: "8.00", currency: "EUR" });
    apiMock.terminalStart.mockRejectedValue(refusal("Busy.", "terminal_busy"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.message).toBe(
      t("payment.readerHeldHere", { amount: formatMoney(800, "EUR"), time: moment(at) }),
    );
  });

  it("stops on a refusal the server understood", async () => {
    apiMock.terminalStart.mockRejectedValue(
      refusal("Nothing is due on this basket. Settle it in cash."),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(
      "Nothing is due on this basket. Settle it in cash.",
    );
  });

  it("takes a rate limit on the start as nothing started, said the till's way", async () => {
    // A 429 is answered before anything is done: nothing is on the reader,
    // and the next press is a fresh try.
    const limited = new ApiError(429, "HTTP 429", null, 5000);
    apiMock.terminalStart.mockRejectedValue(limited);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(describeError(limited));
  });

  it("drops a start answer that lands after the attempt was forgotten", async () => {
    // The panel was closed while the basket was on its way: what comes back
    // describes an attempt that is no longer on screen.
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });

    act(() => {
      result.current.reset();
    });
    await act(async () => started.resolve(payment("pending")));

    expect(result.current.state).toBeNull();
    await wait(TERMINAL_POLL_MS * 3);
    expect(apiMock.terminalStatus).not.toHaveBeenCalled();
  });
});

describe("while the customer has the reader", () => {
  async function waiting(onPaid = vi.fn()) {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const hook = renderHook(() => useTerminal(pairing, onPaid));
    await act(async () => {
      await hook.result.current.start("key-1", [], basket);
    });
    return hook;
  }

  it("asks the server what happened, under the same key", async () => {
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    const { result } = await waiting();

    await poll();

    expect(apiMock.terminalStatus).toHaveBeenCalledWith(pairing, "key-1", expect.any(AbortSignal));
    expect(result.current.state?.phase).toBe("waiting");
  });

  it("records the payment as soon as the server says it went through", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStatus.mockResolvedValue(payment("successful"));
    const { result } = await waiting(onPaid);

    await poll();

    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(result.current.state?.phase).toBe("paid");
  });

  it("stops asking once it has an answer", async () => {
    apiMock.terminalStatus.mockResolvedValue(payment("failed", "FAILED"));
    const { result } = await waiting();

    await poll();
    await poll();

    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(t("payment.readerRefused"));
  });

  it("gives up when the server says there is no such payment", async () => {
    // A reader taken off this till mid-sale, or a payment that never existed.
    // Those are answers rather than silence, and they end the wait.
    apiMock.terminalStatus.mockRejectedValue(
      refusal("No card reader is assigned to this till.", "no_terminal"),
    );
    const { result } = await waiting();

    await poll();

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe("No card reader is assigned to this till.");
  });

  it("keeps waiting, and says so, while it cannot reach the server", async () => {
    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    const { result } = await waiting();

    await poll();

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);

    // And recovers when the server comes back, rather than needing a retry.
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    await poll();

    expect(result.current.state?.stalled).toBe(false);
  });

  it.each([401, 403, 404])("keeps waiting on a %i, which says nothing about the reader", async (status) => {
    // The device refused, or an address gone: the payment on the reader goes
    // on regardless. Ending the wait here used to hand the cashier the cash
    // button with the customer's card still being asked for.
    apiMock.terminalStatus.mockRejectedValue(new ApiError(status, `HTTP ${status}`, { detail: "no" }));
    const { result } = await waiting();

    await poll();

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
  });

  it("keeps waiting on a rate limit, and asks again only when the server said", async () => {
    apiMock.terminalStatus.mockRejectedValue(new ApiError(429, "HTTP 429", null, 10_000));
    const { result } = await waiting();

    await poll();
    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(false);

    await wait(9_000);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
    await wait(1_000);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(2);
  });
});

describe("the polls, one after the other", () => {
  async function waiting(onPaid = vi.fn()) {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const hook = renderHook(() => useTerminal(pairing, onPaid));
    await act(async () => {
      await hook.result.current.start("key-1", [], basket);
    });
    return hook;
  }

  it("never sends a question while the last one is unanswered", async () => {
    // SumUp slow, the server slower: this used to put a new request on the
    // wire every two seconds regardless, seven in flight after fourteen.
    apiMock.terminalStatus.mockReturnValue(new Promise(() => {}));
    await waiting();

    await wait(TERMINAL_POLL_MS * 7);

    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
  });

  it("asks again two seconds after the answer, not after the question", async () => {
    const slow = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStatus.mockReturnValueOnce(slow.promise).mockResolvedValue(payment("pending"));
    await waiting();

    await poll();
    await wait(5_000);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);

    await act(async () => slow.resolve(payment("pending")));
    await wait(TERMINAL_POLL_MS - 1);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(2);
  });

  it("stops the moment the panel lets go, and aborts what is in flight", async () => {
    let signal: AbortSignal | undefined;
    apiMock.terminalStatus.mockImplementation((_p: Pairing, _key: string, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const { result } = await waiting();
    await poll();

    act(() => {
      result.current.reset();
    });
    await wait(TERMINAL_POLL_MS * 5);

    expect(signal?.aborted).toBe(true);
    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
  });

  it("stops when the hook goes away altogether", async () => {
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    const { unmount } = await waiting();
    await poll();

    unmount();
    await wait(TERMINAL_POLL_MS * 5);

    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(1);
  });

  it("records the sale once when a poll and a stop both come back paid", async () => {
    // The card tapped as the cashier pressed stop: the poll and the answer to
    // the stop say "paid" back to back, before React has drawn the first.
    // That recorded the same card sale twice.
    const onPaid = vi.fn();
    const polled = deferred<ReturnType<typeof payment>>();
    const stopped = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStatus.mockReturnValue(polled.promise);
    apiMock.terminalCancel.mockReturnValue(stopped.promise);
    const { result } = await waiting(onPaid);
    await poll();
    act(() => {
      void result.current.cancel();
    });

    await act(async () => {
      polled.resolve(payment("successful"));
      stopped.resolve(payment("successful"));
    });

    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(result.current.state?.phase).toBe("paid");
  });

  it("records it once however many answers say so, across renders", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStatus.mockResolvedValue(payment("successful"));
    apiMock.terminalCancel.mockResolvedValue(payment("successful"));
    const { result, rerender } = await waiting(onPaid);

    await poll();
    rerender();
    await act(async () => {
      await result.current.cancel();
    });

    expect(onPaid).toHaveBeenCalledTimes(1);
  });
});

describe("taking the basket back off the reader", () => {
  it("reports what actually happened, not what was asked for", async () => {
    // A card tapped in the same second is a payment, and the operator has to
    // be told that instead of a cancellation that did not take place.
    const onPaid = vi.fn();
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockResolvedValue(payment("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(result.current.state?.phase).toBe("paid");
  });

  it("goes on waiting when the server cannot be reached", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
    // The stop was never asked, so the way to ask it goes back on screen.
    expect(result.current.state?.cancelling).toBe(false);
  });

  it("gives the stop back with a word when the server asks for a moment", async () => {
    const limited = new ApiError(429, "HTTP 429", null, null);
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(limited);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(false);
    expect(result.current.state?.stalled).toBe(false);
    expect(result.current.state?.notice).toBe(describeError(limited));
  });

  it("stops on a refusal the server understood", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(
      refusal("No card payment was started for this basket.", "no_payment"),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(
      "No card payment was started for this basket.",
    );
  });

  it("offers the way out for good when the reader has moved on", async () => {
    // The reader is somebody else's now, or this payment held it past its
    // five minutes: the server left it alone, and nothing on this till can
    // finish the payment. Waiting, never failed — SumUp has not said it did.
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(movedOn("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state).toMatchObject({
      phase: "waiting", cancelling: false, stalled: false, unanswered: true, unansweredBy: "reader",
    });
    // The polls go on, and an answer that the payment is still open does not
    // take the way out away.
    await poll();
    expect(apiMock.terminalStatus).toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ unanswered: true, unansweredBy: "reader" });
  });

  it("writes a payment the reader moved on from down on the way out", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(movedOn("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });
    await act(async () => {
      await result.current.cancel();
    });

    act(() => {
      result.current.abandon();
    });

    expect(loadOrphans()).toEqual([expect.objectContaining({ key: "key-1", amount: "12.34" })]);
    expect(result.current.state).toBeNull();
  });

  it("records the sale when the reader had moved on after the card went through", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(movedOn("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(onPaid).toHaveBeenCalledOnce();
    expect(onPaid).toHaveBeenCalledWith(expect.objectContaining({ status: "successful" }), "key-1");
    expect(result.current.state?.phase).toBe("paid");
  });

  it("says how it ended when the reader had moved on and the payment was over", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(movedOn("failed", "TIMED_OUT"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(failureMessage("TIMED_OUT"));
  });

  it("starts the next payment with nothing of the one the reader moved on from", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(movedOn("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });
    await act(async () => {
      await result.current.cancel();
    });
    act(() => {
      result.current.abandon();
    });

    await act(async () => {
      await result.current.start("key-2", [], basket);
    });
    await poll();

    expect(result.current.state).toMatchObject({
      key: "key-2", phase: "waiting", unanswered: false, unansweredBy: undefined,
    });
  });

  it("does nothing at all when no payment was ever started", async () => {
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.cancel();
    });

    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});

describe("while a stop is on its way", () => {
  // SumUp stops a reader asynchronously: the server asks, reads the payment
  // back, and answers two or three seconds later that it is still pending.
  // The poll after that finds it cancelled. None of that may look like a tap
  // that did not register.
  async function waiting() {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const hook = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await hook.result.current.start("key-1", [], basket);
    });
    return hook;
  }

  it("says so the moment it is pressed, before the server has answered", async () => {
    const { result } = await waiting();
    const answer = deferred<ReturnType<typeof payment>>();
    apiMock.terminalCancel.mockReturnValue(answer.promise);

    act(() => {
      void result.current.cancel();
    });

    expect(result.current.state?.cancelling).toBe(true);
    expect(result.current.state?.phase).toBe("waiting");
    await act(async () => answer.resolve(payment("failed", "CANCELLED")));
    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.cancelling).toBe(false);
    expect(result.current.state?.message).toBe(t("payment.readerCancelled"));
  });

  it("goes on saying so while the reader has not obeyed yet, until a poll finds it stopped", async () => {
    const { result } = await waiting();
    apiMock.terminalCancel.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));

    await act(async () => {
      await result.current.cancel();
    });
    await poll();

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(true);

    apiMock.terminalStatus.mockResolvedValue(payment("failed", "CANCELLED"));
    await poll();

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.cancelling).toBe(false);
  });

  it("asks the server once, however many times it is pressed", async () => {
    const { result } = await waiting();
    const answer = deferred<ReturnType<typeof payment>>();
    apiMock.terminalCancel.mockReturnValue(answer.promise);

    act(() => {
      void result.current.cancel();
      void result.current.cancel();
    });
    act(() => {
      void result.current.cancel();
    });

    expect(apiMock.terminalCancel).toHaveBeenCalledTimes(1);
    await act(async () => answer.resolve(payment("failed", "CANCELLED")));
  });

  it("gives the stop back once the reader has plainly not obeyed", async () => {
    // A customer halfway through their PIN, or a request lost between the
    // server and SumUp. The reader is still waiting, and saying "cancelling"
    // for ever would leave the cashier no way of asking again.
    const { result } = await waiting();
    apiMock.terminalCancel.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));

    await act(async () => {
      await result.current.cancel();
    });
    await wait(TERMINAL_CANCEL_WAIT_MS);

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(false);

    // And asking again asks again.
    await act(async () => {
      await result.current.cancel();
    });
    expect(apiMock.terminalCancel).toHaveBeenCalledTimes(2);
  });

  it("leaves a finished payment alone when that wait runs out", async () => {
    const { result } = await waiting();
    apiMock.terminalCancel.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("failed", "CANCELLED"));

    await act(async () => {
      await result.current.cancel();
    });
    await poll();
    const ended = result.current.state;
    await wait(TERMINAL_CANCEL_WAIT_MS);

    expect(result.current.state).toBe(ended);
    expect(result.current.state?.phase).toBe("failed");
  });

  it("holds a stop pressed while the basket is on its way until the reader has it", async () => {
    // Sent at once, the stop could reach the server first, be told there was
    // nothing to stop, and hand the cashier the cash button — while the start
    // landed a second later and put the basket on the reader after all.
    apiMock.terminalCancel.mockResolvedValue(payment("pending"));
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.cancelling).toBe(true);
    expect(apiMock.terminalCancel).not.toHaveBeenCalled();

    await act(async () => started.resolve(payment("pending")));

    expect(apiMock.terminalCancel).toHaveBeenCalledTimes(1);
    expect(apiMock.terminalCancel).toHaveBeenCalledWith(pairing, "key-1");
    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(true);
  });

  it("sends no stop at all when the start comes back already settled", async () => {
    const onPaid = vi.fn();
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, onPaid));
    act(() => {
      void result.current.start("key-1", [], basket);
    });
    act(() => {
      void result.current.cancel();
    });

    await act(async () => started.resolve(payment("successful")));

    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("sends the stop after a start whose answer was lost", async () => {
    // The start may or may not have reached the reader: the stop goes, and
    // the server says which.
    apiMock.terminalCancel.mockResolvedValue(payment("failed", "CANCELLED"));
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });
    act(() => {
      void result.current.cancel();
    });

    await act(async () => started.reject(new ApiError(0, "network")));

    expect(apiMock.terminalCancel).toHaveBeenCalledTimes(1);
    expect(result.current.state?.phase).toBe("failed");
  });

  it("drops the stop along with a start the server refused", async () => {
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });
    act(() => {
      void result.current.cancel();
    });

    await act(async () => started.reject(refusal("Sold out.", "sold_out")));

    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    expect(result.current.state?.phase).toBe("failed");
  });

  it("drops an answer that comes back after the attempt was forgotten", async () => {
    const { result } = await waiting();
    const answer = deferred<ReturnType<typeof payment>>();
    apiMock.terminalCancel.mockReturnValue(answer.promise);
    act(() => {
      void result.current.cancel();
    });

    act(() => {
      result.current.reset();
    });
    await act(async () => answer.resolve(payment("pending")));

    expect(result.current.state).toBeNull();
  });

  it("drops a failure that comes back after the attempt was forgotten, too", async () => {
    const { result } = await waiting();
    const answer = deferred<ReturnType<typeof payment>>();
    apiMock.terminalCancel.mockReturnValue(answer.promise);
    act(() => {
      void result.current.cancel();
    });

    act(() => {
      result.current.reset();
    });
    await act(async () => answer.reject(refusal("No card payment was started.")));

    expect(result.current.state).toBeNull();
  });

  it("starts a new attempt with nothing being stopped", async () => {
    const { result } = await waiting();
    apiMock.terminalCancel.mockResolvedValue(payment("failed", "CANCELLED"));
    await act(async () => {
      await result.current.cancel();
    });

    await act(async () => {
      await result.current.start("key-2", [], basket);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.key).toBe("key-2");
    expect(result.current.state?.cancelling).toBe(false);
  });
});

describe("when the server stops answering", () => {
  it("offers the way out once it has said nothing for a while", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await wait(TERMINAL_UNANSWERED_MS - 2000);
    expect(result.current.state?.unanswered).toBe(false);
    await wait(3000);

    expect(result.current.state?.unanswered).toBe(true);
    expect(result.current.state?.phase).toBe("waiting");
  });

  it("offers it too when the start itself never comes back", async () => {
    apiMock.terminalStart.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });

    await wait(TERMINAL_UNANSWERED_MS + 1000);

    expect(result.current.state?.phase).toBe("starting");
    expect(result.current.state?.unanswered).toBe(true);
  });

  it("does not offer it while the server keeps answering, however long the customer takes", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await wait(TERMINAL_UNANSWERED_MS * 3);

    expect(result.current.state?.unanswered).toBe(false);
  });

  it("takes it back the moment the server answers again", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });
    await wait(TERMINAL_UNANSWERED_MS + 1000);
    expect(result.current.state?.unanswered).toBe(true);

    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    await poll();

    expect(result.current.state?.unanswered).toBe(false);
    expect(result.current.state?.stalled).toBe(false);
  });

  it("offers it when the server answers but could not ask SumUp, and says so", async () => {
    // "Pending" from the server's row, because SumUp was out of reach: no
    // news of the payment, so no reason to keep the cashier waiting on it
    // for ever.
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue({ ...payment("pending"), sumup_unreachable: true });
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    await wait(TERMINAL_UNANSWERED_MS - 2000);
    expect(result.current.state).toMatchObject({ unanswered: false, unansweredBy: "sumup" });
    await wait(3000);

    expect(result.current.state).toMatchObject({
      phase: "waiting", stalled: false, unanswered: true, unansweredBy: "sumup",
    });

    // SumUp answers again: the way out goes, and so do the words about it.
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    await poll();
    expect(result.current.state).toMatchObject({ unanswered: false, unansweredBy: undefined });
  });

  it("says it is the server again once the server itself goes quiet", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalStatus.mockResolvedValue({ ...payment("pending"), sumup_unreachable: true });
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });
    await poll();
    expect(result.current.state?.unansweredBy).toBe("sumup");

    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    await poll();

    expect(result.current.state).toMatchObject({ stalled: true, unansweredBy: undefined });
  });

  it("asks again under the same key and the same basket", async () => {
    const positions = [{ item: 4, variation: null, count: 2 }];
    apiMock.terminalStart.mockRejectedValueOnce(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", positions, basket);
    });
    const again = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(again.promise);

    act(() => {
      result.current.retry();
    });
    expect(result.current.state?.asking).toBe(true);
    await act(async () => again.resolve(payment("pending")));

    expect(apiMock.terminalStart).toHaveBeenLastCalledWith(pairing, {
      idempotency_key: "key-1",
      positions,
    });
    expect(result.current.state?.asking).toBe(false);
    expect(result.current.state?.phase).toBe("waiting");
  });

  it("has nothing to ask again about with no payment on screen", () => {
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    act(() => {
      result.current.retry();
    });

    expect(apiMock.terminalStart).not.toHaveBeenCalled();
  });
});

describe("leaving a payment behind", () => {
  it("keeps a payment the reader may still have, to be asked about later", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    act(() => {
      result.current.abandon();
    });

    expect(result.current.state).toBeNull();
    expect(loadOrphans()).toEqual([
      expect.objectContaining({ event: "ev", key: "key-1", amount: "12.34", currency: "EUR" }),
    ]);
  });

  it("remembers it by the basket's figure when the server never priced it", async () => {
    apiMock.terminalStart.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", [], basket);
    });

    act(() => {
      result.current.abandon();
    });

    expect(loadOrphans()).toEqual([
      expect.objectContaining({ key: "key-1", amount: "12.00", currency: "EUR" }),
    ]);
  });

  it("keeps nothing for a payment that has ended", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("failed", "FAILED"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    act(() => {
      result.current.reset();
    });

    expect(loadOrphans()).toEqual([]);
  });
});

describe("picking up a payment after a reload", () => {
  it("asks the server where it has got to before saying anything", async () => {
    const answer = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStatus.mockReturnValue(answer.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    act(() => {
      void result.current.resume("key-1", [], basket, new Date().toISOString());
    });
    expect(result.current.state?.phase).toBe("checking");
    expect(apiMock.terminalStart).not.toHaveBeenCalled();

    await act(async () => answer.resolve(payment("pending")));
    expect(result.current.state?.phase).toBe("waiting");
    expect(apiMock.terminalStatus).toHaveBeenCalledWith(pairing, "key-1");
  });

  it("records the sale when the customer paid while the till was away", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStatus.mockResolvedValue(payment("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(onPaid).toHaveBeenCalledWith(payment("successful"), "key-1");
  });

  it("says so when the payment ended while the till was away", async () => {
    apiMock.terminalStatus.mockResolvedValue(payment("failed", "TIMEOUT"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(t("payment.readerTimeout"));
  });

  it("takes the server not knowing the key as nothing having reached the reader", async () => {
    apiMock.terminalStatus.mockRejectedValue(
      refusal("No card payment was started for this basket.", "no_payment"),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(result.current.state?.phase).toBe("failed");
  });

  it("offers the way out at once when the server cannot be asked", async () => {
    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
    expect(result.current.state?.unanswered).toBe(true);
  });

  it("does not, for a server that only asked to wait", async () => {
    apiMock.terminalStatus.mockRejectedValue(new ApiError(429, "HTTP 429"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(result.current.state?.unanswered).toBe(false);
  });

  it("shows a payment already known to be paid, and leaves the recording to its caller", async () => {
    const onPaid = vi.fn();
    apiMock.terminalCancel.mockResolvedValue(payment("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));

    await act(async () => {
      await result.current.resume(
        "key-1", [], basket, new Date().toISOString(), payment("successful"),
      );
    });

    expect(result.current.state?.phase).toBe("paid");
    expect(apiMock.terminalStatus).not.toHaveBeenCalled();
    // A later answer saying the same is not a second payment either.
    await act(async () => {
      await result.current.cancel();
    });
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("remembers when a payment it leaves behind was started, not when it was picked up", async () => {
    apiMock.terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await act(async () => {
      await result.current.resume("key-1", [], basket, at);
    });

    act(() => {
      result.current.abandon();
    });

    expect(loadOrphans()).toEqual([expect.objectContaining({ key: "key-1", at })]);
  });

  it("asks nothing without a paired till", async () => {
    const { result } = renderHook(() => useTerminal(null, vi.fn()));

    await act(async () => {
      await result.current.resume("key-1", [], basket, new Date().toISOString());
    });

    expect(apiMock.terminalStatus).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});

describe("forgetting an attempt", () => {
  it("clears the state and the key with it", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state).toBeNull();
    // Nothing left to cancel: the attempt is gone, not merely off screen.
    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
  });
});

describe("what the operator is told about a refusal", () => {
  it("turns the statuses that reach a counter into sentences", () => {
    expect(failureMessage("CANCELLED")).toBe(t("payment.readerCancelled"));
    expect(failureMessage("failed")).toBe(t("payment.readerRefused"));
    expect(failureMessage("TIMEOUT")).toBe(t("payment.readerTimeout"));
    expect(failureMessage("")).toBe(t("payment.readerRefused"));
  });

  it("passes anything else through rather than inventing a reason", () => {
    expect(failureMessage("SumUp refused the API key.")).toBe("SumUp refused the API key.");
  });
});

describe("without a paired till", () => {
  it("has nothing to ask, and asks nothing", async () => {
    const { result } = renderHook(() => useTerminal(null, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", [], basket);
    });

    expect(apiMock.terminalStart).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});
