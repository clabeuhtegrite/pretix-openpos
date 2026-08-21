import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pairing } from "./types";

/**
 * The one place the till talks to pretix.
 *
 * Two things here are load-bearing beyond the obvious. First, what counts as
 * "the server is not there" — because that, and not the browser's opinion of
 * its network interface, is what tips the till into offline mode. Second, which
 * failures are worth repeating: an early version treated a 502 as a refusal and
 * took two paid sales out of the queue for good.
 *
 * The modules keep state at module scope, so each test imports both fresh.
 */

type Api = typeof import("./api");
type Connectivity = typeof import("./connectivity");

let api: Api["api"];
let ApiError: Api["ApiError"];
let isRetryable: Api["isRetryable"];
let connectivity: Connectivity;
let fetchMock: ReturnType<typeof vi.fn>;

const pairing: Pairing = {
  token: "tok",
  organizer: "demo",
  event: "festival",
  serial: "TILL1",
  deviceName: "Caisse bar",
};

/**
 * Make the server answer this, for every call the test makes.
 *
 * A fresh Response per call rather than one instance: a body can only be read
 * once, and a test that makes two requests would otherwise fail on the second
 * for a reason that has nothing to do with what it is checking.
 */
function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

/** The same, for an answer that is not JSON — an nginx page, an empty 204. */
function respondRaw(body: BodyInit | null, status: number): void {
  fetchMock.mockImplementation(async () => new Response(body, { status }));
}

/** The URL and options of the nth call, for asserting on the request itself. */
function callArgs(index = 0): [string, RequestInit] {
  const [url, options] = fetchMock.mock.calls[index];
  return [String(url), options as RequestInit];
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  respondWith({});
  const module = await import("./api");
  api = module.api;
  ApiError = module.ApiError;
  isRetryable = module.isRetryable;
  connectivity = await import("./connectivity");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shape of a request", () => {
  it("signs it with the device token", async () => {
    await api.config(pairing);

    const [, options] = callArgs();
    expect(options.headers).toMatchObject({ Authorization: "Device tok" });
  });

  it("sends no Authorization header when there is no token", async () => {
    // Pairing itself: the one call made before there is anything to sign with.
    await api.initialize("init-code");

    const [, options] = callArgs();
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it("sends a body only when there is one", async () => {
    await api.config(pairing);

    const [, options] = callArgs();
    expect(options.body).toBeUndefined();
    expect(options.method).toBe("GET");
  });

  it("serialises the body it was given", async () => {
    await api.summary(pairing);
    fetchMock.mockClear();

    await api.cancelSale(pairing, { seq: 4, idempotency_key: "k" });

    const [, options] = callArgs();
    expect(JSON.parse(String(options.body))).toEqual({ seq: 4, idempotency_key: "k" });
  });

  it("returns the parsed answer", async () => {
    respondWith({ since: "2026-08-16T04:00:00Z" });

    await expect(api.summary(pairing)).resolves.toMatchObject({
      since: "2026-08-16T04:00:00Z",
    });
  });

  it("returns null for an answer with no body", async () => {
    respondRaw(null, 204);

    await expect(api.summary(pairing)).resolves.toBeNull();
  });
});

describe("what counts as the server not being there", () => {
  it("puts the till offline when the request never left", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(api.config(pairing)).rejects.toThrow(ApiError);
    expect(connectivity.isOnline()).toBe(false);
  });

  it("marks a transport failure as status 0, which is what isNetwork reads", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await api.config(pairing).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<Api["ApiError"]>).status).toBe(0);
    expect((error as InstanceType<Api["ApiError"]>).isNetwork).toBe(true);
  });

  it("puts it offline on a server fault too", async () => {
    // A proxy answering 502 for a backend that is down, or a 500 that means
    // this sale is not going to be taken either.
    respondWith({ detail: "boom" }, 502);

    await expect(api.config(pairing)).rejects.toThrow(ApiError);
    expect(connectivity.isOnline()).toBe(false);
  });

  it("leaves it online for a refusal", async () => {
    // The server understood and said no. That is not an outage, and queueing
    // the sale would only replay a refusal.
    respondWith({ detail: "not on sale here" }, 400);

    await expect(api.config(pairing)).rejects.toThrow(ApiError);
    expect(connectivity.isOnline()).toBe(true);
  });

  it("brings it back up on any answer, refusal included", async () => {
    connectivity.markUnreachable();
    respondWith({ detail: "nope" }, 403);

    await api.config(pairing).catch(() => undefined);

    expect(connectivity.isOnline()).toBe(true);
  });

  it("lets an abort through as an abort, not as an outage", async () => {
    // A catalogue refresh cancelled because the screen changed must not make
    // the till believe it lost the network.
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));

    const error = await api.catalog(pairing).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect(connectivity.isOnline()).toBe(true);
  });
});

