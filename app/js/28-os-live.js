/* ============================================================
   MARGYN LIVE: Margyn's agents, what they're doing right now, the Desk,
   the Live page and All work.

   Everything shown here is something that actually happened or is happening:
   - work the app is doing this second (each call it makes to /api is
     recorded while it runs: "Reconciling payments against invoices"),
   - work that ran in the background (Tally and Odoo sync runs, reminders
     sent, documents read, Watch, the forecast), read from their own tables,
   - what each agent is waiting on a person for.
   Nothing moves unless something is running. One voice stays Margyn in chat;
   these are Margyn's agents, shown by the job they do.
   ============================================================ */

const OS_AGENTS = [
  { key:'payments', name:'Payments', job:'Matches payments to invoices', space:'collect', tab:'matching' },
  { key:'collections', name:'Collections', job:'Chases customers who owe you', space:'collect', tab:'chasing' },
  { key:'books', name:'Books', job:'Keeps your books in sync and checks they agree', space:'close', tab:'books' },
  { key:'close', name:'Close', job:'Turns exceptions into proposals for you', space:'work', tab:'needs-me' },
  { key:'gst', name:'GST', job:'Checks supplier filings and input credit', space:'tax', tab:'gst' },
  { key:'documents', name:'Documents', job:'Reads what you forward on WhatsApp', space:'documents', tab:'forwarded' },
  { key:'forecast', name:'Forecast', job:'Learns from your books and forecasts cash', space:'cash', tab:'forecast' },
  { key:'watch', name:'Watch', job:'Watches your numbers and keeps you posted', space:'margyn', tab:'delivery' }
];
const OS_AGENT = Object.fromEntries(OS_AGENTS.map(a => [a.key, a]));
/* A team member sees an agent only if they may open the page it works on (19g-team.js permissions). */
function osAgentAllowed(k){ const a = OS_AGENT[k]; if(!a) return true; const sp = OS_BY_KEY[a.space], t = sp && sp.tabs.find(x => x.k === a.tab); return !t || osAllowed(t.page); }
function osAgentsVisible(){ return OS_AGENTS.filter(a => osAgentAllowed(a.key)); }
function osActVisible(){ return osAct.filter(a => osAgentAllowed(a.agent)); }
function osCan(p){ return typeof mgCan !== 'function' || mgCan(p); }

/* ---------- the activity record ---------- */
const osAct = [];          // { id, agent, text, state:'running'|'done'|'error', at, end, from:'app'|'server', key }
let osActSeq = 0;
const osActListeners = [];
function osActChanged(){ osActListeners.forEach(f => { try { f(); } catch(e){} }); }
function osActAdd(a){
  if(a.key){ const old = osAct.find(x => x.key === a.key); if(old){ Object.assign(old, a); osActChanged(); return old; } }
  a.id = ++osActSeq; osAct.push(a);
  osAct.sort((x, y) => new Date(y.end || y.at) - new Date(x.end || x.at));
  if(osAct.length > 160) osAct.length = 160;
  osActChanged();
  return a;
}
function osRunning(agent){ return osAct.filter(a => a.state === 'running' && (agent ? a.agent === agent : osAgentAllowed(a.agent))); }

/* Calls the app makes, named by the job they do. Order matters: first match wins. */
const OS_CALLS = [
  [/\/api\/reconcile\?action=summary/, 'payments', 'Reconciling payments against invoices', 'Reconciliation checked'],
  [/\/api\/reconcile\?action=position/, 'books', 'Working out who owes what across your books', 'Balances worked out'],
  [/\/api\/reconcile\?action=agent-actions/, 'close', 'Collecting proposals from the last run', 'Proposals collected'],
  [/\/api\/reconcile\?action=resolve/, 'payments', 'Applying your decision', 'Your decision is applied'],
  [/\/api\/reconcile\?action=agent-review/, 'close', 'Applying your decision', 'Your decision is applied'],
  [/\/api\/reconcile\?action=channel-health/, 'watch', 'Checking your messages reached people', 'Delivery checked'],
  [/\/api\/generate-findings\?action=parse-import/, 'documents', 'Reading the file you gave me', 'File read'],
  [/\/api\/generate-findings/, 'books', 'Recomputing your vitals and Pulse Score', 'Vitals recomputed'],
  [/\/api\/generate-briefing/, 'watch', 'Writing your briefing', 'Briefing written'],
  [/\/api\/tally\?action=completeness/, 'books', 'Checking every Tally voucher reached Margyn', 'Tally data checked'],
  [/\/api\/tally\?action=analytics/, 'books', 'Working out margins from Tally', 'Margins worked out'],
  [/\/api\/tally\?action=(status|summary)/, 'books', 'Reading Tally', 'Tally read'],
  [/\/api\/zoho\?action=vitals/, 'books', 'Reading Zoho Books', 'Zoho Books read'],
  [/\/api\/zoho\?action=sync/, 'books', 'Syncing Zoho Books', 'Zoho Books synced'],
  [/\/api\/zoho\?action=odoo-sync/, 'books', 'Syncing Odoo', 'Odoo synced'],
  [/\/api\/zoho\?action=odoo-status/, 'books', 'Reading Odoo', 'Odoo read'],
  [/\/api\/sync-razorpay\?action=cashfree-status/, 'payments', 'Reading Cashfree', 'Cashfree read'],
  [/\/api\/sync-razorpay/, 'payments', 'Syncing Razorpay', 'Razorpay synced'],
  [/\/api\/shopify\?action=sync/, 'payments', 'Syncing Shopify orders', 'Shopify synced'],
  [/\/api\/shopify\?action=status/, 'payments', 'Reading Shopify', 'Shopify read'],
  [/\/api\/ask-margyn\?action=watch/, 'watch', 'Reading what I noticed in your books', 'Watch read'],
  [/\/api\/ops\?action=cron-cfo-pack|cfo-pack-test/, 'close', 'Preparing the CFO pack', 'CFO pack prepared']
];
(function hookFetch(){
  if(window.__osFetch) return; window.__osFetch = true;
  const base = window.fetch.bind(window);
  window.fetch = function(input, init){
    let url = ''; try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch(e){}
    const rule = OS_CALLS.find(r => r[0].test(url));
    const p = base(input, init);
    if(!rule) return p;
    const a = osActAdd({ agent:rule[1], text:rule[2] + '…', state:'running', at:new Date().toISOString(), from:'app' });
    // A call that finishes in a blink still shows as running for 1.5s, so the
    // person opening the app sees what Margyn just did, then it lands in the feed.
    const t0 = Date.now();
    const settle = (ok, text) => setTimeout(() => { a.state = ok ? 'done' : 'error'; a.text = text; a.end = new Date().toISOString(); osActChanged(); }, Math.max(0, 1500 - (Date.now() - t0)));
    p.then(r => settle(r.ok, r.ok ? rule[3] : rule[2] + ': it didn’t answer (' + r.status + ')'),
           () => settle(false, rule[2] + ': couldn’t reach it'));
    return p;
  };
})();

