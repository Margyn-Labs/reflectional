/* ============================================================
   MARGIN (2026-09-30): what Tally says about how much you keep.
   Reads GET /api/tally?action=analytics (api/_lib/tallyAnalytics.js), which
   turns the ledgers, vouchers and bills the agent already syncs into P&L by
   month, cost structure, customers after the cost of waiting for payment,
   working capital, a GST estimate and data-quality checks. All maths is
   server side so the page, Margyn and voice quote the same numbers.
   One source (Tally), so everything here is a signal until bank and GST
   corroborate it; the page says so instead of claiming more.
   ============================================================ */
let mgMar = null, mgMarBusy = false, mgMarErr = false, mgMarAt = 0, mgMarCompany = '';
/* Books are kept in Tally, Zoho Books or Odoo: the analytics come from whichever (api/_lib/dataLayer/books.js). */
function mgBooksConnected(){
  try { return !!((typeof tallyConnected !== 'undefined' && tallyConnected) || (typeof zohoConnected !== 'undefined' && zohoConnected) || (typeof odooConnected !== 'undefined' && odooConnected)); } catch(e){ return false; }
}
function mgBooksName(){ return (mgMar && mgMar.books_source_name) || 'Tally'; }

async function mgLoadMargin(force){
  if(mgMarBusy || (!force && mgMar && Date.now() - mgMarAt < 60000)) return;
  // Opened straight on Margin or Cash flow, sign-in isn't set up yet: try again shortly instead of showing "Couldn't load".
  if(typeof sbClient === 'undefined' || !sbClient){ clearTimeout(mgLoadMargin.retry); mgLoadMargin.retry = setTimeout(() => mgLoadMargin(force), 1500); return; }
  mgMarBusy = true;
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    if(!session) return;
    // A full year of a busy company's books takes ~25 s to read (Care Hygiene, 19k vouchers): wait as long as the function may run (60 s).
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 55000);
    // force (Refresh, a ledger just placed): work it out now, not the saved answer.
    const res = await fetch('/api/tally?action=analytics' + (mgMarCompany ? '&company=' + encodeURIComponent(mgMarCompany) : '') + (force ? '&fresh=1' : ''),
      { headers:{ 'Authorization':'Bearer ' + session.access_token }, signal:ctl.signal });
    clearTimeout(timer);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    mgMar = await res.json(); mgMarAt = Date.now(); mgMarErr = false;
    // The last sync's answer, served at once: fetch this sync's straight after and redraw.
    if(mgMar && mgMar.stale) setTimeout(() => mgLoadMargin(true), 0);
    else if(!mgMarCompany && typeof mgBcSaveSoon === 'function') mgBcSaveSoon();
    // Saved readings now carry the books' cash for their day: re-draw the page that shows them.
    const moved = mgApplyCashHistory(typeof snapshots !== 'undefined' ? snapshots : null);
    if(typeof mgRenderOwn === 'function' && typeof mgCurrentView !== 'undefined' && mgCurrentView !== 'margin' && (moved || ['home', 'cash', 'cashflow', 'reports', 'cfopack'].includes(mgCurrentView))) mgRenderOwn(mgCurrentView);
  } catch(e){ mgMarErr = true; console.error('[margyn] margin:', e.message); }
  finally {
    mgMarBusy = false;
    if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'margin') mgRenderMargin();
    // Reports (view 'analytics') opened while the books were still loading said "Reading your books…" for good.
    if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'analytics' && typeof renderAnalyticsView === 'function') renderAnalyticsView();
  }
}

/* The answer for the latest sync (not the last sync's, served while it's worked out). Up to a minute. */
async function mgMarginFresh(){
  for(let i = 0; i < 120 && (mgMarBusy || (mgMar && mgMar.stale)); i++){
    if(!mgMarBusy && mgMar && mgMar.stale) mgLoadMargin(true);
    await new Promise(r => setTimeout(r, 500));
  }
}

/* Cash, day by day, from the books (tallyAnalytics cash_history, 2026-10-04).
   A saved reading keeps the cash it was saved with, and Care Hygiene's 3 Oct readings were saved from
   Tally balances that still had future EMIs in them (₹4.38 L, real ₹13.8 L), so "vs prior" read +215%.
   Readings whose cash came from Tally take the books' end-of-day cash for their India date instead
   (the saved figure stays on the reading as _cash_saved). Other sources are left as saved. */
