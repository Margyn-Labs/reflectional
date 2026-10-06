/* ============================================================
   CASH FLOW (2026-10-06): the cash flow statement, and how every
   overdraft and loan moved this year.

   Both come with GET /api/tally?action=analytics (mgMar, 19i-margin.js),
   worked out server side in api/_lib/cashFlowStatement.js from every
   entry in the books, so this page, Margyn (cash_flow_statement and
   borrowing_history tools) and voice quote the same numbers.

   - Cash flow page: month by month for the financial year, the owner
     view (what the money was for) or the accountant view (indirect
     method, AS-3), a bridge from opening to closing cash, and the
     checks that it ties to the books.
   - Cash page, "Overdraft and loans this year": each account's balance
     at the end of every day, peak, average, days used, interest and the
     yearly cost, EMIs entered ahead, and use of the limit once the owner
     enters it (saved on the account: preferences.borrow_limits).
   ============================================================ */
let mgCfView = 'owner';   // 'owner' | 'accountant'

function mgCfData(){ return (typeof mgMar !== 'undefined' && mgMar && !mgMarCompany && mgMar.cash_flow) || null; }
function mgBorrowData(){ return (typeof mgMar !== 'undefined' && mgMar && !mgMarCompany && mgMar.borrowing) || null; }
function mgCfMonthShort(c){ return c.key === 'total' ? c.label : c.label.slice(0, 3) + (c.partial ? ' (so far)' : ''); }
function mgCfSigned(n){ const v = Math.round(Number(n) || 0); return v === 0 ? '—' : (v < 0 ? '−' : '') + fmtINR(Math.abs(v)).replace('₹', ''); }

/* Opening → operating → investing → financing → closing, for one column. */
function mgCfBridge(col){
  const secs = col.owner.map(s => ({ label:s.label, v:s.total }));
  const steps = [{ label:'Cash at the start', v:col.opening, base:true }].concat(secs).concat([{ label:'Cash at the end', v:col.closing, base:true }]);
  let run = 0;
  const bars = steps.map(s => { const from = s.base ? 0 : run, to = s.base ? s.v : run + s.v; if(!s.base) run = to; else run = s.v; return Object.assign({ from, to }, s); });
  const lo = Math.min(0, ...bars.map(b => Math.min(b.from, b.to))), hi = Math.max(0, ...bars.map(b => Math.max(b.from, b.to))) || 1;
  const W = 640, H = 210, padT = 22, padB = 40, padL = 8, padR = 8, n = bars.length, slot = (W - padL - padR) / n, bw = Math.min(70, slot * 0.6);
  const y = v => padT + (hi - v) / (hi - lo || 1) * (H - padT - padB);
  let out = '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" stroke="#D2CEC5"/>';
  bars.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2, top = y(Math.max(b.from, b.to)), h = Math.max(1.5, Math.abs(y(b.from) - y(b.to)));
    const fill = b.base ? (b.v < 0 ? '#B3432E' : '#14181F') : (b.v < 0 ? '#B3432E' : '#0E8F5C');
    out += '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + fill + '"' + (b.base ? ' opacity="0.85"' : '') + '><title>' + escapeHtml(b.label + ': ' + fmtINR(b.v)) + '</title></rect>';
    out += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (top - 6).toFixed(1) + '" text-anchor="middle" class="mg-ax mg-ax-v">' + escapeHtml((b.base ? '' : b.v > 0 ? '+' : '') + fmtINR(b.v, 'tile')) + '</text>';
    const words = b.label.split(' '), mid = Math.ceil(words.length / 2);
    out += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 22) + '" text-anchor="middle" class="mg-ax">' + escapeHtml(words.slice(0, mid).join(' ')) + '</text>' +
      '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle" class="mg-ax">' + escapeHtml(words.slice(mid).join(' ')) + '</text>';
    if(i < n - 1){ const nx = padL + (i + 1) * slot + (slot - bw) / 2; out += '<line x1="' + (x + bw).toFixed(1) + '" x2="' + nx.toFixed(1) + '" y1="' + y(b.to).toFixed(1) + '" y2="' + y(b.to).toFixed(1) + '" stroke="#A9AEB7" stroke-dasharray="2 3"/>'; }
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Cash at the start, what each part of the business added or used, and cash at the end">' + out + '</svg>';
}

