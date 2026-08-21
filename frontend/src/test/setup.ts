import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

/**
 * The suite runs on jsdom, but not on its localStorage.
 *
 * jsdom's Storage is real enough, and a Map behind the same contract is both
 * faster and easier to make throw on demand — which the queue's out-of-quota
 * path needs, and which no browser will do to order. Kept as the one shim so
 * that every test starts from an empty till.
 */
const store = new Map<string, string>();

/** Set by a test that wants writes to fail, the way a full disk does. */
let refuseWrites = false;

const localStorageShim: Storage = {
  get length() {
    return store.size;
  },
  clear: () => {
    store.clear();
  },
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => {
    store.delete(key);
  },
  setItem: (key, value) => {
    if (refuseWrites) {
      // The name and shape a browser uses when it will take no more.
      const error = new Error("QuotaExceededError");
      error.name = "QuotaExceededError";
      throw error;
    }
    store.set(key, String(value));
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  configurable: true,
});

/**
 * Make every localStorage write fail for the rest of the test.
 *
 * Undone automatically afterwards, so a test that fills the disk cannot leave
 * the next one unable to save anything.
 */
export function fillStorage(): void {
  refuseWrites = true;
}

beforeEach(() => {
  store.clear();
  refuseWrites = false;
});

// React trees left mounted between tests find each other through the document
// and make a query that should match one element match three.
afterEach(cleanup);