function mgCashHistoryMap(){
  const h = mgMar && !mgMarCompany && mgMar.cash_history;   // another company's books don't describe this account's readings
  if(!h || !Array.isArray(h.points) || !h.points.length) return null;
  return new Map(h.points.map(p => [p.date, Number(p.cash)]));
}
function mgIstDateKey(iso){ const t = Date.parse(iso); return isNaN(t) ? '' : new Date(t + 5.5 * 3600000).toISOString().slice(0, 10); }
function mgApplyCashHistory(list){
  const by = mgCashHistoryMap();
  if(!by || !Array.isArray(list)) return false;
  let changed = false;
  list.forEach(s => {
    const prov = s && s.input_provenance && s.input_provenance.cash;
    if(!prov || prov.source !== 'tally') return;
    const v = by.get(mgIstDateKey(s.created_at));
    if(v == null || !isFinite(v)) return;
    if(s._cash_saved === undefined) s._cash_saved = s.cash;
    if(Number(s.cash) === v) return;
    s.cash = v; changed = true;
    // Cash feeds three vitals and so the Pulse Score: re-score those from the same reading's other figures,
    // or Runway and Pulse keep the wrong cash's verdict (Care Hygiene's Pulse read 44 → 36 from it).
    if(Array.isArray(s.vitals) && typeof scoreCash === 'function' && typeof computePulseScore === 'function'){
      const burn = Number(s.burn) || 0, recv = Number(s.recv_total) || 0, pay = Number(s.pay_soon) || 0;
      const redo = { 'Cash Position':scoreCash(v, burn), 'Payables Due (30d)':scorePayables(pay, v), 'Working Capital Runway':scoreRunway(v, recv, pay, burn) };
      if(s._vitals_saved === undefined){ s._vitals_saved = s.vitals; s._pulse_saved = s.pulse_score; }
      s.vitals = s.vitals.map(x => redo[x.label] ? Object.assign({}, x, { value:redo[x.label].value, score:redo[x.label].score }) : x);
      if(s.vitals.length === 6) s.pulse_score = computePulseScore(s.vitals);
    }
  });
  return changed;
}
/* The last `days` days of book cash as chart points ({ created_at, cash }), or null without history. */
function mgCashHistorySeries(days){
  const h = mgMar && !mgMarCompany && mgMar.cash_history;
  if(!h || !Array.isArray(h.points) || h.points.length < 2) return null;
  return h.points.slice(-(days || 90)).map(p => ({ created_at:p.date + 'T18:00:00+05:30', cash:Number(p.cash) || 0 }));
}

const MG_MAR_BUCKETS = [
  ['sales','Sales'], ['purchases','Purchases (cost of goods)'], ['direct_expense','Direct expense (freight, wages)'],
  ['direct_income','Direct income'], ['opex','Running cost (opex)'], ['other_income','Other income'],
  ['tax','GST / duties'], ['debtor','Customer account'], ['creditor','Vendor account'], ['bank','Bank'], ['cash','Cash'],
  ['stock','Stock'], ['balance_sheet','Balance sheet item (not in P&L)']
];
const MG_MAR_CONF = {
  'low': ['Low confidence', 'warn'],
  'medium': ['Medium confidence', ''],
  'high-for-a-single-source': ['Good for a single source', '']
};

function mgMarPct(n){ return n == null ? '—' : (Math.round(n * 10) / 10) + '%'; }
function mgMarMonth(k){
  const [y, m] = String(k).split('-');
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(+m || 1) - 1] + ' ' + String(y).slice(2);
}
function mgMarTile(label, value, sub, tone, full){
  return '<div class="mg-tile mg-static"><div class="mg-tile-l">' + escapeHtml(label) + '</div><div class="mg-tile-v"' + (full ? ' title="' + escapeHtml(full) + '"' : '') + '>' + escapeHtml(value) +
    '</div><div class="mg-tile-chg ' + (tone || 'flat') + '">' + escapeHtml(sub || '') + '</div></div>';
}
function mgMarPanel(title, aside, body){
  return '<div class="mg-panel mg-gridwrap"><div class="mg-panel-h"><h2>' + escapeHtml(title) + '</h2>' +
    (aside ? '<span class="mg-aside">' + escapeHtml(aside) + '</span>' : '') + '</div>' + body + '</div>';
}
function mgMarNote(t){ return '<div class="mg-panel-b"><p class="mg-muted">' + escapeHtml(t) + '</p></div>'; }

