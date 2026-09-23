/* ============================================================
   DETAIL DRAWER (plan §7.4): opens from the right, keeps your place
   in the list. Used for a customer/vendor from Receivables, Payables,
   Customers and Vendors, and for the forecast assumptions.
   Read-only: shows what each source says and the activity log.
   ============================================================ */
let mgDrawerEl = null, mgDrawerPrevFocus = null;
function mgCloseDrawer(){
  if(!mgDrawerEl) return;
  mgDrawerEl.remove(); mgDrawerEl = null;
  document.removeEventListener('keydown', mgDrawerKey, true);
  if(mgDrawerPrevFocus && mgDrawerPrevFocus.focus) mgDrawerPrevFocus.focus();
}
function mgDrawerKey(e){ if(e.key === 'Escape' && mgDrawerEl && !document.querySelector('.mg-dialog-scrim')){ e.stopPropagation(); mgCloseDrawer(); } }
/* mgDrawer({ title, sub, tabs:[[key,label,html]], body, foot, onInput }) */
function mgDrawer(o){
  mgCloseDrawer();
  mgDrawerPrevFocus = document.activeElement;
  const el = document.createElement('div');
  el.className = 'mg-drawer-scrim';
  const tabs = o.tabs || null;
  el.innerHTML = '<aside class="mg-drawer" role="dialog" aria-modal="true" aria-labelledby="mgDrawerTitle">' +
    '<div class="mg-drawer-h"><div><h3 id="mgDrawerTitle">' + escapeHtml(o.title || '') + '</h3>' +
      (o.sub ? '<div class="mg-drawer-sub">' + o.sub + '</div>' : '') + '</div>' +
      '<button class="mg-icon-btn" type="button" data-drawer-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
    (tabs ? '<div class="mg-drawer-tabs" role="tablist">' + tabs.map((t, i) => '<button type="button" role="tab" data-dtab="' + t[0] + '" class="' + (i ? '' : 'on') + '">' + escapeHtml(t[1]) + '</button>').join('') + '</div>' : '') +
    '<div class="mg-drawer-b">' + (tabs ? tabs.map((t, i) => '<div data-dpanel="' + t[0] + '"' + (i ? ' hidden' : '') + '>' + t[2] + '</div>').join('') : (o.body || '')) + '</div>' +
    (o.foot ? '<div class="mg-drawer-f">' + o.foot + '</div>' : '') +
  '</aside>';
  document.body.appendChild(el);
  mgDrawerEl = el;
  el.addEventListener('click', e => {
    if(e.target === el || e.target.closest('[data-drawer-close]')){ mgCloseDrawer(); return; }
    const t = e.target.closest('[data-dtab]');
    if(t){
      el.querySelectorAll('[data-dtab]').forEach(b => b.classList.toggle('on', b === t));
      el.querySelectorAll('[data-dpanel]').forEach(p => { p.hidden = p.dataset.dpanel !== t.dataset.dtab; });
    }
  });
  if(o.onInput){ el.addEventListener('input', e => o.onInput(e.target)); el.addEventListener('change', e => { if(e.target.type === 'checkbox') o.onInput(e.target); }); }
  document.addEventListener('keydown', mgDrawerKey, true);
  const first = el.querySelector('[data-dtab], input, [data-drawer-close]'); if(first) first.focus();
}

