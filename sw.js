// App-shell caching only. Anything going to Firebase (or any non-GET
// request) is deliberately left alone -- messages must always hit the
// network live, never be served from cache.
const CACHE_NAME = "flip-relay-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) {
    return; // let Firebase / non-GET requests pass straight through
  }
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