/* ---------- background work, from the tables each job writes ---------- */
function osOwner(){ return (typeof mgActor !== 'undefined' && mgActor && mgActor.accountId) || (currentUser && currentUser.id); }
const OS_SYNC_KIND = { ledgers:'ledgers', vouchers:'vouchers', bills:'bills', pair:'pairing', invoices:'invoices', connect:'connection', full:'everything', items:'stock items', structure:'structure' };
let osServerAt = 0, osServerBusy = false;
async function osLoadServer(force){
  if(!currentUser || !sbClient || osServerBusy) return;
  if(!force && Date.now() - osServerAt < 45000) return;
  osServerBusy = true; osServerAt = Date.now();
  const uid = osOwner(), since = new Date(Date.now() - 3 * 86400000).toISOString();
  const q = async (fn) => { try { const r = await fn(); return (r && r.data) || []; } catch(e){ return []; } };
  const [tally, odoo, events, fc] = await Promise.all([
    q(() => sbClient.from('tally_sync_runs').select('id,kind,status,rows_upserted,started_at,finished_at,error_message').eq('user_id', uid).gte('started_at', since).order('started_at', { ascending:false }).limit(12)),
    q(() => sbClient.from('odoo_sync_runs').select('id,kind,status,rows_upserted,started_at,finished_at').eq('user_id', uid).gte('started_at', since).order('started_at', { ascending:false }).limit(6)),
    q(() => sbClient.from('product_events').select('id,name,props,at').eq('user_id', uid).in('name', ['reconcile_run', 'tally_agent_sync', 'whatsapp_outbound']).gte('at', since).order('at', { ascending:false }).limit(20)),
    q(() => sbClient.from('forecast_runs').select('run_date,updated_at,self_check').eq('user_id', uid).order('run_date', { ascending:false }).limit(1))
  ]);
  const fresh = iso => iso && (Date.now() - new Date(iso).getTime()) < 20 * 60000;
  tally.forEach(r => {
    const running = !r.finished_at && fresh(r.started_at);
    if(!r.finished_at && !running) return;   // a run that never finished long ago isn't "running"
    const what = OS_SYNC_KIND[r.kind] || r.kind;
    osActAdd({ key:'tally:' + r.id, agent:'books', from:'server', at:r.started_at, end:r.finished_at || null,
      state:running ? 'running' : r.status === 'ok' ? 'done' : 'error',
      text:running ? 'Syncing Tally ' + what + '…' : r.status === 'ok' ? 'Synced Tally ' + what + (r.rows_upserted ? ' · ' + r.rows_upserted.toLocaleString('en-IN') + ' rows' : '') : 'Tally ' + what + ' sync failed' + (r.error_message ? ': ' + String(r.error_message).slice(0, 80) : '') });
  });
  odoo.forEach(r => {
    const running = !r.finished_at && fresh(r.started_at);
    if(!r.finished_at && !running) return;
    const what = OS_SYNC_KIND[r.kind] || r.kind;
    osActAdd({ key:'odoo:' + r.id, agent:'books', from:'server', at:r.started_at, end:r.finished_at || null,
      state:running ? 'running' : r.status === 'ok' ? 'done' : 'error',
      text:running ? 'Syncing Odoo ' + what + '…' : r.status === 'ok' ? 'Synced Odoo ' + what + (r.rows_upserted ? ' · ' + r.rows_upserted + ' rows' : '') : 'Odoo ' + what + ' sync failed' });
  });
  events.forEach(e => {
    const p = e.props || {};
    if(e.name === 'reconcile_run') osActAdd({ key:'ev:' + e.id, agent:'payments', from:'server', at:e.at, end:e.at, state:'done',
      text:'Ran reconciliation' + (p.matched != null ? ' · ' + p.matched + ' matched' : '') + (p.needs_review ? ' · ' + p.needs_review + ' to check' : '') });
    else if(e.name === 'tally_agent_sync') osActAdd({ key:'ev:' + e.id, agent:'books', from:'server', at:e.at, end:e.at, state:'done', text:'The Tally agent on your PC sent new figures' });
    else if(e.name === 'whatsapp_outbound') osActAdd({ key:'ev:' + e.id, agent:p.kind === 'chase' ? 'collections' : 'watch', from:'server', at:e.at, end:e.at, state:'done',
      text:p.kind === 'chase' ? 'Sent a payment reminder on WhatsApp' : 'Sent a WhatsApp update' });
  });
  if(fc[0] && fc[0].updated_at) osActAdd({ key:'fc:' + fc[0].run_date, agent:'forecast', from:'server', at:fc[0].updated_at, end:fc[0].updated_at, state:'done', text:'Re-learned the 13-week forecast from your books' });
  osFromGlobals();
  osServerBusy = false;
  osActChanged();
}
/* What the app already loaded says what happened too. */
function osFromGlobals(){
  try { (chaseTargets || []).forEach(t => {
    if(t.last_chase_at) osActAdd({ key:'chase:' + (t.id || t.party_name) + ':' + t.last_chase_at, agent:'collections', from:'server', at:t.last_chase_at, end:t.last_chase_at, state:'done',
      text:'Sent ' + (t.party_name || 'a customer') + ' a reminder' + (t.amount ? ' for ' + fmtINR(Number(t.amount), 'tile') : '') });
    if(t.state === 'resolved_paid' && t.resolved_at) osActAdd({ key:'paid:' + (t.id || t.party_name), agent:'collections', from:'server', at:t.resolved_at, end:t.resolved_at, state:'done',
      text:(t.party_name || 'A customer') + ' paid after a reminder' + (t.amount ? ' · ' + fmtINR(Number(t.amount), 'tile') : '') });
  }); } catch(e){}
  try { (pendingSuggestions || []).forEach(p => {
    const ents = (p.proposal && p.proposal.entries) || [];
    osActAdd({ key:'doc:' + p.id, agent:'documents', from:'server', at:p.received_at || p.created_at, end:p.received_at || p.created_at, state:'done',
      text:'Read a document' + (ents[0] && ents[0].party ? ' from ' + ents[0].party : '') + (ents.length ? ' · ' + ents.length + ' figure' + (ents.length === 1 ? '' : 's') + ' to place' : '') });
  }); } catch(e){}
  try { ((agentActions && agentActions.actions) || []).forEach(a => { if(a.created_at) osActAdd({ key:'act:' + a.id, agent:a.kind === 'itc_risk' ? 'gst' : 'close', from:'server', at:a.created_at, end:a.created_at, state:'done', text:'Proposed: ' + a.title }); }); } catch(e){}
  try { const v = reconSummary && reconSummary.provenance && reconSummary.provenance.last_verified_at;
    if(v) osActAdd({ key:'recon:' + v, agent:'payments', from:'server', at:v, end:v, state:'done', text:'Verified payments against Zoho Books' + (reconSummary.counts ? ' · ' + reconSummary.counts.verified + ' matched' : '') }); } catch(e){}
  try { (typeof ledgerEvents !== 'undefined' && ledgerEvents || []).slice(0, 30).forEach(e => {
    if(e.channel !== 'agent') return;
    osActAdd({ key:'le:' + e.id, agent:'close', from:'server', at:e.created_at, end:e.created_at, state:'done', text:'Booked: ' + (e.event || '') + ' ' + (e.entity_type || '') + (e.party_name ? ' · ' + e.party_name : '') });
  }); } catch(e){}
}

