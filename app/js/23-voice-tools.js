/* ============================================================
   VOICE TOOLS — what Margyn can do on a live call (22-realtime-voice.js).
   Tool schemas live in api/ask-margyn.js (REALTIME_TOOLS); each one runs
   here, in the browser, against what the app has already loaded for this
   signed-in user. So every figure Margyn says is the figure on screen, and
   a voice session can reach nothing the user's own session can't.

   Four kinds of tool:
     - workspace: show_view draws a live view (P&L, receivables, cash, GST,
       inbox, a customer...) in the floating workspace without leaving the
       page; show_table / show_chart for anything custom; clear_workspace.
     - screen: navigate, filter_list, open_party, search_app, run_command —
       move the UI the same way the rail, Scope bar and buttons do.
     - read:   get_screen, get_overview, query_parties, get_cash, get_gst,
       get_inbox, think — return live figures (think asks Claude).
     - change: propose_change puts a confirm card on screen (same Claude
       propose_action validation as typed chat). confirm_pending_change is
       the only route from speech to a write, and it is gated HERE, not by
       the model: the card must be an internal, reversible type, and the
       user's own words after the card appeared must be an explicit yes.
   ============================================================ */

/* ---------- small helpers ---------- */
const VX_DIR = { receivables:'recv', payables:'pay' };
const VX_AGE = { '0-30':'b0', '31-60':'b1', '61-90':'b2', '90+':'b3', all:null };
const VX_AGE_BACK = { b0:'0-30', b1:'31-60', b2:'61-90', b3:'90+' };
// Messages a customer, or acts on several rows: always needs a tap.
const VX_TAP_ONLY = ['send_one_off_chase', 'list_for_review'];

