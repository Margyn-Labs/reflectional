/* ============================================================
   MONTHLY CFO PACK (plan §8; HANDOFF-NEXT-THREE §3).

   The report an owner forwards to a CA, a co-founder or a lender, so every
   section says what it is based on:
   - Month figures come from the month's closing reading (the last snapshot
     dated in that month, IST), compared with the prior month's.
   - Balances by source, receivables/payables detail, GST vendors and the
     forecast are live, and say "as of <today>".
   Per-source figures stay separate. The commentary is the AI briefing of
   that month's reading, labelled "Written by Margyn".

   Save as PDF: an A4 print window. The header (org · month · reading date ·
   generated time) and footer repeat on every printed page (table
   header/footer groups), so each page carries its scope and dates.

   Settings (profiles.preferences.cfo_pack, via 19c-prefs.js):
   { enabled, day_of_month, recipients:[{name,email}], sections:[…] }.
   Scheduled email: api/_lib/cfoPack.js via /api/ops?action=cron-cfo-pack.
   ============================================================ */
const MG_PACK_SECTIONS = [
  ['headline', 'Headline figures'], ['pl', 'Profit and loss'], ['cash', 'Cash and forecast'], ['recv', 'Receivables ageing'],
  ['pay', 'Payables due'], ['gst', 'GST'], ['pulse', 'Pulse Score'], ['commentary', 'Commentary'], ['sources', 'Sources and data freshness']
];
const MG_PACK_BREAK = { cash:1, recv:1, gst:1, commentary:1 };   // each starts a new printed page
const MG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let mgPackMonth = null;          // 'YYYY-MM'; null = default
let mgPackSends = null;          // recent report_deliveries rows, or false when the table isn't there

/* ---------- months (IST) ---------- */
function mgMonthKey(iso){ return new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().slice(0, 7); }
function mgMonthLabel(k){ const [y, m] = k.split('-').map(Number); return MG_MONTHS[m - 1] + ' ' + y; }
function mgMonthShift(k, by){ const [y, m] = k.split('-').map(Number); const t = y * 12 + m - 1 + by; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); }
function mgPackMonths(){ return [...new Set((snapshots || []).map(s => mgMonthKey(s.created_at)))].sort().reverse(); }
function mgPackDefaultMonth(){
  const months = mgPackMonths(), last = mgMonthShift(mgMonthKey(new Date().toISOString()), -1);
  return months.includes(last) ? last : (months[0] || last);
}
function mgPackCurrent(){ const m = mgPackMonths(); return mgPackMonth && m.includes(mgPackMonth) ? mgPackMonth : mgPackDefaultMonth(); }
function mgPackSnap(k){ return (snapshots || []).find(s => mgMonthKey(s.created_at) === k) || null; }   // snapshots are newest first
function mgPackCfg(){
  const c = mgPrefGet('cfo_pack', {}) || {};
  return {
    enabled:c.enabled === true, day_of_month:Math.min(28, Math.max(1, parseInt(c.day_of_month, 10) || 1)),
    recipients:Array.isArray(c.recipients) ? c.recipients : null,
    sections:Array.isArray(c.sections) ? c.sections.filter(k => MG_PACK_SECTIONS.some(s => s[0] === k)) : MG_PACK_SECTIONS.map(s => s[0])
  };
}
function mgPackSave(patch){ const c = mgPackCfg(); mgPrefSet('cfo_pack', Object.assign({}, c, { recipients:c.recipients || mgPackDefaultRecipients() }, patch)); }
function mgPackDefaultRecipients(){
  let name = '';
  try { const me = (agentStakeholders || []).find(x => x.is_primary && x.name); if(me) name = me.name; } catch(e){}
  return currentUser && currentUser.email ? [{ name, email:currentUser.email }] : [];
}