describe("the message a cashier is shown", () => {
  it("uses DRF's detail when there is one", async () => {
    respondWith({ detail: "Not found." }, 404);

    await expect(api.config(pairing)).rejects.toThrow("Not found.");
  });

  it("unwraps a field error, which is the shape that matters at the till", async () => {
    respondWith({ positions: ["This product is not on sale here."] }, 400);

    await expect(api.config(pairing)).rejects.toThrow("This product is not on sale here.");
  });

  it("joins several field errors rather than showing one", async () => {
    respondWith({ positions: ["Sold out."], payment_type: "Unknown." }, 400);

    const error = await api.config(pairing).catch((e: unknown) => e);

    expect((error as Error).message).toBe("Sold out. Unknown.");
  });

  it("takes a bare string body as the message", async () => {
    respondWith("Down for maintenance", 503);

    await expect(api.config(pairing)).rejects.toThrow("Down for maintenance");
  });

  it("falls back to the status when the body says nothing useful", async () => {
    respondWith({}, 418);

    await expect(api.config(pairing)).rejects.toThrow("HTTP 418");
  });

  it("survives a body that is not JSON at all", async () => {
    // An nginx error page, which is what a real outage looks like.
    respondRaw("<html>502 Bad Gateway</html>", 502);

    await expect(api.config(pairing)).rejects.toThrow("<html>502 Bad Gateway</html>");
  });
});

