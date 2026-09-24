import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t, tn } from "../i18n";
import { formatMoney } from "../money";
import { figures, noTakings } from "../test/takings";
import type { SummaryResponse } from "../types";
import TakingsPanel, { scopeLabel } from "./TakingsPanel";

/**
 * What the event took, as it is read at closing time.
 *
 * The figures come from the server, which guarantees they add up; what this
 * screen owes is to show every one of them, under the right name, and to say
 * the things a figure alone cannot — that cancellations are already netted
 * off, that deposits are not sales, that test money is not money.
 */

const euros = (cents: number) => formatMoney(cents, "EUR");

const evening: SummaryResponse = noTakings({
  device: figures(3, "12.00", "8.00", "20.00"),
  event: figures(5, "31.00", "8.00", "39.00"),
  categories: [
    {
      id: 1, name: "Bar", count: 6, total: "20.00", items: [
        { item: 10, variation: null, name: "Bière", variation_name: null, count: 4, total: "12.00" },
        { item: 11, variation: 111, name: "Vin", variation_name: "Rouge", count: 2, total: "8.00" },
      ],
    },
    {
      id: null, name: null, count: 1, total: "17.00", items: [
        { item: 99, variation: null, name: "Divers", variation_name: null, count: 1, total: "17.00" },
      ],
    },
  ],
  deposits: {
    taken: { count: 6, total: "6.00" },
    returned: { count: 4, total: "-4.00" },
    total: "2.00",
  },
  devices: [
    { name: "Caisse porte", serial: "TILL2", current: false, ...figures(2, "19.00", "0.00", "19.00") },
    { name: "Caisse bar", serial: "TILL1", current: true, ...figures(3, "12.00", "8.00", "20.00") },
  ],
  nights: [{ date: "2026-08-16", ...figures(5, "31.00", "8.00", "39.00") }],
});

function show(props: Partial<Parameters<typeof TakingsPanel>[0]> = {}) {
  const handlers = { onRefresh: vi.fn(), onClose: vi.fn() };
  const view = render(
    <TakingsPanel
      summary={evening}
      failed={false}
      busy={false}
      currency="EUR"
      queued={{ count: 0, cashCents: 0 }}
      {...handlers}
      {...props}
    />,
  );
  return { user: userEvent.setup(), ...view, ...handlers };
}

describe("the figures at the top", () => {
  it("are the total, cash, card and how many sales", () => {
    const { container } = show();
    const top = container.querySelector(".takings-figures") as HTMLElement;

    expect(within(top).getByText(euros(3900))).toBeDefined();
    expect(within(top).getByText(euros(3100))).toBeDefined();
    expect(within(top).getByText(euros(800))).toBeDefined();
    expect(within(top).getByText(tn("takings.salesCount", 5))).toBeDefined();
  });

  it("name the event they are about", () => {
    show();

    expect(screen.getByText("Festival")).toBeDefined();
  });
});

describe("by product", () => {
  it("lists every product under its category, with its quantity", () => {
    show();

    const bar = screen.getByRole("rowheader", { name: "Bar" }).closest("tbody") as HTMLElement;
    const beer = within(bar).getByText("Bière").closest("tr") as HTMLElement;
    expect(within(beer).getByText("4")).toBeDefined();
    expect(within(beer).getByText(euros(1200))).toBeDefined();
    expect(within(bar).getByText(euros(2000))).toBeDefined();
  });

  it("names an option after its product", () => {
    show();

    expect(screen.getByText("Vin · Rouge")).toBeDefined();
  });

  it("gathers what has no category under a name of its own", () => {
    show();

    expect(screen.getByRole("rowheader", { name: t("takings.uncategorised") })).toBeDefined();
  });

  it("says where money no product accounts for comes from", () => {
    show({ summary: { ...evening, unallocated: "5.00" } });

    expect(screen.getByText(t("takings.unallocated", { amount: euros(500) }))).toBeDefined();
  });
});

describe("the deposits", () => {
  it("are kept apart from the products, taken and handed back side by side", () => {
    show();

    const taken = screen.getByText(t("takings.depositsTaken")).closest("tr") as HTMLElement;
    expect(within(taken).getByText("6")).toBeDefined();
    const back = screen.getByText(t("takings.depositsReturned")).closest("tr") as HTMLElement;
    expect(within(back).getByText(euros(-400))).toBeDefined();
    const balance = screen.getByText(t("takings.depositsBalance")).closest("tr") as HTMLElement;
    expect(within(balance).getByText(euros(200))).toBeDefined();
  });

  it("are not mentioned on an evening without any", () => {
    show({ summary: { ...evening, deposits: null } });

    expect(screen.queryByText(t("takings.deposits"))).toBeNull();
  });
});

describe("by device", () => {
  it("gives every device its line and marks the one in hand", () => {
    show();

    const mine = screen.getByText("Caisse bar").closest("li") as HTMLElement;
    expect(within(mine).getByText(`· ${t("attendance.thisDevice")}`)).toBeDefined();
    expect(within(mine).getByText(euros(2000))).toBeDefined();
    const other = screen.getByText("Caisse porte").closest("li") as HTMLElement;
    expect(within(other).queryByText(`· ${t("attendance.thisDevice")}`)).toBeNull();
  });

  it("calls what no device wrote the back office", () => {
    show({
      summary: {
        ...evening,
        devices: [{ name: null, serial: null, current: false, ...figures(0, "0.00", "5.00", "5.00") }],
      },
    });

    expect(screen.getByText(t("attendance.backOffice"))).toBeDefined();
  });
});