function mgCfTable(d){
  const cols = d.columns.concat(d.total ? [d.total] : []);
  const view = mgCfView === 'accountant' ? 'accountant' : 'owner';
  // Every line that has money in any column, in the statement's order.
  const sections = cols[cols.length - 1][view].map(s => s.key);
  // The statement's own line order; a line with nothing in any month is left out.
  const defs = sections.map(k => {
    const last = cols[cols.length - 1][view].find(s => s.key === k);
    const keys = last.lines.filter(l => l.key === 'net_profit' || l.key === 'customers' || cols.some(c => { const s = c[view].find(x => x.key === k); const y = s && s.lines.find(z => z.key === l.key); return y && y.amount; })).map(l => ({ key:l.key, label:l.label }));
    return { key:k, label:last.label, lines:keys };
  });
  const cell = (n, cls) => '<td class="r' + (cls ? ' ' + cls : '') + (Number(n) < 0 ? ' mg-cf-neg' : '') + '">' + mgCfSigned(n) + '</td>';
  const val = (c, sk, lk) => { const s = c[view].find(x => x.key === sk); const l = s && s.lines.find(x => x.key === lk); return l ? l.amount : 0; };
  const sec = (c, sk) => { const s = c[view].find(x => x.key === sk); return s ? s.total : 0; };
  let body = '';
  defs.forEach(s => {
    body += '<tr class="mg-cf-sec"><td colspan="' + (cols.length + 1) + '">' + escapeHtml(s.label) + '</td></tr>';
    s.lines.forEach(l => { body += '<tr' + (l.key === 'unsorted' || l.key === 'suspense' ? ' class="mg-cf-warn"' : '') + '><td class="mg-cf-l">' + escapeHtml(l.label) + '</td>' + cols.map(c => cell(val(c, s.key, l.key), c.key === 'total' ? 'mg-cf-totcol' : '')).join('') + '</tr>'; });
    body += '<tr class="mg-cf-sub"><td>Net ' + escapeHtml(s.label.charAt(0).toLowerCase() + s.label.slice(1)) + '</td>' + cols.map(c => cell(sec(c, s.key), c.key === 'total' ? 'mg-cf-totcol' : '')).join('') + '</tr>';
  });
  body += '<tr class="mg-cf-net"><td>Net change in cash</td>' + cols.map(c => cell(c.change, c.key === 'total' ? 'mg-cf-totcol' : '')).join('') + '</tr>';
  body += '<tr><td class="mg-cf-l">Cash at the start</td>' + cols.map(c => cell(c.opening, c.key === 'total' ? 'mg-cf-totcol' : '')).join('') + '</tr>';
  body += '<tr class="mg-cf-sub"><td>Cash at the end</td>' + cols.map(c => cell(c.closing, c.key === 'total' ? 'mg-cf-totcol' : '')).join('') + '</tr>';
  if(d.overdraft_as_cash) body += '<tr class="mg-cf-made"><td class="mg-cf-l">of which bank and cash</td>' + cols.map(c => cell(c.made_up_of ? c.made_up_of.bank_and_cash : null)).join('') + '</tr>' +
    '<tr class="mg-cf-made"><td class="mg-cf-l">less overdraft owed</td>' + cols.map(c => cell(c.made_up_of ? -c.made_up_of.overdraft_owed : null)).join('') + '</tr>';
  const head = '<tr><th>₹</th>' + cols.map(c => '<th class="r' + (c.key === 'total' ? ' mg-cf-totcol' : '') + '">' + escapeHtml(mgCfMonthShort(c)) + '</th>').join('') + '</tr>';
  return '<div class="mg-gridwrap mg-cf-wrap"><table class="mg-grid mg-cf" id="mgCfTable"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function mgCfCsv(d){
  const cols = d.columns.concat(d.total ? [d.total] : []);
  const rows = [];
  ['owner', 'accountant'].forEach(view => {
    rows.push([view === 'owner' ? 'OWNER VIEW (what the money was for)' : 'ACCOUNTANT VIEW (indirect method)']);
    cols[cols.length - 1][view].forEach(s => {
      const keys = s.lines.filter(l => cols.some(c => { const x = c[view].find(z => z.key === s.key); const y = x && x.lines.find(z => z.key === l.key); return y && y.amount; }));
      rows.push([s.label]);
      keys.forEach(l => rows.push(['  ' + l.label].concat(cols.map(c => { const x = c[view].find(z => z.key === s.key); const y = x && x.lines.find(z => z.key === l.key); return y ? y.amount : 0; }))));
      rows.push(['Net ' + s.label].concat(cols.map(c => { const x = c[view].find(z => z.key === s.key); return x ? x.total : 0; })));
    });
    rows.push(['Net change in cash'].concat(cols.map(c => c.change)));
    rows.push(['Cash at the start'].concat(cols.map(c => c.opening)));
    rows.push(['Cash at the end'].concat(cols.map(c => c.closing)));
    rows.push([]);
  });
  return [['Cash flow statement'].concat(cols.map(c => c.key === 'total' ? c.label : c.label + (c.partial ? ' (so far)' : ''))), rows];
}

