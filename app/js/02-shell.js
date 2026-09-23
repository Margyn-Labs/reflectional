/* ============================================================
   Toasts. Replaces blocking alert() for action feedback.
   ============================================================ */
function toast(msg, opts){
  opts = opts || {};
  const host = document.getElementById('toastHost'); if(!host){ return; }
  const el = document.createElement('div');
  el.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  const glyph = opts.kind === 'bad' ? '!' : opts.kind === 'info' ? 'i' : '✓';
  el.innerHTML = '<span class="t-ic">' + glyph + '</span><div><div class="t-body">' + escapeHtml(msg) + '</div>' +
    (opts.sub ? '<div class="t-sub">' + escapeHtml(opts.sub) + '</div>' : '') + '</div>';
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, opts.ms || 3600);
}
/* ============================================================
   Command palette. Cmd/Ctrl+K anywhere: jump to a page, fire a
   quick action, or send the typed text straight to Ask Margyn.
   ============================================================ */
const CMDK_ICON = {
  invoice:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  plus:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chart:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  plug:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12l-1 5a5 5 0 0 1-10 0Z"/><path d="M9 17v2a3 3 0 0 0 6 0v-2"/></svg>',
  upload:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  ask:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'
};
let cmdkIndex = 0, cmdkCurrent = [];
function cmdkBuild(q){
  const norm = (q || '').trim().toLowerCase();
  const out = [];
  document.querySelectorAll('.pagenav button').forEach(b => {
    const span = b.querySelector('span');
    const label = span ? span.textContent.trim() : b.textContent.trim();
    out.push({ sec:'Pages', label, icon:(b.querySelector('svg') || {}).outerHTML || '', hint:'Go', run:() => showView(b.dataset.view) });
  });
  [
    { label:'Create a new invoice', icon:CMDK_ICON.invoice, run:() => { showView('invoicing'); if(typeof showKhataTab === 'function') showKhataTab('invoice-new'); } },
    { label:'Add a receivable', icon:CMDK_ICON.plus, run:() => { ledgerActiveTab = 'receivables'; showView('ledger'); } },
    { label:'Add a payable', icon:CMDK_ICON.plus, run:() => { ledgerActiveTab = 'payables'; showView('ledger'); } },
    { label:'Review the agent queue', icon:CMDK_ICON.plus, run:() => { agentsActiveTab = 'queue'; showView('agents'); } },
    { label:'Build a new chart', icon:CMDK_ICON.chart, run:() => { showView('analytics'); const b = document.getElementById('analyticsNewBtn'); if(b) b.click(); } },
    { label:'Connect a data source', icon:CMDK_ICON.plug, run:() => showView('connectors') },
    { label:'Upload a workbook', icon:CMDK_ICON.upload, run:() => showView('calculate') }
  ].forEach(a => out.push({ sec:'Actions', label:a.label, icon:a.icon, hint:'Run', run:a.run }));
  const filtered = norm ? out.filter(i => i.label.toLowerCase().includes(norm)) : out;
  if(norm && norm.length > 2){
    filtered.unshift({ sec:'Ask Margyn', label:'Ask: ' + q.trim(), icon:CMDK_ICON.ask, hint:'Ask', run:() => askFromPage(q.trim()) });
  }
  return filtered;
}
function cmdkRender(){
  const list = document.getElementById('cmdkList'); if(!list) return;
  if(!cmdkCurrent.length){ list.innerHTML = '<div class="cmdk-empty">Nothing matches that. Try a page name, or type a full question to ask Margyn.</div>'; return; }
  let html = '', lastSec = null;
  cmdkCurrent.forEach((it, i) => {
    if(it.sec !== lastSec){ html += '<div class="cmdk-sec">' + escapeHtml(it.sec) + '</div>'; lastSec = it.sec; }
    html += '<div class="cmdk-item' + (i === cmdkIndex ? ' on' : '') + '" data-i="' + i + '">' +
      '<span class="ic">' + (it.icon || '') + '</span><span>' + escapeHtml(it.label) + '</span>' +
      '<span class="hint">' + escapeHtml(it.hint || '') + '</span></div>';
  });
  list.innerHTML = html;
  const items = list.querySelectorAll('.cmdk-item');
  items.forEach(el => {
    // NB: highlight on hover by toggling the class only. Re-running cmdkRender()
    // here rebuilds every node between mousedown and mouseup, which cancels the
    // click and makes palette items look dead.
    el.addEventListener('mousemove', () => {
      const i = Number(el.dataset.i);
      if(i === cmdkIndex) return;
      cmdkIndex = i;
      items.forEach(x => x.classList.toggle('on', x === el));
    });
    el.addEventListener('click', () => cmdkRun(Number(el.dataset.i)));
  });
  const on = list.querySelector('.cmdk-item.on');
  if(on && on.scrollIntoView) on.scrollIntoView({ block:'nearest' });
}
function cmdkOpen(){
  const box = document.getElementById('cmdk'); if(!box) return;
  box.classList.remove('hidden');
  const input = document.getElementById('cmdkInput');
  input.value = ''; cmdkIndex = 0; cmdkCurrent = cmdkBuild(''); cmdkRender();
  setTimeout(() => input.focus(), 40);
}
function cmdkClose(){ const box = document.getElementById('cmdk'); if(box) box.classList.add('hidden'); }
function cmdkRun(i){
  const it = cmdkCurrent[i]; if(!it) return;
  cmdkClose();
  try { it.run(); } catch(e){ console.error('[margyn] cmdk action failed', e); }
}
(function wireCmdk(){
  const box = document.getElementById('cmdk'); if(!box) return;
  const input = document.getElementById('cmdkInput');
  const trigger = document.getElementById('cmdkTrigger');
  if(trigger) trigger.addEventListener('click', cmdkOpen);
  box.addEventListener('click', e => { if(e.target === box) cmdkClose(); });
  input.addEventListener('input', () => { cmdkIndex = 0; cmdkCurrent = cmdkBuild(input.value); cmdkRender(); });
  input.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown'){ e.preventDefault(); cmdkIndex = Math.min(cmdkIndex + 1, cmdkCurrent.length - 1); cmdkRender(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); cmdkIndex = Math.max(cmdkIndex - 1, 0); cmdkRender(); }
    else if(e.key === 'Enter'){ e.preventDefault(); cmdkRun(cmdkIndex); }
    else if(e.key === 'Escape'){ e.preventDefault(); cmdkClose(); }
  });
  document.addEventListener('keydown', e => {
    if((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')){
      e.preventDefault();
      box.classList.contains('hidden') ? cmdkOpen() : cmdkClose();
    }
  });
})();
/* top bar: initials avatar + connector sync state */
function updateTopBar(){
  const av = document.getElementById('topAvatar');
  if(av){
    const name = (currentProfile && currentProfile.company_name) || (currentUser && currentUser.email) || 'M';
    av.textContent = name.trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase().slice(0,2) || 'M';
    av.title = (currentUser && currentUser.email) || '';
  }
  updateOrgSwitch();
  const chip = document.getElementById('topSync');
  const txt = document.getElementById('topSyncText');
  if(!chip || !txt || typeof CONN_FEED_MAP === 'undefined') return;
  const live = CONN_FEED_MAP.filter(c => connIsLive(c.key)).length;
  chip.classList.toggle('idle', live === 0);
  txt.textContent = live === 0 ? 'No sources' : (live + ' source' + (live === 1 ? '' : 's') + ' live');
  if(typeof askGroundChips === 'function') askGroundChips();
}
/* org switcher: today there is exactly one business per login (currentProfile),
   so this always renders a single checked row — the UI is built to hold more
   once the account model supports switching between businesses under one login. */
