/* ============================================================
   MARGYN OS FRAME (MARGYN-UI-RETHINK-2026-10-05.html, approved 5 Oct 2026)
   The app as a financial operating system: Desk and Work, six workflows
   (Cash, Collect, Pay, Tax, Close, Plan), Records, and System.

   It never changes what a page computes. Every existing page keeps its key
   (MG_PAGES), its render function and its view; this file groups them into
   spaces with tabs, draws the new rail, the space header and the phone bar,
   and, where a tab shows only part of a page, hides the other sections of
   that page. Sections no tab claims always show on the page's main tab, so
   nothing can disappear.
   Loaded after 20-frame.js and 25-margyn.js.
   ============================================================ */

/* ---------- icons (24px, stroke) ---------- */
const OS_I = {
  desk:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  work:'<path d="M4 6h16M4 12h16M4 18h10"/>',
  cash:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  collect:'<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  pay:'<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
  tax:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 17 6-6"/>',
  close:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  plan:'<path d="M3 17l5-6 4 4 8-9"/><path d="M15 6h5v5"/>',
  parties:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  transactions:'<path d="M4 7h16M4 12h16M4 17h16"/><path d="m17 4 3 3-3 3"/>',
  documents:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  reports:'<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  margyn:'<path d="M12 2.5l2.2 5.8 5.8 2.2-5.8 2.2L12 18.5l-2.2-5.8L4 10.5l5.8-2.2z"/>',
  apps:'<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><path d="M17.5 14v7M14 17.5h7"/>',
  rules:'<path d="M4 6h9M4 12h16M4 18h7"/><circle cx="16" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
  team:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  audit:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  find:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  more:'<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>'
};
function osIcon(k, cls){ return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (OS_I[k] || '') + '</svg>'; }

/* ---------- spaces ----------
   tab: { k, label, page, secs }   secs = list of section headings (text the
   section's heading starts with) or #id selectors; 'rest' = every section of
   the page that no other tab claims. No secs = the whole page. */
