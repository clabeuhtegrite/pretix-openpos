/*
 * Service worker for the Open POS shell.
 *
 * It caches the shell and the bundle, and nothing else. That is a smaller job
 * than it sounds, and deliberately so: the till survives a dropout through its
 * own queue and the catalogue it holds in localStorage, not through this. What
 * this adds is that the app still *starts* with no network — a tablet whose
 * battery ran out mid-evening, a tab reloaded by mistake, a server restarting —
 * instead of coming back as a blank screen or an error page.
 *
 * It never caches anything under /api/. A cached catalogue would show stale
 * prices, and a cached sale would be a disaster.
 *
 * Product pictures are the one exception, and they get their own cache. They
 * are not the shell, they are large, and their names carry a uuid, so they
 * never go stale and they must not be thrown away every time the app is
 * rebuilt. Only /media/pub/ is touched, which is where pretix puts the files
 * it serves to anyone; everything else under /media/ belongs to somebody and
 * has no business sitting in a shared tablet's cache.
 *
 * The one rule about the shell: the copy kept here is only ever replaced by a
 * complete one. A new shell is kept once every file it names is in the cache
 * too, and never before — a shell whose bundle is missing is a blank screen
 * the first time the till has to start offline.
 */
const CACHE = "openpos-shell-v2";
const PICTURES = "openpos-pictures-v1";

/**
 * How long opening the till waits for the server before it opens on the copy
 * kept here instead.
 *
 * The page is a few kilobytes of HTML: on a working network it is there in a
 * fraction of this. What the wait is for is the network that is not working —
 * wifi up and the uplink gone, a server restarting, a proxy holding the request
 * open — where the browser's own timeout runs to a minute or more, and a till
 * reopened during an outage used to sit on a white screen for all of it, then
 * show the browser's error page instead of selling offline.
 */
const NAVIGATION_TIMEOUT_MS = 4000;

/**
 * Where the bundle lives, and the only part of the cache ever pruned.
 *
 * The bundle is one script and one stylesheet (vite.config.ts), both named by
 * the shell, their names hashed by pretix' static storage. Anything under here
 * the current shell does not name is an older build's, and would otherwise sit
 * in the cache for good, one copy per release.
 */
const BUNDLE_PATH = "/static/pretix_openpos/pwa/";

/** The message the page sends to have a new build brought in (update.ts). */
const PREPARE_UPDATE = "openpos:prepare-update";

/** The shell's own URL, which is this worker's scope: the one page it keeps. */
function shellUrl() {
  return self.registration.scope;
}

/**
 * A response worth keeping as the shell.
 *
 * A 502 caught during a server restart is exactly the moment this worker runs,
 * and storing it would hand that same error page to the till every cold start
 * afterwards. Redirected responses are refused for navigations by Chrome when
 * replayed from a cache, so they are not kept either.
 */
function keepable(response) {
  return response.ok && !response.redirected;
}

/** The static files a shell names — its bundle and its icons — as absolute URLs. */
function filesOf(html) {
  const found = new Set();
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1].replace(/&amp;/g, "&"), shellUrl());
    if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
      found.add(url.href);
    }
  }
  return [...found];
}

/**
 * A file the till cannot start without: its script and its stylesheet. An icon
 * that will not load costs an icon, and must not keep a new build out.
 */
function essential(file) {
  return /\.(?:js|css)$/.test(new URL(file).pathname);
}

/**
 * Keep a shell, once everything it needs is kept too.
 *
 * `fresh` fetches every file again, past the browser's HTTP cache, for an
 * update: a build whose files keep their names from one release to the next
 * (a server without hashed static names) would otherwise be put together from
 * the new page and the old bundle. Otherwise only what is missing is fetched,
 * which for hashed names is exactly what changed.
 *
 * Throws, keeping nothing, when any file cannot be had: the shell already kept
 * then stays the one the till opens on.
 */
