/* ============================================================
   CASH (plan §8): how much, where, arriving when, and will it last.

   - Where the cash is: one row per source and account, exactly as each
     source reports it. Sources are shown side by side and never added
     together; each source's own balance carries an agreement badge
     against the reconciled figure (same 2% / ₹1 tolerance as
     mgMoneyGroups). Tally uses the same ledger filter as the Pulse Score
     (tallyLiquidLedgers() in 15-scoring.js), so the two can't disagree;
     OD / cash-credit / loan ledgers are listed as Borrowing, never cash.
   - In transit: gateway money that isn't in the bank yet, as two lines:
     settled and on its way to the bank, and captured but not yet settled.
   - The 13-week forecast (shared with Home, 19a-forecast.js) plus its
     weekly table and the same Adjust drawer.
   - Settlements with lag and status. Status comes from the gateway; the
     uploaded sheet's "Mark as settled" toggle is session-only and stays
     on Payment gateways, so nothing here looks saved when it isn't.
   The old gateway page is kept as Cash → Payment gateways (⌘K too).
   ============================================================ */
let mgCashSrc = 'reconciled';   // Scope bar: 'reconciled' or one cash source
let mgCashGw = null;            // gateway rows, loaded on first visit: { rz:{ settlements, captured }, cf:{ settlements } }
let mgCashGwLoading = false;
const MG_CASH_SRC_ORDER = ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'manual'];
const MG_CASH_SRC_NAME = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', razorpay:'Razorpay', cashfree:'Cashfree', manual:'Entered by you' };
const MG_RZ_SETTLE_DAYS = 2;    // Razorpay's standard T+2 settlement cycle

/* Gateway rows straight from the synced tables (RLS: own rows only). */
async function mgCashLoadGateways(){
  if(mgCashGwLoading || !currentUser) return;
  mgCashGwLoading = true;
  const out = { rz:{ settlements:[], captured:[] }, cf:{ settlements:[] } };
  const since = new Date(Date.now() - (MG_RZ_SETTLE_DAYS + 1) * 86400000).toISOString();
  try {
    if(razorpayConnected){
      const [s, t] = await Promise.all([
        sbClient.from('razorpay_settlements').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(60),
        sbClient.from('razorpay_transactions').select('*').eq('user_id', currentUser.id).eq('status', 'captured').gte('created_at', since).order('created_at', { ascending:false }).limit(1000)
      ]);
      out.rz.settlements = (s && s.data) || [];
      out.rz.captured = (t && t.data) || [];
    }
  } catch(e){ console.warn('[margyn] cash: razorpay rows', e); }
  try {
    if(cashfreeConnected){
      const r = await sbClient.from('cashfree_settlements').select('*').eq('user_id', currentUser.id).order('settled_on', { ascending:false }).limit(60);
      out.cf.settlements = (r && r.data) || [];
    }
  } catch(e){ console.warn('[margyn] cash: cashfree rows', e); }
  mgCashGw = out; mgCashGwLoading = false;
  if(mgCurrentView === 'cash') mgRenderCash();
}
// New data after a refresh: reload the gateway rows next time Cash is shown.
(function(){ const base = refreshAll; refreshAll = async function(){ mgCashGw = null; return base.apply(this, arguments); }; })();

