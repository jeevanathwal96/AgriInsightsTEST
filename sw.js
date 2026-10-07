/* AgriInsights — PWA service worker
 * Strategy:
 *   - HTML / navigation  -> network-first, revalidated (304 when nothing changed); after 3 s without an
 *                           answer the cached copy is served and the late answer refreshes the cache;
 *                           cached fallback offline (-490, B9 D4)
 *   - Supabase / cross-origin -> network-only, NEVER cached (data + auth must be live)
 *   - same-origin static -> stale-while-revalidate (instant load, refreshed in background)
 *   - old caches purged on activate (keyed by APP_VERSION)
 *
 * DEPLOY: bump APP_VERSION on every release so clients drop the old cache and
 * pick up new shell assets. Paths are relative to the SW scope, so this works
 * unchanged on both the TEST (/AgriInsightsTEST/) and LIVE (/AgriInsights/) repos.
 */
'use strict';

var APP_VERSION = '2026-10-07-490';
var BUILD = 'e7c6efe9f7';   /* dist build (build-dist.mjs): the hashed scripts below */
var CACHE = 'agriinsights-' + APP_VERSION + '-' + BUILD;

/* App shell precached on install. The ?v=-suffixed JS is intentionally left to
 * runtime caching so the existing ?v= cache-busting keeps working untouched. */
var PRECACHE = [
  './',
  './app.c435eeb8eb7b.js',
  './kpi-detail.782a21000ef0.js',
  './index.html',
  './manifest.webmanifest',
  './fonts.css',
  './vendor/chart.umd.js',
  './vendor/supabase.js',
  './vendor/jspdf.umd.min.js?v=218',
  './img/hero-farmland.webp?v=490',
  './img/logomark.png?v=225',
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

/* Build an HTML request that always asks the origin. GitHub Pages serves index.html with
   cache-control: max-age=600, so a plain fetch() inside a network-first handler can still be
   answered from cache and a fresh deploy goes unseen for ten minutes. cache:'no-cache' always
   revalidates - and when nothing has changed the origin answers 304 with no body, so a return visit
   no longer downloads the whole 1.85 MB page (-490, B9 item 1: cache:'reload' sent no If-None-Match;
   the slow-line warm load spent 9.8 s on it). Falls back to the original request if the Request
   constructor rejects the option (a navigate request cannot be rebuilt with options). */
function _freshHTML(req){
  try { return new Request(req, {cache: 'no-cache'}); }
  catch (e) {
    try { return new Request(req.url, {cache: 'no-cache', credentials: 'same-origin'}); }
    catch (e2) { return req; }
  }
}
/* -490 (D4): a stalled rural line must not hold the farmer on a blank page. After HTML_WAIT_MS the copy
   this device already has is shown; the network answer, when it comes, still refreshes the cache, and if
   it is a newer page every open window is told so (the page shows "New version ready · Reload"). */
var HTML_WAIT_MS = 3000;
function _cachedShell(){ return caches.match('./index.html').then(function (m) { return m || caches.match('./'); }); }
function _verOf(res){ try { return res.headers.get('etag') || res.headers.get('last-modified') || ''; } catch (e) { return ''; } }
function _tellNewer(){
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    cs.forEach(function (c) { try { c.postMessage({ type: 'ai-sw-newer', v: APP_VERSION }); } catch (e) {} });
  });
}

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
    var net = fetch(_freshHTML(req));
    /* The answer refreshes the cache whenever it comes, even after the cached copy was shown. */
    var fill = net.then(function (res) {
      if (!res || !res.ok) return res;
      var copy = res.clone();
      return caches.open(CACHE).then(function (c) { return c.put('./index.html', copy); }).then(function () { return res; }, function () { return res; });
    });
    var shown = null;                                   // the cached copy, when that is what the page got
    /* Kept alive until the answer is in the cache - and, if the page was given the older copy, until it is told. */
    e.waitUntil(fill.then(function (res) {
      if (shown && res && res.ok && _verOf(res) !== _verOf(shown)) return _tellNewer();
    }).catch(function () {}));
    e.respondWith(new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        _cachedShell().then(function (m) {
          if (done || !m) return;                       // nothing cached yet: keep waiting for the network
          done = true; shown = m; resolve(m);
        });
      }, HTML_WAIT_MS);
      net.then(function (res) {                          // after fill's clone (registered first): the page never waits for the cache write
        if (done) return; done = true; clearTimeout(timer); resolve(res);
      }, function () {
        if (done) return; clearTimeout(timer);
        _cachedShell().then(function (m) { if (done) return; done = true; resolve(m || Response.error()); });
      });
    }));
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