/* ---------- each agent, right now ---------- */
function osSince(iso){
  if(!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
}
function osClip(t, n){ t = String(t || ''); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; }
function osWhen(iso){ try { return new Date(iso).toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour:'numeric', minute:'2-digit' }); } catch(e){ return ''; } }
/* { state:'working'|'needs'|'idle'|'off', now, facts:[...], need, last } — facts are true statements to cycle through. */
function osAgentState(key){
  const run = osRunning(key);
  const last = osAct.find(a => a.agent === key && a.state !== 'running');
  const out = { state:'idle', now:run[0] ? run[0].text : '', facts:[], need:0, needText:'', last, running:run.length };
  const d = (typeof agentDeployments !== 'undefined' && agentDeployments) || {};
  try {
    if(key === 'payments'){
      const c = reconSummary && reconSummary.connected && reconSummary.counts;
      const review = ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).length;
      out.need = review; out.needText = review ? review + ' payment' + (review === 1 ? '' : 's') + ' to confirm' : '';
      if(c) out.facts.push(c.verified + ' payments matched to invoices', (c.unmatched || 0) + ' still unmatched');
      ['razorpay', 'cashfree', 'shopify'].forEach(k => { const h = mgSourceHealth(k); if(h.on) out.facts.push(MG_SRC_LABEL[k] + ' ' + h.text); });
      if(!c && !out.facts.length){ out.state = 'off'; out.facts.push('Connect Razorpay or Cashfree and Zoho Books to start matching'); }
    } else if(key === 'collections'){
      const all = (typeof chaseTargets !== 'undefined' && chaseTargets) || [];
      const act = all.filter(t => ['active', 'paused_promise'].includes(t.state));
      const stuck = all.filter(t => ['disputed', 'escalated_human'].includes(t.state));
      out.need = stuck.length; out.needText = stuck.length ? stuck.length + ' customer' + (stuck.length === 1 ? '' : 's') + ' need you' : '';
      if(act.length){
        out.facts.push('Chasing ' + act.length + ' customer' + (act.length === 1 ? '' : 's') + ' · ' + fmtINR(act.reduce((s, t) => s + (Number(t.amount) || 0), 0), 'tile'));
        const next = act.map(t => t.next_chase_at).filter(Boolean).sort()[0];
        if(next) out.facts.push('Next reminder ' + fmtDay(next) + ' ' + osWhen(next));
        const prom = act.filter(t => t.state === 'paused_promise');
        if(prom.length) out.facts.push(prom.length + ' promised to pay');
      }
      const st = d.chase_agent && d.chase_agent.status;
      if(!act.length && st !== 'active'){ out.state = 'off'; out.facts.push('Payment reminders are off. Switch them on in Rules.'); }
      else if(!act.length) out.facts.push('Nobody to chase right now');
    } else if(key === 'books'){
      const on = ['tally', 'zoho', 'odoo'].filter(k => mgSourceHealth(k).on);
      on.forEach(k => { const h = mgSourceHealth(k); out.facts.push(MG_SRC_LABEL[k] + ' ' + h.text); });
      let dis = []; try { dis = mgDisagreements(); } catch(e){}
      const warn = on.filter(k => mgSourceHealth(k).warn);
      out.need = dis.length + warn.length;
      out.needText = [dis.length ? dis.length + ' place' + (dis.length === 1 ? '' : 's') + ' your books disagree' : '', warn.length ? warn.map(k => MG_SRC_LABEL[k]).join(', ') + ' need' + (warn.length === 1 ? 's' : '') + ' a look' : ''].filter(Boolean).join(' · ');
      if(!on.length){ out.state = 'off'; out.facts.push('Connect Tally, Zoho Books or Odoo'); }
    } else if(key === 'close'){
      const acts = ((agentActions && agentActions.actions) || []).filter(a => a.kind !== 'itc_risk');
      out.need = acts.length; out.needText = acts.length ? acts.length + ' proposal' + (acts.length === 1 ? '' : 's') + ' waiting' : '';
      if(acts.length) out.facts.push('Biggest: ' + acts.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0))[0].title);
      else out.facts.push('No exceptions waiting');
    } else if(key === 'gst'){
      const z = typeof zohoVitals !== 'undefined' && zohoConnected ? zohoVitals : null;
      const g = z && z.gst_leakage;
      const itc = ((agentActions && agentActions.actions) || []).filter(a => a.kind === 'itc_risk');
      out.need = itc.length; out.needText = itc.length ? itc.length + ' hold' + (itc.length === 1 ? '' : 's') + ' to approve' : '';
      if(g){ out.facts.push(fmtINR(g.total_leakage || 0, 'tile') + ' input credit at risk', (g.vendors_not_filed || 0) + ' supplier' + (g.vendors_not_filed === 1 ? '' : 's') + ' not filed for ' + (g.filing_period || 'this period')); }
      else { out.state = 'off'; out.facts.push('Connect Zoho Books to check GSTR-2B'); }
    } else if(key === 'documents'){
      const n = ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).length;
      out.need = n; out.needText = n ? n + ' document' + (n === 1 ? '' : 's') + ' to approve' : '';
      out.facts.push(n ? 'Read ' + n + ' forwarded document' + (n === 1 ? '' : 's') : 'Forward a bill or invoice on WhatsApp and I’ll read it');
    } else if(key === 'forecast'){
      let f = null; try { f = mgForecast(); } catch(e){}
      if(f){ out.facts.push(f.firstBelow >= 0 ? 'Cash dips below your floor in week ' + (f.firstBelow + 1) : 'Cash stays above your floor for 13 weeks', 'Low point ' + fmtINR(f.min, 'tile') + ' in week ' + (f.minWeek + 1));
        if(f.learned) out.facts.push('Learned from your own books'); }
      else { out.state = 'off'; out.facts.push('Needs a few weeks of figures'); }
    } else if(key === 'watch'){
      const w = typeof mgWatchChannel === 'function' ? mgWatchChannel() : null;
      if(w && w.headline !== 'Off'){ out.facts.push(w.detail); if(w.status === 'failing'){ out.need = 1; out.needText = 'Messages aren’t reaching you'; } }
      else { out.state = 'off'; out.facts.push('WhatsApp updates are off. Turn them on in Settings.'); }
      out.facts.push('Updates go out in the morning, at 10:30 and 3:00, and in the evening');
    }
  } catch(e){ console.error('[os] agent state ' + key, e); }
  if(run.length) out.state = 'working';
  else if(out.need && out.state !== 'off') out.state = 'needs';
  if(last) out.facts.unshift(last.text + ' · ' + osSince(last.end || last.at));
  return out;
}

