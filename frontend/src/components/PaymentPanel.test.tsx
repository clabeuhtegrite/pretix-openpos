import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { formatMoney } from "../money";
import type { PaymentType } from "../types";
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

/**
 * Render the panel and answer its first question, so a test lands where it
 * means to: on the keypad, unless it says otherwise.
 *
 * ``method: null`` leaves the question open, which is what the block below
 * looks at. The answer is given before the test's own props are applied,
 * because a panel mid-request has necessarily been through the step already.
 */
function show(
  props: Partial<Parameters<typeof PaymentPanel>[0]> = {},
  method: PaymentType | null = "cash",
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onTerminalStart = vi.fn();
  const onTerminalStop = vi.fn();
  const panel = (extra: Partial<Parameters<typeof PaymentPanel>[0]>) => (
    <PaymentPanel
      totalCents={1234}
      currency="EUR"
      denominations={DENOMINATIONS}
      cardMode="declared"
      terminal={null}
      onTerminalStart={onTerminalStart}
      onTerminalStop={onTerminalStop}
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
      {...extra}
    />
  );
  const { container, rerender } = render(panel({ busy: false }));
  if (method !== null) {
    fireEvent.click(screen.getByRole("button", { name: t(`payment.${method}`) }));
  }
  rerender(panel({}));
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
  return { user, type, confirm, row, onConfirm, onCancel, onTerminalStart, onTerminalStop, container };
}

/** Whether a quick-tender button is lit: it is while its amount is the one received. */
const lit = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";

