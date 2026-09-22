import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    config: vi.fn(),
    catalog: vi.fn(),
    checkout: vi.fn(),
    terminalStart: vi.fn(),
    terminalStatus: vi.fn(),
    terminalCancel: vi.fn(),
    history: vi.fn(),
    cancelSale: vi.fn(),
    summary: vi.fn(),
    attendance: vi.fn(),
    posEvents: vi.fn(),
    offlineSnapshot: vi.fn(),
    searchAttendees: vi.fn(),
    redeem: vi.fn(),
    initialize: vi.fn(),
  },
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: apiMock };
});

// No camera in jsdom, and the door has its own tests. What is kept is the
// way out, so a test can close the door again.
vi.mock("./components/QrScanner", () => ({
  default: ({ title, footer, children, onClose }: {
    title: string; footer?: React.ReactNode; children?: React.ReactNode; onClose: () => void;
  }) => (
    <div>
      <h2>{title}</h2>
      <button onClick={onClose}>close-scanner</button>
      {footer}
      {children}
    </div>
  ),
}));

import App from "./App";
import { ApiError } from "./api";
import { markReachable, markUnreachable } from "./connectivity";
import { t } from "./i18n";
import { formatMoney } from "./money";
import {
  loadCashier, loadPairing, loadQueue, savePairing, saveFailures, saveQueue,
} from "./storage";
import { fillStorage } from "./test/setup";
import type { Catalog, JournalLine, PosConfig, SaleResult } from "./types";

/**
 * The till as a whole.
 *
 * These are the paths a night actually takes: ring something up, take the
 * money, hand back change, and — the ones that matter most — what happens when
 * the server is not there at the moment the drawer closes. A sale that has been
 * paid for must end up somewhere it will be replayed from, or the operator must
 * be told while the customer is still standing there. There is no third
 * acceptable outcome.
 */

const pairing = {
  token: "tok", organizer: "demo", event: "festival",
  serial: "TILL1", deviceName: "Caisse bar",
};

function config(overrides: Partial<PosConfig> = {}): PosConfig {
  return {
    version: __APP_VERSION__,
    event: {
      slug: "festival", organizer: "demo", name: "Festival",
      currency: "EUR", testmode: false, timezone: "Europe/Paris",
    },
    device: { serial: "TILL1", name: "Caisse bar" },
    checkin: {
      enabled: true, list_id: 7, list_name: "Porte",
      lists: [{ id: 7, name: "Porte", all_products: true, include_pending: false }],
    },
    admission_items: [20],
    cash_denominations: ["5.00", "10.00", "20.00"],
    ...overrides,
  };
}

const catalog: Catalog = {
  categories: [
    {
      id: 1,
      name: "Bar",
      items: [
        {
          id: 10, name: "Bière", admission: false, picture: null,
          price: "3.00", available: null, variations: [],
        },
        {
          id: 11, name: "Vin", admission: false, picture: null,
          price: "4.00", available: 2, variations: [],
        },
        {
          id: 20, name: "Entrée", admission: true, picture: null,
          price: "10.00", available: null, variations: [],
        },
      ],
    },
  ],
};

function sold(overrides: Partial<SaleResult> = {}): SaleResult {
  return {
    order: { code: "POS01", total: "3.00", url: null },
    journal_seq: 1,
    payment_type: "cash",
    cash_given: null,
    cash_change: null,
    datetime: "2026-08-16T22:02:00.000Z",
    replayed: false,
    checked_in: 0,
    checkin_errors: [],
    ...overrides,
  };
}

/** Pretend the app is installed to the home screen, which is the normal case. */
function installed(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query.includes("standalone") }),
  });
}

function show() {
  render(<App />);
  return { user: userEvent.setup() };
}

/** Wait until the catalogue is on screen. */
async function ready() {
  await screen.findByRole("button", { name: /Bière/ });
}

/** Ring up one beer and open the payment panel. */
async function ringUp(user: ReturnType<typeof userEvent.setup>, product = /Bière/) {
  await user.click(screen.getByRole("button", { name: product }));
  await user.click(screen.getByRole("button", { name: t("sale.charge") }));
}

/** Answer the panel's first question — how the customer is paying — with cash. */
async function payCash(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: t("payment.cash") }));
}

/** Answer the panel's first question with cash, then confirm it as it stands. */
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await payCash(user);
  await user.click(screen.getByRole("button", { name: t("payment.confirm") }));
}

