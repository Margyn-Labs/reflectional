/* ============================================================
   APP FRAME (Phase 1 of APP-UI-PROFESSIONAL-PLAN.md): hash router,
   Scope bar, shared page header, user menu, phone rail drawer, and the
   mgConfirm() dialog that replaces window.confirm().

   Loaded last. It never changes what a page computes: it wraps
   showView() and a few render functions to keep the URL and the Scope
   bar in step, and drives the existing in-page source/range tabs by
   clicking them, so every page keeps its own logic.
   ============================================================ */

/* ---------- pages ---------- */
// URL slug -> existing view name (showView/data-view names are unchanged)
const MG_ROUTES = {
  home:'summary', payments:'payments', books:'books', invoicing:'invoicing',
  reports:'analytics', pulse:'scores', ask:'history', agents:'agents',
  sources:'connectors', financing:'financing', settings:'settings',
  profile:'profile', import:'calculate'
};
const MG_SLUG = Object.fromEntries(Object.entries(MG_ROUTES).map(([s, v]) => [v, s]));
const MG_PAGE = {
  summary:{ group:'Overview', label:'Home' },
  payments:{ group:'Money', label:'Payments' }, books:{ group:'Money', label:'Books' },
  invoicing:{ group:'Money', label:'Invoicing' }, calculate:{ group:'Money', label:'Import' },
  analytics:{ group:'Insight', label:'Reports' }, scores:{ group:'Insight', label:'Pulse Score' },
  history:{ group:'Insight', label:'Ask Margyn' }, agents:{ group:'Automation', label:'Agents' },
  connectors:{ group:'Admin', label:'Sources' }, financing:{ group:'Admin', label:'Financing' },
  settings:{ group:'Admin', label:'Settings' }, profile:{ group:'Account', label:'Profile' }
};
// Pages whose numbers carry a scope line (plan §2: "every KPI tile and report").
const MG_DATA_VIEWS = ['summary', 'scores', 'payments', 'books', 'analytics'];

