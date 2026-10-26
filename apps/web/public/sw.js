// Service worker shell. No caching or offline logic in v1 (DECISION-04); this only
// makes the station app installable. The offline WP adds fetch handling here.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