function osNowText(){
  const run = osRunning();
  if(run.length) return (OS_AGENT[run[0].agent] || {}).name + ': ' + run[0].text;
  const last = osActVisible().find(a => a.state !== 'running');
  return last ? 'Last: ' + last.text + ' · ' + osSince(last.end || last.at) : 'Ready when your books sync';
}
/* ---------- top bar: what Margyn is doing, on every page ---------- */
function osDrawPill(){
  let el = document.getElementById('osLive');
  if(!el){
    const k = document.getElementById('cmdkTrigger'); if(!k) return;
    el = document.createElement('button'); el.type = 'button'; el.id = 'osLive'; el.className = 'os-live';
    el.title = 'What Margyn is doing. Open Margyn › Live.';
    k.parentNode.insertBefore(el, k);
    el.addEventListener('click', () => osGo('margyn', 'live'));
  }
  const run = osRunning();
  if(run.length){
    const a = OS_AGENT[run[0].agent];
    el.className = 'os-live on';
    el.innerHTML = '<span class="os-pulse"><i></i><i></i></span><span class="os-live-t"><b>' + escapeHtml(a ? a.name : 'Margyn') + '</b> ' + escapeHtml(run[0].text) + '</span>' + (run.length > 1 ? '<span class="os-live-n">+' + (run.length - 1) + '</span>' : '');
  } else {
    const last = osActVisible().find(a => a.state !== 'running');
    let need = 0; osAgentsVisible().forEach(a => { need += osAgentState(a.key).need ? 1 : 0; });
    el.className = 'os-live';
    el.innerHTML = '<span class="os-pulse idle"><i></i></span><span class="os-live-t"><b>Margyn</b> ' +
      escapeHtml(last ? last.text + ' · ' + osSince(last.end || last.at) : 'ready') + '</span>' + (need ? '<span class="os-live-n warn" title="' + need + ' agent' + (need === 1 ? '' : 's') + ' waiting on you">' + need + '</span>' : '');
  }
}

/* ---------- live tickers: cycle each agent's true facts ---------- */
let osTick = 0;
setInterval(() => {
  if(document.hidden) return;
  osTick++;
  document.querySelectorAll('[data-os-ticker]').forEach(el => {
    const st = osAgentState(el.dataset.osTicker);
    const lines = st.state === 'working' ? osRunning(el.dataset.osTicker).map(a => a.text) : st.facts;
    if(!lines.length) return;
    const next = lines[osTick % lines.length];
    if(el.textContent === next) return;
    el.classList.add('fade');
    setTimeout(() => { el.textContent = next; el.classList.remove('fade'); }, 220);
  });
}, 2600);

/* ---------- an agent row (Desk) and card (Live) ---------- */
const OS_STATE_LABEL = { working:'Working', needs:'Needs you', idle:'Idle', off:'Off' };
function osAgentRow(a){
  const st = osAgentState(a.key);
  const line = st.state === 'working' ? st.now : (st.facts[0] || a.job);
  return '<button type="button" class="os-ag ' + st.state + '" data-os-go="' + a.space + '/' + a.tab + '">' +
    '<span class="os-pulse ' + (st.state === 'working' ? '' : st.state === 'needs' ? 'warn' : 'idle') + '"><i></i>' + (st.state === 'working' || st.state === 'needs' ? '<i></i>' : '') + '</span>' +
    '<span class="os-ag-m"><b>' + escapeHtml(a.name) + '</b><span class="os-ticker" data-os-ticker="' + a.key + '">' + escapeHtml(line) + '</span>' +
    (st.state === 'working' ? '<span class="os-bar-run"></span>' : '') + '</span>' +
    '<span class="os-ag-s">' + (st.needText ? '<em>' + escapeHtml(st.needText) + '</em>' : escapeHtml(OS_STATE_LABEL[st.state])) + '</span></button>';
}
function osAgentCard(a){
  const st = osAgentState(a.key);
  const recent = osAct.filter(x => x.agent === a.key).slice(0, 4);
  return '<div class="os-agc ' + st.state + '">' +
    '<div class="os-agc-h"><span class="os-pulse ' + (st.state === 'working' ? '' : st.state === 'needs' ? 'warn' : 'idle') + '"><i></i>' + (st.state === 'working' || st.state === 'needs' ? '<i></i>' : '') + '</span>' +
      '<div><b>' + escapeHtml(a.name) + ' agent</b><span>' + escapeHtml(a.job) + '</span></div><span class="os-st ' + st.state + '">' + OS_STATE_LABEL[st.state] + '</span></div>' +
    '<div class="os-agc-now"><span class="os-ticker" data-os-ticker="' + a.key + '">' + escapeHtml(st.state === 'working' ? st.now : (st.facts[0] || a.job)) + '</span>' + (st.state === 'working' ? '<span class="os-bar-run"></span>' : '') + '</div>' +
    (st.needText ? '<button type="button" class="os-agc-need" data-os-go="' + a.space + '/' + a.tab + '">' + escapeHtml(st.needText) + ' →</button>' : '') +
    '<div class="os-agc-log">' + (recent.length ? recent.map(x => '<div class="' + x.state + '"><span>' + escapeHtml(x.text) + '</span><small>' + escapeHtml(x.state === 'running' ? 'now' : osSince(x.end || x.at)) + '</small></div>').join('') : '<div class="idle"><span>Nothing yet this session</span></div>') + '</div>' +
    '<button type="button" class="mg-link os-agc-go" data-os-go="' + a.space + '/' + a.tab + '">Open ' + escapeHtml((OS_BY_KEY[a.space] || {}).label || '') + ' →</button>' +
  '</div>';
}

