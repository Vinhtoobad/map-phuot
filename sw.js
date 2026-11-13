// Service worker: cache app shell kiểu network-first.
// Ko cache tile và API ở giai đoạn 1. NHỚ tăng tên cache khi sửa file.
const CACHE = 'map-phuot-v6';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'lib/maplibre-gl.mjs',
  'lib/maplibre-gl-worker.mjs',
  'lib/maplibre-gl.css',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Chỉ xử lý file của chính app; tile, Nominatim, OSRM đi thẳng ra mạng
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      // ignoreSearch vì MapLibre nạp worker kèm ?v=...
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
