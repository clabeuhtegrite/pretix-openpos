import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { posEvents } = vi.hoisted(() => ({ posEvents: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, posEvents } };
});

import { eventDay } from "../events";
import { t } from "../i18n";
import type { Pairing, PosEvent, UnavailableEvent } from "../types";
import { EventButtons, OtherEvents, UnavailableEvents } from "./EventChoice";

/**
 * The pieces every screen that deals with events is built from: a list to
 * pick from, what cannot be picked and why, and the way out of an event that
 * will not open.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};
const festival: PosEvent = {
  slug: "festival", organizer: "demo", name: "Festival", currency: "EUR",
  testmode: false, date_from: "2026-09-19T12:00:00Z",
};
const gala: PosEvent = { ...festival, slug: "gala", name: "Gala", date_from: "2026-10-03T12:00:00Z" };
const bal: UnavailableEvent = { ...festival, slug: "bal", name: "Bal", date_from: null, reason: "plugin_disabled" };

beforeEach(() => {
  posEvents.mockResolvedValue({ results: [festival, gala] });
});

describe("the list of events", () => {
  it("gives each event its day, since the names are often the same", () => {
    render(<EventButtons events={[festival, gala]} onPick={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: new RegExp(eventDay(gala.date_from)) }).textContent,
    ).toContain("Gala");
  });

  it("says which one is a rehearsal", () => {
    render(<EventButtons events={[{ ...gala, testmode: true }]} onPick={vi.fn()} />);

    expect(screen.getByRole("button").textContent).toContain(t("testmode"));
  });

  it("hands back the event tapped", async () => {
    const onPick = vi.fn();
    render(<EventButtons events={[festival, gala]} onPick={onPick} />);

    await userEvent.setup().click(screen.getByRole("button", { name: /Gala/ }));

    expect(onPick).toHaveBeenCalledWith("gala");
  });
});

describe("the events that cannot be picked", () => {
  it("names those without Open POS, and where it is switched on", () => {
    render(<UnavailableEvents events={[bal]} />);

    expect(screen.getByText(t("events.pluginDisabled", { names: "Bal" }))).toBeDefined();
  });

  it("keeps the day in brackets, so the sentence does not end twice", () => {
    render(<UnavailableEvents events={[{ ...bal, date_from: gala.date_from }]} />);

    expect(
      screen.getByText(
        t("events.pluginDisabled", { names: `Bal (${eventDay(gala.date_from)})` }),
      ),
    ).toBeDefined();
  });

  it("names one for a reason this build does not know, without guessing it", () => {
    render(<UnavailableEvents events={[{ ...bal, reason: "something_new" }]} />);

    expect(screen.getByText(t("events.unavailable", { names: "Bal" }))).toBeDefined();
    expect(screen.queryByText(t("events.pluginDisabled", { names: "Bal" }))).toBeNull();
  });

  it("says nothing when there are none", () => {
    const { container } = render(<UnavailableEvents events={[]} />);

    expect(container.textContent).toBe("");
  });
});

describe("the way out of an event that will not open", () => {
  it("offers the device's other events, not the one it is stuck on", async () => {
    render(<OtherEvents pairing={pairing} onPick={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Gala/ })).toBeDefined();
    expect(screen.getByText(t("error.otherEvent"))).toBeDefined();
    expect(screen.queryByRole("button", { name: /Festival/ })).toBeNull();
  });

  it("switches on a tap", async () => {
    const onPick = vi.fn();
    render(<OtherEvents pairing={pairing} onPick={onPick} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /Gala/ }));

    expect(onPick).toHaveBeenCalledWith("gala");
  });

  it("is absent when there is no other event", async () => {
    posEvents.mockResolvedValue({ results: [festival] });
    const { container } = render(<OtherEvents pairing={pairing} onPick={vi.fn()} />);

    await waitFor(() => expect(posEvents).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("is absent when the list cannot be had", async () => {
    // Same network, same server: most likely the reason the event did not open
    // either. The screen already says so.
    posEvents.mockRejectedValue(new Error("offline"));
    const { container } = render(<OtherEvents pairing={pairing} onPick={vi.fn()} />);

    await waitFor(() => expect(posEvents).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
