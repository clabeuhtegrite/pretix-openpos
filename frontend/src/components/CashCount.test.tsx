import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { countTotal, denominationLabel, emptyCount, type CountState } from "../drawer";
import { t } from "../i18n";
import { formatMoney } from "../money";
import type { Denomination } from "../types";
import CashCount from "./CashCount";

/**
 * Counting a drawer: note by note, or the total typed in.
 *
 * Rendered inside a holder that keeps the count, as the drawer panel does, so
 * that what is asserted is what the panel would send.
 */

const EUR: Denomination[] = [
  { value: "50.00", kind: "note" },
  { value: "20.00", kind: "note" },
  { value: "2.00", kind: "coin" },
  { value: "0.50", kind: "coin" },
];

function show(props: { denominations?: Denomination[]; usualCents?: number | null; disabled?: boolean } = {}) {
  const denominations = props.denominations ?? EUR;
  const seen: CountState[] = [];
  function Holder() {
    const [value, setValue] = useState<CountState>(emptyCount(denominations));
    seen.push(value);
    return (
      <CashCount
        value={value}
        onChange={setValue}
        currency="EUR"
        denominations={denominations}
        usualCents={props.usualCents}
        disabled={props.disabled}
      />
    );
  }
  render(<Holder />);
  return { user: userEvent.setup(), last: () => seen[seen.length - 1] };
}

const label = (value: string) => denominationLabel(value, "EUR");

describe("counting note by note", () => {
  it("lists notes and coins apart, each under its own heading", () => {
    show();

    expect(screen.getByRole("heading", { name: t("count.notes") })).toBeDefined();
    expect(screen.getByRole("heading", { name: t("count.coins") })).toBeDefined();
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
  });

  it("adds a note with each tap on plus, and takes one off with minus", async () => {
    const { user, last } = show();

    await user.click(screen.getByRole("button", { name: t("count.more", { note: label("20.00") }) }));
    await user.click(screen.getByRole("button", { name: t("count.more", { note: label("20.00") }) }));
    await user.click(screen.getByRole("button", { name: t("count.less", { note: label("20.00") }) }));

    expect(last().counts["20.00"]).toBe(1);
    expect(countTotal(last())).toBe(2000);
    expect(screen.getByText(formatMoney(2000, "EUR"))).toBeDefined();
  });

  it("offers no minus on a row already at nought", () => {
    show();

    expect(screen.getByRole("button", { name: t("count.less", { note: label("0.50") }) })).toHaveProperty("disabled", true);
  });

  it("takes a number typed straight in, which is how a pile of coins is counted", () => {
    const { last } = show();
    const field = screen.getByRole("textbox", { name: t("count.howMany", { note: label("0.50") }) });

    fireEvent.change(field, { target: { value: "37" } });

    expect(last().counts["0.50"]).toBe(37);
    expect(countTotal(last())).toBe(1850);
  });

  it("keeps digits only, and reads an emptied row as nought", () => {
    const { last } = show();
    const field = screen.getByRole("textbox", { name: t("count.howMany", { note: label("2.00") }) });

    fireEvent.change(field, { target: { value: "1a2" } });
    expect(last().counts["2.00"]).toBe(12);

    fireEvent.change(field, { target: { value: "" } });
    expect(last().counts["2.00"]).toBe(0);
    expect(field).toHaveProperty("value", "");
  });

  it("selects the figure on focus, so typing replaces it", () => {
    show();
    const field = screen.getByRole("textbox", { name: t("count.howMany", { note: label("50.00") }) });
    fireEvent.change(field, { target: { value: "3" } });
    const select = vi.spyOn(field as HTMLInputElement, "select");

    fireEvent.focus(field);

    expect(select).toHaveBeenCalled();
  });

  it("caps a row at what the server accepts", () => {
    const { last } = show();

    fireEvent.change(
      screen.getByRole("textbox", { name: t("count.howMany", { note: label("50.00") }) }),
      { target: { value: "1234567" } },
    );

    expect(last().counts["50.00"]).toBe(99999);
  });
});

describe("typing the total", () => {
  it("switches to a keypad that reads digits as cents", async () => {
    const { user, last } = show();

    await user.click(screen.getByRole("button", { name: t("count.byAmount") }));
    for (const digit of ["1", "2", "3", "4", "5"]) {
      await user.click(screen.getByRole("button", { name: digit }));
    }

    expect(last().mode).toBe("amount");
    expect(countTotal(last())).toBe(12345);
  });

  it("keeps the rows counted so far when switching to the keypad and back", async () => {
    const { user, last } = show();

    await user.click(screen.getByRole("button", { name: t("count.more", { note: label("20.00") }) }));
    await user.click(screen.getByRole("button", { name: t("count.byAmount") }));
    await user.click(screen.getByRole("button", { name: t("count.byNotes") }));

    expect(last().mode).toBe("notes");
    expect(countTotal(last())).toBe(2000);
  });

  it("has 00, 0 and a key that clears", async () => {
    const { user, last } = show();

    await user.click(screen.getByRole("button", { name: t("count.byAmount") }));
    await user.click(screen.getByRole("button", { name: "0" }));
    await user.click(screen.getByRole("button", { name: "5" }));
    await user.click(screen.getByRole("button", { name: "00" }));
    await user.click(screen.getByRole("button", { name: "0" }));
    // A leading nought is dropped rather than kept as a digit worth nothing.
    expect(last().entry).toBe("5000");

    await user.click(screen.getByRole("button", { name: "clear" }));
    expect(last().entry).toBe("");
  });

  it("offers the usual float in one tap, and lights it while it is the figure", async () => {
    const { user, last } = show({ usualCents: 10000 });
    await user.click(screen.getByRole("button", { name: t("count.byAmount") }));
    const usual = screen.getByRole("button", {
      name: t("count.usual", { amount: formatMoney(10000, "EUR") }),
    });
    expect(usual.getAttribute("aria-pressed")).toBe("false");

    await user.click(usual);

    expect(countTotal(last())).toBe(10000);
    expect(usual.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not offer the usual float on the notes, where checking it is the point", () => {
    show({ usualCents: 10000 });

    expect(
      screen.queryByRole("button", { name: t("count.usual", { amount: formatMoney(10000, "EUR") }) }),
    ).toBeNull();
  });

  it("goes straight to the keypad for a currency with no notes listed", () => {
    show({ denominations: [] });

    expect(screen.queryByRole("button", { name: t("count.byNotes") })).toBeNull();
    expect(screen.getByRole("button", { name: "7" })).toBeDefined();
  });
});

it("can be locked while the count is on its way", () => {
  show({ disabled: true });

  expect(screen.getByRole("button", { name: t("count.byAmount") })).toHaveProperty("disabled", true);
  expect(screen.getByRole("textbox", { name: t("count.howMany", { note: label("50.00") }) })).toHaveProperty("disabled", true);
});
