/* ============================================================================
 * AgriInsights — Login Gate + Startup Load  (ai-auth.js)
 * Self-contained: injects its own sign-in overlay, and AFTER sign-in loads the
 * farm's transactions from Supabase into ST.txns and re-renders the app.
 * Does NOT modify bootAgriInsights() or loadState() — it layers on top.
 * Load order in <head>:  supabase-js  ->  ai-data.js  ->  ai-auth.js
 * ========================================================================== */
(function () {
  'use strict';

  /* -495 (B10 item 7, the persistence fix): the herds, blocks, plan lines and co-op accounts arrive whole from the server. A
     server that has no column for Planning's own fields yet (sa-b10-bmb.sql not run) sends none of them, so replacing the
     list would wipe the farmer's pay timing on this device: those fields are kept from this device instead. With the column
     the server's copy is the truth (ai-data carried this device's fields onto it once, on the first load after the release). */
  function _bmbKeepLocal(incoming, local, area) {
    try {
      if (!Array.isArray(incoming) || !Array.isArray(local) || !local.length) return 0;
      var caps = (window.AI && AI.bmbCaps) ? AI.bmbCaps() : {}, K = (window.AI && AI.bmbKeys) || null; if (!K || caps[area]) return 0;
      var keyOf = (area === 'plan') ? K.plKey : function (x) { return String(x.id); };
      var want = function (k) {
        if (area === 'herds') return /^p[A-Z]/.test(k) || k === 'plan' || K.herd.indexOf(k) >= 0;
        if (area === 'plan') return K.crop.indexOf(k) >= 0 || k === 'plan';
        if (area === 'orchard') return K.block.indexOf(k) >= 0;
        return K.coop.indexOf(k) >= 0; };
      var byK = {}, n = 0; local.forEach(function (x) { if (x) byK[keyOf(x)] = x; });
      incoming.forEach(function (x) { var l = x && byK[keyOf(x)]; if (!l) return;
        Object.keys(l).forEach(function (k) { if (!want(k) || l[k] == null || x[k] != null) return; x[k] = JSON.parse(JSON.stringify(l[k])); n++; }); });
      return n;
    } catch (e) { return 0; }
  }
  /* the one-time push: an area whose server copy took this device's fields is saved once, now */
  function _bmbPushNow(only) {
    try {
      var m = window.__AI_BMB_PUSH; if (!m || window.__AI_GUEST || !(window.AI && AI.farm && AI.farm.active())) return;
      Object.keys(m).forEach(function (area) { if (only && area !== only) return; if (only == null && area === 'loans') return;
        var p = null;
        if (area === 'livestock' && AI.livestock && window.ST_LS) p = AI.livestock.saveAll(ST_LS);
        else if (area === 'orchard' && AI.orchard && window.ST_FRUIT) p = AI.orchard.saveAll(ST_FRUIT);
        else if (area === 'plan' && AI.plan && window.ST_PLAN) p = AI.plan.saveAll(ST_PLAN);
        else if (area === 'loans' && AI.loans && window.ST_LOANS) p = AI.loans.saveAll(ST_LOANS);
        delete m[area]; if (p && p.catch) p.catch(function (e) { console.error('Planning fields: one-time push failed (' + area + ')', e); }); });
    } catch (e) {}
  }
  window.__aiBmbKeepLocal = _bmbKeepLocal; window.__aiBmbPushNow = _bmbPushNow;   /* -495: 06-tools/sa-bmb-495-harness.html */

  var FOREST = '#1F4D2C', GOLD = '#C8962C', CREAM = '#F7F6F1', INK = '#1A2622';

  // ---- styles + overlay injected on DOM ready ------------------------------
  /* -514 O1 / O2 (owner sign-off 14-15 Nov 2026): the welcome is a split screen - the promise, a real AgriInsights
     screen as proof and three trust lines on the left (SA: POPIA only); the card on the right with "Create your farm"
     first for a new visitor, Sign in second, the gold "Explore a sample farm", and the EN / AF switch that carries
     through. "Check your email" shows the address with "Wrong address? Change it", Open Gmail / Open Outlook and a
     30-second resend. Every id the sign-in code uses is kept, so sign-in, sign-up, reset, the demo and the -513e
     behaviour are unchanged underneath. Wording: the signed-off prototype strings (AUTH_W, EN + AF). */
  var AUTH_W = {"c.or":["or","of"],"c.privacy":["Privacy policy","Privaatheidsbeleid"],"c.terms":["Terms of use","Gebruiksvoorwaardes"],"w.promise1":["Every rand on your farm,","Elke rand op jou plaas,"],"w.promise2":["clear in minutes.","duidelik binne minute."],"w.sub":["See each month whether the farm is making money, where it goes, and what is due to SARS. Without the paperwork.","Sien elke maand of die plaas geld maak, waarheen dit gaan, en wat aan SARS betaal moet word. Sonder die papierwerk."],"w.samplePill":["Sample farm","Voorbeeldplaas"],"w.chipK":["Is my farm profitable?","Is my plaas winsgewend?"],"w.chipV":["Yes · 27,1% margin","Ja · 27,1% marge"],"w.healthy":["Healthy","Gesond"],"w.proofCap":["The real app, showing the Doringkloof sample farm","Die regte program, met die Doringkloof-voorbeeldplaas"],"w.t1b":["Made for SA farms","Gemaak vir SA-plase"],"w.t1s":["VAT201, provisional tax and rand built in","BTW201, voorlopige belasting en rand ingebou"],"w.t2b":["Your data is yours","Jou data is joune"],"w.t2s":["Protected under POPIA","Beskerm onder POPIA"],"w.t3b":["On your phone too","Ook op jou foon"],"w.t3s":["Works where the signal is weak","Werk waar die sein swak is"],"w.tabCreate":["Create your farm","Skep jou plaas"],"w.tabSignin":["Sign in","Teken in"],"w.createH":["Create your farm","Skep jou plaas"],"w.createP":["Set up your farm within minutes.","Stel jou plaas binne minute op."],"w.changeP":["Type the right address. We’ll send the link there instead.","Tik die regte adres. Ons stuur die skakel eerder soontoe."],"w.email":["Email","E-pos"],"w.password":["Password","Wagwoord"],"w.phEmail":["you@farm.co.za","jy@plaas.co.za"],"w.show":["Show","Wys"],"w.hide":["Hide","Versteek"],"w.showPass":["Show password","Wys wagwoord"],"w.hidePass":["Hide password","Versteek wagwoord"],"w.passHint":["At least 8 characters","Minstens 8 karakters"],"w.createBtn":["Create your farm","Skep jou plaas"],"w.sampleBtn":["Explore a sample farm","Verken ’n voorbeeldplaas"],"w.sampleSub":["No account needed. Nothing is saved.","Geen rekening nodig nie. Niks word gestoor nie."],"w.fine":["You read and accept our {privacy} and {terms} during setup.","Jy lees en aanvaar ons {privacy} en {terms} tydens die opstelling."],"w.creating":["Creating your account…","Besig om jou rekening te skep…"],"w.needBoth":["Enter your email and password.","Voer jou e-pos en wagwoord in."],"w.emailEmpty":["Enter your email address.","Voer jou e-posadres in."],"w.passEmpty":["Enter a password.","Voer ’n wagwoord in."],"w.badEmail":["That doesn’t look like an email address. Check for a missing .co.za or .com.","Dit lyk nie soos ’n e-posadres nie. Kyk of .co.za of .com kort."],"w.emailLong":["That email address is too long. Check it.","Daardie e-posadres is te lank. Kyk dit na."],"w.shortPass":["Too short. Use at least 8 characters.","Te kort. Gebruik ten minste 8 karakters."],"w.longPass":["Use 128 characters or fewer.","Gebruik 128 karakters of minder."],"w.exists":["There is already a farm with this email.","Daar is reeds ’n plaas met hierdie e-pos."],"w.existsLink":["Sign in instead","Teken eerder in"],"w.signinH":["Welcome back","Welkom terug"],"w.signinP":["Sign in to your farm","Teken in by jou plaas"],"w.phPass":["Your password","Jou wagwoord"],"w.forgot":["Forgot password?","Wagwoord vergeet?"],"w.signinBtn":["Sign in","Teken in"],"w.signing":["Signing in…","Besig om in te teken…"],"w.noMatch":["That email and password don’t match. Check them, or reset your password.","Daardie e-pos en wagwoord pas nie. Kyk hulle na, of stel jou wagwoord terug."],"w.needSignin":["Sign in to carry on.","Teken in om voort te gaan."],"w.signedOut":["You’re signed out. Your records are safe.","Jy is uitgeteken. Jou rekords is veilig."],"w.resetH":["Reset your password","Stel jou wagwoord terug"],"w.resetHint":["We’ll email you a link to choose a new password.","Ons stuur vir jou ’n skakel om ’n nuwe wagwoord te kies."],"w.resetBtn":["Email me a reset link","Stuur vir my ’n terugstelskakel"],"w.resetBack":["Back to sign in","Terug na teken in"],"w.resetSentH":["Check your email","Kyk in jou e-pos"],"w.resetSentP":["If there’s a farm with {email}, we’ve sent it a link to choose a new password.","As daar ’n plaas met {email} is, het ons ’n skakel gestuur om ’n nuwe wagwoord te kies."],"w.newPassH":["Choose a new password","Kies ’n nuwe wagwoord"],"w.newPass":["New password","Nuwe wagwoord"],"w.newPass2":["Type it again","Tik dit weer"],"w.savePass":["Save new password","Stoor nuwe wagwoord"],"w.mismatch":["Those two passwords are not the same.","Daardie twee wagwoorde stem nie ooreen nie."],"w.savingPass":["Saving your new password…","Besig om jou nuwe wagwoord te stoor…"],"w.passSaved":["Password changed. Signing you in…","Wagwoord verander. Jy word ingeteken…"],"w.resetExpired":["That reset link has expired. Ask for a new one.","Daardie skakel het verval. Vra ’n nuwe een aan."],"e.promise1":["One quick check,","Een vinnige kontrole,"],"e.promise2":["then your farm.","dan jou plaas."],"e.n1":["Account created","Rekening geskep"],"e.n2":["Confirm your email","Bevestig jou e-pos"],"e.n2s":["So only you can get into your farm’s records.","Sodat net jy by jou plaas se rekords kan kom."],"e.n3":["Tell us about your farm","Vertel ons van jou plaas"],"e.n3s":["About two minutes. Then you are in.","Omtrent twee minute. Dan is jy in."],"e.h":["Check your email","Kyk in jou e-pos"],"e.p":["We sent a link to confirm it is you. Open it on this computer or your phone.","Ons het ’n skakel gestuur om te bevestig dat dit jy is. Maak dit op hierdie rekenaar of jou foon oop."],"e.wrong":["Wrong address?","Verkeerde adres?"],"e.changeIt":["Change it","Verander dit"],"e.gmail":["Open Gmail","Maak Gmail oop"],"e.outlook":["Open Outlook","Maak Outlook oop"],"e.spam":["Nothing there? Look in spam or junk.","Niks daar nie? Kyk in jou gemorspos."],"e.resend":["Send it again","Stuur die e-pos weer"],"e.resendIn":["in {t}","oor {t}"],"e.resent":["Sent again. Check your inbox.","Weer gestuur. Kyk in jou inpos."],"e.already":["Already confirmed? Sign in","Reeds bevestig? Teken in"],"e.confirmed":["Email confirmed. Let’s set up your farm.","E-pos bevestig. Kom ons stel jou plaas op."],"e.notYet":["Confirm your email first. We sent the link to {email}.","Bevestig eers jou e-pos. Ons het die skakel na {email} gestuur."]};
  function W(k, v){ var e = AUTH_W[k]; if (!e) return k; var s = (AUTH_LANG === 'af' && e[1]) ? e[1] : e[0];
    if (v) s = s.replace(/\{(\w+)\}/g, function(m, n){ return (n in v) ? v[n] : m; }); return s; }
  var WI = {
    arrow: '<svg class="i" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    check: '<svg class="i" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    eye: '<svg class="i" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    compass: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
    trend: '<svg class="i" viewBox="0 0 24 24" style="width:20px;height:20px;stroke-width:2.4"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    pin: '<svg class="i" viewBox="0 0 24 24" style="width:17px;height:17px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    shield: '<svg class="i" viewBox="0 0 24 24" style="width:17px;height:17px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    phone: '<svg class="i" viewBox="0 0 24 24" style="width:17px;height:17px"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
    mail: '<svg class="i" viewBox="0 0 24 24" style="color:#2D6A4F"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>',
    ext: '<svg class="i" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
  };
  function _known(){ try { return localStorage.getItem('ai_ob5_known') === '1'; } catch (e) { return false; } }
  function _landingMode(){ return _known() ? 'signin' : 'signup'; }   /* O1: "Create your farm" first for a new visitor */
  function _pwField(id, auto, ph){
    return '<div class="inwrap"><input class="inp" id="' + id + '" type="password" autocomplete="' + auto + '" placeholder="' + ph + '" maxlength="300">' +
      '<button type="button" class="side" data-pw="' + id + '" aria-pressed="false">' + WI.eye + '<span></span></button></div>';
  }
  /* The welcome's pictures never hold up the page's load event (the app's own boot, the guest sandbox's seed and a
     signed-in farmer's return all wait for it): they are set for a visitor at once, for everyone else after load. */
  function _wImgs(){
    var o = document.getElementById('ai-auth'); if (!o || o.classList.contains('imgs')) return;
    o.classList.add('imgs');
    Array.prototype.forEach.call(o.querySelectorAll('img[data-src]'), function(i){ i.src = i.getAttribute('data-src'); });
  }
  function injectUI() {
    var css = document.createElement('style');
    css.textContent =
      '#ai-auth{position:fixed;inset:0;z-index:99999;display:flex;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
      '#ai-auth>.wl{flex:1;min-width:0}' +
      '#ai-auth .card{background:none;border:0;box-shadow:none;padding:0;width:auto;max-width:none;border-radius:0}' +
      '#ai-auth .msg{margin-top:14px;font-size:13.5px;min-height:0;line-height:1.5}#ai-auth .msg:empty{display:none}' +
      '#ai-auth .msg.err{color:#A32D2D}#ai-auth .msg.ok{color:' + FOREST + '}' +
      '#ai-auth.imgs .proof-img{background:url(img/ob5/proof-sa.jpg) 0 0/100% auto no-repeat}#ai-auth.imgs.af .proof-img{background-image:url(img/ob5/proof-sa-af.jpg)}#ai-auth .proof-img{background-color:#EEF2EC}' +   /* C6: the Afrikaans card shows the app in Afrikaans */
      '#ai-auth:not(.imgs) .wl-left::before{background-image:none}' +
      '#ai-auth .inbox-pic{display:block;margin:0 auto;width:120px;height:96px}' +
      '#ai-auth .resend .cd{display:inline-flex;align-items:center;gap:6px;font-weight:700;color:#6B7280;background:#ECEAE2;border-radius:20px;padding:3px 10px;margin-left:4px}' +
      '#ai-auth #ai-resend{margin-top:10px}' +
      '#ai-auth .forgot{text-align:right;margin-top:10px}' +
      '#ai-auth .wl-form :focus-visible,#ai-auth .wl-top :focus-visible{outline:3px solid #2D6A4F !important;outline-offset:2px !important}' +
      '#ai-auth .wl-left :focus-visible{outline:3px solid #95D5B2 !important;outline-offset:2px !important}' +
      '#ai-auth .fine .lnk{font-size:12.5px;font-weight:700}' +
      '#ai-auth .btn:disabled{opacity:.65;cursor:default}' +
      '@keyframes aiOpenSpin{to{transform:rotate(360deg)}}' +
      '#ai-signout{position:fixed;bottom:14px;left:14px;z-index:99998;background:' + FOREST +
        ';color:#fff;border:0;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;' +
        'font-family:"Plus Jakarta Sans",sans-serif;cursor:pointer;opacity:.85;}';
    document.head.appendChild(css);

    var left =
      '<section class="wl-left" id="ai-left" aria-label="AgriInsights">' +
        '<div class="brandrow"><div class="bm"><img data-src="img/logomark.png?v=225" alt=""></div><div class="bn">Agri<span>Insights</span></div></div>' +
        '<div id="ai-left-main" style="display:flex;flex-direction:column;flex:1;min-height:0">' +
          '<h1 class="promise"><span id="ai-w-p1"></span> <em id="ai-w-p2"></em></h1>' +
          '<p class="promise-sub" id="ai-w-sub"></p>' +
          '<figure class="proof"><div class="proof-frame"><div class="proof-bar"><img data-src="img/logomark.png?v=225" alt="">Doringkloof Boerdery<span class="pill" id="ai-w-pill"></span></div>' +
            '<div class="proof-img" role="img" id="ai-w-img"></div></div>' +
            '<div class="proof-chip"><div class="ic">' + WI.trend + '</div><div><div class="k" id="ai-w-chipk"></div><div class="v"><span id="ai-w-chipv" style="all:unset"></span><span id="ai-w-healthy"></span></div></div></div></figure>' +
          '<figcaption class="proof-cap" id="ai-w-cap"></figcaption>' +
        '</div>' +
        '<div id="ai-left-inbox" style="display:none;margin:auto 0"><h1 class="promise" style="font-size:40px;margin-top:0"><span id="ai-e-p1"></span> <em id="ai-e-p2"></em></h1>' +
          '<ol class="next3" style="list-style:none"><li class="n3 done"><div class="c">' + WI.check.replace('class="i"', 'class="i" style="width:16px;height:16px;stroke-width:3"') + '</div><div><b id="ai-e-n1"></b><span id="ai-e-n1s"></span></div></li>' +
          '<li class="n3 on" aria-current="step"><div class="c">2</div><div><b id="ai-e-n2"></b><span id="ai-e-n2s"></span></div></li>' +
          '<li class="n3"><div class="c">3</div><div><b id="ai-e-n3"></b><span id="ai-e-n3s"></span></div></li></ol></div>' +
        '<div class="trust"><div class="tr"><div class="ti">' + WI.pin + '</div><b id="ai-w-t1b"></b><span id="ai-w-t1s"></span></div>' +
          '<div class="tr"><div class="ti">' + WI.shield + '</div><b id="ai-w-t2b"></b><span id="ai-w-t2s"></span></div>' +
          '<div class="tr"><div class="ti">' + WI.phone + '</div><b id="ai-w-t3b"></b><span id="ai-w-t3s"></span></div></div>' +
      '</section>';
    var right =
      '<section class="wl-right">' +
        '<div class="wl-top"><div class="langsw" role="group" aria-label="Language / Taal"><button type="button" id="ai-lang-en" lang="en" aria-pressed="true">English</button><button type="button" id="ai-lang-af" lang="af" aria-pressed="false">Afrikaans</button></div></div>' +
        '<div class="wl-form card" role="dialog" aria-modal="true" aria-labelledby="ai-h1">' +
          '<div class="seg" role="tablist" id="ai-tabs">' +
            '<button type="button" role="tab" class="tab" id="ai-tab-up" aria-selected="false">Create your farm</button>' +
            '<button type="button" role="tab" class="tab on" id="ai-tab-in" aria-selected="true">Sign in</button>' +
          '</div>' +
          '<h2 class="wl-h" id="ai-h1" tabindex="-1">AgriInsights</h2>' +
          '<p class="wl-p sub" id="ai-sub">Sign in to your farm</p>' +
          /* sign-in pane (ids unchanged) */
          '<div id="ai-pane-in">' +
            '<div class="f" style="margin-top:22px"><label class="fl" for="ai-email">Email</label><input class="inp" id="ai-email" type="email" autocomplete="username" spellcheck="false" placeholder="you@farm.co.za" maxlength="400"/></div>' +
            '<div class="f" style="margin-top:18px"><label class="fl" for="ai-pass">Password</label>' + _pwField('ai-pass', 'current-password', 'Your password') + '</div>' +
            '<div class="forgot"><button type="button" id="ai-forgot" class="lnk" style="font-size:13.5px">Forgot password?</button></div>' +
            '<button id="ai-signin" class="btn btn-pri full" style="margin-top:16px;height:54px">Sign in</button>' +
          '</div>' +
          /* forgot password */
          '<div id="ai-pane-reset" style="display:none">' +
            '<div class="f" style="margin-top:22px"><label class="fl" for="ai-rs-email">Email</label><input class="inp" id="ai-rs-email" type="email" autocomplete="username" spellcheck="false" placeholder="you@farm.co.za" maxlength="400"/></div>' +
            '<div class="fh" id="ai-rs-hint">We’ll email you a link to choose a new password.</div>' +
            '<button id="ai-reset" class="btn btn-pri full" style="margin-top:20px;height:54px">Email me a reset link</button>' +
            '<p style="margin-top:20px"><button type="button" id="ai-reset-back" class="lnk">Back to sign in</button></p>' +
          '</div>' +
          /* the reset link lands here */
          '<div id="ai-pane-newpass" style="display:none">' +
            '<div class="f" style="margin-top:22px"><label class="fl" for="ai-np-pass">New password</label>' + _pwField('ai-np-pass', 'new-password', 'At least 8 characters') + '</div>' +
            '<div class="f" style="margin-top:18px"><label class="fl" for="ai-np-pass2">Type it again</label>' + _pwField('ai-np-pass2', 'new-password', 'At least 8 characters') + '</div>' +
            '<button id="ai-savepass" class="btn btn-pri full" style="margin-top:20px;height:54px">Save new password</button>' +
          '</div>' +
          /* create your farm: two fields only */
          '<div id="ai-pane-up" style="display:none">' +
            '<div class="f" style="margin-top:22px"><label class="fl" for="ai-su-email">Email</label><input class="inp" id="ai-su-email" type="email" autocomplete="email" spellcheck="false" placeholder="you@farm.co.za" maxlength="400"/></div>' +
            '<div class="f" style="margin-top:18px"><label class="fl" for="ai-su-pass">Password</label>' + _pwField('ai-su-pass', 'new-password', '') +
              '<div class="fh" id="ai-su-hintrow">' + WI.check + '<span id="ai-su-hint">At least 8 characters</span></div></div>' +
            '<button id="ai-signup" class="btn btn-pri full" style="margin-top:22px;height:54px">Create your farm</button>' +
          '</div>' +
          /* check your email (O2) */
          '<div id="ai-pane-inbox" style="display:none">' +
            '<svg class="inbox-pic" viewBox="0 0 120 96" fill="none" aria-hidden="true"><rect x="10" y="22" width="100" height="66" rx="10" fill="#fff" stroke="#1B4332" stroke-width="2.5"/><path d="M12 28l48 34 48-34" stroke="#1B4332" stroke-width="2.5" stroke-linejoin="round"/><rect x="30" y="6" width="60" height="44" rx="6" fill="#D8F3DC" stroke="#2D6A4F" stroke-width="2"/><path d="M44 26l10 9 20-18" stroke="#1B4332" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 86l36-26M108 86L72 60" stroke="#1B4332" stroke-width="2.5"/></svg>' +
            '<h3 class="wl-h" id="ai-inbox-title" style="text-align:center;margin-top:18px;font-size:26px">Check your email</h3>' +
            '<p class="wl-p" id="ai-inbox-body" style="text-align:center"></p>' +
            '<div class="addr">' + WI.mail + '<div style="min-width:0"><div class="em" id="ai-inbox-email" style="overflow-wrap:anywhere;font-weight:400"></div><div id="ai-inbox-wrongrow" style="font-size:13px;color:#6B7280;margin-top:2px"><span id="ai-inbox-wrong">Wrong address?</span> <button type="button" class="lnk" id="ai-inbox-change" style="font-size:13px">Change it</button></div></div></div>' +
            '<div class="mailbtns"><button type="button" class="btn btn-sec" style="height:50px" id="ai-inbox-gmail">' + WI.ext + '<span>Open Gmail</span></button><button type="button" class="btn btn-sec" style="height:50px" id="ai-inbox-outlook">' + WI.ext + '<span>Open Outlook</span></button></div>' +
            '<div class="resend"><span id="ai-inbox-spam">Nothing there? Look in spam or junk.</span><br><button type="button" id="ai-resend" class="lnk">Send it again</button><span id="ai-resend-cd"></span></div>' +
            '<p style="margin-top:18px;text-align:center"><button type="button" id="ai-inbox-back" class="lnk" style="font-size:13.5px">Already confirmed? Sign in</button></p>' +
          '</div>' +
          /* -490 (B9 D2): a signed-in farmer is never shown the sign-in form while their farm loads */
          '<div id="ai-pane-open" style="display:none;text-align:center;padding:14px 0 4px">' +
            '<div style="width:26px;height:26px;margin:0 auto 12px;border:3px solid #cfe3d6;border-top-color:' + FOREST + ';border-radius:50%;animation:aiOpenSpin .8s linear infinite"></div>' +
            '<div id="ai-open-t" style="font-size:17px;font-weight:800;color:' + FOREST + '">Opening your farm…</div>' +
            '<div id="ai-open-s" style="font-size:12.5px;color:#6b716a;margin-top:4px">Getting your latest figures</div>' +
          '</div>' +
          '<div class="msg" id="ai-msg" role="alert" aria-live="assertive"></div>' +
          '<div id="ai-demo-wrap"><span id="ai-demo-q" hidden></span><div class="or" id="ai-or">or</div>' +
            '<button id="ai-demo" class="btn btn-gold full" style="height:52px">' + WI.compass + '<span id="ai-demo-l">Explore a sample farm</span></button>' +
            '<div class="gold-sub" id="ai-demo-sub">No account needed. Nothing is saved.</div></div>' +
        '</div>' +
        '<div class="wl-foot"><span class="fine" id="ai-fine" style="text-align:left;max-width:300px"></span></div>' +
      '</section>';
    var o = document.createElement('div');
    o.id = 'ai-auth'; o.className = 'ob5 aiw';
    o.innerHTML = '<div class="wl">' + left + right + '</div>';
    document.body.appendChild(o);

    document.getElementById('ai-signin').addEventListener('click', doSignIn);
    document.getElementById('ai-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
    document.getElementById('ai-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
    document.getElementById('ai-signup').addEventListener('click', doSignUp);
    document.getElementById('ai-su-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignUp(); });
    document.getElementById('ai-su-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignUp(); });
    document.getElementById('ai-tab-in').addEventListener('click', function(){ setMode('signin'); });
    document.getElementById('ai-tab-up').addEventListener('click', function(){ setMode('signup'); });
    /* arrows move between the two tabs (both stay in the Tab order) */
    document.getElementById('ai-tabs').addEventListener('keydown', function(e){
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
      var to = (AUTH_MODE === 'signup') ? 'signin' : 'signup'; setMode(to);
      var b = document.getElementById(to === 'signup' ? 'ai-tab-up' : 'ai-tab-in'); if (b) b.focus();
    });
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
    /* show / hide the password */
    Array.prototype.forEach.call(o.querySelectorAll('[data-pw]'), function(b){ b.addEventListener('click', function(){
      var i = document.getElementById(b.getAttribute('data-pw')); if (!i) return;
      var show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.setAttribute('aria-pressed', show ? 'true' : 'false'); applyAuthLang(); i.focus();
    }); });
    /* O2: wrong address -> Create your farm with the address filled in; the new submit sends a fresh link */
    document.getElementById('ai-inbox-change').addEventListener('click', function(){
      var se = document.getElementById('ai-su-email'); if (se) se.value = AUTH_EMAIL || se.value;
      setMode('signup'); _wChange = true; applyAuthLang(); if (se) { se.focus(); try { se.select(); } catch (e) {} }
    });
    document.getElementById('ai-inbox-gmail').addEventListener('click', function(){ try { var w = window.open('https://mail.google.com/', '_blank'); if (w) w.opener = null; } catch (e) {} });
    document.getElementById('ai-inbox-outlook').addEventListener('click', function(){ try { var w = window.open('https://outlook.live.com/mail/', '_blank'); if (w) w.opener = null; } catch (e) {} });
    document.getElementById('ai-fine').addEventListener('click', function(e){
      var b = e.target && e.target.closest ? e.target.closest('[data-pol]') : null; if (!b) return;
      try { if (typeof window.aiPolicyOpen === 'function') window.aiPolicyOpen(b.getAttribute('data-pol')); } catch (e2) {}
    });
    setMode(_landingMode());
    applyAuthLang();
    if (document.readyState === 'complete') _wImgs(); else window.addEventListener('load', function(){ setTimeout(_wImgs, 0); });
    /* The demo's "Create your farm →" leaves a flag so the farmer lands where they
       were heading — the sign-up form — instead of a sign-in card with no way on. */
    try {
      if (localStorage.getItem('ai_auth_mode') === 'signup') { setMode('signup'); WANT_SIGNUP = true; }   /* -513e F4: kept until the card is shown */
      localStorage.removeItem('ai_auth_mode');
    } catch (e) {}
    var demoBtn = document.getElementById('ai-demo');
    if (demoBtn) demoBtn.addEventListener('click', function () {
      try { localStorage.setItem('ai_guest', '1'); } catch (e) {}
      /* -513e F7: the language chosen on this card carries into the sample farm */
      try { var _al = localStorage.getItem('ai_auth_lang'); if (_al === 'af' || _al === 'en') localStorage.setItem('ai_demo_lang', _al); } catch (e) {}
      location.href = location.pathname + '?demo=1';
    });
  }
  var _wChange = false, _wResendTimer = null, _wResendAt = 0;
  /* O2: resend is offered 30 seconds after the email went (the server's own limit still applies on top) */
  function _wResendTick(){
    var b = document.getElementById('ai-resend'), cd = document.getElementById('ai-resend-cd'); if (!b || !cd) return;
    var s = Math.ceil((_wResendAt - Date.now()) / 1000);
    if (s > 0) { b.disabled = true; cd.innerHTML = ' <span class="cd">' + _esc(W('e.resendIn', { t: '0:' + (s < 10 ? '0' : '') + s })) + '</span>'; }
    else { b.disabled = false; cd.innerHTML = ''; if (_wResendTimer) { clearInterval(_wResendTimer); _wResendTimer = null; } }
  }
  function _wResendStart(){ _wResendAt = Math.max(_wResendAt, Date.now() + 30000); if (_wResendTimer) clearInterval(_wResendTimer); _wResendTimer = setInterval(_wResendTick, 1000); _wResendTick(); }
  /* the welcome's own words, in the card's language (called from applyAuthLang) */
  function _wApply(){
    var _s = function(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; };
    _s('ai-w-p1', W('w.promise1')); _s('ai-w-p2', W('w.promise2')); _s('ai-w-sub', W('w.sub')); _s('ai-w-pill', W('w.samplePill'));
    _s('ai-w-chipk', W('w.chipK')); _s('ai-w-chipv', W('w.chipV')); _s('ai-w-healthy', W('w.healthy')); _s('ai-w-cap', W('w.proofCap'));
    var img = document.getElementById('ai-w-img'); if (img) img.setAttribute('aria-label', W('w.proofCap'));
    _s('ai-w-t1b', W('w.t1b')); _s('ai-w-t1s', W('w.t1s')); _s('ai-w-t2b', W('w.t2b')); _s('ai-w-t2s', W('w.t2s')); _s('ai-w-t3b', W('w.t3b')); _s('ai-w-t3s', W('w.t3s'));
    _s('ai-e-p1', W('e.promise1')); _s('ai-e-p2', W('e.promise2')); _s('ai-e-n1', W('e.n1')); _s('ai-e-n1s', AUTH_EMAIL || '');
    _s('ai-e-n2', W('e.n2')); _s('ai-e-n2s', W('e.n2s')); _s('ai-e-n3', W('e.n3')); _s('ai-e-n3s', W('e.n3s'));
    var m = AUTH_MODE;
    _s('ai-tab-up', W('w.tabCreate')); _s('ai-tab-in', W('w.tabSignin'));
    _s('ai-h1', m === 'signup' ? W('w.createH') : m === 'signin' ? W('w.signinH') : m === 'reset' ? W('w.resetH') : m === 'newpass' ? W('w.newPassH') : 'AgriInsights');
    _s('ai-sub', m === 'signup' ? W(_wChange ? 'w.changeP' : 'w.createP') : m === 'signin' ? W('w.signinP') : m === 'reset' ? W('w.resetHint') : '');
    var lab = function(id, k){ var l = document.querySelector('label[for="' + id + '"]'); if (l) l.textContent = W(k); };
    lab('ai-email', 'w.email'); lab('ai-pass', 'w.password'); lab('ai-su-email', 'w.email'); lab('ai-su-pass', 'w.password'); lab('ai-rs-email', 'w.email');
    lab('ai-np-pass', 'w.newPass'); lab('ai-np-pass2', 'w.newPass2');
    _s('ai-su-hint', W('w.passHint')); _s('ai-signup', W('w.createBtn')); _s('ai-signin', W('w.signinBtn')); _s('ai-forgot', W('w.forgot'));
    var su = document.getElementById('ai-signup'); if (su) su.innerHTML = '<span class="bl">' + _esc(W('w.createBtn')) + '</span>' + WI.arrow;
    var si = document.getElementById('ai-signin'); if (si) si.innerHTML = '<span class="bl">' + _esc(W('w.signinBtn')) + '</span>' + WI.arrow;
    _s('ai-rs-hint', W('w.resetHint')); _s('ai-reset-back', W('w.resetBack')); _s('ai-savepass', W('w.savePass'));
    var rs = document.getElementById('ai-reset'); if (rs) rs.innerHTML = '<span class="bl">' + _esc(W('w.resetBtn')) + '</span>' + WI.arrow;
    _s('ai-or', W('c.or')); _s('ai-demo-l', W('w.sampleBtn')); _s('ai-demo-sub', W('w.sampleSub'));
    Array.prototype.forEach.call(document.querySelectorAll('#ai-auth [data-pw]'), function(b){
      var on = b.getAttribute('aria-pressed') === 'true'; var sp = b.querySelector('span'); if (sp) sp.textContent = W(on ? 'w.hide' : 'w.show');
      b.setAttribute('aria-label', W(on ? 'w.hidePass' : 'w.showPass'));
    });
    var ph = function(id, v){ var el = document.getElementById(id); if (el) el.placeholder = v; };
    ph('ai-email', W('w.phEmail')); ph('ai-su-email', W('w.phEmail')); ph('ai-rs-email', W('w.phEmail')); ph('ai-pass', W('w.phPass')); ph('ai-su-pass', '');
    var fine = document.getElementById('ai-fine');
    if (fine) fine.innerHTML = _esc(W('w.fine')).replace('{privacy}', '<button type="button" class="lnk" data-pol="privacy">' + _esc(W('c.privacy')) + '</button>').replace('{terms}', '<button type="button" class="lnk" data-pol="terms">' + _esc(W('c.terms')) + '</button>');
    if (fine) fine.parentNode.style.visibility = (m === 'signup') ? '' : 'hidden';
    /* O2 */
    var reset = (INBOX_KIND === 'reset');
    _s('ai-inbox-title', reset ? W('w.resetSentH') : W('e.h'));
    _s('ai-inbox-body', reset ? W('w.resetSentP', { email: AUTH_EMAIL || '' }) : W('e.p'));
    _s('ai-inbox-email', AUTH_EMAIL || ''); _s('ai-inbox-wrong', W('e.wrong')); _s('ai-inbox-change', W('e.changeIt'));
    var wr = document.getElementById('ai-inbox-wrongrow'); if (wr) wr.style.display = reset ? 'none' : '';
    var g = document.querySelector('#ai-inbox-gmail span'); if (g) g.textContent = W('e.gmail');
    var ol = document.querySelector('#ai-inbox-outlook span'); if (ol) ol.textContent = W('e.outlook');
    _s('ai-inbox-spam', W('e.spam')); _s('ai-resend', W('e.resend')); _s('ai-inbox-back', W('e.already'));
    _wResendTick();
    var inboxLeft = (m === 'inbox' && !reset);
    var lm = document.getElementById('ai-left-main'), li = document.getElementById('ai-left-inbox');
    if (lm) lm.style.display = inboxLeft ? 'none' : 'flex'; if (li) li.style.display = inboxLeft ? '' : 'none';
    var en = document.getElementById('ai-lang-en'), af = document.getElementById('ai-lang-af');
    if (en) en.setAttribute('aria-pressed', AUTH_LANG === 'en' ? 'true' : 'false'); if (af) af.setAttribute('aria-pressed', AUTH_LANG === 'af' ? 'true' : 'false');
    var ti = document.getElementById('ai-tab-in'), tu = document.getElementById('ai-tab-up');
    if (ti) ti.setAttribute('aria-selected', m === 'signin' ? 'true' : 'false'); if (tu) tu.setAttribute('aria-selected', m === 'signup' ? 'true' : 'false');
    try { document.documentElement.lang = AUTH_LANG; } catch (e) {}
    var _aa = document.getElementById('ai-auth'); if (_aa) _aa.classList.toggle('af', AUTH_LANG === 'af');
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
          recoverExpired:'That reset link has expired. Ask for a new one.',
          opening:'Opening your farm\u2026', openingSub:'Getting your latest figures', signingIn:'Signing in\u2026' },
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
          recoverExpired:'Daardie skakel het verval. Vra ’n nuwe een aan.',
          opening:'Maak jou plaas oop\u2026', openingSub:'Ons haal jou nuutste syfers', signingIn:'Besig om in te teken\u2026' }
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
    _txt('ai-demo-q', t.demoQ);   /* -514: the gold button and the hint are written by _wApply */
    _txt('ai-inbox-title', INBOX_KIND === 'reset' ? t.resetTitle : t.inboxTitle);
    _txt('ai-resend', t.resend); _txt('ai-inbox-back', t.back);
    _txt('ai-open-t', t.opening); _txt('ai-open-s', t.openingSub);
    _ph('ai-email', t.phEmail); _ph('ai-pass', t.phPass);
    _ph('ai-su-email', t.phEmail); _ph('ai-su-pass', t.phNewPass);
    var labs = document.querySelectorAll('#ai-pane-in label, #ai-pane-up label');
    if (labs.length >= 4) { labs[0].textContent = t.lblEmail; labs[1].textContent = t.lblPass;
                            labs[2].textContent = t.lblEmail; labs[3].textContent = t.lblNewPass; }
    var en = document.getElementById('ai-lang-en'), af = document.getElementById('ai-lang-af');
    if (en) en.className = (AUTH_LANG === 'en') ? 'on' : '';
    if (af) af.className = (AUTH_LANG === 'af') ? 'on' : '';
    try { _wApply(); } catch (e) {}   /* -514 O1/O2 */
    if (MSG_KEY && t[MSG_KEY]) { var mEl = document.getElementById('ai-msg');
      if (mEl) { mEl.textContent = t[MSG_KEY]; mEl.className = 'msg ' + MSG_KIND; } }
  }
  function _esc(s){ return String(s || '').replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  var AUTH_MODE = 'signin', AUTH_EMAIL = '', INBOX_KIND = 'signup', WANT_SIGNUP = false;
  function setMode(m){
    if (m !== 'signup') _wChange = false;
    AUTH_MODE = m;
    var show = function(id, on){ var el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('ai-pane-in',      m === 'signin');
    show('ai-pane-up',      m === 'signup');
    show('ai-pane-inbox',   m === 'inbox');
    show('ai-pane-reset',   m === 'reset');
    show('ai-pane-newpass', m === 'newpass');
    show('ai-pane-open',    m === 'opening');
    show('ai-sub',          m !== 'opening' && m !== 'inbox');
    show('ai-h1',           m !== 'opening' && m !== 'inbox');   /* -514: the inbox pane has its own heading */
    /* Tabs only make sense while choosing between signing in and signing up. Mid-
       confirmation, mid-reset, or on the new-password screen they are a way to lose
       your place. */
    show('ai-tabs',       m === 'signin' || m === 'signup');
    /* Nor should "look around the demo" sit under a half-finished password reset. */
    var demoBox = document.getElementById('ai-demo-q');
    if (demoBox && demoBox.parentNode) demoBox.parentNode.style.display = (m === 'newpass' || m === 'opening' || m === 'inbox' || m === 'reset') ? 'none' : '';
    if (m === 'inbox') _wResendStart();   /* -514 O2: resend after 30 seconds */
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
      RESEND_AT = Date.now() + 30000;             /* -514 O2: offered again after 30 s (Supabase still rate-limits server-side) */
      _wResendAt = RESEND_AT; _wResendStart();
    }).catch(function (e) {
      btn.disabled = false; _wResendTick();
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
  /* -490: THIS project's session only (sb-<ref>-auth-token). Both apps share one host, so "any sb-*
     token" was satisfied by the other app's account (memory: shared-origin token, -412). The scan stays
     only for a build with no project ref. */
  function _hasPersistedSession(){
    try{ var ref = (window.AI && window.AI.projectRef) || null; if (ref) return !!localStorage.getItem('sb-' + ref + '-auth-token'); }catch(e){}
    try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) return true; } }catch(e){} return false; }
  function _offlineReveal(){
    /* -490: offline is its own path (edits are kept on this device, as before) - never view only. */
    try { _boot.want = false; _boot.failed = true; if (typeof window.aiViewOnly === 'function') window.aiViewOnly(false); } catch (e) {}
    /* -490 item 6: the first draws held behind the card run now (and any later one draws at once). */
    try { if (typeof window.aiRunDeferredRenders === 'function') window.aiRunDeferredRenders(); } catch (e) {}
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

  /* ── -490 (B9 D2): this computer's copy straight away, view only, until the server's copy lands ──
     Shown only when ALL hold: a session under THIS project's token key; the saved copy is stamped with
     the same account id and the same active farm (saveState writes the stamps in the same write as the
     records); the copy was actually read (STATE_LOADED_FROM_DISK); not a password-reset link. Anything
     else - missing, another account or farm, unreadable - shows "Opening your farm…" and waits as before,
     never the sign-in form. While shown, the app is VIEW ONLY (aiViewOnly: one guard for every writer).
     The save lanes, the unsent-edits rule (F2: an area with something unsent keeps this computer's copy)
     and the two-device guards are not touched: hydrate runs exactly as before, catch-up first, AI.sync
     opens at its end, and the screen it is on is redrawn in place. */
  var _boot = { mode: null, want: false, revealed: false, done: false, failed: false };
  function _savedStamp(){
    try {
      var raw = localStorage.getItem(window.SAVE_KEY || 'agri_state_v1'); if (!raw) return null;
      var m = /^\{"uid":("(?:[^"\\]|\\.)*"|null),"farm":("(?:[^"\\]|\\.)*"|null),/.exec(raw.slice(0, 400));
      if (!m) return null;                               /* saved before -490: whose it is is not on it */
      return { uid: JSON.parse(m[1]), farm: JSON.parse(m[2]) };
    } catch (e) { return null; }
  }
  function _revealMatch(){
    if (RECOVERY || window.__AI_GUEST) return false;
    var uid = _sessionUid(), fid = (window.AI && AI.farm) ? AI.farm.active() : null, s = _savedStamp();
    return !!(uid && fid && s && s.uid === uid && s.farm === fid);
  }
  function _reveal(){
    if (_boot.revealed || _boot.done || _boot.failed) return false;
    _boot.revealed = true;
    try { if (typeof window.aiViewOnly === 'function') window.aiViewOnly(true); } catch (e) {}
    /* The setup wizard is up at boot until a load says the farm is set up (hydrate's end hides it). This
       computer's copy already says so: a farm that finished setup has firstRun false - hide it now, as hydrate will. */
    try { if (window.ST && window.ST.firstRun === false) { var _ob = document.getElementById('ob-overlay'); if (_ob) _ob.style.display = 'none'; } } catch (e) {}
    hideOverlay();
    return true;
  }
  /* Put the card back (in "Opening your farm…") when what was shown turns out not to be this farm's. */
  function _unreveal(mode){
    /* -513e F4: the demo's "Create your farm →" asked for Create account; the boot's "no session -> sign in"
       came a moment later and switched it back to Sign in. The farmer's own ask wins, once. */
    if (mode === 'signin' && WANT_SIGNUP) mode = 'signup';
    WANT_SIGNUP = false;
    if (_boot.revealed) {
      _boot.revealed = false;
      var o = document.getElementById('ai-auth'); if (o) o.style.display = 'flex';
    }
    setMode(mode || 'opening');
    try { if (typeof window.aiViewOnly === 'function') window.aiViewOnly(false); } catch (e) {}
  }
  /* index.html's load handler, after it drew this computer's copy. */
  window.aiBootDone = function (loadedFromDisk) {
    if (!_boot.want || _boot.done || _boot.failed) return false;
    if (!loadedFromDisk || !_revealMatch()) { _boot.want = false; return false; }
    return _reveal();
  };
  window.aiBootState = function () { return JSON.parse(JSON.stringify(_boot)); };   /* the harness */
  function _bootFinished(){
    _boot.done = true; if (_boot.revealed) { _boot.wasRevealed = true; _boot.revealed = false; }   /* later loads (tab return) behave as before */
    try { if (typeof window.aiViewOnly === 'function') window.aiViewOnly(false); } catch (e) {}
  }
  var _entering = false;
  function enterApp(){
    if (_entering) return Promise.resolve();
    try { localStorage.setItem('ai_ob5_known', '1'); } catch (e) {}   /* -514: this computer has a farmer - the card opens on Sign in next time */
    _entering = true;
    return hydrate().then(function(){ _bootFinished(); }).then(hideOverlay).then(function(){ _liveEnsure(); }).catch(function (e) {
      _entering = false;
      if (!(_isOfflineErr(e) && _hasPersistedSession())) {
        /* A genuine failure: back to the card, signed-in or not, as before (never a half-loaded farm). */
        _boot.failed = true; _unreveal('signin');
      } else {
        _boot.failed = true; try { if (typeof window.aiViewOnly === 'function') window.aiViewOnly(false); } catch (_) {}
      }
      throw e;
    });
  }

  // ---- sign in -------------------------------------------------------------
  function doSignIn() {
    // Signing in with a real account always leaves guest mode behind.
    try { localStorage.removeItem('ai_guest'); window.__AI_GUEST = false; } catch (e) {}
    var btn = document.getElementById('ai-signin');
    var email = (document.getElementById('ai-email').value || '').trim();
    var pass = document.getElementById('ai-pass').value || '';
    if (!email || !pass) { msgK('needBoth', 'err'); return; }
    btn.disabled = true; msgK('signingIn', 'ok');   /* -513e F7 */
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
    /* This app's own session first. Both apps live on one host, so localStorage holds a
       token for each Supabase project, and taking the first sb-*-auth-token found
       returned the OTHER app's account id about as often as this one's. Hydrate read
       that as "a different farmer is signed in", threw away everything this device had
       not managed to send, and reset the local stores - silently. Caught live on the SA
       test account on 16 Sep 2026: an asset saved while the connection was down was
       gone on the next load, with the status green (-412). */
    try{
      var ref = (window.AI && window.AI.projectRef) || null;
      if (ref) {
        var mine = localStorage.getItem('sb-' + ref + '-auth-token');
        if (!mine) return null;                 /* signed out of THIS app */
        var mv = JSON.parse(mine || '{}');
        return (mv.user && mv.user.id) || (mv.currentSession && mv.currentSession.user && mv.currentSession.user.id) || null;
      }
    }catch(e){}
    /* Older builds had no project ref to ask for; keep the scan as the fallback. */
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

  /* Ask the server for this account's farms, but only trust an EMPTY answer when we
     are certain the read was authenticated and had time to settle. Returns
     {farms, sure}; sure:false means "do not draw conclusions". */
  function _minWithConfidence(){
    var _sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    return AI.init().auth.getSession().then(function (res) {
      var sess = res && res.data ? res.data.session : null;
      if (!sess || !sess.user || !sess.user.id) return { farms: [], sure: false };
      return AI.farm.mine().then(function (f1) {
        if (f1 && f1.length) return { farms: f1, sure: true };
        return _sleep(600).then(function(){ return AI.farm.mine(); }).then(function (f2) {
          if (f2 && f2.length) return { farms: f2, sure: true };
          return _sleep(1200).then(function(){ return AI.farm.mine(); }).then(function (f3) {
            return { farms: f3 || [], sure: true };
          });
        });
      });
    }).catch(function (e) {
      console.error('farm list check failed:', e);
      return { farms: [], sure: false };
    });
  }

  /* -490 (B9 item 4): the early reads. area -> { fid, p } where p settles to the loader's answer or its error. */
  var _early = null;
  var _EARLY = {
    assets:    function (f) { return AI.load.assets(f); },
    loans:     function (f) { return AI.load.loans(f); },
    livestock: function (f) { return AI.load.livestock(f); },
    crops:     function (f) { return AI.load.crops(f); },
    orchard:   function (f) { return AI.load.orchard(f); },
    plan:      function (f) { return AI.load.plan(f); },
    workers:   function (f) { return AI.load.workers(f); },
    settings:  function (f) { return AI.load.profile(f); },
    coop:      function (f) { return AI.load.coopSettlements(f); },
    fuel:      function (f) { return AI.load.fuel(f); },
    documents: function (f) { return AI.load.documents(f); },
    rules:     function (f) { return AI.load.rules(f); },
    rain:      function (f) { return AI.load.rainfall ? AI.load.rainfall(f) : Promise.resolve(null); }
  };
  function _unsentNow(){ try { return (window.AI && AI.sync && AI.sync.unsentAreas) ? AI.sync.unsentAreas() : null; } catch (e) { return null; } }
  function _earlyStart(fid, isNew){
    var E = { fid: fid, at: {}, marked: null, used: {} };
    if (isNew || !fid || !(window.AI && AI.load && AI.load.capsReady)) return E;
    var u = _unsentNow(); if (!u) return E;           /* cannot tell what is unsent: read everything after the catch-up, as before */
    var caps = AI.load.capsReady();
    Object.keys(_EARLY).forEach(function (a) {
      if (u[a]) return;                                  /* unsent here: read after the catch-up sends it */
      var p = caps.then(function () { return _EARLY[a](fid); });
      E.at[a] = p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; });
    });
    return E;
  }
  /* The marks just before the catch-up: an early read of an area the catch-up is about to send is stale. */
  function _earlyMarks(){ if (_early) _early.marked = _unsentNow(); }
  function _earlyGet(area, loader){
    var E = _early, x = E && E.at[area];
    if (!x || E.used[area] || E.fid !== (window.AI && AI.farm ? AI.farm.active() : null) || !E.marked || E.marked[area]) return loader();
    E.used[area] = true;
    return x.then(function (r) { if (r.ok) return r.v; throw r.e; });
  }
  function _dataBump(why){ try { if (typeof window.aiDataBump === 'function') window.aiDataBump(why); } catch (e) {} }
  function hydrate(opts) {
    opts = opts || {};
    _early = null;
    var isNewFarm = false, needOnboarding = false, activeRow = null;
    /* Deciding "this is a brand-new user" is the single most destructive call in the
       sign-in path: get it wrong and the farmer is handed an empty farm while their
       real one sits invisible on the server. RLS answers an unauthenticated read with
       an EMPTY LIST, not an error, so "no farms" and "not authenticated yet" look
       identical. An earlier attempt asked twice with no delay — both calls raced the
       same unsettled session and still created a duplicate. So: confirm a session
       FIRST (getSession resolves from storage and waits for supabase-js to finish
       initialising, no network round-trip), then re-ask with real gaps, and only ever
       create when three spaced, authenticated reads all come back empty. */
    return _minWithConfidence().then(function (res) {
      if (!res.sure) {
        /* We could not establish an authenticated read. Refusing to guess: an error
           here leaves the farmer on the sign-in card, which is recoverable. Creating
           a farm is not. */
        throw new Error('farm-list-unconfirmed');
      }
      if (!res.farms.length) {
        isNewFarm = true;
        return AI.farm.create('My Farm').then(function(){ return null; });
      }
      return res.farms;
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
      /* -523: decide only once this device's own copy has been read. loadState() runs in the boot, which can come after this
         point; asked earlier, every normal reload would look like "nothing saved here". */
      return (window.AI && AI.sync && AI.sync.whenLocalReady) ? AI.sync.whenLocalReady(8000) : false;
    }).then(function (localReady) {
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
      /* -523 (the UK desktop's live leak of 26 Nov 2026, the same code here): the stamp says whose copy was SAVED here, not that
         it was READ. With the stamp kept and no readable copy (part of the site data cleared, a copy that would not load, a first
         save refused by a full storage allowance) the stores still hold the built-in sample farm, and the steps below keep local
         rows when the server has none, so the sample budget, herds, workers and orchards went to the real farm. Nothing read from
         this device counts as another farm's data. If the wait above ran out, the stamp alone answers, as before. */
      var diskOk = true;
      try { if (localReady === true) diskOk = (window.STATE_LOADED_FROM_DISK === true); } catch(e){}
      if (isNewFarm || !sameU || !sameF || !diskOk) {
        if (_boot.revealed) _unreveal('opening');   /* -490: what was shown is not this farm's */
        /* Unsent changes on this device belong to another account or farm: never send them. */
        try { if (window.AI && AI.sync) AI.sync.discardUnsent(); } catch(e){}
        try { if (typeof window.aiAccountReset === 'function') window.aiAccountReset(); } catch(e){}
        try { if (typeof window.syncTopbarFarm === 'function') window.syncTopbarFarm(); } catch(e){}   /* -523: never the wiped farm's name in the header */
      }
      try { localStorage.setItem('ai_state_uid', uid || ''); localStorage.setItem('ai_state_farm', fid || ''); } catch(e){}
      var _fc = AI.load.financeCore(fid);
      /* -490 (B9 item 4): the asset, loan and relational reads start now, with financeCore, for every
         area with nothing unsent on this device - they waited for financeCore, the catch-up and the
         asset/loan step in turn. Orders kept: a read whose columns come from the CAN_* flags waits for
         the column probe (capsReady - every early read waits for it); an area WITH something unsent is
         read only after the catch-up has sent it (the -404 rule: push, then read), and so is any area
         that became unsent before the catch-up ran; every apply below happens where it always did, with
         its own isUnsent guard. Skipped for a brand-new farm (nothing to read). */
      _early = _earlyStart(fid, isNewFarm);
      return _fc;
    }).then(function (core) {
      _dataBump('sync');   /* -490 item 7: every server apply empties the derived-figure caches */
      // Replace the app's working data with the farm's real data.
      if (window.ST) { ST.txns = (window.preservePendingTxns ? window.preservePendingTxns(core.txns || []) : (core.txns || [])); if (!(window.AI && AI.sync && AI.sync.isUnsent('recurring'))) ST.recurring = core.recurring || []; /* -489 F2: a budget edit this device has not sent yet (the budget lane is marked unsent) is the farmer's latest:
         keep it - the catch-up below sends it - instead of loading the server's older copy over it, which the catch-up
         then sent back. provPaid and taxPaid ride the same save, so they are kept with it. Same rule as recurring. */
      var _bgtUnsent = !!(window.AI && AI.sync && AI.sync.isUnsent('budget'));
      if (core.budgets && !_bgtUnsent) { var _ct = ST.budgets && ST.budgets.catTargets, _lk = ST.budgets && ST.budgets.locked, _lg = ST.budgets && ST.budgets.grid; ST.budgets = core.budgets; if (!ST.budgets.catTargets && _ct) ST.budgets.catTargets = _ct; if (!ST.budgets.locked && _lk) ST.budgets.locked = _lk; /* -451 */ /* -491: whitelist 3 of 3 - the Spreadsheet. No grid from the server (its tables not made yet, or not read) keeps this device's; a server with no saved Spreadsheet keeps one this device saved before the tables existed (sent next, as the category targets were). Then the cells follow the month totals (another device may have changed a month). */ try { var _hasFarm = function (g) { try { return Object.keys((g && g.scen) || {}).some(function (k) { return g.scen[k] && g.scen[k].src === 'farm'; }); } catch (e) { return false; } }, _gridResend = false; if (!ST.budgets.grid && _lg) ST.budgets.grid = _lg; else if (_lg && _hasFarm(_lg) && !_hasFarm(ST.budgets.grid)) { ST.budgets.grid = _lg; _gridResend = true; } /* -492: Yield x price (budget_scenarios.yp) - a server without the column yet keeps this device's */ try { var _sg = ST.budgets.grid; if (_sg && _sg.scen) Object.keys(_sg.scen).forEach(function (k) { var a = _sg.scen[k], b = _lg && _lg.scen && _lg.scen[k]; if (a && a._noYp && b && b.yp && Object.keys(b.yp).length && _sg !== _lg) a.yp = b.yp; if (a) delete a._noYp; }); } catch (e) {} /* -493: the forecast - kept from this device when the server has none; you beats plan */ try { if (typeof window.fcHydrate === 'function' && _lg && ST.budgets.grid !== _lg && window.fcHydrate(_lg) > 0) _gridResend = true; } catch (e) {} try { if (typeof window.fcLockMigrate === 'function') window.fcLockMigrate(); } catch (e) {} if (typeof window.bgGridSync === 'function' && window.bgGridSync('totals') > 0) _gridResend = true; /* -492 (owner Q2): the worked-out VAT inside the month totals, on the server's figures */ try { if (typeof window.bgVatSync === 'function' && window.bgVatSync() > 0) _gridResend = true; } catch (e) {} if (_gridResend && window.AI && AI.budget && AI.farm && AI.farm.active()) AI.budget.save(ST.budgets).catch(function () {}); } catch (e) {} } if (!_bgtUnsent && core.provPaid && typeof core.provPaid === 'object') ST.provPaid = core.provPaid; if (!_bgtUnsent && core.taxPaid && typeof core.taxPaid === 'object') ST.taxPaid = core.taxPaid /* -457 */;
      try { if (typeof window.migrateCatTargets === 'function') window.migrateCatTargets(); } catch (e) {}   /* -489 F8: targets loaded under an old category name */ /* -449: targets were wiped by this replace; provisional payment now comes from the cloud */ if (core.batches && !(window.AI && AI.sync && AI.sync.isUnsent('imports'))) ST.importBatches = core.batches;
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
      try { if (window.ST && ST.budgets) { var _d=(window.APP_TODAY?new Date(window.APP_TODAY):new Date());   /* ALWAYS today (-449): the cloud keeps the month the budget was last saved in, and a stale one shifted every headline */ var _ml=(window.MONTH_LABELS_SHORT)||['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; ST.budgets.currentMonth=_ml[_d.getMonth()]+' '+_d.getFullYear(); } } catch (e) {}
      // Brand-new pilot farm: wipe any in-memory demo defaults across ALL modules
      // so the user starts on a clean slate and can begin entering data straight away.
      if (isNewFarm && typeof window.clearAllToFresh === 'function') {
        try { window.clearAllToFresh(); if (typeof window.saveState === 'function') window.saveState(); } catch (e) {}
      }
      // Load the asset register + loans before first render (net-worth uses them).
      /* Send what this device never got to send BEFORE any server copy is applied. The loans are
         the FIRST thing hydrate overwrites, so a catch-up placed after them ran with the server's
         copy already in memory: it pushed that back, cleared the marks, and the change left unsent
         when the app closed was gone. Traced live on 16 Sep 2026 - loans fetched at 1.9s, catch-up
         at 2.0s holding only the server's row. */
      _earlyMarks();   /* what the catch-up is about to send: those early reads are thrown away */
      return (AI.sync ? AI.sync.catchUp() : Promise.resolve()).then(function () { return Promise.all([
        _earlyGet('assets', function () { return AI.load.assets(AI.farm.active()); }),
        _earlyGet('loans', function () { return AI.load.loans(AI.farm.active()); })
      ]); }).then(function (res) {
        _dataBump('sync');
        var assets = res[0], loanData = res[1];
        try {
          /* Never load over assets this device has not managed to send yet (-411):
             until -411 an asset whose write failed was wiped here, silently. */
          if (window.ST_ASSETS && assets && !(window.AI && AI.sync && AI.sync.isUnsent('assets'))) {
            /* Keep the number each asset was given when it was registered. Dealing them
               out fresh on every load (a.id = i + 1) moved every asset below a deleted
               one, and a payment linked to "asset 3" then named a different machine -
               reproduced against the shipped lookup on 16 Sep 2026. Only rows written
               before the local_id column arrive without a number; those get the lowest
               free ones. */
            var _astUsed = {}, _astNext = 1;
            assets.forEach(function (a) { if (a && a.id != null) _astUsed[a.id] = 1; });
            assets.forEach(function (a) {
              if (!a || a.id != null) return;
              while (_astUsed[_astNext]) _astNext++;
              a.id = _astNext; _astUsed[_astNext] = 1;
            });
            ST_ASSETS.assets = assets;
            /* past the highest id in use, not the count: a sparse list minted a duplicate. */
            if (typeof window.astRepairIds === 'function') window.astRepairIds(ST_ASSETS);
            else ST_ASSETS.nextId = assets.length + 1;
            /* The register is in: ties on payments to machines that are no longer in it are
               cleared quietly, on this device only - the server let go of them when the
               machine went (-413). */
            try { if (typeof window.astSweepDeadPaymentLinks === 'function') window.astSweepDeadPaymentLinks(); } catch (e) {}
          }
        } catch (e) { console.error('Asset hydrate failed:', e); }
        try {
          /* Never load over facilities this device has not managed to send yet. */
          if (window.ST_LOANS && loanData && !(window.AI && AI.sync && AI.sync.isUnsent('loans'))) {
            ST_LOANS.loans = loanData.loans || [];
            ST_LOANS.overdrafts = loanData.overdrafts || [];
            _bmbKeepLocal(loanData.coopAccounts, ST_LOANS.coopAccounts, 'coop'); ST_LOANS.coopAccounts = loanData.coopAccounts || [];   /* -495 */
            ST_LOANS.archived = loanData.archived || [];
            // Monthly paid-marks (Item 3): restore so a confirmed month survives reload + new device.
            if (loanData.confirmed) ST_LOANS.confirmed = loanData.confirmed;
            /* The counters live on this device only, while the facilities come back from the
               server: number past what is in use, and renumber anything that arrived twice. */
            try { if (typeof window.lnRepairFacilityIds === 'function') window.lnRepairFacilityIds(ST_LOANS); } catch (e) {}
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
        _bmbPushNow('loans');   /* -495 */
      }).catch(function (e) { console.error('Asset/loan load failed:', e); });
    }).then(function () {
      // Cross-device persistence: load every relational module from the backend so a
      // farmer signing in on a new device sees ALL their data, not demo defaults.
      // Each module applies independently (its own try/catch) so one failure can't
      // break the others. Skipped for brand-new farms (nothing saved yet).
      if (isNewFarm) return;
      var fid = AI.farm.active();
      /* Send what this device never got to send BEFORE loading over it. After financeCore,
         so the column probes have run and a settings catch-up sends every column. */
      return Promise.all([
        _earlyGet('livestock', function () { return AI.load.livestock(fid); }).catch(function (e) { console.error('livestock load', e); return null; }),
        _earlyGet('crops', function () { return AI.load.crops(fid); }).catch(function (e) { console.error('crops load', e); return null; }),
        _earlyGet('orchard', function () { return AI.load.orchard(fid); }).catch(function (e) { console.error('orchard load', e); return null; }),
        _earlyGet('plan', function () { return AI.load.plan(fid); }).catch(function (e) { console.error('plan load', e); return null; }),
        _earlyGet('workers', function () { return AI.load.workers(fid); }).catch(function (e) { console.error('workers load', e); return null; }),
        _earlyGet('settings', function () { return AI.load.profile(fid); }).catch(function (e) { console.error('profile load', e); return null; }),
        _earlyGet('coop', function () { return AI.load.coopSettlements(fid); }).catch(function (e) { console.error('coop load', e); return null; }),
        /* Both of these have existed since the module sweep and neither was ever called.
           AI.fuel.saveAll and AI.documents.saveAll push rows up on every save, so the data
           was on the server the whole time — it just had no way back, and a farmer on a new
           device saw an empty fuel log and no removal certificates. The certificates are the
           worse half: those are statutory documents. */
        _earlyGet('fuel', function () { return AI.load.fuel(fid); }).catch(function (e) { console.error('fuel load', e); return null; }),
        _earlyGet('documents', function () { return AI.load.documents(fid); }).catch(function (e) { console.error('documents load', e); return null; }),
        _earlyGet('rules', function () { return AI.load.rules(fid); }).catch(function (e) { console.error('rules load', e); return null; }),
        /* The rain book, so a farmer on a new device does not open an empty one.
           Never fatal: the tables may not exist yet on an older project. */
        (AI.load.rainfall ? _earlyGet('rain', function () { return AI.load.rainfall(fid); }).catch(function () { return null; }) : Promise.resolve(null))
      ]).then(function (r) {
        _dataBump('sync');
        var ls = r[0], cr = r[1], orc = r[2], pl = r[3], wk = r[4], pf = r[5], coop = r[6],
            fu = r[7], dc = r[8], rl = r[9], rn = r[10];
        /* Never load over an area that still has something unsent on this device. */
        var _unsent = function (a) { try { return !!(AI.sync && AI.sync.isUnsent(a)); } catch (e) { return false; } };
        try { if (window.ST_LS && ls && !_unsent('livestock')) { var _lsHas = ((ls.herds&&ls.herds.length)||(ls.camps&&ls.camps.length)||(ls.animals&&ls.animals.length)); var _lsLoc = ((ST_LS.herd&&ST_LS.herd.length)||(ST_LS.camps&&ST_LS.camps.length)); if (_lsHas || !_lsLoc) { ST_LS.camps = ls.camps || []; _bmbKeepLocal(ls.herds, ST_LS.herd, 'herds'); ST_LS.herd = ls.herds || []; if (ls.benchmarks) ST_LS.benchmarks = ls.benchmarks; ST_LS.moves = ls.moves || []; ST_LS.treatments = ls.treatments || []; ST_LS.removedTreatments = ls.removedTreatments || []; ST_LS.animals = ls.animals || []; ST_LS.health = ls.health || []; ST_LS.breedings = ls.breedings || []; /* Herds whose stored count did not yet include a move recorded elsewhere - the phone at a gate, or another desktop. load.livestock has already folded those moves in, so the figure on screen is the one the ledger supports; this is what the farmer gets told about it, on the Dashboard. */ ST_LS._stockRecon = (ls.stockRecon && ls.stockRecon.length) ? ls.stockRecon : null; } } } catch (e) { console.error('livestock apply', e); }
        try { if (window.ST_CROP && cr && !_unsent('crops')) { var _crHas = ((cr.lands&&cr.lands.length)||(cr.events&&cr.events.length)||(cr.inputs&&cr.inputs.length)); var _crLoc = ((ST_CROP.lands&&ST_CROP.lands.length)||(ST_CROP.events&&ST_CROP.events.length)); if (_crHas || !_crLoc) { ST_CROP.lands = cr.lands || []; ST_CROP.events = cr.events || []; ST_CROP.inputs = cr.inputs || []; ST_CROP.removed = cr.removed || []; if (cr.season) ST_CROP.season = cr.season; if (cr.compliance) ST_CROP.compliance = cr.compliance; } } } catch (e) { console.error('crops apply', e); }
        try { if (window.ST_FRUIT && orc && !_unsent('orchard')) { var _orcHas = (orc.blocks && orc.blocks.length); var _locHas = (ST_FRUIT.blocks && ST_FRUIT.blocks.length); if (_orcHas || !_locHas) { _bmbKeepLocal(orc.blocks, ST_FRUIT.blocks, 'orchard'); ST_FRUIT.blocks = orc.blocks || []; ST_FRUIT.pricing = orc.pricing || {}; ST_FRUIT.sprayDiary = orc.sprayDiary || {}; ST_FRUIT.removedSprays = orc.removedSprays || []; ST_FRUIT.harvest = orc.harvest || []; ST_FRUIT.removedHarvest = orc.removedHarvest || []; if (orc.comply) ST_FRUIT.comply = orc.comply; try{ if(window.orComplyEnsure) orComplyEnsure(); }catch(_){} if (orc.market) ST_FRUIT.market = orc.market; if (typeof window.orRebuildPhi === 'function') { try { window.orRebuildPhi(); } catch (_) {} } } } } catch (e) { console.error('orchard apply', e); }
        try { if (window.ST_PLAN && !_unsent('plan')) { var _plHas = (pl && ((pl.crops&&pl.crops.length)||(pl.events&&pl.events.length))); var _plLoc = ((ST_PLAN.crops&&ST_PLAN.crops.length)||(ST_PLAN.events&&ST_PLAN.events.length)); if (pl && (_plHas || !_plLoc)) { _bmbKeepLocal(pl.crops, ST_PLAN.crops, 'plan'); ST_PLAN.crops = pl.crops || []; ST_PLAN.events = pl.events || []; ST_PLAN.fromBackend = true; if (typeof window.planSyncToCurrentYear === 'function') { try { window.planSyncToCurrentYear(); } catch (_) {} } } else if (!pl && typeof window.cropInitialPlanSync === 'function') { try { window.cropInitialPlanSync(true); } catch (_) {} } } } catch (e) { console.error('plan apply', e); }
        /* Where the farm is, how it tracks rain and its own long-term figure ride
           on the farm row, so a second device knows them before any reading arrives. */
        try {
          if (window.ST_RAIN && pf && pf._rain && !_unsent('settings')) {
            if (pf._rain.loc && !ST_RAIN.loc) ST_RAIN.loc = pf._rain.loc;
            if (pf._rain.mode) ST_RAIN.mode = pf._rain.mode;
            if (pf._rain.yearStart != null) ST_RAIN.yearStart = pf._rain.yearStart;
            if (pf._rain.normalOverride != null) {
              ST_RAIN.normal = ST_RAIN.normal || { monthly: null, override: null };
              ST_RAIN.normal.override = pf._rain.normalOverride;
            }
            /* The stretches the farmer said they were not keeping the book, so a
               second device fills them from satellite exactly as this one does. */
            if (Array.isArray(pf._rain.notKept)) ST_RAIN.notKept = pf._rain.notKept;
            /* The planting rule and the satellite-fill switch, once the farmer has
               chosen them on any device. Marked as chosen here too, so this device
               sends them back unchanged rather than its own defaults. */
            if (pf._rain.rule && (pf._rain.rule.plantMm || pf._rain.rule.plantDays))
              ST_RAIN.rule = { plantMm: pf._rain.rule.plantMm || 25, plantDays: pf._rain.rule.plantDays || 10, set: true };
            if (typeof pf._rain.fillFromSat === 'boolean') { ST_RAIN.fillFromSat = pf._rain.fillFromSat; ST_RAIN.fillSet = true; }
            if (typeof rnSync === 'function') { try { rnSync(); } catch (e4) {} }
          }
        } catch (e) { console.error('rainfall settings hydrate', e); }
        /* Only take the server's rain book when this device has none of its own:
           the same rule the other modules use, so a local book is never wiped. */
        try {
          if (window.ST_RAIN && rn && !_unsent('rain')) {
            var _rnHas = (rn.log && rn.log.length) || (rn.gauges && rn.gauges.length);
            var _rnLoc = (ST_RAIN.log && ST_RAIN.log.length) || (ST_RAIN.gauges && ST_RAIN.gauges.length);
            if (_rnHas && !_rnLoc) {
              if (rn.gauges && rn.gauges.length) ST_RAIN.gauges = rn.gauges;
              if (rn.log && rn.log.length) ST_RAIN.log = rn.log;
              if (typeof renderRainfall === 'function' && document.getElementById('pg-rainfall')) { try { renderRainfall(); } catch (e2) {} }
              if (typeof rnDashSync === 'function') { try { rnDashSync(); } catch (e3) {} }
            }
          }
        } catch (e) { console.error('rainfall hydrate', e); }
        try { if (window.ST_WORK && wk && !_unsent('workers')) { var _wkHas = (wk.workers && wk.workers.length); var _wkLoc = (ST_WORK.workers && ST_WORK.workers.length); if (_wkHas || !_wkLoc) { ST_WORK.workers = wk.workers || []; if (wk.settingsRow && AI.workers && AI.workers.apply) { AI.workers.apply(ST_WORK, wk.settingsRow); } if (wk.payroll) { ST_WORK.paye = wk.payroll.paye || {}; ST_WORK.bonus = wk.payroll.bonus || {}; ST_WORK.extra = wk.payroll.extra || {}; ST_WORK.seasonal = wk.payroll.seasonal || {}; } ST_WORK.payRuns = wk.payRuns || []; if (wk.payslips) { ST_WORK.payslips = wk.payslips; ST_WORK.payslipSends = wk.payslipSends || []; } } } } catch (e) { console.error('workers apply', e); }
        /* The same farm facts live in TWO objects and only one of them round-trips.
           ST.vatRegistered comes back from the server here; FARM.vat never did — and the
           whole VAT engine gates on FARM.vat (IE_split, computeRPT's vatOut/vatIn, the
           VAT 201 summary, the registration nudge). Since clearAllToFresh() sets
           FARM.vat = false and runs on any account/farm mismatch, a farmer signing in on
           a second device had VAT silently switched OFF however they answered, and the
           statutory documents printed a blank VAT and tax number. Copy the profile into
           FARM as well, so the server stays the single source of truth for both.
           Note the != null tests: `false` is a real answer and must survive them. */
        try {
          if (window.ST && pf && !_unsent('settings')) {
            /* Skip the underscore keys: those carry ST_CROP / ST_PLAN / ST_LOANAPP data and
               are applied to their own objects below. Copying them here would park a second,
               stale copy on ST and write it to localStorage on every save. */
            var _lang0 = ST.lang;
            Object.keys(pf).forEach(function (k) { if (k.charAt(0) !== '_' && pf[k] != null) ST[k] = pf[k]; });
            /* -513e F7: the farm's language (farms.lang) is the farmer's - show the app in it */
            try { if ((pf.lang === 'af' || pf.lang === 'en') && pf.lang !== _lang0 && typeof window.applyLang === 'function') { ST.lang = _lang0; window.applyLang(pf.lang); } } catch (e) {}
            if (window.FARM) {
              if (pf.farmName   != null) FARM.name  = pf.farmName;
              if (pf.ownerName  != null) FARM.owner = pf.ownerName;
              if (pf.farmHa     != null) FARM.ha    = Number(pf.farmHa) || 0;
              if (pf.vatRegistered != null) FARM.vat = !!pf.vatRegistered;
              if (pf.vatNumber  != null) FARM.vatNo = pf.vatNumber;
              if (pf.taxNumber  != null) FARM.taxNo = pf.taxNumber;
            }
          }
        } catch (e) { console.error('profile apply', e); }
        /* -523: repaint the header from the farm just loaded (as the UK desktop does). syncTopbarFarm ran once at boot, before
           sign-in loaded anything, so the header kept "Your farm" - or, once the wipe below the stamp check waits for this
           device's copy, the sample farm's name and owner - until something else redrew it. */
        try { if (typeof window.syncTopbarFarm === 'function') window.syncTopbarFarm(); } catch (e) {}
        /* Guarded like the rest (-411): a settlement import this device has not sent
           must not be replaced by the server's copy without it. */
        try { if (window.ST && Array.isArray(coop) && !_unsent('coop')) ST.coopSettlements = coop; } catch (e) { console.error('coop apply', e); }
        /* The stored "needs a look" answers, and the keeper that fills in any line that
           has none or whose answer is older than the word list or the filing rules
           (signed off 20 Sep 2026, d3 = one keeper). Never blocks the load. */
        try { if (typeof window.txLookKick === 'function') window.txLookKick(); } catch (e) { console.error('looks', e); }
        /* Same shape as every other module above: the server wins when it has rows, and
           local is kept when it does not, so a farm that has never synced these is not
           emptied by a load that legitimately returns nothing. */
        try { if (window.ST_FUEL && Array.isArray(fu) && !_unsent('fuel') && (fu.length || !(ST_FUEL.issues && ST_FUEL.issues.length))) ST_FUEL.issues = fu; } catch (e) { console.error('fuel apply', e); }
        try { if (window.ST && Array.isArray(dc) && !_unsent('documents') && (dc.length || !(ST.docs && ST.docs.length))) ST.docs = dc; if (typeof aiDocsSettle === 'function') aiDocsSettle(); } catch (e) { console.error('documents apply', e); }
        /* The settings that used to live only in localStorage. The scalars rode in on the
           generic key-copy just above; these four belong to other objects, so they are
           applied by hand. Underscore-prefixed on the profile object to keep them off ST. */
        try {
          if (pf && !_unsent('settings')) {
            if (pf._loanApp    && window.ST_LOANAPP) Object.keys(pf._loanApp).forEach(function(k){ ST_LOANAPP[k]=pf._loanApp[k]; });
            if (pf._cropPrices && window.ST_CROP)    ST_CROP.prices    = pf._cropPrices;
            if (pf._cropTypes  && window.ST_CROP && pf._cropTypes.length) ST_CROP.cropTypes = pf._cropTypes;
            if (pf._planHedge  && window.ST_PLAN)    ST_PLAN.hedge     = pf._planHedge;
          }
        } catch (e) { console.error('settings apply', e); }
        _bmbPushNow();   /* -495: the one-time push of Planning's own fields */
        /* Filing rules. null means the table is not there, so the device keeps its own —
           only an actual array replaces them. Repointed through CAT_MERGES afterwards so a
           rule aimed at a renamed category still fires instead of silently doing nothing. */
        try {
          if (window.ST && Array.isArray(rl) && !_unsent('rules')) ST.catRules = rl;
          if (typeof window.catRuleRepoint === 'function') window.catRuleRepoint();
        } catch (e) { console.error('rules apply', e); }
        try { if (typeof window.saveState === 'function') window.saveState(); } catch (e) {}
        /* -463: the farm is this farm's now, not the demo's - the tax figures the phone reads
           may be written from here on. */
        try { window.__AI_HYDRATED_AT = Date.now(); if (typeof window.taxPlanQueue === 'function') window.taxPlanQueue(); } catch (e) {}
        try { if (typeof window.homeMoneyQueue === 'function') window.homeMoneyQueue(); } catch (e) {}   /* -469: the phone's Home profit */
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
        /* -490 (B9 item 6): the first draws held behind the card run now - the Dashboard itself is drawn by nav. */
        try { if (typeof window.aiRunDeferredRenders === 'function') window.aiRunDeferredRenders({ dash: true }); } catch (e) {}
        /* -490 (D2): the farmer has been looking at this computer's copy - redraw the screen they are on, in place. */
        if (typeof nav === 'function') nav((opts.silent || _boot.revealed) && window.CURRENT_PAGE ? window.CURRENT_PAGE : 'dashboard');
        else if (typeof updateDashboardFigures === 'function') updateDashboardFigures();
      } catch (e) {}
      try {
        /* The first load has finished: saves that were waiting for it go now. */
        if (window.AI && AI.sync) AI.sync.open();
        if (typeof window.updateSyncIndicator === 'function') window.updateSyncIndicator();
        /* The load found copies left by the old replace-all doubling and is showing one of
           each: save those areas now, so the server drops the rest (-448). */
        if (window.AI && AI.load && AI.load.healed && Object.keys(AI.load.healed()).length && typeof window.flushRelationalToBackend === 'function') {
          try { console.warn('AgriInsights: clearing repeated copies from the server:', JSON.stringify(AI.load.healed())); } catch (_) {}
          window.flushRelationalToBackend();
        }
      } catch (e) {}
    });
  }

  // ---- boot: wait for DOM + AI, then check for an existing session ---------
  function start() {
    if (!window.AI) { msg('Backend not loaded (check ai-data.js).', 'err'); return; }
    /* -490 (B9 D2 + item 6): decided now, before the first paint and before the app's load handler. */
    try {
      if (window.__AI_GUEST) { _boot.mode = 'guest'; }
      else if (_sessionUid() && !RECOVERY) {
        _boot.mode = _revealMatch() ? 'reveal' : 'opening'; _boot.want = (_boot.mode === 'reveal');
        setMode('opening');
      } else { _boot.mode = 'landing'; try { _wImgs(); } catch (e) {} }   /* -514: a visitor sees the welcome's pictures at once */
      window.__AI_BOOT = _boot.mode;
    } catch (e) {}
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
            // else: a genuine error — overlay stays for sign-in (enterApp put the form back)
          });
        } else if (_hasPersistedSession() && navigator.onLine === false) {
          // getSession couldn't confirm offline, but a cached token exists
          _offlineReveal();
        } else {
          // no session (the saved one could not be refreshed) — the sign-in form, as before
          _boot.want = false; _boot.failed = true; _unreveal(_landingMode());   /* -514 O1: a new visitor lands on Create your farm */
        }
      }).catch(function (e) {
        if (_hasPersistedSession() && _isOfflineErr(e)) { _offlineReveal(); }
        else { _boot.want = false; _boot.failed = true; _unreveal(_landingMode()); }   // overlay stays visible, on the form (-514: Create your farm for a new visitor)
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
    if (_refreshBlocked()) return;                                            // mid-edit or a modal open
    if (Date.now() - _lastRefresh < 20000) return;                           // debounce ~20s
    _refreshing = true; _lastRefresh = Date.now();
    try { if (window.flushTxnOutbox) window.flushTxnOutbox(); } catch(e){}    // push local writes first
    /* Push what is waiting, WAIT for it to land, and only then load. Loading while saves
       were still on their way copied the server's older copy over the farmer's change.
       hydrate() also sends anything an earlier session never sent, and never loads over an
       area that still has something unsent. Before the first load has finished nothing is
       pushed here: those saves wait for that load, and waiting on them would never end. */
    var pushes = [];
    try {
      if (!(AI.sync && !AI.sync.isOpen())) {
        if (AI.profile && window.ST) pushes.push(AI.profile.save(ST).catch(function(){}));
        if (AI.loans && window.ST_LOANS) pushes.push(AI.loans.saveAll(ST_LOANS).catch(function(){}));
        if (AI.livestock && window.ST_LS) pushes.push(AI.livestock.saveAll(ST_LS).catch(function(){}));
        if (AI.crop && window.ST_CROP) pushes.push(AI.crop.saveAll(ST_CROP).catch(function(){}));
        if (AI.orchard && window.ST_FRUIT) pushes.push(AI.orchard.saveAll(ST_FRUIT).catch(function(){}));
        if (AI.plan && window.ST_PLAN) pushes.push(AI.plan.saveAll(ST_PLAN).catch(function(){}));
        if (AI.workers && window.ST_WORK) pushes.push(AI.workers.saveAll(ST_WORK).catch(function(){}));
      }
    } catch(e){}
    return Promise.all(pushes)
      .then(function(){ return (AI.sync && AI.sync.idle) ? AI.sync.idle(15000) : null; })
      .then(function(){ return hydrate({silent:true}); })
      .catch(function(){})
      .then(function(){ _refreshing = false; return true; });
  }
  /* Never pull data in under the farmer's fingers: not while typing, and not with a dialog open. */
  function _refreshBlocked(){
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
    try { if (document.querySelector('[id$="-bg"].on')) return true; } catch(e){}
    return false;
  }
  window.refreshFromCloud = refreshFromCloud;
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) { refreshFromCloud(); _liveEnsure(); } });
  window.addEventListener('online', function(){ refreshFromCloud(); _liveEnsure(); });

  /* ---- LIVE: the phone's change shows here without a reload (signed off 19 Sep 2026) ----
     Before this the computer fetched only when a page loaded or the tab came back into
     view, so a payslip answered "Yes" on the iPhone stayed "Not sent" on a computer left on
     screen until the farmer reloaded it. Now Supabase Realtime tells this tab the moment a
     row another device writes changes; a burst is gathered for 2 seconds, then the same
     refresh the tab already uses runs and the page on screen is redrawn.
       - Its OWN saves come back as change messages too. Those are skipped: a row the phone
         marks as its own (source 'Phone', src 'phone', a payslip answer, a permit or filing)
         always counts; anything else is ignored within 8 seconds of this tab saving.
       - Never mid-edit or with a dialog open: it waits and tries again every 3 seconds.
       - Deletes are not delivered by Realtime, and the connection can drop, so while the tab
         is visible it also checks: every 60 seconds with no live connection, every 5 minutes
         with one. The live refresh runs even while the tab is hidden. */
  var _liveTimer = null, _livePhone = false, _lastOwnWrite = 0, _livePoll = null, _liveHooked = false;
  function _liveOwnHooks(){
    if (_liveHooked) return; _liveHooked = true;
    try { if (AI.sync && AI.sync.onChange) AI.sync.onChange(function(){ try { if (AI.sync.status().saving) _lastOwnWrite = Date.now(); } catch(e){} }); } catch(e){}
    ['txnWriteThrough', 'txnUpdateThrough', 'txnDeleteThrough'].forEach(function(n){
      var f = window[n]; if (typeof f !== 'function' || f.__liveWrapped) return;
      var w = function(){ _lastOwnWrite = Date.now(); return f.apply(this, arguments); };
      w.__liveWrapped = true; window[n] = w;
    });
  }
  function _livePhoneRow(table, row){
    row = row || {};
    if (table === 'payslip_sends') return true;
    if (table === 'transactions') return row.source === 'Phone';
    if (table === 'fuel_issues') return row.src === 'phone';
    if (table === 'farm_documents') return row.doc_type === 'PERMIT' || row.doc_type === 'FILING';
    return false;
  }
  function _liveOnEvent(table, p){
    var row = p['new'] || p.record || {};
    var phone = _livePhoneRow(table, row);
    if (!phone && Date.now() - _lastOwnWrite < 8000) return;               // this tab's own save, echoed back
    if (phone) _livePhone = true;
    _liveKick(2000);
  }
  function _liveKick(ms){
    if (_liveTimer) return;
    _liveTimer = setTimeout(function tick(){
      _liveTimer = null;
      /* Refreshed even while the tab is hidden - behind another window, or on the other
         screen - so it is already right when the farmer looks. Skipping it and relying on
         "coming back into view" lost the change whenever that refresh fell inside the
         20-second gap (found testing -419, 19 Sep 2026). */
      if (_refreshing || _refreshBlocked()) { _liveTimer = setTimeout(tick, 3000); return; }
      var fromPhone = _livePhone; _livePhone = false;
      _lastRefresh = 0;
      var r = refreshFromCloud();
      if (r && r.then) r.then(function(){
        try { if (typeof window.toast === 'function') window.toast(fromPhone ? 'Updated from your phone just now.' : 'Updated from another device just now.', 'info'); } catch(e){}
      });
    }, ms);
  }
  function _liveEnsure(){
    try {
      if (window.__AI_GUEST || !(window.AI && AI.live && AI.farm && AI.farm.active())) return;
      if (!_hasPersistedSession()) { AI.live.stop(); return; }
      _liveOwnHooks();
      var fid = AI.farm.active();
      var st = AI.live.state();
      if (AI.live.farm() !== fid || st === 'off' || st === 'CLOSED' || st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
        AI.live.start(fid, _liveOnEvent, function(){});
      }
    } catch(e){}
    if (!_livePoll) {
      var last = Date.now();
      _livePoll = setInterval(function(){
        if (document.hidden || window.__AI_GUEST) return;
        _liveEnsure();
        var up = window.AI && AI.live && AI.live.state() === 'SUBSCRIBED';
        if (Date.now() - last < (up ? 300000 : 60000)) return;
        last = Date.now();
        _lastRefresh = 0; refreshFromCloud();
      }, 15000);
    }
  }
  window.aiLiveEnsure = _liveEnsure;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectUI(); start(); });
  } else { injectUI(); start(); }
})();
