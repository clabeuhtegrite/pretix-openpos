import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASKET_KEEPS_FOR_MS, clearAdmissions, clearBasket, clearPairing, clearSnapshot, enqueue,
  loadAdmissions, loadBasket, loadCached, loadCashier, loadDoorScans, loadFailures, loadPairing,
  loadQueue, loadSnapshot,
  loadSnapshotPull, loadUpdateAttempt, requestPersistence, saveAdmissions, saveBasket, saveCached,
  saveCashier, saveDoorScans, saveFailures, savePairing, saveQueue, saveSnapshot, saveSnapshotPull,
  saveUpdateAttempt,
} from "./storage";
import { fillStorage } from "./test/setup";
import type {
  CartLine, DoorScans, OfflineSnapshot, Pairing, QueuedSale, SyncFailure,
} from "./types";

/**
 * The till's only durable memory. Everything a cashier has taken money for
 * lives here between the drawer closing and the server accepting it, so the
 * rules that matter are about what happens when a write fails: the queue must
 * shout, and nothing else may.
 */

const pairing: Pairing = {
  token: "tok",
  organizer: "demo",
  event: "festival",
  serial: "TILL1",
  deviceName: "Caisse bar",
};

function sale(id: string): QueuedSale {
  return {
    kind: "sale",
    id,
    at: "2026-08-16T22:02:21.000Z",
    event: "festival",
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

const snapshot: OfflineSnapshot = {
  list: { id: 7, name: "Porte" },
  generated: "2026-08-16T20:00:00.000Z",
  tickets: [{ secret: "abc", item: 10, name: "Alice", used: false }],
  truncated: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the offline queue", () => {
  it("comes back empty on a till that has never been cut off", () => {
    expect(loadQueue()).toEqual([]);
  });

  it("survives a reload with its entries in order", () => {
    saveQueue([sale("a"), sale("b")]);

    expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("appends rather than replaces when a sale is queued", () => {
    saveQueue([sale("a")]);

    enqueue(sale("b"));

    expect(loadQueue().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("refuses to fail quietly when the write does not land", () => {
    // A sale that is not on disk is a sale that will never reach pretix. The
    // caller has to be able to tell the cashier before the customer leaves.
    fillStorage();

    expect(() => enqueue(sale("a"))).toThrow("queue-write-failed");
  });

  it("comes back empty rather than throwing on a corrupted store", () => {
    localStorage.setItem("openpos.queue.v1", "{not json");

    expect(loadQueue()).toEqual([]);
  });
});

describe("the replay failures list", () => {
  const failure: SyncFailure = {
    entry: sale("a"),
    at: "2026-08-16T23:00:00.000Z",
    message: "not on sale at the till",
  };

  it("survives a reload", () => {
    saveFailures([failure]);

    expect(loadFailures()).toEqual([failure]);
  });

  it("is dropped rather than taking the queue down with it", () => {
    // Of the two, this is the one the server can reconstruct.
    fillStorage();

    expect(() => saveFailures([failure])).not.toThrow();
  });
});

describe("the cached catalogue and configuration", () => {
  it("is nothing at all before the first successful load", () => {
    expect(loadCached("catalog", "festival")).toBeNull();
  });

  it("is kept per event, so switching events cannot serve the wrong tariff", () => {
    saveCached("catalog", "festival", { categories: ["beer"] });
    saveCached("catalog", "gala", { categories: ["wine"] });

    expect(loadCached("catalog", "festival")).toEqual({ categories: ["beer"] });
    expect(loadCached("catalog", "gala")).toEqual({ categories: ["wine"] });
  });

  it("keeps the configuration apart from the catalogue for one event", () => {
    saveCached("config", "festival", { currency: "EUR" });
    saveCached("catalog", "festival", { categories: [] });

    expect(loadCached("config", "festival")).toEqual({ currency: "EUR" });
  });

  it("costs only the ability to start offline when it cannot be written", () => {
    fillStorage();

    expect(() => saveCached("catalog", "festival", { categories: [] })).not.toThrow();
  });
});

describe("the door's last count", () => {
  const counted: DoorScans = {
    device: { admitted: 41, refused: 2, other: 0, offline: 3 },
    event: { admitted: 180, refused: 5, other: 1, offline: 7 },
    devices: [],
  };

  it("survives a reload, so the counter does not start again from zero", () => {
    saveDoorScans("festival", counted);

    expect(loadDoorScans("festival")).toEqual(counted);
  });

  it("is kept per event", () => {
    saveDoorScans("festival", counted);

    expect(loadDoorScans("gala")).toBeNull();
  });

  it("is still the event's figure days later", () => {
    // It counts the whole event, so no morning makes it out of date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T21:00:00.000Z"));
    saveDoorScans("festival", counted);

    vi.setSystemTime(new Date("2026-09-23T08:00:00.000Z"));

    expect(loadDoorScans("festival")).toEqual(counted);
    vi.useRealTimers();
  });

  it("leaves out a figure that counted one evening only", () => {
    // What 0.18.0 kept: from six in the morning, short of the event's.
    localStorage.setItem(
      "openpos.doorScans.v1.festival",
      JSON.stringify({ ...counted, since: new Date().toISOString() }),
    );

    expect(loadDoorScans("festival")).toBeNull();
  });

  it("is ignored when it is not a count", () => {
    localStorage.setItem("openpos.doorScans.v2.festival", JSON.stringify({ device: null }));
    expect(loadDoorScans("festival")).toBeNull();

    localStorage.setItem("openpos.doorScans.v2.festival", "null");
    expect(loadDoorScans("festival")).toBeNull();
  });

  it("costs only the figure after a reload when it cannot be written", () => {
    fillStorage();

    expect(() => saveDoorScans("festival", counted)).not.toThrow();
  });
});

describe("the offline guest list", () => {
  it("survives a reload", () => {
    saveSnapshot(snapshot);

    expect(loadSnapshot()).toEqual(snapshot);
  });

  it("is dropped whole rather than half-held when it will not fit", () => {
    // Scanning offline then says it carries no list, which a door can act on.
    // Half a guest list would turn valid tickets away with a straight face.
    fillStorage();

    expect(() => saveSnapshot(snapshot)).not.toThrow();
    expect(loadSnapshot()).toBeNull();
  });

  it("goes away when the till is told to forget it, with the time it was pulled", () => {
    saveSnapshot(snapshot);
    saveSnapshotPull({ event: "festival", list: 7, at: 1 });

    clearSnapshot();

    expect(loadSnapshot()).toBeNull();
    expect(loadSnapshotPull()).toBeNull();
  });

  it("does not let a storage that refuses even that stop the till", () => {
    const removeItem = vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => clearSnapshot()).not.toThrow();
    removeItem.mockRestore();
  });
});

describe("who the door let in", () => {
  it("survives a reload, per event", () => {
    saveAdmissions("festival", { 7: { alice: 1 } });

    expect(loadAdmissions("festival")).toEqual({ 7: { alice: 1 } });
    expect(loadAdmissions("gala")).toEqual({});
  });

  it("leaves nothing on disk once there is nothing to remember", () => {
    saveAdmissions("festival", { 7: { alice: 1 } });

    saveAdmissions("festival", {});

    expect(localStorage.getItem("openpos.admitted.v1.festival")).toBeNull();
  });

  it("reads as nothing when what is on disk is not a record", () => {
    localStorage.setItem("openpos.admitted.v1.festival", JSON.stringify(["alice"]));

    expect(loadAdmissions("festival")).toEqual({});
  });

  it("is forgotten for every event at once, and nothing else with it", () => {
    saveAdmissions("festival", { 7: { alice: 1 } });
    saveAdmissions("gala", { 21: { bob: 1 } });
    saveSnapshot(snapshot);

    clearAdmissions();

    expect(loadAdmissions("festival")).toEqual({});
    expect(loadAdmissions("gala")).toEqual({});
    expect(loadSnapshot()).toEqual(snapshot);
  });

  it("does not stop the door when storage will not take it", () => {
    fillStorage();

    expect(() => saveAdmissions("festival", { 7: { alice: 1 } })).not.toThrow();
  });

  it("does not stop the till when storage cannot even be listed", () => {
    const key = vi.spyOn(localStorage, "key").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    saveAdmissions("festival", { 7: { alice: 1 } });

    expect(() => clearAdmissions()).not.toThrow();
    key.mockRestore();
  });
});

describe("when the guest list was last pulled", () => {
  it("survives a reload", () => {
    saveSnapshotPull({ event: "festival", list: 7, at: 1234 });

    expect(loadSnapshotPull()).toEqual({ event: "festival", list: 7, at: 1234 });
  });

  it("is nothing rather than garbage when what is on disk is not one", () => {
    localStorage.setItem("openpos.snapshotPull.v1", JSON.stringify({ event: "festival" }));

    expect(loadSnapshotPull()).toBeNull();
  });

  it("is simply not kept when storage is full", () => {
    fillStorage();

    expect(() => saveSnapshotPull({ event: "festival", list: 7, at: 1 })).not.toThrow();
    expect(loadSnapshotPull()).toBeNull();
  });
});

describe("the pairing", () => {
  it("survives a reload", () => {
    savePairing(pairing);

    expect(loadPairing()).toEqual(pairing);
  });

  it("is nothing on a till that has never been paired", () => {
    expect(loadPairing()).toBeNull();
  });

  it.each(["token", "organizer", "event"] as const)(
    "is refused outright when %s is missing",
    (field) => {
      // Half a pairing sends the till to an endpoint it cannot authenticate
      // against and leaves it there; the pairing screen is the right answer.
      localStorage.setItem("openpos.pairing.v1", JSON.stringify({ ...pairing, [field]: "" }));

      expect(loadPairing()).toBeNull();
    },
  );

  it("is refused rather than thrown on when the store is corrupted", () => {
    localStorage.setItem("openpos.pairing.v1", "{not json");

    expect(loadPairing()).toBeNull();
  });

  it("goes away when the till is unpaired", () => {
    savePairing(pairing);

    clearPairing();

    expect(loadPairing()).toBeNull();
  });
});

describe("the cashier name", () => {
  it("is empty rather than undefined before anyone types one", () => {
    expect(loadCashier()).toBe("");
  });

  it("survives a reload, so a shift does not retype it", () => {
    saveCashier("Ana");

    expect(loadCashier()).toBe("Ana");
  });
});

describe("the update attempt", () => {
  it("is nothing until an update has been taken up", () => {
    expect(loadUpdateAttempt()).toBeNull();
  });

  it("remembers the version, so the offer is made once and not all evening", () => {
    saveUpdateAttempt("0.9.0");

    expect(loadUpdateAttempt()).toBe("0.9.0");
  });

  it("is not worth failing a reload over", () => {
    fillStorage();

    expect(() => saveUpdateAttempt("0.9.0")).not.toThrow();
  });
});

describe("requestPersistence", () => {
  it("asks the browser to keep the queue", () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", { storage: { persist } });

    requestPersistence();

    expect(persist).toHaveBeenCalledOnce();
  });

  it("says nothing when the browser refuses", async () => {
    // There is no answer an operator could act on in the middle of a service.
    const persist = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { storage: { persist } });

    expect(() => requestPersistence()).not.toThrow();
    await Promise.resolve();
  });

  it("does not need a browser that has the API at all", () => {
    vi.stubGlobal("navigator", {});

    expect(() => requestPersistence()).not.toThrow();
  });
});


describe("the basket left on screen", () => {
  const beer: CartLine = {
    key: "10:", itemId: 10, variationId: null, label: "Bière",
    unitPrice: 300, count: 2, available: null,
  };
  const credit = { amountCents: 1000, order: "DEMO-1" };

  afterEach(() => {
    clearBasket();
    vi.useRealTimers();
  });

  it("comes back on a till that was interrupted mid-sale", () => {
    saveBasket("festival", [beer], credit);

    expect(loadBasket("festival")).toEqual({ cart: [beer], credit });
  });

  it("is nothing at all on a till that was not", () => {
    expect(loadBasket("festival")).toBeNull();
  });

  it("belongs to the event it was rung up on", () => {
    // Switching events empties the basket for a reason: its prices, its
    // products and its quota all belong to the evening it was built for.
    saveBasket("festival", [beer], credit);

    expect(loadBasket("autre-soiree")).toBeNull();
  });

  it("is forgotten once nobody is standing in front of it", () => {
    // The credit is why this expires at all. Restoring a stale one takes money
    // off the next customer's total that belongs to somebody who left an hour
    // ago, which is real money out of the drawer; losing a fresh one costs a
    // trip back through the history panel.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T20:00:00.000Z"));
    saveBasket("festival", [beer], credit);

    vi.setSystemTime(new Date(Date.now() + BASKET_KEEPS_FOR_MS + 1000));

    expect(loadBasket("festival")).toBeNull();
  });

  it("does not come back on a second reload once it has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T20:00:00.000Z"));
    saveBasket("festival", [beer], credit);
    vi.setSystemTime(new Date(Date.now() + BASKET_KEEPS_FOR_MS + 1000));

    loadBasket("festival");

    expect(localStorage.getItem("openpos.basket.v1")).toBeNull();
  });

  it("is cleared rather than stored once the basket is empty", () => {
    saveBasket("festival", [beer], credit);

    saveBasket("festival", [], null);

    expect(localStorage.getItem("openpos.basket.v1")).toBeNull();
  });

  it("keeps a credit that outlives its basket", () => {
    // The corrected order can be rung up from an empty basket: the customer is
    // owed the money whether or not they are buying anything back.
    saveBasket("festival", [], credit);

    expect(loadBasket("festival")).toEqual({ cart: [], credit });
  });

  it("survives a storage that will not take the write", () => {
    // A full disk must not throw under an operator mid-sale. The basket is on
    // screen and they are looking at it; there is nothing to say.
    fillStorage();

    expect(() => saveBasket("festival", [beer], credit)).not.toThrow();
  });

  it("reads a corrupted entry as no basket at all", () => {
    localStorage.setItem("openpos.basket.v1", "{ not json");

    expect(loadBasket("festival")).toBeNull();
  });
});