describe("isRetryable", () => {
  it("says yes to a request that never arrived", () => {
    expect(isRetryable(new ApiError(0, "network"))).toBe(true);
  });

  it.each([500, 502, 503, 504])("says yes to a %i", (status) => {
    expect(isRetryable(new ApiError(status, "fault"))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409])("says no to a %i", (status) => {
    // Retrying a refusal forever hides the problem instead of solving it.
    expect(isRetryable(new ApiError(status, "refused"))).toBe(false);
  });

  it("says no to something that is not an API error at all", () => {
    expect(isRetryable(new TypeError("bug in the app"))).toBe(false);
  });
});

describe("the endpoints", () => {
  it("pairs by exchanging the one-shot code, and says which build it is", async () => {
    await api.initialize("init-code");

    const [url, options] = callArgs();
    expect(url).toBe("/api/v1/device/initialize");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toMatchObject({
      token: "init-code",
      software_brand: "pretix-openpos",
      software_version: __APP_VERSION__,
    });
  });

  it("reads the configuration for the paired event", async () => {
    await api.config(pairing);

    expect(callArgs()[0]).toBe("/api/v1/organizers/demo/events/festival/openpos/config/");
  });

  it("reads the catalogue", async () => {
    await api.catalog(pairing);

    expect(callArgs()[0]).toBe("/api/v1/organizers/demo/events/festival/openpos/catalog/");
  });

  it("rings up a sale", async () => {
    const payload = {
      idempotency_key: "key-1",
      positions: [{ item: 10, variation: null, count: 2 }],
      payment_type: "cash",
      cash_given: "10.00",
    };

    await api.checkout(pairing, payload);

    const [url, options] = callArgs();
    expect(url).toBe("/api/v1/organizers/demo/events/festival/openpos/checkout/");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual(payload);
  });

  it("asks for the guest list of one check-in list", async () => {
    await api.offlineSnapshot(pairing, 7);

    expect(callArgs()[0]).toBe(
      "/api/v1/organizers/demo/events/festival/openpos/offline/?list=7",
    );
  });

  it("reads this till's own history", async () => {
    await api.history(pairing);

    expect(callArgs()[0]).toBe("/api/v1/organizers/demo/events/festival/openpos/history/");
  });

  it("cancels a sale by its journal sequence, under an idempotency key", async () => {
    // A cancellation that timed out but went through must not cancel twice.
    await api.cancelSale(pairing, { seq: 12, idempotency_key: "cancel-1", reason: "erreur" });

    const [url, options] = callArgs();
    expect(url).toBe("/api/v1/organizers/demo/events/festival/openpos/cancel/");
    expect(JSON.parse(String(options.body))).toMatchObject({
      seq: 12,
      idempotency_key: "cancel-1",
    });
  });

  it("reads the takings", async () => {
    await api.summary(pairing);

    expect(callArgs()[0]).toBe("/api/v1/organizers/demo/events/festival/openpos/summary/");
  });

  it("reads the head count for one list", async () => {
    await api.attendance(pairing, 7);

    expect(callArgs()[0]).toBe(
      "/api/v1/organizers/demo/events/festival/openpos/attendance/?list=7",
    );
  });

  it("lists the events this device may sell for, at the organizer level", async () => {
    await api.posEvents("demo", "tok");

    const [url, options] = callArgs();
    expect(url).toBe("/api/v1/organizers/demo/openpos/");
    expect(options.headers).toMatchObject({ Authorization: "Device tok" });
  });

  it("searches for a ticket through pretix' own search", async () => {
    await api.searchAttendees(pairing, { listId: 7, query: "marie dupont" });

    expect(callArgs()[0]).toBe(
      "/api/v1/organizers/demo/checkinrpc/search/?list=7&search=marie+dupont",
    );
  });
});

describe("redeeming a ticket", () => {
  it("goes through pretix' own RPC, not a POS endpoint of our own", async () => {
    // Same call pretixSCAN makes, so the rules engine and every refusal reason
    // come from pretix rather than a reimplementation that would drift.
    respondWith({ status: "ok" });

    await api.redeem(pairing, { secret: "s", lists: [7], nonce: "n1" });

    const [url, options] = callArgs();
    expect(url).toBe("/api/v1/organizers/demo/checkinrpc/redeem/");
    expect(JSON.parse(String(options.body))).toMatchObject({
      lists: [7],
      secret: "s",
      source_type: "barcode",
      type: "entry",
      force: false,
      questions_supported: false,
      nonce: "n1",
    });
  });

  it("does not send a timestamp for a scan happening now", async () => {
    respondWith({ status: "ok" });

    await api.redeem(pairing, { secret: "s", lists: [7], nonce: "n1" });

    expect(JSON.parse(String(callArgs()[1].body))).not.toHaveProperty("datetime");
  });

  it("sends the original moment for a scan replayed from the queue", async () => {
    respondWith({ status: "ok" });

    await api.redeem(pairing, {
      secret: "s",
      lists: [7],
      nonce: "n1",
      datetime: "2026-08-16T22:10:00.000Z",
    });

    expect(JSON.parse(String(callArgs()[1].body))).toMatchObject({
      datetime: "2026-08-16T22:10:00.000Z",
    });
  });

  it.each([400, 404])("treats a %i carrying a verdict as an answer, not a failure", async (status) => {
    // A refused ticket is a verdict the door has to show, not an error.
    respondWith({ status: "error", reason: "already_redeemed" }, status);

    await expect(api.redeem(pairing, { secret: "s", lists: [7], nonce: "n" })).resolves.toEqual({
      status: "error",
      reason: "already_redeemed",
    });
  });

  it("still throws on a refusal that carries no verdict", async () => {
    respondWith({ detail: "Not found." }, 404);

    await expect(api.redeem(pairing, { secret: "s", lists: [7], nonce: "n" })).rejects.toThrow(
      "Not found.",
    );
  });

  it("throws on an authentication problem, which is not a verdict", async () => {
    respondWith({ status: "error", reason: "nope" }, 403);

    await expect(api.redeem(pairing, { secret: "s", lists: [7], nonce: "n" })).rejects.toThrow(
      ApiError,
    );
  });
});
