/* ═══════════════════════════════════════════════════════════════
   MSO DIGITAL OPERATIONS — PWA Core
   Shared across all pages · Load this on every page
   
   Provides:
   · Service Worker registration + lifecycle management
   · IndexedDB wrapper (offline data queue)
   · Offline/online detection + UI feedback
   · Background sync registration
   · Install prompt management
   · Push notification subscription
   · SW message bus
   · Network quality detection
═══════════════════════════════════════════════════════════════ */

const MSO = (() => {

  /* ── Config ── */
  const SW_URL   = '/sw.js';
  const DB_NAME  = 'mso_portal_db';
  const DB_VER   = 1;
  const DB_STORES = [
    'pending_sales', 'pending_dips', 'pending_expenses',
    'pending_cashup', 'pending_discharge',
    'dashboard_cache', 'prefs',
  ];

  /* ── State ── */
  let _sw         = null;   /* ServiceWorkerRegistration  */
  let _db         = null;   /* IDBDatabase                */
  let _online     = navigator.onLine;
  let _installEvt = null;   /* BeforeInstallPromptEvent   */
  let _listeners  = {};     /* Event bus                  */

  /* ────────────────────────────────────────────────────────────
     EVENT BUS
  ──────────────────────────────────────────────────────────── */
  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }
  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(f => f !== fn);
  }
  function emit(event, data) {
    (_listeners[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error('[MSO]', e); }
    });
  }

  /* ────────────────────────────────────────────────────────────
     SERVICE WORKER
  ──────────────────────────────────────────────────────────── */
  async function initSW() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[MSO] Service workers not supported');
      return null;
    }

    try {
      _sw = await navigator.serviceWorker.register(SW_URL, {
        scope: '/',
        updateViaCache: 'none', /* Always check for SW updates */
      });

      console.log('[MSO] SW registered:', _sw.scope);

      /* Listen for updates */
      _sw.addEventListener('updatefound', () => {
        const newWorker = _sw.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            /* New version available — notify UI */
            emit('update_available', { registration: _sw });
            _showUpdateBanner();
          }
        });
      });

      /* Listen for messages from SW */
      navigator.serviceWorker.addEventListener('message', event => {
        const { type, ...data } = event.data || {};
        emit(type, data);

        if (type === 'SYNC_COMPLETE') {
          _showSyncToast(data.store);
        }
        if (type === 'SW_ACTIVATED') {
          console.log('[MSO] New SW active:', data.version);
        }
      });

      /* Ensure page is controlled */
      if (!navigator.serviceWorker.controller) {
        await navigator.serviceWorker.ready;
      }

      return _sw;
    } catch (err) {
      console.error('[MSO] SW registration failed:', err);
      return null;
    }
  }

  /* Tell SW to skip waiting and activate immediately */
  function applyUpdate() {
    const waiting = _sw?.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      window.location.reload();
    }
  }

  /* ────────────────────────────────────────────────────────────
     INDEXEDDB — Promise-based wrapper
  ──────────────────────────────────────────────────────────── */
  function openDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);

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

      req.onsuccess = e => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  /* db.put(storeName, data) → Promise<id> */
  async function dbPut(storeName, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put({
        ...data,
        _queued_at: new Date().toISOString(),
        _retries: 0,
      });
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* db.get(storeName, id) → Promise<object|null> */
  async function dbGet(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = e => resolve(e.target.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* db.getAll(storeName) → Promise<array> */
  async function dbGetAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* db.delete(storeName, id) → Promise<void> */
  async function dbDelete(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* db.clear(storeName) → Promise<void> */
  async function dbClear(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* db.count(storeName) → Promise<number> */
  async function dbCount(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* ────────────────────────────────────────────────────────────
     OFFLINE QUEUE — queue submissions when offline
  ──────────────────────────────────────────────────────────── */

  /*
   * submitWithQueue(storeName, syncTag, url, data)
   * 
   * · If online  → POST directly to Apps Script API
   * · If offline → Save to IndexedDB, register background sync
   *               → UI shows "Queued — will sync when online"
   */
  async function submitWithQueue(storeName, syncTag, url, data) {
    if (_online) {
      /* Direct submission */
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(10000),
        });
        const json = await res.json();
        return { submitted: true, queued: false, response: json };
      } catch (err) {
        /* Network failed mid-request — queue it */
        console.warn('[MSO] Submission failed, queuing:', err);
        await _queueItem(storeName, syncTag, url, data);
        return { submitted: false, queued: true };
      }
    } else {
      /* Offline — queue immediately */
      await _queueItem(storeName, syncTag, url, data);
      return { submitted: false, queued: true };
    }
  }

  async function _queueItem(storeName, syncTag, url, data) {
    const id = await dbPut(storeName, { url, data });
    console.log(`[MSO] Queued item ${id} in ${storeName}`);

    /* Register background sync */
    if (_sw && 'sync' in ServiceWorkerRegistration.prototype) {
      await _sw.sync.register(syncTag);
      console.log('[MSO] Background sync registered:', syncTag);
    }

    /* Update pending count badge */
    _updatePendingBadge();

    emit('item_queued', { storeName, syncTag, id });
  }

  /* Check and display pending items count */
  async function _updatePendingBadge() {
    const stores = [
      'pending_sales', 'pending_dips', 'pending_expenses',
      'pending_cashup', 'pending_discharge',
    ];
    let total = 0;
    for (const s of stores) {
      total += await dbCount(s);
    }

    /* Update any badge elements on the page */
    document.querySelectorAll('[data-pending-count]').forEach(el => {
      el.textContent = total;
      el.style.display = total > 0 ? 'flex' : 'none';
    });

    /* Update app badge (Android/desktop) */
    if ('setAppBadge' in navigator) {
      total > 0
        ? navigator.setAppBadge(total).catch(() => {})
        : navigator.clearAppBadge().catch(() => {});
    }

    return total;
  }

  /* ────────────────────────────────────────────────────────────
     NETWORK STATUS
  ──────────────────────────────────────────────────────────── */
  function initNetworkMonitor() {
    function handleOnline() {
      _online = true;
      emit('online');
      _showNetworkToast('online');
      _updatePendingBadge();
      /* Trigger sync for all pending stores */
      _registerAllSyncs();
    }

    function handleOffline() {
      _online = false;
      emit('offline');
      _showNetworkToast('offline');
    }

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    /* Network quality via Navigator API */
    if ('connection' in navigator) {
      navigator.connection.addEventListener('change', () => {
        emit('network_change', {
          effectiveType: navigator.connection.effectiveType,
          downlink:      navigator.connection.downlink,
          rtt:           navigator.connection.rtt,
          saveData:      navigator.connection.saveData,
        });
      });
    }
  }

  async function _registerAllSyncs() {
    if (!_sw) return;
    const tags = [
      'mso-sync-sales', 'mso-sync-dips', 'mso-sync-expenses',
      'mso-sync-cashup', 'mso-sync-discharge',
    ];
    for (const tag of tags) {
      try {
        await _sw.sync.register(tag);
      } catch { /* sync not supported */ }
    }
  }

  /* ────────────────────────────────────────────────────────────
     INSTALL PROMPT
  ──────────────────────────────────────────────────────────── */
  function initInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _installEvt = e;
      emit('install_available');
    });

    window.addEventListener('appinstalled', () => {
      _installEvt = null;
      emit('installed');
      /* Track install */
      console.log('[MSO] App installed to home screen');
    });
  }

  async function promptInstall() {
    if (!_installEvt) return { outcome: 'unavailable' };
    const result = await _installEvt.prompt();
    _installEvt = null;
    emit('install_result', result);
    return result;
  }

  function canInstall() {
    return !!_installEvt;
  }

  /* ────────────────────────────────────────────────────────────
     PUSH NOTIFICATIONS
  ──────────────────────────────────────────────────────────── */
  async function requestPushPermission() {
    if (!('Notification' in window)) {
      return { granted: false, reason: 'not_supported' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { granted: false, reason: permission };
    }

    /* Subscribe to push */
    const subscription = await _subscribeToPush();
    return { granted: true, subscription };
  }

  async function _subscribeToPush() {
    if (!_sw) return null;
    try {
      const sub = await _sw.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlB64ToUint8Array(
          /* VAPID public key — replace with your key */
          'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
        ),
      });
      console.log('[MSO] Push subscription created');
      return sub;
    } catch (err) {
      console.warn('[MSO] Push subscription failed:', err);
      return null;
    }
  }

  function _urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  /* ────────────────────────────────────────────────────────────
     UI HELPERS — toast, banners, badges
  ──────────────────────────────────────────────────────────── */
  function _showNetworkToast(status) {
    const existing = document.getElementById('mso-network-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'mso-network-toast';
    toast.style.cssText = `
      position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;
      transform:translateX(-50%) translateY(20px);
      background:${status === 'online' ? '#16A34A' : '#DC2626'};
      color:#fff;font-family:'Inter',sans-serif;font-size:13px;font-weight:700;
      padding:10px 20px;border-radius:99px;
      box-shadow:0 4px 16px rgba(0,0,0,.25);
      z-index:9999;opacity:0;
      transition:all .28s cubic-bezier(.22,1,.36,1);
      display:flex;align-items:center;gap:8px;
      white-space:nowrap;
    `;
    toast.innerHTML = status === 'online'
      ? `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Back online — syncing data…`
      : `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55"/><path d="M5 12.55a10.94 10.94 0 015.17-2.39"/><path d="M10.71 5.05A16 16 0 0122.56 9"/><path d="M1.42 9a15.91 15.91 0 014.7-2.88"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg> No connection — entries will be saved`;

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, status === 'online' ? 3500 : 5000);
  }

  function _showSyncToast(storeName) {
    const names = {
      pending_sales:    'Sales record',
      pending_dips:     'Tank dip',
      pending_expenses: 'Expense',
      pending_cashup:   'Cash reconciliation',
      pending_discharge:'Discharge record',
    };
    _showToast(
      `✓ ${names[storeName] || 'Record'} synced to Google Sheets`,
      '#16A34A'
    );
  }

  function _showToast(message, bg = '#130656') {
    const existing = document.getElementById('mso-sw-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'mso-sw-toast';
    toast.style.cssText = `
      position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));
      right:16px;background:${bg};color:#fff;
      font-family:'Inter',sans-serif;font-size:13px;font-weight:600;
      padding:11px 18px;border-radius:12px;
      box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:9999;
      opacity:0;transform:translateY(12px);
      transition:all .26s cubic-bezier(.22,1,.36,1);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function _showUpdateBanner() {
    const existing = document.getElementById('mso-update-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.id = 'mso-update-banner';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9998;
      background:#130656;color:#fff;
      font-family:'Inter',sans-serif;font-size:13px;font-weight:600;
      padding:12px 20px;display:flex;align-items:center;justify-content:space-between;
      box-shadow:0 2px 8px rgba(0,0,0,.3);
    `;
    banner.innerHTML = `
      <span>🔄 A new version of MSO Portal is available</span>
      <button onclick="MSO.applyUpdate()" style="
        background:#179DD0;color:#fff;border:none;border-radius:7px;
        padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;
        font-family:'Inter',sans-serif;
      ">Update Now</button>
    `;
    document.body.prepend(banner);
  }

  /* ────────────────────────────────────────────────────────────
     OFFLINE INDICATOR — inject into page if not present
  ──────────────────────────────────────────────────────────── */
  function injectOfflineIndicator() {
    if (document.getElementById('mso-offline-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'mso-offline-bar';
    bar.style.cssText = `
      display:none;position:fixed;top:0;left:0;right:0;z-index:9997;
      background:#DC2626;color:#fff;
      font-family:'Inter',sans-serif;font-size:12.5px;font-weight:700;
      padding:9px 20px;text-align:center;
      box-shadow:0 2px 8px rgba(0,0,0,.2);
    `;
    bar.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:6px">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0119 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 015.17-2.39"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg>
      You're offline — entries are being saved locally and will sync when reconnected
    `;
    document.body.prepend(bar);

    on('offline', () => { bar.style.display = 'block'; });
    on('online',  () => { bar.style.display = 'none';  });

    if (!_online) bar.style.display = 'block';
  }

  /* ────────────────────────────────────────────────────────────
     INIT — call on every page
  ──────────────────────────────────────────────────────────── */
  async function init(options = {}) {
    const {
      registerSW  = true,
      monitorNetwork = true,
      installPrompt  = true,
      offlineBar     = true,
    } = options;

    if (registerSW)     await initSW();
    if (monitorNetwork) initNetworkMonitor();
    if (installPrompt)  initInstallPrompt();
    if (offlineBar)     injectOfflineIndicator();

    /* Preload next likely page */
    _prefetchNextPages();

    console.log('[MSO] PWA Core initialized');
    return { sw: _sw, online: _online };
  }

  /* Prefetch pages the user is likely to visit next */
  function _prefetchNextPages() {
    const prefetchMap = {
      '/index.html':  ['/login.html'],
      '/login.html':  ['/select.html', '/dashboard-mso.html', '/dashboard-mrs.html'],
      '/select.html': ['/dashboard-mso.html', '/dashboard-mrs.html'],
    };

    const path  = window.location.pathname;
    const pages = prefetchMap[path] || [];

    pages.forEach(url => {
      const link = document.createElement('link');
      link.rel  = 'prefetch';
      link.href = url;
      link.as   = 'document';
      document.head.appendChild(link);
    });
  }

  /* ── Public API ── */
  return {
    init,
    on, off, emit,
    applyUpdate,

    /* SW */
    getSW: () => _sw,

    /* Network */
    isOnline: () => _online,

    /* DB */
    db: {
      put:    dbPut,
      get:    dbGet,
      getAll: dbGetAll,
      delete: dbDelete,
      clear:  dbClear,
      count:  dbCount,
    },

    /* Offline queue */
    submitWithQueue,
    updatePendingBadge: _updatePendingBadge,

    /* Install */
    canInstall,
    promptInstall,

    /* Push */
    requestPushPermission,

    /* UI */
    showToast: _showToast,
    showNetworkToast: _showNetworkToast,
  };

})();

/* Auto-init when DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => MSO.init());
} else {
  MSO.init();
}
