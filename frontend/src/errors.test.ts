import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { describeError, unanswered, wordlessRefusal } from "./errors";
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

  it("says a proxy that stopped waiting is worth another try, rather than 'HTTP 408'", () => {
    expect(describeError(new ApiError(408, "HTTP 408", "<html>Request Timeout</html>"))).toBe(
      t("error.timeout"),
    );
  });

  it("says a refusal pretix did not write is a refusal, not 'HTTP 403'", () => {
    // What the API layer makes of a CDN's challenge page, of an empty answer,
    // of plain text, and of JSON it found no message in.
    const pages = [
      new ApiError(403, "HTTP 403", "<!DOCTYPE html><title>Attention Required</title>"),
      new ApiError(403, "HTTP 403", null),
      new ApiError(403, "error code: 1020", "error code: 1020"),
      new ApiError(401, "HTTP 401", { message: "Unauthorized" }),
    ];
    for (const page of pages) {
      expect(wordlessRefusal(page)).toBe(true);
      expect(describeError(page)).toBe(t("error.denied", { status: page.status }));
    }
    // The status stays in the sentence, for whoever gets the phone call.
    expect(describeError(pages[0])).toContain("403");
    expect(describeError(pages[3])).toContain("401");
  });

  it("keeps pretix' own words on a refusal it explained", () => {
    const revoked = new ApiError(401, "Invalid token.", { detail: "Invalid token." });
    expect(wordlessRefusal(revoked)).toBe(false);
    expect(describeError(revoked)).toBe("Invalid token.");
    // An error made without any body did not come from anywhere: left alone.
    expect(wordlessRefusal(new ApiError(403, "Device revoked"))).toBe(false);
    expect(describeError(new ApiError(403, "Device revoked"))).toBe("Device revoked");
  });

  it("only ever calls a 401 or a 403 a wordless refusal", () => {
    expect(wordlessRefusal(new ApiError(400, "HTTP 400", null))).toBe(false);
    expect(wordlessRefusal(new ApiError(404, "HTTP 404", "<html></html>"))).toBe(false);
    expect(wordlessRefusal(new TypeError("HTTP 403"))).toBe(false);
    expect(describeError(new ApiError(404, "HTTP 404", "<html></html>"))).toBe("HTTP 404");
  });

  it("falls back to whatever it was handed", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError("boom")).toBe("boom");
  });
});

describe("a failure that leaves the request's fate open", () => {
  it("is one the server may not have seen, or turned away without doing anything", () => {
    expect(unanswered(new ApiError(0, "network"))).toBe(true);
    expect(unanswered(new ApiError(502, "HTTP 502"))).toBe(true);
    expect(unanswered(new ApiError(500, "A server error occurred."))).toBe(true);
    // A proxy that gave up waiting for the request, and a server asking the
    // device to slow down: neither did the work.
    expect(unanswered(new ApiError(408, "HTTP 408"))).toBe(true);
    expect(unanswered(new ApiError(429, "HTTP 429"))).toBe(true);
  });

  it("is not a refusal, which is the server's final word", () => {
    expect(unanswered(new ApiError(400, "Already cancelled."))).toBe(false);
    expect(unanswered(new ApiError(403, "Device revoked"))).toBe(false);
    expect(unanswered(new ApiError(409, "Conflict"))).toBe(false);
    expect(unanswered(new TypeError("boom"))).toBe(false);
  });
});
