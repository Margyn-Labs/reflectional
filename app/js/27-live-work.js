/* ============================================================
   LIVE WORK: what Margyn is doing right now, on Home.

   Home's "What I'm working on" panel is one tile per job (what is running
   this second, what needs the owner, what each job last did), the day's
   WhatsApp updates on a line, each source's last sync, and what was just
   done, with the time. Margyn's panel header says
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

/* /api/tally answers for every books system (status, analytics), so name the account's own: a Zoho
   account never reads "Read Tally". */
function lwBooksName(){ try { return (typeof mgDataCheckSource === 'function' && mgDataCheckSource()) || 'your books'; } catch(e){ return 'your books'; } }
const lwText = t => typeof t === 'function' ? t() : t;
/* Calls the app makes, named by the job they do. First match wins. Text may be a function, read when the call runs. */
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
  [/\/api\/tally\?action=completeness/, 'books', 'Checking every entry in your books reached Margyn', 'Checked your books data is complete'],
  [/\/api\/tally\?action=analytics/, 'books', () => 'Working out margins from ' + lwBooksName(), 'Worked out margins'],
  [/\/api\/tally\?action=(status|summary)/, 'books', () => 'Reading ' + lwBooksName(), () => 'Read ' + lwBooksName()],
  [/\/api\/zoho\?action=vitals/, 'books', 'Reading Zoho Books', 'Read Zoho Books'],
  [/\/api\/zoho\?action=sync/, 'books', 'Syncing Zoho Books', 'Synced Zoho Books'],
  [/\/api\/zoho\?action=odoo-sync/, 'books', 'Syncing Odoo', 'Synced Odoo'],
  [/\/api\/zoho\?action=odoo-status/, 'books', 'Checking the Odoo connection', 'Checked the Odoo connection'],
  [/\/api\/sync-razorpay\?action=cashfree-status/, 'payments', 'Checking the Cashfree connection', 'Checked the Cashfree connection'],
  [/\/api\/sync-razorpay/, 'payments', 'Syncing Razorpay', 'Synced Razorpay'],
  [/\/api\/shopify\?action=sync/, 'payments', 'Syncing Shopify orders', 'Synced Shopify'],
  [/\/api\/shopify\?action=status/, 'payments', 'Checking the Shopify connection', 'Checked the Shopify connection'],
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
    const doing = lwText(rule[2]), done = lwText(rule[3]);
    const a = lwAdd({ job:rule[1], text:doing + '…', state:'running', at:new Date().toISOString() });
    // A call that finishes in a blink still shows for 1.5 s, so you see what Margyn just did.
    const t0 = Date.now();
    const settle = (ok, text) => setTimeout(() => { a.state = ok ? 'done' : 'error'; a.text = text; a.end = new Date().toISOString(); lwChanged(); }, Math.max(0, 1500 - (Date.now() - t0)));
    p.then(r => settle(r.ok, r.ok ? done : doing + ': it didn’t answer (' + r.status + ')'), () => settle(false, doing + ': couldn’t reach it'));
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
/* One tile per job. Every line is real: something running this second, something
   waiting on the owner, the last thing that job did (with the time), or that it
   is off. Nothing here is simulated. */