function mgRzSettleStatus(s){
  const st = String(s.status || '').toLowerCase();
  if(st === 'failed') return 'failed';
  if(st === 'processed' || (!st && s.processed_at)) return 'settled';
  return 'pending';
}
function mgCfSettleStatus(s){
  const st = String(s.status || '').toUpperCase();
  if(st === 'FAILED') return 'failed';
  if(st === 'PAID' || st === 'SUCCESS' || st === 'SETTLED' || (!st && s.settled_on)) return 'settled';
  return 'pending';
}
/* In transit, as two lines. Razorpay amounts are paise; Cashfree rupees. */
function mgCashTransit(){
  const g = mgCashGw; if(!g) return null;
  const rzSettling = g.rz.settlements.filter(s => mgRzSettleStatus(s) === 'pending').reduce((t, s) => t + (Number(s.amount) || 0) / 100, 0);
  const cutoff = Date.now() - MG_RZ_SETTLE_DAYS * 86400000;
  const rzCaptured = g.rz.captured.filter(t => new Date(t.created_at).getTime() >= cutoff)
    .reduce((a, t) => a + ((Number(t.amount) || 0) - (Number(t.fee) || 0)) / 100, 0);
  const cfSettling = g.cf.settlements.filter(s => mgCfSettleStatus(s) === 'pending').reduce((t, s) => t + (Number(s.amount_settled) || 0), 0);
  return { rzSettling, rzCaptured, cfSettling, settling:rzSettling + cfSettling, captured:rzCaptured, total:rzSettling + cfSettling + rzCaptured };
}

/* Each source's cash, as that source reports it. */
function mgCashSources(){
  const out = [];
  const s = (snapshots || [])[0] || null;
  const prov = (s && s.input_provenance && s.input_provenance.cash) || null;
  try {
    if(zohoConnected && zohoVitals && zohoVitals.cash_position && zohoVitals.cash_position.zoho_reported_balance != null){
      out.push({ src:'zoho', total:Number(zohoVitals.cash_position.zoho_reported_balance) || 0, asOf:zohoVitals.last_synced_at || null,
        accounts:[{ name:'Reported bank and cash balance', balance:Number(zohoVitals.cash_position.zoho_reported_balance) || 0 }] });
    }
  } catch(e){}
  try {
    if(tallyConnected && tallyData){
      const t = tallyLiquidLedgers();
      if(t.liquid.length){
        out.push({ src:'tally', total:t.liquid.reduce((a, x) => a + x.balance, 0), asOf:tallyData.as_of || null, inverted:t.inverted,
          accounts:t.liquid.map(x => ({ name:x.name, group:x.parent, balance:x.balance })) });
      }
      if(t.borrow.length) out.borrowing = t.borrow.map(x => ({ src:'tally', name:x.name, group:x.parent, balance:x.balance, asOf:tallyData.as_of || null }));
    }
  } catch(e){}
  try {
    if(odooConnected && odooStatus && odooStatus.cash_position && odooStatus.cash_position.bank_data_available !== false && odooStatus.cash_position.balance != null){
      const c = odooStatus.cash_position;
      out.push({ src:'odoo', total:Number(c.balance) || 0, asOf:c.as_of || odooStatus.last_success_at || null,
        accounts:[{ name:(c.account_count ? c.account_count + ' bank and cash account' + (c.account_count === 1 ? '' : 's') : 'Bank and cash accounts') + (c.basis ? ' (' + c.basis + ')' : ''), balance:Number(c.balance) || 0 }] });
    }
  } catch(e){}
  if(s && prov && (prov.source === 'self' || !prov.source)){
    out.push({ src:'manual', total:Number(s.cash) || 0, asOf:s.created_at, accounts:[{ name:'Your latest cash figure', balance:Number(s.cash) || 0 }] });
  }
  if(!out.borrowing) out.borrowing = [];
  return out;
}
function mgCashAgree(total, recon){
  if(recon == null) return '<span class="mg-bdg">No reconciled figure</span>';
  const d = Math.abs(total - recon);
  return d <= Math.max(1, Math.abs(recon) * 0.02) ? '<span class="mg-bdg pos">Agrees</span>' : '<span class="mg-bdg neg">Differs by ' + escapeHtml(fmtINR(d)) + '</span>';
}
function mgCashAsOf(iso){ return iso ? escapeHtml(fmtDate(iso)) : '<span class="mg-muted">—</span>'; }
function mgCashSourceOptions(){
  const have = new Set(mgCashSources().map(x => x.src));
  try { if(razorpayConnected) have.add('razorpay'); if(cashfreeConnected) have.add('cashfree'); } catch(e){}
  return MG_CASH_SRC_ORDER.filter(k => have.has(k));
}
function mgCashMode(){ return mgCashSrc === 'reconciled' || mgCashSourceOptions().includes(mgCashSrc) ? mgCashSrc : 'reconciled'; }

