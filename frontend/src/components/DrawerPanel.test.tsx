import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { drawer, drawerOpen, drawerMovement, drawerCount, drawerClose } = vi.hoisted(() => ({
  drawer: vi.fn(),
  drawerOpen: vi.fn(),
  drawerMovement: vi.fn(),
  drawerCount: vi.fn(),
  drawerClose: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, drawer, drawerOpen, drawerMovement, drawerCount, drawerClose },
  };
});

import { ApiError } from "../api";
import { denominationLabel } from "../drawer";
import { t } from "../i18n";
import { formatMoney } from "../money";
import type { DrawerAnswer, DrawerCount, DrawerSession, DrawerState } from "../types";
import DrawerPanel from "./DrawerPanel";

/**
 * The drawer panel: opened on a counted float, cash put in and taken out with
 * a reason, what it should hold on screen all evening, counted, closed on
 * that count.
 *
 * What matters most here is what the screen does not do: close on a count
 * that no longer describes the drawer, or send a corrected figure under the
 * key of the first one.
 */

const pairing = {
  token: "tok", organizer: "demo", event: "festival", serial: "TILL1", deviceName: "Caisse bar",
};

const info = {
  id: 3,
  name: "Bar",
  opening_float: "100.00",
  currency: "EUR",
  denominations: [
    { value: "20.00", kind: "note" as const },
    { value: "0.50", kind: "coin" as const },
  ],
};

const recently = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function session(over: Partial<DrawerSession> = {}): DrawerSession {
  return {
    id: 9,
    opened_at: recently(),
    opened_by: "Ana",
    opening_float: "100.00",
    expected: "185.00",
    cash_sales: "85.00",
    cash_returned: "0.00",
    cash_in: "0.00",
    cash_out: "0.00",
    stale: false,
    movements: [],
    count: null,
    ...over,
  };
}

function aCount(over: Partial<DrawerCount> = {}): DrawerCount {
  return {
    seq: 7,
    kind: "count",
    datetime: recently(),
    amount: "184.00",
    reason: "",
    cashier: "Ana",
    device: "Caisse bar",
    expected: "185.00",
    difference: "-1.00",
    current: true,
    ...over,
  };
}

const closed: DrawerState = { drawer: info, session: null, last_closed: null };
const open: DrawerState = { drawer: info, session: session(), last_closed: null };

function answer(state: DrawerState, over: Partial<DrawerAnswer["entry"]> = {}): DrawerAnswer {
  return {
    ...state,
    entry: {
      seq: 1, kind: "open", datetime: recently(), amount: "0.00", reason: "", cashier: "Ana",
      device: "Caisse bar", ...over,
    },
  };
}

function show(props: { online?: boolean; cashier?: string } = {}) {
  const onState = vi.fn();
  const onClose = vi.fn();
  const { unmount } = render(
    <DrawerPanel
      pairing={pairing}
      cashier={props.cashier ?? "Ana"}
      online={props.online ?? true}
      onState={onState}
      onClose={onClose}
    />,
  );
  return { user: userEvent.setup(), onState, onClose, unmount };
}

const button = (name: string) => screen.getByRole("button", { name });
const more = (value: string) =>
  button(t("count.more", { note: denominationLabel(value, "EUR") }));
const refused = (code: string, message = "refusé") =>
  new ApiError(400, message, { drawer: [message], code });

