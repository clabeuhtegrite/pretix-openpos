import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { posEvents, summary } = vi.hoisted(() => ({
  posEvents: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, posEvents, summary } };
});

import { t, tn } from "../i18n";
import { formatMoney } from "../money";
import { saveQueue } from "../storage";
import { eventDay } from "../events";
import { figures, noTakings } from "../test/takings";
import type { Pairing, PosEvent, QueuedSale, SummaryResponse, UnavailableEvent } from "../types";
import SettingsPanel from "./SettingsPanel";

/**
 * The panel behind the gear: who is on the till, what it has taken, and the two
 * buttons that can lose work — unpairing, and switching event. Both of the
 * things it reads from the server are conveniences, and neither may be allowed
 * to keep the operator from getting back to selling.
 */

const pairing: Pairing = {
  token: "tok",
  organizer: "demo",
  event: "festival",
  serial: "TILL1",
  deviceName: "Caisse bar",
};

const takings: SummaryResponse = noTakings({
  device: figures(12, "120.00", "80.00", "200.00"),
  event: figures(30, "300.00", "200.00", "500.00"),
  devices: [
    { name: "Caisse porte", serial: "TILL2", current: false, ...figures(18, "180.00", "120.00", "300.00") },
    { name: "Caisse bar", serial: "TILL1", current: true, ...figures(12, "120.00", "80.00", "200.00") },
  ],
});

const events: PosEvent[] = [
  { slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null },
  { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: true, date_from: null },
];
const bal: UnavailableEvent = {
  slug: "bal", organizer: "demo", name: "Bal", currency: "EUR", testmode: false,
  date_from: null, reason: "plugin_disabled",
};

function show(props: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const handlers = {
    onCashierChange: vi.fn(),
    onThemeChange: vi.fn(),
    onSoundChange: vi.fn(),
    onRefresh: vi.fn(),
    onUnpair: vi.fn(),
    onClose: vi.fn(),
    onEventChange: vi.fn(),
  };
  const { container } = render(
    <SettingsPanel
      pairing={pairing}
      currency="EUR"
      cashier="Ana"
      theme="system"
      sound
      {...handlers}
      {...props}
    />,
  );
  return { user: userEvent.setup(), container, ...handlers };
}

beforeEach(() => {
  posEvents.mockResolvedValue({ results: events });
  summary.mockResolvedValue(takings);
});

describe("the cashier", () => {
  it("shows who is on the till", () => {
    show();

    expect(screen.getByLabelText(t("settings.cashier"))).toHaveProperty("value", "Ana");
  });

  it("reports every keystroke, so a shift change is not lost on close", async () => {
    const { user, onCashierChange } = show({ cashier: "" });

    await user.type(screen.getByLabelText(t("settings.cashier")), "B");

    expect(onCashierChange).toHaveBeenCalledWith("B");
  });
});

