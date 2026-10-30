/* ============================================================
   TABS (mock v9): long pages split into tabs, each with its own address.

   Presentation only. A page renders exactly what it rendered before; this
   file groups its blocks under tabs and shows one group at a time. Nothing is
   removed from the page: every block belongs to a tab, and anything a tab map
   does not name stays visible on every tab.

   - Cash: Position, Forecast, Settlements, Payment gateways.
     Payment gateways is still its own page underneath (#/payment-gateways
     keeps working); it now carries the Cash tabs so it reads as one of them.
   - Margin: seven tabs.
   - Settings: seven sections down the left; People and roles opens it on
     People on WhatsApp (#/people keeps working).
   Addresses: #/cash?tab=forecast. Back, Forward and refresh land on the tab.
   ============================================================ */

/* page -> [key, label, [block headings]]. A block is matched by its first
   panel heading, or its first tile label for a figures band. */
const MG_TABS = {
  cash:[
    ['position', 'Position', ['Where the cash is', 'Borrowing']],
    ['forecast', 'Forecast', ['13-week cash forecast', 'Cash position', 'Week by week']],
    ['settlements', 'Settlements', ['Settlements', 'Payment gateways']],
    ['gateways', 'Payment gateways', []]                       // opens the Payment gateways page
  ],
  margin:[
    ['overview', 'Overview', ['What stands out', 'Month by month']],
    ['customers', 'Customers', ['Customers, after the cost of waiting']],
    ['items', 'Items', ['Margin by item', 'Sales and purchases by item']],
    ['costs', 'Where the money goes', ['Where the money goes']],
    ['working-capital', 'Working capital', ['Owed to you']],
    ['gst', 'GST estimate', ['GST estimate from your books']],
    ['help', 'Needs your help', ['Margyn needs your help']]
  ]
};
const MG_SET_SECTIONS = [['logins', 'App logins'], ['whatsapp', 'People on WhatsApp'], ['notifications', 'Notifications'], ['scoring', 'Scoring'], ['sources', 'Connected sources'], ['consent', 'Consent and data sharing'], ['account', 'Account']];
/* Pages whose blocks are not flat panels describe themselves here:
   page -> { root, tabs:[[key,label]], leaves():[[element,key]], after():element, onPick?(key) }.
   33-pages.js adds Reports and Automations. */
