const CACHE_NAME = "prb005-brainplay-v6";
const SHELL_URLS = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache dynamic multiplayer API routes
  if (url.pathname.startsWith("/api/")) return;

  // Dynamic pack catalog: network-first with cache fallback so new packs/dates appear immediately
  if (url.pathname === "/packs/catalog.json") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || new Response("Offline", { status: 503 }))
        )
    );
    return;
  }

  // Immutable content shards (/packs/*/*.json) & static daily manifests: cache-first with network fallback
  if (url.pathname.startsWith("/packs/") || url.pathname.startsWith("/data/") || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() =>
            new Response(JSON.stringify({ error: "Offline" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
          );
      })
    );
    return;
  }

  // SPA navigation / root shell: network-first with cached shell fallback for offline Solo play
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/").then((r) => r || new Response("Offline", { status: 503 })))
    );
  }
});
