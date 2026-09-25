/*
 * The service worker.
 *
 * Deliberately small. A job board is a read-mostly site whose content changes
 * daily, so caching pages aggressively would show people closed listings; what
 * is cached is the shell (stylesheet, icon) and an offline fallback, and every
 * document goes to the network first.
 *
 * VERSION is a hash of the shell assets, not a number someone remembers to
 * raise. It was a number, and the first CSS fix that shipped after this file
 * was written did not raise it, so every returning reader kept the broken
 * stylesheet forever. `pnpm test` recomputes the hash and fails when it has
 * drifted, which is the only version of this rule that survives contact.
 */

const VERSION = 'bf43bdc7';
const SHELL = `shell-${VERSION}`;
const ASSETS = ['/assets/app.css', '/assets/tokens.css', '/assets/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // `cache: 'reload'` because addAll goes through the HTTP cache by
      // default, and these assets are served with max-age=3600. Without it the
      // worker faithfully caches whatever stale copy the HTTP cache is still
      // holding, under a fresh cache name, and the result is a cache that
      // looks correct and serves the old file for an hour. That is exactly
      // what happened to the mobile fix.
      .then((cache) => cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache anything under /api or /me: one is live data, the other is a
  // signed-in person's own pages.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/me') || url.pathname.startsWith('/tracker') || url.pathname.startsWith('/fleets/') || url.pathname.startsWith('/notifications')) return;

  if (ASSETS.includes(url.pathname)) {
    // Answer from the cache, then refresh it in the background. A stale asset
    // therefore survives one render rather than until the next VERSION bump,
    // which matters because the bump is the step that gets missed.
    event.respondWith(
      caches.open(SHELL).then((cache) =>
        cache.match(request).then((hit) => {
          // Same reason as install: revalidating through the HTTP cache can
          // refresh the entry with the copy it already had.
          const fresh = fetch(new Request(request.url, { cache: 'reload' }))
            .then((response) => {
              if (response.ok) void cache.put(request, response.clone());
              return response;
            })
            .catch(() => hit);
          if (hit) {
            event.waitUntil(fresh);
            return hit;
          }
          return fresh;
        }),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(request).then(
        (hit) =>
          hit ||
          new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font:16px system-ui;padding:2rem"><h1>Offline</h1><p>This board is not reachable right now.</p>',
            { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
          ),
      ),
    ),
  );
});

/*
 * Push. The payload is JSON the board encrypted to this browser's key:
 * { title, body, url }. Clicking the notification opens the listing, in a
 * tab the site already has if there is one.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'New listing', body: '', url: '/notifications' };
  try {
    payload = Object.assign(payload, event.data ? event.data.json() : {});
  } catch (_) {
    /* A payload that is not JSON still deserves a notification. */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/assets/icon.svg',
      badge: '/assets/icon.svg',
      data: { url: payload.url },
      tag: payload.url,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/notifications', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
