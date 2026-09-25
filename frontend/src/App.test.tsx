import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, sound } = vi.hoisted(() => ({
  sound: { play: vi.fn(), unlock: vi.fn(), setSoundEnabled: vi.fn(), soundEnabled: vi.fn(() => true) },
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
    updateDevice: vi.fn(),
    revokeDevice: vi.fn(),
    drawer: vi.fn(),
    drawerOpen: vi.fn(),
    drawerMovement: vi.fn(),
    drawerCount: vi.fn(),
    drawerClose: vi.fn(),
    deviceStatus: vi.fn(),
  },
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: apiMock };
});

// The sounds have their own tests, and jsdom has no Web Audio anyway. Here it
// is a thing that records what the till asked to be heard.
vi.mock("./sound", () => sound);

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
import { ApiError, deviceDescription } from "./api";
import { noteServerTime } from "./clock";
import { markReachable, markUnreachable } from "./connectivity";
import { moment } from "./drawer";
import { describeError } from "./errors";
import { t, tn } from "./i18n";
import { formatMoney } from "./money";
import {
  addOrphan, clearBasket, loadBasket, loadCashier, loadDeviceReport, loadFailures, loadOrphans,
  loadPairing, loadPendingPayment, loadQueue, loadRevocations, savePairing, saveBasket,
  saveDeviceReport, saveFailures, savePendingPayment, saveQueue,
} from "./storage";
import { fillStorage } from "./test/setup";
import { noTakings } from "./test/takings";
import type {
  Catalog, DrawerState, JournalLine, PendingPayment, PosConfig, QueuedSale, SaleResult,
} from "./types";
import { STATUS_SETTLE_MS } from "./useDeviceStatus";
import { ORPHAN_CHECK_MS } from "./useOrphanPayments";
import { TERMINAL_POLL_MS, TERMINAL_UNANSWERED_MS } from "./useTerminal";

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
    order: { code: "POS01", total: "3.00" },
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

/** An answer the test hands over when it chooses to. */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
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

/**
 * A product button in the grid.
 *
 * Scoped there on purpose: a basket line's count button carries the product's
 * name too — it has to, or a screen reader announces a bare number — so a
 * search by name alone finds two buttons as soon as anything is in the basket.
 */
function tile(name: RegExp | string) {
  return within(document.querySelector(".grid") as HTMLElement).getByRole("button", { name });
}

/** Wait until the catalogue is on screen. */
async function ready() {
  await waitFor(() => expect(document.querySelector(".grid .product")).not.toBeNull());
}

/** Ring up one beer and open the payment panel. */
async function ringUp(user: ReturnType<typeof userEvent.setup>, product = /Bière/) {
  await user.click(tile(product));
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
  apiMock.summary.mockResolvedValue(noTakings());
  apiMock.posEvents.mockResolvedValue({ results: [] });
  apiMock.updateDevice.mockResolvedValue({ unique_serial: "TILL1" });
  apiMock.attendance.mockResolvedValue({
    list: { id: 7, name: "Porte" }, computed_at: "2026-08-16T22:30:00.000Z",
    inside: 0, entered: 0, exited: 0, expected: 0, not_arrived: 0,
    non_admission_entered: 0, items: [],
  });
  apiMock.offlineSnapshot.mockResolvedValue({
    list: { id: 7, name: "Porte" }, generated: "2026-08-16T20:00:00.000Z",
    tickets: [], truncated: false,
  });
  apiMock.deviceStatus.mockResolvedValue({ server_time: new Date().toISOString() });
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

  it("says it is loading while the event opens, rather than three dots", async () => {
    const opening = later<PosConfig>();
    apiMock.config.mockReturnValue(opening.promise);
    show();

    expect(screen.getByText(t("app.loading"))).toBeDefined();
    opening.resolve(config());
    await ready();
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

  it("says nothing is on tonight, rather than selling from the cache", async () => {
    // A series with no date on. The cached catalogue would hand back last
    // week's evening and the till would sell against a date that is over,
    // which the queue only finds out at the payment — the exact shape of the
    // bug this replaced. It is also the one failure here that somebody can
    // fix in a minute from the back office.
    const { user } = show();
    await ready();
    const closed = new ApiError(400, "Nothing is on tonight.", {
      code: "series_closed",
    });
    apiMock.config.mockRejectedValue(closed);
    apiMock.catalog.mockRejectedValue(closed);

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.refresh") }));

    expect(await screen.findByText("Nothing is on tonight.")).toBeDefined();
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

  it("keeps the page up while it tries again, and says it is trying", async () => {
    // The page used to vanish into three dots at the tap, and come back
    // unchanged when the server still said no: a retry that looked like it
    // had not been pressed.
    apiMock.config.mockRejectedValueOnce(new ApiError(403, "Unknown device."));
    apiMock.catalog.mockRejectedValueOnce(new ApiError(403, "Unknown device."));
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: "Unknown device." }));
    const answer = later<PosConfig>();
    apiMock.config.mockReturnValueOnce(answer.promise);

    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    const retrying = screen.getByRole("button", { name: t("error.retrying") });
    expect(retrying).toHaveProperty("disabled", true);
    expect(retrying.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(t("error.refused", { detail: "Unknown device." }))).toBeDefined();
    answer.resolve(config());
    await ready();
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

  it("does not offer to unpair a till that has only lost the network", async () => {
    // A till one retry from working, and a button whose price is a new code
    // typed at the back office by somebody who is not in the room. This is a
    // till that has never loaded, so there is no cache to fall back on.
    apiMock.config.mockRejectedValue(new ApiError(0, "offline", true));
    apiMock.catalog.mockRejectedValue(new ApiError(0, "offline", true));
    show();

    await screen.findByText(t("error.offline"));

    expect(screen.queryByRole("button", { name: t("settings.unpair") })).toBeNull();
    expect(screen.getByRole("button", { name: t("error.retry") })).toBeDefined();
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

  it("offers the device's other events when its own is refused", async () => {
    // Open POS switched off on the event this till was left on. Retrying
    // cannot help and unpairing costs a new code from the back office, while
    // tonight's event was one tap away — but there was no tap to make.
    const refused = new ApiError(403, "Open POS is not enabled for the event festival.");
    apiMock.config.mockImplementation((p: { event: string }) =>
      p.event === "festival" ? Promise.reject(refused) : Promise.resolve(config()),
    );
    apiMock.catalog.mockImplementation((p: { event: string }) =>
      p.event === "festival" ? Promise.reject(refused) : Promise.resolve(catalog),
    );
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: refused.message }));

    await user.click(await screen.findByRole("button", { name: /Gala/ }));

    await ready();
    expect(loadPairing()?.event).toBe("gala");
    expect(apiMock.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ event: "gala" }));
  });

  it("shows the next event loading, not the last one's refusal", async () => {
    const refused = new ApiError(403, "Open POS is not enabled for the event festival.");
    const gala = later<PosConfig>();
    apiMock.config.mockImplementation((p: { event: string }) =>
      p.event === "festival" ? Promise.reject(refused) : gala.promise,
    );
    apiMock.catalog.mockImplementation((p: { event: string }) =>
      p.event === "festival" ? Promise.reject(refused) : Promise.resolve(catalog),
    );
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: refused.message }));

    await user.click(await screen.findByRole("button", { name: /Gala/ }));

    expect(screen.getByText(t("app.loading"))).toBeDefined();
    expect(screen.queryByText(t("error.refused", { detail: refused.message }))).toBeNull();
    gala.resolve(config());
    await ready();
  });

  it("does not let a late answer for the event it left land on the next", async () => {
    // Retry pressed on one event, then another event picked before the first
    // answered: the till is on the second, whatever the first says after.
    const refused = new ApiError(403, "Open POS is not enabled for the event festival.");
    apiMock.config.mockRejectedValueOnce(refused);
    apiMock.catalog.mockRejectedValueOnce(refused);
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    const { user } = show();
    await screen.findByText(t("error.refused", { detail: refused.message }));
    const festival = later<PosConfig>();
    apiMock.config.mockImplementation((p: { event: string }) =>
      p.event === "festival"
        ? festival.promise
        : Promise.resolve(config({ event: { ...config().event, slug: "gala", name: "Gala" } })),
    );
    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    await user.click(await screen.findByRole("button", { name: /Gala/ }));
    expect(await screen.findByRole("heading", { name: "Gala" })).toBeDefined();
    await act(async () => festival.resolve(config()));

    expect(screen.getByRole("heading", { name: "Gala" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Festival" })).toBeNull();
  });

  it("offers them too when a series has nothing on tonight", async () => {
    const closed = new ApiError(400, "Nothing is on tonight.", { code: "series_closed" });
    apiMock.config.mockRejectedValue(closed);
    apiMock.catalog.mockRejectedValue(closed);
    apiMock.posEvents.mockResolvedValue({
      results: [
        { slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null },
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    });
    show();

    expect(await screen.findByRole("button", { name: /Gala/ })).toBeDefined();
    // Not the one it is stuck on.
    expect(screen.queryByRole("button", { name: /Festival/ })).toBeNull();
  });
});

describe("hearing the till", () => {
  it("clicks when a product goes in the basket", async () => {
    // A cashier ringing up a round is looking at the customer, not at the
    // screen. The click is how they know the tap took.
    sound.play.mockClear();
    const { user } = show();
    await ready();

    await user.click(tile(/Bière/));

    expect(sound.play).toHaveBeenCalledWith("add");
  });

  it("starts the audio on the first tap, whatever that tap was", async () => {
    // No browser will open an audio context outside a gesture, and a refused
    // ticket at the door arrives on a camera frame rather than a tap.
    sound.unlock.mockClear();
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("tab", { name: "Bar" }));

    expect(sound.unlock).toHaveBeenCalled();
  });

  it("remembers being told to keep quiet", async () => {
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: "settings" }));

    await user.click(await screen.findByRole("button", { name: t("settings.soundOff") }));

    expect(sound.setSoundEnabled).toHaveBeenCalledWith(false);
  });

  it("says something the moment sound is switched back on", async () => {
    // Otherwise the operator has to ring a sale up to find out whether the
    // switch did anything.
    apiMock.summary.mockResolvedValue(noTakings());
    const { user } = show();
    await ready();
    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.soundOff") }));
    sound.play.mockClear();

    await user.click(screen.getByRole("button", { name: t("settings.soundOn") }));

    expect(sound.setSoundEnabled).toHaveBeenLastCalledWith(true);
    expect(sound.play).toHaveBeenCalledWith("ok");
  });
});