/* ---------- the document ---------- */
const MG_PACK_CSS = [
  ".pk-doc{font-family:Manrope,system-ui,sans-serif;color:#14181F;font-size:12.5px;line-height:1.5;background:#fff}",
  ".pk-doc .pk-frame{width:100%;border-collapse:collapse}",
  ".pk-doc .pk-frame>thead>tr>td,.pk-doc .pk-frame>tfoot>tr>td{padding:0}",
  ".pk-doc .pk-frame>tbody>tr>td{padding:0 0 22px}",
  ".pk-doc .pk-run{display:flex;justify-content:space-between;gap:12px;font-size:10.5px;color:#5B6472;border-bottom:1px solid #E4E1DA;padding:0 0 6px;margin-bottom:14px}",
  ".pk-doc .pk-run b{color:#14181F}",
  ".pk-doc .pk-runf{font-size:10px;color:#8B93A0;border-top:1px solid #E4E1DA;padding-top:6px;margin-top:14px}",
  ".pk-doc .pk-frame>tbody.pk-cover>tr>td{padding-bottom:30px}",
  ".pk-doc .pk-cover-brand{font-weight:800;color:#0E8F5C;font-size:15px}",
  ".pk-doc h1{font-size:26px;font-weight:800;margin:18px 0 4px;letter-spacing:-.01em}",
  ".pk-doc .pk-cover-sub{color:#5B6472;font-size:13px}",
  ".pk-doc .pk-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:16px}",
  ".pk-doc .pk-meta div{border:1px solid #E4E1DA;border-radius:6px;padding:8px 10px}",
  ".pk-doc .pk-meta span{display:block;font-size:10.5px;color:#8B93A0}",
  ".pk-doc h2{font-size:16px;font-weight:800;margin:0 0 2px}",
  ".pk-doc h3{font-size:13px;font-weight:700;margin:14px 0 6px}",
  ".pk-doc .pk-scope{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#8B93A0;margin-bottom:10px}",
  ".pk-doc .pk-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
  ".pk-doc .pk-tile{border:1px solid #E4E1DA;border-radius:8px;padding:10px 12px}",
  ".pk-doc .pk-tile-l{font-size:11px;color:#5B6472}",
  ".pk-doc .pk-tile-v{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;margin-top:2px}",
  ".pk-doc .pk-tile-n{font-size:11px;color:#8B93A0;margin-top:2px}",
  ".pk-doc table.pk-t{width:100%;border-collapse:collapse;font-size:12px}",
  ".pk-doc .pk-t th{text-align:left;font-weight:600;color:#5B6472;font-size:11px;padding:6px 8px;border-bottom:1px solid #D2CEC5;background:#FAFAF8}",
  ".pk-doc .pk-t td{padding:6px 8px;border-bottom:1px solid #ECEAE4;vertical-align:top}",
  ".pk-doc .pk-t .r{text-align:right}",
  ".pk-doc .pk-t td.r,.pk-doc .pk-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".pk-doc .pk-t tr{break-inside:avoid;page-break-inside:avoid}",
  ".pk-doc .pk-t thead{display:table-header-group}",
  ".pk-doc .pk-muted{color:#8B93A0}",
  ".pk-doc .pk-neg{color:#B3432E}",
  ".pk-doc .pk-pos{color:#0E8F5C}",
  ".pk-doc .pk-note{font-size:11px;color:#5B6472;margin-top:6px}",
  ".pk-doc .pk-ai{border:1px solid #F3D9CE;background:#FBEFEA;border-radius:8px;padding:12px 14px}",
  ".pk-doc .pk-ai-l{font-size:11px;font-weight:700;color:#CC5B34;margin-bottom:4px}",
  ".pk-doc .pk-bdg{display:inline-block;font-size:10.5px;font-weight:600;border-radius:4px;padding:0 5px;background:#F1F0EC;color:#5B6472}",
  ".pk-doc .pk-bdg.pos{background:#E7F4EE;color:#0B7049}.pk-doc .pk-bdg.neg{background:#F8E9E6;color:#B3432E}.pk-doc .pk-bdg.warn{background:#FBF1DF;color:#8A5A0B}",
  ".pk-doc .pk-empty{color:#8B93A0;font-size:12px;padding:6px 0}",
  ".pk-doc .pk-blk{break-inside:avoid;page-break-inside:avoid}",
  ".pk-doc h2,.pk-doc h3,.pk-doc .pk-scope{break-after:avoid;page-break-after:avoid}"
].join('\n');
const MG_PACK_PRINT_CSS = "@page{size:A4;margin:14mm 14mm 12mm}html,body{margin:0;background:#fff}" +
  "body{-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
  ".pk-doc .pk-sec.pk-break>tr>td{break-before:page;page-break-before:always}" +
  "@media screen{body{padding:24px;background:#F1F0EC}.pk-doc{max-width:794px;margin:0 auto;padding:40px 44px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}";

