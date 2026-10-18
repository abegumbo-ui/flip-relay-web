// Service worker for the owner dashboard only (its own scope, separate from the Flip Relay web app).
// It keeps nothing: every load comes fresh from the network, so a new dashboard is never hidden behind an old copy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* straight to the network */ });