beforeEach(() => {
  drawer.mockResolvedValue(closed);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading the drawer", () => {
  it("says it is on its way, then shows the drawer by name", async () => {
    show();

    expect(screen.getByText("…")).toBeDefined();
    expect(await screen.findByRole("heading", { name: t("drawer.title", { name: "Bar" }) })).toBeDefined();
    expect(drawer).toHaveBeenCalledWith(pairing, expect.any(AbortSignal));
  });

  it("hands every state it reads to the rest of the till", async () => {
    const { onState } = show();

    await waitFor(() => expect(onState).toHaveBeenCalledWith(closed));
  });

  it("says what went wrong, and tries again on request", async () => {
    drawer.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();

    expect(await screen.findByText(t("error.offline"))).toBeDefined();
    await user.click(button(t("drawer.retry")));

    expect(await screen.findByText(t("drawer.isClosed"))).toBeDefined();
  });

  it("says so when the device no longer has a drawer", async () => {
    drawer.mockResolvedValue({ drawer: null, session: null, last_closed: null });
    show();

    expect(await screen.findByText(t("drawer.none"))).toBeDefined();
    expect(screen.getByRole("heading", { name: t("drawer.heading") })).toBeDefined();
  });

  it("leaves on Back", async () => {
    const { user, onClose } = show();
    await screen.findByText(t("drawer.isClosed"));

    await user.click(button(t("drawer.back")));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("a closed drawer", () => {
  it("shows how the last evening ended", async () => {
    drawer.mockResolvedValue({
      ...closed,
      last_closed: {
        id: 8, opened_at: recently(), closed_at: recently(), cashier: "Léo",
        amount: "210.00", expected: "210.00", difference: "0.00",
      },
    });
    show();

    expect(await screen.findByText(/Léo/)).toBeDefined();
    expect(screen.getByText(t("drawer.right"))).toBeDefined();
    expect(screen.getAllByText(formatMoney(21000, "EUR"))).toHaveLength(2);
  });

  it("says a drawer closed without a count was not counted", async () => {
    drawer.mockResolvedValue({
      ...closed,
      last_closed: {
        id: 8, opened_at: recently(), closed_at: recently(), cashier: "",
        amount: null, expected: "210.00", difference: null,
      },
    });
    show();

    expect(await screen.findByText(t("drawer.closedUncounted"))).toBeDefined();
    expect(screen.queryByText(t("drawer.expected"))).toBeNull();
  });

  it("opens on the float counted note by note", async () => {
    const opened = answer(open);
    drawerOpen.mockResolvedValue(opened);
    const { user, onState, onClose } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));

    expect(screen.getByText(t("drawer.openHelp"))).toBeDefined();
    await user.click(more("20.00"));
    await user.click(more("20.00"));
    await user.click(more("0.50"));
    await user.click(button(t("drawer.openWith", { amount: formatMoney(4050, "EUR") })));

    expect(drawerOpen).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      amount: "40.50",
      denominations: { "20.00": 2, "0.50": 1 },
      cashier: "Ana",
    });
    // Open, which is what the panel was for: it hands the state on and goes.
    expect(onState).toHaveBeenLastCalledWith(opened);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers the usual float on the keypad", async () => {
    drawerOpen.mockResolvedValue(answer(open));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));

    await user.click(button(t("count.byAmount")));
    await user.click(button(t("count.usual", { amount: formatMoney(10000, "EUR") })));
    await user.click(button(t("drawer.openWith", { amount: formatMoney(10000, "EUR") })));

    expect(drawerOpen).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      amount: "100.00",
      cashier: "Ana",
    });
  });

  it("retries a lost opening under the same key, and a corrected one under a new key", async () => {
    drawerOpen
      .mockRejectedValueOnce(new ApiError(0, "network"))
      .mockRejectedValueOnce(new ApiError(502, "HTTP 502"))
      .mockResolvedValueOnce(answer(open));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));
    await user.click(more("20.00"));

    const openWith = (cents: number) =>
      button(t("drawer.openWith", { amount: formatMoney(cents, "EUR") }));
    await user.click(openWith(2000));
    expect(await screen.findByText(t("error.offline"))).toBeDefined();
    await user.click(openWith(2000));
    await screen.findByText("HTTP 502");
    await user.click(more("20.00"));
    await user.click(openWith(4000));

    const keys = drawerOpen.mock.calls.map(([, payload]) => payload.idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("shows the drawer as it is when the other tablet opened it first", async () => {
    drawerOpen.mockRejectedValue(refused("drawer_open", "Cette caisse est déjà ouverte."));
    const { user, onClose } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));
    drawer.mockResolvedValue(open);

    await user.click(button(t("drawer.openWith", { amount: formatMoney(0, "EUR") })));

    expect(await screen.findByText("Cette caisse est déjà ouverte.")).toBeDefined();
    expect(await screen.findByText(t("drawer.float"))).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays on the count when the server finds fault with it", async () => {
    drawerOpen.mockRejectedValue(new ApiError(400, "Ces billets ne font pas ce total.", {
      denominations: ["Ces billets ne font pas ce total."],
    }));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));

    await user.click(button(t("drawer.openWith", { amount: formatMoney(0, "EUR") })));

    expect(await screen.findByText("Ces billets ne font pas ce total.")).toBeDefined();
    expect(screen.getByText(t("drawer.openHelp"))).toBeDefined();
    expect(drawer).toHaveBeenCalledTimes(1);
  });

  it("goes back to the overview without opening", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.openAction") }));

    await user.click(button(t("drawer.back")));

    expect(screen.getByText(t("drawer.isClosed"))).toBeDefined();
    expect(drawerOpen).not.toHaveBeenCalled();
  });
});

