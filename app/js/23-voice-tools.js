/* ============================================================
   VOICE TOOLS — what Margyn can do on a live call (22-realtime-voice.js).
   Tool schemas live in api/ask-margyn.js (REALTIME_TOOLS); each one runs
   here, in the browser, against what the app has already loaded for this
   signed-in user. So every figure Margyn says is the figure on screen, and
   a voice session can reach nothing the user's own session can't.

   Three kinds of tool:
     - screen: navigate, filter_list, open_party, run_command, show_* —
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
    if(page === 'home') return VX_TOOLS.get_overview();
  } catch(e){ console.error('[voice] summary', page, e); }
  return { about:(MG_PAGES[page] && MG_PAGES[page].sub) || null };
}

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
    return { ok:true, now_showing:vxLabel(page), view:mgCurrentSource(page) || null, on_this_page:vxPageSummary(page) };
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
      if(rows) out.rows_on_screen = rows.slice(0, 12).map(r => ({ name:r.party, amount:vxInr(r.amount), amount_inr:Math.round(r.amount), days_to_due:r.days, ref:r.ref }));
    }
    const d = document.querySelector('.mg-drawer h3');
    if(d) out.side_panel_open_for = d.textContent;
    out.summary = vxPageSummary(page);
    return out;
  },

  get_overview(){
    const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
    const out = { as_of:mgAsOf(), organisation:mgOrgName() };
    if(s){
      out.pulse_score = s.pulse_score != null ? s.pulse_score : null;
      if(p && p.pulse_score != null && s.pulse_score != null) out.pulse_change_since_last = s.pulse_score - p.pulse_score;
      out.vitals = (s.vitals || []).map(v => ({ vital:mgVitalName(v.label), value:v.value, score_out_of_100:v.score != null ? Math.round(v.score) : null }));
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
    const dir = VX_DIR[direction]; if(!dir) return { error:'direction must be receivables or payables' };
    let f = vxFindParty(dir, name);
    if(!f.best){   // they may have the direction wrong ("open Sharma" when Sharma is a vendor)
      const other = dir === 'recv' ? 'pay' : 'recv', f2 = vxFindParty(other, name);
      if(f2.best) return { found:false, note:f2.best.party + ' is a ' + (other === 'recv' ? 'customer (receivables)' : 'vendor (payables)') + ', not a ' + (dir === 'recv' ? 'customer' : 'vendor') + '. Call again with that direction.' };
      return { found:false, note:'No ' + (dir === 'recv' ? 'customer' : 'vendor') + ' with an open item matches "' + name + '".' };
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
    const ss = (Array.isArray(series) ? series : []).slice(0, 3).filter(s => s && Array.isArray(s.values));
    if(!ls.length || !ss.length) return { shown:false, error:'labels and series are required' };
    const card = vxAddCard('<h4>' + escapeHtml(title || 'Chart') + '</h4><div class="vx-chart"><canvas></canvas></div>' + (note ? '<div class="vx-note">' + escapeHtml(note) + '</div>' : ''));
    if(!window.Chart) return { shown:false, error:'Charts unavailable' };
    const css = getComputedStyle(document.documentElement);
    const col = [css.getPropertyValue('--emerald').trim() || '#0E8F5C', '#0B4B8C', css.getPropertyValue('--orange').trim() || '#CC5B34'];
    const fmt = v => unit === 'percent' ? v + '%' : unit === 'number' ? Number(v).toLocaleString('en-IN') : fmtINR(v, 'tile');
    new Chart(card.querySelector('canvas'), {
      type:kind === 'line' ? 'line' : 'bar',
      data:{ labels:ls, datasets:ss.map((s, i) => ({ label:s.name, data:s.values.slice(0, ls.length).map(Number), backgroundColor:col[i], borderColor:col[i], borderWidth:kind === 'line' ? 2 : 0, borderRadius:4, pointRadius:kind === 'line' ? 2 : 0, tension:0.25, maxBarThickness:28 })) },
      options:{ responsive:true, maintainAspectRatio:false, animation:{ duration:500 },
        plugins:{ legend:{ display:ss.length > 1, labels:{ boxWidth:10, font:{ size:11 } } }, tooltip:{ callbacks:{ label:c => c.dataset.label + ': ' + fmt(c.parsed.y) } } },
        scales:{ x:{ grid:{ display:false }, ticks:{ font:{ size:10.5 }, maxRotation:0, autoSkip:true } }, y:{ grid:{ color:'rgba(20,24,31,.06)' }, ticks:{ font:{ size:10.5 }, callback:fmt }, border:{ display:false } } } }
    });
    return { shown:true };
  },

  async think({ question }){
    vxSetState('thinking', 'Thinking it through');
    try {
      const data = await Promise.race([
        callAskMargyn(String(question || '').slice(0, 1800), vxThinkHistory.slice(-6), null, null, 'margyn'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      ]);
      const reply = (data && data.reply) || '';
      vxThinkHistory.push({ role:'user', content:question }, { role:'assistant', content:reply });
      if(data && data.actionCard && data.actionCard.type){
        const r = vxShowActionCard(data.actionCard, question);
        return { answer:reply.slice(0, 2400), change_card_shown:true, card:r };
      }
      return { answer:reply.slice(0, 2400) || 'No answer came back.', note:'Speak this in your own words, briefly. Keep every figure exactly as given.' };
    } catch(e){
      return { error:e.message === 'timeout' ? 'The deeper analysis took too long.' : (e.message || 'Could not reach the analyst.') };
    }
  },

  run_command({ command }){
    const go = p => vxDrive(() => showView(p));
    switch(command){
      case 'export_current_view': {
        const b = document.getElementById('mgExport-' + mgCurrentView) || document.querySelector('#view-' + mgCurrentView + ' [id^="mgExport"]');
        if(!b) return { ok:false, error:'This page has no export. Receivables, payables, customers and vendors do.' };
        b.click(); vxActivity('Exported ' + vxLabel(mgCurrentView)); return { ok:true, note:'CSV download started.' };
      }
      case 'new_invoice': go('invoicing'); if(typeof showKhataTab === 'function') showKhataTab('invoice-new'); vxActivity('New invoice'); return { ok:true, note:'The new invoice form is open for them to fill in.' };
      case 'add_receivable': ledgerActiveTab = 'receivables'; go('ledger'); return { ok:true, note:'Ledger open on receivables. You can also create it for them with propose_change.' };
      case 'add_payable': ledgerActiveTab = 'payables'; go('ledger'); return { ok:true, note:'Ledger open on payables. You can also create it for them with propose_change.' };
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
      let data = await callAskMargyn(String(request || '').slice(0, 1800), [], null, null, 'margyn');
      // The orchestrator may hand a collections/reconciliation request to a
      // specialist; follow it once, silently (one voice: Margyn).
      if(data && !data.actionCard && data.handoff && data.handoff.agentId) data = await callAskMargyn(String(request).slice(0, 1800), [], null, null, data.handoff.agentId);
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
    p.card.dataset.vxBusy = '1';
    p.card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const btn = p.card.querySelector('.action-confirm'); if(btn) btn.textContent = 'Applying…';
    try {
      await runProposedAction(p.action);
      vxResolveCard(p, 'Done, confirmed by voice ("' + said.slice(0, 60) + '").', true);
      vxPersist('assistant', '[Applied] ' + (p.action.humanSummary || p.action.type));
      return { applied:true, summary:p.action.humanSummary || null };
    } catch(e){
      delete p.card.dataset.vxBusy;
      p.card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if(btn) btn.textContent = 'Confirm';
      return { applied:false, error:e.message || 'It failed.' };
    }
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
}