describe("the basket", () => {
  it("takes a product on a tap", async () => {
    const { user } = show();
    await ready();

    await user.click(tile(/Bière/));

    expect(screen.getByRole("button", { name: t("sale.charge") })).toHaveProperty(
      "disabled", false,
    );
  });

  it("adds to the line rather than making a second one", async () => {
    const { user } = show();
    await ready();

    await user.click(tile(/Bière/));
    await user.click(tile(/Bière/));

    expect(screen.getByText("2")).toBeDefined();
  });

  it("will not take more than the quota allows", async () => {
    // A basket that can only be refused at checkout, after the customer has
    // been told a total, is the failure this prevents.
    const { user } = show();
    await ready();

    await user.click(tile(/Vin/));
    await user.click(tile(/Vin/));
    await user.click(tile(/Vin/));

    expect(screen.getByText("2")).toBeDefined();
  });

  it("drops a line taken down to nothing", async () => {
    const { user } = show();
    await ready();
    await user.click(tile(/Bière/));

    await user.click(screen.getByRole("button", { name: "−" }));

    expect(screen.getByText(t("sale.empty"))).toBeDefined();
  });

  it("empties on the clear button", async () => {
    const { user } = show();
    await ready();
    await user.click(tile(/Bière/));

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

  const extraTile = (key: "custom.tile" | "deposit.tile") =>
    within(document.querySelector(".grid") as HTMLElement).getByRole("button", {
      name: new RegExp(t(key)),
    });

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

    await user.click(extraTile("custom.tile"));
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

    await user.click(extraTile("custom.tile"));
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
    await user.click(tile(/Bière/));
    await user.click(tile(/Bière/));
    for (let i = 0; i < 3; i += 1) await user.click(extraTile("deposit.tile"));
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
        order: { code: "", total: "0.00" },
        deposit_refund: "2.00",
        net_total: "-2.00",
      }),
    );
    const { user } = show();
    await ready();

    await user.click(extraTile("deposit.tile"));
    await user.click(extraTile("deposit.tile"));
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

    await user.click(tile(/Bière/));
    await user.click(extraTile("deposit.tile"));
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

  it("keeps trying while the till believes it is online", async () => {
    // A drain that failed while a request of the door screen got through: the
    // till was offline and online again between two renders, and nothing ever
    // told it to try again. The scans sat on the phone until it was reopened.
    saveQueue([{
      kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z",
      event: "festival", list: 7, secret: "s", name: "Alice",
    }]);
    apiMock.redeem.mockRejectedValueOnce(new ApiError(0, "network"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      show();
      await ready();
      await waitFor(() => expect(apiMock.redeem).toHaveBeenCalledOnce());
      expect(loadQueue()).toHaveLength(1);
      apiMock.redeem.mockResolvedValue({ status: "ok" });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      await waitFor(() => expect(loadQueue()).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
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

    await user.click(tile(/Bière/));

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

    // Said at once: fetching the new build over a venue's wifi takes a moment,
    // and the old page stays on screen until it is in.
    const updating = screen.getByRole("button", { name: t("update.reloading") });
    expect(updating).toHaveProperty("disabled", true);
    expect(updating.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledWith("v1");
    // Written before the reload: whatever comes back has to know it tried.
    expect(localStorage.getItem("openpos.updateTried.v1")).toBe("99.0.0");
    vi.unstubAllGlobals();
  });
});

describe("what pretix' device list says the till runs", () => {
  it("is told the build the till opened on", async () => {
    // A till paired under an older release: until it says otherwise, the back
    // office shows the build it was paired with.
    show();
    await ready();

    await waitFor(() =>
      expect(apiMock.updateDevice).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({ software_brand: "pretix-openpos", software_version: __APP_VERSION__ }),
      ),
    );
    expect(loadDeviceReport("TILL1")?.software_version).toBe(__APP_VERSION__);
  });

  it("is not told again what it already knows", async () => {
    saveDeviceReport("TILL1", deviceDescription());
    show();
    await ready();

    expect(apiMock.updateDevice).not.toHaveBeenCalled();
  });

  it("is not told twice at pairing, which already said it all", async () => {
    localStorage.clear();
    apiMock.initialize.mockResolvedValue({
      organizer: "demo", device_id: 3, unique_serial: "TILL1", api_token: "tok",
      name: "Caisse bar", security_profile: "openpos",
    });
    apiMock.posEvents.mockResolvedValue({
      results: [{ slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null }],
    });
    const { user } = show();

    await user.click(screen.getByLabelText(t("pairing.token")));
    await user.paste("abcd1234");
    await user.click(screen.getByRole("button", { name: t("pairing.submit") }));
    await ready();

    expect(apiMock.initialize).toHaveBeenCalledWith("abcd1234");
    expect(apiMock.updateDevice).not.toHaveBeenCalled();
  });

  it("does not stand between the till and a sale when pretix will not listen", async () => {
    // A security profile that leaves the endpoint out answers 403. The report
    // is bookkeeping; the till opens and sells all the same.
    apiMock.updateDevice.mockRejectedValue(new ApiError(403, "Permission denied."));
    const { user } = show();
    await ready();

    await ringUp(user);
    await confirm(user);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledTimes(1));
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
    await user.click(tile(/Bière/));
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
    await user.click(tile(/Bière/));
    await user.click(screen.getByRole("button", { name: t("sale.charge") }));

    expect(screen.queryByText(new RegExp(t("payment.stillDue")))).toBeNull();
    confirmed.mockRestore();
  });
});

describe("the settings", () => {
  it("stay open while the catalogue reloads, and close once it is in", async () => {
    // They used to close at the tap, and the till then looked exactly as it
    // had whether the catalogue came or not.
    const { user } = show();
    await ready();
    const reloaded = later<Catalog>();
    apiMock.catalog.mockReturnValueOnce(reloaded.promise);

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.refresh") }));

    expect(screen.getByRole("button", { name: t("settings.refreshing") })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => reloaded.resolve(catalog));
    await waitFor(() => expect(screen.queryByText(t("settings.title"))).toBeNull());
  });

  it("say so when the catalogue could not be reloaded, and the till goes on selling", async () => {
    const { user } = show();
    await ready();
    apiMock.config.mockRejectedValueOnce(new ApiError(0, "network"));
    apiMock.catalog.mockRejectedValueOnce(new ApiError(0, "network"));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: t("settings.refresh") }));

    expect(await screen.findByText(t("settings.refreshFailed"))).toBeDefined();
    expect(screen.getByText(t("settings.title"))).toBeDefined();
    expect(tile(/Bière/)).toBeDefined();

    // A sentence about an earlier attempt, not about the panel opened next.
    await user.click(screen.getByRole("button", { name: t("settings.close") }));
    await user.click(screen.getByRole("button", { name: "settings" }));
    expect(screen.queryByText(t("settings.refreshFailed"))).toBeNull();
  });

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

  it("tells pretix the unpaired till is gone, so it reads revoked there", async () => {
    // Forgetting the token was all unpairing did: the device went on reading
    // "active" in the back office, with a token that still worked.
    apiMock.revokeDevice.mockResolvedValue({});
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(t("settings.unpair")) }));

    await waitFor(() => expect(apiMock.revokeDevice).toHaveBeenCalledWith("tok"));
    await waitFor(() => expect(loadRevocations()).toEqual([]));
    confirmed.mockRestore();
  });

  it("unpairs without a network, and tells pretix once there is one", async () => {
    apiMock.revokeDevice.mockRejectedValueOnce(new ApiError(0, "network"));
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(t("settings.unpair")) }));

    expect(screen.getByText(t("pairing.title"))).toBeDefined();
    await waitFor(() => expect(apiMock.revokeDevice).toHaveBeenCalledTimes(1));
    expect(loadRevocations()).toEqual(["tok"]);

    // What the API layer does after a request that never arrived, and then
    // once the network is back.
    act(() => markUnreachable());
    apiMock.revokeDevice.mockResolvedValue({});
    act(() => markReachable());

    await waitFor(() => expect(loadRevocations()).toEqual([]));
    expect(apiMock.revokeDevice).toHaveBeenCalledTimes(2);
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
    await user.click(tile(/Bière/));

    await user.click(screen.getByRole("button", { name: "settings" }));
    await user.selectOptions(await screen.findByLabelText(t("settings.event")), "gala");

    await waitFor(() => expect(screen.getByText(t("sale.empty"))).toBeDefined());
    expect(loadPairing()?.event).toBe("gala");
  });

  describe("with a credit in the basket", () => {
    const two = {
      results: [
        { slug: "festival", organizer: "demo", name: "Festival", currency: "EUR", testmode: false, date_from: null },
        { slug: "gala", organizer: "demo", name: "Gala", currency: "EUR", testmode: false, date_from: null },
      ],
    };

    beforeEach(() => {
      apiMock.posEvents.mockResolvedValue(two);
      saveBasket("festival", [{
        key: "10:", itemId: 10, variationId: null, label: "Bière",
        unitPrice: 300, count: 1, available: null,
      }], { amountCents: 1000, order: "POS09" });
    });

    afterEach(() => {
      clearBasket();
      vi.unstubAllGlobals();
    });

    it("asks first, and stays put when told no", async () => {
      // The same question "Clear" asks: the credit is money owed to the
      // customer, and it exists nowhere else until the corrected sale is in.
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal("confirm", confirmSpy);
      const { user } = show();
      await ready();

      await user.click(screen.getByRole("button", { name: "settings" }));
      await user.selectOptions(await screen.findByLabelText(t("settings.event")), "gala");

      expect(confirmSpy).toHaveBeenCalledWith(t("settings.eventCredit", { order: "POS09" }));
      expect(loadPairing()?.event).toBe("festival");
      expect(loadBasket("festival")?.credit).toEqual({ amountCents: 1000, order: "POS09" });
    });

    it("switches once that is answered", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      const { user } = show();
      await ready();

      await user.click(screen.getByRole("button", { name: "settings" }));
      await user.selectOptions(await screen.findByLabelText(t("settings.event")), "gala");

      await waitFor(() => expect(loadPairing()?.event).toBe("gala"));
      expect(loadBasket("festival")).toBeNull();
    });
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
    expect(tile(/Bière/)).toBeDefined();
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


describe("a till that was interrupted mid-sale", () => {
  afterEach(() => {
    clearBasket();
    vi.unstubAllGlobals();
  });

  it("comes back with the basket still on screen", async () => {
    // iOS kills a backgrounded PWA, a tablet reboots, somebody pulls to
    // refresh. Before this, the queue at the bar started again from nothing.
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 2, available: null,
    }], null);
    show();
    await ready();

    // Two beers at 3.00, priced by the catalogue these tests serve: the line
    // and the basket total both read it back.
    expect(await screen.findAllByText(formatMoney(600, "EUR"))).toHaveLength(2);
  });

  it("prices it against the tariff that is live now", async () => {
    // It was saved with the prices of the session that was interrupted. The
    // server would refuse a stale figure and the panel would recover, but the
    // amount the operator reads out to a customer has to be right first time.
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 250, count: 2, available: null,
    }], null);
    show();
    await ready();

    // Two beers: 6.00 at the live tariff, 5.00 at the one this basket was
    // saved with. The figure read out to the customer is the live one.
    expect(await screen.findAllByText(formatMoney(600, "EUR"))).toHaveLength(2);
    expect(screen.queryByText(formatMoney(500, "EUR"))).toBeNull();
  });

  it("brings the credit back with it", async () => {
    // The part that is actually money: until the corrected sale is recorded,
    // the credit exists nowhere but this tablet.
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 1, available: null,
    }], { amountCents: 1000, order: "POS09" });
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("sale.charge") }));

    expect(
      await screen.findByText(t("payment.credit", { order: "POS09" })),
    ).toBeTruthy();
  });

  it("leaves another event's basket where it is", async () => {
    saveBasket("autre-soiree", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 2, available: null,
    }], null);
    show();
    await ready();

    expect(
      screen.getByRole("button", { name: t("sale.charge") }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps the basket on disk as it is rung up", async () => {
    const { user } = show();
    await ready();

    await user.click(tile(/Bière/));

    await waitFor(() => expect(loadBasket("festival")?.cart).toHaveLength(1));
  });

  it("forgets it once the sale has been taken", async () => {
    const { user } = show();
    await ready();

    await ringUp(user);
    await confirm(user);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalled());
    await waitFor(() => expect(loadBasket("festival")).toBeNull());
  });
});

