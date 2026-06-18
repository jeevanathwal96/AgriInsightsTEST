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

  // ---- EXPORT --------------------------------------------------------------
  global.AI = { init: client, auth, farm, load, txn, account, budget, recurring,
                _map: { catToId, catToCode, appToDb, dbToApp } };

})(window);
