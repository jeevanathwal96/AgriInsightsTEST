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
      /* ── sign-up additions (Phase 1). Same visual language as the card above. ── */
      '#ai-auth .tabs{display:flex;gap:4px;background:#eceee6;border-radius:12px;padding:4px;margin:0 0 4px;}' +
      '#ai-auth .tab{flex:1;text-align:center;padding:9px 6px;border-radius:9px;font-size:13.5px;font-weight:700;' +
        'color:#6b716a;cursor:pointer;border:0;background:transparent;font-family:inherit;margin:0;width:auto;}' +
      '#ai-auth .tab.on{background:#fff;color:' + FOREST + ';box-shadow:0 1px 3px rgba(0,0,0,.10);}' +
      '#ai-auth .hint{font-size:11.5px;color:#6b716a;margin-top:6px;line-height:1.4;}' +
      '#ai-auth .ghost{background:transparent;color:' + FOREST + ';border:1.5px solid #cdd2c9;font-weight:700;}' +
      '#ai-auth .inbox{text-align:center;}' +
      '#ai-auth .inbox .big{font-size:34px;line-height:1;margin-bottom:10px;}' +
      '#ai-auth .langsw{display:flex;gap:4px;justify-content:flex-end;margin-bottom:2px;}' +
      '#ai-auth .langsw button{width:auto;margin:0;padding:3px 9px;font-size:11px;font-weight:700;border-radius:7px;' +
        'background:transparent;color:#6b716a;border:1px solid #dfe3da;}' +
      '#ai-auth .langsw button.on{background:' + FOREST + ';color:#fff;border-color:' + FOREST + ';}' +
      '#ai-signout{position:fixed;bottom:14px;left:14px;z-index:99998;background:' + FOREST +
        ';color:#fff;border:0;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;' +
        'font-family:"Plus Jakarta Sans",sans-serif;cursor:pointer;opacity:.85;}';
    document.head.appendChild(css);

    var o = document.createElement('div');
    o.id = 'ai-auth';
    o.innerHTML =
      '<div class="card">' +
        '<div class="langsw"><button id="ai-lang-en" class="on">EN</button><button id="ai-lang-af">AF</button></div>' +
        '<h1>AgriInsights</h1>' +
        '<p class="sub" id="ai-sub">Sign in to your farm</p>' +
        '<div class="tabs" id="ai-tabs">' +
          '<button class="tab on" id="ai-tab-in">Sign in</button>' +
          '<button class="tab" id="ai-tab-up">Create account</button>' +
        '</div>' +
        /* ── sign-in pane (unchanged fields + ids, so nothing downstream breaks) ── */
        '<div id="ai-pane-in">' +
          '<label for="ai-email">Email</label>' +
          '<input id="ai-email" type="email" autocomplete="username" placeholder="you@farm.co.za"/>' +
          '<label for="ai-pass">Password</label>' +
          '<input id="ai-pass" type="password" autocomplete="current-password" placeholder="Your password"/>' +
          '<div style="text-align:right;margin-top:8px"><span id="ai-forgot" style="color:' + FOREST + ';font-weight:700;text-decoration:underline;cursor:pointer;font-size:12.5px">Forgot password?</span></div>' +
          '<button id="ai-signin">Sign in</button>' +
        '</div>' +
        /* ── forgot password: ask for the address, then reuse the inbox screen ── */
        '<div id="ai-pane-reset" style="display:none">' +
          '<label for="ai-rs-email">Email</label>' +
          '<input id="ai-rs-email" type="email" autocomplete="username" placeholder="you@farm.co.za"/>' +
          '<div class="hint" id="ai-rs-hint">We’ll email you a link to choose a new password.</div>' +
          '<button id="ai-reset">Email me a reset link</button>' +
          '<button id="ai-reset-back" class="ghost" style="margin-top:8px">← Back to sign in</button>' +
        '</div>' +
        /* ── the screen the reset link lands on: choose a new password ── */
        '<div id="ai-pane-newpass" style="display:none">' +
          '<label for="ai-np-pass">New password</label>' +
          '<input id="ai-np-pass" type="password" autocomplete="new-password" placeholder="At least 8 characters"/>' +
          '<label for="ai-np-pass2">Type it again</label>' +
          '<input id="ai-np-pass2" type="password" autocomplete="new-password" placeholder="At least 8 characters"/>' +
          '<button id="ai-savepass">Save new password</button>' +
        '</div>' +
        /* ── create-account pane. Two fields only: the 5-step wizard already collects
              the farm details, and asking twice doubles the work for the farmer. ── */
        '<div id="ai-pane-up" style="display:none">' +
          '<label for="ai-su-email">Email</label>' +
          '<input id="ai-su-email" type="email" autocomplete="username" placeholder="you@farm.co.za"/>' +
          '<label for="ai-su-pass">Choose a password</label>' +
          '<input id="ai-su-pass" type="password" autocomplete="new-password" placeholder="At least 8 characters"/>' +
          '<div class="hint" id="ai-su-hint">You’ll use this to sign in on any device — your phone, the farm office, anywhere.</div>' +
          '<button id="ai-signup">Create my account</button>' +
        '</div>' +
        /* ── "check your email" pane: shown because email confirmation is ON ── */
        '<div id="ai-pane-inbox" style="display:none">' +
          '<div class="inbox">' +
            '<div class="big">📬</div>' +
            '<div id="ai-inbox-title" style="font-size:18px;font-weight:800;color:' + FOREST + ';margin-bottom:6px">Check your email</div>' +
            '<div id="ai-inbox-body" style="font-size:13px;color:#6b716a;line-height:1.5">We sent a confirmation link to <b id="ai-inbox-email"></b>. Tap it and you’re in.</div>' +
          '</div>' +
          '<button id="ai-resend" class="ghost">Resend the email</button>' +
          '<button id="ai-inbox-back" class="ghost" style="margin-top:8px">Already confirmed? Sign in</button>' +
        '</div>' +
        '<div class="msg" id="ai-msg"></div>' +
        '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #dfe3da;text-align:center">' +
          '<div style="font-size:12px;color:#6b716a;margin-bottom:9px" id="ai-demo-q">Just want to look around first?</div>' +
          '<button id="ai-demo" style="background:' + GOLD + ';color:#12271b;font-weight:800;margin-top:0">🌱 Explore the demo</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);

    document.getElementById('ai-signin').addEventListener('click', doSignIn);
    document.getElementById('ai-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSignIn();
    });
    document.getElementById('ai-signup').addEventListener('click', doSignUp);
    document.getElementById('ai-su-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSignUp();
    });
    document.getElementById('ai-tab-in').addEventListener('click', function(){ setMode('signin'); });
    document.getElementById('ai-tab-up').addEventListener('click', function(){ setMode('signup'); });
    document.getElementById('ai-inbox-back').addEventListener('click', function(){ setMode('signin'); });
    document.getElementById('ai-resend').addEventListener('click', doResend);
    document.getElementById('ai-forgot').addEventListener('click', function(){ setMode('reset'); });
    document.getElementById('ai-reset-back').addEventListener('click', function(){ setMode('signin'); });
    document.getElementById('ai-reset').addEventListener('click', doReset);
    document.getElementById('ai-rs-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') doReset(); });
    document.getElementById('ai-savepass').addEventListener('click', doSavePassword);
    document.getElementById('ai-np-pass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSavePassword(); });
    document.getElementById('ai-lang-en').addEventListener('click', function(){ setAuthLang('en'); });
    document.getElementById('ai-lang-af').addEventListener('click', function(){ setAuthLang('af'); });
    applyAuthLang();
    /* The demo's "Create your farm →" leaves a flag so the farmer lands where they
       were heading — the sign-up form — instead of a sign-in card with no way on. */
    try {
      if (localStorage.getItem('ai_auth_mode') === 'signup') { setMode('signup'); }
      localStorage.removeItem('ai_auth_mode');
    } catch (e) {}
    var demoBtn = document.getElementById('ai-demo');
    if (demoBtn) demoBtn.addEventListener('click', function () {
      try { localStorage.setItem('ai_guest', '1'); } catch (e) {}
      location.href = location.pathname + '?demo=1';
    });
  }

  function msg(text, kind) {
    var m = document.getElementById('ai-msg');
    if (m) { m.textContent = text || ''; m.className = 'msg ' + (kind || ''); }
  }

  /* ── Sign-up (Phase 1) ────────────────────────────────────────────────────
     Strings live here, NOT in LANG_PAIRS: the pair engine is a substring pass
     over the app's DOM and this overlay renders before the app's language is
     even known (a brand-new farmer has no saved preference — the wizard asks
     for it at step 1, which is after this card). Whole strings, chosen by an
     explicit toggle, cannot be mangled the way paired fragments can.        */
  var AUTH_T = {
    en: { subIn:'Sign in to your farm', subUp:'Start your farm’s records', subInbox:'One more step',
          tabIn:'Sign in', tabUp:'Create account', signin:'Sign in', signup:'Create my account',
          lblEmail:'Email', lblPass:'Password', lblNewPass:'Choose a password',
          phEmail:'you@farm.co.za', phPass:'Your password', phNewPass:'At least 8 characters',
          hint:'You’ll use this to sign in on any device — your phone, the farm office, anywhere.',
          demoQ:'Just want to look around first?', demo:'🌱 Explore the demo',
          inboxTitle:'Check your email', inboxBody1:'We sent a confirmation link to ', inboxBody2:'. Tap it and you’re in.',
          resend:'Resend the email', back:'Already confirmed? Sign in',
          needBoth:'Enter your email and password.', badEmail:'That doesn’t look like an email address — check for a missing .co.za or .com.',
          shortPass:'Too short — use at least 8 characters.', creating:'Creating your account…',
          sent:'Email sent — check your inbox.', resent:'Sent again — check your inbox.',
          wait:'Wait ', waitSuffix:'s before asking again.', offline:'You appear to be offline. Connect to the internet to continue.',
          subReset:'Reset your password', subNewPass:'Choose a new password',
          forgot:'Forgot password?', lblRsEmail:'Email', rsHint:'We’ll email you a link to choose a new password.',
          resetBtn:'Email me a reset link', resetBack:'← Back to sign in',
          lblNew:'New password', lblNew2:'Type it again', savePass:'Save new password',
          resetTitle:'Check your email', resetBody1:'We sent a password-reset link to ', resetBody2:'. Open it to choose a new password.',
          resetSent:'Reset link sent — check your inbox.', mismatch:'Those two passwords are not the same.',
          savingPass:'Saving your new password…', passSaved:'Password changed — signing you in…',
          recoverExpired:'That reset link has expired. Ask for a new one.' },
    af: { subIn:'Teken in by jou plaas', subUp:'Begin jou plaas se rekords', subInbox:'Nog een stap',
          tabIn:'Teken in', tabUp:'Skep rekening', signin:'Teken in', signup:'Skep my rekening',
          lblEmail:'E-pos', lblPass:'Wagwoord', lblNewPass:'Kies ’n wagwoord',
          phEmail:'jy@plaas.co.za', phPass:'Jou wagwoord', phNewPass:'Ten minste 8 karakters',
          hint:'Jy gebruik dit om op enige toestel in te teken — jou foon, die plaaskantoor, oral.',
          demoQ:'Wil jy eers net rondkyk?', demo:'🌱 Verken die demo',
          inboxTitle:'Kyk in jou e-pos', inboxBody1:'Ons het ’n bevestigingskakel gestuur na ', inboxBody2:'. Tik daarop en jy is in.',
          resend:'Stuur die e-pos weer', back:'Reeds bevestig? Teken in',
          needBoth:'Voer jou e-pos en wagwoord in.', badEmail:'Dit lyk nie soos ’n e-posadres nie — kyk of .co.za of .com kort.',
          shortPass:'Te kort — gebruik ten minste 8 karakters.', creating:'Besig om jou rekening te skep…',
          sent:'E-pos gestuur — kyk in jou inpos.', resent:'Weer gestuur — kyk in jou inpos.',
          wait:'Wag ', waitSuffix:'s voordat jy weer vra.', offline:'Dit lyk of jy vanlyn is. Koppel aan die internet om voort te gaan.',
          subReset:'Stel jou wagwoord terug', subNewPass:'Kies ’n nuwe wagwoord',
          forgot:'Wagwoord vergeet?', lblRsEmail:'E-pos', rsHint:'Ons stuur vir jou ’n skakel om ’n nuwe wagwoord te kies.',
          resetBtn:'Stuur vir my ’n terugstelskakel', resetBack:'← Terug na teken in',
          lblNew:'Nuwe wagwoord', lblNew2:'Tik dit weer', savePass:'Stoor nuwe wagwoord',
          resetTitle:'Kyk in jou e-pos', resetBody1:'Ons het ’n skakel gestuur na ', resetBody2:'. Maak dit oop om ’n nuwe wagwoord te kies.',
          resetSent:'Terugstelskakel gestuur — kyk in jou inpos.', mismatch:'Daardie twee wagwoorde stem nie ooreen nie.',
          savingPass:'Besig om jou nuwe wagwoord te stoor…', passSaved:'Wagwoord verander — jy word ingeteken…',
          recoverExpired:'Daardie skakel het verval. Vra ’n nuwe een aan.' }
  };
  /* Messages are remembered by KEY, not by the text already on screen: switching
     language with a message showing ("Email sent — check your inbox.") otherwise
     left an English line under an Afrikaans card — the half-translated look this
     codebase keeps having to hunt down. */
  var MSG_KEY = null, MSG_KIND = '';
  function msgK(key, kind){ MSG_KIND = kind || ''; msg(T()[key], kind); MSG_KEY = key; }
  var AUTH_LANG = 'en';
  try { var _sl = localStorage.getItem('ai_auth_lang'); if (_sl === 'af' || _sl === 'en') AUTH_LANG = _sl; } catch (e) {}
  function T(){ return AUTH_T[AUTH_LANG] || AUTH_T.en; }
  function setAuthLang(l){
    AUTH_LANG = (l === 'af') ? 'af' : 'en';
    try { localStorage.setItem('ai_auth_lang', AUTH_LANG); } catch (e) {}
    applyAuthLang();
  }
  function _txt(id, s){ var el = document.getElementById(id); if (el) el.textContent = s; }
  function _ph(id, s){ var el = document.getElementById(id); if (el) el.placeholder = s; }
  function applyAuthLang(){
    var t = T(), pane = AUTH_MODE;
    _txt('ai-sub', pane === 'signup'  ? t.subUp
                 : pane === 'inbox'   ? (INBOX_KIND === 'reset' ? t.subReset : t.subInbox)
                 : pane === 'reset'   ? t.subReset
                 : pane === 'newpass' ? t.subNewPass
                 : t.subIn);
    _txt('ai-forgot', t.forgot); _txt('ai-rs-hint', t.rsHint);
    _txt('ai-reset', t.resetBtn); _txt('ai-reset-back', t.resetBack); _txt('ai-savepass', t.savePass);
    _ph('ai-rs-email', t.phEmail); _ph('ai-np-pass', t.phNewPass); _ph('ai-np-pass2', t.phNewPass);
    var rsL = document.querySelector('#ai-pane-reset label'); if (rsL) rsL.textContent = t.lblRsEmail;
    var npL = document.querySelectorAll('#ai-pane-newpass label');
    if (npL.length >= 2) { npL[0].textContent = t.lblNew; npL[1].textContent = t.lblNew2; }
    _txt('ai-tab-in', t.tabIn); _txt('ai-tab-up', t.tabUp);
    _txt('ai-signin', t.signin); _txt('ai-signup', t.signup);
    _txt('ai-su-hint', t.hint); _txt('ai-demo-q', t.demoQ); _txt('ai-demo', t.demo);
    _txt('ai-inbox-title', INBOX_KIND === 'reset' ? t.resetTitle : t.inboxTitle);
    _txt('ai-resend', t.resend); _txt('ai-inbox-back', t.back);
    _ph('ai-email', t.phEmail); _ph('ai-pass', t.phPass);
    _ph('ai-su-email', t.phEmail); _ph('ai-su-pass', t.phNewPass);
    var labs = document.querySelectorAll('#ai-pane-in label, #ai-pane-up label');
    if (labs.length >= 4) { labs[0].textContent = t.lblEmail; labs[1].textContent = t.lblPass;
                            labs[2].textContent = t.lblEmail; labs[3].textContent = t.lblNewPass; }
    var b = document.getElementById('ai-inbox-body');
    if (b) b.innerHTML = (INBOX_KIND === 'reset' ? t.resetBody1 : t.inboxBody1) +
                         '<b id="ai-inbox-email">' + _esc(AUTH_EMAIL) + '</b>' +
                         (INBOX_KIND === 'reset' ? t.resetBody2 : t.inboxBody2);
    var en = document.getElementById('ai-lang-en'), af = document.getElementById('ai-lang-af');
    if (en) en.className = (AUTH_LANG === 'en') ? 'on' : '';
    if (af) af.className = (AUTH_LANG === 'af') ? 'on' : '';
    if (MSG_KEY && t[MSG_KEY]) { var mEl = document.getElementById('ai-msg');
      if (mEl) { mEl.textContent = t[MSG_KEY]; mEl.className = 'msg ' + MSG_KIND; } }
  }
  function _esc(s){ return String(s || '').replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  var AUTH_MODE = 'signin', AUTH_EMAIL = '', INBOX_KIND = 'signup';
  function setMode(m){
    AUTH_MODE = m;
    var show = function(id, on){ var el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('ai-pane-in',      m === 'signin');
    show('ai-pane-up',      m === 'signup');
    show('ai-pane-inbox',   m === 'inbox');
    show('ai-pane-reset',   m === 'reset');
    show('ai-pane-newpass', m === 'newpass');
    /* Tabs only make sense while choosing between signing in and signing up. Mid-
       confirmation, mid-reset, or on the new-password screen they are a way to lose
       your place. */
    show('ai-tabs',       m === 'signin' || m === 'signup');
    /* Nor should "look around the demo" sit under a half-finished password reset. */
    var demoBox = document.getElementById('ai-demo-q');
    if (demoBox && demoBox.parentNode) demoBox.parentNode.style.display = (m === 'newpass') ? 'none' : '';
    var ti = document.getElementById('ai-tab-in'), tu = document.getElementById('ai-tab-up');
    if (ti) ti.className = 'tab' + (m === 'signin' ? ' on' : '');
    if (tu) tu.className = 'tab' + (m === 'signup' ? ' on' : '');
    MSG_KEY = null; msg('');
    applyAuthLang();
  }

  function _validEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }

  function doSignUp(){
    try { localStorage.removeItem('ai_guest'); window.__AI_GUEST = false; } catch (e) {}
    var t = T(), btn = document.getElementById('ai-signup');
    var email = (document.getElementById('ai-su-email').value || '').trim();
    var pass  = document.getElementById('ai-su-pass').value || '';
    if (!_validEmail(email)) { msgK('badEmail', 'err'); return; }
    if (pass.length < 8)     { msgK('shortPass', 'err'); return; }
    btn.disabled = true; msgK('creating', 'ok');
    AI.auth.signUp(email, pass).then(function (r) {
      btn.disabled = false;
      AUTH_EMAIL = email;
      if (r && r.session) { return enterApp(); }   // only if confirmation is ever turned off
      /* Deliberately NOT branching on r.already: showing a different screen for an
         address that is already registered would leak exactly what Supabase's
         anti-enumeration behaviour is protecting. Everyone sees the same screen,
         and the "Already confirmed? Sign in" button is the way out. */
      setMode('inbox'); msgK('sent', 'ok');
    }).catch(function (e) {
      btn.disabled = false;
      var raw = (e && e.message) ? e.message : '';
      if (_isOfflineErr(e)) { msgK('offline', 'err'); } else { msg(raw || 'Could not create your account.', 'err'); }
    });
  }

  function doReset(){
    var t = T(), btn = document.getElementById('ai-reset');
    var email = (document.getElementById('ai-rs-email').value || '').trim();
    if (!_validEmail(email)) { msgK('badEmail', 'err'); return; }
    btn.disabled = true; msg('…', 'ok');
    AI.auth.resetPassword(email).then(function () {
      btn.disabled = false;
      AUTH_EMAIL = email; INBOX_KIND = 'reset';
      /* Same screen as sign-up confirmation, different words. Shown whether or not
         the address exists — telling someone "no such account" is exactly the
         enumeration leak the sign-up flow already avoids. */
      setMode('inbox'); msgK('resetSent', 'ok');
    }).catch(function (e) {
      btn.disabled = false;
      var raw = (e && e.message) ? e.message : '';
      if (_isOfflineErr(e)) { msgK('offline', 'err'); } else { msg(raw || 'Could not send the email.', 'err'); }
    });
  }

  function doSavePassword(){
    var t = T(), btn = document.getElementById('ai-savepass');
    var p1 = document.getElementById('ai-np-pass').value || '';
    var p2 = document.getElementById('ai-np-pass2').value || '';
    if (p1.length < 8) { msgK('shortPass', 'err'); return; }
    if (p1 !== p2)     { msgK('mismatch', 'err'); return; }
    btn.disabled = true; msgK('savingPass', 'ok');
    AI.auth.updatePassword(p1).then(function () {
      msgK('passSaved', 'ok');
      /* The recovery link already signed them in, so there is nothing left to ask
         for. Drop the token out of the address bar first — a reset link left in
         history is a live credential. */
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      RECOVERY = false;
      return enterApp();
    }).catch(function (e) {
      btn.disabled = false;
      var raw = (e && e.message) ? e.message : '';
      if (_isOfflineErr(e)) { msgK('offline', 'err'); }
      else if (/session|expired|token/i.test(raw)) { msgK('recoverExpired', 'err'); }
      else { msg(raw || 'Could not change your password.', 'err'); }
    });
  }

  var RESEND_AT = 0, RESEND_TIMER = null;
  function doResend(){
    var t = T(), btn = document.getElementById('ai-resend');
    var left = Math.ceil((RESEND_AT - Date.now()) / 1000);
    if (left > 0) { msg(t.wait + left + t.waitSuffix, 'err'); return; }
    btn.disabled = true;
    /* One button, two jobs — whichever email brought the farmer to this screen. */
    var again = (INBOX_KIND === 'reset')
      ? AI.auth.resetPassword(AUTH_EMAIL)
      : AI.auth.resendConfirm(AUTH_EMAIL);
    again.then(function () {
      msgK(INBOX_KIND === 'reset' ? 'resetSent' : 'resent', 'ok');
      RESEND_AT = Date.now() + 60000;             // Supabase rate-limits these server-side too
      var tick = function () {
        var s = Math.ceil((RESEND_AT - Date.now()) / 1000);
        if (s > 0) { btn.textContent = T().resend + ' (' + s + ')'; }
        else { btn.textContent = T().resend; btn.disabled = false; clearInterval(RESEND_TIMER); RESEND_TIMER = null; }
      };
      tick(); if (RESEND_TIMER) clearInterval(RESEND_TIMER); RESEND_TIMER = setInterval(tick, 1000);
    }).catch(function (e) {
      btn.disabled = false;
      msg((e && e.message) ? e.message : 'Could not send the email.', 'err');
    });
  }
  function hideOverlay() {
    var o = document.getElementById('ai-auth');
    if (o) o.style.display = 'none';
    // Sign-out now lives in the header avatar menu (appSignOut) — no floating button.
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

  /* One door into the app, so the three ways a session can appear — an existing
     session at boot, a password sign-in, and the confirmation link coming back
     from the farmer's inbox — cannot double-hydrate each other. */
  /* Did the farmer arrive on a password-reset link? Read at load, BEFORE supabase-js
     parses and strips the fragment. A recovery link carries a real session, so without
     this flag the ordinary "session appeared → go into the app" path would swallow it
     and the farmer would never get to type a new password. */
  var RECOVERY = /(^|[#&])type=recovery/.test(window.location.hash || '');

  var _entering = false;
  function enterApp(){
    if (_entering) return Promise.resolve();
    _entering = true;
    return hydrate().then(hideOverlay).catch(function (e) { _entering = false; throw e; });
  }

  // ---- sign in -------------------------------------------------------------
  function doSignIn() {
    // Signing in with a real account always leaves guest mode behind.
    try { localStorage.removeItem('ai_guest'); window.__AI_GUEST = false; } catch (e) {}
    var btn = document.getElementById('ai-signin');
    var email = (document.getElementById('ai-email').value || '').trim();
    var pass = document.getElementById('ai-pass').value || '';
    if (!email || !pass) { msgK('needBoth', 'err'); return; }
    btn.disabled = true; msg('Signing in…', 'ok');
    AI.auth.signIn(email, pass)
      .then(function () { return enterApp(); })
      .catch(function (e) {
        btn.disabled = false;
        var raw = (e && e.message) ? e.message : '';
        var offline = !navigator.onLine || /failed to fetch|networkerror|load failed|fetch/i.test(raw);
        if (offline) {
          msgK('offline', 'err');
        } else {
          msg(raw || 'Sign-in failed. Check your details.', 'err');
        }
      });
  }

  // ---- ensure a farm, load its data into ST, re-render ---------------------
  /* The signed-in user's id, read from the persisted session. Used to tell whether
     the data already on this device belongs to the account that is signing in. */
  function _sessionUid(){
    try{
      for (var i=0;i<localStorage.length;i++){
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k)) {
          var v = JSON.parse(localStorage.getItem(k) || '{}');
          return (v.user && v.user.id) || (v.currentSession && v.currentSession.user && v.currentSession.user.id) || null;
        }
      }
    }catch(e){}
    return null;
  }

  function hydrate(opts) {
    opts = opts || {};
    var isNewFarm = false, needOnboarding = false, activeRow = null;
    /* getUser() waits for supabase-js to finish initialising, which guarantees the
       token is attached to what follows. Without it, the farm query could go out
       before the session was applied; RLS then answers with an EMPTY LIST rather
       than an error, which is indistinguishable from "brand-new user" — and the
       branch below would create a farm. That is how one test account ended up with
       three farms, two of them empty "My Farm" duplicates that hid the real one. */
    return AI.auth.currentUser().catch(function(){ return null; }).then(function () {
      return AI.farm.mine();
    }).then(function (farms) {
      /* Still empty? Ask once more before concluding this is a new user. Creating a
         farm is not reversible from inside the app, so a transient empty answer must
         never be enough on its own. */
      if (!farms || !farms.length) {
        return AI.farm.mine().catch(function(){ return []; }).then(function (retry) {
          if (retry && retry.length) return retry;
          isNewFarm = true;
          return AI.farm.create('My Farm').then(function(){ return null; });
        });
      }
      return farms;
    }).then(function (farms) {
      if (!farms || !farms.length) { return AI.farm.active(); }   // just created one
      /* The active-farm pointer is stored per BROWSER, so it outlives a sign-out and
         can name a farm this account cannot see. Every read then comes back empty and
         every write fails against RLS, with nothing on screen to explain why. The
         server's list is the authority. */
      var act = AI.farm.active(), ok = false;
      for (var i = 0; i < farms.length; i++) { if (farms[i].id === act) { ok = true; break; } }
      if (!ok) {
        /* Choosing a default on a device with no usable pointer: prefer a farm that
           has actually been set up (owner_name is written when onboarding finishes)
           over an auto-created empty "My Farm". A farmer signing in on a second
           device should land on their records, not on a blank duplicate. */
        var pick = null;
        for (var k = 0; k < farms.length; k++) { if (farms[k].owner_name) { pick = farms[k]; break; } }
        AI.farm.setActive((pick || farms[0]).id);
      }
      act = AI.farm.active();
      for (var j = 0; j < farms.length; j++) { if (farms[j].id === act) { activeRow = farms[j]; break; } }
      return act;
    }).then(function () {
      /* Whose data is already sitting on this device? A mismatch means the demo seed
         or another farmer's records are in the stores, and the server payloads below
         will NOT clear them on their own: the per-module apply steps deliberately keep
         local rows when the server returns none, so an empty (new) farm leaves every
         demo herd, block, worker and plan in place. */
      var fid = AI.farm.active(), uid = _sessionUid(), sameU = false, sameF = false;
      try {
        sameU = (localStorage.getItem('ai_state_uid')  === uid);
        sameF = (localStorage.getItem('ai_state_farm') === fid);
      } catch(e){}
      if (isNewFarm || !sameU || !sameF) {
        try { if (typeof window.aiAccountReset === 'function') window.aiAccountReset(); } catch(e){}
      }
      try { localStorage.setItem('ai_state_uid', uid || ''); localStorage.setItem('ai_state_farm', fid || ''); } catch(e){}
      return AI.load.financeCore(fid);
    }).then(function (core) {
      // Replace the app's working data with the farm's real data.
      if (window.ST) { ST.txns = (window.preservePendingTxns ? window.preservePendingTxns(core.txns || []) : (core.txns || [])); ST.recurring = core.recurring || []; if (core.budgets) ST.budgets = core.budgets; if (core.batches) ST.importBatches = core.batches;
        /* Has this farmer ever been through setup? A farm auto-created at first
           sign-in has no owner_name until obFinish saves one, so "no owner AND no
           transactions" is an un-onboarded farm on any device. Requiring the empty
           ledger too keeps an established farm (whose owner_name predates the
           profile push) from being handed a setup wizard it does not need. */
        needOnboarding = isNewFarm || !!(activeRow && !activeRow.owner_name && !(core.txns || []).length);
        if (needOnboarding) { try { if (typeof window.aiShowOnboarding === 'function') window.aiShowOnboarding(); } catch(e){} }
        else { ST.firstRun = false; }
      }
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
      /* Signed-in users skip the app's first-run onboarding wizard — UNLESS they have
         never been through it. This step used to hide the wizard unconditionally, which
         was right when every account was provisioned by hand (the farm was already set
         up for them). With self-serve sign-up it meant no farmer ever saw onboarding:
         it ran a moment after aiShowOnboarding() and closed it again, so they landed on
         the dashboard with no farm name, no farm type and — the serious part — no POPIA
         consent ever recorded. */
      try {
        if (!needOnboarding) {
          var ov = document.getElementById('ob-overlay');
          if (ov) ov.style.display = 'none';
        }
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
      // Guest demo mode (?demo=1 / ai_guest flag): no login, no backend. Hide the sign-in
      // overlay and hand off to the app's guarded demo runtime. Never calls getSession /
      // signIn / setActive, so _hasBackend() stays false and nothing reaches Supabase.
      if (window.__AI_GUEST) {
        var od = document.getElementById('ai-auth'); if (od) od.style.display = 'none';
        try { if (typeof window.aiDemoStart === 'function') window.aiDemoStart(); } catch (e) {}
        return;
      }
      // Offline boot with a cached session: don't trap the user on a login they can't
      // complete offline — reveal their already-loaded local data.
      if (navigator.onLine === false && _hasPersistedSession()) { _offlineReveal(); return; }
      /* The confirmation link returns to this page with the session in the URL
         fragment. supabase-js is on the implicit flow with detectSessionInUrl,
         so it parses that itself — but the parse finishes asynchronously, after
         getSession() below may already have answered "no session". This listener
         is what actually lets a farmer through on the confirmation bounce, and
         enterApp()'s guard keeps it from racing the getSession path. */
      try {
        AI.init().auth.onAuthStateChange(function (evt, session) {
          if (!session) return;
          var ov = document.getElementById('ai-auth');
          if (!ov || ov.style.display === 'none') return;   // already inside the app
          /* A recovery session means "prove you can read this inbox", not "you are
             signed in" — send them to the new-password screen instead of the app. */
          if (evt === 'PASSWORD_RECOVERY' || RECOVERY) { RECOVERY = true; setMode('newpass'); return; }
          enterApp().catch(function () {});
        });
      } catch (e) {}
      AI.init().auth.getSession().then(function (res) {
        var session = res && res.data ? res.data.session : null;
        if (session && RECOVERY) { setMode('newpass'); return; }
        if (session) {
          enterApp().catch(function (e) {
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
    if (window.__AI_GUEST) return;                                            // guest demo: never pull account data into the sandbox
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
