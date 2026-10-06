/* ============================================================
   LIVE WORK: what Margyn is doing right now, on Home.

   Home's "What I'm working on" panel (25-margyn.js mgrWorkingOn) keeps its
   rows; on top of them it now shows work that is running this second, and
   under them what was just done, with the time. Margyn's panel header says
   what is running too, on every page.

   Everything shown actually happened or is happening:
   - each call the app makes to /api, named by the job it does, while it runs
     ("Syncing Zoho Books…"),
   - background runs, from the tables those jobs write (Tally and Odoo sync
     runs, reconciliation runs, reminders sent, the forecast re-learning),
   - what the app already loaded (proposals, forwarded documents, chases).
   Nothing moves unless something is running.
   ============================================================ */

/* The jobs, and the page each one works on (a teammate sees a job only if
   their role may open that page, 19g-team.js). */
const LW_JOBS = {
  payments:{ name:'Payments', page:'inbox' },
  collections:{ name:'Collections', page:'receivables' },
  books:{ name:'Books', page:'books' },
  close:{ name:'Close', page:'inbox' },
  gst:{ name:'GST', page:'gst' },
  documents:{ name:'Documents', page:'inbox' },
  forecast:{ name:'Forecast', page:'cash' },
  watch:{ name:'Watch', page:'channels' },
  team:{ name:'Team', page:null },
  margyn:{ name:'Margyn', page:null }
};
function lwJobAllowed(k){ const j = LW_JOBS[k]; return !j || !j.page || typeof mgPageAllowed !== 'function' || mgPageAllowed(j.page); }

