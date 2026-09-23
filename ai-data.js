/* ============================================================================
 * AgriInsights — Data Service  (ai-data.js)
 * Connects the front-end to Supabase, replacing localStorage for the FINANCE
 * CORE (transactions, accounts, categories, budgets, recurring).
 * Phase 1. Livestock / crops / workers / etc. hook in during Phase 2.
 * ----------------------------------------------------------------------------
 * SETUP (3 steps)
 *   1. Add the Supabase client to your page <head>, BEFORE this file:
 *        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *        <script src="ai-data.js"></script>
 *   2. Fill in the two constants below from Supabase → Settings → API.
 *      (The anon key is safe in the client — RLS protects the data.)
 *   3. In Supabase: enable Email auth (Authentication → Providers) and create
 *      a private Storage bucket named 'Attachments' (case-sensitive — must match STORAGE_BUCKET below).
 * ----------------------------------------------------------------------------
 * INTEGRATION (how it slots into index.html)
 *   - On app start, after the user is signed in and a farm is active:
 *        const core = await AI.load.financeCore(AI.farm.active());
 *        ST.txns      = core.txns;        // existing render code keeps working
 *        ST.budgets   = core.budgets;
 *        ST.recurring = core.recurring;
 *        ACCOUNTS     = core.accounts;    // new multi-account list
 *        CATEGORIES   = core.categories;
 *   - Replace the localStorage write in saveState() with nothing (or keep it as
 *     an offline cache). Persist real changes via the write functions instead:
 *        after saveSale()/saveExpense() builds a txn -> await AI.txn.add(txn)
 *        on edit  -> await AI.txn.update(id, txn)
 *        on delete-> await AI.txn.remove(id)
 *   - Field mapping (app <-> db) is handled here; you pass/receive the app's
 *     existing txn shape: {id,date,amt,cat,type,desc,method,recur,batch,ref,note}
 * ========================================================================== */