function updateOrgSwitch(){
  const name = (currentProfile && currentProfile.company_name) || 'Your business';
  const initials = name.trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase().slice(0,2) || 'M';
  const sub = currentProfile ? [REV_LABEL[currentProfile.revenue_range], currentProfile.gst_number].filter(Boolean).join(' · ') : '';
  const nameEl = document.getElementById('orgSwitchName'); if(nameEl) nameEl.textContent = name;
  const markEl = document.getElementById('orgSwitchMark'); if(markEl) markEl.textContent = initials;
  const curName = document.getElementById('orgSwitchCurrentName'); if(curName) curName.textContent = name;
  const curMark = document.getElementById('orgSwitchCurrentMark'); if(curMark) curMark.textContent = initials;
  const curSub = document.getElementById('orgSwitchCurrentSub'); if(curSub) curSub.textContent = sub || 'Current business';
}
(function wireOrgSwitch(){
  const wrap = document.getElementById('orgSwitch'); if(!wrap) return;
  const btn = document.getElementById('orgSwitchBtn');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', e => {
    if(wrap.classList.contains('open') && !wrap.contains(e.target)){
      wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && wrap.classList.contains('open')){
      wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    }
  });
})();
function renderInvoicingView(){
  if(typeof relocateKhataIntoInvoicing === 'function') relocateKhataIntoInvoicing();
  if(typeof showKhataTab === 'function') showKhataTab(khataTab || 'parties');
  else if(typeof renderKhataParties === 'function') renderKhataParties();
}
document.querySelectorAll('.pagenav button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
async function refreshAll(){
  snapshots = await loadSnapshots();
  receivables = await loadReceivables();
  payables = await loadPayables();
  findings = await loadFindings();
  pendingSuggestions = await loadPendingSuggestions(); renderSuggestionsBadge();
  khataParties = await loadKhataParties();
  khataEntries = await loadKhataEntries();
  khataInvoices = await loadKhataInvoices();
  await checkRazorpayConnection();
  await checkCashfreeConnection();
  razorpayLiveSummary = await loadRazorpayLiveSummary();
  // Restore session-only Payments-tab state from the latest snapshot so it
  // survives refresh/re-login instead of resetting to empty each load.
  if(snapshots.length > 0){
    const latest = snapshots[0];
    paymentsData = latest.payments_data || null;
    settlementRows = latest.settlement_rows || null;
    settlementDailyTrend = latest.settlement_daily_trend || null;
    shopifyOrdersData = latest.shopify_orders_data || null;
  } else {
    paymentsData = null; settlementRows = null; settlementDailyTrend = null; shopifyOrdersData = null;
  }
  await loadZohoVitals();
  await loadOdooStatus();
  reconSummary = await loadReconSummary();
  agentActions = await loadAgentActions();
  await loadShopifyStatus();
  await loadTallyStatus();
  tallyData = await loadTallyData();
  // Every connector global is loaded by this point. Rebuild the scoring
  // inputs from the best source available per field; if that moved the
  // picture, a fresh `resolved` snapshot is written and re-read so every
  // render below sees the same numbers.
  if(await resolveAndSaveSnapshot()){ snapshots = await loadSnapshots(); }
  renderHeader(); renderProfile(); renderScores(); renderFinancing(); renderPayments(); renderSummary();
  renderReconBooksCard(); renderReconLedger(); renderAgentQueue(); renderTallyTab();
  if(typeof renderBooksHub === 'function') renderBooksHub();
  if(typeof renderConnectionsHub === 'function') renderConnectionsHub();
  if(typeof renderAnalyticsView === 'function') renderAnalyticsView();
  if(typeof updateTopBar === 'function') updateTopBar();
  handleZohoHashReturn();
}