describe("an open drawer", () => {
  it("shows who opened it, on what float, and what it should hold now", async () => {
    drawer.mockResolvedValue(open);
    show();

    expect(await screen.findByText(new RegExp(`Ana`))).toBeDefined();
    expect(screen.getByText(formatMoney(10000, "EUR"))).toBeDefined();
    expect(screen.getByText(t("drawer.holds"))).toBeDefined();
    expect(screen.getByText(formatMoney(18500, "EUR"))).toBeDefined();
    expect(screen.getByText(t("drawer.noMovements"))).toBeDefined();
    // "Expected" belongs to a count; there is none yet.
    expect(screen.queryByText(t("drawer.expected"))).toBeNull();
    expect(button(t("drawer.countAction"))).toBeDefined();
  });

  it("says when it was opened even with no name to go with it", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ opened_by: "" }) });
    show();

    expect(await screen.findByText(/^Open since|^Ouverte depuis/)).toBeDefined();
  });

  it("lists the money put in and taken out, with the reasons", async () => {
    drawer.mockResolvedValue({
      ...open,
      session: session({
        movements: [
          { seq: 2, kind: "in", datetime: recently(), amount: "50.00", reason: "Monnaie", cashier: "Ana", device: "" },
          { seq: 3, kind: "out", datetime: recently(), amount: "20.00", reason: "Glaçons", cashier: "", device: "" },
        ],
      }),
    });
    show();

    const moves = await screen.findByRole("list");
    expect(within(moves).getByText("Monnaie")).toBeDefined();
    expect(within(moves).getByText(`+${formatMoney(5000, "EUR")}`)).toBeDefined();
    expect(within(moves).getByText(`−${formatMoney(2000, "EUR")}`)).toBeDefined();
  });

  it("puts money in, with its reason", async () => {
    drawer.mockResolvedValue(open);
    drawerMovement.mockResolvedValue(answer(open, { kind: "in" }));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.in") }));

    expect(screen.getByText(t("drawer.inHelp"))).toBeDefined();
    await user.type(screen.getByLabelText(t("drawer.reason")), " Monnaie ");
    await user.click(button("5"));
    await user.click(button("00"));
    await user.click(button("0"));
    await user.click(button(t("drawer.putIn", { amount: formatMoney(5000, "EUR") })));

    expect(drawerMovement).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      kind: "in",
      amount: "50.00",
      reason: "Monnaie",
      cashier: "Ana",
    });
    expect(await screen.findByText(t("drawer.float"))).toBeDefined();
  });

  it("takes money out only with an amount and a reason", async () => {
    drawer.mockResolvedValue(open);
    drawerMovement.mockResolvedValue(answer(open, { kind: "out" }));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.out") }));
    const takeOut = (cents: number) =>
      button(t("drawer.takeOut", { amount: formatMoney(cents, "EUR") }));

    expect(screen.getByText(t("drawer.outHelp"))).toBeDefined();
    expect(takeOut(0)).toHaveProperty("disabled", true);
    await user.click(button("2"));
    await user.click(button("00"));
    await user.click(button("0"));
    expect(takeOut(2000)).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText(t("drawer.reason")), "   ");
    expect(takeOut(2000)).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText(t("drawer.reason")), "Coffre");
    await user.click(takeOut(2000));

    expect(drawerMovement).toHaveBeenCalledWith(pairing, expect.objectContaining({
      kind: "out", amount: "20.00", reason: "Coffre",
    }));
  });

  it("goes back from a movement without recording it", async () => {
    drawer.mockResolvedValue(open);
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.out") }));

    await user.click(button(t("drawer.back")));

    expect(screen.getByText(t("drawer.float"))).toBeDefined();
    expect(drawerMovement).not.toHaveBeenCalled();
  });

  it("shows the drawer closed when it was closed on the other tablet meanwhile", async () => {
    drawer.mockResolvedValueOnce(open).mockResolvedValue(closed);
    drawerMovement.mockRejectedValue(refused("drawer_closed", "La caisse n’est pas ouverte."));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.in") }));
    await user.type(screen.getByLabelText(t("drawer.reason")), "Monnaie");
    await user.click(button("5"));

    await user.click(button(t("drawer.putIn", { amount: formatMoney(5, "EUR") })));

    expect(await screen.findByText("La caisse n’est pas ouverte.")).toBeDefined();
    expect(await screen.findByText(t("drawer.isClosed"))).toBeDefined();
  });

  it("says what the drawer should hold, and where that comes from", async () => {
    // The organiser opened on 150, sold in cash, and found only the float on
    // this screen: what should be in the drawer has to be there all evening.
    drawer.mockResolvedValue({
      ...open,
      session: session({
        opening_float: "150.00", cash_sales: "12.00", cash_returned: "-2.00",
        cash_in: "20.00", cash_out: "5.00", expected: "175.00",
      }),
    });
    show();

    const sum = (await screen.findByText(t("drawer.holds"))).closest(".drawer-sum") as HTMLElement;
    const line = (label: string) => within(sum).getByText(label).nextElementSibling?.textContent;
    expect(line(t("drawer.float"))).toBe(formatMoney(15000, "EUR"));
    expect(line(t("drawer.cashSales"))).toBe(`+${formatMoney(1200, "EUR")}`);
    expect(line(t("drawer.cashReturned"))).toBe(`−${formatMoney(200, "EUR")}`);
    expect(line(t("drawer.cashIn"))).toBe(`+${formatMoney(2000, "EUR")}`);
    expect(line(t("drawer.cashOut"))).toBe(`−${formatMoney(500, "EUR")}`);
    expect(line(t("drawer.holds"))).toBe(formatMoney(17500, "EUR"));
  });

  it("leaves off the lines that are still zero, but never the sales", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ cash_sales: "0.00", expected: "100.00" }) });
    show();

    const sum = (await screen.findByText(t("drawer.holds"))).closest(".drawer-sum") as HTMLElement;
    expect(within(sum).getByText(t("drawer.cashSales"))).toBeDefined();
    expect(within(sum).queryByText(t("drawer.cashReturned"))).toBeNull();
    expect(within(sum).queryByText(t("drawer.cashIn"))).toBeNull();
    expect(within(sum).queryByText(t("drawer.cashOut"))).toBeNull();
  });

  it("says what a drawer left open since another day should hold, for whoever closes it", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ stale: true, expected: "142.50" }) });
    show();

    expect(await screen.findByText(t("drawer.holds"))).toBeDefined();
    expect(screen.getByText(formatMoney(14250, "EUR"))).toBeDefined();
  });

  it("counts, then shows what was expected beside the count", async () => {
    drawer.mockResolvedValue(open);
    const counted = { ...open, session: session({ count: aCount() }) };
    drawerCount.mockResolvedValue(answer(counted, { kind: "count", expected: "185.00", difference: "-1.00" }));
    const { user, onState } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.countAction") }));

    expect(screen.getByText(t("drawer.countHelp"))).toBeDefined();
    await user.click(button(t("count.byAmount")));
    for (const digit of ["1", "8", "4", "0", "0"]) await user.click(button(digit));
    await user.click(button(t("drawer.countRecord")));

    expect(drawerCount).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      amount: "184.00",
      cashier: "Ana",
    });
    expect(await screen.findByText(t("drawer.short", { amount: formatMoney(100, "EUR") }))).toBeDefined();
    const result = document.querySelector(".drawer-result") as HTMLElement;
    expect(within(result).getByText(formatMoney(18500, "EUR"))).toBeDefined();
    expect(within(result).getByText(formatMoney(-100, "EUR"))).toBeDefined();
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ session: counted.session }));
  });

  it("says when the count is right, and when there is more than expected", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ count: aCount({ difference: "0.00", expected: "184.00" }) }) });
    show();
    expect(await screen.findByText(t("drawer.right"))).toBeDefined();
  });

  it("puts a plus sign on money found over", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ count: aCount({ difference: "2.50", expected: "181.50" }) }) });
    show();

    expect(await screen.findByText(t("drawer.over", { amount: formatMoney(250, "EUR") }))).toBeDefined();
    expect(screen.getByText(`+${formatMoney(250, "EUR")}`)).toBeDefined();
  });

  it("closes on the count just made, with the note for the report", async () => {
    const counted = { ...open, session: session({ count: aCount() }) };
    drawer.mockResolvedValue(counted);
    const done: DrawerState = {
      drawer: info,
      session: null,
      last_closed: {
        id: 9, opened_at: recently(), closed_at: recently(), cashier: "Ana",
        amount: "184.00", expected: "185.00", difference: "-1.00",
      },
    };
    drawerClose.mockResolvedValue(answer(done, { kind: "close" }));
    const { user, onClose } = show();

    await user.type(await screen.findByLabelText(t("drawer.note")), "Un euro rendu en trop");
    await user.click(button(t("drawer.closeAction")));

    expect(drawerClose).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      count_seq: 7,
      reason: "Un euro rendu en trop",
      cashier: "Ana",
    });
    // The closing stays on screen: it is the receipt for the evening.
    expect(await screen.findByText(t("drawer.isClosed"))).toBeDefined();
    expect(screen.getByText(t("drawer.short", { amount: formatMoney(100, "EUR") }))).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("counts again on request", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ count: aCount() }) });
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("drawer.recount") }));

    expect(screen.getByText(t("drawer.countHelp"))).toBeDefined();
    expect(button(t("drawer.countRecord"))).toBeDefined();
  });

  it("asks for a new count when something was sold since the last one", async () => {
    drawer.mockResolvedValue({ ...open, session: session({ count: aCount({ current: false }) }) });
    show();

    expect(await screen.findByText(/184,00|184\.00/)).toBeDefined();
    expect(screen.queryByText(t("drawer.expected"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("drawer.closeAction") })).toBeNull();
    expect(button(t("drawer.countAction"))).toBeDefined();
  });

  it("reads the drawer again when a sale beat the closing to it", async () => {
    drawer
      .mockResolvedValueOnce({ ...open, session: session({ count: aCount() }) })
      .mockResolvedValue({ ...open, session: session({ count: aCount({ current: false }) }) });
    drawerClose.mockRejectedValue(refused("count_stale", "Recomptez."));
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("drawer.closeAction") }));

    expect(await screen.findByText("Recomptez.")).toBeDefined();
    expect(await screen.findByRole("button", { name: t("drawer.countAction") })).toBeDefined();
  });
});

