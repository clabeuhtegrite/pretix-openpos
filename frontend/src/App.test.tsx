import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    config: vi.fn(),
    catalog: vi.fn(),
    checkout: vi.fn(),
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

// No camera in jsdom, and the door has its own tests.
vi.mock("./components/QrScanner", () => ({
  default: ({ title, footer, children }: {
    title: string; footer?: React.ReactNode; children?: React.ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
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
import { loadCashier, loadPairing, loadQueue, savePairing, saveQueue } from "./storage";
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

/** Confirm the payment panel as it stands. */
async function confirm(user: ReturnType<typeof userEvent.setup>) {
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

  it("goes back to pairing when the device has been revoked", async () => {
    // An operator staring at "403" cannot fix it; a pairing screen they can.
    apiMock.config.mockRejectedValue(new ApiError(403, "Unknown device."));
    apiMock.catalog.mockRejectedValue(new ApiError(403, "Unknown device."));
    show();

    expect(await screen.findByText(t("pairing.title"))).toBeDefined();
    expect(loadPairing()).toBeNull();
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