beforeEach(() => {
  installed();
  markReachable();
  savePairing(pairing);
  apiMock.config.mockResolvedValue(config());
  apiMock.catalog.mockResolvedValue(catalog);
  apiMock.checkout.mockResolvedValue(sold());
  apiMock.history.mockResolvedValue({ device: "TILL1", results: [], truncated: false });
  apiMock.summary.mockResolvedValue({
    since: "2026-08-16T04:00:00Z",
    device: null,
    event: { count: 0, cancellations: 0, cash: "0.00", card: "0.00", total: "0.00" },
  });
  apiMock.posEvents.mockResolvedValue({ results: [] });
  apiMock.attendance.mockResolvedValue({
    list: { id: 7, name: "Porte" }, computed_at: "2026-08-16T22:30:00.000Z",
    inside: 0, entered: 0, exited: 0, expected: 0, not_arrived: 0,
    non_admission_entered: 0, items: [],
  });
  apiMock.offlineSnapshot.mockResolvedValue({
    list: { id: 7, name: "Porte" }, generated: "2026-08-16T20:00:00.000Z",
    tickets: [], truncated: false,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
  markReachable();
});

describe("getting to the till", () => {
  it("insists on being installed before it will sell anything", () => {
    // A tab has an address bar over the basket and a pull-to-refresh gesture
    // across it.
    Object.defineProperty(window, "matchMedia", {
      configurable: true, value: () => ({ matches: false }),
    });
    show();

    expect(screen.getByText(t("gate.title"))).toBeDefined();
  });

  it("asks to be paired when it never has been", () => {
    localStorage.clear();
    show();

    expect(screen.getByText(t("pairing.title"))).toBeDefined();
  });

  it("opens on the event it is paired to", async () => {
    show();

    expect(await screen.findByRole("heading", { name: "Festival" })).toBeDefined();
  });

  it("marks an event running in test mode, loudly", async () => {
    // A night sold into test mode is a night's takings that do not exist.
    apiMock.config.mockResolvedValue(config({
      event: { ...config().event, testmode: true },
    }));
    show();

    expect(await screen.findByText(t("testmode"))).toBeDefined();
  });

  it("says why when it cannot be loaded at all", async () => {
    apiMock.config.mockRejectedValue(new ApiError(0, "network"));
    apiMock.catalog.mockRejectedValue(new ApiError(0, "network"));
    show();

    expect(await screen.findByText(t("error.offline"))).toBeDefined();
  });

  it("says so, and keeps the pairing, when the server refuses the till", async () => {
    // A 403 is what a revoked device gets — and what a CDN or a firewall in
    // front of pretix answers with when it challenges a request. A till that
    // unpaired itself on the second kind could not be brought back without
    // somebody at the back office minting a new code.
    apiMock.config.mockRejectedValue(new ApiError(403, "Unknown device."));
    apiMock.catalog.mockRejectedValue(new ApiError(403, "Unknown device."));
    show();

    expect(
      await screen.findByText(t("error.refused", { detail: "Unknown device." })),
    ).toBeDefined();
    expect(loadPairing()).not.toBeNull();
  });

  it("does not open on the cached catalogue when the till has been refused", async () => {
    // A revoked device selling from a stale catalogue would only be refused
    // again at the first sale, in front of a customer.
    const { user } = show();
    await ready();
    apiMock.config.mockRejectedValue(new ApiError(401, "Invalid token."));
    apiMock.catalog.mockRejectedValue(new ApiError(401, "Invalid token."));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.refresh") }));

    expect(
      await screen.findByText(t("error.refused", { detail: "Invalid token." })),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Bière/ })).toBeNull();
  });

  it("lets a refused till try again", async () => {
    apiMock.config.mockRejectedValueOnce(new ApiError(403, "Unknown device."));
    apiMock.catalog.mockRejectedValueOnce(new ApiError(403, "Unknown device."));
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: "Unknown device." }));

    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    expect(await screen.findByRole("button", { name: /Bière/ })).toBeDefined();
  });

  it("lets a refused till be unpaired, once the operator has confirmed", async () => {
    apiMock.config.mockRejectedValue(new ApiError(401, "Invalid token."));
    apiMock.catalog.mockRejectedValue(new ApiError(401, "Invalid token."));
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: "Invalid token." }));

    await user.click(screen.getByRole("button", { name: t("settings.unpair") }));

    expect(screen.getByText(t("pairing.title"))).toBeDefined();
    expect(loadPairing()).toBeNull();
    confirmed.mockRestore();
  });

  it("keeps a refused till paired when the operator thinks again", async () => {
    apiMock.config.mockRejectedValue(new ApiError(401, "Invalid token."));
    apiMock.catalog.mockRejectedValue(new ApiError(401, "Invalid token."));
    const declined = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: "Invalid token." }));

    await user.click(screen.getByRole("button", { name: t("settings.unpair") }));

    expect(screen.queryByText(t("pairing.title"))).toBeNull();
    expect(loadPairing()).not.toBeNull();
    declined.mockRestore();
  });

  it("opens on what it was last told when the server is unreachable", async () => {
    // A till that had been here before must not become a brick mid-evening.
    const { user } = show();
    await ready();
    apiMock.config.mockRejectedValue(new ApiError(0, "network"));
    apiMock.catalog.mockRejectedValue(new ApiError(0, "network"));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.refresh") }));

    expect(await screen.findByRole("button", { name: /Bière/ })).toBeDefined();
  });

  it("offers another go at loading", async () => {
    apiMock.config.mockRejectedValueOnce(new ApiError(0, "network"));
    apiMock.catalog.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();
    await screen.findByText(t("error.offline"));

    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    expect(await screen.findByRole("button", { name: /Bière/ })).toBeDefined();
  });
});

