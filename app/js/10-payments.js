/* ============================================================
   PAYMENTS (NEW) — simple, session-only placeholder logic.
   Not yet persisted to Supabase (no schema change made here).
   No mock/example numbers — every KPI below reads real data only
   (from Quick manual entry or an uploaded Razorpay Settlements /
   Shopify Orders sheet) and shows zero/empty until you provide it.
   See "Margyn Validation & Logic Roadmap" doc for what's needed
   to make this production-grade.
   ============================================================ */
const ZERO_PAYMENTS = { gross:0, mdr:0, failed:0, total:0, lag:0, upiPct:0 };
let shopifyOrdersData = null; // set on upload only — no mock fallback
let paymentsActiveSource = 'all'; // 'all', 'razorpay' or 'cashfree'. Presentational source switch on the Payments hub.
function applyPaymentsSource(){
  const rzp = document.getElementById('paymentsRzpBlocks');
  const cf = document.getElementById('paymentsCashfreePanel');
  if(rzp) rzp.classList.toggle('hidden', paymentsActiveSource === 'cashfree');
  if(cf) cf.classList.toggle('hidden', paymentsActiveSource === 'razorpay');
  document.querySelectorAll('#paymentsSourceTabs button').forEach(b => b.classList.toggle('active', b.dataset.src === paymentsActiveSource));
}
function renderCashfreePanel(){
  const body = document.getElementById('cashfreePanelBody'); if(!body) return;
  const sub = document.getElementById('cashfreePanelSub');
  if(typeof cashfreeConnected === 'undefined' || !cashfreeConnected){
    if(sub) sub.textContent = 'Not connected';
    body.innerHTML = '<div class="ledger-empty">Cashfree is not connected. Add it under Connections to track Cashfree settlements alongside Razorpay.</div>';
    return;
  }
  const env = (cashfreeStatus && cashfreeStatus.environment === 'production') ? 'Production' : 'Sandbox';
  const last = (cashfreeStatus && cashfreeStatus.last_success_at) ? fmtDate(cashfreeStatus.last_success_at) : 'pending first sync';
  const needsReauth = cashfreeStatus && cashfreeStatus.needs_reauth;
  const primaryIsCashfree = snapshots[0] && snapshots[0].payments_source === 'cashfree_live';
  if(sub) sub.textContent = env + ' · last synced ' + last;
  body.innerHTML =
    '<div class="hint" style="margin-bottom:10px;">Cashfree exposes settlement data only, so every figure ingested here is money that has already settled. ' +
    (primaryIsCashfree
      ? 'Cashfree is your primary gateway right now, so the numbers above are computed from Cashfree.'
      : 'Razorpay is your primary gateway, so Cashfree settlements are tracked for cross-checking but are not added into the totals above. Treated as Signal until a bank feed confirms them.') + '</div>' +
    (needsReauth ? '<div class="note bad" style="margin-bottom:8px;">Reconnect needed, Cashfree rejected the stored keys.</div>' : '') +
    '<div class="ledger-row"><div class="lr-main"><div class="lr-party">Cashfree ' + env + '</div>' +
    '<div class="lr-meta">Last synced ' + last + '</div></div>' +
    '<span class="lr-tag ' + (needsReauth ? 'bad' : 'ok') + '">' + (needsReauth ? 'Action needed' : 'Connected') + '</span></div>';
}
function computePaymentsMetrics(d){
  const gross = Number(d.gross) || 0;
  const mdr = Number(d.mdr) || 0;
  const failed = Number(d.failed) || 0;
  const total = Number(d.total) || 0;
  const lag = Number(d.lag) || 0;
  const upiPct = Math.max(0, Math.min(100, Number(d.upiPct) || 0));
  const mdrPct = gross > 0 ? (mdr / gross) * 100 : 0;
  const failRate = total > 0 ? (failed / total) * 100 : 0;
  const netSettled = gross - mdr;
  const avgTxn = total > 0 ? gross / total : 0;
  // Simple method mix placeholder: UPI vs "Other" (card/netbanking/wallet combined).
  // Real version needs per-transaction method breakdown from Razorpay Transactions export — see roadmap.
  const methods = [
    { name:'UPI', pct: upiPct, color:'#0E8F5C' },
    { name:'Other (card/NB/wallet)', pct: 100 - upiPct, color:'#5C6B7A' }
  ];
  const topMethod = methods.slice().sort((a,b) => b.pct - a.pct)[0];
  return { gross, netSettled, avgTxn, mdrPct, failRate, lag, methods, topMethodPct: topMethod.pct, topMethodName: topMethod.name };
}
function flagFor(kind, val){
  if(kind === 'lag') return val <= 1 ? {c:'ok',t:'Fast'} : val <= 2 ? {c:'warn',t:'Normal'} : {c:'bad',t:'Slow'};
  if(kind === 'mdr') return val <= 2 ? {c:'ok',t:'Healthy'} : val <= 2.5 ? {c:'warn',t:'Watch'} : {c:'bad',t:'High'};
  if(kind === 'fail') return val <= 3 ? {c:'ok',t:'Healthy'} : val <= 8 ? {c:'warn',t:'Watch'} : {c:'bad',t:'High'};
  if(kind === 'conc') return val <= 60 ? {c:'ok',t:'Diversified'} : val <= 80 ? {c:'warn',t:'Concentrated'} : {c:'bad',t:'High risk'};
  return {c:'ok',t:''};
}
function renderPayments(){
  const banner = document.getElementById('paymentsMockBanner');
  const badge = document.getElementById('paymentsBadge');
  const hasData = !!paymentsData;
  banner.classList.toggle('hidden', hasData);
  const srcBadge = document.getElementById('paymentsSourceBadge');
  if(hasData && snapshots[0]){
    // payments_source is scoped to payments_data specifically, not the whole
    // snapshot's source — a snapshot's cash/revenue can be self-reported
    // while its payments block was overwritten live by the Razorpay sync
    // (or vice versa), so this must not read snapshots[0].source.
    const live = snapshots[0].payments_source === 'razorpay_live';
    srcBadge.textContent = live ? 'Live · Razorpay' : 'Manual';
    srcBadge.className = 'source-badge ' + (live ? 'connector' : 'self-reported');
    srcBadge.style.display = 'inline-flex';
    srcBadge.title = live ? 'Synced automatically from Razorpay each night.' : 'These numbers were entered or uploaded by hand, not pulled live from Razorpay.';
  } else {
    srcBadge.style.display = 'none';
  }
  const d = paymentsData || ZERO_PAYMENTS;
  const m = computePaymentsMetrics(d);
  document.getElementById('payGrossVal').textContent = inr(m.gross);
  document.getElementById('payNetVal').textContent = inr(m.netSettled);
  document.getElementById('payAtvVal').textContent = inr(m.avgTxn);
  document.getElementById('paySettleVal').textContent = hasData ? m.lag.toFixed(1) + ' days' : '—';
  const lf = hasData ? flagFor('lag', m.lag) : {c:'',t:''};
  const sf = document.getElementById('paySettleFlag'); sf.textContent = lf.t; sf.className = 'pc-flag ' + lf.c;
  document.getElementById('payMdrVal').textContent = hasData ? m.mdrPct.toFixed(2) + '%' : '—';
  const mf = hasData ? flagFor('mdr', m.mdrPct) : {c:'',t:''};
  const mfe = document.getElementById('payMdrFlag'); mfe.textContent = mf.t; mfe.className = 'pc-flag ' + mf.c;
  document.getElementById('payFailVal').textContent = hasData ? m.failRate.toFixed(1) + '%' : '—';
  const ff = hasData ? flagFor('fail', m.failRate) : {c:'',t:''};
  const ffe = document.getElementById('payFailFlag'); ffe.textContent = ff.t; ffe.className = 'pc-flag ' + ff.c;
  document.getElementById('payMethodVal').textContent = hasData ? (m.topMethodPct.toFixed(0) + '% ' + m.topMethodName) : '—';
  const bar = document.getElementById('payMethodBar'); bar.innerHTML = '';
  const legend = document.getElementById('payMethodLegend'); legend.innerHTML = '';
  if(hasData){
    m.methods.forEach(meth => {
      if(meth.pct <= 0) return;
      const seg = document.createElement('span');
      seg.style.cssText = 'width:' + meth.pct + '%; background:' + meth.color + ';';
      seg.textContent = meth.pct >= 12 ? meth.pct.toFixed(0) + '%' : '';
      bar.appendChild(seg);
      const leg = document.createElement('span');
      leg.innerHTML = '<i style="background:' + meth.color + ';"></i>' + meth.name + ' ' + meth.pct.toFixed(0) + '%';
      legend.appendChild(leg);
    });
  }
  const cf = hasData ? flagFor('conc', m.topMethodPct) : {c:'',t:''};
  const cfe = document.getElementById('payMethodFlag'); cfe.textContent = cf.t; cfe.className = 'pc-flag ' + cf.c;
  badge.textContent = (hasData && (mf.c==='bad'||ff.c==='bad'||cf.c==='bad')) ? '!' : '';
  badge.classList.toggle('hidden', !hasData || !(mf.c==='bad'||ff.c==='bad'||cf.c==='bad'));
  renderSettleTrendChart();
  renderShopifyChart();
  renderSettlementList();
  renderCashfreePanel();
  applyPaymentsSource();
}
document.querySelectorAll('#paymentsSourceTabs button').forEach(b => b.addEventListener('click', () => {
  paymentsActiveSource = b.dataset.src; applyPaymentsSource();
}));
function renderSettlementList(){
  const host = document.getElementById('settlementList'); if(!host) return;
  const sub = document.getElementById('settleListSub');
  const rows = settlementRows || [];
  if(!rows.length){
    sub.textContent = 'No settlement batches yet';
    host.innerHTML = '<div class="ledger-empty">Upload a Razorpay Settlements sheet to see batches here, each with a Mark as settled toggle.</div>';
    return;
  }
  sub.textContent = rows.length + ' batches, status is a local toggle, not yet persisted';
  host.innerHTML = '';
  rows.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'ledger-row';
    row.innerHTML =
      '<div class="lr-main"><div class="lr-party">'+r.id+'</div>' +
      '<div class="lr-meta">'+(r.date||'—')+' · gross '+inr(r.gross)+'<span class="lr-tag '+(r.settled?'ok':'warn')+'">'+(r.settled?'Settled':'Pending')+'</span></div></div>' +
      '<div class="lr-amount">'+inr(r.net)+'</div>' +
      '<div class="lr-actions"><button class="lr-btn" data-idx="'+i+'">'+(r.settled?'Mark pending':'Mark as settled')+'</button></div>';
    row.querySelector('button').addEventListener('click', () => {
      settlementRows[i].settled = !settlementRows[i].settled;
      renderSettlementList();
    });
    host.appendChild(row);
  });
}
function renderSettleTrendChart(){
  const host = document.getElementById('paySettleBarChart'); if(!host) return;
  const sub = document.getElementById('paySettleTrendSub');
  const series = settlementDailyTrend || [0,0,0,0,0,0,0];
  const hasReal = !!settlementDailyTrend;
  sub.textContent = hasReal ? '₹ per day (from uploaded settlement rows)' : 'No data yet, upload settlements to see daily trend';
  const max = Math.max(...series, 1);
  host.innerHTML = '';
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  series.forEach((v, i) => {
    const pct = hasReal ? (v/max)*100 : 0;
    const col = document.createElement('div'); col.className = 'bc-col';
    col.innerHTML = '<span class="bc-val">'+(hasReal ? (v/1000).toFixed(0)+'K' : '—')+'</span><div class="bc-bar" style="height:0%;"></div><span class="bc-label">'+days[i]+'</span>';
    host.appendChild(col);
    requestAnimationFrame(() => { col.querySelector('.bc-bar').style.height = pct + '%'; });
  });
}
function renderShopifyChart(){
  const host = document.getElementById('shopifyBarChart'); if(!host) return;
  const sub = document.getElementById('shopifyChartSub');
  // Uploaded sheet wins when present. Otherwise fall back to live counts from
  // the Shopify connector, so a connected store isn't told to go upload a file.
  let rows = shopifyOrdersData;
  let subText = 'From last upload, reference only, not yet scored';
  if(!rows && shopifyConnected && shopifyStore && shopifyStore.counts){
    const c = shopifyStore.counts;
    rows = [
      { label:'Orders synced', value: c.orders||0 },
      { label:'Refunds', value: c.refunds||0 },
      { label:'SKUs with cost', value: Math.max(0, (c.variants||0) - (c.variants_missing_cost||0)) },
      { label:'SKUs missing cost', value: c.variants_missing_cost||0 }
    ];
    subText = 'Live from the Shopify connector, ' + (shopifyStore.backfill_complete ? 'synced nightly' : 'backfill in progress');
  }
  if(sub) sub.textContent = rows ? subText : 'Not connected';
  if(!rows){ host.innerHTML = '<div class="ledger-empty">Connect Shopify under Connectors, or upload a Shopify Orders sheet, to see order and SKU counts here.</div>'; return; }
  host.innerHTML = '';
  const max = Math.max(...rows.map(r => r.value), 1);
  rows.forEach(r => {
    const pct = Math.max(3, (r.value/max)*100);
    const row = document.createElement('div'); row.className = 'hbar-row';
    const valText = r.isCurrency ? inr(r.value) : r.value;
    row.innerHTML = '<span class="hbar-label">'+r.label+'</span>' +
      '<div class="hbar-track"><div class="hbar-fill" style="width:0%;"></div></div>' +
      '<span class="hbar-val">'+valText+'</span>';
    host.appendChild(row);
    requestAnimationFrame(() => { row.querySelector('.hbar-fill').style.width = pct + '%'; });
  });
}
