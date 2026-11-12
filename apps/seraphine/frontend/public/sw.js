// Seraphine Service Worker — app shell caching, data caching, background sync

// v4: purges agent-harness responses that v3 cached by mistake (see the skip list in the fetch handler).
const CACHE_NAME = 'seraphine-v4';
const DATA_CACHE = 'seraphine-data-v3';

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

// ── IndexedDB asset cache (big binaries like VRM avatars) ──
// Cache API has a per-origin quota that smaller VRMs can share, but
// 70MB+ VRoid exports don't fit reliably. IDB's quota is per-origin and
// much larger (hundreds of MB on Safari PWAs, GBs on desktop).

const ASSET_DB = 'seraphine-assets';
const ASSET_STORE = 'blobs';

function openAssetDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ASSET_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ASSET_STORE)) {
        req.result.createObjectStore(ASSET_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedAsset(url) {
  try {
    const db = await openAssetDB();
    const tx = db.transaction(ASSET_STORE, 'readonly');
    return await new Promise((resolve) => {
      const req = tx.objectStore(ASSET_STORE).get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putCachedAsset(url, blob, contentType) {
  try {
    const db = await openAssetDB();
    const tx = db.transaction(ASSET_STORE, 'readwrite');
    tx.objectStore(ASSET_STORE).put({
      url,
      blob,
      contentType,
      cachedAt: Date.now(),
    });
    return await new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

function assetResponseFromEntry(entry) {
  return new Response(entry.blob, {
    status: 200,
    headers: {
      'Content-Type': entry.contentType || 'model/gltf-binary',
      'Content-Length': String(entry.blob.size),
      'X-Seraphine-IDBCached': '1',
    },
  });
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

// ── Push notifications ──

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Seraphine', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'seraphine',
    renotify: true,
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Abrir' },
      { action: 'dismiss', title: 'Dispensar' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Seraphine', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

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

  // 3. VRM avatars — cache-first via IndexedDB (Cache API quota can't
  //    fit 70MB+ VRoid exports, IDB handles it).
  if (
    event.request.method === 'GET' &&
    url.pathname.startsWith('/avatars/') &&
    url.pathname.endsWith('.vrm')
  ) {
    event.respondWith(
      (async () => {
        const cached = await getCachedAsset(event.request.url);
        if (cached) {
          return assetResponseFromEntry(cached);
        }
        const response = await fetch(event.request);
        if (!response.ok) return response;
        // Tee so the browser gets the streaming response AND we can store it.
        const cloned = response.clone();
        // Fire-and-forget cache write so we don't block the first load.
        cloned.blob().then((blob) => {
          void putCachedAsset(
            event.request.url,
            blob,
            response.headers.get('Content-Type') || 'model/gltf-binary',
          );
        }).catch(() => { /* quota exceeded — live without the cache */ });
        return response;
      })(),
    );
    return;
  }

  // 4. Skip WebSocket, API calls, non-GET.
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/finance') ||
    url.pathname.startsWith('/google') ||
    url.pathname.startsWith('/whatsapp') ||
    url.pathname.startsWith('/memory') ||
    url.pathname.startsWith('/health') ||
    url.pathname.startsWith('/push') ||
    url.pathname.startsWith('/tasks') ||
    // Agent harness: live, authenticated data. Falling through to the
    // stale-while-revalidate branch below answered every read with the
    // PREVIOUS response (a decided approval came back as pending) and
    // stored the request, token header included, in Cache Storage.
    url.pathname.startsWith('/agents') ||
    url.pathname.startsWith('/avatars/')
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