describe("the appearance", () => {
  it("shows which palette the till is on", () => {
    show({ theme: "light" });

    expect(
      screen.getByRole("button", { name: t("settings.themeLight"), pressed: true }),
    ).toBeDefined();
  });

  it("hands the choice up so it can be saved", async () => {
    const { user, onThemeChange } = show({ theme: "system" });

    await user.click(screen.getByRole("button", { name: t("settings.themeDark") }));

    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("offers following the tablet as well as the two palettes", () => {
    show();

    for (const label of ["settings.themeSystem", "settings.themeLight", "settings.themeDark"] as const) {
      expect(screen.getByRole("button", { name: t(label) })).toBeDefined();
    }
  });
});

describe("the sound", () => {
  it("shows whether the till is making any", () => {
    show({ sound: false });

    expect(screen.getByRole("button", { name: t("settings.soundOff"), pressed: true })).toBeDefined();
    expect(screen.getByRole("button", { name: t("settings.soundOn"), pressed: false })).toBeDefined();
  });

  it("turns it off", async () => {
    const { user, onSoundChange } = show({ sound: true });

    await user.click(screen.getByRole("button", { name: t("settings.soundOff") }));

    expect(onSoundChange).toHaveBeenCalledWith(false);
  });

  it("turns it back on", async () => {
    const { user, onSoundChange } = show({ sound: false });

    await user.click(screen.getByRole("button", { name: t("settings.soundOn") }));

    expect(onSoundChange).toHaveBeenCalledWith(true);
  });

  it("says why a door would want it", async () => {
    // An iPhone cannot vibrate in a browser; this is the whole reason the
    // setting exists, and the one thing the operator cannot work out alone.
    show();

    expect(screen.getByText(t("settings.soundHelp"))).toBeDefined();
  });
});

describe("the takings", () => {
  it("are the event's, under the event's name for them", async () => {
    show();

    expect(await screen.findByText(t("summary.title"))).toBeDefined();
    expect(t("summary.title")).not.toMatch(/jour|today/i);
  });

  it("shows this device apart from the event", async () => {
    const { container } = show();

    await waitFor(() => expect(screen.getByText(t("summary.thisTill"))).toBeDefined());
    const lines = container.querySelectorAll(".panel > .takings-lines > li");
    expect(within(lines[0] as HTMLElement).getByText(formatMoney(20_000, "EUR"))).toBeDefined();
    expect(within(lines[1] as HTMLElement).getByText(formatMoney(50_000, "EUR"))).toBeDefined();
  });

  it("shows only the event's when the server reports no till of its own", async () => {
    summary.mockResolvedValue({ ...takings, device: null });
    show();

    await waitFor(() => expect(screen.getByText(t("summary.allTills"))).toBeDefined());
    expect(screen.queryByText(t("summary.thisTill"))).toBeNull();
  });

  it("names the date of a series, since the event field names only the series", async () => {
    summary.mockResolvedValue({
      ...takings,
      scope: {
        event: "Jeudis",
        series: true,
        subevent: { id: 3, name: "Scène ouverte", date_from: "2026-08-20T18:00:00Z" },
      },
    });
    show();

    expect(await screen.findByText(/Jeudis · Scène ouverte · /)).toBeDefined();
  });

  it("keeps the detail off this screen", async () => {
    // By product it runs as long as the menu, and the buttons underneath —
    // unpairing among them — would end up a long scroll away.
    show();

    await waitFor(() => expect(screen.getByText(t("summary.allTills"))).toBeDefined());
    expect(screen.queryByText(t("takings.byProduct"))).toBeNull();
    expect(screen.queryByText(/annul|cancell/i)).toBeNull();
  });

  it("opens the detail, and closing it comes back here", async () => {
    const { user, onClose } = show();

    await user.click(await screen.findByRole("button", { name: t("summary.detail") }));
    expect(screen.getByRole("heading", { name: t("takings.title"), level: 2 })).toBeDefined();
    expect(screen.getByText("Caisse porte")).toBeDefined();

    const closes = screen.getAllByRole("button", { name: t("settings.close") });
    await user.click(closes[closes.length - 1]);

    expect(screen.queryByRole("heading", { name: t("takings.title"), level: 2 })).toBeNull();
    expect(screen.getByText(t("settings.title"))).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the detail on a tap beside it", async () => {
    // The detail sits inside the settings in React's tree, so the tap on its
    // backdrop would otherwise go on to reach theirs and close both.
    const { user, container, onClose } = show();
    await user.click(await screen.findByRole("button", { name: t("summary.detail") }));

    await user.click(container.querySelector(".overlay-top") as HTMLElement);

    expect(screen.queryByRole("heading", { name: t("takings.title"), level: 2 })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks the server again from the detail", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("summary.detail") }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("attendance.refresh") })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    summary.mockResolvedValue({ ...takings, event: figures(31, "303.00", "200.00", "503.00") });

    await user.click(screen.getByRole("button", { name: t("attendance.refresh") }));

    expect(await screen.findAllByText(formatMoney(50_300, "EUR"))).not.toHaveLength(0);
    expect(summary).toHaveBeenCalledTimes(2);
  });

  it("does not lock the panel when the server will not say", async () => {
    summary.mockRejectedValue(new Error("offline"));
    show();

    await waitFor(() => expect(summary).toHaveBeenCalled());
    // Still fully usable: this is a report, not a gate.
    expect(screen.getByRole("button", { name: t("settings.close") })).toBeDefined();
    expect(screen.queryByRole("button", { name: t("summary.detail") })).toBeNull();
  });

  it("says the takings are on their way while they are", () => {
    summary.mockReturnValue(new Promise(() => {}));
    show();

    expect(screen.getByText(t("app.loading"))).toBeDefined();
  });

  it("says so, and offers another go, rather than three dots for ever", async () => {
    // This is the closing-time screen. At half past one a spinner that never
    // resolves is worse than a sentence saying what happened.
    summary.mockRejectedValue(new Error("offline"));
    const { user } = show();
    await screen.findByText(t("summary.failed"));
    summary.mockResolvedValue(takings);

    await user.click(screen.getByRole("button", { name: t("summary.retry") }));

    expect(await screen.findByText(t("summary.allTills"))).toBeDefined();
  });

  it("owns up to what this till has not managed to send", async () => {
    // The figures come from the server, so a sale encashed during a dropout
    // is not in them. Somebody comparing this screen with the drawer would
    // otherwise find a difference with nothing here to explain it.
    const queued: QueuedSale = {
      kind: "sale", id: "k1", at: "2026-08-16T22:00:00.000Z", event: "festival",
      positions: [], chargedTotal: "12.00", paymentType: "cash", cashGiven: "12.00",
      cashChange: "0.00", cashier: "Ana", admits: false, label: "1× Bière",
    };
    saveQueue([queued]);
    show();

    expect(
      await screen.findByText(
        tn("summary.queued", 1, { amount: formatMoney(1200, "EUR") }),
      ),
    ).toBeDefined();
  });
});

describe("the event switcher", () => {
  it("appears when this device may sell for more than one", async () => {
    show();

    await waitFor(() => expect(screen.getByLabelText(t("settings.event"))).toBeDefined());
  });

  it("names the event even when there is no other, and says where others are given", async () => {
    // It used to vanish altogether with a single event, and a device whose
    // other events were out of its reach then looked exactly like a panel
    // with the switch missing — which is what somebody came here to find.
    posEvents.mockResolvedValue({ results: [events[0]], unavailable: [] });
    show();

    expect(
      await screen.findByText(t("settings.eventOnly", { device: "Caisse bar" })),
    ).toBeDefined();
    expect(screen.getByText(t("settings.event"))).toBeDefined();
    expect(screen.getByText("Festival")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: t("settings.event") })).toBeNull();
  });

  it("takes an answer from a server that predates the list of the others", async () => {
    posEvents.mockResolvedValue({ results: [events[0]] });
    show();

    expect(
      await screen.findByText(t("settings.eventOnly", { device: "Caisse bar" })),
    ).toBeDefined();
  });

  it("names the events it cannot switch to, and why", async () => {
    // Open POS never ticked on the next evening: the device does reach it, so
    // pointing at the device's own access would send somebody the wrong way.
    posEvents.mockResolvedValue({ results: [events[0]], unavailable: [bal] });
    show();

    expect(
      await screen.findByText(t("events.pluginDisabled", { names: "Bal" })),
    ).toBeDefined();
    expect(screen.queryByText(t("settings.eventOnly", { device: "Caisse bar" }))).toBeNull();
  });

  it("names them beside a choice as well", async () => {
    posEvents.mockResolvedValue({ results: events, unavailable: [bal] });
    show();

    const select = await screen.findByLabelText(t("settings.event"));
    expect(within(select).queryByRole("option", { name: /Bal/ })).toBeNull();
    expect(screen.getByText(t("events.pluginDisabled", { names: "Bal" }))).toBeDefined();
  });

  it("gives each event its day, since the next one is usually a copy of the last", async () => {
    posEvents.mockResolvedValue({
      results: [events[0], { ...events[0], slug: "festival-2", date_from: "2026-10-03T12:00:00Z" }],
    });
    show();

    const select = await screen.findByLabelText(t("settings.event"));
    expect(within(select).getAllByRole("option")[1].textContent).toBe(
      `Festival · ${eventDay("2026-10-03T12:00:00Z")}`,
    );
  });

  it("says so when Open POS was switched off under the only event it has", async () => {
    posEvents.mockResolvedValue({ results: [], unavailable: [{ ...bal, slug: "festival", name: "Festival" }] });
    show();

    expect(
      await screen.findByText(t("events.pluginDisabled", { names: "Festival" })),
    ).toBeDefined();
    // Not "this device only has this event": it has none it can sell for.
    expect(screen.queryByText(t("settings.eventOnly", { device: "Caisse bar" }))).toBeNull();
  });

  it("does not claim another event while still open on one it can no longer sell for", async () => {
    // Open POS switched off under a running till. A select whose value is not
    // among its options shows the first one as if it were chosen.
    posEvents.mockResolvedValue({ results: [events[1]], unavailable: [{ ...bal, slug: "festival", name: "Festival" }] });
    show();

    const select = (await screen.findByLabelText(t("settings.event"))) as HTMLSelectElement;
    expect(select.value).toBe("festival");
    expect(within(select).getByRole("option", { name: "Festival" })).toHaveProperty("disabled", true);
  });

  it("marks an event that is in test mode", async () => {
    // Selling a night's tickets into test mode is a night's takings that do
    // not exist.
    show();

    const select = await screen.findByLabelText(t("settings.event"));
    expect(within(select).getByRole("option", { name: /Gala/ }).textContent).toContain(
      t("testmode"),
    );
  });

  it("switches on a choice", async () => {
    const { user, onEventChange } = show();
    const select = await screen.findByLabelText(t("settings.event"));

    await user.selectOptions(select, "gala");

    expect(onEventChange).toHaveBeenCalledWith("gala");
  });

  it("is simply absent when the list cannot be fetched", async () => {
    posEvents.mockRejectedValue(new Error("offline"));
    show();

    await waitFor(() => expect(posEvents).toHaveBeenCalled());
    expect(screen.queryByLabelText(t("settings.event"))).toBeNull();
    expect(screen.getByLabelText(t("settings.cashier"))).toBeDefined();
  });
});

describe("unpairing", () => {
  it("names the till, so the right one is unpaired", () => {
    show();

    expect(screen.getByRole("button", { name: new RegExp(pairing.serial) })).toBeDefined();
  });

  it("asks first", async () => {
    // There is no undo: it takes a new pairing code from the back office.
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user, onUnpair } = show();

    await user.click(screen.getByRole("button", { name: new RegExp(t("settings.unpair")) }));

    expect(confirmed).toHaveBeenCalledWith(t("settings.unpairConfirm"));
    expect(onUnpair).not.toHaveBeenCalled();
    confirmed.mockRestore();
  });

  it("goes ahead once confirmed", async () => {
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onUnpair } = show();

    await user.click(screen.getByRole("button", { name: new RegExp(t("settings.unpair")) }));

    expect(onUnpair).toHaveBeenCalledOnce();
    confirmed.mockRestore();
  });
});