function vxInr(n){ return fmtINR(n, 'tile'); }
/* Negative cash stores a runway like "-0.0 months"; spoken, that's "minus zero months". */
function vxVitalValue(val){ return /^-\s*\d+(\.\d+)?\s*months?$/i.test(String(val == null ? '' : val).trim()) ? 'below zero (negative balance, no runway)' : val; }
function vxLabel(page){ return (MG_PAGES[page] && MG_PAGES[page].label) || page; }
function vxNorm(s){
  return String(s || '').toLowerCase()
    .replace(/\b(private limited|pvt\.? ltd\.?|pvt|limited|ltd\.?|llp|and co\.?|& co\.?|enterprises|traders|trading|industries|company|co)\b/g, ' ')
    .replace(/[^a-z0-9ऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function vxEdit1(a, b){   // true when a and b differ by at most one edit
  if(a === b) return true;
  if(Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while(i < a.length && j < b.length){
    if(a[i] === b[j]){ i++; j++; continue; }
    if(++d > 1) return false;
    if(a.length > b.length) i++; else if(b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
/* Spoken names get mis-heard ("Sharma Traders" -> "Sharma traders pvt",
   "Acme" -> "Akme"). Token-level match with a one-letter tolerance. */
function vxScoreName(query, name){
  const q = vxNorm(query), n = vxNorm(name);
  if(!q || !n) return 0;
  if(q === n) return 1;
  if(n.includes(q) || q.includes(n)) return 0.9;
  const qt = q.split(' ').filter(t => t.length > 1), nt = n.split(' ').filter(t => t.length > 1);
  if(!qt.length || !nt.length) return 0;
  const hit = qt.filter(t => nt.some(x => x === t || (t.length >= 4 && (x.startsWith(t) || t.startsWith(x))) || (t.length >= 4 && vxEdit1(t, x)))).length;
  return hit / Math.max(qt.length, 1) * 0.85;
}
function vxGroups(dir){ try { return mgMoneyGroups(dir); } catch(e){ return []; } }
function vxFindParty(dir, name){
  const scored = vxGroups(dir).map(g => ({ g, s:vxScoreName(name, g.party) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s || b.g.amount - a.g.amount);
  return { best:scored[0] ? scored[0].g : null, others:scored.slice(1, 4).map(x => x.g.party), confident:!!scored[0] && (scored[0].s >= 0.85 || !scored[1] || scored[0].s - scored[1].s >= 0.2) };
}
/* The customer/vendor master (19f-parties.js), for parties with nothing open. */
function vxFindMaster(name){
  const list = (typeof khataParties !== 'undefined' && khataParties) || [];
  const best = list.map(p => ({ p, s:vxScoreName(name, p.name) })).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s)[0];
  return best ? best.p : null;
}
/* Section titles on the page, or the ones in view after a scroll. */
function vxHeadings(page, box, top){
  const r = box && box.getBoundingClientRect ? box.getBoundingClientRect() : null;
  return [...page.querySelectorAll('h1, h2, h3, .mg-panel-h h2')].filter(x => x.offsetParent)
    .filter(x => { if(!r || top == null) return true; const y = x.getBoundingClientRect().top - r.top + box.scrollTop; return y >= top - 20 && y <= top + (box.clientHeight || 800); })
    .map(x => x.textContent.trim().slice(0, 40)).filter(Boolean).slice(0, 6);
}
function vxPartyRow(g){
  const od = g.oldestDays != null && g.oldestDays < 0 ? -g.oldestDays : 0;
  return {
    name:g.party, outstanding_inr:Math.round(g.amount), outstanding:vxInr(g.amount), overdue_inr:Math.round(g.overdue || 0),
    open_items:g.invoices, oldest_days_overdue:od, next_due_in_days:(g.oldestDays != null && g.oldestDays >= 0) ? g.oldestDays : null,
    agreement:g.status === 'single' ? 'one source (signal)' : g.status === 'agree' ? 'sources agree (verified)' : 'sources disagree by ' + vxInr(g.diff),
    figures_from:MG_SRC_NAME[g.primary] || g.primary
  };
}
function vxTotals(groups){
  return { parties:groups.length, total_inr:Math.round(groups.reduce((t, g) => t + g.amount, 0)), overdue_inr:Math.round(groups.reduce((t, g) => t + (g.overdue || 0), 0)),
    total:vxInr(groups.reduce((t, g) => t + g.amount, 0)), overdue:vxInr(groups.reduce((t, g) => t + (g.overdue || 0), 0)) };
}
/* Run a UI change as Margyn, so the showView hook in 22 doesn't report it
   back to the model as something the user did themselves. */
function vxDrive(fn){
  vxDriving = true;
  try { return fn(); } finally { setTimeout(() => { vxDriving = false; }, 0); }
}
function vxSpot(el){
  if(!el) return;
  try { el.scrollIntoView({ block:'nearest', behavior:'smooth' }); } catch(e){}
  el.classList.remove('vx-spot'); void el.offsetWidth; el.classList.add('vx-spot');
  setTimeout(() => el.classList.remove('vx-spot'), 2600);
}

/* ---------- page summaries: what a page shows, as data ---------- */
function vxMoneySummary(dir){
  const groups = vxGroups(dir);
  const t = vxTotals(groups);
  const buckets = { '0-30':0, '31-60':0, '61-90':0, '90+':0 };
  groups.forEach(g => g.by[g.primary].rows.forEach(r => { buckets[VX_AGE_BACK[mgBucketOf(r.days)]] += r.amount; }));
  Object.keys(buckets).forEach(k => { buckets[k] = vxInr(buckets[k]); });
  return Object.assign(t, { ageing:buckets, sources_disagreeing:groups.filter(g => g.status === 'conflict').length,
    largest:groups.slice().sort((a, b) => b.amount - a.amount).slice(0, 5).map(vxPartyRow) });
}
function vxPageSummary(page){
  try {
    if(page === 'receivables' || page === 'customers') return vxMoneySummary('recv');
    if(page === 'payables' || page === 'vendors') return vxMoneySummary('pay');
    if(page === 'cash') return VX_TOOLS.get_cash();
    if(page === 'gst') return VX_TOOLS.get_gst();
    if(page === 'inbox' || page === 'agents') return VX_TOOLS.get_inbox();
    if(page === 'cfopack') return vxPackSummary();
    if(page === 'home') return VX_TOOLS.get_overview();
    if(page === 'margin') return VX_TOOLS.get_margin();
    if(page === 'channels') return vxChannelSummary();
  } catch(e){ console.error('[voice] summary', page, e); }
  return { about:(MG_PAGES[page] && MG_PAGES[page].sub) || null };
}
/* Channel health: the same figures as the page (19h-channels.js), so "are my
   reminders going out" and "how much did you recover" have an answer. */
function vxChannelSummary(){
  if(typeof mgLoadChannels === 'function' && !mgChan && !mgChanBusy) mgLoadChannels();
  const d = typeof mgChan !== 'undefined' ? mgChan : null;
  if(!d) return { loading:true, note:'Channel health is still loading. Ask again in a few seconds.' };
  const r = d.recovered || {};
  return {
    window_days:d.window_days,
    channels:(d.channels || []).map(c => ({ channel:c.label, via:c.via, status:c.status, headline:c.headline, sent:c.sent_30d, failed:c.failed_30d, last_delivered:c.last_success_at || null, detail:c.detail })),
    paid_after_chase:{ amount:vxInr(r.amount || 0), invoices:r.invoices || 0, window_days:r.window_days || 30 },
    still_being_chased:{ amount:vxInr((r.still_chasing || {}).amount || 0), invoices:(r.still_chasing || {}).invoices || 0 },
    promised_to_pay:{ amount:vxInr((r.promised || {}).amount || 0), invoices:(r.promised || {}).invoices || 0 },
    note:'Paid after a chase counts payments that followed a chase; it cannot prove the customer would not have paid anyway.'
  };
}
/* The CFO pack is one month's figures (the month picked on the page), not
   today's. Summarising it from the live overview gave a different Pulse
   Score, cash and margin from the pack on screen. This reads the same
   snapshot the pack draws from. */
function vxPackSummary(){
  if(typeof mgPackCurrent !== 'function') return VX_TOOLS.get_overview();
  const k = mgPackCurrent(); if(!k) return { note:'No month has figures yet, so there is no CFO pack.' };
  const s0 = mgPackSnap(k), p0 = mgPackSnap(mgMonthShift(k, -1));
  const pt = p0 && typeof mgPackTallyPnl === 'function' ? mgPackTallyPnl(mgMonthShift(k, -1)) : null, p = p0 && pt ? Object.assign({}, p0, pt) : p0;
  if(!s0) return { month:mgMonthLabel(k), note:'No figures for that month.' };
  // The month's own P&L from the books, exactly as the pack shows it (a reading's revenue is not that month's).
  const s = typeof mgPackTallyPnl === 'function' && mgPackTallyPnl(k) ? Object.assign({}, s0, mgPackTallyPnl(k)) : s0;
  const margin = Number(s.revenue) ? Number(s.net_profit) / Number(s.revenue) * 100 : null;
  const band = s.pulse_score != null && typeof scoreBand === 'function' ? scoreBand(s.pulse_score) : null;
  return {
    cfo_pack_for_month:mgMonthLabel(k), note:'These are the figures in the CFO pack on screen, for that month. Quote these, not today\'s live figures.',
    cash_at_month_end:vxInr(s.cash), revenue:vxInr(s.revenue), net_profit:vxInr(s.net_profit), net_margin_pct:margin == null ? null : +margin.toFixed(1),
    monthly_spend:vxInr(s.burn), gst_payable:vxInr(s.gst_payable),
    pulse_score:s.pulse_score != null ? s.pulse_score : null, pulse_band:band ? band.label : null,
    pulse_change_on_prior_month:p && p.pulse_score != null && s.pulse_score != null ? s.pulse_score - p.pulse_score : null,
    revenue_change_pct:p && !s.pl_in_progress ? vxR1(vxPct(s.revenue, p.revenue)) : null, month_in_progress:!!s.pl_in_progress, cash_change_pct:p ? vxR1(vxPct(s.cash, p.cash)) : null
  };
}
/* The form open in the side panel right now: the New/Edit customer or vendor
   form, or the Ledger's add-entry form. */
const VX_FORM_KEYS = { name:'name', type:'type', gstin:'gstin', phone:'phone', email:'email', address:'address', state:'state', pincode:'pincode', pan:'pan', credit_days:'credit_days', opening_balance:'opening_balance' };
function vxOpenForm(){
  const pf = mgDrawerEl && mgDrawerEl.querySelector('form.mg-pf');
  if(pf) return { kind:'party', form:pf, save:mgDrawerEl.querySelector('[data-pf-save]'), title:(mgDrawerEl.querySelector('h3') || {}).textContent || 'Form' };
  const lf = document.getElementById('ledgerAddForm');
  if(lf && !lf.classList.contains('hidden') && lf.offsetParent !== null) return { kind:'ledger', form:lf, save:document.getElementById('ledgerAddBtn'), title:(document.getElementById('ledgerAddTitle') || {}).textContent || 'Add entry' };
  return null;
}
function vxFormValues(f){
  if(f.kind === 'party') return Object.fromEntries([...f.form.elements].filter(x => x.name).map(x => [x.name, x.value]));
  const v = id => (document.getElementById(id) || {}).value || '';
  return { party:v('ledgerParty'), amount:v('ledgerAmt'), due_date:v('ledgerDue') };
}
/* A save by voice needs the user's own words asking for it, like a change card. */
const VX_SAVE_WORDS = /\b(save|saved|submit|add (it|him|her|them|this)|go ahead|do it|yes|yeah|yep|haan|kar do|kardo|theek hai|thik hai|please do|confirm|done)\b/i;

/* Buttons the user can see on the page (or the open side panel), for get_screen and press. */
function vxButtons(){
  const sc = (typeof mgDrawerEl !== 'undefined' && mgDrawerEl) || document.getElementById('view-' + mgCurrentView) || document.querySelector('.view:not(.hidden)');
  if(!sc) return [];
  return [...new Set([...sc.querySelectorAll('button, [role="tab"], summary')].filter(el => el.offsetParent && !el.disabled)
    .map(el => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length <= 40))].slice(0, 16);
}
/* What the page says, in words, for pages without a figures summary: headings, tiles, table rows. */
function vxPageText(max){
  const sc = (typeof mgDrawerEl !== 'undefined' && mgDrawerEl) || document.getElementById('view-' + mgCurrentView) || document.querySelector('.view:not(.hidden)');
  if(!sc) return '';
  return String(sc.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max || 1800);
}
/* Keep a tool result small: long lists shrink to their first few rows. */
function vxCompact(o, maxLen){
  let s = JSON.stringify(o);
  for(let keep = 5; s.length > maxLen && keep >= 1; keep -= 2){
    o = JSON.parse(s, (k, x) => Array.isArray(x) ? x.slice(0, keep) : (typeof x === 'string' && x.length > 160 ? x.slice(0, 157) + '…' : x));
    s = JSON.stringify(o);
  }
  return o;
}
// Saving a PDF or a CSV to their own computer is fine even though it says "save" / "download".
const VX_PRESS_OK = /\b(print|pdf|export|download|csv)\b/i;
const VX_PRESS_NO = /\b(approve|confirm|dismiss|reject|delete|remove|disconnect|send|pay|paid|save|submit|apply|archive|sign ?out|log ?out|revoke|reset|clear|cancel invite|invite|add|create|book|post|sync|connect|accept|decline|mute|stop)\b/i;

/* ---------- the tools ---------- */
const VX_TOOLS = {
  navigate({ page, view, period }){
    if(!MG_PAGES[page]) return { ok:false, error:'No page called ' + page };
    vxDrive(() => {
      if(view && MG_MONEY[page]){ mgMoneySrc = view; mgMoneyAge = null; }
      if(view && page === 'cash') mgCashSrc = view;
      if(page === 'cfopack' && /^\d{4}-\d{2}$/.test(period || '')) mgPackMonth = period;
      if(page === 'agents') agentsActiveTab = 'roster';
      showView(page);
      if(view && MG_SRC[page] && mgSourceOptions(page).some(o => o.key === view)) mgSetSource(page, view);
      if(period && page === 'analytics' && mgRangeOptions().some(o => o.key === period)) mgSetRange(period);
    });
    vxActivity('Opened ' + vxLabel(page) + (view && view !== 'reconciled' ? ' · ' + (MG_SRC_LABEL[view] || view) : ''));
    // What's on the page comes back with the move, for every page: "open the inbox, what does it say"
    // was answered "it's empty" when only money pages carried their figures (2026-10-03).
    const base = { ok:true, now_showing:vxLabel(page), view:mgCurrentSource(page) || null };
    const shape = sm => {
      if(sm && sm.largest) sm.largest = sm.largest.slice(0, 3).map(r => ({ name:r.name, outstanding:r.outstanding, oldest_days_overdue:r.oldest_days_overdue }));
      if(!sm || (Object.keys(sm).length === 1 && 'about' in sm)) sm = Object.assign({}, sm, { page_text:vxPageText(1200) });
      return Object.assign(base, { on_this_page:vxCompact(sm, 1800) });
    };
    const sm = vxPageSummary(page);
    return sm && typeof sm.then === 'function' ? sm.then(shape) : shape(sm);
  },

  search_app({ query, open_top }){
    const hits = mgSearch(String(query || '')).slice(0, 6);
    if(!hits.length) return { results:[], note:'Nothing in the app matches "' + query + '".' };
    if(open_top){ vxDrive(() => hits[0].run()); vxActivity('Opened ' + hits[0].label); }
    return { results:hits.map(h => ({ type:h.kind, name:h.label, detail:h.hint })), opened:open_top ? hits[0].label : null };
  },

  get_screen(){
    const page = mgCurrentView;
    const out = { page:vxLabel(page), about:(MG_PAGES[page] && MG_PAGES[page].sub) || null, view:mgCurrentSource(page) || null, as_of:mgAsOf() };
    if(MG_MONEY[page]){
      out.filter = { search:mgMoneyQ || null, age:mgMoneyAge ? VX_AGE_BACK[mgMoneyAge] : null };
      const host = document.getElementById('view-' + page);
      const rows = (host && host.__rows) || null;
      if(rows) out.rows_on_screen = rows.slice(0, 8).map(r => ({ name:r.party, amount:vxInr(r.amount), days_to_due:r.days }));
    }
    const d = document.querySelector('.mg-drawer h3');
    if(d) out.side_panel_open_for = d.textContent;
    if(!MG_MONEY[page]) out.summary = vxPageSummary(page);
    out.buttons = vxButtons();
    // Pages with no figures summary: say what the page says, in its own words.
    if(!MG_MONEY[page] && out.summary && Object.keys(out.summary).length === 1 && 'about' in out.summary) out.page_text = vxPageText(1800);
    if(d) out.side_panel_text = vxPageText(1200);
    // The Margin summary waits for its figures (get_margin is async).
    if(out.summary && typeof out.summary.then === 'function') return out.summary.then(sm => Object.assign(out, { summary:sm }));
    return out;
  },

  get_overview(){
    const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
    const out = { as_of:mgAsOf(), organisation:mgOrgName() };
    if(s){
      out.pulse_score = s.pulse_score != null ? s.pulse_score : null;
      if(p && p.pulse_score != null && s.pulse_score != null) out.pulse_change_since_last = s.pulse_score - p.pulse_score;
      out.vitals = (s.vitals || []).map(v => ({ vital:mgVitalName(v.label), value:vxVitalValue(v.value), score_out_of_100:v.score != null ? Math.round(v.score) : null }));
      out.pnl = { cash:vxInr(s.cash), revenue:vxInr(s.revenue), net_profit:vxInr(s.net_profit), monthly_spend:vxInr(s.burn), gst_payable:vxInr(s.gst_payable) };
      if(s.confidence != null) out.data_confidence_pct = Math.round(Number(s.confidence) * (Number(s.confidence) <= 1 ? 100 : 1));
    } else out.note = 'No snapshot yet. The user needs to connect a source or enter figures.';
    out.receivables = vxTotals(vxGroups('recv'));
    out.payables = vxTotals(vxGroups('pay'));
    try { const f = mgForecast(); if(f) out.cash_forecast = { lowest:vxInr(f.min), lowest_in_week:f.minWeek + 1, floor:vxInr(f.floor), drops_below_floor_in_week:f.firstBelow >= 0 ? f.firstBelow + 1 : null }; } catch(e){}
    try { const d = mgDecisions(); out.waiting_on_you = { count:d.length, top:d.slice(0, 4).map(x => ({ what:x.t, detail:x.s, amount:vxInr(x.amt) })) }; } catch(e){}
    try { const d = mgDisagreements(); if(d.length) out.sources_disagree = d.slice(0, 3).map(x => ({ what:x.t, detail:x.s, gap:vxInr(x.amt) })); } catch(e){}
    out.connected_sources = ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo', 'shopify'].map(k => ({ k, h:mgSourceHealth(k) })).filter(x => x.h.on)
      .map(x => MG_SRC_LABEL[x.k] + ' (' + x.h.text + (x.h.warn ? ', needs attention' : '') + ')');
    return out;
  },

  query_parties({ direction, search, overdue_only, min_days_overdue, sort, limit }){
    const dir = VX_DIR[direction]; if(!dir) return { error:'direction must be receivables or payables' };
    let groups = vxGroups(dir);
    if(search){ const m = groups.map(g => ({ g, s:vxScoreName(search, g.party) })).filter(x => x.s >= 0.5); groups = m.sort((a, b) => b.s - a.s).map(x => x.g); }
    if(overdue_only) groups = groups.filter(g => (g.overdue || 0) > 0);
    if(min_days_overdue) groups = groups.filter(g => g.oldestDays != null && -g.oldestDays >= Number(min_days_overdue));
    const key = sort === 'overdue' ? (g => g.overdue || 0) : sort === 'oldest' ? (g => g.oldestDays == null ? -1e9 : -g.oldestDays) : (g => g.amount);
    if(!search) groups = groups.slice().sort((a, b) => key(b) - key(a));
    const n = Math.max(1, Math.min(25, Number(limit) || 8));
    return { matching:vxTotals(groups), rows:groups.slice(0, n).map(vxPartyRow), more:Math.max(0, groups.length - n),
      note:groups.length ? null : 'Nothing matches. ' + (search ? 'The name may have been mis-heard; ask them to spell it or try one distinctive word.' : '') };
  },

  open_party({ direction, name }){
    let dir = VX_DIR[direction] || 'recv';
    let f = vxFindParty(dir, name);
    if(!f.best){   // they may have the direction wrong ("open Sharma" when Sharma is a vendor): just open the right one
      const other = dir === 'recv' ? 'pay' : 'recv', f2 = vxFindParty(other, name);
      if(f2.best){ f = f2; dir = other; }
    }
    if(!f.best){
      // Someone in the customer/vendor master with nothing open (a vendor just added, say): open their record.
      const m = vxFindMaster(name);
      if(m){
        vxDrive(() => mgOpenMasterParty(m.id));
        vxActivity('Opened ' + m.name);
        return { found:true, shown_in_side_panel:true, name:m.name, type:m.type, open_items:0, gstin:m.gstin || null, phone:m.phone || null,
          note:'They have no open invoices or bills; their record is open in the side panel.' };
      }
      return { found:false, note:'Nobody called "' + name + '" among customers, vendors or open items. The name may have been mis-heard: ask them to spell it.' };
    }
    if(!f.confident) return { found:false, did_you_mean:[f.best.party, ...f.others], note:'More than one close match; ask which one.' };
    const g = f.best;
    vxDrive(() => mgOpenParty(dir, g.key));
    vxActivity('Opened ' + g.party);
    const rows = g.by[g.primary].rows.slice().sort((a, b) => (a.days ?? 9e9) - (b.days ?? 9e9));
    let activity = 0; try { activity = (ledgerEvents || []).filter(e => normPartyName(e.party_name) === g.key).length; } catch(e){}
    return Object.assign(vxPartyRow(g), {
      found:true, shown_in_side_panel:true,
      items:rows.slice(0, 10).map(r => ({ ref:r.ref || null, amount:vxInr(r.amount), amount_inr:Math.round(r.amount), days_to_due:r.days })),
      by_source:g.sources.map(s => ({ source:MG_SRC_NAME[s], amount:vxInr(g.by[s].amount) })), activity_entries:activity
    });
  },

  filter_list({ direction, search, age, view }){
    const dir = VX_DIR[direction]; if(!dir) return { error:'direction must be receivables or payables' };
    const page = direction;
    vxDrive(() => {
      if(typeof search === 'string'){
        // Spoken names: filter by the closest real name, not the mis-heard one.
        const f = search.trim() ? vxFindParty(dir, search) : null;
        mgMoneyQ = f && f.best && f.confident ? f.best.party : search.trim();
      }
      if(age && age in VX_AGE) mgMoneyAge = VX_AGE[age];
      if(view) mgMoneySrc = view;
      if(mgCurrentView !== page) showView(page); else { mgRenderOwn(page); mgRefreshScope(); mgWriteHash(false); }
    });
    const host = document.getElementById('view-' + page);
    const rows = (host && host.__rows) || [];
    setTimeout(() => vxSpot(host && host.querySelector('tr.mg-click')), 120);
    vxActivity(vxLabel(page) + (mgMoneyQ ? ' · "' + mgMoneyQ + '"' : '') + (mgMoneyAge ? ' · ' + VX_AGE_BACK[mgMoneyAge] + ' days' : ''));
    return { ok:true, filter:{ search:mgMoneyQ || null, age:mgMoneyAge ? VX_AGE_BACK[mgMoneyAge] : 'all' }, rows_shown:rows.length,
      total_shown:vxInr(rows.reduce((t, r) => t + r.amount, 0)), top:rows.slice(0, 6).map(r => ({ name:r.party, amount:vxInr(r.amount), days_to_due:r.days })) };
  },

  get_cash(){
    const out = {};
    try {
      const srcs = mgCashSources();
      out.by_source = srcs.map(x => ({ source:MG_SRC_NAME[x.src] || x.src, cash:vxInr(x.total), cash_inr:Math.round(x.total), as_of:x.asOf ? fmtDay(x.asOf) : null }));
      if(srcs.length > 1){
        const v = srcs.map(x => x.total), spread = Math.max(...v) - Math.min(...v);
        out.agreement = spread <= Math.max(1, Math.max(...v) * 0.02) ? 'sources agree (verified)' : 'sources differ by ' + vxInr(spread) + ' (usually uncleared items); Margyn uses ' + (MG_SRC_NAME[srcs[0].src] || srcs[0].src);
      }
      if(srcs.borrowing && srcs.borrowing.length) out.borrowing = srcs.borrowing.map(b => ({ account:b.name, balance:vxInr(b.balance) }));
      if(!srcs.length) out.note = 'No cash figure from any source yet.';
    } catch(e){}
    try { const t = mgCashTransit(); if(t) out.in_transit_from_gateways = { total:vxInr(t.total), settling:vxInr(t.settling), captured_not_yet_settled:vxInr(t.captured) }; } catch(e){}
    try {
      const f = mgForecast();
      if(f) out.forecast_13_weeks = {
        opening:vxInr(f.opening), lowest:vxInr(f.min), lowest_in_week:f.minWeek + 1, floor:vxInr(f.floor),
        drops_below_floor_in_week:f.firstBelow >= 0 ? f.firstBelow + 1 : null,
        week_by_week_close_inr:f.close.map(Math.round), assumptions:mgForecastSentence(f)
      };
    } catch(e){}
    return out;
  },

  get_gst(){
    const s = (snapshots || [])[0] || null;
    let z = null; try { z = zohoConnected && zohoVitals ? zohoVitals : null; } catch(e){}
    const g = z && z.gst_leakage ? z.gst_leakage : null;
    const out = { gst_payable_this_month:s ? vxInr(s.gst_payable) : null };
    if(g){
      out.itc_at_risk = vxInr(g.total_leakage); out.vendors_not_filed = g.vendors_not_filed || 0;
      out.share_of_itc_at_risk_pct = g.leakage_pct != null ? Number(g.leakage_pct).toFixed(1) : null; out.filing_period = g.filing_period || null;
      out.vendors_behind_it = ((z.gst_top_at_risk_vendors) || []).slice(0, 8).map(v => ({ vendor:v.vendor_name, at_risk:vxInr(v.at_risk) }));
      out.source = 'GSTR-2B against Zoho Books';
    } else {
      out.itc_at_risk = s ? vxInr(s.gst_leak) : null;
      out.note = 'Vendor-level GST needs Zoho Books connected; this is the self-reported figure.';
    }
    let acts = []; try { acts = ((agentActions && agentActions.actions) || []).filter(a => a.kind === 'itc_risk'); } catch(e){}
    if(acts.length) out.proposals_waiting = acts.map(a => ({ what:a.title, amount:vxInr(a.amount) }));
    return out;
  },

  get_inbox(){
    const out = {};
    try { out.agent_proposals = ((agentActions && agentActions.actions) || []).slice(0, 10).map(a => ({ what:a.title, kind:(typeof AGENT_KIND_LABEL !== 'undefined' && AGENT_KIND_LABEL[a.kind]) || a.kind, amount:vxInr(a.amount), confidence_pct:a.confidence != null ? Math.round(a.confidence * 100) : null, why:a.rationale || null })); } catch(e){ out.agent_proposals = []; }
    try { out.payments_to_review = ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).slice(0, 8).map(q => ({ customer:q.customer_name, reason:q.reason, invoice:q.invoice_number, amount:vxInr(q.amount) })); } catch(e){ out.payments_to_review = []; }
    try { out.forwarded_documents = (pendingSuggestions || []).slice(0, 8).map(p => { const e = (p.proposal && p.proposal.entries) || []; return { from:p.from_phone ? waPrettyPhone(p.from_phone) : null, party:(e[0] || {}).party || null, figures:e.length, total:vxInr(e.reduce((t, x) => t + (Number(x.amount) || 0), 0)) }; }); } catch(e){ out.forwarded_documents = []; }
    try { out.being_chased = (chaseTargets || []).filter(t => ['active', 'paused_promise', 'disputed', 'escalated_human'].includes(t.state)).slice(0, 10).map(t => ({ customer:t.party_name, amount:vxInr(t.amount), state:String(t.state).replace(/_/g, ' '), reminders_sent:t.chases_sent || 0, next_reminder:t.next_chase_at ? fmtDay(t.next_chase_at) : null })); } catch(e){ out.being_chased = []; }
    try { const d = (typeof agentDeployments !== 'undefined' && agentDeployments.chase_agent) || null; out.chase_agent = d ? d.status : 'not set up'; } catch(e){}
    out.total_waiting = out.agent_proposals.length + out.payments_to_review.length + out.forwarded_documents.length;
    return out;
  },

  show_table({ title, columns, rows, note }){
    const cols = Array.isArray(columns) ? columns.slice(0, 8) : [];
    const body = (Array.isArray(rows) ? rows : []).slice(0, 40);
    vxAddCard('<h4>' + escapeHtml(title || 'Data') + '</h4><div class="vx-tablewrap"><table><thead><tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead><tbody>' +
      body.map(r => '<tr>' + (Array.isArray(r) ? r : [r]).slice(0, 8).map(v => '<td>' + escapeHtml(String(v)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
      (note ? '<div class="vx-note">' + escapeHtml(note) + '</div>' : ''));
    return { shown:true };
  },

  show_chart({ title, kind, labels, series, unit, note }){
    const ls = (Array.isArray(labels) ? labels : []).slice(0, 26).map(String);
    const ss = (Array.isArray(series) ? series : []).slice(0, 3).filter(x => x && Array.isArray(x.values));
    if(!ls.length || !ss.length) return { shown:false, error:'labels and series are required' };
    const card = vxAddCard('<h4>' + escapeHtml(title || 'Chart') + '</h4><div class="vx-chart"><canvas></canvas></div>' + (note ? '<div class="vx-note">' + escapeHtml(note) + '</div>' : ''));
    return { shown:vxDrawChart(card.querySelector('canvas'), { kind, labels:ls, series:ss, unit }) };
  },

  /* The rich path: name a view and the app draws it from live data. Cheaper
     than show_table/show_chart (the model doesn't read every figure out) and
     can't misquote a number. Returns a short spoken-ready summary. */
  show_view({ view, direction, name }){
    const f = VX_VIEWS[view];
    if(!f) return { shown:false, error:'Unknown view ' + view };
    try { return Object.assign({ shown:true, where:'workspace' }, f({ direction, name })); }
    catch(e){ console.error('[voice] view ' + view, e); return { shown:false, error:'Could not draw that view.' }; }
  },

  clear_workspace(){ vxClearWorkspace(); return { cleared:true }; },

  show_note({ title, text }){
    const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean).slice(0, 14);
    if(!lines.length) return { shown:false, error:'text is empty' };
    let html = '', list = [];
    const flush = () => { if(list.length){ html += '<ul class="vx-ul">' + list.map(l => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>'; list = []; } };
    lines.forEach(l => { if(/^[-•*]\s+/.test(l)) list.push(l.replace(/^[-•*]\s+/, '')); else { flush(); html += '<p class="vx-p">' + escapeHtml(l) + '</p>'; } });
    flush();
    vxAddCard('<h4>' + escapeHtml(title || 'Note') + '</h4>' + html, 'vx-view', 'note:' + String(title || '').toLowerCase().slice(0, 40));
    return { shown:true, where:'workspace' };
  },

  async sync_source({ source }){
    const run = {
      zoho:    () => zohoConnected ? zohoApi('/api/zoho?action=sync', { method:'POST', body:JSON.stringify({ mode:'delta' }) }).then(() => loadZohoVitals()) : null,
      odoo:    () => odooConnected ? zohoApi('/api/zoho?action=odoo-sync', { method:'POST', body:JSON.stringify({}) }).then(() => loadOdooStatus()) : null,
      shopify: () => shopifyConnected ? shopifyApi('/api/shopify?action=sync', { method:'POST', body:JSON.stringify({}) }).then(() => loadShopifyStatus()) : null
    }[source];
    if(!run) return { synced:false, reason:'Only Zoho Books, Odoo and Shopify can be synced from here. Tally syncs from its desktop agent; Razorpay and Cashfree sync every night.' };
    let p; try { p = run(); } catch(e){ p = Promise.reject(e); }
    if(!p) return { synced:false, reason:(MG_SRC_LABEL[source] || source) + ' is not connected. They can connect it on the Organisations and sources page.' };
    vxActivity('Syncing ' + (MG_SRC_LABEL[source] || source) + '…');
    const label = MG_SRC_LABEL[source] || source;
    try {
      await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('still running')), 25000))]);
      await refreshAll();
      vxActivity(label + ' synced');
      return { synced:true, finished:true, status:mgSourceHealth(source).text || 'synced just now', note:'The sync has FINISHED and figures are refreshed. Say it is done. Re-check anything you quoted before.' };
    } catch(e){
      const still = e && e.message === 'still running';
      if(still){
        // Say so the moment it lands, instead of the user having to ask
        // "did the sync complete?" three times.
        p.then(() => refreshAll()).then(() => {
          vxActivity(label + ' synced');
          vxTellModel('The ' + label + ' sync you started has now finished and the figures are refreshed. Tell the user in one short sentence.', true);
        }).catch(err => vxTellModel('The ' + label + ' sync you started failed' + (err && err.message ? ' (' + String(err.message).slice(0, 80) + ')' : '') + '. Tell the user in one short sentence.', true));
      }
      return { synced:false, still_running:still, reason:still ? 'Still running in the background. The app will tell you the moment it finishes; say that you will let them know, and do not claim it is done.' : 'The sync failed' + (e && e.message ? ' (' + String(e.message).slice(0, 80) + ')' : '') + '. If it keeps failing, they may need to reconnect on the Organisations and sources page.' };
    }
  },

  /* "Is my Zoho connector working?" — instant, from what the app already has. */
  // Waits for the Margin figures instead of answering "still loading": on 1 Oct a first-time
  // "what are my top margin products?" got "the margin view isn't available".
  async get_margin(){
    if(typeof mgLoadMargin === 'function' && !mgMar){
      if(!mgMarBusy) mgLoadMargin();
      for(let i = 0; i < 60 && !mgMar && (mgMarBusy || i < 3); i++) await new Promise(r => setTimeout(r, 300));
    }
    const d = typeof mgMar !== 'undefined' ? mgMar : null;
    if(!d) return { loading:true, note:'Margin didn\u2019t load. Use the products tool for item margins, or books_summary for profit.' };
    if(!d.connected) return { connected:false, note:'Tally is not connected, so margin can\'t be worked out.' };
    const base = (typeof mgMarginForAsk === 'function' && mgMarginForAsk()) || {};
    return Object.assign(base, {
      company:d.company_name,
      slowest_payers:(d.customers || []).filter(c => c.outstanding > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 5)
        .map(c => ({ customer:c.party, owed:vxInr(c.outstanding), overdue:vxInr(c.overdue), days_to_pay:c.dso_days, cost_of_waiting_pct:c.credit_cost_pct_of_sales })),
      top_items_by_sales:(d.items || []).slice(0, 5).map(i => ({ item:i.item, sales:vxInr(i.sold_value), margin_pct:i.est_margin_pct, flags:i.flags })),
      top_items_by_margin_pct:(d.items || []).filter(i => i.est_margin_pct != null && i.sold_value >= 10000).sort((a, b) => b.est_margin_pct - a.est_margin_pct).slice(0, 5).map(i => ({ item:i.item, sales:vxInr(i.sold_value), margin_pct:i.est_margin_pct })),
      more:'For any product, customer, month or ledger detail, call the books tools (products, customer_or_vendor, books_breakdown).',
      latest_months:(d.pnl || []).slice(-3).map(r => ({ month:r.month, net_sales:vxInr(r.net_sales), gross_margin_pct:r.gross_margin_pct_pre_stock, in_progress:r.provisional })),
      note:'Single source (Tally): call these signals. Gross margin is before stock movement unless stated.'
    });
  },

  get_sources(){
    const keys = ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo', 'shopify'];
    const rows = keys.map(k => { const h = mgSourceHealth(k); return { source:MG_SRC_LABEL[k], connected:!!h.on, status:h.text || null, needs_attention:!!h.warn }; });
    return { sources:rows, can_sync_from_here:['Zoho Books', 'Odoo', 'Shopify'],
      note:'Working = connected and synced within the last two days. "Reconnect needed" or an old sync means it needs attention.' };
  },

  /* Fill the form that is open (New customer/vendor, or the Ledger add form). */
  fill_form({ fields }){
    const f = vxOpenForm();
    if(!f) return { ok:false, error:'No form is open. Open one first: run_command add_party (customer/vendor) or add_receivable / add_payable (ledger entry).' };
    const src = fields && typeof fields === 'object' ? fields : {};
    const filled = [], skipped = [];
    const put = (el, val) => {
      if(!el) return false;
      if(el.tagName === 'SELECT'){
        const want = String(val).toLowerCase();
        const o = [...el.options].find(x => x.value.toLowerCase() === want || x.textContent.toLowerCase() === want) || [...el.options].find(x => x.value && x.textContent.toLowerCase().startsWith(want));
        if(!o) return false;
        el.value = o.value;
      } else el.value = String(val).slice(0, 400);
      el.dispatchEvent(new Event('input', { bubbles:true }));   // GSTIN fills state and PAN itself
      el.dispatchEvent(new Event('change', { bubbles:true }));
      return true;
    };
    Object.keys(src).forEach(k => {
      let v = src[k]; if(v == null || v === '') return;
      if(k === 'phone') v = String(v).replace(/[^\d+]/g, '');
      if(k === 'gstin' || k === 'pan') v = String(v).replace(/\s+/g, '').toUpperCase();
      let el = null;
      if(f.kind === 'party') el = VX_FORM_KEYS[k] ? f.form.elements[VX_FORM_KEYS[k]] : null;
      else el = document.getElementById({ party:'ledgerParty', name:'ledgerParty', amount:'ledgerAmt', due_date:'ledgerDue' }[k] || '_');
      if(put(el, v)) filled.push(k); else skipped.push(k);
    });
    const firstEl = filled.length && (f.kind === 'party' ? f.form.elements[filled[0]] : null);
    if(firstEl) vxSpot(firstEl);
    vxActivity('Filled ' + filled.join(', '));
    return { ok:filled.length > 0, form:f.title, filled, skipped, now:vxFormValues(f),
      note:'Read back anything that matters (a phone number digit by digit if they want) and ask if you should save. Nothing is saved until save_form.' };
  },

  /* Press Save on the open form, when the user asked for it. */
  async save_form(){
    const f = vxOpenForm();
    if(!f || !f.save) return { ok:false, error:'No form is open to save.' };
    const said = (vxUtterances[vxUtterances.length - 1] || {}).text || '';
    const recent = vxUtterances.filter(u => Date.now() - u.at < 20000).map(u => u.text).join(' ');
    if(!VX_SAVE_WORDS.test(recent) || VX_NO.test(said)) return { ok:false, needs_ok:true, reason:'Ask them "Shall I save it?" and wait for a yes.' };
    const before = vxFormValues(f);
    f.save.click();
    await new Promise(r => setTimeout(r, 1400));
    const still = vxOpenForm();
    if(f.kind === 'party' && still && still.kind === 'party'){
      const msg = (mgDrawerEl.querySelector('.mg-pf-msg') || {}).textContent || '';
      return { ok:false, saved:false, message:msg || 'The form is still open.', note:'Tell them what the form says. If it offers "Save anyway" for a similar name, ask before saving again.' };
    }
    if(f.kind === 'ledger' && (document.getElementById('ledgerAmt') || {}).value) return { ok:false, saved:false, note:'The entry was not added; the form still has its values. Check the amount and party.' };
    vxActivity('Saved');
    return { ok:true, saved:true, what:before };
  },

  async think({ question }){
    vxSetState('thinking', 'Thinking it through');
    try {
      const data = await Promise.race([
        callAskMargyn(String(question || '').slice(0, 1800), vxThinkHistory.slice(-4), null, null, 'margyn', 'balanced'),
        // Past 6s the call carries on and this answer is spoken when it lands
        // (vxRunTool), so it gets real time instead of being thrown away at 30s.
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 75000))
      ]);
      const reply = (data && data.reply) || '';
      vxThinkHistory.push({ role:'user', content:question }, { role:'assistant', content:reply });
      if(data && data.actionCard && data.actionCard.type){
        const r = vxShowActionCard(data.actionCard, question);
        return { answer:reply.slice(0, 1500), change_card_shown:true, card:r };
      }
      return { answer:reply.slice(0, 1500) || 'No answer came back.', note:'Speak this in your own words, briefly. Keep every figure exactly as given.' };
    } catch(e){
      return { error:e.message === 'timeout' ? 'The deeper analysis took too long.' : (e.message || 'Could not reach the analyst.') };
    }
  },

  run_command({ command, name, party_type }){
    const go = p => vxDrive(() => showView(p));
    const fill = (id, v) => { const el = document.getElementById(id); if(el && v) el.value = String(v).slice(0, 120); return el; };
    switch(command){
      case 'export_current_view': {
        const b = document.getElementById('mgExport-' + mgCurrentView) || document.querySelector('#view-' + mgCurrentView + ' [id^="mgExport"]');
        if(!b) return { ok:false, error:'This page has no export. Receivables, payables, customers and vendors do.' };
        b.click(); vxActivity('Exported ' + vxLabel(mgCurrentView)); return { ok:true, note:'CSV download started.' };
      }
      case 'new_invoice': go('invoicing'); if(typeof showKhataTab === 'function') showKhataTab('invoice-new'); vxActivity('New invoice'); return { ok:true, note:'The new invoice form is open for them to fill in.' };
      case 'add_receivable':
      case 'add_payable': {
        // Opens the Ledger's own add form (not just the page), name filled in if said.
        ledgerActiveTab = command === 'add_payable' ? 'payables' : 'receivables';
        ledgerAddOpen = true;
        go('ledger');
        const f = fill('ledgerParty', name);
        if(f) setTimeout(() => { vxSpot(document.getElementById('ledgerAddForm')); (name ? document.getElementById('ledgerAmt') || f : f).focus(); }, 80);
        vxActivity(command === 'add_payable' ? 'Add payable' : 'Add receivable');
        return { ok:true, form_open:!!f, note:'The Ledger add form is open' + (name ? ' with "' + name + '" filled in' : '') + '. Fill the amount and due date they say with fill_form and add it with save_form when they ask, or prepare it with propose_change.' };
      }
      case 'add_party': {
        // A new customer or vendor record: the Customers / Vendors page's own form.
        const vendor = party_type === 'vendor';
        go(vendor ? 'vendors' : 'customers');
        if(typeof mgPartyForm !== 'function') return { ok:false, error:'The party form is not available.' };
        mgPartyForm({ dir:vendor ? 'pay' : 'recv', name:name || '', source:'margyn' });
        vxActivity(vendor ? 'New vendor' : 'New customer');
        return { ok:true, form_open:true, note:'The New ' + (vendor ? 'vendor' : 'customer') + ' form is open' + (name ? ' with "' + name + '" filled in' : '') + '. They can add GSTIN (state and PAN fill themselves), phone, email and address, then press Save. Fill anything they tell you (phone, GSTIN, email, address) with fill_form, and when they ask you to save, call save_form. Do not say it is saved before save_form says so.' };
      }
      case 'upload_file': go('calculate'); return { ok:true, note:'Import page open. They can drop any Excel, CSV, PDF or photo and Margyn will map it.' };
      case 'build_chart': go('analytics'); setTimeout(() => { const b = document.getElementById('analyticsNewBtn'); if(b) b.click(); }, 80); return { ok:true };
      case 'print_cfo_pack': {
        go('cfopack');
        const b = document.querySelector('#view-cfopack [data-pk-print]');
        if(!b) return { ok:false, error:'The CFO pack is not ready yet.' };
        b.click(); return { ok:true, note:'Print window opened; they choose Save as PDF.' };
      }
      case 'refresh_data': vxActivity('Refreshing data'); return refreshAll().then(() => ({ ok:true, as_of:mgAsOf() })).catch(e => ({ ok:false, error:e.message }));
      case 'close_side_panel': mgCloseDrawer(); return { ok:true };
      case 'open_command_palette': cmdkOpen(); return { ok:true };
    }
    return { ok:false, error:'Unknown command' };
  },

  async propose_change({ request }){
    vxSetState('thinking', 'Preparing the change');
    try {
      let data = await callAskMargyn(String(request || '').slice(0, 1800), [], null, null, 'margyn', 'quick');
      // The orchestrator may hand a collections/reconciliation request to a
      // specialist; follow it once, silently (one voice: Margyn).
      if(data && !data.actionCard && data.handoff && data.handoff.agentId) data = await callAskMargyn(String(request).slice(0, 1800), [], null, null, data.handoff.agentId, 'quick');
      if(data && data.actionCard && data.actionCard.type) return vxShowActionCard(data.actionCard, request);
      return { status:'not_proposed', reason:(data && data.reply) || 'Could not work out a specific change from that.' };
    } catch(e){
      return { status:'error', reason:e.message || 'Could not reach Margyn to check that.' };
    }
  },

  async confirm_pending_change({ decision }){
    const p = vxPending;
    if(!p) return { applied:false, error:'There is no change card waiting.' };
    if(decision === 'cancel'){ vxResolveCard(p, 'Cancelled.'); return { applied:false, cancelled:true }; }
    if(!p.voiceOk) return { applied:false, needs_tap:true, reason:'This one messages a customer or touches several items, so it needs a tap on Confirm.' };
    // The gate: the user's own words, spoken or typed after the card appeared.
    const said = await vxAwaitUtteranceAfter(p.shownAt, 4000);
    if(!said) return { applied:false, needs_tap:true, reason:'I did not catch a clear yes. Ask them to say yes again, or tap Confirm.' };
    if(VX_NO.test(said) || !VX_YES.test(said)) return { applied:false, reason:'What they said ("' + said.slice(0, 80) + '") was not a clear yes. Ask again.' };
    if(p.card.dataset.vxBusy) return { applied:false, error:'Already applying.' };
    // Tapped Confirm while we waited for their words: it's already done, don't apply twice.
    if(vxPending !== p || p.card.querySelector('.action-card-done')) return { applied:true, summary:p.action.humanSummary || null, note:'They tapped Confirm; it is already done.' };
    p.card.dataset.vxBusy = '1';
    p.card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const btn = p.card.querySelector('.action-confirm'); if(btn) btn.textContent = 'Applying…';
    try {
      await runProposedAction(p.action);
      vxResolveCard(p, 'Done, confirmed by voice ("' + said.slice(0, 60) + '").', true);
      vxPersist('assistant', '[Applied] ' + (p.action.humanSummary || p.action.type));
      const who = p.action.payload && (p.action.payload.party_name || p.action.payload.party || p.action.payload.name);
      return { applied:true, summary:p.action.humanSummary || null, party:who || null,
        next:'To show what was created, call show_view with view "party" (or open_party) for ' + (who ? '"' + who + '"' : 'that party') + '.' };
    } catch(e){
      delete p.card.dataset.vxBusy;
      p.card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if(btn) btn.textContent = 'Confirm';
      return { applied:false, error:e.message || 'It failed.' };
    }
  },

  /* "Scroll down", "go to the bottom", "show me the forecast section". The
     side panel scrolls when it's open, otherwise the page. */
  scroll({ direction, to }){
    const drawer = typeof mgDrawerEl !== 'undefined' && mgDrawerEl ? [...mgDrawerEl.querySelectorAll('*')].find(x => x.scrollHeight > x.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(x).overflowY)) : null;
    const wrap = document.querySelector('.app-body .wrap');
    const box = drawer || (wrap && wrap.scrollHeight > wrap.clientHeight + 20 ? wrap : document.scrollingElement);
    const page = drawer || document.getElementById('view-' + mgCurrentView) || document.body;
    if(to){
      const want = String(to).toLowerCase().trim();
      const el = [...page.querySelectorAll('h1, h2, h3, h4, .mg-panel-h, .mgd-sec, th, .mg-tile-l, .rd-head, label')]
        .find(x => x.offsetParent && x.textContent.toLowerCase().includes(want));
      if(!el) return { ok:false, note:'Nothing called "' + to + '" on this page. Headings here: ' + vxHeadings(page).join(', ') };
      el.scrollIntoView({ behavior:'smooth', block:'start' }); vxSpot(el.closest('.mg-panel') || el);
      vxActivity('Scrolled to ' + el.textContent.trim().slice(0, 40));
      return { ok:true, scrolled_to:el.textContent.trim().slice(0, 60) };
    }
    const d = direction || 'down', h = box.clientHeight || window.innerHeight;
    const top = d === 'top' ? 0 : d === 'bottom' ? box.scrollHeight : box.scrollTop + (d === 'up' ? -0.8 : 0.8) * h;
    box.scrollTo({ top, behavior:'smooth' });
    vxActivity('Scrolled ' + d);
    const end = top + h >= box.scrollHeight - 4 ? 'at the bottom' : top <= 0 ? 'at the top' : 'part way down';
    return { ok:true, now:end, in_view:vxHeadings(page, box, top) };
  },

  /* "Close this", "close that window", "band kar do": whatever is on top,
     or the thing they named. Dialogs and pop-ups first, then the side panel,
     then the newest card in the conversation. The page (go back) and the
     Margyn panel only when they ask for those. */
  close({ target }){
    const t = target || 'top';
    const hidden = el => !el || el.classList.contains('hidden');
    const steps = {
      dialog(){
        const d = document.querySelector('.mg-dialog-scrim .mg-dlg-cancel'); if(d){ d.click(); return 'the dialog (nothing was confirmed)'; }
        const w = document.querySelector('.mg-wn-scrim [data-wn-ok]'); if(w){ w.click(); return 'the What’s new card'; }
        const o = [...document.querySelectorAll('.detail-overlay')].find(x => !hidden(x)); if(o){ o.classList.add('hidden'); return 'the detail window'; }
        const a = document.getElementById('agentOverlay'); if(a && !hidden(a)){ a.classList.add('hidden'); return 'the settings window'; }
        const k = document.querySelector('.cmdk:not(.hidden)'); if(k){ cmdkClose(); return 'search'; }
        const pop = document.querySelector('.mg-pop.open'); if(pop){ mgCloseAllPops(); return 'the menu'; }
        return null;
      },
      side_panel(){
        if(typeof mgDrawerEl !== 'undefined' && mgDrawerEl){ const h = mgDrawerEl.querySelector('h3'); const what = h ? h.textContent : 'the side panel'; mgCloseDrawer(); return what + ' (side panel)'; }
        if(typeof ledgerAddOpen !== 'undefined' && ledgerAddOpen){ ledgerAddOpen = false; if(typeof renderLedgerView === 'function') renderLedgerView(); return 'the add-entry form'; }
        return null;
      },
      card(){
        const cards = vxCards().filter(c => !c.classList.contains('vx-old') && !(vxPending && vxPending.card === c));
        const c = cards[cards.length - 1]; if(!c) return null;
        const h = c.querySelector('h4'); c.remove(); return (h ? h.textContent : 'the card') + ' (in the conversation)';
      },
      page(){
        if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'home') return null;
        const from = vxLabel(mgCurrentView);
        vxDrive(() => { if(history.length > 1) history.back(); else showView('home'); });
        return 'the ' + from + ' page (went back)';
      },
      margyn(){
        if(typeof vxActive !== 'undefined' && vxActive){ window.__mgrCloseAfterCall = true; vxEndAfterSpeech(); return 'the Margyn panel, after your goodbye'; }
        if(typeof mgrClose === 'function'){ mgrClose(); return 'the Margyn panel'; }
        return null;
      }
    };
    let closed = null;
    if(t === 'top'){ for(const k of ['dialog', 'side_panel', 'card']){ closed = steps[k](); if(closed) break; } }
    else if(steps[t]) closed = steps[t]();
    else return { closed:null, error:'Unknown target ' + t };
    if(!closed) return { closed:null, note:t === 'top' ? 'Nothing is open on top of the page. Ask whether they mean the page they are on (target "page") or the Margyn panel (target "margyn").' : 'That isn’t open.' };
    vxActivity('Closed ' + closed.replace(/ \(.*\)$/, ''));
    return { closed, note:t === 'margyn' && vxActive ? 'Say a two-word goodbye; the call ends and the panel closes.' : 'Closed. Say so in a few words.' };
  },


  /* ---------- explaining like an accountant (2026-10-03) ----------
     "How is runway calculated?", "why is my score 59?", "where does this cash
     figure come from?": the formula from MG_FORMULAS (app/js/margyn-formulas.js,
     the same text WhatsApp uses) plus the live inputs from the current
     reading, each with its source and how much it can be trusted, and the
     sum worked through with the app's own functions, so the explanation can
     never disagree with the screen. */
  explain({ figure }){
    const F = typeof MG_FORMULAS !== 'undefined' ? MG_FORMULAS : null;
    if(!F) return { error:'Explanations aren’t loaded yet.' };
    const key = F.find(figure);
    if(!key) return { found:false, how_margyn_works:F.howTopic(figure).text, figures_i_can_explain:F.KEYS.map(k => F.FIGURES[k].label) };
    const e = F.FIGURES[key], out = Object.assign({ found:true }, F.describe(key));
    const s = (typeof snapshots !== 'undefined' && snapshots[0]) || null;
    if(!s){ out.live = 'There is no reading yet, so no live figures to plug in. Connect a source or add figures first.'; return out; }
    out.reading_as_of = fmtDate(s.created_at);
    const v = k => Number(s[INPUT_COLUMN[k]]) || 0;
    // Where each input came from: saved on the reading; older readings didn't save it, so work it out the way the score does.
    let prov = s.input_provenance || null;
    if(!prov){ try { prov = resolveSnapshotInputs().provenance; } catch(err){ prov = {}; } }
    const SRCN = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', self:'typed in', manual:'typed in' };
    const TRUST = { verified:'verified: sources agree', connector:'one source (a signal)', self:'self-reported' };
    const NAME = { cash:'Cash', revenue:'Monthly revenue', netProfit:'Monthly net profit', burn:'Monthly spend', gstLeak:'ITC at risk', gstPayable:'GST payable', recvTotal:'Receivables', recv90:'Receivables over 90 days', paySoon:'Bills due in 30 days' };
    out.inputs = (e.inputs || []).filter(k => INPUT_COLUMN[k]).map(k => {
      const p = prov[INPUT_COLUMN[k]];
      return { input:NAME[k], value:vxInr(v(k)), from:p ? (SRCN[p.source] || p.source) + (p.agree ? ', matches ' + p.agree.map(x => SRCN[x] || x).join(' and ') : '') : 'not recorded on this reading', trust:p ? TRUST[p.tier] || p.tier : null };
    });
    const clash = (s.source_conflicts || []).filter(c => (e.inputs || []).some(k => INPUT_COLUMN[k] === c.field));
    if(clash.length) out.sources_disagree = clash.map(c => ({ input:c.field, used:SRCN[c.chosen] || c.chosen, gap_pct:c.spread_pct, values:Object.fromEntries(Object.entries(c.values || {}).map(([k, x]) => [SRCN[k] || k, vxInr(x)])) }));
    const w = e.weight && VITAL_WEIGHTS[e.weight];
    const stored = e.weight ? mgVital(s, e.weight) : null;
    const months = n => (Math.round(n * 10) / 10) + ' months';
    try {
      switch(key){
        case 'pulse_score': {
          const vit = Array.isArray(s.vitals) ? s.vitals : [];
          out.worked = vit.map(x => x.label + ': score ' + Math.round(x.score) + ' × ' + Math.round((VITAL_WEIGHTS[x.label] || 0) * 100) + '% = ' + (Math.round(x.score * (VITAL_WEIGHTS[x.label] || 0) * 10) / 10) + ' points');
          out.result = 'Total ' + s.pulse_score + ' out of 100 (' + scoreBand(s.pulse_score).label + ')';
          const low = vit.slice().sort((a, b) => a.score - b.score)[0];
          if(low) out.biggest_drag = low.label + ' at ' + Math.round(low.score) + ' (' + vxVitalValue(low.value) + ')';
          break;
        }
        case 'cash_vital': { const r = scoreCash(v('cash'), v('burn')); out.worked = vxInr(v('cash')) + ' ÷ ' + vxInr(v('burn')) + ' a month = ' + vxVitalValue(r.value) + ' → score ' + Math.round(r.score); break; }
        case 'receivables_vital': { const r = scoreReceivables(v('recvTotal'), v('recv90')); const sh = v('recvTotal') > 0 ? Math.round(v('recv90') / v('recvTotal') * 1000) / 10 : 0; out.worked = vxInr(v('recv90')) + ' over 90 days ÷ ' + vxInr(v('recvTotal')) + ' = ' + sh + '% stale → 100 − (' + sh + ' ÷ 30) × 100 → score ' + Math.round(r.score); break; }
        case 'payables_vital': { const r = scorePayables(v('paySoon'), v('cash')); const ra = v('cash') > 0 ? Math.round(v('paySoon') / v('cash') * 1000) / 10 + '%' : 'no cash'; out.worked = vxInr(v('paySoon')) + ' due ÷ ' + vxInr(v('cash')) + ' cash = ' + ra + ' → score ' + Math.round(r.score); break; }
        case 'gst_vital': { const r = scoreGst(v('gstLeak'), v('gstPayable')); out.worked = vxInr(v('gstLeak')) + ' at risk ÷ ' + vxInr(v('gstPayable')) + ' payable → score ' + Math.round(r.score); break; }
        case 'margin_vital': { const r = scoreMargin(v('netProfit'), v('revenue')); out.worked = vxInr(v('netProfit')) + ' ÷ ' + vxInr(v('revenue')) + ' = ' + r.value + ' → score ' + Math.round(r.score); break; }
        case 'runway': {
          const wc = v('cash') + v('recvTotal') - v('paySoon'), r = scoreRunway(v('cash'), v('recvTotal'), v('paySoon'), v('burn'));
          out.worked = '(' + vxInr(v('cash')) + ' cash + ' + vxInr(v('recvTotal')) + ' owed to you − ' + vxInr(v('paySoon')) + ' due in 30 days) = ' + vxInr(wc) + ', ÷ ' + vxInr(v('burn')) + ' a month = ' + vxVitalValue(r.value) + ' → score ' + Math.round(r.score);
          const gross = metricValue('grossRunway', s), net = metricValue('netRunway', s);
          out.other_views = 'Cash alone ÷ spend = ' + (gross == null ? 'n/a' : months(gross)) + '; net runway (spend less revenue) = ' + (net == null ? 'not burning: revenue covers spend' : months(net));
          break;
        }
        case 'cash': {
          const t = typeof tallyLiquidLedgers === 'function' ? tallyLiquidLedgers() : null;
          if(t && t.liquid.length){
            out.ledgers_counted = t.liquid.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).slice(0, 8).map(x => x.name + ' (' + x.parent + '): ' + vxInr(x.balance));
            if(t.borrow.length) out.left_out_as_borrowing = t.borrow.slice(0, 5).map(x => x.name + ': ' + vxInr(x.balance) + ' owed');
            if(t.inverted) out.sign_note = 'This Tally export shows bank balances with the opposite sign, so Margyn flipped them.';
          }
          out.result = vxInr(v('cash'));
          break;
        }
        case 'burn': case 'revenue': case 'net_profit': case 'gross_margin': {
          const pnl = ((typeof mgMar !== 'undefined' && mgMar && mgMar.pnl) || []).filter(r => !r.provisional && !r.partial_start && Number(r.net_sales) > 0).slice(-6);
          if(pnl.length) out.months_used = pnl.map(r => r.month + ': sales ' + vxInr(r.net_sales) + ', direct cost ' + vxInr(r.cogs_pre_stock) + ', gross ' + r.gross_margin_pct_pre_stock + '%, running cost ' + vxInr(r.opex) + ', profit ' + vxInr(r.net_profit_pre_stock) + (r.costs_incomplete ? ' (costs not fully booked: left out of the average)' : ''));
          else out.months_used = 'Margin data is still loading or Tally isn’t connected; the figure on the reading is used.';
          if(key !== 'gross_margin') out.result = vxInr(v(key === 'net_profit' ? 'netProfit' : key));
          break;
        }
        case 'gst_payable': { out.result = vxInr(v('gstPayable')); const g = (typeof mgMar !== 'undefined' && mgMar && mgMar.gst_estimate) || []; if(g.length) out.months = g.slice(-3).map(x => x.month + ': ' + vxInr(x.net_payable_estimate)); break; }
        case 'receivables': case 'payables': {
          const dir = key === 'receivables' ? 'recv' : 'pay', groups = mgMoneyGroups(dir);
          const per = {}; groups.forEach(g => g.sources.forEach(src => { per[src] = (per[src] || 0) + g.by[src].amount; }));
          out.result = vxInr(groups.reduce((t, g) => t + g.amount, 0)) + ' across ' + groups.length + (dir === 'recv' ? ' customers' : ' vendors');
          out.each_source_own_total = Object.fromEntries(Object.entries(per).map(([k, x]) => [(MG_SRC_LABEL[k] || k), vxInr(x)]));
          out.parties = { in_one_source:groups.filter(g => g.status === 'single').length, sources_agree:groups.filter(g => g.status === 'agree').length, sources_disagree:groups.filter(g => g.status === 'conflict').length };
          if(dir === 'recv') out.ageing = vxMoneySummary('recv').ageing;
          const note = typeof mgPosNote === 'function' ? mgPosNote(dir) : ''; if(note) out.coverage_note = note;
          break;
        }
        case 'forecast': {
          const f = mgForecast(); if(!f) break;
          out.worked = { starting_cash:vxInr(f.opening), lowest:vxInr(f.min) + ' in week ' + (f.minWeek + 1), week_13:vxInr(f.close[12]), floor:vxInr(f.floor), first_week_below_floor:f.firstBelow >= 0 ? f.firstBelow + 1 : 'none', left_out_as_doubtful:vxInr(f.doubtful), due_after_13_weeks:vxInr(f.beyond) };
          out.assumptions_in_use = { collection_delay_days:f.st.collectDelay, doubtful_after_days:f.st.doubtfulAfter, new_sales_monthly:vxInr(f.st.salesMonthly) + ' from week ' + f.st.salesStart, spend_not_in_bills_monthly:vxInr(f.st.fixedMonthly), new_bills_monthly:vxInr(f.st.billsMonthly) + ' from week ' + f.st.billsStart, gst_monthly:vxInr(f.st.gstMonthly) };
          break;
        }
        case 'dso': ['dso', 'dpo', 'ccc'].forEach(m => { const x = metricValue(m, s); out[m] = x == null ? 'n/a' : Math.round(x) + ' days'; }); break;
        case 'working_capital': ['workingCapital', 'quickRatio', 'cashCover'].forEach(m => { const x = metricValue(m, s); out[m] = x == null ? 'n/a' : (METRICS[m].unit === 'inr' ? vxInr(x) : (Math.round(x * 100) / 100) + '×'); }); break;
        case 'capital_readiness': { const c = computeFinancingEligibility(); out.worked = c ? vxInr(v('revenue')) + ' a month × ' + (s.pulse_score >= 70 ? 3 : s.pulse_score >= 40 ? 2 : 1) + ' (Pulse Score ' + s.pulse_score + ') → ' + vxInr(c.low) + ' to ' + vxInr(c.high) : 'Needs a reading with monthly revenue.'; break; }
        case 'payments': ['payGross', 'payNet', 'mdrPct', 'failRate', 'settleLag'].forEach(m => { const x = metricValue(m, s); if(x != null) out[METRICS[m].label] = METRICS[m].unit === 'inr' ? vxInr(x) : METRICS[m].unit === 'pct' ? (Math.round(x * 10) / 10) + '%' : Math.round(x * 10) / 10 + ' ' + METRICS[m].unit; }); break;
        case 'recovered': out.result = vxCompact(vxChannelSummary(), 900); break;
        case 'cfo_pack': out.month = vxPackSummary(); break;
      }
    } catch(err){ console.error('[voice] explain ' + key, err); }
    if(stored && w) out.in_pulse_score = 'This vital scores ' + Math.round(stored.score) + ' and carries ' + Math.round(w * 100) + '% of the Pulse Score, so it adds ' + (Math.round(stored.score * w * 10) / 10) + ' points.';
    return out;
  },

  how_margyn_works({ topic }){
    const F = typeof MG_FORMULAS !== 'undefined' ? MG_FORMULAS : null;
    if(!F) return { error:'Not loaded yet.' };
    const h = F.howTopic(topic);
    return { topic:h.topic, answer:h.text, other_topics:Object.keys(F.HOW).filter(k => k !== h.topic) };
  },

  /* Press a button, tab or link the user can see, by its words: "click Save as
     PDF", "open the Tally tab", "show more". Anything that changes data or
     sends something is refused here and goes through propose_change /
     save_form and the confirm card, as always. */
  press({ label }){
    const want = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if(!want) return { pressed:false, error:'Say which button.' };
    const text = el => (el.getAttribute('aria-label') || el.textContent || el.title || '').replace(/\s+/g, ' ').trim();
    const scopes = [document.querySelector('.mg-dialog-scrim'), typeof mgDrawerEl !== 'undefined' ? mgDrawerEl : null,
      document.getElementById('view-' + mgCurrentView) || document.querySelector('.view:not(.hidden)'), document.querySelector('.app-body')].filter(Boolean);
    let hit = null;
    for(const sc of scopes){
      const els = [...sc.querySelectorAll('button, [role="button"], [role="tab"], a[href], summary, .mg-seg button, [data-go-page]')]
        .filter(el => el.offsetParent && !el.disabled && !el.closest('#mgRail') && text(el));
      hit = els.find(el => text(el).toLowerCase() === want) || els.find(el => text(el).toLowerCase().startsWith(want)) || els.find(el => text(el).toLowerCase().includes(want));
      if(hit) break;
    }
    if(!hit) return { pressed:false, note:'No button called "' + label + '" on screen.', buttons_on_screen:vxButtons() };
    const name = text(hit);
    if(!VX_PRESS_OK.test(name) && VX_PRESS_NO.test(name)) return { pressed:false, refused:name, reason:'That one changes data or sends something. Prepare it with propose_change (or save_form for an open form) so they confirm on the card, or ask them to tap it.' };
    vxDrive(() => hit.click());
    vxSpot(hit); vxActivity('Pressed ' + name.slice(0, 40));
    return { pressed:name.slice(0, 60), now_on:vxLabel(mgCurrentView), note:/print|pdf/i.test(name) ? 'The browser’s print window is open. They pick "Save as PDF" as the printer and press Save there; that window is the browser’s, so you can’t press it for them.' : null };
  },

  end_conversation(){ vxEndAfterSpeech(); return { ok:true }; }
};

const VX_YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|confirmed|proceed|please do|haan|haa|han|haanji|hanji|ji|theek hai|thik hai|thik|kar do|kardo|kar dijiye|karo|chalo|bilkul|sahi hai|done|approve|approved)\b/i;
const VX_NO = /\b(no|nope|nah|nahi|nahin|mat|don't|dont|do not|cancel|wait|ruko|stop|hold on|not yet)\b/i;

/* ---------- change cards ---------- */
let vxPending = null;
function vxShowActionCard(action, request){
  if(vxPending) vxResolveCard(vxPending, 'Replaced by a newer request.');
  const voiceOk = !VX_TAP_ONLY.includes(action.type);
  const card = vxAddCard('<h4>Needs your OK</h4><div class="vx-note">You asked: “' + escapeHtml(String(request || '').slice(0, 160)) + '”</div>' +
    '<div class="vx-action">' + actionCardHtml(action) + '</div>' +
    '<div class="vx-note vx-how">' + (voiceOk ? 'Say “yes” or tap Confirm. Nothing changes until you do.' : 'Tap Confirm to go ahead. This one needs a tap because it ' + (action.type === 'send_one_off_chase' ? 'messages your customer' : 'acts on several items') + '.') + '</div>', 'vx-change');
  const inner = card.querySelector('.action-card');
  const p = { action, card, voiceOk, shownAt:Date.now() };
  vxPending = p;
  if(inner){
    wireActionCardConfirm(inner, action);
    // A tap goes through wireActionCardConfirm as in typed chat; watch for its
    // outcome so Margyn can acknowledge it out loud.
    inner.querySelector('.action-cancel') && inner.querySelector('.action-cancel').addEventListener('click', () => { if(vxPending === p){ vxPending = null; vxTellModel('The user tapped Cancel on the change card. Nothing was changed.', true); } });
    const mo = new MutationObserver(() => {
      if(card.querySelector('.action-card-done') && !card.dataset.vxBusy){
        mo.disconnect();
        if(vxPending === p) vxPending = null;
        card.classList.add('vx-done');
        const h = card.querySelector('h4'); if(h) h.textContent = 'Done';
        const how = card.querySelector('.vx-how'); if(how) how.remove();
        vxRetireCard(card);
        vxPersist('assistant', '[Applied by tap] ' + (action.humanSummary || action.type));
        vxTellModel('The user tapped Confirm and the change was applied: ' + (action.humanSummary || action.type) + '. Acknowledge in a few words.', true);
      }
    });
    mo.observe(card, { childList:true, subtree:true });
  }
  vxActivity('Change ready for your OK');
  return { status:'awaiting_confirmation', summary:action.humanSummary || null, can_confirm_by_voice:voiceOk,
    say:voiceOk ? 'Read the summary back in one sentence and ask if you should go ahead.' : 'Read the summary back and ask them to tap Confirm on the card.' };
}
function vxResolveCard(p, text, ok){
  if(vxPending === p) vxPending = null;
  const h = p.card.querySelector('h4'); if(h) h.textContent = ok ? 'Done' : 'Not applied';
  const a = p.card.querySelector('.vx-action');
  if(a) a.innerHTML = '<div class="vx-summary">' + escapeHtml(p.action.humanSummary || '') + '</div><div class="action-card-done">' + escapeHtml(text) + '</div>';
  const how = p.card.querySelector('.vx-how'); if(how) how.remove();
  p.card.classList.add(ok ? 'vx-done' : 'vx-void');
  vxRetireCard(p.card);
}
/* A settled change card has nothing left to do: let it go after a few seconds
   so "Needs your OK" never lingers in the workspace. */
function vxRetireCard(card){
  setTimeout(() => {
    if(!card.parentNode || (vxPending && vxPending.card === card)) return;
    card.remove();
    const f = vxFeed(); if(f && !f.children.length) vxDeskOpen(false);
  }, 6000);
}

/* ---------- workspace views (show_view) ---------- */
function vxDrawChart(canvas, { kind, labels, series, unit, floor, colors }){
  if(!window.Chart || !canvas) return false;
  const css = getComputedStyle(document.documentElement);
  const col = [css.getPropertyValue('--emerald').trim() || '#0E8F5C', '#0B4B8C', css.getPropertyValue('--orange').trim() || '#CC5B34'];
  const fmt = v => unit === 'percent' ? v + '%' : unit === 'number' ? Number(v).toLocaleString('en-IN') : fmtINR(v, 'tile');
  const line = kind === 'line';
  const sets = series.map((x, i) => ({ label:x.name, data:x.values.slice(0, labels.length).map(Number),
    backgroundColor:colors && !line ? colors : (line && i === 0 ? 'rgba(14,143,92,.10)' : col[i]), borderColor:col[i], fill:line && i === 0 && series.length === 1,
    borderWidth:line ? 2 : 0, borderRadius:4, pointRadius:line ? 0 : 0, tension:0.3, maxBarThickness:30 }));
  if(floor != null) sets.push({ label:'Floor', data:labels.map(() => floor), borderColor:'#B3432E', borderDash:[4, 4], borderWidth:1.5, pointRadius:0, fill:false, type:'line' });
  new Chart(canvas, {
    type:line ? 'line' : 'bar',
    data:{ labels, datasets:sets },
    options:{ responsive:true, maintainAspectRatio:false, animation:{ duration:450 }, interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ display:sets.length > 1, labels:{ boxWidth:10, font:{ size:11 } } }, tooltip:{ callbacks:{ label:c => c.dataset.label + ': ' + fmt(c.parsed.y) } } },
      scales:{ x:{ grid:{ display:false }, ticks:{ font:{ size:10.5 }, maxRotation:0, autoSkip:true } }, y:{ grid:{ color:'rgba(20,24,31,.06)' }, ticks:{ font:{ size:10.5 }, callback:fmt, maxTicksLimit:5 }, border:{ display:false } } } }
  });
  return true;
}
function vxR1(v){ return v == null ? null : +v.toFixed(1); }
function vxPct(now, prev){ now = Number(now); prev = Number(prev); return (!isFinite(now) || !isFinite(prev) || !prev) ? null : (now - prev) / Math.abs(prev) * 100; }
function vxKpi(label, value, delta, goodUp){
  const d = delta == null ? '' : '<i class="' + ((delta >= 0) === (goodUp !== false) ? 'up' : 'down') + '">' + (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(delta).toFixed(1) + '% vs last</i>';
  return '<div class="vx-kpi"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b>' + d + '</div>';
}
function vxTableHtml(cols, rows){
  return '<div class="vx-tablewrap"><table><thead><tr>' + cols.map(c => '<th' + (c.r ? ' class="r"' : '') + '>' + escapeHtml(typeof c === 'object' ? (c.t || '') : c) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + r.cells.map((v, i) => '<td' + ((cols[i] && cols[i].r) || v && v.cls ? ' class="' + [(cols[i] && cols[i].r) ? 'r' : '', v && v.cls || ''].join(' ').trim() + '"' : '') + '>' + escapeHtml(v && v.t !== undefined ? v.t : String(v)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
function vxMore(page, label){ return '<div class="vx-more"><button type="button" data-vx-go="' + page + '">' + escapeHtml(label) + ' →</button></div>'; }
function vxViewCard(key, title, sub, body){ return vxAddCard('<h4>' + escapeHtml(title) + '</h4>' + (sub ? '<div class="vx-sub">' + escapeHtml(sub) + '</div>' : '') + body, 'vx-view', key); }
function vxMonth(iso){ try { return new Date(iso).toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', month:'short' }); } catch(e){ return ''; } }
function vxDue(days){ return days == null ? 'no due date' : days < 0 ? (-days) + 'd overdue' : days === 0 ? 'due today' : 'due in ' + days + 'd'; }

const VX_VIEWS = {
  mismatches(){
    const rows = [], out = [];
    [['recv', 'Customer'], ['pay', 'Vendor']].forEach(([dir, who]) => vxGroups(dir).filter(g => g.status === 'conflict').forEach(g => {
      rows.push({ cells:[g.party, who, g.sources.map(x => (MG_SRC_NAME[x] || x) + ' ' + vxInr(g.by[x].amount)).join(' · '), { t:vxInr(g.diff), cls:'neg' }] });
      out.push({ name:g.party, kind:who.toLowerCase(), by_source:g.sources.map(x => (MG_SRC_NAME[x] || x) + ' ' + vxInr(g.by[x].amount)).join(', '), gap:vxInr(g.diff), margyn_uses:MG_SRC_NAME[g.primary] || g.primary });
    }));
    try {
      const c = snapshots[0] && snapshots[0].source_conflicts;
      (Array.isArray(c) ? c : []).forEach(x => {
        const vals = x.values || {}, nums = Object.values(vals).map(Number).filter(isFinite);
        const label = (typeof CONFLICT_FIELD_LABEL !== 'undefined' && CONFLICT_FIELD_LABEL[x.field]) || x.field || 'Figure';
        const by = Object.keys(vals).map(k => ((typeof SOURCE_DISPLAY !== 'undefined' && SOURCE_DISPLAY[k]) || k) + ' ' + vxInr(vals[k])).join(' · ');
        const gap = nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0;
        rows.push({ cells:[label, 'Figure', by, { t:vxInr(gap), cls:'neg' }] });
        out.push({ name:label, kind:'figure', by_source:by, gap:vxInr(gap) });
      });
    } catch(e){}
    vxViewCard('mismatches', 'Where your sources disagree', rows.length ? rows.length + ' item' + (rows.length === 1 ? '' : 's') + ' · Margyn uses the stronger source and never averages' : 'Everything that appears in two sources agrees within 2%',
      rows.length ? vxTableHtml([{ t:'Who / what' }, { t:'Type' }, { t:'Each source says' }, { t:'Gap', r:1 }], rows.slice(0, 12)) + vxMore('books', 'Compare in the Ledger') : '<div class="vx-note">No disagreements right now.</div>');
    return { count:out.length, items:out.slice(0, 8), tolerance:'2% or ₹1' };
  },
  pnl(){
    const snaps = (snapshots || []).slice(0, 6), s = snaps[0], p = snaps[1];
    if(!s) return { shown:false, note:'No P&L yet: connect Zoho Books or Tally, or enter figures.' };
    const margin = x => Number(x.revenue) ? Number(x.net_profit) / Number(x.revenue) * 100 : null;
    let z = null; try { z = zohoConnected && zohoVitals && zohoVitals.net_margin ? zohoVitals.net_margin : null; } catch(e){}
    const rows = [
      { cells:['Revenue', vxInr(s.revenue), p ? vxInr(p.revenue) : '—'] },
      ...(z ? [{ cells:['Cost of goods (' + (z.period || 'Zoho') + ')', vxInr(z.cogs), '—'] }, { cells:['Operating expenses (' + (z.period || 'Zoho') + ')', vxInr(z.opex), '—'] }] : [{ cells:['Total spend', vxInr(s.burn), p ? vxInr(p.burn) : '—'] }]),
      { cls:'tot', cells:['Net profit', { t:vxInr(s.net_profit), cls:Number(s.net_profit) < 0 ? 'neg' : '' }, p ? vxInr(p.net_profit) : '—'] },
      { cells:['GST payable', vxInr(s.gst_payable), p ? vxInr(p.gst_payable) : '—'] }
    ];
    const hist = snaps.slice().reverse();
    const card = vxViewCard('pnl', 'Profit and loss', mgAsOf() + (z ? ' · COGS and opex from Zoho Books' : ''),
      '<div class="vx-kpis">' + vxKpi('Revenue', vxInr(s.revenue), p ? vxPct(s.revenue, p.revenue) : null) + vxKpi('Net profit', vxInr(s.net_profit), p ? vxPct(s.net_profit, p.net_profit) : null) +
        vxKpi('Net margin', margin(s) == null ? '—' : margin(s).toFixed(1) + '%', null) + '</div>' +
      (hist.length > 1 ? '<div class="vx-chart"><canvas></canvas></div>' : '') +
      vxTableHtml([{ t:'' }, { t:'This month', r:1 }, { t:'Last month', r:1 }], rows) + vxMore('analytics', 'Open Reports'));
    if(hist.length > 1) vxDrawChart(card.querySelector('canvas'), { kind:'bar', labels:hist.map(x => vxMonth(x.created_at)), series:[{ name:'Revenue', values:hist.map(x => Number(x.revenue) || 0) }, { name:'Net profit', values:hist.map(x => Number(x.net_profit) || 0) }] });
    return { revenue:vxInr(s.revenue), net_profit:vxInr(s.net_profit), net_margin_pct:margin(s) == null ? null : +margin(s).toFixed(1),
      revenue_change_pct:p && !s.pl_in_progress ? vxR1(vxPct(s.revenue, p.revenue)) : null, month_in_progress:!!s.pl_in_progress, profit_change_pct:p ? vxR1(vxPct(s.net_profit, p.net_profit)) : null,
      cogs:z ? vxInr(z.cogs) : null, opex:z ? vxInr(z.opex) : null, months_charted:hist.length, as_of:mgAsOf() };
  },
  receivables(){ return vxMoneyView('recv'); },
  payables(){ return vxMoneyView('pay'); },
  cash(){
    const c = VX_TOOLS.get_cash(), srcs = (function(){ try { return mgCashSources(); } catch(e){ return []; } })();
    let f = null; try { f = mgForecast(); } catch(e){}
    const card = vxViewCard('cash', 'Cash', (c.agreement || '') + (c.agreement ? ' · ' : '') + mgAsOf(),
      '<div class="vx-kpis">' + vxKpi('Cash now', srcs[0] ? vxInr(srcs[0].total) : '—') + vxKpi('Lowest, next 13 wks', f ? vxInr(f.min) : '—') +
        vxKpi(f && f.firstBelow >= 0 ? 'Below floor from' : 'Floor', f ? (f.firstBelow >= 0 ? 'week ' + (f.firstBelow + 1) : vxInr(f.floor)) : '—') + '</div>' +
      (f ? '<div class="vx-chart"><canvas></canvas></div>' : '') +
      (srcs.length ? vxTableHtml([{ t:'Source' }, { t:'Balance', r:1 }, { t:'As of' }], srcs.map(x => ({ cells:[MG_SRC_NAME[x.src] || x.src, vxInr(x.total), x.asOf ? fmtDay(x.asOf) : '—'] }))) : '') +
      (c.in_transit_from_gateways ? '<div class="vx-note">Plus ' + escapeHtml(c.in_transit_from_gateways.total) + ' in transit from payment gateways.</div>' : '') + vxMore('cash', 'Open Cash'));
    if(f) vxDrawChart(card.querySelector('canvas'), { kind:'line', labels:f.close.map((_, i) => 'W' + (i + 1)), series:[{ name:'Closing cash', values:f.close }], floor:f.floor });
    const out = Object.assign({}, c); if(out.forecast_13_weeks) delete out.forecast_13_weeks.week_by_week_close_inr;
    return out;
  },
  forecast(){ return VX_VIEWS.cash(); },
  gst(){
    const g = VX_TOOLS.get_gst();
    vxViewCard('gst', 'GST and input credit', g.source || 'Self-reported', '<div class="vx-kpis">' + vxKpi('GST payable', g.gst_payable_this_month || '—') + vxKpi('Credit at risk', g.itc_at_risk || '—') +
      vxKpi('Vendors not filed', g.vendors_not_filed != null ? String(g.vendors_not_filed) : '—') + '</div>' +
      ((g.vendors_behind_it || []).length ? vxTableHtml([{ t:'Vendor' }, { t:'At risk', r:1 }], g.vendors_behind_it.map(v => ({ cells:[v.vendor, v.at_risk] }))) : '<div class="vx-note">' + escapeHtml(g.note || 'No vendor has credit at risk.') + '</div>') + vxMore('gst', 'Open GST'));
    return g;
  },
  inbox(){
    const b = VX_TOOLS.get_inbox();
    const rows = [...(b.agent_proposals || []).map(a => ({ cells:[a.what, a.amount] })), ...(b.payments_to_review || []).map(q => ({ cells:[(q.customer || 'Payment') + ': ' + (q.reason || 'review'), q.amount] })),
      ...(b.forwarded_documents || []).map(d => ({ cells:['Forwarded' + (d.party ? ': ' + d.party : ''), d.total] }))].slice(0, 8);
    vxViewCard('inbox', 'Waiting on you', b.total_waiting + ' item' + (b.total_waiting === 1 ? '' : 's'), rows.length ? vxTableHtml([{ t:'What' }, { t:'Amount', r:1 }], rows) + vxMore('inbox', 'Open Inbox') : '<div class="vx-note">Nothing is waiting on you.</div>');
    return { total_waiting:b.total_waiting, top:rows.slice(0, 3).map(r => r.cells[0]), being_chased:(b.being_chased || []).length };
  },
  overview(){
    const o = VX_TOOLS.get_overview();
    vxViewCard('overview', 'How the business is doing', o.as_of, '<div class="vx-kpis">' + vxKpi('Pulse Score', o.pulse_score != null ? String(o.pulse_score) : '—') +
      vxKpi('Owed to you', o.receivables.total) + vxKpi('You owe', o.payables.total) + '</div>' +
      vxTableHtml([{ t:'Vital' }, { t:'Now', r:1 }, { t:'Score', r:1 }], (o.vitals || []).map(v => ({ cells:[v.vital, String(v.value), v.score_out_of_100 == null ? '—' : String(v.score_out_of_100)] }))) + vxMore('home', 'Open Home'));
    delete o.connected_sources; return o;
  },
  cfopack(){
    const s = vxPackSummary();
    if(!s.cfo_pack_for_month || s.revenue === undefined) return Object.assign({ shown:false }, s);
    const rows = [['Cash at month end', s.cash_at_month_end, s.cash_change_pct == null ? '—' : (s.cash_change_pct >= 0 ? '+' : '') + s.cash_change_pct + '%'],
      ['Revenue', s.revenue, s.revenue_change_pct == null ? '—' : (s.revenue_change_pct >= 0 ? '+' : '') + s.revenue_change_pct + '%'],
      ['Net profit', s.net_profit, s.net_margin_pct == null ? '—' : s.net_margin_pct + '% margin'],
      ['Monthly spend', s.monthly_spend, '—'], ['GST payable', s.gst_payable, '—'],
      ['Pulse Score', s.pulse_score == null ? 'n/a' : String(s.pulse_score), s.pulse_change_on_prior_month == null ? (s.pulse_band || '—') : (s.pulse_change_on_prior_month > 0 ? '+' : '') + s.pulse_change_on_prior_month + ' pts']];
    vxViewCard('cfopack', 'CFO pack · ' + s.cfo_pack_for_month, 'The same figures as the pack', vxTableHtml([{ t:'' }, { t:'Value', r:1 }, { t:'vs prior month', r:1 }], rows.map(r => ({ cells:r }))) + vxMore('cfopack', 'Open the CFO pack'));
    return s;
  },
  party({ direction, name }){
    const dir = VX_DIR[direction] || 'recv';
    const f = vxFindParty(dir, name || '');
    if(!f.best) return { shown:false, note:'No ' + (dir === 'recv' ? 'customer' : 'vendor') + ' matches "' + name + '". Try the other direction.' };
    if(!f.confident) return { shown:false, did_you_mean:[f.best.party, ...f.others] };
    const g = f.best, row = vxPartyRow(g), items = g.by[g.primary].rows.slice().sort((a, b) => (a.days ?? 9e9) - (b.days ?? 9e9));
    vxViewCard('party:' + g.key, g.party, (dir === 'recv' ? 'Customer' : 'Vendor') + ' · ' + row.agreement,
      '<div class="vx-kpis">' + vxKpi(dir === 'recv' ? 'Owes you' : 'You owe', row.outstanding) + vxKpi('Overdue', vxInr(g.overdue || 0)) + vxKpi('Open items', String(g.invoices)) + '</div>' +
      vxTableHtml([{ t:'Reference' }, { t:'Status' }, { t:'Amount', r:1 }], items.slice(0, 8).map(r => ({ cells:[r.ref || (r.due ? 'Due ' + fmtDay(r.due) : (MG_SRC_NAME[r.src] || 'Entry')), { t:vxDue(r.days), cls:r.days != null && r.days < 0 ? 'neg' : '' }, vxInr(r.amount)] }))) +
      (g.sources.length > 1 ? '<div class="vx-note">' + escapeHtml(g.sources.map(x => MG_SRC_NAME[x] + ' ' + vxInr(g.by[x].amount)).join(' · ')) + '</div>' : ''));
    return Object.assign(row, { items:items.slice(0, 5).map(r => ({ ref:r.ref, amount:vxInr(r.amount), status:vxDue(r.days) })) });
  }
};
function vxMoneyView(dir){
  const groups = vxGroups(dir), t = vxTotals(groups), recv = dir === 'recv';
  const b = { b0:0, b1:0, b2:0, b3:0 };
  groups.forEach(g => g.by[g.primary].rows.forEach(r => { b[mgBucketOf(r.days)] += r.amount; }));
  const top = groups.slice().sort((x, y) => y.amount - x.amount).slice(0, 6);
  const card = vxViewCard(recv ? 'receivables' : 'payables', recv ? 'Receivables' : 'Payables', t.parties + (recv ? ' customers' : ' vendors') + ' · reconciled across sources',
    '<div class="vx-kpis">' + vxKpi(recv ? 'Owed to you' : 'You owe', t.total) + vxKpi('Overdue', t.overdue) + vxKpi('Over 90 days', vxInr(b.b3)) + '</div>' +
    '<div class="vx-chart" style="height:150px"><canvas></canvas></div>' +
    vxTableHtml([{ t:recv ? 'Customer' : 'Vendor' }, { t:'Oldest' }, { t:'Amount', r:1 }], top.map(g => ({ cells:[g.party, { t:vxDue(g.oldestDays), cls:g.oldestDays != null && g.oldestDays < 0 ? 'neg' : '' }, vxInr(g.amount)] }))) +
    vxMore(recv ? 'receivables' : 'payables', 'Open the full list'));
  vxDrawChart(card.querySelector('canvas'), { kind:'bar', labels:['0–30', '31–60', '61–90', '90+'], series:[{ name:'Amount', values:[b.b0, b.b1, b.b2, b.b3] }], colors:['#0E8F5C', '#9A6A00', '#C77A2E', '#B3432E'] });
  return Object.assign(t, { ageing:{ '0-30':vxInr(b.b0), '31-60':vxInr(b.b1), '61-90':vxInr(b.b2), '90+':vxInr(b.b3) }, top:top.slice(0, 3).map(g => ({ name:g.party, amount:vxInr(g.amount), oldest:vxDue(g.oldestDays) })) });
}
/* "Open the full list →" in a workspace card is the user's own click. */
document.addEventListener('click', e => { const b = e.target.closest('[data-vx-go]'); if(b) mgGo(b.dataset.vxGo); });

/* The books tools (api/_lib/booksTools.js) run on the server, through ?action=books: the same
   engine typed chat and WhatsApp use, reading every Tally entry rather than what the page loaded. */
const VX_BOOK_TOOLS = ['books_summary', 'books_breakdown', 'customer_or_vendor', 'products', 'money_owed', 'find_entries', 'cash_and_loans', 'what_needs_attention'];
async function vxBooks(tool, input){
  const { data:{ session } } = await sbClient.auth.getSession();
  const res = await fetch('/api/ask-margyn?action=books', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', ...(session ? { 'Authorization':'Bearer ' + session.access_token } : {}) },
    body:JSON.stringify({ tool, input:input || {} })
  });
  if(!res.ok) return { error:'Couldn’t read the books just now. Try again in a moment.' };
  return res.json();
}
VX_BOOK_TOOLS.forEach(t => { VX_TOOLS[t] = (input) => vxBooks(t, input); });
