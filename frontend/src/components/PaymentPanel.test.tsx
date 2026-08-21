import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { formatMoney } from "../money";
import PaymentPanel from "./PaymentPanel";

/**
 * Where the money changes hands.
 *
 * The arithmetic itself is settlement.ts' job and is tested there. What is
 * tested here is the panel around it: that the keypad reads the way a till
 * keypad reads, that a short payment cannot be confirmed, and that the figure
 * the operator counts out is the one the server is told about.
 */

const DENOMINATIONS = ["5.00", "10.00", "20.00", "50.00"];

function show(props: Partial<Parameters<typeof PaymentPanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(
    <PaymentPanel
      totalCents={1234}
      currency="EUR"
      denominations={DENOMINATIONS}
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  const user = userEvent.setup();
  const type = async (digits: string) => {
    for (const digit of digits) {
      await user.click(screen.getByRole("button", { name: digit }));
    }
  };
  const confirm = () =>
    within(container.querySelector(".pay-actions") as HTMLElement).getByRole("button", {
      name: new RegExp(`${t("payment.confirm")}|${t("payment.cardConfirm")}|${t("payment.working")}`),
    });
  // "Due" and "Received" can show the same amount, so each is read from its
  // own row rather than from the panel at large.
  const row = (label: string) =>
    within(screen.getByText(label).parentElement as HTMLElement);
  return { user, type, confirm, row, onConfirm, onCancel, container };
}

describe("the keypad", () => {
  it("reads digits as cents, the way a till does", async () => {
    // 1-2-3-4 is 12.34. There is no decimal point to fumble mid-queue.
    const { type, row } = show();

    await type("1234");

    expect(row(t("payment.received")).getByText(formatMoney(1234, "EUR"))).toBeDefined();
  });

  it("takes a double zero in one tap", async () => {
    const { user, type, row } = show();

    await type("2");
    await user.click(screen.getByRole("button", { name: "00" }));

    expect(row(t("payment.received")).getByText(formatMoney(200, "EUR"))).toBeDefined();
  });

  it("does not let a slip of the finger leave a leading zero", async () => {
    // A stray 0 before the amount would otherwise read as ten times too much.
    const { type, row } = show();

    await type("0500");

    expect(row(t("payment.received")).getByText(formatMoney(500, "EUR"))).toBeDefined();
  });

  it("stops at eight digits rather than overflowing the display", async () => {
    const { type, row } = show();

    await type("123456789");

    expect(row(t("payment.received")).getByText(formatMoney(12_345_678, "EUR"))).toBeDefined();
  });

  it("clears on the backspace", async () => {
    const { user, type } = show();
    await type("1234");

    await user.click(screen.getByRole("button", { name: "clear" }));

    // Back to nothing received, and therefore no change to count.
    expect(screen.queryByText(t("payment.change"))).toBeNull();
  });

  it("fills in the exact amount in one tap", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: t("payment.exact") }));

    const change = screen.getByText(t("payment.change")).parentElement as HTMLElement;
    expect(within(change).getByText(formatMoney(0, "EUR"))).toBeDefined();
  });

  it("offers the notes that are actually in circulation", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: formatMoney(2000, "EUR") }));

    const change = screen.getByText(t("payment.change")).parentElement as HTMLElement;
    expect(within(change).getByText(formatMoney(766, "EUR"))).toBeDefined();
  });
});

