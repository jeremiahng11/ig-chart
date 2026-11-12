/* IG Charts service worker: web push notifications + network-first app shell cache (offline installable PWA). */
const CACHE = 'igc-shell-v4';
const SHELL = ['/', '/index.html', '/style.css', '/vendor/lightweight-charts.js', '/core.js', '/aichance.js', '/indicators.js', '/charttypes.js',
  '/drawings.js', '/chartview.js', '/strategy.js', '/paper.js', '/panels.js', '/mt5.js', '/app.js', '/push.js', '/manifest.webmanifest',
  '/pine.js', '/script-worker.js', '/trade.js', '/trade.css', '/notes.js', '/hotlists.js', '/pine-render.js', '/stmn.js',
  '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Only same-origin static GETs are cached; /api and /ws always go to the network.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : undefined))
    .then((hit) => hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const data = { url: '/', ...(d.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || 'IG Charts', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, data, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const same = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (same) {
      same.postMessage({ type: 'notification-click', data: e.notification.data || {} });
      return same.focus();
    }
    return self.clients.openWindow(target);
  }));
});
