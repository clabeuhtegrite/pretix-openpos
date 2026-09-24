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
import { t } from "./i18n";
import type { Pairing } from "./types";
import {
  failureMessage, TERMINAL_CANCEL_WAIT_MS, TERMINAL_POLL_MS, useTerminal,
} from "./useTerminal";

const pairing: Pairing = {
  token: "tok", organizer: "org", event: "ev", serial: "TILL1", deviceName: "Caisse bar",
};

function payment(status: "pending" | "successful" | "failed", failure = "") {
  return { status, amount: "12.34", currency: "EUR", failure };
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

/** Let the interval fire once, and the promise it starts resolve. */
async function poll() {
  await act(async () => {
    vi.advanceTimersByTime(TERMINAL_POLL_MS);
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
      await result.current.start("key-1", [{ item: 1, variation: null, count: 1 }]);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.amount).toBe("12.34");
    expect(apiMock.terminalStart).toHaveBeenCalledWith(pairing, {
      idempotency_key: "key-1",
      positions: [{ item: 1, variation: null, count: 1 }],
    });
  });

  it("hands the payment to its caller the moment the money moves", async () => {
    const onPaid = vi.fn();
    apiMock.terminalStart.mockResolvedValue(payment("successful"));
    const { result } = renderHook(() => useTerminal(pairing, onPaid));

    await act(async () => {
      await result.current.start("key-1", []);
    });

    expect(onPaid).toHaveBeenCalledWith(payment("successful"));
    expect(result.current.state?.phase).toBe("paid");
  });

  it("goes on waiting when it cannot tell whether the reader was asked", async () => {
    // A lost answer and a lost request look identical from a tablet. The card
    // may be being charged right now, so the one thing that must not happen
    // here is a refusal on screen: it goes on asking instead.
    apiMock.terminalStart.mockRejectedValue(new ApiError(0, "network"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", []);
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
      new ApiError(400, "The card reader is taking another payment.", {
        code: "terminal_busy",
      }),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", []);
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.stalled).toBe(false);
    expect(result.current.state?.message).toBe(t("payment.readerTaken"));
  });

  it("stops on a refusal the server understood", async () => {
    apiMock.terminalStart.mockRejectedValue(
      new ApiError(400, "Nothing is due on this basket. Settle it in cash."),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));

    await act(async () => {
      await result.current.start("key-1", []);
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(
      "Nothing is due on this basket. Settle it in cash.",
    );
  });
});

describe("while the customer has the reader", () => {
  async function waiting(onPaid = vi.fn()) {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const hook = renderHook(() => useTerminal(pairing, onPaid));
    await act(async () => {
      await hook.result.current.start("key-1", []);
    });
    return hook;
  }

  it("asks the server what happened, under the same key", async () => {
    apiMock.terminalStatus.mockResolvedValue(payment("pending"));
    const { result } = await waiting();

    await poll();

    expect(apiMock.terminalStatus).toHaveBeenCalledWith(pairing, "key-1");
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
      new ApiError(400, "No card reader is assigned to this till."),
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
      await result.current.start("key-1", []);
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
      await result.current.start("key-1", []);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.stalled).toBe(true);
    // The stop was never asked, so the way to ask it goes back on screen.
    expect(result.current.state?.cancelling).toBe(false);
  });

  it("stops on a refusal the server understood", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    apiMock.terminalCancel.mockRejectedValue(
      new ApiError(400, "No card payment was started for this basket."),
    );
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", []);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state?.phase).toBe("failed");
    expect(result.current.state?.message).toBe(
      "No card payment was started for this basket.",
    );
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
      await hook.result.current.start("key-1", []);
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
    await act(async () => {
      vi.advanceTimersByTime(TERMINAL_CANCEL_WAIT_MS);
    });

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
    await act(async () => {
      vi.advanceTimersByTime(TERMINAL_CANCEL_WAIT_MS);
    });

    expect(result.current.state).toBe(ended);
    expect(result.current.state?.phase).toBe("failed");
  });

  it("keeps a stop pressed while the basket was still on its way to the reader", async () => {
    apiMock.terminalCancel.mockResolvedValue(payment("pending"));
    const started = deferred<ReturnType<typeof payment>>();
    apiMock.terminalStart.mockReturnValue(started.promise);
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    act(() => {
      void result.current.start("key-1", []);
    });

    await act(async () => {
      await result.current.cancel();
    });
    await act(async () => started.resolve(payment("pending")));

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(true);
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
    await act(async () => answer.reject(new ApiError(400, "No card payment was started.")));

    expect(result.current.state).toBeNull();
  });

  it("starts a new attempt with nothing being stopped", async () => {
    const { result } = await waiting();
    apiMock.terminalCancel.mockResolvedValue(payment("failed", "CANCELLED"));
    await act(async () => {
      await result.current.cancel();
    });

    await act(async () => {
      await result.current.start("key-2", []);
    });

    expect(result.current.state?.phase).toBe("waiting");
    expect(result.current.state?.cancelling).toBe(false);
  });
});

describe("forgetting an attempt", () => {
  it("clears the state and the key with it", async () => {
    apiMock.terminalStart.mockResolvedValue(payment("pending"));
    const { result } = renderHook(() => useTerminal(pairing, vi.fn()));
    await act(async () => {
      await result.current.start("key-1", []);
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
      await result.current.start("key-1", []);
    });

    expect(apiMock.terminalStart).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});