describe("by evening", () => {
  it("is left out when the event ran one evening, where it would repeat the total", () => {
    show();

    expect(screen.queryByText(t("takings.byNight"))).toBeNull();
  });

  it("splits an event that ran several", () => {
    show({
      summary: {
        ...evening,
        nights: [
          { date: "2026-08-15", ...figures(2, "10.00", "0.00", "10.00") },
          { date: "2026-08-16", ...figures(3, "21.00", "8.00", "29.00") },
        ],
      },
    });

    expect(screen.getByText(t("takings.byNight"))).toBeDefined();
    expect(screen.getByText(euros(2900))).toBeDefined();
  });
});

describe("what the figures alone do not say", () => {
  it("that cancellations are already netted off, and how much they gave back", () => {
    show({
      summary: {
        ...evening,
        event: figures(5, "31.00", "8.00", "39.00", { cancellations: 2, cancelled_total: "-15.00" }),
      },
    });

    expect(
      screen.getByText(tn("takings.cancelled", 2, { amount: euros(-1500) })),
    ).toBeDefined();
  });

  it("nothing about cancellations on an evening without any", () => {
    show();

    expect(screen.queryByText(/sales? cancelled|ventes? annulées?/i)).toBeNull();
  });

  it("that test money is counted nowhere", () => {
    show({ summary: { ...evening, testmode: figures(1, "9.00", "0.00", "9.00") } });

    expect(screen.getByText(tn("takings.testmode", 1, { amount: euros(900) }))).toBeDefined();
  });

  it("what this device holds and has not sent", () => {
    show({ queued: { count: 2, cashCents: 700 } });

    expect(screen.getByText(tn("summary.queued", 2, { amount: euros(700) }))).toBeDefined();
  });

  it("that each date of a series has takings of its own", () => {
    show({
      summary: {
        ...evening,
        scope: {
          event: "Jeudis", series: true,
          subevent: { id: 3, name: "Scène ouverte", date_from: "2026-08-20T18:00:00Z" },
        },
      },
    });

    expect(screen.getByText(new RegExp(t("takings.scopeSeries").slice(0, 30)))).toBeDefined();
  });
});

describe("an event with nothing sold yet", () => {
  it("says so rather than drawing empty tables", () => {
    show({ summary: noTakings() });

    expect(screen.getByText(t("takings.empty"))).toBeDefined();
    expect(screen.queryByText(t("takings.byProduct"))).toBeNull();
  });
});

describe("while the server has not answered", () => {
  it("says it is loading", () => {
    show({ summary: null, busy: true });

    expect(screen.getAllByText(t("takings.loading"))).not.toHaveLength(0);
  });

  it("says it could not ask, and offers another go", async () => {
    const { user, onRefresh } = show({ summary: null, failed: true });

    expect(screen.getByText(t("summary.failed"))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("summary.retry") }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("the panel", () => {
  it("asks again on Refresh, and not twice at once", async () => {
    const { user, onRefresh, rerender } = show();

    await user.click(screen.getByRole("button", { name: t("attendance.refresh") }));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(
      <TakingsPanel
        summary={evening}
        failed={false}
        busy
        currency="EUR"
        queued={{ count: 0, cashCents: 0 }}
        onRefresh={onRefresh}
        onClose={vi.fn()}
      />,
    );
    const refreshing = screen.getByRole("button", { name: t("takings.loading") });
    expect(refreshing).toHaveProperty("disabled", true);
    expect(refreshing.getAttribute("aria-busy")).toBe("true");
  });

  it("closes on a tap beside it, and keeps the tap to itself", async () => {
    const outside = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <div onClick={outside}>
        <TakingsPanel
          summary={evening}
          failed={false}
          busy={false}
          currency="EUR"
          queued={{ count: 0, cashCents: 0 }}
          onRefresh={vi.fn()}
          onClose={onClose}
        />
      </div>,
    );

    await userEvent.setup().click(container.querySelector(".overlay") as HTMLElement);

    expect(onClose).toHaveBeenCalledOnce();
    expect(outside).not.toHaveBeenCalled();
  });

  it("stays open on a tap inside it", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByText(t("takings.byProduct")));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("scopeLabel", () => {
  it("is the event's name for a plain event", () => {
    expect(scopeLabel({ event: "Gala", series: false, subevent: null })).toBe("Gala");
  });

  it("adds the date of a series, and its name when it has one of its own", () => {
    const label = scopeLabel({
      event: "Jeudis", series: true,
      subevent: { id: 3, name: "Scène ouverte", date_from: "2026-08-20T18:00:00Z" },
    });

    expect(label).toMatch(/^Jeudis · Scène ouverte · .+/);
  });

  it("does not repeat the series' name when the date carries the same", () => {
    const label = scopeLabel({
      event: "Jeudis", series: true,
      subevent: { id: 3, name: "Jeudis", date_from: "2026-08-20T18:00:00Z" },
    });

    expect(label).not.toMatch(/Jeudis · Jeudis/);
  });

  it("says all dates when the series had none to pick", () => {
    expect(scopeLabel({ event: "Jeudis", series: true, subevent: null })).toBe(
      `Jeudis · ${t("takings.allDates")}`,
    );
  });
});