function mgCfChecks(d){
  const k = d.checks || {}, t = d.total;
  const items = [];
  items.push(k.ties
    ? '<li><span class="mg-bdg pos">Ties</span> Cash at the start ' + escapeHtml(fmtINR(t.opening)) + ' + the year’s flows ' + escapeHtml(fmtINR(t.owner_net)) + ' = cash today ' + escapeHtml(fmtINR(t.closing)) + '.</li>'
    : '<li><span class="mg-bdg neg">Gap ' + escapeHtml(fmtINR(k.unexplained)) + '</span> ' + escapeHtml((k.unbalanced_entries || 0) + ' entries in your books don’t balance (debits and credits differ), so the lines don’t add up to the change in cash by that much.') + '</li>');
  const ob = k.opening_balances || { checked:0, gaps:[] };
  if(ob.checked) items.push(ob.gaps.length
    ? '<li><span class="mg-bdg warn">Check</span> ' + escapeHtml(ob.gaps.map(g => g.ledger + ' is ' + fmtINR(Math.abs(g.gap)) + ' off').join('; ') + ' when walked back to the opening balance ' + mgBooksName() + ' has for it. Some entries are probably missing from the sync.') + '</li>'
    : '<li><span class="mg-bdg pos">Complete</span> ' + escapeHtml('All ' + ob.checked + ' cash and overdraft ledgers walk back exactly to the opening balance ' + mgBooksName() + ' has for them, so no entries are missing.') + '</li>');
  if(Math.abs(k.views_differ_by || 0) >= 1) items.push('<li><span class="mg-bdg">Note</span> ' + escapeHtml('The two views differ by ' + fmtINR(k.views_differ_by) + ': entries that don’t move cash but don’t balance either.') + '</li>');
  return '<ul class="mg-cf-checks">' + items.join('') + '</ul>';
}