const OS_SPACES = [
  { key:'margyn', label:'Margyn', group:'Margyn', sub:'What Margyn and its agents are doing', tabs:[
    { k:'live', label:'Live', page:'live' },
    { k:'agents', label:'Agents', page:'agents' },
    { k:'conversations', label:'Conversations', page:'history' },
    { k:'delivery', label:'Delivery', page:'channels' },
    { k:'how', label:'How it works', page:'howitworks' }] },
  { key:'desk', label:'Desk', group:'You', sub:'Where every day starts', tabs:[{ k:'desk', label:'Desk', page:'home' }] },
  { key:'work', label:'Work', group:'You', sub:'Every open finance task, with an owner', tabs:[
    { k:'all', label:'Work', page:'work' }] },
  { key:'cash', label:'Cash', group:'Workflows', sub:'How much money there is, where it is, and where it’s going', tabs:[
    { k:'overview', label:'Overview', page:'cash', secs:'rest' },
    { k:'forecast', label:'Forecast', page:'cash', secs:['13-week cash forecast', 'Week by week', 'How Margyn built this', 'How the forecast is made'], sub:'Thirteen weeks of money in and out, learned from your own books. Change the assumptions with Adjust.' },
    { k:'settlements', label:'Settlements', page:'cash', secs:['Settlements'], sub:'Money your payment gateways have collected and paid into your bank: when each batch landed, the lag and the UTR.' },
    { k:'gateways', label:'Gateway detail', page:'payments' }] },
  { key:'collect', label:'Collect', group:'Workflows', sub:'Everything customers owe you, and getting it paid', tabs:[
    { k:'overview', label:'Overview', page:'collect' },
    { k:'receivables', label:'Receivables', page:'receivables' },
    { k:'invoices', label:'Invoices', page:'invoicing' },
    { k:'chasing', label:'Chasing', page:'chasing' },
    { k:'matching', label:'Matching', page:'inbox', secs:['#reconReviewCard'], sub:'Payments Margyn couldn’t match to an invoice on its own. Confirm the right one; nothing is applied until you do.' }] },
  { key:'pay', label:'Pay', group:'Workflows', sub:'Everything you owe suppliers', tabs:[
    { k:'overview', label:'Overview', page:'payover' },
    { k:'payables', label:'Payables', page:'payables' }] },
  { key:'tax', label:'Tax', group:'Workflows', sub:'GST: what’s due, what’s filed, what’s at risk', tabs:[
    { k:'gst', label:'GST', page:'gst' }] },
  { key:'close', label:'Close', group:'Workflows', sub:'Getting the books right and closing the month', tabs:[
    { k:'overview', label:'Overview', page:'closeover' },
    { k:'proposals', label:'Proposals', page:'inbox', secs:['#agentQueueCard'], sub:'What Margyn proposes for the exceptions it found: splitting a payment across invoices, booking TDS, holding a payment until a supplier files GST. Nothing is applied until you approve it.' },
    { k:'books', label:'Books', page:'books' }] },
  { key:'plan', label:'Plan', group:'Workflows', sub:'How healthy the business is, and where it’s heading', tabs:[
    { k:'overview', label:'Overview', page:'plan' },
    { k:'margin', label:'Margin', page:'margin' },
    { k:'pulse', label:'Pulse Score', page:'scores', secs:'rest' },
    { k:'capital', label:'Capital readiness', page:'financing' }] },
  { key:'parties', label:'Parties', group:'Records', sub:'Every customer and supplier', tabs:[
    { k:'customers', label:'Customers', page:'customers' },
    { k:'vendors', label:'Vendors', page:'vendors' }] },
  { key:'transactions', label:'Transactions', group:'Records', sub:'Every transaction Margyn holds, from every app', tabs:[
    { k:'all', label:'All', page:'transactions' }] },
  { key:'documents', label:'Documents', group:'Records', sub:'Every file sent to Margyn', tabs:[
    { k:'forwarded', label:'Forwarded documents', page:'inbox', secs:['#agentSuggestCard'], sub:'Bills, invoices and receipts sent to your Margyn WhatsApp number. Margyn read each one and proposed where it goes.' },
    { k:'files', label:'All documents', page:'documents' },
    { k:'import', label:'Import a file', page:'calculate' }] },
  { key:'reports', label:'Reports', group:'Records', sub:'Your monthly pack, briefings and the reports you build', tabs:[
    { k:'cfo-pack', label:'CFO pack', page:'cfopack' },
    { k:'custom', label:'Custom reports', page:'analytics' },
    { k:'briefings', label:'Briefings', page:'scores', secs:['#scBrief'], sub:'Margyn’s written read of your business, from your own figures.' }] },
  { key:'apps', label:'Apps', group:'System', sub:'The apps Margyn reads from and writes to', tabs:[
    { k:'connected', label:'Connected apps', page:'connectors' }] },
  { key:'rules', label:'Rules', group:'System', sub:'What Margyn may do on its own, and what waits for a person', tabs:[
    { k:'autonomy', label:'What Margyn may do', page:'rules' },
    { k:'scoring', label:'Scoring', page:'settings', secs:['Scoring'], sub:'Where the Healthy and Caution labels sit on the 0 to 100 scale.' }] },
  { key:'team', label:'Team', group:'System', sub:'Everyone who works in Margyn, in the app and on WhatsApp', tabs:[
    { k:'people', label:'People and roles', page:'settings', secs:['App logins'], sub:'Who can sign in to Margyn and what each person can see and do.' },
    { k:'whatsapp', label:'WhatsApp numbers', page:'people', secs:['People on WhatsApp'], sub:'Who can message Margyn on WhatsApp, and who gets which updates.' }] },
  { key:'audit', label:'Audit log', group:'System', sub:'Every action, by a person or by Margyn', tabs:[
    { k:'log', label:'Audit log', page:'audit' }] },
  { key:'settings', label:'Settings', group:'System', sub:'Your business and how Margyn behaves for you', tabs:[
    { k:'business', label:'Business', page:'profile', secs:['Business details'], sub:'Your company, and what Margyn calls you. Your sign-in is under Account; people are under Team.' },
    { k:'preferences', label:'Preferences', page:'settings', secs:'rest' },
    { k:'notifications', label:'Notifications', page:'settings', secs:['Notifications'], sub:'What Margyn tells you, and where.' },
    { k:'consent', label:'Consent', page:'settings', secs:['Consent and data sharing'], sub:'What Margyn reads and who it is shared with.' },
    { k:'account', label:'Account', page:'settings', secs:['Account'], sub:'Your sign-in and your account.' }] }
];
const OS_BY_KEY = Object.fromEntries(OS_SPACES.map(s => [s.key, s]));
// The page key a section filter applies to ('people' renders the settings view).
const OS_PAGE_VIEW = { people:'settings' };
// Sections hidden everywhere: duplicates of what now has its own place.
const OS_HIDE = { settings:['Connected sources'], connectors:['#connFlowMap'],   // the apps diagram is on Margyn › Live
  // Books keeps what is about the books themselves; each source's receivables, payables and GST are on Collect, Pay and Tax (pick the source in the bar).
  cash:['Payment gateways'],          // a link list to the Gateway detail tab next door
  payments:['Settlement batches'],    // settlements, with status from the gateway, are on Cash › Settlements
  books:['Receivables aging', 'Overdue customers', 'Vendors putting ITC at risk', 'Payment reconciliation', 'Outstanding bills'] };
