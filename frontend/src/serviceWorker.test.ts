import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREPARE_UPDATE } from "./update";

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
 * blank screen, and a till reopened while the server restarts as a till rather
 * than as an error page. It must never keep anything it should not: a cached
 * catalogue would quote stale prices, a cached sale would be a disaster, and a
 * 502 stored during a server restart would be handed to the till on every cold
 * start afterwards. And the copy it keeps must only ever be replaced by a
 * complete one — a shell whose bundle is missing is a blank screen offline.
 */

// Resolved from the vitest root (frontend/) rather than from import.meta.url,
// which is not a file: URL once the module has been through vite.
const SOURCE = readFileSync(
  resolve(process.cwd(), "../pretix_openpos/static/pretix_openpos/sw.js"),
  "utf8",
);

const ORIGIN = "https://pretix.example";
const SHELL = `${ORIGIN}/openpos/`;
const SCRIPT = `${ORIGIN}/static/pretix_openpos/pwa/app.2b1f.js`;
const STYLE = `${ORIGIN}/static/pretix_openpos/pwa/app.2b1f.css`;
const ICON = `${ORIGIN}/static/pretix_openpos/icons/icon-192.2b1f.png`;
const OLD_SCRIPT = `${ORIGIN}/static/pretix_openpos/pwa/app.0a0a.js`;

/** The shell as pretix renders it: root-relative paths to the files it names. */
function page(files: string[] = [SCRIPT, STYLE, ICON]): string {
  const path = (url: string) => new URL(url).pathname;
  const tags = files.map((file) =>
    file.endsWith(".js")
      ? `<script type="module" src="${path(file)}"></script>`
      : file.endsWith(".css")
        ? `<link rel="stylesheet" href="${path(file)}">`
        : `<link rel="icon" type="image/png" href="${path(file)}">`,
  );
  return `<!doctype html><html><head><link rel="manifest" href="/openpos/manifest.webmanifest">${tags.join("")}</head><body><div id="root"></div></body></html>`;
}

interface FakeResponse {
  ok: boolean;
  redirected: boolean;
  status: number;
  /** Which response this is, for a test to tell them apart. */
  tag?: string;
  text: () => Promise<string>;
  clone: () => FakeResponse;
}

/** A response, in as much detail as the worker actually looks at. */
function response(overrides: Partial<FakeResponse> = {}, body = ""): FakeResponse {
  const make = (): FakeResponse => ({
    ok: true,
    redirected: false,
    status: 200,
    ...overrides,
    text: async () => body,
    clone: () => make(),
  });
  return make();
}

/** What the server answers, per URL; anything not listed is a 200. */
let routes: Map<string, () => Promise<FakeResponse>>;
let fetchMock: ReturnType<typeof vi.fn>;
/** Every cache, by name, holding responses by URL. */
let stores: Map<string, Map<string, FakeResponse>>;
let deleted: string[];
let skipWaiting: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let listeners: Record<string, (event: unknown) => void>;
/** What the worker asked to be kept alive for, so a test can wait on it. */
let pending: Promise<unknown>[];

function urlOf(key: string | { url: string }): string {
  return typeof key === "string" ? key : key.url;
}

function store(name: string): Map<string, FakeResponse> {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
}

function openCache(name: string) {
  const entries = store(name);
  return {
    match: async (key: string | { url: string }, options?: { ignoreSearch?: boolean }) => {
      const url = urlOf(key);
      if (entries.has(url)) return entries.get(url);
      if (!options?.ignoreSearch) return undefined;
      const bare = url.split("?")[0];
      for (const [kept, value] of entries) {
        if (kept.split("?")[0] === bare) return value;
      }
      return undefined;
    },
    put: async (key: string | { url: string }, value: FakeResponse) => {
      entries.set(urlOf(key), value);
    },
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    delete: async (key: string | { url: string }) => entries.delete(urlOf(key)),
  };
}

