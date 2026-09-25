import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deviceStatusCall } = vi.hoisted(() => ({ deviceStatusCall: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, deviceStatus: deviceStatusCall } };
});

import { ApiError } from "./api";
import { saveLastSync, saveQueue } from "./storage";
import type { Pairing, QueuedCheckin, QueuedSale } from "./types";
import { STATUS_EVERY_MS, STATUS_SETTLE_MS, deviceStatus, useDeviceStatus } from "./useDeviceStatus";

/**
 * What the back office is told about the sales this device holds.
 *
 * A sale rung up with no network exists on one tablet and nowhere else until
 * it is sent, and this is how somebody at the back office finds out which
 * tablet to walk over to before closing. What is pinned here is what is said
 * and when — and that saying it never gets in the cashier's way.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};

function sale(id: string, at: string): QueuedSale {
  return {
    kind: "sale", id, at, event: "festival",
    positions: [{ item: 10, variation: null, count: 1, price: "4.00" }],
    chargedTotal: "4.00", paymentType: "cash", cashGiven: "5.00", cashChange: "1.00",
    cashier: "Ana", admits: false, label: "1× Bière",
  };
}

const scan: QueuedCheckin = {
  kind: "checkin", id: "c", at: "2026-08-16T20:00:00.000Z", event: "festival", list: 7,
  secret: "abc", name: "Alice",
};

function report(online = true, pending = 0) {
  return renderHook(
    (props: { online: boolean; pending: number }) => useDeviceStatus(pairing, props.online, props.pending),
    { initialProps: { online, pending } },
  );
}

beforeEach(() => {
  deviceStatusCall.mockResolvedValue({ server_time: new Date().toISOString() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what is said", () => {
  it("counts the sales waiting, dates the oldest, and names the build", () => {
    saveQueue([
      sale("b", "2026-08-16T22:30:00.000Z"),
      scan,
      sale("a", "2026-08-16T21:00:00.000Z"),
    ]);
    saveLastSync("2026-08-16T20:45:00.000Z");

    expect(deviceStatus()).toEqual({
      // Scans are the door's business, and a scan is not money.
      pending_sales: 2,
      oldest_pending_at: "2026-08-16T21:00:00.000Z",
      last_sync_at: "2026-08-16T20:45:00.000Z",
      version: __APP_VERSION__,
    });
  });

  it("says plainly when nothing is waiting", () => {
    expect(deviceStatus()).toEqual({
      pending_sales: 0, oldest_pending_at: null, last_sync_at: null, version: __APP_VERSION__,
    });
  });
});

describe("when it is said", () => {
  it("at once when the till opens with a network", async () => {
    saveQueue([sale("a", "2026-08-16T21:00:00.000Z")]);
    report();

    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());
    expect(deviceStatusCall).toHaveBeenCalledWith(pairing, expect.objectContaining({ pending_sales: 1 }));
  });

  it("not while there is no network, and at once when it is back", async () => {
    const { rerender } = report(false);
    await act(async () => {});
    expect(deviceStatusCall).not.toHaveBeenCalled();

    rerender({ online: true, pending: 0 });

    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());
  });

  it("every minute for as long as the network stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    report();
    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * STATUS_EVERY_MS);
    });

    expect(deviceStatusCall).toHaveBeenCalledTimes(3);
  });

  it("once the queue has settled, rather than at every sale a drain sends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = report(true, 5);
    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());

    for (const pending of [4, 3, 2, 1, 0]) {
      rerender({ online: true, pending });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_SETTLE_MS / 4);
      });
    }
    expect(deviceStatusCall).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_SETTLE_MS);
    });

    expect(deviceStatusCall).toHaveBeenCalledTimes(2);
  });

  it("not for a queue that moved while there was no network", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = report(false, 0);

    rerender({ online: false, pending: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_SETTLE_MS + 100);
    });

    expect(deviceStatusCall).not.toHaveBeenCalled();
  });

  it("not twice at once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: (value: unknown) => void = () => {};
    deviceStatusCall.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { rerender } = report(true, 0);
    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());

    rerender({ online: true, pending: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_SETTLE_MS + 100);
    });

    expect(deviceStatusCall).toHaveBeenCalledOnce();
    await act(async () => answer({ server_time: new Date().toISOString() }));
  });
});

describe("when it cannot be said", () => {
  it("is tried again at the next occasion, and nothing else happens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    deviceStatusCall.mockRejectedValueOnce(new ApiError(429, "Too many requests."));
    report();
    await waitFor(() => expect(deviceStatusCall).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS);
    });

    expect(deviceStatusCall).toHaveBeenCalledTimes(2);
  });

  it("is not tried by a device that is not paired", async () => {
    renderHook(() => useDeviceStatus(null, true, 3));
    await act(async () => {});

    expect(deviceStatusCall).not.toHaveBeenCalled();
  });
});
