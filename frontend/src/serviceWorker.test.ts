import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service worker, loaded from where it is actually served.
 *
 * It is not part of the bundle — it lives in the plugin's static directory
 * because it has to be served from /openpos/sw.js for its scope to cover the
 * app — so it is read off disk and run against a fake worker scope here rather
 * than imported.
 *
 * What it decides matters more than its size suggests. It is the only reason a
 * tablet whose battery died mid-evening comes back as a till rather than as a
 * blank screen. And it must never keep anything it should not: a cached
 * catalogue would quote stale prices, a cached sale would be a disaster, and a
 * 502 stored during a server restart would be handed to the till on every cold
 * start afterwards.
 */

// Resolved from the vitest root (frontend/) rather than from import.meta.url,
// which is not a file: URL once the module has been through vite.
const SOURCE = readFileSync(
  resolve(process.cwd(), "../pretix_openpos/static/pretix_openpos/sw.js"),
  "utf8",
);

const ORIGIN = "https://pretix.example";

/** A response, in as much detail as the worker actually looks at. */
function response(overrides: Record<string, unknown> = {}) {
  const body = { ok: true, redirected: false, status: 200, ...overrides };
  return { ...body, clone: () => ({ ...body, clone: () => body }) };
}

interface FetchEvent {
  request: { url: string; method: string; mode: string };
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<unknown>) => void;
}

let listeners: Record<string, (event: FetchEvent) => void>;
let skipWaiting: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
/** The one cache the worker is allowed to keep, plus whatever else exists. */
let stored: Map<string, unknown>;
let cacheNames: string[];
let deleted: string[];
let cachePut: ReturnType<typeof vi.fn>;

function load() {
  listeners = {};
  const cache = {
    match: vi.fn(async (request: { url: string }) => stored.get(request.url)),
    put: cachePut,
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => cacheNames),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      return true;
    }),
    match: vi.fn(async (request: { url: string }) => stored.get(request.url)),
  };
  const scope = {
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
      listeners[type] = listener;
    },
    skipWaiting,
    clients: { claim },
    location: { origin: ORIGIN },
    caches,
  };
  // The worker refers to `self` and to a bare `caches`; both are given here.
  new Function("self", "caches", "fetch", "Response", "URL", SOURCE)(
    scope, caches, fetchMock, Response, URL,
  );
}

/** Fire a fetch event at the worker and hand back what it answered, if anything. */
async function fetchEvent(url: string, { method = "GET", mode = "no-cors" } = {}) {
  let answered: Promise<unknown> | null = null;
  const event: FetchEvent = {
    request: { url, method, mode },
    waitUntil: () => {},
    respondWith: (promise) => {
      answered = promise;
    },
  };
  listeners.fetch(event);
  return answered === null ? null : await answered;
}

beforeEach(() => {
  skipWaiting = vi.fn();
  claim = vi.fn();
  cachePut = vi.fn();
  fetchMock = vi.fn().mockResolvedValue(response());
  stored = new Map();
  cacheNames = [];
  deleted = [];
  load();
});

describe("taking over", () => {
  it("does not wait three sessions to become the new build", async () => {
    let waited: Promise<unknown> = Promise.resolve();
    listeners.install({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    } as unknown as FetchEvent);
    await waited;

    expect(skipWaiting).toHaveBeenCalled();
  });

  it("throws away every cache but its own on activation", async () => {
    // A shell from an older build, served to a till that has been upgraded, is
    // an update no reload can ever apply.
    cacheNames = [
      "openpos-shell-v1", "openpos-shell-v2", "openpos-pictures-v1", "something-else",
    ];
    let waited: Promise<unknown> = Promise.resolve();
    listeners.activate({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    } as unknown as FetchEvent);
    await waited;

    // The pictures are not the shell and survive a rebuild: they are large,
    // their names carry a uuid, and a bar that has just been upgraded is a bar
    // about to lose its network.
    expect(deleted).toEqual(["openpos-shell-v1", "something-else"]);
    expect(claim).toHaveBeenCalled();
  });
});