function mgRenderCashFlow(){
  const host = document.getElementById('view-cashflow'); if(!host) return;
  if(typeof mgMar !== 'undefined' && !mgMar && !mgMarBusy && !mgMarErr && typeof mgLoadMargin === 'function' && mgBooksConnected()) mgLoadMargin();
  const d = mgCfData();
  const seg = '<div class="mg-seg" role="tablist" aria-label="View">' +
    '<button type="button" data-cf-view="owner" class="' + (mgCfView === 'owner' ? 'on' : '') + '">Owner view</button>' +
    '<button type="button" data-cf-view="accountant" class="' + (mgCfView === 'accountant' ? 'on' : '') + '">Accountant view</button></div>';
  const head = mgPageHead({ group:'Insight', title:'Cash flow',
    sub:'Where your cash came from and where it went, month by month, from every entry in your books.',
    actions:(d ? seg + ' ' + mgExportBtn('cfExport') : '') + mgBtn('Refresh', 'data-cf-refresh') });
  if(!d){
    const loading = typeof mgMarBusy !== 'undefined' && mgMarBusy;
    const off = !mgBooksConnected() || (mgMar && !mgMar.connected);
    host.innerHTML = head + '<div class="mg-panel mg-empty-panel"><h2>' + (off ? 'Connect your books to see your cash flow' : loading || !mgMar ? 'Reading your books…' : mgMarErr ? 'Couldn’t load your books' : 'No cash flow yet') + '</h2>' +
      '<p>' + (off ? 'The statement is built from every entry in Tally, Zoho Books or Odoo.' : mgMarCompany ? 'Switch Margin back to your main company to see its cash flow.' : loading || !mgMar ? 'This takes a few seconds.' : 'Margyn couldn’t find entries on your bank, cash or overdraft accounts yet.') + '</p>' +
      (off ? '<div style="margin-top:12px">' + mgBtn('Open sources', 'data-go-page="connectors"', true) + '</div>' : '') + '</div>';
    return;
  }
  const t = d.total;
  const sec = k => (t.owner.find(s => s.key === k) || { total:0 }).total;
  const profit = (t.accountant.find(s => s.key === 'operating').lines.find(l => l.key === 'net_profit') || { amount:0 }).amount;
  const op = sec('operating');
  const tiles = '<div class="mg-tiles four">' +
    mgTile({ label:'Cash from running the business', value:fmtINR(op, 'tile'), full:fmtINR(op), note:'Profit in the books ' + fmtINR(profit, 'tile'), src:t.label + ' · from your books', go:'cashflow' }) +
    mgTile({ label:'Spent on assets and investments', value:fmtINR(sec('investing'), 'tile'), full:fmtINR(sec('investing')), note:'Equipment, vehicles, deposits', src:t.label, go:'cashflow' }) +
    mgTile({ label:'From loans and the owner', value:fmtINR(sec('financing'), 'tile'), full:fmtINR(sec('financing')), note:d.overdraft_as_cash ? 'Overdraft counted as cash' : 'Including the overdraft', src:t.label, go:'cashflow' }) +
    mgTile({ label:'Cash now', value:fmtINR(t.closing, 'tile'), full:fmtINR(t.closing), note:(t.change >= 0 ? '▲ ' : '▼ ') + fmtINR(Math.abs(t.change), 'tile') + ' since ' + mgFcDay(t.from), src:d.overdraft_as_cash ? 'Bank and cash less overdraft' : 'Bank and cash', go:'cash' }) + '</div>';
  // Profit vs cash in one sentence: the question this page exists to answer.
  const gap = op - profit;
  const why = Math.abs(gap) >= 1 ? '<div class="mg-panel-b mg-cf-why">' + escapeHtml(
    'The books show ' + fmtINR(profit, 'tile') + ' profit ' + t.label.toLowerCase() + ', and running the business ' + (op >= 0 ? 'brought in ' : 'used ') + fmtINR(Math.abs(op), 'tile') + ' of cash. ' +
    (gap < 0 ? 'The ' + fmtINR(-gap, 'tile') + ' difference is mostly money still owed to you, stock and taxes; switch to the Accountant view to see each.' : 'Cash ran ' + fmtINR(gap, 'tile') + ' ahead of profit: customers paid down older balances or you paid suppliers later; the Accountant view shows which.')) + '</div>' : '';
  const notes = (d.notes || []).map(n => '<li>' + escapeHtml(n) + '</li>').join('');
  const uns = (d.unsorted || []).length ? '<div class="mg-panel"><div class="mg-panel-h"><h2>Not yet sorted</h2><span class="mg-aside">Ledgers Margyn can’t place in the statement yet</span></div>' +
    '<div class="mg-gridwrap"><table class="mg-grid"><thead><tr><th>Ledger</th><th class="r">Entries</th><th class="r">Cash effect (₹)</th></tr></thead><tbody>' +
    d.unsorted.map(u => '<tr><td>' + escapeHtml(u.ledger) + '</td><td class="r">' + u.entries + '</td><td class="r">' + mgCfSigned(u.amount) + '</td></tr>').join('') + '</tbody></table></div>' +
    '<div class="mg-foot-note">Put these under a proper group in ' + escapeHtml(mgBooksName()) + ' (a loan, an asset, an expense) and they move to the right line on the next sync.</div></div>' : '';
  host.__csv = mgCfCsv(d);
  host.innerHTML = head + tiles +
    '<div class="mg-panel"><div class="mg-panel-h"><h2>From the start of the year to today</h2><span class="mg-aside">' + escapeHtml(mgFcDay(t.from) + ' to ' + mgFcDay(t.to)) + '</span></div>' +
      why + '<div class="mg-panel-b">' + mgCfBridge(t) + '</div></div>' +
    '<div class="mg-panel"><div class="mg-panel-h"><h2>' + (mgCfView === 'accountant' ? 'Cash flow statement (indirect method)' : 'Where the cash came from and went') + '</h2><span class="mg-aside">' +
      (mgCfView === 'accountant' ? 'Net profit adjusted for what isn’t cash, as in AS-3 / Ind AS 7' : 'Every entry that moved cash, by what it was for') + '</span></div>' +
      mgCfTable(d) + '<div class="mg-foot-note">Money in is positive, money out is negative. ' + (d.overdraft_as_cash ? 'Cash includes the overdraft (' + escapeHtml(d.overdraft_ledgers.join(', ')) + ') as negative cash.' : '') + '</div></div>' +
    '<div class="mg-panel"><div class="mg-panel-h"><h2>Does it add up?</h2><span class="mg-aside">Checked against your books every time</span></div><div class="mg-panel-b">' + mgCfChecks(d) +
      (notes ? '<ul class="mg-fine">' + notes + '</ul>' : '') + '</div></div>' + uns +
    (mgBorrowData() && mgBorrowData().accounts.length ? '<div class="mg-panel"><div class="mg-panel-h"><h2>Overdraft and loans</h2><span class="mg-aside">How each one moved this year</span>' + mgBtn('Open on Cash', 'data-cf-borrow') + '</div>' +
      mgBorrowData().accounts.slice(0, 4).map(a => '<div class="mg-li"><div><div class="mg-li-t">' + escapeHtml(a.name) + '</div><div class="mg-li-s">' + escapeHtml(mgBorrowLine(a)) + '</div></div><div class="mg-li-a">' + escapeHtml(fmtINR(a.owed_today, 'tile')) + '</div></div>').join('') + '</div>' : '');
}
MG_OWN_RENDER.cashflow = mgRenderCashFlow;