describe("emptying the basket", () => {
  afterEach(() => {
    clearBasket();
    vi.unstubAllGlobals();
  });

  it("asks first when it would drop a credit", async () => {
    // A credit is money the till is holding for a customer standing there. One
    // stray tap on "Vider" used to be enough to lose it.
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 1, available: null,
    }], { amountCents: 1000, order: "POS09" });
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("sale.clear") }));

    expect(confirmSpy).toHaveBeenCalled();
    // Declined, so nothing was dropped.
    expect(screen.getByRole("button", { name: t("sale.charge") })).toBeTruthy();
  });

  it("drops it once that is answered", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 1, available: null,
    }], { amountCents: 1000, order: "POS09" });
    const { user } = show();
    await ready();

    await user.click(screen.getByRole("button", { name: t("sale.clear") }));

    await waitFor(() => expect(loadBasket("festival")).toBeNull());
  });

  it("does not ask about an ordinary basket", async () => {
    // Ten seconds to ring up again, and a dialog on every clear is a dialog
    // nobody reads by the third one.
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    const { user } = show();
    await ready();

    await user.click(tile(/Bière/));
    await user.click(screen.getByRole("button", { name: t("sale.clear") }));

    expect(confirmSpy).not.toHaveBeenCalled();
    // Emptied: the button that takes the money has nothing to take.
    expect(
      screen.getByRole("button", { name: t("sale.charge") }),
    ).toHaveProperty("disabled", true);
  });
});