/* ---------- the system view: apps → one record → agents → people ---------- */
function osPeople(){
  const out = [{ k:'me', av:osInitials(osMyName()), name:osMyName() + ' (you)', role:(typeof mgActor !== 'undefined' && mgActor && mgActor.roleLabel) || 'Owner' }];
  osPresenceList().filter(p => !p.me).slice(0, 2).forEach(p => out.push({ k:p.id, av:osInitials(p.name), name:p.name, role:p.where || 'Online' }));
  out.push({ k:'wa', av:'WA', name:'WhatsApp', role:'Updates and replies' });
  return out;
}
function osSystemSvg(){
  const apps = ['tally', 'zoho', 'odoo', 'razorpay', 'cashfree', 'shopify'].filter(k => mgSourceHealth(k).on);
  const people = osPeople();
  const AG = osAgentsVisible();
  const W = 1000, H = Math.max(320, 70 + AG.length * 48);
  const ay = i => 40 + i * Math.min(56, (H - 80) / Math.max(1, apps.length)), gy = j => 26 + j * 48, py = k => 50 + k * Math.min(80, (H - 90) / Math.max(1, people.length));
  let paths = '', dots = '', nodes = '', pid = 0;
  const path = (d, cls) => { const id = 'osp' + (pid++); paths += '<path id="' + id + '" d="' + d + '" class="' + cls + '"/>'; return id; };
  const flow = (id, cls, dur, n) => { for(let i = 0; i < n; i++) dots += '<circle r="3" class="' + cls + '"><animateMotion dur="' + dur + 's" repeatCount="indefinite" begin="-' + (dur / n * i).toFixed(2) + 's"><mpath href="#' + id + '"/></animateMotion></circle>'; };
  const agentSt = Object.fromEntries(AG.map(a => [a.key, osAgentState(a.key)]));
  const booksBusy = !!agentSt.books && agentSt.books.state === 'working', payBusy = !!agentSt.payments && agentSt.payments.state === 'working';
  apps.forEach((k, i) => {
    const y = ay(i) + 18, busy = ['tally', 'zoho', 'odoo'].includes(k) ? booksBusy : payBusy;
    const id = path('M176,' + y + ' L236,' + y, 'os-l');
    if(busy) flow(id, 'os-d-in', 1.4, 2);
    const h = mgSourceHealth(k), L = MG_SRC_LOGO[k] || ['?', '#8B93A0'];
    nodes += '<g><rect x="24" y="' + ay(i) + '" width="152" height="36" rx="8" class="os-n"/><rect x="34" y="' + (ay(i) + 9) + '" width="18" height="18" rx="4" fill="' + L[1] + '"/><text x="43" y="' + (ay(i) + 22) + '" text-anchor="middle" class="os-t-logo">' + L[0] + '</text>' +
      '<text x="60" y="' + (ay(i) + 16) + '" class="os-t-b">' + escapeHtml(MG_SRC_LABEL[k]) + '</text><text x="60" y="' + (ay(i) + 29) + '" class="os-t-s' + (h.warn ? ' warn' : '') + '">' + escapeHtml(h.text) + '</text></g>';
  });
  if(!apps.length) nodes += '<text x="100" y="60" text-anchor="middle" class="os-t-s">No apps connected</text>';
  nodes += '<rect x="236" y="20" width="56" height="' + (H - 40) + '" rx="10" class="os-rec"/><text transform="translate(268,' + (H / 2) + ') rotate(-90)" text-anchor="middle" class="os-t-rec">ONE FINANCE RECORD</text>';
  AG.forEach((a, j) => {
    const st = agentSt[a.key], y = gy(j) + 18;
    const id = path('M292,' + y + ' L400,' + y, 'os-l' + (st.state === 'working' ? ' on' : ''));
    if(st.state === 'working') flow(id, 'os-d-work', 1.2, 3);
    nodes += '<g class="os-sg ' + st.state + '" data-os-go="' + a.space + '/' + a.tab + '"><rect x="400" y="' + gy(j) + '" width="250" height="38" rx="8" class="os-n ' + st.state + '"/>' +
      '<circle cx="416" cy="' + (gy(j) + 19) + '" r="4.5" class="os-dot ' + st.state + '"/>' + (st.state === 'working' ? '<circle cx="416" cy="' + (gy(j) + 19) + '" r="4.5" class="os-ring"/>' : '') +
      '<text x="428" y="' + (gy(j) + 16) + '" class="os-t-b">' + escapeHtml(a.name) + '</text>' +
      '<text x="428" y="' + (gy(j) + 30) + '" class="os-t-s" data-os-svgtick="' + a.key + '">' + escapeHtml(osClip(st.state === 'working' ? st.now : (st.needText || st.facts[0] || a.job), 36)) + '</text></g>';
  });
  // decisions waiting go to the owner; WhatsApp work goes to WhatsApp
  AG.forEach((a, j) => {
    const st = agentSt[a.key]; if(!st.need && !(a.key === 'collections' && st.state !== 'off') && !(a.key === 'watch' && st.state !== 'off')) return;
    const to = (a.key === 'collections' || a.key === 'watch') && !st.need ? people.length - 1 : 0;
    const y1 = gy(j) + 19, y2 = py(to) + 22;
    const id = path('M650,' + y1 + ' C760,' + y1 + ' 760,' + y2 + ' 850,' + y2, 'os-l hand');
    flow(id, st.need ? 'os-d-hand' : 'os-d-wa', 3.4 + j * .2, 1);
  });
  people.forEach((p, k) => {
    nodes += '<g><rect x="850" y="' + py(k) + '" width="136" height="44" rx="9" class="os-n"/><circle cx="870" cy="' + (py(k) + 22) + '" r="11" class="os-av' + (p.k === 'wa' ? ' wa' : '') + '"/>' +
      '<text x="870" y="' + (py(k) + 26) + '" text-anchor="middle" class="os-t-av">' + escapeHtml(p.av) + '</text>' +
      '<text x="888" y="' + (py(k) + 19) + '" class="os-t-b">' + escapeHtml(osClip(p.name, 15)) + '</text><text x="888" y="' + (py(k) + 33) + '" class="os-t-s">' + escapeHtml(osClip(p.role, 17)) + '</text></g>';
  });
  return '<svg class="os-sys-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Your connected apps feed one finance record. Margyn’s agents work on it and hand decisions to you.">' +
    '<text x="100" y="18" text-anchor="middle" class="os-t-h">APPS</text><text x="525" y="16" text-anchor="middle" class="os-t-h">MARGYN’S AGENTS</text><text x="918" y="36" text-anchor="middle" class="os-t-h">PEOPLE</text>' +
    paths + nodes + dots + '</svg>';
}

/* ---------- the Live page ---------- */
function osRenderLive(){
  const host = document.getElementById('view-live'); if(!host) return;
  const run = osRunning();
  const legend = '<div class="os-legend"><span><i class="in"></i>Data coming in</span><span><i class="work"></i>An agent working</span><span><i class="hand"></i>A decision handed to you</span><span><i class="wa"></i>Going out on WhatsApp</span></div>';
  host.innerHTML = mgPageHead({ group:'Margyn', title:'Margyn, live', sub:'Margyn’s agents and what each is doing right now. Something moves here only when it is actually happening.',
      actions:'<button class="mg-btn" type="button" data-os-refresh>Check again</button>' }) +
    '<div class="os-livebar' + (run.length ? ' on' : '') + '"><span class="os-pulse' + (run.length ? '' : ' idle') + '"><i></i>' + (run.length ? '<i></i>' : '') + '</span><b>' + (run.length ? run.length + ' thing' + (run.length === 1 ? '' : 's') + ' running' : 'Nothing running this second') + '</b>' +
      '<span>' + escapeHtml(run.length ? run.map(a => (OS_AGENT[a.agent] || {}).name + ': ' + a.text).join(' · ') : 'Agents run when your books sync, overnight, and when you open the app.') + '</span></div>' +
    '<div class="mg-panel os-sys"><div class="mg-gridwrap">' + osSystemSvg() + '</div>' + legend + '</div>' +
    '<div class="os-agcs">' + osAgentsVisible().map(osAgentCard).join('') + '</div>' +
    '<div class="mg-panel"><div class="mg-panel-h"><h2>Everything, as it happened</h2><span class="mg-aside">This session and the last 3 days</span></div>' + osFeedHtml(40, true) + '</div>';
}
function osFeedHtml(n, withAgent){
  const rows = osActVisible().slice(0, n);
  if(!rows.length) return '<div class="mg-empty">Nothing recorded yet. As soon as your books sync or I do something, it shows here.</div>';
  return '<div class="os-feed">' + rows.map(x => {
    const a = OS_AGENT[x.agent];
    return '<div class="os-fe ' + x.state + '"><span class="os-fe-dot"></span><span class="os-fe-t">' + (withAgent && a ? '<b>' + escapeHtml(a.name) + '</b> ' : '') + escapeHtml(x.text) + '</span><small>' + escapeHtml(x.state === 'running' ? 'now' : osWhen(x.end || x.at) + ' · ' + osSince(x.end || x.at)) + '</small></div>';
  }).join('') + '</div>';
}

