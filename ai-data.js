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
 *      a private Storage bucket named 'attachments'.
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
  const SUPABASE_ANON_KEY = 'sb_publishable_-nl0FU9CplFIPpJ_UBXEJg_awromv5n'; // publishable (public) key
  // Magic-link return: derived from wherever the app is served (live OR test),
  // so the same file works on both without editing.
  const APP_URL = window.location.origin +
                  window.location.pathname.replace(/[^/]*$/, '');

  const ACTIVE_FARM_KEY = 'ai_active_farm';

  let sb = null;
  let catMaps = { code2id: {}, id2code: {}, list: [] };

  function client() {
    if (sb) return sb;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error('supabase-js not loaded — add the CDN <script> before ai-data.js');
    }
    sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
    async signOut() { await client().auth.signOut(); },
    async currentUser() {
      const { data } = await client().auth.getUser();
      return data ? data.user : null;
    },
    onAuth(cb) {
      client().auth.onAuthStateChange((_evt, session) => cb(session ? session.user : null));
    }
  };

  // ---- 3. FARM CONTEXT -----------------------------------------------------
  const farm = {
    async mine() {
      // farms the signed-in user belongs to (RLS limits this automatically)
      const { data, error } = await client()
        .from('farms').select('id,name,owner_name,province,farm_ha,farm_type,fy_start_month,lang')
        .order('created_at', { ascending: true });
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
    setActive(id) { try { localStorage.setItem(ACTIVE_FARM_KEY, id); } catch (e) {} },
    active() { try { return localStorage.getItem(ACTIVE_FARM_KEY); } catch (e) { return null; } }
  };

  // ---- 4. CATEGORY CACHE + MAPPING -----------------------------------------
  function norm(s){ return (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]/g,''); }
  function toISO(d){
    if(!d) return null;
    var s = String(d);
    if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    var dt = new Date(s); return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0,10);
  }
  async function loadCats(farmId) {
    // system rows (farm_id null) + this farm's custom rows; RLS handles visibility
    const { data, error } = await client()
      .from('categories').select('id,kind,code,label,is_system,sort,active')
      .or(`farm_id.is.null,farm_id.eq.${farmId}`)
      .eq('active', true).order('sort', { ascending: true });
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
  async function ensureCats() { if (!catMaps.list.length) await loadCats(farm.active()); }

  // ---- 5. SHAPE MAPPING (app txn <-> db row) -------------------------------
  function appToDb(t, farmId) {
    return {
      farm_id:        farmId,
      account_id:     t.accountId || null,
      category_id:    catToId(t.cat),
      txn_date:       toISO(t.date) || new Date().toISOString().slice(0,10),
      type:           t.type,                       // 'income' | 'expense'
      amount:         Number(t.amt),
      description:    t.desc || null,
      payment_method: t.method || null,             // 'Cash' | 'Card' | 'EFT'
      reference:      t.ref || null,
      note:           t.note || null,
      quantity:       (t.qty != null && t.qty !== '') ? Number(t.qty) : null,
      unit:           t.unit || null,
      enterprise:     t.ent || null,
      source:         t.source || null
    };
  }
  function dbToApp(r) {
    return {
      id:       r.id,
      date:     r.txn_date,
      amt:      Number(r.amount),
      cat:      catToCode(r.category_id),
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
      source:   r.source || undefined
    };
  }

  // ---- 6. LOAD FINANCE CORE ------------------------------------------------
  const load = {
    async financeCore(farmId) {
      if (!farmId) throw new Error('No active farm');
      await loadCats(farmId);

      const [acc, txn, bud, rec, fst] = await Promise.all([
        client().from('accounts').select('*').eq('farm_id', farmId).order('name'),
        client().from('transactions').select('*').eq('farm_id', farmId).order('txn_date', { ascending: false }),
        client().from('budget_months').select('*').eq('farm_id', farmId),
        client().from('recurring').select('*').eq('farm_id', farmId).order('name'),
        client().from('farms').select('budget_income_pattern,budget_expense_pattern,budget_current_month').eq('id', farmId).single()
      ]);
      for (const r of [acc, txn, bud, rec]) if (r.error) throw r.error;

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
        txns:       (txn.data || []).map(dbToApp),
        budgets:    bObj,
        recurring:  (rec.data || []).map(r => ({
          id: r.id, name: r.name, type: r.type, amt: Number(r.amount),
          freq: r.frequency, category: catToCode(r.category_id),
          months: r.months || undefined,
          accountId: r.account_id, nextDate: r.next_date, active: r.active
        }))
      };
    },
    async assets(farmId) {
      farmId = farmId || farm.active();
      const { data, error } = await client().from('assets').select('*').eq('farm_id', farmId).order('created_at');
      if (error) throw error;
      return (data || []).map(assetToApp);
    },
    async loans(farmId) {
      farmId = farmId || farm.active();
      const [l, o, c] = await Promise.all([
        client().from('loans').select('*').eq('farm_id', farmId).order('created_at'),
        client().from('overdrafts').select('*').eq('farm_id', farmId).order('created_at'),
        client().from('coop_accounts').select('*').eq('farm_id', farmId).order('created_at')
      ]);
      for (const r of [l, o, c]) if (r.error) throw r.error;
      const out = { loans: [], overdrafts: [], coopAccounts: [], archived: [] };
      (l.data || []).forEach(function (r) { var m = loanFromDb(r); if (r.archived) { m._kind = 'loan'; m.archived = true; out.archived.push(m); } else out.loans.push(m); });
      (o.data || []).forEach(function (r) { var m = odFromDb(r); if (r.archived) { m._kind = 'overdraft'; m.archived = true; out.archived.push(m); } else out.overdrafts.push(m); });
      (c.data || []).forEach(function (r) { var m = coopFromDb(r); if (r.archived) { m._kind = 'coop'; m.archived = true; out.archived.push(m); } else out.coopAccounts.push(m); });
      return out;
    }
  };

  // ---- 7. WRITE: TRANSACTIONS ----------------------------------------------
  const txn = {
    async add(t) {
      const farmId = farm.active();
      await ensureCats();
      const { data, error } = await client()
        .from('transactions').insert(appToDb(t, farmId)).select().single();
      if (error) throw error;
      return dbToApp(data);
    },
    async addMany(list) {                       // bulk insert (imports) — one round-trip
      if (!list || !list.length) return [];
      const farmId = farm.active();
      await ensureCats();
      const rows = list.map(function (t) { return appToDb(t, farmId); });
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
      var r2 = await client().from('farms').update({
        budget_income_pattern: b.incomePattern || null,
        budget_expense_pattern: b.expensePattern || null,
        budget_current_month: b.currentMonth || null
      }).eq('id', fid);
      if (r2.error) throw r2.error;
      return true;
    }
  };
  const recurring = {
    async add(r) {
      await ensureCats();
      const { data, error } = await client().from('recurring').insert({
        farm_id: farm.active(), name: r.name, type: r.type, amount: Number(r.amt),
        frequency: r.freq, category_id: catToId(r.category || r.cat),
        account_id: r.accountId || null, next_date: r.nextDate || null,
        months: r.months || null
      }).select().single();
      if (error) throw error;
      return data;
    },
    async update(id, r) {
      await ensureCats();
      const { data, error } = await client().from('recurring').update({
        name: r.name, type: r.type, amount: Number(r.amt),
        frequency: r.freq, category_id: catToId(r.category || r.cat),
        account_id: r.accountId || null, next_date: r.nextDate || null,
        months: r.months || null
      }).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },
    async remove(id) {
      const { error } = await client().from('recurring').delete().eq('id', id);
      if (error) throw error;
      return true;
    }
  };

  // ---- ASSETS --------------------------------------------------------------
  function assetToDb(a) {
    return {
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
      docs: a.docs || null
    };
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
    return a;
  }
  const asset = {
    async add(a) {
      const { data, error } = await client().from('assets')
        .insert(Object.assign({ farm_id: farm.active() }, assetToDb(a))).select().single();
      if (error) throw error;
      return data;
    },
    async update(id, a) {
      if (!id) return;
      const { error } = await client().from('assets').update(assetToDb(a)).eq('id', id);
      if (error) throw error;
      return true;
    },
    async remove(id) {
      if (!id) return;
      const { error } = await client().from('assets').delete().eq('id', id);
      if (error) throw error;
      return true;
    }
  };

  // ---- LOANS & DEBT --------------------------------------------------------
  // Loans/overdrafts/co-op accounts use their own stable string ids ('comb',
  // 'ln3', 'od1', 'oc1') so we key DB rows on that and sync the whole set.
  function loanToDb(l) {
    return { local_id: l.id, icon: l.icon || null, name: l.name || null, lender: l.lender || null,
      type: l.type || null, borrowed: Number(l.borrowed) || 0, balance: Number(l.balance) || 0,
      rate: Number(l.rate) || 0, payment: Number(l.payment) || 0, next_label: l.next || null,
      funds_for: l.fundsFor || null, archived: !!l.archived };
  }
  function loanFromDb(r) {
    return { id: r.local_id, icon: r.icon || '\uD83C\uDFE6', name: r.name || '', lender: r.lender || '',
      type: r.type || 'Loan', assetId: null, borrowed: Number(r.borrowed) || 0, balance: Number(r.balance) || 0,
      rate: Number(r.rate) || 0, payment: Number(r.payment) || 0, next: r.next_label || 'next month',
      fundsFor: r.funds_for || undefined };
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
      const snap = JSON.stringify({ l: st.loans, o: st.overdrafts, c: st.coopAccounts, a: st.archived });
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
      const lRows = lList.map(function (l) { return Object.assign({ farm_id: fid }, loanToDb(l)); });
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
    const { data, error } = await client()
      .from('coop_settlements').select('*').eq('farm_id', farmId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(csFromDb);
  };
  const coopSettlement = {
    async addMany(list){
      if(!list || !list.length) return [];
      const farmId = farm.active();
      const rows = list.map(function(s){ return csToDb(s, farmId); });
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
    months:(h.months!=null&&h.months!=='')?parseInt(h.months,10):null, notes:h.notes||null }; }
  function herdFromDb(r){ var h={ id:_numIf(r.local_id), type:r.type||'', name:r.name||'', qty:Number(r.qty)||0,
    buy:Number(r.buy)||0, feed:Number(r.feed)||0, vet:Number(r.vet)||0, sell:Number(r.sell)||0,
    months:(r.months!=null)?Number(r.months):0, notes:r.notes||'', camp:r.camp||'', campId:r.camp_id||'', track:!!r.track };
    if(r.planned) h.planned=true; if(r.breed) h.breed=r.breed; return h; }
  function classRows(h,fid){ return (h.classes||[]).map(function(c){ return { farm_id:fid, herd_local_id:String(h.id), class_key:c.k, count:(c.n!=null)?parseInt(c.n,10):0, class_value:(c.v!=null)?Number(c.v):0 }; }); }
  // 3a-ii — moves / treatments / animals (set-sync, append-only) + health (per-row)
  function moveToDb(m,fid){ return { farm_id:fid, local_id:String(m.id), herd_local_id:(m.herd!=null)?String(m.herd):null, reason:m.reason||null, qty:(m.qty!=null)?parseInt(m.qty,10):null, move_date:m.date||null, note:m.note||null, money:(m.money!=null)?Number(m.money):null, cls:m.cls||null, to_cls:m.toCls||null }; }
  function moveFromDb(r){ var m={ id:r.local_id, herd:_numIf(r.herd_local_id), reason:r.reason||'', qty:Number(r.qty)||0, date:r.move_date||'', note:r.note||'', money:Number(r.money)||0 }; if(r.cls) m.cls=r.cls; if(r.to_cls) m.toCls=r.to_cls; return m; }
  function treatToDb(t,fid){ return { farm_id:fid, local_id:String(t.id), herd_local_id:(t.herd!=null)?String(t.herd):null, kind:t.kind||null, product:t.product||null, reg:t.reg||null, act:t.act||null, abx:(t.abx!=null)?!!t.abx:null, target:t.target||null, head:(t.head!=null)?parseInt(t.head,10):null, tags:t.tags||[], dose:t.dose||null, route:t.route||null, reason:t.reason||null, batch:t.batch||null, expiry:t.expiry||null, rx:t.rx||null, treat_date:t.date||null, by_who:t.by||null, cost:(t.cost!=null)?Number(t.cost):null, meat:(t.meat!=null)?parseInt(t.meat,10):null, milk:(t.milk!=null)?parseInt(t.milk,10):null }; }
  function treatFromDb(r){ var t={ id:r.local_id, herd:_numIf(r.herd_local_id), kind:r.kind||'', product:r.product||'', reg:r.reg||'', act:r.act||'', target:r.target||'', head:Number(r.head)||0, tags:r.tags||[], dose:r.dose||'', route:r.route||'', reason:r.reason||'', batch:r.batch||'', expiry:r.expiry||'', date:r.treat_date||'', by:r.by_who||'', cost:Number(r.cost)||0, meat:Number(r.meat)||0, milk:Number(r.milk)||0 }; if(r.abx) t.abx=true; if(r.rx) t.rx=r.rx; return t; }
  function animalToDb(a,fid){ return { farm_id:fid, local_id:String(a.id), herd_local_id:(a.herd!=null)?String(a.herd):null, tag:a.tag||null, name:a.name||null, sex:a.sex||null, breed:a.breed||null, cls:a.cls||null }; }
  function animalFromDb(r){ var a={ id:r.local_id, herd:_numIf(r.herd_local_id), tag:r.tag||'', sex:r.sex||'' }; if(r.name) a.name=r.name; if(r.breed) a.breed=r.breed; if(r.cls) a.cls=r.cls; return a; }
  function healthToDb(h,fid){ return { farm_id:fid, local_id:h.id?String(h.id):null, health_date:h.date||null, type:h.type||null, event:h.event||null, count:(h.count!=null)?parseInt(h.count,10):null, descr:h.desc||null, cost:(h.cost!=null)?Number(h.cost):null, supplier:h.supplier||null }; }
  function healthFromDb(r){ return { date:r.health_date||'', type:r.type||'', event:r.event||'', count:Number(r.count)||0, desc:r.descr||'', cost:Number(r.cost)||0, supplier:r.supplier||'' }; }

  load.livestock = async function(farmId){
    farmId = farmId || farm.active();
    const [cp,hd,hc,bm,mv,tr,an,he] = await Promise.all([
      client().from('livestock_camps').select('*').eq('farm_id',farmId).order('created_at'),
      client().from('herds').select('*').eq('farm_id',farmId).order('created_at'),
      client().from('herd_classes').select('*').eq('farm_id',farmId),
      client().from('livestock_benchmarks').select('*').eq('farm_id',farmId),
      client().from('livestock_moves').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('livestock_treatments').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('animals').select('*').eq('farm_id',farmId).order('created_at'),
      client().from('livestock_health').select('*').eq('farm_id',farmId).order('created_at',{ascending:false})
    ]);
    for(const r of [cp,hd,hc,bm,mv,tr,an,he]) if(r.error) throw r.error;
    var byHerd={};
    (hc.data||[]).forEach(function(r){ (byHerd[r.herd_local_id]=byHerd[r.herd_local_id]||[]).push({k:r.class_key,n:Number(r.count)||0,v:Number(r.class_value)||0}); });
    var herds=(hd.data||[]).map(function(r){ var h=herdFromDb(r); var cs=byHerd[r.local_id]; if(cs&&cs.length) h.classes=cs; return h; });
    var benchmarks={}; (bm.data||[]).forEach(function(r){ benchmarks[r.bench_key]=Number(r.bench_value); });
    return { camps:(cp.data||[]).map(campFromDb), herds:herds, benchmarks:benchmarks,
             moves:(mv.data||[]).map(moveFromDb), treatments:(tr.data||[]).map(treatFromDb),
             animals:(an.data||[]).map(animalFromDb), health:(he.data||[]).map(healthFromDb) };
  };

  var _lsSnap=null;
  const livestock = {
    async saveAll(stls){
      if(!stls) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({c:stls.camps,h:stls.herd,b:stls.benchmarks,m:stls.moves,t:stls.treatments,a:stls.animals});
      if(snap===_lsSnap) return;
      const camps=(stls.camps||[]), herds=(stls.herd||[]), bench=(stls.benchmarks||{});
      const moves=(stls.moves||[]), treats=(stls.treatments||[]), animals=(stls.animals||[]);
      if(camps.length){ const e=(await client().from('livestock_camps').upsert(camps.map(function(c){return campToDb(c,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(herds.length){ const e=(await client().from('herds').upsert(herds.map(function(h){return herdToDb(h,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      var allClasses=[]; herds.forEach(function(h){ allClasses=allClasses.concat(classRows(h,fid)); });
      if(allClasses.length){ const e=(await client().from('herd_classes').upsert(allClasses,{onConflict:'farm_id,herd_local_id,class_key'})).error; if(e) throw e; }
      for(const h of herds){ var keys=(h.classes||[]).map(function(c){return c.k;});
        var q=client().from('herd_classes').delete().eq('farm_id',fid).eq('herd_local_id',String(h.id));
        if(keys.length) q=q.not('class_key','in',_inList(keys));
        const e=(await q).error; if(e) throw e; }
      var bkeys=Object.keys(bench);
      if(bkeys.length){ const e=(await client().from('livestock_benchmarks').upsert(bkeys.map(function(k){return {farm_id:fid,bench_key:k,bench_value:Number(bench[k])};}),{onConflict:'farm_id,bench_key'})).error; if(e) throw e; }
      var bq=client().from('livestock_benchmarks').delete().eq('farm_id',fid);
      if(bkeys.length) bq=bq.not('bench_key','in',_inList(bkeys));
      { const e=(await bq).error; if(e) throw e; }
      // append-only logs: upsert by local_id, no prune (no delete UI except animals→removeAnimal)
      if(moves.length){ const e=(await client().from('livestock_moves').upsert(moves.map(function(m){return moveToDb(m,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(treats.length){ const e=(await client().from('livestock_treatments').upsert(treats.map(function(t){return treatToDb(t,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(animals.length){ const e=(await client().from('animals').upsert(animals.map(function(a){return animalToDb(a,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      _lsSnap=snap;
      return true;
    },
    async addHealth(h){ const fid=farm.active(); if(!fid||!h) return; const e=(await client().from('livestock_health').insert(healthToDb(h,fid))).error; if(e) throw e; return true; },
    async removeAnimal(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('animals').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; },
    async removeHerd(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('herds').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; },
    async removeCamp(localId){ const fid=farm.active(); if(!fid||localId==null) return; const e=(await client().from('livestock_camps').delete().eq('farm_id',fid).eq('local_id',String(localId))).error; if(e) throw e; _lsSnap=null; return true; }
  };

  // ---- CROPS (lands, events, inputs) — 3b-i --------------------------------
  // ST_CROP is source of truth; DB mirrors it. Land ids stay as local_id text
  // so 'crop:<type>' tags + crop profit (keyed off land.crop/yields) keep working.
  // Lands edit-in-place (upsert); events/inputs append-only (upsert, no prune —
  // no delete UI). Config (prices/compliance/season) is 3b-ii.
  function landToDb(l,fid){ return { farm_id:fid, local_id:String(l.id), name:l.name||null, area:(l.area!=null&&l.area!=='')?Number(l.area):null, crop:l.crop||null, cultivar:l.cultivar||null, gmo:!!l.gmo, irrigated:!!l.irrigated, planted:l.planted||null, harvest:l.harvest||null, stage:l.stage||null, target_yield:(l.targetYield!=null&&l.targetYield!=='')?Number(l.targetYield):null, actual_yield:(l.actualYield!=null&&l.actualYield!=='')?Number(l.actualYield):null, input_per_ha:(l.inputPerHa!=null&&l.inputPerHa!=='')?Number(l.inputPerHa):null, prev_crop:l.prevCrop||null, price:(l.price!=null&&l.price!=='')?Number(l.price):null }; }
  function landFromDb(r){ var l={ id:_numIf(r.local_id), name:r.name||'', area:Number(r.area)||0, crop:r.crop||'', cultivar:r.cultivar||'', gmo:!!r.gmo, irrigated:!!r.irrigated, planted:r.planted||'', harvest:r.harvest||'', stage:r.stage||'', targetYield:Number(r.target_yield)||0, actualYield:(r.actual_yield!=null)?Number(r.actual_yield):null, inputPerHa:Number(r.input_per_ha)||0, prevCrop:r.prev_crop||'' }; if(r.price) l.price=Number(r.price); return l; }
  function cevToDb(e,fid){ return { farm_id:fid, local_id:String(e.id), land_local_id:(e.land!=null)?String(e.land):null, kind:e.kind||null, event_date:e.date||null, note:e.note||null, tons:(e.tons!=null)?Number(e.tons):null, yield_val:(e.yield!=null)?Number(e.yield):null, cert:e.cert||null }; }
  function cevFromDb(r){ var e={ id:r.local_id, land:_numIf(r.land_local_id), kind:r.kind||'', date:r.event_date||'', note:r.note||'' }; if(r.tons!=null) e.tons=Number(r.tons); if(r.yield_val!=null) e.yield=Number(r.yield_val); if(r.cert) e.cert=r.cert; return e; }
  function cinToDb(i,fid){ return { farm_id:fid, local_id:String(i.id), land_local_id:(i.land!=null)?String(i.land):null, input_date:i.date||null, product:i.product||null, reg:i.reg||null, kind:i.kind||null, rate:i.rate||null, batch:i.batch||null, by_who:i.by||null, operator_cert:i.operatorCert||null, target_for:i.targetFor||null, phi:(i.phi!=null)?parseInt(i.phi,10):null, cost_per_ha:(i.costPerHa!=null)?Number(i.costPerHa):null }; }
  function cinFromDb(r){ return { id:r.local_id, land:_numIf(r.land_local_id), date:r.input_date||'', product:r.product||'', reg:r.reg||'', kind:r.kind||'', rate:r.rate||'', batch:r.batch||'', by:r.by_who||'', operatorCert:r.operator_cert||'', targetFor:r.target_for||'', phi:Number(r.phi)||0, costPerHa:Number(r.cost_per_ha)||0 }; }

  load.crops = async function(farmId){
    farmId = farmId || farm.active();
    const [ld,ev,ip,cfg] = await Promise.all([
      client().from('crop_lands').select('*').eq('farm_id',farmId).order('created_at'),
      client().from('crop_events').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('crop_inputs').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('farms').select('crop_season,crop_compliance').eq('id',farmId).single()
    ]);
    for(const r of [ld,ev,ip]) if(r.error) throw r.error;
    return { lands:(ld.data||[]).map(landFromDb), events:(ev.data||[]).map(cevFromDb), inputs:(ip.data||[]).map(cinFromDb),
             season:(cfg.data && cfg.data.crop_season) || null,
             compliance:(cfg.data && cfg.data.crop_compliance) || null };
  };

  var _cropSnap=null;
  var _cropCfgSnap=null;
  const crop = {
    async saveAll(stc){
      if(!stc) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({l:stc.lands,e:stc.events,i:stc.inputs});
      if(snap===_cropSnap) return;
      const lands=(stc.lands||[]), events=(stc.events||[]), inputs=(stc.inputs||[]);
      if(lands.length){ const e=(await client().from('crop_lands').upsert(lands.map(function(l){return landToDb(l,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(events.length){ const e=(await client().from('crop_events').upsert(events.map(function(x){return cevToDb(x,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      if(inputs.length){ const e=(await client().from('crop_inputs').upsert(inputs.map(function(x){return cinToDb(x,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      _cropSnap=snap;
      return true;
    },
    // 3b-ii: season + compliance blob live on the farm row
    async saveConfig(stc){
      if(!stc) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({s:stc.season,c:stc.compliance});
      if(snap===_cropCfgSnap) return;
      const e=(await client().from('farms').update({ crop_season:stc.season||null, crop_compliance:stc.compliance||null }).eq('id',fid)).error;
      if(e) throw e;
      _cropCfgSnap=snap;
      return true;
    }
  };

  // ---- ORCHARDS (blocks, pricing, sprays, harvest) — 3c-i -----------------
  // Blocks are the canonical set (set-sync). Pricing is 1 row/block + a child
  // table for the variable others[] lines. Sprays/harvest are append logs.
  // PHI (safe-to-pick) is NOT stored — it is recomputed from sprays on load.
  function _n(v){ return (v!=null&&v!=='')?Number(v):null; }
  function obToDb(b,fid){ return { farm_id:fid, local_id:String(b.id), cat:b.cat||null, icon:b.icon||null, name:b.name||null, cultivar:b.cultivar||null, root:b.root||null, plant:(b.plant!=null)?String(b.plant):null, age:(b.age!=null&&b.age!=='')?parseInt(b.age,10):null, ha:_n(b.ha), trees:(b.trees!=null&&b.trees!=='')?parseInt(b.trees,10):null, status:b.status||null, status_tag:b.statusTag||null, tons:_n(b.tons), exp:_n(b.exp), carton_kg:_n(b.cartonKg), margin:_n(b.margin), estab:b.estab||null, estab_yr:(b.estabYr!=null&&b.estabYr!=='')?parseInt(b.estabYr,10):null, writeoff:_n(b.writeoff), per_unit:_n(b.perUnit), unit_word:b.unitWord||null, curve:b.curve||null, cover:b.cover||null, plan:(b.plan!=null)?!!b.plan:null, grade:_n(b.grade), unit:b.unit||null, days:(b.days!=null&&b.days!=='')?parseInt(b.days,10):null, pick_from:b.pickFrom||null, cycle:b.cycle||null, removed:(b.removed!=null)?!!b.removed:null }; }
  function obFromDb(r){ var b={ id:r.local_id, cat:r.cat||'', icon:r.icon||'', name:r.name||'', cultivar:r.cultivar||'', status:r.status||'', statusTag:r.status_tag||'' };
    if(r.root!=null) b.root=r.root; if(r.plant!=null) b.plant=_numIf(r.plant); if(r.age!=null) b.age=Number(r.age); if(r.ha!=null) b.ha=Number(r.ha); if(r.trees!=null) b.trees=Number(r.trees); if(r.tons!=null) b.tons=Number(r.tons); if(r.exp!=null) b.exp=Number(r.exp); if(r.carton_kg!=null) b.cartonKg=Number(r.carton_kg); if(r.margin!=null) b.margin=Number(r.margin); if(r.estab!=null) b.estab=r.estab; if(r.estab_yr!=null) b.estabYr=Number(r.estab_yr); if(r.writeoff!=null) b.writeoff=Number(r.writeoff); if(r.per_unit!=null) b.perUnit=Number(r.per_unit); if(r.unit_word!=null) b.unitWord=r.unit_word; if(r.curve!=null) b.curve=r.curve; if(r.cover!=null) b.cover=r.cover; if(r.plan!=null) b.plan=!!r.plan; if(r.grade!=null) b.grade=Number(r.grade); if(r.unit!=null) b.unit=r.unit; if(r.days!=null) b.days=Number(r.days); if(r.pick_from!=null) b.pickFrom=r.pick_from; if(r.cycle!=null) b.cycle=r.cycle; if(r.removed!=null) b.removed=!!r.removed;
    return b; }
  // compliance item: persist full item (queryable) ; load overlays user fields onto app defaults
  function ociToDb(key,c,fid){ c=c||{}; return { farm_id:fid, item_key:String(key), kind:c.type||null, icon:c.ic||null, title:c.title||null, what:c.what||null, status:c.status||null, status_tag:c.statusTag||null, expiry:c.expiry||null, cropcat:c.cropcat||null, log:(c.log!=null)?String(c.log):null }; }
  function opToDb(blockId,p,fid){ p=p||{}; var lo=p.local||{}; return { farm_id:fid, block_local_id:String(blockId), price:_n(p.price), comm:_n(p.comm), pack:_n(p.pack), ship:_n(p.ship), levy:_n(p.levy), levy_name:p.levyName||null, local_price:_n(lo.price), local_comm:_n(lo.comm), local_trans:_n(lo.trans), local_other:_n(lo.other) }; }
  function opFromDb(r,others){ return { price:Number(r.price)||0, comm:Number(r.comm)||0, pack:Number(r.pack)||0, ship:Number(r.ship)||0, levy:Number(r.levy)||0, levyName:r.levy_name||'', others:(others&&others.length)?others:[{label:'Other costs',amt:0}], local:{price:Number(r.local_price)||0,comm:Number(r.local_comm)||0,trans:Number(r.local_trans)||0,other:Number(r.local_other)||0} }; }
  function osToDb(s,cat,fid){ return { farm_id:fid, local_id:String(s.id), cropcat:cat||null, block_local_id:(s.bid!=null&&s.bid!=='')?String(s.bid):null, product:s.product||null, reg:s.reg||null, target_for:s.forx||null, applied_by:s.by||null, spray_date:s.dateISO||null, phi_eu:_n(s.phi&&s.phi.eu), phi_uk:_n(s.phi&&s.phi.uk), phi_us:_n(s.phi&&s.phi.us), phi_local:_n(s.phi&&s.phi.local), title:s.t||null, sub:s.s||null, icon:s.ic||null }; }
  function osFromDb(r){ return { id:r.local_id, ic:r.icon||'\uD83E\uDDEA', t:r.title||'', s:r.sub||'', phi:{eu:Number(r.phi_eu)||0,uk:Number(r.phi_uk)||0,us:Number(r.phi_us)||0,local:Number(r.phi_local)||0}, bid:r.block_local_id||'', product:r.product||'', reg:r.reg||'', forx:r.target_for||'', by:r.applied_by||'', dateISO:r.spray_date||'', cropcat:r.cropcat||'' }; }
  function ohToDb(h,fid){ return { farm_id:fid, local_id:String(h.id), cropcat:h.cat||null, block_local_id:(h.bid!=null&&h.bid!=='')?String(h.bid):null, bins:_n(h.bins), tons:_n(h.tons!=null?h.tons:h.tn), cartons:_n(h.cartons), top_grade_pct:_n(h.grade), sold_to:h.to||null, amount:_n(h.money), pick_date:h.dateISO||null, title:h.t||null, sub:h.s||null, revenue:h.r||null, icon:h.ic||null }; }
  function ohFromDb(r){ return { id:r.local_id, ic:r.icon||'\uD83C\uDF4A', t:r.title||'', s:r.sub||'', r:r.revenue||'\u2014', cat:r.cropcat||'', bid:r.block_local_id||'', tn:Number(r.tons)||0, tons:Number(r.tons)||0, cartons:Number(r.cartons)||0, to:r.sold_to||'', money:Number(r.amount)||0, dateISO:r.pick_date||'' }; }

  load.orchard = async function(farmId){
    farmId = farmId || farm.active();
    const [bl,dc,pr,po,sp,hv,ci,cd,cc,cr,cfg] = await Promise.all([
      client().from('orchard_blocks').select('*').eq('farm_id',farmId).order('created_at'),
      client().from('orchard_block_docs').select('*').eq('farm_id',farmId).order('sort_idx'),
      client().from('orchard_pricing').select('*').eq('farm_id',farmId),
      client().from('orchard_pricing_others').select('*').eq('farm_id',farmId).order('sort_idx'),
      client().from('orchard_sprays').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('orchard_harvest').select('*').eq('farm_id',farmId).order('created_at',{ascending:false}),
      client().from('orchard_compliance_items').select('*').eq('farm_id',farmId),
      client().from('orchard_compliance_docs').select('*').eq('farm_id',farmId).order('sort_idx'),
      client().from('orchard_compliance_checks').select('*').eq('farm_id',farmId).order('sort_idx'),
      client().from('orchard_compliance_readings').select('*').eq('farm_id',farmId).order('sort_idx'),
      client().from('farms').select('orchard_market').eq('id',farmId).single()
    ]);
    for(const r of [bl,dc,pr,po,sp,hv,ci,cd,cc,cr]) if(r.error) throw r.error;
    var docsByBlock={}; (dc.data||[]).forEach(function(d){ (docsByBlock[d.block_local_id]=docsByBlock[d.block_local_id]||[]).push({name:d.name,kind:d.kind,added:d.added}); });
    var blocks=(bl.data||[]).map(function(r){ var b=obFromDb(r); b.docs=docsByBlock[b.id]||[]; return b; });
    var othByBlock={}; (po.data||[]).forEach(function(o){ (othByBlock[o.block_local_id]=othByBlock[o.block_local_id]||[]).push({label:o.label||'',amt:Number(o.amt)||0}); });
    var pricing={}; (pr.data||[]).forEach(function(r){ pricing[r.block_local_id]=opFromDb(r,othByBlock[r.block_local_id]||[]); });
    var sprayDiary={}; (sp.data||[]).forEach(function(r){ var s=osFromDb(r); (sprayDiary[s.cropcat]=sprayDiary[s.cropcat]||[]).push(s); });
    var harvest=(hv.data||[]).map(ohFromDb);
    // compliance: per-key user fields + children, to overlay onto app defaults in ai-auth
    var cDocs={}, cChecks={}, cReads={};
    (cd.data||[]).forEach(function(d){ (cDocs[d.item_key]=cDocs[d.item_key]||[]).push({name:d.name||'',kind:d.kind||'',added:d.added||''}); });
    (cc.data||[]).forEach(function(r){ (cChecks[r.item_key]=cChecks[r.item_key]||[]).push({date:r.check_date||'',note:r.note||''}); });
    (cr.data||[]).forEach(function(r){ (cReads[r.item_key]=cReads[r.item_key]||[]).push({date:r.reading_date||'',m3:r.m3||''}); });
    var comply={};
    (ci.data||[]).forEach(function(r){ var o={status:r.status||'',statusTag:r.status_tag||'',expiry:r.expiry||''}; if(r.log!=null) o.log=r.log;
      if(cDocs[r.item_key]) o.docs=cDocs[r.item_key]; if(cChecks[r.item_key]) o.checks=cChecks[r.item_key]; if(cReads[r.item_key]) o.readings=cReads[r.item_key];
      comply[r.item_key]=o; });
    return { blocks:blocks, pricing:pricing, sprayDiary:sprayDiary, harvest:harvest, comply:comply, market:(cfg.data&&cfg.data.orchard_market)||null };
  };

  var _orSnap=null, _orCfgSnap=null;
  const orchard = {
    async saveAll(stf){
      if(!stf) return;
      const fid=farm.active(); if(!fid) return;
      const snap=JSON.stringify({b:stf.blocks,p:stf.pricing,s:stf.sprayDiary,h:stf.harvest,c:stf.comply});
      if(snap===_orSnap) return;
      const blocks=(stf.blocks||[]); const blockIds=blocks.map(function(b){return String(b.id);});
      if(blocks.length){ const e=(await client().from('orchard_blocks').upsert(blocks.map(function(b){return obToDb(b,fid);}),{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      { var bq=client().from('orchard_blocks').delete().eq('farm_id',fid); if(blockIds.length) bq=bq.not('local_id','in',_inList(blockIds)); const e=(await bq).error; if(e) throw e; }
      // block docs: replace-all (small metadata child set)
      { const e=(await client().from('orchard_block_docs').delete().eq('farm_id',fid)).error; if(e) throw e; }
      var docRows=[]; blocks.forEach(function(b){ (b.docs||[]).forEach(function(d,i){ docRows.push({farm_id:fid,block_local_id:String(b.id),name:d.name||null,kind:d.kind||null,added:d.added||null,sort_idx:i}); }); });
      if(docRows.length){ const e=(await client().from('orchard_block_docs').insert(docRows)).error; if(e) throw e; }
      // pricing upsert + prune
      var pricing=stf.pricing||{}; var pkeys=Object.keys(pricing).filter(function(k){return blockIds.indexOf(String(k))>=0;});
      if(pkeys.length){ const e=(await client().from('orchard_pricing').upsert(pkeys.map(function(k){return opToDb(k,pricing[k],fid);}),{onConflict:'farm_id,block_local_id'})).error; if(e) throw e; }
      { var pq=client().from('orchard_pricing').delete().eq('farm_id',fid); if(pkeys.length) pq=pq.not('block_local_id','in',_inList(pkeys)); const e=(await pq).error; if(e) throw e; }
      // pricing others: replace-all
      { const e=(await client().from('orchard_pricing_others').delete().eq('farm_id',fid)).error; if(e) throw e; }
      var othRows=[]; pkeys.forEach(function(k){ ((pricing[k]&&pricing[k].others)||[]).forEach(function(o,i){ othRows.push({farm_id:fid,block_local_id:String(k),label:o.label||null,amt:_n(o.amt),sort_idx:i}); }); });
      if(othRows.length){ const e=(await client().from('orchard_pricing_others').insert(othRows)).error; if(e) throw e; }
      // sprays append-only (assign ids if missing so upsert is stable)
      var sprayRows=[]; var sd=stf.sprayDiary||{}; Object.keys(sd).forEach(function(cat){ (sd[cat]||[]).forEach(function(s){ if(!s.id) s.id='os'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); sprayRows.push(osToDb(s,cat,fid)); }); });
      if(sprayRows.length){ const e=(await client().from('orchard_sprays').upsert(sprayRows,{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      var harvRows=[]; (stf.harvest||[]).forEach(function(h){ if(!h.id) h.id='oh'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); harvRows.push(ohToDb(h,fid)); });
      if(harvRows.length){ const e=(await client().from('orchard_harvest').upsert(harvRows,{onConflict:'farm_id,local_id'})).error; if(e) throw e; }
      // compliance: items upsert + prune; docs/checks/readings replace-all per farm
      var comply=stf.comply||{}; var ckeys=Object.keys(comply);
      if(ckeys.length){ const e=(await client().from('orchard_compliance_items').upsert(ckeys.map(function(k){return ociToDb(k,comply[k],fid);}),{onConflict:'farm_id,item_key'})).error; if(e) throw e; }
      { var cq=client().from('orchard_compliance_items').delete().eq('farm_id',fid); if(ckeys.length) cq=cq.not('item_key','in',_inList(ckeys)); const e=(await cq).error; if(e) throw e; }
      { const e=(await client().from('orchard_compliance_docs').delete().eq('farm_id',fid)).error; if(e) throw e; }
      var cdRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].docs)||[]).forEach(function(d,i){ cdRows.push({farm_id:fid,item_key:k,name:d.name||null,kind:d.kind||null,added:d.added||null,sort_idx:i}); }); });
      if(cdRows.length){ const e=(await client().from('orchard_compliance_docs').insert(cdRows)).error; if(e) throw e; }
      { const e=(await client().from('orchard_compliance_checks').delete().eq('farm_id',fid)).error; if(e) throw e; }
      var ccRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].checks)||[]).forEach(function(c,i){ ccRows.push({farm_id:fid,item_key:k,check_date:c.date||null,note:c.note||null,sort_idx:i}); }); });
      if(ccRows.length){ const e=(await client().from('orchard_compliance_checks').insert(ccRows)).error; if(e) throw e; }
      { const e=(await client().from('orchard_compliance_readings').delete().eq('farm_id',fid)).error; if(e) throw e; }
      var crRows=[]; ckeys.forEach(function(k){ ((comply[k]&&comply[k].readings)||[]).forEach(function(rd,i){ crRows.push({farm_id:fid,item_key:k,reading_date:rd.date||null,m3:rd.m3||null,sort_idx:i}); }); });
      if(crRows.length){ const e=(await client().from('orchard_compliance_readings').insert(crRows)).error; if(e) throw e; }
      _orSnap=snap;
      return true;
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

  // ---- EXPORT --------------------------------------------------------------
  global.AI = { init: client, auth, farm, load, txn, account, budget, recurring, asset, loans,
                coopSettlement: coopSettlement, livestock: livestock, crop: crop, orchard: orchard,
                _map: { catToId, catToCode, appToDb, dbToApp } };

})(window);