describe("the cash drawer", () => {
  const closedDrawer = { id: 3, name: "Bar", open: false, stale: false };
  const drawerInfo = {
    id: 3, name: "Bar", opening_float: "100.00", currency: "EUR",
    denominations: [{ value: "20.00", kind: "note" as const }],
  };
  const closedState: DrawerState = { drawer: drawerInfo, session: null, last_closed: null };
  const openState: DrawerState = {
    drawer: drawerInfo,
    session: {
      id: 9, opened_at: new Date().toISOString(), opened_by: "Ana", opening_float: "100.00",
      expected: "100.00", cash_sales: "0.00", cash_returned: "0.00", cash_in: "0.00", cash_out: "0.00",
      stale: false, movements: [], count: null,
    },
    last_closed: null,
  };
  const panelTitle = () => screen.queryByRole("heading", { name: t("drawer.title", { name: "Bar" }) });
  const banner = () => screen.queryByText(t("drawer.bannerClosed", { name: "Bar" }));

  beforeEach(() => {
    apiMock.drawer.mockResolvedValue(closedState);
  });

  it("asks for the drawer to be opened when the till starts on it closed", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: closedDrawer }));
    const { user } = show();

    expect(await screen.findByRole("heading", { name: t("drawer.title", { name: "Bar" }) })).toBeDefined();
    await user.click(await screen.findByRole("button", { name: t("drawer.back") }));

    // Asked once; after that the banner keeps saying it, and is the way back.
    expect(panelTitle()).toBeNull();
    await user.click(banner() as HTMLElement);
    expect(await screen.findByRole("heading", { name: t("drawer.title", { name: "Bar" }) })).toBeDefined();
  });

  it("says nothing of a drawer that is open, and keeps it one tap away", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: { ...closedDrawer, open: true } }));
    apiMock.drawer.mockResolvedValue(openState);
    const { user } = show();
    await ready();

    expect(panelTitle()).toBeNull();
    expect(banner()).toBeNull();
    await user.click(screen.getByRole("button", { name: t("drawer.title", { name: "Bar" }) }));
    expect(await screen.findByText(t("drawer.float"))).toBeDefined();
  });

  it("names a drawer left open since an earlier day", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: { ...closedDrawer, open: true, stale: true } }));
    show();

    expect(await screen.findByText(t("drawer.bannerStale", { name: "Bar" }))).toBeDefined();
  });

  it("neither asks nor warns with no network, where the drawer can be neither read nor opened", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: closedDrawer }));
    const { user } = show();
    await ready();
    act(() => markUnreachable());

    expect(banner()).toBeNull();
    await ringUp(user);
    await payCash(user);
    // Offline the sale is queued as always; the server takes it when it arrives.
    expect(screen.getByRole("button", { name: t("payment.confirm") })).toBeDefined();
  });

  it("does not ask over a basket that was interrupted mid-sale", async () => {
    saveBasket("festival", [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 1, available: null,
    }], null);
    apiMock.config.mockResolvedValue(config({ drawer: closedDrawer }));
    show();
    await ready();

    expect(banner()).not.toBeNull();
    expect(panelTitle()).toBeNull();
    clearBasket();
  });

  it("opens the drawer from the payment, and then takes the cash", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: closedDrawer }));
    apiMock.drawerOpen.mockResolvedValue({
      ...openState,
      entry: { seq: 1, kind: "open", datetime: new Date().toISOString(), amount: "100.00", reason: "", cashier: "", device: "" },
    });
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: t("drawer.back") }));
    await ready();
    await ringUp(user);
    await payCash(user);

    expect(screen.getByText(t("payment.drawerClosed", { name: "Bar" }))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("drawer.openAction") }));
    // The drawer panel lands over the payment, which keeps its own button.
    await screen.findByText(t("drawer.isClosed"));
    const drawerPanel = within(document.querySelector(".drawer-panel") as HTMLElement);
    await user.click(drawerPanel.getByRole("button", { name: t("drawer.openAction") }));
    await user.click(screen.getByRole("button", { name: t("drawer.openWith", { amount: formatMoney(0, "EUR") }) }));

    await waitFor(() => expect(panelTitle()).toBeNull());
    expect(banner()).toBeNull();
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));
    expect(apiMock.checkout).toHaveBeenCalledWith(pairing, expect.objectContaining({ payment_type: "cash" }));
  });

  it("finds out the drawer was closed when the server refuses the cash for it", async () => {
    apiMock.config.mockResolvedValue(config({ drawer: { ...closedDrawer, open: true } }));
    apiMock.checkout.mockRejectedValue(new ApiError(400, "La caisse n’est pas ouverte.", {
      drawer: ["La caisse n’est pas ouverte."], code: "drawer_closed",
    }));
    const { user } = show();
    await ready();
    await ringUp(user);

    await confirm(user);

    expect(await screen.findByText("La caisse n’est pas ouverte.")).toBeDefined();
    expect(apiMock.drawer).toHaveBeenCalledWith(pairing);
    expect(await screen.findByText(t("payment.drawerClosed", { name: "Bar" }))).toBeDefined();
  });

  it("stays quiet about a drawer the device does not have", async () => {
    show();
    await ready();

    expect(screen.queryByRole("button", { name: t("drawer.title", { name: "Bar" }) })).toBeNull();
    expect(apiMock.drawer).not.toHaveBeenCalled();
  });
});