/* ---------- presence: who else is in Margyn right now ---------- */
let osPresence = null, osPresenceState = {};
function osMyName(){ try { return (typeof mgActorName === 'function' && mgActorName()) || (typeof mgrName !== 'undefined' && mgrName) || (lsGet('margyn_owner_name') || '') || (currentUser && String(currentUser.email || '').split('@')[0]) || 'You'; } catch(e){ return 'You'; } }
function osInitials(n){ return String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?'; }
function osWhere(){ return osCur ? osCur.space.label + (osCur.space.tabs.length > 1 ? ' · ' + osCur.tab.label : '') : 'Desk'; }
function osPresenceList(){
  const me = currentUser && currentUser.id, out = [];
  Object.values(osPresenceState || {}).forEach(arr => (arr || []).forEach(p => { if(!out.some(x => x.id === p.id)) out.push({ id:p.id, name:p.name, where:p.where, me:p.id === me, at:p.at }); }));
  return out;
}
function osStartPresence(){
  try {
    if(osPresence || !sbClient || !sbClient.channel || !currentUser) return;
    const acct = osOwner(); if(!acct) return;
    osPresence = sbClient.channel('os-presence-' + acct, { config:{ presence:{ key:currentUser.id } } });
    osPresence.on('presence', { event:'sync' }, () => { osPresenceState = osPresence.presenceState(); osRefreshLive(); })
      .subscribe(st => { if(st === 'SUBSCRIBED') osTrack(); });
  } catch(e){ console.warn('[os] presence', e); }
}
function osTrack(){ try { if(osPresence) osPresence.track({ id:currentUser.id, name:osMyName(), where:osWhere(), at:new Date().toISOString() }); } catch(e){} }
function osTeamHtml(){
  const ps = osPresenceList();
  const others = ps.filter(p => !p.me);
  let members = []; try { members = (typeof mgTeamData !== 'undefined' && mgTeamData && mgTeamData.members) || []; } catch(e){}
  const rows = [{ name:osMyName() + ' (you)', where:osWhere(), on:true }].concat(others.map(p => ({ name:p.name, where:p.where, on:true })));
  members.forEach(m => { const n = m.name || m.email; if(n && !rows.some(r => r.name === n) && m.status !== 'removed') rows.push({ name:n, where:m.role_label || '', on:false }); });
  return rows.map(r => '<div class="os-pp"><span class="os-av' + (r.on ? ' on' : '') + '">' + escapeHtml(osInitials(r.name)) + '</span><div><b>' + escapeHtml(r.name) + '</b><span>' + escapeHtml(r.on ? 'In ' + r.where : r.where || 'Not online') + '</span></div><span class="os-pp-st' + (r.on ? ' on' : '') + '">' + (r.on ? 'Online' : 'Away') + '</span></div>').join('') +
    (rows.length < 2 ? '<div class="os-pp-hint">Invite your accountant or CA and you’ll see when they’re working here. <button type="button" class="mg-link" data-os-go="team/people">Invite →</button></div>' : '');
}
function osFaces(){
  const el = document.getElementById('osFaces');
  const others = osPresenceList().filter(p => !p.me);
  if(!el){ return; }
  el.innerHTML = others.slice(0, 3).map(p => '<span class="os-av on" title="' + escapeHtml(p.name + ' · ' + (p.where || '')) + '">' + escapeHtml(osInitials(p.name)) + '</span>').join('');
  el.classList.toggle('hidden', !others.length);
}

/* ---------- Desk ---------- */
function osTile(o){
  return '<button type="button" class="os-wft' + (o.busy ? ' busy' : '') + '" data-os-go="' + o.go + '">' +
    '<span class="os-wft-k">' + osIcon(o.icon) + '<b>' + escapeHtml(o.label) + '</b>' + (o.n ? '<i class="hot">' + o.n + '</i>' : '') + '</span>' +
    '<span class="os-wft-v' + (o.tone ? ' ' + o.tone : '') + '">' + escapeHtml(o.value) + '</span><span class="os-wft-s">' + escapeHtml(o.sub || '') + '</span></button>';
}
function osDeskTiles(){
  const s = (snapshots || [])[0] || null;
  const v = l => { const x = mgVital(s, l); return x ? Number(x.raw != null ? x.raw : x.value) : null; };
  const st = k => osAgentState(k);
  let recv = [], pay = []; try { recv = mgMoneyGroups('recv'); pay = mgMoneyGroups('pay'); } catch(e){}
  const sum = (g, f) => g.reduce((t, x) => t + (Number(x[f]) || 0), 0);
  const age = (() => { try { return mgInvoiceAgeing(recv); } catch(e){ return null; } })();
  let f = null; try { f = mgForecast(); } catch(e){}
  const G = (() => { try { return mgGstFig(s, 'gst_payable'); } catch(e){ return { known:false }; } })();
  let dis = []; try { dis = mgDisagreements(); } catch(e){}
  const cashV = s && s.cash != null && isFinite(Number(s.cash)) ? Number(s.cash) : null;   // the same figure as Cash › Overview
  const recvTotal = sum(recv, 'amount'), over90 = age ? age.b3 : 0, payTotal = sum(pay, 'amount');
  return '<div class="os-wfts">' + [
    osCan('view_cash') && osTile({ go:'cash/overview', icon:'cash', label:'Cash', value:cashV != null ? fmtINR(cashV, 'tile') : '—', sub:f ? (f.firstBelow >= 0 ? 'Dips below floor in week ' + (f.firstBelow + 1) : 'Above your floor for 13 weeks') : 'Forecast needs more figures', tone:f && f.firstBelow >= 0 ? 'neg' : '', busy:st('forecast').state === 'working' }),
    osCan('view_receivables') && osTile({ go:'collect/overview', icon:'collect', label:'Collect', value:recvTotal ? fmtINR(recvTotal, 'tile') : '—', sub:recvTotal ? (over90 ? fmtINR(over90, 'tile') + ' past 90 days' : 'owed to you') : 'Nothing owed yet', tone:over90 ? 'neg' : '', n:st('payments').need + st('collections').need, busy:st('payments').state === 'working' || st('collections').state === 'working' }),
    osCan('view_payables') && osTile({ go:'pay/overview', icon:'pay', label:'Pay', value:payTotal ? fmtINR(payTotal, 'tile') : '—', sub:payTotal ? 'you owe suppliers' : 'Nothing owed yet' }),
    osCan('view_gst') && osTile({ go:'tax/gst', icon:'tax', label:'Tax', value:G.known ? fmtINR(G.v, 'tile') : '—', sub:G.known ? 'GST payable this month' : 'Connect Zoho Books for GST', n:st('gst').need, busy:st('gst').state === 'working' }),
    osAllowed('books') && osTile({ go:'close/overview', icon:'close', label:'Close', value:dis.length ? dis.length + ' to check' : 'Books agree', sub:dis.length ? 'place' + (dis.length === 1 ? '' : 's') + ' your books disagree' : 'across every source', tone:dis.length ? 'warn' : '', n:st('books').need, busy:st('books').state === 'working' }),
    osAllowed('scores') && osTile({ go:'plan/pulse', icon:'plan', label:'Plan', value:s && s.pulse_score != null ? 'Pulse ' + s.pulse_score : '—', sub:s && s.pulse_score != null ? 'operating health, out of 100' : 'Needs your figures' })
  ].filter(Boolean).join('') + '</div>';
}
function osRenderDesk(){
  const host = document.getElementById('view-home'); if(!host) return;
  let m = { line:'', sub:'', tag:'', level:'steady' }; try { m = mgrMood(); } catch(e){}
  if(!osCan('view_cash')) m = { line:'Here’s what needs you today.', sub:'' };   // Margyn's read leads with cash
  const who = typeof mgActorName === 'function' ? mgActorName() : '';
  let dec = []; try { dec = mgDecisions(); } catch(e){}
  const name = who || (typeof mgrName !== 'undefined' && mgrName) || '';
  const hr = Number(new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', hour:'numeric', hour12:false }));
  const hello = (hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + name.split(/\s+/)[0] : '');
  const day = new Date().toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', weekday:'long', day:'numeric', month:'short' });
  const away = typeof mgrAway !== 'undefined' && mgrAway && mgrAway.did && mgrAway.did.length ? mgrAway.did : [];
  const s = (snapshots || [])[0] || null;
  const run = osRunning();
  host.innerHTML =
    '<div class="os-hello"><div><div class="os-hello-d">' + escapeHtml(day.toUpperCase() + ' · ' + hello.toUpperCase()) + '</div>' +
      '<h1 class="os-hello-h">' + escapeHtml(m.line || (s ? 'Here’s where things stand.' : 'Let’s get your figures in.')) + '</h1>' +
      (who && typeof mgActor !== 'undefined' && mgActor ? '<div class="os-hello-role">Signed in as ' + escapeHtml(mgActor.roleLabel || '') + (osCan('edit') ? '' : ', read-only') + '. You see what your role allows.</div>' : '') +
      (away.length ? '<div class="os-hello-away"><b>While you were away:</b> ' + escapeHtml(away.join(', ')) + '.</div>' : (m.sub ? '<div class="os-hello-away">' + escapeHtml(m.sub) + '</div>' : '')) + '</div>' +
      '<button type="button" class="os-now' + (run.length ? ' on' : '') + '" data-os-go="margyn/live"><span class="os-pulse' + (run.length ? '' : ' idle') + '"><i></i>' + (run.length ? '<i></i>' : '') + '</span><span><b>' + (run.length ? 'Margyn is working' : 'Margyn · agents idle') + '</b><span class="os-now-t" id="osDeskNow">' +
        escapeHtml(osNowText()) + '</span></span></button></div>' +
    (s ? '' : '<div class="mg-panel os-setup"><div class="mg-panel-h"><h2>Set Margyn up</h2><span class="mg-aside">Takes a few minutes</span></div><div class="os-setup-list">' +
      '<button type="button" data-os-go="apps/connected"><b>Connect your books</b><span>Tally, Zoho Books or Odoo</span></button>' +
      '<button type="button" data-os-go="apps/connected"><b>Connect payments</b><span>Razorpay, Cashfree or Shopify</span></button>' +
      '<button type="button" data-os-go="documents/import"><b>Or import a file</b><span>Excel, CSV, PDF or a photo</span></button>' +
      '<button type="button" data-os-go="team/people"><b>Invite your accountant</b><span>They get their own login</span></button></div></div>') +
    osDeskTiles() +
    '<div class="os-desk">' +
      '<div class="os-desk-l">' +
        '<div class="mg-panel"><div class="mg-panel-h"><h2>Needs you</h2><span class="mg-aside">' + (dec.length ? dec.length + ' waiting' : 'All clear') + '</span></div>' +
          (dec.length ? '<div class="os-need">' + dec.slice(0, 6).map(x => '<div class="os-need-r"><div><b>' + escapeHtml(x.t) + '</b><span>' + escapeHtml(x.s) + '</span></div><span class="os-need-a">' + (x.amt ? escapeHtml(fmtINR(x.amt, 'tile')) : '') + '</span><span class="mg-pill os-pill-prop">Proposed</span></div>').join('') + '</div>' +
            '<div class="os-need-f"><button type="button" class="mg-btn primary mg-btn-sm" data-os-go="work/needs-me">Review and approve</button><button type="button" class="mg-btn mg-btn-sm" data-mgr-ask="What needs my OK?">Go through them with Margyn</button></div>'
            : '<div class="mg-empty">Nothing is waiting on you. When an agent needs a decision, it lands here.</div>') + '</div>' +
        '<div class="mg-panel"><div class="mg-panel-h"><h2>Activity</h2><span class="mg-aside"><span class="os-livetag"><i></i>Live</span> people and Margyn</span></div><div id="osDeskFeed">' + osFeedHtml(8, true) + '</div></div>' +
      '</div>' +
      '<div class="os-desk-r">' +
        '<div class="mg-panel"><div class="mg-panel-h"><h2>Margyn at work</h2><button type="button" class="mg-link mg-aside" data-os-go="margyn/live">See it live →</button></div><div class="os-ags" id="osDeskAgents">' + osAgentsVisible().map(osAgentRow).join('') + '</div></div>' +
        '<div class="mg-panel"><div class="mg-panel-h"><h2>Team</h2><span class="mg-aside">' + (osPresenceList().filter(p => !p.me).length + 1) + ' online</span></div><div class="os-people" id="osDeskTeam">' + osTeamHtml() + '</div></div>' +
      '</div>' +
    '</div>';
}

/* ---------- All work: what's waiting, what's running, what's done ---------- */
let osWorkTab = 'waiting';
function osRenderWork(){
  const host = document.getElementById('view-work'); if(!host) return;
  let dec = []; try { dec = mgDecisions(); } catch(e){}
  const running = [];
  try { (chaseTargets || []).filter(t => ['active', 'paused_promise', 'disputed', 'escalated_human'].includes(t.state)).forEach(t => running.push({ w:'Collect', t:(t.state === 'paused_promise' ? 'Waiting for ' : t.state === 'active' ? 'Chasing ' : 'Needs you: ') + (t.party_name || 'customer'), s:t.state === 'paused_promise' ? 'Promised to pay' + (t.promise_to_pay_date ? ' by ' + fmtDay(t.promise_to_pay_date) : '') : t.next_chase_at ? 'Next reminder ' + fmtDay(t.next_chase_at) : (t.state || '').replace('_', ' '), amt:Number(t.amount) || 0, st:['disputed', 'escalated_human'].includes(t.state) ? 'need' : 'run', go:'collect/chasing' })); } catch(e){}
  osRunning().forEach(a => running.push({ w:(OS_AGENT[a.agent] || {}).name || 'Margyn', t:a.text, s:'Running now', amt:0, st:'run' }));
  const done = osActVisible().filter(a => a.state === 'done').slice(0, 40);
  let le = []; try { le = ((typeof ledgerEvents !== 'undefined' && ledgerEvents) || []).filter(e => e.channel !== 'agent').slice(0, 30); } catch(e){}
  const tabs = [['waiting', 'Waiting on a person', dec.length], ['assigned', 'Assigned', typeof osAssignedCount === 'function' ? osAssignedCount() : 0], ['running', 'Margyn is on it', running.length], ['people', 'Done by people', le.length], ['done', 'Done by Margyn', done.length]];
  let body = '';
  if((osWorkTab === 'waiting' || osWorkTab === 'assigned') && typeof osWorkTableHtml === 'function') body = osWorkTableHtml(osWorkTab);
  else if(osWorkTab === 'waiting') body = dec.length ? '<table class="mg-grid os-work"><thead><tr><th></th><th>What</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
      dec.map(x => '<tr><td class="os-own"><span class="os-av m">M</span></td><td><b>' + escapeHtml(x.t) + '</b><div class="mg-muted">' + escapeHtml(x.s) + '</div></td><td class="r">' + (x.amt ? mgNum(x.amt) : '') + '</td><td><span class="mg-pill os-pill-prop">Proposed</span></td><td class="r"><button type="button" class="mg-btn mg-btn-sm primary" data-os-go="work/needs-me">Review</button></td></tr>').join('') + '</tbody></table>'
    : '<div class="mg-empty">Nothing is waiting on a person.</div>';
  else if(osWorkTab === 'running') body = running.length ? '<table class="mg-grid os-work"><thead><tr><th></th><th>What</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>' +
      running.map(x => '<tr' + (x.go ? ' class="click" data-os-go="' + x.go + '"' : '') + '><td class="os-own"><span class="os-av m">M</span></td><td><span class="os-wfc">' + escapeHtml(x.w) + '</span><b>' + escapeHtml(x.t) + '</b><div class="mg-muted">' + escapeHtml(x.s) + '</div></td><td class="r">' + (x.amt ? mgNum(x.amt) : '') + '</td><td><span class="mg-pill ' + (x.st === 'need' ? 'os-pill-wait' : 'os-pill-run') + '">' + (x.st === 'need' ? 'Needs you' : 'Running') + '</span></td></tr>').join('') + '</tbody></table>'
    : '<div class="mg-empty">Margyn has nothing in progress right now.</div>';
  else if(osWorkTab === 'people') body = le.length ? '<table class="mg-grid os-work"><thead><tr><th></th><th>What</th><th class="r">Amount</th><th>When</th></tr></thead><tbody>' +
      le.map(e => '<tr><td class="os-own"><span class="os-av">' + escapeHtml(osInitials(e.actor_name || 'You')) + '</span></td><td><b>' + escapeHtml(((e.actor_name || 'Someone') + ' ' + ({ settled:'settled', deleted:'removed', created:'added', imported:'imported', updated:'changed' }[e.event] || e.event || '') + ' ' + (e.entity_type || '')).trim()) + '</b><div class="mg-muted">' + escapeHtml([e.party_name, e.note].filter(Boolean).join(' · ')) + '</div></td><td class="r">' + (e.amount != null ? mgNum(e.amount) : '') + '</td><td class="mg-mono">' + escapeHtml(e.created_at ? osSince(e.created_at) : '') + '</td></tr>').join('') + '</tbody></table>'
    : '<div class="mg-empty">Nothing yet. Changes your team makes show here, with who made them.</div>';
  else body = done.length ? '<div class="os-feed">' + done.map(x => '<div class="os-fe done"><span class="os-fe-dot"></span><span class="os-fe-t"><b>' + escapeHtml((OS_AGENT[x.agent] || {}).name || 'Margyn') + '</b> ' + escapeHtml(x.text) + '</span><small>' + escapeHtml(osSince(x.end || x.at)) + '</small></div>').join('') + '</div>'
    : '<div class="mg-empty">Nothing recorded yet this session.</div>';
  host.innerHTML = mgPageHead({ group:'Work', title:'All work', sub:'Everything in progress across the business: what waits on a person, what Margyn is doing, and what was done.' }) +
    '<div class="os-subtabs">' + tabs.map(t => '<button type="button" class="' + (t[0] === osWorkTab ? 'on' : '') + '" data-os-worktab="' + t[0] + '">' + escapeHtml(t[1]) + '<i>' + t[2] + '</i></button>').join('') + '</div>' +
    '<div class="mg-panel mg-gridwrap">' + body + '</div>';
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-os-worktab]'); if(b){ osWorkTab = b.dataset.osWorktab; osRenderWork(); return; }
  if(e.target.closest('[data-os-refresh]')){ osLoadServer(true); if(typeof refreshAll === 'function') refreshAll(); }
});

