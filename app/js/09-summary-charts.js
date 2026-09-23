/* ============================================================
   SUMMARY (NEW) — the top overview: KPI strip with sparklines,
   a revenue trend chart, real rule-based alerts, and a stat strip.
   Every figure reads real data only (latest snapshot / ledger /
   payments) — shows zero, never a mock number, until you upload
   or enter something.
   ============================================================ */
const ICONS = {
  wallet: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
  inbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>',
  percent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
};
function deltaBadge(curr, prev, opts){
  opts = opts || {};
  if(prev === null || prev === undefined) return { cls:'flat', text:'no prior reading' };
  const diff = curr - prev;
  if(Math.abs(diff) < 1e-6) return { cls:'flat', text:'no change vs prior' };
  const invert = !!opts.invert; // true when a lower reading is the good direction (e.g. spend)
  const good = invert ? diff < 0 : diff > 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const pctText = prev !== 0 ? (Math.abs(diff/prev*100).toFixed(1) + '%') : inr(Math.abs(diff));
  return { cls: good ? 'up' : 'down', text: arrow + ' ' + pctText + ' vs prior' };
}
let sparkGradId = 0;
function sparklineSvg(values, color){
  color = color || '#0E8F5C';
  const clean = (values||[]).map(v => Number(v)||0);
  if(clean.length < 2) return '<svg class="kc-spark" viewBox="0 0 100 32" preserveAspectRatio="none"></svg>';
  const min = Math.min(...clean), max = Math.max(...clean);
  const range = (max - min) || 1;
  const W=100, H=32, PAD=3;
  const pts = clean.map((v,i) => ({
    x: PAD + (i/(clean.length-1))*(W-2*PAD),
    y: H-PAD - ((v-min)/range)*(H-2*PAD)
  }));
  const gid = 'sg'+(sparkGradId++);
  const linePath = smoothPath(pts);
  const last = pts[pts.length-1];
  const areaPath = linePath+' L'+last.x.toFixed(1)+','+(H-PAD)+' L'+pts[0].x.toFixed(1)+','+(H-PAD)+' Z';
  return '<svg class="kc-spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">' +
    '<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity="0.16"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="'+areaPath+'" fill="url(#'+gid+')"/>' +
    '<path class="draw-line" d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="'+last.x.toFixed(1)+'" cy="'+last.y.toFixed(1)+'" r="2" fill="'+color+'"/></svg>';
}
/* ============================================================
   Chart.js wrapper for the redesigned surfaces (Summary, Analytics).
   spec = { type:'line'|'bar'|'area'|'combo', labels:[],
            series:[ {name, color, unit:'inr'|'pct'|'score', data:[], type?} ], h }
   rdChart() returns markup with a <canvas>; call rdMountCharts(root) after
   inserting it so the actual Chart is instantiated (Chart.js needs a laid-out
   canvas). Instances are tracked and dead ones are swept on each mount.
   ============================================================ */
