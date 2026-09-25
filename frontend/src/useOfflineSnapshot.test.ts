import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { offlineSnapshot } = vi.hoisted(() => ({ offlineSnapshot: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, offlineSnapshot } };
});

import { ApiError } from "./api";
import { loadSnapshot, loadSnapshotPull, saveSnapshot, saveSnapshotPull } from "./storage";
import type { OfflineSnapshot, Pairing } from "./types";
import { SNAPSHOT_MIN_GAP_MS, SNAPSHOT_REFRESH_MS, useOfflineSnapshot } from "./useOfflineSnapshot";

/**
 * The guest list a till carries for a dropout.
 *
 * What is pinned here is when it is fetched and when it is not: the screens
 * that use it have their own tests for what they do with it.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Porte",
};

function guestList(id: number): OfflineSnapshot {
  return {
    list: { id, name: `Liste ${id}` },
    generated: "2026-08-16T20:00:00.000Z",
    tickets: [],
    truncated: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  offlineSnapshot.mockImplementation(async (_pairing: Pairing, listId: number) => guestList(listId));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the guest list carried for a dropout", () => {
  it("is pulled at once, and kept on the device", async () => {
    const { result } = renderHook(() => useOfflineSnapshot(pairing, 7, true));

    await waitFor(() => expect(result.current?.list.id).toBe(7));
    expect(offlineSnapshot).toHaveBeenCalledWith(pairing, 7);
    expect(loadSnapshot()?.list.id).toBe(7);
  });

  it("starts from what the device already holds", () => {
    // A till switched on with no network still has the list it was last given.
    saveSnapshot(guestList(7));
    offlineSnapshot.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useOfflineSnapshot(pairing, 7, true));

    expect(result.current?.list.id).toBe(7);
  });

  it("is refreshed on a timer, because tickets are still being sold", async () => {
    renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS);
    });

    expect(offlineSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps the one it has when a refresh fails", async () => {
    saveSnapshot(guestList(7));
    offlineSnapshot.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalled());

    expect(result.current?.list.id).toBe(7);
    expect(loadSnapshot()?.list.id).toBe(7);
  });

  it("asks for nothing before the till is paired", () => {
    renderHook(() => useOfflineSnapshot(null, 7, true));

    expect(offlineSnapshot).not.toHaveBeenCalled();
  });

  it("asks for nothing when there is no list to carry", () => {
    renderHook(() => useOfflineSnapshot(pairing, null, true));

    expect(offlineSnapshot).not.toHaveBeenCalled();
  });

  it("stands down while told to, and resumes at once when it may", async () => {
    const { rerender } = renderHook(
      ({ active }) => useOfflineSnapshot(pairing, 7, active),
      { initialProps: { active: false } },
    );
    expect(offlineSnapshot).not.toHaveBeenCalled();

    rerender({ active: true });

    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());
  });

  it("is not pulled again for a flicker of the network", async () => {
    // One failed request answered at once by one that got through reads as
    // the network coming back. On a network dropping writes but not reads
    // that alternates as fast as the requests go, and each pull is every
    // ticket sold.
    const { rerender } = renderHook(
      ({ active }) => useOfflineSnapshot(pairing, 7, active),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());

    for (let i = 0; i < 5; i++) {
      rerender({ active: false });
      rerender({ active: true });
    }

    expect(offlineSnapshot).toHaveBeenCalledOnce();
  });

  it("is pulled again when the network comes back a while later", async () => {
    const { rerender } = renderHook(
      ({ active }) => useOfflineSnapshot(pairing, 7, active),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());
    rerender({ active: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_MIN_GAP_MS);
    });
    rerender({ active: true });

    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledTimes(2));
  });

  it("follows the door to another list", async () => {
    const { result, rerender } = renderHook(
      ({ listId }) => useOfflineSnapshot(pairing, listId, true),
      { initialProps: { listId: 7 } },
    );
    await waitFor(() => expect(result.current?.list.id).toBe(7));

    rerender({ listId: 8 });

    await waitFor(() => expect(result.current?.list.id).toBe(8));
    expect(loadSnapshot()?.list.id).toBe(8);
  });

  it("is not pulled again by the next screen within the gap", async () => {
    // A door stepping out to the grid to sell a ticket and straight back: the
    // app's pull and the door screen's are the same list, and each used to
    // pull the whole of it on arrival.
    const door = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());
    door.unmount();

    for (let i = 0; i < 3; i++) {
      renderHook(() => useOfflineSnapshot(pairing, 7, true)).unmount();
      renderHook(() => useOfflineSnapshot(pairing, 7, true)).unmount();
    }

    expect(offlineSnapshot).toHaveBeenCalledOnce();
  });

  it("holds the gap across a relaunch", () => {
    // iOS reloads an app it has kept in the background; a pull made seconds
    // before is still the list.
    saveSnapshotPull({ event: "festival", list: 7, at: Date.now() - 10_000 });

    renderHook(() => useOfflineSnapshot(pairing, 7, true));

    expect(offlineSnapshot).not.toHaveBeenCalled();
  });

  it("times the refresh from the last pull, whichever screen made it", async () => {
    // Otherwise a door changing screen more often than every five minutes
    // would only ever pull on arrival.
    saveSnapshotPull({ event: "festival", list: 7, at: Date.now() - 40_000 });
    renderHook(() => useOfflineSnapshot(pairing, 7, true));
    expect(offlineSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS - 41_000);
    });
    expect(offlineSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(offlineSnapshot).toHaveBeenCalledOnce();
  });

  it("does not count a pull for another list, or another event", async () => {
    saveSnapshotPull({ event: "festival", list: 8, at: Date.now() });
    const first = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());
    first.unmount();

    saveSnapshotPull({ event: "gala", list: 7, at: Date.now() });
    renderHook(() => useOfflineSnapshot(pairing, 7, true));

    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledTimes(2));
  });

  it("is not put off for an hour by a clock set back", async () => {
    saveSnapshotPull({ event: "festival", list: 7, at: Date.now() + 3_600_000 });
    renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS);
    });

    expect(offlineSnapshot).toHaveBeenCalledTimes(2);
  });

  it("is dropped the moment the server says this device is not a door", async () => {
    // Every guest's name and ticket secret, on a device that has no business
    // with the door any more.
    saveSnapshot(guestList(7));
    offlineSnapshot.mockRejectedValue(
      new ApiError(403, "This device is not a door.", { code: "door_role_required" }),
    );

    const { result } = renderHook(() => useOfflineSnapshot(pairing, 7, true));

    await waitFor(() => expect(result.current).toBeNull());
    expect(loadSnapshot()).toBeNull();
    expect(loadSnapshotPull()).toBeNull();
  });

  it("is kept for any other refusal", async () => {
    saveSnapshot(guestList(7));
    offlineSnapshot.mockRejectedValue(new ApiError(403, "Device revoked."));

    const { result } = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.list.id).toBe(7);
    expect(loadSnapshot()?.list.id).toBe(7);
  });

  it("does not drop a list on a refusal that arrives after it was stood down", async () => {
    saveSnapshot(guestList(7));
    let refuse!: (error: unknown) => void;
    offlineSnapshot.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const { unmount } = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    unmount();

    await act(async () => {
      refuse(new ApiError(403, "no", { code: "door_role_required" }));
    });

    expect(loadSnapshot()?.list.id).toBe(7);
  });

  it("drops an answer that arrives after it was stood down", async () => {
    // The list on screen may have changed in the meantime; a late answer for
    // the old one must not overwrite the new one on the device.
    let answer!: (value: OfflineSnapshot) => void;
    offlineSnapshot.mockReturnValue(new Promise<OfflineSnapshot>((resolve) => { answer = resolve; }));
    const { result, unmount } = renderHook(() => useOfflineSnapshot(pairing, 7, true));
    unmount();

    await act(async () => {
      answer(guestList(7));
    });

    expect(result.current).toBeNull();
    expect(loadSnapshot()).toBeNull();
  });
});