const MG_TABX = {
  // Ledger: every accounting source on one page, sorted by what you came to do.
  books:{
    root:'view-books',
    tabs:[['entries', 'Entries'], ['position', 'Position'], ['checks', 'Checks'], ['tally', 'Tally books'], ['balances', 'Balances']],
    after:() => document.querySelector('#view-books > .rd-head'),
    leaves(){
      const out = [], add = (sel, key) => document.querySelectorAll(sel).forEach(e => out.push([e, key]));
      const title = e => ((e.querySelector('.cc-title, .ch-title, h3, h2, .ledger-list-title') || e).textContent || '').trim();
      add('#booksManualBlocks', 'entries');
      add('#srcConflictCard', 'checks');
      add('#booksNotConnected, #booksBackfillBanner', 'position');
      document.querySelectorAll('#booksContent > *').forEach(e => out.push([e, e.id === 'zvInsightsCard' || /^Vendors putting ITC at risk/.test(title(e)) ? 'checks' : 'position']));
      add('#zvReconCard', 'checks');
      add('#booksTallyBlocks > .hint, #tallyNotConnected', 'tally');
      document.querySelectorAll('#tallyTabContent > *').forEach(e => out.push([e, /^Ledger balances/.test(title(e)) ? 'balances' : 'tally']));
      add('#booksOdooBlocks', 'position');
      return out;
    }
  }
};
const mgTab = {};                                   // page -> chosen tab key (unset = the first)
function mgTabKeys(page){ return page === 'settings' ? MG_SET_SECTIONS.map(x => x[0]) : MG_TABX[page] ? MG_TABX[page].tabs.map(x => x[0]) : (MG_TABS[page] || []).map(x => x[0]); }
/* What goes in the address: the tab, unless it is the first one. */
function mgTabOf(page){
  if(page === 'payments' || page === 'people') return null;      // their own addresses already say which tab
  if(page === 'invoicing') return typeof khataTab !== 'undefined' && ['invoice-new', 'invoices', 'printing'].includes(khataTab) ? khataTab : null;
  const keys = mgTabKeys(page), k = mgTab[page];
  return keys.length && k && k !== keys[0] && keys.includes(k) ? k : null;
}
/* An address was opened: remember its tab before the page renders. */
function mgTabRoute(page, tab){
  if(page === 'people'){ mgTab.settings = 'whatsapp'; return; }
  if(page === 'invoicing'){ mgTab.invoicing = ['invoice-new', 'invoices', 'printing'].includes(tab) ? tab : 'parties'; return; }
  if(!mgTabKeys(page).length) return;
  mgTab[page] = mgTabKeys(page).includes(tab) ? tab : mgTabKeys(page)[0];
}
function mgSetTab(page, key){
  if(page === 'cash' && key === 'gateways'){ showView('payments'); return; }
  if(page === 'payments'){ mgTab.cash = key; showView('cash'); return; }
  if(page === 'invoicing'){ if(typeof showKhataTab === 'function') showKhataTab(key); return; }
  mgTab[page] = key;
  if(MG_TABX[page] && MG_TABX[page].onPick) MG_TABX[page].onPick(key);
  mgTabsApply(page);
  if(typeof mgWriteHash === 'function') mgWriteHash(true);
  const w = document.querySelector('.app-body .wrap'); if(w && page !== 'settings') w.scrollTop = Math.min(w.scrollTop, 0);
}
function mgTabBar(page, on){
  return '<div class="mg-tabs" role="tablist" data-mg-tabs="' + page + '">' + MG_TABS[page].map(t =>
    '<button type="button" role="tab" aria-selected="' + (t[0] === on) + '" class="' + (t[0] === on ? 'on' : '') + '" data-mg-tab="' + t[0] + '">' + escapeHtml(t[1]) + '</button>').join('') + '</div>';
}
function mgTabsApply(page){
  if(page === 'settings' || page === 'people') return mgSetSectionsApply();
  if(page === 'payments') return mgPaymentsAsTab();
  if(MG_TABX[page]) return mgTabsApplyX(page);
  const map = MG_TABS[page]; if(!map) return;
  const root = document.getElementById('view-' + page); if(!root || root.classList.contains('hidden')) return;
  const blocks = [...root.children].filter(c => !c.classList.contains('mg-tabs'));
  if(!blocks.some(b => b.classList.contains('mg-panel'))) return;          // empty or loading state: nothing to split
  const on = mgTabKeys(page).includes(mgTab[page]) && mgTab[page] !== 'gateways' ? mgTab[page] : map[0][0];
  const headOf = b => { const h = b.querySelector('.mg-panel-h h2') || (b.classList.contains('mg-tiles') ? b.querySelector('.mg-tile-l') : null); return h ? h.textContent.trim() : ''; };
  let cur = null, firstMatched = null;
  blocks.forEach(b => {
    const h = headOf(b), t = h && map.find(m => m[2].includes(h));
    if(t){ cur = t[0]; if(!firstMatched) firstMatched = b; }
    // before the first named block: the header, the band and notes belong to every tab
    const off = !!cur && cur !== on;
    if(cur && b.dataset.mgTabKey !== cur) b.dataset.mgTabKey = cur;
    if(b.classList.contains('mg-tab-off') !== off) b.classList.toggle('mg-tab-off', off);
  });
  if(!firstMatched) return;
  let bar = root.querySelector(':scope > .mg-tabs');
  const html = mgTabBar(page, on);
  if(!bar){ firstMatched.insertAdjacentHTML('beforebegin', html); }
  else if(bar.outerHTML !== html || bar.nextElementSibling !== firstMatched){ bar.remove(); firstMatched.insertAdjacentHTML('beforebegin', html); }
}
/* A described page (MG_TABX). A tab with nothing to show right now (its source is
   not connected, or the Sources filter hides it) is left out of the bar. */
