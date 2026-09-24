import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { history, cancelSale } = vi.hoisted(() => ({
  history: vi.fn(),
  cancelSale: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, history, cancelSale } };
});

import { ApiError } from "../api";
import { t } from "../i18n";
import { formatMoney } from "../money";
import type { CancelResult, JournalLine } from "../types";
import HistoryPanel from "./HistoryPanel";

/**
 * Today's transactions on this till, and the way to undo one.
 *
 * Undoing is never an edit: a cancellation is its own journal line standing
 * next to the sale it reverses, and correcting an order means ringing up a new
 * one against the credit. The tests that matter here are the ones about money
 * moving twice — a retry that cancels a second time, an operator told to hand
 * back 20 € before they have said whether they are correcting the order.
 */

function saleLine(overrides: Partial<JournalLine> = {}): JournalLine {
  return {
    seq: 12,
    kind: "sale",
    datetime: "2026-08-16T22:02:00.000Z",
    order: "POS01",
    total: "12.00",
    payment_type: "cash",
    cashier: "Ana",
    testmode: false,
    positions: [
      {
        item: 10, item_name: "Bière", variation: null, variation_name: null,
        count: 3, unit_price: "4.00", line_total: "12.00",
      },
    ],
    reason: "",
    cancels_seq: null,
    cancelled: false,
    can_cancel: true,
    ...overrides,
  };
}

const cancelled: CancelResult = {
  cancellation: { ...saleLine({ seq: 13, kind: "cancellation", total: "-12.00", cancels_seq: 12 }) },
  sale: saleLine(),
  replayed: false,
  credit_note: "DEMO-2026-1",
  refunded: true,
};

function show(props: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
  const onReuse = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <HistoryPanel
      pairing={{
        token: "tok", organizer: "demo", event: "festival",
        serial: "TILL1", deviceName: "Caisse bar",
      }}
      currency="EUR"
      cashier="Ana"
      onReuse={onReuse}
      onClose={onClose}
      {...props}
    />,
  );
  return { user: userEvent.setup(), container, onReuse, onClose };
}

/** Open a journal entry's detail. */
async function open(user: ReturnType<typeof userEvent.setup>, order = "POS01") {
  await user.click(await screen.findByRole("button", { name: new RegExp(order) }));
}

let confirmed: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Reset, not just re-stub: two of these tests count calls, and a shared mock
  // carries the previous test's presses into them.
  history.mockReset();
  cancelSale.mockReset();
  history.mockResolvedValue({ device: "TILL1", results: [saleLine()], truncated: false });
  cancelSale.mockResolvedValue(cancelled);
  confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  confirmed.mockRestore();
});

