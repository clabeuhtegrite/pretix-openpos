import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import InstallGate, { browserAllowed, isStandalone } from "./InstallGate";

/**
 * The gate that keeps the till out of a browser tab.
 *
 * A tab has an address bar eating a fifth of the screen, no wake lock worth the
 * name, and a pull-to-refresh gesture over the basket. But being locked out on
 * the night of an event is worse than any of that, so the escape hatch matters
 * as much as the gate.
 */

/** Pretend to be a particular device. */
function browserIs(properties: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

/** Pretend the app was launched in one display mode or another. */
function displayModeIs(mode: string | null): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: mode !== null && query.includes(mode) }),
  });
}

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

afterEach(() => {
  for (const name of ["standalone", "userAgent", "platform", "maxTouchPoints"]) {
    Reflect.deleteProperty(navigator, name);
  }
  Reflect.deleteProperty(window, "matchMedia");
  window.history.replaceState({}, "", "/openpos/");
});

describe("isStandalone", () => {
  it("recognises an iOS home-screen app", () => {
    // iOS never implemented the display-mode query and uses this instead.
    browserIs({ standalone: true });
    displayModeIs(null);

    expect(isStandalone()).toBe(true);
  });

  it.each(["standalone", "fullscreen", "minimal-ui"])(
    "recognises an installed app running in %s",
    (mode) => {
      displayModeIs(mode);

      expect(isStandalone()).toBe(true);
    },
  );

  it("says no for a plain browser tab", () => {
    displayModeIs(null);

    expect(isStandalone()).toBe(false);
  });

  it("says no rather than throwing where matchMedia does not exist", () => {
    expect(isStandalone()).toBe(false);
  });
});

describe("browserAllowed", () => {
  it("says no on a device that has never asked", () => {
    expect(browserAllowed()).toBe(false);
  });

  it("lets a tab through when the escape hatch is in the address", () => {
    window.history.replaceState({}, "", "/openpos/?browser=1");

    expect(browserAllowed()).toBe(true);
  });

  it("remembers it, so the address only has to be typed once", () => {
    // On the night, from a replacement device, with one hand.
    window.history.replaceState({}, "", "/openpos/?browser=1");
    browserAllowed();
    window.history.replaceState({}, "", "/openpos/");

    expect(browserAllowed()).toBe(true);
  });

  it("ignores any other value", () => {
    window.history.replaceState({}, "", "/openpos/?browser=0");

    expect(browserAllowed()).toBe(false);
  });

  it("gates rather than throws when storage is unavailable", () => {
    // Safari in private mode used to throw on every localStorage access.
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });

    expect(browserAllowed()).toBe(false);

    vi.unstubAllGlobals();
    getItem.mockRestore();
  });
});

describe("the instructions", () => {
  it("gives the Safari share-sheet steps on an iPhone", () => {
    browserIs({ userAgent: IPHONE });

    render(<InstallGate />);

    expect(screen.getByText(t("gate.ios1"))).toBeDefined();
  });

  it("gives them on an iPad, which reports itself as a Mac", () => {
    // iPadOS 13 onwards lies about its user agent; the touch points do not.
    browserIs({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 });

    render(<InstallGate />);

    expect(screen.getByText(t("gate.ios3"))).toBeDefined();
  });

  it("gives the browser-menu steps everywhere else", () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });

    render(<InstallGate />);

    expect(screen.getByText(t("gate.other1"))).toBeDefined();
  });

  it("always says how to get a tab anyway", () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });

    render(<InstallGate />);

    expect(screen.getByText(t("gate.escape"))).toBeDefined();
  });
});

describe("the one-tap install", () => {
  /** Chrome's install prompt, as it arrives. */
  function installPromptFires(prompt = vi.fn().mockResolvedValue(undefined)) {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
    });
    window.dispatchEvent(event);
    return { event, prompt };
  }

  it("offers the button once the browser says it can install", async () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });
    render(<InstallGate />);

    await act(installPromptFires);

    expect(screen.getByRole("button", { name: t("gate.install") })).toBeDefined();
  });

  it("keeps the browser from popping its own banner mid-service", async () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });
    render(<InstallGate />);

    const { event } = await act(installPromptFires);

    expect(event.defaultPrevented).toBe(true);
  });

  it("replaces the written steps with the button", async () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });
    render(<InstallGate />);

    await act(installPromptFires);

    expect(screen.queryByText(t("gate.other1"))).toBeNull();
  });

  it("installs on a tap, and only offers it once", async () => {
    // The browser refuses a second call on the same event.
    const user = userEvent.setup();
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });
    render(<InstallGate />);
    const { prompt } = await act(installPromptFires);

    await user.click(screen.getByRole("button", { name: t("gate.install") }));

    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: t("gate.install") })).toBeNull();
  });

  it("stops listening once the gate is gone", async () => {
    browserIs({ userAgent: ANDROID, platform: "Linux", maxTouchPoints: 0 });
    const { unmount } = render(<InstallGate />);

    unmount();
    const { event } = installPromptFires();

    // Nothing left to preventDefault it.
    expect(event.defaultPrevented).toBe(false);
  });
});
