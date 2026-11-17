/* AgriInsights — PWA service worker
 * Strategy:
 *   - HTML / navigation  -> network-first, revalidated (304 when nothing changed); after 3 s without an
 *                           answer the cached copy is served and the late answer refreshes the cache;
 *                           cached fallback offline (-490, B9 D4)
 *   - Supabase / cross-origin -> network-only, NEVER cached (data + auth must be live)
 *   - same-origin static -> stale-while-revalidate (instant load, refreshed in background)
 *   - old caches purged on activate (keyed by APP_VERSION)
 *
 *   - -497: only the app page ("./", "./index.html", any ?query) is the shell; every other page has its own cache entry
 * DEPLOY: bump APP_VERSION on every release so clients drop the old cache and
 * pick up new shell assets. Paths are relative to the SW scope, so this works
 * unchanged on both the TEST (/AgriInsightsTEST/) and LIVE (/AgriInsights/) repos.
 */
'use strict';

var APP_VERSION = '2026-11-16-515';
var BUILD = 'a7536173ce';   /* dist build (build-dist.mjs): the hashed scripts below */
var CACHE = 'agriinsights-' + APP_VERSION + '-' + BUILD;

/* App shell precached on install. The ?v=-suffixed JS is intentionally left to
 * runtime caching so the existing ?v= cache-busting keeps working untouched. */
var PRECACHE = [
  './',
  './app.8caf278d269f.js',
  './bg-grid.e975f666c214.js',
  './bmb.ee796db206e4.js',
  './kpi-detail.ea39f6dbbb74.js',
  './ob5-str.961abfe6bdbf.js',
  './ob5.9b4ef6025a91.js',
  './index.html',
  './manifest.webmanifest',
  './fonts.css',
  './vendor/chart.umd.js',
  './vendor/supabase.js',
  './vendor/jspdf.umd.min.js?v=218',
  './img/hero-farmland.webp?v=490',
  './img/logomark.png?v=225',
  './img/ob5/proof-sa.jpg',   /* -514 the welcome's proof picture */
  './img/ob5/proof-sa-af.jpg',   /* C6: in Afrikaans */
  './img/ob5/contours.svg',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './fonts/plus-jakarta-sans-400.woff2',
  './fonts/plus-jakarta-sans-500.woff2',
  './fonts/plus-jakarta-sans-600.woff2',
  './fonts/plus-jakarta-sans-700.woff2',
  './fonts/plus-jakarta-sans-800.woff2'
];

/* -513 modern emoji set: the bundled Noto pictures. Never in the install step (the first visit and the update never wait for
 * them): the page asks for them once it is idle after load ('ai-warm-emoji'), and each picture is also kept the first time it
 * is shown. Pictures are answered cache-first (a code point's picture never changes; the cache is per build). */
