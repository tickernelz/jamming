// sw.js - Jamri Service Worker for Offline PWA Capabilities

const CACHE_NAME = 'jamri-shell-v12';
const SHELL_ASSETS = [
    './css/main.css',
    './css/components.css',
    './css/world.css',
    './js/jamri-format.js',
    './js/identity.js',
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

    // Only handle same-origin GET requests. API, WebSocket and dynamic PHP are
    // always passed straight through to the network.
    if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }
    if (url.pathname.includes('/api/') || url.port === '8080' || url.port === '8081'
        || url.pathname.endsWith('.php') || url.pathname.endsWith('/')) {
        return;
    }

    // NETWORK-FIRST: always try to fetch the latest asset so code/CSS updates
    // are picked up on a normal reload. Fall back to cache only when offline.
    // (The previous cache-first strategy kept serving stale JS/CSS after
    // updates, which caused confusing "nothing changed" bugs.)
    e.respondWith(
        fetch(e.request)
            .then((response) => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(() => caches.match(e.request).then((cached) => cached || Response.error()))
    );
});
