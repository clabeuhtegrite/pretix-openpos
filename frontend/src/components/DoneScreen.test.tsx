import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { formatMoney } from "../money";
import type { SaleResult } from "../types";
import DoneScreen from "./DoneScreen";

/**
 * The screen between one customer and the next.
 *
 * Its whole job is knowing when to get out of the way. A till that clears
 * itself while the cashier still owes change loses the change; a till that
 * waits for a tap after every beer costs a second per customer, all evening.
 */

function sale(overrides: Partial<SaleResult> = {}): SaleResult {
  return {
    order: { code: "POS01", total: "10.00", url: null },
    journal_seq: 12,
    payment_type: "cash",
    cash_given: null,
    cash_change: null,
    datetime: "2026-08-16T22:02:21.000Z",
    replayed: false,
    checked_in: 1,
    checkin_errors: [],
    ...overrides,
  };
}

function show(overrides: Partial<SaleResult> = {}) {
  const onDismiss = vi.fn();
  const view = render(
    <DoneScreen sale={sale(overrides)} currency="EUR" onDismiss={onDismiss} />,
  );
  return { onDismiss, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what it says", () => {
  it("tells the door to let them in when the ticket was checked in", () => {
    show();

    expect(screen.getByText(t("done.admitted"))).toBeDefined();
  });

  it("just confirms the sale when nothing admits anyone", () => {
    show({ checked_in: 0 });

    expect(screen.getByText(t("done.sold"))).toBeDefined();
  });

  it("says so when the check-in did not go through", () => {
    // The customer is standing there with a ticket that will not scan; the
    // cashier has to know to wave them in by hand.
    show({ checked_in: 0, checkin_errors: ["Already redeemed"] });

    expect(screen.getByText(t("done.checkinFailed"))).toBeDefined();
  });

  it("shows the order code, the journal number and the total", () => {
    show();

    expect(screen.getByText(/POS01/)).toBeDefined();
    expect(screen.getByText(/#12/)).toBeDefined();
  });

  it("says a queued sale is queued instead of showing an order code", () => {
    // There is no order yet. Printing one would be a lie the cashier could
    // read out to a customer.
    show({ offline: true, order: { code: "", total: "10.00", url: null } });

    expect(screen.queryByText(/POS01/)).toBeNull();
    expect(screen.getByText(/kept on this till/)).toBeDefined();
  });
});

describe("the change to hand back", () => {
  it("is shown, large, when there is any", () => {
    show({ cash_given: "20.00", cash_change: "10.00" });

    expect(screen.getByText(t("done.change"))).toBeDefined();
  });

  it("is not shown for a card payment", () => {
    show({ payment_type: "card" });

    expect(screen.queryByText(t("done.change"))).toBeNull();
  });

  it("is not shown when the customer paid the exact amount", () => {
    show({ cash_given: "10.00", cash_change: "0.00" });

    expect(screen.queryByText(t("done.change"))).toBeNull();
  });
});

describe("getting out of the way", () => {
  it("clears itself after a few seconds when nothing is owed", () => {
    vi.useFakeTimers();
    const { onDismiss } = show();

    vi.advanceTimersByTime(6000);

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("waits while there is change to hand back", () => {
    // Clearing here is how a customer walks off without their coins.
    vi.useFakeTimers();
    const { onDismiss } = show({ cash_given: "20.00", cash_change: "10.00" });

    vi.advanceTimersByTime(60_000);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("waits while a failed check-in is unresolved", () => {
    vi.useFakeTimers();
    const { onDismiss } = show({ checked_in: 0, checkin_errors: ["Already redeemed"] });

    vi.advanceTimersByTime(60_000);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("waits when the sale is only queued, so the cashier sees that it is", () => {
    vi.useFakeTimers();
    const { onDismiss } = show({ offline: true });

    vi.advanceTimersByTime(60_000);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not fire after the screen has gone", () => {
    vi.useFakeTimers();
    const { onDismiss, unmount } = show();

    unmount();
    vi.advanceTimersByTime(60_000);

    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("moving on by hand", () => {
  it("takes a tap anywhere when the till is only waiting to be read", async () => {
    const user = userEvent.setup();
    const { onDismiss } = show({ checked_in: 1 });

    await user.click(screen.getByText(t("done.admitted")));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("ignores a stray tap while change is still owed", async () => {
    // A hand brushing the screen must not clear the amount to give back.
    const user = userEvent.setup();
    const { onDismiss } = show({ cash_given: "20.00", cash_change: "10.00" });

    await user.click(screen.getByText(t("done.change")));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("always moves on when the button is pressed", async () => {
    const user = userEvent.setup();
    const { onDismiss } = show({ cash_given: "20.00", cash_change: "10.00" });

    await user.click(screen.getByRole("button", { name: t("done.next") }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("a deposit handed back", () => {
  it("names the amount to count out when nothing was sold", () => {
    show({
      order: { code: "", total: "0.00", url: null },
      deposit_refund: "3.00",
      net_total: "-3.00",
      checked_in: 0,
    });

    expect(screen.getByText(t("done.giveBack"))).toBeDefined();
    expect(screen.getByText(formatMoney(300, "EUR"))).toBeDefined();
  });

  it("says a deposit was returned rather than that a sale was recorded", () => {
    show({
      order: { code: "", total: "0.00", url: null },
      deposit_refund: "3.00",
      net_total: "-3.00",
      checked_in: 0,
    });

    expect(screen.getByText(t("done.depositOnly"))).toBeDefined();
    expect(screen.queryByText(t("done.sold"))).toBeNull();
  });

  it("waits for the operator, because money is still owed", () => {
    vi.useFakeTimers();
    const { onDismiss } = show({
      order: { code: "", total: "0.00", url: null },
      deposit_refund: "3.00",
      net_total: "-3.00",
      checked_in: 0,
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not say the same thing three times over", () => {
    // Headline, amount, and a line repeating both is noise on the one screen
    // whose job is to be read at a glance.
    show({
      order: { code: "", total: "0.00", url: null },
      deposit_refund: "3.00",
      net_total: "-3.00",
      checked_in: 0,
    });

    expect(
      screen.queryByText(t("done.depositBack", { total: formatMoney(300, "EUR") })),
    ).toBeNull();
  });

  it("mentions it on a sale that netted positive too", () => {
    // The figures above are already net of it, and nothing else on the screen
    // would say it happened.
    show({
      order: { code: "POS01", total: "12.00", url: null },
      deposit_refund: "3.00",
      net_total: "9.00",
    });

    expect(
      screen.getByText(t("done.depositBack", { total: formatMoney(300, "EUR") })),
    ).toBeDefined();
    expect(screen.getByText(/POS01/)).toBeDefined();
  });
});