// Where a page opens when something navigates to it directly (not by a tab).
const OS_DEFAULT = { home:['desk', 'desk'], summary:['desk', 'desk'], settings:['settings', 'preferences'],
  people:['team', 'whatsapp'], scores:['plan', 'pulse'], cash:['cash', 'overview'] };

function osFind(space, k){ const s = OS_BY_KEY[space]; return s && s.tabs.find(t => t.k === k) ? { space:s, tab:s.tabs.find(t => t.k === k) } : null; }
function osDefaultFor(page){
  if(OS_DEFAULT[page]) return osFind(OS_DEFAULT[page][0], OS_DEFAULT[page][1]);
  for(const s of OS_SPACES) for(const t of s.tabs) if(t.page === page && (!t.secs || t.secs === 'rest')) return { space:s, tab:t };
  for(const s of OS_SPACES) for(const t of s.tabs) if(t.page === page) return { space:s, tab:t };
  return null;
}
let osCur = null, osPending = null;
function osResolve(page){
  if(page === 'summary') page = 'home';
  if(osPending && osPending.tab.page === page) return osPending;
  if(osCur && osCur.tab.page === page) return osCur;
  return osDefaultFor(page);
}
/* Router hooks (called from 20-frame.js): '#/collect/receivables'. */
function osHashPath(page){ const r = osResolve(page); return r ? r.space.key + (r.space.tabs.length > 1 ? '/' + r.tab.k : '') : null; }
function osResolvePath(path){
  const [sp, tk] = String(path || '').split('/');
  const s = OS_BY_KEY[sp]; if(!s) return null;
  // An old link that is also a space ('#/settings', '#/cash') opens the tab showing that page.
  const old = !tk && typeof MG_BY_SLUG !== 'undefined' && MG_BY_SLUG[sp];
  const t = (tk && s.tabs.find(x => x.k === tk)) || (old && s.tabs.find(x => x.page === old && (!x.secs || x.secs === 'rest'))) || s.tabs[0];
  osPending = { space:s, tab:t };
  return t.page;
}
// The new pages follow the same access rules as the pages they are built from (19g-team.js).
if(typeof MG_PAGE_PERM !== 'undefined') Object.assign(MG_PAGE_PERM, { collect:'view_receivables', chasing:'view_receivables', payover:'view_payables',
  plan:'view_cash', tallydata:'view_cash', entries:'view_receivables', transactions:'view_receivables' });
function osAllowed(page){ return typeof mgPageAllowed !== 'function' || mgPageAllowed(page); }
function osTabsFor(s){ return s.tabs.filter(t => osAllowed(t.page)); }

