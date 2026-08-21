import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What "offline" means to this till.
 *
 * Not `navigator.onLine`: on a venue's wifi a tablet is very often attached to
 * an access point that leads nowhere, and reports itself perfectly online while
 * every sale fails. The truth here comes from requests that did or did not
 * arrive, and these tests exist to keep it that way.
 *
 * The module keeps its verdict in module scope, so each test imports it fresh
 * rather than inheriting the previous one's mood.
 */

type Connectivity = typeof import("./connectivity");

let connectivity: Connectivity;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  connectivity = await import("./connectivity");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the verdict", () => {
  it("starts optimistic: a till that has not tried anything is not offline", () => {
    expect(connectivity.isOnline()).toBe(true);
  });

  it("goes down when a request never reached the server", () => {
    connectivity.markUnreachable();

    expect(connectivity.isOnline()).toBe(false);
  });

  it("comes back up on any answer at all, including a refusal", () => {
    connectivity.markUnreachable();

    connectivity.markReachable();

    expect(connectivity.isOnline()).toBe(true);
  });

  it("tells subscribers when it changes", () => {
    const listener = vi.fn();
    connectivity.subscribe(listener);

    connectivity.markUnreachable();

    expect(listener).toHaveBeenCalledWith(false);
  });

  it("says nothing when a request confirms what it already believed", () => {
    // Every answered request marks us up. Re-rendering the whole app on each
    // one would be a redraw per keypress on a busy till.
    const listener = vi.fn();
    connectivity.subscribe(listener);

    connectivity.markReachable();
    connectivity.markReachable();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops telling a subscriber that has unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = connectivity.subscribe(listener);

    unsubscribe();
    connectivity.markUnreachable();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("probe", () => {
  it("asks the app shell, not an endpoint that needs a valid token", async () => {
    // This runs while offline, possibly for hours. A device token that expired
    // during the outage must not be able to make the till believe the network
    // is still down.
    await connectivity.probe();

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^\/openpos\/\?probe=\d+$/);
    expect(options).toMatchObject({ method: "HEAD", cache: "no-store" });
  });

  it("brings the till back up when the server answers", async () => {
    connectivity.markUnreachable();

    await connectivity.probe();

    expect(connectivity.isOnline()).toBe(true);
  });

  it("puts it down when the request throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await connectivity.probe();

    expect(connectivity.isOnline()).toBe(false);
  });

  it("counts a refusal as the server being there", async () => {
    // A 404 on the shell still travelled over the network both ways.
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    connectivity.markUnreachable();

    await connectivity.probe();

    expect(connectivity.isOnline()).toBe(true);
  });

  it("collapses a burst of failures into one request", async () => {
    // Six calls failing at once must not put six probes on a network that is
    // already the problem.
    const both = Promise.all([connectivity.probe(), connectivity.probe()]);

    await both;

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("useConnectivity", () => {
  it("hands the component the current verdict", () => {
    const { result } = renderHook(() => connectivity.useConnectivity());

    expect(result.current).toBe(true);
  });

  it("re-renders the component when the verdict changes", () => {
    const { result } = renderHook(() => connectivity.useConnectivity());

    act(() => connectivity.markUnreachable());

    expect(result.current).toBe(false);
  });

  it("checks for itself when the browser claims the network came back", () => {
    // The browser's event is a hint to go and look, never the answer.
    renderHook(() => connectivity.useConnectivity());

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("checks when the browser claims it went away, too", () => {
    renderHook(() => connectivity.useConnectivity());

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps testing the water while it believes it is down", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderHook(() => connectivity.useConnectivity());
    act(() => connectivity.markUnreachable());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops as soon as one probe gets through", async () => {
    // The till is back; the interval is left to run but has nothing to do.
    vi.useFakeTimers();
    renderHook(() => connectivity.useConnectivity());
    act(() => connectivity.markUnreachable());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(connectivity.isOnline()).toBe(true);
  });

  it("does not spend the evening pinging a server that answers", () => {
    // A working till has better things to do with a venue's uplink.
    vi.useFakeTimers();
    renderHook(() => connectivity.useConnectivity());

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets go of the window and the timer when the app unmounts", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => connectivity.useConnectivity());

    unmount();
    act(() => connectivity.markUnreachable());
    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("online"));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