/* Two books systems connected: one is read everywhere, the other shown beside it, never added (dataLayer/books.js). */
function mgMarComparePanel(d){
  const c = d.books_compare || [];
  if(c.length < 2) return '';
  const p = c[0];
  const rows = c.map((x, i) => '<tr><td>' + escapeHtml(x.source_name) + (i === 0 ? ' <span class="mg-bdg pos">Used everywhere</span>' : '') + '</td><td class="r">' + mgNum(x.receivables) + '</td><td class="r">' + mgNum(x.payables) + '</td>' +
    '<td class="r">' + (i === 0 ? '' : escapeHtml(fmtINR(x.receivables - p.receivables))) + '</td><td>' + (x.last_sync ? escapeHtml(fmtDate(x.last_sync)) : '—') + '</td></tr>').join('');
  return mgMarPanel('Your books in more than one place', 'Compared, never added. Margyn reads the most trusted, most recently synced one everywhere',
    '<table class="mg-grid"><thead><tr><th>Books</th><th class="r">Customers owe (₹)</th><th class="r">You owe (₹)</th><th class="r">Owed vs main (₹)</th><th>Last synced</th></tr></thead><tbody>' + rows + '</tbody></table>');
}

/* What else the books say (api/_lib/booksEngine.js): findings, kits, branches, concentration.
   Arrive with the analytics payload; every figure is worked out on the server. */