describe("the basket", () => {
  it("takes a product on a tap", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: /Bière/ }));

    expect(screen.getByRole("button", { name: t("sale.charge") })).toHaveProperty(
      "disabled", false,
    );
  });

  it("adds to the line rather than making a second one", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: /Bière/ }));
    await user.click(screen.getByRole("button", { name: /Bière/ }));

    expect(screen.getByText("2")).toBeDefined();
  });

  it("will not take more than the quota allows", async () => {
    // A basket that can only be refused at checkout, after the customer has
    // been told a total, is the failure this prevents.
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: /Vin/ }));
    await user.click(screen.getByRole("button", { name: /Vin/ }));
    await user.click(screen.getByRole("button", { name: /Vin/ }));

    expect(screen.getByText("2")).toBeDefined();
  });

  it("drops a line taken down to nothing", async () => {
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: /Bière/ }));

    await user.click(screen.getByRole("button", { name: "−" }));

    expect(screen.getByText(t("sale.empty"))).toBeDefined();
  });

  it("empties on the clear button", async () => {
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: /Bière/ }));

    await user.click(screen.getByRole("button", { name: t("sale.clear") }));

    expect(screen.getByText(t("sale.empty"))).toBeDefined();
  });
});

describe("taking the money", () => {
  it("tells the server what the customer was just told", async () => {
    // The server refuses rather than charge a figure the customer never heard.
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    await waitFor(() =>
      expect(apiMock.checkout).toHaveBeenCalledWith(
        pairing,
        expect.objectContaining({
          positions: [{ item: 10, variation: null, count: 1 }],
          payment_type: "cash",
          expected_total: "3.00",
        }),
      ),
    );
  });

  it("shows the sale, then clears the basket for the next customer", async () => {
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    expect(await screen.findByText(t("done.sold"))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("done.next") }));
    expect(screen.getByText(t("sale.empty"))).toBeDefined();
  });

  it("names the cashier on the sale", async () => {
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.type(await screen.findByLabelText(t("settings.cashier")), "Ana");
    await user.click(screen.getByRole("button", { name: t("settings.close") }));
    await ringUp(user);

    await confirm(user);

    await waitFor(() =>
      expect(apiMock.checkout).toHaveBeenCalledWith(
        pairing, expect.objectContaining({ cashier: "Ana" }),
      ),
    );
  });

  it("keeps the same key across a retry, so a timeout cannot sell twice", async () => {
    // If the request did commit before the answer went missing, the replay
    // recognises it and returns the original order.
    apiMock.checkout.mockRejectedValueOnce(new ApiError(400, "Sold out."));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);
    await screen.findByText("Sold out.");
    await confirm(user);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledTimes(2));
    const [[, first], [, second]] = apiMock.checkout.mock.calls;
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });

  it("mints a new key for the next customer", async () => {
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);
    await screen.findByText(t("done.sold"));
    await user.click(screen.getByRole("button", { name: t("done.next") }));

    await ringUp(user);
    await confirm(user);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledTimes(2));
    const [[, first], [, second]] = apiMock.checkout.mock.calls;
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it("says a check-in failed rather than letting it pass unnoticed", async () => {
    apiMock.checkout.mockResolvedValue(
      sold({ checked_in: 0, checkin_errors: ["Already redeemed"] }),
    );
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    expect(await screen.findByText(t("done.checkinFailed"))).toBeDefined();
  });

  it("backs out of the panel without recording anything", async () => {
    const { user } = show();
    await ready();
    await ringUp(user);

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(apiMock.checkout).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("sale.charge") })).toBeDefined();
  });
});

describe("when the server refuses the sale", () => {
  it("says why, and keeps the basket", async () => {
    // The server understood and said no; queueing it would only mean being
    // refused again later, out of sight of anyone who could fix it.
    apiMock.checkout.mockRejectedValue(new ApiError(400, "This product is not on sale here."));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    expect(await screen.findByText("This product is not on sale here.")).toBeDefined();
    expect(loadQueue()).toEqual([]);
  });

  it("re-prices the basket in place when the tariff moved under it", async () => {
    // Nothing was charged. The panel stays open showing the figure that will
    // actually be taken.
    apiMock.checkout.mockRejectedValue(
      new ApiError(409, "Prices changed.", { code: "price_changed" }),
    );
    apiMock.catalog.mockResolvedValue({
      categories: [{
        ...catalog.categories[0],
        items: [{ ...catalog.categories[0].items[0], price: "3.50" }],
      }],
    });
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    await screen.findByText("Prices changed.");
    // Read off the panel the customer is being quoted from, not the grid.
    const panel = document.querySelector(".pay-panel") as HTMLElement;
    await waitFor(() =>
      expect(
        within(within(panel).getByText(t("payment.due")).parentElement as HTMLElement)
          .getByText(formatMoney(350, "EUR")),
      ).toBeDefined(),
    );
  });
});