/* Go to a space (its remembered tab) or a space's tab. */
const osLastTab = {};
function osGo(space, tabKey){
  const s = OS_BY_KEY[space]; if(!s) return;
  const tabs = osTabsFor(s); if(!tabs.length) return;
  const t = (tabKey && tabs.find(x => x.k === tabKey)) || tabs.find(x => x.k === osLastTab[space]) || tabs[0];
  osPending = { space:s, tab:t };
  if(t.page === 'inbox') agentsActiveTab = 'queue';
  if(t.page === 'agents') agentsActiveTab = 'roster';
  showView(t.page);
}

/* ---------- rail ---------- */
function osRailHtml(){
  let h = '', g = null;
  OS_SPACES.forEach(s => {
    if(!osTabsFor(s).length) return;
    if(s.key === 'margyn'){
      h += '<button type="button" class="os-rail-b os-rail-mg" data-os-space="margyn" title="' + escapeHtml(s.sub) + '"><img src="images/margyn-logo-mark.png" alt="" class="os-rail-mark">' +
        '<span class="os-rail-mg-t"><b>Margyn</b><small data-os-railnow>' + escapeHtml(typeof osRailNow === 'function' ? osRailNow() : '') + '</small></span><i class="os-rail-n" data-os-count="margyn"></i></button>';
      g = s.group; return;
    }
    if(s.group !== g){ g = s.group; h += '<div class="os-rail-g' + (g === 'System' ? ' os-sys' : '') + '">' + escapeHtml(g) + '</div>'; }
    h += '<button type="button" class="os-rail-b" data-os-space="' + s.key + '" title="' + escapeHtml(s.sub) + '">' + osIcon(s.key) + '<span>' + escapeHtml(s.label) + '</span><i class="os-rail-n" data-os-count="' + s.key + '"></i></button>';
  });
  return h;
}
function osDrawRail(){
  const nav = document.querySelector('.sidebar .pagenav'); if(!nav) return;
  let r = nav.querySelector('.os-rail');
  if(!r){ r = document.createElement('div'); r.className = 'os-rail'; nav.insertBefore(r, nav.firstChild); }
  r.innerHTML = osRailHtml();
  osMarkRail(); osCounts();
}
function osMarkRail(){
  document.querySelectorAll('.os-rail-b').forEach(b => b.classList.toggle('active', !!osCur && b.dataset.osSpace === osCur.space.key));
  document.querySelectorAll('.os-bar-b[data-os-space]').forEach(b => b.classList.toggle('on', !!osCur && b.dataset.osSpace === osCur.space.key));
}
/* Counts on the rail: real queue sizes only. */
function osCounts(){
  const set = (k, n, hot) => document.querySelectorAll('[data-os-count="' + k + '"]').forEach(el => { el.textContent = n ? String(n) : ''; el.classList.toggle('hot', !!hot && !!n); });
  let total = 0; try { total = agentQueueTotals().total || 0; } catch(e){}
  set('work', total, true);
  // Each workflow counts what its agents are waiting on a person for (28-os-live.js), the same as the Desk tiles.
  if(typeof osAgentState === 'function'){
    const need = k => { try { return osAgentState(k).need || 0; } catch(e){ return 0; } };
    set('collect', need('payments') + need('collections'));
    set('tax', need('gst'));
    set('close', need('books') + need('close'));
    set('documents', need('documents'));
  }
}

