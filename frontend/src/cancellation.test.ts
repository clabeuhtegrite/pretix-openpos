import { describe, expect, it } from "vitest";

import { cancellationKeys } from "./cancellation";

/**
 * The key a cancellation is sent under.
 *
 * These pin the rule a previous version broke by minting a fresh key on every
 * press: the retry of a cancellation that timed out has to arrive under the key
 * the first attempt used, or the server sees a *second* cancellation of a sale
 * it has already reversed, answers "already cancelled", and the operator is
 * left without the credit note and without the corrected basket — for a
 * cancellation that in fact went through.
 */

/** Predictable keys, so a test can tell "the same one" from "another one". */
function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe("cancellationKeys", () => {
  it("hands the same key back for every retry of one sale", () => {
    const keys = cancellationKeys(counter());

    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(12)).toBe("key-1");
  });

  it("gives a different sale a different key", () => {
    const keys = cancellationKeys(counter());

    expect(keys.for(12)).toBe("key-1");
    expect(keys.for(13)).toBe("key-2");
    // Coming back to the first one does not mint a third.
    expect(keys.for(12)).toBe("key-1");
  });

  it("mints a fresh key once the server has answered", () => {
    const keys = cancellationKeys(counter());

    const first = keys.for(12);
    keys.settle(12);
    // A second cancellation of the same journal entry would be refused anyway,
    // but it is a new request and must not borrow the spent key: replaying that
    // one would hand back the first cancellation's answer as if it were this
    // one's.
    expect(keys.for(12)).not.toBe(first);
  });

  it("leaves other sales alone when one is settled", () => {
    const keys = cancellationKeys(counter());

    const twelve = keys.for(12);
    const thirteen = keys.for(13);
    keys.settle(12);

    expect(keys.for(13)).toBe(thirteen);
    expect(keys.for(12)).not.toBe(twelve);
  });

  it("mints real nonces by default", () => {
    const keys = cancellationKeys();

    const key = keys.for(1);
    // Long enough for the server, which refuses anything under eight characters.
    expect(key.length).toBeGreaterThanOrEqual(8);
    keys.settle(1);
    expect(keys.for(1)).not.toBe(key);
  });
});
