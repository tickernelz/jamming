// sw.js - Jamri Service Worker for Offline PWA Capabilities

const CACHE_NAME = 'jamri-shell-v6';
const SHELL_ASSETS = [
    '../index.php',
    './css/main.css',
    './css/components.css',
    './js/jamri-format.js',
    './js/fingerprint.js',
    './js/websocket.js',
    './js/player.js',
    './js/chat.js',
    './js/search.js',
    './js/app.js',
    './manifest.json',
    './icon-192.svg',
    './icon-512.svg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            for (const asset of SHELL_ASSETS) {
                try {
                    await cache.add(asset);
                } catch (err) {
                    console.warn('[SW] Skipped caching non-critical asset:', asset);
                }
            }
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Bypass API and WebSocket from cache
    if (url.pathname.includes('/api/') || url.port === '8080') {
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(e.request).catch(() => {
                // Offline fallback if navigation
                if (e.request.mode === 'navigate') {
                    return caches.match('./index.php');
                }
            });
        })
    );
});
