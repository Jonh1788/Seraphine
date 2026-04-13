// Seraphine Service Worker — app shell caching, data caching, background sync

const CACHE_NAME = 'seraphine-v1';
const DATA_CACHE = 'seraphine-data-v1';

// App shell files to cache on install
const APP_SHELL = [
  '/',
  '/icon-192.png',
  '/icon-512.png',
];

// GET endpoints eligible for network-first with cache fallback
const CACHEABLE_DATA_PATTERNS = [
  /^\/finance\/summary/,
  /^\/finance\/entries/,
  /^\/finance\/recurring/,
  /^\/google\/.*events/,
];

// Write endpoints eligible for offline queueing
const QUEUEABLE_WRITE_PREFIXES = ['/finance/', '/whatsapp/'];

// ── IndexedDB helpers for offline action queue ──

const DB_NAME = 'seraphine-offline';
const STORE_NAME = 'pending-actions';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueAction(action) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).add(action);
  return new Promise((resolve) => { tx.oncomplete = resolve; });
}

async function replayPendingActions() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const actions = await new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
  });

  for (const action of actions) {
    try {
      const resp = await fetch(action.url, {
        method: action.method,
        headers: action.headers,
        body: action.body,
      });
      if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
        // Remove on success OR client error (4xx won't resolve on retry)
        const delTx = db.transaction(STORE_NAME, 'readwrite');
        delTx.objectStore(STORE_NAME).delete(action.id);
      }
      // 5xx: leave in queue for retry
    } catch {
      // Network error — stop replaying, will retry on next sync
      break;
    }
  }
}

// ── Lifecycle events ──

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean old caches (keep current app shell + data cache)
self.addEventListener('activate', (event) => {
  const KEEP = new Set([CACHE_NAME, DATA_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Background sync ──

self.addEventListener('sync', (event) => {
  if (event.tag === 'pending-actions') {
    event.waitUntil(replayPendingActions());
  }
});

// ── Fetch handler ──

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 0. Share target — intercept POST from OS share sheet and redirect to GET
  if (event.request.method === 'POST' && url.searchParams.get('share') === 'true') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const title = formData.get('title') || '';
          const text = formData.get('text') || '';
          const shareUrl = formData.get('url') || '';
          const redirect = new URL('/', url.origin);
          redirect.searchParams.set('share', 'true');
          if (title) redirect.searchParams.set('title', title);
          if (text) redirect.searchParams.set('text', text);
          if (shareUrl) redirect.searchParams.set('url', shareUrl);
          return Response.redirect(redirect.toString(), 303);
        } catch {
          return Response.redirect('/?share=true', 303);
        }
      })()
    );
    return;
  }

  // 1. Data caching — network-first with cache fallback for cacheable GET endpoints
  if (event.request.method === 'GET' && CACHEABLE_DATA_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            if (cached) {
              const headers = new Headers(cached.headers);
              headers.set('X-Seraphine-Cached', 'true');
              return new Response(cached.body, { status: cached.status, headers });
            }
            return new Response(JSON.stringify({ error: 'offline', cached: false }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          });
        })
    );
    return;
  }

  // 2. Offline action queue — queue write requests to known endpoints when offline
  if (
    event.request.method !== 'GET' &&
    QUEUEABLE_WRITE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    event.respondWith(
      fetch(event.request.clone()).catch(async () => {
        const body = await event.request.text();
        await queueAction({
          url: event.request.url,
          method: event.request.method,
          headers: Object.fromEntries(event.request.headers),
          body,
          timestamp: Date.now(),
        });
        if ('sync' in self.registration) {
          await self.registration.sync.register('pending-actions');
        }
        return new Response(JSON.stringify({ ok: true, queued: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // 3. Skip WebSocket, remaining API calls, and non-GET requests
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

  // 4. Navigation requests — network first, fallback to cached shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // 5. Static assets — stale-while-revalidate
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