function load() {
  listeners = {};
  const caches = {
    open: vi.fn(async (name: string) => openCache(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      return stores.delete(name);
    }),
  };
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
    skipWaiting,
    clients: { claim },
    location: { origin: ORIGIN },
    registration: { scope: SHELL },
  };
  // The worker refers to `self` and to a bare `caches`; both are given here.
  new Function("self", "caches", "fetch", "Response", "URL", SOURCE)(
    scope, caches, fetchMock, Response, URL,
  );
}

/** Fire a fetch event at the worker and hand back what it answered, if anything. */
async function fetchEvent(url: string, { method = "GET", mode = "no-cors" } = {}) {
  let answered: Promise<unknown> | null = null;
  listeners.fetch({
    request: { url, method, mode },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    respondWith: (promise: Promise<unknown>) => {
      answered = promise;
    },
  });
  return answered === null ? null : ((await answered) as FakeResponse);
}

/** Open the till, the way the browser does. */
function navigate(url = SHELL) {
  return fetchEvent(url, { mode: "navigate" });
}

/** Wait for whatever the worker went on doing after answering. */
async function settle() {
  while (pending.length) await Promise.all(pending.splice(0));
}

/** A shell and its files, as a previous visit left them. */
function keptBuild(files: string[] = [OLD_SCRIPT]) {
  const cache = store("openpos-shell-v2");
  cache.set(SHELL, response({ tag: "kept" }, page(files)));
  for (const file of files) cache.set(file, response({ tag: "kept" }));
}

