// Chizu service worker: makes the site installable. Pages and data always come from the network (so updates show at once);
// only a small offline page is cached, shown when there is no connection.
const OFFLINE = '/offline.html', CACHE = 'chizu-offline-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE, '/assets/icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;   // everything except page loads goes straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