function mgTabsApplyX(page){
  const X = MG_TABX[page], root = document.getElementById(X.root); if(!root || root.classList.contains('hidden')) return;
  if(X.ready && !X.ready()) return;
  const leaves = X.leaves();
  // "there" = shown if its tab were open: no hidden ancestor of its own
  const there = el => { for(let n = el; n && n !== root; n = n.parentElement){ if(n.classList.contains('hidden') || n.hidden || n.style.display === 'none') return false; } return true; };
  const live = X.tabs.filter(t => t[2] === 'always' || leaves.some(([el, k]) => k === t[0] && there(el)));
  if(!live.length) return;
  const on = live.some(t => t[0] === mgTab[page]) ? mgTab[page] : live[0][0];
  leaves.forEach(([el, k]) => { const off = k !== on; if(el.classList.contains('mg-tab-off') !== off) el.classList.toggle('mg-tab-off', off); if(el.dataset.mgTabKey !== k) el.dataset.mgTabKey = k; });
  const html = '<div class="mg-tabs" role="tablist" data-mg-tabs="' + page + '">' + live.map(t => { const n = X.count ? X.count(t[0]) : null;
    return '<button type="button" role="tab" aria-selected="' + (t[0] === on) + '" class="' + (t[0] === on ? 'on' : '') + '" data-mg-tab="' + t[0] + '">' + escapeHtml(t[1]) + (n != null ? '<small>' + n + '</small>' : '') + '</button>'; }).join('') + '</div>';
  const anchor = X.after(); if(!anchor) return;
  const bar = root.querySelector('.mg-tabs[data-mg-tabs="' + page + '"]');
  if(!bar) anchor.insertAdjacentHTML('afterend', html); else if(bar.outerHTML !== html) bar.outerHTML = html;
  if(X.painted) X.painted(on);
}
/* Payment gateways, shown as the fourth Cash tab: Cash's title, the same tab bar. */
function mgPaymentsAsTab(){
  const root = document.getElementById('view-payments'); if(!root || root.classList.contains('hidden')) return;
  const head = root.querySelector('.rd-head'); if(!head) return;
  const h1 = head.querySelector('h1'); if(h1){ const tn = [...h1.childNodes].find(n => n.nodeType === 3); if(tn && tn.data.trim() !== 'Cash') tn.data = 'Cash '; }
  // Cash's four figures stay above the tabs here too (drawn by the Cash page itself, then copied).
  try {
    let src = document.querySelector('#view-cash > .mg-tiles');
    if(!src && typeof mgRenderCash === 'function' && !mgPaymentsAsTab.tried){ mgPaymentsAsTab.tried = true; mgRenderCash(); src = document.querySelector('#view-cash > .mg-tiles'); }
    const have = root.querySelector(':scope > .mg-tiles');
    if(src){ if(!have) head.insertAdjacentHTML('afterend', src.outerHTML); else if(have.innerHTML !== src.innerHTML) have.innerHTML = src.innerHTML; }
  } catch(e){}
  const html = mgTabBar('cash', 'gateways').replace('data-mg-tabs="cash"', 'data-mg-tabs="payments"');
  const bar = root.querySelector(':scope > .mg-tabs');
  const anchor = root.querySelector(':scope > .mg-tiles') || head;
  if(!bar) anchor.insertAdjacentHTML('afterend', html); else if(bar.outerHTML !== html || bar.previousElementSibling !== anchor){ bar.remove(); anchor.insertAdjacentHTML('afterend', html); }
}
/* Settings: one section at a time, chosen from a list on the left. */
function mgSetSectionsApply(){
  const mount = document.getElementById('settingsMount'), root = document.getElementById('view-settings');
  if(!mount || !root || root.classList.contains('hidden')) return;
  const blocks = [...mount.children].filter(c => c.classList.contains('set-block')); if(!blocks.length) return;
  const keyOf = b => { const t = (b.querySelector(':scope > h3') || {}).textContent || ''; const s = MG_SET_SECTIONS.find(x => x[1] === t.trim()); return s ? s[0] : null; };
  const keys = blocks.map(keyOf);
  const on = keys.includes(mgTab.settings) ? mgTab.settings : keys.find(Boolean);
  blocks.forEach((b, i) => { if(keys[i] && b.dataset.mgTabKey !== keys[i]) b.dataset.mgTabKey = keys[i]; const off = !!keys[i] && keys[i] !== on; if(b.classList.contains('mg-tab-off') !== off) b.classList.toggle('mg-tab-off', off); });
  const html = '<div class="mg-setnav" role="tablist" aria-orientation="vertical" data-mg-tabs="settings">' + MG_SET_SECTIONS.filter(s => keys.includes(s[0])).map(s =>
    '<button type="button" role="tab" aria-selected="' + (s[0] === on) + '" class="' + (s[0] === on ? 'on' : '') + '" data-mg-tab="' + s[0] + '">' + escapeHtml(s[1]) + '</button>').join('') + '</div>';
  const nav = mount.querySelector(':scope > .mg-setnav');
  if(!nav) mount.insertAdjacentHTML('afterbegin', html); else if(nav.outerHTML !== html) nav.outerHTML = html;
  if(!mount.classList.contains('mg-set')) mount.classList.add('mg-set');
}