var EMOJI = [
  './img/emoji/1f0cf.svg',
  './img/emoji/1f1ea_1f1fa.svg',
  './img/emoji/1f1ec_1f1e7.svg',
  './img/emoji/1f1fa_1f1f8.svg',
  './img/emoji/1f1ff_1f1e6.svg',
  './img/emoji/1f30d.svg',
  './img/emoji/1f321.svg',
  './img/emoji/1f326.svg',
  './img/emoji/1f327.svg',
  './img/emoji/1f330.svg',
  './img/emoji/1f331.svg',
  './img/emoji/1f333.svg',
  './img/emoji/1f334.svg',
  './img/emoji/1f338.svg',
  './img/emoji/1f33b.svg',
  './img/emoji/1f33c.svg',
  './img/emoji/1f33d.svg',
  './img/emoji/1f33e.svg',
  './img/emoji/1f33f.svg',
  './img/emoji/1f341.svg',
  './img/emoji/1f342.svg',
  './img/emoji/1f343.svg',
  './img/emoji/1f344.svg',
  './img/emoji/1f345.svg',
  './img/emoji/1f347.svg',
  './img/emoji/1f34a.svg',
  './img/emoji/1f34b.svg',
  './img/emoji/1f34e.svg',
  './img/emoji/1f34f.svg',
  './img/emoji/1f350.svg',
  './img/emoji/1f351.svg',
  './img/emoji/1f352.svg',
  './img/emoji/1f353.svg',
  './img/emoji/1f356.svg',
  './img/emoji/1f360.svg',
  './img/emoji/1f37c.svg',
  './img/emoji/1f381.svg',
  './img/emoji/1f382.svg',
  './img/emoji/1f383.svg',
  './img/emoji/1f389.svg',
  './img/emoji/1f38b.svg',
  './img/emoji/1f39a.svg',
  './img/emoji/1f39b.svg',
  './img/emoji/1f3ac.svg',
  './img/emoji/1f3af.svg',
  './img/emoji/1f3c1.svg',
  './img/emoji/1f3c6.svg',
  './img/emoji/1f3d7.svg',
  './img/emoji/1f3da.svg',
  './img/emoji/1f3db.svg',
  './img/emoji/1f3e0.svg',
  './img/emoji/1f3e1.svg',
  './img/emoji/1f3e2.svg',
  './img/emoji/1f3e6.svg',
  './img/emoji/1f3ea.svg',
  './img/emoji/1f3f7.svg',
  './img/emoji/1f402.svg',
  './img/emoji/1f403.svg',
  './img/emoji/1f404.svg',
  './img/emoji/1f407.svg',
  './img/emoji/1f40e.svg',
  './img/emoji/1f40f.svg',
  './img/emoji/1f410.svg',
  './img/emoji/1f411.svg',
  './img/emoji/1f414.svg',
  './img/emoji/1f416.svg',
  './img/emoji/1f417.svg',
  './img/emoji/1f41b.svg',
  './img/emoji/1f41d.svg',
  './img/emoji/1f41f.svg',
  './img/emoji/1f423.svg',
  './img/emoji/1f430.svg',
  './img/emoji/1f437.svg',
  './img/emoji/1f43e.svg',
  './img/emoji/1f441.svg',
  './img/emoji/1f446.svg',
  './img/emoji/1f44b.svg',
  './img/emoji/1f465.svg',
  './img/emoji/1f477.svg',
  './img/emoji/1f489.svg',
  './img/emoji/1f4a1.svg',
  './img/emoji/1f4a4.svg',
  './img/emoji/1f4a6.svg',
  './img/emoji/1f4a7.svg',
  './img/emoji/1f4ac.svg',
  './img/emoji/1f4b0.svg',
  './img/emoji/1f4b2.svg',
  './img/emoji/1f4b3.svg',
  './img/emoji/1f4b5.svg',
  './img/emoji/1f4b8.svg',
  './img/emoji/1f4b9.svg',
  './img/emoji/1f4c4.svg',
  './img/emoji/1f4c5.svg',
  './img/emoji/1f4c8.svg',
  './img/emoji/1f4c9.svg',
  './img/emoji/1f4ca.svg',
  './img/emoji/1f4cb.svg',
  './img/emoji/1f4cc.svg',
  './img/emoji/1f4ce.svg',
  './img/emoji/1f4d0.svg',
  './img/emoji/1f4d2.svg',
  './img/emoji/1f4d8.svg',
  './img/emoji/1f4dc.svg',
  './img/emoji/1f4dd.svg',
  './img/emoji/1f4e5.svg',
  './img/emoji/1f4e6.svg',
  './img/emoji/1f4ec.svg',
  './img/emoji/1f4f1.svg',
  './img/emoji/1f4f7.svg',
  './img/emoji/1f500.svg',
  './img/emoji/1f501.svg',
  './img/emoji/1f504.svg',
  './img/emoji/1f50d.svg',
  './img/emoji/1f50e.svg',
  './img/emoji/1f512.svg',
  './img/emoji/1f514.svg',
  './img/emoji/1f517.svg',
  './img/emoji/1f527.svg',
  './img/emoji/1f52a.svg',
  './img/emoji/1f52c.svg',
  './img/emoji/1f52e.svg',
  './img/emoji/1f550.svg',
  './img/emoji/1f570.svg',
  './img/emoji/1f5a8.svg',
  './img/emoji/1f5bc.svg',
  './img/emoji/1f5c2.svg',
  './img/emoji/1f5d1.svg',
  './img/emoji/1f5d2.svg',
  './img/emoji/1f5d3.svg',
  './img/emoji/1f5fa.svg',
  './img/emoji/1f69a.svg',
  './img/emoji/1f69c.svg',
  './img/emoji/1f6a2.svg',
  './img/emoji/1f6a6.svg',
  './img/emoji/1f6a8.svg',
  './img/emoji/1f6a9.svg',
  './img/emoji/1f6aa.svg',
  './img/emoji/1f6c1.svg',
  './img/emoji/1f6c2.svg',
  './img/emoji/1f6d2.svg',
  './img/emoji/1f6e1.svg',
  './img/emoji/1f6e2.svg',
  './img/emoji/1f6fb.svg',
  './img/emoji/1f7e0.svg',
  './img/emoji/1f7e2.svg',
  './img/emoji/1f91d.svg',
  './img/emoji/1f951.svg',
  './img/emoji/1f952.svg',
  './img/emoji/1f954.svg',
  './img/emoji/1f955.svg',
  './img/emoji/1f95b.svg',
  './img/emoji/1f95c.svg',
  './img/emoji/1f966.svg',
  './img/emoji/1f967.svg',
  './img/emoji/1f96c.svg',
  './img/emoji/1f96d.svg',
  './img/emoji/1f983.svg',
  './img/emoji/1f986.svg',
  './img/emoji/1f98b.svg',
  './img/emoji/1f98c.svg',
  './img/emoji/1f999.svg',
  './img/emoji/1f99f.svg',
  './img/emoji/1f9a9.svg',
  './img/emoji/1f9ac.svg',
  './img/emoji/1f9c2.svg',
  './img/emoji/1f9c5.svg',
  './img/emoji/1f9ca.svg',
  './img/emoji/1f9d1_200d_1f33e.svg',
  './img/emoji/1f9ea.svg',
  './img/emoji/1f9ec.svg',
  './img/emoji/1f9ed.svg',
  './img/emoji/1f9ee.svg',
  './img/emoji/1f9fa.svg',
  './img/emoji/1f9fe.svg',
  './img/emoji/1fa7a.svg',
  './img/emoji/1faa6.svg',
  './img/emoji/1faaa.svg',
  './img/emoji/1fab0.svg',
  './img/emoji/1fab6.svg',
  './img/emoji/1fabf.svg',
  './img/emoji/1facf.svg',
  './img/emoji/1fad0.svg',
  './img/emoji/1fad1.svg',
  './img/emoji/1fad2.svg',
  './img/emoji/1fad8.svg',
  './img/emoji/1fada.svg',
  './img/emoji/1fadb.svg',
  './img/emoji/231b.svg',
  './img/emoji/2328.svg',
  './img/emoji/23f0.svg',
  './img/emoji/23f3.svg',
  './img/emoji/2600.svg',
  './img/emoji/2614.svg',
  './img/emoji/267b.svg',
  './img/emoji/2696.svg',
  './img/emoji/2699.svg',
  './img/emoji/26a0.svg',
  './img/emoji/26a1.svg',
  './img/emoji/26d4.svg',
  './img/emoji/26f0.svg',
  './img/emoji/26fd.svg',
  './img/emoji/2702.svg',
  './img/emoji/270d.svg',
  './img/emoji/270f.svg',
  './img/emoji/2728.svg',
  './img/emoji/2744.svg',
  './img/emoji/2753.svg',
  './img/emoji/2795.svg',
  './img/emoji/2b50.svg',
  './img/emoji/d-barley.svg',
  './img/emoji/d-beefcow.svg',
  './img/emoji/d-blackberry.svg',
  './img/emoji/d-blesbok.svg',
  './img/emoji/d-butternut.svg',
  './img/emoji/d-cauliflower.svg',
  './img/emoji/d-cotton.svg',
  './img/emoji/d-drybean.svg',
  './img/emoji/d-eland.svg',
  './img/emoji/d-fieldbean.svg',
  './img/emoji/d-gemsbok.svg',
  './img/emoji/d-gooseberry.svg',
  './img/emoji/d-grapefruit.svg',
  './img/emoji/d-grass.svg',
  './img/emoji/d-greenbean.svg',
  './img/emoji/d-hay.svg',
  './img/emoji/d-impala.svg',
  './img/emoji/d-kudu.svg',
  './img/emoji/d-layerhen.svg',
  './img/emoji/d-leek.svg',
  './img/emoji/d-linseed.svg',
  './img/emoji/d-litchi.svg',
  './img/emoji/d-lupin.svg',
  './img/emoji/d-macadamia.svg',
  './img/emoji/d-naartjie.svg',
  './img/emoji/d-oats.svg',
  './img/emoji/d-parsnip.svg',
  './img/emoji/d-plum.svg',
  './img/emoji/d-pomegranate.svg',
  './img/emoji/d-quince.svg',
  './img/emoji/d-raspberry.svg',
  './img/emoji/d-rye.svg',
  './img/emoji/d-sorghum.svg',
  './img/emoji/d-spinach.svg',
  './img/emoji/d-springbok.svg',
  './img/emoji/d-sprouts.svg',
  './img/emoji/d-straw.svg',
  './img/emoji/d-sugarbeet.svg',
  './img/emoji/d-swede.svg',
  './img/emoji/d-winegrape.svg'
];
function _warmEmoji(){ return caches.open(CACHE).then(function (c) { return Promise.allSettled(EMOJI.map(function (u) { return c.match(u).then(function (m) { return m || c.add(u); }); })); }); }
self.addEventListener('message', function (e) { if (e.data && e.data.type === 'ai-warm-emoji' && e.waitUntil) e.waitUntil(_warmEmoji().catch(function () {})); });

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
/* -497: is this the app page itself - the scope's own folder ("./") or "./index.html", with any ?query (?demo=1) - resolved
   against this worker's scope, never a hard-coded path. Only that page is the shell. */
