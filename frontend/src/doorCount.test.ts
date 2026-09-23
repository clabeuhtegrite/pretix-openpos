import { describe, expect, it } from "vitest";

import { addScans, countSent, doorCount, NO_SCANS, queuedScans, subtractScans, waitingScans } from "./doorCount";
import { loadDoorScans, saveDoorScans } from "./storage";
import type { DoorScans, QueuedCheckin, QueuedSale } from "./types";

/**
 * The scanner's counter.
 *
 * It used to be a tally kept by the screen, and it went back to zero every
 * time iOS reloaded the page. It is now the server's count plus what the
 * server cannot know yet — and the arithmetic of that "plus" is where a scan
 * could be counted twice, or not at all.
 */

const counted: DoorScans = {
  device: { admitted: 40, refused: 2, other: 1, offline: 3 },
  event: { admitted: 180, refused: 5, other: 1, offline: 7 },
  devices: [],
};

function scan(overrides: Partial<QueuedCheckin> = {}): QueuedCheckin {
  return {
    kind: "checkin", id: "n", at: "2026-09-19T21:00:00.000Z", event: "festival",
    list: 7, secret: "s", name: "", ...overrides,
  };
}

const sale: QueuedSale = {
  kind: "sale", id: "k", at: "2026-09-19T21:00:00.000Z", event: "festival",
  positions: [], chargedTotal: "10.00", paymentType: "cash", cashGiven: null,
  cashChange: null, cashier: "", admits: true, label: "1× Entrée",
};

describe("the figures", () => {
  it("add up line by line", () => {
    expect(addScans(counted.device!, { admitted: 1, refused: 1, other: 1, offline: 1 })).toEqual({
      admitted: 41, refused: 3, other: 2, offline: 4,
    });
  });

  it("never go below zero when taken apart", () => {
    expect(subtractScans({ ...NO_SCANS, admitted: 1 }, { ...NO_SCANS, admitted: 2, refused: 1 }))
      .toEqual(NO_SCANS);
  });
});

describe("what waits in the queue", () => {
  it("is sorted into let in, turned away and let nobody in", () => {
    const queue = [
      scan(),
      // Queued before the app wrote this down: they were all people let in.
      scan({ admits: undefined }),
      scan({ admits: false }),
      scan({ refused: "invalid" }),
    ];

    expect(queuedScans(queue, "festival")).toEqual({
      admitted: 2, refused: 1, other: 1, offline: 2,
    });
  });

  it("leaves out sales and other events", () => {
    expect(queuedScans([sale, scan({ event: "gala" })], "festival")).toEqual(NO_SCANS);
  });

  it("counts a scan from an earlier night of the event", () => {
    expect(queuedScans([scan({ at: "2026-09-01T21:00:00.000Z" })], "festival").admitted).toBe(1);
  });

  it("says how many are still to be sent, whenever they were made", () => {
    expect(waitingScans([sale, scan(), scan({ at: "2026-09-01T21:00:00.000Z" })], "festival"))
      .toBe(2);
  });
});

describe("the counter", () => {
  it("is the server's figure with what it has not heard of on top", () => {
    const count = doorCount(counted, { ...NO_SCANS, admitted: 2 }, [scan()], "festival");

    expect(count.device).toEqual({ admitted: 43, refused: 2, other: 1, offline: 4 });
    expect(count.event).toBe(183);
  });

  it("is this device's own scans alone before the server has answered", () => {
    const count = doorCount(null, { ...NO_SCANS, refused: 1 }, [scan()], "festival");

    expect(count.device).toEqual({ admitted: 1, refused: 1, other: 0, offline: 1 });
    expect(count.event).toBeNull();
  });

  it("reads zero on a device the server has no line for", () => {
    const count = doorCount({ ...counted, device: null }, NO_SCANS, [], "festival");

    expect(count.device).toEqual(NO_SCANS);
    expect(count.event).toBe(180);
  });
});

describe("a scan the drain has sent", () => {
  const now = new Date().toISOString();

  it("moves into the figure kept for a reload", () => {
    saveDoorScans("festival", counted);

    countSent(scan({ at: now }));

    expect(loadDoorScans("festival")).toEqual({
      ...counted,
      device: { admitted: 41, refused: 2, other: 1, offline: 4 },
      event: { admitted: 181, refused: 5, other: 1, offline: 8 },
    });
  });

  it("keeps a figure with no line for this device without one", () => {
    saveDoorScans("festival", { ...counted, device: null });

    countSent(scan({ at: now }));

    expect(loadDoorScans("festival")?.device).toBeNull();
    expect(loadDoorScans("festival")?.event.admitted).toBe(181);
  });

  it("does nothing when no figure is kept", () => {
    countSent(scan({ at: now }));

    expect(loadDoorScans("festival")).toBeNull();
  });
});
