/* ═══════════════════════════════════════════════════════════════
   MSO DIGITAL OPERATIONS — Service Worker
   Production-grade · Google PWA Engineer Standard
   
   Strategy per route:
   ├── App shell (HTML/CSS/JS)     → Cache-first  (instant load)
   ├── CDN assets (Bootstrap etc)  → Cache-first  (long-lived)
   ├── Google Fonts                → Stale-while-revalidate
   ├── Images (Unsplash)          → Cache-first  (background update)
   ├── Apps Script API             → Network-first (live data)
   └── Offline fallback            → IndexedDB queue + fallback page
═══════════════════════════════════════════════════════════════ */

const VERSION     = 'v1.0.0';
const SHELL_CACHE = `mso-shell-${VERSION}`;
const ASSET_CACHE = `mso-assets-${VERSION}`;
const IMAGE_CACHE = `mso-images-${VERSION}`;
const DATA_CACHE  = `mso-data-${VERSION}`;
const ALL_CACHES  = [SHELL_CACHE, ASSET_CACHE, IMAGE_CACHE, DATA_CACHE];

/* ── App shell — precached on install ── */
const SHELL_URLS = [
  '/index.html',
  '/login.html',
  '/select.html',
  '/dashboard-mso.html',
  '/dashboard-mrs.html',
  '/offline.html',
  '/manifest.json',
  '/js/pwa-core.js',
  '/icons/icon.png',
];

/* ── CDN assets — precached ── */
const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js',
];

/* ─────────────────────────────────────────────────────────────
   INSTALL — precache the app shell
───────────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      /* Cache shell URLs */
      const shellCache = await caches.open(SHELL_CACHE);
      await shellCache.addAll(SHELL_URLS).catch(err => {
        console.warn('[SW] Shell cache partial failure:', err);
      });

      /* Cache CDN assets — fail silently if offline during install */
      const assetCache = await caches.open(ASSET_CACHE);
      await Promise.allSettled(
        CDN_ASSETS.map(url => assetCache.add(url))
      );

      /* Take control immediately */
      await self.skipWaiting();
      console.log(`[SW] ${VERSION} installed`);
    })()
  );
});

/* ─────────────────────────────────────────────────────────────
   ACTIVATE — clean old caches, claim all clients
───────────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      /* Remove caches from old versions */
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => !ALL_CACHES.includes(key))
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );

      /* Claim all open clients without reload */
      await self.clients.claim();
      console.log(`[SW] ${VERSION} active — controlling all clients`);

      /* Notify clients that a new version is active */
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.postMessage({
        type: 'SW_ACTIVATED',
        version: VERSION,
      }));
    })()
  );
});

/* ─────────────────────────────────────────────────────────────
   FETCH — route-based caching strategy
───────────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Only handle GET (non-GET goes straight to network) */
  if (request.method !== 'GET') return;

  /* ── 1. Apps Script API → Network-first with offline queue ── */
  if (url.hostname === 'script.google.com') {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  /* ── 2. Google Fonts → Stale-while-revalidate ── */
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  /* ── 3. CDN (Bootstrap, Alpine, BI) → Cache-first ── */
  if (
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'cdnjs.cloudflare.com'
  ) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  /* ── 4. Images (Unsplash, etc) → Cache-first, lazy update ── */
  if (
    request.destination === 'image' ||
    url.hostname === 'images.unsplash.com'
  ) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  /* ── 5. App shell HTML pages → Stale-while-revalidate ── */
  if (request.destination === 'document') {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  /* ── 6. All other same-origin assets → Cache-first ── */
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
});

/* ─────────────────────────────────────────────────────────────
   CACHE STRATEGY HELPERS
───────────────────────────────────────────────────────────── */

/* Cache-first: serve from cache, fall back to network */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match('/offline.html');
  }
}

/* Stale-while-revalidate: serve cache immediately, update in bg */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  /* Fire network request regardless */
  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  /* Return cached immediately if available, otherwise await network */
  return cached || networkFetch || caches.match('/offline.html');
}

/* Network-first: try network, fall back to cache, then offline page */
async function networkFirstWithFallback(request) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const response = await fetch(request, {
      signal: AbortSignal.timeout(8000), /* 8s timeout */
    });
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    /* Network failed — return cached API response if available */
    const cached = await cache.match(request);
    if (cached) return cached;

    /* Return offline JSON for API calls */
    return new Response(
      JSON.stringify({ ok: false, offline: true, error: 'No network connection' }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'X-MSO-Offline': 'true',
        },
      }
    );
  }
}