/* ---------- Overdraft and loans this year (Cash page) ---------- */
function mgBorrowLimits(){ const v = typeof mgPrefGet === 'function' ? mgPrefGet('borrow_limits', {}) : {}; return v && typeof v === 'object' ? v : {}; }
function mgBorrowLimitOf(a){ const v = Number(mgBorrowLimits()[a.name]); return v > 0 ? v : null; }
function mgBorrowLine(a){
  const ch = a.change_30d, lim = mgBorrowLimitOf(a);
  return (Math.abs(ch) < 1 ? 'No change in 30 days' : (ch > 0 ? 'Up ' : 'Down ') + fmtINR(Math.abs(ch), 'tile') + ' in 30 days') +
    ' · peak ' + fmtINR(a.peak.owed, 'tile') + ' on ' + mgFcDay(a.peak.date) +
    (lim ? ' · ' + Math.round(a.owed_today / lim * 100) + '% of the limit' : '') +
    (a.kind === 'loan' && a.trend ? ' · ' + ({ reducing:'reducing', growing:'growing', flat:'not reducing' }[a.trend]) : '');
}
function mgOwedChart(a, limit){
  const pts = a.series.owed;
  if(!pts || pts.length < 2) return '';
  const W = 640, H = 150, padL = 8, padR = 8, padT = 14, padB = 20;
  const hi = Math.max(1, limit || 0, ...pts) * 1.05, lo = Math.min(0, ...pts);
  const x = i => padL + i * (W - padL - padR) / (pts.length - 1);
  const y = v => padT + (hi - v) / (hi - lo || 1) * (H - padT - padB);
  const t0 = Date.parse(a.series.start + 'T00:00:00Z');
  const day = i => new Date(t0 + i * 86400000).toISOString().slice(0, 10);
  const line = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  const area = line + 'L' + x(pts.length - 1).toFixed(1) + ',' + y(Math.max(0, lo)).toFixed(1) + 'L' + x(0).toFixed(1) + ',' + y(Math.max(0, lo)).toFixed(1) + 'Z';
  let ticks = '';
  for(let i = 0; i < pts.length; i++){ const k = day(i); if(k.slice(8) === '01') ticks += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + (H - padB) + '" y2="' + (H - padB + 4) + '" stroke="#D2CEC5"/><text x="' + x(i).toFixed(1) + '" y="' + (H - 5) + '" class="mg-ax" text-anchor="' + (x(i) < 24 ? 'start' : x(i) > W - 24 ? 'end' : 'middle') + '">' + escapeHtml(MONTHS_SHORT_CF[Number(k.slice(5, 7)) - 1]) + '</text>'; }
  const pk = pts.indexOf(Math.max(...pts));
  const step = Math.max(1, Math.floor(pts.length / 60));
  const tips = pts.map((v, i) => i % step && i !== pts.length - 1 ? '' : '<rect x="' + (x(i) - (W / pts.length) * step / 2).toFixed(1) + '" y="' + padT + '" width="' + ((W / pts.length) * step).toFixed(1) + '" height="' + (H - padT - padB) + '" fill="transparent"><title>' + escapeHtml(mgFcDay(day(i)) + ': ' + fmtINR(v) + ' owed') + '</title></rect>').join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + escapeHtml(a.name + ', amount owed at the end of each day') + '">' +
    '<path d="' + area + '" fill="#0E8F5C" opacity="0.08"/><path d="' + line + '" fill="none" stroke="#0E8F5C" stroke-width="1.75"/>' +
    (limit ? '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(limit).toFixed(1) + '" y2="' + y(limit).toFixed(1) + '" stroke="#B3432E" stroke-dasharray="4 4"/><text x="' + (W - padR) + '" y="' + (y(limit) - 4).toFixed(1) + '" class="mg-ax" text-anchor="end">Limit ' + escapeHtml(fmtINR(limit, 'tile')) + '</text>' : '') +
    '<circle cx="' + x(pk).toFixed(1) + '" cy="' + y(pts[pk]).toFixed(1) + '" r="3" fill="#14181F"><title>' + escapeHtml('Peak ' + fmtINR(pts[pk]) + ' on ' + mgFcDay(day(pk))) + '</title></circle>' +
    '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(pts[pts.length - 1]).toFixed(1) + '" r="3.5" fill="#0E8F5C"/>' + ticks + tips + '</svg>';
}
const MONTHS_SHORT_CF = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function mgBorrowAccount(a){
  const lim = mgBorrowLimitOf(a);
  const stat = (k, v, s) => '<div class="mg-bw-stat"><div class="mg-bw-k">' + escapeHtml(k) + '</div><div class="mg-bw-v">' + escapeHtml(v) + '</div>' + (s ? '<div class="mg-bw-s">' + escapeHtml(s) + '</div>' : '') + '</div>';
  const ch = a.change_30d;
  const stats = [
    stat('Owed today', fmtINR(a.owed_today, 'tile'), Math.abs(ch) < 1 ? 'Same as 30 days ago' : (ch > 0 ? '▲ ' : '▼ ') + fmtINR(Math.abs(ch), 'tile') + ' in 30 days'),
    stat('Peak this year', fmtINR(a.peak.owed, 'tile'), mgFcDay(a.peak.date)),
    stat('Average', fmtINR(a.average, 'tile'), a.kind === 'overdraft' ? 'Used on ' + a.days_used + ' of ' + a.days + ' days' : 'Lowest ' + fmtINR(a.low.owed, 'tile')),
    lim ? stat('Limit used', Math.round(a.owed_today / lim * 100) + '%', fmtINR(Math.max(0, lim - a.owed_today), 'tile') + ' left · peak ' + Math.round(a.peak.owed / lim * 100) + '%')
      : a.kind === 'overdraft' ? '<div class="mg-bw-stat"><div class="mg-bw-k">Limit</div><button class="mg-btn mg-btn-sm" type="button" data-bw-limit="' + escapeHtml(a.name) + '">Enter your limit</button><div class="mg-bw-s">So Margyn can show what’s left</div></div>'
      : stat('Trend', { reducing:'Reducing', growing:'Growing', flat:'Not reducing' }[a.trend] || '—', (a.change_90d < 0 ? '▼ ' : a.change_90d > 0 ? '▲ ' : '') + fmtINR(Math.abs(a.change_90d), 'tile') + ' in 90 days'),
    a.interest_charged ? stat('Interest charged to it', fmtINR(a.interest_charged, 'tile'), a.interest_rate_pct != null ? 'About ' + a.interest_rate_pct + '% a year on the average owed' : '') : null
  ].filter(Boolean).join('');
  const months = a.month_end.map(m => '<td class="r">' + mgNum(m.owed) + '</td>').join('');
  const up = a.months_up_in_a_row >= 2 ? '<div class="mg-bw-alert">Higher at the end of each of the last ' + a.months_up_in_a_row + ' months.</div>' : '';
  const ahead = (a.upcoming || []).length ? '<div class="mg-fine">Already entered for later dates: ' + escapeHtml(a.upcoming.slice(0, 6).map(u => mgFcDay(u.date) + ' ' + fmtINR(u.amount, 'tile')).join(' · ')) + '. Taken off on their dates.</div>' : '';
  return '<div class="mg-bw" data-bw="' + escapeHtml(a.name) + '"><div class="mg-bw-h"><b>' + escapeHtml(a.name) + '</b><span class="mg-bdg">' + (a.kind === 'overdraft' ? 'Overdraft / cash credit' : 'Loan') + '</span>' +
    (lim ? '<button class="mg-linkbtn" type="button" data-bw-limit="' + escapeHtml(a.name) + '">Limit ' + escapeHtml(fmtINR(lim, 'tile')) + ' · change</button>' : '') + '</div>' +
    '<div class="mg-bw-stats">' + stats + '</div>' + up + mgOwedChart(a, lim) +
    '<div class="mg-gridwrap"><table class="mg-grid mg-bw-months"><thead><tr><th>Owed at month end (₹)</th>' + a.month_end.map(m => '<th class="r">' + escapeHtml(MONTHS_SHORT_CF[Number(m.month.slice(5, 7)) - 1] + (m.partial ? ' (today)' : '')) + '</th>').join('') + '</tr></thead><tbody><tr><td class="mg-muted">' +
      escapeHtml(a.kind === 'overdraft' ? 'Paid out ' + fmtINR(a.paid_out, 'tile') + ', paid in ' + fmtINR(a.paid_in, 'tile') : 'Drawn ' + fmtINR(a.paid_out, 'tile') + ', repaid ' + fmtINR(a.paid_in, 'tile')) + '</td>' + months + '</tr></tbody></table></div>' + ahead + '</div>';
}
function mgBorrowPanel(){
  const b = mgBorrowData();
  if(!b || !b.accounts.length) return '';
  const T = b.total;
  const lims = b.accounts.map(mgBorrowLimitOf), allLim = lims.every(Boolean) ? lims.reduce((s, v) => s + v, 0) : null;
  const sum = T && b.accounts.length > 1 ? '<div class="mg-panel-b mg-bw-total">All borrowing <b>' + escapeHtml(fmtINR(T.owed_today, 'tile')) + '</b>' +
    ' · ' + escapeHtml((T.change_30d >= 0 ? 'up ' : 'down ') + fmtINR(Math.abs(T.change_30d), 'tile') + ' in 30 days') +
    ' · peak ' + escapeHtml(fmtINR(T.peak.owed, 'tile') + ' on ' + mgFcDay(T.peak.date)) +
    (allLim ? ' · ' + Math.round(T.owed_today / allLim * 100) + '% of your limits' : '') + '</div>' : '';
  const cost = T && T.interest_rate_pct != null ? '<div class="mg-panel-b mg-cf-why">' + escapeHtml('Interest this year ' + fmtINR(T.interest_this_fy, 'tile') + ' on an average ' + fmtINR(T.average, 'tile') + ' borrowed: borrowing costs you about ' + T.interest_rate_pct + '% a year.') + '</div>' : '';
  return '<div class="mg-panel" id="mgBorrowHist"><div class="mg-panel-h"><h2>Overdraft and loans this year</h2><span class="mg-aside">Owed at the end of every day, from every entry on the account</span></div>' +
    sum + cost + b.accounts.map(mgBorrowAccount).join('') +
    '<div class="mg-foot-note">' + escapeHtml((b.notes || []).filter(n => !/limit yet/.test(n) || b.accounts.some(a => a.kind === 'overdraft' && !mgBorrowLimitOf(a))).join(' ')) + '</div></div>';
}
function mgBorrowEditLimit(name){
  const cur = mgBorrowLimits()[name];
  mgDrawer({
    title:'Overdraft limit', sub:name + '. ' + mgPrefWhere(),
    body:'<label class="mg-field"><span class="mg-field-l">Sanctioned limit</span><span class="mg-field-in"><i>₹</i><input type="number" inputmode="numeric" min="0" step="10000" data-bw-input value="' + (cur > 0 ? Number(cur) : '') + '" placeholder="e.g. 5000000"></span>' +
      '<span class="mg-field-h">From your sanction letter or bank statement. Margyn uses it to show how much of the limit you use and how much is left. It doesn’t change your Pulse Score.</span></label>',
    foot:(cur > 0 ? '<button class="mg-btn" type="button" data-bw-clear="' + escapeHtml(name) + '">Remove</button>' : '') + '<button class="mg-btn primary" type="button" data-bw-save="' + escapeHtml(name) + '">Save</button>'
  });
  setTimeout(() => { const i = document.querySelector('[data-bw-input]'); if(i) i.focus(); }, 50);
}
function mgBorrowSetLimit(name, v){
  const all = Object.assign({}, mgBorrowLimits());
  if(v > 0) all[name] = Math.round(v); else delete all[name];
  mgPrefSet('borrow_limits', Object.keys(all).length ? all : null);
  if(typeof mgCloseDrawer === 'function') mgCloseDrawer();
  if(typeof mgRenderOwn === 'function') mgRenderOwn(mgCurrentView);
}

document.addEventListener('click', e => {
  const v = e.target.closest('[data-cf-view]'); if(v){ mgCfView = v.dataset.cfView; mgRenderCashFlow(); return; }
  if(e.target.closest('[data-cf-refresh]')){ mgLoadMargin(true).then(() => mgRenderCashFlow()); return; }
  if(e.target.closest('#cfExport')){ const host = document.getElementById('view-cashflow'); if(host && host.__csv) mgCsv('margyn-cash-flow.csv', host.__csv[0], host.__csv[1]); return; }
  if(e.target.closest('[data-cf-borrow]')){ mgGo('cash'); setTimeout(() => { const el = document.getElementById('mgBorrowHist'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }, 80); return; }
  const l = e.target.closest('[data-bw-limit]'); if(l){ mgBorrowEditLimit(l.dataset.bwLimit); return; }
  const s = e.target.closest('[data-bw-save]'); if(s){ const i = document.querySelector('[data-bw-input]'); mgBorrowSetLimit(s.dataset.bwSave, Number(i && i.value) || 0); return; }
  const c = e.target.closest('[data-bw-clear]'); if(c){ mgBorrowSetLimit(c.dataset.bwClear, 0); return; }
});

/* What Margyn (voice) reads off this page: the same figures as the table. */
function vxCashFlowSummary(){
  const d = mgCfData();
  if(!d) return { loading:true, note:'The cash flow is still loading, or no books are connected. The cash_flow_statement tool reads the books directly.' };
  const t = d.total, f = n => fmtINR(n, 'tile');
  const lines = s => Object.fromEntries(s.lines.filter(l => l.amount).map(l => [l.label, f(l.amount)]));
  return {
    period:t.label + ' (' + t.from + ' to ' + t.to + ')', view_on_screen:mgCfView, cash_at_start:f(t.opening), cash_now:f(t.closing), change:f(t.change),
    overdraft_counted_as_cash:d.overdraft_as_cash,
    owner_view:Object.fromEntries(t.owner.map(s => [s.label, Object.assign({ total:f(s.total) }, lines(s))])),
    accountant_view:Object.fromEntries(t.accountant.map(s => [s.label, Object.assign({ total:f(s.total) }, lines(s))])),
    by_month:d.columns.map(c => ({ month:c.label + (c.partial ? ' (so far)' : ''), operating:f(c.owner[0].total), investing:f(c.owner[1].total), financing:f(c.owner[2].total), closing:f(c.closing) })),
    ties_to_books:!!(d.checks || {}).ties, notes:d.notes
  };
}
