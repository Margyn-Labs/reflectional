/* ============================================================
   13-WEEK CASH FORECAST — a feature the customer steers.

   Deterministic arithmetic on the customer's own figures; the AI never
   touches it. Every assumption is visible, starts from the customer's own
   data, and can be changed or switched off (Home → Adjust).

   Week 1 starts today. Closing cash for each week =
     opening cash (latest snapshot)
   + open receivables, each on its due date + collection delay; ones already
     overdue come in spread over weeks 1–4 (2026-10-04: they all landed in
     week 3, so weeks 1–2 had no money in at all); items overdue by more than
     the doubtful threshold are left out
   + new sales collected per month, from the week the customer sets
   − open bills, each on its due date + payment delay; overdue ones spread
     over weeks 1–4, and bills overdue by more than the doubtful threshold
     are left out (a 431-day-old bill is in dispute, not due this week)
   − spend not in bills (salaries, rent...) per month, every week
   − new bills per month, from the week the customer sets
   − GST on the 20th of each month.
   Receivables/payables use the reconciled view (each party once, from its
   most trusted source), so no source is counted twice.

   Defaults (all overridable): delay 15 days, doubtful after 90 days, bills
   on the due date, new sales = latest monthly revenue from the week today's
   open invoices are used up (receivables / weekly sales), spend not in bills = monthly spend minus bills due in
   30 days, new bills = the rest from week 5, GST = latest GST payable,
   floor = two weeks of spend. Week 1 is this week.
   Settings are saved to the account (profiles.preferences.forecast, see 19c-prefs.js).

   2026-10-04: by default the forecast is LEARNED from the books instead (api/_lib/cashFlowModel.js, sent as
   forecast_v2 in the analytics payload): each customer's open invoices on how that customer has actually paid,
   new sales collected the same way, suppliers the way that predicted them best on this business's past weeks,
   recurring payments on their days, entries already made for later dates, GST from where it's paid. Cash is
   before loans, overdraft and transfers. The range is as wide as it has actually missed on these books.
   The arithmetic above stays as "My own assumptions" (Adjust → How the forecast is made).
   ============================================================ */
const MG_FC_WEEKS = 13;
const MG_WEEKLY = 12 / 52;   // monthly amount -> per week
const MG_FC_SPREAD = 4;      // overdue money in and out is spread over the first four weeks

function mgFcData(){
  const s = (typeof snapshots !== 'undefined' && snapshots[0]) || null;
  if(!s) return null;
  const pay = mgMoneyGroups('pay');
  const payDue30 = pay.reduce((t, g) => t + g.by[g.primary].rows.filter(r => r.days === null || r.days <= 30).reduce((a, r) => a + r.amount, 0), 0);
  const burn = Math.max(0, Number(s.burn) || 0);
  const fixed = Math.max(0, burn - payDue30);
  // New sales start arriving when today's open invoices have been collected:
  // weeks of cover = open receivables (excluding doubtful, >90 days overdue) / weekly sales.
  const revenue = Math.max(0, Number(s.revenue) || 0);
  const recvOpen = mgMoneyGroups('recv').reduce((t, g) => t + g.by[g.primary].rows.filter(r => !(r.days !== null && r.days < -90)).reduce((a, r) => a + r.amount, 0), 0);
  const cover = revenue > 0 ? recvOpen / (revenue * MG_WEEKLY) : 0;
  // Opening cash: today's balance in the books when Tally is where cash comes from (19i-margin.js).
  const prov = s.input_provenance && s.input_provenance.cash;
  const live = prov && prov.source === 'tally' && typeof mgMar !== 'undefined' && mgMar && !mgMarCompany && mgMar.cash && mgMar.cash.total != null ? Number(mgMar.cash.total) : null;
  return {
    cash:live != null && isFinite(live) ? live : (Number(s.cash) || 0), asOf:live != null ? (mgMar.as_of || s.created_at) : s.created_at,
    defaults:{
      enabled:true, mode:'learned', collectDelay:15, doubtfulAfter:90, payDelay:0,
      // Week numbers are as people count them: week 1 is this week.
      salesMonthly:Math.round(revenue), salesStart:Math.max(1, Math.min(13, Math.floor(cover) + 1)),
      fixedMonthly:Math.round(fixed), billsMonthly:Math.round(Math.max(0, burn - fixed)), billsStart:5,
      gstMonthly:Math.round(Number(s.gst_payable) || 0), floor:Math.round(burn / 2)
    },
    origin:{
      salesMonthly:'your latest monthly revenue', salesStart:'when your open invoices have been collected', fixedMonthly:'monthly spend less bills due in 30 days',
      billsMonthly:'the rest of your monthly spend', gstMonthly:'your latest GST payable', floor:'two weeks of spend'
    }
  };
}
function mgFcSettings(){
  const d = mgFcData(); if(!d) return null;
  const saved = mgPrefGet('forecast', {}) || {};
  const out = Object.assign({}, d.defaults);
  Object.keys(out).forEach(k => { if(saved[k] !== undefined && saved[k] !== null && saved[k] !== '') out[k] = typeof out[k] === 'boolean' ? !!saved[k] : typeof out[k] === 'string' ? String(saved[k]) : Number(saved[k]); });
  return out;
}
function mgFcSave(patch){
  mgPrefSet('forecast', Object.assign({}, mgPrefGet('forecast', {}), patch));
}
function mgFcReset(){ mgPrefSet('forecast', null); }

