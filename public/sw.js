/**
 * Sérgio Simulator - Service Worker para PWA Offline
 * Permite que o app funcione completamente offline em salas de ensaio e estantes sem sinal.
 */

const CACHE_NAME = 'sergio-simulator-v1';

// Recursos essenciais para pré-cache imediato
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// 1. Instalação: Pré-carrega o esqueleto do aplicativo
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Falha ao pré-carregar alguns itens no cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Ativação: Limpa versões antigas do cache e assume o controle das páginas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Interceptação de Requisições (Fetch)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignora chamadas externas do Firebase / Firestore / WebSockets
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('firestore') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Requisição de Navegação (ex: carregar a página principal '/')
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // Se a rede falhar (está offline), serve a versão em cache
          const cached = await caches.match(event.request);
          if (cached) return cached;
          return caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }

  // Recursos estáticos (JS, CSS, Fontes, Imagens): Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => null);

      // Retorna do cache se existir, ou espera a rede se ainda não estiver em cache
      return cachedResponse || fetchPromise;
    })
  );
});
