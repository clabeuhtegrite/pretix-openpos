/*
 * Service worker for the Open POS shell.
 *
 * The till is online-only by design, so this worker exists for one reason: to
 * make the app open instantly and survive a brief wifi dropout on the way to the
 * login screen. It never caches anything under /api/, because a cached
 * catalogue would show stale prices and a cached sale would be a disaster.
 */
const CACHE = "openpos-shell-v1";

self.addEventListener("install", (event) => {
  // A new build should take over the next time the app is opened, not three
  // sessions later.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
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

  // Navigations: try the network so a new build is picked up, fall back to the
  // cached shell so a dropout does not produce a blank screen.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
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
