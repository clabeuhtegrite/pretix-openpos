import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDoorResume, loadUpdateAttempt } from "./storage";
import {
  installUpdate, PREPARE_RECEIPT_MS, PREPARE_TIMEOUT_MS, PREPARE_UPDATE, prepareUpdate,
} from "./update";

/**
 * Moving onto a new build without ever being left with none.
 *
 * The page asks the service worker to bring the new build in (sw.js answers
 * "preparing", then "ready" or "failed") and reloads only once it is on the
 * device. What these pin is the part that used to go wrong: an update that
 * could not be fetched must change nothing, where it used to have already
 * thrown away the only copy of the app the device could start from offline.
 */

let location: PropertyDescriptor | undefined;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reload = vi.fn();
  location = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", {
    configurable: true, value: { ...window.location, reload },
  });
});

afterEach(() => {
  if (location) Object.defineProperty(window, "location", location);
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.useRealTimers();
});

/** A worker in control of the page, answering the handshake as `answer` does. */
function worker(answer: (port: MessagePort, message: unknown) => void) {
  const postMessage = vi.fn((message: unknown, transfer: MessagePort[]) => {
    answer(transfer[0], message);
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true, value: { controller: { postMessage } },
  });
  return postMessage;
}

/** One that answers these states, in order. */
function answering(...states: string[]) {
  return worker((port) => {
    for (const state of states) port.postMessage({ state });
  });
}

describe("prepareUpdate", () => {
  it("asks the worker in control of the page", async () => {
    const asked = answering("preparing", "ready");

    await prepareUpdate();

    expect(asked).toHaveBeenCalledWith({ type: PREPARE_UPDATE }, [expect.anything()]);
  });

  it("is ready once the worker has the new build on the device", async () => {
    answering("preparing", "ready");

    expect(await prepareUpdate()).toBe("ready");
  });

  it("fails when the worker could not bring it in", async () => {
    answering("preparing", "failed");

    expect(await prepareUpdate()).toBe("failed");
  });

  it("has nobody to ask on a page no worker controls", async () => {
    // A browser without service workers, or the very first load, before the
    // worker has taken the page over. A reload is all there is.
    expect(await prepareUpdate()).toBe("unsupported");

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true, value: { controller: null },
    });
    expect(await prepareUpdate()).toBe("unsupported");
  });

  it("takes silence for a worker from before this handshake", async () => {
    // Its navigations go to the network first, so a plain reload still gets
    // the new build; waiting on it would only stall the update for good.
    vi.useFakeTimers();
    worker(() => {});

    const outcome = prepareUpdate();
    await vi.advanceTimersByTimeAsync(PREPARE_RECEIPT_MS);

    expect(await outcome).toBe("unsupported");
  });

  it("gives up on a download that never ends", async () => {
    vi.useFakeTimers();
    worker((port) => port.postMessage({ state: "preparing" }));

    const outcome = prepareUpdate();
    // Past the receipt window, the worker has said it started: still waiting.
    await vi.advanceTimersByTimeAsync(PREPARE_RECEIPT_MS * 2);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);

    expect(await outcome).toBe("failed");
  });

  it("ignores what it does not understand", async () => {
    worker((port) => {
      port.postMessage(null);
      port.postMessage({ state: "something else" });
      port.postMessage({ state: "preparing" });
      port.postMessage({ state: "ready" });
    });

    expect(await prepareUpdate()).toBe("ready");
  });

  it("does not wait on a worker it could not even write to", async () => {
    worker(() => {
      throw new DOMException("gone", "InvalidStateError");
    });

    expect(await prepareUpdate()).toBe("unsupported");
  });
});

describe("installUpdate", () => {
  it("reloads onto the new build once it is on the device", async () => {
    answering("preparing", "ready");

    await installUpdate("99.0.0", false);

    expect(reload).toHaveBeenCalledOnce();
    // Written before the reload: whatever comes back has to know it tried.
    expect(loadUpdateAttempt()).toBe("99.0.0");
    expect(loadDoorResume()).toBe(false);
  });

  it("asks the new build to open on the door when that is where it was", async () => {
    answering("preparing", "ready");

    await installUpdate("99.0.0", true);

    expect(loadDoorResume()).toBe(true);
  });

  it("changes nothing when the new build could not be fetched", async () => {
    answering("preparing", "failed");

    expect(await installUpdate("99.0.0", true)).toBe(false);

    expect(reload).not.toHaveBeenCalled();
    // The offer stands: it was never taken up.
    expect(loadUpdateAttempt()).toBeNull();
    expect(loadDoorResume()).toBe(false);
  });

  it("still reloads where there is no worker to ask", async () => {
    expect(await installUpdate("99.0.0", false)).toBe(true);

    expect(reload).toHaveBeenCalledOnce();
  });
});
