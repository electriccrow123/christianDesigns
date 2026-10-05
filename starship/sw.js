// Service worker: makes Starhome installable and lets it start without a connection
// after the first visit. Network first, so updates always show up when online.
const CACHE = 'starhome-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // cache our own files and the three.js / controller-model CDN files
  if (url.origin !== location.origin && url.hostname !== 'cdn.jsdelivr.net') return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
