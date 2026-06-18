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
        msg((e && e.message) ? e.message : 'Sign-in failed. Check your details.', 'err');
      });
  }

  // ---- ensure a farm, load its data into ST, re-render ---------------------
  function hydrate() {
    return AI.farm.mine().then(function (farms) {
      if (!farms || !farms.length) return AI.farm.create('My Farm');
      if (!AI.farm.active()) AI.farm.setActive(farms[0].id);
      return AI.farm.active();
    }).then(function () {
      return AI.load.financeCore(AI.farm.active());
    }).then(function (core) {
      // Replace the app's working data with the farm's real data.
      if (window.ST) { ST.txns = core.txns || []; ST.recurring = core.recurring || []; if (core.budgets) ST.budgets = core.budgets; ST.firstRun = false; }
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
          }
        } catch (e) { console.error('Loan hydrate failed:', e); }
      }).catch(function (e) { console.error('Asset/loan load failed:', e); });
    }).then(function () {
      // Signed-in users skip the app's first-run onboarding wizard.
      try {
        var ov = document.getElementById('ob-overlay');
        if (ov) ov.style.display = 'none';
      } catch (e) {}
      try {
        if (typeof nav === 'function') nav('dashboard');
        else if (typeof updateDashboardFigures === 'function') updateDashboardFigures();
      } catch (e) {}
    });
  }

  // ---- boot: wait for DOM + AI, then check for an existing session ---------
  function start() {
    if (!window.AI) { msg('Backend not loaded (check ai-data.js).', 'err'); return; }
    // Run AFTER the app's own boot has populated ST (setTimeout defers past it).
    setTimeout(function () {
      AI.init().auth.getSession().then(function (res) {
        var session = res && res.data ? res.data.session : null;
        if (session) { hydrate().then(hideOverlay).catch(function(){ /* stay on overlay */ }); }
        // else: overlay stays visible for sign-in
      }).catch(function () { /* overlay stays visible */ });
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectUI(); start(); });
  } else { injectUI(); start(); }
})();
