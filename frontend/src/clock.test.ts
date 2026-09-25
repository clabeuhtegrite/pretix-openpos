import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLOCK_SKEW_WARN_MS, clockSkew, formatDrift, noteServerTime, subscribeClock, useClockSkew,
} from "./clock";

/**
 * How far this device's clock is from the server's.
 *
 * A sale rung up with no network is dated by this clock, so a tablet set by
 * hand — or left on another country's time — files its sales wrongly. What is
 * pinned here is the reading itself, and when it is worth a line on screen.
 */

const T = Date.parse("2026-08-16T22:00:00.000Z");

afterEach(() => {
  // Module state: back to a clock that agrees, for whatever runs next.
  noteServerTime(new Date(T).toISOString(), T, T);
});

describe("a reading of the server's clock", () => {
  it("is set against the middle of the request, not either end of it", () => {
    // Sent at T, answered two seconds later: the server read its clock
    // somewhere in between, most likely around T + 1 s.
    noteServerTime(new Date(T - 5 * 60_000).toISOString(), T, T + 2000);

    expect(clockSkew()).toBe(5 * 60_000 + 1000);
  });

  it("is positive when this device is ahead, negative when it is behind", () => {
    noteServerTime(new Date(T + 3 * 60_000).toISOString(), T, T);

    expect(clockSkew()).toBe(-3 * 60_000);
  });

  it("is no reading at all when the server sent no time", () => {
    noteServerTime(new Date(T - 60_000).toISOString(), T, T);

    // An older server, or a field that did not parse.
    noteServerTime(undefined, T, T);
    noteServerTime("not a date", T, T);

    expect(clockSkew()).toBe(60_000);
  });

  it("tells whoever listens, and only when it changed", () => {
    const heard = vi.fn();
    const stop = subscribeClock(heard);

    noteServerTime(new Date(T - 60_000).toISOString(), T, T);
    noteServerTime(new Date(T - 60_000).toISOString(), T, T);
    stop();
    noteServerTime(new Date(T - 120_000).toISOString(), T, T);

    expect(heard).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenCalledWith(60_000);
  });
});

describe("the drift worth saying", () => {
  it("is nothing within the threshold, which is only the network", () => {
    const { result } = renderHook(() => useClockSkew());

    act(() => noteServerTime(new Date(T - (CLOCK_SKEW_WARN_MS - 1000)).toISOString(), T, T));

    expect(result.current).toBeNull();
  });

  it("is whole minutes past it, signed like the reading", () => {
    const { result } = renderHook(() => useClockSkew());

    act(() => noteServerTime(new Date(T - 7 * 60_000 - 20_000).toISOString(), T, T));
    expect(result.current).toBe(7);

    act(() => noteServerTime(new Date(T + 125 * 60_000).toISOString(), T, T));
    expect(result.current).toBe(-125);
  });

  it("is read at once by a screen that opens after the reading", () => {
    noteServerTime(new Date(T - 10 * 60_000).toISOString(), T, T);

    const { result } = renderHook(() => useClockSkew());

    expect(result.current).toBe(10);
  });

  it("stops being said once the clock has been set", () => {
    const { result } = renderHook(() => useClockSkew());
    act(() => noteServerTime(new Date(T - 10 * 60_000).toISOString(), T, T));

    act(() => noteServerTime(new Date(T).toISOString(), T, T));

    expect(result.current).toBeNull();
  });
});

describe("a drift as somebody reads it", () => {
  it("is minutes under the hour", () => {
    expect(formatDrift(7)).toBe("7 min");
    expect(formatDrift(-59)).toBe("59 min");
  });

  it("is hours and minutes past it, rather than a sum to do", () => {
    expect(formatDrift(125)).toBe("2 h 05");
    expect(formatDrift(-60)).toBe("1 h 00");
  });
});
