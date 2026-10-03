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
/* Quick actions. The ids are shared with the navigator (api/_lib/jevNav.js NAV_ACTIONS),
   so Jev can name one and the palette or the Margyn panel runs it. */
const MG_NAV_ACTIONS = {
  'act:new_invoice':{ label:'Create a new invoice', say:'Opening a new invoice.', icon:CMDK_ICON.invoice, words:'invoice bill new make raise', run:() => { showView('invoicing'); if(typeof showKhataTab === 'function') showKhataTab('invoice-new'); } },
  'act:new_customer':{ label:'New customer', say:'Opening the new customer form.', icon:CMDK_ICON.plus, words:'add customer party client buyer create master gstin', run:() => { showView('customers'); if(typeof mgPartyForm === 'function') mgPartyForm({ dir:'recv' }); } },
  'act:new_vendor':{ label:'New vendor', say:'Opening the new vendor form.', icon:CMDK_ICON.plus, words:'add vendor supplier party create master gstin', run:() => { showView('vendors'); if(typeof mgPartyForm === 'function') mgPartyForm({ dir:'pay' }); } },
  'act:add_receivable':{ label:'Add a receivable', say:'Opening receivables in the Ledger.', icon:CMDK_ICON.plus, words:'log payment money owed customer entry', run:() => { ledgerActiveTab = 'receivables'; showView('ledger'); } },
  'act:add_payable':{ label:'Add a payable', say:'Opening payables in the Ledger.', icon:CMDK_ICON.plus, words:'log bill vendor owe entry', run:() => { ledgerActiveTab = 'payables'; showView('ledger'); } },
  'act:voice':{ label:'Talk to Margyn (⌥M)', say:'Starting a call.', icon:CMDK_ICON.ask, words:'voice call speak mic', run:() => { if(typeof openRealtimeOverlay === 'function') openRealtimeOverlay(); } },
  'act:whats_new':{ label:"What's new in Margyn", say:'Here’s what’s new.', icon:CMDK_ICON.chart, words:'whats new release notes changelog updates shipped features', run:() => { if(typeof mgWhatsNew === 'function') mgWhatsNew(true); } },
  'act:agent_queue':{ label:'Review the agent queue', icon:CMDK_ICON.plus, words:'approve proposals inbox decisions', run:() => { agentsActiveTab = 'queue'; showView('agents'); } },
  'act:new_chart':{ label:'Build a new chart', say:'Opening a new chart.', icon:CMDK_ICON.chart, words:'report graph analytics', run:() => { showView('analytics'); const b = document.getElementById('analyticsNewBtn'); if(b) b.click(); } },
  'act:connect':{ label:'Connect a data source', icon:CMDK_ICON.plug, words:'zoho tally odoo razorpay cashfree shopify integration', run:() => showView('connectors') },
  'act:upload':{ label:'Upload a workbook', icon:CMDK_ICON.upload, words:'import excel csv pdf file', run:() => showView('calculate') }
};
/* ---------- search: one index for the command palette and the voice agent ----------
   Pages (by name and by what they're for), connected sources, customers and
   vendors with open items, and actions. "zoho" finds the Zoho connection and
   its figures; "upload" finds Import; a customer's name opens them. */
