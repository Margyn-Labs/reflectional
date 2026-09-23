/* ============================================================
   NEW PAGES (the agreed mock, app-frame-mock.html): Home,
   Receivables / Payables with Reconciled | By source | Compare,
   Customers / Vendors, GST and tax, Audit log, notifications.

   Read-only over data the app already loads (receivables, payables,
   zohoLedgerRows, tallyData, odooStatus, snapshots, agentActions,
   reconSummary, pendingSuggestions, ledgerEvents). Writes only through
   the existing ledger functions (mark received / paid, delete), each
   behind mgConfirm(). Per-source totals are never added together.
   ============================================================ */

/* ---------- money model: every open invoice/bill, every source ---------- */
const MG_SRC_ORDER = ['zoho', 'tally', 'odoo', 'manual'];   // connector before self-entered (SOURCE_TIER)
const MG_SRC_NAME = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', manual:'Manual entries' };
const MG_SRC_LOGO = { zoho:['Z', '#E0482F'], tally:['T', '#1F5FAD'], odoo:['O', '#714B67'], manual:['M', '#5B6472'], razorpay:['R', '#2B6DE8'], cashfree:['C', '#5F259F'], shopify:['S', '#5E8E3E'] };
function mgLogo(src){ const l = MG_SRC_LOGO[src] || ['?', '#8B93A0']; return '<span class="mg-src-logo" style="background:' + l[1] + '">' + l[0] + '</span>'; }

function mgMoneyRows(dir){
  const out = [];
  try {
    unifiedLedgerRows(dir).forEach(r => out.push({
      party:r.party || 'Unnamed', amount:Number(r.amount) || 0, due:r.due_date || null, ref:r.ref || null,
      src:(r.source === 'manual' || r.source === 'upload') ? 'manual' : r.source, editable:!!r.editable, raw:r.raw || null
    }));
  } catch(e){ /* ledger not ready */ }
  try {
    if(odooConnected && odooStatus){
      const blk = dir === 'recv' ? odooStatus.receivables : odooStatus.payables;
      ((blk && blk.items) || []).forEach(i => out.push({ party:i.party_name || 'Unnamed', amount:Number(i.amount) || 0, due:i.due_date || null, ref:i.ref || null, src:'odoo', editable:false, raw:null }));
    }
  } catch(e){}
  out.forEach(r => { r.key = normPartyName(r.party) || ('~' + String(r.party).toLowerCase()); r.days = daysFromToday(r.due); });
  return out;
}
function mgMoneySources(dir){ const s = new Set(mgMoneyRows(dir).map(r => r.src)); return MG_SRC_ORDER.filter(k => s.has(k)); }

/* One row per counterparty. `amount` comes from the most trusted source that
   has the party (connector before manual); the other sources are compared
   against it, never added to it. Same 2% / ₹1 tolerance as crossLedgerGroups(). */
function mgMoneyGroups(dir){
  const map = new Map();
  mgMoneyRows(dir).forEach(r => {
    if(!map.has(r.key)) map.set(r.key, { key:r.key, party:r.party, by:{} });
    const g = map.get(r.key);
    if(!g.by[r.src]) g.by[r.src] = { amount:0, rows:[] };
    g.by[r.src].amount += r.amount; g.by[r.src].rows.push(r);
  });
  return [...map.values()].map(g => {
    const srcs = MG_SRC_ORDER.filter(s => g.by[s]);
    const primary = srcs[0];
    const amts = srcs.map(s => g.by[s].amount);
    const max = Math.max(...amts), min = Math.min(...amts);
    const multi = srcs.length >= 2;
    const status = !multi ? 'single' : ((max - min) <= Math.max(1, max * 0.02) ? 'agree' : 'conflict');
    const prow = g.by[primary].rows;
    const dues = prow.map(r => r.days).filter(d => d !== null);
    const oldest = dues.length ? Math.min(...dues) : null;
    return {
      key:g.key, party:g.party, by:g.by, sources:srcs, primary, status, amount:g.by[primary].amount,
      diff:multi ? max - min : 0, oldestDays:oldest, invoices:prow.length,
      overdue:prow.filter(r => r.days !== null && r.days < 0).reduce((s, r) => s + r.amount, 0),
      due7:prow.filter(r => r.days !== null && r.days <= 7).reduce((s, r) => s + r.amount, 0)
    };
  }).sort((a, b) => b.amount - a.amount);
}
function mgBucketOf(days){
  if(days === null || days >= 0) return 'b0';
  const od = -days; return od <= 30 ? 'b0' : od <= 60 ? 'b1' : od <= 90 ? 'b2' : 'b3';
}
const MG_BUCKETS = [['b0', 'Current and 0–30 days'], ['b1', '31–60 days'], ['b2', '61–90 days'], ['b3', '90+ days']];

