/* ============================================================
   METRIC LIBRARY. Every indicator Margyn can derive from a single
   snapshot row, so each one gets a value, a delta and a sparkline
   for free. Deterministic arithmetic only, no AI anywhere near it.
   calc(s) returns a number, or null when the inputs aren't there.
   ============================================================ */
const METRIC_GROUPS = ['Profitability', 'Liquidity', 'Working capital', 'Collections', 'Tax', 'Payments'];
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const div = (a, b) => (num(b) === 0 ? null : num(a) / num(b));
const pd = s => (s && s.payments_data) ? s.payments_data : null;
const METRICS = {
  /* Profitability */
  revenue:       { label:'Revenue',              group:'Profitability', unit:'inr',   better:'up',   why:'Top line on this snapshot.',                    calc:s => num(s.revenue) },
  netProfit:     { label:'Net profit',           group:'Profitability', unit:'inr',   better:'up',   why:'What is left after everything.',                calc:s => num(s.net_profit) },
  netMargin:     { label:'Net margin',           group:'Profitability', unit:'pct',   better:'up',   why:'Net profit as a share of revenue.',             calc:s => { const r = div(s.net_profit, s.revenue); return r === null ? null : r * 100; } },
  totalSpend:    { label:'Total spend',          group:'Profitability', unit:'inr',   better:'down', why:'Everything going out this period.',             calc:s => num(s.burn) },
  opexRatio:     { label:'Spend to revenue',     group:'Profitability', unit:'pct',   better:'down', why:'How much of every rupee earned goes back out.', calc:s => { const r = div(s.burn, s.revenue); return r === null ? null : r * 100; } },
  profitPerSpend:{ label:'Profit per ₹ spent',   group:'Profitability', unit:'ratio', better:'up',   why:'Return on every rupee of spend.',               calc:s => div(s.net_profit, s.burn) },
  /* Liquidity */
  cash:          { label:'Cash position',        group:'Liquidity', unit:'inr',    better:'up',   why:'What you can actually spend today.',            calc:s => num(s.cash) },
  netBurn:       { label:'Net burn',             group:'Liquidity', unit:'inr',    better:'down', why:'Spend less revenue. Negative means you are funding yourself.', calc:s => num(s.burn) - num(s.revenue) },
  grossRunway:   { label:'Gross runway',         group:'Liquidity', unit:'months', better:'up',   why:'Cash divided by total spend, ignoring revenue.', calc:s => div(s.cash, s.burn) },
  netRunway:     { label:'Net runway',           group:'Liquidity', unit:'months', better:'up',   why:'Cash divided by net burn. Blank while you are profitable.', calc:s => { const nb = num(s.burn) - num(s.revenue); return nb <= 0 ? null : div(s.cash, nb); } },
  workingCapital:{ label:'Working capital',      group:'Liquidity', unit:'inr',    better:'up',   why:'Cash plus receivables, less payables due.',     calc:s => num(s.cash) + num(s.recv_total) - num(s.pay_soon) },
  quickRatio:    { label:'Quick ratio',          group:'Liquidity', unit:'ratio',  better:'up',   why:'Cash and receivables against payables due.',    calc:s => div(num(s.cash) + num(s.recv_total), s.pay_soon) },
  cashCover:     { label:'Cash cover of payables', group:'Liquidity', unit:'ratio', better:'up',  why:'How many times over your cash clears what is due.', calc:s => div(s.cash, s.pay_soon) },
  /* Working capital cycle */
  dso:           { label:'Days sales outstanding', group:'Working capital', unit:'days', better:'down', why:'How long your money sits with customers.', calc:s => { const r = div(s.recv_total, s.revenue); return r === null ? null : r * 30; } },
  dpo:           { label:'Days payable outstanding', group:'Working capital', unit:'days', better:'up', why:'How long you hold onto vendor money.',   calc:s => { const r = div(s.pay_soon, s.burn); return r === null ? null : r * 30; } },
  ccc:           { label:'Cash conversion cycle', group:'Working capital', unit:'days', better:'down', why:'Days between paying out and getting paid.', calc:s => { const a = div(s.recv_total, s.revenue), b = div(s.pay_soon, s.burn); return (a === null || b === null) ? null : (a - b) * 30; } },
  /* Collections */
  receivables:   { label:'Receivables',          group:'Collections', unit:'inr', better:'down', why:'Everything customers still owe you.',           calc:s => num(s.recv_total) },
  recvOver90:    { label:'Receivables over 90d', group:'Collections', unit:'inr', better:'down', why:'The part that is genuinely at risk.',           calc:s => num(s.recv_90) },
  recvOver90Pct: { label:'Share over 90 days',   group:'Collections', unit:'pct', better:'down', why:'How much of your book has gone stale.',         calc:s => { const r = div(s.recv_90, s.recv_total); return r === null ? null : r * 100; } },
  payablesSoon:  { label:'Payables due (30d)',   group:'Collections', unit:'inr', better:'down', why:'What you owe in the next month.',               calc:s => num(s.pay_soon) },
  netPosition:   { label:'Net ledger position',  group:'Collections', unit:'inr', better:'up',   why:'Owed to you, less owed by you.',                calc:s => num(s.recv_total) - num(s.pay_soon) },
  /* Tax */
  gstLeak:       { label:'GST/ITC leakage',      group:'Tax', unit:'inr', better:'down', why:'Input credit claimed but not vendor-confirmed.',       calc:s => num(s.gst_leak) },
  gstPayable:    { label:'GST payable',          group:'Tax', unit:'inr', better:'down', why:'What is due to the department.',                        calc:s => num(s.gst_payable) },
  gstLeakPct:    { label:'ITC at risk',          group:'Tax', unit:'pct', better:'down', why:'Leakage as a share of GST payable.',                    calc:s => { const r = div(s.gst_leak, s.gst_payable); return r === null ? null : r * 100; } },
  /* Payments */
  payGross:      { label:'Payments processed',   group:'Payments', unit:'inr',  better:'up',   why:'Gross through your gateways.',                    calc:s => { const p = pd(s); return p ? num(p.gross) : null; } },
  payNet:        { label:'Net settled to bank',  group:'Payments', unit:'inr',  better:'up',   why:'After processing fees and refunds.',              calc:s => { const p = pd(s); return p ? num(p.gross) - num(p.mdr) : null; } },
  mdrPct:        { label:'MDR burden',           group:'Payments', unit:'pct',  better:'down', why:'Processing fees as a share of gross.',            calc:s => { const p = pd(s); if(!p) return null; const r = div(p.mdr, p.gross); return r === null ? null : r * 100; } },
  failRate:      { label:'Failed payment rate',  group:'Payments', unit:'pct',  better:'down', why:'Attempted transactions that did not go through.', calc:s => { const p = pd(s); if(!p) return null; const r = div(p.failed, p.total); return r === null ? null : r * 100; } },
  settleLag:     { label:'Settlement lag',       group:'Payments', unit:'days', better:'down', why:'Capture to bank credit.',                         calc:s => { const p = pd(s); return p ? num(p.lag) : null; } },
  avgTxn:        { label:'Average transaction',  group:'Payments', unit:'inr',  better:'up',   why:'Gross divided by transaction count.',             calc:s => { const p = pd(s); return p ? div(p.gross, p.total) : null; } }
};
function metricFormat(v, unit, mode){
  if(v === null || v === undefined || !isFinite(v)) return 'n/a';
  if(unit === 'inr')    return fmtINR(v, mode);
  if(unit === 'pct')    return v.toFixed(1) + '%';
  if(unit === 'days')   return Math.round(v) + 'd';
  if(unit === 'months') return v.toFixed(1) + ' mo';
  if(unit === 'ratio')  return v.toFixed(2) + '×';
  return Math.round(v).toString();
}
function metricValue(key, s){ const m = METRICS[key]; if(!m || !s) return null; try { return m.calc(s); } catch(e){ return null; } }
function metricSeries(key, limit){
  const rows = (snapshots || []).slice(0, limit || 30).reverse();
  return rows.map(s => metricValue(key, s)).filter(v => v !== null && isFinite(v));
}
/* Which metrics each surface shows. Customer-chosen, kept per browser. */
const METRIC_DEFAULTS = {
  summary: ['cash', 'receivables', 'payablesSoon', 'netMargin'],
  scores:  ['netMargin', 'netProfit', 'opexRatio', 'cash', 'grossRunway', 'quickRatio', 'workingCapital', 'dso', 'dpo', 'ccc', 'receivables', 'recvOver90Pct', 'payablesSoon', 'gstLeakPct', 'mdrPct', 'settleLag']
};
function metricSelection(surface){
  try {
    const raw = localStorage.getItem('margyn_metrics_' + surface);
    if(raw){ const a = JSON.parse(raw); if(Array.isArray(a) && a.length) return a.filter(k => METRICS[k]); }
  } catch(e){}
  return METRIC_DEFAULTS[surface].slice();
}
function setMetricSelection(surface, keys){
  try { localStorage.setItem('margyn_metrics_' + surface, JSON.stringify(keys)); } catch(e){}
}
/* A single indicator tile: value, movement against the previous snapshot,
   and a sparkline of its own history. */
