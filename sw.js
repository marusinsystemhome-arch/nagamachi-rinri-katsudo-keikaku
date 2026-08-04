const CACHE = "nagamachi-rinri-keikaku-v2";
const CORE = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything: this app's data comes live from the Drive
// API, so a stale cached response is worse than a network error. Caching
// here exists only so a transient network blip (e.g. mid-gesture on
// mobile) falls back to something recent instead of an error page — every
// successful fetch refreshes the cache entry, so the fallback never drifts
// far behind. (Previously the cache was only ever populated once, at
// install time, so a device that installed this service worker long ago
// could fall back all the way to a years-old snapshot of the app.)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        var copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
