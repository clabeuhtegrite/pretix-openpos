import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { formatMoney } from "../money";
import CustomSalePanel from "./CustomSalePanel";

/**
 * Typing a price at the counter.
 *
 * The only screen in the till where the cashier decides what something costs,
 * which is exactly why it refuses to produce half of one: an amount with no
 * reason is the line nobody can account for afterwards, and a reason with no
 * amount is nothing at all.
 */

function show() {
  const onAdd = vi.fn();
  const onCancel = vi.fn();
  render(
    <CustomSalePanel
      currency="EUR"
      productName="Divers"
      onAdd={onAdd}
      onCancel={onCancel}
    />,
  );
  const type = async (user: ReturnType<typeof userEvent.setup>, digits: string) => {
    for (const digit of digits) {
      await user.click(screen.getByRole("button", { name: digit }));
    }
  };
  return { user: userEvent.setup(), onAdd, onCancel, type };
}

const add = () => screen.getByRole("button", { name: t("custom.add") });

describe("typing the amount", () => {
  it("reads digits as cents, the way the payment keypad does", async () => {
    const { user, type } = show();

    await type(user, "1234");

    // 1-2-3-4 is 12.34. Two ways of typing an amount on one till is one of
    // them being got wrong.
    expect(screen.getByText(formatMoney(1234, "EUR"))).toBeDefined();
  });

  it("clears back to nothing", async () => {
    const { user, type } = show();
    await type(user, "500");

    await user.click(screen.getByRole("button", { name: "clear" }));

    expect(screen.getByText(formatMoney(0, "EUR"))).toBeDefined();
  });

  it("has a double zero, because prices are mostly round", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: "5" }));
    await user.click(screen.getByRole("button", { name: "00" }));

    expect(screen.getByText(formatMoney(500, "EUR"))).toBeDefined();
  });

  it("says which product the amount will be booked against", () => {
    show();

    expect(screen.getByText("Divers")).toBeDefined();
  });
});

describe("what it will and will not add", () => {
  it("will not add an amount with no reason", async () => {
    const { user, type } = show();

    await type(user, "500");

    expect(add()).toHaveProperty("disabled", true);
  });

  it("will not add a reason with no amount", async () => {
    const { user } = show();

    await user.type(screen.getByLabelText(t("custom.reason")), "Verre cassé");

    expect(add()).toHaveProperty("disabled", true);
  });

  it("will not take spaces for a reason", async () => {
    const { user, type } = show();
    await type(user, "500");

    await user.type(screen.getByLabelText(t("custom.reason")), "   ");

    expect(add()).toHaveProperty("disabled", true);
  });

  it("hands up the amount in cents and the reason, trimmed", async () => {
    const { user, type, onAdd } = show();
    await type(user, "1250");
    await user.type(screen.getByLabelText(t("custom.reason")), "  Verre cassé  ");

    await user.click(add());

    expect(onAdd).toHaveBeenCalledWith(1250, "Verre cassé");
  });

  it("backs out without adding anything", async () => {
    const { user, onAdd, onCancel } = show();

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(onCancel).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