describe("what may be confirmed", () => {
  it("refuses a payment that does not cover the total", async () => {
    const { type, confirm } = show();

    await type("1000");

    expect(confirm()).toHaveProperty("disabled", true);
  });

  it("allows it as soon as it does", async () => {
    const { type, confirm } = show();

    await type("2000");

    expect(confirm()).toHaveProperty("disabled", false);
  });

  it("tells the server what was actually handed over", async () => {
    const { type, user, confirm, onConfirm } = show();

    await type("2000");
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("cash", "20.00");
  });

  it("takes a confirmation with nothing typed as the exact amount", async () => {
    // The commonest case at a bar: the customer hands over the coins and the
    // cashier presses confirm without counting them into the till.
    const { user, confirm, onConfirm } = show();

    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("cash", null);
  });

  it("goes back without recording anything", async () => {
    const { user, onCancel, onConfirm } = show();

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("paying by card", () => {
  it("puts the keypad away", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
  });

  it("tells the cashier to charge the terminal", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByText(t("payment.cardPrompt"))).toBeDefined();
  });

  it("records no cash and no change", async () => {
    const { user, confirm, onConfirm } = show();

    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("card", null);
    expect(screen.queryByText(t("payment.change"))).toBeNull();
  });

  it("marks which method is selected", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByRole("button", { name: t("payment.card") }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: t("payment.cash") }).getAttribute("aria-pressed"))
      .toBe("false");
  });
});

describe("a sale being corrected", () => {
  const credit = { amountCents: 1000, order: "POS01" };

  it("shows what was already taken back off the customer", () => {
    show({ credit });

    expect(screen.getByText(`−${formatMoney(1000, "EUR")}`)).toBeDefined();
  });

  it("asks only for the difference when the new order costs more", () => {
    show({ credit });

    const line = screen.getByText(t("payment.stillDue")).parentElement as HTMLElement;
    expect(within(line).getByText(formatMoney(234, "EUR"))).toBeDefined();
  });

  it("says how much to give back when it costs less", () => {
    // Nobody counts 10 € across the counter to be handed 7.66 € straight back.
    show({ credit: { amountCents: 2000, order: "POS01" } });

    const line = screen.getByText(t("payment.giveBack")).parentElement as HTMLElement;
    expect(within(line).getByText(formatMoney(766, "EUR"))).toBeDefined();
  });

  it("puts the keypad away when the credit covers the whole order", () => {
    show({ credit: { amountCents: 2000, order: "POS01" } });

    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(screen.getByText(t("payment.coveredByCredit"))).toBeDefined();
  });

  it("records the credit as part of what funded the order", async () => {
    // The order is still worth its full total, and the journal has to say so.
    const { user, confirm, onConfirm } = show({ credit });

    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("cash", "12.34");
  });

  it("adds the cash to the credit when the customer tops it up", async () => {
    const { type, user, confirm, onConfirm } = show({ credit });

    await type("500");
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("cash", "15.00");
  });

  it("tells the cashier to refund the card, with the amount", async () => {
    const { user } = show({ credit: { amountCents: 2000, order: "POS01" } });

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(
      screen.getByText(t("payment.cardRefundPrompt", { amount: formatMoney(766, "EUR") })),
    ).toBeDefined();
  });

  it("tells it to charge the difference when there is one", async () => {
    const { user } = show({ credit });

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(
      screen.getByText(t("payment.cardChargePrompt", { amount: formatMoney(234, "EUR") })),
    ).toBeDefined();
  });
});

describe("while the server is being asked", () => {
  it("says what it is doing", () => {
    show({ busy: true });

    expect(screen.getByText(t("payment.working"))).toBeDefined();
  });

  it("takes no second press of confirm", () => {
    // Two orders for one customer is the failure this prevents.
    const { confirm } = show({ busy: true });

    expect(confirm()).toHaveProperty("disabled", true);
  });

  it("takes no change to the amount either", () => {
    show({ busy: true });

    expect(screen.getByRole("button", { name: "1" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: t("payment.exact") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("cannot be backed out of half-way", () => {
    show({ busy: true });

    expect(screen.getByRole("button", { name: t("payment.back") })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("when the server refuses", () => {
  it("says why, above the keypad, without clearing what was typed", () => {
    show({ error: "This product is not on sale here." });

    expect(screen.getByText("This product is not on sale here.")).toBeDefined();
    expect(screen.getByRole("button", { name: "1" })).toHaveProperty("disabled", false);
  });
});