describe("the two buttons that are not products", () => {
  /** A till with both extras switched on, and a one-euro deposit. */
  const withExtras = () =>
    config({
      custom_sale: { enabled: true, item: 30, name: "Divers" },
      deposit: { enabled: true, item: 31, name: "Consigne", price: "1.00" },
    });

  const tile = (key: "custom.tile" | "deposit.tile") =>
    screen.getByRole("button", { name: new RegExp(t(key)) });

  it("shows neither until the organiser has set one up", async () => {
    show();
    await ready();

    expect(screen.queryByRole("button", { name: new RegExp(t("custom.tile")) })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(t("deposit.tile")) })).toBeNull();
  });

  it("sends a free amount with its price and its reason", async () => {
    apiMock.config.mockResolvedValue(withExtras());
    const { user } = show();
    await ready();

    await user.click(tile("custom.tile"));
    for (const digit of "1250") {
      await user.click(screen.getByRole("button", { name: digit }));
    }
    await user.type(screen.getByLabelText(t("custom.reason")), "Verre cassé");
    await user.click(screen.getByRole("button", { name: t("custom.add") }));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));
    await confirm(user);

    await waitFor(() =>
      expect(apiMock.checkout).toHaveBeenCalledWith(
        pairing,
        expect.objectContaining({
          positions: [
            { item: 30, variation: null, count: 1, price: "12.50", description: "Verre cassé" },
          ],
          expected_total: "12.50",
        }),
      ),
    );
  });

  it("names a free amount in the basket by its reason", async () => {
    apiMock.config.mockResolvedValue(withExtras());
    const { user } = show();
    await ready();

    await user.click(tile("custom.tile"));
    await user.click(screen.getByRole("button", { name: "5" }));
    await user.click(screen.getByRole("button", { name: "00" }));
    await user.type(screen.getByLabelText(t("custom.reason")), "Don");
    await user.click(screen.getByRole("button", { name: t("custom.add") }));

    // "Divers · 5,00 €" would be true and useless; the reason is the whole
    // point of the line.
    expect(screen.getByText("Don")).toBeDefined();
  });

  it("nets a returned deposit off the basket it is in", async () => {
    apiMock.config.mockResolvedValue(withExtras());
    const { user } = show();
    await ready();

    // Two beers at 3 €, three cups back at 1 €.
    await user.click(screen.getByRole("button", { name: /Bière/ }));
    await user.click(screen.getByRole("button", { name: /Bière/ }));
    for (let i = 0; i < 3; i += 1) await user.click(tile("deposit.tile"));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));
    await confirm(user);

    await waitFor(() =>
      expect(apiMock.checkout).toHaveBeenCalledWith(
        pairing,
        expect.objectContaining({
          positions: [
            { item: 10, variation: null, count: 2 },
            // No price: the server knows what a deposit costs, and this is
            // still a till that does not name its own prices.
            { item: 31, variation: null, count: 3, refund: true },
          ],
          expected_total: "3.00",
        }),
      ),
    );
  });

  it("hands money over for cups returned with nothing bought", async () => {
    apiMock.config.mockResolvedValue(withExtras());
    apiMock.checkout.mockResolvedValue(
      sold({
        order: { code: "", total: "0.00", url: null },
        deposit_refund: "2.00",
        net_total: "-2.00",
      }),
    );
    const { user } = show();
    await ready();

    await user.click(tile("deposit.tile"));
    await user.click(tile("deposit.tile"));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));

    // Nothing to take, so nothing to type: the panel says what to count out.
    await payCash(user);
    expect(screen.getByText(t("payment.nothingToTake"))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));

    await waitFor(() =>
      expect(apiMock.checkout).toHaveBeenCalledWith(
        pairing,
        // null, not "0.00": no note crossed the counter.
        expect.objectContaining({ cash_given: null, expected_total: "-2.00" }),
      ),
    );
    expect(await screen.findByText(t("done.giveBack"))).toBeDefined();
  });

  it("queues both kinds of line when the server is not there", async () => {
    apiMock.config.mockResolvedValue(withExtras());
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: /Bière/ }));
    await user.click(tile("deposit.tile"));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));
    await confirm(user);

    await screen.findByText(/kept on this till/);
    // Both lines priced, as an offline sale must be, and each still saying
    // which kind it is so the replay records it the same way.
    expect(loadQueue()[0]).toEqual(
      expect.objectContaining({
        chargedTotal: "2.00",
        positions: [
          { item: 10, variation: null, count: 1, price: "3.00" },
          { item: 31, variation: null, count: 1, price: "-1.00", refund: true },
        ],
      }),
    );
  });
});

describe("when the server is not there", () => {
  it("queues the sale rather than losing it", async () => {
    // The money is in the drawer. There is nowhere else for this sale to go.
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    await screen.findByText(/kept on this till/);
    expect(loadQueue()).toEqual([
      expect.objectContaining({ kind: "sale", chargedTotal: "3.00", label: "1× Bière" }),
    ]);
  });

  it("queues it under the very key the failed request carried", async () => {
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    await screen.findByText(/kept on this till/);
    const [[, sent]] = apiMock.checkout.mock.calls;
    expect(loadQueue()[0].id).toBe(sent.idempotency_key);
  });

  it("queues it on a server fault too", async () => {
    // A 502 from a restarting proxy is not a refusal.
    apiMock.checkout.mockRejectedValue(new ApiError(502, "bad gateway"));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    await screen.findByText(/kept on this till/);
    expect(loadQueue()).toHaveLength(1);
  });

  it("does not even try the network when it knows it is down", async () => {
    const { user } = show();
    await ready();
    await ringUp(user);
    act(() => markUnreachable());

    await confirm(user);

    await screen.findByText(/kept on this till/);
    expect(apiMock.checkout).not.toHaveBeenCalled();
  });

  it("records what admits somebody, so the door screen still says to let them in", async () => {
    const { user } = show();
    await ready();
    act(() => markUnreachable());
    await ringUp(user, /Entrée/);

    await confirm(user);

    expect(await screen.findByText(t("done.admitted"))).toBeDefined();
  });

  it("tells the operator while the customer is still there when it cannot queue", async () => {
    // Being shown a receipt for a sale that will never exist is the one
    // outcome that is not acceptable.
    const { user } = show();
    await ready();
    act(() => markUnreachable());
    await ringUp(user);
    fillStorage();

    await confirm(user);

    expect(await screen.findByText(t("offline.queueFailed"))).toBeDefined();
  });
});

