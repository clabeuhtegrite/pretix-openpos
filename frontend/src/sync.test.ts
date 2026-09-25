import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The replay of what a till did while cut off. These tests pin the rule the
 * whole queue's safety rests on — a 400 with the server's reasons is a
 * refusal of that entry, everything else means "not now" — because early
 * versions got it wrong twice: one took two paid sales out of the queue on a
 * 500, the next emptied a revoked tablet's whole queue into the refusals on a
 * 403. They must never come back as plausible-looking code.
 */

const { checkout, redeem, reportRefusal } = vi.hoisted(() => ({
  checkout: vi.fn(),
  redeem: vi.fn(),
  reportRefusal: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, checkout, redeem, reportRefusal } };
});

import { ApiError } from "./api";
import { describeError } from "./errors";
import { t } from "./i18n";
import {
  enqueue, loadDoorScans, loadFailures, loadLastSync, loadQueue, saveDoorScans, saveQueue,
} from "./storage";
import { drainQueue, sendable, THROTTLED_WAIT_MS } from "./sync";
import type { DoorScans, Pairing, QueuedCheckin, QueuedSale } from "./types";

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

function checkin(id: string, secret: string, overrides: Partial<QueuedCheckin> = {}): QueuedCheckin {
  return {
    kind: "checkin",
    id,
    at: "2026-08-16T22:10:00.000Z",
    event: "festival",
    list: 7,
    secret,
    name: "Alice",
    ...overrides,
  };
}

const sold = { order: { code: "POS01" } };

/** A refusal as the server sends one: a 400 with its reasons. */
function refusal(message: string) {
  return new ApiError(400, message, { positions: [message] });
}