/** A till whose card payments go through the reader on the counter. */
function terminalTill(): PosConfig {
  return config({ device: { serial: "TILL1", name: "Caisse bar", role: "pos", card: "terminal" } });
}

/** What the server answers about a reader payment. */
function onReader(status: "pending" | "successful" | "failed", amount = "3.00", failure = "") {
  return { status, amount, currency: "EUR", failure };
}

/** A request that went and never came back, as the real client reports one. */
function unreachable(): Promise<never> {
  markUnreachable();
  return Promise.reject(new ApiError(0, "network"));
}

/** Ring up one beer and answer the panel's question with the card. */
async function payByCard(user: ReturnType<typeof userEvent.setup>) {
  await ringUp(user);
  await user.click(screen.getByRole("button", { name: t("payment.card") }));
}

/** The key the basket went on the reader under, the n-th time. */
const readerKey = (n = 0) => apiMock.terminalStart.mock.calls[n][1].idempotency_key as string;

/** A payment written down as on its way, the way the till writes it. */
function pendingPayment(over: Partial<PendingPayment> = {}): PendingPayment {
  return {
    event: "festival",
    key: "k-pending",
    stage: "sale",
    paymentType: "cash",
    cashGiven: null,
    charged: null,
    cart: [{
      key: "10:", itemId: 10, variationId: null, label: "Bière",
      unitPrice: 300, count: 1, available: null,
    }],
    credit: null,
    cashier: "",
    admits: false,
    currency: "EUR",
    at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

/** A sale rung up with no network, waiting in the queue. */
function queuedSale(id: string, at = "2026-08-16T21:00:00.000Z"): QueuedSale {
  return {
    kind: "sale", id, at, event: "festival",
    positions: [{ item: 10, variation: null, count: 1, price: "3.00" }],
    chargedTotal: "3.00", paymentType: "cash", cashGiven: "5.00", cashChange: "2.00",
    cashier: "", admits: false, label: "1× Bière",
  };
}

describe("a card payment on the reader", () => {
  beforeEach(() => {
    apiMock.config.mockResolvedValue(terminalTill());
  });

  afterEach(() => {
    vi.useRealTimers();
    clearBasket();
  });

  it("records the sale once when a stop and the tapped card cross", async () => {
    // The customer taps as the cashier presses stop: the poll says paid, and
    // so does the answer to the stop, a moment later. Both used to record
    // the sale, and the second landed while the first was still on its way.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    const poll = later<ReturnType<typeof onReader>>();
    apiMock.terminalStatus.mockReturnValue(poll.promise);
    const stop = later<ReturnType<typeof onReader>>();
    apiMock.terminalCancel.mockReturnValue(stop.promise);
    const recorded = later<SaleResult>();
    apiMock.checkout.mockReturnValue(recorded.promise);
    const { user } = show();
    await ready();
    await payByCard(user);
    await screen.findByText(t("payment.readerPrompt"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS);
    });
    expect(apiMock.terminalStatus).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: t("payment.readerStop") }));
    await act(async () => poll.resolve(onReader("successful")));
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    await act(async () => stop.resolve(onReader("successful")));
    await act(async () => recorded.resolve(sold({ payment_type: "card" })));

    expect(await screen.findByRole("button", { name: t("done.next") })).toBeDefined();
    expect(apiMock.checkout).toHaveBeenCalledOnce();
    expect(apiMock.checkout.mock.calls[0][1].idempotency_key).toBe(readerKey());
  });

  it("sends a stop pressed while the basket is on its way only once the server has it", async () => {
    // Sent at once, the stop could overtake the start, be told there was
    // nothing to stop, and hand the cashier the cash button while the start
    // put the basket on the reader a second later.
    const start = later<ReturnType<typeof onReader>>();
    apiMock.terminalStart.mockReturnValue(start.promise);
    apiMock.terminalCancel.mockResolvedValue(onReader("failed", "3.00", "CANCELLED"));
    const { user } = show();
    await ready();
    await payByCard(user);

    await user.click(screen.getByRole("button", { name: t("payment.readerStop") }));

    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", true);
    await act(async () => start.resolve(onReader("pending")));
    await waitFor(() => expect(apiMock.terminalCancel).toHaveBeenCalledOnce());
    expect(apiMock.terminalCancel.mock.calls[0][1]).toBe(readerKey());
    expect(await screen.findByText(t("payment.readerCancelled"))).toBeDefined();
  });

  it("puts nothing on the reader with no network, and keeps cash one tap away", async () => {
    const { user } = show();
    await ready();
    act(() => markUnreachable());

    await payByCard(user);

    expect(await screen.findByText(t("payment.readerOffline"))).toBeDefined();
    expect(apiMock.terminalStart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: t("payment.back") })).toHaveProperty("disabled", false);
  });

  it("puts the basket on the reader once the network is back, when asked", async () => {
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    const { user } = show();
    await ready();
    act(() => markUnreachable());
    await payByCard(user);

    await act(async () => markReachable());

    expect(await screen.findByText(t("payment.readerBack"))).toBeDefined();
    expect(apiMock.terminalStart).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: t("payment.readerRetry") }));
    expect(await screen.findByText(t("payment.readerPrompt"))).toBeDefined();
    expect(apiMock.terminalStart).toHaveBeenCalledOnce();
  });

  it("offers a way out once the server has gone quiet, and takes the cash under the sale's own key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    apiMock.terminalStatus.mockImplementation(unreachable);
    const { user } = show();
    await ready();
    await payByCard(user);
    await screen.findByText(t("payment.readerPrompt"));
    // Until then the rule holds: a payment the till cannot see is a payment
    // still running.
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_UNANSWERED_MS + 1000);
    });

    expect(await screen.findByText(t("payment.readerUnanswered"))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("payment.cash") }));
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));
    await screen.findByText(/kept on this till/);
    const [entry] = loadQueue();
    expect(entry).toMatchObject({ kind: "sale", paymentType: "cash" });
    // Never the reader's key: had that payment gone through, the replay would
    // find it and record a card sale for money taken in cash.
    expect(entry.id).not.toBe(readerKey());
    // The reader payment is kept aside, to be asked about.
    expect(loadOrphans()).toEqual([expect.objectContaining({ key: readerKey(), amount: "3.00" })]);
  });

  it("keeps waiting, cash locked, through a till turned away or asked to slow down", async () => {
    // Neither says anything about the payment, which the reader may still be
    // asking a customer for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    apiMock.terminalStatus
      .mockRejectedValueOnce(new ApiError(429, "Too many requests."))
      .mockRejectedValueOnce(new ApiError(403, "Forbidden."))
      .mockResolvedValue(onReader("pending"));
    const { user } = show();
    await ready();
    await payByCard(user);
    await screen.findByText(t("payment.readerPrompt"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * TERMINAL_POLL_MS + 500);
    });

    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByText(t("payment.readerPrompt"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", true);
    expect(apiMock.checkout).not.toHaveBeenCalled();
  });

  it("queues a card sale it could not record with its lines' own sum beside the reader's figure", async () => {
    // The server priced the basket at 3.50 when it put it on the reader; the
    // lines here say 3.00, a tariff refresh behind. Checked against 3.50 on
    // replay, they did not add up and the sale was refused.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.terminalStart.mockResolvedValue(onReader("pending", "3.50"));
    apiMock.terminalStatus.mockResolvedValue(onReader("successful", "3.50"));
    apiMock.checkout.mockImplementation(unreachable);
    const { user } = show();
    await ready();
    await payByCard(user);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 500);
    });

    await waitFor(() => expect(loadQueue()).toHaveLength(1));
    expect(loadQueue()[0]).toMatchObject({
      id: readerKey(), paymentType: "card", chargedTotal: "3.50", linesTotal: "3.00",
    });
  });

  it("takes cash after a refused card under the sale's key, never the reader's", async () => {
    apiMock.terminalStart.mockResolvedValue(onReader("failed", "3.00", "FAILED"));
    const { user } = show();
    await ready();
    await payByCard(user);
    await screen.findByText(t("payment.readerRefused"));

    await user.click(screen.getByRole("button", { name: t("payment.cash") }));
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    const sale = apiMock.checkout.mock.calls[0][1];
    expect(sale.payment_type).toBe("cash");
    expect(sale.idempotency_key).not.toBe(readerKey());
  });

  it("asks nothing more about the reader once the panel has closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    apiMock.terminalStatus.mockResolvedValue(onReader("successful"));
    apiMock.checkout.mockResolvedValue(sold({ payment_type: "card" }));
    const { user } = show();
    await ready();
    await payByCard(user);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 500);
    });
    expect(await screen.findByRole("button", { name: t("done.next") })).toBeDefined();
    const asked = apiMock.terminalStatus.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * TERMINAL_POLL_MS);
    });

    expect(apiMock.terminalStatus).toHaveBeenCalledTimes(asked);
  });
});

