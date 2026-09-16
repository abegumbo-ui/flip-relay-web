// Offline caching was causing more harm than good -- it kept serving
// outdated copies of the page after every update. This version replaces
// it: it wipes any cache a previous install left behind and unregisters
// itself, so the page just loads fresh from the network like a normal site.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
  );
});