describe("getting back to the till", () => {
  it("reloads the catalogue on demand", async () => {
    // The way a price edited in the back office reaches the door at once.
    const { user, onRefresh } = show();

    await user.click(screen.getByRole("button", { name: t("settings.refresh") }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows the reload under way, and takes no second tap", () => {
    // The panel used to close the moment the button was pressed, and the
    // till then looked exactly as it had, whether the catalogue came or not.
    show({ refreshing: true });

    const reloading = screen.getByRole("button", { name: t("settings.refreshing") });
    expect(reloading).toHaveProperty("disabled", true);
    expect(reloading.getAttribute("aria-busy")).toBe("true");
  });

  it("says so when the reload did not reach the server", () => {
    show({ refreshFailed: true });

    expect(screen.getByText(t("settings.refreshFailed"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("settings.refresh") })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("drops that sentence while it tries again", () => {
    show({ refreshFailed: true, refreshing: true });

    expect(screen.queryByText(t("settings.refreshFailed"))).toBeNull();
  });

  it("closes on the button", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a tap outside the panel", async () => {
    const { user, onClose, container } = show();

    await user.click(container.querySelector(".overlay") as HTMLElement);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open on a tap inside it", async () => {
    // Typing a cashier name must not dismiss the panel under the keyboard.
    const { user, onClose } = show();

    await user.click(screen.getByText(t("settings.title")));

    expect(onClose).not.toHaveBeenCalled();
  });
});