describe("the queue", () => {
  it("is counted in the top bar", async () => {
    saveQueue([{
      kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z",
      event: "festival", list: 7, secret: "s", name: "Alice",
    }]);
    act(() => markUnreachable());
    show();
    await ready();

    expect(
      screen.getByRole("button", { name: t("offline.badgeOffline", { n: 1 }) }),
    ).toBeDefined();
  });

  it("is emptied on sight when the till starts up with a network", async () => {
    // Nobody has to remember to press anything: the badge that greets an
    // operator at the start of a shift is one they cannot act on.
    saveQueue([{
      kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z",
      event: "festival", list: 7, secret: "s", name: "Alice",
    }]);
    apiMock.redeem.mockResolvedValue({ status: "ok" });
    show();
    await ready();

    await waitFor(() => expect(loadQueue()).toEqual([]));
  });

  it("says the till is cut off rather than merely behind", async () => {
    show();
    await ready();

    act(() => markUnreachable());

    expect(
      await screen.findByRole("button", { name: t("offline.badgeOffline", { n: 0 }) }),
    ).toBeDefined();
  });

  it("stays out of the top bar when there is nothing to say", async () => {
    show();
    await ready();

    expect(screen.queryByRole("button", { name: /offline|attente/i })).toBeNull();
  });

  it("opens the panel that explains itself", async () => {
    const { user } = show();
    await ready();
    act(() => markUnreachable());

    await user.click(await screen.findByRole("button", {
      name: t("offline.badgeOffline", { n: 0 }),
    }));

    expect(screen.getByText(t("offline.title"))).toBeDefined();
  });

  it("empties itself when the network comes back", async () => {
    apiMock.checkout.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);
    await screen.findByText(/kept on this till/);
    apiMock.checkout.mockResolvedValue(sold());

    await act(async () => {
      markReachable();
    });

    await waitFor(() => expect(loadQueue()).toEqual([]));
  });

  it("is sent on demand once the server will take it", async () => {
    // The automatic drain had already tried and been refused; this is the
    // button an operator presses when they can see the wifi is back.
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);
    await screen.findByText(/kept on this till/);
    await user.click(screen.getByRole("button", { name: t("done.next") }));
    await user.click(await screen.findByRole("button", {
      name: t("offline.badgePending", { n: 1 }),
    }));
    apiMock.checkout.mockResolvedValue(sold());

    await user.click(screen.getByRole("button", { name: t("offline.sync") }));

    await waitFor(() => expect(loadQueue()).toEqual([]));
  });

  it("stops being announced once it is empty", async () => {
    apiMock.checkout.mockRejectedValueOnce(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);
    await screen.findByText(/kept on this till/);
    apiMock.checkout.mockResolvedValue(sold());

    await user.click(screen.getByRole("button", { name: t("done.next") }));

    await waitFor(() => expect(loadQueue()).toEqual([]));
    expect(
      screen.queryByRole("button", { name: t("offline.badgePending", { n: 1 }) }),
    ).toBeNull();
  });

  it("goes on announcing a refusal after the queue has drained", async () => {
    // The rule the whole offline mode rests on is that no refusal is ever
    // swallowed. The badge is the only door to the panel that shows them, and
    // it used to close the moment the queue emptied — taking the unread
    // refusal with it.
    saveFailures([{
      entry: {
        kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z",
        event: "festival", list: 7, secret: "s", name: "Alice",
      },
      at: "2026-08-16T22:05:00.000Z",
      message: "Already scanned",
    }]);

    show();
    await ready();

    expect(loadQueue()).toEqual([]);
    expect(
      await screen.findByRole("button", { name: t("offline.badgeFailed", { n: 1 }) }),
    ).toBeTruthy();
  });

  it("does not replay a queue in the middle of a payment", async () => {
    // Interrupting a half-tendered payment to drain a queue is the worst
    // possible moment.
    saveQueue([{
      kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z",
      event: "festival", list: 7, secret: "s", name: "Alice",
    }]);
    act(() => markUnreachable());
    const { user } = show();
    await ready();
    await ringUp(user);

    await act(async () => {
      markReachable();
    });

    expect(apiMock.redeem).not.toHaveBeenCalled();
  });
});

