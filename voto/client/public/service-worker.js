
const CACHE_NAME = 'classvote-shell-v5';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter((key) => key.startsWith('classvote-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Nunca armazenar dados da API.
  const apiPaths = [
    '/login',
    '/users',
    '/candidates',
    '/votes',
    '/courses',
    '/blockchain',
    '/my-participation',
    '/results',
    '/election-status',
    '/health',
    '/turmas',
    '/api'
  ];

  if (
    apiPaths.some(
      (path) => url.pathname === path || url.pathname.startsWith(path + '/')
    )
  ) {
    return;
  }

  // Navegação: rede primeiro, cache como alternativa offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/index.html', response.clone());
          }

          return response;
        } catch {
          return (
            (await caches.match('/index.html')) ||
            (await caches.match('/'))
          );
        }
      })()
    );

    return;
  }

  // Recursos estáticos: cache primeiro.
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/')
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch {
          return new Response('Recurso indisponível offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
  }
});