describe("the list", () => {
  it("says it is working before the server has answered", () => {
    show();

    expect(screen.getByText(t("history.loading"))).toBeDefined();
  });

  it("says plainly when the till has taken nothing yet", async () => {
    history.mockResolvedValue({ device: "TILL1", results: [], truncated: false });
    show();

    expect(await screen.findByText(t("history.empty"))).toBeDefined();
  });

  it("shows each entry with its order, its sequence and its total", async () => {
    show();

    const row = await screen.findByRole("button", { name: /POS01/ });
    expect(within(row).getByText(/#12/)).toBeDefined();
    expect(within(row).getByText(formatMoney(1200, "EUR"))).toBeDefined();
  });

  it("marks a sale that has since been reversed", async () => {
    // Not only in the meta line: the amount itself has to read as money that
    // was never taken, or the column totals up as takings at two in the
    // morning.
    history.mockResolvedValue({
      device: "TILL1", results: [saleLine({ cancelled: true, can_cancel: false })], truncated: false,
    });
    show();

    const row = await screen.findByRole("button", { name: /POS01/ });
    expect(within(row).getByText(new RegExp(t("history.badgeCancelled")))).toBeDefined();
    expect(row.className).toContain("is-cancelled");
  });

  it("leaves a sale that still stands alone", async () => {
    history.mockResolvedValue({
      device: "TILL1", results: [saleLine()], truncated: false,
    });
    show();

    const row = await screen.findByRole("button", { name: /POS01/ });
    expect(row.className).not.toContain("is-cancelled");
  });

  it("marks the reversal itself, and says what it reverses", async () => {
    history.mockResolvedValue({
      device: "TILL1",
      results: [saleLine({ seq: 13, kind: "cancellation", total: "-12.00", cancels_seq: 12 })],
      truncated: false,
    });
    show();

    expect(
      await screen.findByText(new RegExp(t("history.isCancellation", { seq: 12 }))),
    ).toBeDefined();
  });

  it("warns once, under the list, when test-mode rows are mixed in", async () => {
    // The risk being guarded against is a volunteer totting the column up as
    // the night's takings.
    history.mockResolvedValue({
      device: "TILL1", results: [saleLine({ testmode: true })], truncated: false,
    });
    show();

    expect(await screen.findByText(t("history.testmodeNote"))).toBeDefined();
  });

  it("keeps quiet about test mode when there is none", async () => {
    show();

    await screen.findByRole("button", { name: /POS01/ });
    expect(screen.queryByText(t("history.testmodeNote"))).toBeNull();
  });

  it("says when the evening ran longer than the till will show", async () => {
    history.mockResolvedValue({ device: "TILL1", results: [saleLine()], truncated: true });
    show();

    expect(await screen.findByText(new RegExp(t("history.truncated", { n: 1 })))).toBeDefined();
  });

  it("says it is the network when the list cannot be read", async () => {
    history.mockRejectedValue(new ApiError(0, "network"));
    show();

    expect(await screen.findByText(t("error.offline"))).toBeDefined();
    // And stops saying it is loading, which it no longer is.
    expect(screen.queryByText(t("history.loading"))).toBeNull();
  });

  it("offers another go, and shows it under way", async () => {
    // A list that could not be read used to say so, and "Chargement…" under
    // it for as long as the panel stayed open, with no way to ask again.
    history.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();
    await screen.findByText(t("error.offline"));
    let answer: (value: unknown) => void = () => {};
    history.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    await user.click(screen.getByRole("button", { name: t("history.retry") }));

    const retrying = screen.getByRole("button", { name: t("history.loading") });
    expect(retrying).toHaveProperty("disabled", true);
    expect(retrying.getAttribute("aria-busy")).toBe("true");
    answer({ device: "TILL1", results: [saleLine()], truncated: false });
    expect(await screen.findByText(/POS01/)).toBeDefined();
    expect(screen.queryByText(t("error.offline"))).toBeNull();
  });
});

describe("one entry", () => {
  it("opens on a tap, with its lines", async () => {
    const { user } = show();

    await open(user);

    expect(screen.getByText("Bière")).toBeDefined();
    expect(screen.getByText("×3")).toBeDefined();
  });

  it("names a variation next to its product", async () => {
    history.mockResolvedValue({
      device: "TILL1",
      results: [saleLine({
        positions: [{
          item: 21, item_name: "T-shirt", variation: 101, variation_name: "L",
          count: 1, unit_price: "18.00", line_total: "18.00",
        }],
      })],
      truncated: false,
    });
    const { user } = show();

    await open(user);

    expect(screen.getByText("T-shirt · L")).toBeDefined();
  });

  it("goes back to the list", async () => {
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: new RegExp(t("history.back")) }));

    expect(screen.getByRole("button", { name: /POS01/ })).toBeDefined();
  });

  it("explains why an entry cannot be undone from the till", async () => {
    history.mockResolvedValue({
      device: "TILL1",
      results: [saleLine({ kind: "cancellation", can_cancel: false })],
      truncated: false,
    });
    const { user } = show();

    await open(user);

    expect(screen.getByText(t("history.notCancellable"))).toBeDefined();
  });

  it("says when it has already been undone", async () => {
    history.mockResolvedValue({
      device: "TILL1", results: [saleLine({ cancelled: true, can_cancel: false })], truncated: false,
    });
    const { user } = show();

    await open(user);

    expect(screen.getByText(t("history.alreadyCancelled"))).toBeDefined();
  });
});