describe("a new build on the server", () => {
  it("is offered between customers", async () => {
    apiMock.config.mockResolvedValue(config({ version: "99.0.0" }));
    show();
    await ready();

    expect(screen.getByRole("button", { name: t("update.reload") })).toBeDefined();
  });

  it("is not offered over a basket being rung up", async () => {
    apiMock.config.mockResolvedValue(config({ version: "99.0.0" }));
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: /Bière/ }));

    expect(screen.queryByRole("button", { name: t("update.reload") })).toBeNull();
  });

  it("is not offered when the till already reloaded for it", async () => {
    // A deployment whose image carries a bundle older than the plugin beside
    // it can never satisfy this check, and the prompt would sit there all
    // evening asking to be pressed again.
    localStorage.setItem("openpos.updateTried.v1", "99.0.0");
    apiMock.config.mockResolvedValue(config({ version: "99.0.0" }));
    show();
    await ready();

    expect(screen.queryByRole("button", { name: t("update.reload") })).toBeNull();
  });

  it("is not offered by a server too old to report a version", async () => {
    apiMock.config.mockResolvedValue(config({ version: undefined }));
    show();
    await ready();

    expect(screen.queryByRole("button", { name: t("update.reload") })).toBeNull();
  });

  it("drops the caches before reloading, or the reload serves the old bundle", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { keys: vi.fn().mockResolvedValue(["v1"]), delete: remove });
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true, value: { ...window.location, reload, search: "" },
    });
    apiMock.config.mockResolvedValue(config({ version: "99.0.0" }));
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("update.reload") }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledWith("v1");
    // Written before the reload: whatever comes back has to know it tried.
    expect(localStorage.getItem("openpos.updateTried.v1")).toBe("99.0.0");
    vi.unstubAllGlobals();
  });
});

describe("keeping the tariff current", () => {
  it("re-reads it while the till is idle", async () => {
    // A price edited in the back office has to reach the door without anyone
    // relaunching the app.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await ready();
    apiMock.catalog.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(apiMock.catalog).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("holds still under a basket that is being read out to a customer", async () => {
    // Announcing one figure and charging another is the failure here.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: /Bière/ }));
    apiMock.catalog.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(apiMock.catalog).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("re-reads it when the operator comes back to the app", async () => {
    show();
    await ready();
    apiMock.catalog.mockClear();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible", configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(apiMock.catalog).toHaveBeenCalled());
  });
});

describe("correcting a sale", () => {
  const line: JournalLine = {
    seq: 12, kind: "sale", datetime: "2026-08-16T22:02:00.000Z", order: "POS01",
    total: "12.00", payment_type: "cash", cashier: "Ana", testmode: false,
    positions: [{
      item: 10, item_name: "Bière", variation: null, variation_name: null,
      count: 4, unit_price: "3.00", line_total: "12.00",
    }],
    reason: "", cancels_seq: null, cancelled: false, can_cancel: true,
  };

  it("puts the cancelled lines back in the basket, with the credit", async () => {
    apiMock.history.mockResolvedValue({ device: "TILL1", results: [line], truncated: false });
    apiMock.cancelSale.mockResolvedValue({
      cancellation: { ...line, seq: 13, kind: "cancellation", total: "-12.00" },
      sale: line, replayed: false, credit_note: "DEMO-1", refunded: true,
    });
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("history.open") }));
    await user.click(await screen.findByRole("button", { name: /POS01/ }));
    await user.click(screen.getByRole("button", { name: t("history.cancel") }));
    await user.click(await screen.findByRole("button", { name: t("history.correct") }));

    expect(screen.getByText("4")).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));
    expect(screen.getByText(`−${formatMoney(1200, "EUR")}`)).toBeDefined();
    confirmed.mockRestore();
  });

  it("abandons the credit with the basket it belonged to", async () => {
    apiMock.history.mockResolvedValue({ device: "TILL1", results: [line], truncated: false });
    apiMock.cancelSale.mockResolvedValue({
      cancellation: { ...line, seq: 13, kind: "cancellation", total: "-12.00" },
      sale: line, replayed: false, credit_note: null, refunded: true,
    });
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: t("history.open") }));
    await user.click(await screen.findByRole("button", { name: /POS01/ }));
    await user.click(screen.getByRole("button", { name: t("history.cancel") }));
    await user.click(await screen.findByRole("button", { name: t("history.correct") }));

    await user.click(screen.getByRole("button", { name: t("sale.clear") }));
    await user.click(screen.getByRole("button", { name: /Bière/ }));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));

    expect(screen.queryByText(new RegExp(t("payment.stillDue")))).toBeNull();
    confirmed.mockRestore();
  });
});

describe("the settings", () => {
  it("remembers the cashier across a reload", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.type(await screen.findByLabelText(t("settings.cashier")), "Ana");

    expect(loadCashier()).toBe("Ana");
  });

  it("sends the till back to pairing when it is unpaired", async () => {
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(t("settings.unpair")) }));

    expect(screen.getByText(t("pairing.title"))).toBeDefined();
    expect(loadPairing()).toBeNull();
    confirmed.mockRestore();
  });

  it("empties the basket when the till is switched to another event", async () => {
    // The basket belongs to the event it was built for.
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null },
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: /Bière/ }));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.selectOptions(await screen.findByLabelText(t("settings.event")), "gala");

    await waitFor(() => expect(screen.getByText(t("sale.empty"))).toBeDefined());
    expect(loadPairing()?.event).toBe("gala");
  });
});

