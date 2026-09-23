/* ============================================================
   ANALYTICS (new, presentational). Trends across snapshots and
   connector data already in memory. Nothing here is persisted or
   feeds the Pulse Score.
   ============================================================ */
let analyticsRange = '1q'; // '1m', '1q', '1y' or 'max'. How far back the chart data goes.
const ANALYTICS_METRICS = {
  revenue:   { label:'Revenue',         color:'#0E8F5C', unit:'inr',   agg:'sum',  val:s => Number(s.revenue)||0 },
  cash:      { label:'Cash position',   color:'#0B4B8C', unit:'inr',   agg:'last', val:s => Number(s.cash)||0 },
  pulse:     { label:'Pulse Score',     color:'#0E8F5C', unit:'score', agg:'last', val:s => Number(s.pulse_score)||0 },
  margin:    { label:'Net margin',      color:'#0E8F5C', unit:'pct',   agg:'last', val:s => Number(s.revenue) ? (Number(s.net_profit)/Number(s.revenue))*100 : 0 },
  spend:     { label:'Total spend',     color:'#CC5B34', unit:'inr',   agg:'sum',  val:s => Number(s.burn)||0 },
  netprofit: { label:'Net profit',      color:'#0E8F5C', unit:'inr',   agg:'sum',  val:s => Number(s.net_profit)||0 },
  gstleak:   { label:'GST/ITC leakage', color:'#CC5B34', unit:'inr',   agg:'last', val:s => Number(s.gst_leak)||0 }
};
const ANALYTICS_DEFAULTS = [
  { id:'d1', name:'Revenue', type:'bar', metrics:['revenue'], group:'Week' },
  { id:'d2', name:'Cash position', type:'area', metrics:['cash'], group:'Week' },
  { id:'d3', name:'Pulse Score', type:'line', metrics:['pulse'], group:'Week' },
  { id:'d4', name:'Revenue vs net profit', type:'combo', metrics:['revenue','netprofit'], group:'Month' }
];
function loadAnalyticsCharts(){
  const a = mgPrefGet('analytics_charts', null); if(Array.isArray(a)) return a.slice();
  return ANALYTICS_DEFAULTS.slice();
}
function saveAnalyticsCharts(list){ mgPrefSet('analytics_charts', list); }
function analyticsRows(){
  const chron = (snapshots || []).slice().reverse(); // oldest first
  const days = { '1m':31, '1q':93, '1y':372, 'max':1e7 }[analyticsRange] || 93;
  const cut = Date.now() - days * 86400000;
  const within = chron.filter(s => s.created_at && new Date(s.created_at).getTime() >= cut);
  return within.length >= 2 ? within : chron;
}
function renderAnalyticsView(){
  const mount = document.getElementById('analyticsMount'); if(!mount) return;
  document.querySelectorAll('#analyticsRangeTabs button').forEach(b => b.classList.toggle('active', b.dataset.range === analyticsRange));
  // populate the metric pill set once
  const mp = document.getElementById('abMetrics');
  if(mp && !mp.children.length){
    mp.innerHTML = Object.keys(ANALYTICS_METRICS).map(k => '<button type="button" data-m="'+k+'">'+ANALYTICS_METRICS[k].label+'</button>').join('');
    mp.querySelectorAll('button').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  }
  const rows = analyticsRows();
  const charts = loadAnalyticsCharts();
  if(rows.length < 2){
    mount.innerHTML = '<div class="ch-tile wide"><div class="ledger-empty">Charts appear once you have at least two snapshots in this range. Add another under Upload &amp; calculate, or widen the range.</div></div>';
    return;
  }
  mount.innerHTML = charts.map(c => {
    const metrics = (c.metrics && c.metrics.length ? c.metrics : ['revenue']).filter(m => ANALYTICS_METRICS[m]);
    const buckets = rdBucketRows(rows, c.group || 'Month');
    const palette = ['#0B4B8C','#CC5B34','#767E8B'];
    const series = metrics.map((m, i) => {
      const M = ANALYTICS_METRICS[m];
      const stype = c.type === 'combo' ? (i === 0 ? 'bar' : 'line') : c.type;
      return { type: stype, color: i === 0 ? M.color : palette[(i-1) % palette.length], name: M.label, unit: M.unit, data: rdMetricSeries(m, buckets) };
    });
    // change vs the previous bucket, not vs the first: a partial opening
    // week or month otherwise produces meaningless four-figure percentages.
    const s0 = series[0].data;
    const last = s0[s0.length - 1], before = s0.length > 1 ? s0[s0.length - 2] : null;
    let pct = (before !== null && before !== 0) ? ((last - before) / Math.abs(before) * 100) : null;
    if(pct !== null && (!isFinite(pct) || Math.abs(pct) > 999)) pct = null;
    const perLabel = 'vs previous ' + (c.group || 'Month').toLowerCase();
    const wide = metrics.length > 1;
    return '<div class="ch-tile' + (wide ? ' wide' : '') + '" data-margyn-topic="' + escapeHtml(c.name) + '">' +
      '<div class="ch-h"><div><div class="t">' + escapeHtml(c.name) + '</div>' +
        '<div class="s">' + escapeHtml(metrics.map(m => ANALYTICS_METRICS[m].label).join(' · ')) + ' &nbsp;/&nbsp; by ' + escapeHtml((c.group || 'Month').toLowerCase()) + '</div></div>' +
      '<button class="ch-menu" data-del="' + c.id + '" title="Remove chart">&times;</button></div>' +
      rdChart({ type: c.type, labels: buckets.map(b => b._label), series, h: wide ? 260 : 220 }) +
      '<div class="ch-foot">' +
      (pct !== null ? '<span class="rd-tag ' + (pct >= 0 ? 'ok' : '') + '">' + (pct >= 0 ? '▲ +' : '▼ ') + Math.abs(pct).toFixed(0) + '% ' + perLabel + '</span>' : '') +
      '</div></div>';
  }).join('');
  mount.querySelectorAll('.ch-menu[data-del]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    saveAnalyticsCharts(loadAnalyticsCharts().filter(c => c.id !== b.dataset.del));
    renderAnalyticsView();
  }));
  rdMountCharts(mount);
}
function analyticsAddChart(){
  const metrics = [...document.querySelectorAll('#abMetrics button.on')].map(b => b.dataset.m);
  const typeBtn = document.querySelector('#abType button.on');
  const type = typeBtn ? typeBtn.dataset.y : 'line';
  const name = (document.getElementById('abName').value || '').trim()
    || (metrics.length ? metrics.map(m => ANALYTICS_METRICS[m].label).join(' vs ') : 'Untitled chart');
  const list = loadAnalyticsCharts();
  list.unshift({
    id: 'c' + Date.now(),
    name, type,
    metrics: metrics.length ? metrics : ['revenue'],
    group: document.getElementById('abGroup').value
  });
  saveAnalyticsCharts(list);
  toast('Chart added', { sub: name });
  document.getElementById('abName').value = '';
  document.querySelectorAll('#abMetrics button.on').forEach(b => b.classList.remove('on'));
  document.getElementById('analyticsBuilder').classList.remove('open');
  const chev = document.getElementById('abChev'); if(chev) chev.textContent = 'expand';
  renderAnalyticsView();
}
document.querySelectorAll('#analyticsRangeTabs button').forEach(b => b.addEventListener('click', () => {
  analyticsRange = b.dataset.range; renderAnalyticsView();
}));
(function wireAnalyticsBuilder(){
  const builder = document.getElementById('analyticsBuilder'); if(!builder) return;
  const chev = document.getElementById('abChev');
  const setOpen = (open) => { builder.classList.toggle('open', open); if(chev) chev.textContent = open ? 'collapse' : 'expand'; };
  document.getElementById('abToggle').addEventListener('click', () => setOpen(!builder.classList.contains('open')));
  const nb = document.getElementById('analyticsNewBtn'); if(nb) nb.addEventListener('click', () => { setOpen(true); builder.scrollIntoView({ behavior:'smooth', block:'nearest' }); });
  document.getElementById('abCancel').addEventListener('click', () => setOpen(false));
  document.getElementById('abAdd').addEventListener('click', analyticsAddChart);
  document.querySelectorAll('#abType button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#abType button').forEach(x => x.classList.remove('on')); b.classList.add('on');
  }));
})();
/* ============================================================
   SETTINGS (new). Notification prefs, band-label preference,
   connected-source overview, consent copy, account controls.
   Preferences are saved to the account (19c-prefs.js); the connectors and the
   account-delete flow reuse existing handlers.
   ============================================================ */
