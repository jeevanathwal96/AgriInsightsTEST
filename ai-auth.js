/* ============================================================================
 * AgriInsights — Login Gate + Startup Load  (ai-auth.js)
 * Self-contained: injects its own sign-in overlay, and AFTER sign-in loads the
 * farm's transactions from Supabase into ST.txns and re-renders the app.
 * Does NOT modify bootAgriInsights() or loadState() — it layers on top.
 * Load order in <head>:  supabase-js  ->  ai-data.js  ->  ai-auth.js
 * ========================================================================== */
(function () {
  'use strict';

  var FOREST = '#1F4D2C', GOLD = '#C8962C', CREAM = '#F7F6F1', INK = '#1A2622';

  // ---- styles + overlay injected on DOM ready ------------------------------
  function injectUI() {
    var css = document.createElement('style');
    css.textContent =
      '#ai-auth{position:fixed;inset:0;z-index:99999;background:' + FOREST +
        ';display:flex;align-items:center;justify-content:center;' +
        'font-family:"Plus Jakarta Sans",system-ui,sans-serif;}' +
      '#ai-auth .card{background:' + CREAM + ';width:340px;max-width:90vw;border-radius:18px;' +
        'padding:30px 26px;box-shadow:0 20px 60px rgba(0,0,0,.35);}' +
      '#ai-auth h1{margin:0 0 4px;font-size:22px;color:' + FOREST + ';font-weight:800;}' +
      '#ai-auth p.sub{margin:0 0 20px;font-size:13px;color:#6b716a;}' +
      '#ai-auth label{display:block;font-size:12px;font-weight:600;color:' + INK +
        ';margin:12px 0 5px;}' +
      '#ai-auth input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cdd2c9;' +
        'border-radius:10px;font-size:15px;font-family:inherit;}' +
      '#ai-auth input:focus{outline:none;border-color:' + FOREST + ';}' +
      '#ai-auth button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;' +
        'background:' + FOREST + ';color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;}' +
      '#ai-auth button:disabled{opacity:.6;cursor:default;}' +
      '#ai-auth .msg{margin-top:14px;font-size:13px;min-height:18px;}' +
      '#ai-auth .msg.err{color:#a6432a;}#ai-auth .msg.ok{color:' + FOREST + ';}' +
      '#ai-signout{position:fixed;bottom:14px;left:14px;z-index:99998;background:' + FOREST +
        ';color:#fff;border:0;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;' +
        'font-family:"Plus Jakarta Sans",sans-serif;cursor:pointer;opacity:.85;}';
    document.head.appendChild(css);

    var o = document.createElement('div');
    o.id = 'ai-auth';
    o.innerHTML =
      '<div class="card">' +
        '<h1>AgriInsights</h1>' +
        '<p class="sub">Sign in to your farm</p>' +
        '<label for="ai-email">Email</label>' +
        '<input id="ai-email" type="email" autocomplete="username" placeholder="you@farm.co.za"/>' +
        '<label for="ai-pass">Password</label>' +
        '<input id="ai-pass" type="password" autocomplete="current-password" placeholder="Your password"/>' +
        '<button id="ai-signin">Sign in</button>' +
        '<div class="msg" id="ai-msg"></div>' +
      '</div>';
    document.body.appendChild(o);

    document.getElementById('ai-signin').addEventListener('click', doSignIn);
    document.getElementById('ai-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSignIn();
    });
  }

  function msg(text, kind) {
    var m = document.getElementById('ai-msg');
    if (m) { m.textContent = text || ''; m.className = 'msg ' + (kind || ''); }
  }
  function hideOverlay() {
    var o = document.getElementById('ai-auth');
    if (o) o.style.display = 'none';
    if (!document.getElementById('ai-signout')) {
      var b = document.createElement('button');
      b.id = 'ai-signout'; b.textContent = 'Sign out';
      b.addEventListener('click', function () {
        AI.auth.signOut().then(function () { location.reload(); });
      });
      document.body.appendChild(b);
    }
  }

  // ---- offline session: reveal the cached app instead of trapping on login ----
  function _isOfflineErr(e){ var raw=(e&&e.message)?e.message:String(e||''); return (navigator.onLine===false) || /failed to fetch|networkerror|load failed|fetch|timeout|offline/i.test(raw); }
  function _hasPersistedSession(){ try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) return true; } }catch(e){} return false; }
  function _offlineReveal(){
    // The app's own boot (bootAgriInsights -> loadState) already populated ST from this
    // device's localStorage, so the user has their last-synced data. Reveal it; the topbar
    // sync indicator shows the offline state and the outbox/relational flush runs on reconnect.
    hideOverlay();
    try{ if(typeof window.toast==='function') window.toast('You\u2019re offline \u2014 showing your last synced data. Changes save on this device and sync when you reconnect.','info'); }catch(e){}
  }

  // ---- sign in -------------------------------------------------------------
  function doSignIn() {
    var btn = document.getElementById('ai-signin');
    var email = (document.getElementById('ai-email').value || '').trim();
    var pass = document.getElementById('ai-pass').value || '';
    if (!email || !pass) { msg('Enter your email and password.', 'err'); return; }
    btn.disabled = true; msg('Signing in…', 'ok');
    AI.auth.signIn(email, pass)
      .then(function () { return hydrate(); })
      .then(function () { hideOverlay(); })
      .catch(function (e) {
        btn.disabled = false;
        var raw = (e && e.message) ? e.message : '';
        var offline = !navigator.onLine || /failed to fetch|networkerror|load failed|fetch/i.test(raw);
        if (offline) {
          msg('You appear to be offline. Connect to the internet to sign in.', 'err');
        } else {
          msg(raw || 'Sign-in failed. Check your details.', 'err');
        }
      });
  }

  // ---- ensure a farm, load its data into ST, re-render ---------------------
  function hydrate(opts) {
    opts = opts || {};
    var isNewFarm = false;
    return AI.farm.mine().then(function (farms) {
      if (!farms || !farms.length) { isNewFarm = true; return AI.farm.create('My Farm'); }
      if (!AI.farm.active()) AI.farm.setActive(farms[0].id);
      return AI.farm.active();
    }).then(function () {
      return AI.load.financeCore(AI.farm.active());
    }).then(function (core) {
      // Replace the app's working data with the farm's real data.
      if (window.ST) { ST.txns = (window.preservePendingTxns ? window.preservePendingTxns(core.txns || []) : (core.txns || [])); ST.recurring = core.recurring || []; if (core.budgets) ST.budgets = core.budgets; if (core.batches) ST.importBatches = core.batches; ST.firstRun = false; }
      // currentMonth is a local "trailing window" anchor the backend doesn't persist — financeCore returns it as null,
      // which blanked the boot-time anchor on every sign-in (money views then fell back to a computed default). Re-anchor
      // it to the real current month here. Only sets the label; never shifts transaction dates, so real data is untouched.
      try { if (window.ST && ST.budgets && !ST.budgets.currentMonth) { var _d=(window.APP_TODAY?new Date(window.APP_TODAY):new Date()); var _ml=(window.MONTH_LABELS_SHORT)||['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; ST.budgets.currentMonth=_ml[_d.getMonth()]+' '+_d.getFullYear(); } } catch (e) {}
      // Brand-new pilot farm: wipe any in-memory demo defaults across ALL modules
      // so the user starts on a clean slate and can begin entering data straight away.
      if (isNewFarm && typeof window.clearAllToFresh === 'function') {
        try { window.clearAllToFresh(); if (typeof window.saveState === 'function') window.saveState(); } catch (e) {}
      }
      // Load the asset register + loans before first render (net-worth uses them).
      return Promise.all([
        AI.load.assets(AI.farm.active()),
        AI.load.loans(AI.farm.active())
      ]).then(function (res) {
        var assets = res[0], loanData = res[1];
        try {
          if (window.ST_ASSETS && assets) {
            assets.forEach(function (a, i) { a.id = i + 1; });
            ST_ASSETS.assets = assets;
            ST_ASSETS.nextId = assets.length + 1;
          }
        } catch (e) { console.error('Asset hydrate failed:', e); }
        try {
          if (window.ST_LOANS && loanData) {
            ST_LOANS.loans = loanData.loans || [];
            ST_LOANS.overdrafts = loanData.overdrafts || [];
            ST_LOANS.coopAccounts = loanData.coopAccounts || [];
            ST_LOANS.archived = loanData.archived || [];
            // Monthly paid-marks (Item 3): restore so a confirmed month survives reload + new device.
            if (loanData.confirmed) ST_LOANS.confirmed = loanData.confirmed;
            // Loan->asset link (Item 2): resolve the stored asset UUID back to the
            // asset's current local id (assets were applied just above).
            if (window.ST_ASSETS && ST_ASSETS.assets) {
              var _byUuid = {};
              ST_ASSETS.assets.forEach(function (a) { if (a._aiId) _byUuid[a._aiId] = a.id; });
              ST_LOANS.loans.concat(ST_LOANS.archived || []).forEach(function (l) {
                if (l._assetUuid && _byUuid[l._assetUuid] != null) l.assetId = _byUuid[l._assetUuid];
              });
            }
          }
        } catch (e) { console.error('Loan hydrate failed:', e); }
      }).catch(function (e) { console.error('Asset/loan load failed:', e); });
    }).then(function () {
      // Cross-device persistence: load every relational module from the backend so a
      // farmer signing in on a new device sees ALL their data, not demo defaults.
      // Each module applies independently (its own try/catch) so one failure can't
      // break the others. Skipped for brand-new farms (nothing saved yet).
      if (isNewFarm) return;
      var fid = AI.farm.active();
      return Promise.all([
        AI.load.livestock(fid).catch(function (e) { console.error('livestock load', e); return null; }),
        AI.load.crops(fid).catch(function (e) { console.error('crops load', e); return null; }),
        AI.load.orchard(fid).catch(function (e) { console.error('orchard load', e); return null; }),
        AI.load.plan(fid).catch(function (e) { console.error('plan load', e); return null; }),
        AI.load.workers(fid).catch(function (e) { console.error('workers load', e); return null; }),
        AI.load.profile(fid).catch(function (e) { console.error('profile load', e); return null; }),
        AI.load.coopSettlements(fid).catch(function (e) { console.error('coop load', e); return null; })
      ]).then(function (r) {
        var ls = r[0], cr = r[1], orc = r[2], pl = r[3], wk = r[4], pf = r[5], coop = r[6];
        try { if (window.ST_LS && ls) { var _lsHas = ((ls.herds&&ls.herds.length)||(ls.camps&&ls.camps.length)||(ls.animals&&ls.animals.length)); var _lsLoc = ((ST_LS.herd&&ST_LS.herd.length)||(ST_LS.camps&&ST_LS.camps.length)); if (_lsHas || !_lsLoc) { ST_LS.camps = ls.camps || []; ST_LS.herd = ls.herds || []; if (ls.benchmarks) ST_LS.benchmarks = ls.benchmarks; ST_LS.moves = ls.moves || []; ST_LS.treatments = ls.treatments || []; ST_LS.animals = ls.animals || []; ST_LS.health = ls.health || []; ST_LS.breedings = ls.breedings || []; } } } catch (e) { console.error('livestock apply', e); }
        try { if (window.ST_CROP && cr) { var _crHas = ((cr.lands&&cr.lands.length)||(cr.events&&cr.events.length)||(cr.inputs&&cr.inputs.length)); var _crLoc = ((ST_CROP.lands&&ST_CROP.lands.length)||(ST_CROP.events&&ST_CROP.events.length)); if (_crHas || !_crLoc) { ST_CROP.lands = cr.lands || []; ST_CROP.events = cr.events || []; ST_CROP.inputs = cr.inputs || []; if (cr.season) ST_CROP.season = cr.season; if (cr.compliance) ST_CROP.compliance = cr.compliance; } } } catch (e) { console.error('crops apply', e); }
        try { if (window.ST_FRUIT && orc) { var _orcHas = (orc.blocks && orc.blocks.length); var _locHas = (ST_FRUIT.blocks && ST_FRUIT.blocks.length); if (_orcHas || !_locHas) { ST_FRUIT.blocks = orc.blocks || []; ST_FRUIT.pricing = orc.pricing || {}; ST_FRUIT.sprayDiary = orc.sprayDiary || {}; ST_FRUIT.harvest = orc.harvest || []; if (orc.comply) ST_FRUIT.comply = orc.comply; try{ if(window.orComplyEnsure) orComplyEnsure(); }catch(_){} if (orc.market) ST_FRUIT.market = orc.market; if (typeof window.orRebuildPhi === 'function') { try { window.orRebuildPhi(); } catch (_) {} } } } } catch (e) { console.error('orchard apply', e); }
        try { if (window.ST_PLAN) { var _plHas = (pl && ((pl.crops&&pl.crops.length)||(pl.events&&pl.events.length))); var _plLoc = ((ST_PLAN.crops&&ST_PLAN.crops.length)||(ST_PLAN.events&&ST_PLAN.events.length)); if (pl && (_plHas || !_plLoc)) { ST_PLAN.crops = pl.crops || []; ST_PLAN.events = pl.events || []; ST_PLAN.fromBackend = true; if (typeof window.planSyncToCurrentYear === 'function') { try { window.planSyncToCurrentYear(); } catch (_) {} } } else if (!pl && typeof window.cropInitialPlanSync === 'function') { try { window.cropInitialPlanSync(true); } catch (_) {} } } } catch (e) { console.error('plan apply', e); }
        try { if (window.ST_WORK && wk) { var _wkHas = (wk.workers && wk.workers.length); var _wkLoc = (ST_WORK.workers && ST_WORK.workers.length); if (_wkHas || !_wkLoc) { ST_WORK.workers = wk.workers || []; if (wk.settingsRow && AI.workers && AI.workers.apply) { AI.workers.apply(ST_WORK, wk.settingsRow); } if (wk.payroll) { ST_WORK.paye = wk.payroll.paye || {}; ST_WORK.bonus = wk.payroll.bonus || {}; ST_WORK.extra = wk.payroll.extra || {}; ST_WORK.seasonal = wk.payroll.seasonal || {}; } ST_WORK.payRuns = wk.payRuns || []; } } } catch (e) { console.error('workers apply', e); }
        try { if (window.ST && pf) { Object.keys(pf).forEach(function (k) { if (pf[k] != null) ST[k] = pf[k]; }); if (window.FARM && pf.farmName) FARM.name = pf.farmName; } } catch (e) { console.error('profile apply', e); }
        try { if (window.ST && Array.isArray(coop)) ST.coopSettlements = coop; } catch (e) { console.error('coop apply', e); }
        try { if (typeof window.saveState === 'function') window.saveState(); } catch (e) {}
      }).catch(function (e) { console.error('Relational hydrate failed:', e); });
    }).then(function () {
      // Signed-in users skip the app's first-run onboarding wizard.
      try {
        var ov = document.getElementById('ob-overlay');
        if (ov) ov.style.display = 'none';
      } catch (e) {}
      try {
        if (typeof nav === 'function') nav(opts.silent && window.CURRENT_PAGE ? window.CURRENT_PAGE : 'dashboard');
        else if (typeof updateDashboardFigures === 'function') updateDashboardFigures();
      } catch (e) {}
      try {
        if (typeof window.updateSyncIndicator === 'function') window.updateSyncIndicator();
      } catch (e) {}
    });
  }

  // ---- boot: wait for DOM + AI, then check for an existing session ---------
  function start() {
    if (!window.AI) { msg('Backend not loaded (check ai-data.js).', 'err'); return; }
    // Run AFTER the app's own boot has populated ST (setTimeout defers past it).
    setTimeout(function () {
      // Offline boot with a cached session: don't trap the user on a login they can't
      // complete offline — reveal their already-loaded local data.
      if (navigator.onLine === false && _hasPersistedSession()) { _offlineReveal(); return; }
      AI.init().auth.getSession().then(function (res) {
        var session = res && res.data ? res.data.session : null;
        if (session) {
          hydrate().then(hideOverlay).catch(function (e) {
            if (_isOfflineErr(e) && _hasPersistedSession()) { _offlineReveal(); }
            // else: a genuine error — overlay stays for sign-in
          });
        } else if (_hasPersistedSession() && navigator.onLine === false) {
          // getSession couldn't confirm offline, but a cached token exists
          _offlineReveal();
        }
        // else: no session — overlay stays visible for sign-in
      }).catch(function (e) {
        if (_hasPersistedSession() && _isOfflineErr(e)) { _offlineReveal(); }
        // else: overlay stays visible
      });
    }, 0);
  }

  // ---- Tier-1 cross-device: re-pull from the cloud when the app regains focus ----
  var _lastRefresh = 0, _refreshing = false;
  function refreshFromCloud(){
    if (_refreshing) return;
    if (navigator.onLine === false) return;                                   // offline: outbox handles it
    if (!(window.AI && AI.farm && AI.farm.active()) || !_hasPersistedSession()) return;  // signed-in only
    var ae = document.activeElement;                                          // don't yank data mid-edit
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    try { if (document.querySelector('[id$="-bg"].on')) return; } catch(e){}  // a modal is open
    if (Date.now() - _lastRefresh < 20000) return;                           // debounce ~20s
    _refreshing = true; _lastRefresh = Date.now();
    try { if (window.flushTxnOutbox) window.flushTxnOutbox(); } catch(e){}    // push local writes first
    try {                                                                    // push pending relational edits too (snapshot-debounced -> no-op if unchanged), so a refocus never races a local edit
      if (AI.loans && window.ST_LOANS) AI.loans.saveAll(ST_LOANS).catch(function(){});
      if (AI.livestock && window.ST_LS) AI.livestock.saveAll(ST_LS).catch(function(){});
      if (AI.crop && window.ST_CROP) AI.crop.saveAll(ST_CROP).catch(function(){});
      if (AI.orchard && window.ST_FRUIT) AI.orchard.saveAll(ST_FRUIT).catch(function(){});
      if (AI.plan && window.ST_PLAN) AI.plan.saveAll(ST_PLAN).catch(function(){});
      if (AI.workers && window.ST_WORK) AI.workers.saveAll(ST_WORK).catch(function(){});
    } catch(e){}
    hydrate({silent:true}).catch(function(){}).then(function(){ _refreshing = false; });
  }
  window.refreshFromCloud = refreshFromCloud;
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) refreshFromCloud(); });
  window.addEventListener('online', function(){ refreshFromCloud(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectUI(); start(); });
  } else { injectUI(); start(); }
})();