describe("a card payment left aside", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is taken off the reader once the server answers, while it is still recent", async () => {
    addOrphan({
      event: "festival", key: "k-aside", at: new Date(Date.now() - 60_000).toISOString(),
      amount: "3.00", currency: "EUR",
    });
    apiMock.terminalStatus.mockResolvedValue(onReader("pending"));
    apiMock.terminalCancel.mockResolvedValue(onReader("failed", "3.00", "CANCELLED"));
    show();
    await ready();

    await waitFor(() => expect(apiMock.terminalCancel).toHaveBeenCalledOnce());
    expect(apiMock.terminalCancel.mock.calls[0][1]).toBe("k-aside");
    await waitFor(() => expect(loadOrphans()).toEqual([]));
  });

  it("is shown, until somebody has read it, when the card went through after all", async () => {
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    addOrphan({ event: "festival", key: "k-aside", at, amount: "3.00", currency: "EUR" });
    apiMock.terminalStatus.mockResolvedValue(onReader("successful"));
    const { user } = show();
    await ready();
    const warning = t("payment.latePaid", { amount: formatMoney(300, "EUR"), time: moment(at) });

    expect(await screen.findByText(warning)).toBeDefined();
    // Too old to be taken off a reader that may have moved on to somebody else.
    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: t("payment.latePaidOk") }));

    expect(screen.queryByText(warning)).toBeNull();
    expect(loadOrphans()).toEqual([]);
  });

  it("is waited for while the network is gone, and asked about once it is back", async () => {
    addOrphan({
      event: "festival", key: "k-aside", at: new Date(Date.now() - 10 * 60_000).toISOString(),
      amount: "3.00", currency: "EUR",
    });
    apiMock.terminalStatus.mockResolvedValue(onReader("failed", "3.00", "TIMEOUT"));
    act(() => markUnreachable());
    show();
    await ready();
    expect(apiMock.terminalStatus).not.toHaveBeenCalled();

    await act(async () => markReachable());

    await waitFor(() => expect(loadOrphans()).toEqual([]));
    expect(apiMock.terminalStatus).toHaveBeenCalledWith(expect.anything(), "k-aside");
  });
});