describe("cancelling", () => {
  it("asks before it does anything", async () => {
    confirmed.mockReturnValue(false);
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    expect(cancelSale).not.toHaveBeenCalled();
  });

  it("sends the sequence, the cashier and the reason", async () => {
    const { user } = show();
    await open(user);
    await user.type(screen.getByLabelText(t("history.reason")), "erreur de saisie");

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    await waitFor(() =>
      expect(cancelSale).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ seq: 12, cashier: "Ana", reason: "erreur de saisie" }),
      ),
    );
  });

  it("carries the same key when a timed-out attempt is retried", async () => {
    // Minting a fresh one per press is what made the server answer "already
    // cancelled" for a cancellation that had in fact gone through, losing the
    // credit note and the corrected basket with it.
    cancelSale.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));
    await screen.findByText("network");
    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    await waitFor(() => expect(cancelSale).toHaveBeenCalledTimes(2));
    const [[, first], [, second]] = cancelSale.mock.calls;
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });

  it("mints a new key once the server has answered", async () => {
    // A refusal is final too: the next cancellation is a different one.
    cancelSale.mockRejectedValueOnce(new ApiError(409, "already cancelled"));
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));
    await screen.findByText("already cancelled");
    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    await waitFor(() => expect(cancelSale).toHaveBeenCalledTimes(2));
    const [[, first], [, second]] = cancelSale.mock.calls;
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it("takes no second press while the first is in flight", async () => {
    let release: (value: CancelResult) => void = () => {};
    cancelSale.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    const cancelling = screen.getByRole("button", { name: t("history.cancelling") });
    expect(cancelling).toHaveProperty("disabled", true);
    expect(cancelling.getAttribute("aria-busy")).toBe("true");
    release(cancelled);
  });

  it("shows the credit note it produced", async () => {
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    expect(
      await screen.findByText(t("history.creditNote", { number: "DEMO-2026-1" })),
    ).toBeDefined();
  });

  it("says nothing about a credit note when pretix issued none", async () => {
    cancelSale.mockResolvedValue({ ...cancelled, credit_note: null });
    const { user } = show();
    await open(user);

    await user.click(screen.getByRole("button", { name: t("history.cancel") }));

    await screen.findByText(t("history.cancelled"));
    expect(screen.queryByText(/DEMO-2026/)).toBeNull();
  });
});

