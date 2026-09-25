import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { terminalStatus, terminalCancel } = vi.hoisted(() => ({
  terminalStatus: vi.fn(),
  terminalCancel: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, terminalStatus, terminalCancel } };
});

import { ApiError } from "./api";
import { addOrphan, loadOrphans } from "./storage";
import type { OrphanPayment, Pairing, TerminalPayment } from "./types";
import {
  ORPHAN_CANCEL_WITHIN_MS, ORPHAN_CHECK_MS, ORPHAN_UNKNOWN_AFTER_MS, useOrphanPayments,
} from "./useOrphanPayments";

/**
 * The reader payments a till left aside when the server stopped answering.
 *
 * The cashier took the sale in cash; the reader may still have been asking
 * for a card. What is pinned here is what the till does about each of them
 * once it can ask again: take it off the reader while that is safe, forget it
 * when nobody was charged, and say so — until somebody has read it — when
 * the customer was charged after all.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};

function reader(status: TerminalPayment["status"], failure = ""): TerminalPayment {
  return { status, amount: "4.50", currency: "EUR", failure };
}

function aside(key: string, ageMs: number, over: Partial<OrphanPayment> = {}): OrphanPayment {
  return {
    event: "festival", key, at: new Date(Date.now() - ageMs).toISOString(), amount: "4.00",
    currency: "EUR", ...over,
  };
}

function follow(online = true, readerBusy = false) {
  return renderHook(
    (props: { online: boolean; readerBusy: boolean }) =>
      useOrphanPayments(pairing, props.online, props.readerBusy),
    { initialProps: { online, readerBusy } },
  );
}

beforeEach(() => {
  terminalStatus.mockResolvedValue(reader("pending"));
  terminalCancel.mockResolvedValue(reader("failed", "CANCELLED"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a payment still on the reader", () => {
  it("is taken off it while that is safe, and forgotten once it has failed", async () => {
    addOrphan(aside("k-1", 60_000));
    follow();

    await waitFor(() => expect(loadOrphans()).toEqual([]));
    expect(terminalStatus).toHaveBeenCalledWith(pairing, "k-1");
    expect(terminalCancel).toHaveBeenCalledWith(pairing, "k-1");
  });

  it("is taken off once only, even across a reload", async () => {
    // The stop is written down before it is asked: SumUp confirms nothing,
    // and a second one could only ever stop somebody else's payment.
    terminalCancel.mockResolvedValue(reader("pending"));
    addOrphan(aside("k-1", 60_000));
    const first = follow();
    await waitFor(() => expect(terminalCancel).toHaveBeenCalledOnce());
    await waitFor(() => expect(loadOrphans()[0].cancelAsked).toBe(true));
    first.unmount();

    follow();

    await waitFor(() => expect(terminalStatus).toHaveBeenCalledTimes(2));
    expect(terminalCancel).toHaveBeenCalledOnce();
  });

  it("is left on the reader while this till has a payment of its own on it", async () => {
    addOrphan(aside("k-1", 60_000));
    follow(true, true);

    await waitFor(() => expect(terminalStatus).toHaveBeenCalled());
    expect(terminalCancel).not.toHaveBeenCalled();
    expect(loadOrphans()).toHaveLength(1);
  });

  it("is left on the reader past the time the server holds it", async () => {
    // Past it, the server clears the reader itself before the next payment,
    // and a stop could only reach whatever is on it now.
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    follow();

    await waitFor(() => expect(terminalStatus).toHaveBeenCalled());
    expect(terminalCancel).not.toHaveBeenCalled();
  });

  it("is asked about again every little while, for as long as it is there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    follow();
    await waitFor(() => expect(terminalStatus).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORPHAN_CHECK_MS);
    });

    expect(terminalStatus).toHaveBeenCalledTimes(2);
  });

  it("is asked about on the event it was taken on", async () => {
    addOrphan(aside("k-1", 60_000, { event: "gala" }));
    follow();

    await waitFor(() => expect(terminalStatus).toHaveBeenCalled());
    expect(terminalStatus.mock.calls[0][0]).toEqual({ ...pairing, event: "gala" });
  });
});

describe("a payment that went through after all", () => {
  it("is kept, with what the reader took, until somebody has read it", async () => {
    terminalStatus.mockResolvedValue(reader("successful"));
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    const { result } = follow();

    await waitFor(() => expect(result.current.latePaid).toHaveLength(1));
    expect(result.current.latePaid[0]).toMatchObject({ key: "k-1", paid: true, amount: "4.50" });

    act(() => result.current.acknowledge("k-1"));

    expect(result.current.latePaid).toEqual([]);
    expect(loadOrphans()).toEqual([]);
  });

  it("is found by the stop itself when the card was tapped in the meantime", async () => {
    terminalCancel.mockResolvedValue(reader("successful"));
    addOrphan(aside("k-1", 60_000));
    const { result } = follow();

    await waitFor(() => expect(result.current.latePaid).toHaveLength(1));
  });

  it("is not asked about again once known", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    terminalStatus.mockResolvedValue(reader("successful"));
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    const { result } = follow();
    await waitFor(() => expect(result.current.latePaid).toHaveLength(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * ORPHAN_CHECK_MS);
    });

    expect(terminalStatus).toHaveBeenCalledOnce();
  });
});

describe("a question that gets no answer", () => {
  it("is not asked while the till has no network", async () => {
    addOrphan(aside("k-1", 60_000));
    const { rerender } = follow(false);

    await act(async () => {});
    expect(terminalStatus).not.toHaveBeenCalled();

    rerender({ online: true, readerBusy: false });

    await waitFor(() => expect(terminalStatus).toHaveBeenCalledOnce());
  });

  it("keeps the payment when the server could not be reached", async () => {
    terminalStatus.mockRejectedValue(new ApiError(0, "network"));
    addOrphan(aside("k-1", 60_000));
    follow();

    await waitFor(() => expect(terminalStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(loadOrphans()).toHaveLength(1);
  });

  it("forgets a payment the server never heard of, once the start cannot still be on its way", async () => {
    terminalStatus.mockRejectedValue(
      new ApiError(400, "No card payment was started for this basket.", { code: "no_payment" }),
    );
    addOrphan(aside("k-old", ORPHAN_UNKNOWN_AFTER_MS + 1000));
    addOrphan(aside("k-young", 5_000));
    follow();

    await waitFor(() => expect(loadOrphans().map((kept) => kept.key)).toEqual(["k-young"]));
  });

  it("asks one question at a time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: (value: TerminalPayment) => void = () => {};
    terminalStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    follow();
    await waitFor(() => expect(terminalStatus).toHaveBeenCalledOnce());

    // A round comes due while the first question is still out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORPHAN_CHECK_MS);
    });

    expect(terminalStatus).toHaveBeenCalledOnce();
    await act(async () => answer(reader("failed")));
    await waitFor(() => expect(loadOrphans()).toEqual([]));
  });

  it("is dropped, answered or not, once the till has moved on", async () => {
    let answer: (value: TerminalPayment) => void = () => {};
    terminalStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    addOrphan(aside("k-1", ORPHAN_CANCEL_WITHIN_MS + 1000));
    addOrphan(aside("k-2", ORPHAN_CANCEL_WITHIN_MS + 1000));
    const { unmount } = follow();
    await waitFor(() => expect(terminalStatus).toHaveBeenCalledOnce());

    unmount();
    await act(async () => answer(reader("failed")));

    // The first answer is still written down; the second question is never asked.
    expect(terminalStatus).toHaveBeenCalledOnce();
    expect(loadOrphans().map((kept) => kept.key)).toEqual(["k-2"]);
  });
});
