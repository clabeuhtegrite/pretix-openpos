import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Android back gesture, aimed at the overlay rather than at the till.
 *
 * An installed PWA sits on a single history entry, so back closes the whole
 * app — basket and all. Every overlay therefore takes an entry of its own while
 * it is open. The subtle part is giving that entry back when the overlay is
 * closed from the UI instead: that calls history.back() too, and an early
 * version had the panel underneath take the resulting event as its own cue, so
 * tapping "Close" on a panel also shut the scanner behind it.
 *
 * The browser is driven directly here — pushState and back are spied on, and
 * the gesture is the popstate event itself — because jsdom's session history is
 * a sketch: it fires no popstate for a traversal back to the first entry, which
 * is precisely where an installed till lives. Testing against that would pin
 * the quirks of the fake browser rather than the behaviour of the hook.
 *
 * The hook keeps its stack in module scope; each test imports it fresh.
 */

type Module = typeof import("./useBackClose");

let useBackClose: Module["useBackClose"];
let pushState: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;

/** The system back gesture, as the browser delivers it to the page. */
async function pressBack(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
}

/**
 * Close an overlay from the UI, then let the browser answer.
 *
 * Giving the entry back means calling history.back(), and the browser fires the
 * same popstate for that as for a real press. Both halves belong to one action.
 */
async function closeFromUi(unmount: () => void): Promise<void> {
  const before = back.mock.calls.length;
  unmount();
  if (back.mock.calls.length > before) await pressBack();
}

beforeEach(async () => {
  vi.resetModules();
  ({ useBackClose } = await import("./useBackClose"));
  pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  back = vi.spyOn(window.history, "back").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useBackClose", () => {
  it("takes a history entry while the overlay is open", () => {
    renderHook(() => useBackClose(true, () => {}));

    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState.mock.calls[0][0]).toEqual({ openposOverlay: true });
  });

  it("takes none while the overlay is closed", () => {
    renderHook(() => useBackClose(false, () => {}));

    expect(pushState).not.toHaveBeenCalled();
  });

  it("closes the overlay instead of the till", async () => {
    const close = vi.fn();
    renderHook(() => useBackClose(true, close));

    await pressBack();

    expect(close).toHaveBeenCalledOnce();
  });

  it("gives its entry back when the overlay is closed from the UI", async () => {
    const close = vi.fn();
    const { unmount } = renderHook(() => useBackClose(true, close));

    await closeFromUi(unmount);

    expect(back).toHaveBeenCalledOnce();
    // Closed by the button, not by the gesture: it must not close twice.
    expect(close).not.toHaveBeenCalled();
  });

  it("does not close the panel underneath when one is closed from the UI", async () => {
    // The exact bug: tapping "Close" on a panel shut the scanner behind it.
    const closeScanner = vi.fn();
    const closePanel = vi.fn();
    renderHook(() => useBackClose(true, closeScanner));
    const panel = renderHook(() => useBackClose(true, closePanel));

    await closeFromUi(panel.unmount);

    expect(closePanel).not.toHaveBeenCalled();
    expect(closeScanner).not.toHaveBeenCalled();
  });

  it("keeps the one underneath reachable after that", async () => {
    // The self-pop must be consumed exactly once. Swallowing every pop would
    // leave the scanner unable to be closed by the gesture at all.
    const closeScanner = vi.fn();
    const closePanel = vi.fn();
    renderHook(() => useBackClose(true, closeScanner));
    const panel = renderHook(() => useBackClose(true, closePanel));

    await closeFromUi(panel.unmount);
    await pressBack();

    expect(closeScanner).toHaveBeenCalledOnce();
  });

  it("closes only the innermost overlay on a back press", async () => {
    const closeScanner = vi.fn();
    const closePanel = vi.fn();
    renderHook(() => useBackClose(true, closeScanner));
    renderHook(() => useBackClose(true, closePanel));

    await pressBack();

    expect(closePanel).toHaveBeenCalledOnce();
    expect(closeScanner).not.toHaveBeenCalled();
  });

  it("does not give an entry back for the overlay the gesture just closed", async () => {
    // It is already gone. Popping again would take the till's own entry and
    // close the app — which is the thing this hook exists to prevent.
    const { unmount } = renderHook(() => useBackClose(true, vi.fn()));

    await pressBack();
    unmount();

    expect(back).not.toHaveBeenCalled();
  });

  it("does not push again when the component re-renders", () => {
    // Every caller passes an inline arrow; re-running the effect on each
    // render would stack a history entry per keystroke.
    const { rerender } = renderHook(({ close }) => useBackClose(true, close), {
      initialProps: { close: () => {} },
    });

    rerender({ close: () => {} });
    rerender({ close: () => {} });

    expect(pushState).toHaveBeenCalledOnce();
  });

  it("closes with the callback it has now, not the one it opened with", async () => {
    const stale = vi.fn();
    const current = vi.fn();
    const { rerender } = renderHook(({ close }) => useBackClose(true, close), {
      initialProps: { close: stale },
    });

    rerender({ close: current });
    await pressBack();

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it("ignores a back press once nothing is open", async () => {
    const close = vi.fn();
    const { unmount } = renderHook(() => useBackClose(true, close));
    await closeFromUi(unmount);

    await pressBack();

    expect(close).not.toHaveBeenCalled();
  });

  it("takes its entry when an overlay that was closed is opened", () => {
    const { rerender } = renderHook(({ open }) => useBackClose(open, () => {}), {
      initialProps: { open: false },
    });

    rerender({ open: true });

    expect(pushState).toHaveBeenCalledOnce();
  });
});
