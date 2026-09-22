/*
 * Service worker for the Open POS shell.
 *
 * It caches the shell and the bundle, and nothing else. That is a smaller job
 * than it sounds, and deliberately so: the till survives a dropout through its
 * own queue and the catalogue it holds in localStorage, not through this. What
 * this adds is that the app still *starts* with no network — a tablet whose
 * battery ran out mid-evening, a tab reloaded by mistake — instead of coming
 * back as a blank screen.
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
 */
const CACHE = "openpos-shell-v2";
const PICTURES = "openpos-pictures-v1";

self.addEventListener("install", (event) => {
  // A new build should take over the next time the app is opened, not three
  // sessions later.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const keep = [CACHE, PICTURES];
      await Promise.all(
        names.filter((name) => !keep.includes(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
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

  // Navigations: try the network so a new build is picked up, fall back to the
  // cached shell so a dropout does not produce a blank screen.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Only ever keep a shell worth falling back to. A 502 caught during a
          // server restart is exactly the moment this worker runs, and storing
          // it would hand that same error page to the till every cold start
          // afterwards. Redirected responses are refused for navigations by
          // Chrome when replayed from a cache, so they are not kept either.
          if (response.ok && !response.redirected) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(request);
          return cached ?? Response.error();
        }
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