function mgRenderCash(){
  const host = document.getElementById('view-cash'); if(!host) return;
  if(!mgCashGw && !mgCashGwLoading) mgCashLoadGateways();
  const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
  const recon = s ? Number(s.cash) || 0 : null;
  const prov = (s && s.input_provenance && s.input_provenance.cash) || null;
  const mode = mgCashMode();
  const show = k => mode === 'reconciled' || mode === k;
  const modeLabel = mode === 'reconciled' ? 'Reconciled' : MG_CASH_SRC_NAME[mode];
  const srcs = mgCashSources();
  const tr = mgCashTransit();
  const f = s && typeof mgForecast === 'function' ? mgForecast() : null;
  const runway = mgVital(s, 'Working Capital Runway'), runwayP = mgVital(p, 'Working Capital Runway');
  const rNow = runway ? parseFloat(runway.value) : null, rPrev = runwayP ? parseFloat(runwayP.value) : null;
  const usedName = prov && prov.source ? (SOURCE_DISPLAY[prov.source] || MG_CASH_SRC_NAME[prov.source] || prov.source) : null;

  const tiles = !s ? '' : '<div class="mg-tiles four">' +
    mgTile({ label:'Cash (reconciled)', value:fmtINR(recon, 'tile'), full:fmtINR(recon), delta:p ? mgPct(recon, Number(p.cash)) : null, goodUp:true,
      src:'Reconciled' + (usedName ? ' · from ' + usedName : ''), go:'cash' }) +
    mgTile({ label:'In transit', value:tr ? fmtINR(tr.total, 'tile') : (mgCashGwLoading ? '…' : 'n/a'), full:tr ? fmtINR(tr.total) : '',
      note:tr ? fmtINR(tr.settling, 'tile') + ' settling · ' + fmtINR(tr.captured, 'tile') + ' not yet settled' : '', src:'Payment gateways, not yet in the bank', go:'cash' }) +
    mgTile({ label:'Runway', value:rNow != null ? rNow.toFixed(1) + ' months' : 'n/a', full:'Cash plus receivables, less payables due, over monthly spend',
      delta:(rNow != null && rPrev != null) ? rNow - rPrev : null, deltaText:(rNow != null && rPrev != null) ? Math.abs(rNow - rPrev).toFixed(1) + ' months' : '', goodUp:true, src:'Reconciled', go:'pulse' }) +
    mgTile({ label:'Lowest point in 13 weeks', value:f ? fmtINR(f.min, 'tile') : 'n/a', full:f ? fmtINR(f.min) : '',
      note:f ? 'Week ' + (f.minWeek + 1) + (f.min < f.floor ? ', below your floor' : ', above your floor') : '', src:'Your forecast assumptions', go:'cash' }) + '</div>';

  // ---- where the cash is ----
  let rows = '';
  const srcHead = (k, total, asOf, status) => '<tr class="mg-cash-src"><td><span class="mg-srccell">' + mgLogo(k) + escapeHtml(MG_CASH_SRC_NAME[k]) + '</span></td><td class="mg-muted">' +
    (k === 'tally' ? 'All bank and cash ledgers' : 'As reported') + '</td><td class="r">' + mgNum(total) + '</td><td>' + mgCashAsOf(asOf) + '</td><td>' + status + '</td></tr>';
  srcs.filter(x => show(x.src)).forEach(x => {
    const used = prov && prov.source === (x.src === 'manual' ? 'self' : x.src);
    const status = (used ? '<span class="mg-bdg pos">Used for Cash</span> ' : '') + (used ? '' : mgCashAgree(x.total, recon));
    if(x.accounts.length === 1){
      rows += '<tr data-cash-src="' + x.src + '"><td><span class="mg-srccell">' + mgLogo(x.src) + escapeHtml(MG_CASH_SRC_NAME[x.src]) + '</span></td><td>' + escapeHtml(x.accounts[0].name) + '</td><td class="r">' + mgNum(x.total) + '</td><td>' + mgCashAsOf(x.asOf) + '</td><td>' + status + '</td></tr>';
    } else {
      rows += srcHead(x.src, x.total, x.asOf, status).replace('<tr class="mg-cash-src">', '<tr class="mg-cash-src" data-cash-src="' + x.src + '">');
      x.accounts.forEach(a => { rows += '<tr class="mg-cash-acct" data-cash-acct="' + x.src + '"><td></td><td>' + escapeHtml(a.name) + (a.group ? ' <span class="mg-muted">· ' + escapeHtml(a.group) + '</span>' : '') + '</td><td class="r">' + mgNum(a.balance) + '</td><td>' + mgCashAsOf(x.asOf) + '</td><td></td></tr>'; });
    }
  });
  const gwSynced = k => { try { return k === 'razorpay' ? ((razorpayStatus && razorpayStatus.last_success_at) || lastSyncedAt || null) : (cashfreeStatus && cashfreeStatus.last_success_at) || null; } catch(e){ return null; } };
  const gwRow = (k, what, amt, status) => '<tr data-cash-src="' + k + '"><td><span class="mg-srccell">' + mgLogo(k) + escapeHtml(MG_CASH_SRC_NAME[k]) + '</span></td><td>' + escapeHtml(what) + '</td><td class="r">' + (amt == null ? '<span class="mg-muted">—</span>' : mgNum(amt)) + '</td><td>' + mgCashAsOf(gwSynced(k)) + '</td><td>' + status + '</td></tr>';
  let gwAny = false;
  try {
    if(razorpayConnected && show('razorpay')){ gwAny = true;
      rows += gwRow('razorpay', 'Settled, on its way to your bank', tr ? tr.rzSettling : null, '<span class="mg-bdg warn">In transit</span>');
      rows += gwRow('razorpay', 'Captured, not yet settled (estimate, T+' + MG_RZ_SETTLE_DAYS + ')', tr ? tr.rzCaptured : null, '<span class="mg-bdg warn">In transit</span>');
    }
    if(cashfreeConnected && show('cashfree')){ gwAny = true;
      rows += gwRow('cashfree', 'Settled, on its way to your bank', tr ? tr.cfSettling : null, '<span class="mg-bdg warn">In transit</span>');
      rows += gwRow('cashfree', 'Captured, not yet settled', null, '<span class="mg-bdg">Cashfree shows payments only once settled</span>');
    }
  } catch(e){}
  if(mode === 'reconciled') rows += '<tr class="mg-muted-row"><td><span class="mg-srccell"><span class="mg-src-logo" style="background:#8B93A0">B</span>Bank feed</span></td><td>Coming via Account Aggregator</td><td class="r"><span class="mg-muted">—</span></td><td><span class="mg-muted">—</span></td><td><span class="mg-bdg">Not connected</span></td></tr>';
  const borrow = (srcs.borrowing || []).filter(b => show(b.src));
  const where = '<div class="mg-panel"><div class="mg-panel-h"><h2>Where the cash is</h2><span class="mg-aside">' + (recon != null ? 'Reconciled cash ' + escapeHtml(fmtINR(recon)) : '') + '</span></div>' +
    (rows ? '<div class="mg-gridwrap"><table class="mg-grid" id="mgCashWhere"><thead><tr><th>Source</th><th>Account</th><th class="r">Balance (₹)</th><th>As of</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="mg-empty">Connect Zoho Books, Tally or Odoo to see balances by account, or import a file with your cash figure.</div>') +
    '<div class="mg-foot-note">Each source is shown exactly as it reports. Balances are never added across sources; ' +
      (usedName ? 'your reconciled cash uses ' + escapeHtml(usedName) + ', the most trusted source that has it.' : 'your reconciled cash uses the most trusted source that has it.') +
      ' Agreement uses a 2% tolerance.' + (gwAny ? ' In-transit money is not in the bank yet, so it is not part of Cash.' : '') + '</div>' +
    (borrow.length ? '<div class="mg-panel-h mg-sub-h"><h2>Borrowing</h2><span class="mg-aside">Overdraft, cash credit and loan ledgers. Not counted as cash.</span></div>' +
      '<div class="mg-gridwrap"><table class="mg-grid" id="mgCashBorrow"><thead><tr><th>Source</th><th>Account</th><th class="r">Balance (₹)</th><th>As of</th></tr></thead><tbody>' +
      borrow.map(b => '<tr><td><span class="mg-srccell">' + mgLogo(b.src) + escapeHtml(MG_CASH_SRC_NAME[b.src]) + '</span></td><td>' + escapeHtml(b.name) + (b.group ? ' <span class="mg-muted">· ' + escapeHtml(b.group) + '</span>' : '') + '</td><td class="r">' + mgNum(b.balance) + '</td><td>' + mgCashAsOf(b.asOf) + '</td></tr>').join('') +
      '</tbody></table></div>' : '') + '</div>';

  // ---- forecast ----
  let fc;
  if(!s) fc = '';
  else if(f && f.st.enabled) fc = mgForecastPanel(window.innerWidth > 900) + '<div class="mg-panel"><div class="mg-panel-h"><h2>Week by week</h2><span class="mg-aside">Closing cash under your assumptions</span></div>' + mgForecastTable(f) + '</div>';
  else fc = '<div class="mg-panel"><div class="mg-panel-h"><h2>13-week cash forecast</h2><button class="mg-btn mg-btn-sm" type="button" data-fc-adjust>Adjust</button></div><div class="mg-empty">The forecast is switched off. Open Adjust and tick “Show the forecast” to turn it back on.</div></div>';

  // ---- settlements ----
  const setl = [];
  if(mgCashGw){
    mgCashGw.rz.settlements.forEach(x => setl.push({ src:'razorpay', id:x.settlement_id || x.id, created:x.created_at, done:x.processed_at, amount:(Number(x.amount) || 0) / 100, fee:(Number(x.fee_deducted) || 0) / 100, utr:x.utr, status:mgRzSettleStatus(x) }));
    mgCashGw.cf.settlements.forEach(x => setl.push({ src:'cashfree', id:x.settlement_id, created:x.payment_till || x.payment_from, done:x.settled_on, amount:Number(x.amount_settled) || 0, fee:null, utr:x.utr, status:mgCfSettleStatus(x) }));
  }
  const setlShown = setl.filter(x => show(x.src)).sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  const lag = x => (x.created && x.done) ? Math.max(0, (new Date(x.done) - new Date(x.created)) / 86400000) : null;
  const lags = setlShown.map(lag).filter(v => v != null);
  const badge = st => st === 'settled' ? '<span class="mg-bdg pos">Settled</span>' : st === 'failed' ? '<span class="mg-bdg neg">Failed</span>' : '<span class="mg-bdg warn">Pending</span>';
  const uploaded = (!setl.length && Array.isArray(settlementRows) && settlementRows.length) ? settlementRows : null;
  let settle;
  if(setlShown.length){
    settle = '<div class="mg-panel"><div class="mg-panel-h"><h2>Settlements</h2><span class="mg-aside">' + (lags.length ? 'Average lag ' + (lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1) + ' days · ' : '') + 'Status from the gateway</span></div>' +
      '<div class="mg-gridwrap"><table class="mg-grid" id="mgCashSettle"><thead><tr><th>Gateway</th><th>Settlement</th><th>Created</th><th>Reached bank</th><th class="r">Lag (days)</th><th class="r">Amount (₹)</th><th>UTR</th><th>Status</th></tr></thead><tbody>' +
      setlShown.slice(0, 25).map(x => '<tr><td><span class="mg-srccell">' + mgLogo(x.src) + escapeHtml(MG_CASH_SRC_NAME[x.src]) + '</span></td><td class="mg-mono">' + escapeHtml(x.id || '—') + '</td><td>' + mgCashAsOf(x.created) + '</td><td>' + (x.status === 'settled' ? mgCashAsOf(x.done) : '<span class="mg-muted">—</span>') + '</td>' +
        '<td class="r">' + (lag(x) != null && x.status === 'settled' ? lag(x).toFixed(1) : '<span class="mg-muted">—</span>') + '</td><td class="r">' + mgNum(x.amount) + '</td><td class="mg-mono">' + escapeHtml(x.utr || '—') + '</td><td>' + badge(x.status) + '</td></tr>').join('') +
      '</tbody></table></div></div>';
  } else if(uploaded && show('razorpay')){
    settle = '<div class="mg-panel"><div class="mg-panel-h"><h2>Settlements</h2><span class="mg-aside">From your uploaded sheet</span></div>' +
      '<div class="mg-gridwrap"><table class="mg-grid" id="mgCashSettle"><thead><tr><th>Batch</th><th>Date</th><th class="r">Gross (₹)</th><th class="r">Net (₹)</th></tr></thead><tbody>' +
      uploaded.slice(0, 25).map(r => '<tr><td class="mg-mono">' + escapeHtml(r.id || '—') + '</td><td>' + escapeHtml(r.date || '—') + '</td><td class="r">' + mgNum(r.gross) + '</td><td class="r">' + mgNum(r.net) + '</td></tr>').join('') +
      '</tbody></table></div><div class="mg-foot-note">An uploaded sheet doesn’t say when each batch reached the bank. Marking batches as settled is on Payment gateways, and lasts until you reload.</div></div>';
  } else {
    settle = '<div class="mg-panel"><div class="mg-panel-h"><h2>Settlements</h2></div><div class="mg-empty">' + (mgCashGwLoading ? 'Loading settlements…' : 'No settlements yet. Connect Razorpay or Cashfree, or upload a settlements sheet.') + '</div></div>';
  }

  // ---- payment gateways (the old page, one click away) ----
  const gws = ['razorpay', 'cashfree'].map(k => ({ k, h:mgSourceHealth(k) }));
  const gw = '<div class="mg-panel"><div class="mg-panel-h"><h2>Payment gateways</h2><span class="mg-aside">Fees, failed payments and settlement batches</span>' +
    '<button class="mg-btn mg-btn-sm" type="button" data-go-page="payments">Open payment gateways</button></div>' +
    gws.map(x => '<div class="mg-li"><div><div class="mg-li-t"><span class="mg-srccell">' + mgLogo(x.k) + escapeHtml(MG_CASH_SRC_NAME[x.k]) + '</span></div></div><div class="mg-li-a' + (x.h.warn ? ' neg' : '') + '">' + escapeHtml(x.h.on ? x.h.text : 'Not connected') + '</div></div>').join('') + '</div>';

  host.innerHTML = mgPageHead({ group:'Money', title:'Cash', scope:mgScopeText(modeLabel),
      sub:'How much you have, where it is, what is on its way, and whether it lasts.', actions:mgBtn('Payment gateways', 'data-go-page="payments"') }) +
    (s ? '' : '<div class="mg-panel mg-empty-panel"><h2>No cash figures yet</h2><p>Import a workbook or connect a source, and Margyn fills this page in.</p>' + mgBtn('Import a file', 'data-go-page="import"', true) + ' ' + mgBtn('Connect a source', 'data-go-page="sources"') + '</div>') +
    tiles + where + fc + settle + gw;
}
