const CACHE_NAME = 'plus500-v2';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for API calls
  if (e.request.url.includes('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first for shell
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

self.addEventListener('push', e => {
  if (!e.data) return;

  const data = e.data.json();
  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
    tag: data.type || 'alert',
    renotify: true,
    requireInteraction: data.type === 'REVERSAL',
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Otworz' },
      { action: 'dismiss', title: 'Zamknij' },
    ],
  };

  e.waitUntil(
    self.registration.showNotification(data.title || '+500 Alert', options)
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing window if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      return clients.openWindow(url);
    })
  );
});