let _rdChartSeq = 0;
const _rdChartSpecs = {};
const _rdChartInstances = {};
function _cssVar(name, fallback){
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; } catch(e){ return fallback; }
}
function _hexA(hex, a){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex||'').replace('#',''));
  if(!m) return hex;
  return 'rgba(' + parseInt(m[1],16) + ',' + parseInt(m[2],16) + ',' + parseInt(m[3],16) + ',' + a + ')';
}
function _fmtUnit(v, unit){
  v = Number(v) || 0;
  if(unit === 'pct') return v.toFixed(1) + '%';
  if(unit === 'score') return Math.round(v).toString();
  return inr(Math.round(v));
}
function _shortUnit(v, unit){
  v = Number(v) || 0;
  if(unit === 'pct') return v.toFixed(0) + '%';
  if(unit === 'score') return Math.round(v).toString();
  const a = Math.abs(v);
  if(a >= 1e7) return '₹' + (v/1e7).toFixed(1) + 'Cr';
  if(a >= 1e5) return '₹' + (v/1e5).toFixed(1) + 'L';
  if(a >= 1e3) return '₹' + Math.round(v/1e3) + 'k';
  return '₹' + Math.round(v);
}
function rdChart(spec){
  const id = 'rdc' + (++_rdChartSeq);
  _rdChartSpecs[id] = spec;
  const h = spec.h || 200;
  return '<div class="rd-chart" style="height:' + h + 'px; position:relative;"><canvas id="' + id + '"></canvas></div>';
}
function _rdBuildConfig(spec){
  const series = spec.series || [];
  // group series onto axes by "scale signature": unit + whether it is a
  // flow total (bars, big) or a point-in-time level (small). Revenue summed
  // over a month and a cash balance are both rupees but must not share a scale.
  const sig = s => (s.unit || 'inr') + '|' + (s.type === 'bar' ? 'flow' : 'level');
  const sigs = [];
  series.forEach(s => { const g = sig(s); if(!sigs.includes(g)) sigs.push(g); });
  const units = sigs.map(g => g.split('|')[0]);
  const axisFor = s => sigs.length > 1 && sig(s) === sigs[1] ? 'y1' : 'y';
  const ink3 = _cssVar('--text-3', '#9AA1AD');
  const ink2 = _cssVar('--text-2', '#767E8B');
  const hair = _cssVar('--border-1', '#E4E1DA');
  const fontF = 'Manrope, system-ui, sans-serif';
  const monoF = 'IBM Plex Mono, monospace';
  const anyBar = series.some(s => (s.type || spec.type) === 'bar' || spec.type === 'bar' || spec.type === 'combo');
  const datasets = series.map((s, i) => {
    const stype = s.type || (spec.type === 'combo' ? (i === 0 ? 'bar' : 'line') : spec.type);
    const isBar = stype === 'bar';
    const isArea = stype === 'area';
    return {
      label: s.name || ('Series ' + (i+1)),
      data: s.data.map(Number),
      _unit: s.unit || 'inr',
      type: isBar ? 'bar' : 'line',
      yAxisID: axisFor({ unit: s.unit || 'inr', type: stype }),
      order: isBar ? 2 : 1,
      borderColor: s.color,
      backgroundColor: isBar ? s.color : (isArea ? _hexA(s.color, 0.14) : s.color),
      borderWidth: isBar ? 0 : 2.25,
      borderRadius: isBar ? 5 : 0,
      maxBarThickness: 34,
      categoryPercentage: 0.62,
      barPercentage: 0.88,
      tension: 0.32,
      cubicInterpolationMode: 'monotone',
      fill: isArea ? 'origin' : false,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: s.color,
      pointHoverBorderColor: '#fff',
      pointHoverBorderWidth: 1.5,
      clip: 8
    };
  });
  const scales = {
    x: {
      grid: { display: false, drawBorder: false },
      border: { display: false },
      ticks: { font: { family: monoF, size: 9 }, color: ink3, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, padding: 6 }
    },
    y: {
      position: 'left',
      beginAtZero: units[0] !== 'score',
      grid: { color: hair, drawTicks: false, drawBorder: false },
      border: { display: false },
      ticks: { font: { family: monoF, size: 9 }, color: ink3, padding: 8, maxTicksLimit: 5, callback: v => _shortUnit(v, units[0]) }
    }
  };
  if(units.length > 1){
    scales.y1 = {
      position: 'right',
      beginAtZero: units[1] !== 'score',
      grid: { display: false, drawBorder: false },
      border: { display: false },
      ticks: { font: { family: monoF, size: 9 }, color: ink3, padding: 8, maxTicksLimit: 5, callback: v => _shortUnit(v, units[1]) }
    };
  }
  return {
    type: anyBar ? 'bar' : 'line',
    data: { labels: spec.labels || [], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 6, right: 4, bottom: 0, left: 0 } },
      plugins: {
        legend: {
          display: series.length > 1,
          position: 'bottom',
          align: 'start',
          labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 6, boxHeight: 6, padding: 14, font: { family: fontF, size: 11, weight: '600' }, color: ink2 }
        },
        tooltip: {
          backgroundColor: '#14181F',
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          usePointStyle: true,
          titleFont: { family: monoF, size: 10, weight: '600' },
          bodyFont: { family: monoF, size: 11 },
          bodySpacing: 5,
          callbacks: { label: ctx => '  ' + ctx.dataset.label + ':  ' + _fmtUnit(ctx.raw, ctx.dataset._unit) }
        }
      },
      scales
    }
  };
}
function rdRefreshCharts(){
  if(typeof Chart === 'undefined') return;
  requestAnimationFrame(() => {
    Object.keys(_rdChartInstances).forEach(k => {
      if(!document.getElementById(k)) return;
      try { _rdChartInstances[k].resize(); } catch(e){}
    });
  });
}
function rdMountCharts(root){
  if(typeof Chart === 'undefined') return;
  root = root || document;
  // sweep instances whose canvas has left the DOM
  Object.keys(_rdChartInstances).forEach(k => {
    if(!document.getElementById(k)){ try { _rdChartInstances[k].destroy(); } catch(e){} delete _rdChartInstances[k]; }
  });
  root.querySelectorAll('canvas[id^="rdc"]').forEach(cv => {
    const spec = _rdChartSpecs[cv.id];
    if(!spec || cv.dataset.mounted) return;
    cv.dataset.mounted = '1';
    try { _rdChartInstances[cv.id] = new Chart(cv.getContext('2d'), _rdBuildConfig(spec)); } catch(e){ console.error('[margyn] chart mount failed', e); }
    delete _rdChartSpecs[cv.id];
  });
}
/* bucket snapshot rows by Snapshot / Week / Month / Quarter for Analytics */
function rdBucketRows(rows, groupBy){
  if(!groupBy || groupBy === 'Snapshot') return rows.map(r => ({ created_at: r.created_at, _label: fmtMon(r.created_at), _group: [r] }));
  const keyOf = iso => {
    const dt = new Date(iso);
    if(groupBy === 'Week'){
      const oneJan = new Date(dt.getFullYear(), 0, 1);
      const wk = Math.ceil((((dt - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
      return dt.getFullYear() + '-W' + String(wk).padStart(2, '0');
    }
    if(groupBy === 'Quarter') return dt.getFullYear() + '-Q' + (Math.floor(dt.getMonth() / 3) + 1);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
  };
  const labelOf = k => {
    if(groupBy === 'Week') return k.split('-')[1];
    if(groupBy === 'Quarter'){ const [y, q] = k.split('-'); return q + " '" + y.slice(2); }
    const [y, m] = k.split('-');
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1] + " '" + y.slice(2);
  };
  const map = new Map();
  rows.forEach(r => { const k = keyOf(r.created_at); if(!map.has(k)) map.set(k, []); map.get(k).push(r); });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, grp]) => ({
    created_at: grp[grp.length - 1].created_at, _label: labelOf(k), _group: grp
  }));
}
function rdMetricSeries(metricKey, buckets){
  const M = ANALYTICS_METRICS[metricKey]; if(!M) return buckets.map(() => 0);
  return buckets.map(b => {
    const grp = b._group || [b];
    if(M.agg === 'sum') return grp.reduce((s, r) => s + (Number(M.val(r)) || 0), 0);
    return Number(M.val(grp[grp.length - 1])) || 0;
  });
}
function renderRevenueTrendChart(hist){
  const host = document.getElementById('revenueTrendChart'); if(!host) return;
  const sub = document.getElementById('revTrendSub'); if(!sub) return;
  if(hist.length < 2){
    sub.textContent = 'Add a second snapshot to see a trend line';
    host.innerHTML = '<div class="trend-empty">Revenue trend appears once you have at least two snapshots.</div>';
    return;
  }
  const vals = hist.map(r => Number(r.revenue)||0);
  const first = vals[0], last = vals[vals.length-1];
  const changePct = first !== 0 ? ((last-first)/first*100) : null;
  sub.textContent = changePct===null ? 'vs first snapshot' : ((changePct>=0?'▲ +':'▼ ')+Math.abs(changePct).toFixed(1)+'% vs first snapshot');
  const W = 640, H = 130, PAD = 10;
  const max = Math.max(...vals, 1), min = 0;
  const x = i => PAD + (i/(vals.length-1)) * (W-2*PAD);
  const y = v => H-PAD - ((v-min)/(max-min||1)) * (H-2*PAD);
  const pts = vals.map((v,i) => ({x:x(i), y:y(v)}));
  const linePath = smoothPath(pts);
  const lastPt = pts[pts.length-1];
  const areaPath = linePath+' L'+lastPt.x.toFixed(1)+','+(H-PAD)+' L'+pts[0].x.toFixed(1)+','+(H-PAD)+' Z';
  const endDot = '<circle cx="'+lastPt.x.toFixed(1)+'" cy="'+lastPt.y.toFixed(1)+'" r="7" fill="#0E8F5C" fill-opacity="0.14"/>' +
    '<circle cx="'+lastPt.x.toFixed(1)+'" cy="'+lastPt.y.toFixed(1)+'" r="3.6" fill="#0E8F5C" stroke="#FFFFFF" stroke-width="1.5"><title>'+fmtDate(hist[hist.length-1].created_at)+': '+inr(vals[vals.length-1])+'</title></circle>';
  host.innerHTML = '<svg class="trend-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">' +
    '<defs><linearGradient id="revGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0E8F5C" stop-opacity="0.14"/><stop offset="100%" stop-color="#0E8F5C" stop-opacity="0"/></linearGradient></defs>' +
    gridlinesSvg(W, H, PAD, 3) +
    '<line x1="'+PAD+'" y1="'+(H-PAD)+'" x2="'+(W-PAD)+'" y2="'+(H-PAD)+'" stroke="rgba(20,24,31,0.1)" stroke-width="1"/>' +
    '<path class="area-fill" d="'+areaPath+'" fill="url(#revGlow)"/>' +
    '<path class="draw-line" d="'+linePath+'" fill="none" stroke="#0E8F5C" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
    endDot + '</svg>';
  animateDrawLine(host);
}
function renderAlerts(latest, recvTotal, recv90, paySoon, pay){
  const host = document.getElementById('alertsList'); const sub = document.getElementById('alertsSub');
  if(!host || !sub) return;
  const items = [];
  if(latest){
    const vitalsMap = {}; (latest.vitals||[]).forEach(v => vitalsMap[v.label]=v);
    const runwayV = vitalsMap['Working Capital Runway'];
    if(runwayV){
      const months = parseFloat(runwayV.value);
      if(!isNaN(months)){
        if(months < BENCH.runwayMin) items.push({ sev:'bad', title:'Runway is tight', desc:'Working capital runway is '+runwayV.value+', below the '+BENCH.runwayMin+' month floor.', nav:{view:'scores'} });
        else if(months < BENCH.runwayMax) items.push({ sev:'warn', title:'Runway below target', desc:'Working capital runway is '+runwayV.value+', short of the '+BENCH.runwayMax+' month target.', nav:{view:'scores'} });
      }
    }
    if(recvTotal > 0){
      const ratio = recv90/recvTotal;
      if(ratio > 0.3) items.push({ sev:'bad', title:'Receivables aging out', desc: inr(recv90)+' ('+(ratio*100).toFixed(0)+'%) of receivables are over 90 days overdue.', nav:{view:'ledger', ltab:'receivables'} });
      else if(recv90 > 0) items.push({ sev:'warn', title:'Some receivables overdue', desc: inr(recv90)+' is over 90 days overdue, worth a nudge.', nav:{view:'ledger', ltab:'receivables'} });
    }
    if(paySoon > 0 && Number(latest.cash) > 0 && paySoon > Number(latest.cash)*0.5){
      items.push({ sev: paySoon > Number(latest.cash) ? 'bad' : 'warn', title:'Payables due soon', desc: inr(paySoon)+' is due in the next 30 days against '+inr(latest.cash)+' cash on hand.', nav:{view:'ledger', ltab:'payables'} });
    }
    if(Number(latest.gst_payable) > 0 && Number(latest.gst_leak) > 0){
      const ratio = Number(latest.gst_leak)/Number(latest.gst_payable);
      if(ratio > BENCH.gstBad) items.push({ sev:'bad', title:'ITC going unclaimed', desc: inr(latest.gst_leak)+' in input credit is unclaimed against '+inr(latest.gst_payable)+' payable.', nav:{view:'scores'} });
      else if(ratio > 0) items.push({ sev:'warn', title:'Some ITC unclaimed', desc: inr(latest.gst_leak)+' in input credit hasn’t been reconciled yet.', nav:{view:'scores'} });
    }
  }
  if(pay){
    const m = computePaymentsMetrics(pay);
    const ff = flagFor('fail', m.failRate); if(ff.c==='bad'||ff.c==='warn') items.push({ sev:ff.c, title:'Failed payment rate '+ff.t.toLowerCase(), desc: m.failRate.toFixed(1)+'% of transactions failed this period.', nav:{view:'payments'} });
    const mf = flagFor('mdr', m.mdrPct); if(mf.c==='bad'||mf.c==='warn') items.push({ sev:mf.c, title:'MDR burden '+mf.t.toLowerCase(), desc: m.mdrPct.toFixed(2)+'% of gross is going to processing fees.', nav:{view:'payments'} });
    const lf = flagFor('lag', m.lag); if(lf.c==='bad') items.push({ sev:'bad', title:'Settlement lag slow', desc: m.lag.toFixed(1)+' days average, transaction capture to bank credit.', nav:{view:'payments'} });
  }
  const order = { bad:0, warn:1 };
  items.sort((a,b) => order[a.sev]-order[b.sev]);
  if(!latest){ sub.textContent = 'no data yet'; host.innerHTML = '<div class="ledger-empty">Add a snapshot to see what needs attention.</div>'; return; }
  sub.textContent = items.length ? (items.length + ' to review') : 'all clear';
  if(!items.length){
    host.innerHTML = '<div class="rd-attn" style="cursor:default;"><span class="ic ok">✓</span><div><h4>Nothing needs attention</h4><p>No issues found on your latest snapshot.</p></div></div>';
    return;
  }
  host.innerHTML = items.map((it, i) =>
    '<div class="rd-attn' + (it.nav ? ' is-clickable' : '') + '" data-idx="'+i+'"><span class="ic '+(it.sev==='bad'?'bad':'warn')+'">'+(it.sev==='bad'?'!':'i')+'</span>' +
    '<div><h4>'+it.title+'</h4><p>'+it.desc+'</p></div>' +
    (it.nav ? '<span class="go">→</span>' : '') +
    '</div>'
  ).join('');
  host.querySelectorAll('.rd-attn[data-idx]').forEach(el => {
    const it = items[Number(el.dataset.idx)];
    if(!it.nav) return;
    el.addEventListener('click', () => { if(it.nav.ltab) ledgerActiveTab = it.nav.ltab; showView(it.nav.view); });
  });
}
function renderLedgerInsight(){
  const host = document.getElementById('ledgerInsightList'); const sub = document.getElementById('ledgerInsightSub');
  if(!host || !sub) return;
  const rows = [
    ...receivables.map(r => ({ ...r, kind:'recv', badge: recvBucket(r.due_date) })),
    ...payables.map(p => ({ ...p, kind:'pay', badge: payUrgency(p.due_date) }))
  ];
  const rank = { bad:0, warn:1, ok:2, '':3 };
  rows.sort((a,b) => (rank[a.badge.tag]??3) - (rank[b.badge.tag]??3));
  const top = rows.slice(0,4);
  sub.textContent = (receivables.length + payables.length) + ' open item' + ((receivables.length + payables.length)===1?'':'s');
  if(!top.length){
    host.innerHTML = '<div class="alert-empty">No open receivables or payables. Add one in the Ledger.</div>';
    return;
  }
  host.innerHTML = top.map((r,i) =>
    '<div class="ledger-row" data-idx="'+i+'" style="cursor:pointer;">' +
    '<div class="lr-main"><div class="lr-party">'+escapeHtml(r.party_name)+
    '<span class="lr-tag '+(r.kind==='recv'?'type-recv':'type-pay')+'">'+(r.kind==='recv'?'Receivable':'Payable')+'</span></div>' +
    '<div class="lr-meta">due '+(r.due_date?fmtDay(r.due_date):'—')+(r.badge.tag?'<span class="lr-tag '+r.badge.tag+'">'+r.badge.label+'</span>':'')+'</div></div>' +
    '<div class="lr-amount">'+inr(r.amount)+'</div>' +
    '</div>'
  ).join('') +
  '<a href="javascript:void(0)" id="viewFullLedgerLink" style="display:block; margin-top:14px; font-size:12.5px; font-weight:600; color:var(--emerald);">View full ledger →</a>';
  host.querySelectorAll('.ledger-row[data-idx]').forEach(el => {
    el.addEventListener('click', () => { ledgerActiveTab = top[Number(el.dataset.idx)].kind === 'recv' ? 'receivables' : 'payables'; showView('ledger'); });
  });
  const link = document.getElementById('viewFullLedgerLink');
  if(link) link.addEventListener('click', () => { ledgerActiveTab = 'all'; showView('ledger'); });
}
function renderSummary(){
  const strip = document.getElementById('kpiStrip'); if(!strip) return;
  renderConfidence();
  const latest = snapshots[0] || null;
  const prev = snapshots[1] || null;
  const { recvTotal, recv90, paySoon } = ledgerAggregates();
  const pay = paymentsData;

  const hr = new Date().getHours();
  const gEl = document.getElementById('summaryGreeting');
  if(gEl) gEl.textContent = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('summaryHeadline').textContent = currentProfile ? currentProfile.company_name : 'Your business';
  const pl = document.getElementById('summaryProfileLine');
  if(pl) pl.textContent = currentProfile ? [REV_LABEL[currentProfile.revenue_range], currentProfile.industry, currentProfile.city].filter(Boolean).join(' · ') : '';
  document.getElementById('summaryAsOf').textContent = latest ? ('As of ' + fmtDate(latest.created_at)) : 'No data yet';

  const vBand = latest ? scoreBand(latest.pulse_score) : { color:'var(--text-2)', label:'No data yet' };
  const vNum = document.getElementById('verdictNum');
  vNum.textContent = latest ? latest.pulse_score : '—';
  vNum.style.color = latest ? vBand.color : '';
  const vBadge = document.getElementById('verdictBand');
  vBadge.textContent = vBand.label; vBadge.style.color = vBand.color;
  const pd = (latest && prev) ? latest.pulse_score - prev.pulse_score : null;
  const vdEl = document.getElementById('verdictDelta');
  vdEl.textContent = !latest ? 'Upload a snapshot to see your score'
    : (pd === null ? 'First snapshot'
      : pd === 0 ? 'No change since your last snapshot'
      : (pd > 0 ? '▲ +' : '▼ ') + Math.abs(pd) + (Math.abs(pd) === 1 ? ' point' : ' points') + ' since your last snapshot');
  vdEl.style.color = pd === null || pd === 0 ? '' : (pd > 0 ? 'var(--emerald-deep)' : 'var(--rose)');
  document.getElementById('verdictCta').onclick = () => { showView('scores'); togglePulseBreakdown(true); };

  const hist = snapshots.slice(0,13).slice().reverse();
  const marginNow = latest && Number(latest.revenue) ? (Number(latest.net_profit)/Number(latest.revenue))*100 : 0;
  const marginPrev = prev && Number(prev.revenue) ? (Number(prev.net_profit)/Number(prev.revenue))*100 : null;
  const cashMax = Math.max(Number(latest ? latest.cash : 0), ...hist.map(r => Number(r.cash)||0), 1);
  const nn = document.getElementById('numbersNote');
  if(nn) nn.textContent = latest ? 'self entered and connector figures' : '';
  // Driven by the customer's own metric selection, not a fixed four.
  const chosen = metricSelection('summary');
  const nav = {
    cash:{view:'ledger', ltab:'cash'}, receivables:{view:'ledger', ltab:'receivables'},
    recvOver90:{view:'ledger', ltab:'receivables'}, recvOver90Pct:{view:'ledger', ltab:'receivables'},
    payablesSoon:{view:'ledger', ltab:'payables'}, netPosition:{view:'ledger', ltab:'all'},
    payGross:{view:'payments'}, payNet:{view:'payments'}, mdrPct:{view:'payments'},
    failRate:{view:'payments'}, settleLag:{view:'payments'}, avgTxn:{view:'payments'}
  };
  strip.style.gridTemplateColumns = 'repeat(' + Math.min(Math.max(chosen.length, 1), 4) + ', 1fr)';
  strip.innerHTML = '';
  chosen.slice(0, 8).forEach(key => {
    const m = METRICS[key]; if(!m) return;
    const v = latest ? metricValue(key, latest) : null;
    const p = prev ? metricValue(key, prev) : null;
    let cls = 'flat', txt = latest ? 'this snapshot' : 'no data yet';
    if(v !== null && p !== null && isFinite(v) && isFinite(p)){
      const raw = v - p;
      if(Math.abs(raw) < Math.max(Math.abs(p) * 0.0005, 1e-9)){ cls = 'flat'; txt = 'no change since last'; }
      else {
        cls = (m.better === 'up' ? raw > 0 : raw < 0) ? 'up' : 'down';
        const pctd = p === 0 ? null : (raw / Math.abs(p)) * 100;
        txt = (raw > 0 ? '▲ ' : '▼ ') + (pctd !== null && Math.abs(pctd) < 999 ? Math.abs(pctd).toFixed(1) + '% vs prior' : metricFormat(Math.abs(raw), m.unit) + ' vs prior');
      }
    } else if(v === null){ txt = 'not available yet'; }
    // the bar shows where this reading sits inside its own historical range
    const hist = metricSeries(key, 30);
    let fill = 0;
    if(v !== null && hist.length > 1){
      const mn = Math.min(...hist), mx = Math.max(...hist);
      fill = mx === mn ? 60 : ((v - mn) / (mx - mn)) * 100;
      if(m.better === 'down') fill = 100 - fill;
    } else if(v !== null){ fill = 55; }
    const el = document.createElement('div');
    el.className = 'rd-inst';
    el.innerHTML = '<div class="l">' + escapeHtml(m.label) + '</div>' +
      '<div class="v">' + escapeHtml(metricFormat(v, m.unit)) + '</div>' +
      '<div class="d ' + cls + '">' + escapeHtml(txt) + '</div>' +
      '<div class="bar"><i style="width:' + Math.max(3, Math.min(100, fill)).toFixed(0) + '%' + (cls === 'down' ? ';background:var(--rose)' : '') + '"></i></div>';
    const go = nav[key] || { view:'scores' };
    el.addEventListener('click', () => { if(go.ltab) ledgerActiveTab = go.ltab; showView(go.view); });
    strip.appendChild(el);
  });

  // cash trajectory
  const traj = document.getElementById('revenueTrendChart');
  const trajSub = document.getElementById('revTrendSub');
  if(traj){
    if(hist.length < 2){
      traj.innerHTML = '<div class="ledger-empty">Appears once you have two snapshots.</div>';
      if(trajSub) trajSub.textContent = '';
    } else {
      const cashVals = hist.map(r => Number(r.cash)||0);
      traj.innerHTML = rdChart({ type:'area', labels: hist.map(r => fmtMon(r.created_at)), series:[{ type:'area', color:'#0E8F5C', name:'Cash', unit:'inr', data: cashVals }], h: 200 });
      rdMountCharts(traj);
      const first = cashVals[0], last = cashVals[cashVals.length-1];
      if(trajSub) trajSub.textContent = first ? ((last>=first?'▲ +':'▼ ') + Math.abs((last-first)/first*100).toFixed(0) + '% over ' + hist.length + ' snapshots') : (hist.length + ' snapshots');
    }
  }

  renderAlerts(latest, recvTotal, recv90, paySoon, pay);
  renderSummaryTimeline(latest);
}
function fmtMon(iso){ try { return new Date(iso).toLocaleDateString('en-IN', { day:'numeric', month:'short' }); } catch(e){ return ''; } }
function renderSummaryTimeline(latest){
  const host = document.getElementById('sumTimeline'); if(!host) return;
  const items = [];
  if(latest) items.push({ em:true, t:'Snapshot recorded', m: fmtDate(latest.created_at) });
  (findings || []).slice(0,3).forEach(f => {
    const tier = (f.tier || f.confidence_tier || '').toLowerCase();
    items.push({ em: tier === 'verified', t: 'Finding: ' + (f.summary || f.narration || 'flagged a movement'), m: (tier ? tier.charAt(0).toUpperCase()+tier.slice(1) : 'Signal') + (f.created_at ? ' · ' + fmtDate(f.created_at) : '') });
  });
  if(typeof razorpayLiveSummary !== 'undefined' && razorpayLiveSummary && razorpayLiveSummary.count){
    items.push({ em:true, t:'Razorpay synced, ' + razorpayLiveSummary.count + ' transactions', m:'Nightly' });
  }
  if(typeof zohoConnected !== 'undefined' && zohoConnected && zohoVitals && zohoVitals.organization_name){
    items.push({ em:true, t:'Zoho Books synced, ' + escapeHtml(zohoVitals.organization_name), m:'Nightly' });
  }
  if(typeof tallyConnected !== 'undefined' && tallyConnected && tallyData && tallyData.counts){
    items.push({ em:false, t:'Tally agent synced ledgers and vouchers', m:'Signal' });
  }
  if(!items.length){
    host.innerHTML = '<div class="ledger-empty">Nothing yet. Activity from your connectors and findings shows up here.</div>';
    return;
  }
  host.innerHTML = items.slice(0,6).map(it =>
    '<div class="rd-tl' + (it.em ? ' em' : '') + '"><div class="t">' + escapeHtml(it.t) + '</div><div class="m">' + escapeHtml(it.m) + '</div></div>'
  ).join('');
}
