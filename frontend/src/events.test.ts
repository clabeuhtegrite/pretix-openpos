import { describe, expect, it } from "vitest";

import { eventDay, eventLabel } from "./events";
import { t } from "./i18n";
import type { PosEvent } from "./types";

/**
 * How an event is named in a list of events.
 *
 * The next evening is usually a copy of the last one, name included, so the
 * day is what tells two entries apart.
 */

const evening: PosEvent = {
  slug: "soiree", organizer: "demo", name: "Soirée", currency: "EUR",
  testmode: false, date_from: "2026-09-19T12:00:00Z",
};
const september = new Date("2026-09-22T12:00:00Z");

describe("eventDay", () => {
  it("gives the day without the year when it is this year", () => {
    const day = eventDay(evening.date_from, september);

    expect(day).toContain("19");
    expect(day).not.toContain("2026");
  });

  it("gives the year when it is not this one", () => {
    // Otherwise last year's evening and this year's read as the same one.
    expect(eventDay("2025-09-20T12:00:00Z", september)).toContain("2025");
  });

  it("says nothing rather than something wrong", () => {
    expect(eventDay(null)).toBe("");
    expect(eventDay("not a date")).toBe("");
  });
});

describe("eventLabel", () => {
  it("puts the day after the name", () => {
    expect(eventLabel(evening)).toBe(`Soirée · ${eventDay(evening.date_from)}`);
  });

  it("says when an event is a rehearsal", () => {
    // Selling a night's tickets into test mode is a night's takings that do
    // not exist.
    expect(eventLabel({ ...evening, date_from: null, testmode: true })).toBe(
      `Soirée · ${t("testmode")}`,
    );
  });

  it("is the bare name when there is nothing to add", () => {
    expect(eventLabel({ ...evening, date_from: null })).toBe("Soirée");
  });
});