const LW_TILES = ['payments', 'books', 'close', 'gst', 'forecast', 'documents', 'watch', 'collections'];
function lwJobState(k){
  const run = lwRunning().find(a => a.job === k);
  if(run) return { cls:'run lw-now', st:'Running', text:run.text };
  const d = (typeof agentDeployments !== 'undefined' && agentDeployments) || {};
  const n = (x, one, many) => x + ' ' + (x === 1 ? one : many);
  let acts = []; try { acts = (agentActions && agentActions.actions) || []; } catch(e){}
  try {
    if(k === 'payments'){ const q = ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).length; if(q) return { cls:'need', st:'Needs you', text:n(q, 'payment', 'payments') + ' to check', ask:'Walk me through the reconciliation items waiting on me.' }; }
    if(k === 'close'){ const q = acts.filter(a => a.kind !== 'itc_risk').length; if(q) return { cls:'need', st:'Needs you', text:n(q, 'proposal', 'proposals') + ' waiting on your OK', ask:'What needs my OK?' }; }
    if(k === 'gst'){ const q = acts.filter(a => a.kind === 'itc_risk').length; if(q) return { cls:'need', st:'Needs you', text:n(q, 'vendor', 'vendors') + ' flagged for input credit at risk', ask:'Which vendors put my input credit at risk?' }; }
    if(k === 'documents'){ const q = (pendingSuggestions || []).length; if(q) return { cls:'need', st:'Needs you', text:n(q, 'forwarded document', 'forwarded documents') + ' read, waiting for your OK', ask:'What documents are waiting for my approval?' }; }
    if(k === 'books'){ const bad = ['zoho', 'tally', 'odoo'].find(x => { const h = mgSourceHealth(x); return h.on && h.warn; });
      if(bad) return { cls:'need', st:'Needs you', text:MG_SRC_LABEL[bad] + ': ' + mgSourceHealth(bad).text, ask:'Is my ' + MG_SRC_LABEL[bad] + ' connector working?' }; }
    if(k === 'watch'){
      const w = typeof mgWatchChannel === 'function' ? mgWatchChannel() : null, bells = typeof mgBellsLive === 'function' ? mgBellsLive() : null;
      // Until Channel health has loaded (a few seconds after opening) nothing is known: say so, never "Off".
      if(typeof mgChan !== 'undefined' && !mgChan && !(typeof mgChanErr !== 'undefined' && mgChanErr)) return { cls:'done idle', st:'Checking', text:'Checking what reached your WhatsApp' };
      if(w && w.status === 'failing') return { cls:'need', st:'Needs you', text:w.detail, ask:'What have you sent me on WhatsApp?' };
      const bellDown = !!(d.whatsapp_bell && d.whatsapp_bell.status === 'active' && bells === false);
      // Updates that are going out lead; a Bell that isn't live is said after them, not instead of them.
      if(w && w.headline !== 'Off') return { cls:'done', st:w.status === 'working' ? 'Delivering' : 'On', text:w.detail + (bellDown ? ' Opening and Closing Bell aren’t live yet.' : ''), ask:'What have you sent me on WhatsApp?' };
      if(bellDown) return { cls:'need', st:'Not live', text:'Opening and Closing Bell: WhatsApp hasn’t approved the message, so nothing goes out' };
      if(d.whatsapp_bell && d.whatsapp_bell.status === 'active' && bells === true) return { cls:'done', st:'Scheduled', text:'Opening and Closing Bell: your morning and evening briefing on WhatsApp' };
      if(!w || w.headline === 'Off') return { cls:'off', st:'Off', text:'Updates on WhatsApp are off. Turn on in Automations' };
    }
    if(k === 'collections'){
      const stt = (d.chase_agent && d.chase_agent.status) || 'not_deployed';
      const ct = (chaseTargets || []).filter(t => ['active', 'paused_promise', 'disputed', 'escalated_human'].includes(t.state));
      if(ct.length){ const next = ct.map(t => t.next_chase_at).filter(Boolean).sort()[0];
        return { cls:stt === 'paused' ? 'off' : 'done', st:stt === 'paused' ? 'Paused' : 'On it', text:'Chasing ' + n(ct.length, 'customer', 'customers') + ' · ' + fmtINR(ct.reduce((a, t) => a + (Number(t.amount) || 0), 0), 'tile') + ' outstanding' + (next ? ' · next reminder ' + fmtDay(next) : ''), ask:'Who am I chasing and how is it going?' }; }
      if(stt !== 'active') return { cls:'off', st:stt === 'paused' ? 'Paused' : 'Off', text:'Payment reminders are ' + (stt === 'paused' ? 'paused' : 'off') + '. Turn on in Automations' };
    }
  } catch(e){}
  const last = lwAct.find(a => a.job === k && a.state !== 'running');
  if(last) return { cls:'done' + (last.state === 'error' ? ' bad' : ''), st:lwSince(last.end || last.at), text:last.text };
  let idle = { payments:'Nothing to match right now', close:'Nothing proposed right now', gst:'Nothing flagged', forecast:'Up to date', documents:'Nothing forwarded today', collections:'No one to chase right now', watch:'Nothing sent yet today' }[k];
  if(k === 'books'){ try { const on = ['zoho', 'tally', 'odoo'].filter(x => mgSourceHealth(x).on); idle = on.length ? on.map(x => MG_SRC_LABEL[x] + ' ' + mgSourceHealth(x).text).join(' · ') : 'No accounting source connected yet'; } catch(e){ idle = 'In sync'; } }
  return { cls:'done idle', st:'Idle', text:idle };
}
function lwJobTiles(){
  return '<div class="mgh-jobs">' + LW_TILES.filter(lwJobAllowed).map(k => { const j = lwJobState(k), pg = LW_JOBS[k].page;
    return '<button type="button" class="mgd-task mgh-job ' + j.cls + '"' + (j.ask ? ' data-mgr-ask="' + escapeHtml(j.ask) + '"' : j.cls === 'off' ? ' data-go-page="agents"' : pg ? ' data-go-page="' + ((MG_PAGES[pg] || {}).slug || pg) + '"' : '') + '>' +
      '<b>' + escapeHtml(LW_JOBS[k].name) + '<em class="mgd-st' + (j.cls.indexOf('run') === 0 ? ' lw-st' : '') + '">' + escapeHtml(j.st) + '</em></b><span>' + escapeHtml(j.text) + '</span><u><i></i></u></button>'; }).join('') + '</div>';
}
/* The day's WhatsApp updates on a line, when they are on (times from Margyn Watch's own schedule). */
function lwDay(){
  let w = null; try { w = typeof mgWatchChannel === 'function' ? mgWatchChannel() : null; } catch(e){}
  if(!w || w.headline === 'Off') return '';
  const pts = [[7.5, '7:30 am', 'Morning update'], [10.5, '10:30', 'Update'], [12.5, '12:30', 'Update'], [15, '3:00 pm', 'Update'], [17, '5:00 pm', 'Update'], [19, '7:00 pm', 'Evening wrap']];
  let h = 12; try { const t = new Date().toLocaleTimeString('en-GB', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false }).split(':'); h = Number(t[0]) + Number(t[1]) / 60; } catch(e){}
  const pos = x => Math.max(0, Math.min(100, (x - 7.5) / 11.5 * 100));
  const now = h >= 7.5 && h <= 19 ? pos(h) : null, fill = h < 7.5 ? 0 : h > 19 ? 100 : pos(h);
  return '<div class="mgh-day" title="Updates go out on WhatsApp at these times; the short ones only when something moved"><div class="mgh-day-ln"><i style="width:' + fill.toFixed(1) + '%"></i></div>' +
    pts.map(p => '<span class="mgh-day-pt' + (h >= p[0] ? ' ok' : '') + '" style="left:' + pos(p[0]).toFixed(1) + '%"></span>').join('') + (now != null ? '<span class="mgh-day-pt now" style="left:' + now.toFixed(1) + '%"></span>' : '') +
    '<div class="mgh-day-lb">' + pts.map(p => '<span style="left:' + pos(p[0]).toFixed(1) + '%"><b>' + p[1] + '</b>' + p[2] + '</span>').join('') + '</div></div>';
}
/* Each connected source and when it last synced. */
function lwSrcChips(){
  let out = '';
  try { ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'].forEach(k => { const h = mgSourceHealth(k); if(!h.on) return;
    out += '<button type="button" class="mgh-tag' + (h.warn ? ' hot' : '') + '"' + (h.warn ? ' data-mgr-ask="Is my ' + escapeHtml(MG_SRC_LABEL[k]) + ' connector working?"' : ' data-go-page="sources"') + '><i></i>' + escapeHtml(MG_SRC_LABEL[k] + ' · ' + h.text) + '</button>'; }); } catch(e){}
  return out ? '<div class="mgh-srcs">' + out + '</div>' : '';
}
function lwNeedCount(){ return LW_TILES.filter(lwJobAllowed).filter(k => lwJobState(k).cls === 'need').length; }
function lwAside(){ const n = lwRunning().length, k = lwNeedCount(); return [n ? n + ' running now' : '', k ? k + (k === 1 ? ' needs you' : ' need you') : ''].filter(Boolean).join(' · ') || 'live'; }
function lwWorkHtml(){
  // No connected source, nothing running and nothing done yet: say so plainly.
  const none = !lwAct.length && !lwSrcChips();
  return (none ? '<div class="mg-empty">Nothing running yet. Connect a source or switch on payment reminders and I’ll get to work.</div>' : '') + lwJobTiles() + lwDay() + lwSrcChips() + lwDoneRows();
}
mgrWorkingOn = function(){ return '<div id="lwWorking">' + lwWorkHtml() + '</div>'; };
// The panel's "live" label says how many are running and how many need the owner, from the first render.
if(typeof mgrDeskTop === 'function'){
  const baseTop = mgrDeskTop;
  mgrDeskTop = function(){
    const a = lwAside(), html = baseTop.apply(this, arguments);
    return a !== 'live' ? html.replace('<h2>What I’m working on</h2><span class="mg-aside">live</span>', '<h2>What I’m working on</h2><span class="mg-aside' + (lwRunning().length ? ' lw-live' : '') + '">' + a + '</span>') : html;
  };
}
function lwPaintHome(){
  const el = document.getElementById('lwWorking'); if(!el) return;
  el.innerHTML = lwWorkHtml();
  const aside = el.closest('.mg-panel') && el.closest('.mg-panel').querySelector('.mg-panel-h .mg-aside');
  if(aside){ aside.classList.toggle('lw-live', lwRunning().length > 0); aside.textContent = lwAside(); }
}
// "All activity" opens the day's log (the live pill's pop-up in the top bar).
document.addEventListener('click', e => { if(e.target.closest('[data-lw-all]')) setTimeout(() => { const c = document.getElementById('topSync'); if(c) c.click(); }, 0); });

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