describe("a payment the till was in the middle of when it stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearBasket();
  });

  /** Take the card payment as far as the reader, then kill the till. */
  async function killedAtTheReader() {
    apiMock.config.mockResolvedValue(terminalTill());
    apiMock.terminalStart.mockResolvedValue(onReader("pending"));
    apiMock.terminalStatus.mockResolvedValue(onReader("pending"));
    const user = userEvent.setup();
    const first = render(<App />);
    await ready();
    await payByCard(user);
    await screen.findByText(t("payment.readerPrompt"));
    // iOS reclaims the app while the customer holds their card.
    first.unmount();
    apiMock.terminalStatus.mockClear();
    return readerKey();
  }

  it("asks how the reader payment ended rather than putting the basket on the reader again", async () => {
    const key = await killedAtTheReader();

    render(<App />);

    await waitFor(() => expect(apiMock.terminalStatus).toHaveBeenCalledWith(expect.anything(), key));
    expect(await screen.findByText(t("payment.resumed"))).toBeDefined();
    expect(await screen.findByText(t("payment.readerPrompt"))).toBeDefined();
    expect(apiMock.terminalStart).toHaveBeenCalledOnce();
  });

  it("records the sale the customer paid for while the till was away, under the reader's key", async () => {
    const key = await killedAtTheReader();
    apiMock.terminalStatus.mockResolvedValue(onReader("successful"));

    render(<App />);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    expect(apiMock.checkout.mock.calls[0][1]).toMatchObject({
      idempotency_key: key, payment_type: "card", expected_total: "3.00",
    });
    expect(await screen.findByRole("button", { name: t("done.next") })).toBeDefined();
    expect(loadPendingPayment()).toBeNull();
  });

  it("gives the basket back, saying why, when the card was refused meanwhile", async () => {
    await killedAtTheReader();
    apiMock.terminalStatus.mockResolvedValue(onReader("failed", "3.00", "FAILED"));

    render(<App />);

    expect(await screen.findByText(t("payment.readerRefused"))).toBeDefined();
    expect(apiMock.checkout).not.toHaveBeenCalled();
    await waitFor(() => expect(loadPendingPayment()).toBeNull());
  });

  it("offers the way out at once when the server cannot be asked", async () => {
    // Nobody knows how long ago the server last answered: the till was not
    // running to hear it.
    await killedAtTheReader();
    apiMock.terminalStatus.mockImplementation(unreachable);

    render(<App />);

    expect(await screen.findByText(t("payment.readerUnanswered"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", false);
  });

  it("sends a sale that was on its way again, under the same key, and says why", async () => {
    // Killed while "Recording…" spun. The next try used to carry a new key,
    // and a request that had in fact arrived became a second sale.
    apiMock.checkout.mockReturnValueOnce(new Promise(() => {}));
    const user = userEvent.setup();
    const first = render(<App />);
    await ready();
    await ringUp(user);
    await confirm(user);
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    const key = apiMock.checkout.mock.calls[0][1].idempotency_key;
    first.unmount();
    apiMock.checkout.mockResolvedValue(sold({ replayed: true }));

    render(<App />);

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledTimes(2));
    expect(apiMock.checkout.mock.calls[1][1].idempotency_key).toBe(key);
    expect(await screen.findByText(t("done.resumed"))).toBeDefined();
    expect(loadPendingPayment()).toBeNull();
  });

  it("queues it under that key when the network is gone", async () => {
    apiMock.checkout.mockReturnValueOnce(new Promise(() => {}));
    const user = userEvent.setup();
    const first = render(<App />);
    await ready();
    await ringUp(user);
    await confirm(user);
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    const key = apiMock.checkout.mock.calls[0][1].idempotency_key;
    first.unmount();
    act(() => markUnreachable());

    render(<App />);

    expect(await screen.findByText(t("done.resumed"))).toBeDefined();
    expect(loadQueue()).toEqual([expect.objectContaining({ kind: "sale", id: key })]);
    expect(apiMock.checkout).toHaveBeenCalledOnce();
  });

  it("picks up a card sale that was being recorded, locked on it until it is", async () => {
    // The reader had taken the money: only the sale is left, and a cash tap
    // meanwhile would record the same money twice.
    apiMock.config.mockResolvedValue(terminalTill());
    savePendingPayment(pendingPayment({ key: "k-card", paymentType: "card", charged: "3.50" }));
    const recorded = later<SaleResult>();
    apiMock.checkout.mockReturnValue(recorded.promise);
    show();

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    expect(apiMock.checkout.mock.calls[0][1]).toMatchObject({
      idempotency_key: "k-card", payment_type: "card", expected_total: "3.50",
    });
    expect(screen.getByText(t("payment.readerPaid"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("payment.cash") })).toHaveProperty("disabled", true);
    await act(async () => recorded.resolve(sold({ payment_type: "card" })));
    expect(await screen.findByText(t("done.resumed"))).toBeDefined();
    expect(apiMock.terminalStatus).not.toHaveBeenCalled();
  });

  it("files a sale left from an earlier evening in the queue, under its key, with nothing on screen", async () => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    savePendingPayment(pendingPayment({ key: "k-old", at }));
    apiMock.checkout.mockResolvedValue(sold({ replayed: true }));
    show();
    await ready();

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledWith(pairing, expect.objectContaining({
      idempotency_key: "k-old", offline: expect.objectContaining({ recorded_at: at }),
    })));
    expect(screen.queryByRole("heading", { name: t("payment.title") })).toBeNull();
    expect(loadPendingPayment()).toBeNull();
  });

  it("keeps a sale from an earlier evening where it is when the queue cannot take it", async () => {
    // Tried again at the next launch: dropped, it would exist nowhere.
    savePendingPayment(pendingPayment({ key: "k-old", at: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    fillStorage();
    show();
    await ready();

    expect(loadPendingPayment()).toMatchObject({ key: "k-old" });
    expect(loadQueue()).toEqual([]);
  });

  it("sets a reader payment from an earlier evening aside, to be asked about", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    savePendingPayment(pendingPayment({
      key: "k-old", stage: "reader", paymentType: "card",
      at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    }));
    apiMock.terminalStatus.mockResolvedValue(onReader("failed", "3.00", "TIMEOUT"));
    show();
    await ready();
    expect(loadOrphans()).toEqual([expect.objectContaining({ key: "k-old", amount: "3.00" })]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORPHAN_CHECK_MS);
    });

    await waitFor(() => expect(loadOrphans()).toEqual([]));
    expect(apiMock.terminalStatus).toHaveBeenCalledWith(expect.anything(), "k-old");
    expect(apiMock.terminalCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: t("payment.title") })).toBeNull();
  });

  it("keeps the sale on its way through a request to wait, and sends it again under the same key", async () => {
    const wait = new ApiError(429, "Too many requests.");
    apiMock.checkout.mockRejectedValueOnce(wait).mockResolvedValueOnce(sold());
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);

    expect(await screen.findByText(describeError(wait))).toBeDefined();
    const key = apiMock.checkout.mock.calls[0][1].idempotency_key;
    expect(loadPendingPayment()).toMatchObject({ key, stage: "sale" });
    expect(loadQueue()).toEqual([]);
    await user.click(screen.getByRole("button", { name: t("payment.confirm") }));

    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledTimes(2));
    expect(apiMock.checkout.mock.calls[1][1].idempotency_key).toBe(key);
    expect(await screen.findByRole("button", { name: t("done.next") })).toBeDefined();
  });

  it("forgets the payment on its way when the cashier goes back", async () => {
    apiMock.checkout.mockRejectedValue(new ApiError(429, "Too many requests."));
    const { user } = show();
    await ready();
    await ringUp(user);
    await confirm(user);
    await waitFor(() => expect(loadPendingPayment()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(loadPendingPayment()).toBeNull();
  });

  it("lets go of a card payment the server refuses to record for good", async () => {
    // Sending it again would only be refused again; the payment is in the back
    // office's list of card payments with no sale.
    apiMock.config.mockResolvedValue(terminalTill());
    apiMock.terminalStart.mockResolvedValue(onReader("successful"));
    apiMock.checkout.mockRejectedValue(new ApiError(400, "Sold out.", { detail: "Sold out." }));
    const { user } = show();
    await ready();
    await payByCard(user);

    expect(await screen.findByText(`${t("payment.readerPaidNotRecorded")} Sold out.`)).toBeDefined();
    expect(loadPendingPayment()).toMatchObject({ stage: "sale", charged: "3.00" });
    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(loadPendingPayment()).toBeNull();
    expect(screen.queryByRole("heading", { name: t("payment.title") })).toBeNull();
  });
});