describe("after a cancellation", () => {
  async function cancel(user: ReturnType<typeof userEvent.setup>) {
    await open(user);
    await user.click(screen.getByRole("button", { name: t("history.cancel") }));
    await screen.findByText(t("history.cancelled"));
  }

  it("offers to correct the order rather than only to refund it", async () => {
    // Telling the operator to hand back 20 € before they have said whether
    // they are correcting the order is how you count 20 € out of the drawer
    // and 17 € straight back into it.
    const { user } = show();

    await cancel(user);

    expect(screen.getByRole("button", { name: t("history.correct") })).toBeDefined();
  });

  it("puts the lines back in the basket, with the credit", async () => {
    const { user, onReuse, onClose } = show();
    await cancel(user);

    await user.click(screen.getByRole("button", { name: t("history.correct") }));

    expect(onReuse).toHaveBeenCalledWith(
      cancelled.sale?.positions,
      { amountCents: 1200, order: "POS01" },
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("when a card reader took the money", () => {
    /** The server having refunded the card, or not managed to. */
    const refund = (card_refund: "done" | "already" | "failed") => ({
      ...cancelled,
      cancellation: { ...cancelled.cancellation, payment_type: "card" as const },
      card_refund,
    });

    it("says the money is on its way back, and asks for nothing", async () => {
      cancelSale.mockResolvedValue(refund("done"));
      const { user } = show();

      await cancel(user);

      expect(screen.getByText(t("history.refundedToCard"))).toBeDefined();
      expect(screen.getByRole("button", { name: t("history.finish") })).toBeDefined();
    });

    it("corrects the order without a credit, because the till holds none", async () => {
      // The money went back to the card. Carrying a credit into the corrected
      // basket would settle it against money the till no longer has.
      cancelSale.mockResolvedValue(refund("already"));
      const { user, onReuse } = show();
      await cancel(user);

      await user.click(screen.getByRole("button", { name: t("history.correct") }));

      expect(onReuse).toHaveBeenCalledWith(cancelled.sale?.positions, null);
    });

    it("says plainly when the refund did not go through", async () => {
      // The one outcome that must not read as a cancellation that is finished:
      // the customer's money is still on their card.
      cancelSale.mockResolvedValue(refund("failed"));
      const { user } = show();

      await cancel(user);

      expect(screen.getByText(t("history.refundFailed"))).toBeDefined();
      expect(screen.queryByRole("button", { name: t("history.finish") })).toBeNull();
    });
  });

  it("names the amount to hand back on the other way out", async () => {
    const { user } = show();

    await cancel(user);

    expect(
      screen.getByRole("button", {
        name: t("history.refundCashAndFinish", { total: formatMoney(1200, "EUR") }),
      }),
    ).toBeDefined();
  });

  it("says to refund the card when that is how it was paid", async () => {
    cancelSale.mockResolvedValue({
      ...cancelled,
      cancellation: { ...cancelled.cancellation, payment_type: "card" },
    });
    const { user } = show();

    await cancel(user);

    expect(
      screen.getByRole("button", {
        name: t("history.refundCardAndFinish", { total: formatMoney(1200, "EUR") }),
      }),
    ).toBeDefined();
  });

  it("goes back to a freshly read list", async () => {
    const { user } = show();
    await cancel(user);
    history.mockClear();

    await user.click(
      screen.getByRole("button", {
        name: t("history.refundCashAndFinish", { total: formatMoney(1200, "EUR") }),
      }),
    );

    await waitFor(() => expect(history).toHaveBeenCalled());
  });

  it("offers no correction for a sale that had no lines to reuse", async () => {
    cancelSale.mockResolvedValue({ ...cancelled, sale: null });
    const { user } = show();

    await cancel(user);

    expect(screen.queryByRole("button", { name: t("history.correct") })).toBeNull();
  });
});

describe("getting back to the till", () => {
  it("closes on the button", async () => {
    const { user, onClose } = show();
    await screen.findByRole("button", { name: /POS01/ });

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a tap outside the panel", async () => {
    const { user, onClose, container } = show();

    await user.click(container.querySelector(".overlay") as HTMLElement);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers no close button while an entry is open", async () => {
    // The button under the detail is "back", and two of them side by side is
    // how an operator leaves the panel meaning to leave the entry.
    const { user } = show();

    await open(user);

    expect(screen.queryByRole("button", { name: t("settings.close") })).toBeNull();
  });
});

describe("a deposit handed back", () => {
  const refund = saleLine({
    seq: 14,
    kind: "deposit_refund",
    // No order behind it: pretix cannot hold one worth less than nothing.
    order: "",
    total: "-3.00",
    can_cancel: false,
    positions: [
      {
        item: 30, item_name: "Consigne", variation: null, variation_name: null,
        count: 3, unit_price: "-1.00", line_total: "-3.00",
      },
    ],
  });

  it("says what it is, rather than trailing a blank order code", async () => {
    history.mockResolvedValue({ device: "TILL1", results: [refund], truncated: false });
    show();

    expect(
      await screen.findByRole("button", { name: new RegExp(t("deposit.tile")) }),
    ).toBeDefined();
  });

  it("reads as money going out", async () => {
    history.mockResolvedValue({ device: "TILL1", results: [refund], truncated: false });
    const { container } = show();
    await screen.findByRole("button", { name: new RegExp(t("deposit.tile")) });

    expect(screen.getByText(formatMoney(-300, "EUR"))).toBeDefined();
    expect(container.querySelector(".history-row-total.is-negative")).not.toBeNull();
  });

  it("cannot be reversed from the till", async () => {
    // There is no order to credit. Taking the deposit again is a deposit
    // sold, which is one tap away on the grid.
    history.mockResolvedValue({ device: "TILL1", results: [refund], truncated: false });
    const { user } = show();

    await user.click(
      await screen.findByRole("button", { name: new RegExp(t("deposit.tile")) }),
    );

    expect(screen.getByText(t("history.notCancellable"))).toBeDefined();
    expect(screen.queryByRole("button", { name: t("history.cancel") })).toBeNull();
  });
});

describe("a free amount in the journal", () => {
  it("shows the reason where the product name would be", async () => {
    // "Divers" is the same word on every one of them and answers nothing.
    history.mockResolvedValue({
      device: "TILL1",
      results: [
        saleLine({
          positions: [{
            item: 30, item_name: "Divers", variation: null, variation_name: null,
            count: 1, unit_price: "12.50", line_total: "12.50",
            description: "Verre cassé",
          }],
        }),
      ],
      truncated: false,
    });
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: /POS01/ }));

    expect(screen.getByText("Verre cassé")).toBeDefined();
  });
});
