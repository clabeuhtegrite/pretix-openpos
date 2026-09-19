import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTheme, loadTheme, resolveTheme, saveTheme, watchDeviceTheme, type Theme,
} from "./theme";
import { fillStorage } from "./test/setup";

/**
 * Which palette the till wears.
 *
 * Small enough to read, and worth pinning down anyway: the failure mode is a
 * till that opens the wrong colour after a relaunch, or a white status bar
 * over a dark screen — neither of which anybody would report as a bug, and
 * both of which look like the app is broken.
 */

/** jsdom ships no matchMedia; this is the device answering a question. */
function deviceIs(scheme: "light" | "dark", { listeners = true } = {}) {
  const added: (() => void)[] = [];
  const removed: (() => void)[] = [];
  const query = {
    matches: scheme === "light",
    addEventListener: listeners
      ? (_name: string, fn: () => void) => added.push(fn)
      : undefined,
    removeEventListener: listeners
      ? (_name: string, fn: () => void) => removed.push(fn)
      : undefined,
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(query));
  return { added, removed };
}

/** The two tags the shell ships, one per device setting. */
function shellMetaTags() {
  document.head.innerHTML = `
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#1b2130" media="(prefers-color-scheme: dark)">
  `;
  return () =>
    [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
      (tag) => tag.content,
    );
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  deviceIs("dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remembering the choice", () => {
  it("follows the device until told otherwise", () => {
    expect(loadTheme()).toBe("system");
  });

  it("comes back to the palette the venue picked", () => {
    saveTheme("light");

    expect(loadTheme()).toBe("light");
  });

  it("ignores a value it does not recognise rather than guessing", () => {
    localStorage.setItem("openpos.theme.v1", "sepia");

    expect(loadTheme()).toBe("system");
  });

  it("follows the device when storage cannot be read at all", () => {
    // Private browsing, or site data blocked. A till that threw here would
    // not start.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(loadTheme()).toBe("system");
  });

  it("still switches when storage will take nothing", () => {
    fillStorage();

    // No throw: a full disk costs the preference, not the service.
    expect(() => saveTheme("dark")).not.toThrow();
  });
});

describe("resolving what is actually on screen", () => {
  it.each<[Theme, "light" | "dark"]>([
    ["light", "light"],
    ["dark", "dark"],
  ])("takes %s at its word whatever the device says", (chosen, expected) => {
    deviceIs("light");

    expect(resolveTheme(chosen)).toBe(expected);
  });

  it("asks the device when nobody has chosen", () => {
    deviceIs("light");

    expect(resolveTheme("system")).toBe("light");
  });

  it("stays dark on a browser that cannot be asked", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(resolveTheme("system")).toBe("dark");
  });
});

describe("putting it on screen", () => {
  it("names the palette on the root element", () => {
    applyTheme("light");

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("removes the attribute for system, so the media query decides alone", () => {
    applyTheme("dark");
    applyTheme("system");

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("pins both status-bar colours to the chosen palette", () => {
    const colours = shellMetaTags();

    applyTheme("light");

    // Both, not one: the device may well be set the other way, and its tag is
    // the one iOS would otherwise read.
    expect(colours()).toEqual(["#ffffff", "#ffffff"]);
  });

  it("hands each tag its own colour back when following the device", () => {
    const colours = shellMetaTags();
    applyTheme("dark");

    applyTheme("system");

    expect(colours()).toEqual(["#ffffff", "#1b2130"]);
  });
});

describe("a device that changes appearance mid-service", () => {
  it("repaints the status bar for a till that follows it", () => {
    const colours = shellMetaTags();
    const { added } = deviceIs("dark");
    applyTheme("system");
    watchDeviceTheme(() => "system");

    // Sunset: the tablet flips to dark. The palette follows through CSS; the
    // status bar has to be told.
    added[0]();

    expect(colours()).toEqual(["#ffffff", "#1b2130"]);
  });

  it("leaves a till that was told which palette to wear alone", () => {
    const colours = shellMetaTags();
    const { added } = deviceIs("dark");
    applyTheme("light");
    watchDeviceTheme(() => "light");

    added[0]();

    expect(colours()).toEqual(["#ffffff", "#ffffff"]);
  });

  it("unsubscribes when the app goes away", () => {
    const { added, removed } = deviceIs("dark");

    watchDeviceTheme(() => "system")();

    expect(removed).toEqual(added);
  });

  it("is a no-op on a browser with no media queries", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(() => watchDeviceTheme(() => "system")()).not.toThrow();
  });
});