/* ---------- sources: only where the page can already filter by source ---------- */
const MG_SRC = {
  payments:{ tabs:'#paymentsSourceTabs', get:() => paymentsActiveSource },
  books:{ tabs:'#booksSourceTabs', get:() => booksActiveSource }
};
const MG_SRC_LABEL = { all:'All sources', razorpay:'Razorpay', cashfree:'Cashfree', zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', manual:'Manual entries', shopify:'Shopify' };
function mgSourceHealth(key){
  // { on:boolean, text, warn } for a source key; reads connector globals only.
  const ago = iso => {
    if(!iso) return null;
    const h = (Date.now() - new Date(iso).getTime()) / 3600000;
    if(!(h >= 0)) return null;
    return h < 1 ? 'synced just now' : h < 48 ? 'synced ' + Math.round(h) + 'h ago' : 'last synced ' + Math.round(h / 24) + 'd ago';
  };
  const stale = iso => iso && (Date.now() - new Date(iso).getTime()) > 48 * 3600000;
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
    if(key === 'manual') return { on:true, text:'Entered by you' };
  } catch(e){ /* globals not ready yet */ }
  return { on:true, text:'' };
}
function mgSourceOptions(view){
  const cfg = MG_SRC[view]; if(!cfg) return [];
  return [...document.querySelectorAll(cfg.tabs + ' button[data-src]')].map(b => ({ key:b.dataset.src, label:MG_SRC_LABEL[b.dataset.src] || b.textContent.trim() }));
}
function mgCurrentSource(view){ const cfg = MG_SRC[view]; if(!cfg) return null; try { return cfg.get(); } catch(e){ return 'all'; } }
function mgSetSource(view, key){
  const cfg = MG_SRC[view]; if(!cfg) return;
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

/* ---------- organisations found in connected books (read-only, Phase A) ---------- */
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
let mgCurrentView = 'summary';
let mgApplying = false;   // true while the router itself is navigating
let mgFirstLoadDone = false; // set once the first refreshAll() after login has applied the URL

/* ---------- rendering the Scope bar + page header ---------- */
function mgScopeParts(view){
  const srcOpts = mgSourceOptions(view);
  const src = mgCurrentSource(view);
  const srcLabel = srcOpts.length ? (MG_SRC_LABEL[src] || src) : 'Reconciled';
  const perLabel = view === 'analytics' ? (MG_RANGE_LABEL[analyticsRange] || analyticsRange) : mgAsOf();
  let warn = false;
  srcOpts.forEach(o => { if(o.key !== 'all' && mgSourceHealth(o.key).warn) warn = true; });
  return { srcOpts, src, srcLabel, perLabel, warn };
}
function mgOptHtml(attr, key, label, sub, meta, sel, warnMeta){
  return '<button class="mg-opt' + (sel ? ' sel' : '') + '" type="button" role="menuitemradio" aria-checked="' + (sel ? 'true' : 'false') + '" ' + attr + '="' + escapeHtml(key) + '">' +
    '<span>' + escapeHtml(label) + (sub ? '<span class="mg-sub">' + escapeHtml(sub) + '</span>' : '') + '</span>' +
    (meta ? '<span class="mg-meta"' + (warnMeta ? ' style="color:var(--warn)"' : '') + '>' + escapeHtml(meta) + '</span>' : '') +
    '<svg class="mg-tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>';
}
function mgSourcesMenu(view, p){
  if(!p.srcOpts.length){
    return '<h6>Sources</h6><div class="mg-note">' + escapeHtml(MG_PAGE[view] ? MG_PAGE[view].label : 'This page') +
      ' uses Margyn’s reconciled view: each figure from the best source available, with conflicts flagged. Pick a single source on Payments or Books.</div>';
  }
  return '<h6>Sources on ' + escapeHtml(MG_PAGE[view].label) + '</h6>' + p.srcOpts.map(o => {
    const h = o.key === 'all' ? { text:'Side by side' } : mgSourceHealth(o.key);
    return mgOptHtml('data-mg-src', o.key, o.label, '', h.text, o.key === p.src, h.warn);
  }).join('');
}
function mgPeriodMenu(view, p){
  if(view !== 'analytics'){
    return '<h6>Period</h6><div class="mg-note">' + escapeHtml(p.perLabel) + '. This page shows your latest figures. Reports lets you pick a range.</div>';
  }
  return '<h6>Period</h6>' + mgRangeOptions().map(o => mgOptHtml('data-mg-range', o.key, o.label, '', '', o.key === analyticsRange)).join('');
}
function mgEntitiesHtml(){
  const ents = mgEntities();
  if(!ents.length) return '';
  return '<div class="osm-divider"></div><div class="osm-label">Found in your connected books</div>' +
    ents.map(e => '<div class="mg-ent"><span>' + escapeHtml(e.name) + '<span class="mg-sub">' + escapeHtml([...e.sources].join(', ')) + '</span></span></div>').join('');
}
function mgRefreshScope(){
  const view = mgCurrentView;
  const p = mgScopeParts(view);
  const hasSrc = p.srcOpts.length > 0, hasPer = view === 'analytics';
  const set = (id, fn) => { const el = document.getElementById(id); if(el) fn(el); };
  set('mgSrcVal', el => el.textContent = p.srcLabel);
  set('mgSrcBtn', el => { el.disabled = !hasSrc; el.title = hasSrc ? '' : 'This page always shows the reconciled view'; });
  set('mgSrcDot', el => { el.classList.toggle('warn', p.warn); });
  set('mgSrcPop', el => el.innerHTML = mgSourcesMenu(view, p));
  set('mgPerVal', el => el.textContent = p.perLabel);
  set('mgPerBtn', el => { el.disabled = !hasPer; el.title = hasPer ? '' : 'This page shows your latest figures'; });
  set('mgPerPop', el => el.innerHTML = mgPeriodMenu(view, p));
  set('mgOrgEntities', el => el.innerHTML = mgEntitiesHtml());
  set('mgScopeCompactVal', el => el.textContent = mgOrgShort() + ' · ' + p.srcLabel + (MG_DATA_VIEWS.includes(view) ? ' · ' + p.perLabel : ''));
  set('mgScopeCompactDot', el => el.classList.toggle('warn', p.warn));
  set('mgScopeCompactPop', el => el.innerHTML =
    '<h6>Organisation</h6><div class="mg-ent"><span><b>' + escapeHtml(mgOrgName()) + '</b><span class="mg-sub">Switching between organisations comes with multi-organisation support.</span></span></div>' +
    mgEntitiesHtml().replace('<div class="osm-divider"></div>', '<div class="mg-sep"></div>').replace('class="osm-label"', 'class="mg-note"') +
    '<div class="mg-sep"></div>' + mgSourcesMenu(view, p) + '<div class="mg-sep"></div>' + mgPeriodMenu(view, p));
  mgRenderPageHead(view, p);
  mgRenderUser();
}
function mgRenderPageHead(view, p){
  const root = document.getElementById('view-' + view);
  const head = root && root.querySelector('.rd-head');
  if(!head) return;
  const meta = MG_PAGE[view];
  const eb = head.querySelector('.rd-eyebrow');
  // Breadcrumb in the eyebrow slot. Home keeps its live greeting (it has an id).
  if(eb && !eb.id && meta && view !== 'summary') eb.textContent = meta.group + ' / ' + meta.label;
  let line = head.querySelector('.mg-scopeline');
  if(!MG_DATA_VIEWS.includes(view)){ if(line) line.remove(); return; }
  if(!line){
    line = document.createElement('div'); line.className = 'mg-scopeline';
    const col = head.firstElementChild; (col || head).appendChild(line);
  }
  line.innerHTML = '<span class="mg-dot' + (p.warn ? ' warn' : '') + '"></span>' +
    escapeHtml(mgOrgShort() + ' · ' + p.srcLabel + ' · ' + p.perLabel);
}
function mgRenderUser(){
  const nameEl = document.getElementById('mgUserName'); if(!nameEl) return;
  let who = '';
  try { const me = (agentStakeholders || []).find(x => x.is_primary && x.name); if(me) who = me.name; } catch(e){}
  if(!who){ try { who = (typeof lsGet === 'function' && lsGet('margyn_owner_name')) || ''; } catch(e){} }
  nameEl.textContent = who || mgOrgName();
}

/* ---------- router: #/page?src=&period= ---------- */
function mgParseHash(){
  const m = /^#\/([\w-]+)(?:\?(.*))?$/.exec(location.hash || '');
  if(!m) return null;
  const q = new URLSearchParams(m[2] || '');
  return { slug:m[1], src:q.get('src'), period:q.get('period') };
}
function mgHashFor(view){
  const slug = MG_SLUG[view]; if(!slug) return null;
  const q = new URLSearchParams();
  const src = mgCurrentSource(view);
  if(src && src !== 'all') q.set('src', src);
  if(view === 'analytics' && typeof analyticsRange !== 'undefined' && analyticsRange !== '1q') q.set('period', analyticsRange);
  const qs = q.toString();
  return '#/' + slug + (qs ? '?' + qs : '');
}
function mgWriteHash(push){
  if((location.hash || '').indexOf('zoho=') !== -1) return; // Zoho org-select callback owns the hash
  // Signed out (sign-in screen showing): keep the link the visitor arrived on,
  // so it still opens after they log in. The sign-out path calls showView('summary').
  const shell = document.getElementById('appShell');
  if(shell && shell.classList.contains('hidden')) return;
  // Until the first data load has applied the URL, renders during that load
  // must not overwrite it with whatever page happened to be current.
  if(!mgFirstLoadDone) return;
  const h = mgHashFor(mgCurrentView); if(!h || location.hash === h) return;
  history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + location.search + h);
}
function mgApplyRoute(){
  const r = mgParseHash(); if(!r) return false;
  const view = MG_ROUTES[r.slug]; if(!view) return false;
  mgApplying = true;
  try {
    showView(view);
    if(MG_SRC[view]){
      const want = r.src || 'all';
      if(mgSourceOptions(view).some(o => o.key === want) && mgCurrentSource(view) !== want) mgSetSource(view, want);
    }
    if(view === 'analytics'){
      const want = r.period || '1q';
      if(mgRangeOptions().some(o => o.key === want) && analyticsRange !== want) mgSetRange(want);
    }
  } finally { mgApplying = false; }
  mgRefreshScope();
  return true;
}