function metricCardHtml(key, latest, prev){
  const m = METRICS[key]; if(!m) return '';
  const v = metricValue(key, latest);
  const p = prev ? metricValue(key, prev) : null;
  let dCls = 'flat', dTxt = 'no prior reading';
  if(v !== null && p !== null && isFinite(v) && isFinite(p)){
    const raw = v - p;
    if(Math.abs(raw) < Math.max(Math.abs(p) * 0.0005, 1e-9)){ dCls = 'flat'; dTxt = 'no change'; }
    else {
      const good = m.better === 'up' ? raw > 0 : raw < 0;
      dCls = good ? 'up' : 'down';
      const pct = p === 0 ? null : (raw / Math.abs(p)) * 100;
      dTxt = (raw > 0 ? '▲ ' : '▼ ') + (pct !== null && Math.abs(pct) < 999 ? Math.abs(pct).toFixed(1) + '%' : metricFormat(Math.abs(raw), m.unit));
    }
  } else if(v === null){ dTxt = 'not available yet'; }
  const series = metricSeries(key, 24);
  let spark = '';
  if(series.length > 2){
    const mn = Math.min(...series), mx = Math.max(...series), rg = (mx - mn) || 1;
    const pts = series.map((s, i) => (i / (series.length - 1) * 96 + 2).toFixed(1) + ',' + (26 - ((s - mn) / rg) * 22).toFixed(1)).join(' ');
    const col = dCls === 'down' ? 'var(--rose)' : 'var(--emerald)';
    spark = '<svg class="mx-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  }
  const vTxt = metricFormat(v, m.unit, 'tile');
  return '<div class="mx-card" data-margyn-topic="' + escapeHtml(m.label) + '">' +
    '<div><div class="mx-label">' + escapeHtml(m.label) + '</div>' +
    '<div class="mx-why">' + escapeHtml(m.why) + '</div></div>' +
    '<div>' + (spark || '') + '</div>' +
    '<div class="mx-value' + (v === null ? ' na' : '') + '" title="' + escapeHtml(metricFormat(v, m.unit)) + '">' + escapeHtml(vTxt) + '</div>' +
    '<div class="mx-delta ' + dCls + '">' + escapeHtml(dTxt) + '</div>' +
  '</div>';
}
/* The Scores indicator wall, grouped, driven by the customer's selection. */
function renderScoreMetrics(){
  const host = document.getElementById('scMetrics'); if(!host) return;
  const latest = snapshots[0] || null, prev = snapshots[1] || null;
  const note = document.getElementById('scMetricsNote');
  if(!latest){
    if(note) note.textContent = '';
    host.innerHTML = '<div class="rd-empty"><div class="e-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg></div>' +
      '<h4>No snapshot yet</h4><p>Add one under Upload &amp; calculate and every indicator below fills in, with its own history.</p></div>';
    return;
  }
  const chosen = metricSelection('scores');
  if(note) note.textContent = chosen.length + ' of ' + Object.keys(METRICS).length + ' shown';
  let html = '';
  METRIC_GROUPS.forEach(g => {
    const keys = chosen.filter(k => METRICS[k] && METRICS[k].group === g);
    if(!keys.length) return;
    html += '<div class="mx-group"><div class="mx-group-label">' + escapeHtml(g) + '</div><div class="mx-grid">' +
      keys.map(k => metricCardHtml(k, latest, prev)).join('') + '</div></div>';
  });
  host.innerHTML = html ? ('<div class="mx-panel">' + html + '</div>') : '<div class="ledger-empty">Nothing selected. Use Customize to pick the indicators you want here.</div>';
}
/* ---------- metric picker ---------- */
let metricPickerSurface = 'scores';
let metricPickerDraft = [];
function metricPickerOpen(surface){
  metricPickerSurface = surface;
  metricPickerDraft = metricSelection(surface).slice();
  const t = document.getElementById('metricPickerTitle');
  const sub = document.getElementById('metricPickerSub');
  if(t) t.textContent = surface === 'summary' ? 'What shows on Summary' : 'What shows on Scores';
  if(sub) sub.textContent = surface === 'summary'
    ? 'Pick up to four for the headline row on Summary. Every one is computed from your own snapshots.'
    : 'Every indicator Margyn can derive from your snapshots. Pick the ones you actually run the business on.';
  metricPickerRender();
  document.getElementById('metricPicker').classList.remove('hidden');
}
function metricPickerRender(){
  const body = document.getElementById('metricPickerBody'); if(!body) return;
  let html = '';
  METRIC_GROUPS.forEach(g => {
    const keys = Object.keys(METRICS).filter(k => METRICS[k].group === g);
    if(!keys.length) return;
    html += '<div class="mp-sec">' + escapeHtml(g) + '</div><div class="mp-list">' +
      keys.map(k => {
        const m = METRICS[k], on = metricPickerDraft.includes(k);
        return '<label class="mp-opt' + (on ? ' on' : '') + '" data-k="' + k + '">' +
          '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
          '<span><span class="t">' + escapeHtml(m.label) + '</span><span class="d">' + escapeHtml(m.why) + '</span></span></label>';
      }).join('') + '</div>';
  });
  body.innerHTML = html;
  body.querySelectorAll('.mp-opt').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      const k = el.dataset.k;
      const i = metricPickerDraft.indexOf(k);
      if(i > -1) metricPickerDraft.splice(i, 1);
      else {
        if(metricPickerSurface === 'summary' && metricPickerDraft.length >= 4){
          toast('Summary holds four', { kind:'info', sub:'Remove one before adding another.' });
          return;
        }
        metricPickerDraft.push(k);
      }
      metricPickerRender();
    });
  });
  const c = document.getElementById('metricPickerCount');
  if(c) c.textContent = metricPickerDraft.length + ' selected' + (metricPickerSurface === 'summary' ? ' of 4' : '');
}
(function wireMetricPicker(){
  const overlay = document.getElementById('metricPicker'); if(!overlay) return;
  const close = () => overlay.classList.add('hidden');
  document.getElementById('metricPickerClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
  document.getElementById('metricPickerReset').addEventListener('click', () => {
    metricPickerDraft = METRIC_DEFAULTS[metricPickerSurface].slice();
    metricPickerRender();
  });
  document.getElementById('metricPickerSave').addEventListener('click', () => {
    if(!metricPickerDraft.length){ toast('Pick at least one indicator', { kind:'bad' }); return; }
    setMetricSelection(metricPickerSurface, metricPickerDraft);
    close();
    if(metricPickerSurface === 'summary'){ renderSummary(); toast('Summary updated', { sub: metricPickerDraft.length + ' indicators' }); }
    else { renderScoreMetrics(); toast('Scores updated', { sub: metricPickerDraft.length + ' indicators' }); }
  });
  const sc = document.getElementById('scCustomize');
  if(sc) sc.addEventListener('click', () => metricPickerOpen('scores'));
  const su = document.getElementById('sumCustomize');
  if(su) su.addEventListener('click', () => metricPickerOpen('summary'));
})();
/* Band for a single vital's 0-100 score, same cut-offs as the Pulse bands. */
function vitalBand(score){
  const c = scoreBandCutoffs();
  if(score >= c.healthy) return { cls:'good', label:'Healthy' };
  if(score >= c.caution) return { cls:'warn', label:'Caution' };
  return { cls:'bad', label:'At risk' };
}
/* One vital's score across every snapshot, oldest first. */
function vitalScoreSeries(label){
  return (snapshots || []).slice().reverse().map(s => {
    const hit = (s.vitals || []).find(v => v.label === label);
    return hit ? (Number(hit.score) || 0) : null;
  }).filter(v => v !== null);
}
function renderVitals(vitals, hasData){
  renderVitalsAccordion(vitals, hasData);
}
/* One row per vital: score, weight and points (the math), a sparkline
   (the trend), and an expandable body with the plain-English explanation
   plus a link into the itemized ledger for the two vitals that have one.
   This is the single place that math is shown — see togglePulseBreakdown. */
function renderVitalsAccordion(vitals, hasData){
  const host = document.getElementById('vitalsAccordion'); if(!host) return;
  if(!hasData){
    host.innerHTML = '<div class="rd-empty"><div class="e-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg></div>' +
      '<h4>No snapshot yet</h4><p>Add one under Upload &amp; calculate and each vital breaks down here.</p></div>';
    return;
  }
  const itemized = { 'Receivables Aging':true, 'Payables Due (30d)':true };
  const prov = (snapshots[0] || {}).input_provenance || null;
  const TIER_TAG = { verified:'Verified', connector:'Connected', self:'Self-reported' };
  const vitalSourceTag = label => {
    const t = vitalTier(label, prov);
    const names = (VITAL_INPUTS[label] || [])
      .map(f => (prov && prov[INPUT_COLUMN[f] || f] || {}).source)
      .filter((x, i, a) => x && x !== 'self' && a.indexOf(x) === i);
    const title = names.length ? ('From ' + names.join(' + ')) : 'Entered or uploaded by hand';
    return '<span class="src-tag ' + t + '" title="' + escapeHtml(title) + '">' + TIER_TAG[t] + '</span>';
  };
  host.innerHTML = vitals.map(v => {
    const accent = VITAL_ACCENTS[v.label] || '#5C6B7A';
    const score = Math.max(0, Math.min(100, v.score || 0));
    const band = vitalBand(score);
    const w = VITAL_WEIGHTS[v.label] || 0;
    const pts = score * w;
    const series = vitalScoreSeries(v.label).slice(-24);
    let spark;
    if(series.length < 2){
      spark = '<svg class="sv-acc-spark" viewBox="0 0 100 28" preserveAspectRatio="none"><line x1="0" y1="14" x2="100" y2="14" stroke="var(--border-1)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';
    } else {
      const min = Math.min(...series), max = Math.max(...series), range = (max - min) || 1;
      const pts2 = series.map((s, i) => (i / (series.length - 1) * 98 + 1).toFixed(1) + ',' + (26 - ((s - min) / range) * 22).toFixed(1)).join(' ');
      spark = '<svg class="sv-acc-spark" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="' + pts2 + '" fill="none" stroke="' + accent + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
    }
    const actions = itemized[v.label]
      ? '<div class="sv-acc-actions"><button class="btn-ghost sv-acc-open" data-label="' + escapeHtml(v.label) + '" type="button">Open itemized ledger &rarr;</button></div>'
      : '';
    return '<div class="sv-acc-row" style="--v-accent:' + accent + ';">' +
      '<div class="sv-acc-head" data-label="' + escapeHtml(v.label) + '">' +
        '<span class="sv-acc-accent"></span>' +
        '<span class="sv-acc-name"><span class="sv-acc-label">' + escapeHtml(v.label) + '</span><span class="sv-acc-band ' + band.cls + '">' + band.label + '</span>' + vitalSourceTag(v.label) + '</span>' +
        spark +
        '<span class="sv-acc-score"><b>' + Math.round(score) + '</b>/100</span>' +
        '<span class="sv-acc-weight">' + Math.round(w * 100) + '%</span>' +
        '<span class="sv-acc-pts">' + pts.toFixed(1) + 'pt</span>' +
        '<svg class="sv-acc-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</div>' +
      '<div class="sv-acc-body"><div class="sv-acc-reading"><b style="color:var(--text-0);">Current reading: ' + v.value + '</b></div>' +
        '<div class="sv-acc-explain">' + (VITAL_EXPLAIN[v.label] || '') + '</div>' + actions +
      '</div>' +
    '</div>';
  }).join('');
  host.querySelectorAll('.sv-acc-head').forEach(head => {
    head.addEventListener('click', () => openVitalAccordionRow(head.closest('.sv-acc-row')));
  });
  host.querySelectorAll('.sv-acc-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = vitals.find(x => x.label === btn.dataset.label);
      if(v) openVitalDetail(v, VITAL_ACCENTS[v.label] || '#5C6B7A');
    });
  });
}
function openVitalAccordionRow(row, forceOpen){
  if(!row) return;
  const open = forceOpen === true ? true : !row.classList.contains('open');
  document.querySelectorAll('#vitalsAccordion .sv-acc-row.open').forEach(r => { if(r !== row) r.classList.remove('open'); });
  row.classList.toggle('open', open);
}
/* The contribution ledger: how each vital's score, at its weight, adds up
   to the Pulse Score, and how many points each one is leaving on the table. */