beforeEach(() => {
  localStorage.clear();
  checkout.mockReset();
  redeem.mockReset();
  reportRefusal.mockReset();
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
        offline: {
          recorded_at: "2026-08-16T22:02:21.000Z",
          charged_total: "4.00",
          sent_at: expect.any(String),
        },
      }),
    );
    expect(report.halted).toBeUndefined();
  });

  it("sends this device's clock at the moment of sending with every replay", async () => {
    // What lets the server correct a sale dated by a tablet whose clock is
    // wrong, instead of refusing it as dated in the future.
    vi.useFakeTimers({ now: new Date("2026-08-17T01:00:00.000Z") });
    try {
      saveQueue([sale("a")]);
      checkout.mockResolvedValue(sold);

      await drainQueue(pairing);

      expect(checkout.mock.calls[0][1].offline.sent_at).toBe("2026-08-17T01:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks a reader sale's lines against their own sum, not against the card's", async () => {
    // The server priced that basket when it put it on the reader, and builds
    // the order from what it pinned then. The lines here carry this till's
    // prices, a refresh behind: checked against the reader's figure they did
    // not add up, and the sale was refused on replay.
    saveQueue([{ ...sale("a"), paymentType: "card" as const, chargedTotal: "4.50", linesTotal: "4.00" }]);
    checkout.mockResolvedValue(sold);

    await drainQueue(pairing);

    expect(checkout.mock.calls[0][1].offline.charged_total).toBe("4.00");
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

  it("moves a refusal to the failures list and carries on", async () => {
    saveQueue([sale("a"), sale("b")]);
    checkout
      .mockRejectedValueOnce(refusal("not on sale at the till"))
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

  it("never posts an entry to the event it was not rung up on", async () => {
    saveQueue([sale("a", "other-event")]);

    const report = await drainQueue(pairing);

    expect(checkout).not.toHaveBeenCalled();
    expect(report.sales).toBe(0);
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("steps over another event's entry instead of stopping behind it", async () => {
    // The exact shape that used to freeze a till: one entry for an event this
    // device has since left, sitting in front of the night's real sales. The
    // badge counted them, "send now" sent nothing, and nothing said why.
    saveQueue([sale("a", "other-event"), sale("b"), sale("c")]);
    checkout.mockResolvedValue(sold);

    const report = await drainQueue(pairing);

    expect(checkout).toHaveBeenCalledTimes(2);
    expect(report.sales).toBe(2);
    // Left exactly where it was, and counted so the panel can explain itself.
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a"]);
    expect(report.stranded).toBe(1);
  });

  it("keeps this event's entries in order across a foreign one", async () => {
    saveQueue([sale("first"), sale("skipped", "other-event"), sale("second")]);
    checkout.mockResolvedValue(sold);

    await drainQueue(pairing);

    expect(
      checkout.mock.calls.map(([, payload]) => payload.idempotency_key),
    ).toEqual(["first", "second"]);
  });

  it("reports nothing stranded when the whole queue is this event's", async () => {
    saveQueue([sale("a"), sale("b")]);
    checkout.mockResolvedValue(sold);

    const report = await drainQueue(pairing);

    expect(report.stranded).toBe(0);
    expect(loadQueue()).toEqual([]);
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

  it("sends it the way pretix expects a scan made offline", async () => {
    // Forced: the person walked in on the answer the door gave at the time,
    // and pretix records it whatever it would say now — and marks it as an
    // offline scan, with the time it arrived, in its history and its export.
    saveQueue([checkin("nonce-1", "alice-secret")]);
    redeem.mockResolvedValue({ status: "ok" });

    await drainQueue(pairing);

    expect(redeem).toHaveBeenCalledWith(pairing, expect.objectContaining({ force: true }));
  });

  it("sends a refusal made offline to pretix' own record of refused scans", async () => {
    saveQueue([
      checkin("nonce-2", "nobody", {
        name: "", refused: "error", explanation: "not checked",
      }),
    ]);
    reportRefusal.mockResolvedValue({});

    const report = await drainQueue(pairing);

    expect(redeem).not.toHaveBeenCalled();
    expect(reportRefusal).toHaveBeenCalledWith(pairing, {
      event: "festival",
      list: 7,
      secret: "nobody",
      reason: "error",
      explanation: "not checked",
      datetime: "2026-08-16T22:10:00.000Z",
      nonce: "nonce-2",
    });
    expect(report.checkins).toBe(1);
    expect(loadQueue()).toEqual([]);
  });

  it("keeps a refusal in line when the network goes again", async () => {
    saveQueue([checkin("nonce-2", "nobody", { refused: "invalid" })]);
    reportRefusal.mockRejectedValue(new ApiError(0, "network"));

    const report = await drainQueue(pairing);

    expect(report.checkins).toBe(0);
    expect(loadQueue().map((entry) => entry.id)).toEqual(["nonce-2"]);
  });

  it("sends a scan made for another event instead of holding it back", async () => {
    // A door phone moved on to the next evening kept the previous one's
    // entries to itself. A scan names its list, and the list its event.
    saveQueue([checkin("nonce-1", "alice-secret", { event: "last-night" })]);
    redeem.mockResolvedValue({ status: "ok" });

    const report = await drainQueue(pairing);

    expect(redeem).toHaveBeenCalledOnce();
    expect(report.stranded).toBe(0);
    expect(loadQueue()).toEqual([]);
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

  it.each([
    [401, "device"],
    [403, "device"],
    [404, "other"],
    [409, "other"],
    [408, "wait"],
    [429, "wait"],
  ] as const)("keeps the whole queue on a %i and says why it stopped", async (status, kind) => {
    // The device refused, an address gone, "not now": none of them is about
    // the sale in hand, and every sale behind it would get the same answer.
    // A revoked tablet used to file its whole queue as refused this way, one
    // sale after the other, with nothing left to send once paired again.
    saveQueue([sale("a"), sale("b"), sale("c")]);
    const error = new ApiError(status, `HTTP ${status}`, { detail: "no" });
    checkout.mockRejectedValue(error);

    const report = await drainQueue(pairing);

    expect(checkout).toHaveBeenCalledTimes(1);
    expect(report.failed).toBe(0);
    expect(report.halted?.kind).toBe(kind);
    expect(report.halted?.message).toBe(describeError(error));
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(loadFailures()).toEqual([]);
  });

  it("keeps it on a 400 that carries no reasons, which is a proxy talking", async () => {
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(new ApiError(400, "HTTP 400", "<html>Bad Request</html>"));

    const report = await drainQueue(pairing);

    expect(report.halted?.kind).toBe("other");
    expect(loadQueue().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("waits as long as a rate limit asks before the next automatic run", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-17T01:00:00.000Z") });
    try {
      saveQueue([sale("a")]);
      checkout.mockRejectedValue(new ApiError(429, "HTTP 429", null, 90_000));

      const report = await drainQueue(pairing);

      expect(report.halted?.retryAt).toBe(Date.now() + 90_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits a quarter of a minute when the rate limit does not say", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-17T01:00:00.000Z") });
    try {
      saveQueue([sale("a")]);
      checkout.mockRejectedValue(new ApiError(429, "HTTP 429"));

      const report = await drainQueue(pairing);

      expect(report.halted?.retryAt).toBe(Date.now() + THROTTLED_WAIT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a network failure is one, with no wait of its own", async () => {
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(new ApiError(0, "network"));

    const report = await drainQueue(pairing);

    expect(report.halted).toEqual({
      kind: "unreachable", message: describeError(new ApiError(0, "network")), retryAt: null,
    });
  });

  it("files a sale the server says is dated in the future as refused, like any refusal", async () => {
    // With sent_at the server corrects the date itself; one it still refuses
    // is a refusal with its reasons, and it is shown rather than retried.
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(
      new ApiError(400, "This sale is dated in the future.", {
        offline: { recorded_at: ["This sale is dated in the future."] },
      }),
    );

    const report = await drainQueue(pairing);

    expect(report.failed).toBe(1);
    expect(loadFailures()[0].message).toBe("This sale is dated in the future.");
  });

  it("keeps a refused sale in the queue when its refusal cannot be written down", async () => {
    // It used to leave the queue all the same, and then existed nowhere.
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(refusal("refused"));
    const write = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "openpos.failures.v1") throw new Error("QuotaExceededError");
      write(key, value);
    });
    try {
      const report = await drainQueue(pairing);

      expect(report.failed).toBe(0);
      expect(report.halted).toEqual({
        kind: "other", message: t("offline.storageFull"), retryAt: null,
      });
      expect(loadQueue().map((entry) => entry.id)).toEqual(["a"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("files a refusal once, however many runs meet the same entry", async () => {
    saveQueue([sale("a")]);
    checkout.mockRejectedValue(refusal("refused"));
    const write = localStorage.setItem.bind(localStorage);
    let refuseQueue = true;
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "openpos.queue.v1" && refuseQueue) throw new Error("QuotaExceededError");
      write(key, value);
    });
    try {
      await drainQueue(pairing);
      refuseQueue = false;
      await drainQueue(pairing);

      expect(loadFailures()).toHaveLength(1);
      expect(loadQueue()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("stops without throwing when the queue cannot be rewritten after a send", async () => {
    // The sale went: sent again at the next run, the server answers it as the
    // replay it is. This used to escape as an unhandled rejection.
    saveQueue([sale("a"), sale("b")]);
    checkout.mockResolvedValue(sold);
    const write = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "openpos.queue.v1") throw new Error("QuotaExceededError");
      write(key, value);
    });
    try {
      const report = await drainQueue(pairing);

      expect(report.halted?.kind).toBe("other");
      expect(checkout).toHaveBeenCalledTimes(1);
      expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("notes when it last sent everything it could, and not when it stopped short", async () => {
    saveQueue([sale("a")]);
    checkout.mockRejectedValueOnce(new ApiError(0, "network"));

    await drainQueue(pairing);
    expect(loadLastSync()).toBeNull();

    checkout.mockResolvedValue(sold);
    await drainQueue(pairing);
    expect(loadLastSync()).not.toBeNull();
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

describe("sendable", () => {
  it("holds back a sale of another event only", () => {
    expect(sendable(sale("a", "other-event"), "festival")).toBe(false);
    expect(sendable(sale("a"), "festival")).toBe(true);
    expect(sendable(checkin("n", "s", { event: "other-event" }), "festival")).toBe(true);
  });
});

describe("the figure kept for a reload", () => {
  const counted: DoorScans = {
    device: { admitted: 5, refused: 1, other: 0, offline: 0 },
    event: { admitted: 50, refused: 2, other: 0, offline: 0 },
    devices: [],
  };

  it("counts a scan the drain has sent", async () => {
    // Out of the queue and not yet in the figure: without this, a phone
    // reloaded with no network right after a drain opened short of it.
    saveDoorScans("festival", counted);
    saveQueue([checkin("nonce-1", "alice-secret", { at: new Date().toISOString() })]);
    redeem.mockResolvedValue({ status: "ok" });

    await drainQueue(pairing);

    expect(loadDoorScans("festival")).toEqual({
      ...counted,
      device: { admitted: 6, refused: 1, other: 0, offline: 1 },
      event: { admitted: 51, refused: 2, other: 0, offline: 1 },
    });
  });

  it("counts a refusal as one", async () => {
    saveDoorScans("festival", counted);
    saveQueue([checkin("n", "nobody", { at: new Date().toISOString(), refused: "invalid" })]);
    reportRefusal.mockResolvedValue({});

    await drainQueue(pairing);

    expect(loadDoorScans("festival")?.device?.refused).toBe(2);
  });

  it("leaves out a scan the server would not take", async () => {
    saveDoorScans("festival", counted);
    saveQueue([checkin("nonce-1", "alice-secret", { at: new Date().toISOString() })]);
    redeem.mockRejectedValue(new ApiError(400, "unknown list"));

    await drainQueue(pairing);

    expect(loadDoorScans("festival")).toEqual(counted);
  });

  it("counts a scan from an earlier night of the event", async () => {
    // Weeks old, and still one of this event's: the figure is the event's.
    saveDoorScans("festival", counted);
    saveQueue([checkin("nonce-1", "alice-secret")]);
    redeem.mockResolvedValue({ status: "ok" });

    await drainQueue(pairing);

    expect(loadDoorScans("festival")?.event.admitted).toBe(51);
  });

  it("is not made up when there is none", async () => {
    saveQueue([checkin("nonce-1", "alice-secret", { at: new Date().toISOString() })]);
    redeem.mockResolvedValue({ status: "ok" });

    await drainQueue(pairing);

    expect(loadDoorScans("festival")).toBeNull();
  });
});
