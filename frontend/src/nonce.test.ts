import { afterEach, describe, expect, it, vi } from "vitest";

import { newNonce } from "./nonce";

/**
 * The idempotency key for a sale and the nonce for a check-in both come from
 * here. Two of them colliding would make the server treat a second sale as a
 * replay of the first and quietly take no money for it, so the fallback path
 * matters as much as the real one — and the fallback is the path a till on a
 * bare-HTTP dev box actually takes.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newNonce", () => {
  it("uses the browser's UUID generator when there is one", () => {
    const randomUUID = vi.fn(() => "11111111-2222-3333-4444-555555555555");
    vi.stubGlobal("crypto", { randomUUID });

    expect(newNonce()).toBe("11111111-2222-3333-4444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("still produces one without a secure context", () => {
    // http://192.168.x.x during setup: crypto exists but randomUUID does not.
    vi.stubGlobal("crypto", {});

    expect(newNonce()).toMatch(/^n-[0-9a-z]+-[0-9a-z]+$/);
  });

  it("produces one even where crypto is absent altogether", () => {
    vi.stubGlobal("crypto", undefined);

    expect(newNonce()).toMatch(/^n-/);
  });

  it("does not repeat itself", () => {
    vi.stubGlobal("crypto", {});

    const seen = new Set(Array.from({ length: 500 }, () => newNonce()));

    expect(seen.size).toBe(500);
  });
});
