// Seraphine Service Worker — app shell caching for PWA

const CACHE_NAME = 'seraphine-v1';

// App shell files to cache on install
const APP_SHELL = [
  '/',
  '/icon-192.png',
  '/icon-512.png',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API/WS, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip WebSocket, API calls, and non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/finance') ||
    url.pathname.startsWith('/google') ||
    url.pathname.startsWith('/whatsapp') ||
    url.pathname.startsWith('/memory') ||
    url.pathname.startsWith('/health')
  ) {
    return;
  }

  // For navigation requests (HTML), try network first, fallback to cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});