function lsGet(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : v; } catch(e){ return d; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
function renderSettingsView(){
  const mount = document.getElementById('settingsMount'); if(!mount) return;
  const bands = scoreBandCutoffs();
  const toggle = (id, on) => '<label class="rd-toggle"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span class="track"></span></label>';
  mount.innerHTML =
    '<div class="set-block"><h3>People</h3><div class="set-card" id="setPeopleMount"></div></div>' +
    '<div class="set-block"><h3>Notifications</h3><div class="set-card">' +
      '<div class="set-row"><span>Weekly email digest<span class="set-desc">A short summary of your Pulse Score and open items, once a week.</span></span>' +
        '<span class="rd-tag">Coming</span></div>' +
      '<div class="set-row"><span>WhatsApp Opening and Closing Bell<span class="set-desc">Push briefings on WhatsApp. Manage the number and cadence with the Bell agent.</span></span>' +
        '<button class="btn-ghost" type="button" id="setGoAgents">Open Agents</button></div>' +
    '</div></div>' +
    '<div class="set-block"><h3>Scoring</h3><div class="set-card">' +
      '<div class="set-note">Where the Healthy and Caution labels sit on the 0 to 100 scale. This changes labels in your view only, it does not change how the Pulse Score itself is calculated.</div>' +
      '<div class="set-row"><span>Healthy at or above</span><input type="number" id="setBandHealthy" value="' + bands.healthy + '"></div>' +
      '<div class="set-row"><span>Caution at or above</span><input type="number" id="setBandCaution" value="' + bands.caution + '"></div>' +
      '<div class="set-row"><span class="note" id="setBandNote"></span><span style="display:flex; gap:10px;"><button class="btn-ghost" type="button" id="setBandReset">Reset to defaults</button><button class="btn-primary" type="button" id="setBandSave">Save</button></span></div>' +
    '</div></div>' +
    '<div class="set-block"><h3>Connected sources</h3><div class="set-card">' +
      CONN_FEED_MAP.map(c => {
        const live = connIsLive(c.key);
        return '<div class="set-row"><span>' + escapeHtml(c.label) + '<span class="set-desc">' + escapeHtml(c.tier) + ' tier</span></span>' +
          '<span class="rd-tag ' + (live ? 'ok' : '') + '">' + (live ? 'Connected' : 'Not connected') + '</span></div>';
      }).join('') +
      '<div class="set-row"><span class="set-desc" style="margin:0;">Full connect and disconnect controls live under Connections.</span><button class="btn-ghost" type="button" id="setGoConnections">Manage connections</button></div>' +
    '</div></div>' +
    '<div class="set-block"><h3>Consent and data sharing</h3><div class="set-card">' +
      '<div class="set-note">Margyn reads from the sources you connect to compute your vitals. Your data is not shared with lenders or any third party unless you explicitly request an introduction under Financing. A granular per-source consent ledger is on the roadmap and not yet enforced here.</div>' +
    '</div></div>' +
    '<div class="set-block"><h3>Account</h3><div class="set-card">' +
      '<div class="set-row"><span>Email</span><span class="mono" style="font-size:12px; color:var(--text-2);">' + escapeHtml((currentUser && currentUser.email) || '') + '</span></div>' +
      '<div class="set-row"><span>Business details<span class="set-desc">Company name, revenue band, industry and city.</span></span><button class="btn-ghost" type="button" id="setGoProfile">Open Profile</button></div>' +
      '<div class="set-row"><span>Delete account<span class="set-desc">Soft delete. Deactivates now, revokes every connector, signs you out. The data purge runs later.</span></span>' +
        '<button class="btn-ghost" type="button" id="setDeleteAccount" style="border-color:rgba(179,67,46,0.4); color:#B3432E;">Delete my account</button></div>' +
    '</div></div>';
  const save = document.getElementById('setBandSave');
  if(save) save.addEventListener('click', () => {
    const h = Number(document.getElementById('setBandHealthy').value);
    const c = Number(document.getElementById('setBandCaution').value);
    const note = document.getElementById('setBandNote');
    if(!(h > c && c > 0 && h <= 100)){ if(note){ note.textContent = 'Healthy must be above Caution, both within 1 to 100.'; note.className = 'note bad'; } return; }
    mgPrefSet('score_bands', { healthy:h, caution:c });
    if(note){ note.textContent = ''; }
    toast('Scoring labels saved', { sub: 'Healthy at ' + h + ', Caution at ' + c });
    if(typeof renderScores === 'function') renderScores();
    if(typeof renderSummary === 'function') renderSummary();
  });
  const reset = document.getElementById('setBandReset');
  if(reset) reset.addEventListener('click', () => {
    mgPrefSet('score_bands', null);
    renderSettingsView();
    if(typeof renderScores === 'function') renderScores();
    if(typeof renderSummary === 'function') renderSummary();
  });
  const bind = (id, view) => { const el = document.getElementById(id); if(el) el.addEventListener('click', () => showView(view)); };
  bind('setGoAgents', 'agents'); bind('setGoConnections', 'connectors'); bind('setGoProfile', 'profile');
  renderPeopleMounts(true);
  const del = document.getElementById('setDeleteAccount');
  if(del) del.addEventListener('click', () => { if(typeof confirmAccountDelete === 'function') confirmAccountDelete(); });
}
/* Books had TWO absolutely-positioned nav badges (#booksBadge for Zoho flags,
   #tallyBadge for overdue Tally bills) pinned to the same coordinates, so
   whichever rendered second hid the other. One badge, both signals: the '!'
   for a Zoho problem wins over a plain count, because it is the more urgent
   of the two. */
let zohoBooksUrgent = false;
let tallyOverdueCount = 0;
function renderBooksBadge(){
  const badge = document.getElementById('booksBadge'); if(!badge) return;
  const text = zohoBooksUrgent ? '!' : (tallyOverdueCount ? String(tallyOverdueCount) : '');
  badge.textContent = text;
  badge.classList.toggle('hidden', !text);
  badge.title = zohoBooksUrgent
    ? 'Zoho Books flagged something that needs attention'
    : (tallyOverdueCount ? tallyOverdueCount + ' overdue bill(s) in Tally' : '');
}
function renderZohoBooksTab(){
  const notConnected = document.getElementById('booksNotConnected');
  const backfill = document.getElementById('booksBackfillBanner');
  const content = document.getElementById('booksContent');
  if(!notConnected || !content) return;

  if(!zohoConnected || !zohoVitals){
    notConnected.classList.remove('hidden');
    backfill.classList.add('hidden');
    content.classList.add('hidden');
    zohoBooksUrgent = false; renderBooksBadge();
    return;
  }
  notConnected.classList.add('hidden');
  backfill.classList.toggle('hidden', !!zohoVitals.backfill_completed_at);
  content.classList.remove('hidden');

  const v = zohoVitals;
  const r = v.receivables || {}, p = v.payables || {}, g = v.gst_leakage || {};
  const m = v.net_margin || {}, w = v.working_capital_runway || {}, c = v.cash_position || {};
  const flags = v.flags || [];

  zvSet('zvRecvVal', inr(r.total));
  zvFlag('zvRecvFlag', Number(r.days_90_plus) > 0 ? 'bad' : 'ok',
         Number(r.days_90_plus) > 0 ? inr(r.days_90_plus) + ' over 90d' : 'None over 90d');

  zvSet('zvPayVal', inr(p.total));
  const crunch = Number(p.projected_cash_after_this_weeks_payables) < 0;
  zvFlag('zvPayFlag', crunch ? 'bad' : (Number(p.overdue) > 0 ? 'warn' : 'ok'),
         crunch ? 'Shortfall this week' : (Number(p.overdue) > 0 ? inr(p.overdue) + ' overdue' : inr(p.due_this_week) + ' due this week'));

  zvSet('zvGstVal', inr(g.total_leakage));
  const leakPct = Number(g.leakage_pct) || 0;
  zvFlag('zvGstFlag', leakPct > 15 ? 'bad' : (leakPct > 0 ? 'warn' : 'ok'),
         leakPct > 0 ? leakPct + '% of claimed ITC' : 'Nothing at risk');

  zvSet('zvMarginVal', (m.net_margin_pct !== null && m.net_margin_pct !== undefined) ? m.net_margin_pct + '%' : '—');
  zvSet('zvRunwayVal', (w.runway_days !== null && w.runway_days !== undefined) ? Math.round(w.runway_days) + ' days' : '—');

  if(c.bank_data_available === false){
    zvSet('zvCashVal', 'Not available');
    zvFlag('zvCashFlag', 'warn', 'Needs Zoho Standard plan');
  } else {
    zvSet('zvCashVal', inr(c.zoho_reported_balance));
    const div = Number(c.divergence_pct) || 0;
    zvFlag('zvCashFlag', div > 10 ? 'bad' : 'ok', div + '% vs gateway settlements');
  }

  // Named-entity insight lines, generated server-side alongside the vitals.
  const hints = (v.briefing_hints && v.briefing_hints.lines) || [];
  const ins = document.getElementById('zvInsights');
  const insCard = document.getElementById('zvInsightsCard');
  if(hints.length){
    insCard.classList.remove('hidden');
    ins.innerHTML = hints.map(l =>
      '<div class="alert-item"><span class="alert-dot warn">!</span>' +
      '<div class="alert-body"><div class="alert-desc">' + escapeHtml(l) + '</div></div></div>').join('');
  } else {
    insCard.classList.remove('hidden');
    ins.innerHTML = '<div class="alert-item"><span class="alert-dot ok">✓</span><div class="alert-body">' +
      '<div class="alert-title">Nothing urgent in the books</div>' +
      '<div class="alert-desc">No overdue customers, ITC risk or near-term cash crunch flagged on the latest sync.</div></div></div>';
  }

  // Receivables aging buckets
  const aging = document.getElementById('zvAgingChart');
  const buckets = [['Current', r.current], ['1–30 days', r.days_1_30], ['31–60 days', r.days_31_60],
                   ['61–90 days', r.days_61_90], ['90+ days', r.days_90_plus]];
  const maxB = Math.max.apply(null, buckets.map(b => Number(b[1]) || 0).concat([1]));
  aging.innerHTML = '';
  buckets.forEach(b => {
    const val = Number(b[1]) || 0;
    const pct = Math.max(2, (val / maxB) * 100);
    const row = document.createElement('div'); row.className = 'hbar-row';
    row.innerHTML = '<span class="hbar-label">' + b[0] + '</span>' +
      '<div class="hbar-track"><div class="hbar-fill" style="width:0%;"></div></div>' +
      '<span class="hbar-val">' + inr(val) + '</span>';
    aging.appendChild(row);
    requestAnimationFrame(() => { row.querySelector('.hbar-fill').style.width = pct + '%'; });
  });

  // Overdue customers — the line the owner can act on same day
  const od = document.getElementById('zvOverdueList');
  const overdue = v.top_overdue_customers || [];
  od.innerHTML = overdue.length ? (
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:112px"></colgroup>' +
    '<thead><tr><th>Customer</th><th class="num">Balance</th></tr></thead><tbody>' +
    overdue.map(x =>
      '<tr><td><div class="dt-main">' + escapeHtml(x.customer_name || 'Unnamed customer') + '</div>' +
      '<div class="dt-sub' + (Number(x.days_overdue) > 90 ? ' late' : '') + '">' +
      escapeHtml(x.invoice_number || '—') + ' · ' + x.days_overdue + 'd overdue</div></td>' +
      '<td class="num">' + inr(x.balance) + '</td></tr>'
    ).join('') + '</tbody></table></div>'
  ) : '<div class="ledger-empty">Nothing overdue right now.</div>';

  // Vendors creating ITC risk — vendor-level, because that is who you chase
  const vl = document.getElementById('zvVendorList');
  const vendors = v.gst_top_at_risk_vendors || [];
  const vsub = document.getElementById('zvVendorSub');
  if(vsub) vsub.textContent = g.filing_period ? ('Period ' + g.filing_period) : 'Latest filing period';
  vl.innerHTML = vendors.length ? (
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:112px"></colgroup>' +
    '<thead><tr><th>Vendor</th><th class="num">At risk</th></tr></thead><tbody>' +
    vendors.map(x =>
      '<tr><td><div class="dt-main">' + escapeHtml(x.vendor_name || 'Unnamed vendor') + '</div>' +
      '<div class="dt-sub">' + escapeHtml(x.vendor_gstin || 'GSTIN not recorded') + '</div></td>' +
      '<td class="num">' + inr(x.at_risk) + '</td></tr>'
    ).join('') + '</tbody></table></div>'
  ) : '<div class="ledger-empty">No input credit at risk this period.</div>';

  zohoBooksUrgent = flags.indexOf('gst_leakage_material') !== -1 ||
                    flags.indexOf('cash_crunch_within_7_days') !== -1 ||
                    flags.indexOf('needs_reauth') !== -1;
  renderBooksBadge();

  renderReconBooksCard();
  wireDscroll(document.getElementById('booksZohoBlocks'));
}

