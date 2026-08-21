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

import { t } from "../i18n";
import { formatMoney } from "../money";
import type { Pairing, PosEvent, SummaryResponse } from "../types";
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
    onRefresh: vi.fn(),
    onUnpair: vi.fn(),
    onClose: vi.fn(),
    onEventChange: vi.fn(),
  };
  const { container } = render(
    <SettingsPanel pairing={pairing} currency="EUR" cashier="Ana" {...handlers} {...props} />,
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
