/* Polish (visual only). Marks a sideways-scrolled table so its pinned first
   column gets a shadow (polish.css .is-xscrolled). Reads scroll position,
   changes one class. No data, no rendering, no page text. */
(function(){
  document.addEventListener('scroll', function(e){
    const el = e.target;
    if(!el || !el.classList || !(el.classList.contains('mg-gridwrap') || el.classList.contains('lt-table'))) return;
    el.classList.toggle('is-xscrolled', el.scrollLeft > 0);
  }, true);
})();

/* Inbox as two panes (mock v9): the list on the left, the decision on the right.
   Presentation only. The rows the Inbox already renders (13-recon-agent.js,
   14-auth-import.js) stay in the page with their own buttons and handlers; this
   lists them on the left and shows one at a time on the right. On a phone the
   Inbox stays one list. */
(function(){
  const CARDS = ['reconReviewCard', 'agentQueueCard', 'agentSuggestCard'];
  const LISTS = ['reconReviewList', 'agentQueueList', 'suggestionsList'];
  let sel = null, queued = false, filter = 'all';
  const $ = id => document.getElementById(id);
  const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  function items(){
    const out = [];
    CARDS.forEach((cid, ci) => {
      const card = $(cid), list = $(LISTS[ci]); if(!card || !list || card.classList.contains('hidden')) return;
      const rows = [...list.children].filter(r => r.matches('.ledger-row, .card'));
      rows.forEach((r, i) => {
        const party = r.querySelector('.lr-party');
        const first = party ? [...party.childNodes].find(n => n.nodeType === 3 && n.data.trim()) : null;
        const tags = party ? [...party.querySelectorAll('.lr-tag')].map(txt).filter(Boolean).join(' · ') : '';
        const head = r.querySelector('.ledger-list-title, h2, h4, b, strong');
        out.push({ el:r, card, key:r.dataset.workKey || (r.dataset.agentId ? 'act:' + r.dataset.agentId : cid + ':' + i), group:ci,
          title:(first ? first.data.trim() : txt(head)) || 'Item ' + (i + 1), amount:txt(r.querySelector('.lr-amount')),
          sub:[txt(r.querySelector('.lr-meta')), ci === 1 ? tags : ''].filter(Boolean).join(' · ') });
      });
    });
    return out;
  }
  function paint(){
    queued = false;
    const host = $('agentPanel-queue'); if(!host) return;
    let wrap = $('mgInbox');
    if(!wrap){
      const firstCard = $(CARDS[0]); if(!firstCard) return;
      wrap = document.createElement('div'); wrap.className = 'mgi'; wrap.id = 'mgInbox';
      wrap.innerHTML = '<div class="mgi-list" id="mgInboxList" role="listbox" aria-label="Waiting on you"></div><div class="mgi-detail" id="mgInboxDetail"></div>';
      firstCard.before(wrap);
      CARDS.forEach(id => { const c = $(id); if(c) wrap.lastChild.appendChild(c); });
      wrap.firstChild.addEventListener('click', e => { const f = e.target.closest('[data-mgi-f]'); if(f && !f.disabled){ filter = f.dataset.mgiF; paint(); return; } const b = e.target.closest('[data-mgi]'); if(b){ sel = b.dataset.mgi; paint(); } });
      wrap.firstChild.addEventListener('keydown', e => {
        if(e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const all = [...wrap.firstChild.querySelectorAll('[data-mgi]')], i = all.findIndex(b => b.dataset.mgi === sel), n = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if(n){ e.preventDefault(); sel = n.dataset.mgi; paint(); const f = wrap.firstChild.querySelector('[data-mgi="' + CSS.escape(sel) + '"]'); if(f) f.focus(); }
      });
    }
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
    const all = items();
    // Waiting = everything; Mine = what is assigned to you (28-live-team.js owners).
    const me = typeof mgActorName === 'function' ? mgActorName() : '';
    const mineOf = x => !!me && typeof ltOwnerOf === 'function' && ltOwnerOf(x.key) === me;
    const nMine = all.filter(mineOf).length;
    if(filter === 'mine' && !nMine) filter = 'all';
    const its = filter === 'mine' ? all.filter(mineOf) : all;
    all.forEach(x => { if(!its.includes(x)) x.el.classList.remove('mgi-on'); });
    wrap.classList.toggle('mgi-empty', !all.length);
    if(!its.some(x => x.key === sel)) sel = its.length ? its[0].key : null;
    let html = '<div class="mgi-pills"><button type="button" class="mg-pill' + (filter === 'all' ? ' on' : '') + '" data-mgi-f="all" aria-pressed="' + (filter === 'all') + '">Waiting<b>' + all.length + '</b></button>' +
      '<button type="button" class="mg-pill' + (filter === 'mine' ? ' on' : '') + '" data-mgi-f="mine" aria-pressed="' + (filter === 'mine') + '"' + (nMine ? '' : ' disabled title="Nothing is assigned to you"') + '>Mine<b>' + nMine + '</b></button></div>', g = -1;
    its.forEach(x => {
      if(x.group !== g){ g = x.group; html += '<h4>' + esc(txt(x.card.querySelector('.ledger-list-title'))) + '</h4>'; }
      html += '<button type="button" role="option" class="mgi-it' + (x.key === sel ? ' on' : '') + '" aria-selected="' + (x.key === sel) + '" data-mgi="' + esc(x.key) + '"><strong>' + esc(x.title) + '</strong>' +
        (x.amount ? '<span>' + esc(x.amount) + '</span>' : '') + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</button>';
    });
    const list = wrap.firstChild;
    if(list.innerHTML !== html) list.innerHTML = html;
    its.forEach(x => x.el.classList.toggle('mgi-on', x.key === sel));
    // "Ask Margyn why" for the item in front of you: a question, never an action.
    const cur = its.find(x => x.key === sel), det = wrap.lastChild;
    let why = det.querySelector(':scope > .mgi-why');
    if(!cur){ if(why) why.remove(); }
    else { const q = 'Why is this in my Inbox, and what do you suggest? ' + cur.title + (cur.amount ? ' (' + cur.amount + ')' : '') + (cur.sub ? '. ' + cur.sub : '');
      if(!why){ why = document.createElement('div'); why.className = 'mgi-why'; det.appendChild(why); }
      const h = '<button type="button" class="mg-btn mg-btn-sm" data-mgr-ask="' + esc(q) + '">Ask Margyn why</button><span class="mgi-keys"><kbd>↑</kbd><kbd>↓</kbd> move between items</span>';
      if(why.innerHTML !== h) why.innerHTML = h; }
    CARDS.forEach(id => { const c = $(id); if(c) c.classList.toggle('mgi-has', its.some(x => x.card === c && x.key === sel)); });
  }
  // Show the Inbox item that holds this element (32-tabs.js mgReveal).
  window.mgInboxSelect = function(el){
    const it = items().find(x => x.el.contains(el)); if(!it || it.key === sel) return;
    sel = it.key; filter = 'all'; paint();
  };
  function queue(){ if(queued) return; queued = true; requestAnimationFrame(paint); }
  function boot(){
    const host = $('agentPanel-queue'); if(!host) return;
    const mo = new MutationObserver(queue);
    LISTS.forEach(id => { const l = $(id); if(l) mo.observe(l, { childList:true }); });
    CARDS.forEach(id => { const c = $(id); if(c) mo.observe(c, { attributes:true, attributeFilter:['class'] }); });
    queue();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

/* The menu folds to icons (56 px) for more room; the choice is remembered. */
(function(){
  const KEY = 'mg.rail', b = document.getElementById('mgRailToggle'); if(!b) return;
  const set = (min, save) => {
    document.body.classList.toggle('mg-rail-min', min);
    b.textContent = min ? '»' : '«'; b.title = min ? 'Show the menu names' : 'Collapse the menu'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(min));
    // folded: each item's name becomes its tooltip
    document.querySelectorAll('#sidebarNav .pagenav button[data-view]').forEach(n => { const t = (n.querySelector('span') || {}).textContent || ''; if(min) n.title = t; else n.removeAttribute('title'); });
    if(save){ try { localStorage.setItem(KEY, min ? 'min' : 'full'); } catch(e){} }
  };
  let was = false; try { was = localStorage.getItem(KEY) === 'min'; } catch(e){}
  set(was, false);
  b.addEventListener('click', () => set(!document.body.classList.contains('mg-rail-min'), true));
})();

/* Long lists: 50 rows at a time. The page still renders every row (search,
   totals and export are untouched); rows past the first 50 wait behind
   "Show 50 more". */
(function(){
  const STEP = 50, limit = new Map();     // list element -> rows shown
  const lists = root => [...root.querySelectorAll('.mg-grid > tbody, .lt-table')];
  const rowsOf = l => l.matches('tbody') ? [...l.rows] : [...l.querySelectorAll(':scope > .lt-row')];
  function apply(root){
    lists(root).forEach(l => {
      const rows = rowsOf(l).filter(r => !r.classList.contains('mg-more-row')), key = l.closest('[id^="view-"], #mgAutoChase') || root;
      const id = (key.id || '') + '|' + [...key.querySelectorAll('.mg-grid > tbody, .lt-table')].indexOf(l);
      const n = Math.max(STEP, limit.get(id) || STEP);
      let more = l.matches('tbody') ? l.querySelector(':scope > .mg-more-row') : l.querySelector(':scope > .mg-more-row');
      if(rows.length <= n + 10){ rows.forEach(r => r.classList.remove('mg-row-more')); if(more) more.remove(); return; }   // a few extra rows are not worth a button
      rows.forEach((r, i) => { const off = i >= n; if(r.classList.contains('mg-row-more') !== off) r.classList.toggle('mg-row-more', off); });
      const left = rows.length - n, label = 'Show ' + Math.min(STEP, left) + ' more', note = n + ' of ' + rows.length + ' shown';
      const inner = '<button type="button" class="mg-btn mg-btn-sm" data-mg-more="' + id + '">' + label + '</button><button type="button" class="mg-link" data-mg-more-all="' + id + '">Show all ' + rows.length + '</button><span>' + note + '</span>';
      if(!more){
        if(l.matches('tbody')){ more = document.createElement('tr'); more.className = 'mg-more-row'; const td = document.createElement('td'); td.colSpan = 99; more.appendChild(td); }
        else { more = document.createElement('div'); more.className = 'mg-more-row'; }
        l.appendChild(more);
      } else if(more !== l.lastElementChild) l.appendChild(more);
      const box = more.firstElementChild && more.matches('tr') ? more.firstElementChild : more;
      if(box.innerHTML !== inner) box.innerHTML = inner;
    });
  }
  let queued = false;
  const run = () => { queued = false; const w = document.querySelector('.app-body .wrap'); if(w) apply(w); };
  const queue = () => { if(!queued){ queued = true; requestAnimationFrame(run); } };
  document.addEventListener('click', e => {
    const m = e.target.closest('[data-mg-more]'), a = e.target.closest('[data-mg-more-all]');
    if(m){ limit.set(m.dataset.mgMore, (limit.get(m.dataset.mgMore) || STEP) + STEP); run(); }
    else if(a){ limit.set(a.dataset.mgMoreAll, 1e9); run(); }
  });
  // Something wants a row that is held back (Margyn pointing at it, a jump link): show the whole list.
  window.mgPagerShowAll = function(el){
    const r = el && el.closest && el.closest('.mg-row-more'); if(!r) return;
    const l = r.parentElement, key = l.closest('[id^="view-"], #mgAutoChase'); if(!key) return;
    limit.set((key.id || '') + '|' + [...key.querySelectorAll('.mg-grid > tbody, .lt-table')].indexOf(l), 1e9); run();
  };
  const boot = () => { const w = document.querySelector('.app-body .wrap'); if(!w) return; new MutationObserver(queue).observe(w, { childList:true, subtree:true }); queue(); };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

/* Phone bottom bar: Home, Inbox, Margyn, Money, More. More opens the full menu. */
(function(){
  const bar = document.getElementById('mgBottomBar'); if(!bar) return;
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-bb]'); if(!b) return;
    const k = b.dataset.bb;
    if(k === 'margyn'){ if(typeof mgrToggle === 'function') mgrToggle(); return; }
    if(k === 'more'){ const m = document.getElementById('mgMenuBtn'); if(m) m.click(); return; }
    if(typeof mgrIsOpen === 'function' && mgrIsOpen()) mgrClose(true);
    showView(k === 'money' ? 'cash' : k);
  });
  const paint = () => {
    const page = document.body.dataset.mgPage || '', grp = document.body.dataset.mgGroup || '';
    const on = page === 'home' ? 'home' : page === 'inbox' ? 'inbox' : (grp === 'Money' || grp === 'Parties') ? 'money' : 'more';
    bar.querySelectorAll('[data-bb]').forEach(b => b.classList.toggle('on', b.dataset.bb === on));
  };
  new MutationObserver(paint).observe(document.body, { attributes:true, attributeFilter:['data-mg-page', 'data-mg-group'] }); paint();
  const src = document.getElementById('agentsBadge'), dst = document.getElementById('mgBbBadge');
  if(src && dst){ const copy = () => { dst.textContent = src.textContent; dst.classList.toggle('hidden', src.classList.contains('hidden') || !src.textContent.trim()); };
    new MutationObserver(copy).observe(src, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class'] }); copy(); }
})();
