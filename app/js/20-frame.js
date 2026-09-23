/* ============================================================
   APP FRAME (APP-UI-PROFESSIONAL-PLAN.md, agreed mock app-frame-mock.html):
   hash router, Scope bar, rail, shared page header, user menu, phone rail
   drawer, notifications, and mgConfirm() (replaces window.confirm()).

   Loaded last. It never changes what an existing page computes: it wraps
   showView() and a few render functions to keep the URL, rail and Scope bar
   in step, drives the existing in-page source/range tabs by clicking them,
   and shows the new pages from 19-pages.js.
   ============================================================ */

/* ---------- pages ----------
   key = the rail button's data-view. `own` pages live in 19-pages.js;
   `base` = the existing view showView() already knows. */
const MG_PAGES = {
  home:{ slug:'home', own:true, group:'Overview', label:'Home' },
  inbox:{ slug:'inbox', base:'agents', group:'Overview', label:'Inbox', sub:'Everything waiting on your decision: agent proposals, payments to confirm and forwarded documents. Nothing is applied until you approve it.' },
  payments:{ slug:'cash', base:'payments', group:'Money', label:'Cash', sub:'Settlements, fees and failed payments from your payment gateways.' },
  receivables:{ slug:'receivables', own:true, group:'Money', label:'Receivables' },
  payables:{ slug:'payables', own:true, group:'Money', label:'Payables' },
  gst:{ slug:'gst', own:true, group:'Money', label:'GST and tax' },
  books:{ slug:'ledger', base:'books', group:'Money', label:'Ledger', sub:'Every accounting source, side by side. Sources are compared, never added together.' },
  invoicing:{ slug:'invoicing', base:'invoicing', group:'Money', label:'Invoicing' },
  calculate:{ slug:'import', base:'calculate', group:'Money', label:'Import' },
  customers:{ slug:'customers', own:true, group:'Parties', label:'Customers' },
  vendors:{ slug:'vendors', own:true, group:'Parties', label:'Vendors' },
  analytics:{ slug:'reports', base:'analytics', group:'Insight', label:'Reports', sub:'Charts you define, computed from connected data. Nothing here moves your Pulse Score.' },
  scores:{ slug:'pulse', base:'scores', group:'Insight', label:'Pulse Score', sub:'Every point is arithmetic on your own figures. The AI writes the briefing; it never touches the score.' },
  history:{ slug:'ask', base:'history', group:'Insight', label:'Ask Margyn', sub:'Answers from your connected data. When Margyn doesn’t know, it says so.' },
  agents:{ slug:'agents', base:'agents', group:'Automation', label:'Agents', sub:'Automations that work on your data. They propose; you approve.' },
  connectors:{ slug:'sources', base:'connectors', group:'Admin', label:'Organisations and sources', sub:'The systems Margyn reads from. Connect, reconnect or disconnect each one here.' },
  people:{ slug:'people', base:'settings', group:'Admin', label:'People and roles', sub:'Who can message Margyn on WhatsApp, get the Bells, and act on your behalf.' },
  settings:{ slug:'settings', base:'settings', group:'Admin', label:'Settings', sub:'Notifications, scoring labels and account controls.' },
  audit:{ slug:'audit', own:true, group:'Admin', label:'Audit log' },
  financing:{ slug:'financing', base:'financing', group:'Insight', label:'Capital readiness', sub:'An indicative working-capital view built from your own figures. Margyn is not a lender.' },
  profile:{ slug:'profile', base:'profile', group:'Account', label:'Profile' }
};
const MG_BY_SLUG = Object.fromEntries(Object.entries(MG_PAGES).map(([k, p]) => [p.slug, k]));
const MG_OWN = Object.keys(MG_PAGES).filter(k => MG_PAGES[k].own);
const MG_MONEY = { receivables:'recv', payables:'pay', customers:'recv', vendors:'pay' };
// Existing pages whose header gets a scope line.
const MG_DATA_VIEWS = ['scores', 'payments', 'books', 'analytics'];