/* ---------- shared bits ---------- */
function mgStatusBadge(days, dir){
  if(days === null) return '<span class="mg-bdg">No due date</span>';
  if(days < 0) return '<span class="mg-bdg neg">Overdue ' + (-days) + 'd</span>';
  if(days <= 7) return '<span class="mg-bdg warn">Due in ' + days + 'd</span>';
  return '<span class="mg-bdg">' + (dir === 'pay' ? 'Due in ' + days + 'd' : 'Open') + '</span>';
}
function mgAgreeBadge(g){
  if(g.status === 'agree') return '<span class="mg-bdg pos">Agree</span>';
  if(g.status === 'conflict') return '<span class="mg-bdg neg">Conflict ' + escapeHtml(fmtINR(g.diff)) + '</span>';
  return '<span class="mg-bdg">Single source</span>';
}
function mgNum(n){ return escapeHtml(fmtINR(n).replace('₹', '')); }   // table cells: unit lives in the header
function mgPageHead(o){
  return '<div class="mg-ph"><div class="mg-ph-l">' +
    '<div class="mg-crumb">' + escapeHtml(mgOrgShort() + ' / ' + o.group) + '</div>' +
    '<h1 class="mg-title">' + escapeHtml(o.title) + '</h1>' +
    (o.sub ? '<div class="mg-ph-sub">' + escapeHtml(o.sub) + '</div>' : '') +
    (o.scope ? '<div class="mg-scopeline">' + escapeHtml(o.scope) + '</div>' : '') +
    '</div><div class="mg-ph-actions">' + (o.actions || '') + '</div></div>';
}
function mgBtn(label, attrs, primary){
  return '<button class="mg-btn' + (primary ? ' primary' : '') + '" type="button" ' + (attrs || '') + '>' + escapeHtml(label) + '</button>';
}
const MG_ICON_EXPORT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
function mgExportBtn(id){ return '<button class="mg-btn" type="button" id="' + id + '">' + MG_ICON_EXPORT + '<span>Export</span></button>'; }
function mgCsv(filename, header, rows){
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const blob = new Blob([[header, ...rows].map(r => r.map(esc).join(',')).join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
function mgLiveCount(){ try { return CONN_FEED_MAP.filter(c => connIsLive(c.key)).length; } catch(e){ return 0; } }
function mgScopeText(srcLabel){ return mgOrgShort() + ' · ' + srcLabel + ' · ' + mgAsOf(); }

/* ---------- Home ---------- */
const MG_VITAL_NAME = { 'Cash Position':'Cash position', 'Receivables Aging':'Receivables ageing', 'Payables Due (30d)':'Payables due in 30 days',
  'GST/ITC Leakage':'GST input credit at risk', 'Net Margin':'Net margin', 'Working Capital Runway':'Working-capital runway' };
function mgVitalName(l){ return MG_VITAL_NAME[l] || l; }
function mgVital(snap, label){ return snap && Array.isArray(snap.vitals) ? snap.vitals.find(v => v.label === label) : null; }
function mgPct(now, prev){ return (prev == null || !isFinite(prev) || prev === 0) ? null : ((now - prev) / Math.abs(prev)) * 100; }
function mgTile(o){
  let chg = '<div class="mg-tile-chg flat">' + (o.note ? escapeHtml(o.note) : '&nbsp;') + '</div>';
  if(o.delta != null && isFinite(o.delta)){
    const up = o.delta > 0, flat = Math.abs(o.delta) < 0.05;
    const good = flat ? null : (up === o.goodUp);
    chg = '<div class="mg-tile-chg ' + (flat ? 'flat' : good ? 'good' : 'bad') + '">' + (flat ? '' : up ? '▲ ' : '▼ ') + escapeHtml(o.deltaText || Math.abs(o.delta).toFixed(1) + '%') + ' vs prior</div>';
  }
  return '<button class="mg-tile" type="button" data-go-page="' + o.go + '"' + (o.full ? ' title="' + escapeHtml(o.full) + '"' : '') + '>' +
    '<div class="mg-tile-l">' + escapeHtml(o.label) + '</div>' +
    '<div class="mg-tile-v">' + escapeHtml(o.value) + '</div>' + chg +
    '<div class="mg-tile-src">' + escapeHtml(o.src) + '</div></button>';
}
function mgCashChart(hist){
  const W = 640, H = 200, padL = 56, padB = 24, padT = 12, padR = 28;
  const pts = hist.map(s => Number(s.cash) || 0);
  if(pts.length < 2) return '<div class="mg-empty">Cash history appears after your second snapshot.</div>';
  const max = Math.max(...pts) * 1.1 || 1;
  const x = i => padL + i * (W - padL - padR) / (pts.length - 1);
  const y = v => H - padB - (v / max) * (H - padB - padT);
  const d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  let grid = '';
  [0, 0.5, 1].forEach(f => { const v = max / 1.1 * f; grid += '<line x1="' + padL + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#ECEAE4"/><text x="0" y="' + (y(v) + 4) + '" class="mg-ax">' + escapeHtml(fmtINR(v, 'tile').replace('₹', '')) + '</text>'; });
  let ticks = '';
  const step = Math.max(1, Math.ceil(hist.length / 6));
  hist.forEach((s, i) => { if(i % step === 0 || i === hist.length - 1) ticks += '<text x="' + x(i) + '" y="' + (H - 6) + '" class="mg-ax" text-anchor="middle">' + escapeHtml(new Date(s.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short' })) + '</text>'; });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Cash position over time">' + grid +
    '<path d="' + d + 'L' + x(pts.length - 1) + ',' + (H - padB) + 'L' + x(0) + ',' + (H - padB) + 'Z" fill="#0E8F5C" opacity=".08"/>' +
    '<path d="' + d + '" fill="none" stroke="#0E8F5C" stroke-width="2"/>' + ticks + '</svg>';
}
function mgDecisions(){
  const out = [];
  try { ((agentActions && agentActions.actions) || []).forEach(a => out.push({ t:a.title, s:(AGENT_KIND_LABEL[a.kind] || a.kind) + ' · Agents' + (a.confidence != null ? ' · ' + Math.round(a.confidence * 100) + '% sure' : ''), amt:Number(a.amount) || 0 })); } catch(e){}
  try { ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).forEach(q => out.push({ t:(q.customer_name || 'Payment') + ': ' + (q.reason || 'needs review'), s:'Reconciliation · ' + (q.invoice_number || ''), amt:Number(q.amount) || 0 })); } catch(e){}
  try { (pendingSuggestions || []).forEach(p => {
    const ents = (p.proposal && p.proposal.entries) || [];
    const first = ents[0] || {};
    out.push({ t:'Forwarded on WhatsApp' + (first.party ? ': ' + first.party : ''), s:'Import' + (ents.length > 1 ? ' · ' + ents.length + ' figures' : '') + (p.from_phone ? ' · ' + waPrettyPhone(p.from_phone) : ''),
      amt:ents.reduce((t, x) => t + (Number(x.amount) || 0), 0) });
  }); } catch(e){}
  return out.sort((a, b) => b.amt - a.amt);
}
function mgDisagreements(){
  const out = [];
  [['recv', 'receivables'], ['pay', 'payables']].forEach(([dir, page]) => {
    mgMoneyGroups(dir).filter(g => g.status === 'conflict').forEach(g => out.push({
      t:g.party, s:g.sources.map(s => MG_SRC_NAME[s] + ' ' + fmtINR(g.by[s].amount)).join(' · '), amt:g.diff, page
    }));
  });
  try {
    const c = snapshots[0] && snapshots[0].source_conflicts;
    // Same shape renderSourceConflicts() reads: { field, values:{source:amount}, spread_pct, chosen }
    (Array.isArray(c) ? c : []).forEach(x => {
      const vals = x.values || {};
      const nums = Object.values(vals).map(Number).filter(isFinite);
      out.push({ t:CONFLICT_FIELD_LABEL[x.field] || x.field || 'Figure',
        s:Object.keys(vals).map(k => (SOURCE_DISPLAY[k] || k) + ' ' + fmtINR(vals[k])).join(' · '), amt:nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0, page:'books' });
    });
  } catch(e){}
  return out.sort((a, b) => b.amt - a.amt);
}
function mgRenderHome(){
  const host = document.getElementById('view-home'); if(!host) return;
  const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
  const recv = mgMoneyGroups('recv'), pay = mgMoneyGroups('pay');
  const overdue = recv.reduce((t, g) => t + g.overdue, 0);
  const due7 = pay.reduce((t, g) => t + g.due7, 0);
  const nOver = recv.filter(g => g.overdue > 0).length, nDue = pay.filter(g => g.due7 > 0).length;
  const live = mgLiveCount();
  const srcLine = 'Reconciled · ' + (live ? live + ' source' + (live === 1 ? '' : 's') + ' live' : 'self-entered');
  const runway = mgVital(s, 'Working Capital Runway'), runwayP = mgVital(p, 'Working Capital Runway');
  const rNow = runway ? parseFloat(runway.value) : null, rPrev = runwayP ? parseFloat(runwayP.value) : null;
  const tiles = !s ? '' : '<div class="mg-tiles">' +
    mgTile({ label:'Cash', value:fmtINR(s.cash, 'tile'), full:fmtINR(s.cash), delta:p ? mgPct(Number(s.cash), Number(p.cash)) : null, goodUp:true, src:srcLine, go:'payments' }) +
    mgTile({ label:'Runway', value:rNow != null ? rNow.toFixed(1) + ' months' : 'n/a', full:'Cash plus receivables, less payables due, over monthly spend',
      delta:(rNow != null && rPrev != null) ? rNow - rPrev : null, deltaText:(rNow != null && rPrev != null) ? Math.abs(rNow - rPrev).toFixed(1) + ' months' : '', goodUp:true, src:srcLine, go:'pulse' }) +
    mgTile({ label:'Receivables overdue', value:fmtINR(overdue, 'tile'), full:fmtINR(overdue), delta:null, note:nOver + ' customer' + (nOver === 1 ? '' : 's') + ' overdue', goodUp:false, src:srcLine, go:'receivables' }) +
    mgTile({ label:'Payables due in 7 days', value:fmtINR(due7, 'tile'), full:fmtINR(due7) + ', including anything already overdue', delta:null, note:nDue + ' vendor' + (nDue === 1 ? '' : 's') + ' to pay', goodUp:false, src:srcLine, go:'payables' }) +
    mgTile({ label:'GST payable this month', value:fmtINR(s.gst_payable, 'tile'), full:fmtINR(s.gst_payable), delta:p ? mgPct(Number(s.gst_payable), Number(p.gst_payable)) : null, goodUp:false, src:srcLine, go:'gst' }) +
    '</div>';

  // Pulse: the three vitals moving the score most, in points vs a neutral 50.
  let pulse = '<div class="mg-empty">Your Pulse Score appears after your first snapshot.</div>';
  if(s){
    const band = scoreBand(s.pulse_score);
    const d = p ? s.pulse_score - p.pulse_score : null;
    const drivers = (s.vitals || []).map(v => ({ label:mgVitalName(v.label), pts:(Number(v.score) - 50) * (VITAL_WEIGHTS[v.label] || 0) }))
      .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 3);
    pulse = '<div class="mg-pulse"><div class="mg-pulse-n">' + escapeHtml(String(s.pulse_score)) + '</div><div>' +
      '<span class="mg-band ' + band.cls + '">' + escapeHtml(band.label) + '</span>' +
      '<div class="mg-fine">' + escapeHtml((d === null ? 'First reading' : d === 0 ? 'No change on last reading' : (d > 0 ? 'Up ' : 'Down ') + Math.abs(d) + ' on last reading') +
        (s.confidence != null ? ' · ' + Math.round(Number(s.confidence) * 100) + '% confidence' : '')) + '</div></div></div>' +
      '<ul class="mg-drivers">' + drivers.map(x => '<li><span>' + escapeHtml(x.label) + '</span><span class="mg-pts ' + (x.pts < 0 ? 'neg' : 'pos') + '">' + (x.pts < 0 ? '−' : '+') + Math.abs(x.pts).toFixed(0) + ' pts</span></li>').join('') + '</ul>' +
      '<button class="mg-link" type="button" data-go-page="pulse">What would move it →</button>';
  }
  const dec = mgDecisions(), dis = mgDisagreements();
  const listRows = (arr, cls) => arr.slice(0, 5).map(x => '<div class="mg-li"><div><div class="mg-li-t">' + escapeHtml(x.t) + '</div><div class="mg-li-s">' + escapeHtml(x.s) + '</div></div><div class="mg-li-a' + (cls ? ' ' + cls : '') + '">' + escapeHtml(fmtINR(x.amt)) + '</div></div>').join('');
  const hist = (snapshots || []).slice(0, 13).slice().reverse();
  const brief = s && s.briefing;
  const fc = s && typeof mgForecastPanel === 'function' ? mgForecastPanel() : null;
  host.innerHTML = mgPageHead({ group:'Overview', title:'Home', scope:mgScopeText('Reconciled') }) +
    (s ? '' : '<div class="mg-panel mg-empty-panel"><h2>Start with your figures</h2><p>Import a workbook or connect a source, and Margyn fills this page in.</p>' + mgBtn('Import a file', 'data-go-page="import"', true) + ' ' + mgBtn('Connect a source', 'data-go-page="sources"') + '</div>') +
    tiles +
    '<div class="mg-row2">' +
      (fc || ('<div class="mg-panel"><div class="mg-panel-h"><h2>Cash position</h2><span class="mg-aside">' + (hist.length ? 'Last ' + hist.length + ' readings' : '') + '</span>' +
        (s ? '<button class="mg-btn mg-btn-sm" type="button" data-fc-adjust>Show forecast</button>' : '') + '</div><div class="mg-panel-b">' + mgCashChart(hist) + '</div></div>')) +
      '<div class="mg-panel"><div class="mg-panel-h"><h2>Pulse Score</h2><span class="mg-aside">Operating health, not a credit score</span></div><div class="mg-panel-b">' + pulse + '</div></div>' +
    '</div>' +
    '<div class="mg-row3">' +
      '<div class="mg-panel"><div class="mg-panel-h"><h2>Needs your decision</h2>' + (dec.length ? '<button class="mg-link mg-aside" type="button" data-go-page="inbox">All ' + dec.length + ' in Inbox →</button>' : '') + '</div>' +
        (dec.length ? listRows(dec) : '<div class="mg-empty">Nothing is waiting on you.</div>') + '</div>' +
      '<div class="mg-panel"><div class="mg-panel-h"><h2>Sources disagree</h2>' + (dis.length ? '<button class="mg-link mg-aside" type="button" data-compare="receivables">Open in Compare →</button>' : '') + '</div>' +
        (dis.length ? listRows(dis, 'neg') : '<div class="mg-empty">Your connected sources agree.</div>') + '</div>' +
    '</div>' +
    (brief ? '<div class="mg-panel mg-ai-panel"><div class="mg-panel-h"><h2>Margyn’s briefing</h2><span class="mg-ai-tag">Written by Margyn</span><span class="mg-aside">' + escapeHtml(s.briefing_generated_at ? fmtDate(s.briefing_generated_at) : '') + '</span></div><div class="mg-panel-b"><p>' + escapeHtml(brief) + '</p></div></div>' : '');
}

/* ---------- Receivables / Payables ---------- */
let mgMoneySrc = 'reconciled';          // 'reconciled' | 'compare' | a source key; shared by the money + party pages
let mgMoneyAge = null;                  // aging bucket filter
let mgMoneyQ = '';                      // customer / vendor search
function mgMoneyMode(dir){
  if(mgMoneySrc === 'reconciled' || mgMoneySrc === 'compare') return mgMoneySrc;
  return mgMoneySources(dir).includes(mgMoneySrc) ? mgMoneySrc : 'reconciled';
}
function mgRenderMoney(dir){
  const page = dir === 'recv' ? 'receivables' : 'payables';
  const host = document.getElementById('view-' + page); if(!host) return;
  const who = dir === 'recv' ? 'Customer' : 'Vendor';
  const mode = mgMoneyMode(dir);
  const srcs = mgMoneySources(dir);
  const q = mgMoneyQ.trim().toLowerCase();
  const modeLabel = mode === 'reconciled' ? 'Reconciled' : mode === 'compare' ? 'Compare' : MG_SRC_NAME[mode];
  const seg = '<div class="mg-seg" role="tablist">' +
    [['reconciled', 'Reconciled'], ['bysource', 'By source'], ['compare', 'Compare']].map(([k, l]) =>
      '<button type="button" role="tab" data-money-mode="' + k + '" class="' + ((k === mode || (k === 'bysource' && MG_SRC_ORDER.includes(mode))) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    (MG_SRC_ORDER.includes(mode) ? '<div class="mg-seg">' + srcs.map(s => '<button type="button" data-money-src="' + s + '" class="' + (s === mode ? 'on' : '') + '">' + escapeHtml(MG_SRC_NAME[s]) + '</button>').join('') + '</div>' : '');
  let body = '', count = 0, csv = null;

  if(!srcs.length){
    body = '<div class="mg-panel mg-empty-panel"><h2>No open ' + (dir === 'recv' ? 'receivables' : 'payables') + '</h2><p>Add one in the Ledger, import a file, or connect Zoho Books, Tally or Odoo.</p>' +
      mgBtn('Open the Ledger', 'data-go-page="ledger"') + '</div>';
  } else if(mode === 'compare'){
    const groups = mgMoneyGroups(dir).filter(g => !q || g.party.toLowerCase().includes(q));
    count = groups.length;
    body = '<div class="mg-panel mg-gridwrap"><table class="mg-grid"><thead><tr><th>' + who + '</th>' +
      srcs.map(s => '<th class="r">' + escapeHtml(MG_SRC_NAME[s]) + ' (₹)</th>').join('') + '<th class="r">Difference (₹)</th><th>Agreement</th></tr></thead><tbody>' +
      groups.map(g => '<tr class="mg-click" data-open-party="' + escapeHtml(g.key) + '" data-dir="' + dir + '"><td>' + escapeHtml(g.party) + '</td>' +
        srcs.map(s => g.by[s] ? '<td class="r">' + mgNum(g.by[s].amount) + '</td>' : '<td class="r mg-muted">not listed</td>').join('') +
        '<td class="r' + (g.status === 'conflict' ? ' mg-diff' : ' mg-muted') + '">' + (g.status === 'single' ? '—' : mgNum(g.diff)) + '</td><td>' + mgAgreeBadge(g) + '</td></tr>').join('') +
      '</tbody></table><div class="mg-foot-note">Compared per ' + who.toLowerCase() + ', because invoice numbers differ between systems. Each column is exactly what that system says; “not listed” means that source didn’t send an open item for this ' + who.toLowerCase() + '. Agreement is judged across the sources that list it. Totals are never added across sources.</div></div>';
    csv = [[who, ...srcs.map(s => MG_SRC_NAME[s] + ' (INR)'), 'Difference (INR)', 'Agreement'],
      groups.map(g => [g.party, ...srcs.map(s => g.by[s] ? Math.round(g.by[s].amount) : ''), g.status === 'single' ? '' : Math.round(g.diff), g.status])];
  } else {
    // Reconciled: one row per party from its most trusted source. By source: that system's invoices.
    let rows;
    if(mode === 'reconciled'){
      rows = mgMoneyGroups(dir).map(g => ({ party:g.party, amount:g.amount, days:g.oldestDays, ref:g.invoices + ' open', g, src:g.primary }));
    } else {
      rows = mgMoneyRows(dir).filter(r => r.src === mode).map(r => ({ party:r.party, amount:r.amount, days:r.days, ref:r.ref || '—', r, src:r.src }));
    }
    const buckets = { b0:0, b1:0, b2:0, b3:0 };
    rows.forEach(r => { buckets[mgBucketOf(r.days)] += r.amount; });
    const btot = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
    rows = rows.filter(r => (!q || r.party.toLowerCase().includes(q)) && (!mgMoneyAge || mgBucketOf(r.days) === mgMoneyAge));
    count = rows.length;
    const total = rows.reduce((t, r) => t + r.amount, 0);
    const colors = { b0:'var(--brand)', b1:'var(--warn)', b2:'#C77A2E', b3:'var(--neg)' };
    body = '<div class="mg-aging">' + MG_BUCKETS.map(([k, l]) =>
      '<button type="button" data-money-age="' + k + '" class="' + (mgMoneyAge === k ? 'on' : '') + '"><div class="mg-ag-l">' + l + '</div><div class="mg-ag-v">' + escapeHtml(fmtINR(buckets[k], 'tile')) + '</div>' +
      '<div class="mg-ag-bar"><i style="width:' + (buckets[k] / btot * 100).toFixed(1) + '%;background:' + colors[k] + '"></i></div></button>').join('') + '</div>' +
      '<div class="mg-panel mg-gridwrap"><table class="mg-grid"><thead><tr><th>' + who + '</th><th>' + (mode === 'reconciled' ? 'Invoices' : 'Reference') + '</th><th>Status</th><th class="r">Open amount (₹)</th><th>' + (mode === 'reconciled' ? 'Agreement' : 'Source') + '</th><th></th></tr></thead><tbody>' +
      rows.map((r, i) => '<tr class="mg-click" data-open-party="' + escapeHtml(r.g ? r.g.key : r.r.key) + '" data-dir="' + dir + '"><td>' + escapeHtml(r.party) + '</td><td class="mg-mono">' + escapeHtml(r.ref) + '</td><td>' + mgStatusBadge(r.days, dir) + '</td><td class="r">' + mgNum(r.amount) + '</td>' +
        '<td>' + (mode === 'reconciled' ? mgAgreeBadge(r.g) + ' <span class="mg-srcs">' + r.g.sources.map(mgLogo).join('') + '</span>' : '<span class="mg-srccell">' + mgLogo(r.src) + escapeHtml(r.src === 'manual' ? 'Entered by you' : (mgSourceHealth(r.src).text || '')) + '</span>') + '</td>' +
        '<td class="r">' + (r.r && r.r.editable && r.r.raw ? '<button class="mg-row-act" type="button" data-money-settle="' + i + '">' + (dir === 'recv' ? 'Mark received' : 'Mark paid') + '</button>' : '') + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td colspan="3">Total' + (mode === 'reconciled' ? ', each ' + who.toLowerCase() + ' counted once' : ', ' + MG_SRC_NAME[mode] + ' only') + '</td><td class="r">' + mgNum(total) + '</td><td colspan="2"></td></tr></tfoot></table></div>';
    host.__rows = rows;
    csv = [[who, mode === 'reconciled' ? 'Invoices' : 'Reference', 'Days to due (negative = overdue)', 'Open amount (INR)', mode === 'reconciled' ? 'Agreement' : 'Source'],
      rows.map(r => [r.party, r.ref, r.days == null ? '' : r.days, Math.round(r.amount), mode === 'reconciled' ? r.g.status : MG_SRC_NAME[r.src]])];
  }
  host.__csv = csv;
  host.innerHTML = mgPageHead({ group:'Money', title:dir === 'recv' ? 'Receivables' : 'Payables', scope:mgScopeText(modeLabel),
      actions:mgExportBtn('mgExport-' + page) + (dir === 'recv' ? mgBtn('New invoice', 'data-go-page="invoicing"', true) : mgBtn('Add a bill', 'data-go-page="ledger"', true)) }) +
    '<div class="mg-toolbar">' + seg + '<input class="mg-search" type="search" placeholder="Find a ' + who.toLowerCase() + '" value="' + escapeHtml(mgMoneyQ) + '" data-money-q>' +
    (mgMoneyAge ? '<button class="mg-chip" type="button" data-money-age="">Age ' + escapeHtml(MG_BUCKETS.find(b => b[0] === mgMoneyAge)[1]) + ' ✕</button>' : '') +
    '<span class="mg-count">' + count + (mode === 'reconciled' || mode === 'compare' ? ' ' + who.toLowerCase() + (count === 1 ? '' : 's') : ' open') + '</span></div>' + body;
}

/* ---------- Customers / Vendors ---------- */
function mgRenderParties(dir){
  const page = dir === 'recv' ? 'customers' : 'vendors';
  const host = document.getElementById('view-' + page); if(!host) return;
  const who = dir === 'recv' ? 'Customer' : 'Vendor';
  const q = mgMoneyQ.trim().toLowerCase();
  const groups = mgMoneyGroups(dir).filter(g => !q || g.party.toLowerCase().includes(q));
  host.__csv = [[who, 'Sources', 'Open invoices', 'Outstanding (INR)', 'Overdue (INR)', 'Agreement'],
    groups.map(g => [g.party, g.sources.map(s => MG_SRC_NAME[s]).join(' + '), g.invoices, Math.round(g.amount), Math.round(g.overdue), g.status])];
  host.innerHTML = mgPageHead({ group:'Parties', title:who + 's', scope:mgScopeText('Reconciled'), sub:'Everyone with an open ' + (dir === 'recv' ? 'invoice' : 'bill') + ', across every connected source.', actions:mgExportBtn('mgExport-' + page) }) +
    '<div class="mg-toolbar"><input class="mg-search" type="search" placeholder="Find a ' + who.toLowerCase() + '" value="' + escapeHtml(mgMoneyQ) + '" data-money-q><span class="mg-count">' + groups.length + ' ' + who.toLowerCase() + (groups.length === 1 ? '' : 's') + '</span></div>' +
    (groups.length ? '<div class="mg-panel mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>' + who + '</th><th>Sources</th><th class="r">Open</th><th class="r">Outstanding (₹)</th><th class="r">Overdue (₹)</th><th>Oldest</th><th>Agreement</th></tr></thead><tbody>' +
      groups.map(g => '<tr class="mg-click" data-open-party="' + escapeHtml(g.key) + '" data-dir="' + dir + '"><td><b>' + escapeHtml(g.party) + '</b></td><td><span class="mg-srcs">' + g.sources.map(mgLogo).join('') + '</span></td><td class="r">' + g.invoices + '</td><td class="r">' + mgNum(g.amount) + '</td>' +
        '<td class="r' + (g.overdue ? ' mg-diff' : ' mg-muted') + '">' + (g.overdue ? mgNum(g.overdue) : '0') + '</td><td>' + mgStatusBadge(g.oldestDays, dir) + '</td><td>' + mgAgreeBadge(g) + '</td></tr>').join('') +
      '</tbody></table></div>' : '<div class="mg-panel mg-empty-panel"><h2>No open ' + (dir === 'recv' ? 'invoices' : 'bills') + '</h2><p>' + who + 's appear here once they owe or are owed something.</p></div>');
}

/* ---------- GST and tax ---------- */
function mgRenderGst(){
  const host = document.getElementById('view-gst'); if(!host) return;
  const s = (snapshots || [])[0] || null, p0 = (snapshots || [])[1] || null;
  let z = null; try { z = zohoConnected && zohoVitals ? zohoVitals : null; } catch(e){}
  const g = z && z.gst_leakage ? z.gst_leakage : null;
  const vendors = (z && z.gst_top_at_risk_vendors) || [];
  let acts = []; try { acts = ((agentActions && agentActions.actions) || []).filter(a => a.kind === 'itc_risk'); } catch(e){}
  const tiles = '<div class="mg-tiles four">' +
    mgTile({ label:'GST payable this month', value:s ? fmtINR(s.gst_payable, 'tile') : 'n/a', full:s ? fmtINR(s.gst_payable) : '', delta:(s && p0) ? mgPct(Number(s.gst_payable), Number(p0.gst_payable)) : null, goodUp:false, src:'From your latest snapshot', go:'gst' }) +
    mgTile({ label:'Input credit at risk', value:g ? fmtINR(g.total_leakage, 'tile') : (s ? fmtINR(s.gst_leak, 'tile') : 'n/a'), full:g ? fmtINR(g.total_leakage) : '', note:vendors.length ? vendors.length + ' vendor' + (vendors.length === 1 ? '' : 's') + ' behind it' : '', src:g ? 'GSTR-2B against Zoho Books' : 'From your latest snapshot', go:'gst' }) +
    mgTile({ label:'Vendors not filed', value:g ? String(g.vendors_not_filed || 0) : 'n/a', note:g ? 'GSTR-1 for ' + (g.filing_period || 'this period') : '', src:g ? 'GSTR-2B against Zoho Books' : 'Needs Zoho Books', go:'gst' }) +
    mgTile({ label:'Share of ITC at risk', value:g && g.leakage_pct != null ? Number(g.leakage_pct).toFixed(1) + '%' : 'n/a', note:g ? 'of input credit claimed' : '', src:g ? 'GSTR-2B against Zoho Books' : 'Needs Zoho Books', go:'gst' }) + '</div>';
  host.innerHTML = mgPageHead({ group:'Money', title:'GST and tax', scope:mgScopeText(g ? 'Zoho Books' : 'Reconciled'), sub:'GSTR-2B against your books, and the input credit at risk vendor by vendor.' }) + tiles +
    '<div class="mg-panel"><div class="mg-panel-h"><h2>Input credit at risk, by vendor</h2><span class="mg-aside">' + (g ? escapeHtml('Filing period ' + (g.filing_period || '')) : '') + '</span></div>' +
    (vendors.length ? '<div class="mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>Vendor</th><th>GSTIN</th><th class="r">At risk (₹)</th></tr></thead><tbody>' +
      vendors.map(v => '<tr><td>' + escapeHtml(v.vendor_name || '—') + '</td><td class="mg-mono">' + escapeHtml(v.vendor_gstin || '') + '</td><td class="r">' + mgNum(v.at_risk) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<div class="mg-empty">' + (z ? 'No vendor has credit at risk this period.' : 'Connect Zoho Books to match GSTR-2B against your books.') + '</div>') + '</div>' +
    (acts.length ? '<div class="mg-panel"><div class="mg-panel-h"><h2>Waiting on your decision</h2><button class="mg-link mg-aside" type="button" data-go-page="inbox">Open in Inbox →</button></div>' +
      acts.map(a => '<div class="mg-li"><div><div class="mg-li-t">' + escapeHtml(a.title) + '</div><div class="mg-li-s">' + escapeHtml(a.rationale || '') + '</div></div><div class="mg-li-a">' + escapeHtml(fmtINR(a.amount)) + '</div></div>').join('') + '</div>' : '');
}

/* ---------- Audit log (ledger_events: every add, settle, delete, import) ---------- */
let mgAuditLoading = false;
function mgRenderAudit(){
  const host = document.getElementById('view-audit'); if(!host) return;
  const ev = (typeof ledgerEvents !== 'undefined' && ledgerEvents) || [];
  if(!ev.length && !mgAuditLoading && typeof loadLedgerEvents === 'function' && currentUser){
    mgAuditLoading = true;
    loadLedgerEvents().then(r => { ledgerEvents = r || []; mgAuditLoading = false; if(mgCurrentView === 'audit') mgRenderAudit(); }).catch(() => { mgAuditLoading = false; });
  }
  const q = mgMoneyQ.trim().toLowerCase();
  const rows = ev.filter(e => !q || [e.party_name, e.event, e.entity_type, e.note, e.source].join(' ').toLowerCase().includes(q));
  const what = e => ({ settled:'Settled', deleted:'Deleted', created:'Added', imported:'Imported', updated:'Changed' }[e.event] || e.event || '—') + ' ' + (e.entity_type || '');
  host.__csv = [['When', 'Event', 'Party', 'Amount (INR)', 'Source', 'Note'], rows.map(e => [e.created_at, what(e), e.party_name || '', e.amount != null ? Math.round(e.amount) : '', e.source || '', e.note || ''])];
  host.innerHTML = mgPageHead({ group:'Admin', title:'Audit log', sub:'Every change to your ledger: what, when, and where it came from.', actions:mgExportBtn('mgExport-audit') }) +
    '<div class="mg-toolbar"><input class="mg-search" type="search" placeholder="Find an entry" value="' + escapeHtml(mgMoneyQ) + '" data-money-q><span class="mg-count">' + rows.length + ' entries</span></div>' +
    (rows.length ? '<div class="mg-panel mg-gridwrap"><table class="mg-grid"><thead><tr><th>When</th><th>Event</th><th>Party</th><th class="r">Amount (₹)</th><th>Source</th><th>Note</th></tr></thead><tbody>' +
      rows.map(e => '<tr><td class="mg-mono">' + escapeHtml(e.created_at ? fmtDate(e.created_at) : '') + '</td><td>' + escapeHtml(what(e)) + '</td><td>' + escapeHtml(e.party_name || '—') + '</td><td class="r">' + (e.amount != null ? mgNum(e.amount) : '') + '</td><td>' + escapeHtml(e.source || '') + '</td><td class="mg-muted">' + escapeHtml(e.note || '') + '</td></tr>').join('') +
      '</tbody></table></div>' : '<div class="mg-panel mg-empty-panel"><h2>' + (mgAuditLoading ? 'Loading…' : 'No changes recorded yet') + '</h2><p>Adding, settling, deleting or importing an entry is recorded here.</p></div>');
}

/* ---------- notifications (source health + waiting items) ---------- */
function mgNotifications(){
  const out = [];
  ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo'].forEach(k => {
    const h = mgSourceHealth(k);
    if(h.on && h.warn) out.push({ t:(MG_SRC_NAME[k] || MG_SRC_LABEL[k] || k) + ': ' + h.text, go:'sources', warn:true });
  });
  try { const t = agentQueueTotals(); if(t.total) out.push({ t:t.total + ' item' + (t.total === 1 ? '' : 's') + ' waiting in your Inbox', go:'inbox' }); } catch(e){}
  return out;
}
function mgRenderNotifications(){
  const n = mgNotifications();
  const dot = document.getElementById('mgBellDot'); if(dot) dot.classList.toggle('hidden', !n.length);
  const pop = document.getElementById('mgBellPop');
  if(pop) pop.innerHTML = '<h6>Notifications</h6>' + (n.length ? n.map(x => '<button class="mg-opt" type="button" data-go="' + x.go + '"><span' + (x.warn ? ' style="color:var(--warn)"' : '') + '>' + escapeHtml(x.t) + '</span></button>').join('') : '<div class="mg-note">You’re all caught up.</div>');
  const ic = document.getElementById('mgInboxCount');
  if(ic){ let t = 0; try { t = agentQueueTotals().total; } catch(e){} ic.textContent = t ? String(t) : ''; ic.classList.toggle('hidden', !t); }
}

/* ---------- page registry + events ---------- */
const MG_OWN_RENDER = {
  home:mgRenderHome, receivables:() => mgRenderMoney('recv'), payables:() => mgRenderMoney('pay'),
  customers:() => mgRenderParties('recv'), vendors:() => mgRenderParties('pay'), gst:mgRenderGst, audit:mgRenderAudit
};
function mgRenderOwn(page){ const f = MG_OWN_RENDER[page]; if(f){ try { f(); } catch(e){ console.error('[margyn] render ' + page, e); } } }
document.addEventListener('click', async e => {
  const t = e.target;
  const go = t.closest('[data-go-page]');
  if(go){ mgGo(go.dataset.goPage); return; }
  const cmp = t.closest('[data-compare]');
  if(cmp){ mgMoneySrc = 'compare'; mgMoneyAge = null; mgGo(cmp.dataset.compare); return; }
  const mode = t.closest('[data-money-mode]');
  if(mode){
    const m = mode.dataset.moneyMode, dir = mgCurrentView === 'payables' ? 'pay' : 'recv';
    mgMoneySrc = m === 'bysource' ? (mgMoneySources(dir)[0] || 'reconciled') : m; mgMoneyAge = null;
    mgRenderOwn(mgCurrentView); mgRefreshScope(); mgWriteHash(false); return;
  }
  const src = t.closest('[data-money-src]');
  if(src){ mgMoneySrc = src.dataset.moneySrc; mgRenderOwn(mgCurrentView); mgRefreshScope(); mgWriteHash(false); return; }
  const age = t.closest('[data-money-age]');
  if(age){ mgMoneyAge = age.dataset.moneyAge && mgMoneyAge !== age.dataset.moneyAge ? age.dataset.moneyAge : null; mgRenderOwn(mgCurrentView); return; }
  const exp = t.closest('[id^="mgExport-"]');
  if(exp){ const host = document.getElementById('view-' + mgCurrentView); if(host && host.__csv) mgCsv(mgCurrentView + '-' + new Date().toISOString().slice(0, 10) + '.csv', host.__csv[0], host.__csv[1]); return; }
  const settle = t.closest('[data-money-settle]');
  if(settle){
    const host = document.getElementById('view-' + mgCurrentView), r = host && host.__rows && host.__rows[Number(settle.dataset.moneySettle)];
    if(!r || !r.r || !r.r.raw) return;
    const recv = mgCurrentView === 'receivables';
    const ok = await mgConfirm({ title:(recv ? 'Mark ' : 'Mark ') + r.party + (recv ? ' as received?' : ' as paid?'),
      body:'This records it as settled in Margyn and recalculates your figures. Your connected books are not changed.',
      effect:[[recv ? 'Customer' : 'Vendor', r.party], ['Amount', fmtINR(r.amount)]],
      tick:recv ? 'The money has reached the bank' : 'The payment has left the bank', confirmLabel:recv ? 'Mark received' : 'Mark paid' });
    if(!ok) return;
    await (recv ? ledgerSettleReceivable(r.r.raw) : ledgerSettlePayable(r.r.raw));
    mgRenderOwn(mgCurrentView);
  }
});
document.addEventListener('input', e => {
  if(!e.target.matches('[data-money-q]')) return;
  mgMoneyQ = e.target.value;
  const pos = e.target.selectionStart;
  mgRenderOwn(mgCurrentView);
  const again = document.querySelector('#view-' + mgCurrentView + ' [data-money-q]');
  if(again){ again.focus(); try { again.setSelectionRange(pos, pos); } catch(err){} }
});