(function (global) {
  'use strict';

  // ---- 1. CONFIG (fill these in) -------------------------------------------
  const SUPABASE_URL      = 'https://wiyfuxbftbitnbuzencv.supabase.co';
  /* Both apps are served from one host, so they share one localStorage - and each keeps
     its own Supabase session under sb-<project>-auth-token. Anything hunting for "the"
     token has to say WHICH project, or it reads the other app's account (-412). */
  const PROJECT_REF       = 'wiyfuxbftbitnbuzencv';
  const SUPABASE_ANON_KEY = 'sb_publishable_-nl0FU9CplFIPpJ_UBXEJg_awromv5n'; // publishable (public) key
  // Magic-link return: derived from wherever the app is served (live OR test),
  // so the same file works on both without editing.
  const APP_URL = window.location.origin +
                  window.location.pathname.replace(/[^/]*$/, '');

  const ACTIVE_FARM_KEY = 'ai_active_farm';

  let sb = null;
  let catMaps = { code2id: {}, id2code: {}, list: [] };

  /* Did this device lose its session without asking to?
     A paired phone signs in AS the owner, so anything that revokes the account's
     sessions takes this computer with it - and until now nothing noticed. The app
     kept showing the farm, kept saying "Saved to your account", and only admitted
     something was wrong when the farmer tried to add a phone. _hadSession is what
     separates a revoke from an ordinary cold start on a device nobody has signed
     in on yet; _signingOut is what separates it from the farmer's own Sign out. */
  let _authLost = false, _signingOut = false, _hadSession = false;

  function client() {
    if (sb) return sb;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error('supabase-js not loaded — add the CDN <script> before ai-data.js');
    }
    sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    /* Every write in this file passes through here, so the edit time cannot be
       forgotten at a call site - the way three separate whitelists once let
       Supplier and Reference sync as NULL. Only .upsert carries an edit time up:
       an .insert has no stored row to be stale against, and a .update patch that
       omits updated_at leaves the trigger to stamp server now().

       All three come back through here as well (-415). The row memory is what decides
       whether a row has been changed since this device last saw it, and a write moves
       the server's copy on: an accepted one is stamped now(), a refused one keeps a
       version this device has never seen. Filled only at load, the memory started
       lying the moment the app wrote anything - and a later save that matched those
       stale values was read as "unchanged", sent with an edit time the server left
       behind long ago, and thrown away with a 200. Proved on the live SA account on
       17 Sep 2026: amount 500 sent, 200 returned, the row still 650. So every write
       asks for the rows it wrote and the memory takes the answer. */
    try{
      var _rawFrom = sb.from.bind(sb);
      sb.from = function(table){
        var qb = _rawFrom(table);
        try{
          ['upsert','update','insert'].forEach(function(verb){
            var raw = qb[verb];
            if(typeof raw !== 'function') return;
            qb[verb] = function(vals, opts){
              var sent = (verb === 'upsert') ? _srvPrep(table, vals) : vals;
              return _srvWatch(table, verb, sent, raw.call(qb, sent, opts));
            };
          });
        }catch(e){}
        return qb;
      };
    }catch(e){}
    /* Installed once, with the client. supabase-js refreshes the token in the
       background; when the refresh token is refused it clears the session and
       emits here, which is the only moment this device can learn that its login
       is gone. Nothing is torn down - what the farmer has typed stays on the
       device - but the status must stop claiming the server has it. */
    try{
      sb.auth.onAuthStateChange(function(evt, session){
        if(session){ _hadSession = true; _authLost = false; return; }
        if(_hadSession && !_signingOut) _authLost = true;
      });
    }catch(e){}
    return sb;
  }

  // ---- 2. AUTH (email magic link) ------------------------------------------
  const auth = {
    async sendMagicLink(email) {
      const { error } = await client().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: APP_URL }
      });
      if (error) throw error;
      return true; // user must click the link in their email
    },
    async signIn(email, password) {            // password sign-in — handy for testing (no email)
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    /* Self-serve sign-up. Email confirmation is ON in the project, so this returns
       NO session — the farmer must click the link in their inbox first. The caller
       shows the "check your email" screen when needsConfirm is true.
       Supabase deliberately will not tell you an email is already registered
       (account enumeration). The one honest tell: for an existing account it
       returns a user whose identities array is EMPTY. We surface that as `already`
       so the UI can nudge toward signing in — without ever asserting the address
       is taken, which would leak exactly what the API is protecting. */
    async signUp(email, password) {
      const { data, error } = await client().auth.signUp({
        email: email,
        password: password,
        options: { emailRedirectTo: APP_URL }
      });
      if (error) throw error;
      const u = (data && data.user) || null;
      const already = !!(u && Array.isArray(u.identities) && u.identities.length === 0);
      return { user: u, session: (data && data.session) || null,
               needsConfirm: !(data && data.session), already: already };
    },
    /* Forgot password. The email lands the farmer back on APP_URL with a recovery
       session in the URL fragment (implicit flow — so opening the mail on a phone
       while signing up on a laptop still works, which PKCE would not allow).
       Like signUp, this never reveals whether the address is registered. */
    async resetPassword(email) {
      const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
      if (error) throw error;
      return true;
    },
    /* Set the new password. Only valid while the recovery session from that link is
       live, which is why the UI must not sign the farmer into the app first. */
    async updatePassword(newPassword) {
      const { data, error } = await client().auth.updateUser({ password: newPassword });
      if (error) throw error;
      return (data && data.user) || null;
    },
    /* Re-send the confirmation email. Supabase rate-limits these server-side, so the
       UI also holds a cooldown — a farmer hammering the button would otherwise just
       collect errors. */
    async resendConfirm(email) {
      const { error } = await client().auth.resend({
        type: 'signup', email: email,
        options: { emailRedirectTo: APP_URL }
      });
      if (error) throw error;
      return true;
    },
    /* Sign THIS device out, not every device on the account.
       Every paired phone signs in as the owner, and Supabase's default scope is
       'global' - so Sign out on the computer revoked the phones' sessions too
       (found 19 Sep 2026 in a production test, from the other direction: the test
       phone's sign-out ended the computer's session). The phone was fixed then;
       this is the computer's half. Pass { scope:'global' } deliberately if a
       "sign out everywhere" is ever offered for a lost or stolen device. */
    async signOut(opts) {
      _signingOut = true;
      _srvForget(); try{ live.stop(); }catch(e){}
      try { await client().auth.signOut({ scope: (opts && opts.scope) || 'local' }); }
      finally { _authLost = false; }
    },
    /* True once this device's session went away on its own. The app asks before it
       claims anything was saved to the account. */
    lost() { return _authLost; },
    async currentUser() {
      const { data } = await client().auth.getUser();
      return data ? data.user : null;
    },
    onAuth(cb) {
      client().auth.onAuthStateChange((evt, session) => cb(session ? session.user : null, evt));
    }
  };

  // ---- 3. FARM CONTEXT -----------------------------------------------------
  const farm = {
    async mine() {
      // farms the signed-in user belongs to (RLS limits this automatically)
      const { data, error } = await selectAll(() => client()
        .from('farms').select('id,name,owner_name,province,farm_ha,farm_type,fy_start_month,lang')
        .order('created_at', { ascending: true }));
      if (error) throw error;
      return data || [];
    },
    async create(name) {
      // SECURITY DEFINER RPC: inserts the farm + adds you as owner atomically
      const { data, error } = await client().rpc('create_farm', { p_name: name });
      if (error) throw error;
      farm.setActive(data);
      return data; // new farm uuid
    },
    setActive(id) { _srvForget(); try { localStorage.setItem(ACTIVE_FARM_KEY, id); } catch (e) {} },
    active() { try { return localStorage.getItem(ACTIVE_FARM_KEY); } catch (e) { return null; } },
    async clearData(farmId) {
      // SECURITY DEFINER RPC: deletes every farm-scoped row for this farm
      // (auto-discovers all public tables with a farm_id column), keeping the
      // farm itself so the user stays signed in with an empty farm.
      const fid = farmId || farm.active();
      if (!fid) return;
      const { error } = await client().rpc('clear_farm_data', { p_farm_id: fid });
      if (error) throw error;
      return true;
    }
  };

  // ---- 4. CATEGORY CACHE + MAPPING -----------------------------------------
  function norm(s){ return (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]/g,''); }
  function toISO(d){
    if(!d) return null;
    var s = String(d);
    if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    var dt = new Date(s); if (isNaN(dt.getTime())) return null;
    /* toISOString() renders UTC: a display date like "11 Aug 2026" parses at LOCAL
       midnight, so for any timezone ahead of UTC (all of South Africa, UTC+2) it
       became "2026-08-10" — every quick-add landed a day early on the server,
       crossing month ends into the wrong VAT period and financial year. Use the
       local calendar date the farmer actually picked. */
    var p = function(n){ return (n < 10 ? '0' : '') + n; };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }
  async function loadCats(farmId) {
    // system rows (farm_id null) + this farm's custom rows; RLS handles visibility
    const { data, error } = await selectAll(() => client()
      .from('categories').select('id,kind,code,label,is_system,sort,active')
      .or(`farm_id.is.null,farm_id.eq.${farmId}`)
      .eq('active', true).order('sort', { ascending: true }));
    if (error) throw error;
    catMaps = { code2id: {}, id2code: {}, list: data || [] };
    (data || []).forEach(c => {
      catMaps.code2id[norm(c.code)] = c.id;
      catMaps.code2id[norm(c.label)] = c.id;   // match ignoring case/spaces/&
      catMaps.id2code[c.id] = c.code;
    });
    return data || [];
  }
  const catToId   = code => (code == null ? null : (catMaps.code2id[norm(code)] || null));
  const catToCode = id   => (id   == null ? null : (catMaps.id2code[id]   || null));
  /* THE CATEGORY SPELLING FLIPS ON EVERY ROUND-TRIP, AND THAT IS THE BUG BEHIND A WHOLE
     CLASS OF SILENT MISCALCULATIONS. Three spellings exist for one category: the table's
     `code` ("Seeds&Planting"), the table's `label` (sentence case, "Seeds & planting")
     and the app's display name ("Seeds & Planting"). catToCode returns the CODE, so a
     transaction the farmer just typed carries the display name and matches every literal
     in index.html — and the same row, after one page reload, matches none of them.
     Thirty comparison sites depend on the display spelling (cost-of-sales classification,
     the byCat report lines, the loan-repayment interest split), and they were all quietly
     failing after a hydrate. Single-word categories like Fertiliser matched by luck and
     hid it. Normalise HERE, at the one boundary where server rows become app rows, rather
     than at thirty call sites — that way any comparison written in future works too.
     Rewriting the stored rows instead is what makes the category migration re-run on
     every load. normalizeCat lives in the app script; it is defined by the time any of
     this runs, but guard anyway so a load-order change can never throw. */
  function _appCat(code){
    if (!code) return code;
    try { if (typeof global.normalizeCat === 'function') return global.normalizeCat(code) || code; } catch (e) {}
    return code;
  }
  async function ensureCats() { if (!catMaps.list.length) await loadCats(farm.active()); }

  // ---- 5. SHAPE MAPPING (app txn <-> db row) -------------------------------
  function appToDb(t, farmId) {
    const row = {
      farm_id:        farmId,
      account_id:     t.accountId || null,
      category_id:    catToId(t.cat),
      txn_date:       toISO(t.date) || toISO(new Date()),   // local "today" — the UTC form lost a day before 2am SAST
      type:           t.type,                       // 'income' | 'expense'
      amount:         Number(t.amt),
      description:    t.desc || null,
      payment_method: t.method || null,             // 'Cash' | 'Card' | 'EFT'
      reference:      t.ref || null,
      note:           t.note || null,
      quantity:       (t.qty != null && t.qty !== '') ? Number(t.qty) : null,
      unit:           t.unit || null,
      enterprise:     t.ent || null,
      source:         t.source || null,
      import_batch_id: t.batch || null,       // which import brought this row in
      client_uid:     t.cuid || null          // idempotency key for offline-safe retries
    };
    /* "Keep as is" needs a column that older databases don't have. Sending an unknown
       column makes PostgREST reject the whole write, which would break every save — so
       only include it once we've seen the column exist. */
    if (CAN_CAT_CONFIRM) row.cat_confirmed = !!t._catOk;
    /* What the matcher suggested when the farmer settled this line. Without it, a line
       settled against a suggestion that later proves wrong stays wrong for ever - six
       bank fees on the live farm did exactly that (20 Sep 2026). */
    if (CAN_CAT_OK_CAT) row.cat_ok_cat_id = t._catOkCat || null;
    /* Same rule as cat_confirmed: gate on the probe, or a database that has not had the
       para 12 migration rejects EVERY transaction write, not just this field. */
    if (CAN_TXN_ASSET) row.asset_id = _txAssetUuid(t);
    /* "No, it was tax" — a separate answer from _catOk/cat_confirmed on purpose.
       Settling where a cost is FILED is not the same as settling whether it comes off
       your tax, and conflating them is what let a bulk recategorise silence both. */
    if (CAN_TXN_DEDOK) row.ded_confirmed = !!t._dedOk;
    if (CAN_TXN_CAPOK) row.cap_confirmed = !!t._capOk;
    /* The receipt's STORAGE PATH only — never the image bytes. A base64 receipt that
       has not finished uploading stays on the device (t.receipt.data) and is sent on a
       later save, so a slow or offline upload never blocks the transaction itself. */
    /* Who the money came from / went to. `reference` already had a column and a
       display row — it was only ever the form that failed to read the box. */
    if (CAN_TXN_PARTY) row.counterparty = t.party || null;
    if (CAN_TXN_RECEIPT) {
      var _rc = t.receipt || null;
      row.receipt_path = (_rc && _rc.url && !/^data:/.test(_rc.url)) ? _rc.url : null;
      row.receipt_name = row.receipt_path ? (_rc.name || null) : null;
      row.receipt_kind = row.receipt_path ? (_rc.kind || null) : null;
    }
    return row;
  }
  /* The asset a transaction paid for, as the SERVER's id. The link is stored locally as
     a numeric ST_ASSETS id (matching how loans do it), so it has to be translated on the
     way out — and _assetUuid is honoured too, so a row that came from the server and was
     never re-linked on this device keeps its link instead of quietly losing it. */
  /* Which farm's asset register has actually been fetched this session. Set by
     load.assets; until it matches the active farm, nothing below may treat a missing
     machine as a sold one. */
  let _assetsSeenFor = null;
  function _txAssetUuid(t){
    if (!t) return null;
    const arr = (global.ST_ASSETS && global.ST_ASSETS.assets) || [];
    const seen = !!(_assetsSeenFor && _assetsSeenFor === farm.active());
    /* The register for this farm has arrived and this machine is not in it: it was sold
       or scrapped, and the server has already cleared its own copy of the tie (asset_id
       is ON DELETE SET NULL). Sending the id anyway was refused with 23503 on every later
       edit of the payment - permanently. Nor may the stale local number stand in for it:
       a new machine that took that number would inherit the payment on the server.
       Reproduced on the live UK account 16 Sep 2026 (-413). */
    if (t._assetUuid && seen){
      for (let j = 0; j < arr.length; j++){ if (arr[j] && arr[j]._aiId === t._assetUuid) return t._assetUuid; }
      return null;
    }
    if (t.assetId != null){
      try{
        for (let i = 0; i < arr.length; i++){
          if (String(arr[i].id) === String(t.assetId)) return arr[i]._aiId || null;
        }
      }catch(e){}
    }
    return t._assetUuid || null;      // assets not loaded yet — never downgrade to null
  }
  /* Set by probeCaps() on the first load; false until proven otherwise. */
  let CAN_CAT_CONFIRM  = false;
  let CAN_TXN_ASSET    = false;
  let CAN_TXN_DEDOK    = false;
  let CAN_ASSET_NOPAY  = false;
  let CAN_FARM_CONSENT = false;
  let CAN_TXN_RECEIPT  = false;
  let CAN_ORCH_DOCFILE = false;
  let CAN_TXN_PARTY    = false;
  /* Orchard attachment references, the rest of a compliance check, block markets, the
     planning "leave it out of the forecast" answer and picking pay-run detail. Each had
     no column, so each was written locally and dropped on sync. Gated like every other
     late-added column: a database without the migration keeps working, minus the field. */
  let CAN_ORCH_ATT     = false;
  let CAN_ORCH_CHKMETA = false;
  let CAN_ORCH_MARKETS = false;
  let CAN_PLANEVT_FC   = false;
  let CAN_PAYRUN_META  = false;
  /* Asset disposals. Gated like every other late-added column: a database without the
     migration keeps working, and the disposal stays on the device instead of throwing. */
  /* Farm settings that were saved to localStorage and sent nowhere: the confirmed bank
     balance, the season start month, the budget target, and the four nested blobs
     (lender-pack inputs, crop prices, farmer-added crop types, forward selling). Probed
     on bank_balance; without the migration they stay on the device as before. */
  let CAN_FARM_SETTINGS = false;
  let CAN_FARM_RAIN     = false;
  let CAN_FARM_RAIN_NK  = false;   // farms.rain_not_kept (rainfall_not_kept.sql)
  let CAN_FARM_RAIN_RULE= false;   // farms.rain_plant_mm/_days + rain_fill_sat (rainfall_farm_settings.sql)
  let CAN_FARM_RAIN_DRV = false;   // farms.rain_derived (rain_derived_migration.sql)
  let CAN_FARM_STOCK    = false;   // farms.stock_counts (stock_counts_migration.sql)
  let CAN_FARM_BANK_AT  = false;   // farms.bank_balance_at (bank_balance_at_migration.sql)
  let CAN_FARM_VAT_CAT  = false;   // farms.vat_category (vat_category_migration.sql)
  let CAN_FARM_PARTNERS = false;   // farms.partners (farms_partners_migration.sql)
  let _bankSeen = null;            // the balance the server last gave us
  /* Filing rules. Without the table they stay on the device, which is how the UK build
     shipped them — defensible there because that project is not provisioned, and not
     here, where a farmer moves between a laptop and a tablet. */
  let CAN_CAT_RULES     = false;
  let CAN_REMINDERS     = false;   // push_devices: is this phone still being reminded?
  let CAN_LOOKS         = false;   // transaction_looks: the computer's stored "needs a look" answer
  let CAN_CAT_OK_CAT    = false;   // transactions.cat_ok_cat_id: what "keep as is" was told
  let CAN_FUEL_METER    = false;
  let CAN_FUEL_SRC      = false;
  /* Payslips that stay what was paid (payslips_migration.sql, signed off 19 Sep 2026).
     Without it the desktop works payslips out as it always has, and nothing is kept. */
  let CAN_PAYSLIPS      = false;   // payslips + payslip_sends
  let CAN_WORKER_PHONE  = false;   // workers.phone / payslip_whatsapp_ok / _on / payslip_lang
  let CAN_DEVICES       = false;   // farm_devices: "whose phone is this?"
  let CAN_ORCH_PARTS    = false;   // orchard_sprays: rate/batch/operator_cert/weather
  let CAN_INPUT_WEATHER = false;   // crop_inputs.weather
  /* Correcting and removing a spray or input (spray_corrections.sql, signed off 23 Sep).
     One flag a table: the script alters each table in its own statement, so a half-run
     script must not read as finished. Until it has run the app REFUSES to remove - a
     removal the server cannot store would come straight back on the next load. */
  let CAN_ORCH_FIX      = false;   // orchard_sprays: removed_at/removed_reason/removed_by/changes
  let CAN_INPUT_FIX     = false;   // crop_inputs:    the same four
  let CAN_ASSET_DISPOSAL = false;
  /* "It's a running cost, stop asking." Its own column rather than reusing cat_confirmed:
     that answer is about the CATEGORY being right, this one is about the cost not being
     capital, and a farmer can mean one without the other. */
  let CAN_TXN_CAPOK      = false;
  /* ---- what this database actually has, asked once ------------------------
     Every late-added column is gated on a CAN_* flag, and every flag used to cost
     its own round trip - 34 of them, in series, on EVERY financeCore load, which
     the transaction outbox triggers again after a flush. Two things were wrong
     with that beyond the latency:

       1. `catch(e){ return false; }` treated a dropped connection, a timeout or a
          401 as "the column is not there". A farmer on a rural link could lose a
          single probe and have CAN_UPDATED_AT flipped off for the session - which
          silently disables _srvStamp, _srvPrep and _srvWatch on all 43 tables,
          i.e. the whole row-memory scheme and the -415 read-back with it.
       2. Nothing was remembered, so a later flaky run could DOWNGRADE an answer
          this device had already learned was true.

     Now: definitive answers are cached for the session and never re-asked, so a
     known column can never be un-learned; a probe that could not reach the server
     is not an answer and is not stored. app_columns() answers the whole set in one
     round trip where it exists, and where it does not the probes still run - in
     parallel rather than in series - so this works on a database that has never had
     the migration. See 02-database/app_columns_migration.sql. */
  var _colCache = Object.create(null);          // "table.column" -> true | false
  var _colRpcDead = false;                      // the function is not on this project

  /* A single column, probed the old way. Returns null for "could not ask", which is
     NOT an answer: only 42703 / PGRST204 mean the column is really absent. NOT
     select=count - PostgREST treats count as an aggregate and returns 200 whether or
     not the column exists, so it would report every column as present. */
  async function _probeCol(table, col){
    try{
      const r = await client().from(table).select(col).limit(1);
      if(!r.error) return true;
      const code = String((r.error && r.error.code) || '');
      const msg  = String((r.error && r.error.message) || '');
      if(code === '42703' || code === 'PGRST204') return false;
      if(/does not exist|Could not find the/i.test(msg) && /column/i.test(msg)) return false;
      return null;
    }catch(e){ return null; }
  }

  /* Fill the cache for every pair we do not already know. */
  async function _learnCols(pairs){
    const want = pairs.filter(function(p){ return !((p[0] + '.' + p[1]) in _colCache); });
    if(!want.length) return;

    if(!_colRpcDead){
      const tables = [];
      want.forEach(function(p){ if(tables.indexOf(p[0]) < 0) tables.push(p[0]); });
      let rows = null;
      try{
        const r = await client().rpc('app_columns', { p_tables: tables });
        if(!r.error && Array.isArray(r.data)) rows = r.data;
        else if(r.error) _colRpcDead = true;   // not migrated: stop asking this session
      }catch(e){ _colRpcDead = true; }
      if(rows){
        const seen = Object.create(null);
        rows.forEach(function(row){ seen[String(row.t) + '.' + String(row.c)] = true; });
        /* The function answered for these tables, so a pair it did not name is
           genuinely absent - a definitive No, safe to remember. */
        want.forEach(function(p){ _colCache[p[0] + '.' + p[1]] = !!seen[p[0] + '.' + p[1]]; });
        return;
      }
    }

    /* Fallback: ask per column, all at once rather than one after another. */
    const answers = await Promise.all(want.map(function(p){ return _probeCol(p[0], p[1]); }));
    want.forEach(function(p, i){
      if(answers[i] !== null) _colCache[p[0] + '.' + p[1]] = answers[i];
    });
  }

  /* Every column any CAN_* flag depends on. */
  var CAP_COLS = [
    ['transactions','cat_confirmed'], ['transactions','asset_id'], ['transactions','ded_confirmed'],
    ['transactions','receipt_path'], ['transactions','counterparty'], ['transactions','cap_confirmed'],
    ['transactions','cat_ok_cat_id'], ['transactions','updated_at'],
    ['assets','no_payment'], ['assets','disposal_date'],
    ['farms','consent_version'], ['farms','bank_balance'], ['farms','rain_lat'],
    ['farms','rain_not_kept'], ['farms','rain_plant_days'], ['farms','rain_fill_sat'],
    ['farms','rain_derived'], ['farms','stock_counts'], ['farms','bank_balance_at'],
    ['farms','vat_category'], ['farms','partners'],
    ['orchard_block_docs','path'], ['orchard_harvest','att'],
    ['orchard_compliance_checks','check_iso'], ['orchard_blocks','markets'],
    ['plan_events','in_forecast'], ['pay_runs','source'],
    ['category_rules','match_text'], ['transaction_looks','look_v'],
    ['push_devices','last_ok_at'], ['fuel_issues','hour_meter'], ['fuel_issues','src'],
    ['orchard_sprays','rate'], ['crop_inputs','weather'], ['orchard_sprays','removed_at'], ['crop_inputs','removed_at'],
    ['payslips','snap'], ['payslip_sends','outcome'],
    ['workers','payslip_whatsapp_ok'], ['farm_devices','kind']
  ];

  async function probeCaps(farmId){
    if (!farmId) return;
    await _learnCols(CAP_COLS);
    /* Only a cached TRUE turns a flag on. An unanswered probe leaves the flag as it
       was, so a bad moment on the line cannot switch the row-memory scheme off. */
    const has = function(t, c){ return _colCache[t + '.' + c] === true; };
    const keep = function(cur, t, c){
      const k = t + '.' + c;
      return (k in _colCache) ? _colCache[k] === true : cur;
    };
    CAN_CAT_CONFIRM = keep(CAN_CAT_CONFIRM, 'transactions', 'cat_confirmed');
    CAN_TXN_ASSET   = keep(CAN_TXN_ASSET,   'transactions', 'asset_id');
    CAN_TXN_DEDOK   = keep(CAN_TXN_DEDOK,   'transactions', 'ded_confirmed');
    CAN_ASSET_NOPAY = keep(CAN_ASSET_NOPAY, 'assets',       'no_payment');
    CAN_FARM_CONSENT= keep(CAN_FARM_CONSENT,'farms',        'consent_version');
    CAN_TXN_RECEIPT = keep(CAN_TXN_RECEIPT, 'transactions', 'receipt_path');
    CAN_ORCH_DOCFILE= keep(CAN_ORCH_DOCFILE,'orchard_block_docs','path');
    CAN_TXN_PARTY   = keep(CAN_TXN_PARTY,   'transactions','counterparty');
    CAN_ORCH_ATT    = keep(CAN_ORCH_ATT,    'orchard_harvest','att');
    CAN_ORCH_CHKMETA= keep(CAN_ORCH_CHKMETA,'orchard_compliance_checks','check_iso');
    CAN_ORCH_MARKETS= keep(CAN_ORCH_MARKETS,'orchard_blocks','markets');
    CAN_PLANEVT_FC  = keep(CAN_PLANEVT_FC,  'plan_events','in_forecast');
    CAN_PAYRUN_META = keep(CAN_PAYRUN_META, 'pay_runs','source');
    CAN_ASSET_DISPOSAL = keep(CAN_ASSET_DISPOSAL,'assets','disposal_date');
    CAN_TXN_CAPOK      = keep(CAN_TXN_CAPOK,     'transactions','cap_confirmed');
    CAN_FARM_SETTINGS  = keep(CAN_FARM_SETTINGS, 'farms','bank_balance');
    CAN_FARM_RAIN      = keep(CAN_FARM_RAIN,     'farms','rain_lat');
    CAN_FARM_RAIN_NK   = keep(CAN_FARM_RAIN_NK,  'farms','rain_not_kept');
    if(('farms.rain_plant_days' in _colCache) && ('farms.rain_fill_sat' in _colCache))
      CAN_FARM_RAIN_RULE = has('farms','rain_plant_days') && has('farms','rain_fill_sat');
    CAN_FARM_RAIN_DRV  = keep(CAN_FARM_RAIN_DRV, 'farms','rain_derived');
    CAN_FARM_STOCK     = keep(CAN_FARM_STOCK,    'farms','stock_counts');
    CAN_FARM_BANK_AT   = keep(CAN_FARM_BANK_AT,  'farms','bank_balance_at');
    CAN_FARM_VAT_CAT   = keep(CAN_FARM_VAT_CAT,  'farms','vat_category');
    CAN_FARM_PARTNERS  = keep(CAN_FARM_PARTNERS, 'farms','partners');
    CAN_CAT_RULES      = keep(CAN_CAT_RULES,     'category_rules','match_text');
    CAN_LOOKS          = keep(CAN_LOOKS,         'transaction_looks','look_v');
    CAN_REMINDERS      = keep(CAN_REMINDERS,     'push_devices','last_ok_at');
    CAN_CAT_OK_CAT     = keep(CAN_CAT_OK_CAT,    'transactions','cat_ok_cat_id');
    /* The whole row-memory scheme rides on this one column. A project that has not
       run agriinsights-13-relational-sync.sql keeps today's behaviour rather than
       having every write rejected for an unknown column - and, now, a project that
       HAS run it cannot lose the answer to a dropped packet. */
    CAN_UPDATED_AT     = keep(CAN_UPDATED_AT,    'transactions','updated_at');
    /* The SARS diesel logbook fields the phone captures at the pump. Gated the same
       way: an un-migrated project must keep saving fuel, not lose every issue. */
    CAN_FUEL_METER     = keep(CAN_FUEL_METER,    'fuel_issues','hour_meter');
    CAN_FUEL_SRC       = keep(CAN_FUEL_SRC,      'fuel_issues','src');
    if(('payslips.snap' in _colCache) && ('payslip_sends.outcome' in _colCache))
      CAN_PAYSLIPS     = has('payslips','snap') && has('payslip_sends','outcome');
    CAN_WORKER_PHONE   = keep(CAN_WORKER_PHONE,  'workers','payslip_whatsapp_ok');
    CAN_DEVICES        = keep(CAN_DEVICES,       'farm_devices','kind');
    /* The particulars a spray register prints. An un-migrated project still saves
       the spray - it just cannot carry rate, batch, certificate or the weather at
       application until 02-database/orchard_spray_particulars.sql has run. rate is
       the sentinel: the four arrive together. */
    CAN_ORCH_PARTS     = keep(CAN_ORCH_PARTS,    'orchard_sprays','rate');
    CAN_INPUT_WEATHER  = keep(CAN_INPUT_WEATHER, 'crop_inputs','weather');
    CAN_ORCH_FIX       = keep(CAN_ORCH_FIX,      'orchard_sprays','removed_at');
    CAN_INPUT_FIX      = keep(CAN_INPUT_FIX,     'crop_inputs','removed_at');
  }
  /* A harness needs to drive a second load and a bad line; the app never calls these. */
  probeCaps.reset = function(){ _colCache = Object.create(null); _colRpcDead = false; };
  probeCaps.seen  = function(){ return _colCache; };
  /* ================== ROW MEMORY - two-device safety (Phase 0) ==================
     What this device actually LOADED from the server, per table.

     The desktop saves a module by upserting its whole in-memory state and then
     deleting "everything for this farm that I am not currently holding". That is
     safe on one device and destructive on two: a row the phone wrote after this
     tab loaded was never in this tab's hands, so the prune removes it and the
     farmer never learns it existed.

     This registry is the memory that makes the difference. Three jobs:

       1. updated_at. A row we have NOT changed is written back carrying the edit
          time we hold, so guard_updated_at (02-database/agriinsights-13-relational-
          sync.sql) keeps the newer stored row instead of letting our stale copy
          overwrite it. A row we HAVE changed carries no updated_at at all, so the
          trigger stamps server now() and the farmer's own edit always lands.
          This device's clock is never written into the database - only a timestamp
          the server itself produced - so a wrong clock can neither reject a real
          edit nor park a row in the future.

       2. Prune. A delete may only name rows THIS device loaded. Anything that
          arrived afterwards was never ours to remove.

       3. Reconciliation. Herd head counts can be told apart from what the moves
          ledger actually says - see load.livestock.
     =========================================================================== */
  let CAN_UPDATED_AT = false;
  var _SRV = Object.create(null);

  /* What identifies a row inside its own table. Anything not listed is keyed on
     local_id - the app's own id, and the conflict target for most upserts. */
  var _SRV_KEY = {
    transactions:             ['client_uid'],
    herd_classes:             ['herd_local_id','class_key'],
    livestock_benchmarks:     ['bench_key'],
    orchard_pricing:          ['block_local_id'],
    orchard_compliance_items: ['item_key'],
    crop_compliance_areas:    ['area_key'],
    payroll_entries:          ['period_label','worker_local_id'],
    budget_months:            ['period_year','period_month','side']
  };
  function _srvKey(table,row){
    if(!row || typeof row!=='object') return null;
    var f=_SRV_KEY[table]||['local_id'], out=[], i, v;
    for(i=0;i<f.length;i++){
      v=row[f[i]];
      if(v===undefined||v===null||v==='') return null;   // no identity - cannot be tracked
      out.push(String(v));
    }
    return out.join('\u0001');
  }

  /* Called from load.* with rows exactly as the server returned them. Replaces the
     table's memory outright: a fresh load is fresh truth. */
  function _srvNote(table,rows){
    var t={ rows:Object.create(null), ids:[], maxUa:null };
    (rows||[]).forEach(function(r){
      if(!r || typeof r!=='object') return;
      var k=_srvKey(table,r); if(k!=null) t.rows[k]=r;
      /* Newest edit time the server gave us, used as the prune boundary. One row
         without it and the boundary is abandoned: a NULL would slip past an
         lte() filter and survive every replace, quietly doubling up. */
      if(t.maxUa !== false){
        if(!r.updated_at) t.maxUa = false;
        else if(!t.maxUa || r.updated_at > t.maxUa) t.maxUa = r.updated_at;
      }
      /* The server primary key, kept even for rows with no identity of their own:
         the replace-all children (compliance logs, docs, checks, readings) are
         positional, and their id is the only handle a scoped delete has. */
      if(r.id!=null) t.ids.push(r.id);
    });
    _SRV[table]=t;
    return rows;
  }
  /* Sign-out, or a switch to another farm. Another farm's rows are not ours. */
  function _srvForget(){ _SRV=Object.create(null); }

  /* Server bookkeeping, not content - never part of the changed/unchanged test. */
  var _SRV_SKIP={ updated_at:1, created_at:1, id:1 };
  function _srvSame(prev,row){
    if(!prev) return false;
    for(var k in row){
      if(!Object.prototype.hasOwnProperty.call(row,k) || _SRV_SKIP[k]) continue;
      var a=row[k], b=prev[k];
      if(a===b) continue;
      /* Empty is empty. Every *ToDb in this file writes `x || null`, so a column the
         server is holding as '' and a row rebuilding it as null are the same fact,
         and calling that a change would mean no row was ever seen as unchanged.
         Deliberately NOT extended to false or 0: `leaving` on a livestock move is
         three-state, where absent and false mean different things. */
      var aE=(a===null||a===undefined||a===''), bE=(b===null||b===undefined||b==='');
      if(aE && bE) continue;
      if(aE !== bE) return false;
      if(typeof a==='object' || typeof b==='object'){
        try{ if(JSON.stringify(a)===JSON.stringify(b)) continue; }catch(e){}
        return false;
      }
      /* Postgres hands numerics back as numbers or as strings depending on the
         column type, so compare loosely rather than calling every numeric row
         changed. Being wrong in this direction is safe: a row wrongly called
         changed is simply written the way it is written today. */
      if(String(a)===String(b)) continue;
      var na=Number(a), nb=Number(b);
      if(typeof a!=='boolean' && typeof b!=='boolean' &&
         a!=='' && b!=='' && !isNaN(na) && !isNaN(nb) && na===nb) continue;
      return false;
    }
    return true;
  }

  /* Carry the held edit time on a row we have not touched; say nothing about a row
     we have. Upserts only - a plain .insert() has no stored row to be stale
     against, and a .update() patch that omits updated_at already leaves the
     trigger to stamp server now(). */
  function _srvStamp(table,row){
    if(!CAN_UPDATED_AT || !row || typeof row!=='object') return row;
    if(Object.prototype.hasOwnProperty.call(row,'updated_at')) return row;   // caller decided
    var t=_SRV[table], k=_srvKey(table,row);
    var prev=(t && k!=null) ? t.rows[k] : null;
    if(prev && prev.updated_at && _srvSame(prev,row)) row.updated_at=prev.updated_at;
    return row;
  }
  function _srvPrep(table,vals){
    if(!CAN_UPDATED_AT) return vals;
    try{
      if(Array.isArray(vals)){ for(var i=0;i<vals.length;i++) _srvStamp(table,vals[i]); }
      else _srvStamp(table,vals);
    }catch(e){}
    return vals;
  }

  /* ---- what the server actually kept (-415) --------------------------------------
     _srvStamp above can only be as honest as the memory it reads. These three keep
     that memory equal to the server's own copy instead of to a snapshot taken when
     the table loaded. */
  var _srvKept = [];

  /* Ask for the rows back, then hand them to the memory. In this library a later
     .select() from the caller REPLACES this one, so a caller that wants its own
     columns still gets them, and one that only reads .error is unaffected. Every
     table either app writes was read as the signed-in farmer before this shipped
     (38 on SA, 35 on UK), so asking cannot turn a working save into a refusal. */
  function _srvWatch(table, verb, sent, b){
    if(!CAN_UPDATED_AT || !b || typeof b.then !== 'function') return b;
    try{
      if(typeof b.select === 'function') b.select();
      var _then = b.then;
      b.then = function(ok, no){
        return _then.call(b, function(r){
          try{ _srvSettled(table, verb, sent, r); }catch(e){}
          return ok ? ok(r) : r;
        }, no);
      };
    }catch(e){}
    return b;
  }

  /* A row the server hands back IS the server's copy, so it replaces whatever the
     memory held - never merged into it: a half-answer that kept old values for the
     columns it did not carry would be a memory that lies in the one direction that
     costs an edit. Replacing at worst forgets, and a forgotten row is simply written
     without an edit time, which always lands. */
  function _srvSettled(table, verb, sent, res){
    if(!res || res.error) return;
    var rows = res.data; if(!rows) return;
    if(!Array.isArray(rows)) rows = [rows];
    if(!rows.length) return;
    var t = _SRV[table];
    if(!t){ t = _SRV[table] = { rows:Object.create(null), ids:[], maxUa:false }; }
    var byKey = Object.create(null);
    rows.forEach(function(r){
      var k = _srvKey(table, r);
      if(k == null) return;
      byKey[k] = r; t.rows[k] = r;
    });
    if(verb !== 'upsert') return;
    /* What went up against what came back. They differ only when guard_updated_at
       kept the stored row - which now means one thing: this device sent values it
       had not changed and another device has edited that row since. Keeping theirs
       is right; saying nothing about it is how this went unseen for a month. */
    (Array.isArray(sent) ? sent : [sent]).forEach(function(row){
      if(!row || typeof row !== 'object') return;
      if(!Object.prototype.hasOwnProperty.call(row, 'updated_at')) return;
      var k = _srvKey(table, row); if(k == null) return;
      var got = byKey[k]; if(!got || _srvSame(got, row)) return;
      _srvKept.push({ table:table, key:k, at:Date.now() });
      if(_srvKept.length > 50) _srvKept.shift();
      try{ console.warn('AgriInsights: ' + table + ' - the server kept its own copy of a row this '
        + 'device sent unchanged. Another device has edited it since; taking the server version.'); }catch(e){}
    });
  }

  /* The identities of rows this device loaded from `table` that the farmer has
     since removed - the only rows a prune is entitled to delete.
       keep   : {identity: 1} the caller still holds
       field  : the column carrying the identity
       filter : optional, to scope to one parent (a herd's classes, say)
     Returns null when the table was never loaded: the caller must then prune
     nothing rather than guess. */
  function _srvGone(table,keep,field,filter){
    var t=_SRV[table];
    if(!t) return null;
    var out=[];
    Object.keys(t.rows).forEach(function(k){
      var r=t.rows[k];
      if(filter && !filter(r)) return;
      var v=r[field];
      if(v===undefined||v===null||v==='') return;
      v=String(v);
      if(!keep[v] && out.indexOf(v)<0) out.push(v);
    });
    return out;
  }
  /* Server primary keys this device loaded - the scope for a replace-all child
     table, whose rows are positional and have no identity of their own. */
  function _srvIds(table){ var t=_SRV[table]; return t ? t.ids.slice() : null; }
  /* Rows THIS device wrote belong in its row memory too. The memory was only ever filled
     by a load, so a row added and then removed in the same session was never in it: the
     prune skipped it, the server kept it, and it came back on the next load - proven on
     both live test accounts with a filing rule (14 Sep 2026). Only rows the memory does
     not already hold are added: a loaded row keeps the server's copy, whose updated_at
     is what stops an unchanged row reading as freshly edited on the next save. Rows
     another device wrote are still never in here, so they are still never pruned. */
  function _srvWrote(table, rows){
    var t = _SRV[table];
    if(!t){ t = _SRV[table] = { rows:Object.create(null), ids:[], maxUa:false }; }
    (rows||[]).forEach(function(r){ var k = _srvKey(table, r); if(k != null && !(k in t.rows)) t.rows[k] = r; });
  }
  /* And a row the prune has deleted leaves the memory, so the next save does not try again. */
  function _srvForgetRows(table, field, values, filter){
    var t = _SRV[table]; if(!t || !values || !values.length) return;
    var gone = Object.create(null); values.forEach(function(v){ gone[String(v)] = 1; });
    Object.keys(t.rows).forEach(function(k){ var r = t.rows[k];
      if(filter && !filter(r)) return;
      if(gone[String(r[field])]) delete t.rows[k]; });
  }

  /* The scoped form of "delete everything for this farm, then insert my copy".
     A replace-all child table (compliance logs and docs, plan rows, the worker
     ledger) holds positional rows with no identity of their own, so the only
     honest scope is time: delete what was already there when this device loaded,
     and leave anything written since - by the phone, or by another desktop -
     alone. The boundary is the newest edit time the SERVER gave us, never this
     device's clock.

     Two deliberate fallbacks, both of which prefer a visible duplicate to a
     silent deletion:
       - table never loaded here: prune nothing, warn once.
       - no updated_at column (agriinsights-13-relational-sync.sql not run):
         keep today's whole-table replace, because there is no way to tell new
         rows from old ones. */
  /* ---- stock reconciliation: what the moves ledger says the count should be ----
     A herd's qty is NOT the sum of its moves. A herd is created with an opening
     number the farmer types and moves accrue from there, so "recount from the
     ledger" has no starting point. The answerable question is narrower: which
     moves is the stored count not counting yet?

     A move created AFTER its herd row was last written is one of them - the phone
     records a birth, and the herds row still carries the number this desktop wrote
     before that. The test only became truthful once an unchanged herd row stopped
     bumping its own updated_at on every save (see ROW MEMORY above); before that,
     every herd looked freshly written whether or not anything had changed.

     Sign rule, kept identical to _lsAdjustHead in index.html - the two must never
     drift: born and bought add, promote shifts heads between classes and nets to
     zero, and sold / died / slaughter / stolen / missing / traded take away.
     A move already carries its resolved class (lsRecordMove fills in the young
     class for a birth before it writes the record), so the classes move with it. */
  var _LS_ADDS  = { born:1, bought:1 };
  var _LS_NEUTRAL = { promote:1 };
  function _lsPendingMoves(herdRows, moveRows){
    var writtenAt = {};
    (herdRows||[]).forEach(function(r){
      if(r && r.local_id!=null) writtenAt[String(r.local_id)] = r.updated_at || null;
    });
    var out = {};
    (moveRows||[]).forEach(function(m){
      if(!m || m.herd_local_id==null) return;
      var reason = String(m.reason||'');
      if(_LS_NEUTRAL[reason]) return;
      var hid = String(m.herd_local_id), saved = writtenAt[hid];
      /* No timestamp either side and there is no way to tell - say nothing rather
         than double-count a move the stored figure already includes. */
      if(!saved || !m.created_at) return;
      if(!(m.created_at > saved)) return;            // already in the stored count
      var q = parseInt(m.qty,10)||0; if(q<=0) return;
      var signed = _LS_ADDS[reason] ? q : -q;
      var o = out[hid] || (out[hid] = { delta:0, n:0, cls:{} });
      o.delta += signed; o.n++;
      if(m.cls) o.cls[String(m.cls)] = (o.cls[String(m.cls)]||0) + signed;
    });
    return out;
  }

  /* After a replace-all save, the rows this device holds are the ones it just
     wrote. Without this the SECOND save of a session still points at the ids it
     LOADED - already deleted by the first save - so the first save's rows survive
     the prune and the second inserts alongside them. A harness in 06-tools caught
     the table growing 1 -> 3 -> 4 across three edits. */
  function _srvSetIds(table, ids){
    var t = _SRV[table];
    if(!t){ t = _SRV[table] = { rows:Object.create(null), ids:[], maxUa:false }; }
    t.ids = (ids||[]).slice();
  }
  /* The scoped replace-all: insert what the farmer holds, then remove only the rows
     THIS device loaded or last wrote. Returns an error rather than throwing, which
     is the contract every call site here already expects.

     Two rules it will not bend:
       - insert BEFORE delete, so a failed write leaves the previous state standing
         rather than an empty table;
       - a table this device never loaded is pruned NOT AT ALL. Reading its ids now
         and deleting them destroys rows another device wrote, which is the whole
         hazard this registry exists to prevent. A visible duplicate is recoverable,
         a silent deletion is not - and _srvSetIds then gives the next save a proper
         scope, so at worst it doubles once and corrects itself. */
  var _pruneWarned = Object.create(null);
  async function replaceAllRows(table, fid, rows){
    try {
      var oldIds = _srvIds(table);
      if (oldIds === null){
        if(!_pruneWarned[table]){
          _pruneWarned[table] = 1;
          console.warn('AgriInsights: ' + table + ' was never loaded on this device - '
            + 'leaving its rows alone rather than replacing what it cannot see.');
        }
        oldIds = [];
      }
      var newIds = [];
      if (rows && rows.length){
        var ins = await client().from(table).insert(rows).select('id');
        if (ins.error) return ins.error;                 // old rows still standing
        newIds = (ins.data || []).map(function(r){ return r.id; });
      }
      for (var i = 0; i < oldIds.length; i += 100){
        var e = (await client().from(table).delete().in('id', oldIds.slice(i, i + 100))).error;
        if (e) return e;
      }
      _srvSetIds(table, newIds);
      return null;
    } catch(err){ return err; }
  }

  function dbToApp(r) {
    return {
      id:       r.id,
      date:     r.txn_date,
      amt:      Number(r.amount),
      cat:      _appCat(catToCode(r.category_id)),
      type:     r.type,
      desc:     r.description || '',
      method:   r.payment_method || '',
      ref:      r.reference || '',
      note:     r.note || '',
      accountId: r.account_id || null,
      recur:    r.recurring_id || null,
      batch:    r.import_batch_id || null,
      qty:      (r.quantity != null) ? Number(r.quantity) : undefined,
      unit:     r.unit || undefined,
      ent:      r.enterprise || undefined,
      source:   r.source || undefined,
      cuid:     r.client_uid || undefined,
      party:    r.counterparty || undefined,
      /* Comes back as a path, not an image. The viewer swaps it for a short-lived
         signed URL on demand, the same way asset and worker documents work. */
      receipt:  r.receipt_path ? { url:r.receipt_path, name:r.receipt_name || 'receipt',
                                   kind:r.receipt_kind || 'image' } : undefined,
      /* When the row reached the farm account. Rows that arrived together came from the
         same import, which is how imports made before we recorded them are grouped. */
      _added:   r.created_at || undefined,
      /* The server's answer whenever it has the column - false included. It used to be
         "true or nothing", and preservePendingTxns fills a missing flag from the local row,
         so once this computer had confirmed a line nothing could un-confirm it: the phone's
         Undo after its Accept had gone up (or any other device) set cat_confirmed=false,
         the pull read "nothing", the stale local true was laid back over it - and the
         computer's next save of the row wrote true to the server again (19 Sep 2026).
         _txNeedsLook reads it as truthy/falsy, so false and "never asked" still mean the
         same there. Undefined only when the database has no such column. */
      _catOk:   (r.cat_confirmed === true) ? true : (r.cat_confirmed === false ? false : undefined),
      /* Null is a real answer here: "settled, but we were not recording what it was told". */
      _catOkCat: r.cat_ok_cat_id || null,
      /* The asset this payment bought, as the server's uuid. Deliberately NOT converted
         to a local ST_ASSETS id here: assets may not be loaded yet when transactions
         arrive, and the loans code already shows what happens then — loanFromDb sets
         _assetUuid with a comment saying it is "resolved to a local id after assets
         load", and nothing anywhere does that, so a loan's asset link is lost on every
         cloud round-trip. txLinkedAsset() resolves at the point of use instead, which
         cannot race the load order. */
      _assetUuid: r.asset_id || undefined,
      /* The server's answer, false included, for the same reason as _catOk: it is also
         laid over from the local row when missing. False and never-asked read the same
         (the question is asked again); only a truthy value settles it. */
      _dedOk:     (r.ded_confirmed === true) ? true : (r.ded_confirmed === false ? false : undefined),
      _capOk:     (r.cap_confirmed === true) ? true : undefined
    };
  }

  // ---- import batches -------------------------------------------------------
  /* The panel's record of "where did these rows come from". Ids are generated client-side
     as UUIDs so an import works offline and re-syncs without creating duplicates. */
  const importBatch = {
    async list(farmId) {
      const fid = farmId || farm.active(); if (!fid) return [];
      const { data, error } = await selectAll(() => client()
        .from('import_batches').select('*').eq('farm_id', fid)
        .order('imported_at', { ascending: false }));
      if (error) throw error;
      return (data || []).filter(b => b.status !== 'undone').map(b => ({
        id:     b.id,
        source: b.source || 'Import',
        rows:   (b.txn_count != null) ? Number(b.txn_count) : 0,
        when:   b.imported_at || null,
        kind:  (b.meta && b.meta.kind)  || 'file',
        span:  (b.meta && b.meta.span)  || '',
        note:  (b.meta && b.meta.note)  || ''
      }));
    },
    /* The id is minted on this device and is the row's key, so an upsert makes a
       retry write the same batch rather than fail on the key (-411). */
    async create(batch, farmId) {
      const fid = farmId || farm.active(); if (!fid || !batch) return null;
      const { data, error } = await client().from('import_batches').upsert({
        id:          batch.id,
        farm_id:     fid,
        source:      batch.source || 'Import',
        txn_count:   batch.rows || 0,
        status:      'active',
        imported_at: batch.when || new Date().toISOString(),
        meta:        { kind: batch.kind || 'file', span: batch.span || '', note: batch.note || '' }
      }, { onConflict: 'id' }).select().single();
      if (error) throw error;
      return data;
    },
    async remove(id) {
      if (!id) return;
      /* Mark rather than delete: the transactions carry this id as a foreign key, and a
         hard delete would either fail or orphan them depending on the constraint. */
      const { error } = await client().from('import_batches')
        .update({ status: 'undone' }).eq('id', id);
      if (error) throw error;
    }
  };

  // ---- 6. LOAD FINANCE CORE ------------------------------------------------
  /* PostgREST caps every select at `max-rows` (1000 on Supabase) — a farm with more rows
     than that silently loaded only the first 1000, understating every total, report and tax
     figure with no warning. selectAll() pages through with .range() until a short page comes
     back. buildQuery must return a FRESH builder each call (a builder can't be re-awaited).
     Returns the same {data, error} shape as a normal select, so call sites barely change. */
  async function selectAll(buildQuery, pageSize) {
    pageSize = pageSize || 1000;
    let out = [], from = 0;
    for (;;) {
      const r = await buildQuery().range(from, from + pageSize - 1);
      if (r.error) return { data: null, error: r.error };
      const rows = r.data || [];
      out = out.concat(rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return { data: out, error: null };
  }

  const load = {
    async financeCore(farmId) {
      if (!farmId) throw new Error('No active farm');
      await loadCats(farmId);
      await probeCaps(farmId);          // learn once whether cat_confirmed exists
      /* The import panel's records. Never fatal: a farm with no imports, or a database
         without the table, must still load its transactions. */
      let impBatches = [];
      try { impBatches = await importBatch.list(farmId); } catch (e) { impBatches = []; }

      const [acc, txn, bud, rec, fst] = await Promise.all([
        selectAll(() => client().from('accounts').select('*').eq('farm_id', farmId).order('name')),
        selectAll(() => client().from('transactions').select('*').eq('farm_id', farmId).order('txn_date', { ascending: false })),
        client().from('budget_months').select('*').eq('farm_id', farmId),
        client().from('recurring').select('*').eq('farm_id', farmId).order('name'),
        client().from('farms').select('budget_income_pattern,budget_expense_pattern,budget_current_month').eq('id', farmId).single()
      ]);
      for (const r of [acc, txn, bud, rec]) if (r.error) throw r.error;
      _srvNote('accounts', acc.data);      _srvNote('transactions', txn.data);
      _srvNote('budget_months', bud.data); _srvNote('recurring', rec.data);

      var bObj = { monthlyIncome: {}, monthlyExpenses: {},
        incomePattern: (fst.data && fst.data.budget_income_pattern) || 'harvest',
        expensePattern: (fst.data && fst.data.budget_expense_pattern) || 'planting',
        currentMonth: (fst.data && fst.data.budget_current_month) || null };
      (bud.data || []).forEach(function (r) {
        var lbl = ymToLabel(r.period_year, r.period_month);
        if (r.side === 'income') bObj.monthlyIncome[lbl] = Number(r.amount);
        else bObj.monthlyExpenses[lbl] = Number(r.amount);
      });

      return {
        accounts:   acc.data || [],
        categories: catMaps.list,
        batches:    impBatches,
        txns:       (txn.data || []).map(dbToApp),
        budgets:    bObj,
        recurring:  (rec.data || []).map(r => ({
          id: (r.local_id != null && r.local_id !== '') ? r.local_id : r.id,
          name: r.name, type: r.type, amt: Number(r.amount),
          freq: r.frequency, category: _appCat(catToCode(r.category_id)),
          months: r.months || undefined,
          accountId: r.account_id, nextDate: r.next_date, active: r.active
        }))
      };
    },
    async assets(farmId) {
      farmId = farmId || farm.active();
      const { data, error } = await selectAll(() => client().from('assets').select('*').eq('farm_id', farmId).order('created_at'));
      if (error) throw error;
      _assetsSeenFor = farmId;          // this farm's register is now known (-413)
      return (data || []).map(assetToApp);
    },
    async loans(farmId) {
      farmId = farmId || farm.active();
      const [l, o, c] = await Promise.all([
        selectAll(() => client().from('loans').select('*').eq('farm_id', farmId).order('created_at')),
        selectAll(() => client().from('overdrafts').select('*').eq('farm_id', farmId).order('created_at')),
        selectAll(() => client().from('coop_accounts').select('*').eq('farm_id', farmId).order('created_at'))
      ]);
      for (const r of [l, o, c]) if (r.error) throw r.error;
      const out = { loans: [], overdrafts: [], coopAccounts: [], archived: [] };
      (l.data || []).forEach(function (r) { var m = loanFromDb(r); if (r.archived) { m._kind = 'loan'; m.archived = true; out.archived.push(m); } else out.loans.push(m); });
      (o.data || []).forEach(function (r) { var m = odFromDb(r); if (r.archived) { m._kind = 'overdraft'; m.archived = true; out.archived.push(m); } else out.overdrafts.push(m); });
      (c.data || []).forEach(function (r) { var m = coopFromDb(r); if (r.archived) { m._kind = 'coop'; m.archived = true; out.archived.push(m); } else out.coopAccounts.push(m); });
      // Reconstruct the monthly paid-marks (ST_LOANS.confirmed) from the loan rows.
      var confMonth = null, confPaid = {};
      (l.data || []).forEach(function (r) { if (r.confirmed_off != null && r.confirmed_month) { confMonth = r.confirmed_month; confPaid[r.local_id] = Number(r.confirmed_off); } });
      out.confirmed = confMonth ? { month: confMonth, paid: confPaid } : null;
      return out;
    }
  };

  // ---- 7. WRITE: TRANSACTIONS ----------------------------------------------
  // client_uid is added by a migration; until it runs we fall back to a plain
  // insert so the app keeps working (no dedupe protection until the SQL is run).
  var _cuidUnsupported = false;
  function _isMissingCuid(err){
    if(!err) return false;
    var m = ((err.message||'') + ' ' + (err.details||'') + ' ' + (err.hint||'')).toLowerCase();
    var c = String(err.code||'');
    return m.indexOf('client_uid') >= 0 || c === 'pgrst204' || c === '42703' || c === '42p10';
  }
  function _warnCuid(err){
    if(_cuidUnsupported) return;
    _cuidUnsupported = true;
    console.warn('AgriInsights: transactions.client_uid not found \u2014 run the offline-outbox migration in Supabase for duplicate-safe sync. (' + ((err&&err.message)||err) + ')');
  }
  const txn = {
    async add(t) {
      const farmId = farm.active();
      await ensureCats();
      const row = appToDb(t, farmId);
      if (row.client_uid && !_cuidUnsupported) {
        const up = await client().from('transactions')
          .upsert(row, { onConflict: 'farm_id,client_uid' }).select().single();
        if (!up.error) return dbToApp(up.data);
        if (!_isMissingCuid(up.error)) throw up.error;
        _warnCuid(up.error);                       // column missing -> fall through to insert
      }
      delete row.client_uid;
      const { data, error } = await client()
        .from('transactions').insert(row).select().single();
      if (error) throw error;
      return dbToApp(data);
    },
    async addMany(list) {                       // bulk upsert (imports / outbox flush) — one round-trip
      if (!list || !list.length) return [];
      const farmId = farm.active();
      await ensureCats();
      const rows = list.map(function (t) { return appToDb(t, farmId); });
      const hasCuid = rows.some(function(r){ return r.client_uid; });
      if (hasCuid && !_cuidUnsupported) {
        const up = await client().from('transactions')
          .upsert(rows, { onConflict: 'farm_id,client_uid' }).select();
        if (!up.error) return (up.data || []).map(dbToApp);
        if (!_isMissingCuid(up.error)) throw up.error;
        _warnCuid(up.error);
      }
      rows.forEach(function(r){ delete r.client_uid; });
      const { data, error } = await client()
        .from('transactions').insert(rows).select();
      if (error) throw error;
      return (data || []).map(dbToApp);          // PostgREST preserves insert order
    },
    async update(id, t) {
      const farmId = farm.active();
      await ensureCats();
      const { data, error } = await client()
        .from('transactions').update(appToDb(t, farmId)).eq('id', id).select().single();
      if (error) throw error;
      return dbToApp(data);
    },
    async remove(id) {
      const { error } = await client().from('transactions').delete().eq('id', id);
      if (error) throw error;
      return true;
    }
  };

  // ---- 8. WRITE: ACCOUNTS / BUDGETS / RECURRING ----------------------------
  const account = {
    async add(a) {
      const { data, error } = await client().from('accounts').insert({
        farm_id: farm.active(), name: a.name, kind: a.kind,
        opening_balance: Number(a.openingBalance || 0), is_default: !!a.isDefault
      }).select().single();
      if (error) throw error;
      return data;
    }
  };
  var MON_ABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function labelToYM(label){ var p = String(label||'').trim().split(/\s+/); var m = MON_ABBR.indexOf(p[0]); return { month: m>0?m:null, year: parseInt(p[1],10) || null }; }
  function ymToLabel(y,m){ return MON_ABBR[m] + ' ' + y; }
  const budget = {
    // Persist the whole budget object: per-month income/expense targets + settings
    async save(b) {
      if (!b) return;
      var fid = farm.active();
      var rows = [];
      Object.keys(b.monthlyIncome || {}).forEach(function (lbl) {
        var ym = labelToYM(lbl);
        if (ym.month && ym.year) rows.push({ farm_id: fid, period_year: ym.year, period_month: ym.month, side: 'income', amount: Number(b.monthlyIncome[lbl]) || 0 });
      });
      Object.keys(b.monthlyExpenses || {}).forEach(function (lbl) {
        var ym = labelToYM(lbl);
        if (ym.month && ym.year) rows.push({ farm_id: fid, period_year: ym.year, period_month: ym.month, side: 'expense', amount: Number(b.monthlyExpenses[lbl]) || 0 });
      });
      if (rows.length) {
        var r1 = await client().from('budget_months').upsert(rows, { onConflict: 'farm_id,period_year,period_month,side' });
        if (r1.error) throw r1.error;
      }
      /* This write moves the farm row's version, which is what every Settings save
         carries to prove it is not stale (-406). Live-tested 16 Sep 2026: writing the
         same three values back still moved it, in both apps. So read the new version
         back and hand it to Settings, or every budget edit sends the next Settings save
         down the refetch-merge-retry path for nothing (-411). */
      var r2 = await client().from('farms').update({
        budget_income_pattern: b.incomePattern || null,
        budget_expense_pattern: b.expensePattern || null,
        budget_current_month: b.currentMonth || null
      }).eq('id', fid).select('budget_income_pattern,budget_expense_pattern,budget_current_month,updated_at');
      if (r2.error) throw r2.error;
      try { if ((r2.data || []).length) _profNoteAck(r2.data[0]); } catch (e) {}
      return true;
    }
  };
  const recurring = {
    /* The bill keeps the name this device gave it (it was minted and then thrown away),
       so sending it again after a failure updates that row instead of adding a second
       bill (-411). */
    async add(r) {
      await ensureCats();
      const row = {
        farm_id: farm.active(), local_id: (r.id != null && r.id !== '') ? String(r.id) : null,
        name: r.name, type: r.type, amount: Number(r.amt),
        frequency: r.freq, category_id: catToId(r.category || r.cat),
        account_id: r.accountId || null, next_date: r.nextDate || null,
        months: r.months || null
      };
      const q = (row.local_id == null)
        ? client().from('recurring').insert(row)
        : client().from('recurring').upsert(row, { onConflict: 'farm_id,local_id' });
      const { data, error } = await q.select().single();
      if (error) throw error;
      return data;
    },
    async update(id, r) {
      await ensureCats();
      const payload = {
        name: r.name, type: r.type, amount: Number(r.amt),
        frequency: r.freq, category_id: catToId(r.category || r.cat),
        account_id: r.accountId || null, next_date: r.nextDate || null,
        months: r.months || null
      };
      /* By the device's own name where there is one, so an edit works on a bill whose
         first write never reached the server. */
      if (r && r.id != null && r.id !== '' && farm.active()) {
        const u = await client().from('recurring').update(payload)
          .eq('farm_id', farm.active()).eq('local_id', String(r.id)).select();
        if (u.error) throw u.error;
        if ((u.data || []).length) return u.data[0];
      }
      if (!id) return;
      const { data, error } = await client().from('recurring').update(payload).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },
    async remove(id, localId) {
      if (localId != null && localId !== '' && farm.active()) {
        const d = await client().from('recurring').delete()
          .eq('farm_id', farm.active()).eq('local_id', String(localId));
        if (d.error) throw d.error;
        if (!id) return true;
      }
      if (!id) return true;
      const { error } = await client().from('recurring').delete().eq('id', id);
      if (error) throw error;
      return true;
    }
  };

  // ---- ASSETS --------------------------------------------------------------
  function assetToDb(a) {
    const row = {
      /* The device's own number for this asset, written down so it survives the round
         trip. Without it an asset had no name of its own until the server answered: a
         write that failed could never be sent again, and the numbers were dealt out
         fresh on every load - which is how a payment came to point at the wrong machine
         (proved 16 Sep 2026, fixed in -411). */
      local_id: (a.id != null && a.id !== '') ? String(a.id) : null,
      name: a.name, category: a.cat || null, subtype: a.subtype || null,
      purchase_date: a.date || null, price: Number(a.price) || 0,
      depr_type: a.deprType || null,
      life_years: (a.life != null && a.life !== '') ? parseInt(a.life, 10) : null,
      notes: a.notes || null,
      financed: !!a.financed, lender: a.lender || null,
      outstanding: (a.outstanding != null && a.outstanding !== '') ? Number(a.outstanding) : null,
      instalment: (a.instalment != null && a.instalment !== '') ? Number(a.instalment) : null,
      rate: (a.rate != null && a.rate !== '') ? Number(a.rate) : null,
      insured_value: (a.insuredValue != null && a.insuredValue !== '') ? Number(a.insuredValue) : null,
      insurer: a.insurer || null, renewal_date: a.renewalDate || null,
      // Persist doc METADATA + Storage path only — never the base64 blob.
      docs: (a.docs && a.docs.length) ? a.docs.map(function(d){ return { id:d.id||null, name:d.name||null, kind:d.kind||null, url:d.url||'' }; }) : null
    };
    /* The farmer's "there is no payment for this in my books". Without it syncing, the
       reconcile panel re-asks on every other device — and a question that comes back
       after you answered it is how a panel earns being ignored. */
    if (CAN_ASSET_NOPAY) row.no_payment = !!a._noPayment;
    /* Written even when the asset is NOT disposed — the nulls are what clear a disposal
       the farmer has undone. Sending them only when set would leave a sale recorded on
       every other device forever. */
    if (CAN_ASSET_DISPOSAL) {
      row.disposal_date     = a.disposalDate || null;
      row.disposal_proceeds = (a.disposalProceeds != null && a.disposalProceeds !== '') ? Number(a.disposalProceeds) : null;
      row.disposal_reason   = a.disposalReason || null;
    }
    return row;
  }
  function assetToApp(r) {
    var a = {
      _aiId: r.id, name: r.name, cat: r.category, subtype: r.subtype || '',
      date: r.purchase_date || '', price: Number(r.price) || 0,
      deprType: r.depr_type || 'none', life: (r.life_years != null ? r.life_years : 0),
      notes: r.notes || '', docs: r.docs || []
    };
    a.financed = !!r.financed;
    if (r.financed) { a.lender = r.lender || ''; a.outstanding = Number(r.outstanding) || 0; a.instalment = Number(r.instalment) || 0; a.rate = Number(r.rate) || 0; }
    if (r.insured_value != null) a.insuredValue = Number(r.insured_value);
    if (r.insurer) a.insurer = r.insurer;
    if (r.renewal_date) a.renewalDate = r.renewal_date;
    if (r.no_payment === true) a._noPayment = true;      // only when true, as above
    if (r.disposal_date) {
      a.disposalDate     = r.disposal_date;
      a.disposalProceeds = Number(r.disposal_proceeds) || 0;
      a.disposalReason   = r.disposal_reason || 'sold';
    }
    /* Keep the number the device that registered it gave it. Rows written before the
       column existed have none; hydrate numbers those, and only those. */
    if (r.local_id != null && r.local_id !== '') { var _ln = Number(r.local_id); if (_ln === _ln) a.id = _ln; }
    return a;
  }
  /* Every write is keyed on the farm's own number for the asset, so the save queue can
     send the same one twice without registering a second tractor. The server's id is
     still honoured when it is all the caller has (rows from before the column). */
  const asset = {
    async add(a) {
      const row = Object.assign({ farm_id: farm.active() }, assetToDb(a));
      const q = (row.local_id == null)
        ? client().from('assets').insert(row)
        : client().from('assets').upsert(row, { onConflict: 'farm_id,local_id' });
      const { data, error } = await q.select().single();
      if (error) throw error;
      return data;
    },
    async update(id, a) {
      const row = assetToDb(a);
      if (row.local_id != null) {
        const { data, error } = await client().from('assets')
          .upsert(Object.assign({ farm_id: farm.active() }, row), { onConflict: 'farm_id,local_id' })
          .select().single();
        if (error) throw error;
        return data || true;
      }
      if (!id) return;
      const { error } = await client().from('assets').update(row).eq('id', id);
      if (error) throw error;
      return true;
    },
    async remove(id, localId) {
      var q = client().from('assets').delete();
      if (id) q = q.eq('id', id);
      else if (localId != null && localId !== '' && farm.active()) q = q.eq('farm_id', farm.active()).eq('local_id', String(localId));
      else return;
      const { error } = await q;
      if (error) throw error;
      return true;
    }
  };

  // ---- LOANS & DEBT --------------------------------------------------------
  // Loans/overdrafts/co-op accounts use their own stable string ids ('comb',
  // 'ln3', 'od1', 'oc1') so we key DB rows on that and sync the whole set.
  function loanToDb(l, extra) {
    extra = extra || {};
    return { local_id: l.id, icon: l.icon || null, name: l.name || null, lender: l.lender || null,
      type: l.type || null, borrowed: Number(l.borrowed) || 0, balance: Number(l.balance) || 0,
      rate: Number(l.rate) || 0, payment: Number(l.payment) || 0, next_label: l.next || null,
      funds_for: l.fundsFor || null, archived: !!l.archived,
      asset_id: extra.assetUuid || null,
      confirmed_off: (extra.confOff != null) ? Number(extra.confOff) : null,
      confirmed_month: extra.confMonth || null };
  }
  function loanFromDb(r) {
    var m = { id: r.local_id, icon: r.icon || '\uD83C\uDFE6', name: r.name || '', lender: r.lender || '',
      type: r.type || 'Loan', assetId: null, borrowed: Number(r.borrowed) || 0, balance: Number(r.balance) || 0,
      rate: Number(r.rate) || 0, payment: Number(r.payment) || 0, next: r.next_label || 'next month',
      fundsFor: r.funds_for || undefined };
    if (r.asset_id) m._assetUuid = r.asset_id;          // resolved to a local id after assets load
    if (r.confirmed_off != null) m._confOff = Number(r.confirmed_off);
    if (r.confirmed_month) m._confMonth = r.confirmed_month;
    return m;
  }
  function odToDb(o) {
    return { local_id: o.id, icon: o.icon || null, name: o.name || null, lender: o.lender || null,
      credit_limit: Number(o.limit) || 0, used: Number(o.used) || 0, rate_mode: o.rateMode || 'prime',
      prime: Number(o.prime) || 0, margin: Number(o.margin) || 0, flat_rate: Number(o.flatRate) || 0,
      funds_for: o.fundsFor || null, archived: !!o.archived };
  }
  function odFromDb(r) {
    return { id: r.local_id, icon: r.icon || '\uD83C\uDFE6', name: r.name || '', lender: r.lender || '',
      limit: Number(r.credit_limit) || 0, used: Number(r.used) || 0, rateMode: r.rate_mode || 'prime',
      prime: Number(r.prime) || 0, margin: Number(r.margin) || 0, flatRate: Number(r.flat_rate) || 0,
      fundsFor: r.funds_for || undefined };
  }
  function coopToDb(o) {
    return { local_id: o.id, icon: o.icon || null, name: o.name || null, coop: o.coop || null,
      lender: o.lender || null, credit_limit: Number(o.limit) || 0, used: Number(o.used) || 0,
      rate_mode: o.rateMode || 'prime', prime: Number(o.prime) || 0, margin: Number(o.margin) || 0,
      flat_rate: Number(o.flatRate) || 0, funds_for: o.fundsFor || null, archived: !!o.archived };
  }
  function coopFromDb(r) {
    return { id: r.local_id, icon: r.icon || '\uD83C\uDF3E', name: r.name || '', coop: r.coop || '',
      lender: r.lender || r.coop || '', limit: Number(r.credit_limit) || 0, used: Number(r.used) || 0,
      rateMode: r.rate_mode || 'prime', prime: Number(r.prime) || 0, margin: Number(r.margin) || 0,
      flatRate: Number(r.flat_rate) || 0, fundsFor: r.funds_for || undefined };
  }
  var _loanSnap = null;
  const loans = {
    // Upsert the whole loan/overdraft/co-op set. No-ops when nothing changed.
    async saveAll(st) {
      if (!st) return;
      const fid = farm.active(); if (!fid) return;
      const snap = JSON.stringify({ l: st.loans, o: st.overdrafts, c: st.coopAccounts, a: st.archived, cf: st.confirmed });
      if (snap === _loanSnap) return;
      const lList = (st.loans || []).slice();
      const oList = (st.overdrafts || []).slice();
      const cList = (st.coopAccounts || []).slice();
      (st.archived || []).forEach(function (it) {
        var k = it._kind || 'loan';
        if (k === 'overdraft') oList.push(it);
        else if (k === 'coop') cList.push(it);
        else lList.push(it);
      });
      function _assetUuidFor(localId) {
        try { var arr = (global.ST_ASSETS && global.ST_ASSETS.assets) || [];
          for (var i = 0; i < arr.length; i++) { if (String(arr[i].id) === String(localId)) return arr[i]._aiId || null; }
        } catch (e) {} return null;
      }
      var conf = (st.confirmed && st.confirmed.paid) ? st.confirmed : null;
      const lRows = lList.map(function (l) {
        var extra = {
          assetUuid: (l.assetId != null) ? _assetUuidFor(l.assetId) : null,
          confOff:   (conf && conf.paid[l.id] != null) ? conf.paid[l.id] : null,
          confMonth: (conf && conf.paid[l.id] != null) ? conf.month : null
        };
        return Object.assign({ farm_id: fid }, loanToDb(l, extra));
      });
      const oRows = oList.map(function (o) { return Object.assign({ farm_id: fid }, odToDb(o)); });
      const cRows = cList.map(function (o) { return Object.assign({ farm_id: fid }, coopToDb(o)); });
      if (lRows.length) { const e = (await client().from('loans').upsert(lRows, { onConflict: 'farm_id,local_id' })).error; if (e) throw e; }
      if (oRows.length) { const e = (await client().from('overdrafts').upsert(oRows, { onConflict: 'farm_id,local_id' })).error; if (e) throw e; }
      if (cRows.length) { const e = (await client().from('coop_accounts').upsert(cRows, { onConflict: 'farm_id,local_id' })).error; if (e) throw e; }
      _loanSnap = snap;
      return true;
    },
    async remove(kind, localId) {
      const fid = farm.active(); if (!fid || !localId) return;
      const table = kind === 'overdrafts' ? 'overdrafts' : (kind === 'coop_accounts' ? 'coop_accounts' : 'loans');
      const e = (await client().from(table).delete().eq('farm_id', fid).eq('local_id', localId)).error;
      if (e) throw e;
      _loanSnap = null;
      return true;
    }
  };

  // ---- CO-OP SETTLEMENTS ---------------------------------------------------
  // Sidecar to transactions: stores what the co-op kept per delivery so the
  // "What your co-op kept" card survives reload. The income txn + any account
  // paydown are persisted separately (txn.addMany / loans.saveAll via renderLoans).
  function isoToDisp(s){
    if(!s) return '';
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(!m) return String(s);
    return parseInt(m[3],10) + ' ' + MON_ABBR[parseInt(m[2],10)] + ' ' + m[1];
  }
  function csToDb(s, farmId){
    return {
      farm_id:     farmId,
      settle_date: toISO(s.date),
      coop:        s.coop || null,
      commodity:   s.commodity || null,
      tons:        (s.tons   != null) ? Number(s.tons)   : null,
      gross:       (s.gross  != null) ? Number(s.gross)  : null,
      net:         (s.net    != null) ? Number(s.net)    : null,
      ded:         (s.ded    != null) ? Number(s.ded)    : null,
      ded_items:   s.dedItems || null,
      paid:        (s.paid   != null) ? Number(s.paid)   : null,
      to_bank:     (s.toBank != null) ? Number(s.toBank) : null,
      batch:       s.batch || null
    };
  }
  function csFromDb(r){
    return {
      id:        r.id,
      date:      isoToDisp(r.settle_date),
      coop:      r.coop || '',
      commodity: r.commodity || 'Delivery',
      tons:      Number(r.tons)  || 0,
      gross:     Number(r.gross) || 0,
      net:       Number(r.net)   || 0,
      ded:       Number(r.ded)   || 0,
      dedItems:  r.ded_items || {},
      paid:      Number(r.paid)    || 0,
      toBank:    Number(r.to_bank) || 0,
      batch:     r.batch || undefined
    };
  }
  load.coopSettlements = async function(farmId){
    farmId = farmId || farm.active();
    const { data, error } = await selectAll(() => client()
      .from('coop_settlements').select('*').eq('farm_id', farmId)
      .order('created_at', { ascending: false }));
    if (error) throw error;
    return (data || []).map(csFromDb);
  };
  const coopSettlement = {
    /* An import's rows all carry the same batch, so a replay clears that batch and
       writes it again: the same import sent twice can never double a delivery (-411).
       Rows with no batch are inserted as before. */
    async addMany(list){
      if(!list || !list.length) return [];
      const farmId = farm.active();
      const rows = list.map(function(s){ return csToDb(s, farmId); });
      const seen = {}, batches = [];
      rows.forEach(function(r){ if(r.batch && !seen[r.batch]){ seen[r.batch] = 1; batches.push(r.batch); } });
      for (var bi = 0; bi < batches.length; bi++) {
        const d = await client().from('coop_settlements').delete()
          .eq('farm_id', farmId).eq('batch', batches[bi]);
        if (d.error) throw d.error;
      }
      const { data, error } = await client()
        .from('coop_settlements').insert(rows).select();
      if (error) throw error;
      return (data || []).map(csFromDb);
    },
    async removeByBatch(batch){
      const fid = farm.active(); if(!fid || !batch) return;
      const { error } = await client()
        .from('coop_settlements').delete().eq('farm_id', fid).eq('batch', batch);
      if (error) throw error;
      return true;
    }
  };

  // ---- LIVESTOCK (camps, herds, herd_classes, benchmarks) — 3a-i ----------
  // ST_LS is the source of truth; DB is mirrored to it. Herd ids stay as
  // local_id text so 'ls:<id>' enterprise tags keep resolving. Classes and
  // benchmarks live in their own queryable tables (D1/D3). Camps/herds use
  // upsert + explicit remove (a flaky load must never delete farm data);
  // classes/benchmarks are pruned to mirror edits-in-place.
  function _numIf(s){ var n=parseInt(s,10); return (String(n)===String(s))?n:s; }
  function _inList(keep){ return '('+keep.map(function(k){return '"'+String(k).replace(/"/g,'')+'"';}).join(',')+')'; }
  function campToDb(c,fid){ return { farm_id:fid, local_id:String(c.id), name:c.name||null, ha:(c.ha!=null&&c.ha!=='')?Number(c.ha):null, since:c.since||null, notes:c.notes||null }; }
  function campFromDb(r){ return { id:r.local_id, name:r.name||'', ha:(r.ha!=null)?Number(r.ha):0, since:r.since||'', notes:r.notes||'' }; }
  function herdToDb(h,fid){ return { farm_id:fid, local_id:String(h.id), type:h.type||null, name:h.name||null, breed:h.breed||null,
    camp:h.camp||null, camp_id:h.campId||null, track:!!h.track, planned:!!h.planned, qty:(h.qty!=null)?parseInt(h.qty,10):0,
    buy:(h.buy!=null&&h.buy!=='')?Number(h.buy):null, feed:(h.feed!=null&&h.feed!=='')?Number(h.feed):null,
    vet:(h.vet!=null&&h.vet!=='')?Number(h.vet):null, sell:(h.sell!=null&&h.sell!=='')?Number(h.sell):null,
    months:(h.months!=null&&h.months!=='')?parseInt(h.months,10):null, notes:h.notes||null,
    ages:h.ages||null, removed:(h.removed!=null)?!!h.removed:null,
    in_planning:(h.inPlanning!=null)?!!h.inPlanning:null, plan_head:(h.planHead!=null)?parseInt(h.planHead,10):null,
    plan_month:h.planMonth||null, plan_classes:(h.planClasses&&h.planClasses.length)?h.planClasses:null }; }
  function herdFromDb(r){ var h={ id:_numIf(r.local_id), type:r.type||'', name:r.name||'', qty:Number(r.qty)||0,
    buy:Number(r.buy)||0, feed:Number(r.feed)||0, vet:Number(r.vet)||0, sell:Number(r.sell)||0,
    months:(r.months!=null)?Number(r.months):0, notes:r.notes||'', camp:r.camp||'', campId:r.camp_id||'', track:!!r.track };
    if(r.planned) h.planned=true; if(r.breed) h.breed=r.breed;
    if(r.ages){ try{ h.ages=(typeof r.ages==='string'?JSON.parse(r.ages):r.ages); }catch(e){} }
    if(r.removed) h.removed=true;
    if(r.in_planning) h.inPlanning=true;
    if(r.plan_head!=null) h.planHead=Number(r.plan_head);
    if(r.plan_month) h.planMonth=r.plan_month;
    if(r.plan_classes){ try{ h.planClasses=(typeof r.plan_classes==='string'?JSON.parse(r.plan_classes):r.plan_classes); }catch(e){} }
    return h; }
  function classRows(h,fid){ return (h.classes||[]).map(function(c){ return { farm_id:fid, herd_local_id:String(h.id), class_key:c.k, count:(c.n!=null)?parseInt(c.n,10):0, class_value:(c.v!=null)?Number(c.v):0 }; }); }
  // 3a-ii — moves / treatments / animals (set-sync, append-only) + health (per-row)
  function moveToDb(m,fid){ return { farm_id:fid, local_id:String(m.id), herd_local_id:(m.herd!=null)?String(m.herd):null, reason:m.reason||null, qty:(m.qty!=null)?parseInt(m.qty,10):null, move_date:m.date||null, note:m.note||null, money:(m.money!=null)?Number(m.money):null, cls:m.cls||null, to_cls:m.toCls||null, leaving:(m.leaving!=null)?!!m.leaving:null, from_place:m.fromPlace||null, to_place:m.toPlace||null, transporter:m.transporter||null, veh_reg:m.vehReg||null, veh_make:m.vehMake||null }; }
  /* `leaving` is THREE-STATE and both directions must keep it that way: absent means
     nobody was ever asked, false means the farmer said the stock stays, true means it
     left. This read dropped false until 12 Sep 2026 — the desktop never writes false,
     only the phone's "No, it stays" does, so a phone answer came back as undefined and
     the next desktop save wrote null over it, destroying the answer in the database
     rather than only on screen. moveToDb has always preserved all three. */
  function moveFromDb(r){ var m={ id:r.local_id, herd:_numIf(r.herd_local_id), reason:r.reason||'', qty:Number(r.qty)||0, date:r.move_date||'', note:r.note||'', money:Number(r.money)||0 }; if(r.cls) m.cls=r.cls; if(r.to_cls) m.toCls=r.to_cls; if(r.leaving!=null) m.leaving=!!r.leaving; if(r.from_place) m.fromPlace=r.from_place; if(r.to_place) m.toPlace=r.to_place; if(r.transporter) m.transporter=r.transporter; if(r.veh_reg) m.vehReg=r.veh_reg; if(r.veh_make) m.vehMake=r.veh_make; return m; }
  function treatToDb(t,fid){ return { farm_id:fid, local_id:String(t.id), herd_local_id:(t.herd!=null)?String(t.herd):null, kind:t.kind||null, product:t.product||null, reg:t.reg||null, act:t.act||null, abx:(t.abx!=null)?!!t.abx:null, target:t.target||null, head:(t.head!=null)?parseInt(t.head,10):null, tags:t.tags||[], dose:t.dose||null, route:t.route||null, reason:t.reason||null, batch:t.batch||null, expiry:t.expiry||null, rx:t.rx||null, treat_date:t.date||null, by_who:t.by||null, cost:(t.cost!=null)?Number(t.cost):null, meat:(t.meat!=null)?parseInt(t.meat,10):null, milk:(t.milk!=null)?parseInt(t.milk,10):null }; }
  function treatFromDb(r){ var t={ id:r.local_id, herd:_numIf(r.herd_local_id), kind:r.kind||'', product:r.product||'', reg:r.reg||'', act:r.act||'', target:r.target||'', head:Number(r.head)||0, tags:r.tags||[], dose:r.dose||'', route:r.route||'', reason:r.reason||'', batch:r.batch||'', expiry:r.expiry||'', date:r.treat_date||'', by:r.by_who||'', cost:Number(r.cost)||0, meat:Number(r.meat)||0, milk:Number(r.milk)||0 }; /* abx is three-state like leaving: the phone's "No" is false, and reading only true turned it into unknown on the next livestock save. */ if(r.abx!=null) t.abx=!!r.abx; if(r.rx) t.rx=r.rx; return t; }
  function animalToDb(a,fid){ return { farm_id:fid, local_id:String(a.id), herd_local_id:(a.herd!=null)?String(a.herd):null, tag:a.tag||null, name:a.name||null, sex:a.sex||null, breed:a.breed||null, cls:a.cls||null, dob:a.dob||null, dam:a.dam||null, sire:a.sire||null, repro:(a.repro&&a.repro.length)?a.repro:null, status:a.status||null, due_approx:a.dueApprox||null, parity:a.parity||null, weight:(a.weight!=null?a.weight:null) }; }
  function animalFromDb(r){ var a={ id:r.local_id, herd:_numIf(r.herd_local_id), tag:r.tag||'', sex:r.sex||'' }; if(r.name) a.name=r.name; if(r.breed) a.breed=r.breed; if(r.cls) a.cls=r.cls; if(r.dob) a.dob=r.dob; if(r.dam) a.dam=r.dam; if(r.sire) a.sire=r.sire; if(r.repro){ try{ a.repro=(typeof r.repro==='string'?JSON.parse(r.repro):r.repro); }catch(e){} } if(r.status) a.status=r.status; if(r.due_approx) a.dueApprox=r.due_approx; if(r.parity) a.parity=r.parity; if(r.weight!=null) a.weight=r.weight; return a; }
  function healthToDb(h,fid){ return { farm_id:fid, local_id:h.id?String(h.id):null, health_date:h.date||null, type:h.type||null, event:h.event||null, count:(h.count!=null)?parseInt(h.count,10):null, descr:h.desc||null, cost:(h.cost!=null)?Number(h.cost):null, supplier:h.supplier||null }; }
  /* local_id rides back out again: without it a health record has no identity, and a
     background merge cannot tell one this device already holds from one the phone
     just wrote. healthToDb has always sent it. */
  function healthFromDb(r){ var h={ date:r.health_date||'', type:r.type||'', event:r.event||'', count:Number(r.count)||0, desc:r.descr||'', cost:Number(r.cost)||0, supplier:r.supplier||'' }; if(r.local_id!=null) h.id=r.local_id; return h; }
  // Breeding & calving (reproduction). Table livestock_breedings — see livestock_breeding_schema.sql.
  function breedingToDb(b,fid){ return { farm_id:fid, local_id:String(b.id), herd_local_id:(b.herd!=null)?String(b.herd):null, season:b.season||null, sire:b.sire||null, females:(b.females!=null)?parseInt(b.females,10):null, start_date:b.start||null, end_date:b.end||null, gestation:(b.gestation!=null)?parseInt(b.gestation,10):null, pd_date:b.pdDate||null, in_calf:(b.inCalf!=null)?parseInt(b.inCalf,10):null, empty:(b.empty!=null)?parseInt(b.empty,10):null, born:(b.born!=null)?parseInt(b.born,10):null, stillborn:(b.stillborn!=null)?parseInt(b.stillborn,10):null, weaned:(b.weaned!=null)?parseInt(b.weaned,10):null, wean_weight:(b.weanWeight!=null)?Number(b.weanWeight):null, wean_date:b.weanDate||null, status:b.status||null }; }
  function breedingFromDb(r){ var b={ id:r.local_id, herd:_numIf(r.herd_local_id), season:r.season||'', sire:r.sire||'', females:(r.females!=null)?Number(r.females):null, start:r.start_date||'', end:r.end_date||'', gestation:Number(r.gestation)||283, pdDate:r.pd_date||'', inCalf:(r.in_calf!=null)?Number(r.in_calf):null, empty:(r.empty!=null)?Number(r.empty):null, born:Number(r.born)||0, stillborn:Number(r.stillborn)||0, weaned:(r.weaned!=null)?Number(r.weaned):0, status:r.status||'breeding' }; if(r.wean_weight!=null) b.weanWeight=Number(r.wean_weight); if(r.wean_date) b.weanDate=r.wean_date; return b; }

  load.livestock = async function(farmId){
    farmId = farmId || farm.active();
    const [cp,hd,hc,bm,mv,tr,an,he] = await Promise.all([
      selectAll(() => client().from('livestock_camps').select('*').eq('farm_id',farmId).order('created_at')),
      selectAll(() => client().from('herds').select('*').eq('farm_id',farmId).order('created_at')),
      selectAll(() => client().from('herd_classes').select('*').eq('farm_id',farmId)),
      selectAll(() => client().from('livestock_benchmarks').select('*').eq('farm_id',farmId)),
      selectAll(() => client().from('livestock_moves').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      selectAll(() => client().from('livestock_treatments').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      selectAll(() => client().from('animals').select('*').eq('farm_id',farmId).order('created_at')),
      selectAll(() => client().from('livestock_health').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}))
    ]);
    for(const r of [cp,hd,hc,bm,mv,tr,an,he]) if(r.error) throw r.error;
    _srvNote('livestock_camps', cp.data);      _srvNote('herds', hd.data);
    _srvNote('herd_classes', hc.data);         _srvNote('livestock_benchmarks', bm.data);
    _srvNote('livestock_moves', mv.data);      _srvNote('livestock_treatments', tr.data);
    _srvNote('animals', an.data);              _srvNote('livestock_health', he.data);
    var byHerd={};
    (hc.data||[]).forEach(function(r){ (byHerd[r.herd_local_id]=byHerd[r.herd_local_id]||[]).push({k:r.class_key,n:Number(r.count)||0,v:Number(r.class_value)||0}); });
    var herds=(hd.data||[]).map(function(r){ var h=herdFromDb(r); var cs=byHerd[r.local_id]; if(cs&&cs.length) h.classes=cs; return h; });
    var benchmarks={}; (bm.data||[]).forEach(function(r){ benchmarks[r.bench_key]=Number(r.bench_value); });
    /* Moves recorded since this herd's counts were last written - from the phone at
       a gate, or from another desktop. Fold them in so the number on screen is the
       number the ledger supports, and hand back what changed so the farmer is told
       rather than quietly shown a different figure. */
    var _lsPend=_lsPendingMoves(hd.data, mv.data), _lsRecon=[];
    herds.forEach(function(h){
      var p=_lsPend[String(h.id)];
      if(!p || !p.delta) return;
      var stored=Number(h.qty)||0, derived=Math.max(0, stored+p.delta);
      if(derived===stored) return;
      _lsRecon.push({ herd:h.id, name:h.name||'', type:h.type||'',
                      stored:stored, derived:derived, moves:p.n });
      h.qty=derived;
      if(h.classes){
        Object.keys(p.cls).forEach(function(k){
          var d=p.cls[k]; if(!d) return;
          var c=null;
          for(var i=0;i<h.classes.length;i++){ if(String(h.classes[i].k)===k){ c=h.classes[i]; break; } }
          if(!c){ if(d<=0) return; c={k:k,n:0,v:Number(h.sell)||0}; h.classes.push(c); }
          c.n=Math.max(0,(Number(c.n)||0)+d);
        });
      }
    });
    // Breeding — queried separately & resiliently: a farm whose Supabase hasn't run the
    // livestock_breeding migration must still load all its other livestock data.
    var breedings=[];
    try{ var bd=await selectAll(() => client().from('livestock_breedings').select('*').eq('farm_id',farmId).order('created_at')); if(!bd.error) breedings=(bd.data||[]).map(breedingFromDb); }
    catch(e){ /* table not migrated yet — ignore */ }
    return { camps:(cp.data||[]).map(campFromDb), herds:herds, benchmarks:benchmarks,
             moves:(mv.data||[]).map(moveFromDb), treatments:(tr.data||[]).map(treatFromDb),
             animals:(an.data||[]).map(animalFromDb), health:(he.data||[]).map(healthFromDb), breedings:breedings,
             stockRecon:_lsRecon };
  };

  /* ---- FUEL ISSUES (diesel rebate logbook) ---------------------------------
     One row per machine per week. Append-only in practice, but re-saving a week
     replaces that week's rows client-side, so upsert on (farm_id, local_id). */
  function fuelToDb(f,fid){ var row={ farm_id:fid, local_id:String(f.id),
      issue_date:f.date||null, asset_local_id:(f.asset!=null)?String(f.asset):null,
      machine:f.machine||null, litres:(f.litres!=null)?Number(f.litres):null,
      activity:f.activity||null, act_key:f.actKey||null,
      qualifies:(f.qualifies!=null)?!!f.qualifies:null };
    /* Meter reading and place: what turns a list of litres into a logbook SARS will
       accept. Captured on the phone at the pump; nullable, and only sent once the
       column probe has seen them, on the same rule as receipt_path. */
    /* Where the row came from. The phone stamps 'phone' on a row captured at the
       pump; _fuIsField() uses it as the fourth signal, after a meter reading, a place
       and a fix, to keep the weekly grid from replacing a real dispensing. Without
       this the phone wrote it and the desktop never read it back. */
    if(CAN_FUEL_SRC) row.src=f.src||null;
    if(CAN_FUEL_METER){
      row.hour_meter=(f.hourMeter!=null&&f.hourMeter!=='')?Number(f.hourMeter):null;
      row.lat=(f.lat!=null&&f.lat!=='')?Number(f.lat):null;
      row.lon=(f.lon!=null&&f.lon!=='')?Number(f.lon):null;
      row.place=f.place||null;
    }
    return row; }
  function fuelFromDb(r){ var f={ id:r.local_id, date:r.issue_date||'',
      asset:_numIf(r.asset_local_id), machine:r.machine||'',
      litres:Number(r.litres)||0, activity:r.activity||'', actKey:r.act_key||'',
      qualifies:!!r.qualifies };
    if(r.src) f.src=r.src;
    if(r.hour_meter!=null) f.hourMeter=Number(r.hour_meter);
    if(r.lat!=null) f.lat=Number(r.lat);
    if(r.lon!=null) f.lon=Number(r.lon);
    if(r.place) f.place=r.place;
    return f; }
  load.fuel = async function(farmId){
    farmId=farmId||farm.active();
    const r=await selectAll(() => client().from('fuel_issues').select('*').eq('farm_id',farmId).order('issue_date',{ascending:false}));
    if(r.error) throw r.error;
    _srvNote('fuel_issues', r.data);
    return (r.data||[]).map(fuelFromDb);
  };
  var _fuelSnap=null;
  const fuel = {
    async saveAll(issues){
      issues=issues||[]; const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify(issues); if(snap===_fuelSnap) return;
      if(issues.length){
        const e=(await client().from('fuel_issues')
          .upsert(issues.map(function(f){ return fuelToDb(f,fid); }),{onConflict:'farm_id,local_id'})).error;
        if(e){ console.warn('Fuel log not saved online yet — run removal_certificate_schema.sql in Supabase. ('+(e.message||e)+')'); return false; }
      }
      _fuelSnap=snap; return true;
    }
  };

  /* ══ RAINFALL sync ══ */
  function rainGaugeToDb(g,fid){ return { farm_id:fid, local_id:String(g.id), name:g.name||null,
      where_at:g.where||null, is_default:!!g.isDefault, link_type:(g.link&&g.link.type)||null,
      link_local_id:(g.link&&g.link.id!=null)?String(g.link.id):null }; }
  function rainGaugeFromDb(r){ var g={ id:r.local_id, name:r.name||'', where:r.where_at||'', isDefault:!!r.is_default, link:{} };
    if(r.link_type){ g.link={ type:r.link_type }; if(r.link_local_id) g.link.id=r.link_local_id; }
    return g; }
  function rainReadToDb(x,fid){ return { farm_id:fid, local_id:String(x.id), read_date:x.date||null,
      gauge_local_id:x.gaugeId?String(x.gaugeId):null, mm:(x.mm!=null)?Number(x.mm):null,
      source:x.src||'gauge', read_by:x.by||null, note:x.note||null }; }
  function rainReadFromDb(r){ return { id:r.local_id, date:r.read_date||'', gaugeId:r.gauge_local_id||null,
      mm:Number(r.mm)||0, src:r.source||'gauge', by:r.read_by||'', note:r.note||'' }; }

  load.rainfall = async function(farmId){
    farmId=farmId||farm.active();
    const [g,r]=await Promise.all([
      selectAll(() => client().from('rainfall_gauges').select('*').eq('farm_id',farmId)),
      selectAll(() => client().from('rainfall_readings').select('*').eq('farm_id',farmId).order('read_date',{ascending:false}))
    ]);
    if(g.error) throw g.error;
    if(r.error) throw r.error;
    return { gauges:(g.data||[]).map(rainGaugeFromDb), log:(r.data||[]).map(rainReadFromDb) };
  };

  var _rainSnap=null;
  const rain = {
    /* Readings are append-mostly and a correction replaces one row, so this
       upserts and never clears the server copy first — the plan's
       delete-all-then-insert would lose a season to one failed insert. */
    async saveAll(state){
      state=state||(typeof window!=='undefined'&&window.ST_RAIN)||null;
      if(!state) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({g:state.gauges||[],l:state.log||[]});
      if(snap===_rainSnap) return true;
      const warn='Rainfall not saved online yet — run rainfall_schema.sql in Supabase.';
      if((state.gauges||[]).length){
        const e=(await client().from('rainfall_gauges')
          .upsert(state.gauges.map(function(g){ return rainGaugeToDb(g,fid); }),{onConflict:'farm_id,local_id'})).error;
        if(e){ console.warn(warn+' ('+(e.message||e)+')'); return false; }
      }
      if((state.log||[]).length){
        const own=state.log.filter(function(x){ return x && x.src!=='sat'; });
        if(own.length){
          const e2=(await client().from('rainfall_readings')
            .upsert(own.map(function(x){ return rainReadToDb(x,fid); }),{onConflict:'farm_id,local_id'})).error;
          if(e2){ console.warn(warn+' ('+(e2.message||e2)+')'); return false; }
        }
      }
      _rainSnap=snap; return true;
    },
    async remove(localId){
      const fid=farm.active(); if(!fid||!localId) return;
      const e=(await client().from('rainfall_readings').delete().eq('farm_id',fid).eq('local_id',String(localId))).error;
      if(e) throw e;
      _rainSnap=null; return true;
    }
  };
  /* ══ end RAINFALL sync ══ */

  /* ---- STATUTORY DOCUMENTS -------------------------------------------------
     Removal certificates now; spray records and payslips later, hence a domain
     of its own rather than hanging off livestock. Append-only and immutable:
     a correction issues a NEW number and supersedes the old, so nothing here
     is ever updated in place except the status flip on being superseded. */
  function docToDb(d,fid){ return { farm_id:fid, local_id:String(d.no), doc_type:d.doc_type||d.type||'RC',
      doc_no:d.no||null, status:d.status||'issued', issued_at:d.issuedAt||null, doc_date:d.date||null,
      move_local_id:d.moveId?String(d.moveId):null, supersedes:d.supersedes||null,
      superseded_by:d.supersededBy||null, snapshot:d.snap||null }; }
  /* lid is the row's own key, kept apart from `no`. A certificate's number IS its
     key, but a phone permit's is `PERMIT:<move>:<uid>` while its number is the one
     on the paper - and a desktop before -396 saved those permits back under the
     NUMBER, so some farms carry two rows for one permit. The register needs the key
     to tell the phone's row from that legacy copy. docToDb never reads this: the
     write path still keys on d.no and still sends RC rows only. */
  function docFromDb(r){ var d={ no:r.doc_no||r.local_id, lid:r.local_id||'', type:r.doc_type||'RC', status:r.status||'issued',
      issuedAt:r.issued_at||'', date:r.doc_date||'', moveId:r.move_local_id||null };
    if(r.supersedes) d.supersedes=r.supersedes;
    if(r.superseded_by) d.supersededBy=r.superseded_by;
    if(r.snapshot){ try{ d.snap=(typeof r.snapshot==='string')?JSON.parse(r.snapshot):r.snapshot; }catch(e){ d.snap={}; } }
    return d; }
  /* Rules are rewritten whole on every change: there are a handful of them, order is
     part of the data, and a diff would have to reconcile order anyway. sort_idx is
     stamped from the array position rather than trusted from the row. */
  function ruleToDb(r,fid,i){ return { farm_id:fid, local_id:String(r.id), match_text:String(r.match||''),
      cat_name:String(r.cat||''), rule_type:r.type||null, sort_idx:i, created_on:r.made||null }; }
  function ruleFromDb(r){ return { id:r.local_id, match:r.match_text||'', cat:r.cat_name||'',
      type:r.rule_type||'', made:r.created_on||'' }; }
  load.rules = async function(farmId){
    farmId=farmId||farm.active();
    if(!CAN_CAT_RULES) return null;                 // no table: caller keeps what is on the device
    const r=await selectAll(() => client().from('category_rules').select('*').eq('farm_id',farmId).order('sort_idx'));
    if(r.error) throw r.error;
    _srvNote('category_rules', r.data);
    return (r.data||[]).map(ruleFromDb);
  };
  var _ruleSnap=null;
  /* ---- what the computer reckons each bank line is (signed off 20 Sep 2026) ----
     Worked out ONCE on the computer, from inferCategory - the bank-import matcher,
     which applies the farmer's own filing rules first - and written down, so the
     phone reads the same answer instead of guessing with a word list of its own.
     Kept beside the transaction, never on it: a derived write would bump
     transactions.updated_at and the phone would raise a "Changed on both" card over
     a change the farmer never made (02-database/txn_looks_migration.sql). */
  const looks = {
    can(){ return CAN_LOOKS; },
    /* Every answer this farm holds, keyed by transaction id. */
    async load(farmId){
      if (!farmId || !CAN_LOOKS) return {};
      const { data, error } = await selectAll(() => client()
        .from('transaction_looks').select('txn_id,look_cat_id,look_v,rules_at').eq('farm_id', farmId));
      if (error) throw error;
      const out = {};
      (data || []).forEach(function(r){ out[r.txn_id] = { cat: r.look_cat_id || null, v: r.look_v, rulesAt: r.rules_at || null }; });
      return out;
    },
    /* The newest filing rule, so an answer older than the rules can be re-done.
       Null when the farm has no rules, or the table has no updated_at yet. */
    async rulesAt(farmId){
      if (!farmId || !CAN_CAT_RULES) return null;
      try {
        const r = await client().from('category_rules').select('updated_at')
          .eq('farm_id', farmId).order('updated_at', { ascending: false }).limit(1);
        if (r.error || !r.data || !r.data.length) return null;
        return r.data[0].updated_at || null;
      } catch (e) { return null; }
    },
    /* Rows: [{ txnId, catId, v, rulesAt }]. Upserted in one call per batch. */
    async saveMany(rows, farmId){
      const fid = farmId || farm.active();
      if (!fid || !CAN_LOOKS || !rows || !rows.length) return 0;
      const body = rows.map(function(r){
        return { txn_id: r.txnId, farm_id: fid, look_cat_id: r.catId || null,
                 look_v: r.v, rules_at: r.rulesAt || null, updated_at: new Date().toISOString() };
      });
      const { error } = await client().from('transaction_looks').upsert(body, { onConflict: 'txn_id' });
      if (error) throw error;
      return body.length;
    }
  };

  const rules = {
    async saveAll(list){
      list=list||[]; const fid=farm.active(); if(!fid || !CAN_CAT_RULES) return;
      const snap=JSON.stringify(list); if(snap===_ruleSnap) return;
      if(list.length){
        const e=(await client().from('category_rules')
          .upsert(list.map(function(r,i){ return ruleToDb(r,fid,i); }),{onConflict:'farm_id,local_id'})).error;
        if(e) throw e;
        _srvWrote('category_rules', list.map(function(r,i){ return ruleToDb(r,fid,i); }));
      }
      /* Deletes: a rule removed on this device has to disappear on the others, so drop
         anything on the server whose local_id is no longer in the list. */
      var keepRu={}; list.forEach(function(r){ keepRu[String(r.id)]=1; });
      var goneRu=_srvGone('category_rules',keepRu,'local_id');
      if(goneRu && goneRu.length){
        const e2=(await client().from('category_rules').delete().eq('farm_id',fid).in('local_id',goneRu)).error;
        if(e2) throw e2;
        _srvForgetRows('category_rules','local_id',goneRu);
      }
      _ruleSnap=snap;
      return true;
    }
  };
  load.documents = async function(farmId){
    farmId=farmId||farm.active();
    const r=await selectAll(() => client().from('farm_documents').select('*').eq('farm_id',farmId).order('issued_at',{ascending:false}));
    if(r.error) throw r.error;
    _srvNote('farm_documents', r.data);
    return (r.data||[]).map(docFromDb);
  };
  var _docSnap=null;
  const documents = {
    async saveAll(docs){
      docs=docs||[]; const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify(docs); if(snap===_docSnap) return;
      /* Only the certificates this app issues go back up. ST.docs also holds what the
         repull brought in from the phone — movement permits (doc_type PERMIT) and
         returns marked filed (FILING) — and docToDb keys a row by its number. A permit's
         number is not its row id, so every save wrote a SECOND copy of each phone permit;
         and a filing the farmer took back on the phone was written back by the next
         save from any tab that had loaded it. Those rows are the phone's to write. */
      var own=docs.filter(function(d){ return d && String(d.doc_type||d.type||'RC')==='RC'; });
      if(own.length){
        const e=(await client().from('farm_documents')
          .upsert(own.map(function(d){ return docToDb(d,fid); }),{onConflict:'farm_id,local_id'})).error;
        /* A missing migration must not take the whole save down with it — the
           certificate is already on the device and can be re-pushed later. */
        if(e){ console.warn('Documents not saved online yet — run removal_certificate_schema.sql in Supabase. ('+(e.message||e)+')'); return false; }
      }
      _docSnap=snap; return true;
    }
  };

  var _lsSnap=null;
  const livestock = {
    async saveAll(stls){
      if(!stls) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({c:stls.camps,h:stls.herd,b:stls.benchmarks,m:stls.moves,t:stls.treatments,a:stls.animals,br:stls.breedings});
      if(snap===_lsSnap) return;
      const camps=(stls.camps||[]), herds=(stls.herd||[]), bench=(stls.benchmarks||{});
      const moves=(stls.moves||[]), treats=(stls.treatments||[]), animals=(stls.animals||[]);
      if(camps.length){ const e=(await client().from('livestock_camps').upsert(camps.map(function(c){return campToDb(c,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(herds.length){
        var hrows=herds.map(function(h){return herdToDb(h,fid);});
        var he=(await client().from('herds').upsert(hrows,{onConflict:'farm_id,local_id'})).error;
        if(he){
          // Likely the ages/removed/planning columns aren't migrated yet — retry without them so the base herd still syncs.
          var hstripped=hrows.map(function(r){ var c={}; for(var k in r){ if(k!=='ages'&&k!=='removed'&&k!=='in_planning'&&k!=='plan_head'&&k!=='plan_month'&&k!=='plan_classes') c[k]=r[k]; } return c; });
          const he2=(await client().from('herds').upsert(hstripped,{onConflict:'farm_id,local_id'})).error;
          if(he2) throw he2;
          console.warn('Herd age-bands/removed/planning fields not saved online yet — run the herds alter-table in livestock_breeding_schema.sql.');
        }
      }
      var allClasses=[]; herds.forEach(function(h){ allClasses=allClasses.concat(classRows(h,fid)); });
      if(allClasses.length){ const e=(await client().from('herd_classes').upsert(allClasses,{onConflict:'farm_id,herd_local_id,class_key'})).error; if(e) throw e; _srvWrote('herd_classes', allClasses); }
      /* Classes the farmer removed - named one by one, never "everything except
         what I happen to hold", which would take a class this tab never loaded. */
      for(const h of herds){
        var keepHc={}; (h.classes||[]).forEach(function(c){ keepHc[String(c.k)]=1; });
        var hidHc=String(h.id);
        var goneHc=_srvGone('herd_classes',keepHc,'class_key',function(r){ return String(r.herd_local_id)===hidHc; });
        if(goneHc && goneHc.length){
          const e=(await client().from('herd_classes').delete().eq('farm_id',fid)
                    .eq('herd_local_id',hidHc).in('class_key',goneHc)).error; if(e) throw e; _srvForgetRows('herd_classes','class_key',goneHc,function(r){ return String(r.herd_local_id)===hidHc; }); }
      }
      var bkeys=Object.keys(bench);
      if(bkeys.length){ const e=(await client().from('livestock_benchmarks').upsert(bkeys.map(function(k){return {farm_id:fid,bench_key:k,bench_value:Number(bench[k])};}),{onConflict:'farm_id,bench_key'})).error; if(e) throw e; _srvWrote('livestock_benchmarks', bkeys.map(function(k){ return {farm_id:fid,bench_key:k}; })); }
      { var keepBm={}; bkeys.forEach(function(k){ keepBm[String(k)]=1; });
        var goneBm=_srvGone('livestock_benchmarks',keepBm,'bench_key');
        if(goneBm && goneBm.length){ const e=(await client().from('livestock_benchmarks').delete()
              .eq('farm_id',fid).in('bench_key',goneBm)).error; if(e) throw e; _srvForgetRows('livestock_benchmarks','bench_key',goneBm); } }
      // append-only logs: upsert by local_id, no prune (no delete UI except animals→removeAnimal)
      if(moves.length){ const e=(await client().from('livestock_moves').upsert(moves.map(function(m){return moveToDb(m,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(treats.length){ const e=(await client().from('livestock_treatments').upsert(treats.map(function(t){return treatToDb(t,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(animals.length){
        var arows=animals.map(function(a){return animalToDb(a,fid);});
        var ae=(await client().from('animals').upsert(arows,{onConflict:'farm_id,local_id'})).error;
        if(ae){
          // Cascading retry so an un-migrated NEWER column never throws away an OLDER one that already syncs fine.
          // Tier 2 = "Dairy fast-start" (status/due_approx/parity/weight) — the newest additions, most likely absent.
          // Tier 3 = also drop Phase-2a/2b pedigree/repro (dob/dam/sire/repro) — for a farm with no migrations at all.
          function stripKeys(rows,keys){ return rows.map(function(r){ var c={}; for(var k in r){ if(keys.indexOf(k)<0) c[k]=r[k]; } return c; }); }
          var TIER2=['status','due_approx','parity','weight'];
          var TIER3=['dob','dam','sire','repro'].concat(TIER2);
          var e2=(await client().from('animals').upsert(stripKeys(arows,TIER2),{onConflict:'farm_id,local_id'})).error;
          if(!e2){
            console.warn('Animal weight/dairy-status fields (status/due_approx/parity/weight) not saved online yet — run the newest animals alter-table in livestock_breeding_schema.sql.');
          } else {
            const e3=(await client().from('animals').upsert(stripKeys(arows,TIER3),{onConflict:'farm_id,local_id'})).error;
            if(e3) throw e3;
            console.warn('Animal pedigree/repro/weight (dob/dam/sire/repro/status/due_approx/parity/weight) not saved online yet — run the animals alter-table in livestock_breeding_schema.sql.');
          }
        }
      }
      // Breeding — resilient: if the migration hasn't been run, keep the rest of the save working.
      var breedings=(stls.breedings||[]), _breedErr=null;
      if(breedings.length){ try{ const e=(await client().from('livestock_breedings').upsert(breedings.map(function(b){return breedingToDb(b,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
        catch(be){ _breedErr=be; console.warn('Breeding records not saved online yet — run livestock_breeding_schema.sql in Supabase. ('+(be&&be.message||be)+')'); } }
      /* Not marked saved: the rest went, the breeding records are sent again next time. */
      if(_breedErr) throw _breedErr;
      _lsSnap=snap;
      return true;
    },
    async addHealth(h){ const fid=farm.active(); if(!fid||!h) return; const row=healthToDb(h,fid); /* local_id has always been sent; using it on the way in too means a retry writes the dosing once (-411). */ const q=(row.local_id!=null&&row.local_id!=='')?client().from('livestock_health').upsert(row,{onConflict:'farm_id,local_id'}):client().from('livestock_health').insert(row); const e=(await q).error; if(e) throw e; return true; },
    async removeAnimal(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('animals').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; },
    async removeHerd(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('herds').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; },
    async removeCamp(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('livestock_camps').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; }
  };

  // ---- CROPS (lands, events, inputs) — 3b-i --------------------------------
  // ST_CROP is source of truth; DB mirrors it. Land ids stay as local_id text
  // so 'crop:<type>' tags + crop profit (keyed off land.crop/yields) keep working.
  // Lands edit-in-place (upsert); events/inputs append-only (upsert, no prune —
  // no delete UI). Config (prices/compliance/season) is 3b-ii.
  function landToDb(l,fid){ return { farm_id:fid, local_id:String(l.id), name:l.name||null, area:(l.area!=null&&l.area!=='')?Number(l.area):null, crop:l.crop||null, cultivar:l.cultivar||null, gmo:!!l.gmo, irrigated:!!l.irrigated, planted:l.planted||null, harvest:l.harvest||null, stage:l.stage||null, target_yield:(l.targetYield!=null&&l.targetYield!=='')?Number(l.targetYield):null, actual_yield:(l.actualYield!=null&&l.actualYield!=='')?Number(l.actualYield):null, input_per_ha:(l.inputPerHa!=null&&l.inputPerHa!=='')?Number(l.inputPerHa):null, prev_crop:l.prevCrop||null, price:(l.price!=null&&l.price!=='')?Number(l.price):null, plan_link:l.planId||null }; }
  function landFromDb(r){ var l={ id:_numIf(r.local_id), name:r.name||'', area:Number(r.area)||0, crop:r.crop||'', cultivar:r.cultivar||'', gmo:!!r.gmo, irrigated:!!r.irrigated, planted:r.planted||'', harvest:r.harvest||'', stage:r.stage||'', targetYield:Number(r.target_yield)||0, actualYield:(r.actual_yield!=null)?Number(r.actual_yield):null, inputPerHa:Number(r.input_per_ha)||0, prevCrop:r.prev_crop||'' }; if(r.price) l.price=Number(r.price); if(r.plan_link) l.planId=r.plan_link; return l; }
  function cevToDb(e,fid){ return { farm_id:fid, local_id:String(e.id), land_local_id:(e.land!=null)?String(e.land):null, kind:e.kind||null, event_date:e.date||null, note:e.note||null, tons:(e.tons!=null)?Number(e.tons):null, yield_val:(e.yield!=null)?Number(e.yield):null, cert:e.cert||null }; }
  function cevFromDb(r){ var e={ id:r.local_id, land:_numIf(r.land_local_id), kind:r.kind||'', date:r.event_date||'', note:r.note||'' }; if(r.tons!=null) e.tons=Number(r.tons); if(r.yield_val!=null) e.yield=Number(r.yield_val); if(r.cert) e.cert=r.cert; return e; }
  function cinToDb(i,fid){ var row = { farm_id:fid, local_id:String(i.id), land_local_id:(i.land!=null)?String(i.land):null, input_date:i.date||null, product:i.product||null, reg:i.reg||null, kind:i.kind||null, rate:i.rate||null, batch:i.batch||null, by_who:i.by||null, operator_cert:i.operatorCert||null, target_for:i.targetFor||null, phi:(i.phi!=null)?parseInt(i.phi,10):null, cost_per_ha:(i.costPerHa!=null)?Number(i.costPerHa):null };
    if(CAN_INPUT_WEATHER) row.weather = i.weather || null;
    if(CAN_INPUT_FIX){ row.removed_at=(i.removed&&i.removed.at)||null; row.removed_reason=(i.removed&&i.removed.reason)||null;
      row.removed_by=(i.removed&&i.removed.by)||null;
      row.changes=Array.isArray(i.changes)?i.changes:[]; }   /* NOT NULL on the server: never send null */
    return row; }
  function cinFromDb(r){ return { id:r.local_id, land:_numIf(r.land_local_id), date:r.input_date||'', product:r.product||'', reg:r.reg||'', kind:r.kind||'', rate:r.rate||'', batch:r.batch||'', by:r.by_who||'', operatorCert:r.operator_cert||'', targetFor:r.target_for||'', phi:Number(r.phi)||0, costPerHa:Number(r.cost_per_ha)||0,
    weather:r.weather||'',
    removed:r.removed_at?{at:r.removed_at, reason:r.removed_reason||'', by:r.removed_by||''}:undefined,
    changes:(Array.isArray(r.changes)&&r.changes.length)?r.changes:undefined }; }

  // ---- crop compliance: relational (Option A) — settings row + areas + children
  // ST_CROP.compliance is one farm-level record: flat scalar settings, tracked{}/
  // cadence{} maps (per area) and logs{}/docs{} (per area) + waterReadings[].
  // Doc files (url) and log photos are base64 blobs — deferred to Storage; metadata persists.
  var CC_AREAS=['chem','water','gmo','invasive','seed','soil','ohs','diesel','export'];
  // [appKey, dbCol, type]  type: t=text n=number i=int b=bool
  var CC_SET=[['waterWUL','water_wul','t'],['waterAuthorised','water_authorised','n'],['waterUsed','water_used','n'],['waterMetered','water_metered','b'],['gmoStewardshipDoc','gmo_stewardship_doc','b'],['gmoRefugeLogged','gmo_refuge_logged','b'],['gmoRefugePct','gmo_refuge_pct','t'],['invasiveRegister','invasive_register','b'],['invasiveOutstanding','invasive_outstanding','t'],['invasiveLastAction','invasive_last_action','t'],['seedCertified','seed_certified','b'],['retainedSeed','retained_seed','b'],['seedNote','seed_note','t'],['soilPractice','soil_practice','t'],['soilTest','soil_test','t'],['operatorsTrained','operators_trained','i'],['operatorsTotal','operators_total','i'],['ppeIssued','ppe_issued','b'],['firstAidKit','first_aid_kit','b'],['workerTraining','worker_training','t'],['sdsRegister','sds_register','b'],['containerDisposal','container_disposal','b'],['dieselLitres','diesel_litres','n'],['dieselLogbook','diesel_logbook','b'],['exportReady','export_ready','b'],['exportScheme','export_scheme','t']];
  function ccSettToDb(c,fid){ c=c||{}; var row={farm_id:fid}; CC_SET.forEach(function(f){ var v=c[f[0]]; if(v===undefined||v===null||v===''){ row[f[1]]=null; } else if(f[2]==='b'){ row[f[1]]=!!v; } else if(f[2]==='i'){ row[f[1]]=parseInt(v,10); } else if(f[2]==='n'){ row[f[1]]=Number(v); } else { row[f[1]]=String(v); } }); return row; }
  function ccSettFromDb(r){ var c={}; CC_SET.forEach(function(f){ var v=r?r[f[1]]:null; if(v==null){ c[f[0]]=(f[2]==='b')?false:((f[2]==='n'||f[2]==='i')?0:''); } else { c[f[0]]=(f[2]==='b')?!!v:((f[2]==='n'||f[2]==='i')?Number(v):String(v)); } }); return c; }

  load.crops = async function(farmId){
    farmId = farmId || farm.active();
    const [ld,ev,ip,cfg,cs,ca,cl,cd,cr,cp] = await Promise.all([
      client().from('crop_lands').select('*').eq('farm_id',farmId).order('created_at'),
      selectAll(() => client().from('crop_events').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      selectAll(() => client().from('crop_inputs').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      client().from('farms').select('crop_season').eq('id',farmId).single(),
      client().from('crop_compliance_settings').select('*').eq('farm_id',farmId),
      client().from('crop_compliance_areas').select('*').eq('farm_id',farmId),
      selectAll(() => client().from('crop_compliance_logs').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('crop_compliance_docs').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('crop_compliance_readings').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('crop_compliance_log_photos').select('*').eq('farm_id',farmId).order('sort_idx'))
    ]);
    for(const r of [ld,ev,ip]) if(r.error) throw r.error;
    for(const r of [cs,ca,cl,cd,cr,cp]) if(r&&r.error) throw r.error;
    _srvNote('crop_lands', ld.data);   _srvNote('crop_events', ev.data);   _srvNote('crop_inputs', ip.data);
    _srvNote('crop_compliance_areas',      ca && ca.data);
    _srvNote('crop_compliance_logs',       cl && cl.data);
    _srvNote('crop_compliance_docs',       cd && cd.data);
    _srvNote('crop_compliance_readings',   cr && cr.data);
    _srvNote('crop_compliance_log_photos', cp && cp.data);
    // compliance: reconstruct the farm-level record from its tables. Authoritative
    // only when the farm has saved before (settings row / any area rows); else null so
    // ai-auth keeps the app's default structure (tracked/cadence keys the UI needs).
    var settingsRow=(cs&&cs.data&&cs.data[0])||null;
    var areaRows=(ca&&ca.data)||[];
    var hasSaved=!!settingsRow || areaRows.length>0 ||
      ((cl&&cl.data&&cl.data.length)||(cd&&cd.data&&cd.data.length)||(cr&&cr.data&&cr.data.length));
    var compliance=null;
    if(hasSaved){
      var tracked={}, cadence={};
      areaRows.forEach(function(r){ tracked[r.area_key]=(r.tracked!==false); if(r.cadence_months!=null) cadence[r.area_key]=Number(r.cadence_months); });
      var logs={}; (cl.data||[]).forEach(function(r){ (logs[r.area_key]=logs[r.area_key]||[]).push({date:r.log_date||'',what:r.what||'',note:r.note||'',photos:[]}); });
      // attach log photos to their log by (area_key, log_idx)
      (cp&&cp.data||[]).forEach(function(r){ var arr=logs[r.area_key]; if(arr && arr[r.log_idx]){ arr[r.log_idx].photos.push({name:r.name||'',kind:r.kind||'',url:r.url||''}); } });
      var docs={}; (cd.data||[]).forEach(function(r){ (docs[r.area_key]=docs[r.area_key]||[]).push({name:r.name||'',kind:r.kind||'',expiry:r.expiry||'',added:r.added||'',url:r.url||''}); });
      var waterReadings=(cr.data||[]).map(function(r){ return {date:r.reading_date||'',m3:(r.m3!=null?Number(r.m3):0)}; });
      compliance={ settings:ccSettFromDb(settingsRow), tracked:tracked, cadence:cadence, logs:logs, docs:docs, waterReadings:waterReadings };
    }
    return { lands:(ld.data||[]).map(landFromDb), events:(ev.data||[]).map(cevFromDb), inputs:(ip.data||[]).filter(function(r){return !r.removed_at;}).map(cinFromDb), removed:(ip.data||[]).filter(function(r){return !!r.removed_at;}).map(cinFromDb),
             season:(cfg.data && cfg.data.crop_season) || null,
             compliance:compliance };
  };

  var _cropSnap=null;
  var _cropCfgSnap=null;
  var _cropCfgGate=Promise.resolve();   // serializes saveConfig so concurrent/rapid calls never overlap (delete-all+insert would otherwise race into duplicate rows)
  const crop = {
    /* May this device remove an input? Only once the server can store the removal. */
    canFix(){ return CAN_INPUT_FIX; },
    async saveAll(stc){
      if(!stc) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({l:stc.lands,e:stc.events,i:stc.inputs,r:stc.removed});
      if(snap===_cropSnap) return;
      const lands=(stc.lands||[]), events=(stc.events||[]), inputs=(stc.inputs||[]).concat(stc.removed||[]);
      if(lands.length){ const e=(await client().from('crop_lands').upsert(lands.map(function(l){return landToDb(l,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(events.length){ const e=(await client().from('crop_events').upsert(events.map(function(x){return cevToDb(x,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(inputs.length){ const e=(await client().from('crop_inputs').upsert(inputs.map(function(x){return cinToDb(x,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      _cropSnap=snap;
      return true;
    },
    // 3b-ii: season stays on the farm row; compliance is now relational (5 tables).
    async saveConfig(stc){
      if(!stc) return;
      const fid=farm.active(); if(!fid) return;
      // serialize: wait for any in-flight saveConfig, so the delete-all/insert writes below never overlap and race into duplicate rows
      var _prev=_cropCfgGate, _rel; _cropCfgGate=new Promise(function(r){ _rel=r; });
      try{ await _prev; }catch(e){}
      try {
      const c=stc.compliance||{};
      const snap=JSON.stringify({s:stc.season,c:c});
      if(snap===_cropCfgSnap) return true;
      // season on the farm row
      { const e=(await client().from('farms').update({ crop_season:stc.season||null }).eq('id',fid)).error; if(e) throw e; }
      // settings: single row per farm
      { const e=(await client().from('crop_compliance_settings').upsert(ccSettToDb(c,fid),{onConflict:'farm_id'})).error; if(e) throw e; }
      // areas: write all known area keys (tracked + cadence). 'tracked unless false' mirrors the UI.
      var trk=c.tracked||{}, cad=c.cadence||{};
      var areaRows=CC_AREAS.map(function(k){ return { farm_id:fid, area_key:k, tracked:(trk[k]!==false), cadence_months:(cad[k]!=null?parseInt(cad[k],10):null) }; });
      { const e=(await client().from('crop_compliance_areas').upsert(areaRows,{onConflict:'farm_id,area_key'})).error; if(e) throw e; }
      // logs: replace-all (per area)
      var logRows=[]; var L=c.logs||{}; Object.keys(L).forEach(function(area){ (L[area]||[]).forEach(function(g,i){ logRows.push({farm_id:fid,area_key:area,log_date:g.date||null,what:g.what||null,note:g.note||null,sort_idx:i}); }); });
      { const e=await replaceAllRows('crop_compliance_logs',fid,logRows); if(e) throw e; }
      // docs: replace-all (per area) — metadata only; file blobs deferred to Storage
      var docRows=[]; var D=c.docs||{}; Object.keys(D).forEach(function(area){ (D[area]||[]).forEach(function(d,i){ docRows.push({farm_id:fid,area_key:area,name:d.name||null,kind:d.kind||null,expiry:d.expiry||null,added:d.added||null,url:d.url||null,sort_idx:i}); }); });
      { const e=await replaceAllRows('crop_compliance_docs',fid,docRows); if(e) throw e; }
      // log photos: replace-all, one row per photo, keyed to its log by (area_key, log_idx)
      var photoRows=[]; Object.keys(L).forEach(function(area){ (L[area]||[]).forEach(function(g,li){ (g.photos||[]).forEach(function(p,pi){ photoRows.push({farm_id:fid,area_key:area,log_idx:li,name:p.name||null,kind:p.kind||null,url:p.url||null,sort_idx:pi}); }); }); });
      { const e=await replaceAllRows('crop_compliance_log_photos',fid,photoRows); if(e) throw e; }
      // water meter readings: replace-all
      var rdRows=[]; (c.waterReadings||[]).forEach(function(rd,i){ rdRows.push({farm_id:fid,area_key:'water',reading_date:rd.date||null,m3:(rd.m3!=null?Number(rd.m3):null),sort_idx:i}); });
      { const e=await replaceAllRows('crop_compliance_readings',fid,rdRows); if(e) throw e; }
      _cropCfgSnap=snap;
      return true;
      } finally { _rel(); }
    }
  };

  // ---- ORCHARDS (blocks, pricing, sprays, harvest) — 3c-i -----------------
  // Blocks are the canonical set (set-sync). Pricing is 1 row/block + a child
  // table for the variable others[] lines. Sprays/harvest are append logs.
  // PHI (safe-to-pick) is NOT stored — it is recomputed from sprays on load.
  function _n(v){ return (v!=null&&v!=='')?Number(v):null; }
  function obToDb(b,fid){ var row = { farm_id:fid, local_id:String(b.id), cat:b.cat||null, icon:b.icon||null, name:b.name||null, cultivar:b.cultivar||null, root:b.root||null, plant:(b.plant!=null)?String(b.plant):null, age:(b.age!=null&&b.age!=='')?parseInt(b.age,10):null, ha:_n(b.ha), trees:(b.trees!=null&&b.trees!=='')?parseInt(b.trees,10):null, status:b.status||null, status_tag:b.statusTag||null, tons:_n(b.tons), exp:_n(b.exp), carton_kg:_n(b.cartonKg), margin:_n(b.margin), estab:b.estab||null, estab_yr:(b.estabYr!=null&&b.estabYr!=='')?parseInt(b.estabYr,10):null, writeoff:_n(b.writeoff), per_unit:_n(b.perUnit), unit_word:b.unitWord||null, curve:b.curve||null, cover:b.cover||null, plan:(b.plan!=null)?!!b.plan:null, grade:_n(b.grade), unit:b.unit||null, days:(b.days!=null&&b.days!=='')?parseInt(b.days,10):null, pick_from:b.pickFrom||null, cycle:b.cycle||null, removed:(b.removed!=null)?!!b.removed:null };
    /* Not cosmetic: orBlockMarkets() GUESSES when this is missing, and the guess picks
       which pre-harvest interval governs safe-to-pick. */
    if(CAN_ORCH_MARKETS) row.markets = (b.markets && b.markets.length) ? b.markets : null;
    return row; }
  function obFromDb(r){ var b={ id:r.local_id, cat:r.cat||'', icon:r.icon||'', name:r.name||'', cultivar:r.cultivar||'', status:r.status||'', statusTag:r.status_tag||'' };
    if(r.root!=null) b.root=r.root; if(r.plant!=null) b.plant=_numIf(r.plant); if(r.age!=null) b.age=Number(r.age); if(r.ha!=null) b.ha=Number(r.ha); if(r.trees!=null) b.trees=Number(r.trees); if(r.tons!=null) b.tons=Number(r.tons); if(r.exp!=null) b.exp=Number(r.exp); if(r.carton_kg!=null) b.cartonKg=Number(r.carton_kg); if(r.margin!=null) b.margin=Number(r.margin); if(r.estab!=null) b.estab=r.estab; if(r.estab_yr!=null) b.estabYr=Number(r.estab_yr); if(r.writeoff!=null) b.writeoff=Number(r.writeoff); if(r.per_unit!=null) b.perUnit=Number(r.per_unit); if(r.unit_word!=null) b.unitWord=r.unit_word; if(r.curve!=null) b.curve=r.curve; if(r.cover!=null) b.cover=r.cover; if(r.plan!=null) b.plan=!!r.plan; if(r.grade!=null) b.grade=Number(r.grade); if(r.unit!=null) b.unit=r.unit; if(r.days!=null) b.days=Number(r.days); if(r.pick_from!=null) b.pickFrom=r.pick_from; if(r.cycle!=null) b.cycle=r.cycle; if(r.removed!=null) b.removed=!!r.removed;
    return b; }
  // compliance item: persist full item (queryable) ; load overlays user fields onto app defaults
  function ociToDb(key,c,fid){ c=c||{}; return { farm_id:fid, item_key:String(key), kind:c.type||null, icon:c.ic||null, title:c.title||null, what:c.what||null, status:c.status||null, status_tag:c.statusTag||null, expiry:c.expiry||null, cropcat:c.cropcat||null, log:(c.log!=null)?String(c.log):null }; }
  function opToDb(blockId,p,fid){ p=p||{}; var lo=p.local||{}; return { farm_id:fid, block_local_id:String(blockId), price:_n(p.price), comm:_n(p.comm), pack:_n(p.pack), ship:_n(p.ship), levy:_n(p.levy), levy_name:p.levyName||null, local_price:_n(lo.price), local_comm:_n(lo.comm), local_trans:_n(lo.trans), local_other:_n(lo.other) }; }
  function opFromDb(r,others){ return { price:Number(r.price)||0, comm:Number(r.comm)||0, pack:Number(r.pack)||0, ship:Number(r.ship)||0, levy:Number(r.levy)||0, levyName:r.levy_name||'', others:(others&&others.length)?others:[{label:'Other costs',amt:0}], local:{price:Number(r.local_price)||0,comm:Number(r.local_comm)||0,trans:Number(r.local_trans)||0,other:Number(r.local_other)||0} }; }
  /* rate, batch, the operator's certificate and the weather at application are what
     GlobalG.A.P. 32.02.01/02 asks for and what the register prints. Gated: a database
     without the migration must still save the spray, minus the particulars. */
  function osToDb(s,cat,fid){ var row = { farm_id:fid, local_id:String(s.id), cropcat:cat||null, block_local_id:(s.bid!=null&&s.bid!=='')?String(s.bid):null, product:s.product||null, reg:s.reg||null, target_for:s.forx||null, applied_by:s.by||null, spray_date:s.dateISO||null, phi_eu:_n(s.phi&&s.phi.eu), phi_uk:_n(s.phi&&s.phi.uk), phi_us:_n(s.phi&&s.phi.us), phi_local:_n(s.phi&&s.phi.local), title:s.t||null, sub:s.s||null, icon:s.ic||null };
    if(CAN_ORCH_ATT) row.att = s.att || null;
    if(CAN_ORCH_PARTS){
      row.rate = s.rate || null; row.batch = s.batch || null;
      row.operator_cert = s.cert || null; row.weather = s.weather || null;
    }
    if(CAN_ORCH_FIX){ row.removed_at=(s.removed&&s.removed.at)||null; row.removed_reason=(s.removed&&s.removed.reason)||null;
      row.removed_by=(s.removed&&s.removed.by)||null;
      row.changes=Array.isArray(s.changes)?s.changes:[]; }   /* NOT NULL on the server: never send null */
    return row; }
  function osFromDb(r){ return { id:r.local_id, ic:r.icon||'\uD83E\uDDEA', t:r.title||'', s:r.sub||'', phi:{eu:Number(r.phi_eu)||0,uk:Number(r.phi_uk)||0,us:Number(r.phi_us)||0,local:Number(r.phi_local)||0}, bid:r.block_local_id||'', product:r.product||'', reg:r.reg||'', forx:r.target_for||'', by:r.applied_by||'', dateISO:r.spray_date||'', cropcat:r.cropcat||'', att:r.att||undefined,
    rate:r.rate||'', batch:r.batch||'', cert:r.operator_cert||'', weather:r.weather||'',
    removed:r.removed_at?{at:r.removed_at, reason:r.removed_reason||'', by:r.removed_by||''}:undefined,
    changes:(Array.isArray(r.changes)&&r.changes.length)?r.changes:undefined }; }
  function ohToDb(h,fid){ var row = { farm_id:fid, local_id:String(h.id), cropcat:h.cat||null, block_local_id:(h.bid!=null&&h.bid!=='')?String(h.bid):null, bins:_n(h.bins), tons:_n(h.tons!=null?h.tons:h.tn), cartons:_n(h.cartons), top_grade_pct:_n(h.grade), sold_to:h.to||null, amount:_n(h.money), pick_date:h.dateISO||null, title:h.t||null, sub:h.s||null, revenue:h.r||null, icon:h.ic||null };
    /* The delivery note the farmer attached to this pick. Its bytes are already in
       Storage; without this the pointer died here and the file was orphaned. */
    if(CAN_ORCH_ATT) row.att = h.att || null;
    return row; }
  function ohFromDb(r){ return { id:r.local_id, ic:r.icon||'\uD83C\uDF4A', t:r.title||'', s:r.sub||'', r:r.revenue||'\u2014', cat:r.cropcat||'', bid:r.block_local_id||'', tn:Number(r.tons)||0, tons:Number(r.tons)||0, cartons:Number(r.cartons)||0, to:r.sold_to||'', money:Number(r.amount)||0, dateISO:r.pick_date||'', att:r.att||undefined }; }

  load.orchard = async function(farmId){
    farmId = farmId || farm.active();
    const [bl,dc,pr,po,sp,hv,ci,cd,cc,cr,cfg] = await Promise.all([
      selectAll(() => client().from('orchard_blocks').select('*').eq('farm_id',farmId).order('created_at')),
      selectAll(() => client().from('orchard_block_docs').select('*').eq('farm_id',farmId).order('sort_idx')),
      client().from('orchard_pricing').select('*').eq('farm_id',farmId),
      client().from('orchard_pricing_others').select('*').eq('farm_id',farmId).order('sort_idx'),
      selectAll(() => client().from('orchard_sprays').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      selectAll(() => client().from('orchard_harvest').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      client().from('orchard_compliance_items').select('*').eq('farm_id',farmId),
      client().from('orchard_compliance_docs').select('*').eq('farm_id',farmId).order('sort_idx'),
      selectAll(() => client().from('orchard_compliance_checks').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('orchard_compliance_readings').select('*').eq('farm_id',farmId).order('sort_idx')),
      client().from('farms').select('orchard_market').eq('id',farmId).single()
    ]);
    for(const r of [bl,dc,pr,po,sp,hv,ci,cd,cc,cr]) if(r.error) throw r.error;
    _srvNote('orchard_blocks', bl.data);              _srvNote('orchard_block_docs', dc.data);
    _srvNote('orchard_pricing', pr.data);             _srvNote('orchard_pricing_others', po.data);
    _srvNote('orchard_sprays', sp.data);              _srvNote('orchard_harvest', hv.data);
    _srvNote('orchard_compliance_items', ci.data);    _srvNote('orchard_compliance_docs', cd.data);
    _srvNote('orchard_compliance_checks', cc.data);   _srvNote('orchard_compliance_readings', cr.data);
    var docsByBlock={}; (dc.data||[]).forEach(function(d){ (docsByBlock[d.block_local_id]=docsByBlock[d.block_local_id]||[]).push({name:d.name,kind:d.kind,added:d.added,id:d.local_id||undefined,path:d.path||undefined}); });
    var blocks=(bl.data||[]).map(function(r){ var b=obFromDb(r); b.docs=docsByBlock[b.id]||[];
      if(r.markets && r.markets.length) b.markets=r.markets;
      return b; });
    var othByBlock={}; (po.data||[]).forEach(function(o){ (othByBlock[o.block_local_id]=othByBlock[o.block_local_id]||[]).push({label:o.label||'',amt:Number(o.amt)||0}); });
    var pricing={}; (pr.data||[]).forEach(function(r){ pricing[r.block_local_id]=opFromDb(r,othByBlock[r.block_local_id]||[]); });
    /* A removed spray is held apart from the diary, so the safe-to-pick grid, the register
       and every other reader of sprayDiary are right without knowing removal exists. */
    var sprayDiary={}, removedSprays=[]; (sp.data||[]).forEach(function(r){ var s=osFromDb(r); if(r.removed_at){ removedSprays.push(s); return; } (sprayDiary[s.cropcat]=sprayDiary[s.cropcat]||[]).push(s); });
    var harvest=(hv.data||[]).map(ohFromDb);
    // compliance: per-key user fields + children, to overlay onto app defaults in ai-auth
    var cDocs={}, cChecks={}, cReads={};
    (cd.data||[]).forEach(function(d){ (cDocs[d.item_key]=cDocs[d.item_key]||[]).push({name:d.name||'',kind:d.kind||'',added:d.added||'',id:d.local_id||undefined,path:d.path||undefined}); });
    (cc.data||[]).forEach(function(r){ var _c={date:r.check_date||'',note:r.note||''};
      if(r.check_iso) _c.iso=r.check_iso; if(r.ctype) _c.ctype=r.ctype; if(r.by_who) _c.by=r.by_who;
      if(r.att) _c.att=r.att;
      (cChecks[r.item_key]=cChecks[r.item_key]||[]).push(_c); });
    (cr.data||[]).forEach(function(r){ (cReads[r.item_key]=cReads[r.item_key]||[]).push({date:r.reading_date||'',m3:r.m3||''}); });   // reading_date is a display string; orSaveReading now writes a real one
    var comply={};
    (ci.data||[]).forEach(function(r){ var o={status:r.status||'',statusTag:r.status_tag||'',expiry:r.expiry||''}; if(r.log!=null) o.log=r.log;
      if(cDocs[r.item_key]) o.docs=cDocs[r.item_key]; if(cChecks[r.item_key]) o.checks=cChecks[r.item_key]; if(cReads[r.item_key]) o.readings=cReads[r.item_key];
      comply[r.item_key]=o; });
    return { blocks:blocks, pricing:pricing, sprayDiary:sprayDiary, removedSprays:removedSprays, harvest:harvest, comply:comply, market:(cfg.data&&cfg.data.orchard_market)||null };
  };

  var _orSnap=null, _orCfgSnap=null;
  var _orGate=Promise.resolve();   // serializes orchard saveAll (its delete-all+insert children would otherwise race into duplicate rows on rapid edits)
  const orchard = {
    canFix(){ return CAN_ORCH_FIX; },
    async saveAll(stf){
      if(!stf) return;
      const fid=farm.active(); if(!fid) return;
      // serialize: wait for any in-flight saveAll so the delete-all/insert children below never overlap
      var _prev=_orGate, _rel; _orGate=new Promise(function(r){ _rel=r; });
      try{ await _prev; }catch(e){}
      try {
      const snap=JSON.stringify({b:stf.blocks,p:stf.pricing,s:stf.sprayDiary,r:stf.removedSprays,h:stf.harvest,c:stf.comply});
      if(snap===_orSnap) return true;
      const blocks=(stf.blocks||[]); const blockIds=blocks.map(function(b){return String(b.id);});
      if(blocks.length){ const e=(await client().from('orchard_blocks').upsert(blocks.map(function(b){return obToDb(b,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; _srvWrote('orchard_blocks', blocks.map(function(b){ return {farm_id:fid,local_id:String(b.id)}; })); }
      /* Blocks the farmer deleted. Scoped to blocks this device loaded, so a block
         added on the phone since is not destroyed by a tab that never saw it. */
      { var keepBl={}; blockIds.forEach(function(k){ keepBl[String(k)]=1; });
        var goneBl=_srvGone('orchard_blocks',keepBl,'local_id');
        if(goneBl && goneBl.length){ const e=(await client().from('orchard_blocks').delete()
              .eq('farm_id',fid).in('local_id',goneBl)).error; if(e) throw e; _srvForgetRows('orchard_blocks','local_id',goneBl); } }
      // block docs: replace-all (small metadata child set)
      var docRows=[]; blocks.forEach(function(b){ (b.docs||[]).forEach(function(d,i){
        var _r={farm_id:fid,block_local_id:String(b.id),name:d.name||null,kind:d.kind||null,added:d.added||null,sort_idx:i};
        /* The FILE lives in Storage; this carries only its path, plus the ref id so the
           Open link still resolves on a device that has never seen the local copy. */
        if(CAN_ORCH_DOCFILE){ _r.local_id=d.id||null; _r.path=d.path||null; }
        docRows.push(_r); }); });
      { const e=await replaceAllRows('orchard_block_docs',fid,docRows); if(e) throw e; }
      // pricing upsert + prune
      var pricing=stf.pricing||{}; var pkeys=Object.keys(pricing).filter(function(k){return blockIds.indexOf(String(k))>=0;});
      if(pkeys.length){ const e=(await client().from('orchard_pricing').upsert(pkeys.map(function(k){return opToDb(k,pricing[k],fid);}),{onConflict:'farm_id,block_local_id'})).error; if(e) throw e; _srvWrote('orchard_pricing', pkeys.map(function(k){ return {farm_id:fid,block_local_id:String(k)}; })); }
      { var keepPr={}; pkeys.forEach(function(k){ keepPr[String(k)]=1; });
        var gonePr=_srvGone('orchard_pricing',keepPr,'block_local_id');
        if(gonePr && gonePr.length){ const e=(await client().from('orchard_pricing').delete()
              .eq('farm_id',fid).in('block_local_id',gonePr)).error; if(e) throw e; _srvForgetRows('orchard_pricing','block_local_id',gonePr); } }
      // pricing others: replace-all
      var othRows=[]; pkeys.forEach(function(k){ ((pricing[k]&&pricing[k].others)||[]).forEach(function(o,i){ othRows.push({farm_id:fid,block_local_id:String(k),label:o.label||null,amt:_n(o.amt),sort_idx:i}); }); });
      { const e=await replaceAllRows('orchard_pricing_others',fid,othRows); if(e) throw e; }
      // sprays append-only (assign ids if missing so upsert is stable)
      var sprayRows=[]; var sd=stf.sprayDiary||{}; Object.keys(sd).forEach(function(cat){ (sd[cat]||[]).forEach(function(s){ if(!s.id) s.id='os'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); sprayRows.push(osToDb(s,cat,fid)); }); });
      (stf.removedSprays||[]).forEach(function(s){ if(s&&s.id) sprayRows.push(osToDb(s, s.cropcat||null, fid)); });
      if(sprayRows.length){ const e=(await client().from('orchard_sprays').upsert(sprayRows,{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      var harvRows=[]; (stf.harvest||[]).forEach(function(h){ if(!h.id) h.id='oh'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); harvRows.push(ohToDb(h,fid)); });
      if(harvRows.length){ const e=(await client().from('orchard_harvest').upsert(harvRows,{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      // compliance: items upsert + prune; docs/checks/readings replace-all per farm
      var comply=stf.comply||{}; var ckeys=Object.keys(comply);
      if(ckeys.length){ const e=(await client().from('orchard_compliance_items').upsert(ckeys.map(function(k){return ociToDb(k,comply[k],fid);}),{onConflict:'farm_id,item_key'})).error; if(e) throw e; _srvWrote('orchard_compliance_items', ckeys.map(function(k){ return {farm_id:fid,item_key:String(k)}; })); }
      { var keepCi={}; ckeys.forEach(function(k){ keepCi[String(k)]=1; });
        var goneCi=_srvGone('orchard_compliance_items',keepCi,'item_key');
        if(goneCi && goneCi.length){ const e=(await client().from('orchard_compliance_items').delete()
              .eq('farm_id',fid).in('item_key',goneCi)).error; if(e) throw e; _srvForgetRows('orchard_compliance_items','item_key',goneCi); } }
      var cdRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].docs)||[]).forEach(function(d,i){
        var _c={farm_id:fid,item_key:k,name:d.name||null,kind:d.kind||null,added:d.added||null,sort_idx:i};
        if(CAN_ORCH_DOCFILE){ _c.local_id=d.id||null; _c.path=d.path||null; }
        cdRows.push(_c); }); });
      { const e=await replaceAllRows('orchard_compliance_docs',fid,cdRows); if(e) throw e; }
      var ccRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].checks)||[]).forEach(function(c,i){
        var _cc={farm_id:fid,item_key:k,check_date:c.date||null,note:c.note||null,sort_idx:i};
        /* check_date holds a DISPLAY string ("12 Aug") with no year, so on its own it
           cannot order or season-filter an audit trail. check_iso carries the real date.
           att is the evidence document — the whole point of logging a check. */
        /* check_iso is a DATE column. One malformed value would fail the insert and take
           every other orchard row down with it, so anything that is not a clean
           YYYY-MM-DD goes as null rather than risking the whole save. */
        if(CAN_ORCH_CHKMETA){ _cc.check_iso=(/^\d{4}-\d{2}-\d{2}$/.test(String(c.iso||'')))?c.iso:null;
          _cc.ctype=c.ctype||null; _cc.by_who=c.by||null; }
        if(CAN_ORCH_ATT){ _cc.att=c.att||null; }
        ccRows.push(_cc); }); });
      { const e=await replaceAllRows('orchard_compliance_checks',fid,ccRows); if(e) throw e; }
      var crRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].readings)||[]).forEach(function(rd,i){ crRows.push({farm_id:fid,item_key:k,reading_date:rd.date||null,m3:rd.m3||null,sort_idx:i}); }); });
      { const e=await replaceAllRows('orchard_compliance_readings',fid,crRows); if(e) throw e; }
      _orSnap=snap;
      return true;
      } finally { _rel(); }
    },
    async saveConfig(stf){
      if(!stf) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({m:stf.market});
      if(snap===_orCfgSnap) return;
      const e=(await client().from('farms').update({ orchard_market:stf.market||null }).eq('id',fid)).error;
      if(e) throw e;
      _orCfgSnap=snap;
      return true;
    }
  };

  // ---- PLANNING (forecast crop lines + livestock events) — relational -------
  // ST_PLAN.crops[] : forecast lines (linked to a crop land via link_id, or manual).
  // ST_PLAN.events[]: livestock events; herd_local_id is a soft ref to a herd, same
  // pattern as livestock_moves/treatments. UI state (view/tab/months) is transient.
  function planCropToDb(c,fid,i){ return { farm_id:fid, crop:c.crop||null, field:c.field||null, ha:(c.ha!=null&&c.ha!=='')?Number(c.ha):null, plant:c.plant||null, harvest:c.harvest||null, yield_val:(c.yield!=null&&c.yield!=='')?Number(c.yield):null, price:(c.price!=null&&c.price!=='')?Number(c.price):null, input_cost:(c.inputCost!=null&&c.inputCost!=='')?Number(c.inputCost):null, other_cost:(c.otherCost!=null&&c.otherCost!=='')?Number(c.otherCost):null, repeat:c.repeat||null, link_id:c.linkId||null, in_forecast:(c.inForecast===false)?false:true, sort_idx:i }; }
  function planCropFromDb(r){ var c={ crop:r.crop||'', field:r.field||'', ha:Number(r.ha)||0, plant:r.plant||'', harvest:r.harvest||'', yield:Number(r.yield_val)||0, price:Number(r.price)||0, inputCost:Number(r.input_cost)||0, otherCost:Number(r.other_cost)||0, repeat:r.repeat||'none' }; if(r.link_id) c.linkId=r.link_id; if(r.in_forecast===false) c.inForecast=false; return c; }
  function planEvtToDb(e,fid,i){ var row = { farm_id:fid, herd_local_id:(e.herdId!=null)?String(e.herdId):null, species:e.species||null, animal:e.animal||null, icon:e.icon||null, descr:e.desc||null, type:e.type||null, month:e.month||null, qty:(e.qty!=null&&e.qty!=='')?Number(e.qty):null, unit:e.unit||null, price:(e.price!=null&&e.price!=='')?Number(e.price):null, recur:e.recur||null, notes:e.notes||null, use_market:!!e.useMarket, done:!!e.done, sort_idx:i };
    if(CAN_PLANEVT_FC) row.in_forecast = (e.inForecast===false) ? false : true;
    return row; }
  function planEvtFromDb(r){ return { herdId:_numIf(r.herd_local_id), species:r.species||'', animal:r.animal||'', icon:r.icon||'', desc:r.descr||'', type:r.type||'sell', month:r.month||'', qty:Number(r.qty)||0, unit:r.unit||'head', price:Number(r.price)||0, recur:r.recur||'annual', notes:r.notes||'', useMarket:!!r.use_market, done:!!r.done, inForecast:(r.in_forecast===false)?false:true }; }
  load.plan = async function(farmId){
    farmId = farmId || farm.active();
    const [pc,pe] = await Promise.all([
      selectAll(() => client().from('plan_crops').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('plan_events').select('*').eq('farm_id',farmId).order('sort_idx'))
    ]);
    for(const r of [pc,pe]) if(r&&r.error) throw r.error;
    /* Noted BEFORE the empty-plan early return below: "loaded, and there was nothing"
       is a different fact from "never looked", and only the first one entitles a save
       to replace what is on the server. */
    _srvNote('plan_crops', (pc&&pc.data)); _srvNote('plan_events', (pe&&pe.data));
    var cropRows=(pc&&pc.data)||[], evtRows=(pe&&pe.data)||[];
    // null when the farm has never saved a plan — caller drops the demo + seeds from lands.
    if(!cropRows.length && !evtRows.length) return null;
    return { crops:cropRows.map(planCropFromDb), events:evtRows.map(planEvtFromDb) };
  };
  var _planSnap=null;
  var _planGate=Promise.resolve();   // serializes plan saveAll (plan_crops/plan_events are delete-all+insert)
  const plan = {
    // crops + events both replace-all (small per-farm sets; sort_idx preserves order)
    async saveAll(stp){
      if(!stp) return;
      const fid=farm.active(); if(!fid) return;
      var _prev=_planGate, _rel; _planGate=new Promise(function(r){ _rel=r; });
      try{ await _prev; }catch(e){}
      try {
      const crops=(stp.crops||[]), events=(stp.events||[]);
      const snap=JSON.stringify({c:crops,e:events});
      if(snap===_planSnap) return true;
      { var _pcRows=crops.map(function(c,i){ return planCropToDb(c,fid,i); });
        const e=await replaceAllRows('plan_crops',fid,_pcRows); if(e) throw e; }
      { var _peRows=events.map(function(ev,i){ return planEvtToDb(ev,fid,i); });
        const e=await replaceAllRows('plan_events',fid,_peRows); if(e) throw e; }
      _planSnap=snap;
      return true;
      } finally { _rel(); }
    }
  };

  // ==========================================================================
  // WORKERS / PAYROLL — Option A relational (8 tables). Persists the numbers
  // the app produced / the farmer entered. NO tax math here (PAYE/UIF/SDL are
  // computed in index.html). Maps app keys <-> db columns (e.g. sun->sunday,
  // ph->holiday hours). Deferred this pass (logged): compliance sub-state
  // (uifPayments[], coida, hours config, doc tracking) and contractTemplate.extra.
  // ==========================================================================
  function wkrToDb(w, fid){ var row = { farm_id:fid, local_id:String(w.id),
    name:w.name||null, role:w.role||null, worker_type:w.type||null, start_date:w.start||null,
    on_farm:!!w.onFarm, id_no:w.idNo||null, basis:w.basis||null,
    amt:(w.amt!=null&&w.amt!=='')?Number(w.amt):null,
    hours_week:(w.hoursWeek!=null&&w.hoursWeek!=='')?parseInt(w.hoursWeek,10):null,
    hours_day:(w.hoursDay!=null&&w.hoursDay!=='')?parseInt(w.hoursDay,10):null,
    uif:(w.uif!=null)?!!w.uif:null, uif_no:w.uifNo||null, uif_exempt:!!w.uifExempt, works_sundays:!!w.worksSundays,
    contract_status:w.contract||null, activity:w.activity||null,
    leave_annual:(w.leave&&w.leave.annual!=null)?Number(w.leave.annual):null,
    leave_sick:(w.leave&&w.leave.sick!=null)?Number(w.leave.sick):null,
    leave_family:(w.leave&&w.leave.family!=null)?Number(w.leave.family):null,
    housing_deduction:(w.housing&&w.housing.deduction!=null)?Number(w.housing.deduction):null,
    adv_owing:(w.adv&&w.adv.owing!=null)?Number(w.adv.owing):null,
    adv_per_pay:(w.adv&&w.adv.perPay!=null)?Number(w.adv.perPay):null,
    adv_reason:(w.adv&&w.adv.reason)||null,
    adv_consent:(w.adv&&w.adv.consent!=null)?!!w.adv.consent:null,
    fund_on:(w.fund&&w.fund.on!=null)?!!w.fund.on:null,
    fund_where:(w.fund&&w.fund.where)||null, fund_scheme:(w.fund&&w.fund.scheme)||null,
    fund_freq:(w.fund&&w.fund.freq)||null,
    fund_per_pay:(w.fund&&w.fund.perPay!=null)?Number(w.fund.perPay):null,
    fund_balance:(w.fund&&w.fund.balance!=null)?Number(w.fund.balance):null,
    fund_consent:(w.fund&&w.fund.consent!=null)?!!w.fund.consent:null };
    /* The cellphone a payslip goes to, the worker's okay for WhatsApp and the day it was
       given, and the payslip's language. Sent only once the columns exist. */
    if(CAN_WORKER_PHONE){ row.phone=w.phone||null; row.payslip_whatsapp_ok=!!w.waOk;
      row.payslip_whatsapp_on=(w.waOk&&w.waOn)?w.waOn:null; row.payslip_lang=(w.slipLang==='af')?'af':(w.slipLang==='en'?'en':null); }
    return row; }
  function wkrFromDb(r){ var w={ id:r.local_id, name:r.name||'', role:r.role||'', type:r.worker_type||'',
    start:r.start_date||'', onFarm:!!r.on_farm, idNo:r.id_no||'', basis:r.basis||'month',
    amt:Number(r.amt)||0, hoursWeek:(r.hours_week!=null)?Number(r.hours_week):45,
    hoursDay:(r.hours_day!=null)?Number(r.hours_day):8, uif:(r.uif!=null)?!!r.uif:true,
    uifNo:r.uif_no||'', uifExempt:!!r.uif_exempt, worksSundays:!!r.works_sundays, contract:r.contract_status||'missing', activity:r.activity||'' };
    if(r.phone) w.phone=r.phone;
    if(r.payslip_whatsapp_ok){ w.waOk=true; if(r.payslip_whatsapp_on) w.waOn=r.payslip_whatsapp_on; }
    if(r.payslip_lang) w.slipLang=r.payslip_lang;
    if(r.leave_annual!=null||r.leave_sick!=null||r.leave_family!=null){ w.leave={annual:Number(r.leave_annual)||0,sick:Number(r.leave_sick)||0,family:(r.leave_family!=null)?Number(r.leave_family):3}; }
    if(r.housing_deduction!=null) w.housing={deduction:Number(r.housing_deduction)};
    if(r.adv_owing!=null||r.adv_per_pay!=null||r.adv_reason||r.adv_consent!=null){ w.adv={owing:Number(r.adv_owing)||0,perPay:Number(r.adv_per_pay)||0,reason:r.adv_reason||'',consent:!!r.adv_consent}; } else { w.adv=null; }
    if(r.fund_on!=null||r.fund_balance!=null||r.fund_per_pay!=null){ w.fund={on:!!r.fund_on,where:r.fund_where||'hold',scheme:r.fund_scheme||'',freq:r.fund_freq||'month',perPay:Number(r.fund_per_pay)||0,balance:Number(r.fund_balance)||0,consent:!!r.fund_consent}; } else { w.fund=null; }
    return w; }
  function wkSettToDb(stw, fid){ var ct=stw.contractTemplate||{}; return { farm_id:fid,
    nmw_rate:(stw.nmwRate!=null)?Number(stw.nmwRate):null,
    hours_week:(stw.hoursWeek!=null)?parseInt(stw.hoursWeek,10):null,
    tax_threshold:(stw.taxThreshold!=null)?parseInt(stw.taxThreshold,10):null,
    sdl_registered:!!(stw.compliance&&stw.compliance.sdlRegistered),
    contract_brk:ct.brk||null, contract_days:ct.days||null, contract_payday:ct.payday||null,
    contract_method:ct.method||null, contract_prob:ct.prob||null }; }   // contract_extra deferred (object map)
  function wkSettApply(stw, r){ if(!r) return;
    if(r.nmw_rate!=null) stw.nmwRate=Number(r.nmw_rate);
    if(r.hours_week!=null) stw.hoursWeek=Number(r.hours_week);
    if(r.tax_threshold!=null) stw.taxThreshold=Number(r.tax_threshold);
    stw.compliance=stw.compliance||{}; stw.compliance.sdlRegistered=!!r.sdl_registered;
    if(r.contract_brk||r.contract_days||r.contract_payday||r.contract_method||r.contract_prob){
      stw.contractTemplate=Object.assign(stw.contractTemplate||{},{ brk:r.contract_brk||undefined, days:r.contract_days||undefined, payday:r.contract_payday||undefined, method:r.contract_method||undefined, prob:r.contract_prob||undefined }); } }
  function wkLedgerRows(stw, fid){ var rows=[]; (stw.workers||[]).forEach(function(w){ (w.ledger||[]).forEach(function(e,i){ rows.push({ farm_id:fid, worker_local_id:String(w.id), entry_date:e.date||null, kind:e.kind||null, amt:(e.amt!=null)?Number(e.amt):null, note:e.note||null, sort_idx:i }); }); }); return rows; }
  function wkLeaveRows(stw, fid){ var rows=[]; (stw.workers||[]).forEach(function(w){ (w.leaveLog||[]).forEach(function(e,i){ rows.push({ farm_id:fid, worker_local_id:String(w.id), leave_type:e.type||null, days:(e.days!=null)?Number(e.days):null, log_date:e.date||null, sort_idx:i }); }); }); return rows; }
  function wkDocRows(stw, fid){ var rows=[]; (stw.workers||[]).forEach(function(w){ (w.docs||[]).forEach(function(d,i){ rows.push({ farm_id:fid, worker_local_id:String(w.id), doc_id:d.id||null, name:d.name||null, doc_type:d.type||null, mime:d.mime||null, size:(d.size!=null)?parseInt(d.size,10):null, added_date:d.date||null, url:d.url||null, sort_idx:i }); }); }); return rows; }   // metadata only; blob deferred to Storage
  function wkPayrollRows(stw, fid){ var by={};
    function ensure(L,wid){ var k=L+'\u0000'+wid; var r=by[k]; if(!r){ r=by[k]={ farm_id:fid, period_label:L, worker_local_id:String(wid), paye:0, bonus:0, sunday:0, holiday:0, seasonal_days:0 }; } return r; }
    var P=stw.paye||{}; Object.keys(P).forEach(function(L){ var m=P[L]||{}; Object.keys(m).forEach(function(wid){ ensure(L,wid).paye=Number(m[wid])||0; }); });
    var B=stw.bonus||{}; Object.keys(B).forEach(function(L){ var m=B[L]||{}; Object.keys(m).forEach(function(wid){ ensure(L,wid).bonus=Number(m[wid])||0; }); });
    var E=stw.extra||{}; Object.keys(E).forEach(function(L){ var m=E[L]||{}; Object.keys(m).forEach(function(wid){ var e=m[wid]||{}; var r=ensure(L,wid); r.sunday=Number(e.sun)||0; r.holiday=Number(e.ph)||0; }); });
    var S=stw.seasonal||{}; Object.keys(S).forEach(function(L){ var m=S[L]||{}; Object.keys(m).forEach(function(wid){ ensure(L,wid).seasonal_days=Number(m[wid])||0; }); });
    return Object.keys(by).map(function(k){ return by[k]; }); }
  function wkPayrollToMaps(rows){ var paye={},bonus={},extra={},seasonal={};
    (rows||[]).forEach(function(r){ var L=r.period_label, wid=r.worker_local_id;
      if(r.paye){ (paye[L]=paye[L]||{})[wid]=Number(r.paye); }
      if(r.bonus){ (bonus[L]=bonus[L]||{})[wid]=Number(r.bonus); }
      if(r.sunday||r.holiday){ var e=(extra[L]=extra[L]||{})[wid]=(extra[L][wid]||{}); if(r.sunday)e.sun=Number(r.sunday); if(r.holiday)e.ph=Number(r.holiday); }
      if(r.seasonal_days){ (seasonal[L]=seasonal[L]||{})[wid]=Number(r.seasonal_days); } });
    return { paye:paye, bonus:bonus, extra:extra, seasonal:seasonal }; }
  function payRunToDb(r, fid){ var row = { farm_id:fid, local_id:String(r.id), label:r.label||null, kind:r.kind||null, net:(r.net!=null)?Number(r.net):null, gross:(r.gross!=null)?Number(r.gross):null, uif:(r.uif!=null)?Number(r.uif):null, run_date:r.date||null, seasonal:!!r.seasonal };
    if(CAN_PAYRUN_META){ row.source=r.source||null; row.block=r.block||null;
      row.per_picker=(r.perPicker!=null&&r.perPicker!=='')?Number(r.perPicker):null; }
    return row; }
  function payRunFromDb(r){ var o={ id:r.local_id, label:r.label||'', kind:r.kind||'', net:Number(r.net)||0, date:r.run_date||'' }; if(r.gross!=null)o.gross=Number(r.gross); if(r.uif!=null)o.uif=Number(r.uif); if(r.seasonal)o.seasonal=true;
    if(r.source)o.source=r.source; if(r.block)o.block=r.block;
    if(r.per_picker!=null)o.perPicker=Number(r.per_picker);
    return o; }
  /* A kept payslip: written once when its pay run is posted, then only its status moves
     (issued -> withdrawn on undo -> replaced when the month is posted again). `snap` is
     the whole printed page, so nothing a later edit does to the worker can change it. */
  function payslipToDb(p, fid){ return { farm_id:fid, local_id:String(p.id), run_local_id:String(p.runId),
    worker_local_id:String(p.wid), period_label:p.label||'', seasonal:!!p.seasonal, status:p.status||'issued',
    replaced_by:p.replacedBy||null, kept_on:p.keptOn||null,
    gross:(p.snap&&p.snap.gross!=null)?Number(p.snap.gross):null, net:(p.snap&&p.snap.net!=null)?Number(p.snap.net):null,
    snap:p.snap||{} }; }
  function payslipFromDb(r){ return { id:r.local_id, runId:r.run_local_id, wid:r.worker_local_id, label:r.period_label||'',
    seasonal:!!r.seasonal, status:r.status||'issued', replacedBy:r.replaced_by||null, keptOn:r.kept_on||'', snap:r.snap||{} }; }
  /* Written by the PHONE only: the farmer's answer to "did it reach Sipho?". Read here. */
  function payslipSendFromDb(r){ return { uid:r.client_uid, slip:r.payslip_local_id, wid:r.worker_local_id||'',
    outcome:r.outcome||'sent', at:r.sent_at||r.created_at||'' }; }
  function payAppliedRows(stw, fid){ var rows=[]; (stw.payRuns||[]).forEach(function(r){ (r.applied||[]).forEach(function(a){ rows.push({ farm_id:fid, run_local_id:String(r.id), worker_local_id:String(a.wid), adv_repaid:(a.advRepay!=null)?Number(a.advRepay):0, savings_in:(a.savings!=null)?Number(a.savings):0 }); }); }); return rows; }

  load.workers = async function(farmId){
    farmId = farmId || farm.active();
    /* Every one of these except the settings row grows without bound: the ledger
       and pay_run_applied carry one row per worker per pay period, so twenty
       workers paid weekly cross PostgREST's 1000-row cap inside two seasons and
       the load would silently return only the first page. That is the same fault
       selectAll() was written for on transactions — and it matters more here,
       because these rows feed the SARS submission. worker_settings is one row a
       farm and is left as a plain select. */
    const [wk,st,lg,lv,dc,pe,pr,pa] = await Promise.all([
      selectAll(() => client().from('workers').select('*').eq('farm_id',farmId).order('created_at')),
      client().from('worker_settings').select('*').eq('farm_id',farmId),
      selectAll(() => client().from('worker_ledger').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('worker_leave_log').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('worker_docs').select('*').eq('farm_id',farmId).order('sort_idx')),
      selectAll(() => client().from('payroll_entries').select('*').eq('farm_id',farmId)),
      selectAll(() => client().from('pay_runs').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})),
      selectAll(() => client().from('pay_run_applied').select('*').eq('farm_id',farmId))
    ]);
    for(const r of [wk,st,lg,lv,dc,pe,pr,pa]) if(r&&r.error) throw r.error;
    /* Kept payslips and what the phone sent. Only when the tables exist; otherwise the
       result carries neither and the device keeps what it holds. */
    var ps=null, sd=null;
    if(CAN_PAYSLIPS){
      const [a,b] = await Promise.all([
        selectAll(() => client().from('payslips').select('*').eq('farm_id',farmId).order('created_at')),
        selectAll(() => client().from('payslip_sends').select('*').eq('farm_id',farmId).order('sent_at'))
      ]);
      if(a&&a.error) throw a.error; if(b&&b.error) throw b.error;
      ps=(a.data||[]).map(payslipFromDb); sd=(b.data||[]).map(payslipSendFromDb);
    }
    _srvNote('workers', wk.data);            _srvNote('worker_ledger', lg.data);
    _srvNote('worker_leave_log', lv.data);   _srvNote('worker_docs', dc.data);
    _srvNote('payroll_entries', pe.data);    _srvNote('pay_runs', pr.data);
    _srvNote('pay_run_applied', pa.data);
    var workers=(wk.data||[]).map(wkrFromDb);
    var byW={}; workers.forEach(function(w){ byW[String(w.id)]=w; });
    (lg.data||[]).forEach(function(r){ var w=byW[r.worker_local_id]; if(w){ (w.ledger=w.ledger||[]).push({date:r.entry_date||'',kind:r.kind||'',amt:Number(r.amt)||0,note:r.note||''}); } });
    (lv.data||[]).forEach(function(r){ var w=byW[r.worker_local_id]; if(w){ (w.leaveLog=w.leaveLog||[]).push({type:r.leave_type||'',days:Number(r.days)||0,date:r.log_date||''}); } });
    (dc.data||[]).forEach(function(r){ var w=byW[r.worker_local_id]; if(w){ (w.docs=w.docs||[]).push({id:r.doc_id||('d'+r.id),name:r.name||'',type:r.doc_type||'',mime:r.mime||'',size:Number(r.size)||0,date:r.added_date||'',url:r.url||''}); } });
    var payRuns=(pr.data||[]).map(payRunFromDb);
    var byRun={}; (pa.data||[]).forEach(function(r){ (byRun[r.run_local_id]=byRun[r.run_local_id]||[]).push({wid:r.worker_local_id,advRepay:Number(r.adv_repaid)||0,savings:Number(r.savings_in)||0}); });
    payRuns.forEach(function(r){ if(byRun[r.id]) r.applied=byRun[r.id]; });
    var out={ workers:workers, settingsRow:(st.data&&st.data[0])||null, payroll:wkPayrollToMaps(pe.data||[]), payRuns:payRuns };
    if(ps){ out.payslips=ps; out.payslipSends=sd; }
    return out;
  };

  var _wkSnap=null;
  const workersSave = {
    apply: wkSettApply,
    async saveAll(stw){
      if(!stw) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({ w:stw.workers, s:[stw.nmwRate,stw.hoursWeek,stw.taxThreshold,(stw.compliance&&stw.compliance.sdlRegistered),stw.contractTemplate], p:stw.paye, b:stw.bonus, e:stw.extra, sd:stw.seasonal, r:stw.payRuns, ps:stw.payslips });
      if(snap===_wkSnap) return;
      { const e=(await client().from('worker_settings').upsert(wkSettToDb(stw,fid),{onConflict:'farm_id'})).error; if(e) throw e; }
      var ws=(stw.workers||[]);
      if(ws.length){ const e=(await client().from('workers').upsert(ws.map(function(w){return wkrToDb(w,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      var lgR=wkLedgerRows(stw,fid);      { const e=await replaceAllRows('worker_ledger',fid,lgR); if(e) throw e; }
      var lvR=wkLeaveRows(stw,fid);      { const e=await replaceAllRows('worker_leave_log',fid,lvR); if(e) throw e; }
      var dcR=wkDocRows(stw,fid);      { const e=await replaceAllRows('worker_docs',fid,dcR); if(e) throw e; }
      var peR=wkPayrollRows(stw,fid); if(peR.length){ const e=(await client().from('payroll_entries').upsert(peR,{onConflict:'farm_id,period_label,worker_local_id'})).error; if(e) throw e; }
      var prR=(stw.payRuns||[]).map(function(r){return payRunToDb(r,fid);}); if(prR.length){ const e=(await client().from('pay_runs').upsert(prR,{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      var paR=payAppliedRows(stw,fid);      { const e=await replaceAllRows('pay_run_applied',fid,paR); if(e) throw e; }
      /* Upsert only, never a prune: a kept payslip is a record that was handed to a worker. */
      if(CAN_PAYSLIPS && (stw.payslips||[]).length){
        const e=(await client().from('payslips').upsert(stw.payslips.map(function(p){return payslipToDb(p,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      _wkSnap=snap;
      return true;
    },
    async removePayRun(localId){
      const fid=farm.active(); if(!fid||localId==null) return;
      { const e=(await client().from('pay_run_applied').delete().eq('farm_id',fid).eq('run_local_id',String(localId))).error; if(e) throw e; }
      { const e=(await client().from('pay_runs').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; }
      _wkSnap=null; return true;
    },
    async removeWorker(localId){
      const fid=farm.active(); if(!fid||localId==null) return;
      const wl=String(localId);
      { const e=(await client().from('worker_ledger').delete().eq('farm_id',fid).eq('worker_local_id',wl)).error; if(e) throw e; }
      { const e=(await client().from('worker_leave_log').delete().eq('farm_id',fid).eq('worker_local_id',wl)).error; if(e) throw e; }
      { const e=(await client().from('worker_docs').delete().eq('farm_id',fid).eq('worker_local_id',wl)).error; if(e) throw e; }
      { const e=(await client().from('workers').delete().eq('farm_id',fid).eq('local_id',wl)).error; if(e) throw e; }
      _wkSnap=null; return true;
    }
  };


  // ---- SETTINGS / FARM PROFILE ---------------------------------------------
  // All on the farms row (name/owner/province/ha/type/fy/lang already existed;
  // vat_registered/tax_number/vat_number added by settings_profile_schema.sql).
  /* ---- SETTINGS: send only what changed, never write over a newer row ----------------
     Every save used to send all of the farm's settings, every time, so a device that had
     not refreshed wrote its own older copy over whatever another device had changed. Now
     each field is compared with what the SERVER last confirmed (seeded whenever the farm
     row is read), only the differences are sent, and each write carries the row version
     this device last saw. If this device is behind, the server keeps its own row and says
     nothing (guard_updated_at) - so every write reads back what was kept: when the server
     kept its own, this device re-reads the row, keeps only the fields the FARMER changed
     here, and sends those once more. The other device's fields are left alone. */
  /* What the server last confirmed, kept per farm ON THIS DEVICE. In memory only, it was empty
     at the start of a session - so the first save after an app open (the catch-up) had nothing to
     compare against and sent every field, unconditionally, which is exactly the cross-device
     overwrite this is meant to stop (seen live, 16 Sep 2026). Persisted, it tells this device which
     fields the FARMER changed here while it was closed. */
  var _profAck = null, _profAckFarm = null;
  function _profAckKey(){ var fid = farm.active(); return fid ? SYNC_KEY.replace('unsent', 'ack') + fid : null; }
  function _profAckGet(){
    var fid = farm.active();
    if(_profAck && _profAckFarm === fid) return _profAck;
    _profAckFarm = fid; _profAck = null;
    try{ var k = _profAckKey(), raw = k ? localStorage.getItem(k) : null; if(raw) _profAck = JSON.parse(raw); }catch(e){ _profAck = null; }
    return _profAck;
  }
  function _profAckClear(){ try{ var k = _profAckKey(); if(k) localStorage.removeItem(k); }catch(e){} _profAck = null; }
  function _stableJson(v){
    if(v === null || typeof v !== 'object') return JSON.stringify(v);
    if(Array.isArray(v)) return '[' + v.map(_stableJson).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function(k){ return JSON.stringify(k) + ':' + _stableJson(v[k]); }).join(',') + '}';
  }
  function _profSameValue(a, b){
    if(a === b) return true;
    if(a == null || b == null) return (a == null && b == null);
    if(typeof a === 'object' || typeof b === 'object') return _stableJson(a) === _stableJson(b);
    /* The server hands a timestamp back in its own format ('...T18:20:54.05+00:00' for the
       '...T18:20:54.050Z' that went out) - the same instant, different text. Comparing the text
       called a SUCCESSFUL write "kept by the server", so the save retried for ever and the farmer
       saw "Not saved online" (seen live on the UK account, 16 Sep 2026). */
    if(typeof a === 'string' && typeof b === 'string'){
      var ISO = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/;
      if(ISO.test(a) && ISO.test(b)){
        var ta = Date.parse(a), tb = Date.parse(b);
        if(!isNaN(ta) && !isNaN(tb)) return ta === tb;
      }
    }
    if(typeof a === 'number' || typeof b === 'number'){ var na = Number(a), nb = Number(b); if(!isNaN(na) && !isNaN(nb)) return na === nb; }
    return String(a) === String(b);
  }
  function _profNoteAck(row){
    if(!row || typeof row !== 'object') return;
    var ack = _profAckGet() || {};
    Object.keys(row).forEach(function(k){ ack[k] = row[k]; });
    _profAck = ack; _profAckFarm = farm.active();
    try{ var k = _profAckKey(); if(k) localStorage.setItem(k, JSON.stringify(ack)); }catch(e){}
  }
  /* db column -> the name the app keeps it under, for the fields the settings save writes.
     Used after the server keeps its own row: this device adopts the server's values for
     everything the farmer did NOT change here, so the next save cannot push them back. */
  var _PROF_COL_TO_KEY = {
    name: 'farmName', owner_name: 'ownerName', province: 'province', region: 'region',
    farm_ha: 'farmHa', farm_type: 'farmType', fy_start_month: 'fyStartMonth', lang: 'lang',
    vat_registered: 'vatRegistered', vat_category: 'vatCategory', tax_number: 'taxNumber',
    utr: 'taxNumber', vat_number: 'vatNumber', entity_type: 'entityType', partners: 'partners',
    farm_address: 'farmAddr', paye_ref: 'payeRef', stock_mark: 'stockMark',
    stock_mark_type: 'stockMarkType', herd_mark: 'stockMark',
    bank_balance: 'bankBalance', bank_balance_at: 'bankBalanceAt',
    season_start_month: 'seasonStartMonth', budget_expense_target: 'budgetExpenseTarget'
  };
  function _profAdopt(st, mine){
    var ack = _profAckGet();
    if(!st || !ack) return;
    Object.keys(ack).forEach(function(col){
      if(mine && (col in mine)) return;                 // the farmer changed this here: keep it
      var key = _PROF_COL_TO_KEY[col];
      if(!key) return;                                  // rain, crop prices and the like live elsewhere
      var v = ack[col];
      if(v === undefined) return;
      if(col === 'partners'){ try{ v = (typeof v === 'string') ? JSON.parse(v) : v; }catch(e){ return; } }
      st[key] = v;
    });
    /* Settings may be on screen with the OLD value still in its inputs - and Save settings reads the
       inputs, so it would write the old value straight back (seen live, 16 Sep 2026). Tell the app. */
    try{ if(typeof global.aiProfileAdopted === 'function') global.aiProfileAdopted(); }catch(e){}
  }
  function _profChanged(payload){
    var out = {};
    Object.keys(payload).forEach(function(k){
      var ack = _profAckGet();
      if(!ack || !(k in ack) || !_profSameValue(ack[k], payload[k])) out[k] = payload[k];
    });
    return out;
  }
  /* One statement: send the changed fields, read back what the server kept. */
  async function _profWrite(fid, payload){
    var keys = Object.keys(payload);
    if(!keys.length) return { skipped: true };
    var q = client().from('farms').update(payload).eq('id', fid);
    /* The write only applies while the row is still the version this device last read: a row
       that has moved on matches nothing, so 0 rows come back and the caller knows it was kept.
       This does not depend on a database trigger - SA's farms table already carries an older
       trigger that stamps updated_at BEFORE any guard would run, so a guard could never see the
       version the client sent (probed live, 16 Sep 2026). Proved on the live row: a stale
       version updates 0 rows, the current version updates 1 and stamps a new one. */
    var ack = _profAckGet();
    if(ack && ack.updated_at) q = q.eq('updated_at', ack.updated_at);
    var r = await q.select(keys.concat(['updated_at']).join(','));
    if(r.error) return { error: r.error };
    var rows = r.data || [];
    if(!rows.length) return { stale: true };
    var row = rows[0];
    var kept = keys.every(function(k){ return _profSameValue(row[k], payload[k]); });
    if(kept){ _profNoteAck(row); return { ok: true, row: row }; }
    return { stale: true, row: row };
  }
  function profileFromDb(r){ if(!r) return null; var p={};
    _profNoteAck(r);   /* what the server has, field by field */
    /* Underscore-prefixed, so the hydrate's blanket copy onto ST skips it and
       the rain book applies it to ST_RAIN itself. */
    if(r.rain_lat!=null || r.rain_mode!=null || r.rain_year_start!=null){
      p._rain={};
      if(r.rain_lat!=null && r.rain_lon!=null) p._rain.loc={ lat:Number(r.rain_lat), lon:Number(r.rain_lon), town:r.rain_town||'' };
      if(r.rain_mode!=null) p._rain.mode=r.rain_mode;
      if(r.rain_year_start!=null) p._rain.yearStart=parseInt(r.rain_year_start,10);
      if(r.rain_normal_override!=null) p._rain.normalOverride=Number(r.rain_normal_override);
    }
    if(r.rain_not_kept!=null){ p._rain=p._rain||{}; p._rain.notKept=Array.isArray(r.rain_not_kept)?r.rain_not_kept:[]; }
    if(r.rain_plant_mm!=null || r.rain_plant_days!=null){ p._rain=p._rain||{}; p._rain.rule={ plantMm:(r.rain_plant_mm!=null?Number(r.rain_plant_mm):null), plantDays:(r.rain_plant_days!=null?parseInt(r.rain_plant_days,10):null) }; }
    /* What some device already derived: frost, the season lean, the veld norm.
       Read back so a second computer, and the phone, show the same figures
       without re-fetching an archive. Null branches mean "not derived". */
    if(r.rain_derived!=null){ p._rain=p._rain||{}; p._rain.derived=r.rain_derived; }
    /* Year-end stock counts, keyed by tax year (stock_counts_migration.sql). An absent
       year means "not counted", never zero - see the column comment. */
    if(r.stock_counts!=null){
      try{ p.stockCounts = (typeof r.stock_counts==='string') ? JSON.parse(r.stock_counts) : r.stock_counts; }
      catch(e){ p.stockCounts = {}; }
    }
    if(r.rain_fill_sat!=null){ p._rain=p._rain||{}; p._rain.fillFromSat=!!r.rain_fill_sat; }
    if(r.name!=null) p.farmName=r.name;
    if(r.owner_name!=null) p.ownerName=r.owner_name;
    if(r.province!=null) p.province=r.province;
    if(r.farm_ha!=null) p.farmHa=Number(r.farm_ha);
    if(r.farm_type!=null) p.farmType=r.farm_type;
    if(r.fy_start_month!=null) p.fyStartMonth=parseInt(r.fy_start_month,10);
    if(r.lang!=null) p.lang=r.lang;
    if(r.vat_registered!=null) p.vatRegistered=!!r.vat_registered;
    /* The category decides the VAT201 due date. It lived only on this device until
       vat_category_migration.sql, so a phone quietly assumed A. */
    if(r.vat_category!=null)   p.vatCategory=String(r.vat_category);
    if(r.tax_number!=null) p.taxNumber=r.tax_number;
    if(r.vat_number!=null) p.vatNumber=r.vat_number;
    if(r.entity_type!=null) p.entityType=r.entity_type;
    if(r.partners!=null){ try{ p.partners=(typeof r.partners==='string')?JSON.parse(r.partners):r.partners; }catch(e){ p.partners=[]; } }
    if(r.farm_address!=null) p.farmAddr=r.farm_address;
    if(r.paye_ref!=null) p.payeRef=r.paye_ref;
    if(r.stock_mark!=null) p.stockMark=r.stock_mark;
    if(r.stock_mark_type!=null) p.stockMarkType=r.stock_mark_type;
    /* Device-sync settings. The scalars land on ST through the caller's generic
       key-copy; the blobs are handed back under their own names because they belong to
       ST_CROP, ST_PLAN and ST_LOANAPP rather than ST, and the caller applies those. */
    if(r.bank_balance!=null)          p.bankBalance=Number(r.bank_balance);
    if(r.bank_balance_at!=null)       p.bankBalanceAt=r.bank_balance_at;
    /* What the server holds right now, so profileSave can tell whether the farmer
       actually changed the balance or merely re-saved the profile around it. */
    _bankSeen = (r.bank_balance!=null) ? Number(r.bank_balance) : null;
    if(r.season_start_month!=null)    p.seasonStartMonth=parseInt(r.season_start_month,10);
    if(r.budget_expense_target!=null) p.budgetExpenseTarget=Number(r.budget_expense_target);
    if(r.loan_app!=null)              p._loanApp=r.loan_app;
    if(r.crop_prices!=null)           p._cropPrices=r.crop_prices;
    if(r.crop_types!=null)            p._cropTypes=r.crop_types;
    if(r.plan_hedge!=null)            p._planHedge=r.plan_hedge;
    return p; }
  load.profile = async function(farmId){
    farmId=farmId||farm.active();
    const r=await client().from('farms').select((CAN_FARM_SETTINGS?'bank_balance,season_start_month,budget_expense_target,loan_app,crop_prices,crop_types,plan_hedge,':'')+(CAN_FARM_RAIN?'rain_lat,rain_lon,rain_town,rain_year_start,rain_mode,rain_normal_override,':'')+(CAN_FARM_RAIN_NK?'rain_not_kept,':'')+(CAN_FARM_RAIN_RULE?'rain_plant_mm,rain_plant_days,rain_fill_sat,':'')+(CAN_FARM_RAIN_DRV?'rain_derived,':'')+(CAN_FARM_STOCK?'stock_counts,':'')+(CAN_FARM_BANK_AT?'bank_balance_at,':'')+(CAN_FARM_VAT_CAT?'vat_category,':'')+(CAN_FARM_PARTNERS?'partners,':'')+'name,owner_name,province,farm_ha,farm_type,fy_start_month,lang,vat_registered,tax_number,vat_number,entity_type,stock_mark,stock_mark_type,farm_address,paye_ref,updated_at').eq('id',farmId).single();
    if(r.error) throw r.error;
    return profileFromDb(r.data);
  };
  var _profSnap=null;
  const profile = {
    // Update only the fields actually provided — never null out an existing value.
    // Core columns (always present) save first and independently of the
    // registration columns (vat_registered/tax_number/vat_number, added by
    // settings_profile_schema.sql) so a missing migration can never block the
    // whole save — the symptom that would otherwise be "nothing saved".
    async save(st){
      if(!st) return; const fid=farm.active(); if(!fid) return;
      var core={}, extra={};
      if(st.farmName) core.name=st.farmName;
      if(st.ownerName) core.owner_name=st.ownerName;
      if(st.province) core.province=st.province;
      if(st.farmHa!=null && st.farmHa!=='') core.farm_ha=Number(st.farmHa);
      if(st.farmType) core.farm_type=st.farmType;
      if(st.fyStartMonth!=null) core.fy_start_month=parseInt(st.fyStartMonth,10);
      if(st.lang) core.lang=st.lang;
      if(st.vatRegistered!=null) extra.vat_registered=!!st.vatRegistered;
      if(CAN_FARM_VAT_CAT && st.vatCategory) extra.vat_category=String(st.vatCategory);
      if(st.taxNumber) extra.tax_number=st.taxNumber;
      if(st.vatNumber) extra.vat_number=st.vatNumber;
      if(st.entityType) extra.entity_type=st.entityType;
      /* Gated on the column: an unknown column would sink the whole `extra` statement. */
      if(CAN_FARM_PARTNERS && Array.isArray(st.partners)) extra.partners=st.partners;
      if(st.farmAddr!=null) extra.farm_address=st.farmAddr;
      if(st.payeRef!=null) extra.paye_ref=st.payeRef;
      if(st.stockMark!=null) extra.stock_mark=st.stockMark;
      if(st.stockMarkType!=null) extra.stock_mark_type=st.stockMarkType;
      /* POPIA consent. Captured by the onboarding gate as {policyVersion, acceptedAt}
         but, until now, only ever stored in the browser \u2014 a cleared cache erased the
         proof that consent was ever given. Written in its OWN statement and gated on
         the column probe, on the same rule as `extra`: a database that has not had the
         consent migration must not lose the farm name along with it. */
      var cons={};
      if(CAN_FARM_CONSENT && st.consent && st.consent.policyVersion){
        cons.consent_version    = st.consent.policyVersion;
        cons.consent_accepted_at= st.consent.acceptedAt || new Date().toISOString();
      }
      /* The seven that used to live only in localStorage. Read from their own globals
         rather than from st, because only the three scalars are on ST — crop prices,
         crop types, forward selling and the lender-pack inputs belong to ST_CROP,
         ST_PLAN and ST_LOANAPP. Own statement, own gate: a database without the
         migration must not lose the farm name along with them. */
      var sett={};
      if(CAN_FARM_SETTINGS){
        if(st.bankBalance!=null && st.bankBalance!==''){
          sett.bank_balance=Number(st.bankBalance);
          /* Date it only when the FIGURE moved. Stamping on every profile save would
             make a month-old balance look like this morning's the next time someone
             edited a VAT number, which is the exact dishonesty this column exists to
             remove. */
          /* The date ON THE STATEMENT when the farmer gave one (Money Flow asks for it, so
             the books can be checked against the bank); otherwise the day it changed. */
          if(CAN_FARM_BANK_AT && st.bankBalanceAt){
            sett.bank_balance_at=String(st.bankBalanceAt).slice(0,10);
            _bankSeen=Number(st.bankBalance);
          } else if(CAN_FARM_BANK_AT && Number(st.bankBalance)!==_bankSeen){
            sett.bank_balance_at=new Date().toISOString().slice(0,10);
            _bankSeen=Number(st.bankBalance);
          }
        }
        if(st.seasonStartMonth!=null)                                   sett.season_start_month=parseInt(st.seasonStartMonth,10);
        if(st.budgetExpenseTarget!=null && st.budgetExpenseTarget!=='') sett.budget_expense_target=Number(st.budgetExpenseTarget);
        try{ var _la=global.ST_LOANAPP; if(_la && Object.keys(_la).length) sett.loan_app=_la; }catch(e){}
        try{ var _cp=global.ST_CROP && global.ST_CROP.prices;    if(_cp && Object.keys(_cp).length) sett.crop_prices=_cp; }catch(e){}
        try{ var _ct=global.ST_CROP && global.ST_CROP.cropTypes; if(_ct && _ct.length)              sett.crop_types=_ct; }catch(e){}
        try{ var _ph=global.ST_PLAN && global.ST_PLAN.hedge;     if(_ph && Object.keys(_ph).length) sett.plan_hedge=_ph; }catch(e){}
      }
      var rainc={};
      if(CAN_FARM_RAIN){
        try{
          var _r=global.ST_RAIN;
          if(_r){
            if(_r.loc && _r.loc.lat!=null){ rainc.rain_lat=Number(_r.loc.lat); rainc.rain_lon=Number(_r.loc.lon); rainc.rain_town=_r.loc.town||null; }
            if(_r.mode) rainc.rain_mode=_r.mode;
            if(_r.yearStart!=null) rainc.rain_year_start=parseInt(_r.yearStart,10);
            if(_r.normal && _r.normal.override!=null) rainc.rain_normal_override=Number(_r.normal.override);
          }
        }catch(e){}
      }
      /* The stretches a farmer was not keeping the book, in their own update:
         until rainfall_not_kept.sql is run the column is missing, and a failed
         write must not take the farm's rain location down with it. Written only
         when this device actually holds the list, so a device that never loaded
         it cannot wipe another device's answer. */
      var raink={};
      if(CAN_FARM_RAIN_NK){
        try{ var _rk=global.ST_RAIN; if(_rk && Array.isArray(_rk.notKept)) raink.rain_not_kept=_rk.notKept; }catch(e){}
      }
      /* The planting rule and the satellite-fill switch, in their own update for
         the same reason. Written only once the farmer has chosen them — a device
         still on the defaults must never overwrite a choice made on another. */
      var rainr={};
      if(CAN_FARM_RAIN_RULE){
        try{
          var _rr=global.ST_RAIN;
          if(_rr && _rr.rule && _rr.rule.set){ rainr.rain_plant_mm=Number(_rr.rule.plantMm)||null; rainr.rain_plant_days=parseInt(_rr.rule.plantDays,10)||null; }
          if(_rr && _rr.fillSet) rainr.rain_fill_sat=!!_rr.fillFromSat;
        }catch(e){}
      }
      /* What this device DERIVED, so the phone and a second computer can show it
         without fetching an archive of their own. Frost and the season lean are
         written already GATED -- rnFrostCalibrated() decides frost, and
         rnSeasOutlook() returns null when the run is stale, biased, or a coin
         toss -- so a reader inherits the desktop's judgement rather than having
         to re-implement it.

         Written only when this device actually derived something. A computer
         that has never set up rainfall holds nothing, and must not null out the
         figures another device worked out. */
      var raind={};
      if(CAN_FARM_RAIN_DRV){
        try{
          var _rd=global.ST_RAIN, drv={ at:null, frost:null, season:null, veld:null };
          if(_rd){
            try{ if(typeof rnFrostCalibrated==='function' && rnFrostCalibrated() && _rd.frost) drv.frost=_rd.frost; }catch(e){}
            try{
              var _so=(typeof rnSeasOutlook==='function') ? rnSeasOutlook() : null;
              if(_so){
                drv.season={ months:_so.months, n:_so.n, below:_so.below, lean:_so.lean,
                             dryOf10:_so.dryOf10, wetOf10:_so.wetOf10,
                             /* the ensemble's OWN fetch date: staleness is judged
                                against this, never against `at`. */
                             fetched:(_rd.seas && _rd.seas.fetched) || null };
              }
            }catch(e){}
            try{
              var _vl=(typeof rnVeldLines==='function') ? rnVeldLines() : null;
              if(_vl && _vl.now>0) drv.veld={ haLsu:Math.round(_vl.now*10)/10, pct:_vl.pct,
                                              src:(_vl.norm && _vl.norm.src)||null };
            }catch(e){}
          }
          if(drv.frost || drv.season || drv.veld){
            drv.at=new Date().toISOString().slice(0,10);
            raind.rain_derived=drv;
          }
        }catch(e){}
      }
      /* Year-end stock counts (stock_counts_migration.sql). Its own statement on the
         same rule as every other optional column: a database without it still saves the
         rest. Sent whenever the app holds the object at all - including when it is EMPTY,
         because clearing the last count has to overwrite the server's copy. Dropping the
         key instead would send nothing, and the old figure would come back on the next
         load. */
      var stockc={};
      if(CAN_FARM_STOCK && st.stockCounts && typeof st.stockCounts==='object') stockc.stock_counts=st.stockCounts;
      var snap=JSON.stringify({c:core,e:extra,k:cons,s:sett,r:rainc,n:raink,p:rainr,d:raind,t:stockc}); if(snap===_profSnap) return;
      /* Only what differs from the row the server last confirmed. */
      var groups = [
        { all: core,  fatal: true },
        { all: extra, warn: 'Profile: optional fields (VAT/tax/business-type) not saved \u2014 run the profile-schema migrations in Supabase.' },
        { all: sett,  warn: 'Profile: device-sync settings not saved (migration missing?)' },
        { all: cons,  warn: 'Profile: POPIA consent not recorded \u2014 run the consent migration in Supabase.' },
        { all: rainr, warn: 'Profile: planting rule / satellite fill not saved \u2014 run rainfall_farm_settings.sql.' },
        { all: raind, warn: 'Profile: derived rain values (frost / season / veld) not saved \u2014 run rain_derived_migration.sql.' },
        { all: stockc, warn: 'Profile: year-end stock count not saved \u2014 run stock_counts_migration.sql.' },
        { all: raink, warn: 'Profile: rain-book gaps not saved \u2014 run rainfall_not_kept.sql.' },
        { all: rainc, warn: 'Profile: rainfall location not saved \u2014 run rainfall_schema.sql.' }
      ];
      var extraOk = true, firstErr = null, stale = [];
      for(var gi = 0; gi < groups.length; gi++){
        var g = groups[gi];
        g.body = _profChanged(g.all);
        if(!Object.keys(g.body).length) continue;
        var res = await _profWrite(fid, g.body);
        if(res.error){
          if(g.fatal) throw res.error;
          extraOk = false; firstErr = firstErr || res.error;
          try{ console.warn(g.warn + ' (' + (res.error.message || res.error) + ')'); }catch(e){}
        } else if(res.stale){ stale.push(g); }
        else if(g.done) g.done();
      }
      if(stale.length){
        /* The server kept a newer row: re-read it, adopt everything the farmer did NOT change on
           this device (otherwise this device's older copy of those fields would be sent as if it
           were an edit), then send only what the farmer did change here. */
        try{ await load.profile(fid); }catch(e){}
        var mine = {}; stale.forEach(function(g){ Object.keys(g.body).forEach(function(k){ mine[k] = true; }); });
        try{ _profAdopt(st, mine); }catch(e){}
        for(var si = 0; si < stale.length; si++){
          var s2 = stale[si], done2 = false, r2 = null;
          /* Up to three rounds, not one. The guard is optimistic concurrency on
             farms.updated_at, and losing it once is ordinary: the row moves whenever
             anything else writes to it, and a page load writes to it. Giving up after a
             single retry turned "somebody else touched the row a moment ago" into a
             refused save - proved on a live account, where the farmer was told the figure
             had not reached the server while the only other writer was this same page
             finishing its own hydrate. Each round re-reads the row first, so it is always
             a fresh version that is sent, and the loop is bounded so a genuinely
             contested row still fails rather than spinning. */
          for(var at = 0; at < 3 && !done2; at++){
            /* Re-read the row so the next attempt carries a fresh version - but do NOT
               adopt into `st` again. The one adoption above is what stops this device
               sending its older copy of fields the farmer did not touch; repeating it on
               every round writes server values back over whatever the farmer has typed
               SINCE the save started, and _profAdopt also refills the Settings inputs
               from them. A retry that takes a second or two would quietly undo the very
               correction the farmer had just made - which is exactly what a farmer does
               after a refused save. The retry does not need it: body2 is computed from
               s2.body against the ack, and never reads `st`. */
            if(at > 0){ try{ await load.profile(fid); }catch(e){} }
            var body2 = _profChanged(s2.body);
            if(!Object.keys(body2).length){ done2 = true; if(s2.done) s2.done(); break; }
            r2 = await _profWrite(fid, body2);
            if(r2.error){
              if(s2.fatal) throw r2.error;
              extraOk = false; firstErr = firstErr || r2.error;
              done2 = true;
            } else if(!r2.stale){
              done2 = true; if(s2.done) s2.done();
            }
          }
          if(!done2 && r2 && r2.stale){
            extraOk = false;
            firstErr = firstErr || Object.assign(new Error('These settings were changed on another device'), { code: 'stale' });
          }
        }
      }
      if(extraOk) _profSnap=snap;
      /* A refused statement is a failed save: the queue reports it and nothing is marked saved. */
      else if(firstErr) throw firstErr;
      return true;
    }
  };


  // ---- FILE STORAGE (private 'Attachments' bucket) -------------------------
  // Files are namespaced {farm_id}/{module}/{sub}/{uuid}_{name}. The leading
  // farm_id is what the Storage RLS policy checks via is_farm_member(), so file
  // access inherits the same tenant isolation as every table.
  const STORAGE_BUCKET = 'Attachments';
  function _dataUrlToBlob(dataUrl){
    var parts = String(dataUrl).split(',');
    var meta = parts[0] || '', b64 = parts[1] || '';
    var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function _blobToDataUrl(blob){
    return new Promise(function (resolve, reject) {
      try { var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = function () { reject(fr.error || new Error('read failed')); }; fr.readAsDataURL(blob); }
      catch (e) { reject(e); }
    });
  }
  const storage = {
    bucket: STORAGE_BUCKET,
    path: function (farmId, module, sub, filename) {
      var safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
      if (safe.length > 80) safe = safe.slice(safe.length - 80);
      var uid = null;
      try { uid = (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID() : null; } catch (e) { uid = null; }
      if (!uid) uid = Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
      var arr = [farmId, module];
      if (sub != null && sub !== '') arr.push(String(sub));
      return arr.join('/') + '/' + uid + '_' + safe;
    },
    async upload(path, fileOrDataUrl, contentType) {
      var body = fileOrDataUrl;
      if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.indexOf('data:') === 0) {
        body = _dataUrlToBlob(fileOrDataUrl);
        if (!contentType) contentType = body.type;
      }
      var opts = { upsert: true };
      if (contentType) opts.contentType = contentType;
      const { data, error } = await client().storage.from(STORAGE_BUCKET).upload(path, body, opts);
      if (error) throw error;
      return (data && data.path) || path;
    },
    async signedUrl(path, expiresIn) {
      const { data, error } = await client().storage.from(STORAGE_BUCKET).createSignedUrl(path, expiresIn || 3600);
      if (error) throw error;
      return data.signedUrl;
    },
    async download(path) {
      // Fetch a stored file as a base64 data URL, for embedding into self-contained
      // exports (compliance packs) that must work offline / when printed.
      const { data, error } = await client().storage.from(STORAGE_BUCKET).download(path);
      if (error) throw error;
      return await _blobToDataUrl(data);
    },
    async remove(paths) {
      var list = Array.isArray(paths) ? paths : [paths];
      list = list.filter(Boolean);
      if (!list.length) return true;
      const { error } = await client().storage.from(STORAGE_BUCKET).remove(list);
      if (error) throw error;
      return true;
    }
  };

  // ---- EXPORT --------------------------------------------------------------
  /* ---- PAIRING A PHONE ------------------------------------------------------
     Settings shows a QR code and eight characters; the phone reads either one and
     hands it back, and an edge function (mobile Phase 1) exchanges it for a
     session. The farmer never types a password into a phone in a shed, and the
     phone never holds credentials of its own.

     Only a HASH of the secret is stored. A leaked row is then not enough to pair
     with - the secret exists on the desktop's screen and nowhere else. The code
     is what the farmer can read aloud when a scratched lens in the sun defeats
     the camera, which is the failure WhatsApp's own linked-devices flow plans for.
     ------------------------------------------------------------------------- */
  const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1 - this gets read aloud
  function _hex(bytes){
    var out=''; for(var i=0;i<bytes.length;i++) out += ('0'+bytes[i].toString(16)).slice(-2);
    return out;
  }
  const pairing = {
    available(){ return !!(global.crypto && global.crypto.subtle && global.crypto.getRandomValues); },
    async create(kind){
      const fid = farm.active();
      if(!fid) throw new Error('No active farm');
      if(!pairing.available()){
        throw new Error('This browser cannot make a secure code. Open the app over https and try again.');
      }
      const rnd = new Uint8Array(24); global.crypto.getRandomValues(rnd);
      let code = ''; for(let i=0;i<8;i++) code += PAIR_ALPHABET[rnd[i] % PAIR_ALPHABET.length];
      const secret = _hex(rnd.subarray(8));
      const digest = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
      const hash = _hex(new Uint8Array(digest));
      let uid = null;
      try{ const u = await auth.currentUser(); uid = u && u.id; }catch(e){}
      if(!uid) throw new Error('Sign in again before adding a phone.');
      const r = await client().from('device_pair_tokens')
        .insert({ farm_id: fid, created_by: uid, code: code, token_hash: hash })
        .select().single();
      if(r.error) throw r.error;
      /* "Whose phone is this?" The code row is deleted the moment a phone uses it, so the
         answer is kept on its own row, which the phone finds through the same code. */
      let device = null;
      if(CAN_DEVICES){
        const d = await client().from('farm_devices')
          .insert({ farm_id: fid, pair_code: code, kind: kind === 'owner' ? 'owner' : 'staff', created_by: uid })
          .select().single();
        if(d.error) throw d.error;
        device = d.data || null;
      }
      return { code: code, secret: secret, farmId: fid, device: device,
               expiresAt: (r.data && r.data.expires_at) || null,
               id: (r.data && r.data.id) || null };
    },
    /* Cancelling a code the farmer decided not to use. Spending it is what makes
       it dead, so it is marked used rather than deleted - the row is the only
       record that a pairing was ever offered. */
    /* Phones added, newest first — only those a phone actually paired with. */
    async devices(){
      const fid = farm.active(); if(!fid || !CAN_DEVICES) return null;
      const r = await client().from('farm_devices').select('id,kind,pair_code,created_at').eq('farm_id', fid).order('created_at', { ascending: false });
      if(r.error) throw r.error;
      return r.data || [];
    },
    async setKind(id, kind){
      if(!id || !CAN_DEVICES) return false;
      const r = await client().from('farm_devices').update({ kind: kind === 'owner' ? 'owner' : 'staff' }).eq('id', id);
      if(r.error) throw r.error;
      return true;
    },
    async forget(id){
      if(!id || !CAN_DEVICES) return false;
      const r = await client().from('farm_devices').delete().eq('id', id);
      if(r.error) throw r.error;
      return true;
    },
    canAsk(){ return CAN_DEVICES; },
    /* Which phones are still being reminded, and when each last heard from us
       (reminders_migration.sql). The daily job retires a token Expo reports as
       dead, so a phone that has stopped can be SHOWN as stopped here rather than
       the farmer wondering why their deadlines went quiet. Keyed by device_id,
       which is the same row this list is built from. */
    async reminders(){
      const fid = farm.active(); if(!fid || !CAN_REMINDERS) return null;
      const r = await client().from('push_devices')
        .select('device_id,last_ok_at,retired_at,enabled,platform,lang')
        .eq('farm_id', fid);
      if(r.error) throw r.error;
      const by = {};
      for(const row of (r.data || [])) if(row.device_id) by[String(row.device_id)] = row;
      return by;
    },
    canRemind(){ return CAN_REMINDERS; },
    /* Whether a code was used: the edge function DELETES a code once a phone redeems it,
       so a row that is still here means no phone paired with it. */
    async tokenState(id){
      if(!id) return null;
      const r = await client().from('device_pair_tokens').select('id,used_at,device_label').eq('id', id).limit(1);
      if(r.error) throw r.error;
      return (r.data && r.data[0]) || null;
    },
    async revoke(id){
      if(!id) return;
      const r = await client().from('device_pair_tokens')
        .update({ used_at: new Date().toISOString(), device_label: 'cancelled' }).eq('id', id);
      if(r.error) throw r.error;
      return true;
    }
  };

  // ---- SAVE QUEUES -----------------------------------------------------------
  /* One save at a time per area, in the order the farmer made the changes.

     Saves used to run side by side. Each built its payload, sent several writes and only
     then recorded a snapshot of what it sent, so two saves in flight could land in the
     wrong order: the older one arrived last, the snapshot held the newer one, and every
     later save matched the snapshot and sent nothing. Seen live on 15 Sep 2026 (a business
     type switched back to sole stayed "partnership" on the server) and reproduced with
     delayed, reordered replies, together with a deleted loan written back by a save that
     was already on its way: removes ran outside any order. (06-tools/save-lane-harness.html)

     So each area has a queue. A save starts when the one before it has finished and reads
     the live state then. Removes join their area's queue. A save that fails is never
     marked saved: a dropped connection retries by itself, a refusal waits for the next app
     open or "Try again now".

     What has not reached the server is remembered on this device, per farm, so the next
     open sends it before loading the server's copy, and hydrate never loads over an area
     that still has something unsent. Until the first load of a session has finished,
     ordinary saves wait: a device pulls before it pushes. */
  var SYNC_KEY = 'ai_sync_unsent_';
  var SYNC_RETRY_MS = 20000;
  var _lanes = {}, _syncSubs = [], _syncIsOpen = false, _syncGateWaiters = [];
  var _syncLastOk = null, _syncCatching = false, _syncRaw = {}, _syncMods = {};
  function _syncNoop(){}
  function _syncEmit(){ _syncSubs.slice().forEach(function(f){ try{ f(); }catch(e){} }); }
  function _laneOf(area){
    return _lanes[area] || (_lanes[area] = { tail: Promise.resolve(), running: 0, waiting: 0, err: null, retryAt: 0, timer: null, lastSave: null, external: false });
  }
  function _unsentKey(){ var fid = farm.active(); return fid ? SYNC_KEY + fid : null; }
  function _unsentRead(){
    try{
      var k = _unsentKey(), o = k ? JSON.parse(localStorage.getItem(k) || 'null') : null;
      return { areas: (o && o.areas && typeof o.areas === 'object') ? o.areas : {}, ops: (o && Array.isArray(o.ops)) ? o.ops : [] };
    }catch(e){ return { areas: {}, ops: [] }; }
  }
  function _unsentWrite(u){
    try{
      var k = _unsentKey(); if(!k) return;
      if(!Object.keys(u.areas).length && !u.ops.length) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(u));
    }catch(e){}
  }
  /* A dropped connection is worth retrying on a timer; anything the database answered is
     not, until something changes. */
  function _syncKind(e){
    var code = (e && e.code != null) ? String(e.code) : '', msg = String((e && (e.message || e)) || '');
    if(global.navigator && global.navigator.onLine === false) return 'retry';
    if(/failed to fetch|networkerror|load failed|network request failed|timed? ?out|aborted/i.test(msg)) return 'retry';
    if(/^(57014|08\d\d\d|40001|40P01|53\d\d\d|PGRST00[0-3]|unavailable)$/.test(code)) return 'retry';
    if(e && (e.status === 0 || e.status === 429 || e.status >= 500)) return 'retry';
    return 'refused';
  }
  /* The column a refusal was about, so the farmer reads "Business type", not "Settings". */
  function _syncColumn(e){
    var msg = String((e && (e.message || e)) || ''), m;
    if((m = msg.match(/check constraint "[a-z0-9]+_([a-z0-9_]+)_chk"/))) return m[1];
    if((m = msg.match(/'([a-z0-9_]+)' column/))) return m[1];
    if((m = msg.match(/column [a-z0-9_]+\.([a-z0-9_]+) does not exist/))) return m[1];
    if((m = msg.match(/column "([a-z0-9_]+)"/))) return m[1];
    return null;
  }
  function _syncGate(){ return _syncIsOpen ? Promise.resolve() : new Promise(function(r){ _syncGateWaiters.push(r); }); }
  function _syncClear(L){ if(L.timer) clearTimeout(L.timer); L.timer = null; L.retryAt = 0; L.err = null; }
  function _queue(area, run, o){
    o = o || {};
    var L = _laneOf(area), hasFarm = !!farm.active();
    var gated = o.gate !== false && !_syncIsOpen && hasFarm;
    var opId = o.opId || null;
    if(hasFarm){
      var u = _unsentRead();
      if(o.op && !opId){
        opId = 'op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        u.ops.push({ id: opId, area: area, mod: o.op.mod, method: o.op.method, args: o.op.args, tries: 0 });
        _unsentWrite(u);
      } else if(!o.op && !u.areas[area]){ u.areas[area] = true; _unsentWrite(u); }
    }
    if(!o.op) L.lastSave = run;
    if(gated) L.waiting++; else L.running++;
    _syncEmit();
    var job = (gated ? _syncGate() : Promise.resolve()).then(function(){
      if(gated){ L.waiting--; L.running++; }
      var r = L.tail.then(function(){ return run(); });
      L.tail = r.then(_syncNoop, _syncNoop);
      return r;
    });
    return job.then(function(v){
      L.running--;
      if(v === false) _syncFailed(area, L, { message: 'not saved' }, opId, 'refused');
      else _syncDone(area, L, opId);
      return v;
    }, function(e){
      L.running--;
      _syncFailed(area, L, e, opId);
      throw e;
    });
  }
  function _syncDone(area, L, opId){
    _syncLastOk = Date.now();
    if(farm.active()){
      var u = _unsentRead();
      if(opId) u.ops = u.ops.filter(function(x){ return x.id !== opId; });
      else if(L.running === 0 && L.waiting === 0) delete u.areas[area];
      _unsentWrite(u);
      var opsLeft = u.ops.some(function(x){ return x.area === area; });
      if(L.err && !L.external && (opId ? (L.err.op === 'remove' && !opsLeft) : L.err.op === 'save')) _syncClear(L);
    }
    _syncEmit();
  }
  function _syncFailed(area, L, e, opId, kind){
    kind = kind || _syncKind(e);
    _syncClear(L);
    L.err = { kind: kind, code: (e && e.code) || null, column: _syncColumn(e), op: opId ? 'remove' : 'save' };
    if(kind === 'retry'){ L.retryAt = Date.now() + SYNC_RETRY_MS; L.timer = setTimeout(function(){ _syncRetry(area); }, SYNC_RETRY_MS); }
    try{ console.warn('Not saved online (' + area + ', ' + kind + '):', (e && (e.message || e)) || e); }catch(_){}
    _syncEmit();
  }
  function _syncRawCall(key, mod, args){ var fn = _syncRaw[key]; return fn ? fn.apply(mod, args) : true; }
  /* How to send an area from the live state - used by the next open and by retries, so a
     retry never replays an old argument (the filing rules are passed as a fresh list). */
  function _syncBoth(a, b){ return Promise.resolve(a()).then(function(x){ return Promise.resolve(b()).then(function(y){ return (x === false || y === false) ? false : true; }); }); }
  var _CATCHUP = {
    settings:  function(){ return global.ST ? _syncRawCall('profile.save', profile, [global.ST]) : true; },
    loans:     function(){ return global.ST_LOANS ? _syncRawCall('loans.saveAll', loans, [global.ST_LOANS]) : true; },
    livestock: function(){ return global.ST_LS ? _syncRawCall('livestock.saveAll', livestock, [global.ST_LS]) : true; },
    crops:     function(){ return global.ST_CROP ? _syncBoth(function(){ return _syncRawCall('crop.saveAll', crop, [global.ST_CROP]); }, function(){ return _syncRawCall('crop.saveConfig', crop, [global.ST_CROP]); }) : true; },
    orchard:   function(){ return global.ST_FRUIT ? _syncBoth(function(){ return _syncRawCall('orchard.saveAll', orchard, [global.ST_FRUIT]); }, function(){ return _syncRawCall('orchard.saveConfig', orchard, [global.ST_FRUIT]); }) : true; },
    plan:      function(){ return global.ST_PLAN ? _syncRawCall('plan.saveAll', plan, [global.ST_PLAN]) : true; },
    workers:   function(){ return global.ST_WORK ? _syncRawCall('workers.saveAll', workersSave, [global.ST_WORK]) : true; },
    fuel:      function(){ return (global.ST_FUEL && global.ST_FUEL.issues) ? _syncRawCall('fuel.saveAll', fuel, [global.ST_FUEL.issues]) : true; },
    rain:      function(){ return global.ST_RAIN ? _syncRawCall('rain.saveAll', rain, [global.ST_RAIN]) : true; },
    documents: function(){ return (global.ST && global.ST.docs) ? _syncRawCall('documents.saveAll', documents, [global.ST.docs]) : true; },
    budget:    function(){ return (global.ST && global.ST.budgets) ? _syncRawCall('budget.save', budget, [global.ST.budgets]) : true; },
    rules:     function(){ var list = (typeof global.catRules === 'function') ? global.catRules() : (global.ST && global.ST.catRules); return list ? _syncRawCall('rules.saveAll', rules, [list]) : true; }
  };
  /* Is this area's data actually on the device right now? */
  var _CATCHUP_HAS = {
    settings:  function(){ return !!global.ST; },
    loans:     function(){ return !!global.ST_LOANS; },
    livestock: function(){ return !!global.ST_LS; },
    crops:     function(){ return !!global.ST_CROP; },
    orchard:   function(){ return !!global.ST_FRUIT; },
    plan:      function(){ return !!global.ST_PLAN; },
    workers:   function(){ return !!global.ST_WORK; },
    fuel:      function(){ return !!(global.ST_FUEL && global.ST_FUEL.issues); },
    rain:      function(){ return !!global.ST_RAIN; },
    documents: function(){ return !!(global.ST && global.ST.docs); },
    budget:    function(){ return !!(global.ST && global.ST.budgets); },
    rules:     function(){ return !!(typeof global.catRules === 'function' || (global.ST && global.ST.catRules)); }
  };
  /* The app loads its own copy from this device (loadState) on the window 'load' event, while
     sign-in starts on DOMContentLoaded - so the catch-up below could run FIRST, with the state
     objects still empty. It then had nothing to send, cleared the unsent marks anyway, and the
     load that followed replaced the device's copy with the server's: a change left unsent when
     the app was closed was lost. Seen on the live account 16 Sep 2026 (an overdraft written to
     this device, marked unsent by hand, never reached the server and vanished on reload; the
     only requests at start-up were reads).

     So the app says when its own data is in place, and nothing is pushed or cleared before that. */
  var _localReady = false, _localWaiters = [];
  function _whenLocalReady(ms){
    if(_localReady) return Promise.resolve(true);
    return new Promise(function(res){
      var done = false;
      var t = setTimeout(function(){ if(!done){ done = true; res(false); } }, ms || 8000);
      _localWaiters.push(function(){ if(!done){ done = true; clearTimeout(t); res(true); } });
    });
  }
  function _replayOp(x){
    var fn = _syncRaw[x.mod + '.' + x.method], mod = _syncMods[x.mod];
    if(!fn || !mod) return Promise.resolve();
    return _queue(x.area, function(){ return fn.apply(mod, x.args || []); }, { gate: false, op: true, opId: x.id });
  }
  function _syncRetry(area){
    var L = _laneOf(area); if(L.external) return Promise.resolve();
    _syncClear(L);
    var u = _unsentRead(), jobs = [];
    u.ops.filter(function(x){ return x.area === area; }).forEach(function(x){ jobs.push(_replayOp(x).catch(_syncNoop)); });
    var run = _CATCHUP[area] || L.lastSave;
    if(u.areas[area] && run) jobs.push(_queue(area, run, { gate: false }).catch(_syncNoop));
    _syncEmit();
    return Promise.all(jobs);
  }
  function _syncWrap(area, modName, mod, method, isOp){
    var orig = mod && mod[method]; if(typeof orig !== 'function') return;
    _syncRaw[modName + '.' + method] = orig; _syncMods[modName] = mod;
    mod[method] = function(){
      var args = Array.prototype.slice.call(arguments);
      return _queue(area, function(){ return orig.apply(mod, args); }, isOp ? { op: { mod: modName, method: method, args: args } } : null);
    };
  }
  _syncWrap('settings',  'profile',   profile,     'save');
  _syncWrap('loans',     'loans',     loans,       'saveAll');
  _syncWrap('loans',     'loans',     loans,       'remove', true);
  _syncWrap('livestock', 'livestock', livestock,   'saveAll');
  _syncWrap('livestock', 'livestock', livestock,   'removeAnimal', true);
  _syncWrap('livestock', 'livestock', livestock,   'removeHerd', true);
  _syncWrap('livestock', 'livestock', livestock,   'removeCamp', true);
  _syncWrap('crops',     'crop',      crop,        'saveAll');
  _syncWrap('crops',     'crop',      crop,        'saveConfig');
  _syncWrap('orchard',   'orchard',   orchard,     'saveAll');
  _syncWrap('orchard',   'orchard',   orchard,     'saveConfig');
  _syncWrap('plan',      'plan',      plan,        'saveAll');
  _syncWrap('workers',   'workers',   workersSave, 'saveAll');
  _syncWrap('workers',   'workers',   workersSave, 'removeWorker', true);
  _syncWrap('workers',   'workers',   workersSave, 'removePayRun', true);
  _syncWrap('fuel',      'fuel',      fuel,        'saveAll');
  _syncWrap('rain',      'rain',      rain,        'saveAll');
  _syncWrap('rain',      'rain',      rain,        'remove', true);
  _syncWrap('documents', 'documents', documents,   'saveAll');
  _syncWrap('rules',     'rules',     rules,       'saveAll');
  /* -411: the six writers that saved outside the queues. A failure used to print one
     console line under a green status and the next load wiped the row. Assets, recurring
     bills, co-op settlements and import batches go in as operations - replayed with the
     arguments they were called with, and every one of them is now keyed so a replay can
     only ever leave one row. Budgets save the whole object, like the other saveAll lanes.
     Health records join the livestock lane, whose load is already guarded. */
  _syncWrap('budget',    'budget',    budget,      'save');
  _syncWrap('assets',    'asset',     asset,       'add',    true);
  _syncWrap('assets',    'asset',     asset,       'update', true);
  _syncWrap('assets',    'asset',     asset,       'remove', true);
  _syncWrap('recurring', 'recurring', recurring,   'add',    true);
  _syncWrap('recurring', 'recurring', recurring,   'update', true);
  _syncWrap('recurring', 'recurring', recurring,   'remove', true);
  _syncWrap('coop',      'coopSettlement', coopSettlement, 'addMany',       true);
  _syncWrap('coop',      'coopSettlement', coopSettlement, 'removeByBatch', true);
  _syncWrap('imports',   'importBatch', importBatch, 'create', true);
  _syncWrap('imports',   'importBatch', importBatch, 'remove', true);
  _syncWrap('livestock', 'livestock',  livestock,   'addHealth', true);

  /* ---- LIVE: another device's change reaches this screen without a reload ----------
     Supabase Realtime (live_updates_migration.sql puts these tables in the publication).
     Row-level security applies to what a browser hears, so it only ever hears its own farm.
     Deletes are NOT delivered here - Realtime cannot filter a delete by farm - so the
     caller keeps a slow poll for those. Only tables another device writes are listened to:
     the phone's events, and payslip "sent" answers. (signed off 19 Sep 2026) */
  const LIVE_TABLES = ['transactions', 'livestock_moves', 'livestock_treatments', 'livestock_health',
    'rainfall_readings', 'rainfall_gauges', 'fuel_issues', 'crop_inputs', 'orchard_sprays',
    'orchard_harvest', 'crop_events', 'farm_documents', 'payslip_sends'];
  let _liveCh = null, _liveFarm = null, _liveState = 'off';
  const live = {
    tables: LIVE_TABLES,
    state(){ return _liveState; },
    farm(){ return _liveFarm; },
    start(fid, onEvent, onState){
      live.stop();
      if(!fid) return;
      _liveFarm = fid; _liveState = 'joining';
      let ch = client().channel('farm-live-' + fid);
      LIVE_TABLES.forEach(function(t){
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'farm_id=eq.' + fid },
          function(p){ try{ if(onEvent) onEvent(t, p || {}); }catch(e){} });
      });
      _liveCh = ch.subscribe(function(status){ _liveState = String(status || ''); try{ if(onState) onState(_liveState); }catch(e){} });
    },
    stop(){
      if(_liveCh){ try{ client().removeChannel(_liveCh); }catch(e){} }
      _liveCh = null; _liveFarm = null; _liveState = 'off';
    }
  };

  const sync = {
    status(){
      var saving = false, failing = [];
      Object.keys(_lanes).forEach(function(a){
        var L = _lanes[a];
        if(L.running > 0) saving = true;
        if(L.err) failing.push({ area: a, kind: L.err.kind, column: L.err.column, retryAt: L.retryAt || 0 });
      });
      return { open: _syncIsOpen, saving: saving, catchingUp: _syncCatching, failing: failing, lastConfirmed: _syncLastOk };
    },
    onChange(fn){ if(typeof fn === 'function') _syncSubs.push(fn); },
    isOpen(){ return _syncIsOpen; },
    /* The first load of the session has finished: saves that were waiting go now. */
    open(){
      if(!_syncIsOpen){ _syncIsOpen = true; if(!_syncLastOk) _syncLastOk = Date.now(); _syncGateWaiters.splice(0).forEach(function(r){ r(); }); }
      _syncEmit();
    },
    /* Resolves when nothing is on its way (saves still waiting for the first load are not
       counted - they cannot start until that load, so waiting for them would never end). */
    idle(maxMs){
      return new Promise(function(res){
        var until = Date.now() + (maxMs || 15000);
        (function check(){
          var busy = Object.keys(_lanes).some(function(a){ return _lanes[a].running > 0; });
          if(!busy || Date.now() > until) res(); else setTimeout(check, 40);
        })();
      });
    },
    isUnsent(area){ var u = _unsentRead(); return !!u.areas[area] || u.ops.some(function(x){ return x.area === area; }); },
    /* Send what an earlier session never got to send. Runs before hydrate loads anything. */
    /* The app has loaded its own copy from this device: saves may go now. */
    localReady(){ _localReady = true; _localWaiters.splice(0).forEach(function(f){ try{ f(); }catch(e){} }); _syncEmit(); },
    isLocalReady(){ return _localReady; },
    whenLocalReady(ms){ return _whenLocalReady(ms); },
    async catchUp(){
      if(!farm.active()) return;
      /* Never before this device's own data is in place: sending nothing and clearing the marks
         would drop the very changes this is here to protect. */
      if(!(await _whenLocalReady(8000))){
        try{ console.warn('Unsent changes are still waiting: the app had not loaded its own data yet.'); }catch(e){}
        return;
      }
      var u = _unsentRead();
      if(!u.ops.length && !Object.keys(u.areas).length) return;
      _syncCatching = true; _syncEmit();
      u.ops.forEach(function(x){ x.tries = (x.tries || 0) + 1; });
      u.ops = u.ops.filter(function(x){
        if(x.tries > 5){ try{ console.warn('Gave up on an unsent change after 5 app opens:', x.mod + '.' + x.method, x.args); }catch(_){} return false; }
        return true;
      });
      _unsentWrite(u);
      var jobs = u.ops.map(function(x){ return _replayOp(x).catch(_syncNoop); });
      Object.keys(u.areas).forEach(function(a){
        /* An area whose data is not on this device cannot be sent - and must not be marked as
           sent either, or the next load would write over it. */
        if(_CATCHUP[a] && _CATCHUP_HAS[a] && _CATCHUP_HAS[a]()) jobs.push(_queue(a, _CATCHUP[a], { gate: false }).catch(_syncNoop));
      });
      return Promise.all(jobs).then(function(){ _syncCatching = false; _syncEmit(); });
    },
    /* The device holds another account's or another farm's records: never send them. */
    discardUnsent(){ try{ var k = _unsentKey(); if(k) localStorage.removeItem(k); }catch(e){} try{ _profAckClear(); }catch(e){} },
    retryAll(){
      var jobs = [];
      Object.keys(_lanes).forEach(function(a){ if(_lanes[a].err && !_lanes[a].external) jobs.push(_syncRetry(a)); });
      return Promise.all(jobs);
    },
    /* Rows the server kept instead of the copy this device sent, newest last (-415). */
    kept(){ return _srvKept.slice(); },
    /* For writes the app sends itself (the transaction outbox, attachments). */
    report(area, e){
      var L = _laneOf(area); L.external = true;
      if(e) L.err = { kind: _syncKind(e), code: (e && e.code) || null, column: null, op: 'save' };
      else { L.err = null; _syncLastOk = Date.now(); }
      _syncEmit();
    }
  };
  try{ global.addEventListener('online', function(){ sync.retryAll(); }); }catch(e){}

  global.AI = { init: client, projectRef: PROJECT_REF, auth, farm, sync: sync, load, txn, account, budget, recurring, asset, loans,
                coopSettlement: coopSettlement, livestock: livestock, crop: crop, orchard: orchard, plan: plan, workers: workersSave, profile: profile,
                documents: documents, fuel: fuel, rain: rain,
                storage: storage,
                importBatch: importBatch,
                rules, looks: looks,
                pairing: pairing, live: live,
                _map: { catToId, catToCode, appToDb, dbToApp },
                /* Test hooks. 06-tools/schema-probe-harness.html drives the capability
                   probe directly - what it asserts (a dropped packet must not un-learn a
                   column) cannot be reached through a public method, because the whole
                   point is what happens on the SECOND load. Nothing in the app calls
                   these. */
                __probeCaps: probeCaps, __client: client };

})(window);
