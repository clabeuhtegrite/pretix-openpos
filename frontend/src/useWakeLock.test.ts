import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWakeLock } from "./useWakeLock";

/**
 * A tablet that dims in the middle of a queue costs a few seconds every time,
 * and the system hands the lock back on its own whenever it feels like it —
 * low power mode, an incoming call, a permission sheet. So the interesting
 * behaviour is not taking the lock, it is taking it again, and knowing when
 * to stop.
 */

/** A stand-in for the sentinel the browser hands back. */
function makeSentinel() {
  const listeners = new Set<() => void>();
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    /** Pretend the system took the lock back. */
    systemReleases: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

let request: ReturnType<typeof vi.fn>;

function grantWakeLock(): void {
  Object.defineProperty(navigator, "wakeLock", {
    value: { request },
    configurable: true,
  });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  request = vi.fn().mockImplementation(async () => makeSentinel());
  setVisibility("visible");
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  vi.restoreAllMocks();
});

describe("useWakeLock", () => {
  it("keeps the screen awake while the till is in use", async () => {
    grantWakeLock();

    await act(async () => {
      renderHook(() => useWakeLock(true));
    });

    expect(request).toHaveBeenCalledWith("screen");
  });

  it("does nothing at all when it is not asked to", async () => {
    grantWakeLock();

    await act(async () => {
      renderHook(() => useWakeLock(false));
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("does not nag a browser that has no such API", async () => {
    // Safari before 16.4, and every desktop browser that still refuses.
    await act(async () => {
      renderHook(() => useWakeLock(true));
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("says nothing when the lock is refused", async () => {
    grantWakeLock();
    request.mockRejectedValue(new Error("NotAllowedError"));

    await act(async () => {
      renderHook(() => useWakeLock(true));
    });

    // No throw, no unhandled rejection: there is nothing an operator could do.
    expect(request).toHaveBeenCalledOnce();
  });

  it("gives the lock back when the till stops needing it", async () => {
    grantWakeLock();
    const sentinel = makeSentinel();
    request.mockResolvedValue(sentinel);
    const { unmount } = renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    unmount();

    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it("takes it again when the system hands it back mid-service", async () => {
    grantWakeLock();
    const sentinel = makeSentinel();
    request.mockResolvedValue(sentinel);
    renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    await act(async () => {
      sentinel.systemReleases();
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not fight for it while the app is in the background", async () => {
    grantWakeLock();
    const sentinel = makeSentinel();
    request.mockResolvedValue(sentinel);
    renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      sentinel.systemReleases();
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("takes it back when the app comes to the front again", async () => {
    grantWakeLock();
    renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    await act(async () => {
      setVisibility("visible");
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops asking rather than looping forever against a refusal", async () => {
    // A system that releases the lock the instant it is granted would
    // otherwise spin for the whole evening.
    grantWakeLock();
    const sentinel = makeSentinel();
    request.mockResolvedValue(sentinel);
    renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => {
        sentinel.systemReleases();
      });
    }

    // The first grant plus the twenty it is allowed to try for.
    expect(request).toHaveBeenCalledTimes(21);
  });

  it("does not take it again after the till has let go", async () => {
    grantWakeLock();
    const sentinel = makeSentinel();
    request.mockResolvedValue(sentinel);
    const { unmount } = renderHook(() => useWakeLock(true));
    await act(async () => undefined);

    unmount();
    await act(async () => {
      sentinel.systemReleases();
      setVisibility("visible");
    });

    expect(request).toHaveBeenCalledOnce();
  });
});