function renderScoreContribution(vitals, hasData){
  const host = document.getElementById('scContrib'); if(!host) return;
  if(!hasData){
    host.innerHTML = '<div class="rd-empty"><div class="e-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg></div>' +
      '<h4>No snapshot yet</h4><p>Add one under Upload &amp; calculate and this breaks your score down point by point.</p></div>';
    return;
  }
  let earned = 0, possible = 0;
  const rows = vitals.map(v => {
    const w = VITAL_WEIGHTS[v.label] || 0;
    const score = Math.max(0, Math.min(100, v.score || 0));
    const pts = score * w;
    const max = 100 * w;
    earned += pts; possible += max;
    return { label:v.label, accent: VITAL_ACCENTS[v.label] || '#5C6B7A', score, w, pts, max };
  }).sort((a, b) => (b.max - b.pts) - (a.max - a.pts)); // biggest point loss first
  const worst = rows[0];
  host.innerHTML =
    '<div class="scc-head"><span>Vital</span><span>Points earned of available</span><span>Weight</span><span>Points</span></div>' +
    rows.map(r =>
      '<div class="scc-row"><div class="scc-name"><span class="scc-dot" style="background:' + r.accent + '"></span>' + escapeHtml(r.label) + '</div>' +
      '<div class="scc-track"><div class="scc-fill" style="width:' + ((r.pts / r.max) * 100).toFixed(1) + '%; background:' + r.accent + ';"></div>' +
        '<div class="scc-lost" style="width:' + (100 - (r.pts / r.max) * 100).toFixed(1) + '%;"></div></div>' +
      '<div class="scc-num">' + Math.round(r.w * 100) + '%</div>' +
      '<div class="scc-pts">' + r.pts.toFixed(1) + ' / ' + r.max.toFixed(0) + '</div></div>'
    ).join('') +
    '<div class="scc-total"><div class="scc-name">Pulse Score</div><div></div><div class="scc-num">100%</div>' +
      '<div class="scc-pts">' + Math.round(earned) + ' / ' + Math.round(possible) + '</div></div>' +
    (worst ? '<div class="scc-foot">Biggest single drag: <strong style="color:var(--text-1);">' + escapeHtml(worst.label) + '</strong>, leaving ' +
      (worst.max - worst.pts).toFixed(1) + ' points on the table. Lift that one vital to full and your score would be ' +
      Math.round(earned + (worst.max - worst.pts)) + '.</div>' : '');
}
/* Small multiples: one sparkline per vital so you can see which are
   improving and which are sliding, rather than one bar chart of today. */