describe("the question that comes first", () => {
  // Cash was the default and card a toggle nobody remembered to flip, which
  // came out as a drawer that did not balance. Now nothing is presumed.

  it("asks which way before showing anything to press", () => {
    show({}, null);

    expect(screen.getByText(t("payment.chooseMethod"))).toBeDefined();
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(screen.queryByRole("button", { name: t("payment.exact") })).toBeNull();
  });

  it("asks with the amount already on screen", () => {
    // What the operator says out loud is "douze trente-quatre, espèces ou
    // carte ?", so the figure has to be there before the question is answered.
    show({}, null);

    expect(
      within(screen.getByText(t("payment.due")).parentElement as HTMLElement)
        .getByText(formatMoney(1234, "EUR")),
    ).toBeDefined();
  });

  it("offers nothing to confirm until it has an answer", () => {
    const { container } = show({}, null);

    const actions = container.querySelector(".pay-actions") as HTMLElement;
    expect(
      within(actions).queryByRole("button", { name: t("payment.confirm") }),
    ).toBeNull();
    expect(
      within(actions).queryByRole("button", { name: t("payment.cardConfirm") }),
    ).toBeNull();
  });

  it("opens the keypad once the answer is cash", async () => {
    const { user, confirm } = show({}, null);

    await user.click(screen.getByRole("button", { name: t("payment.cash") }));

    expect(screen.getByRole("button", { name: "1" })).toBeDefined();
    expect(confirm()).toHaveProperty("disabled", false);
  });

  it("goes straight to the terminal once the answer is card", async () => {
    const { user, onConfirm, confirm } = show({}, null);

    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    expect(screen.getByText(t("payment.cardPrompt"))).toBeDefined();

    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith("card", null);
  });

  it("leaves the answer changeable afterwards", async () => {
    // A mis-tap is one tap to undo, not a trip back to the basket.
    const { user } = show({}, null);
    await user.click(screen.getByRole("button", { name: t("payment.cash") }));

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(screen.getByText(t("payment.cardPrompt"))).toBeDefined();
  });

  it("can be backed out of without answering", async () => {
    const { user, onCancel, onConfirm } = show({}, null);

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("asks it of a basket that pays out too", () => {
    // Deposits handed back still leave the journal a payment type to record.
    show({ totalCents: -300 }, null);

    expect(screen.getByText(t("payment.chooseMethod"))).toBeDefined();
    expect(screen.queryByText(t("payment.nothingToTake"))).toBeNull();
  });
});

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

  it("lights the exact-amount button once tapped", async () => {
    // Nothing else on the panel moves when the change is nil, so the button
    // itself has to say the tap landed.
    const { user } = show();
    expect(lit(t("payment.exact"))).toBe(false);

    await user.click(screen.getByRole("button", { name: t("payment.exact") }));

    expect(lit(t("payment.exact"))).toBe(true);
  });

  it("lights the note that was tapped, and no other", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: formatMoney(2000, "EUR") }));

    expect(lit(formatMoney(2000, "EUR"))).toBe(true);
    expect(lit(formatMoney(1000, "EUR"))).toBe(false);
    expect(lit(t("payment.exact"))).toBe(false);
  });

  it("lights the note that is the exact price, and the exact button with it", async () => {
    // A 10 € beer paid with a 10 € note: both buttons stand for the amount
    // received, so both say so.
    const { user } = show({ totalCents: 1000 });

    await user.click(screen.getByRole("button", { name: formatMoney(1000, "EUR") }));

    expect(lit(formatMoney(1000, "EUR"))).toBe(true);
    expect(lit(t("payment.exact"))).toBe(true);
  });

  it("puts the light out as soon as the amount is changed", async () => {
    const { user, type } = show();
    await user.click(screen.getByRole("button", { name: formatMoney(2000, "EUR") }));

    await type("0");

    expect(lit(formatMoney(2000, "EUR"))).toBe(false);
  });

  it("lights the exact-amount button when the keys spell that amount too", async () => {
    // The light describes the amount, not the finger: 12.34 typed out is exact.
    const { type } = show();

    await type("1234");

    expect(lit(t("payment.exact"))).toBe(true);
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

describe("a basket that pays out", () => {
  // Deposits handed back and nothing bought: the queue at closing time.
  it("says what to hand over rather than an amount due", () => {
    show({ totalCents: -300 });

    expect(screen.queryByText(t("payment.due"))).toBeNull();
    expect(
      within(screen.getByText(t("payment.giveBack")).parentElement as HTMLElement)
        .getByText(formatMoney(300, "EUR")),
    ).toBeDefined();
  });

  it("puts the keypad away: there is nothing to take", () => {
    show({ totalCents: -300 });

    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(screen.getByText(t("payment.nothingToTake"))).toBeDefined();
  });

  it("can be confirmed straight away, with no amount received", async () => {
    const { user, confirm, onConfirm } = show({ totalCents: -300 });

    await user.click(confirm());

    // null, not "0.00": nothing was tendered, and the server refuses an
    // amount received on a transaction that pays money out.
    expect(onConfirm).toHaveBeenCalledWith("cash", null);
  });

  it("tells the operator to refund on the terminal when it was a card sale", async () => {
    const { user } = show({ totalCents: -300 });

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(
      screen.getByText(t("payment.cardRefundPrompt", { amount: formatMoney(300, "EUR") })),
    ).toBeDefined();
  });
});

describe("when the server refuses", () => {
  it("says why, above the keypad, without clearing what was typed", () => {
    show({ error: "This product is not on sale here." });

    expect(screen.getByText("This product is not on sale here.")).toBeDefined();
    expect(screen.getByRole("button", { name: "1" })).toHaveProperty("disabled", false);
  });
});

describe("on a till with a card reader of its own", () => {
  /** What the hook reports while the customer has the reader in front of them. */
  const waiting = { phase: "waiting" as const, amount: "12.34", currency: "EUR", message: null, stalled: false };

  it("puts the basket on the reader the moment card is chosen", async () => {
    // No confirmation step in between: the customer is standing there with a
    // card, and a button between them and the reader is one nobody presses.
    const { user, onTerminalStart } = show({ cardMode: "terminal" }, null);

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(onTerminalStart).toHaveBeenCalled();
  });

  it("offers no way to confirm a card payment by hand", async () => {
    const { user, onConfirm } = show({ cardMode: "terminal", terminal: waiting }, null);

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.queryByRole("button", { name: t("payment.cardConfirm") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("payment.confirm") })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  const paid = {
    phase: "paid" as const, amount: "12.34", currency: "EUR", message: null, stalled: false,
  };

  it("will not let a charged card be booked as cash", async () => {
    // The panel only stays open at this point because posting the sale
    // failed, so there is a red banner on screen — which is exactly when
    // somebody starts pressing things. One tap on "Espèces" and one on
    // "Valider" used to record a cash sale for money that went on a card, and
    // the drawer came up short by that amount at closing.
    const { user, onConfirm } = show(
      { cardMode: "terminal", terminal: paid, error: "Le serveur n'a pas répondu" },
      null,
    );
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    await user.click(screen.getByRole("button", { name: t("payment.cash") }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", true);
  });

  it("will not let the operator walk away from a charged card either", async () => {
    const { user, onCancel } = show(
      { cardMode: "terminal", terminal: paid, error: "Le serveur n'a pas répondu" },
      null,
    );
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByRole("button", { name: t("payment.back") })).toHaveProperty("disabled", true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("offers to record the sale by hand once the card has been charged", async () => {
    // The automatic post is what normally ends this, so the button only
    // appears when that has failed — and then it is the only correct move.
    const { user, onConfirm } = show(
      { cardMode: "terminal", terminal: paid, error: "Le serveur n'a pas répondu" },
      null,
    );
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    await user.click(screen.getByRole("button", { name: t("payment.cardConfirm") }));

    expect(onConfirm).toHaveBeenCalledWith("card", null, "12.34");
  });

  it("reads out the figure the reader is showing, not the basket's", async () => {
    // They can differ: the server prices the basket when it puts it on the
    // reader, and this app's catalogue can be a refresh behind. The customer
    // is being asked for the reader's figure, so that is the one on screen.
    const { user } = show(
      { cardMode: "terminal", terminal: { ...waiting, amount: "15.00" } },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByText(formatMoney(1500, "EUR"))).toBeDefined();
    expect(screen.getByText(t("payment.readerPrompt"))).toBeDefined();
  });

  it("says the payment carries on when it loses the server", async () => {
    // The one thing that must never be shown here is a refusal for a card
    // that is in fact being charged.
    const { user } = show(
      { cardMode: "terminal", terminal: { ...waiting, stalled: true } },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByText(t("payment.readerStalled"))).toBeDefined();
    expect(screen.getByText(t("payment.readerPrompt"))).toBeDefined();
  });

  it("says why a card was refused, and offers another go", async () => {
    const failed = {
      phase: "failed" as const, amount: null, currency: null,
      message: t("payment.readerRefused"), stalled: false,
    };
    const { user, onTerminalStart } = show({ cardMode: "terminal", terminal: failed }, null);

    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    onTerminalStart.mockClear();
    await user.click(screen.getByRole("button", { name: t("payment.readerRetry") }));

    expect(screen.getByText(t("payment.readerRefused"))).toBeDefined();
    expect(onTerminalStart).toHaveBeenCalled();
  });

  it("takes the basket off the reader before it lets the operator leave", async () => {
    const { user, onTerminalStop, onCancel } = show(
      { cardMode: "terminal", terminal: waiting },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    await user.click(screen.getByRole("button", { name: t("payment.readerStop") }));

    expect(onTerminalStop).toHaveBeenCalled();
    // Walking away in the same tap is how a card gets charged for a sale
    // nobody recorded.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("locks the method toggle while the reader has the basket", async () => {
    const { user } = show({ cardMode: "terminal", terminal: waiting }, null);

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("refuses the reader for a basket that pays money out", async () => {
    // SumUp only refunds against a transaction of its own, so there is no way
    // to send money to a card that nothing stands behind.
    const { user, onTerminalStart } = show(
      { cardMode: "terminal", totalCents: -200 },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByText(t("payment.readerNoRefund"))).toBeDefined();
    expect(onTerminalStart).not.toHaveBeenCalled();
  });

  it("refuses the reader while a credit is being settled", async () => {
    const { user, onTerminalStart } = show(
      { cardMode: "terminal", credit: { amountCents: 2000, order: "ABC12" } },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.getByText(t("payment.readerCredit"))).toBeDefined();
    expect(onTerminalStart).not.toHaveBeenCalled();
  });

  it("says so when the card was charged and the sale was not recorded", async () => {
    // It should be impossible — the basket is pinned, the quota is forced, the
    // total is not re-checked — but a cashier reading "not recorded" would
    // otherwise assume nothing was charged.
    const paid = {
      phase: "paid" as const, amount: "12.34", currency: "EUR", message: null, stalled: false,
    };
    const { user } = show(
      { cardMode: "terminal", terminal: paid, error: "Something went wrong." },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(
      screen.getByText(`${t("payment.readerPaidNotRecorded")} Something went wrong.`),
    ).toBeDefined();
  });

  it("does not say that about an ordinary refusal, before any card is charged", async () => {
    const { user } = show(
      { cardMode: "terminal", terminal: waiting, error: "Something went wrong." },
      null,
    );

    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(screen.queryByText(t("payment.readerPaidNotRecorded"))).toBeNull();
    expect(screen.getByText("Something went wrong.")).toBeDefined();
  });

  it("leaves cash alone, because the drawer is still a drawer", async () => {
    const { user, onConfirm } = show({ cardMode: "terminal" }, null);

    await user.click(screen.getByRole("button", { name: t("payment.cash") }));
    await user.click(screen.getByRole("button", { name: t("payment.exact") }));
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));

    expect(onConfirm).toHaveBeenCalledWith("cash", "12.34");
  });

  it("lets a mis-tap on card be undone in one tap, before the reader answers", async () => {
    const { user } = show({ cardMode: "terminal" }, null);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    await user.click(screen.getByRole("button", { name: t("payment.cash") }));

    expect(screen.getByRole("button", { name: t("payment.confirm") })).toBeDefined();
  });
});
