import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateDevice } = vi.hoisted(() => ({ updateDevice: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, updateDevice } };
});

import { ApiError, deviceDescription } from "./api";
import { loadDeviceReport, saveDeviceReport } from "./storage";
import type { Pairing } from "./types";
import { markDeviceReported, reportDevice, useDeviceReport } from "./useDeviceReport";

/**
 * What pretix' device list says this device runs.
 *
 * pretix knows only what the device tells it. The till used to say it once,
 * at pairing, so the back office went on showing that build through every
 * release after it. What is pinned here is when the till tells pretix again,
 * and when it keeps quiet: pretix writes an entry in the device's history for
 * every report, so saying the same thing at every launch has a cost too.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};

beforeEach(() => {
  updateDevice.mockResolvedValue({ unique_serial: "TILL1" });
});

/** Let a report that has been answered finish settling. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("telling pretix what the device runs", () => {
  it("reports a device that has said nothing since it paired", async () => {
    // Every till paired before this existed: pretix still shows the build it
    // was paired with.
    expect(await reportDevice(pairing)).toBe("done");

    expect(updateDevice).toHaveBeenCalledWith("tok", deviceDescription());
    expect(loadDeviceReport("TILL1")).toEqual(deviceDescription());
  });

  it("reports again once the device runs another build", async () => {
    saveDeviceReport("TILL1", { ...deviceDescription(), software_version: "0.10.0" });

    await reportDevice(pairing);

    expect(updateDevice).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ software_version: __APP_VERSION__ }),
    );
    expect(loadDeviceReport("TILL1")?.software_version).toBe(__APP_VERSION__);
  });

  it("reports a system update too", async () => {
    saveDeviceReport("TILL1", { ...deviceDescription(), os_version: "iPhone OS 17_5" });

    await reportDevice(pairing);

    expect(updateDevice).toHaveBeenCalledTimes(1);
  });

  it("keeps quiet when pretix already has exactly this", async () => {
    saveDeviceReport("TILL1", deviceDescription());

    expect(await reportDevice(pairing)).toBe("done");

    expect(updateDevice).not.toHaveBeenCalled();
  });

  it("never takes another device's report for its own", async () => {
    // The same tablet, unpaired and paired again as a new device in pretix.
    saveDeviceReport("OLDTILL", deviceDescription());

    await reportDevice(pairing);

    expect(updateDevice).toHaveBeenCalledTimes(1);
  });

  it("counts pairing as a report, since pairing said all the same things", async () => {
    markDeviceReported("TILL1");

    await reportDevice(pairing);

    expect(updateDevice).not.toHaveBeenCalled();
  });

  it("asks to try again when the request never reached the server", async () => {
    updateDevice.mockRejectedValue(new ApiError(0, "network"));

    expect(await reportDevice(pairing)).toBe("retry");
    expect(loadDeviceReport("TILL1")).toBeNull();
  });

  it.each([401, 403, 500, 502])("leaves a %i for the next launch", async (status) => {
    // An answer will be the same answer a minute later. For a fault it is
    // worse than useless: the API layer takes a fault for an absent server,
    // and asking on every return to the network would flip the till offline
    // every few seconds.
    updateDevice.mockRejectedValue(new ApiError(status, "no"));

    expect(await reportDevice(pairing)).toBe("done");
    expect(loadDeviceReport("TILL1")).toBeNull();
  });

  it("keeps a bug in the call away from the till", async () => {
    updateDevice.mockImplementation(() => {
      throw new TypeError("bug in the app");
    });

    expect(await reportDevice(pairing)).toBe("done");
  });
});

describe("when the till reports", () => {
  it("does it once a launch, as soon as it is paired and online", async () => {
    const { rerender } = renderHook(
      ({ p, online }) => useDeviceReport(p, online),
      { initialProps: { p: pairing, online: true } },
    );

    await waitFor(() => expect(loadDeviceReport("TILL1")).not.toBeNull());
    await settle();
    // The event switched in the settings: the same device, nothing new to say.
    rerender({ p: { ...pairing, event: "autre-soiree" }, online: true });
    rerender({ p: { ...pairing, event: "autre-soiree" }, online: false });
    rerender({ p: { ...pairing, event: "autre-soiree" }, online: true });

    expect(updateDevice).toHaveBeenCalledTimes(1);
  });

  it("waits for a pairing, and for the network", async () => {
    const { rerender } = renderHook(
      ({ p, online }: { p: Pairing | null; online: boolean }) => useDeviceReport(p, online),
      { initialProps: { p: null as Pairing | null, online: true } },
    );
    rerender({ p: pairing, online: false });
    expect(updateDevice).not.toHaveBeenCalled();

    rerender({ p: pairing, online: true });

    await waitFor(() => expect(updateDevice).toHaveBeenCalledTimes(1));
  });

  it("tries again on the way back online when the report was lost", async () => {
    // A till opened in a dead corner of the venue reports when it finds the wifi.
    updateDevice.mockRejectedValueOnce(new ApiError(0, "network"));
    const { rerender } = renderHook(
      ({ online }) => useDeviceReport(pairing, online),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(updateDevice).toHaveBeenCalledTimes(1));
    await settle();

    // What the API layer does after a request that never arrived.
    rerender({ online: false });
    rerender({ online: true });

    await waitFor(() => expect(loadDeviceReport("TILL1")).not.toBeNull());
    expect(updateDevice).toHaveBeenCalledTimes(2);
  });

  it("does not ask again after an answer, whatever it was", async () => {
    updateDevice.mockRejectedValue(new ApiError(500, "Server Error"));
    const { rerender } = renderHook(
      ({ online }) => useDeviceReport(pairing, online),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(updateDevice).toHaveBeenCalledTimes(1));
    // Settled before the network comes and goes: while a report is still out,
    // the hook would keep quiet anyway, and this would prove nothing.
    await settle();

    rerender({ online: false });
    rerender({ online: true });
    await settle();

    expect(updateDevice).toHaveBeenCalledTimes(1);
  });

  it("sends one report at a time", async () => {
    updateDevice.mockReturnValue(new Promise(() => {}));
    const { rerender } = renderHook(
      ({ online }) => useDeviceReport(pairing, online),
      { initialProps: { online: true } },
    );

    rerender({ online: false });
    rerender({ online: true });

    expect(updateDevice).toHaveBeenCalledTimes(1);
  });
});