/* The learned forecast from the books, when this account's books sent one (another company's books don't describe it). */
function mgFcLearned(){
  if(typeof mgMar === 'undefined' || !mgMar || mgMarCompany) return null;
  const v = mgMar.forecast_v2;
  return v && Array.isArray(v.weeks) && v.weeks.length === MG_FC_WEEKS ? v : null;
}
function mgForecast(){
  const d = mgFcData(); if(!d) return null;
  const st = mgFcSettings();
  const v = st.mode !== 'manual' ? mgFcLearned() : null;
  if(v){
    const close = v.weeks.map(w => w.close), min = Math.min(...close);
    return { learned:true, v, opening:v.opening, close, low:v.weeks.map(w => w.low), high:v.weeks.map(w => w.high),
      inflow:v.weeks.map(w => w.in), outflow:v.weeks.map(w => w.out), min, minWeek:close.indexOf(min), firstBelow:close.findIndex(c => c < st.floor),
      floor:st.floor, doubtful:(v.drivers.doubtful || {}).amount || 0, beyond:0, stale:0, overdueIn:0, overdueOut:0, st, origin:d.origin };
  }
  const inflow = new Array(MG_FC_WEEKS).fill(0), outflow = new Array(MG_FC_WEEKS).fill(0);
  let doubtful = 0, beyond = 0, stale = 0, overdueIn = 0, overdueOut = 0;
  const weekOf = days => Math.floor(Math.max(0, days) / 7);
  const spread = (arr, amt) => { for(let w = 0; w < MG_FC_SPREAD; w++) arr[w] += amt / MG_FC_SPREAD; };
  mgMoneyGroups('recv').forEach(g => g.by[g.primary].rows.forEach(r => {
    const due = r.days === null ? 0 : r.days;
    if(due < 0 && -due > st.doubtfulAfter){ doubtful += r.amount; return; }
    if(due < 0){ overdueIn += r.amount; spread(inflow, r.amount); return; }
    const w = weekOf(due + st.collectDelay);
    if(w >= MG_FC_WEEKS){ beyond += r.amount; return; }
    inflow[w] += r.amount;
  }));
  mgMoneyGroups('pay').forEach(g => g.by[g.primary].rows.forEach(r => {
    const due = r.days === null ? 0 : r.days;
    if(due < 0 && -due > st.doubtfulAfter){ stale += r.amount; return; }
    if(due < 0){ overdueOut += r.amount; spread(outflow, r.amount); return; }
    const w = weekOf(due + st.payDelay);
    if(w < MG_FC_WEEKS) outflow[w] += r.amount;
  }));
  const today = new Date(new Date().toDateString());
  for(let w = 0; w < MG_FC_WEEKS; w++){
    if(w >= st.salesStart - 1) inflow[w] += st.salesMonthly * MG_WEEKLY;
    outflow[w] += st.fixedMonthly * MG_WEEKLY;
    if(w >= st.billsStart - 1) outflow[w] += st.billsMonthly * MG_WEEKLY;
    for(let k = 0; k < 7; k++){   // GST on the 20th
      const day = new Date(today.getTime() + (w * 7 + k) * 86400000);
      if(day.getDate() === 20) outflow[w] += st.gstMonthly;
    }
  }
  const close = []; let c = d.cash;
  for(let w = 0; w < MG_FC_WEEKS; w++){ c += inflow[w] - outflow[w]; close.push(c); }
  const min = Math.min(...close), minWeek = close.indexOf(min);
  const firstBelow = close.findIndex(v => v < st.floor);
  return { opening:d.cash, close, inflow, outflow, min, minWeek, firstBelow, floor:st.floor, doubtful, beyond, stale, overdueIn, overdueOut, st, origin:d.origin };
}