function renderVitalsBarChart(vitals, hasData){
  const host = document.getElementById('vitalsBarChart'); if(!host) return;
  if(!hasData){ host.innerHTML = '<div class="ledger-empty">Add a snapshot to compare your six vitals over time.</div>'; return; }
  host.innerHTML = vitals.map(v => {
    const accent = VITAL_ACCENTS[v.label] || '#5C6B7A';
    const series = vitalScoreSeries(v.label).slice(-24);
    const now = Math.round(v.score || 0);
    const first = series.length ? series[0] : now;
    const d = Math.round(now - first);
    const dCls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    let svg;
    if(series.length < 2){
      svg = '<svg viewBox="0 0 120 44" preserveAspectRatio="none"><line x1="0" y1="22" x2="120" y2="22" stroke="var(--border-1)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';
    } else {
      const min = Math.min(...series), max = Math.max(...series);
      const range = (max - min) || 1;
      const pts = series.map((s, i) => (i / (series.length - 1) * 118 + 1).toFixed(1) + ',' + (40 - ((s - min) / range) * 36).toFixed(1)).join(' ');
      svg = '<svg viewBox="0 0 120 44" preserveAspectRatio="none">' +
        '<polyline points="' + pts + '" fill="none" stroke="' + accent + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
        '<circle cx="119" cy="' + (40 - ((series[series.length-1] - min) / range) * 36).toFixed(1) + '" r="2.4" fill="' + accent + '"/></svg>';
    }
    return '<div class="sc-spark"><div class="ss-top"><span class="ss-label">' + escapeHtml(v.label) + '</span>' +
      '<span><span class="ss-now">' + now + '</span> <span class="ss-delta ' + dCls + '">' +
      (d > 0 ? '▲ +' + d : d < 0 ? '▼ ' + Math.abs(d) : 'flat') + '</span></span></div>' + svg + '</div>';
  }).join('');
}
function openVitalDetail(v, accent){
  const overlay = document.getElementById('detailOverlay');
  const modal = overlay.querySelector('.detail-modal');
  if(v.label === 'Receivables Aging'){ modal.classList.add('wide'); renderReceivablesDetail(accent); overlay.classList.remove('hidden'); renderVitalChatBlock(v.label); return; }
  if(v.label === 'Payables Due (30d)'){ modal.classList.add('wide'); renderPayablesDetail(accent); overlay.classList.remove('hidden'); renderVitalChatBlock(v.label); return; }
  modal.classList.remove('wide');
  const host = document.getElementById('detailContent');
  const pct = Math.max(0, Math.min(100, v.score || 0));
  host.innerHTML =
    '<div class="detail-eyebrow">Vital</div>' +
    '<div class="detail-title">'+v.label+'</div>' +
    '<div class="detail-score-row">' +
      '<div class="detail-score-num" style="color:'+accent+';">'+Math.round(v.score)+'</div>' +
      '<div class="detail-score-bar"><div class="detail-score-fill" style="width:'+pct+'%; background:'+accent+';"></div></div>' +
    '</div>' +
    '<div class="detail-body"><b style="color:var(--text-0);">Current reading: '+v.value+'</b><br><br>' + (VITAL_EXPLAIN[v.label] || '') + '</div>';
  overlay.classList.remove('hidden');
  renderVitalChatBlock(v.label);
}
/* ---------- itemized receivables ledger ---------- */
function renderReceivablesDetail(accent){
  const host = document.getElementById('detailContent');
  const { recvTotal, recv90 } = ledgerAggregates();
  host.innerHTML =
    '<div class="detail-eyebrow">Vital</div><div class="detail-title">Receivables Aging</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Total outstanding: <b style="color:var(--text-0);">'+inr(recvTotal)+'</b> &nbsp;·&nbsp; Over 90 days: <b style="color:#B3432E;">'+inr(recv90)+'</b></div>' +
    '<div class="ledger-form"><div class="lf-title">Add receivable</div>' +
    '<div class="lf-grid"><input type="text" id="recvParty" placeholder="Customer name"><input type="number" id="recvAmt" placeholder="Amount (₹)"></div>' +
    '<div class="lf-grid"><input type="date" id="recvDue"><span></span></div>' +
    '<button id="recvAddBtn">Add to ledger</button></div>' +
    '<div class="ledger-list-title">Open invoices ('+receivables.length+')</div>' +
    '<div id="recvList"></div>';
  renderReceivablesList();
  document.getElementById('recvAddBtn').addEventListener('click', async () => {
    const party = document.getElementById('recvParty').value.trim();
    const amt = Number(document.getElementById('recvAmt').value);
    const due = document.getElementById('recvDue').value || null;
    if(!party || !amt) return;
    try {
      const { error } = await sbClient.from('receivables').insert({ user_id:currentUser.id, party_name:party, amount:amt, due_date:due, status:'open', source:'manual' });
      if(error) throw error;
      await logLedgerEvent({ entityType:'receivable', event:'created', partyName:party, amount:amt, source:'manual' });
      receivables = await loadReceivables();
      await saveLedgerSnapshot();
      renderReceivablesDetail(accent);
    } catch(err){ toast('Could not add: ' + (err.message||'unknown error'), {kind:'bad'}); }
  });
}
function renderReceivablesList(){
  const list = document.getElementById('recvList');
  if(!receivables.length){ list.innerHTML = '<div class="ledger-empty">No open receivables. Add one above.</div>'; return; }
  list.innerHTML = '';
  receivables.forEach(r => {
    const b = recvBucket(r.due_date);
    const row = document.createElement('div'); row.className = 'ledger-row';
    row.innerHTML =
      '<div class="lr-main"><div class="lr-party">'+escapeHtml(r.party_name)+ledgerRowTags(r)+'</div>' +
      '<div class="lr-meta">due '+(r.due_date?fmtDay(r.due_date):'—')+(b.tag?'<span class="lr-tag '+b.tag+'">'+b.label+'</span>':'')+'</div></div>' +
      '<div class="lr-amount">'+inr(r.amount)+'</div>' +
      '<div class="lr-actions"><button class="lr-btn" data-act="collect">Mark received</button><button class="lr-btn danger" data-act="del">Delete</button></div>';
    row.querySelector('[data-act="collect"]').addEventListener('click', () => collectReceivable(r));
    row.querySelector('[data-act="del"]').addEventListener('click', () => deleteReceivable(r));
    list.appendChild(row);
  });
}
async function collectReceivable(r){
  try {
    const { error } = await sbClient.from('receivables').update({ status:'settled', settled_at:new Date().toISOString(), settled_amount:r.amount, settled_kind:'received' }).eq('id', r.id);
    if(error) throw error;
    await logLedgerEvent({ entityType:'receivable', entityId:r.id, event:'settled', partyName:r.party_name, amount:r.amount, source:r.source||'manual', note:'marked received' });
    receivables = await loadReceivables();
    await saveLedgerSnapshot();
    renderReceivablesDetail('#B3432E');
  } catch(err){ toast('Could not mark as received: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
async function deleteReceivable(r){
  try {
    await logLedgerEvent({ entityType:'receivable', entityId:r.id, event:'deleted', partyName:r.party_name, amount:r.amount, source:r.source||'manual' });
    const { error } = await sbClient.from('receivables').delete().eq('id', r.id);
    if(error) throw error;
    receivables = await loadReceivables();
    await saveLedgerSnapshot();
    renderReceivablesDetail('#B3432E');
  } catch(err){ toast('Could not delete: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
/* ---------- itemized payables ledger ---------- */
function renderPayablesDetail(accent){
  const host = document.getElementById('detailContent');
  const { paySoon } = ledgerAggregates();
  const total = payables.reduce((s,p) => s + Number(p.amount), 0);
  host.innerHTML =
    '<div class="detail-eyebrow">Vital</div><div class="detail-title">Payables Due</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Total outstanding: <b style="color:var(--text-0);">'+inr(total)+'</b> &nbsp;·&nbsp; Due within 30 days: <b style="color:#5B6472;">'+inr(paySoon)+'</b></div>' +
    '<div class="ledger-form"><div class="lf-title">Add payable</div>' +
    '<div class="lf-grid"><input type="text" id="payParty" placeholder="Vendor name"><input type="number" id="payAmt" placeholder="Amount (₹)"></div>' +
    '<div class="lf-grid"><input type="date" id="payDue"><span></span></div>' +
    '<button id="payAddBtn">Add to ledger</button></div>' +
    '<div class="ledger-list-title">Open bills ('+payables.length+')</div>' +
    '<div id="payList"></div>';
  renderPayablesList();
  document.getElementById('payAddBtn').addEventListener('click', async () => {
    const party = document.getElementById('payParty').value.trim();
    const amt = Number(document.getElementById('payAmt').value);
    const due = document.getElementById('payDue').value || null;
    if(!party || !amt) return;
    try {
      const { error } = await sbClient.from('payables').insert({ user_id:currentUser.id, party_name:party, amount:amt, due_date:due, status:'open', source:'manual' });
      if(error) throw error;
      await logLedgerEvent({ entityType:'payable', event:'created', partyName:party, amount:amt, source:'manual' });
      payables = await loadPayables();
      await saveLedgerSnapshot();
      renderPayablesDetail(accent);
    } catch(err){ toast('Could not add: ' + (err.message||'unknown error'), {kind:'bad'}); }
  });
}
function renderPayablesList(){
  const list = document.getElementById('payList');
  if(!payables.length){ list.innerHTML = '<div class="ledger-empty">No open payables. Add one above.</div>'; return; }
  list.innerHTML = '';
  payables.forEach(p => {
    const u = payUrgency(p.due_date);
    const row = document.createElement('div'); row.className = 'ledger-row';
    row.innerHTML =
      '<div class="lr-main"><div class="lr-party">'+escapeHtml(p.party_name)+ledgerRowTags(p)+'</div>' +
      '<div class="lr-meta">due '+(p.due_date?fmtDay(p.due_date):'—')+'<span class="lr-tag '+u.tag+'">'+u.label+'</span></div></div>' +
      '<div class="lr-amount">'+inr(p.amount)+'</div>' +
      '<div class="lr-actions"><button class="lr-btn" data-act="pay">Mark paid</button><button class="lr-btn danger" data-act="del">Delete</button></div>';
    row.querySelector('[data-act="pay"]').addEventListener('click', () => payPayable(p));
    row.querySelector('[data-act="del"]').addEventListener('click', () => deletePayable(p));
    list.appendChild(row);
  });
}
async function payPayable(p){
  try {
    const { error } = await sbClient.from('payables').update({ status:'settled', settled_at:new Date().toISOString(), settled_amount:p.amount, settled_kind:'paid' }).eq('id', p.id);
    if(error) throw error;
    await logLedgerEvent({ entityType:'payable', entityId:p.id, event:'settled', partyName:p.party_name, amount:p.amount, source:p.source||'manual', note:'marked paid' });
    payables = await loadPayables();
    await saveLedgerSnapshot();
    renderPayablesDetail('#5B6472');
  } catch(err){ toast('Could not mark as paid: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
async function deletePayable(p){
  try {
    await logLedgerEvent({ entityType:'payable', entityId:p.id, event:'deleted', partyName:p.party_name, amount:p.amount, source:p.source||'manual' });
    const { error } = await sbClient.from('payables').delete().eq('id', p.id);
    if(error) throw error;
    payables = await loadPayables();
    await saveLedgerSnapshot();
    renderPayablesDetail('#5B6472');
  } catch(err){ toast('Could not delete: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
document.getElementById('detailClose').addEventListener('click', () => document.getElementById('detailOverlay').classList.add('hidden'));
document.getElementById('detailOverlay').addEventListener('click', (e) => { if(e.target.id === 'detailOverlay') e.currentTarget.classList.add('hidden'); });

/* ---------- Margyn Findings ----------
   Detection and narration both now happen server-side, in
   api/generate-findings.js, triggered right after a snapshot is saved
   (see triggerFindingsGeneration). By the time anyone opens a vital or
   the global panel, findings are already sitting in the `findings`
   table with their narration pre-written — this code only reads and
   renders them. No client-side detection, no click-triggered API call
   to reveal a finding; "Explain why" is an instant local reveal.

   Server-side, Claude looks at the WHOLE evidence sheet (multiple past
   snapshots across all three connectors) and proposes candidate
   findings + corroborating metrics — real correlation discovery, not a
   hardcoded lookup table. A deterministic validator then re-checks every
   claim against the actual numbers before anything is allowed to be
   tiered VERIFIED: the cited corroborator must be real, must come from
   an independently operated source (Razorpay or Shopify — never another
   vital derived from the same inputs), and must show an actual move.
   Anything that fails is downgraded to SIGNAL or dropped. See
   api/generate-findings.js for the full pipeline.

   Free-text chat remains — for "what does this number mean" questions,
   or a follow-up after a finding's been read — but stays the secondary
   control beneath the findings, never the first thing shown. */
/* ---------- Chat persistence ----------
   Every exchange (a finding's "Explain why" reveal, and free-text
   follow-ups) is saved to chat_messages, keyed by thread_key:
   - 'finding:<finding id>'  — anchored to one specific Finding
   - 'vital:<label>::<session suffix>' — a per-vital ask with no active
     finding. The session suffix is generated fresh the first time a
     given topic is clicked on THIS page load (see sessionThreadKeyFor
     below) so a refresh, or logging out and back in, always opens that
     topic's chat clean instead of replaying whatever was asked last
     time. Click the same topic again without reloading and it's the
     same key, so it continues.
   - 'global'                — the floating panel's general thread
   Reopening the same vital/finding/panel automatically replays its saved
   thread — that's "access previous chats" for the natural entry points.
   The history browser (clock icon in the panel header) additionally lists every
   thread across the account for jumping back into an older one.

   CHAT_CONTEXT_CAP bounds how many past turns get sent to the model on
   each call — the saved thread can grow indefinitely for the user to
   read, but only the last few turns are ever replayed into the prompt,
   matching the cap ask-margyn.js already enforces server-side. */
const CHAT_CONTEXT_CAP = 8;

/* Which agent (Margyn the CFO, or a specialist — Chase/Close/Import) is
   currently active per conversation thread. Keyed by threadKey so each
   conversation keeps its own agent state; a new thread (askNewConversation)
   always starts back at Margyn. Server confirms/drives the actual switch
   via handoff_to_agent (see api/_lib/agentRegistry.js) — this map just
   remembers which agent's turn it is for the next message in this thread. */
const threadAgentMap = new Map();
function getThreadAgent(tk){ return threadAgentMap.get(tk) || 'margyn'; }
const AGENT_META = {
  margyn: { name:'Margyn', sub:'Grounded in your connected data', icon:'margyn' },
  chase:  { name:'Chase Agent', sub:'Collections — chasing overdue receivables', icon:'chase' },
  close:  { name:'Close Agent', sub:'Reconciliation — the Agent Queue', icon:'close' },
  import: { name:'Import Agent', sub:'Triaging pending invoices & bills', icon:'import' }
};
/* One glyph per agent — never a distinct hue (orange stays the single
   "AI-generated narrative" colour product-wide, per the locked palette in
   :root). Feather-style, 24x24, stroke=currentColor, matching every other
   icon already in this file. */
const AGENT_ICON_SVG = {
  margyn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  chase:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  close:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
};
function agentAvatarInner(agentId){ return AGENT_ICON_SVG[agentId] || AGENT_ICON_SVG.margyn; }
/* Render (or update) the header avatar for the active agent. Only plays the
   pop-in animation when the agent actually changed — reused on every
   askSetTitle call, most of which don't touch the agent at all. */
let _lastHeaderAgentId = null;
function setThreadAvatar(agentId){
  const el = document.getElementById('askThreadAvatar'); if(!el) return;
  const id = agentId || 'margyn';
  el.innerHTML = agentAvatarInner(id);
  el.classList.remove('pop');
  if(id !== _lastHeaderAgentId){
    void el.offsetWidth; // restart animation even if same class was already applied once
    el.classList.add('pop');
  }
  _lastHeaderAgentId = id;
}