describe("the door", () => {
  it("is reachable from the top bar when the event has a list", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("checkin.open") }));

    expect(screen.getByRole("heading", { name: t("checkin.title") })).toBeDefined();
  });

  it("is not offered for an event that has no check-in list at all", async () => {
    apiMock.config.mockResolvedValue(config({
      checkin: { enabled: false, list_id: null, list_name: null, lists: [] },
    }));
    show();
    await ready();

    expect(screen.queryByRole("button", { name: t("checkin.open") })).toBeNull();
  });

  it("holds the catalogue still while it is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: t("checkin.open") }));
    apiMock.catalog.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(apiMock.catalog).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("the guest list carried for a dropout", () => {
  const twoDoors = () =>
    config({
      checkin: {
        enabled: true, list_id: 7, list_name: "Porte",
        lists: [
          { id: 7, name: "Porte", all_products: true, include_pending: false },
          { id: 8, name: "VIP", all_products: false, include_pending: false },
        ],
      },
    });

  it("is fetched before the door has ever been opened", async () => {
    // A phone that lost the wifi before anyone had opened the scanner used
    // to have no guest list at all, and its door stayed shut for the dropout.
    show();
    await ready();

    await waitFor(() => expect(apiMock.offlineSnapshot).toHaveBeenCalledWith(pairing, 7));
  });

  it("is fetched for the event's first list when sales do not check in", async () => {
    apiMock.config.mockResolvedValue(config({
      checkin: {
        enabled: false, list_id: null, list_name: null,
        lists: [{ id: 9, name: "Entrée", all_products: true, include_pending: false }],
      },
    }));
    show();
    await ready();

    await waitFor(() => expect(apiMock.offlineSnapshot).toHaveBeenCalledWith(pairing, 9));
  });

  it("is not fetched at all for an event with no list", async () => {
    apiMock.config.mockResolvedValue(config({
      checkin: { enabled: false, list_id: null, list_name: null, lists: [] },
    }));
    show();
    await ready();

    expect(apiMock.offlineSnapshot).not.toHaveBeenCalled();
  });

  it("is left to the door screen while that is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = show();
    await ready();
    await waitFor(() => expect(apiMock.offlineSnapshot).toHaveBeenCalledOnce());
    apiMock.offlineSnapshot.mockClear();

    await user.click(screen.getByRole("button", { name: t("checkin.open") }));
    await waitFor(() => expect(apiMock.offlineSnapshot).toHaveBeenCalledOnce());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    // One fetcher at a time: the door's own refresh, not the app's on top of it.
    expect(apiMock.offlineSnapshot).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("follows the door to the list it was switched to, and reopens on it", async () => {
    apiMock.config.mockResolvedValue(twoDoors());
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: t("checkin.open") }));
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");
    apiMock.offlineSnapshot.mockClear();

    await user.click(screen.getByRole("button", { name: "close-scanner" }));
    await waitFor(() => expect(apiMock.offlineSnapshot).toHaveBeenCalledWith(pairing, 8));
    await user.click(screen.getByRole("button", { name: t("checkin.open") }));

    expect(screen.getByLabelText(t("checkin.list"))).toHaveProperty("value", "8");
  });

  it("forgets the door's list when the till is switched to another event", async () => {
    // The lists belong to the event; the other event's door is its own.
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null },
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    apiMock.config.mockImplementation(async (p: { event: string }) =>
      p.event === "gala"
        ? config({
            event: { ...config().event, slug: "gala", name: "Gala" },
            checkin: {
              enabled: true, list_id: 21, list_name: "Gala",
              lists: [{ id: 21, name: "Gala", all_products: true, include_pending: false }],
            },
          })
        : twoDoors(),
    );
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: t("checkin.open") }));
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");
    await user.click(screen.getByRole("button", { name: "close-scanner" }));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.selectOptions(await screen.findByLabelText(t("settings.event")), "gala");

    await waitFor(() =>
      expect(apiMock.offlineSnapshot).toHaveBeenCalledWith({ ...pairing, event: "gala" }, 21),
    );
  });
});

describe("the top bar", () => {
  it("shows who is on the till", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.type(await screen.findByLabelText(t("settings.cashier")), "Ana");
    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    const topbar = document.querySelector(".topbar") as HTMLElement;
    expect(within(topbar).getByText("Ana")).toBeDefined();
  });

  it("opens today's transactions", async () => {
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("history.open") }));

    expect(screen.getByRole("heading", { name: t("history.title") })).toBeDefined();
  });
});