/* ---------- Home panel ---------- */
function mgForecastChart(f, wide){
  const W = wide ? 1100 : 640, H = wide ? 230 : 210, padL = 56, padR = 16, padB = 24, padT = 12;
  const vals = [f.opening, ...f.close, f.floor, ...(f.low || []), ...(f.high || [])];
  const lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.08 || 1;
  const x = i => padL + i * (W - padL - padR) / MG_FC_WEEKS;
  const y = v => H - padB - (v - lo) / (hi - lo) * (H - padB - padT);
  const pts = [f.opening, ...f.close];
  const d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  let ax = '';
  [lo, (lo + hi / 1.08) / 2, hi / 1.08].forEach(v => { ax += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#ECEAE4"/><text x="0" y="' + (y(v) + 4) + '" class="mg-ax">' + escapeHtml(fmtINR(v, 'tile').replace('₹', '')) + '</text>'; });
  for(let i = 1; i <= MG_FC_WEEKS; i += 2) ax += '<text x="' + x(i) + '" y="' + (H - 6) + '" class="mg-ax" text-anchor="middle">W' + i + '</text>';
  const fy = y(f.floor);
  const minX = x(f.minWeek + 1), minY = y(f.min);
  // The range (learned forecast): cautious to hopeful, as wide as the forecast has actually missed on these books.
  const band = f.low ? '<path d="M' + x(0) + ',' + y(f.opening) + f.high.map((v, i) => 'L' + x(i + 1).toFixed(1) + ',' + y(v).toFixed(1)).join('') +
    f.low.map((v, i) => [i, v]).reverse().map(([i, v]) => 'L' + x(i + 1).toFixed(1) + ',' + y(v).toFixed(1)).join('') + 'Z" fill="#0E8F5C" opacity=".13"/>' : '';
  const tips = f.close.map((v, i) => '<circle cx="' + x(i + 1).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="9" fill="transparent"><title>' + escapeHtml('Week ' + (i + 1) + ': ' + fmtINR(v, 'tile') +
    (f.low ? ' (range ' + fmtINR(f.low[i], 'tile') + ' to ' + fmtINR(f.high[i], 'tile') + ')' : '')) + '</title></circle>').join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="13-week cash forecast">' + ax + band +
    '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + fy + '" y2="' + fy + '" stroke="#B3432E" stroke-dasharray="4 4"/>' +
    '<path d="' + d + 'L' + x(MG_FC_WEEKS) + ',' + y(lo) + 'L' + x(0) + ',' + y(lo) + 'Z" fill="#0E8F5C" opacity=".08"/>' +
    '<path d="' + d + '" fill="none" stroke="#0E8F5C" stroke-width="2"/>' +
    '<circle cx="' + minX + '" cy="' + minY + '" r="3.5" fill="' + (f.min < f.floor ? '#B3432E' : '#0E8F5C') + '"/>' + tips + '</svg>';
}
function mgForecastSentence(f){
  if(f.learned){
    const v = f.v, dr = v.drivers || {}, bits = [];
    const cd = dr.collection_days || {};
    bits.push('each customer’s open invoices come in the way that customer has actually paid' + (cd.p50 ? ' (a typical invoice is paid in ' + cd.p50 + ' days)' : ''));
    if(dr.pace && dr.pace.sales_weekly) bits.push('new sales of about ' + fmtINR(dr.pace.sales_weekly, 'tile') + ' a week are collected the same way');
    const sm = dr.suppliers && dr.suppliers.method;
    bits.push(sm === 'bills' ? 'suppliers are paid on their open bills, as quickly as you usually pay them' : 'suppliers are paid at your recent pace of about ' + fmtINR((dr.pace || {}).suppliers_weekly || 0, 'tile') + ' a week');
    if((dr.recurring || []).length) bits.push((dr.recurring || []).length + ' monthly payments on their usual day');
    if((dr.known_ahead || []).length) bits.push('payments already entered for later dates on those dates');
    if(dr.gst_next && dr.gst_next.amount) bits.push('GST of ' + fmtINR(dr.gst_next.amount, 'tile') + ' on ' + mgFcDay(dr.gst_next.date));
    return 'Learned from your books: ' + bits.join(', ') + '. Cash before loans, overdraft and transfers. The shaded band is how far off it has been on your past weeks.';
  }
  const st = f.st, bits = [];
  bits.push('customers pay ' + st.collectDelay + ' days after the due date');
  if(f.overdueIn) bits.push(fmtINR(f.overdueIn, 'tile') + ' already overdue comes in over the next four weeks');
  if(f.doubtful) bits.push(fmtINR(f.doubtful, 'tile') + ' overdue more than ' + st.doubtfulAfter + ' days is left out');
  bits.push(st.payDelay ? 'bills are paid ' + st.payDelay + ' days after due' : 'bills are paid on their due date');
  if(f.overdueOut) bits.push(fmtINR(f.overdueOut, 'tile') + ' of overdue bills is paid over the next four weeks');
  if(f.stale) bits.push(fmtINR(f.stale, 'tile') + ' of bills overdue more than ' + st.doubtfulAfter + ' days is left out (check whether you still owe it)');
  if(st.salesMonthly) bits.push(fmtINR(st.salesMonthly, 'tile') + ' of new sales a month from week ' + st.salesStart);
  if(st.gstMonthly) bits.push('GST of ' + fmtINR(st.gstMonthly, 'tile') + ' on the 20th');
  return 'Assumes ' + bits.join(', ') + '.';
}
const mgFcDay = iso => new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone:'UTC', day:'numeric', month:'short' });
/* One line on how well the learned forecast has done on these books (its self-check). */
function mgFcTrackLine(v){
  const sc = v && v.self_check;
  if(!sc || !sc.checks || !sc.checks.length) return '';
  const miss = sc.checks.reduce((t, c) => t + Math.abs(c.predicted_customer_in - c.actual_customer_in) / Math.max(1, c.actual_customer_in), 0) / sc.checks.length;
  const m4 = (sc.error_by_week || {})[4];
  return 'Checked on your last ' + sc.checks.length + ' weeks: money from customers was within ' + Math.round(miss * 100) + '% on average' +
    (m4 ? ', and cash four weeks out within about ' + fmtINR(m4.typical_miss, 'tile') : '') + '.';
}
function mgForecastPanel(wide){
  const f = mgForecast(); if(!f) return '';
  if(!f.st.enabled) return null;   // customer switched it off: Home shows cash history instead
  const warn = f.firstBelow >= 0;
  return '<div class="mg-panel"><div class="mg-panel-h"><h2>13-week cash forecast</h2>' +
    '<span class="mg-aside">' + (f.learned ? 'Learned from your books · ' : '') + 'Opening ' + escapeHtml(fmtINR(f.opening, 'tile')) + ' · floor ' + escapeHtml(fmtINR(f.floor, 'tile')) + '</span>' +
    '<button class="mg-btn mg-btn-sm" type="button" data-fc-adjust>Adjust</button></div><div class="mg-panel-b">' +
    '<div class="mg-fc-callout' + (warn ? ' warn' : '') + '">' + (warn
      ? (f.opening < f.floor ? 'Cash today is already below your floor of ' + escapeHtml(fmtINR(f.floor, 'tile')) + '.' : 'Cash falls below your floor in week ' + (f.firstBelow + 1) + '.') + ' Lowest point ' + escapeHtml(fmtINR(f.min, 'tile')) + ' in week ' + (f.minWeek + 1) + '.'
      : 'Stays above your floor for 13 weeks. Lowest point ' + escapeHtml(fmtINR(f.min, 'tile')) + ' in week ' + (f.minWeek + 1) + '.') + '</div>' +
    mgForecastChart(f, wide) +
    (f.learned && mgFcTrackLine(f.v) ? '<div class="mg-fine"><b>' + escapeHtml(mgFcTrackLine(f.v)) + '</b></div>' : '') +
    '<div class="mg-fine">' + escapeHtml(mgForecastSentence(f)) + ' ' + (f.learned
      ? '<button class="mg-link" type="button" data-fc-how>How Margyn built this</button> · <button class="mg-link" type="button" data-fc-adjust>Adjust</button>'
      : '<button class="mg-link" type="button" data-fc-adjust>Change the assumptions</button>') + '</div></div></div>';
}
/* Week-by-week table (Cash page, CFO pack). Week 1 starts today. */
function mgForecastWeeks(f){
  const today = new Date(new Date().toDateString());
  const d = n => new Date(today.getTime() + n * 86400000).toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short' });
  return f.close.map((c, w) => ({ n:w + 1, from:d(w * 7), to:d(w * 7 + 6), inflow:f.inflow[w], outflow:f.outflow[w], close:c, below:c < f.floor,
    low:f.low ? f.low[w] : null, high:f.high ? f.high[w] : null }));
}
function mgForecastTable(f){
  const rng = !!f.low;
  return '<div class="mg-gridwrap"><table class="mg-grid" id="mgFcTable"><thead><tr><th>Week</th><th>Dates</th><th class="r">Coming in (₹)</th><th class="r">Going out (₹)</th><th class="r">Closing cash (₹)</th>' +
    (rng ? '<th class="r">Cautious (₹)</th><th class="r">Hopeful (₹)</th>' : '') + '<th></th></tr></thead><tbody>' +
    mgForecastWeeks(f).map(r => '<tr><td>W' + r.n + '</td><td class="mg-muted">' + escapeHtml(r.from + ' – ' + r.to) + '</td><td class="r">' + mgNum(r.inflow) + '</td><td class="r">' + mgNum(r.outflow) + '</td>' +
      '<td class="r' + (r.below ? ' mg-diff' : '') + '">' + mgNum(r.close) + '</td>' + (rng ? '<td class="r mg-muted">' + mgNum(r.low) + '</td><td class="r mg-muted">' + mgNum(r.high) + '</td>' : '') +
      '<td>' + (r.below ? '<span class="mg-bdg neg">Below floor</span>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ---------- Cash page: how the learned forecast was built ---------- */
function mgForecastHowPanel(f){
  if(!f || !f.learned) return '';
  const v = f.v, dr = v.drivers || {}, sc = v.self_check || {};
  const tbl = (id, head, rows) => rows.length ? '<div class="mg-gridwrap"><table class="mg-grid" id="' + id + '"><thead><tr>' + head.map(h => '<th' + (h[1] ? ' class="r"' : '') + '>' + escapeHtml(h[0]) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + r.map((c, i) => '<td' + (head[i][1] ? ' class="r"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '';
  const sec = (title, aside, inner) => inner ? '<div class="mg-panel-h mg-sub-h"><h2>' + escapeHtml(title) + '</h2>' + (aside ? '<span class="mg-aside">' + escapeHtml(aside) + '</span>' : '') + '</div>' + inner : '';
  const track = tbl('mgFcTrack', [['Forecast made on'], ['Customers, expected (₹)', 1], ['Customers, paid (₹)', 1], ['Cash, 4 weeks on: off by (₹)', 1]],
    (sc.checks || []).map(c => [escapeHtml(mgFcDay(c.as_of)), mgNum(c.predicted_customer_in), mgNum(c.actual_customer_in), mgNum(c.cash_error)]));
  const graded = (v.accuracy || []).filter(a => a.horizon_days === 28);
  const cust = tbl('mgFcCust', [['Customer'], ['Owes (₹)', 1], ['Expected in 13 weeks (₹)', 1], ['Usually pays in']],
    (dr.customers || []).map(c => [escapeHtml(c.party), mgNum(c.open), mgNum(c.expected_13w), escapeHtml((c.habit_days != null ? c.habit_days + ' days' : '—') + (c.own_history ? '' : ' (everyone’s pattern)'))]));
  const rec = tbl('mgFcRec', [['Paid every month'], ['About (₹)', 1], ['Around day']], (dr.recurring || []).map(r => [escapeHtml(r.ledger), mgNum(r.amount), String(r.day_of_month)]));
  const ahead = tbl('mgFcAhead', [['Entered for'], ['Amount (₹)', 1], ['Account']], (dr.known_ahead || []).map(k => [escapeHtml(mgFcDay(k.date)), mgNum(Math.abs(k.amount)), escapeHtml(k.ledger || '')]));
  const pace = dr.pace || {}, sup = dr.suppliers || {};
  const paceRows = [['New sales', pace.sales_weekly, 'collected the way customers pay'],
    ['Supplier payments', pace.suppliers_weekly, sup.method === 'bills' ? 'not used: open bills predicted your past weeks better' : 'used: predicted your past weeks better than open bills'],
    ['Purchases', pace.purchases_weekly, sup.method === 'bills' ? 'used, paid as quickly as you usually pay' : ''],
    ['Other running costs', pace.running_costs_weekly, 'not monthly, not suppliers']].filter(r => r[1] != null && (r[1] || r[0] === 'New sales'))
    .map(r => [escapeHtml(r[0]), mgNum(r[1]), escapeHtml(r[2])]);
  const g = dr.gst_next;
  const notes = (v.notes || []).map(n => '<li>' + escapeHtml(n) + '</li>').join('');
  return '<div class="mg-panel" id="mgFcHow"><div class="mg-panel-h"><h2>How Margyn built this</h2><span class="mg-aside">From every entry in your books this year</span></div>' +
    '<div class="mg-panel-b"><div class="mg-fine">' + escapeHtml(mgFcTrackLine(v) || 'Not enough history yet to check it against past weeks.') + '</div>' + (notes ? '<ul class="mg-fine">' + notes + '</ul>' : '') + '</div>' +
    sec('Its track record', 'The same forecast made on each past week, using only what was known then', track) +
    (graded.length ? '<div class="mg-foot-note">Saved forecasts graded so far: ' + graded.map(a => escapeHtml(mgFcDay(a.run_date)) + ' off by ' + escapeHtml(fmtINR(a.error, 'tile'))).join(' · ') + '</div>' : '') +
    sec('Customers', 'Biggest money expected in, from how each one has paid', cust) +
    sec('Monthly payments', 'Paid in at least 3 of the last 4 months, similar amount, same time of month', rec) +
    sec('Already entered for later dates', 'Taken out on their dates', ahead) +
    sec('Weekly pace', 'Median of the last 8 weeks (₹ a week)', tbl('mgFcPace', [['What'], ['₹ a week', 1], ['How it’s used']], paceRows)) +
    (g ? '<div class="mg-foot-note">GST: ' + escapeHtml(g.paid_from_elsewhere ? 'your books show about ' + fmtINR(g.books_estimate, 'tile') + ' due on ' + mgFcDay(g.date) + '; it hasn’t been paid from these accounts lately, so it isn’t taken from cash here.' : fmtINR(g.amount, 'tile') + ' on ' + mgFcDay(g.date) + (g.paid_vs_estimate !== 1 ? ' (your books estimate ' + fmtINR(g.books_estimate, 'tile') + '; you’ve paid about ' + Math.round(g.paid_vs_estimate * 100) + '% of the estimate lately)' : ' (from your books)') + '.') +
      ((dr.doubtful || {}).amount ? ' Left out as doubtful: ' + escapeHtml(fmtINR(dr.doubtful.amount, 'tile')) + '.' : '') + '</div>' : '') +
    '</div>';
}

/* ---------- Cash page: week by week this year (cash, receivables, payables, days to collect) ---------- */
function mgHistMini(title, pts, key, fmt, note){
  const vals = pts.map(p => p[key]).filter(v => v != null);
  if(vals.length < 2) return '';
  const W = 300, H = 110, padL = 6, padR = 6, padT = 10, padB = 18;
  const lo = Math.min(0, ...vals), hi = Math.max(...vals) || 1;
  const x = i => padL + i * (W - padL - padR) / Math.max(1, pts.length - 1);
  const y = v => H - padB - (v - lo) / (hi - lo || 1) * (H - padB - padT);
  let d = '', pen = false;
  pts.forEach((p, i) => { if(p[key] == null){ pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p[key]).toFixed(1); pen = true; });
  const last = pts.length - 1, lv = pts[last][key];
  const tips = pts.map((p, i) => p[key] == null ? '' : '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p[key]).toFixed(1) + '" r="7" fill="transparent"><title>' + escapeHtml(mgFcDay(p.date) + ': ' + fmt(p[key])) + '</title></circle>').join('');
  return '<div class="mg-histmini"><div class="mg-histmini-h"><span>' + escapeHtml(title) + '</span><b>' + escapeHtml(lv == null ? '—' : fmt(lv)) + '</b></div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + escapeHtml(title + ', week by week') + '">' +
    '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(lo) + '" y2="' + y(lo) + '" stroke="#ECEAE4"/>' +
    '<path d="' + d + '" fill="none" stroke="#0E8F5C" stroke-width="2"/>' + (lv != null ? '<circle cx="' + x(last) + '" cy="' + y(lv) + '" r="3.5" fill="#0E8F5C"/>' : '') +
    '<text x="' + padL + '" y="' + (H - 4) + '" class="mg-ax">' + escapeHtml(mgFcDay(pts[0].date)) + '</text><text x="' + (W - padR) + '" y="' + (H - 4) + '" class="mg-ax" text-anchor="end">' + escapeHtml(mgFcDay(pts[last].date)) + '</text>' +
    tips + '</svg>' + (note ? '<div class="mg-fine">' + escapeHtml(note) + '</div>' : '') + '</div>';
}
function mgPositionHistoryPanel(){
  const v = mgFcLearned();
  const h = v && v.history;
  if(!h || h.length < 3) return '';
  const tile = n => fmtINR(n, 'tile');
  return '<div class="mg-panel" id="mgFcHist"><div class="mg-panel-h"><h2>Week by week this year</h2><span class="mg-aside">End of each week, from your books</span></div>' +
    '<div class="mg-panel-b"><div class="mg-histgrid">' +
    mgHistMini('Cash', h, 'cash', tile, 'Bank and cash, not counting the overdraft.') +
    mgHistMini('Customers owe you', h, 'receivables', tile, '') +
    mgHistMini('You owe suppliers', h, 'payables', tile, '') +
    mgHistMini('Days to collect', h, 'days_to_collect', n => Math.round(n) + ' days', 'What customers owe ÷ the last 90 days’ sales per day.') +
    '</div></div></div>';
}
function mgFcRerender(){ if(mgCurrentView === 'home' || mgCurrentView === 'cash') mgRenderOwn(mgCurrentView); }

/* ---------- Adjust panel (side drawer) ---------- */
function mgForecastEditor(){
  const d = mgFcData(); if(!d) return;
  const st = mgFcSettings(), def = d.defaults;
  const num = (k, label, unit, help) => '<label class="mg-field"><span class="mg-field-l">' + escapeHtml(label) +
      (unit === '₹' ? ' <b class="mg-field-v" data-fcv="' + k + '">' + escapeHtml(fmtINR(st[k], 'tile')) + '</b>' : '') + '</span>' +
    '<span class="mg-field-in">' + (unit === '₹' ? '<i>₹</i>' : '') + '<input type="number" inputmode="numeric" min="0" step="' + (unit === '₹' ? '1000' : '1') + '" data-fc="' + k + '" value="' + st[k] + '">' + (unit && unit !== '₹' ? '<i>' + escapeHtml(unit) + '</i>' : '') + '</span>' +
    '<span class="mg-field-h">' + escapeHtml(help + (d.origin[k] ? ' Default: ' + (unit === '₹' ? fmtINR(def[k]) : def[k]) + ', ' + d.origin[k] + '.' : ' Default: ' + def[k] + '.')) + '</span></label>';
  const learnedOk = !!mgFcLearned(), manual = st.mode === 'manual' || !learnedOk;
  const radio = (val, label, help, dis) => '<label class="mg-switch"><input type="radio" name="mgFcMode" data-fc="mode" value="' + val + '"' + ((val === 'manual') === manual ? ' checked' : '') + (dis ? ' disabled' : '') + '> <span><b>' + escapeHtml(label) + '</b><br><span class="mg-field-h">' + escapeHtml(help) + '</span></span></label>';
  mgDrawer({
    title:'Forecast assumptions',
    sub:'Change any of these and the forecast updates. ' + mgPrefWhere(),
    body:
      '<label class="mg-switch"><input type="checkbox" data-fc="enabled"' + (st.enabled ? ' checked' : '') + '> <span>Show the forecast</span></label>' +
      '<h4>How the forecast is made</h4>' +
      radio('learned', 'Learned from your books (recommended)', learnedOk ? 'How each customer actually pays, your suppliers, monthly payments and entries made ahead, checked against your past weeks.' : 'Needs your books (Tally, Zoho Books or Odoo) connected and synced.', !learnedOk) +
      radio('manual', 'My own assumptions', 'Set the figures below yourself.') +
      '<h4>Alert</h4>' +
      num('floor', 'Warn me if cash falls below', '₹', '') +
      '<div' + (manual ? '' : ' hidden') + ' data-fc-manual>' +
      '<h4>Money coming in</h4>' +
      num('collectDelay', 'Customers pay this many days after the due date', 'days', '') +
      num('doubtfulAfter', 'Leave out invoices overdue by more than', 'days', 'Treated as doubtful and not counted.') +
      num('salesMonthly', 'New sales collected per month', '₹', '') +
      num('salesStart', 'New sales start arriving in week', '', 'Week 1 is this week.') +
      '<h4>Money going out</h4>' +
      num('payDelay', 'Bills are paid this many days after the due date', 'days', '') +
      num('fixedMonthly', 'Spend not in your bills, per month', '₹', 'Salaries, rent, subscriptions.') +
      num('billsMonthly', 'New bills per month', '₹', '') +
      num('billsStart', 'New bills start in week', '', 'Week 1 is this week. Before this, your open bills cover it.') +
      num('gstMonthly', 'GST paid on the 20th, per month', '₹', '') + '</div>',
    foot:'<button class="mg-btn" type="button" data-fc-reset>Reset to my figures</button><button class="mg-btn primary" type="button" data-drawer-close>Done</button>',
    onInput:el => {
      const k = el.dataset.fc; if(!k) return;
      mgFcSave({ [k]:el.type === 'checkbox' ? el.checked : el.value });
      if(k === 'mode'){ const m = document.querySelector('[data-fc-manual]'); if(m) m.hidden = el.value !== 'manual'; mgFcRerender(); return; }
      const v = document.querySelector('[data-fcv="' + k + '"]'); if(v) v.textContent = fmtINR(Number(el.value) || 0, 'tile');
      mgFcRerender();
    }
  });
}
document.addEventListener('click', e => {
  if(e.target.closest('[data-fc-adjust]')){ mgForecastEditor(); return; }
  if(e.target.closest('[data-fc-how]')){
    if(mgCurrentView !== 'cash' && typeof mgGo === 'function') mgGo('cash');
    setTimeout(() => { const el = document.getElementById('mgFcHow'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }, 80);
    return;
  }
  if(e.target.closest('[data-fc-reset]')){ mgFcReset(); mgCloseDrawer(); mgFcRerender(); mgForecastEditor(); }
});
