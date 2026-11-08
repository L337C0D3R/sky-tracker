// Offline shell: cache static assets; network-first for live data (/api/*).
const CACHE = 'skytracker-v8';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'js/main.js', 'js/sky.js', 'js/orient.js', 'js/details.js', 'js/camctl.js',
  'vendor/astronomy.js', 'vendor/satellite.js',
  'data/stars.json', 'data/constellations.json', 'data/asteroids.json',
  'icon.svg', 'icon-192.png', 'apple-touch-icon.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first everywhere (fresh deploys + live data), cache as offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && !url.pathname.startsWith('/api/whereami')) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
