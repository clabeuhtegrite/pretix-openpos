import { describe, expect, it, vi } from "vitest";

import {
  cancellationKeys,
  clearCancellationResult,
  clearCancellations,
  loadCancellationResult,
  RESULT_KEEPS_FOR_MS,
  saveCancellationResult,
} from "./cancellation";
import { fillStorage } from "./test/setup";
import type { CancelResult, JournalLine } from "./types";

/**
 * The key a cancellation is sent under.
 *
 * These pin the rule a previous version broke by minting a fresh key on every
 * press: the retry of a cancellation that timed out has to arrive under the key
 * the first attempt used, or the server sees a *second* cancellation of a sale
 * it has already reversed, answers "already cancelled", and the operator is
 * left without the credit note and without the corrected basket — for a
 * cancellation that in fact went through.
 *
 * The next version kept the key in the history panel, which a tap beside it,
 * the back gesture or iOS reloading the app all threw away — so the retry was a
 * new cancellation again. The persistence tests below are about that.
 */

const SCOPE = "TILL1:festival";

/** Predictable keys, so a test can tell "the same one" from "another one". */
function counter(prefix = "key") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("cancellationKeys", () => {
  it("hands the same key back for every retry of one sale", () => {
    const keys = cancellationKeys(SCOPE, counter());

    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(12)).toBe("key-1");
  });

  it("gives a different sale a different key", () => {
    const keys = cancellationKeys(SCOPE, counter());

    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(13)).toBe("key-2");
    // Coming back to the first one does not mint a third.
    expect(keys.for(12)).toBe("key-1");
  });

  it("mints a fresh key once the server has answered", () => {
    const keys = cancellationKeys(SCOPE, counter());

    const first = keys.for(12);
    keys.settle(12);
    // A second cancellation of the same journal entry would be refused anyway,
    // but it is a new request and must not borrow the spent key: replaying that
    // one would hand back the first cancellation's answer as if it were this
    // one's.
    expect(keys.for(12)).not.toBe(first);
  });

  it("leaves other sales alone when one is settled", () => {
    const keys = cancellationKeys(SCOPE, counter());

    const twelve = keys.for(12);
    const thirteen = keys.for(13);
    keys.settle(12);

    expect(keys.for(13)).toBe(thirteen);
    expect(keys.for(12)).not.toBe(twelve);
  });

  it("mints real nonces by default", () => {
    const keys = cancellationKeys(SCOPE);

    const key = keys.for(1);
    // Long enough for the server, which refuses anything under eight characters.
    expect(key.length).toBeGreaterThanOrEqual(8);
    keys.settle(1);
    expect(keys.for(1)).not.toBe(key);
  });

  it("says which sales went out without an answer", () => {
    const keys = cancellationKeys(SCOPE, counter());

    expect(keys.pending(12)).toBe(false);
    keys.for(12);
    expect(keys.pending(12)).toBe(true);
    expect(keys.pending(13)).toBe(false);
    keys.settle(12);
    expect(keys.pending(12)).toBe(false);
  });

  it("keeps an unanswered key when the panel that minted it is gone", () => {
    // The panel closed — a tap beside it, the back gesture, iOS reloading the
    // app — while the request had timed out. The next panel is a new instance
    // and must still send the first key, or the retry is a new cancellation.
    const first = cancellationKeys(SCOPE, counter("first"));
    const key = first.for(12);

    const second = cancellationKeys(SCOPE, counter("second"));
    expect(second.pending(12)).toBe(true);
    expect(second.for(12)).toBe(key);
  });

  it("forgets an answered key across instances too", () => {
    const first = cancellationKeys(SCOPE, counter("first"));
    first.for(12);
    first.for(13);
    first.settle(12);

    const second = cancellationKeys(SCOPE, counter("second"));
    expect(second.pending(12)).toBe(false);
    expect(second.for(12)).toBe("second-1");
    expect(second.for(13)).toBe("first-2");
  });

  it("removes the stored entry once nothing is left in it", () => {
    const keys = cancellationKeys(SCOPE, counter());
    keys.for(12);
    expect(localStorage.getItem(`openpos.cancelKeys.v1.${SCOPE}`)).not.toBeNull();

    keys.settle(12);
    expect(localStorage.getItem(`openpos.cancelKeys.v1.${SCOPE}`)).toBeNull();
    // Settling what is not there writes nothing.
    keys.settle(99);
    expect(localStorage.getItem(`openpos.cancelKeys.v1.${SCOPE}`)).toBeNull();
  });

  it("keeps one till's keys apart from another event's, or another pairing's", () => {
    // Sale #12 of another event, or of this device paired again, is another
    // sale: it must not be sent under this one's key.
    const here = cancellationKeys(SCOPE, counter("here"));
    here.for(12);

    const otherEvent = cancellationKeys("TILL1:gala", counter("gala"));
    expect(otherEvent.pending(12)).toBe(false);
    expect(otherEvent.for(12)).toBe("gala-1");

    const otherTill = cancellationKeys("TILL2:festival", counter("till2"));
    expect(otherTill.for(12)).toBe("till2-1");

    expect(cancellationKeys(SCOPE).for(12)).toBe("here-1");
  });

  it("ignores what it cannot read on the device", () => {
    localStorage.setItem(`openpos.cancelKeys.v1.${SCOPE}`, "{not json");
    expect(cancellationKeys(SCOPE, counter()).for(12)).toBe("key-1");

    // A stored map with a key that is not a string: that one entry is dropped,
    // the rest is used.
    localStorage.setItem(`openpos.cancelKeys.v1.${SCOPE}`, JSON.stringify({ 12: 7, 13: "kept" }));
    const keys = cancellationKeys(SCOPE, counter());
    expect(keys.pending(12)).toBe(false);
    expect(keys.for(13)).toBe("kept");

    localStorage.setItem(`openpos.cancelKeys.v1.${SCOPE}`, JSON.stringify("text"));
    expect(cancellationKeys(SCOPE, counter()).pending(0)).toBe(false);
  });

  it("still holds its keys in memory when the device refuses to store them", () => {
    fillStorage();
    const keys = cancellationKeys(SCOPE, counter());

    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(12)).toBe("key-1");
    expect(keys.pending(12)).toBe(true);
    keys.settle(12);
    expect(keys.pending(12)).toBe(false);
  });
});

