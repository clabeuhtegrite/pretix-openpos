/**
 * Which palette the till wears.
 *
 * Three settings, not two. "system" is the default and follows the tablet,
 * which is the only one of the three that is right on a device nobody has
 * configured; the other two are for the venue that knows better than its
 * device — a bar in daylight whose iPads are all still on dark, a back room
 * whose iPads are all still on light.
 *
 * The choice is written to `data-theme` on <html> and the palettes live in
 * styles.css, so switching costs one attribute and never a re-render. Only the
 * browser chrome has to be told separately, which is what the theme-color
 * meta tags below are for: on an installed PWA that colour is the status bar,
 * and a dark bar over a white till looks like a rendering fault.
 */

const KEY = "openpos.theme.v1";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * Status-bar colour per palette.
 *
 * --surface rather than --bg: on an installed app this is the band directly
 * above the topbar, and matching the topbar makes it disappear into it.
 * Kept in step with styles.css by hand — two values, changed about never.
 */
const CHROME: Record<"light" | "dark", string> = {
  light: "#ffffff",
  dark: "#1b2130",
};

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    // Anything else — an older build's value, a hand-edited key — falls back
    // to following the device rather than to a palette nobody asked for.
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage refused. The theme still applies for this session; it just will
    // not survive a relaunch, which is not worth interrupting a service for.
  }
}

/** Whether the device itself is asking for light. */
function deviceWantsLight(): boolean {
  return Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches);
}

/** The palette actually on screen, once "system" has been resolved. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return deviceWantsLight() ? "light" : "dark";
}

/**
 * Point the browser chrome at the palette on screen.
 *
 * The shell ships two theme-color tags, one per `prefers-color-scheme`, so the
 * status bar is already right before any JavaScript runs. An explicit choice
 * overrides the device, so both tags are pinned to the same colour; going back
 * to "system" hands each one its own colour again.
 */
function paintChrome(theme: Theme): void {
  const tags = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  for (const tag of tags) {
    // getAttribute, not .media: the IDL property is newer than the attribute
    // and is missing in jsdom, so reading it would make this work everywhere
    // except under test.
    const media = tag.getAttribute("media") ?? "";
    const scoped = media.includes("light") ? "light" : media.includes("dark") ? "dark" : null;
    // A tag scoped to a device setting keeps that setting's colour while the
    // till follows the device. One scoped to nothing — or any tag at all once
    // a palette has been chosen — is told what is actually on screen.
    tag.content = CHROME[theme === "system" && scoped ? scoped : resolveTheme(theme)];
  }
}

/**
 * Put a theme on screen.
 *
 * "system" removes the attribute rather than writing it: the media query in
 * styles.css is then the only thing deciding, which is also what a device that
 * switches appearance at sunset needs — nothing here re-runs for that.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  paintChrome(theme);
}

/**
 * Keep the chrome in step while the till follows the device.
 *
 * The palette itself needs no listener — CSS re-evaluates its own media query
 * — but the theme-color tags do not, because the explicit choice may have
 * pinned them. Returns an unsubscribe function.
 */
export function watchDeviceTheme(current: () => Theme): () => void {
  const query = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!query?.addEventListener) return () => {};
  const onChange = () => paintChrome(current());
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