function _scopeURL(){ try { return new URL((self.registration && self.registration.scope) || './', self.location.href); } catch (e) { return new URL('./', self.location.href); } }
function _isAppPage(url){ var sc = _scopeURL(); if (url.origin !== sc.origin) return false; return url.pathname === sc.pathname || url.pathname === sc.pathname + 'index.html'; }
/* any other page: its own URL is its cache key (the query kept, the #hash never sent) */
function _ownKey(url){ return url.origin + url.pathname + url.search; }
function _verOf(res){ try { return res.headers.get('etag') || res.headers.get('last-modified') || ''; } catch (e) { return ''; } }
/* -491 (UK B11F item 3): the "newer page" message carries that page's own release (its <meta name="ai-build">), and the page
   asks which release this worker is, so the bar shows only when there really is another version. */
function _buildOf(res){
  try { return res.clone().text().then(function (t) { var m = String(t).match(/<meta name="ai-build" content="([^"]+)"/); return m ? m[1] : null; }).catch(function () { return null; }); }
  catch (e) { return Promise.resolve(null); }
}
function _tellNewer(build){
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    cs.forEach(function (c) { try { c.postMessage({ type: 'ai-sw-newer', v: APP_VERSION, build: build || null }); } catch (e) {} });
  });
}
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'ai-version?') return;
  var m = { type: 'ai-version', v: APP_VERSION };
  if (e.ports && e.ports[0]) e.ports[0].postMessage(m); else if (e.source) e.source.postMessage(m);
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

  // 2b) -497: any other same-origin page (privacy.html, ...): network-first, cached under its own URL, offline its own copy or a
  //     network error - it never touches the app shell and the app shell never stands in for it.
  if (isHTML && !_isAppPage(url)) {
    var key = _ownKey(url), netO = fetch(_freshHTML(req));
    e.waitUntil(netO.then(function (res) {
      if (!res || !res.ok || res.type !== 'basic') return;
      var cp = res.clone(); return caches.open(CACHE).then(function (c) { return c.put(key, cp); });
    }).catch(function () {}));
    e.respondWith(new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { caches.match(key).then(function (m) { if (done || !m) return; done = true; resolve(m); }); }, HTML_WAIT_MS);
      netO.then(function (res) { if (done) return; done = true; clearTimeout(timer); resolve(res); },
                function () { if (done) return; clearTimeout(timer); caches.match(key).then(function (m) { if (done) return; done = true; resolve(m || Response.error()); }); });
    }));
    return;
  }

  // 2) HTML / navigation of the app page itself: network-first so a normal reload always gets the latest
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
      if (shown && res && res.ok && _verOf(res) !== _verOf(shown)) return _buildOf(res).then(function (b) { return _tellNewer(b); });
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

  // 2c) -513: a bundled emoji picture: cache-first (filled on first view or by the idle warm-up)
  if (/\/img\/emoji\/[0-9a-z_-]+\.svg$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(function (m) { return m || fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
      return res; }); }));
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