function mgPackPct(a, b){ a = Number(a); b = Number(b); return b ? (a - b) / Math.abs(b) * 100 : null; }
function mgPackChg(a, b, goodUp){
  const p = mgPackPct(a, b);
  if(p === null || !isFinite(p)) return '<span class="pk-muted">—</span>';
  const good = Math.abs(p) < 0.05 ? null : (p > 0) === goodUp;
  return '<span class="' + (good === null ? '' : good ? 'pk-pos' : 'pk-neg') + '">' + (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(1) + '%</span>';
}
function mgPackN(n){ return escapeHtml(fmtINR(n).replace('₹', '')); }
function mgPackTable(head, rows, id){
  return '<table class="pk-t"' + (id ? ' id="' + id + '"' : '') + '><thead><tr>' + head.map(h => '<th' + (/\(₹\)|%|pts|days|Score/.test(h) ? ' class="r"' : '') + '>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}
function mgPackDoc(k){
  const s = mgPackSnap(k), p = mgPackSnap(mgMonthShift(k, -1));
  if(!s) return '';
  const cfg = mgPackCfg(), on = new Set(cfg.sections);
  const org = mgOrgName(), month = mgMonthLabel(k);
  const today = fmtDay(new Date().toISOString());
  const gen = new Date().toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit' });
  const closing = 'closing reading ' + fmtDay(s.created_at);
  const monthScope = mgOrgShort() + ' · Reconciled · ' + month + ' · ' + closing;
  const liveScope = mgOrgShort() + ' · Reconciled · as of today, ' + today;
  const latestMonth = mgPackMonths()[0] === k;
  let n = 0;
  const sec = (key, title, scope, body) => {
    if(!on.has(key)) return '';
    n++;
    return '<tbody class="pk-sec' + (MG_PACK_BREAK[key] ? ' pk-break' : '') + '" data-pk-sec="' + key + '"><tr><td><h2>' + n + '. ' + escapeHtml(title) + '</h2><div class="pk-scope">' + escapeHtml(scope) + '</div>' + body + '</td></tr></tbody>';
  };
  const margin = Number(s.revenue) ? Number(s.net_profit) / Number(s.revenue) * 100 : null;
  const marginP = p && Number(p.revenue) ? Number(p.net_profit) / Number(p.revenue) * 100 : null;
  const band = s.pulse_score != null ? scoreBand(s.pulse_score) : null;

  // 1. headline
  const tile = (l, v, note) => '<div class="pk-tile"><div class="pk-tile-l">' + escapeHtml(l) + '</div><div class="pk-tile-v">' + escapeHtml(v) + '</div><div class="pk-tile-n">' + note + '</div></div>';
  const headline = '<div class="pk-tiles">' +
    tile('Cash at month end', fmtINR(s.cash, 'tile'), p ? mgPackChg(s.cash, p.cash, true) + ' vs prior month' : 'First month') +
    tile('Revenue', fmtINR(s.revenue, 'tile'), p ? mgPackChg(s.revenue, p.revenue, true) + ' vs prior month' : '') +
    tile('Net profit', fmtINR(s.net_profit, 'tile'), margin != null ? escapeHtml(margin.toFixed(1) + '% margin') : '') +
    tile('Pulse Score', s.pulse_score != null ? String(s.pulse_score) : 'n/a', band ? escapeHtml(band.label + ' · operating health') : '') + '</div>';

  // 2. P&L
  const plRow = (l, a, b, goodUp) => '<tr><td>' + escapeHtml(l) + '</td><td class="r">' + mgPackN(a) + '</td><td class="r">' + (p ? mgPackN(b) : '—') + '</td><td class="r">' + (p ? mgPackN(Number(a) - Number(b)) : '—') + '</td><td class="r">' + (p ? mgPackChg(a, b, goodUp) : '—') + '</td></tr>';
  const pl = mgPackTable(['', month + ' (₹)', (p ? mgMonthLabel(mgMonthShift(k, -1)) : 'Prior month') + ' (₹)', 'Change (₹)', 'Change %'], [
    plRow('Revenue', s.revenue, p && p.revenue, true),
    plRow('Total spend', s.burn, p && p.burn, false),
    plRow('Net profit', s.net_profit, p && p.net_profit, true),
    '<tr><td>Net margin</td><td class="r">' + (margin != null ? margin.toFixed(1) + '%' : '—') + '</td><td class="r">' + (marginP != null ? marginP.toFixed(1) + '%' : '—') + '</td><td class="r">' + (margin != null && marginP != null ? (margin - marginP >= 0 ? '+' : '−') + Math.abs(margin - marginP).toFixed(1) + ' pts' : '—') + '</td><td class="r"></td></tr>'
  ], 'pkPl') + '<div class="pk-note">Monthly revenue and spend as recorded in each month’s closing reading. Spend is total monthly outgoings, so net profit = revenue − spend.</div>';

  // 3. cash
  const srcs = mgCashSources(), reconNow = (snapshots[0] && Number(snapshots[0].cash)) || 0;
  const cashRows = [];
  srcs.forEach(x => {
    const d = Math.abs(x.total - reconNow), agree = d <= Math.max(1, Math.abs(reconNow) * 0.02);
    const badge = '<span class="pk-bdg ' + (agree ? 'pos' : 'neg') + '">' + (agree ? 'Agrees' : 'Differs by ' + escapeHtml(fmtINR(d))) + '</span>';
    if(x.accounts.length === 1) cashRows.push('<tr><td>' + escapeHtml(MG_CASH_SRC_NAME[x.src]) + '</td><td>' + escapeHtml(x.accounts[0].name) + '</td><td class="r">' + mgPackN(x.total) + '</td><td>' + badge + '</td></tr>');
    else {
      cashRows.push('<tr><td><b>' + escapeHtml(MG_CASH_SRC_NAME[x.src]) + '</b></td><td class="pk-muted">All bank and cash ledgers</td><td class="r"><b>' + mgPackN(x.total) + '</b></td><td>' + badge + '</td></tr>');
      x.accounts.forEach(a => cashRows.push('<tr><td></td><td>' + escapeHtml(a.name) + '</td><td class="r">' + mgPackN(a.balance) + '</td><td></td></tr>'));
    }
  });
  const tr = mgCashTransit();
  if(tr){
    try { if(razorpayConnected){ cashRows.push('<tr><td>Razorpay</td><td>Settled, on its way to your bank</td><td class="r">' + mgPackN(tr.rzSettling) + '</td><td><span class="pk-bdg warn">In transit</span></td></tr>');
      cashRows.push('<tr><td>Razorpay</td><td>Captured, not yet settled (estimate)</td><td class="r">' + mgPackN(tr.rzCaptured) + '</td><td><span class="pk-bdg warn">In transit</span></td></tr>'); } } catch(e){}
    try { if(cashfreeConnected) cashRows.push('<tr><td>Cashfree</td><td>Settled, on its way to your bank</td><td class="r">' + mgPackN(tr.cfSettling) + '</td><td><span class="pk-bdg warn">In transit</span></td></tr>'); } catch(e){}
  }
  const f = mgForecast();
  const cash = '<div class="pk-tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">' +
      tile('Cash at month end (reconciled)', fmtINR(s.cash, 'tile'), escapeHtml(fmtINR(s.cash))) +
      tile('Cash today (reconciled)', fmtINR(reconNow, 'tile'), escapeHtml(fmtINR(reconNow) + ' · ' + today)) + '</div>' +
    '<div class="pk-blk"><h3>Where the cash is, as of today</h3>' +
    (cashRows.length ? mgPackTable(['Source', 'Account', 'Balance (₹)', 'Against reconciled'], cashRows, 'pkCash') : '<div class="pk-empty">No source reports balances by account yet.</div>') +
    '<div class="pk-note">Each source as it reports. Balances are never added across sources. In-transit money is not in the bank yet and is not part of cash. Bank feed via Account Aggregator is not connected yet.</div></div>' +
    (f && f.st.enabled ? '<div class="pk-blk"><h3>13-week forecast, from today</h3><div class="pk-note" style="margin:0 0 6px">' + escapeHtml(mgForecastSentence(f)) + ' Floor ' + escapeHtml(fmtINR(f.floor)) + '.</div>' +
      mgPackTable(['Week', 'Dates', 'Coming in (₹)', 'Going out (₹)', 'Closing cash (₹)'], mgForecastWeeks(f).map(r =>
        '<tr><td>W' + r.n + '</td><td class="pk-muted">' + escapeHtml(r.from + ' – ' + r.to) + '</td><td class="r">' + mgPackN(r.inflow) + '</td><td class="r">' + mgPackN(r.outflow) + '</td><td class="r' + (r.below ? ' pk-neg' : '') + '">' + mgPackN(r.close) + (r.below ? ' ▼' : '') + '</td></tr>'), 'pkFc') +
      '<div class="pk-note">' + (f.firstBelow >= 0 ? 'Cash falls below the floor in week ' + (f.firstBelow + 1) + ' (marked ▼). ' : 'Stays above the floor for 13 weeks. ') + 'Lowest point ' + escapeHtml(fmtINR(f.min)) + ' in week ' + (f.minWeek + 1) + '.</div></div>'
      : '<div class="pk-empty">The 13-week forecast is switched off for this account.</div>');

  // 4. receivables
  const recv = mgMoneyGroups('recv');
  const buckets = { b0:0, b1:0, b2:0, b3:0 };
  recv.forEach(g => g.by[g.primary].rows.forEach(r => { buckets[mgBucketOf(r.days)] += r.amount; }));
  const btot = Object.values(buckets).reduce((a, b) => a + b, 0);
  const over = recv.filter(g => g.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 10);
  const recvHtml = mgPackTable(['At month end', month + ' (₹)', 'Prior month (₹)', 'Change %'], [
      '<tr><td>Receivables outstanding</td><td class="r">' + mgPackN(s.recv_total) + '</td><td class="r">' + (p ? mgPackN(p.recv_total) : '—') + '</td><td class="r">' + (p ? mgPackChg(s.recv_total, p.recv_total, false) : '—') + '</td></tr>',
      '<tr><td>Of which over 90 days</td><td class="r">' + mgPackN(s.recv_90) + '</td><td class="r">' + (p ? mgPackN(p.recv_90) : '—') + '</td><td class="r">' + (p ? mgPackChg(s.recv_90, p.recv_90, false) : '—') + '</td></tr>'], 'pkRecvMonth') +
    '<div class="pk-blk"><h3>Ageing, as of today</h3>' + (btot ? mgPackTable(['Age', 'Open amount (₹)', 'Share %'], MG_BUCKETS.map(([bk, l]) => '<tr><td>' + escapeHtml(l) + '</td><td class="r">' + mgPackN(buckets[bk]) + '</td><td class="r">' + (buckets[bk] / btot * 100).toFixed(1) + '%</td></tr>'), 'pkAging') : '<div class="pk-empty">No open receivables.</div>') + '</div>' +
    '<div class="pk-blk"><h3>Top overdue customers, as of today</h3>' + (over.length ? mgPackTable(['Customer', 'Overdue (₹)', 'Oldest (days overdue)', 'Sources'], over.map(g =>
      '<tr><td>' + escapeHtml(g.party) + '</td><td class="r">' + mgPackN(g.overdue) + '</td><td class="r">' + (g.oldestDays != null && g.oldestDays < 0 ? -g.oldestDays : '—') + '</td><td>' + escapeHtml(g.sources.map(x => MG_SRC_NAME[x]).join(', ')) + (g.status === 'conflict' ? ' <span class="pk-bdg neg">Sources differ by ' + escapeHtml(fmtINR(g.diff)) + '</span>' : '') + '</td></tr>'), 'pkOverdue') : '<div class="pk-empty">No customer is overdue.</div>') +
    '<div class="pk-note">Each customer counted once, from the most trusted source that lists them.</div></div>';

  // 5. payables
  const pay = mgMoneyGroups('pay');
  const payRows = [];
  pay.forEach(g => g.by[g.primary].rows.forEach(r => payRows.push(Object.assign({ party:g.party }, r))));
  const pOver = payRows.filter(r => r.days !== null && r.days < 0).reduce((t, r) => t + r.amount, 0);
  const p7 = payRows.filter(r => r.days !== null && r.days >= 0 && r.days <= 7).reduce((t, r) => t + r.amount, 0);
  const p30 = payRows.filter(r => r.days !== null && r.days > 7 && r.days <= 30).reduce((t, r) => t + r.amount, 0);
  const soon = payRows.filter(r => r.days === null || r.days <= 30).sort((a, b) => (a.days ?? -999) - (b.days ?? -999)).slice(0, 10);
  const payHtml = mgPackTable(['', 'Amount (₹)'], [
      '<tr><td>Due in 30 days at month end (' + escapeHtml(closing) + ')</td><td class="r">' + mgPackN(s.pay_soon) + '</td></tr>',
      '<tr><td>Overdue today</td><td class="r' + (pOver ? ' pk-neg' : '') + '">' + mgPackN(pOver) + '</td></tr>',
      '<tr><td>Due in the next 7 days</td><td class="r">' + mgPackN(p7) + '</td></tr>',
      '<tr><td>Due in 8 to 30 days</td><td class="r">' + mgPackN(p30) + '</td></tr>'], 'pkPay') +
    '<div class="pk-blk"><h3>Bills due soonest, as of today</h3>' + (soon.length ? mgPackTable(['Vendor', 'Reference', 'Due', 'Amount (₹)'], soon.map(r =>
      '<tr><td>' + escapeHtml(r.party) + '</td><td class="pk-mono">' + escapeHtml(r.ref || '—') + '</td><td>' + (r.days === null ? 'No due date' : r.days < 0 ? '<span class="pk-neg">Overdue ' + (-r.days) + 'd</span>' : 'In ' + r.days + 'd') + '</td><td class="r">' + mgPackN(r.amount) + '</td></tr>'), 'pkPaySoon') : '<div class="pk-empty">No bills due in the next 30 days.</div>') + '</div>';

  // 6. GST
  let z = null; try { z = zohoConnected && zohoVitals ? zohoVitals : null; } catch(e){}
  const g = z && z.gst_leakage, vendors = (z && z.gst_top_at_risk_vendors) || [];
  const gstHtml = mgPackTable(['', 'Amount (₹)'], [
      '<tr><td>GST payable (' + escapeHtml(closing) + ')</td><td class="r">' + mgPackN(s.gst_payable) + '</td></tr>',
      '<tr><td>Input credit at risk (' + escapeHtml(closing) + ')</td><td class="r">' + mgPackN(s.gst_leak) + '</td></tr>'], 'pkGst') +
    (g ? '<div class="pk-blk"><h3>GSTR-2B against Zoho Books, as of today</h3><div class="pk-note" style="margin:0 0 6px">Filing period ' + escapeHtml(g.filing_period || '') + ': ' + escapeHtml(fmtINR(g.total_leakage)) + ' of input credit at risk' +
      (g.leakage_pct != null ? ' (' + Number(g.leakage_pct).toFixed(1) + '% of ITC claimed)' : '') + ', ' + (g.vendors_not_filed || 0) + ' vendor' + (g.vendors_not_filed === 1 ? '' : 's') + ' not filed.</div>' +
      (vendors.length ? mgPackTable(['Vendor', 'GSTIN', 'At risk (₹)'], vendors.slice(0, 10).map(v => '<tr><td>' + escapeHtml(v.vendor_name || '—') + '</td><td class="pk-mono">' + escapeHtml(v.vendor_gstin || '') + '</td><td class="r">' + mgPackN(v.at_risk) + '</td></tr>'), 'pkGstVendors') : '') + '</div>'
      : '<div class="pk-note">Vendor-level GSTR-2B matching needs Zoho Books connected.</div>');

  // 7. Pulse
  const vit = (s.vitals || []).map(v => ({ label:mgVitalName(v.label), value:v.value, score:Number(v.score), pts:(Number(v.score) - 50) * (VITAL_WEIGHTS[v.label] || 0) }));
  const pulseHtml = '<div class="pk-tiles" style="grid-template-columns:repeat(3,minmax(0,1fr))">' +
      tile('Pulse Score', s.pulse_score != null ? String(s.pulse_score) : 'n/a', band ? escapeHtml(band.label) : '') +
      tile('Change on prior month', p && p.pulse_score != null && s.pulse_score != null ? ((s.pulse_score - p.pulse_score > 0 ? '+' : '') + (s.pulse_score - p.pulse_score) + ' pts') : 'n/a', '') +
      tile('Confidence', s.confidence != null ? Math.round(Number(s.confidence) * 100) + '%' : 'n/a', 'share of inputs from connected sources') + '</div>' +
    (vit.length ? '<div class="pk-blk"><h3>What drives it</h3>' + mgPackTable(['Vital', 'Reading', 'Score (0–100)', 'Effect (pts)'], vit.map(v =>
      '<tr><td>' + escapeHtml(v.label) + '</td><td class="pk-mono">' + escapeHtml(v.value == null ? '—' : String(v.value)) + '</td><td class="r">' + (isFinite(v.score) ? Math.round(v.score) : '—') + '</td><td class="r ' + (v.pts < 0 ? 'pk-neg' : 'pk-pos') + '">' + (v.pts < 0 ? '−' : '+') + Math.abs(v.pts).toFixed(0) + '</td></tr>'), 'pkPulse') + '</div>' : '') +
    '<div class="pk-note">The Pulse Score measures operating health from your own figures. It is not a credit score, and Margyn is not a lender. Effect = points above or below a neutral 50, by each vital’s weight.</div>';

  // 8. commentary
  const commentary = s.briefing ? '<div class="pk-ai"><div class="pk-ai-l">Written by Margyn' + (s.briefing_generated_at ? ' · ' + escapeHtml(fmtDay(s.briefing_generated_at)) : '') + '</div>' + escapeHtml(s.briefing) + '</div>' +
      '<div class="pk-note">AI-written narrative of this month’s reading. The figures elsewhere in this pack are arithmetic on your data; the AI does not change them.</div>'
    : '<div class="pk-empty">Margyn didn’t write a briefing for ' + escapeHtml(month) + '.</div>';

  // 9. sources
  const srcKeys = ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'].filter(x => mgSourceHealth(x).on);
  const sourcesHtml = mgPackTable(['Source', 'Status'], srcKeys.map(x => '<tr><td>' + escapeHtml(MG_SRC_LABEL[x] || x) + '</td><td>' + escapeHtml(mgSourceHealth(x).text || 'Connected') + '</td></tr>')
      .concat(['<tr><td>Bank feed (Account Aggregator)</td><td class="pk-muted">Not connected</td></tr>']), 'pkSources') +
    '<div class="pk-note">Month figures: closing reading of ' + escapeHtml(fmtDay(s.created_at)) + (p ? ', compared with ' + escapeHtml(fmtDay(p.created_at)) : '') + '. Live sections: as of ' + escapeHtml(today) + '.' +
      (latestMonth ? '' : ' Live sections show today’s position, not ' + escapeHtml(month) + '’s.') + ' Where sources disagree, the most trusted source is used (Zoho Books, then Tally, then Odoo, then entries made by hand) and the difference is shown.</div>';

  const body =
    '<tbody class="pk-sec pk-cover"><tr><td><div class="pk-cover-brand">margyn</div><h1>' + escapeHtml(month) + ' CFO pack</h1>' +
      '<div class="pk-cover-sub">' + escapeHtml(org) + '</div>' +
      '<div class="pk-meta"><div><span>Organisation</span>' + escapeHtml(mgOrgShort()) + '</div><div><span>Sources</span>Reconciled</div><div><span>Month figures</span>' + escapeHtml(fmtDay(s.created_at)) + '</div><div><span>Generated</span>' + escapeHtml(gen) + '</div></div></td></tr></tbody>' +
    sec('headline', 'Headline figures', monthScope, headline) +
    sec('pl', 'Profit and loss', monthScope, pl) +
    sec('cash', 'Cash and forecast', monthScope + ' · detail ' + today, cash) +
    sec('recv', 'Receivables ageing', monthScope + ' · detail ' + today, recvHtml) +
    sec('pay', 'Payables due', monthScope + ' · detail ' + today, payHtml) +
    sec('gst', 'GST', monthScope + (g ? ' · vendors ' + today : ''), gstHtml) +
    sec('pulse', 'Pulse Score', monthScope, pulseHtml) +
    sec('commentary', 'Commentary', monthScope, commentary) +
    sec('sources', 'Sources and data freshness', liveScope, sourcesHtml);
  return '<div class="pk-doc"><table class="pk-frame">' +
    '<thead><tr><td><div class="pk-run"><span><b>' + escapeHtml(mgOrgShort()) + '</b> · CFO pack · ' + escapeHtml(month) + '</span><span>Reconciled · ' + escapeHtml(closing) + ' · generated ' + escapeHtml(gen) + '</span></div></td></tr></thead>' +
    '<tfoot><tr><td><div class="pk-runf">Prepared by Margyn from ' + escapeHtml(org) + '’s connected sources. Figures from different sources are never added together. Pulse Score is operating health, not a credit score.</div></td></tr></tfoot>' +
    body + '</table></div>';
}

/* ---------- Save as PDF ---------- */
function mgPackPrint(){
  const k = mgPackCurrent(), doc = mgPackDoc(k);
  if(!doc) return;
  let w = null;
  try { w = window.open('', '_blank', 'width=900,height=1100'); } catch(e){ w = null; }
  if(!w){ toast('Allow pop-ups to save the PDF', { sub:'Your browser blocked the print window.' }); return; }
  const title = mgOrgShort() + ' CFO pack ' + mgMonthLabel(k);
  w.document.open();
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<style>' + MG_PACK_CSS + MG_PACK_PRINT_CSS + '</style></head><body>' + doc +
    '<scr' + 'ipt>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(function(){window.focus();window.print();},300);});};</scr' + 'ipt>' +
    '</body></html>');
  w.document.close();
}

/* ---------- the page ---------- */
function mgPackCssOnce(){
  if(document.getElementById('mgPackCss')) return;
  const st = document.createElement('style'); st.id = 'mgPackCss'; st.textContent = MG_PACK_CSS; document.head.appendChild(st);
}
async function mgPackLoadSends(){
  if(mgPackSends !== null || !currentUser) return;
  mgPackSends = [];
  try {
    const { data, error } = await sbClient.from('report_deliveries').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(10);
    mgPackSends = error ? false : (data || []);
  } catch(e){ mgPackSends = false; }
}
function mgPackDeliveryLine(){
  const c = mgPackCfg(), r = c.recipients || mgPackDefaultRecipients();
  if(!c.enabled) return 'Not emailed yet. Set up delivery to send it each month.';
  return 'Emailed on the ' + mgOrdinal(c.day_of_month) + ' of each month to ' + r.length + ' ' + (r.length === 1 ? 'person' : 'people') + ': ' + r.map(x => x.name || x.email).join(', ') + '.';
}
function mgOrdinal(n){ const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function mgRenderPack(){
  const host = document.getElementById('view-cfopack'); if(!host) return;
  mgPackCssOnce();
  if(typeof mgCashGw !== 'undefined' && !mgCashGw && !mgCashGwLoading) mgCashLoadGateways().then(() => { if(mgCurrentView === 'cfopack') mgRenderPack(); });
  const months = mgPackMonths();
  if(!months.length){
    host.innerHTML = mgPageHead({ group:'Insight', title:'CFO pack', sub:'A monthly report to share with your CA, co-founder or lender.' }) +
      '<div class="mg-panel mg-empty-panel"><h2>Your first pack needs a month of figures</h2><p>Import a workbook or connect a source. The pack is built from each month’s closing reading.</p>' + mgBtn('Import a file', 'data-go-page="import"', true) + '</div>';
    return;
  }
  const k = mgPackCurrent();
  const monthSel = '<label class="mg-pk-month"><span>Month</span><select data-pk-month>' + months.map(m => '<option value="' + m + '"' + (m === k ? ' selected' : '') + '>' + escapeHtml(mgMonthLabel(m)) + '</option>').join('') + '</select></label>';
  host.innerHTML = mgPageHead({ group:'Insight', title:'CFO pack', scope:mgOrgShort() + ' · Reconciled · ' + mgMonthLabel(k),
      sub:'A monthly report to share with your CA, co-founder or lender. Save it as a PDF, or have it emailed each month.',
      actions:monthSel + mgBtn('Delivery and sections', 'data-pk-customise') + mgBtn('Save as PDF', 'data-pk-print', true) }) +
    '<div class="mg-panel mg-pk-strip"><div class="mg-li"><div><div class="mg-li-t">Monthly email</div><div class="mg-li-s" id="mgPackDelivery">' + escapeHtml(mgPackDeliveryLine()) + '</div></div>' +
      '<button class="mg-btn mg-btn-sm" type="button" data-pk-customise>' + (mgPackCfg().enabled ? 'Change' : 'Set up delivery') + '</button></div></div>' +
    '<div class="mg-pk-paper">' + mgPackDoc(k) + '</div>';
}

/* ---------- delivery and sections drawer ---------- */
function mgPackDrawer(){
  const c = mgPackCfg(), rec = c.recipients || mgPackDefaultRecipients();
  const k = mgPackCurrent();
  const sends = mgPackSends;
  mgDrawer({
    title:'Delivery and sections',
    sub:'Saved to your account.',
    body:
      '<h4>Sections in the pack</h4>' +
      MG_PACK_SECTIONS.map(([key, l]) => '<label class="mg-switch"><input type="checkbox" data-pk-secopt="' + key + '"' + (c.sections.includes(key) ? ' checked' : '') + '> <span>' + escapeHtml(l) + '</span></label>').join('') +
      '<h4>Monthly email</h4>' +
      '<label class="mg-switch"><input type="checkbox" data-pk-enabled' + (c.enabled ? ' checked' : '') + '> <span>Email the pack each month</span></label>' +
      '<label class="mg-field"><span class="mg-field-l">Send on this day of the month</span><span class="mg-field-in"><select data-pk-day>' +
        Array.from({ length:28 }, (_, i) => '<option value="' + (i + 1) + '"' + (c.day_of_month === i + 1 ? ' selected' : '') + '>' + mgOrdinal(i + 1) + '</option>').join('') + '</select></span>' +
        '<span class="mg-field-h">Covers the previous month. Sent around 8 am IST.</span></label>' +
      '<div class="mg-pk-rec" id="mgPackRec">' + (rec.length ? rec.map((r, i) => '<div class="mg-li"><div><div class="mg-li-t">' + escapeHtml(r.name || r.email) + '</div><div class="mg-li-s">' + escapeHtml(r.email) + '</div></div><button class="mg-row-act" type="button" data-pk-rm="' + i + '">Remove</button></div>').join('') : '<div class="mg-empty">No recipients yet.</div>') + '</div>' +
      '<div class="mg-pk-add"><input type="text" placeholder="Name" data-pk-newname maxlength="80"><input type="email" placeholder="Email" data-pk-newemail maxlength="200"><button class="mg-btn mg-btn-sm" type="button" data-pk-add>Add</button></div>' +
      '<div class="mg-field-h" id="mgPackAddNote">Up to 10 people. They get the key numbers and Margyn’s commentary by email. The full pack opens for anyone who can log in to this Margyn account.</div>' +
      '<h4>Recent sends</h4>' +
      (sends === false ? '<div class="mg-field-h">The delivery log isn’t set up yet.</div>' : !sends || !sends.length ? '<div class="mg-field-h">Nothing sent yet.</div>' :
        sends.map(x => '<div class="mg-li"><div><div class="mg-li-t">' + escapeHtml(x.recipient_email) + (x.kind === 'test' ? ' (test)' : '') + '</div><div class="mg-li-s">' + escapeHtml(mgMonthLabel(x.period) + ' · ' + fmtDate(x.created_at)) + '</div></div><span class="mg-bdg ' + (x.status === 'sent' ? 'pos' : 'neg') + '">' + (x.status === 'sent' ? 'Sent' : 'Failed') + '</span></div>').join('')),
    foot:'<button class="mg-btn" type="button" data-pk-test>Send a test to me</button><button class="mg-btn primary" type="button" data-drawer-close>Done</button>',
    onInput:el => {
      if(el.dataset.pkSecopt){
        const on = [...document.querySelectorAll('.mg-drawer [data-pk-secopt]')].filter(x => x.checked).map(x => x.dataset.pkSecopt);
        mgPackSave({ sections:on });
      } else if(el.matches('[data-pk-enabled]')){
        if(el.checked && !(mgPackCfg().recipients || mgPackDefaultRecipients()).length){ el.checked = false; mgPackNote('Add at least one person first.', true); return; }
        mgPackSave({ enabled:el.checked });
      } else if(el.matches('[data-pk-day]')) mgPackSave({ day_of_month:Number(el.value) });
      else return;
      mgPackRefresh();
    }
  });
  if(sends === null) mgPackLoadSends().then(() => { if(document.querySelector('.mg-drawer [data-pk-enabled]')) mgPackDrawer(); });
}
function mgPackNote(t, bad){ const n = document.getElementById('mgPackAddNote'); if(n){ n.textContent = t; n.style.color = bad ? 'var(--neg)' : ''; } }
function mgPackRefresh(){ if(mgCurrentView === 'cfopack') mgRenderPack(); }
document.addEventListener('click', async e => {
  const t = e.target;
  if(t.closest('[data-pk-print]')){ mgPackPrint(); return; }
  if(t.closest('[data-pk-customise]')){ mgPackDrawer(); return; }
  const rm = t.closest('[data-pk-rm]');
  if(rm){
    const rec = (mgPackCfg().recipients || mgPackDefaultRecipients()).slice();
    rec.splice(Number(rm.dataset.pkRm), 1);
    mgPackSave({ recipients:rec, enabled:rec.length ? mgPackCfg().enabled : false });
    mgPackDrawer(); mgPackRefresh(); return;
  }
  if(t.closest('[data-pk-add]')){
    const nameEl = document.querySelector('.mg-drawer [data-pk-newname]'), mailEl = document.querySelector('.mg-drawer [data-pk-newemail]');
    const name = (nameEl.value || '').trim(), email = (mailEl.value || '').trim().toLowerCase();
    const rec = (mgPackCfg().recipients || mgPackDefaultRecipients()).slice();
    if(!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(email)){ mgPackNote('Enter a valid email address.', true); return; }
    if(rec.some(r => String(r.email).toLowerCase() === email)){ mgPackNote('That person is already on the list.', true); return; }
    if(rec.length >= 10){ mgPackNote('Up to 10 people.', true); return; }
    rec.push({ name, email });
    mgPackSave({ recipients:rec });
    mgPackDrawer(); mgPackRefresh(); return;
  }
  if(t.closest('[data-pk-test]')){
    const btn = t.closest('[data-pk-test]'); btn.disabled = true;
    try {
      const { data:{ session } } = await sbClient.auth.getSession();
      if(!session) throw new Error('Log in again to send a test.');
      const r = await fetch('/api/ops?action=cfo-pack-test', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + session.access_token }, body:JSON.stringify({ period:mgPackCurrent() }) });
      const j = await r.json().catch(() => ({}));
      if(!r.ok) throw new Error(j.error || 'Could not send the test email.');
      toast('Test sent', { sub:'Check ' + (j.to || 'your inbox') + '.' });
      mgPackSends = null;
    } catch(err){ toast('Test not sent', { sub:err.message }); }
    btn.disabled = false;
  }
});
document.addEventListener('change', e => {
  if(!e.target.matches('[data-pk-month]')) return;
  mgPackMonth = e.target.value; mgRenderPack(); mgRefreshScope(); mgWriteHash(false);
});
