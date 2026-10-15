/* ============================================================
   REPORTS and AUTOMATIONS, as in mock v9.

   Reports gains an Overview in front of the charts it already had: the seven
   measures as a band, one chart you can re-point at any one or two of them,
   what moved (arithmetic on the same figures, not written by AI), a box that
   hands a chart request to Margyn, and a library of the ready-made reports.
   Every figure comes from the same model the saved charts use
   (analyticsModel / MG_REPORTS in 12-analytics-settings.js and
   margyn-reports.js); nothing new is computed about the business here.

   Automations gains tabs: the roster it had, who is being chased, and the
   log of updates sent, both from data the app already loads.
   ============================================================ */

/* ---------- Reports ---------- */
const MGR_ORDER = ['revenue', 'spend', 'netprofit', 'margin', 'cash', 'pulse', 'gstleak'];
const MGR_COL = { revenue:'#0E8F5C', spend:'#CC5B34', netprofit:'#1C5BB5', margin:'#9A6B00', cash:'#0B4B8C', pulse:'#4A3FC0', gstleak:'#B3432E' };
const MGR_GOOD_UP = { revenue:true, spend:false, netprofit:true, margin:true, cash:true, pulse:true, gstleak:false };
let mgRep = { sel:['revenue', 'netprofit'], type:'combo', group:'Month', name:'' };
function mgRepFmt(k, v){
  if(v == null || !isFinite(v)) return 'n/a';
  const u = ANALYTICS_METRICS[k].unit;
  return u === 'inr' ? fmtINR(v, 'tile') : u === 'pct' ? (Math.round(v * 10) / 10) + '%' : String(Math.round(v));
}
/* One measure over the chosen range, by month: its headline figure and its last whole-period change. */
function mgRepMeasure(k){
  const M = analyticsModel([k], 'Month'), P = M.periods, vals = P.map(p => p.values[k]).filter(v => v != null);
  const head = !vals.length ? null : ANALYTICS_METRICS[k].agg === 'sum' ? vals.reduce((a, b) => a + b, 0) : vals[vals.length - 1];
  return { k, P, vals, head, ch:MG_REPORTS.lastChange(P, k) };
}
function mgRepSpark(vals, color){
  if(vals.length < 2) return '<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"></svg>';
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const pts = vals.map((v, i) => (i / (vals.length - 1) * 100).toFixed(1) + ',' + (18 - (v - lo) / sp * 16).toFixed(1)).join(' ');
  return '<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
}
function mgRepChange(m){
  if(!m.ch) return '<div class="d">Not enough months yet</div>';
  const up = m.ch.pct >= 0, flat = Math.abs(m.ch.pct) < 0.5, good = up === MGR_GOOD_UP[m.k];
  return '<div class="d ' + (flat ? '' : good ? 'up' : 'dn') + '">' + (flat ? 'No change ' : (up ? '▲ ' : '▼ ') + Math.abs(m.ch.pct).toFixed(0) + '% ') + escapeHtml(m.ch.to + ' vs ' + m.ch.from) + '</div>';
}
function mgRepSentence(m){
  if(!m.ch || Math.abs(m.ch.pct) < 0.5) return null;
  const L = ANALYTICS_METRICS[m.k].label, up = m.ch.pct >= 0, to = m.P.find(p => p.label === m.ch.to), v = to ? to.values[m.k] : null;
  const verb = { revenue:['rose', 'fell'], spend:['rose', 'fell'], netprofit:['rose', 'fell'], margin:['improved', 'slipped'], cash:['is up', 'is down'], pulse:['is up', 'is down'], gstleak:['has grown', 'has come down'] }[m.k][up ? 0 : 1];
  return { k:m.k, up, good:up === MGR_GOOD_UP[m.k], text:L + ' ' + verb + ' ' + Math.abs(m.ch.pct).toFixed(0) + '% from ' + m.ch.from + ' to ' + m.ch.to + (v != null ? ', to ' + mgRepFmt(m.k, v) : '') + '.' };
}
const MGR_LIBRARY = [
  ['cfopack', 'cfo-pack', 'CFO pack', 'The month in one document: profit and loss, cash, receivables, payables and what changed. Print it or email it.'],
  ['cashflow', 'cash-flow', 'Cash flow statement', 'Where cash came from and where it went, as an owner reads it or as an accountant does.'],
  ['margin', 'margin', 'Margin', 'What you keep: by month, by customer, by item, and where the money goes.'],
  ['scores', 'pulse', 'Pulse Score', 'Operating health out of 100, the vitals behind it and what would move it.'],
  ['financing', 'financing', 'Capital readiness', 'An indicative working-capital view built from your own figures. Margyn is not a lender.'],
  ['gst', 'gst', 'GST and tax', 'GSTR-2B against your books, and the input credit at risk vendor by vendor.'],
  ['receivables', 'receivables', 'Receivables ageing', 'Who owes you, how late, and whether your sources agree.'],
  ['payables', 'payables', 'Payables', 'What you owe, what falls due this week and what is already late.'],
  ['audit', 'audit', 'Audit log', 'Every change to your ledger and your team: what, when, who, and where it came from.']
];
function mgRepRender(){
  const root = document.getElementById('view-analytics'), head = root && root.querySelector('.rd-head'); if(!head) return;
  let host = document.getElementById('mgRep');
  if(!host){ host = document.createElement('div'); host.id = 'mgRep'; host.innerHTML = '<div id="mgRepBar"></div><div id="mgRepOverview"></div><div id="mgRepLib"></div>'; head.after(host); }
  const can = pg => typeof mgPageAllowed !== 'function' || mgPageAllowed(pg);
  const ms = MGR_ORDER.map(mgRepMeasure), any = ms.some(m => m.vals.length >= 2);
  const ranges = typeof mgRangeOptions === 'function' ? mgRangeOptions() : [];
  const SHORT = { '1m':'1M', '1q':'1Q', '1y':'1Y', max:'Max' };
  document.getElementById('mgRepBar').innerHTML = '<div class="mg-toolbar"><div class="mg-seg" role="group" aria-label="Period">' + ranges.map(r =>
    '<button type="button" class="' + (r.key === analyticsRange ? 'on' : '') + '" data-rep-range="' + r.key + '" title="' + escapeHtml(r.label) + '">' + (SHORT[r.key] || escapeHtml(r.label)) + '</button>').join('') + '</div>' +
    '<span class="mg-fine" style="margin:0">' + escapeHtml((ranges.find(r => r.key === analyticsRange) || {}).label || '') + ' · by month</span><span class="mg-count">Compared with the month before</span></div>';
  const ov = document.getElementById('mgRepOverview');
  if(!any){
    ov.innerHTML = '<div class="mg-panel mg-empty-panel"><h2>' + (typeof mgMarBusy !== 'undefined' && mgMarBusy ? 'Reading your books…' : 'Not enough history yet') + '</h2><p>Figures over time appear once there are two periods. Connect your books, or widen the range.</p></div>';
  } else {
    mgRep.sel = mgRep.sel.filter(k => ANALYTICS_METRICS[k]); if(!mgRep.sel.length) mgRep.sel = ['revenue'];
    const band = '<div class="mg-mband">' + ms.map(m => { const i = mgRep.sel.indexOf(m.k);
      return '<button type="button" class="' + (i === 0 ? 'on' : i === 1 ? 'on2' : '') + '" data-rep-m="' + m.k + '" style="--k:' + MGR_COL[m.k] + '" aria-pressed="' + (i >= 0) + '"><div class="l"><i></i>' + escapeHtml(ANALYTICS_METRICS[m.k].label) + '</div><div class="v">' + (typeof mgFig === 'function' ? mgFig(mgRepFmt(m.k, m.head)) : escapeHtml(mgRepFmt(m.k, m.head))) + '</div>' + mgRepChange(m) + mgRepSpark(m.vals, MGR_COL[m.k]) + '</button>'; }).join('') + '</div>';
    // the explorer: the same recipe the saved charts use
    const sel = mgRep.sel, type = sel.length < 2 && mgRep.type === 'combo' ? 'bar' : mgRep.type;
    const M0 = analyticsModel(sel, mgRep.group), P = M0.periods;
    const series = sel.map((k, i) => ({ type:type === 'combo' ? (i === 0 ? 'bar' : 'line') : type, color:MGR_COL[k], name:ANALYTICS_METRICS[k].label, unit:ANALYTICS_METRICS[k].unit, data:P.map(p => p.values[k] == null ? null : p.values[k]) }));
    const costs = sel.some(k => k === 'spend' || k === 'netprofit' || k === 'margin');
    const labels = P.map(p => p.label + (sel.some(k => MG_REPORTS.FLOW[k]) && p.in_progress ? ' (so far)' : costs && p.costs_incomplete ? ' *' : ''));
    const auto = sel.map(k => ANALYTICS_METRICS[k].label).join(' vs ');
    const notes = [M0.note, P.some(p => p.costs_incomplete) && costs ? '* Running costs look incomplete that month, so profit is overstated until they’re booked.' : ''].filter(Boolean).join(' ');
    const seg = (attr, opts, on) => '<div class="mg-seg">' + opts.map(o => '<button type="button" class="' + (o[0] === on ? 'on' : '') + '" ' + attr + '="' + o[0] + '"' + (o[2] ? ' disabled title="' + o[2] + '"' : '') + '>' + o[1] + '</button>').join('') + '</div>';
    const xp = '<div class="mg-xp"><div class="mg-xp-plot"><h3>' + escapeHtml(mgRep.name || auto) + '</h3><p>' + escapeHtml(sel.map(k => ANALYTICS_METRICS[k].label).join(' · ') + ' / by ' + (M0.group || mgRep.group).toLowerCase()) + '</p>' +
        '<div class="mg-xp-leg">' + sel.map(k => { const m = ms.find(x => x.k === k); return '<span style="--k:' + MGR_COL[k] + '">' + escapeHtml(ANALYTICS_METRICS[k].label + ' · ' + mgRepFmt(k, m.head)) + '</span>'; }).join('') + '</div>' +
        (P.length >= 2 ? rdChart({ type, labels, series, h:280 }) : '<div class="mg-empty">Not enough periods in this range yet.</div>') +
        (notes ? '<div class="mg-fine">' + escapeHtml(notes) + '</div>' : '') + '</div>' +
      '<div class="mg-xp-ctl"><div><h5>Measures · pick one or two</h5><div class="mg-xp-pills">' + MGR_ORDER.map(k => '<button type="button" class="' + (sel.includes(k) ? 'on' : '') + '" data-rep-m="' + k + '" style="--k:' + MGR_COL[k] + '"><i></i>' + escapeHtml(ANALYTICS_METRICS[k].label) + '</button>').join('') + '</div></div>' +
        '<div><h5>Chart type</h5>' + seg('data-rep-type', [['line', 'Line'], ['bar', 'Bar'], ['area', 'Area'], ['combo', 'Combo', sel.length < 2 ? 'Pick two measures for a combo chart' : '']], type) + '</div>' +
        '<div><h5>Group by</h5>' + seg('data-rep-group', [['Week', 'Week'], ['Month', 'Month'], ['Quarter', 'Quarter']], mgRep.group) + '</div>' +
        '<div><h5>Chart name</h5><input type="text" id="mgRepName" value="' + escapeHtml(mgRep.name) + '" placeholder="' + escapeHtml(auto) + '" aria-label="Chart name"></div>' +
        '<button type="button" class="mg-btn primary" data-rep-save>Save to your charts</button>' +
        '<p class="mg-fine" style="margin:0">Revenue, spend and profit come from your books month by month; cash, Pulse Score and GST leakage are readings, so they are never added up.</p></div></div>';
    const moved = ms.map(mgRepSentence).filter(Boolean);
    const movedCard = '<div class="mg-panel mg-rep-moved"><div class="mg-panel-h"><h2>What moved</h2><span class="mg-aside">From your figures, not written by AI</span></div>' +
      (moved.length ? moved.map(x => '<div class="mg-li"><span class="ar ' + (x.good ? 'pos' : 'neg') + '" aria-hidden="true">' + (x.up ? '▲' : '▼') + '</span><div class="mg-li-t">' + escapeHtml(x.text) + '</div><button type="button" class="mg-btn mg-btn-sm" data-rep-chart="' + x.k + '">Chart it</button></div>').join('')
        : '<div class="mg-empty">Nothing moved between the last two whole months in this range.</div>') + '</div>';
    const askCard = '<div class="mg-panel"><div class="mg-panel-h"><h2>Ask for a chart</h2><span class="mg-aside">Margyn can draw one for you</span></div><div class="mg-panel-b">' +
      '<form class="mgd-ask" data-rep-ask style="max-width:none"><input type="text" placeholder="“Revenue against spend by quarter, last two years”" aria-label="Describe a chart"><button type="submit" class="mgd-ask-send" aria-label="Ask Margyn" title="Ask Margyn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>' +
      '<div class="mgh-chips">' + ['Cash against payables due', 'Profit by month this year', 'How has my Pulse moved?'].map(q => '<button type="button" data-rep-askq="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('') + '</div>' +
      '<p class="mg-fine" style="margin-top:10px">Margyn draws it in its panel from the same figures as this page. Use the controls above to keep a chart here.</p></div></div>';
    ov.innerHTML = band + xp + '<div class="mg-row3 mg-rep-two">' + movedCard + askCard + '</div>';
    rdMountCharts(ov);
  }
  document.getElementById('mgRepLib').innerHTML = '<div class="mg-rep-lib">' + MGR_LIBRARY.filter(r => can(r[0])).map(r => { const ic = document.querySelector('#sidebarNav .pagenav button[data-view="' + r[0] + '"] svg');
    return '<div class="mg-lib"><div class="h"><span class="mg-ph-chip" aria-hidden="true">' + (ic ? ic.outerHTML : '') + '</span><b>' + escapeHtml(r[2]) + '</b></div><p>' + escapeHtml(r[3]) + '</p><div class="f"><button type="button" class="mg-btn mg-btn-sm" data-go-page="' + r[1] + '">Open</button></div></div>'; }).join('') + '</div>';
  if(typeof mgTabsApply === 'function' && mgCurrentView === 'analytics') mgTabsApply('analytics');
}
if(typeof MG_TABX !== 'undefined'){
  MG_TABX.analytics = {
    root:'view-analytics',
    tabs:[['overview', 'Overview', 'always'], ['charts', 'Your charts', 'always'], ['library', 'Report library', 'always']],
    after:() => document.getElementById('mgRepBar'),
    ready:() => !!document.getElementById('mgRep'),
    count:k => k === 'charts' ? loadAnalyticsCharts().length : k === 'library' ? document.querySelectorAll('#mgRepLib .mg-lib').length : null,
    leaves:() => [[document.getElementById('mgRepOverview'), 'overview'], [document.getElementById('analyticsBuilder'), 'charts'], [document.getElementById('analyticsMount'), 'charts'], [document.getElementById('mgRepLib'), 'library']].filter(x => x[0])
  };
}
if(typeof renderAnalyticsView === 'function'){
  const baseRA = renderAnalyticsView;
  renderAnalyticsView = function(){ const out = baseRA.apply(this, arguments); try { mgRepRender(); } catch(e){ console.error('[margyn] reports overview', e); } return out; };
}
document.addEventListener('click', e => {
  const t = e.target;
  const r = t.closest('[data-rep-range]'); if(r){ if(typeof mgSetRange === 'function') mgSetRange(r.dataset.repRange); return; }
  const m = t.closest('[data-rep-m]');
  if(m){ const k = m.dataset.repM, i = mgRep.sel.indexOf(k);
    if(i >= 0){ if(mgRep.sel.length > 1) mgRep.sel.splice(i, 1); }           // tap a chosen one to drop it (one always stays)
    else { if(mgRep.sel.length >= 2) mgRep.sel.shift(); mgRep.sel.push(k); }
    if(mgRep.sel.length === 2 && mgRep.type !== 'line' && mgRep.type !== 'area') mgRep.type = 'combo';
    mgRep.name = ''; mgRepRender(); return; }
  const ty = t.closest('[data-rep-type]'); if(ty && !ty.disabled){ mgRep.type = ty.dataset.repType; mgRepRender(); return; }
  const g = t.closest('[data-rep-group]'); if(g){ mgRep.group = g.dataset.repGroup; mgRepRender(); return; }
  const c = t.closest('[data-rep-chart]'); if(c){ mgRep.sel = [c.dataset.repChart]; mgRep.type = ANALYTICS_METRICS[c.dataset.repChart].agg === 'sum' ? 'bar' : 'line'; mgRep.name = ''; mgRepRender(); const w = document.querySelector('.app-body .wrap'); if(w) w.scrollTo({ top:0, behavior:'smooth' }); return; }
  if(t.closest('[data-rep-save]')){
    const name = ((document.getElementById('mgRepName') || {}).value || '').trim() || mgRep.sel.map(k => ANALYTICS_METRICS[k].label).join(' vs ');
    const type = mgRep.sel.length < 2 && mgRep.type === 'combo' ? 'bar' : mgRep.type;
    const list = loadAnalyticsCharts(); list.unshift({ id:'c' + Date.now(), name, type, metrics:mgRep.sel.slice(), group:mgRep.group });
    saveAnalyticsCharts(list); mgRep.name = '';
    toast('Saved to your charts', { sub:name, kind:'good' });
    renderAnalyticsView(); return; }
  const q = t.closest('[data-rep-askq]'); if(q && typeof mgrAsk === 'function'){ mgrAsk('Draw me a chart: ' + q.dataset.repAskq); return; }
  // "+ New chart" builds a chart from scratch under Your charts
  if(t.closest('#analyticsNewBtn') && typeof mgTab !== 'undefined'){ mgTab.analytics = 'charts'; if(typeof mgTabsApply === 'function') mgTabsApply('analytics'); }
});
document.addEventListener('input', e => { if(e.target.id === 'mgRepName') mgRep.name = e.target.value; });
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-rep-ask]'); if(!f) return;
  e.preventDefault(); const i = f.querySelector('input'), v = i.value.trim(); if(!v) return; i.value = '';
  if(typeof mgrAsk === 'function') mgrAsk('Draw me a chart: ' + v);
});