/* ---------- a customer or vendor, across every source ---------- */
function mgOpenParty(dir, key){
  const g = mgMoneyGroups(dir).find(x => x.key === key); if(!g) return;
  const who = dir === 'recv' ? 'Customer' : 'Vendor';
  const prim = g.by[g.primary];
  const rows = prim.rows.slice().sort((a, b) => (a.days ?? 9e9) - (b.days ?? 9e9));
  const details =
    '<div class="mg-dl">' +
      '<div><span>' + (dir === 'recv' ? 'Owes you' : 'You owe') + '</span><b>' + escapeHtml(fmtINR(g.amount)) + '</b></div>' +
      '<div><span>Overdue</span><b class="' + (g.overdue ? 'neg' : '') + '">' + escapeHtml(fmtINR(g.overdue)) + '</b></div>' +
      '<div><span>Open ' + (dir === 'recv' ? 'invoices' : 'bills') + '</span><b>' + g.invoices + '</b></div>' +
      '<div><span>Agreement</span><b>' + mgAgreeBadge(g) + '</b></div>' +
      '<div><span>Figures from</span><b class="txt">' + escapeHtml(MG_SRC_NAME[g.primary]) + '</b></div>' +
    '</div>' +
    '<table class="mg-grid"><thead><tr><th>Reference</th><th>Status</th><th class="r">Amount (₹)</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td class="mg-mono">' + escapeHtml(r.ref || '—') + '</td><td>' + mgStatusBadge(r.days, dir) + '</td><td class="r">' + mgNum(r.amount) + '</td></tr>').join('') +
    '</tbody></table>';
  const sources = '<p class="mg-fine" style="margin:0 0 12px">Each source exactly as it reports this ' + who.toLowerCase() + '. They are compared, never added.</p>' +
    g.sources.map(s => {
      const h = mgSourceHealth(s);
      const b = g.by[s];
      return '<div class="mg-src-block"><div class="mg-src-block-h">' + mgLogo(s) + '<b>' + escapeHtml(MG_SRC_NAME[s]) + '</b><span class="mg-fine">' + escapeHtml(h.text || '') + '</span><span class="mg-src-amt">' + escapeHtml(fmtINR(b.amount)) + '</span></div>' +
        b.rows.map(r => '<div class="mg-src-row"><span class="mg-mono">' + escapeHtml(r.ref || '—') + '</span><span>' + (r.due ? escapeHtml(fmtDay(r.due)) : 'No due date') + '</span><span class="mg-mono">' + mgNum(r.amount) + '</span></div>').join('') + '</div>';
    }).join('') +
    (g.status === 'conflict' ? '<div class="mg-fc-callout warn">Sources differ by ' + escapeHtml(fmtINR(g.diff)) + '. Margyn uses ' + escapeHtml(MG_SRC_NAME[g.primary]) + ' and flags the difference; it never averages them.</div>' : '');
  const ev = ((typeof ledgerEvents !== 'undefined' && ledgerEvents) || []).filter(e => normPartyName(e.party_name) === g.key);
  const activity = ev.length
    ? ev.map(e => '<div class="mg-act"><div class="mg-act-t">' + escapeHtml((e.event || '') + ' ' + (e.entity_type || '')) + (e.amount != null ? ' · ' + escapeHtml(fmtINR(e.amount)) : '') + '</div><div class="mg-fine">' + escapeHtml((e.created_at ? fmtDate(e.created_at) : '') + (e.source ? ' · ' + e.source : '') + (e.note ? ' · ' + e.note : '')) + '</div></div>').join('')
    : '<div class="mg-empty">No changes recorded for this ' + who.toLowerCase() + ' yet.</div>';
  mgDrawer({
    title:g.party,
    sub:escapeHtml(who + ' · ' + g.sources.map(s => MG_SRC_NAME[s]).join(', ')),
    tabs:[['details', 'Details', details], ['sources', 'Sources', sources], ['activity', 'Activity', activity]],
    foot:'<button class="mg-btn" type="button" data-drawer-ask="' + escapeHtml(g.party) + '">Ask Margyn about ' + escapeHtml(g.party) + '</button>' +
      (mgCurrentView === 'customers' || mgCurrentView === 'vendors' ? '<button class="mg-btn primary" type="button" data-drawer-list="' + escapeHtml(g.party) + '" data-dir="' + dir + '">Open in ' + (dir === 'recv' ? 'Receivables' : 'Payables') + '</button>' : '')
  });
}
document.addEventListener('click', e => {
  const ask = e.target.closest('[data-drawer-ask]');
  if(ask){ const t = ask.dataset.drawerAsk; mgCloseDrawer(); if(typeof openMargynFocused === 'function') openMargynFocused(t, null); return; }
  const list = e.target.closest('[data-drawer-list]');
  if(list){ mgMoneyQ = list.dataset.drawerList; mgMoneySrc = 'reconciled'; mgMoneyAge = null; mgCloseDrawer(); mgGo(list.dataset.dir === 'recv' ? 'receivables' : 'payables'); return; }
  const open = e.target.closest('[data-open-party]');
  if(open && !e.target.closest('button')){ mgOpenParty(open.dataset.dir, open.dataset.openParty); }
});