describe("a drawer left open since an earlier day", () => {
  const stale = { ...open, session: session({ stale: true, opened_at: "2026-09-12T16:00:00Z" }) };

  it("says so, and offers only to close it without counting", async () => {
    drawer.mockResolvedValue(stale);
    show();

    expect(await screen.findByText(new RegExp(t("drawer.staleHelp").slice(0, 20)))).toBeDefined();
    expect(button(t("drawer.closeUncounted"))).toBeDefined();
    expect(screen.queryByRole("button", { name: t("drawer.in") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("drawer.countAction") })).toBeNull();
  });

  it("closes it uncounted once confirmed", async () => {
    drawer.mockResolvedValue(stale);
    drawerClose.mockResolvedValue(answer(closed, { kind: "close", amount: null }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("drawer.closeUncounted") }));

    expect(confirm).toHaveBeenCalledWith(t("drawer.closeUncountedConfirm", { name: "Bar" }));
    expect(drawerClose).toHaveBeenCalledWith(pairing, {
      idempotency_key: expect.any(String),
      uncounted: true,
      cashier: "Ana",
    });
    expect(await screen.findByText(t("drawer.isClosed"))).toBeDefined();
  });

  it("does nothing when the question is answered no", async () => {
    drawer.mockResolvedValue(stale);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("drawer.closeUncounted") }));

    expect(drawerClose).not.toHaveBeenCalled();
  });

  it("closes on a count made that evening and never closed on", async () => {
    drawer.mockResolvedValue({ ...stale, session: { ...stale.session, count: aCount() } });
    drawerClose.mockResolvedValue(answer(closed, { kind: "close" }));
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("drawer.closeAction") }));

    expect(drawerClose).toHaveBeenCalledWith(pairing, expect.objectContaining({ count_seq: 7 }));
    expect(screen.queryByRole("button", { name: t("drawer.closeUncounted") })).toBeNull();
  });
});

