/*
 * The service worker.
 *
 * Deliberately small. A job board is a read-mostly site whose content changes
 * daily, so caching pages aggressively would show people closed listings; what
 * is cached is the shell (stylesheet, icon) and an offline fallback, and every
 * document goes to the network first.
 *
 * Bump VERSION on any change here or to the assets listed below. Without a
 * bump, a returning reader keeps the old worker and never sees the change.
 */

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const ASSETS = ['/assets/app.css', '/assets/tokens.css', '/assets/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/me')) return;

  if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request)),
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