beforeEach(() => {
  routes = new Map();
  fetchMock = vi.fn(async (request: string | { url: string }) => {
    const route = routes.get(urlOf(request));
    if (route) return route();
    return urlOf(request) === SHELL ? response({ tag: "network" }, page()) : response({ tag: "network" });
  });
  stores = new Map();
  deleted = [];
  pending = [];
  skipWaiting = vi.fn();
  claim = vi.fn();
  load();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("taking over", () => {
  /** Run one of the worker's lifecycle events to the end. */
  async function lifecycle(type: "install" | "activate") {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
  }

  it("does not wait three sessions to become the new build", async () => {
    await lifecycle("install");

    expect(skipWaiting).toHaveBeenCalled();
  });

  it("throws away every cache but its own on activation", async () => {
    // A shell from an older build, served to a till that has been upgraded, is
    // an update no reload can ever apply.
    keptBuild();
    store("openpos-shell-v1").set(SHELL, response());
    store("openpos-pictures-v1");
    store("something-else");

    await lifecycle("activate");

    // The pictures are not the shell and survive a rebuild: they are large,
    // their names carry a uuid, and a bar that has just been upgraded is a bar
    // about to lose its network.
    expect(deleted.sort()).toEqual(["openpos-shell-v1", "something-else"]);
    expect(claim).toHaveBeenCalled();
    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("kept");
  });

  it("carries the shell over from an older cache before throwing that one away", async () => {
    // A worker that renames its cache must not leave the till with no shell to
    // open on offline until the next time it happens to have a network.
    store("openpos-shell-v1").set(SHELL, response({ tag: "older" }, page([OLD_SCRIPT])));
    store("openpos-shell-v1").set(OLD_SCRIPT, response({ tag: "older" }));

    await lifecycle("activate");

    expect(deleted).toEqual(["openpos-shell-v1"]);
    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("older");
    expect(store("openpos-shell-v2").get(OLD_SCRIPT)?.tag).toBe("older");
  });
});

describe("what it keeps out of its hands", () => {
  it("never touches a request to pretix' API", async () => {
    // A cached catalogue quotes stale prices; a cached sale is a disaster.
    const answered = await fetchEvent(`${ORIGIN}/api/v1/organizers/demo/events/f/openpos/catalog/`);

    expect(answered).toBeNull();
    expect(stores.size).toBe(0);
  });

  it("never touches a checkout, which is a POST anyway", async () => {
    const answered = await fetchEvent(SHELL, { method: "POST", mode: "navigate" });

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

  it("does not take the manifest, opened in a tab, for the page the till opens on", async () => {
    const answered = await navigate(`${ORIGIN}/openpos/manifest.webmanifest`);

    expect(answered).toBeNull();
    expect(stores.size).toBe(0);
  });
});

describe("opening the till", () => {
  it("goes to the network first, so a new build is picked up", async () => {
    keptBuild();

    const answered = await navigate();

    expect(fetchMock).toHaveBeenCalled();
    expect(answered?.tag).toBe("network");
  });

  it("keeps the shell it was served, with every file it names", async () => {
    await navigate();
    await settle();

    const kept = store("openpos-shell-v2");
    expect(kept.get(SHELL)?.tag).toBe("network");
    expect(kept.has(SCRIPT)).toBe(true);
    expect(kept.has(STYLE)).toBe(true);
    expect(kept.has(ICON)).toBe(true);
  });

  it("keeps a new shell only once its bundle is kept too", async () => {
    // Kept first and its files after, a dropout in between left a shell the
    // till could open offline onto a blank screen.
    keptBuild();
    routes.set(SCRIPT, async () => response({ ok: false, status: 404 }));

    await navigate();
    await settle();

    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("kept");
    expect(store("openpos-shell-v2").has(OLD_SCRIPT)).toBe(true);
  });

  it("does not let an icon that will not load keep a new build out", async () => {
    routes.set(ICON, async () => {
      throw new TypeError("Failed to fetch");
    });

    await navigate();
    await settle();

    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("network");
  });

  it("only fetches the files it does not already have", async () => {
    store("openpos-shell-v2").set(SCRIPT, response({ tag: "kept" }));

    await navigate();
    await settle();

    expect(fetchMock).not.toHaveBeenCalledWith(SCRIPT, undefined);
    expect(store("openpos-shell-v2").get(SCRIPT)?.tag).toBe("kept");
  });

  it("throws away the bundle of the build it replaces, and nothing else", async () => {
    keptBuild([OLD_SCRIPT, ICON]);
    store("openpos-shell-v2").set(`${ORIGIN}/static/pretix_openpos/icons/old.png`, response());

    await navigate();
    await settle();

    const kept = store("openpos-shell-v2");
    expect(kept.has(OLD_SCRIPT)).toBe(false);
    expect(kept.has(SCRIPT)).toBe(true);
    // Only the bundle's directory is pruned: nothing else of the shell's is
    // one copy per release.
    expect(kept.has(`${ORIGIN}/static/pretix_openpos/icons/old.png`)).toBe(true);
  });

  it("refuses to keep a page that loads no bundle", async () => {
    // A maintenance page answered with a 200, a login wall in front of pretix:
    // kept as the shell, it would also have had the real bundle pruned.
    keptBuild();
    routes.set(SHELL, async () => response({ tag: "maintenance" }, "<html>Back soon</html>"));

    await navigate();
    await settle();

    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("kept");
    expect(store("openpos-shell-v2").has(OLD_SCRIPT)).toBe(true);
  });

  it("refuses to keep an error page", async () => {
    // A 502 caught during a server restart is exactly when this worker runs,
    // and storing it would hand that same page to the till every cold start
    // from then on.
    routes.set(SHELL, async () => response({ ok: false, status: 502 }, page()));

    await navigate();
    await settle();

    expect(store("openpos-shell-v2").has(SHELL)).toBe(false);
  });

  it("refuses to keep a redirect", async () => {
    // Chrome refuses a redirected response replayed from a cache for a
    // navigation, so a stored one is a blank screen with extra steps.
    routes.set(SHELL, async () => response({ redirected: true }, page()));

    await navigate();
    await settle();

    expect(store("openpos-shell-v2").has(SHELL)).toBe(false);
  });

  it("with nothing kept, answers with the error page rather than swallowing it", async () => {
    routes.set(SHELL, async () => response({ ok: false, status: 502 }));

    const answered = await navigate();

    expect(answered).toMatchObject({ status: 502 });
  });

  it("opens on the shell it kept when the server answers with a fault", async () => {
    // A till reopened while pretix restarts used to show the proxy's error
    // page, with no way to sell until the server came back.
    keptBuild();
    routes.set(SHELL, async () => response({ ok: false, status: 503 }));

    const answered = await navigate();

    expect(answered?.tag).toBe("kept");
  });

  it("shows the server's own refusal, which a kept shell would only hide", async () => {
    keptBuild();
    routes.set(SHELL, async () => response({ ok: false, status: 404, tag: "refused" }));

    const answered = await navigate();

    expect(answered?.tag).toBe("refused");
  });

  it("falls back to the shell it kept when there is no network", async () => {
    // The whole reason this worker exists: a tablet whose battery ran out
    // mid-evening comes back as a till, not as a blank screen.
    keptBuild();
    routes.set(SHELL, async () => {
      throw new TypeError("Failed to fetch");
    });

    const answered = await navigate();

    expect(answered?.tag).toBe("kept");
  });

  it("finds the shell it kept whatever the app was opened with", async () => {
    keptBuild();
    routes.set(`${SHELL}?browser=1`, async () => {
      throw new TypeError("Failed to fetch");
    });

    const answered = await navigate(`${SHELL}?browser=1`);

    expect(answered?.tag).toBe("kept");
  });

  it("gives a network that hangs a few seconds, then opens on the shell it kept", async () => {
    // Wifi up and the uplink gone: the browser would wait a minute or more on
    // a white screen, then show its own error page.
    vi.useFakeTimers();
    keptBuild();
    routes.set(SHELL, () => new Promise(() => {}));

    const answered = navigate();
    await vi.advanceTimersByTimeAsync(4_000);

    expect((await answered)?.tag).toBe("kept");
  });

  it("still keeps a shell that arrives after the till opened on the old one", async () => {
    vi.useFakeTimers();
    keptBuild();
    let deliver: (value: FakeResponse) => void = () => {};
    routes.set(SHELL, () => new Promise((resolve) => (deliver = resolve)));

    const answered = navigate();
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await answered)?.tag).toBe("kept");
    deliver(response({ tag: "late" }, page()));
    await settle();

    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("late");
  });

  it("says so plainly when it has no shell to fall back to", async () => {
    routes.set(SHELL, async () => {
      throw new TypeError("Failed to fetch");
    });

    const answered = (await navigate()) as unknown as Response;

    expect(answered.type).toBe("error");
  });
});

describe("bringing a new build in before the page reloads onto it", () => {
  /** Send the page's message, and hand back what the worker said to it. */
  async function prepare(data: unknown = { type: PREPARE_UPDATE }) {
    const said: unknown[] = [];
    const port = { postMessage: (message: { state: string }) => said.push(message.state) };
    listeners.message({
      data,
      ports: [port],
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await settle();
    return said;
  }

  it("says at once that it has started, then that the build is in", async () => {
    keptBuild();

    expect(await prepare()).toEqual(["preparing", "ready"]);
    const kept = store("openpos-shell-v2");
    expect(kept.get(SHELL)?.tag).toBe("network");
    expect(kept.has(SCRIPT)).toBe(true);
    expect(kept.has(OLD_SCRIPT)).toBe(false);
  });

  it("fetches the page and every file again, past the browser's own cache", async () => {
    // A server whose static files keep their names from one release to the
    // next would otherwise put the new page together with the old bundle.
    keptBuild([SCRIPT, STYLE, ICON]);

    await prepare();

    expect(fetchMock).toHaveBeenCalledWith(SHELL, { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith(SCRIPT, { cache: "reload" });
    expect(fetchMock).toHaveBeenCalledWith(STYLE, { cache: "reload" });
    expect(store("openpos-shell-v2").get(SCRIPT)?.tag).toBe("network");
  });

  it("changes nothing when the page cannot be had", async () => {
    keptBuild();
    routes.set(SHELL, async () => response({ ok: false, status: 502 }));

    expect(await prepare()).toEqual(["preparing", "failed"]);
    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("kept");
  });

  it("changes nothing when its bundle cannot be had", async () => {
    keptBuild();
    routes.set(STYLE, async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await prepare()).toEqual(["preparing", "failed"]);
    expect(store("openpos-shell-v2").get(SHELL)?.tag).toBe("kept");
    expect(store("openpos-shell-v2").has(OLD_SCRIPT)).toBe(true);
  });

  it("answers nothing it was not asked", async () => {
    expect(await prepare({ type: "something else" })).toEqual([]);
    expect(await prepare(null)).toEqual([]);

    // Nor a message with nowhere to answer.
    listeners.message({ data: { type: PREPARE_UPDATE }, ports: [], waitUntil: () => {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the bundle and the icons", () => {
  it("comes out of the cache without waiting for the network", async () => {
    store("openpos-shell-v2").set(SCRIPT, response({ tag: "kept" }));

    const answered = await fetchEvent(SCRIPT);

    expect(answered?.tag).toBe("kept");
  });

  it("is refreshed in the background all the same", async () => {
    store("openpos-shell-v2").set(SCRIPT, response({ tag: "kept" }));

    await fetchEvent(SCRIPT);

    expect(fetchMock).toHaveBeenCalled();
  });

  it("is fetched and kept the first time it is asked for", async () => {
    const answered = await fetchEvent(SCRIPT);

    expect(answered).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(store("openpos-shell-v2").has(SCRIPT)).toBe(true));
  });

  it("is not kept when the server would not serve it", async () => {
    routes.set(SCRIPT, async () => response({ ok: false, status: 404 }));

    await fetchEvent(SCRIPT);

    expect(store("openpos-shell-v2").has(SCRIPT)).toBe(false);
  });

  it("fails honestly when it is neither cached nor reachable", async () => {
    routes.set(SCRIPT, async () => {
      throw new TypeError("Failed to fetch");
    });

    const answered = (await fetchEvent(SCRIPT)) as unknown as Response;

    expect(answered.type).toBe("error");
  });
});

describe("the product photographs", () => {
  const picture = `${ORIGIN}/media/pub/demo/f/item-10-abc.png`;

  it("is fetched and kept the first time it is asked for", async () => {
    await fetchEvent(picture);

    expect(fetchMock).toHaveBeenCalled();
    expect(store("openpos-pictures-v1").has(picture)).toBe(true);
  });

  it("comes straight out of the cache afterwards, network or no network", async () => {
    // The point of keeping them: the bar drops off the network regularly, and
    // a grid whose photographs vanish when it gets busy is worse than one that
    // never had any.
    store("openpos-pictures-v1").set(picture, response({ tag: "kept" }));

    const answered = await fetchEvent(picture);

    expect(answered?.tag).toBe("kept");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not kept when the server would not serve it", async () => {
    routes.set(picture, async () => response({ ok: false, status: 404 }));

    await fetchEvent(picture);

    expect(store("openpos-pictures-v1").has(picture)).toBe(false);
  });

  it("fails honestly when it is neither cached nor reachable", async () => {
    routes.set(picture, async () => {
      throw new Error("offline");
    });

    const answered = await fetchEvent(picture);

    expect((answered as unknown as Response).type).toBe("error");
  });

  it("leaves the rest of /media/ alone", async () => {
    // Everything outside pub/ belongs to somebody — an invoice, a file an
    // attendee uploaded — and has no business in a shared tablet's cache.
    const answered = await fetchEvent(`${ORIGIN}/media/invoices/demo-00001.pdf`);

    expect(answered).toBeNull();
    expect(stores.size).toBe(0);
  });
});
