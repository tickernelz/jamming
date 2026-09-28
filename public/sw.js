// sw.js - Jamri Service Worker for Offline PWA Capabilities

const CACHE_NAME = 'jamri-shell-v11';
const SHELL_ASSETS = [
    './css/main.css',
    './css/components.css',
    './js/jamri-format.js',
    './js/fingerprint.js',
    './js/websocket.js',
    './js/player.js',
    './js/chat.js',
    './js/search.js',
    './js/soundboard.js',
    './js/voice-ptt.js',
    './js/games.js',
    './js/lyrics.js',
    './js/world.js',
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

    // Only handle same-origin GET requests. Bypass API, WebSocket and the
    // dynamic HTML shell entirely so the app never serves a stale index.php.
    if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }
    if (url.pathname.includes('/api/') || url.port === '8080' || url.pathname.endsWith('.php') || url.pathname.endsWith('/')) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(e.request).catch(() => {
                return new Response('', { status: 504, statusText: 'Offline' });
            });
        })
    );
});