/* ---------- keep everything that shows live work current ---------- */
let osLiveQueued = false;
function osRefreshLive(){
  if(osLiveQueued) return; osLiveQueued = true;
  requestAnimationFrame(() => {
    osLiveQueued = false;
    osDrawPill(); osFaces();
    if(typeof osCounts === 'function') osCounts();
    const v = typeof mgCurrentView !== 'undefined' ? mgCurrentView : '';
    if(v === 'home'){
      const f = document.getElementById('osDeskFeed'); if(f) f.innerHTML = osFeedHtml(8, true);
      const a = document.getElementById('osDeskAgents'); if(a) a.innerHTML = osAgentsVisible().map(osAgentRow).join('');
      const t = document.getElementById('osDeskTeam'); if(t) t.innerHTML = osTeamHtml();
      const n = document.getElementById('osDeskNow'); const run = osRunning();
      if(n){ n.textContent = osNowText(); const hb = n.previousElementSibling; if(hb) hb.textContent = run.length ? 'Margyn is working' : 'Margyn · agents idle';
        const btn = n.closest('.os-now'); if(btn){ btn.classList.toggle('on', !!run.length); } }
    }
    if(v === 'live') osRenderLive();
    if(v === 'work') osRenderWork();
  });
}
osActListeners.push(osRefreshLive);
setInterval(() => { if(!document.hidden){ osDrawPill(); } }, 30000);
setInterval(() => { if(!document.hidden && currentUser) osLoadServer(); }, 60000);

/* ---------- register pages + boot ---------- */
MG_OWN_RENDER.home = osRenderDesk;
MG_OWN_RENDER.live = osRenderLive;
MG_OWN_RENDER.work = osRenderWork;
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    try { osFromGlobals(); osLoadServer(); osStartPresence(); osTrack(); osDrawPill(); } catch(e){ console.error('[os] live boot', e); }
    return out;
  };
  const sv = showView;
  showView = function(){ const out = sv.apply(this, arguments); osTrack(); return out; };
})();
(function addFaces(){
  const live = document.getElementById('topSync'); if(!live || document.getElementById('osFaces')) return;
  const f = document.createElement('span'); f.id = 'osFaces'; f.className = 'os-faces hidden';
  live.parentNode.parentNode.insertBefore(f, live.parentNode);
})();
osDrawPill();