/* ---------- Automations: Roster, Chasing, Update log ---------- */
const MGA_STATE = { active:['pos', 'Chasing'], paused_promise:['warn', 'Promised to pay'], disputed:['neg', 'Disputed'], escalated_human:['warn', 'Needs you'], resolved_paid:['pos', 'Paid'], resolved_manual:['', 'Closed'], opted_out:['', 'Opted out'], stopped:['', 'Reminders off'] };
function mgAutoOpen(){ try { return (chaseTargets || []).filter(t => ['active', 'paused_promise', 'disputed', 'escalated_human'].includes(t.state)); } catch(e){ return []; } }
// Reminders on or off for one customer. A customer who replied STOP (opted out), paid, or is in your hands has no switch.
function mgAutoSwitch(t){
  const on = ['active', 'paused_promise'].includes(t.state);
  if(!on && t.state !== 'stopped') return '<span class="mg-fine">—</span>';
  return '<label class="mg-switch" style="padding:0"><input type="checkbox" data-chase-onoff="' + escapeHtml(String(t.id)) + '"' + (on ? ' checked' : '') + '> <span>' + (on ? 'On' : 'Off') + '</span></label>';
}
document.addEventListener('change', async e => {
  const box = e.target.closest && e.target.closest('[data-chase-onoff]'); if(!box) return;
  const t = ((typeof chaseTargets !== 'undefined' && chaseTargets) || []).find(x => String(x.id) === box.dataset.chaseOnoff); if(!t) return;
  const name = t.party_name || 'this customer';
  const ok = box.checked
    ? await mgConfirm({ title:'Send reminders to ' + name + ' again?', body:(t.contact_phone ? 'The next reminder goes out at the 10:30 am run.' : 'There’s no WhatsApp number for them yet, so nothing goes out until you add one.'), effect:(t.amount != null ? [['Outstanding', fmtINR(t.amount)]] : []), confirmLabel:'Turn on' })
    : await mgConfirm({ title:'Stop reminders to ' + name + '?', body:'Margyn won’t send them payment reminders, including for new invoices, until you turn this back on.', effect:(t.amount != null ? [['Outstanding', fmtINR(t.amount)]] : []), confirmLabel:'Stop reminders' });
  if(!ok){ box.checked = !box.checked; return; }
  const patch = box.checked
    ? { state:'active', resolution:null, next_chase_at:t.contact_phone ? new Date().toISOString() : null }
    : { state:'stopped', resolution:'Stopped by the owner.', next_chase_at:null };
  try {
    const { error } = await sbClient.from('whatsapp_chase_targets').update(patch).eq('id', t.id).eq('user_id', currentUser.id);
    if(error) throw error;
    // Every entry for the same customer goes with it, so one switch covers them.
    const same = (chaseTargets || []).filter(x => x.id !== t.id && String(x.party_name || '').trim().toLowerCase() === String(t.party_name || '').trim().toLowerCase() && (box.checked ? x.state === 'stopped' : ['active', 'paused_promise'].includes(x.state)));
    for(const x of same) await sbClient.from('whatsapp_chase_targets').update(patch).eq('id', x.id).eq('user_id', currentUser.id);
    toast(box.checked ? 'Reminders on for ' + name : 'Reminders off for ' + name, { kind:'good' });
  } catch(err){ toast('Could not change reminders', { kind:'bad', sub:err.message || '' }); }
  if(typeof loadChaseTargets === 'function') await loadChaseTargets();
  mgAutoPanels();
});
function mgAutoPanels(){
  const root = document.getElementById('view-agents'), roster = document.getElementById('agentPanel-roster'); if(!root || !roster) return;
  let ch = document.getElementById('mgAutoChase'), lg = document.getElementById('mgAutoLog');
  if(!ch){ ch = document.createElement('div'); ch.id = 'mgAutoChase'; lg = document.createElement('div'); lg.id = 'mgAutoLog'; roster.after(ch, lg); }
  const d = (typeof agentDeployments !== 'undefined' && agentDeployments) || {}, st = (d.chase_agent && d.chase_agent.status) || 'not_deployed';
  // The list is read here, not left to whichever page loaded it last: it used to show "Nobody is being chased"
  // (and no switches) whenever Automations opened before anything else had read it. Again at most every 30 s.
  if(typeof loadChaseTargets === 'function' && !mgAutoPanels.busy && Date.now() - (mgAutoPanels.at || 0) > 30000){
    mgAutoPanels.busy = true;
    Promise.resolve(loadChaseTargets()).then(() => { mgAutoPanels.at = Date.now(); }).catch(() => {}).then(() => { mgAutoPanels.busy = false; if(mgCurrentView === 'agents') mgAutoPanels(); });
  }
  const loading = !mgAutoPanels.at;
  const all = (typeof chaseTargets !== 'undefined' && chaseTargets) || [], open = mgAutoOpen();
  const paid = all.filter(t => t.state === 'resolved_paid');
  const when = iso => iso ? fmtDay(iso) : '—';
  ch.innerHTML = (typeof mgSum === 'function' ? mgSum([['Being chased', String(open.length)], ['Outstanding', fmtINR(open.reduce((a, t) => a + (Number(t.amount) || 0), 0), 'tile')], ['Paid after a reminder', String(paid.length), paid.length ? 'pos' : ''],
      ['Payment reminders', st === 'active' ? 'On' : st === 'paused' ? 'Paused' : 'Off']]) : '') +
    (all.length ? '<div class="mg-panel mg-gridwrap mg-bleed"><table class="mg-grid comfy"><thead><tr><th>Customer</th><th>Status</th><th class="r">Amount (₹)</th><th>Last reminder</th><th>Next reminder</th><th>Reminders</th></tr></thead><tbody>' +
      all.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).map(t => { const s = MGA_STATE[t.state] || ['', String(t.state || '').replace(/_/g, ' ')];
        return '<tr><td>' + (typeof mgWho === 'function' ? mgWho(t.party_name || 'A customer') : escapeHtml(t.party_name || '')) + '</td><td><span class="mg-bdg ' + s[0] + '">' + escapeHtml(s[1]) + '</span></td><td class="r">' + (t.amount != null ? mgNum(t.amount) : '') + '</td><td>' + escapeHtml(when(t.last_chase_at)) + '</td><td>' + escapeHtml(['active'].includes(t.state) ? when(t.next_chase_at) : '—') + '</td><td>' + mgAutoSwitch(t) + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : loading ? '<div class="mg-panel mg-empty-panel"><p>Loading who is being chased…</p></div>'
      : '<div class="mg-panel mg-empty-panel"><h2>Nobody is being chased</h2><p>' + (st === 'active' ? 'Payment reminders are on. Customers appear here as their invoices go past due.' : 'Payment reminders on WhatsApp are off. Turn them on from the Roster tab and overdue customers appear here.') + '</p></div>');
  // Update log: what Margyn sent on WhatsApp, run by run (the Conversations page's own log)
  const w = typeof mgHub !== 'undefined' && mgHub ? mgHub.watch : null;
  const runs = w && typeof mgHubRunsHtml === 'function' ? mgHubRunsHtml(w) : '';
  lg.innerHTML = '<div class="mg-panel"><div class="mg-panel-h"><h2>Updates sent on WhatsApp</h2><button type="button" class="mg-link mg-aside" data-go-page="history">Open in Conversations →</button></div><div class="mg-panel-b">' +
    (runs || '<p class="mg-fine" style="margin:0">' + (w ? 'No update has run yet. The first goes out around 7:30 am once updates are on.' : 'Loading the log…') + '</p>') + '</div></div>';
  if(!w && typeof mgHubLoad === 'function' && !mgAutoPanels.asked){ mgAutoPanels.asked = true; Promise.resolve(mgHubLoad()).then(() => { if(mgCurrentView === 'agents') mgAutoPanels(); }).catch(() => {}); }
}
if(typeof MG_TABX !== 'undefined'){
  MG_TABX.agents = {
    root:'view-agents',
    tabs:[['roster', 'Roster', 'always'], ['chasing', 'Chasing', 'always'], ['log', 'Update log', 'always'], ['conversations', 'Conversations', 'always']],
    after:() => document.querySelector('#view-agents > .rd-head'),
    ready:() => { const r = document.getElementById('view-agents'); return !!r && r.classList.contains('mg-is-agents') && !!document.getElementById('mgAutoChase'); },
    count:k => k === 'roster' ? document.querySelectorAll('#agentCards .agent-card').length || null : k === 'chasing' ? mgAutoOpen().length : null,
    onPick:k => { if(k === 'conversations'){ mgTab.agents = 'roster'; showView('history'); } },
    leaves:() => [[document.getElementById('agentPanel-roster'), 'roster'], [document.getElementById('mgAutoChase'), 'chasing'], [document.getElementById('mgAutoLog'), 'log']].filter(x => x[0])
  };
}
(function(){
  const paint = () => { try { const r = document.getElementById('view-agents');
    const bar = r && r.querySelector('.mg-tabs[data-mg-tabs="agents"]');
    if(!r || !r.classList.contains('mg-is-agents')){ if(bar) bar.remove(); ['mgAutoChase', 'mgAutoLog'].forEach(id => { const e = document.getElementById(id); if(e) e.classList.add('mg-tab-off'); }); return; }
    mgAutoPanels(); if(typeof mgTabsApply === 'function') mgTabsApply('agents'); } catch(e){ console.error('[margyn] automations tabs', e); } };
  const base = showView;
  showView = function(){ const out = base.apply(this, arguments); if(mgCurrentView === 'agents' || mgCurrentView === 'inbox') paint(); return out; };
  if(typeof renderAgentRoster === 'function'){ const b = renderAgentRoster; renderAgentRoster = function(){ const o = b.apply(this, arguments); Promise.resolve(o).then(() => { if(mgCurrentView === 'agents') paint(); }); return o; }; }
})();

/* ---------- Organisations and sources: four figures up top ---------- */
function mgSrcBandPaint(){
  const root = document.getElementById('view-connectors'), head = root && root.querySelector('.rd-head'); if(!head || typeof CONN_FEED_MAP === 'undefined' || typeof mgSum !== 'function') return;
  const g = fn => { try { return fn(); } catch(e){ return null; } };
  const T = { razorpay:g(() => (razorpayStatus && razorpayStatus.last_success_at) || lastSyncedAt), cashfree:g(() => cashfreeStatus && cashfreeStatus.last_success_at), zoho:g(() => zohoVitals && zohoVitals.last_synced_at),
    tally:g(() => (tallyInstalls || []).map(i => i.last_sync_at).filter(Boolean).sort().pop()), odoo:g(() => odooStatus && odooStatus.last_success_at), shopify:g(() => shopifyStore && shopifyStore.last_synced_at) };
  const live = CONN_FEED_MAP.filter(c => connIsLive(c.key));
  const timed = live.map(c => ({ c, t:T[c.key] ? new Date(T[c.key]).getTime() : 0 })).filter(x => x.t > 0).sort((a, b) => b.t - a.t);
  const ago = t => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'Just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const warn = live.filter(c => { const h = mgSourceHealth(c.key); return h.on && h.warn; });
  const verified = live.filter(c => c.tier === 'Verified').length;
  const cell = (l, v, sub, cls) => '<div><div class="mg-sum-l">' + escapeHtml(l) + '</div><div class="mg-sum-v' + (cls ? ' ' + cls : '') + '">' + (typeof mgFig === 'function' ? mgFig(v) : escapeHtml(v)) + '</div><div class="mg-sum-d">' + escapeHtml(sub) + '</div></div>';
  const html = '<div class="mg-sum mg-sum-4" id="mgSrcBand">' +
    cell('Connected', live.length + ' of ' + CONN_FEED_MAP.length, live.map(c => c.label).join(', ') || 'Nothing connected yet') +
    cell('Last sync', timed.length ? ago(timed[0].t) : '—', timed.length ? timed[0].c.label + (timed.length > 1 ? ' · oldest ' + timed[timed.length - 1].c.label + ', ' + ago(timed[timed.length - 1].t).toLowerCase() : '') : 'No sync yet') +
    cell('Verified figures', String(verified) + (verified === 1 ? ' source' : ' sources'), 'Verified needs two independent sources') +
    cell('Needs attention', String(warn.length), warn.length ? warn.map(c => c.label + ': ' + mgSourceHealth(c.key).text).join(' · ') : 'Every connected source is syncing', warn.length ? 'bad' : '') + '</div>';
  const old = document.getElementById('mgSrcBand');
  if(!old) head.insertAdjacentHTML('afterend', html); else if(old.outerHTML !== html) old.outerHTML = html;
}
if(typeof renderConnectionsHub === 'function'){
  const baseHub2 = renderConnectionsHub;
  renderConnectionsHub = function(){ const out = baseHub2.apply(this, arguments); try { mgSrcBandPaint(); } catch(e){ console.error('[margyn] sources band', e); } return out; };
}
(function(){ const base = showView; showView = function(){ const out = base.apply(this, arguments); if(mgCurrentView === 'connectors'){ try { mgSrcBandPaint(); } catch(e){} } return out; }; })();

/* The first finished load: from here an empty page really means no figures (see mgDataReady in 19-pages.js). */
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    try { return await base.apply(this, arguments); }
    finally {
      if(!mgDataReady){ mgDataReady = true; try { if(typeof MG_OWN !== 'undefined' && MG_OWN.includes(mgCurrentView) && typeof mgRenderOwn === 'function') mgRenderOwn(mgCurrentView); } catch(e){} }
    }
  };
})();
