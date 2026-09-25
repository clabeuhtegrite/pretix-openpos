import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { describeError } from "./errors";
import { t } from "./i18n";

describe("what a failure is shown as", () => {
  it("names the one thing a cashier can act on when the server is out of reach", () => {
    // "Failed to fetch" tells nobody anything at a counter.
    expect(describeError(new ApiError(0, "network"))).toBe(t("error.offline"));
  });

  it("passes the server's own words through, because they were written for this", () => {
    expect(describeError(new ApiError(400, "This product is not on sale here."))).toBe(
      "This product is not on sale here.",
    );
  });

  it("says the server is in trouble and to try again, rather than 'HTTP 502'", () => {
    // What a proxy answers for a pretix that is restarting: no JSON, so the
    // API layer could only call it by its status.
    const shown = describeError(new ApiError(502, "HTTP 502", "<html>Bad Gateway</html>"));
    expect(shown).toBe(t("error.server", { status: 502 }));
    expect(shown).toContain("502");
    expect(shown).not.toMatch(/ApiError/);
  });

  it("does so for any fault, even one that came with framework prose", () => {
    expect(describeError(new ApiError(500, "A server error occurred."))).toBe(
      t("error.server", { status: 500 }),
    );
    expect(describeError(new ApiError(504, "HTTP 504"))).toBe(t("error.server", { status: 504 }));
  });

  it("asks to wait a few seconds when the server says there were too many requests", () => {
    expect(
      describeError(new ApiError(429, "Request was throttled. Expected available in 5 seconds.")),
    ).toBe(t("error.tooMany"));
    expect(describeError(new ApiError(429, "HTTP 429"))).toBe(t("error.tooMany"));
  });

  it("falls back to whatever it was handed", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError("boom")).toBe("boom");
  });
});
