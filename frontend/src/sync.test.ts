import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The replay of what a till did while cut off. These tests pin the rule the
 * whole queue's safety rests on — 4xx is a refusal, everything else means
 * "not now" — because an early version got it wrong and took two paid sales
 * out of the queue on a 500. They must never come back as plausible-looking
 * code.
 */

const { checkout, redeem } = vi.hoisted(() => ({
  checkout: vi.fn(),
  redeem: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, checkout, redeem } };
});

import { ApiError } from "./api";
import { enqueue, loadFailures, loadQueue, saveQueue } from "./storage";
import { drainQueue } from "./sync";
import type { Pairing, QueuedCheckin, QueuedSale } from "./types";

const pairing: Pairing = {
  token: "tok",
  organizer: "demo",
  event: "festival",
  serial: "TILL1",
  deviceName: "Caisse bar",
};

function sale(id: string, event = "festival"): QueuedSale {
  return {
    kind: "sale",
    id,
    at: "2026-08-16T22:02:21.000Z",
    event,
    positions: [{ item: 10, variation: null, count: 1, price: "4.00" }],
    chargedTotal: "4.00",
    paymentType: "cash",
    cashGiven: "10.00",
    cashChange: "6.00",
    cashier: "Ana",
    admits: false,
    label: "1× Bière",
  };
}

function checkin(id: string, secret: string): QueuedCheckin {
  return {
    kind: "checkin",
    id,
    at: "2026-08-16T22:10:00.000Z",
    event: "festival",
    list: 7,
    secret,
    name: "Alice",
  };
}

const sold = { order: { code: "POS01" } };

beforeEach(() => {
  localStorage.clear();
  checkout.mockReset();
  redeem.mockReset();
});

describe("drainQueue", () => {
  it("sends everything, oldest first, and empties the queue", async () => {
    saveQueue([sale("a"), sale("b")]);
    checkout.mockResolvedValue(sold);

    const report = await drainQueue(pairing);

    expect(report.sales).toBe(2);
    expect(loadQueue()).toEqual([]);
    expect(checkout).toHaveBeenNthCalledWith(
      1,
      pairing,
      expect.objectContaining({
        idempotency_key: "a",
        // The offline block is what authorises the client-sent price; a
        // replay without it would be refused as tampering.
        offline: { recorded_at: "2026-08-16T22:02:21.000Z", charged_total: "4.00" },
      }),
    );
  });

  it("keeps an entry in line on a transport failure", async () => {
    saveQueue([sale("a"), sale("b")]);
    checkout.mockRejectedValue(new ApiError(0, "network"));

    const report = await drainQueue(pairing);

    expect(report.sales).toBe(0);
    expect(report.failed).toBe(0);
    // Nothing lost, nothing reordered: the network went away again.
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(loadFailures()).toEqual([]);
  });

  it("treats a 5xx as 'not now', never as a refusal", async () => {
    // The bug an early version had: a 502 from a restarting proxy took two
    // paid sales out of the queue for good.
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(new ApiError(502, "bad gateway"));

    await drainQueue(pairing);

    expect(loadQueue().map((entry) => entry.id)).toEqual(["a"]);
    expect(loadFailures()).toEqual([]);
  });

  it("moves a 4xx refusal to the failures list and carries on", async () => {
    saveQueue([sale("a"), sale("b")]);
    checkout
      .mockRejectedValueOnce(new ApiError(400, "not on sale at the till"))
      .mockResolvedValueOnce(sold);

    const report = await drainQueue(pairing);

    expect(report.failed).toBe(1);
    expect(report.sales).toBe(1);
    expect(loadQueue()).toEqual([]);
    const failures = loadFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].entry.id).toBe("a");
    expect(failures[0].message).toBe("not on sale at the till");
  });

  it("does not send another event's entries", async () => {
    saveQueue([sale("a", "other-event"), sale("b")]);

    const report = await drainQueue(pairing);

    // The head belongs to another event: the drain stops rather than posting
    // it to the wrong one, and the queue is left exactly as it was.
    expect(checkout).not.toHaveBeenCalled();
    expect(report.sales).toBe(0);
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("reports off-tariff sales instead of smoothing them away", async () => {
    saveQueue([sale("a")]);
    checkout.mockResolvedValue({
      order: { code: "POS02" },
      off_tariff: [{ item: 10, item_name: "Bière", charged: "3.50", tariff: "4.00" }],
    });

    const report = await drainQueue(pairing);

    expect(report.offTariff).toEqual([
      { order: "POS02", item: 10, item_name: "Bière", charged: "3.50", tariff: "4.00" },
    ]);
  });

  it("replays a check-in with its own nonce and original timestamp", async () => {
    saveQueue([checkin("nonce-1", "alice-secret")]);
    redeem.mockResolvedValue({ status: "ok" });

    const report = await drainQueue(pairing);

    expect(report.checkins).toBe(1);
    expect(report.contested).toEqual([]);
    expect(redeem).toHaveBeenCalledWith(
      pairing,
      expect.objectContaining({
        secret: "alice-secret",
        nonce: "nonce-1",
        datetime: "2026-08-16T22:10:00.000Z",
      }),
    );
  });

  it("reports a check-in the server contests on replay", async () => {
    saveQueue([checkin("nonce-1", "alice-secret")]);
    redeem.mockResolvedValue({ status: "error", reason: "already_redeemed" });

    const report = await drainQueue(pairing);

    // The person is inside either way; the organiser hears about it.
    expect(report.checkins).toBe(1);
    expect(report.contested).toEqual([
      { name: "Alice", secret: "alice-secret", reason: "already_redeemed" },
    ]);
    expect(loadQueue()).toEqual([]);
  });

  it("does not lose a sale queued while the drain was running", async () => {
    saveQueue([sale("a")]);
    checkout.mockImplementation(async () => {
      // A sale rung up mid-drain, appended to the stored queue behind the
      // drain's back.
      if (checkout.mock.calls.length === 1) enqueue(sale("c"));
      return sold;
    });

    const report = await drainQueue(pairing);

    expect(report.sales).toBe(2);
    expect(loadQueue()).toEqual([]);
  });
});
