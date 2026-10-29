/* PDF Studio offline service worker. Generated at build time by the
   offlineServiceWorker Vite plugin, which fills in the version and asset list. */
const VERSION = '__VERSION__';
const PRECACHE_URLS = __PRECACHE__;
const PRECACHE = `pdf-studio-precache-${VERSION}`;
const RUNTIME = 'pdf-studio-runtime';
const APP_SHELL = '/index.html';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // Each asset is cached independently so one failed download (e.g. a large
      // model on a flaky connection) never blocks offline support for the rest.
      await Promise.all(
        ['/', APP_SHELL, ...PRECACHE_URLS].map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('pdf-studio-precache-') && name !== PRECACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(PRECACHE);
      await cache.put(APP_SHELL, copy);
    }
    return response;
  } catch {
    return (await caches.match(APP_SHELL)) || (await caches.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    const cache = await caches.open(RUNTIME);
    await cache.put(request, copy);
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        cache.put(request, copy);
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    if (request.mode === 'navigate') {
      event.respondWith(networkFirstNavigation(request));
      return;
    }
    // Unhashed stylesheets (e.g. the handwriting @font-face sheet) change in place, so a cache-first copy hides newly added faces.
    if (url.pathname.endsWith('.css') && !/[-.][A-Za-z0-9_]{8,}\.css$/.test(url.pathname)) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(async () => (await caches.match(request, { ignoreSearch: true })) || Response.error()),
      );
      return;
    }
    event.respondWith(cacheFirst(request));
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) event.respondWith(staleWhileRevalidate(request));
});