function line(overrides: Partial<JournalLine> = {}): JournalLine {
  return {
    seq: 12,
    kind: "sale",
    datetime: "2026-08-16T22:02:00.000Z",
    order: "POS01",
    total: "12.00",
    payment_type: "cash",
    cashier: "Ana",
    testmode: false,
    positions: [],
    reason: "",
    cancels_seq: null,
    cancelled: false,
    can_cancel: true,
    ...overrides,
  };
}

function result(): CancelResult {
  return {
    cancellation: line({ seq: 13, kind: "cancellation", total: "-12.00", cancels_seq: 12 }),
    sale: line({ cancelled: true, can_cancel: false }),
    replayed: false,
    credit_note: null,
    refunded: true,
  };
}

describe("the cancellation waiting on screen", () => {
  it("comes back until somebody acts on it", () => {
    saveCancellationResult(SCOPE, result());

    expect(loadCancellationResult(SCOPE)).toEqual(result());
    // Reading it does not use it up: the panel may be closed and opened again.
    expect(loadCancellationResult(SCOPE)).toEqual(result());

    clearCancellationResult(SCOPE);
    expect(loadCancellationResult(SCOPE)).toBeNull();
  });

  it("belongs to one till on one event", () => {
    saveCancellationResult(SCOPE, result());

    expect(loadCancellationResult("TILL1:gala")).toBeNull();
    expect(loadCancellationResult("TILL2:festival")).toBeNull();
  });

  it("is dropped once the customer it was for has long gone", () => {
    const saved = new Date("2026-08-16T21:00:00").getTime();
    const now = vi.spyOn(Date, "now").mockReturnValue(saved);
    saveCancellationResult(SCOPE, result());
    now.mockRestore();

    expect(loadCancellationResult(SCOPE, saved + RESULT_KEEPS_FOR_MS)).toEqual(result());
    expect(loadCancellationResult(SCOPE, saved + RESULT_KEEPS_FOR_MS + 1)).toBeNull();
    // And removed, not merely hidden.
    expect(localStorage.getItem(`openpos.cancelResult.v1.${SCOPE}`)).toBeNull();
  });

  it("ignores anything that is not a saved answer", () => {
    const key = `openpos.cancelResult.v1.${SCOPE}`;

    localStorage.setItem(key, "{not json");
    expect(loadCancellationResult(SCOPE)).toBeNull();

    localStorage.setItem(key, JSON.stringify({ at: Date.now() }));
    expect(loadCancellationResult(SCOPE)).toBeNull();

    localStorage.setItem(key, JSON.stringify({ result: { refund: null }, at: Date.now() }));
    expect(loadCancellationResult(SCOPE)).toBeNull();

    localStorage.setItem(key, JSON.stringify({ result: result(), at: "yesterday" }));
    expect(loadCancellationResult(SCOPE)).toBeNull();
  });

  it("is simply not kept when the device refuses to store it", () => {
    fillStorage();
    saveCancellationResult(SCOPE, result());
    expect(loadCancellationResult(SCOPE)).toBeNull();
  });
});

describe("clearCancellations", () => {
  it("forgets every key and every answer, for every till and event", () => {
    cancellationKeys(SCOPE, counter()).for(12);
    cancellationKeys("TILL1:gala", counter()).for(3);
    saveCancellationResult(SCOPE, result());
    saveCancellationResult("TILL1:gala", result());
    localStorage.setItem("openpos.pairing.v1", "kept");

    clearCancellations();

    expect(cancellationKeys(SCOPE).pending(12)).toBe(false);
    expect(cancellationKeys("TILL1:gala").pending(3)).toBe(false);
    expect(loadCancellationResult(SCOPE)).toBeNull();
    expect(loadCancellationResult("TILL1:gala")).toBeNull();
    // What is not its own stays.
    expect(localStorage.getItem("openpos.pairing.v1")).toBe("kept");
  });

  it("gives up quietly when the device cannot list what it holds", () => {
    const spy = vi.spyOn(localStorage, "key").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    saveCancellationResult(SCOPE, result());

    expect(() => clearCancellations()).not.toThrow();
    spy.mockRestore();
  });
});