/* ─────────────────────────────────────────────────────────────
   BACKGROUND SYNC — flush queued offline submissions
───────────────────────────────────────────────────────────── */
self.addEventListener('sync', event => {
  console.log('[SW] Background sync fired:', event.tag);

  const syncMap = {
    'mso-sync-sales':    () => flushQueue('pending_sales'),
    'mso-sync-dips':     () => flushQueue('pending_dips'),
    'mso-sync-expenses': () => flushQueue('pending_expenses'),
    'mso-sync-cashup':   () => flushQueue('pending_cashup'),
    'mso-sync-discharge':() => flushQueue('pending_discharge'),
  };

  if (syncMap[event.tag]) {
    event.waitUntil(syncMap[event.tag]());
  }
});

async function flushQueue(storeName) {
  const db    = await openDB();
  const items = await dbGetAll(db, storeName);

  console.log(`[SW] Flushing ${items.length} items from ${storeName}`);

  for (const item of items) {
    try {
      const response = await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.data),
      });

      if (response.ok) {
        /* Successfully synced — remove from queue */
        await dbDelete(db, storeName, item.id);

        /* Notify open clients */
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(client => client.postMessage({
          type: 'SYNC_COMPLETE',
          store: storeName,
          id: item.id,
        }));

        console.log(`[SW] Synced item ${item.id} from ${storeName}`);
      }
    } catch (err) {
      console.warn(`[SW] Sync failed for item ${item.id}:`, err);
      /* Will retry on next sync event */
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   PUSH NOTIFICATIONS
───────────────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};

  const configs = {
    tank_critical: {
      title: '⚠️ Tank Level Critical',
      body:  data.message || 'A tank is below 10% — discharge required.',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag:   'tank-critical',
      requireInteraction: true,
      actions: [
        { action: 'view',    title: 'View Dashboard' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    },
    approval_pending: {
      title: '📋 Approval Required',
      body:  data.message || 'An edit request is waiting for your approval.',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag:   'approval',
      actions: [
        { action: 'approve', title: 'View Request' },
        { action: 'dismiss', title: 'Later' },
      ],
    },
    shift_reminder: {
      title: '🕐 Shift Log Reminder',
      body:  data.message || 'Time to record your shift handover.',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag:   'shift',
    },
    discharge_overdue: {
      title: '🚛 Discharge Overdue',
      body:  data.message || 'A fuel delivery is overdue — please update records.',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag:   'discharge',
      requireInteraction: true,
    },
  };

  const cfg = configs[data.type] || {
    title: data.title || 'MSO Portal',
    body:  data.body  || data.message || 'New notification',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    tag:   'general',
  };

  event.waitUntil(
    self.registration.showNotification(cfg.title, {
      body:               cfg.body,
      icon:               cfg.icon,
      badge:              cfg.badge,
      tag:                cfg.tag,
      requireInteraction: cfg.requireInteraction || false,
      actions:            cfg.actions || [],
      data:               { url: data.url || '/dashboard-mso.html', ...data },
      vibrate:            [200, 100, 200],
    })
  );
});

/* Notification click handler */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const data   = event.notification.data || {};
  const url    = data.url || '/dashboard-mso.html';

  if (action === 'dismiss') return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        /* Focus existing window if open */
        const existing = clients.find(c => c.url.includes(self.location.origin));
        if (existing) {
          existing.focus();
          existing.postMessage({ type: 'NOTIFICATION_CLICK', action, data });
          return;
        }
        /* Otherwise open new window */
        return self.clients.openWindow(url);
      })
  );
});

/* ─────────────────────────────────────────────────────────────
   MESSAGE HANDLER — commands from page scripts
───────────────────────────────────────────────────────────── */
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.source.postMessage({ type: 'VERSION', version: VERSION });
      break;

    case 'CACHE_URLS':
      /* Dynamically cache additional URLs sent from page */
      caches.open(SHELL_CACHE).then(cache => {
        cache.addAll(payload?.urls || []).catch(() => {});
      });
      break;

    case 'CLEAR_DATA_CACHE':
      caches.delete(DATA_CACHE).then(() => {
        event.source.postMessage({ type: 'DATA_CACHE_CLEARED' });
      });
      break;
  }
});

/* ─────────────────────────────────────────────────────────────
   INDEXEDDB HELPERS (used inside SW for background sync)
───────────────────────────────────────────────────────────── */
const DB_NAME    = 'mso_portal_db';
const DB_VERSION = 1;
const DB_STORES  = [
  'pending_sales',
  'pending_dips',
  'pending_expenses',
  'pending_cashup',
  'pending_discharge',
  'dashboard_cache',
  'prefs',
];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      DB_STORES.forEach(name => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
      });
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDelete(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}
