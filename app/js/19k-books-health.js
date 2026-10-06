/* Books health check (2026-10-07): what's wrong in the books that the accountant should fix, checked every
   morning for every account with books (api/_lib/booksHealth.js). Lives on Organisations and sources, above
   "Is all your data in?", and its count shows on Home under "Needs you".
   GET /api/tally?action=books-check[&refresh=1], POST ?action=books-check-set { key, status: 'ignored' | 'open' }.
   Nothing is sent by Margyn: "Send to my accountant" opens WhatsApp with the list (the person presses send) or copies it. */
let mgBH = null, mgBHAt = 0, mgBHBusy = false;
const mgBHOpenSecs = new Set();   // sections the person opened stay open when the panel redraws
const mgBHSec = k => ' data-bh-sec="' + k + '"' + (mgBHOpenSecs.has(k) ? ' open' : '');
async function mgBHFetch(path, init){
  const { data:{ session } } = await sbClient.auth.getSession();
  if(!session) throw new Error('signed out');
  const res = await fetch(path, Object.assign({}, init || {}, { headers:Object.assign({ 'Authorization':'Bearer ' + session.access_token }, (init && init.headers) || {}) }));
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function mgLoadBooksHealth(force){
  if(mgBHBusy || (!force && mgBH && !mgBH.error && Date.now() - mgBHAt < 10 * 60000)) return;
  if(typeof mgBooksConnected === 'function' ? !mgBooksConnected() : !(typeof tallyConnected !== 'undefined' && tallyConnected)) return;
  mgBHBusy = true;
  try { mgBH = await mgBHFetch('/api/tally?action=books-check' + (force ? '&refresh=1' : '')); mgBHAt = Date.now(); }
  catch(e){ console.error('[margyn] books check:', e.message); mgBH = { error:true }; }
  finally {
    mgBHBusy = false; mgRenderBooksHealth();
    // Home's "Needs you" lists it too.
    try { if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'home' && typeof mgRenderOwn === 'function') mgRenderOwn('home'); } catch(e){}
  }
}
function mgBHOpen(){ return ((mgBH && mgBH.items) || []).filter(x => x.status === 'open'); }
const MG_BH_BADGE = { high:'<span class="mg-bdg neg">Fix first</span>', medium:'<span class="mg-bdg warn">Fix</span>', low:'<span class="mg-bdg">Look</span>' };
function mgBHWhen(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit' });
}
function mgBHItem(x, compact){
  const meta = x.status === 'ignored' ? 'Ignored' + (x.ignored_by ? ' by ' + x.ignored_by : '') + '. Comes back if the amount changes by more than a quarter.'
    : x.status === 'open' && x.first_seen ? 'First seen ' + new Date(x.first_seen).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '';
  return '<div class="mg-bh-item" style="padding:8px 0;' + (compact ? 'border-top:1px dashed var(--g100);' : '') + '">' +
    '<div style="display:flex;gap:10px;justify-content:space-between;align-items:baseline;"><b style="font-size:13px;">' + escapeHtml(x.title) + '</b>' +
      (x.amount ? '<span class="mono" style="white-space:nowrap;font-size:13px;">' + escapeHtml(fmtINR(x.amount, 'tile')) + '</span>' : '') + '</div>' +
    '<div class="mg-muted" style="font-size:13px;margin-top:2px;">' + escapeHtml(x.detail || '') + '</div>' +
    '<div style="font-size:13px;margin-top:4px;"><b>' + (x.for_accountant ? 'For your accountant: ' : 'What to do: ') + '</b>' + escapeHtml(x.fix || '') + '</div>' +
    '<div class="mg-muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(meta) +
      (x.status === 'open' ? ' <button class="mg-link" type="button" data-bh-set="' + escapeHtml(x.key) + '" data-to="ignored" style="margin-left:6px;">Ignore</button>'
        : x.status === 'ignored' ? ' <button class="mg-link" type="button" data-bh-set="' + escapeHtml(x.key) + '" data-to="open" style="margin-left:6px;">Bring back</button>' : '') + '</div></div>';
}
function mgRenderBooksHealth(){
  const host = document.getElementById('mgBooksHealth'); if(!host) return;
  if(typeof mgBooksConnected === 'function' ? !mgBooksConnected() : !(typeof tallyConnected !== 'undefined' && tallyConnected)){ host.innerHTML = ''; return; }
  const head = '<div class="rd-section-label">Books health check <span class="rd-note">Checked every morning: what your accountant should fix in the books</span></div>';
  const d = mgBH;
  if(!d){ host.innerHTML = head + '<div class="rd-card" style="padding:16px 20px;"><span class="mg-muted">Checking your books…</span></div>'; mgLoadBooksHealth(); return; }
  if(d.error || !d.connected){ host.innerHTML = head + '<div class="rd-card" style="padding:16px 20px;"><span class="mg-muted">Couldn’t run the check just now.</span> <button class="mg-link" type="button" data-bh-run>Try again</button></div>'; return; }
  const items = d.items || [];
  const open = items.filter(x => x.status === 'open'), ignored = items.filter(x => x.status === 'ignored'), fixed = items.filter(x => x.status === 'fixed');
  const toFix = open.filter(x => x.for_accountant);
  const top = '<div style="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
    '<div class="mg-muted" style="font-size:12px;">' + escapeHtml([d.company, d.source, d.checked_at ? 'Checked ' + mgBHWhen(d.checked_at) : '', fixed.length ? fixed.length + ' fixed in the last 30 days' : ''].filter(Boolean).join(' · ')) +
      ' <button class="mg-link" type="button" data-bh-run style="margin-left:6px;">Check again</button></div>' +
    (toFix.length ? '<button class="mg-btn primary mg-btn-sm" type="button" data-bh-send>Send to my accountant</button>' : '') + '</div>';
  let body;
  if(!open.length) body = '<div style="padding:6px 0;"><span class="mg-bdg pos">OK</span> <b style="font-size:13px;margin-left:6px;">Nothing to fix in your books right now.</b>' +
    '<div class="mg-muted" style="font-size:13px;margin-top:4px;">Margyn checks again every morning and tells you here and on Home when something turns up.</div></div>';
  else {
    // One row per kind of problem; several of a kind fold into a list.
    const kinds = [];
    open.forEach(x => { if(!kinds.includes(x.kind)) kinds.push(x.kind); });
    body = '<table style="width:100%;border-collapse:collapse;"><tbody>' + kinds.map(k => {
      const list = open.filter(x => x.kind === k);
      const sev = list.some(x => x.severity === 'high') ? 'high' : list.some(x => x.severity === 'medium') ? 'medium' : 'low';
      const badge = list[0].for_accountant ? MG_BH_BADGE[sev] : '<span class="mg-bdg">Note</span>';
      if(list.length === 1) return '<tr><td style="white-space:nowrap;vertical-align:top;padding-top:10px;">' + badge + '</td><td style="vertical-align:top;">' + mgBHItem(list[0]) + '</td></tr>';
      const tot = list.reduce((t, x) => t + (Number(x.amount) || 0), 0);
      const title = (d.groups && d.groups[k]) || list[0].title;
      return '<tr><td style="white-space:nowrap;vertical-align:top;padding-top:10px;">' + badge + '</td><td style="vertical-align:top;padding:8px 0;">' +
        '<details' + mgBHSec(k) + '><summary style="cursor:pointer;"><b style="font-size:13px;">' + escapeHtml(title) + '</b> <span class="mg-muted" style="font-size:13px;">' + list.length + ' · ' + escapeHtml(fmtINR(tot, 'tile')) + '</span>' +
        '<div class="mg-muted" style="font-size:12px;margin-top:2px;">Biggest: ' + list.slice(0, 3).map(x => escapeHtml(x.party ? mgCleanName(x.party) : x.title)).join(' · ') + '</div></summary>' +
        list.map(x => mgBHItem(x, true)).join('') + '</details></td></tr>';
    }).join('') + '</tbody></table>';
  }
  const ig = ignored.length ? '<details' + mgBHSec('ignored') + ' style="margin-top:10px;"><summary class="mg-muted" style="cursor:pointer;font-size:13px;">Ignored (' + ignored.length + ')</summary>' + ignored.map(x => mgBHItem(x, true)).join('') + '</details>' : '';
  const fx = fixed.length ? '<details' + mgBHSec('fixed') + ' style="margin-top:6px;"><summary class="mg-muted" style="cursor:pointer;font-size:13px;">Fixed in the last 30 days (' + fixed.length + ')</summary>' +
    fixed.map(x => '<div style="font-size:13px;padding:6px 0;border-top:1px dashed var(--g100);"><span class="mg-bdg pos">Fixed</span> ' + escapeHtml(x.title) + (x.fixed_at ? ' <span class="mg-muted">· ' + escapeHtml(new Date(x.fixed_at).toLocaleDateString('en-IN', { day:'numeric', month:'short' })) + '</span>' : '') + '</div>').join('') + '</details>' : '';
  const note = d.ready === false ? '<div class="mg-muted" style="font-size:12px;margin-top:8px;">Today’s findings. Margyn starts keeping their history (fixed and ignored) once the books health update is switched on.</div>' : '';
  host.innerHTML = head + '<div class="rd-card" id="mgBooksHealthCard" style="padding:12px 20px;">' + top + body + ig + fx + note + '</div>';
}
async function mgBHSet(key, to){
  try {
    await mgBHFetch('/api/tally?action=books-check-set', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ key, status:to }) });
    const x = ((mgBH && mgBH.items) || []).find(i => i.key === key);
    if(x){ x.status = to; if(to === 'ignored') x.ignored_by = (typeof mgActor !== 'undefined' && mgActor && mgActor.name) || null; }
    if(typeof toast === 'function') toast(to === 'ignored' ? 'Ignored' : 'Brought back', { kind:'info', sub:to === 'ignored' ? 'It comes back only if the amount changes by more than a quarter.' : 'It’s on the list again.' });
    mgBH.accountant_text = mgBH.accountant_text_full = null;   // the list changed: rebuilt on the next read
    mgRenderBooksHealth();
    mgLoadBooksHealth(true);
  } catch(e){
    if(typeof toast === 'function') toast('Couldn’t change that', { kind:'error', sub:/409/.test(e.message) ? 'The books health update isn’t switched on yet.' : 'Try again in a moment.' });
  }
}
/* "Send to my accountant": shows the list first. Margyn sends nothing; WhatsApp opens with the text and the person presses send. */
function mgBHSend(){
  const d = mgBH;
  const full = d && (d.accountant_text_full || d.accountant_text);
  if(!full){ mgShowBooksHealth(); return; }
  const prevFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'mg-dialog-scrim';
  scrim.innerHTML = '<div class="mg-dialog" role="dialog" aria-modal="true" aria-labelledby="mgBHTitle" style="width:min(560px,100%);">' +
    '<h3 id="mgBHTitle">Send to my accountant</h3>' +
    '<p>This is the list. Margyn won’t send it by itself: open it in WhatsApp and press send there, or copy it into an email.</p>' +
    '<textarea readonly class="mono" style="width:100%;height:260px;margin-top:12px;font-size:12px;line-height:1.45;padding:10px;border:1px solid var(--g200);border-radius:var(--r-ctl);background:var(--g25);resize:vertical;">' + escapeHtml(full) + '</textarea>' +
    '<div class="mg-foot"><button class="mg-btn mg-dlg-cancel" type="button">Close</button><button class="mg-btn" type="button" data-bh-copy>Copy</button>' +
    '<button class="mg-btn primary" type="button" data-bh-wa>Open in WhatsApp</button></div></div>';
  document.body.appendChild(scrim);
  const done = () => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if(prevFocus && prevFocus.focus) prevFocus.focus(); };
  const onKey = e => { if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); done(); } };
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', e => {
    if(e.target === scrim || e.target.closest('.mg-dlg-cancel')) return done();
    if(e.target.closest('[data-bh-copy]')){
      try { navigator.clipboard.writeText(full); e.target.textContent = 'Copied'; } catch(err){ scrim.querySelector('textarea').select(); }
      return;
    }
    if(e.target.closest('[data-bh-wa]')){
      // A WhatsApp link has a length limit: the shorter list, with a pointer to the full one in Margyn.
      window.open('https://wa.me/?text=' + encodeURIComponent(d.accountant_text || full), '_blank', 'noopener');
      done();
    }
  });
  scrim.querySelector('[data-bh-wa]').focus();
}
function mgShowBooksHealth(){
  if(typeof mgGo === 'function') mgGo('connectors');
  setTimeout(() => { const el = document.getElementById('mgBooksHealth'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }, 120);
}
document.addEventListener('toggle', e => {
  const d = e.target; if(!d || !d.dataset || !d.dataset.bhSec) return;
  if(d.open) mgBHOpenSecs.add(d.dataset.bhSec); else mgBHOpenSecs.delete(d.dataset.bhSec);
}, true);
document.addEventListener('click', e => {
  if(!e.target.closest) return;
  const s = e.target.closest('[data-bh-set]'); if(s){ mgBHSet(s.dataset.bhSet, s.dataset.to); return; }
  if(e.target.closest('[data-bh-run]')){ mgBH = null; mgRenderBooksHealth(); mgLoadBooksHealth(true); return; }
  if(e.target.closest('[data-bh-send]')){ mgBHSend(); return; }
});
