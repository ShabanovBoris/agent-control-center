/* Service worker намеренно без сборки и без кешей: offline-режима нет. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Chrome считает PWA устанавливаемой, если service worker отвечает на навигацию.
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});

self.addEventListener('push', event => {
  let data = {};
  try {
    const parsed = event.data ? event.data.json() : {};
    data = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Agent Control Center';
  const body = typeof data.body === 'string' && data.body ? data.body : 'Новое событие';
  const url = typeof data.url === 'string' ? data.url : '/';
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        lang: 'ru',
        ...(typeof data.tag === 'string' ? { tag: data.tag } : {}),
        data: { url },
      });
    } catch {
      // Разрешение могли отозвать, пока уведомление было в пути.
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  let url;
  try {
    const target = new URL(typeof data.url === 'string' ? data.url : '/', self.location.origin);
    url = target.origin === self.location.origin ? target.href : new URL('/', self.location.origin).href;
  } catch {
    url = new URL('/', self.location.origin).href;
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOrigin = windows.filter(client => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    const client = sameOrigin.find(candidate => candidate.focused) || sameOrigin[0];
    if (!client) {
      await self.clients.openWindow(url);
      return;
    }
    await client.focus();
    if (client.url !== url) {
      try {
        await client.navigate(url);
      } catch {
        await self.clients.openWindow(url);
      }
    }
  })());
});