/* ---------- sources ---------- */
const MG_SRC = {   // existing pages that already filter by source (driven by clicking their own tabs)
  payments:{ tabs:'#paymentsSourceTabs', get:() => paymentsActiveSource },
  books:{ tabs:'#booksSourceTabs', get:() => booksActiveSource }
};
const MG_SRC_LABEL = { all:'All sources', razorpay:'Razorpay', cashfree:'Cashfree', zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', manual:'Manual entries', shopify:'Shopify' };
function mgSourceHealth(key){
  // { on, text, warn } for a source key; reads connector globals only.
  const ago = iso => {
    if(!iso) return null;
    const h = (Date.now() - new Date(iso).getTime()) / 3600000;
    if(!(h >= 0)) return null;
    return h < 1 ? 'synced just now' : h < 48 ? 'synced ' + Math.round(h) + 'h ago' : 'last synced ' + Math.round(h / 24) + 'd ago';
  };
  const stale = iso => !!iso && (Date.now() - new Date(iso).getTime()) > 48 * 3600000;
  try {
    if(key === 'razorpay'){ if(!razorpayConnected) return { on:false, text:'Not connected' };
      const t = (razorpayStatus && razorpayStatus.last_success_at) || lastSyncedAt;
      return razorpayStatus && razorpayStatus.needs_reauth ? { on:true, text:'Reconnect needed', warn:true } : { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'cashfree'){ if(!cashfreeConnected) return { on:false, text:'Not connected' };
      const t = cashfreeStatus && cashfreeStatus.last_success_at;
      return cashfreeStatus && cashfreeStatus.needs_reauth ? { on:true, text:'Reconnect needed', warn:true } : { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'zoho'){ if(!zohoConnected) return { on:false, text:'Not connected' };
      const t = zohoVitals && zohoVitals.last_synced_at; return { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'tally'){ if(!tallyConnected) return { on:false, text:'Not connected' };
      const t = (tallyInstalls || []).map(i => i.last_sync_at).filter(Boolean).sort().pop(); return { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'odoo'){ if(!odooConnected) return { on:false, text:'Not connected' };
      const t = odooStatus && odooStatus.last_success_at;
      return odooStatus && odooStatus.needs_reauth ? { on:true, text:'Reconnect needed', warn:true } : { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'shopify'){ if(!shopifyConnected) return { on:false, text:'Not connected' };
      const t = shopifyStore && shopifyStore.last_synced_at; return { on:true, text:ago(t) || 'Connected', warn:stale(t) }; }
    if(key === 'manual') return { on:true, text:'Entered by you' };
  } catch(e){ /* globals not ready yet */ }
  return { on:false, text:'' };
}
function mgSourceOptions(page){
  const cfg = MG_SRC[page]; if(!cfg) return [];
  return [...document.querySelectorAll(cfg.tabs + ' button[data-src]')].map(b => ({ key:b.dataset.src, label:MG_SRC_LABEL[b.dataset.src] || b.textContent.trim() }));
}
function mgCurrentSource(page){
  if(MG_MONEY[page]) return mgMoneySrc;
  const cfg = MG_SRC[page]; if(!cfg) return null;
  try { return cfg.get(); } catch(e){ return 'all'; }
}
function mgSetSource(page, key){
  if(MG_MONEY[page]){
    mgMoneySrc = key; mgMoneyAge = null;
    // Party pages are one row per party: Compare / a single source opens the money page.
    if((page === 'customers' || page === 'vendors') && key !== 'reconciled'){ mgGo(page === 'customers' ? 'receivables' : 'payables'); return; }
    mgRenderOwn(page); mgRefreshScope(); mgWriteHash(false); return;
  }
  const cfg = MG_SRC[page]; if(!cfg) return;
  const b = document.querySelector(cfg.tabs + ' button[data-src="' + key + '"]');
  if(b) b.click(); // the page's own handler sets its state and re-renders
}

/* ---------- period: only Reports has a range today ---------- */
const MG_RANGE_LABEL = { '1m':'Last month', '1q':'Last quarter', '1y':'Last year', 'max':'All time' };
function mgRangeOptions(){ return [...document.querySelectorAll('#analyticsRangeTabs button[data-range]')].map(b => ({ key:b.dataset.range, label:MG_RANGE_LABEL[b.dataset.range] || b.textContent.trim() })); }
function mgSetRange(key){ const b = document.querySelector('#analyticsRangeTabs button[data-range="' + key + '"]'); if(b) b.click(); }
function mgAsOf(){
  try {
    const s = snapshots && snapshots[0];
    if(!s) return 'No data yet';
    return 'As of ' + new Date(s.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  } catch(e){ return 'Latest'; }
}

/* ---------- organisations found in connected books (read-only until multi-org) ---------- */
function mgEntities(){
  const map = new Map();
  const add = (name, src) => {
    if(!name) return;
    const k = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
    if(!map.has(k)) map.set(k, { name:String(name).trim(), sources:new Set() });
    map.get(k).sources.add(src);
  };
  try { if(zohoConnected && zohoVitals) add(zohoVitals.organization_name, 'Zoho Books'); } catch(e){}
  try { (tallyInstalls || []).filter(i => i.status === 'active').forEach(i => add(i.company_name, 'Tally')); } catch(e){}
  try { if(odooConnected && odooStatus) add(odooStatus.db || odooStatus.instance, 'Odoo'); } catch(e){}
  return [...map.values()];
}
function mgOrgName(){ return (typeof currentProfile !== 'undefined' && currentProfile && currentProfile.company_name) || 'Your business'; }
function mgOrgShort(){ return mgOrgName().replace(/\s+(Private Limited|Pvt\.? Ltd\.?|Limited|Ltd\.?|LLP)$/i, ''); }

/* ---------- state ---------- */
let mgCurrentView = 'home';
let mgApplying = false;       // true while the router itself is navigating
let mgFirstLoadDone = false;  // set once the first refreshAll() after login has applied the URL

/* ---------- Scope bar + page header ---------- */
function mgScopeParts(page){
  let srcLabel = 'Reconciled', enabled = false, warn = false;
  const perLabel = page === 'analytics' ? (MG_RANGE_LABEL[analyticsRange] || analyticsRange) : mgAsOf();
  if(MG_MONEY[page]){
    enabled = true;
    const m = mgMoneySrc;
    srcLabel = m === 'reconciled' ? 'Reconciled' : m === 'compare' ? 'Compare' : (MG_SRC_NAME[m] || m);
  } else if(MG_SRC[page]){
    const opts = mgSourceOptions(page);
    if(opts.length){ enabled = true; srcLabel = MG_SRC_LABEL[mgCurrentSource(page)] || mgCurrentSource(page); }
  } else if(page === 'home'){ enabled = true; }
  ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo', 'shopify'].forEach(k => { const h = mgSourceHealth(k); if(h.on && h.warn) warn = true; });
  return { srcLabel, perLabel, enabled, warn };
}
const MG_TICK = '<svg class="mg-tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
function mgOptHtml(attr, key, label, sub, meta, sel, warnMeta, logo){
  return '<button class="mg-opt' + (sel ? ' sel' : '') + '" type="button" role="menuitemradio" aria-checked="' + (sel ? 'true' : 'false') + '" ' + attr + '="' + escapeHtml(key) + '">' +
    (logo || '') + '<span>' + escapeHtml(label) + (sub ? '<span class="mg-sub">' + escapeHtml(sub) + '</span>' : '') + '</span>' +
    (meta ? '<span class="mg-meta"' + (warnMeta ? ' style="color:var(--warn)"' : '') + '>' + escapeHtml(meta) + '</span>' : '') + (sel ? MG_TICK : '') + '</button>';
}
function mgHealthRow(k){
  const h = mgSourceHealth(k);
  return '<div class="mg-opt mg-static">' + mgLogo(k) + '<span>' + escapeHtml(MG_SRC_LABEL[k]) + '</span><span class="mg-meta"' + (h.warn ? ' style="color:var(--warn)"' : '') + '>' + escapeHtml(h.text) + '</span></div>';
}
function mgSourcesMenu(page){
  if(MG_MONEY[page]){
    const dir = MG_MONEY[page], cur = mgMoneySrc;
    return '<h6>How to view the data</h6>' +
      mgOptHtml('data-mg-src', 'reconciled', 'Reconciled', 'Each ' + (dir === 'recv' ? 'customer' : 'vendor') + ' once, with an agreement badge', '', cur === 'reconciled') +
      mgOptHtml('data-mg-src', 'compare', 'Compare', 'Source against source, side by side', '', cur === 'compare') +
      '<div class="mg-sep"></div><h6>Single source</h6>' +
      (mgMoneySources(dir).map(k => mgOptHtml('data-mg-src', k, MG_SRC_NAME[k], '', mgSourceHealth(k).text, cur === k, mgSourceHealth(k).warn, mgLogo(k))).join('') || '<div class="mg-note">No source has open items yet.</div>');
  }
  if(MG_SRC[page]){
    const cur = mgCurrentSource(page);
    return '<h6>Sources on ' + escapeHtml(MG_PAGES[page].label) + '</h6>' + mgSourceOptions(page).map(o =>
      mgOptHtml('data-mg-src', o.key, o.label, '', o.key === 'all' ? 'Side by side' : mgSourceHealth(o.key).text, o.key === cur, mgSourceHealth(o.key).warn, o.key === 'all' ? '' : mgLogo(o.key))).join('');
  }
  const live = ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'].filter(k => mgSourceHealth(k).on);
  return '<h6>How to view the data</h6><div class="mg-note">' + escapeHtml(MG_PAGES[page] ? MG_PAGES[page].label : 'This page') +
    ' shows Margyn’s reconciled view: each figure from the most trusted source, with disagreements flagged. Pick a single source or Compare on Receivables, Payables, Cash or Ledger.</div>' +
    (live.length ? '<div class="mg-sep"></div><h6>Your sources</h6>' + live.map(mgHealthRow).join('') : '');
}
function mgPeriodMenu(page, p){
  if(page !== 'analytics') return '<h6>Period</h6><div class="mg-note">' + escapeHtml(p.perLabel) + '. This page shows your latest figures. Reports lets you pick a range.</div>';
  return '<h6>Period</h6>' + mgRangeOptions().map(o => mgOptHtml('data-mg-range', o.key, o.label, '', '', o.key === analyticsRange)).join('');
}
function mgEntitiesHtml(){
  const ents = mgEntities();
  if(!ents.length) return '';
  return '<div class="osm-divider"></div><div class="osm-label">Found in your connected books</div>' +
    ents.map(e => '<div class="mg-ent"><span>' + escapeHtml(e.name) + '<span class="mg-sub">' + escapeHtml([...e.sources].join(', ')) + '</span></span></div>').join('');
}
function mgRefreshScope(){
  const page = mgCurrentView;
  const p = mgScopeParts(page);
  const set = (id, fn) => { const el = document.getElementById(id); if(el) fn(el); };
  set('mgSrcVal', el => el.textContent = p.srcLabel);
  set('mgSrcBtn', el => { el.disabled = !p.enabled; el.title = p.enabled ? '' : 'This page always shows the reconciled view'; });
  set('mgSrcDot', el => el.classList.toggle('warn', p.warn));
  set('mgSrcPop', el => el.innerHTML = mgSourcesMenu(page));
  set('mgPerVal', el => el.textContent = p.perLabel);
  set('mgPerBtn', el => { el.disabled = page !== 'analytics'; el.title = page === 'analytics' ? '' : 'This page shows your latest figures'; });
  set('mgPerPop', el => el.innerHTML = mgPeriodMenu(page, p));
  set('mgOrgEntities', el => el.innerHTML = mgEntitiesHtml());
  set('orgSwitchName', el => el.textContent = mgOrgShort());
  set('mgScopeCompactVal', el => el.textContent = mgOrgShort() + ' · ' + p.srcLabel + ' · ' + p.perLabel);
  set('mgScopeCompactDot', el => el.classList.toggle('warn', p.warn));
  set('mgScopeCompactPop', el => el.innerHTML =
    '<h6>Organisation</h6><div class="mg-ent"><span><b>' + escapeHtml(mgOrgName()) + '</b><span class="mg-sub">Switching between organisations comes with multi-organisation support.</span></span></div>' +
    mgEntitiesHtml().replace('<div class="osm-divider"></div>', '<div class="mg-sep"></div>').replace('class="osm-label"', 'class="mg-note"') +
    '<div class="mg-sep"></div>' + mgSourcesMenu(page) + '<div class="mg-sep"></div>' + mgPeriodMenu(page, p));
  mgRenderPageHead(page, p);
  mgRenderUser();
  mgRenderNotifications();
}
function mgRenderPageHead(page, p){
  const P = MG_PAGES[page]; if(!P || P.own) return;
  const root = document.getElementById('view-' + P.base);
  const head = root && root.querySelector('.rd-head');
  if(!head) return;
  // Breadcrumb + page title, same recipe as the new pages. Titles with an id
  // are live (e.g. "Why your Pulse Score is 59") and are left alone; only the
  // first text node changes so inline badges inside the h1 survive.
  // Inbox and Agents share the agents view: Inbox is the queue only, Agents the roster and conversations.
  if(P.base === 'agents'){
    root.classList.toggle('mg-is-inbox', page === 'inbox'); root.classList.toggle('mg-is-agents', page === 'agents');
  }
  const sub = head.querySelector('.rd-sub');
  if(sub && P.sub) sub.textContent = P.sub;
  const eb = head.querySelector('.rd-eyebrow');
  if(eb && !eb.id) eb.textContent = mgOrgShort() + ' / ' + P.group;
  const h1 = head.querySelector('h1');
  if(h1 && !h1.id){ const tn = [...h1.childNodes].find(n => n.nodeType === 3); if(tn) tn.data = P.label + ' '; }
  if(page === 'analytics' && !head.querySelector('[data-go-page="financing"]')){
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mg-btn'; b.dataset.goPage = 'financing'; b.textContent = 'Capital readiness';
    (head.lastElementChild !== head.firstElementChild ? head.lastElementChild : head).appendChild(b);
  }
  let line = head.querySelector('.mg-scopeline');
  if(!MG_DATA_VIEWS.includes(P.base)){ if(line) line.remove(); return; }
  if(!line){ line = document.createElement('div'); line.className = 'mg-scopeline'; (head.firstElementChild || head).appendChild(line); }
  line.textContent = mgOrgShort() + ' · ' + p.srcLabel + ' · ' + p.perLabel;
}
function mgRenderUser(){
  const nameEl = document.getElementById('mgUserName'); if(!nameEl) return;
  let who = '';
  try { const me = (agentStakeholders || []).find(x => x.is_primary && x.name); if(me) who = me.name; } catch(e){}
  if(!who){ try { who = (typeof lsGet === 'function' && lsGet('margyn_owner_name')) || ''; } catch(e){} }
  nameEl.textContent = who || mgOrgName();
  const av = document.getElementById('topAvatar');
  if(av && who) av.textContent = who.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

/* ---------- navigation ---------- */
function mgGo(pageOrSlug){ const k = MG_PAGES[pageOrSlug] ? pageOrSlug : MG_BY_SLUG[pageOrSlug]; if(k) showView(k); }
const mgBaseShowView = showView;
showView = function(name){
  let page = name === 'summary' ? 'home' : name === 'ledger' ? 'books' : name;
  const P = MG_PAGES[page];
  MG_OWN.forEach(k => { const el = document.getElementById('view-' + k); if(el) el.classList.add('hidden'); });
  if(!P){ mgBaseShowView(name); }
  else if(P.own){
    mgBaseShowView(page);   // hides every existing view; no existing view has this name
    const el = document.getElementById('view-' + page);
    if(el){ el.classList.remove('hidden', 'rd-fade'); void el.offsetWidth; el.classList.add('rd-fade'); }
    mgRenderOwn(page);
  } else {
    if(page === 'inbox') agentsActiveTab = 'queue';
    mgBaseShowView(name === 'ledger' ? 'ledger' : P.base);
    // Code that opens the Agents page on its queue lands on Inbox.
    if(page === 'agents' && agentsActiveTab === 'queue') page = 'inbox';
    if(page === 'people') setTimeout(() => { const m = document.getElementById('setPeopleMount'); if(m) m.scrollIntoView({ block:'start' }); }, 60);
  }
  document.querySelectorAll('.pagenav button').forEach(b => b.classList.toggle('active', b.dataset.view === page));
  const changed = page !== mgCurrentView;
  mgCurrentView = page;
  mgCloseRail(); mgCloseAllPops(); mgRefreshScope();
  if(!mgApplying) mgWriteHash(changed);
};
// The rail's Agents item opens the roster; Inbox opens the queue.
(function(){ const b = document.querySelector('.pagenav button[data-view="agents"]'); if(b) b.addEventListener('click', () => { agentsActiveTab = 'roster'; }, true); })();
['renderBooksHub', 'applyPaymentsSource', 'renderAnalyticsView'].forEach(fn => {
  const base = window[fn]; if(typeof base !== 'function') return;
  window[fn] = function(){
    const out = base.apply(this, arguments);
    mgRefreshScope();
    if(!mgApplying) mgWriteHash(false);
    return out;
  };
});

/* ---------- router: #/page?src=&period= ---------- */
function mgParseHash(){
  const m = /^#\/([\w-]+)(?:\?(.*))?$/.exec(location.hash || '');
  if(!m) return null;
  const q = new URLSearchParams(m[2] || '');
  return { slug:m[1], src:q.get('src'), period:q.get('period') };
}
function mgHashFor(page){
  const P = MG_PAGES[page]; if(!P) return null;
  const q = new URLSearchParams();
  const src = mgCurrentSource(page);
  if(src && src !== 'all' && src !== 'reconciled') q.set('src', src);
  if(page === 'analytics' && typeof analyticsRange !== 'undefined' && analyticsRange !== '1q') q.set('period', analyticsRange);
  const qs = q.toString();
  return '#/' + P.slug + (qs ? '?' + qs : '');
}
function mgWriteHash(push){
  if((location.hash || '').indexOf('zoho=') !== -1) return;   // Zoho org-select callback owns the hash
  // Signed out (sign-in screen showing): keep the link the visitor arrived on.
  const shell = document.getElementById('appShell');
  if(shell && shell.classList.contains('hidden')) return;
  // Until the first data load has applied the URL, renders must not overwrite it.
  if(!mgFirstLoadDone) return;
  const h = mgHashFor(mgCurrentView); if(!h || location.hash === h) return;
  history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + location.search + h);
}
function mgApplyRoute(){
  const r = mgParseHash(); if(!r) return false;
  const page = MG_BY_SLUG[r.slug]; if(!page) return false;
  mgApplying = true;
  try {
    if(MG_MONEY[page]) mgMoneySrc = r.src || 'reconciled';
    if(page === 'agents') agentsActiveTab = 'roster';
    showView(page);
    if(MG_SRC[page]){
      const want = r.src || 'all';
      if(mgSourceOptions(page).some(o => o.key === want) && mgCurrentSource(page) !== want) mgSetSource(page, want);
    }
    if(page === 'analytics'){
      const want = r.period || '1q';
      if(mgRangeOptions().some(o => o.key === want) && analyticsRange !== want) mgSetRange(want);
    }
  } finally { mgApplying = false; }
  mgRefreshScope();
  return true;
}
// First data load after login: re-apply the URL so the page it names renders
// with real data; later loads keep the URL on the page actually shown.
const mgBaseRefreshAll = refreshAll;
refreshAll = async function(){
  const out = await mgBaseRefreshAll.apply(this, arguments);
  if(!mgFirstLoadDone){ mgFirstLoadDone = true; if(!mgApplyRoute()){ showView(mgCurrentView); mgWriteHash(false); } }
  else { if(MG_PAGES[mgCurrentView] && MG_PAGES[mgCurrentView].own) mgRenderOwn(mgCurrentView); mgWriteHash(false); }
  mgRefreshScope();
  return out;
};
window.addEventListener('popstate', () => { mgApplyRoute(); });

/* ---------- popovers, user menu, notifications, phone rail ---------- */
const MG_POPS = [['mgSrcBtn', 'mgSrcPop'], ['mgPerBtn', 'mgPerPop'], ['mgScopeCompactBtn', 'mgScopeCompactPop'], ['topAvatar', 'mgUserPop'], ['mgBellBtn', 'mgBellPop']];
function mgCloseAllPops(except){
  MG_POPS.forEach(([b, p]) => {
    if(p === except) return;
    const pop = document.getElementById(p), btn = document.getElementById(b);
    if(pop) pop.classList.remove('open'); if(btn) btn.setAttribute('aria-expanded', 'false');
  });
}
MG_POPS.forEach(([b, p]) => {
  const btn = document.getElementById(b), pop = document.getElementById(p);
  if(!btn || !pop) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    mgCloseAllPops(p);
    const org = document.getElementById('orgSwitch'); if(org) org.classList.remove('open');
    const open = pop.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  pop.addEventListener('click', e => {
    const s = e.target.closest('[data-mg-src]'), r = e.target.closest('[data-mg-range]'), go = e.target.closest('[data-go]');
    if(s){ mgCloseAllPops(); mgSetSource(mgCurrentView, s.dataset.mgSrc); }
    else if(r){ mgCloseAllPops(); mgSetRange(r.dataset.mgRange); }
    else if(go){ mgCloseAllPops(); mgGo(go.dataset.go); }
    e.stopPropagation();
  });
});
document.addEventListener('click', e => { if(!e.target.closest('.mg-pop')) mgCloseAllPops(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape'){ mgCloseAllPops(); mgCloseRail(); } });
document.querySelectorAll('nav.mg-top [data-go]').forEach(b => {
  if(b.closest('.mg-pop')) return; // menu items are handled by their popover
  b.addEventListener('click', () => mgGo(b.dataset.go));
});
function mgCloseRail(){
  document.body.classList.remove('mg-rail-open');
  const b = document.getElementById('mgMenuBtn'); if(b) b.setAttribute('aria-expanded', 'false');
}
(function wireRail(){
  const btn = document.getElementById('mgMenuBtn'), scrim = document.getElementById('mgRailScrim');
  if(btn) btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = document.body.classList.toggle('mg-rail-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  if(scrim) scrim.addEventListener('click', mgCloseRail);
})();

/* ---------- dialog: replaces window.confirm() ----------
   mgConfirm({ title, body, confirmLabel, danger, effect:[[label, value]], tick })
   resolves true only on an explicit confirm. `tick` adds a checkbox that must
   be ticked first (for destructive or consent-bearing actions). */
function mgConfirm(o){
  o = o || {};
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'mg-dialog-scrim';
    scrim.innerHTML =
      '<div class="mg-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mgDlgTitle" aria-describedby="mgDlgBody">' +
        '<h3 id="mgDlgTitle">' + escapeHtml(o.title || 'Are you sure?') + '</h3>' +
        (o.body ? '<p id="mgDlgBody">' + escapeHtml(o.body) + '</p>' : '') +
        (o.effect && o.effect.length ? '<div class="mg-effect">' + o.effect.map(([k, v]) => '<div><span>' + escapeHtml(k) + '</span><b>' + escapeHtml(v) + '</b></div>').join('') + '</div>' : '') +
        (o.tick ? '<label><input type="checkbox" class="mg-dlg-tick"> <span>' + escapeHtml(o.tick) + '</span></label>' : '') +
        '<div class="mg-foot"><button class="mg-btn mg-dlg-cancel" type="button">' + escapeHtml(o.cancelLabel || 'Cancel') + '</button>' +
        '<button class="mg-btn ' + (o.danger ? 'danger' : 'primary') + ' mg-dlg-ok" type="button"' + (o.tick ? ' disabled' : '') + '>' + escapeHtml(o.confirmLabel || 'Confirm') + '</button></div>' +
      '</div>';
    document.body.appendChild(scrim);
    const ok = scrim.querySelector('.mg-dlg-ok'), cancel = scrim.querySelector('.mg-dlg-cancel'), tick = scrim.querySelector('.mg-dlg-tick');
    const done = v => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if(prevFocus && prevFocus.focus) prevFocus.focus(); resolve(v); };
    const onKey = e => {
      if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); done(false); }
      if(e.key === 'Tab'){ // keep focus inside the dialog
        const f = [...scrim.querySelectorAll('button:not(:disabled), input')];
        const i = f.indexOf(document.activeElement);
        if(e.shiftKey && i <= 0){ e.preventDefault(); f[f.length - 1].focus(); }
        else if(!e.shiftKey && i === f.length - 1){ e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    if(tick) tick.addEventListener('change', () => { ok.disabled = !tick.checked; });
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    scrim.addEventListener('click', e => { if(e.target === scrim) done(false); });
    (tick || cancel).focus();
  });
}

/* ---------- lakh/crore on older tiles ----------
   Pages still rendered by the original code print full figures in their
   tiles. Tiles show lakh/crore; the exact figure stays in the tooltip and in
   data-mg-full (which "Ask Margyn about this" reads). Tables are untouched. */
const MG_TILE_SEL = '.pay-card .pc-value, .rd-strip .v, .fact .f-value';
function mgTileify(){
  document.querySelectorAll(MG_TILE_SEL).forEach(el => {
    const txt = el.textContent.trim();
    const m = /^([+\-−]?)₹\s?([\d,]+)$/.exec(txt);
    if(!m) return;
    const n = Number(m[2].replace(/,/g, ''));
    if(!(n >= 1e5)) return;
    el.dataset.mgFull = txt; el.title = txt;
    el.textContent = (m[1] === '+' ? '+' : '') + fmtINR((m[1] && m[1] !== '+' ? -1 : 1) * n, 'tile');
  });
}
let mgTileQueued = false;
new MutationObserver(() => {
  if(mgTileQueued) return; mgTileQueued = true;
  requestAnimationFrame(() => { mgTileQueued = false; mgTileify(); });
}).observe(document.querySelector('.app-body') || document.body, { childList:true, subtree:true, characterData:true });

/* ---------- boot ---------- */
if(!mgApplyRoute()) showView('home');