/* ---------- the activity record ---------- */
const lwAct = [];          // { id, job, text, state:'running'|'done'|'error', at, end, key }
let lwActSeq = 0;
const lwListeners = [];
function lwChanged(){ lwListeners.forEach(f => { try { f(); } catch(e){} }); }
function lwAdd(a){
  if(a.key){ const old = lwAct.find(x => x.key === a.key); if(old){ Object.assign(old, a); lwChanged(); return old; } }
  a.id = ++lwActSeq; lwAct.push(a);
  lwAct.sort((x, y) => new Date(y.end || y.at) - new Date(x.end || x.at));
  if(lwAct.length > 160) lwAct.length = 160;
  lwChanged();
  return a;
}
function lwRunning(){ return lwAct.filter(a => a.state === 'running' && lwJobAllowed(a.job)); }
function lwSince(iso){
  if(!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
}

/* Calls the app makes, named by the job they do. First match wins. */
const LW_CALLS = [
  [/\/api\/reconcile\?action=summary/, 'payments', 'Checking payments against invoices', 'Checked payments against invoices'],
  [/\/api\/reconcile\?action=position/, 'books', 'Working out who owes what across your books', 'Worked out who owes what'],
  [/\/api\/reconcile\?action=agent-actions/, 'close', 'Collecting proposals from the last run', 'Collected proposals'],
  [/\/api\/reconcile\?action=resolve/, 'payments', 'Applying your decision', 'Applied your decision'],
  [/\/api\/reconcile\?action=agent-review/, 'close', 'Applying your decision', 'Applied your decision'],
  [/\/api\/reconcile\?action=channel-health/, 'watch', 'Checking your messages reached people', 'Checked message delivery'],
  [/\/api\/generate-findings\?action=parse-import/, 'documents', 'Reading the file you gave me', 'Read your file'],
  [/\/api\/generate-findings/, 'books', 'Recomputing your vitals and Pulse Score', 'Recomputed your vitals'],
  [/\/api\/generate-briefing/, 'watch', 'Writing your briefing', 'Wrote your briefing'],
  [/\/api\/tally\?action=books-check-set/, 'books', 'Updating your books check', 'Updated your books check'],
  [/\/api\/tally\?action=books-check/, 'books', 'Checking your books for things to fix', 'Checked your books'],
  [/\/api\/tally\?action=completeness/, 'books', 'Checking every Tally voucher reached Margyn', 'Checked Tally data is complete'],
  [/\/api\/tally\?action=analytics/, 'books', 'Working out margins from Tally', 'Worked out margins'],
  [/\/api\/tally\?action=(status|summary)/, 'books', 'Reading Tally', 'Read Tally'],
  [/\/api\/zoho\?action=vitals/, 'books', 'Reading Zoho Books', 'Read Zoho Books'],
  [/\/api\/zoho\?action=sync/, 'books', 'Syncing Zoho Books', 'Synced Zoho Books'],
  [/\/api\/zoho\?action=odoo-sync/, 'books', 'Syncing Odoo', 'Synced Odoo'],
  [/\/api\/zoho\?action=odoo-status/, 'books', 'Reading Odoo', 'Read Odoo'],
  [/\/api\/sync-razorpay\?action=cashfree-status/, 'payments', 'Reading Cashfree', 'Read Cashfree'],
  [/\/api\/sync-razorpay/, 'payments', 'Syncing Razorpay', 'Synced Razorpay'],
  [/\/api\/shopify\?action=sync/, 'payments', 'Syncing Shopify orders', 'Synced Shopify'],
  [/\/api\/shopify\?action=status/, 'payments', 'Reading Shopify', 'Read Shopify'],
  [/\/api\/ask-margyn\?action=watch/, 'watch', 'Reading what I noticed in your books', 'Read what I noticed'],
  [/\/api\/ops\?action=cron-cfo-pack|cfo-pack-test/, 'close', 'Preparing the CFO pack', 'Prepared the CFO pack']
];
(function hookFetch(){
  if(window.__lwFetch) return; window.__lwFetch = true;
  const base = window.fetch.bind(window);
  window.fetch = function(input, init){
    let url = ''; try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch(e){}
    const rule = LW_CALLS.find(r => r[0].test(url));
    const p = base(input, init);
    if(!rule) return p;
    const a = lwAdd({ job:rule[1], text:rule[2] + '…', state:'running', at:new Date().toISOString() });
    // A call that finishes in a blink still shows for 1.5 s, so you see what Margyn just did.
    const t0 = Date.now();
    const settle = (ok, text) => setTimeout(() => { a.state = ok ? 'done' : 'error'; a.text = text; a.end = new Date().toISOString(); lwChanged(); }, Math.max(0, 1500 - (Date.now() - t0)));
    p.then(r => settle(r.ok, r.ok ? rule[3] : rule[2] + ': it didn’t answer (' + r.status + ')'), () => settle(false, rule[2] + ': couldn’t reach it'));
    return p;
  };
})();

/* ---------- background work, from the tables each job writes ---------- */
function lwOwner(){ return (typeof mgActor !== 'undefined' && mgActor && mgActor.accountId) || (currentUser && currentUser.id); }
const LW_SYNC_KIND = { ledgers:'ledgers', vouchers:'vouchers', bills:'bills', pair:'pairing', invoices:'invoices', connect:'connection', full:'everything', items:'stock items', structure:'structure' };
let lwServerAt = 0, lwServerBusy = false;
async function lwLoadServer(force){
  if(!currentUser || !sbClient || lwServerBusy) return;
  if(!force && Date.now() - lwServerAt < 45000) return;
  lwServerBusy = true; lwServerAt = Date.now();
  const uid = lwOwner(), since = new Date(Date.now() - 3 * 86400000).toISOString();
  const q = async fn => { try { const r = await fn(); return (r && r.data) || []; } catch(e){ return []; } };
  const [tally, odoo, events, fc] = await Promise.all([
    q(() => sbClient.from('tally_sync_runs').select('id,kind,status,rows_upserted,started_at,finished_at,error_message').eq('user_id', uid).gte('started_at', since).order('started_at', { ascending:false }).limit(12)),
    q(() => sbClient.from('odoo_sync_runs').select('id,kind,status,rows_upserted,started_at,finished_at').eq('user_id', uid).gte('started_at', since).order('started_at', { ascending:false }).limit(6)),
    q(() => sbClient.from('product_events').select('id,name,props,at').eq('user_id', uid).in('name', ['reconcile_run', 'tally_agent_sync', 'whatsapp_outbound']).gte('at', since).order('at', { ascending:false }).limit(20)),
    q(() => sbClient.from('forecast_runs').select('run_date,updated_at').eq('user_id', uid).order('run_date', { ascending:false }).limit(1))
  ]);
  const fresh = iso => iso && (Date.now() - new Date(iso).getTime()) < 20 * 60000;
  [[tally, 'Tally', 'tally'], [odoo, 'Odoo', 'odoo']].forEach(([rows, app, k]) => rows.forEach(r => {
    const running = !r.finished_at && fresh(r.started_at);
    if(!r.finished_at && !running) return;   // a run that never finished long ago isn't running
    const what = LW_SYNC_KIND[r.kind] || r.kind;
    lwAdd({ key:k + ':' + r.id, job:'books', at:r.started_at, end:r.finished_at || null, state:running ? 'running' : r.status === 'ok' ? 'done' : 'error',
      text:running ? 'Syncing ' + app + ' ' + what + '…' : r.status === 'ok' ? 'Synced ' + app + ' ' + what + (r.rows_upserted ? ' · ' + Number(r.rows_upserted).toLocaleString('en-IN') + ' rows' : '') : app + ' ' + what + ' sync failed' + (r.error_message ? ': ' + String(r.error_message).slice(0, 80) : '') });
  }));
  events.forEach(e => {
    const p = e.props || {};
    if(e.name === 'reconcile_run') lwAdd({ key:'ev:' + e.id, job:'payments', at:e.at, end:e.at, state:'done', text:'Ran reconciliation' + (p.matched != null ? ' · ' + p.matched + ' matched' : '') + (p.needs_review ? ' · ' + p.needs_review + ' to check' : '') });
    else if(e.name === 'tally_agent_sync') lwAdd({ key:'ev:' + e.id, job:'books', at:e.at, end:e.at, state:'done', text:'The Tally agent on your PC sent new figures' });
    else if(e.name === 'whatsapp_outbound') lwAdd({ key:'ev:' + e.id, job:p.kind === 'chase' ? 'collections' : 'watch', at:e.at, end:e.at, state:'done', text:p.kind === 'chase' ? 'Sent a payment reminder on WhatsApp' : 'Sent you an update on WhatsApp' });
  });
  if(fc[0] && fc[0].updated_at) lwAdd({ key:'fc:' + fc[0].run_date, job:'forecast', at:fc[0].updated_at, end:fc[0].updated_at, state:'done', text:'Re-learned the 13-week forecast from your books' });
  lwFromGlobals();
  lwServerBusy = false;
  lwChanged();
}
/* What the app already loaded says what happened too. */
function lwFromGlobals(){
  try { (chaseTargets || []).forEach(t => {
    if(t.last_chase_at) lwAdd({ key:'chase:' + (t.id || t.party_name) + ':' + t.last_chase_at, job:'collections', at:t.last_chase_at, end:t.last_chase_at, state:'done', text:'Sent ' + (t.party_name || 'a customer') + ' a reminder' + (t.amount ? ' for ' + fmtINR(Number(t.amount), 'tile') : '') });
    if(t.state === 'resolved_paid' && t.resolved_at) lwAdd({ key:'paid:' + (t.id || t.party_name), job:'collections', at:t.resolved_at, end:t.resolved_at, state:'done', text:(t.party_name || 'A customer') + ' paid after a reminder' + (t.amount ? ' · ' + fmtINR(Number(t.amount), 'tile') : '') });
  }); } catch(e){}
  try { (pendingSuggestions || []).forEach(p => { const ents = (p.proposal && p.proposal.entries) || []; const at = p.received_at || p.created_at; if(at) lwAdd({ key:'doc:' + p.id, job:'documents', at, end:at, state:'done', text:'Read a document' + (ents[0] && ents[0].party ? ' from ' + ents[0].party : '') }); }); } catch(e){}
  try { ((agentActions && agentActions.actions) || []).forEach(a => { if(a.created_at) lwAdd({ key:'act:' + a.id, job:a.kind === 'itc_risk' ? 'gst' : 'close', at:a.created_at, end:a.created_at, state:'done', text:'Proposed: ' + a.title }); }); } catch(e){}
  try { const v = reconSummary && reconSummary.provenance && reconSummary.provenance.last_verified_at;
    if(v) lwAdd({ key:'recon:' + v, job:'payments', at:v, end:v, state:'done', text:'Verified payments against Zoho Books' + (reconSummary.counts ? ' · ' + reconSummary.counts.verified + ' matched' : '') }); } catch(e){}
}
// What Margyn applied from its panel is work done too.
if(typeof mgStatus === 'function'){
  const baseStatus = mgStatus;
  mgStatus = function(text){ const out = baseStatus.apply(this, arguments);
    try { if(/^Applied:/.test(String(text || ''))) lwAdd({ job:'margyn', text:String(text), state:'done', at:new Date().toISOString(), end:new Date().toISOString() }); } catch(e){}
    return out; };
}

/* ---------- Home: "What I'm working on" ---------- */
function lwNowRows(){
  return lwRunning().slice(0, 4).map(a => '<div class="mgd-task lw-now"><span class="mgd-dot doing"></span><div><b>' + escapeHtml(a.text) + '</b><span>' + escapeHtml((LW_JOBS[a.job] || {}).name || 'Margyn') + '</span><i class="lw-bar"></i></div><span class="mgd-st lw-st">NOW</span></div>').join('');
}
function lwDoneRows(){
  const done = lwAct.filter(a => a.state !== 'running' && lwJobAllowed(a.job)).slice(0, 5);
  if(!done.length) return '';
  return '<div class="lw-done"><div class="lw-done-h">Just done</div>' + done.map(a =>
    '<div class="lw-done-r' + (a.state === 'error' ? ' bad' : '') + '"><span>' + escapeHtml(a.text) + '</span><small>' + escapeHtml(lwSince(a.end || a.at)) + '</small></div>').join('') + '</div>';
}
const lwBaseWorkingOn = mgrWorkingOn;
mgrWorkingOn = function(){
  return '<div id="lwWorking">' + lwNowRows() + lwBaseWorkingOn.apply(this, arguments) + lwDoneRows() + '</div>';
};
// The panel's "live" label says how many are running, from the first render.
if(typeof mgrDeskTop === 'function'){
  const baseTop = mgrDeskTop;
  mgrDeskTop = function(){
    const n = lwRunning().length, html = baseTop.apply(this, arguments);
    return n ? html.replace('<h2>What I’m working on</h2><span class="mg-aside">live</span>', '<h2>What I’m working on</h2><span class="mg-aside lw-live">' + n + ' running now</span>') : html;
  };
}
function lwPaintHome(){
  const el = document.getElementById('lwWorking'); if(!el) return;
  el.innerHTML = lwNowRows() + lwBaseWorkingOn() + lwDoneRows();
  const aside = el.closest('.mg-panel') && el.closest('.mg-panel').querySelector('.mg-panel-h .mg-aside');
  if(aside){ const n = lwRunning().length; aside.classList.toggle('lw-live', n > 0); aside.textContent = n ? n + ' running now' : 'live'; }
}

/* ---------- Margyn's panel header: what is running, on every page ---------- */
function lwPaintPanel(){
  const sub = document.getElementById('mgrSub'); if(!sub) return;
  const run = lwRunning();
  if(run.length){
    sub.textContent = run[0].text + (run.length > 1 ? ' (+' + (run.length - 1) + ' more)' : '');
    sub.classList.add('live'); sub.dataset.lw = '1';
  } else if(sub.dataset.lw){
    delete sub.dataset.lw; sub.classList.remove('live'); sub.textContent = 'Your finance operator';
  }
}

/* ---------- keep it current ---------- */
let lwQueued = false;
lwListeners.push(() => {
  if(lwQueued) return; lwQueued = true;
  requestAnimationFrame(() => { lwQueued = false; lwPaintHome(); lwPaintPanel(); });
});
(function(){
  const base = refreshAll;
  refreshAll = async function(){ const out = await base.apply(this, arguments); try { lwFromGlobals(); lwLoadServer(); lwChanged(); } catch(e){ console.error('[live] after refresh', e); } return out; };
})();
setInterval(() => { if(!document.hidden && currentUser) lwLoadServer(); }, 60000);
setInterval(() => { if(!document.hidden && typeof mgCurrentView !== 'undefined' && mgCurrentView === 'home') lwPaintHome(); }, 30000);   // "2 min ago" stays true