const MG_SEARCH_WORDS = {
  home:'dashboard overview summary today pulse briefing', inbox:'approvals approve decisions pending queue review proposals waiting',
  cash:'bank balance cash position forecast runway liquidity 13 week transit', payments:'razorpay cashfree gateway settlements fees failed payments upi refunds',
  receivables:'debtors owed owe us collections overdue invoices ar ageing aging dues', payables:'creditors bills vendors due ap owe we pay',
  gst:'tax itc gstr gstr-2b 2b tds input credit gstin filing returns', books:'ledger books zoho tally odoo manual entries journal accounting sources compare',
  invoicing:'invoice create bill khata quote estimate', calculate:'import upload excel xlsx csv pdf file spreadsheet workbook photo scan',
  customers:'clients buyers debtors parties', vendors:'suppliers creditors parties', cfopack:'report monthly pdf board investor pack mis email',
  analytics:'reports charts graphs analytics trends build chart', scores:'pulse score health vitals scoring',
  history:'ask chat questions ai conversation history threads', agents:'agents automation chase collections close bell whatsapp reminders',
  connectors:'sources connectors integrations connect zoho tally odoo razorpay cashfree shopify sync disconnect reconnect api keys organisations',
  people:'people team members roles whatsapp numbers access users permissions', settings:'settings notifications preferences account delete',
  audit:'audit log history changes activity trail who changed', channels:'channel health delivery whatsapp bell chase email failing template approved recovered paid after chase', financing:'capital loan credit financing working capital lender readiness',
  profile:'profile company gst number details name city'
};
const MG_SEARCH_SOURCES = ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'];
function mgSearchNorm(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mgSearchScore(q, label, words){
  const L = mgSearchNorm(label), W = mgSearchNorm(words || '');
  if(!q) return 0;
  if(L === q) return 100;
  if(L.startsWith(q)) return 90;
  if(L.includes(q)) return 78;
  const qt = q.split(' '), lt = L.split(' '), wt = W.split(' ');
  const pref = (t, arr) => arr.some(x => x.startsWith(t) || (t.length >= 4 && x.length >= 4 && typeof vxEdit1 === 'function' && vxEdit1(t, x)));
  if(qt.every(t => pref(t, lt))) return 72;
  if(qt.every(t => pref(t, lt) || pref(t, wt))) return 58;
  const hit = qt.filter(t => pref(t, lt) || pref(t, wt)).length;
  return hit ? 30 * hit / qt.length : 0;
}
/* [{ sec, label, hint, icon, score, kind, run }] best first. */
function mgSearch(q){
  // Filler words ("show me", "kitna", "the") shouldn't dilute the match.
  const STOP = /^(a|an|the|me|my|our|us|we|i|is|are|to|of|for|in|on|and|show|open|go|take|find|see|what|who|how|much|many|most|please|kya|kitna|kitni|kaun|hai|ka|ki|ke|mera|mujhe|dikhao|kholo|batao)$/;
  const raw = mgSearchNorm(q), kept = raw.split(' ').filter(t => t && !STOP.test(t)).join(' ');
  const nq = kept || raw, out = [];
  const push = (it, words) => { const sc = nq ? mgSearchScore(nq, it.label, words) : 1; if(sc > 0) out.push(Object.assign(it, { score:sc })); };
  const railIcon = {};
  document.querySelectorAll('.pagenav button').forEach(b => { const s = b.querySelector('svg'); if(s) railIcon[b.dataset.view] = s.outerHTML; });
  try {
    Object.keys(MG_PAGES).forEach(k => push({ sec:'Pages', kind:'page', label:MG_PAGES[k].label, hint:'Go', icon:railIcon[k] || railIcon[MG_PAGES[k].parent] || '', run:() => mgGo(k) }, MG_SEARCH_WORDS[k]));
  } catch(e){ /* frame not loaded */ }
  if(nq){
    try {
      MG_SEARCH_SOURCES.forEach(k => {
        const h = mgSourceHealth(k), name = MG_SRC_LABEL[k];
        push({ sec:'Sources', kind:'source', label:name + (h.on ? '' : ' (connect)'), hint:h.on ? (h.text || 'Connected') : 'Not connected', icon:CMDK_ICON.plug, run:() => mgGo('connectors') }, 'connection connector source sync ' + k);
        if(h.on && ['zoho', 'tally', 'odoo'].includes(k)) push({ sec:'Sources', kind:'source', label:name + ' figures in the Ledger', hint:'View', icon:CMDK_ICON.chart, run:() => { mgGo('books'); mgSetSource('books', k); } }, k + ' ledger books figures entries');
      });
    } catch(e){}
    try {
      [['recv', 'Customer', 'owes you'], ['pay', 'Vendor', 'you owe']].forEach(([dir, who, verb]) => mgMoneyGroups(dir).forEach(g => push({
        sec:who + 's', kind:'party', dir, key:g.key, label:g.party, hint:verb + ' ' + fmtINR(g.amount, 'tile'), icon:CMDK_ICON.invoice,
        run:() => { mgGo(dir === 'recv' ? 'receivables' : 'payables'); setTimeout(() => mgOpenParty(dir, g.key), 60); }
      }, who.toLowerCase())));
    } catch(e){}
  }
  Object.keys(MG_NAV_ACTIONS).forEach(id => { const a = MG_NAV_ACTIONS[id]; push({ sec:'Actions', kind:'action', label:a.label, hint:'Run', icon:a.icon, run:a.run }, a.words); });
  const SEC = { Pages:0, Sources:1, Customers:2, Vendors:3, Actions:4 };
  return nq ? out.sort((a, b) => b.score - a.score || SEC[a.sec] - SEC[b.sec]) : out;
}
function cmdkBuild(q){
  const text = (q || '').trim();
  let items = mgSearch(text);
  if(!text) return items;
  // Drop stragglers that only share one loose word with a long query.
  const top = items.length ? items[0].score : 0;
  items = items.filter(i => i.score >= Math.max(30, top * 0.6)).slice(0, 9);
  // Group by section, sections ordered by their best hit, so Enter opens the best match.
  const order = [];
  items.forEach(i => { if(!order.includes(i.sec)) order.push(i.sec); });
  items = order.flatMap(s => items.filter(i => i.sec === s));
  if(text.length > 2){
    const ask = { sec:'Ask Margyn', label:'Ask: ' + text, icon:CMDK_ICON.ask, hint:'Ask', run:() => askFromPage(text) };
    // A question goes to Margyn first; a name or a word goes to the best match first.
    const question = /\?$|^(who|what|why|how|when|which|where|should|can|is|are|do|does|kya|kitna|kitni|kaun|kab|kyun|kaise)\b/i.test(text);
    if(question || !items.length || items[0].score < 50) items.unshift(ask); else items.push(ask);
  }
  return items;
}
/* ---------- the navigator (Jev): typed words -> a place, ~0.3 s, no Claude ----------
   Only when nothing matched by its own name (a page label or a customer scores
   72+); a loose synonym hit ("owes" ~ "owed" on Add a receivable) still asks Jev. The server holds the list of places
   (api/_lib/jevNav.js); all we send is the text, with known customer and
   vendor names swapped for PARTY first. Any failure just means no extra row. */
let mgNavModesP = null, mgNavOff = false;
const mgNavCache = new Map();
function mgNavModes(){
  if(!mgNavModesP) mgNavModesP = (async () => {
    try {
      const { data:{ session } } = await sbClient.auth.getSession();
      if(!session) return { nav:'off', panel:'off' };
      const r = await fetch('/api/ask-margyn?action=nav', { headers:{ 'Authorization':'Bearer ' + session.access_token } });
      const m = r.ok ? await r.json() : { nav:'off', panel:'off' };
      if(m.nav === 'off') mgNavOff = true;
      return m;
    } catch(e){ return { nav:'off', panel:'off' }; }
  })();
  return mgNavModesP;
}
function mgNavMask(text){
  let out = String(text || '');
  const names = new Set();
  try { ['recv', 'pay'].forEach(d => mgMoneyGroups(d).forEach(g => g.party && names.add(String(g.party)))); } catch(e){}
  try { (khataParties || []).forEach(p => p && p.name && names.add(String(p.name))); } catch(e){}
  [...names].filter(n => n.trim().length > 2).sort((a, b) => b.length - a.length).forEach(n => {
    out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'PARTY');
  });
  return out.slice(0, 200);
}
/* { place, placeConfidence, intent, intentConfidence, best, go, ... } or null. Never throws. */
async function mgNavPick(text, surface, claude){
  if(mgNavOff) return null;
  const q = mgNavMask(text).trim();
  if(q.length < 4) return null;
  const key = (surface || '') + '|' + q.toLowerCase() + '|' + (claude || '');
  if(!claude && mgNavCache.has(key)) return mgNavCache.get(key);
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    if(!session) return null;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch('/api/ask-margyn?action=nav', {
      method:'POST', signal:ctl.signal,
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + session.access_token },
      body:JSON.stringify({ q, surface:surface || 'palette', ...(claude ? { claude } : {}) })
    }).finally(() => clearTimeout(timer));
    if(!r.ok) return null;
    const out = await r.json();
    if(out.nav === 'off'){ mgNavOff = true; return null; }
    if(!out.place) return null;
    if(mgNavCache.size > 200) mgNavCache.clear();
    mgNavCache.set(key, out);
    return out;
  } catch(e){ return null; }
}
/* A Jev place id -> { label, say, run, icon }, or null if it isn't one we can open. */
function mgNavTarget(id){
  if(!id) return null;
  if(MG_NAV_ACTIONS[id]){ const a = MG_NAV_ACTIONS[id]; return { label:a.label, say:a.say || ('Opening ' + a.label + '.'), icon:a.icon, run:a.run }; }
  if(typeof MG_PAGES !== 'undefined' && MG_PAGES[id]){
    if(typeof mgPageAllowed === 'function' && !mgPageAllowed(id)) return null;
    const btn = document.querySelector('.pagenav button[data-view="' + id + '"]') || document.querySelector('.pagenav button[data-view="' + (MG_PAGES[id].parent || '') + '"]');
    const svg = btn && btn.querySelector('svg');
    return { label:MG_PAGES[id].label, say:'Opening ' + MG_PAGES[id].label + '.', icon:svg ? svg.outerHTML : '', run:() => mgGo(id) };
  }
  return null;
}
let cmdkNavTimer = null;
function cmdkNav(text){
  clearTimeout(cmdkNavTimer);
  text = (text || '').trim();
  if(mgNavOff || text.length <= 3) return;
  const top = cmdkCurrent.find(i => i.sec !== 'Ask Margyn');
  if(top && top.score >= 72) return;   // a page or name matched by its own label: the keywords found it
  cmdkNavTimer = setTimeout(async () => {
    await mgNavModes();
    const r = await mgNavPick(text, 'palette');
    const input = document.getElementById('cmdkInput');
    if(!r || !r.best || !input || input.value.trim() !== text) return;
    const t = mgNavTarget(r.best); if(!t) return;
    const row = { sec:'Best match', kind:'nav', label:t.label, hint:'Go', icon:t.icon, run:t.run };
    const rest = cmdkCurrent.filter(i => i.label !== t.label);
    // A clear question keeps "Ask" on top; otherwise Enter opens the best match.
    const askFirst = rest.length && rest[0].sec === 'Ask Margyn' && r.intent === 'ask' && r.intentConfidence >= 0.85;
    cmdkCurrent = askFirst ? [rest[0], row, ...rest.slice(1)] : [row, ...rest];
    cmdkIndex = 0; cmdkRender();
  }, 300);
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
  input.addEventListener('input', () => { cmdkIndex = 0; cmdkCurrent = cmdkBuild(input.value); cmdkRender(); cmdkNav(input.value); });
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
  // The reconciled receivables / payables position, computed on the server
  // over every open row (19-pages.js). Falls back to the local model if slow.
  if(typeof mgLoadPosition === 'function') await mgLoadPosition();
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
