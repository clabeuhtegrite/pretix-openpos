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

  it("falls back to whatever it was handed", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError("boom")).toBe("boom");
  });
});
