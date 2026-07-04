/* AgriInsights — PWA service worker
 * Strategy:
 *   - HTML / navigation  -> network-first (fresh on every online reload; cached fallback offline)
 *   - Supabase / cross-origin -> network-only, NEVER cached (data + auth must be live)
 *   - same-origin static -> stale-while-revalidate (instant load, refreshed in background)
 *   - old caches purged on activate (keyed by APP_VERSION)
 *
 * DEPLOY: bump APP_VERSION on every release so clients drop the old cache and
 * pick up new shell assets. Paths are relative to the SW scope, so this works
 * unchanged on both the TEST (/AgriInsightsTEST/) and LIVE (/AgriInsights/) repos.
 */
'use strict';

var APP_VERSION = '2026-07-04-79';
var CACHE = 'agriinsights-' + APP_VERSION;

/* App shell precached on install. The ?v=-suffixed JS is intentionally left to
 * runtime caching so the existing ?v= cache-busting keeps working untouched. */
var PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './fonts.css',
  './vendor/chart.umd.js',
  './vendor/supabase.js',
  './Logo.png',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './fonts/plus-jakarta-sans-400.woff2',
  './fonts/plus-jakarta-sans-500.woff2',
  './fonts/plus-jakarta-sans-600.woff2',
  './fonts/plus-jakarta-sans-700.woff2',
  './fonts/plus-jakarta-sans-800.woff2'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Resilient precache: one missing asset must not abort the whole install.
      return Promise.allSettled(PRECACHE.map(function (u) { return c.add(u); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf('agriinsights-') === 0 && k !== CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;            // never intercept writes (POST/PATCH/DELETE)

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 1) Supabase API + any cross-origin request: do not touch — always live network.
  if (url.origin !== self.location.origin || url.hostname.indexOf('supabase') !== -1) {
    return;
  }

  var isHTML = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  // 2) HTML / navigation: network-first so a normal reload always gets the latest
  //    deploy when online; fall back to the cached shell when offline.
  if (isHTML) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (m) {
          return m || caches.match('./');
        });
      })
    );
    return;
  }

  // 3) Same-origin static (vendor, fonts, css, versioned JS, images):
  //    stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
