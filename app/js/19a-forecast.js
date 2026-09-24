/* ============================================================
   13-WEEK CASH FORECAST — a feature the customer steers.

   Deterministic arithmetic on the customer's own figures; the AI never
   touches it. Every assumption is visible, starts from the customer's own
   data, and can be changed or switched off (Home → Adjust).

   Week 1 starts today. Closing cash for each week =
     opening cash (latest snapshot)
   + open receivables, each on its due date + collection delay
     (items overdue by more than the doubtful threshold are left out)
   + new sales collected per month, from the week the customer sets
   − open bills, each on its due date + payment delay (overdue: this week)
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
   ============================================================ */
const MG_FC_WEEKS = 13;
const MG_WEEKLY = 12 / 52;   // monthly amount -> per week

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
  return {
    cash:Number(s.cash) || 0, asOf:s.created_at,
    defaults:{
      enabled:true, collectDelay:15, doubtfulAfter:90, payDelay:0,
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
  Object.keys(out).forEach(k => { if(saved[k] !== undefined && saved[k] !== null && saved[k] !== '') out[k] = typeof out[k] === 'boolean' ? !!saved[k] : Number(saved[k]); });
  return out;
}
function mgFcSave(patch){
  mgPrefSet('forecast', Object.assign({}, mgPrefGet('forecast', {}), patch));
}
function mgFcReset(){ mgPrefSet('forecast', null); }

function mgForecast(){
  const d = mgFcData(); if(!d) return null;
  const st = mgFcSettings();
  const inflow = new Array(MG_FC_WEEKS).fill(0), outflow = new Array(MG_FC_WEEKS).fill(0);
  let doubtful = 0, beyond = 0;
  const weekOf = days => Math.floor(Math.max(0, days) / 7);
  mgMoneyGroups('recv').forEach(g => g.by[g.primary].rows.forEach(r => {
    const due = r.days === null ? 0 : r.days;
    if(due < 0 && -due > st.doubtfulAfter){ doubtful += r.amount; return; }
    const w = weekOf(Math.max(0, due) + st.collectDelay);
    if(w >= MG_FC_WEEKS){ beyond += r.amount; return; }
    inflow[w] += r.amount;
  }));
  mgMoneyGroups('pay').forEach(g => g.by[g.primary].rows.forEach(r => {
    const due = r.days === null ? 0 : r.days;
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
  return { opening:d.cash, close, inflow, outflow, min, minWeek, firstBelow, floor:st.floor, doubtful, beyond, st, origin:d.origin };
}

/* ---------- Home panel ---------- */
function mgForecastChart(f, wide){
  const W = wide ? 1100 : 640, H = wide ? 230 : 210, padL = 56, padR = 16, padB = 24, padT = 12;
  const vals = [f.opening, ...f.close, f.floor];
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
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="13-week cash forecast">' + ax +
    '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + fy + '" y2="' + fy + '" stroke="#B3432E" stroke-dasharray="4 4"/>' +
    '<path d="' + d + 'L' + x(MG_FC_WEEKS) + ',' + y(lo) + 'L' + x(0) + ',' + y(lo) + 'Z" fill="#0E8F5C" opacity=".08"/>' +
    '<path d="' + d + '" fill="none" stroke="#0E8F5C" stroke-width="2"/>' +
    '<circle cx="' + minX + '" cy="' + minY + '" r="3.5" fill="' + (f.min < f.floor ? '#B3432E' : '#0E8F5C') + '"/></svg>';
}
function mgForecastSentence(f){
  const st = f.st, bits = [];
  bits.push('customers pay ' + st.collectDelay + ' days after the due date');
  if(f.doubtful) bits.push(fmtINR(f.doubtful, 'tile') + ' overdue more than ' + st.doubtfulAfter + ' days is left out');
  bits.push(st.payDelay ? 'bills are paid ' + st.payDelay + ' days after due' : 'bills are paid on their due date');
  if(st.salesMonthly) bits.push(fmtINR(st.salesMonthly, 'tile') + ' of new sales a month from week ' + st.salesStart);
  if(st.gstMonthly) bits.push('GST of ' + fmtINR(st.gstMonthly, 'tile') + ' on the 20th');
  return 'Assumes ' + bits.join(', ') + '.';
}
function mgForecastPanel(wide){
  const f = mgForecast(); if(!f) return '';
  if(!f.st.enabled) return null;   // customer switched it off: Home shows cash history instead
  const warn = f.firstBelow >= 0;
  return '<div class="mg-panel"><div class="mg-panel-h"><h2>13-week cash forecast</h2>' +
    '<span class="mg-aside">Opening ' + escapeHtml(fmtINR(f.opening, 'tile')) + ' · floor ' + escapeHtml(fmtINR(f.floor, 'tile')) + '</span>' +
    '<button class="mg-btn mg-btn-sm" type="button" data-fc-adjust>Adjust</button></div><div class="mg-panel-b">' +
    '<div class="mg-fc-callout' + (warn ? ' warn' : '') + '">' + (warn
      ? 'Cash falls below your floor in week ' + (f.firstBelow + 1) + '. Lowest point ' + escapeHtml(fmtINR(f.min, 'tile')) + ' in week ' + (f.minWeek + 1) + '.'
      : 'Stays above your floor for 13 weeks. Lowest point ' + escapeHtml(fmtINR(f.min, 'tile')) + ' in week ' + (f.minWeek + 1) + '.') + '</div>' +
    mgForecastChart(f, wide) +
    '<div class="mg-fine">' + escapeHtml(mgForecastSentence(f)) + ' <button class="mg-link" type="button" data-fc-adjust>Change the assumptions</button></div></div></div>';
}
/* Week-by-week table (Cash page, CFO pack). Week 1 starts today. */
function mgForecastWeeks(f){
  const today = new Date(new Date().toDateString());
  const d = n => new Date(today.getTime() + n * 86400000).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  return f.close.map((c, w) => ({ n:w + 1, from:d(w * 7), to:d(w * 7 + 6), inflow:f.inflow[w], outflow:f.outflow[w], close:c, below:c < f.floor }));
}
function mgForecastTable(f){
  return '<div class="mg-gridwrap"><table class="mg-grid" id="mgFcTable"><thead><tr><th>Week</th><th>Dates</th><th class="r">Coming in (₹)</th><th class="r">Going out (₹)</th><th class="r">Closing cash (₹)</th><th></th></tr></thead><tbody>' +
    mgForecastWeeks(f).map(r => '<tr><td>W' + r.n + '</td><td class="mg-muted">' + escapeHtml(r.from + ' – ' + r.to) + '</td><td class="r">' + mgNum(r.inflow) + '</td><td class="r">' + mgNum(r.outflow) + '</td>' +
      '<td class="r' + (r.below ? ' mg-diff' : '') + '">' + mgNum(r.close) + '</td><td>' + (r.below ? '<span class="mg-bdg neg">Below floor</span>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>';
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
  mgDrawer({
    title:'Forecast assumptions',
    sub:'Change any of these and the forecast updates. ' + mgPrefWhere(),
    body:
      '<label class="mg-switch"><input type="checkbox" data-fc="enabled"' + (st.enabled ? ' checked' : '') + '> <span>Show the forecast</span></label>' +
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
      num('gstMonthly', 'GST paid on the 20th, per month', '₹', '') +
      '<h4>Alert</h4>' +
      num('floor', 'Warn me if cash falls below', '₹', ''),
    foot:'<button class="mg-btn" type="button" data-fc-reset>Reset to my figures</button><button class="mg-btn primary" type="button" data-drawer-close>Done</button>',
    onInput:el => {
      const k = el.dataset.fc; if(!k) return;
      mgFcSave({ [k]:el.type === 'checkbox' ? el.checked : el.value });
      const v = document.querySelector('[data-fcv="' + k + '"]'); if(v) v.textContent = fmtINR(Number(el.value) || 0, 'tile');
      mgFcRerender();
    }
  });
}
document.addEventListener('click', e => {
  if(e.target.closest('[data-fc-adjust]')){ mgForecastEditor(); return; }
  if(e.target.closest('[data-fc-reset]')){ mgFcReset(); mgCloseDrawer(); mgFcRerender(); mgForecastEditor(); }
});