/* ---------- space header (label + tabs) ---------- */
function osDrawHead(){
  let el = document.getElementById('osHead');
  if(!el){
    const wrap = document.querySelector('.app-body .wrap'); if(!wrap) return;
    el = document.createElement('div'); el.id = 'osHead'; el.className = 'os-head';
    const first = [...wrap.children].find(c => /^view-/.test(c.id || '')) || wrap.firstChild;
    wrap.insertBefore(el, first);
  }
  if(!osCur){ el.innerHTML = ''; el.classList.add('hidden'); return; }
  const s = osCur.space, tabs = osTabsFor(s);
  document.body.dataset.osCurrent = s.key;
  document.body.classList.toggle('os-tabbed', tabs.length > 1);
  if(tabs.length < 2){ el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="os-head-t">' + osIcon(s.key) + '<b>' + escapeHtml(s.label) + '</b><span>' + escapeHtml(s.sub) + '</span></div>' +
    '<div class="os-tabs" role="tablist" aria-label="' + escapeHtml(s.label) + '">' +
    tabs.map(t => '<button type="button" role="tab" class="os-tab' + (t === osCur.tab ? ' on' : '') + '" aria-selected="' + (t === osCur.tab) + '" data-os-tab="' + s.key + '/' + t.k + '">' + escapeHtml(t.label) + '<i class="os-tab-n" data-os-tabcount="' + s.key + '/' + t.k + '"></i></button>').join('') + '</div>';
}

/* ---------- section filter ---------- */
const OS_WRAPS = '.mg-row2, #settingsMount, #agentPanel-queue, .set-wrap, .mg-cols, #booksZohoBlocks, #booksContent, #booksTallyBlocks, #booksTallyMount, #tallyTabContent, #tallyTabContent > div, #paymentsRzpBlocks';
function osBlocks(root){
  const out = [];
  const walk = el => [...el.children].forEach(c => {
    if(c.matches('.mg-ph, .rd-head, .srcseg, #agentTabs, .os-emptynote, .mg-tiles, script, style')) return;   // the page head and its tiles show on every tab
    if(c.matches(OS_WRAPS)){ walk(c); return; }
    out.push(c);
  });
  walk(root);
  return out;
}
function osHeading(b){
  const h = b.querySelector('h2, h3, .ledger-list-title, .rd-section-label');
  return h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
}
function osMatch(b, secs){
  if(!Array.isArray(secs)) return false;
  const head = osHeading(b);
  return secs.some(x => x[0] === '#' ? (b.matches(x) || !!b.querySelector(x)) : head.indexOf(x) === 0);
}
function osClaims(viewPage){   // every section any tab claims for this page
  const all = [];
  OS_SPACES.forEach(s => s.tabs.forEach(t => { if((OS_PAGE_VIEW[t.page] || t.page) === viewPage && Array.isArray(t.secs)) all.push(...t.secs); }));
  return all;
}
let osFiltering = false;
function osApplyFilter(){
  if(!osCur) return;
  const t = osCur.tab, viewPage = OS_PAGE_VIEW[t.page] || t.page;
  const P = MG_PAGES[viewPage];
  const root = document.getElementById('view-' + (P && !P.own ? P.base : viewPage));
  if(!root) return;
  osFiltering = true;
  try {
    root.querySelectorAll('.os-off').forEach(x => x.classList.remove('os-off'));
    const blocks = osBlocks(root), hide = OS_HIDE[viewPage] || [];
    const claims = osClaims(viewPage);
    blocks.forEach(b => {
      let show = true;
      if(Array.isArray(t.secs)) show = osMatch(b, t.secs);
      else if(t.secs === 'rest') show = !osMatch(b, claims);
      if(show && hide.length && osMatch(b, hide)) show = false;
      if(!show) b.classList.add('os-off');
    });
    // A tab showing part of a page says so when that part is empty.
    root.classList.toggle('os-part', Array.isArray(t.secs));
    // A tab that shows part of a page is titled by the tab ("Matching", not "Inbox").
    if(Array.isArray(t.secs) || t.secs === 'rest'){
      const h = root.querySelector('.rd-head h1, .mg-ph .mg-title');
      const want = Array.isArray(t.secs) ? (t.title || t.label) : null;
      if(h && want){ const tn = [...h.childNodes].find(n => n.nodeType === 3); if(tn && tn.data.trim() !== want) tn.data = want + ' '; else if(!tn && h.textContent !== want) h.textContent = want; }
      const sub = root.querySelector('.rd-head .rd-sub, .mg-ph .mg-ph-sub');
      if(sub && t.sub && sub.textContent !== t.sub) sub.textContent = t.sub;
    }
    let note = root.querySelector(':scope > .os-emptynote');
    const empty = Array.isArray(t.secs) && !blocks.some(b => !b.classList.contains('os-off') && !b.classList.contains('hidden') && !b.hidden);
    if(empty && !note){ note = document.createElement('div'); note.className = 'os-emptynote'; root.appendChild(note); }
    if(note){ note.hidden = !empty; note.textContent = empty ? 'Nothing here right now. When ' + (t.label === 'Matching' ? 'a payment needs checking' : t.label === 'Forwarded' ? 'someone forwards a document' : 'there is something') + ', it shows up here.' : ''; }
  } finally { osFiltering = false; }
}
let osFilterQueued = false;
const osObserver = new MutationObserver(() => {
  if(osFiltering || osFilterQueued) return;
  osFilterQueued = true;
  requestAnimationFrame(() => { osFilterQueued = false; osApplyFilter(); });
});
function osWatchView(){
  osObserver.disconnect();
  if(!osCur) return;
  const viewPage = OS_PAGE_VIEW[osCur.tab.page] || osCur.tab.page, P = MG_PAGES[viewPage];
  const root = document.getElementById('view-' + (P && !P.own ? P.base : viewPage));
  if(root) osObserver.observe(root, { childList:true, subtree:true, characterData:true });
}

/* ---------- showView: settle the space + tab after every navigation ---------- */
const osBaseShowView = showView;
showView = function(name){
  if(name === 'inbox' && !(osPending && osPending.tab.page === 'inbox')){ try { osWorkTab = 'waiting'; } catch(e){} arguments[0] = name = 'work'; }
  // Manual entries and Tally's own vouchers are sources on Close › Books (one place for the books).
  if(name === 'entries' || name === 'tallydata'){ booksActiveSource = name === 'entries' ? 'manual' : 'tally'; arguments[0] = name = 'books'; osPending = osFind('close', 'books'); }
  const out = osBaseShowView.apply(this, arguments);
  const page = mgCurrentView;
  const r = osResolve(page) || osDefaultFor(page);
  osPending = null;
  if(r){ osCur = r; osLastTab[r.space.key] = r.tab.k; }
  osDrawHead(); osMarkRail(); osApplyFilter(); osWatchView();
  // A tab that shows part of a page starts at the top of it.
  const wrap = document.querySelector('.app-body .wrap'); if(wrap && name !== mgCurrentView) wrap.scrollTop = 0;
  return out;
};
// Own pages re-render on every data load: keep the filter on them.
const osBaseRenderOwn = mgRenderOwn;
mgRenderOwn = function(page){ const out = osBaseRenderOwn.apply(this, arguments); if(osCur && (OS_PAGE_VIEW[osCur.tab.page] || osCur.tab.page) === page) osApplyFilter(); return out; };

/* ---------- phone bar: Desk, Work, Margyn, Find, Menu ---------- */
function osDrawBar(){
  if(document.getElementById('osBar')) return;
  const bar = document.createElement('div'); bar.id = 'osBar'; bar.className = 'os-bar'; bar.setAttribute('role', 'navigation'); bar.setAttribute('aria-label', 'Main');
  bar.innerHTML =
    '<button type="button" class="os-bar-b" data-os-space="desk">' + osIcon('desk') + '<span>Desk</span></button>' +
    '<button type="button" class="os-bar-b" data-os-space="work">' + osIcon('work') + '<span>Work</span><i class="os-rail-n" data-os-count="work"></i></button>' +
    '<button type="button" class="os-bar-b os-bar-mic" data-mgr-talk aria-label="Talk to Margyn"><span class="os-mic">' + osIcon('mic') + '</span><span>Margyn</span></button>' +
    '<button type="button" class="os-bar-b" data-os-find>' + osIcon('find') + '<span>Find</span></button>' +
    '<button type="button" class="os-bar-b" data-os-menu>' + osIcon('more') + '<span>Menu</span></button>';
  document.body.appendChild(bar);
}

/* ---------- ask bar: Margyn on every page ---------- */
function osDrawAsk(){
  const wrap = document.querySelector('.app-body .wrap'); if(!wrap || document.getElementById('osAsk')) return;
  const f = document.createElement('form'); f.id = 'osAsk'; f.className = 'os-ask'; f.setAttribute('autocomplete', 'off');
  f.innerHTML = '<img src="images/margyn-logo-mark.png" alt="" class="os-ask-mark">' +
    '<input type="text" id="osAskInput" placeholder="Ask Margyn, or tell it what to do…" aria-label="Ask Margyn">' +
    '<span class="os-ask-chips" id="osAskChips"></span>' +
    '<button type="submit" class="mg-btn mg-btn-sm">Ask</button>' +
    '<button type="button" class="mg-btn mg-btn-sm os-talk" data-mgr-talk>' + osIcon('mic') + '<span>Talk</span></button>';
  wrap.appendChild(f);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const i = document.getElementById('osAskInput'), v = (i.value || '').trim(); if(!v) return;
    i.value = '';
    if(typeof mgrOpen === 'function') mgrOpen();
    if(typeof mgrAsk === 'function') mgrAsk(v);
  });
}
// Two questions that fit where you are, from what's on screen.
const OS_CHIPS = {
  desk:['What needs my OK?', 'What did you do overnight?'], work:['Go through what needs me', 'What is Margyn working on?'],
  cash:['Will cash dip soon?', 'Where is my cash?'], collect:['Who should I chase first?', 'Who paid after a reminder?'],
  pay:['What’s due this week?', 'Which suppliers are late?'], tax:['How much GST is due?', 'Which suppliers haven’t filed?'],
  close:['Where do my books disagree?', 'Is all my data in?'], plan:['How is my margin?', 'Why is my Pulse Score this?'],
  parties:['Who owes me the most?', 'Who do I owe the most?'], margyn:['What are you working on?', 'What did you send me today?']
};
function osDrawChips(){
  const el = document.getElementById('osAskChips'); if(!el) return;
  const c = (osCur && OS_CHIPS[osCur.space.key]) || [];
  el.innerHTML = c.map(q => '<button type="button" class="os-chip" data-mgr-ask="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
}

/* ---------- Margyn panel: a sheet over the page, pinned on wide screens ---------- */
const OS_PIN_KEY = 'mg.panel.pin';
const OS_DOCK_MIN = 1280;   // wide enough for rail + page + Margyn side by side
function osPinned(){ try { return lsGet(OS_PIN_KEY, '1') !== '0' && window.innerWidth >= OS_DOCK_MIN; } catch(e){ return false; } }
function osSyncPin(){
  document.body.classList.toggle('os-pinned', osPinned());
  const b = document.getElementById('osPinBtn');
  if(b){ const on = lsGet(OS_PIN_KEY, '1') !== '0'; b.classList.toggle('on', on); b.title = on ? 'Unpin: open Margyn over the page' : 'Pin Margyn to the side'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
}
function osAddPin(){
  const h = document.querySelector('#mgRail .mgr-h'); if(!h || document.getElementById('osPinBtn')) return;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'mg-icon-btn os-pin'; b.id = 'osPinBtn';
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2H6z"/></svg>';
  b.addEventListener('click', () => { lsSet(OS_PIN_KEY, lsGet(OS_PIN_KEY, '1') !== '0' ? '0' : '1'); osSyncPin(); });
  const close = document.getElementById('mgrClose'); h.insertBefore(b, close || null);
  osSyncPin();
}
window.addEventListener('resize', osSyncPin);
// Clicking the page outside an unpinned sheet closes it.
document.addEventListener('mousedown', e => {
  if(!document.body.classList.contains('mgr-open') || document.body.classList.contains('os-pinned')) return;
  if(e.target.closest('#mgRail, #osAsk, .mg-top, .mgr-bubble, .mg-dialog-scrim, .cmdk, .os-bar, .mg-wn-scrim, [data-mgr-ask], [data-mgr-talk]')) return;
  if(typeof mgrClose === 'function') mgrClose(true);
});

/* ---------- wiring ---------- */
document.addEventListener('click', e => {
  const sp = e.target.closest('[data-os-space]');
  if(sp && !sp.hasAttribute('data-mgr-talk')){ e.preventDefault(); osGo(sp.dataset.osSpace); if(typeof mgCloseRail === 'function') mgCloseRail(); return; }
  const tb = e.target.closest('[data-os-tab]');
  if(tb){ const [s, k] = tb.dataset.osTab.split('/'); osGo(s, k); return; }
  const go = e.target.closest('[data-os-go]');
  if(go){ const [s, k] = go.dataset.osGo.split('/'); osGo(s, k); return; }
  if(e.target.closest('[data-os-find]')){ const t = document.getElementById('cmdkTrigger'); if(t) t.click(); return; }
  if(e.target.closest('[data-os-menu]')){ const b = document.getElementById('mgMenuBtn'); if(b) b.click(); return; }
});
// Keyboard: G then a letter jumps to a space (Desk, Work, Cash, Collect, Pay, Tax, cLose, pLan).
(function(){
  const KEYS = { d:'desk', w:'work', c:'cash', o:'collect', p:'pay', t:'tax', l:'close', n:'plan', r:'reports', m:'margyn' };
  let g = 0;
  document.addEventListener('keydown', e => {
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if(/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    if(k === 'g'){ g = Date.now(); return; }
    if(g && Date.now() - g < 1200 && KEYS[k]){ e.preventDefault(); g = 0; osGo(KEYS[k]); }
  });
})();

// Who is signed in decides which spaces and tabs show: redraw when that changes (19g-team.js).
if(typeof mgApplyActor === 'function'){ const baseActor = mgApplyActor; mgApplyActor = function(){ const out = baseActor.apply(this, arguments); try { osDrawRail(); osDrawHead(); } catch(e){} return out; }; }

/* A section asked for by name ("scroll to the forecast") that sits on another
   tab of the same page: open that tab first, so voice and chat still find it. */
function osRevealSection(want){
  if(!osCur) return false;
  want = String(want || '').toLowerCase().trim(); if(!want) return false;
  const viewPage = OS_PAGE_VIEW[osCur.tab.page] || osCur.tab.page, P = MG_PAGES[viewPage];
  const root = document.getElementById('view-' + (P && !P.own ? P.base : viewPage)); if(!root) return false;
  const block = osBlocks(root).find(b => b.classList.contains('os-off') && b.textContent.toLowerCase().includes(want) &&
    [...b.querySelectorAll('h1, h2, h3, h4, .mg-panel-h, th, label')].some(h => h.textContent.toLowerCase().includes(want)));
  if(!block) return false;
  const claims = osClaims(viewPage);
  const tab = osCur.space.tabs.find(t => (OS_PAGE_VIEW[t.page] || t.page) === viewPage && osAllowed(t.page) &&
    (Array.isArray(t.secs) ? osMatch(block, t.secs) : t.secs === 'rest' ? !osMatch(block, claims) : true));
  if(!tab) return false;
  osGo(osCur.space.key, tab.k);
  return true;
}
if(typeof VX_TOOLS !== 'undefined' && VX_TOOLS && typeof VX_TOOLS.scroll === 'function'){
  const baseScroll = VX_TOOLS.scroll;
  VX_TOOLS.scroll = function(a){ if(a && a.to) osRevealSection(a.to); return baseScroll.apply(this, arguments); };
}
// What Margyn applied from the panel lands in the activity record too (28-os-live.js).
if(typeof mgStatus === 'function'){
  const baseStatus = mgStatus;
  mgStatus = function(text){ const out = baseStatus.apply(this, arguments);
    try { if(/^Applied:/.test(String(text || '')) && typeof osActAdd === 'function') osActAdd({ agent:'margyn', text:String(text), state:'done', at:new Date().toISOString(), end:new Date().toISOString(), from:'app' }); } catch(e){}
    return out; };
}

/* ---------- boot ---------- */
document.body.classList.add('os-on');
osDrawRail(); osDrawBar(); osDrawAsk(); osAddPin();
// Re-draw counts and the rail (permissions can change) after each data load.
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    try { osDrawRail(); osDrawHead(); osDrawChips(); osApplyFilter(); osSyncPin(); } catch(e){ console.error('[os] after refresh', e); }
    return out;
  };
})();
(function(){ const r = osDefaultFor(mgCurrentView); if(r){ osCur = r; osDrawHead(); osMarkRail(); } osDrawChips(); })();
// Chips follow the space.
(function(){ const base = showView; showView = function(){ const out = base.apply(this, arguments); osDrawChips(); return out; }; })();