/* Something on another tab is wanted (Margyn pressing a button or scrolling to
   a section, a link that jumps to a panel): open the tab it is on, or the
   Inbox item it belongs to. Safe to call on anything. */
function mgHiddenByLayout(el){ return !!(el && el.closest && (el.closest('.mg-tab-off') || el.closest('.mg-row-more') || (el.closest('.mgi-detail [id$="List"] > :not(.mgi-on)') && document.querySelector('#view-agents.mg-is-inbox')))); }
function mgReveal(el){
  if(!el || !el.closest) return;
  const block = el.closest('.mg-tab-off');
  if(block && block.dataset.mgTabKey){
    let page = block.closest('#settingsMount') ? 'settings' : ((block.closest('[id^="view-"]') || {}).id || '').replace('view-', '');
    page = { analytics:'analytics', agents:'agents' }[page] || page;
    if(page){ mgTab[page] = block.dataset.mgTabKey; mgTabsApply(page); if(typeof mgWriteHash === 'function') mgWriteHash(false); }
  }
  if(typeof mgInboxSelect === 'function') mgInboxSelect(el);   // 31-polish.js
  if(typeof mgPagerShowAll === 'function') mgPagerShowAll(el);   // 31-polish.js: a row held back by "Show 50 more"
}

/* Every tab, for search and for Margyn. */
function mgTabDefs(page){
  if(page === 'settings') return MG_SET_SECTIONS.map(x => [x[0], x[1]]);
  if(page === 'invoicing') return [['parties', 'Parties'], ['invoice-new', 'New invoice'], ['invoices', 'Invoices'], ['printing', 'Printing and reports']];
  return MG_TABX[page] ? MG_TABX[page].tabs.map(x => [x[0], x[1]]) : (MG_TABS[page] || []).map(x => [x[0], x[1]]);
}
function mgTabList(){
  const out = [], ok = pg => typeof mgPageAllowed !== 'function' || mgPageAllowed(pg);
  ['cash', 'books', 'margin', 'analytics', 'agents', 'settings', 'invoicing'].filter(ok).forEach(page => mgTabDefs(page).forEach((t, i) => {
    if(i === 0 && page !== 'settings') return;                               // the first tab is the page itself
    if(page === 'agents' && t[0] === 'conversations') return;
    if(page === 'cash' && t[0] === 'gateways') return;                       // Payment gateways is already listed as a page
    out.push({ page, key:t[0], label:t[1], pageLabel:page === 'settings' ? 'Settings' : MG_PAGES[page].label, icon:page, words:page + ' tab ' + t[0].replace(/-/g, ' ') });
  }));
  return out;
}
function mgTabNames(page){
  if(page === 'people') page = 'settings';
  if(page === 'payments') return { on:'Payment gateways', others:['Position', 'Forecast', 'Settlements'] };
  const defs = mgTabDefs(page); if(!defs.length) return null;
  const cur = page === 'invoicing' ? (typeof khataTab !== 'undefined' ? khataTab : 'parties') : (mgTabKeys(page).includes(mgTab[page]) ? mgTab[page] : defs[0][0]);
  const on = defs.find(d => d[0] === cur) || defs[0];
  return { on:on[1], others:defs.filter(d => d !== on).map(d => d[1]) };
}

