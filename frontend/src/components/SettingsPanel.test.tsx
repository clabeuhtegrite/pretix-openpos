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
import type { Pairing, PosEvent, QueuedSale, SummaryResponse } from "../types";
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

function show(props: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const handlers = {
    onCashierChange: vi.fn(),
    onThemeChange: vi.fn(),
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

  it("stays out of the way when there is only one", async () => {
    posEvents.mockResolvedValue({ results: [events[0]] });
    show();

    await waitFor(() => expect(posEvents).toHaveBeenCalled());
    expect(screen.queryByLabelText(t("settings.event"))).toBeNull();
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
