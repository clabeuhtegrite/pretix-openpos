import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The message catalogue.
 *
 * The language is decided once, at import, from the browser's own setting — so
 * every test here imports the module fresh under the navigator it wants.
 */

type I18n = typeof import("./i18n");

async function withLanguage(language: string): Promise<I18n> {
  vi.resetModules();
  vi.stubGlobal("navigator", { language });
  return import("./i18n");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("choosing the language", () => {
  it("speaks French to a French browser", async () => {
    const { t, locale } = await withLanguage("fr-FR");

    expect(locale).toBe("fr");
    expect(t("payment.cash")).toBe("Espèces");
  });

  it("does not care how the tag is cased", async () => {
    const { locale } = await withLanguage("FR-ch");

    expect(locale).toBe("fr");
  });

  it("falls back to English for anything else", async () => {
    const { t, locale } = await withLanguage("de-DE");

    expect(locale).toBe("en");
    expect(t("payment.cash")).toBe("Cash");
  });

  it("does not need a navigator at all", async () => {
    // Server-side rendering is not a thing here, but a test runner without a
    // DOM is, and a catalogue that throws on import takes the whole app with it.
    vi.resetModules();
    vi.stubGlobal("navigator", undefined);

    const { locale } = await import("./i18n");

    expect(locale).toBe("en");
  });
});

describe("t", () => {
  it("fills a placeholder in", async () => {
    const { t } = await withLanguage("en");

    expect(t("sale.left", { n: 3 })).toBe("3 left");
  });

  it("fills every placeholder of a message that has several", async () => {
    const { t } = await withLanguage("fr-FR");

    expect(t("history.cancelledMeta", { order: "POS01", total: "12,00 €" })).toBe(
      "POS01 · 12,00 € avoirés",
    );
  });

  it("leaves a placeholder alone when nothing was passed for it", async () => {
    const { t } = await withLanguage("en");

    expect(t("sale.left")).toBe("{n} left");
  });

  it("takes numbers as readily as strings", async () => {
    const { t } = await withLanguage("en");

    expect(t("summary.cancellations", { n: 2 })).toContain("2");
  });
});

describe("the French catalogue", () => {
  it("translates every string the English one has", async () => {
    // A string added to English and forgotten in French does not fail the
    // build and does not throw: it silently puts an English word on a French
    // till, in the middle of a sale, where nobody is going to file a bug.
    const { MESSAGES } = await import("./i18n");
    const missing = Object.keys(MESSAGES.en).filter(
      (key) => !(key in MESSAGES.fr),
    );

    expect(missing).toEqual([]);
  });

  it("has no string English does not have", async () => {
    // The other direction is a key that was renamed on one side only: dead in
    // French, and English wherever it is actually used.
    const { MESSAGES } = await import("./i18n");
    const english: Record<string, string> = MESSAGES.en;
    const extra = Object.keys(MESSAGES.fr).filter((key) => !(key in english));

    expect(extra).toEqual([]);
  });

  it("leaves no string untranslated by copying the English one", async () => {
    // Not a rule that can be absolute — "Total" is "Total" — so this pins the
    // ones that are legitimately identical and fails on a new one.
    const { MESSAGES } = await import("./i18n");
    const french: Record<string, string> = MESSAGES.fr;
    const identical = Object.entries(MESSAGES.en)
      .filter(([key, value]) => french[key] === value)
      .map(([key]) => key);

    expect(identical.sort()).toMatchSnapshot();
  });
});
