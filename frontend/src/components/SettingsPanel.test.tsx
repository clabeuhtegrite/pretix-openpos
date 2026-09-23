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

import { locale, t } from "../i18n";
import { formatMoney } from "../money";
import { saveQueue } from "../storage";
import { eventDay } from "../events";
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

const takings: SummaryResponse = {
  since: "2026-08-16T04:00:00Z",
  device: { count: 12, cancellations: 0, cash: "120.00", card: "80.00", total: "200.00" },
  event: { count: 30, cancellations: 0, cash: "300.00", card: "200.00", total: "500.00" },
};

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
  it("shows this till apart from the event", async () => {
    const { container } = show();

    await waitFor(() => expect(screen.getByText(t("summary.thisTill"))).toBeDefined());
    const rows = container.querySelectorAll("tbody tr");
    expect(within(rows[0] as HTMLElement).getByText(formatMoney(20_000, "EUR"))).toBeDefined();
    expect(within(rows[1] as HTMLElement).getByText(formatMoney(50_000, "EUR"))).toBeDefined();
  });

  it("shows only the event's when the server reports no till of its own", async () => {
    summary.mockResolvedValue({ ...takings, device: null });
    show();

    await waitFor(() => expect(screen.getByText(t("summary.allTills"))).toBeDefined());
    expect(screen.queryByText(t("summary.thisTill"))).toBeNull();
  });

  it("says out loud that cancellations are already netted off", async () => {
    // A drawer short by exactly a cancelled sale is not short at all, and
    // whoever counts it at 2am should not have to work that out.
    summary.mockResolvedValue({ ...takings, event: { ...takings.event, cancellations: 2 } });
    show();

    await waitFor(() =>
      expect(screen.getByText(t("summary.cancellations", { n: 2 }))).toBeDefined(),
    );
  });

  it("says out loud that deposits handed back are netted off too", async () => {
    // A night of returned cups is money out of the drawer with not one sale
    // to show for it, so the figure above can look wrong when it is right.
    summary.mockResolvedValue({
      ...takings,
      event: { ...takings.event, deposit_refunds: 7 },
    });
    show();

    await waitFor(() =>
      expect(screen.getByText(t("summary.depositRefunds", { n: 7 }))).toBeDefined(),
    );
  });

  it("keeps quiet when there were none", async () => {
    show();

    await waitFor(() => expect(screen.getByText(t("summary.allTills"))).toBeDefined());
    expect(screen.queryByText(/annul|cancell/i)).toBeNull();
  });

  it("does not lock the panel when the server will not say", async () => {
    summary.mockRejectedValue(new Error("offline"));
    show();

    await waitFor(() => expect(summary).toHaveBeenCalled());
    // Still fully usable: this is a report, not a gate.
    expect(screen.getByRole("button", { name: t("settings.close") })).toBeDefined();
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

  it("names the till day it is reporting on", async () => {
    // A till day starts at six in the morning, so a bar that closes at 5:40
    // and counts the drawer at 6:15 reads zeros everywhere — true, and
    // useless without this line.
    const clock = new Date(takings.since).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    show();

    expect(await screen.findByText(t("summary.since", { time: clock }))).toBeDefined();
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
        t("summary.queued", { n: 1, amount: formatMoney(1200, "EUR") }),
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

describe("money paid back on another day's sale", () => {
  it("says how much, because nothing else on this screen would", async () => {
    // Somebody came back a week later and was refunded out of tonight's
    // drawer. The takings are short by exactly that much — correctly — and a
    // volunteer counting cash cannot tell that from a miscount.
    summary.mockResolvedValue({
      ...takings,
      event: {
        ...takings.event,
        cash: "270.00",
        total: "470.00",
        earlier_days: { count: 1, total: "-30.00" },
      },
    });
    show();

    expect(
      await screen.findByText(
        t("summary.earlierDays", { n: 1, amount: formatMoney(3000, "EUR") }),
      ),
    ).toBeTruthy();
  });

  it("says nothing on an ordinary evening", async () => {
    // A line reading "0,00 paid back on 0 earlier sales" on every closing
    // screen is noise that trains people to skip the section that matters.
    summary.mockResolvedValue(takings);
    show();

    await screen.findByText(t("summary.allTills"));
    expect(screen.queryByText(/earlier day|autre jour/)).toBeNull();
  });
});

describe("a till with a cash drawer", () => {
  // Its cash is counted blind when the drawer closes, so the figure the count
  // would be checked against is not handed out one tap away from the count.
  const blind: SummaryResponse = {
    since: "2026-08-16T04:00:00Z",
    device: { count: 12, cancellations: 0, cash: null, card: "80.00", total: null },
    event: { count: 30, cancellations: 0, cash: null, card: "200.00", total: null },
    drawer: { name: "Bar" },
  };

  it("shows a dash where the cash and the total would be, and says why", async () => {
    summary.mockResolvedValue(blind);
    const { container } = show();

    expect(await screen.findByText(t("summary.drawerHidden", { name: "Bar" }))).toBeDefined();
    const table = container.querySelector("table.takings") as HTMLElement;
    expect(within(table).getAllByText("—")).toHaveLength(4);
    expect(within(table).getByText(formatMoney(8000, "EUR"))).toBeDefined();
    expect(within(table).queryByText(formatMoney(0, "EUR"))).toBeNull();
  });

  it("says nothing of a drawer on a till that has none", async () => {
    show();

    await screen.findByText(t("summary.thisTill"));
    expect(screen.queryByText(t("summary.drawerHidden", { name: "Bar" }))).toBeNull();
  });
});