describe("with no network", () => {
  it("says so and offers nothing that would need the server", async () => {
    drawer.mockResolvedValue(open);
    show({ online: false });

    expect(await screen.findByText(t("drawer.offline"))).toBeDefined();
    expect(button(t("drawer.in"))).toHaveProperty("disabled", true);
    expect(button(t("drawer.countAction"))).toHaveProperty("disabled", true);
    expect(button(t("drawer.back"))).toHaveProperty("disabled", false);
  });

  it("cannot open a closed drawer either", async () => {
    show({ online: false });

    expect(await screen.findByRole("button", { name: t("drawer.openAction") })).toHaveProperty("disabled", true);
  });
});

it("says it is recording while a request is on its way", async () => {
  let finish: (value: DrawerAnswer) => void = () => {};
  drawerCount.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  drawer.mockResolvedValue(open);
  const { user } = show();
  await user.click(await screen.findByRole("button", { name: t("drawer.countAction") }));

  await user.click(button(t("drawer.countRecord")));

  expect(button(t("drawer.working"))).toHaveProperty("disabled", true);
  expect(button(t("drawer.back"))).toHaveProperty("disabled", true);
  finish(answer({ ...open, session: session({ count: aCount() }) }));
  expect(await screen.findByRole("button", { name: t("drawer.closeAction") })).toBeDefined();
});

it("drops a read that was still on its way when the panel closed", async () => {
  let reject: (e: unknown) => void = () => {};
  drawer.mockReturnValue(new Promise((_, no) => (reject = no)));
  const { onState, unmount } = show();
  const signal: AbortSignal = drawer.mock.calls[0][1];

  unmount();
  expect(signal.aborted).toBe(true);
  reject(new DOMException("aborted", "AbortError"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onState).not.toHaveBeenCalled();
});