/* About 55 places in the app jump to a panel with scrollIntoView. If that panel
   now sits on another tab (or behind "Show 50 more"), open it first. */
(function(){
  const base = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function(){
    try { if(mgHiddenByLayout(this)) mgReveal(this); } catch(e){}
    return base.apply(this, arguments);
  };
})();

/* ---------- wiring ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mg-tab]'); if(!b) return;
  const bar = b.closest('[data-mg-tabs]'); if(!bar) return;
  mgSetTab(bar.dataset.mgTabs, b.dataset.mgTab);
});
// Left and right arrows move between tabs, as a tab list should.
document.addEventListener('keydown', e => {
  if(!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const b = e.target.closest && e.target.closest('[data-mg-tab]'); if(!b) return;
  const all = [...b.parentElement.querySelectorAll('[data-mg-tab]')], n = all[all.indexOf(b) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1)];
  if(n){ e.preventDefault(); const page = b.parentElement.dataset.mgTabs, key = n.dataset.mgTab; mgSetTab(page, key);
    const f = document.querySelector('[data-mg-tabs="' + page + '"] [data-mg-tab="' + key + '"]'); if(f) f.focus(); }
});
// Pages re-render themselves (a sync lands, a filter changes): put the tabs back each time.
(function(){
  let queued = false;
  const run = () => { queued = false; try { mgTabsApply(mgCurrentView); } catch(e){ console.error('[margyn] tabs', e); } };
  const queue = () => { if(!queued){ queued = true; requestAnimationFrame(run); } };
  const boot = () => {
    ['view-cash', 'view-margin', 'view-payments', 'settingsMount'].forEach(id => { const el = document.getElementById(id); if(el) new MutationObserver(queue).observe(el, { childList:true }); });
    // Ledger: sources connect, sync and get filtered while the page is open.
    const bk = document.getElementById('view-books'); if(bk) new MutationObserver(queue).observe(bk, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'style', 'hidden'] });
    // Invoicing keeps its own tabs; each gets an address.
    if(typeof showKhataTab === 'function'){ const baseK = showKhataTab; showKhataTab = function(){ const out = baseK.apply(this, arguments); try { if(mgCurrentView === 'invoicing' && typeof mgWriteHash === 'function') mgWriteHash(true); } catch(e){} return out; }; }
    const base = showView;
    showView = function(name){
      const out = base.apply(this, arguments);
      try {
        // People and roles is a section of Settings now: light up Settings in the menu, open that section.
        if(mgCurrentView === 'people'){ mgTab.settings = 'whatsapp'; const sb = document.querySelector('.pagenav button[data-view="settings"]'); if(sb) sb.classList.add('active'); }
        if(mgCurrentView === 'invoicing' && mgTab.invoicing && typeof showKhataTab === 'function'){ const t = mgTab.invoicing; delete mgTab.invoicing; if(typeof khataTab === 'undefined' || khataTab !== t) showKhataTab(t); }
        mgTabsApply(mgCurrentView);
      } catch(e){ console.error('[margyn] tabs', e); }
      return out;
    };
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