describe("what a device is for", () => {
  /** A config whose device carries a role, and optionally a card reader. */
  function assigned(role: "" | "pos" | "door", card: "declared" | "terminal" = "declared") {
    return config({ device: { serial: "TILL1", name: "Caisse bar", role, card } });
  }

  it("keeps both jobs on a device nobody has assigned", async () => {
    // Which is every device paired before roles existed. The till opens on the
    // grid and the door is one tap away, exactly as before.
    show();
    await ready();

    expect(screen.getByRole("button", { name: t("checkin.open") })).toBeDefined();
  });

  it("keeps both jobs against a server too old to have a role at all", async () => {
    apiMock.config.mockResolvedValue(config({
      device: { serial: "TILL1", name: "Caisse bar" },
    }));
    show();
    await ready();

    expect(screen.getByRole("button", { name: t("checkin.open") })).toBeDefined();
  });

  it("gives a bar till no door to open", async () => {
    apiMock.config.mockResolvedValue(assigned("pos"));
    show();
    await ready();

    expect(screen.queryByRole("button", { name: t("checkin.open") })).toBeNull();
  });

  it("opens a door device on the scanner", async () => {
    apiMock.config.mockResolvedValue(assigned("door"));
    show();

    expect(
      await screen.findByRole("heading", { name: t("checkin.title") }),
    ).toBeDefined();
  });

  it("lets the door step out to the grid to sell a ticket", async () => {
    apiMock.config.mockResolvedValue(assigned("door"));
    const { user } = show();
    await screen.findByRole("heading", { name: t("checkin.title") });

    await user.click(screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` }));

    expect(screen.getByRole("button", { name: /Entrée/ })).toBeDefined();
    expect(screen.queryByRole("heading", { name: t("checkin.title") })).toBeNull();
  });

  it("puts the door back on the scanner once the ticket is sold", async () => {
    // The grid is a detour at the door: the next person in the queue is
    // holding a QR code, and a volunteer should not have to find the way back.
    apiMock.config.mockResolvedValue(assigned("door"));
    const { user } = show();
    await screen.findByRole("heading", { name: t("checkin.title") });
    await user.click(screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` }));

    await ringUp(user, /Entrée/);
    await confirm(user);
    await user.click(await screen.findByRole("button", { name: t("done.next") }));

    expect(
      await screen.findByRole("heading", { name: t("checkin.title") }),
    ).toBeDefined();
  });

  it("leaves a till where it is once its sale is done", async () => {
    apiMock.config.mockResolvedValue(assigned("pos"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await confirm(user);
    await user.click(await screen.findByRole("button", { name: t("done.next") }));

    expect(screen.queryByRole("heading", { name: t("checkin.title") })).toBeNull();
    expect(screen.getByRole("button", { name: /Bière/ })).toBeDefined();
  });

  it("does not offer a door that only the scanner button knows about", async () => {
    // The button is the way back in, so it has no business being on screen
    // while the scanner already is.
    apiMock.config.mockResolvedValue(assigned("door"));
    show();
    await screen.findByRole("heading", { name: t("checkin.title") });

    expect(screen.queryByRole("button", { name: t("checkin.open") })).toBeNull();
  });

  it("opens a door on the grid when the event has no list to scan", async () => {
    // There is nothing to scan against, so the scanner would be a screen that
    // does nothing — and, after every sale, a loop back into it.
    apiMock.config.mockResolvedValue(config({
      device: { serial: "TILL1", name: "Caisse bar", role: "door", card: "declared" },
      checkin: { enabled: false, list_id: null, list_name: null, lists: [] },
    }));
    show();
    await ready();

    expect(screen.queryByRole("heading", { name: t("checkin.title") })).toBeNull();
  });

  /** What the server answers for a reader payment in one state or another. */
  function reader(status: "pending" | "successful" | "failed", failure = "") {
    return { status, amount: "5.00", currency: "EUR", failure };
  }

  it("puts the basket on the reader and records the sale it validated", async () => {
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    apiMock.terminalStart.mockResolvedValue(reader("successful"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalled());
    const started = apiMock.terminalStart.mock.calls[0][1];
    const sale = apiMock.checkout.mock.calls[0][1];
    // One key for both: the sale the server records is the one the reader was
    // asked to take, and that is what it looks up before it writes anything.
    expect(sale.idempotency_key).toBe(started.idempotency_key);
    expect(sale.payment_type).toBe("card");
    // The figure the customer agreed to is the reader's, which the server
    // priced — not this app's, whose catalogue can be a refresh behind.
    expect(sale.expected_total).toBe("5.00");
    expect(started.positions).toEqual(sale.positions);
  });

  it("records nothing when the card is refused", async () => {
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    apiMock.terminalStart.mockResolvedValue(reader("failed", "FAILED"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(await screen.findByText(t("payment.readerRefused"))).toBeDefined();
    expect(apiMock.checkout).not.toHaveBeenCalled();
  });

  it("does not offer a card payment the operator could confirm by hand", async () => {
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    apiMock.terminalStart.mockResolvedValue(reader("pending"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));

    expect(await screen.findByText(t("payment.readerPrompt"))).toBeDefined();
    expect(screen.queryByRole("button", { name: t("payment.cardConfirm") })).toBeNull();
    expect(apiMock.checkout).not.toHaveBeenCalled();
  });

  it("takes the basket back off the reader when the operator gives up", async () => {
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    apiMock.terminalStart.mockResolvedValue(reader("pending"));
    apiMock.terminalCancel.mockResolvedValue(reader("failed", "CANCELLED"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    await user.click(await screen.findByRole("button", { name: t("payment.readerStop") }));

    expect(await screen.findByText(t("payment.readerCancelled"))).toBeDefined();
    expect(apiMock.checkout).not.toHaveBeenCalled();
  });

  it("asks the reader again under a new key after a refusal", async () => {
    // The server remembers a payment by its key, so retrying under the spent
    // one would find the refusal instead of asking for a card again.
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    apiMock.terminalStart.mockResolvedValue(reader("failed", "FAILED"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await user.click(screen.getByRole("button", { name: t("payment.card") }));
    await user.click(await screen.findByRole("button", { name: t("payment.readerRetry") }));

    await waitFor(() => expect(apiMock.terminalStart).toHaveBeenCalledTimes(2));
    const [first, second] = apiMock.terminalStart.mock.calls.map((call) => call[1]);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it("still takes cash on that same till", async () => {
    apiMock.config.mockResolvedValue(assigned("pos", "terminal"));
    const { user } = show();
    await ready();

    await ringUp(user);
    await confirm(user);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalled());
    expect(apiMock.checkout.mock.calls[0][1].payment_type).toBe("cash");
  });
});