describe("a till the server turns away", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps every sale it holds for when it is paired again, and says so", async () => {
    // A revoked till used to file each of them as refused, one after the
    // other, and have nothing left to send once it was paired again.
    saveQueue([queuedSale("k-1"), queuedSale("k-2"), queuedSale("k-3")]);
    const refused = new ApiError(403, "Invalid token.");
    apiMock.config.mockRejectedValue(refused);
    apiMock.catalog.mockRejectedValue(refused);
    apiMock.checkout.mockRejectedValue(refused);
    show();

    expect(await screen.findByText(tn("error.keptForRepair", 3))).toBeDefined();
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());
    expect(loadQueue().map((entry) => entry.id)).toEqual(["k-1", "k-2", "k-3"]);
    expect(loadFailures()).toEqual([]);
  });

  it("waits as long as the server asked before sending again, unless somebody asks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saveQueue([queuedSale("k-1")]);
    apiMock.checkout
      .mockRejectedValueOnce(new ApiError(429, "Too many requests.", null, 60_000))
      .mockResolvedValue(sold());
    const { user } = show();
    await ready();
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());

    // Two of the till's own retries go by without a request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(apiMock.checkout).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: t("offline.badgePending", { n: 1 }) }));
    await user.click(screen.getByRole("button", { name: t("offline.sync") }));

    await waitFor(() => expect(loadQueue()).toEqual([]));
    expect(apiMock.checkout).toHaveBeenCalledTimes(2);
  });

  it("sends again by itself once the wait is over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saveQueue([queuedSale("k-1")]);
    apiMock.checkout
      .mockRejectedValueOnce(new ApiError(429, "Too many requests.", null, 20_000))
      .mockResolvedValue(sold());
    show();
    await ready();
    await waitFor(() => expect(apiMock.checkout).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => expect(loadQueue()).toEqual([]));
  });
});

describe("what the back office is told about this device", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hears what it holds as soon as it opens", async () => {
    saveQueue([queuedSale("k-1", "2026-08-16T21:00:00.000Z"), queuedSale("k-2", "2026-08-16T21:30:00.000Z")]);
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    show();
    await ready();

    await waitFor(() => expect(apiMock.deviceStatus).toHaveBeenCalled());
    expect(apiMock.deviceStatus.mock.calls[0]).toEqual([pairing, {
      pending_sales: 2,
      oldest_pending_at: "2026-08-16T21:00:00.000Z",
      last_sync_at: null,
      version: __APP_VERSION__,
    }]);
  });

  it("hears again a few seconds after the queue has moved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.checkout.mockRejectedValue(new ApiError(0, "network"));
    const { user } = show();
    await ready();
    await waitFor(() => expect(apiMock.deviceStatus).toHaveBeenCalledOnce());
    await ringUp(user);
    await confirm(user);
    await screen.findByText(/kept on this till/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_SETTLE_MS + 500);
    });

    await waitFor(() => expect(apiMock.deviceStatus).toHaveBeenCalledTimes(2));
    expect(apiMock.deviceStatus.mock.calls[1][1]).toMatchObject({ pending_sales: 1 });
  });

  it("is not something the cashier hears about when it fails", async () => {
    apiMock.deviceStatus.mockRejectedValue(new ApiError(502, "Bad gateway"));
    show();
    await ready();

    await waitFor(() => expect(apiMock.deviceStatus).toHaveBeenCalled());
    expect(screen.queryByText("Bad gateway")).toBeNull();
    expect(screen.queryByRole("button", { name: t("offline.badgeOffline", { n: 0 }) })).toBeNull();
  });
});

describe("a device whose clock is off", () => {
  afterEach(() => {
    // Module state: set back to a clock that agrees, for the next test.
    const now = Date.now();
    act(() => noteServerTime(new Date(now).toISOString(), now, now));
  });

  /** One reading of the server's clock, `offMs` behind this device's. */
  function serverBehindBy(offMs: number) {
    const now = Date.now();
    act(() => noteServerTime(new Date(now - offMs).toISOString(), now, now));
  }

  it("says it is ahead, by how much, and where to set it", async () => {
    show();
    await ready();

    serverBehindBy(7 * 60_000);

    expect(await screen.findByText(t("clock.ahead", { drift: "7 min" }))).toBeDefined();
  });

  it("says it is behind, in hours past an hour", async () => {
    show();
    await ready();

    serverBehindBy(-(2 * 60 + 5) * 60_000);

    expect(await screen.findByText(t("clock.behind", { drift: "2 h 05" }))).toBeDefined();
  });

  it("says nothing of a minute or so, which is only the network", async () => {
    show();
    await ready();

    serverBehindBy(90_000);

    expect(screen.queryByText(/Set Automatically/)).toBeNull();
  });
});
