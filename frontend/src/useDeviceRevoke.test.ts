import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { revokeDevice } = vi.hoisted(() => ({ revokeDevice: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, revokeDevice } };
});

import { ApiError } from "./api";
import { loadRevocations, queueRevocation } from "./storage";
import type { Pairing } from "./types";
import { revokeLeftovers, useDeviceRevoke } from "./useDeviceRevoke";

/**
 * Ending in pretix the pairings a till has given up.
 *
 * pretix asks any app that lets a device be removed to call `/device/revoke`.
 * The till used to forget its token and nothing more, so the device went on
 * reading "active" in the back office with a token that still worked. What is
 * pinned here is that an unpairing reaches pretix even when it was made
 * without a network, and that the till lets the token go once it has.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};

beforeEach(() => {
  revokeDevice.mockResolvedValue({});
});

/** Let a request that has been answered finish settling. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("revoking what an unpairing left behind", () => {
  it("revokes a queued token and lets it go", async () => {
    queueRevocation("old");

    expect(await revokeLeftovers()).toBe("done");

    expect(revokeDevice).toHaveBeenCalledWith("old");
    expect(loadRevocations()).toEqual([]);
  });

  it("asks nothing when nothing was unpaired", async () => {
    expect(await revokeLeftovers()).toBe("done");

    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it("queues a token once, however often it is given up", () => {
    queueRevocation("old");
    queueRevocation("old");

    expect(loadRevocations()).toEqual(["old"]);
  });

  it("keeps the token when the request never reached the server", async () => {
    revokeDevice.mockRejectedValue(new ApiError(0, "network"));
    queueRevocation("old");

    expect(await revokeLeftovers()).toBe("retry");
    expect(loadRevocations()).toEqual(["old"]);
  });

  it.each([401, 403, 404])("lets a token go on a %i", async (status) => {
    // A device already revoked or deleted in the back office: nothing is left
    // for this token to end, and asking again would get the same answer.
    revokeDevice.mockRejectedValue(new ApiError(status, "no"));
    queueRevocation("old");

    expect(await revokeLeftovers()).toBe("done");
    expect(loadRevocations()).toEqual([]);
  });

  it.each([500, 502])("keeps the token for the next launch on a %i", async (status) => {
    // pretix may have written nothing. Not asked again on every return to the
    // network, though: the API layer takes a fault for an absent server, and
    // that would flip the till offline every few seconds.
    revokeDevice.mockRejectedValue(new ApiError(status, "fault"));
    queueRevocation("old");

    expect(await revokeLeftovers()).toBe("done");
    expect(loadRevocations()).toEqual(["old"]);
  });

  it("lets a bug in the call go rather than keep it for ever", async () => {
    revokeDevice.mockImplementation(() => {
      throw new TypeError("bug in the app");
    });
    queueRevocation("old");

    expect(await revokeLeftovers()).toBe("done");
    expect(loadRevocations()).toEqual([]);
  });

  it("goes through every token, one lost request or not", async () => {
    revokeDevice.mockRejectedValueOnce(new ApiError(0, "network"));
    queueRevocation("first");
    queueRevocation("second");

    expect(await revokeLeftovers()).toBe("retry");

    expect(revokeDevice).toHaveBeenCalledWith("second");
    expect(loadRevocations()).toEqual(["first"]);
  });
});

describe("when the till revokes", () => {
  it("does it as soon as it is unpaired and online", async () => {
    const { rerender } = renderHook(
      ({ p, online }: { p: Pairing | null; online: boolean }) => useDeviceRevoke(p, online),
      { initialProps: { p: pairing as Pairing | null, online: true } },
    );
    await settle();
    expect(revokeDevice).not.toHaveBeenCalled();

    queueRevocation("tok");
    rerender({ p: null, online: true });

    await waitFor(() => expect(loadRevocations()).toEqual([]));
    expect(revokeDevice).toHaveBeenCalledWith("tok");
  });

  it("sends what an earlier launch could not", async () => {
    queueRevocation("old");

    renderHook(() => useDeviceRevoke(null, true));

    await waitFor(() => expect(loadRevocations()).toEqual([]));
  });

  it("waits for the network, and tries again on the way back", async () => {
    revokeDevice.mockRejectedValueOnce(new ApiError(0, "network"));
    queueRevocation("tok");
    const { rerender } = renderHook(
      ({ online }) => useDeviceRevoke(null, online),
      { initialProps: { online: false } },
    );
    expect(revokeDevice).not.toHaveBeenCalled();

    rerender({ online: true });
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledTimes(1));
    await settle();
    expect(loadRevocations()).toEqual(["tok"]);

    // What the API layer does after a request that never arrived.
    rerender({ online: false });
    rerender({ online: true });

    await waitFor(() => expect(loadRevocations()).toEqual([]));
    expect(revokeDevice).toHaveBeenCalledTimes(2);
  });

  it("does not ask again once answered, until the pairing changes", async () => {
    queueRevocation("tok");
    const { rerender } = renderHook(
      ({ online }) => useDeviceRevoke(null, online),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(loadRevocations()).toEqual([]));
    await settle();

    rerender({ online: false });
    rerender({ online: true });
    await settle();

    expect(revokeDevice).toHaveBeenCalledTimes(1);
  });

  it("catches an unpairing made while a request was still out", async () => {
    // Launch, then unpair at once: the launch's look at the queue is still
    // waiting on pretix when the token of the pairing just given up arrives.
    let answer: (value: unknown) => void = () => {};
    revokeDevice.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    queueRevocation("old");
    const { rerender } = renderHook(
      ({ p }: { p: Pairing | null }) => useDeviceRevoke(p, true),
      { initialProps: { p: pairing as Pairing | null } },
    );
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledTimes(1));

    queueRevocation("tok");
    rerender({ p: null });
    await act(async () => answer({}));

    await waitFor(() => expect(loadRevocations()).toEqual([]));
    expect(revokeDevice).toHaveBeenCalledWith("tok");
  });
});