/* ---------- hooks into existing functions (behaviour unchanged) ---------- */
const mgBaseShowView = showView;
showView = function(name){
  mgBaseShowView(name);
  const view = name === 'ledger' ? 'books' : name;
  const changed = view !== mgCurrentView;
  mgCurrentView = view;
  mgCloseRail();
  mgCloseAllPops();
  mgRefreshScope();
  if(!mgApplying) mgWriteHash(changed);
};
['renderBooksHub', 'applyPaymentsSource', 'renderAnalyticsView'].forEach(fn => {
  const base = window[fn]; if(typeof base !== 'function') return;
  window[fn] = function(){
    const out = base.apply(this, arguments);
    mgRefreshScope();
    if(!mgApplying) mgWriteHash(false);
    return out;
  };
});
// First data load after login: re-apply the URL so the page it names renders
// with real data (login itself never changes the current view).
const mgBaseRefreshAll = refreshAll;
refreshAll = async function(){
  const out = await mgBaseRefreshAll.apply(this, arguments);
  if(!mgFirstLoadDone){ mgFirstLoadDone = true; if(!mgApplyRoute()) mgWriteHash(false); }
  else mgWriteHash(false); // e.g. signed out and back in: keep the URL on the page actually shown
  mgRefreshScope();
  return out;
};
window.addEventListener('popstate', () => { mgApplyRoute(); });

/* ---------- popovers, user menu, phone rail ---------- */
const MG_POPS = [['mgSrcBtn', 'mgSrcPop'], ['mgPerBtn', 'mgPerPop'], ['mgScopeCompactBtn', 'mgScopeCompactPop'], ['topAvatar', 'mgUserPop']];
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
    if(s){ mgSetSource(mgCurrentView, s.dataset.mgSrc); mgCloseAllPops(); }
    else if(r){ mgSetRange(r.dataset.mgRange); mgCloseAllPops(); }
    else if(go){ mgCloseAllPops(); showView(go.dataset.go); }
    e.stopPropagation();
  });
});
document.addEventListener('click', e => { if(!e.target.closest('.mg-pop')) mgCloseAllPops(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape'){ mgCloseAllPops(); mgCloseRail(); } });
document.querySelectorAll('nav.mg-top [data-go]').forEach(b => {
  if(b.closest('.mg-pop')) return; // menu items are handled by their popover
  b.addEventListener('click', () => showView(b.dataset.go));
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

/* ---------- boot ---------- */
if(!mgApplyRoute()){
  mgCurrentView = (document.querySelector('.pagenav button.active') || {}).dataset?.view || 'summary';
  mgRefreshScope();
  mgWriteHash(false);
}