async function keepShell(response, fresh) {
  const html = await response.clone().text();
  const files = filesOf(html);
  // A page that loads no bundle is not the till, whatever its status says — a
  // maintenance page answered with a 200, a login wall in front of pretix.
  // Kept as the shell, it would also have every file of the real one pruned.
  if (!files.some((file) => new URL(file).pathname.startsWith(BUNDLE_PATH) && essential(file))) {
    throw new Error("not the till's page");
  }
  const cache = await caches.open(CACHE);
  await Promise.all(
    files.map(async (file) => {
      if (!fresh && (await cache.match(file))) return;
      try {
        const got = await fetch(file, fresh ? { cache: "reload" } : undefined);
        if (!got.ok) throw new Error(`${file} answered ${got.status}`);
        await cache.put(file, got);
      } catch (error) {
        if (essential(file)) throw error;
      }
    }),
  );
  await cache.put(shellUrl(), response);
  const wanted = new Set(files);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(BUNDLE_PATH) && !wanted.has(url.href)) {
      await cache.delete(request);
    }
  }
}

/** The shell kept here, whatever query string the app was opened with. */
async function keptShell() {
  const cache = await caches.open(CACHE);
  return cache.match(shellUrl(), { ignoreSearch: true });
}

self.addEventListener("install", (event) => {
  // A new build should take over the next time the app is opened, not three
  // sessions later.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // A worker that renames its cache must not cost the till the shell it
      // would open on offline: whatever an older shell cache holds is carried
      // over before that cache goes, unless this one already has a shell.
      const cache = await caches.open(CACHE);
      if (!(await cache.match(shellUrl(), { ignoreSearch: true }))) {
        for (const name of names.filter((n) => n.startsWith("openpos-shell-") && n !== CACHE)) {
          const old = await caches.open(name);
          for (const request of await old.keys()) {
            const response = await old.match(request);
            if (response) await cache.put(request, response);
          }
        }
      }
      const keep = [CACHE, PICTURES];
      await Promise.all(
        names.filter((name) => !keep.includes(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Bring a new build in before the page reloads onto it (update.ts).
 *
 * Says "preparing" at once, so the page can tell a worker that knows this
 * message from an older one that does not, then "ready" once the new shell and
 * every file it names are kept, or "failed" having changed nothing.
 */
self.addEventListener("message", (event) => {
  if (event.data?.type !== PREPARE_UPDATE) return;
  const port = event.ports?.[0];
  if (!port) return;
  port.postMessage({ state: "preparing" });
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch(shellUrl(), { cache: "no-store" });
        if (!keepable(response)) throw new Error(`shell answered ${response.status}`);
        await keepShell(response, true);
        port.postMessage({ state: "ready" });
      } catch {
        port.postMessage({ state: "failed" });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Anything that talks to pretix goes straight to the network, always.
  if (url.pathname.startsWith("/api/")) return;

  // A product picture: kept the first time it is seen and served from there
  // afterwards, never refreshed. The bar loses the network regularly, and a
  // grid whose photographs disappear exactly when the evening gets busy is
  // worse than a grid that never had any.
  if (url.pathname.startsWith("/media/pub/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PICTURES);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put(request, response.clone());
          return response;
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }

  // Opening the till. Only the shell itself: the manifest opened in a tab is a
  // navigation too, and must not be kept as the page the till opens on.
  if (request.mode === "navigate") {
    if (url.pathname !== new URL(shellUrl()).pathname) return;

    // The network first, so a new build is picked up. Copied as soon as it
    // answers, before the browser starts reading it, so it can be kept
    // whenever it arrives — including after the till has already opened on
    // the kept copy.
    const network = fetch(request).then(
      (response) => ({ response, copy: keepable(response) ? response.clone() : null }),
      () => null,
    );
    event.waitUntil(
      network.then((got) => (got?.copy ? keepShell(got.copy, false) : undefined)).catch(() => {
        // A file the new shell names could not be had: the shell kept before
        // stays the one the till opens on.
      }),
    );
    event.respondWith(
      (async () => {
        const kept = await keptShell();
        // Nothing to fall back on — the first launch, or one after the cache
        // was cleared: whatever the network says, error page included, is all
        // there is.
        if (!kept) return (await network)?.response ?? Response.error();
        // Otherwise the network gets a few seconds, and a fault is no answer:
        // a 5xx is a proxy standing in for a server that is restarting, and
        // the copy kept here still sells, offline, from its own queue.
        let timer;
        const got = await Promise.race([
          network,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        return got && got.response.status < 500 ? got.response : kept;
      })(),
    );
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background.
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => null);
        return cached ?? (await network) ?? Response.error();
      })(),
    );
  }
});