function mgMarInsightsPanel(d){
  const list = (d.insights || []).slice(0, 8);
  if(!list.length) return '';
  const rows = list.map(x => '<div class="mg-ins-li"><span class="mg-dot ' + (x.severity === 'high' ? 'neg' : x.severity === 'medium' ? 'warn' : '') + '"></span>' +
    '<div style="min-width:0;flex:1"><div class="mg-li-t">' + escapeHtml(x.title) + '</div>' + (x.detail ? '<div class="mg-li-s">' + escapeHtml(x.detail) + '</div>' : '') +
    (x.action ? '<div class="mg-li-s"><b>Next:</b> ' + escapeHtml(x.action) + '</div>' : '') + '</div>' +
    (x.ask ? '<button type="button" class="mg-btn mg-btn-sm" data-hub-ask="' + escapeHtml(x.ask) + '">Ask Margyn</button>' : '') + '</div>').join('');
  return mgMarPanel('What else your books say', 'Worked out from every Tally entry, biggest first', '<div>' + rows + '</div>');
}
function mgMarKitsPanel(d){
  const k = (d.kits || []).filter(x => x.made_qty > 0);
  if(!k.length) return '';
  const rows = k.slice(0, 15).map(x => '<tr><td>' + escapeHtml(x.item) + '</td><td class="r">' + mgNum(x.made_qty) + '</td><td class="r">' + (x.cost_per_unit == null ? '—' : mgNum(x.cost_per_unit)) + '</td>' +
    '<td class="r">' + mgNum(x.sold_qty) + '</td><td class="r">' + mgNum(x.sales) + '</td><td class="r">' + (x.avg_price == null ? '—' : mgNum(x.avg_price)) + '</td><td class="r">' + mgMarPct(x.margin_pct) + '</td></tr>').join('');
  return mgMarPanel('Kits you put together', 'Cost = the parts in your Manufacturing Journals', '<table class="mg-grid"><thead><tr><th>Kit</th><th class="r">Made</th><th class="r">Cost per kit (₹)</th><th class="r">Sold</th><th class="r">Sales (₹)</th><th class="r">Avg price (₹)</th><th class="r">Margin %</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    mgMarNote('These are never bought, so until now they had no cost and no margin. Margyn now takes their cost from the parts that went into them.'));
}
function mgMarBranchPanel(d){
  const b = d.branches || [];
  if(b.length < 2) return '';
  const months = [...new Set(b.flatMap(x => (x.months || []).map(m => m.month)))].sort().slice(-6);
  const head = '<tr><th>Branch</th><th class="r">Sales this year (₹)</th><th class="r">Share</th><th class="r">Invoices</th><th class="r">Customers</th>' + months.map(m => '<th class="r">' + escapeHtml(mgMarMonth(m)) + '</th>').join('') + '</tr>';
  const rows = b.map(x => '<tr><td>' + escapeHtml(x.branch) + '</td><td class="r">' + mgNum(x.net_sales) + '</td><td class="r">' + mgMarPct(x.share_pct) + '</td><td class="r">' + mgNum(x.invoices) + '</td><td class="r">' + mgNum(x.customers) + '</td>' +
    months.map(m => { const r = (x.months || []).find(y => y.month === m); return '<td class="r">' + (r ? mgNum(r.net_sales) : '—') + '</td>'; }).join('') + '</tr>').join('');
  return mgMarPanel('Sales by branch', 'Sales invoices, from how your sales voucher types are named in Tally. Returns aren’t split by branch', '<table class="mg-grid"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>');
}
function mgMarConcentration(d){
  const c = d.concentration;
  if(!c || !c.top1) return '';
  return mgMarTile('Your biggest customer', mgMarPct(c.top1.share_pct) + ' of sales', c.top1.party, c.top1.share_pct >= 20 ? 'bad' : 'flat') +
    mgMarTile('Top 5 customers', mgMarPct(c.top5_pct) + ' of sales', c.customers + ' customers billed this year', c.top5_pct >= 60 ? 'bad' : 'flat');
}

function mgRenderMargin(){
  const host = document.getElementById('view-margin'); if(!host) return;
  if(!mgMar && !mgMarBusy && !mgMarErr) mgLoadMargin();
  const d = mgMar;
  const head = mgPageHead({ group:'Insight', title:'Margin',
    sub:'How much you keep, worked out from your ' + mgBooksName() + ' books. One source, so every figure is a signal until bank and GST agree with it.' + (d && d.stale ? ' Updating to your latest sync…' : ''),
    actions:mgBtn('Refresh', 'data-mar-refresh') + (d && d.connected ? mgExportBtn('marExport') : '') });
  if(!d){
    host.innerHTML = head + '<div class="mg-panel mg-empty-panel"><h2>' + (mgMarErr ? 'Couldn’t load margin' : 'Loading…') + '</h2>' +
      '<p>' + (mgMarErr ? 'Try Refresh in a moment.' : 'Reading your books.') + '</p></div>';
    return;
  }
  if(!d.connected){
    host.innerHTML = head + '<div class="mg-panel mg-empty-panel"><h2>Connect your books to see your margin</h2>' +
      '<p>Margin is built from your books: Tally (through the Margyn Tally agent), Zoho Books or Odoo.</p>' +
      '<div style="margin-top:12px">' + mgBtn('Open sources', 'data-mar-go="connectors"', true) + '</div></div>';
    return;
  }
  const p = d.period || {}, wc = d.working_capital || {}, q = d.quality || {}, lk = d.leaks || {};
  const gm = p.gross_margin_pct_after_stock != null ? p.gross_margin_pct_after_stock : p.gross_margin_pct_pre_stock;
  const gmLabel = p.gross_margin_pct_after_stock != null ? 'Gross margin, after stock movement' : 'Gross margin, before stock movement';
  const conf = MG_MAR_CONF[q.confidence] || MG_MAR_CONF.medium;

  const companySel = (d.companies || []).length > 1
    ? '<div class="mg-panel-b"><label class="mg-muted">Company&nbsp;</label><select data-mar-company>' +
      d.companies.map(c => '<option' + (c === d.company_name ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') + '</select></div>' : '';

  const stand = (d.headlines || []).length
    ? '<ul class="mg-list" style="margin:0;padding:12px 16px 12px 32px">' + d.headlines.map(h => '<li style="margin:4px 0">' + escapeHtml(h) + '</li>').join('') + '</ul>'
    : '<div class="mg-panel-b"><p class="mg-muted">Not enough closed months yet to compare. Once two full months are in Tally, the changes show here.</p></div>';

  const pnlRows = (d.pnl || []).slice().reverse().map(r =>
    '<tr><td>' + escapeHtml(mgMarMonth(r.month)) + (r.provisional ? ' <span class="mg-muted">(month in progress)</span>' : r.partial_start ? ' <span class="mg-muted">(partial month, synced from mid-month)</span>' : r.costs_incomplete ? ' <span class="mg-muted">(running costs look incomplete)</span>' : '') + '</td>' +
    '<td class="r">' + mgNum(r.net_sales) + '</td><td class="r">' + mgNum(r.cogs_pre_stock) + '</td>' +
    // A month a few days old (or with costs not booked) has no meaningful margin %: Oct, 4 days in, read −175%.
    '<td class="r">' + mgNum(r.gross_profit_pre_stock) + '</td><td class="r">' + (r.provisional ? '—' : mgMarPct(r.gross_margin_pct_pre_stock)) + '</td>' +
    '<td class="r">' + mgNum(r.opex) + '</td><td class="r">' + mgNum(r.net_profit_pre_stock) + '</td><td class="r">' + (r.provisional || r.costs_incomplete ? '—' : mgMarPct(r.net_margin_pct_pre_stock)) + '</td></tr>').join('');

  const costRows = (d.cost_structure || []).map(c =>
    '<tr><td>' + escapeHtml(c.ledger) + '</td><td class="mg-muted">' + escapeHtml((MG_MAR_BUCKETS.find(b => b[0] === c.bucket) || [0, c.bucket])[1]) + '</td>' +
    '<td class="r">' + mgNum(c.amount) + '</td><td class="r">' + mgMarPct(c.pct_of_net_sales) + '</td></tr>').join('');

  const custRows = (d.customers || []).filter(c => c.net_sales || c.outstanding).slice(0, 25).map(c =>
    '<tr><td>' + escapeHtml(mgCleanName(c.party) || '—') + (c.flags.length ? ' <span class="mg-muted">' + escapeHtml(c.flags.map(f => ({ over_90_days:'over 90 days', owes_with_no_sales_in_90d:'no recent sales', high_returns:'high returns' }[f] || f)).join(', ')) + '</span>' : '') + '</td>' +
    '<td class="r">' + mgNum(c.net_sales) + '</td><td class="r">' + mgMarPct(c.returns_pct) + '</td>' +
    '<td class="r">' + mgNum(c.outstanding) + '</td><td class="r">' + (c.dso_days == null ? '—' : Math.round(c.dso_days) + ' d') + '</td>' +
    '<td class="r">' + mgMarPct(c.credit_cost_pct_of_sales) + '</td><td class="r">' + mgMarPct(c.est_margin_after_credit_pct) + '</td></tr>').join('');

  let itemsPanel;
  if(d.items_available){
    const ir = d.items.slice(0, 30).map(i =>
      '<tr><td>' + escapeHtml(i.item) + (i.flags.length ? ' <span class="mg-muted">' + escapeHtml(i.flags.map(f => ({ sold_below_cost:'sold below cost', no_purchase_cost_in_period:'no purchase cost', sold_more_than_bought_in_period:'sold more than bought', cost_from_assembly:'kit: cost from its parts' }[f] || f)).join(', ')) + '</span>' : '') + '</td>' +
      '<td class="r">' + mgNum(i.sold_qty) + '</td><td class="r">' + mgNum(i.sold_value) + '</td><td class="r">' + (i.avg_price == null ? '—' : mgNum(i.avg_price)) + '</td>' +
      '<td class="r">' + (i.avg_cost == null ? '—' : mgNum(i.avg_cost)) + '</td><td class="r">' + (i.est_margin == null ? '—' : mgNum(i.est_margin)) + '</td><td class="r">' + mgMarPct(i.est_margin_pct) + '</td></tr>').join('');
    const b = d.margin_bridge;
    itemsPanel = mgMarPanel('Margin by item', 'Average purchase cost over the period', '<table class="mg-grid"><thead><tr><th>Item</th><th class="r">Qty sold</th><th class="r">Sales (₹)</th><th class="r">Avg price (₹)</th><th class="r">Avg cost (₹)</th><th class="r">Margin (₹)</th><th class="r">Margin %</th></tr></thead><tbody>' + ir + '</tbody></table>' +
      (b ? mgMarNote('Between ' + mgMarMonth(b.from_month) + ' and ' + mgMarMonth(b.to_month) + ' margin moved ' + fmtINR(b.margin_to - b.margin_from) + ': selling price ' + fmtINR(b.price_effect) + ', purchase cost ' + fmtINR(b.cost_effect) + ', volume and mix ' + fmtINR(b.volume_mix_effect) + '.') : ''));
  } else {
    itemsPanel = mgMarPanel('Margin by item', 'Not available yet',
      mgMarNote('Tally hasn’t sent the item lines on your sales and purchase vouchers yet, so margin per product can’t be worked out. It arrives with the next Margyn Tally agent update. Until then customer margins below use your company-wide margin.'));
  }

  const gstRows = (d.gst_estimate || []).slice().reverse().slice(0, 12).map(g =>
    '<tr><td>' + escapeHtml(mgMarMonth(g.month)) + '</td><td class="r">' + mgNum(g.output_tax) + '</td><td class="r">' + mgNum(g.input_tax) + '</td><td class="r">' + mgNum(g.net_payable_estimate) + '</td></tr>').join('');

  const qs = (d.questions || []).filter(x => x.kind === 'classify_ledger');
  const other = (d.questions || []).filter(x => x.kind !== 'classify_ledger');
  const qHtml = (qs.length || other.length)
    ? '<div class="mg-panel-b">' +
      qs.map(x =>
        '<div class="mg-field" style="grid-template-columns:1fr auto auto"><div class="mg-field-l"><strong>' + escapeHtml(x.ledger) + '</strong><div class="mg-muted">' + escapeHtml(x.why) + '</div></div>' +
        '<select data-mar-bucket="' + escapeHtml(x.ledger) + '"><option value="">Choose…</option>' + MG_MAR_BUCKETS.map(b => '<option value="' + b[0] + '"' + (x.suggested === b[0] ? ' selected' : '') + '>' + escapeHtml(b[1]) + '</option>').join('') + '</select>' +
        mgBtn('Confirm', 'data-mar-confirm="' + escapeHtml(x.ledger) + '"') + '</div>').join('') +
      other.map(x => '<p class="mg-muted" style="margin:10px 0">' + escapeHtml(x.why) + '</p>').join('') + '</div>'
    : mgMarNote('Nothing to confirm. Every ledger with activity is placed.');

  host.__csv = [['Month', 'Net sales', 'Cost of goods (before stock)', 'Gross profit', 'Gross margin %', 'Opex', 'Net profit', 'Net margin %'],
    (d.pnl || []).map(r => [r.month, r.net_sales, r.cogs_pre_stock, r.gross_profit_pre_stock, r.gross_margin_pct_pre_stock, r.opex, r.net_profit_pre_stock, r.net_margin_pct_pre_stock])];

  host.innerHTML = head +
    '<div class="mg-panel"><div class="mg-panel-b" style="display:flex;gap:12px;align-items:flex-start"><span class="mg-dot ' + conf[1] + '" style="margin-top:6px"></span><div><strong>' + conf[0] + '.</strong> ' +
      escapeHtml(d.basis || '') + '<div class="mg-muted" style="margin-top:4px">' + escapeHtml((q.reasons || []).slice(0, 4).join(' ')) + '</div></div></div>' + companySel + '</div>' +
    '<div class="mg-tiles four">' +
      mgMarTile('Net sales, before GST', fmtINR(p.net_sales || 0, 'tile'), (p.from || '') + ' to ' + (p.to || ''), 'flat', fmtINR(p.net_sales || 0)) +
      mgMarTile(gmLabel, mgMarPct(gm), p.gross_margin_pct_after_stock == null ? 'Stock balance not available' : 'Indicative: depends on Tally’s stock value', gm != null && gm < 15 ? 'bad' : 'flat') +
      mgMarTile('Returns and credit notes', mgMarPct((lk.returns || {}).pct_of_gross_sales), fmtINR((lk.returns || {}).value || 0, 'tile') + ' of gross sales', ((lk.returns || {}).pct_of_gross_sales || 0) > 5 ? 'bad' : 'flat') +
      mgMarTile('Days to get paid', wc.dso_days == null ? '—' : Math.round(wc.dso_days) + ' days', 'Last 90 days of sales', (wc.dso_days || 0) > 60 ? 'bad' : 'flat') +
    '</div>' +
    mgMarPanel('What stands out', 'Worked out from your figures, not written by AI', stand) +
    mgMarComparePanel(d) + mgMarInsightsPanel(d) +
    mgMarPanel('Month by month', 'Before stock movement', '<table class="mg-grid"><thead><tr><th>Month</th><th class="r">Net sales (₹)</th><th class="r">Cost of goods (₹)</th><th class="r">Gross profit (₹)</th><th class="r">Gross %</th><th class="r">Running cost (₹)</th><th class="r">Net profit (₹)</th><th class="r">Net %</th></tr></thead><tbody>' + (pnlRows || '<tr><td colspan="8" class="mg-muted">No vouchers yet.</td></tr>') + '</tbody></table>' +
      mgMarNote('Sales here exclude GST. Gross profit is sales less purchases and direct costs in each month. Stock movement is only known for the whole period, so it isn’t spread across months. Orders and delivery notes are left out because they don’t move money.')) +
    itemsPanel +
    mgMarKitsPanel(d) +
    mgMarBranchPanel(d) +
    (d.concentration ? '<div class="mg-tiles four">' + mgMarConcentration(d) + '</div>' : '') +
    mgMarPanel('Customers, after the cost of waiting', 'Assumes ' + Math.round(((d.assumptions || {}).credit_rate_annual || 0.12) * 100) + '% a year on money owed to you', '<table class="mg-grid"><thead><tr><th>Customer</th><th class="r">Net sales (₹)</th><th class="r">Returns</th><th class="r">Owed (₹)</th><th class="r">Days to pay</th><th class="r">Cost of waiting</th><th class="r">Margin after</th></tr></thead><tbody>' + (custRows || '<tr><td colspan="7" class="mg-muted">No customer sales yet.</td></tr>') + '</tbody></table>' +
      mgMarNote(d.items_available ? 'Customer margin uses company-wide margin until item lines are matched to customers.' : 'Customer margin uses your company-wide gross margin, so it shows who is costly to wait for, not who buys the cheap items.')) +
    mgMarPanel('Where the money goes', 'Largest cost ledgers', '<table class="mg-grid"><thead><tr><th>Ledger</th><th>Type</th><th class="r">Amount (₹)</th><th class="r">% of sales</th></tr></thead><tbody>' + (costRows || '<tr><td colspan="4" class="mg-muted">Nothing yet.</td></tr>') + '</tbody></table>') +
    '<div class="mg-tiles four">' +
      mgMarTile('Owed to you', fmtINR(wc.receivables || 0, 'tile'), fmtINR(wc.receivables_overdue || 0, 'tile') + ' overdue', (wc.receivables_overdue || 0) > 0 ? 'bad' : 'flat', fmtINR(wc.receivables || 0)) +
      mgMarTile('You owe', fmtINR(wc.payables || 0, 'tile'), wc.dpo_days == null ? (wc.suppliers_tracked_billwise === false ? (wc.payables_basis === 'supplier_ledgers' ? 'From supplier balances' + (wc.supplier_advances >= 1 ? '; ' + fmtINR(wc.supplier_advances, 'tile') + ' paid ahead' : '') : 'Supplier bills aren’t tracked bill by bill in Tally') : '') : 'Paid in about ' + Math.round(wc.dpo_days) + ' days', 'flat', fmtINR(wc.payables || 0)) +
      mgMarTile('Stock held', wc.stock_value == null ? '—' : fmtINR(wc.stock_value, 'tile'), wc.dio_days == null ? 'Days of stock not available' : Math.round(wc.dio_days) + ' days of stock', 'flat', wc.stock_value == null ? '' : fmtINR(wc.stock_value)) +
      mgMarTile('Cash cycle', wc.cash_conversion_days == null ? '—' : Math.round(wc.cash_conversion_days) + ' days', 'Days to pay + days of stock − days to be paid') +
    '</div>' +
    mgMarPanel('GST estimate from your books', 'From booked tax ledgers, not the GST portal. The GST and tax page has the filing view', '<table class="mg-grid"><thead><tr><th>Month</th><th class="r">Output tax (₹)</th><th class="r">Input tax (₹)</th><th class="r">Net payable (₹)</th></tr></thead><tbody>' + (gstRows || '<tr><td colspan="4" class="mg-muted">No tax ledgers found.</td></tr>') + '</tbody></table>') +
    mgMarPanel('Margyn needs your help', 'Confirming these makes the margin more accurate', qHtml);
}
MG_OWN_RENDER.margin = mgRenderMargin;

document.addEventListener('click', async e => {
  if(e.target.closest('[data-mar-refresh]')){ mgLoadMargin(true).then(() => mgRenderMargin()); return; }
  const go = e.target.closest('[data-mar-go]'); if(go && typeof mgGo === 'function'){ mgGo(go.getAttribute('data-mar-go')); return; }
  if(e.target.closest('#marExport')){
    const host = document.getElementById('view-margin');
    if(host && host.__csv) mgCsv('margyn-margin.csv', host.__csv[0], host.__csv[1]);
    return;
  }
  const btn = e.target.closest('[data-mar-confirm]'); if(!btn) return;
  const ledger = btn.getAttribute('data-mar-confirm');
  const sel = Array.from(document.querySelectorAll('[data-mar-bucket]')).find(s => s.getAttribute('data-mar-bucket') === ledger);
  if(!sel || !sel.value){ toast('Choose where “' + ledger + '” belongs first.'); return; }
  btn.disabled = true;
  try {
    await tallyApi('/api/tally?action=classify', { method:'POST', body: JSON.stringify({ ledger, bucket: sel.value, company: (mgMar && mgMar.company_name) || '' }) });
    await mgLoadMargin(true); mgRenderMargin();
  } catch(err){ btn.disabled = false; toast(err.message || 'Couldn’t save that.', { kind:'bad' }); }
});
document.addEventListener('change', e => {
  const s = e.target.closest('[data-mar-company]'); if(!s) return;
  mgMarCompany = s.value; mgMar = null; mgLoadMargin(true).then(() => mgRenderMargin());
});

/* What Margyn (chat and voice) may quote: the server's own headlines and a few
   figures, never anything recomputed in the browser. Null until loaded. */
function mgMarginForAsk(){
  const d = mgMar;
  if(!d || !d.connected) return null;
  const p = d.period || {}, wc = d.working_capital || {}, lk = d.leaks || {};
  return {
    headlines: (d.headlines || []).slice(0, 6),
    period: { from:p.from, to:p.to, net_sales:p.net_sales, gross_margin_pct_pre_stock:p.gross_margin_pct_pre_stock, gross_margin_pct_after_stock:p.gross_margin_pct_after_stock, net_margin_pct_after_stock:p.net_margin_pct_after_stock },
    returns_pct: (lk.returns || {}).pct_of_gross_sales,
    dso_days: wc.dso_days, receivables_overdue: wc.receivables_overdue,
    confidence: (d.quality || {}).confidence, caveats: ((d.quality || {}).reasons || []).slice(0, 3),
    open_questions: (d.questions || []).length,
    items_available: !!d.items_available,
    overdraft: !!(d.funding && d.funding.overdraft),
    top_findings: (d.insights || []).slice(0, 3).map(x => x.title)
  };
}

// Load once in the background after sign-in so Margyn can speak to margin without a visit to the page.
(function(){
  let tries = 0;
  const t = setInterval(() => {
    if(++tries > 30){ clearInterval(t); return; }
    if(typeof currentUser === 'undefined' || !currentUser) return;
    clearInterval(t);
    if(typeof mgCan === 'function' && !mgCan('view_cash')) return;
    if(typeof tallyConnected !== 'undefined' && !tallyConnected) return;
    setTimeout(() => mgLoadMargin(), 4000);
  }, 2000);
})();