describe("what it keeps out of its hands", () => {
  it("never touches a request to pretix' API", async () => {
    // A cached catalogue quotes stale prices; a cached sale is a disaster.
    const answered = await fetchEvent(`${ORIGIN}/api/v1/organizers/demo/events/f/openpos/catalog/`);

    expect(answered).toBeNull();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("never touches a checkout, which is a POST anyway", async () => {
    const answered = await fetchEvent(`${ORIGIN}/openpos/`, { method: "POST", mode: "navigate" });

    expect(answered).toBeNull();
  });

  it("leaves another origin's requests alone", async () => {
    const answered = await fetchEvent("https://somewhere.else/thing.js");

    expect(answered).toBeNull();
  });

  it("leaves a page that is neither the app nor an asset alone", async () => {
    // The back office is not this worker's business.
    const answered = await fetchEvent(`${ORIGIN}/control/event/demo/f/orders/`);

    expect(answered).toBeNull();
  });
});

describe("opening the till", () => {
  const shell = `${ORIGIN}/openpos/`;

  it("goes to the network first, so a new build is picked up", async () => {
    const answered = await fetchEvent(shell, { mode: "navigate" });

    expect(fetchMock).toHaveBeenCalled();
    expect(answered).toMatchObject({ ok: true });
  });

  it("keeps the shell it was served, for the next cold start", async () => {
    await fetchEvent(shell, { mode: "navigate" });

    expect(cachePut).toHaveBeenCalledOnce();
  });

  it("refuses to keep an error page", async () => {
    // A 502 caught during a server restart is exactly when this worker runs,
    // and storing it would hand that same page to the till every cold start
    // from then on.
    fetchMock.mockResolvedValue(response({ ok: false, status: 502 }));

    await fetchEvent(shell, { mode: "navigate" });

    expect(cachePut).not.toHaveBeenCalled();
  });

  it("refuses to keep a redirect", async () => {
    // Chrome refuses a redirected response replayed from a cache for a
    // navigation, so a stored one is a blank screen with extra steps.
    fetchMock.mockResolvedValue(response({ redirected: true }));

    await fetchEvent(shell, { mode: "navigate" });

    expect(cachePut).not.toHaveBeenCalled();
  });

  it("still answers with the error page rather than swallowing it", async () => {
    fetchMock.mockResolvedValue(response({ ok: false, status: 502 }));

    const answered = await fetchEvent(shell, { mode: "navigate" });

    expect(answered).toMatchObject({ status: 502 });
  });

  it("falls back to the shell it kept when there is no network", async () => {
    // The whole reason this worker exists: a tablet whose battery ran out
    // mid-evening comes back as a till, not as a blank screen.
    stored.set(shell, response({ status: 200 }));
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const answered = await fetchEvent(shell, { mode: "navigate" });

    expect(answered).toMatchObject({ status: 200 });
  });

  it("says so plainly when it has no shell to fall back to", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const answered = (await fetchEvent(shell, { mode: "navigate" })) as unknown as Response;

    expect(answered.type).toBe("error");
  });
});

describe("the bundle and the icons", () => {
  const asset = `${ORIGIN}/static/pretix_openpos/pwa/app.js`;

  it("comes out of the cache without waiting for the network", async () => {
    stored.set(asset, response({ status: 200 }));

    const answered = await fetchEvent(asset);

    expect(answered).toMatchObject({ status: 200 });
  });

  it("is refreshed in the background all the same", async () => {
    stored.set(asset, response({ status: 200 }));

    await fetchEvent(asset);

    expect(fetchMock).toHaveBeenCalled();
  });

  it("is fetched and kept the first time it is asked for", async () => {
    const answered = await fetchEvent(asset);

    expect(answered).toMatchObject({ ok: true });
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it("is not kept when the server would not serve it", async () => {
    fetchMock.mockResolvedValue(response({ ok: false, status: 404 }));

    await fetchEvent(asset);

    expect(cachePut).not.toHaveBeenCalled();
  });

  it("fails honestly when it is neither cached nor reachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const answered = (await fetchEvent(asset)) as unknown as Response;

    expect(answered.type).toBe("error");
  });
});

describe("the product photographs", () => {
  const picture = `${ORIGIN}/media/pub/demo/f/item-10-abc.png`;

  it("is fetched and kept the first time it is asked for", async () => {
    await fetchEvent(picture);

    expect(fetchMock).toHaveBeenCalled();
    expect(cachePut).toHaveBeenCalled();
  });

  it("comes straight out of the cache afterwards, network or no network", async () => {
    // The point of keeping them: the bar drops off the network regularly, and
    // a grid whose photographs vanish when it gets busy is worse than one that
    // never had any.
    stored.set(picture, response({ cached: true }));

    const answered = await fetchEvent(picture);

    expect(answered).toMatchObject({ cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not kept when the server would not serve it", async () => {
    fetchMock.mockResolvedValue(response({ ok: false, status: 404 }));

    await fetchEvent(picture);

    expect(cachePut).not.toHaveBeenCalled();
  });

  it("fails honestly when it is neither cached nor reachable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    const answered = await fetchEvent(picture);

    expect((answered as unknown as Response).type).toBe("error");
  });

  it("leaves the rest of /media/ alone", async () => {
    // Everything outside pub/ belongs to somebody — an invoice, a file an
    // attendee uploaded — and has no business in a shared tablet's cache.
    const answered = await fetchEvent(`${ORIGIN}/media/invoices/demo-00001.pdf`);

    expect(answered).toBeNull();
    expect(cachePut).not.toHaveBeenCalled();
  });
});
