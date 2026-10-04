/**
 * OmniBox service worker.
 *
 * The rule that matters: it only touches same-origin GETs. Everything else —
 * API calls to providers, downloads you start with fetch(), POST requests —
 * goes straight to the network untouched. A stale cached API response would be
 * a correctness bug, so it is never allowed to happen.
 */

const VERSION = 'omnibox-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app/ui/app.js',
  './app/core/util.js',
  './app/core/xml.js',
  './app/core/zip.js',
  './app/core/image.js',
  './app/core/pdf.js',
  './app/core/pdfread.js',
  './app/core/docx.js',
  './app/core/xlsx.js',
  './app/core/markdown.js',
  './app/core/convert.js',
  './app/core/ytdlp.js',
  './app/core/keys.js',
  './tools/fetch.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // add() one by one so a single missing file cannot abort the whole install
    await Promise.all(SHELL.map((path) => cache.add(path).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // provider APIs and downloads: never touch

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(VERSION);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone());
      return fresh;
    } catch {
      return hit || Response.error();
    }
  })());
});
