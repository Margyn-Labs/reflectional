/* ============================================================
   MARGYN — one place to work with Margyn (2026-09-30).

   One Margyn, one panel. The panel on the right is the conversation:
   typing, talking (a call is the same panel in voice mode, see
   22-realtime-voice.js) and everything Margyn shows (views, tables, change
   cards) land in the same thread. Typed questions get the same screen tools
   the voice call has: the server pauses a turn, the page runs the tools
   (23-voice-tools.js), and the turn carries on (api/ask-margyn.js, `resume`).

   Also here:
     - the greeting: "Hey Varad, welcome back", what happened while they
       were away, what needs them, what's new in Margyn;
     - nudges: Margyn speaks up when something is wrong. Plain rules on data
       the app already has; no AI call, so they cost nothing;
     - the status line in the top bar: what Margyn is doing, from real events.

   Nothing here writes on its own. Changes go through the same confirm card
   as before (actionCardHtml / wireActionCardConfirm).
   ============================================================ */
let mgrThread = null;          // chat_messages.thread_key of the panel conversation (typed + voice)
const mgrHistory = [];         // { role, content } sent to Claude as context
let mgrBusy = false, mgrFocus = null, mgrGreeted = false, mgrUserId = null;
let mgrAway = null;            // what happened since the last visit (shared with the Home desk)
let mgrName = null;            // first name, once known
const MGR_OPEN_KEY = 'mg.panel', MGR_SEEN_KEY = 'mg.lastSeen.', MGR_SNOOZE_KEY = 'mg.nudge.snooze';

function mgrEl(id){ return document.getElementById(id); }
function mgrFeed(){ return mgrEl('vxFeed'); }
function mgrWide(){ return window.innerWidth >= 1100; }

/* ---------- open / close ---------- */
function mgrIsOpen(){ return document.body.classList.contains('mgr-open'); }
function mgrOpen(focusInput){
  const r = mgrEl('mgRail'); if(!r) return;
  r.classList.remove('hidden');
  document.body.classList.add('mgr-open');
  lsSet(MGR_OPEN_KEY, 'open');
  mgrHideBubble();
  const b = mgrEl('mgAskBtn'); if(b) b.classList.add('on');
  if(focusInput) setTimeout(() => { const i = mgrEl('mgrInput'); if(i) i.focus(); }, 60);
  mgrScroll();
}
function mgrClose(dontRemember){
  if(typeof vxActive !== 'undefined' && vxActive) closeRealtimeOverlay();
  const r = mgrEl('mgRail'); if(r) r.classList.add('hidden');
  document.body.classList.remove('mgr-open');
  if(!dontRemember) lsSet(MGR_OPEN_KEY, 'closed');
  const b = mgrEl('mgAskBtn'); if(b) b.classList.remove('on');
}
function mgrToggle(){ if(mgrIsOpen()) mgrClose(); else mgrOpen(true); }
function mgrScroll(){ const f = mgrFeed(); if(f) requestAnimationFrame(() => { f.scrollTop = f.scrollHeight; }); }

/* ---------- conversation ---------- */
function mgrThreadKey(){
  if(!mgrThread) mgrThread = 'panel:' + new Date().toISOString();
  return mgrThread;
}
/* Voice lines and typed lines both feed the context Claude sees. */
function mgrRemember(role, content){
  content = String(content || '').trim(); if(!content) return;
  mgrHistory.push({ role, content:content.slice(0, 2000) });
  if(mgrHistory.length > 40) mgrHistory.splice(0, mgrHistory.length - 40);
}
function mgrTime(){ return new Date().toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit' }); }
/* A message row. who: 'user' | 'margyn'. `id` lets a live transcript update in place. */
function mgrLine(who, text, id){
  const f = mgrFeed(); if(!f) return null;
  let row = id ? f.querySelector('.mgr-msg[data-item="' + id + '"]') : null;
  if(!row){
    row = document.createElement('div');
    row.className = 'mgr-msg ' + (who === 'user' ? 'me' : 'm');
    if(id) row.dataset.item = id;
    row.innerHTML = (who === 'user' ? '' : '<div class="mgr-who">Margyn · ' + escapeHtml(mgrTime()) + '</div>') + '<div class="mgr-b"></div>';
    f.appendChild(row);
  }
  row.querySelector('.mgr-b').textContent = text || '';
  row.classList.toggle('pending', !text);
  mgrScroll();
  return row;
}
function mgrHtmlLine(html, cls){
  const f = mgrFeed(); if(!f) return null;
  const row = document.createElement('div');
  row.className = 'mgr-msg m' + (cls ? ' ' + cls : '');
  row.innerHTML = '<div class="mgr-who">Margyn · ' + escapeHtml(mgrTime()) + '</div><div class="mgr-b"></div>';
  row.querySelector('.mgr-b').innerHTML = html;
  f.appendChild(row);
  mgrScroll();
  return row;
}
/* Typed out, a couple of words at a time: reads as Margyn writing, and it's
   free (the reply is already here). */
function mgrType(el, text){
  return new Promise(resolve => {
    const words = String(text || '').split(/(\s+)/);
    let i = 0; el.textContent = '';
    const tick = () => {
      i += 4;
      el.textContent = words.slice(0, i).join('');
      mgrScroll();
      if(i < words.length) setTimeout(tick, 24); else resolve();
    };
    tick();
  });
}
async function mgrTypeHtml(el, html){
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  await mgrType(el, tmp.textContent);
  el.innerHTML = html;
  mgrScroll();
}
/* "> Opening receivables" — what Margyn is doing, typed out before the answer. */
async function mgrStep(host, text){
  if(!host || !text) return;
  const line = document.createElement('div');
  host.appendChild(line);
  const t = '› ' + text;
  for(let i = 1; i <= t.length; i += 2){ line.textContent = t.slice(0, i); await new Promise(r => setTimeout(r, 8)); }
  line.textContent = t;
  mgrScroll();
}
const MGR_VIEW_LABEL = { pnl:'your P&L', receivables:'receivables', payables:'payables', cash:'cash and the forecast', gst:'GST', inbox:'what needs your OK', overview:'the overview', cfopack:'the CFO pack', party:'the party', mismatches:'where sources disagree' };
function mgrStepLabel(name, a){
  a = a || {};
  const dir = a.direction === 'payables' ? 'vendors' : 'customers';
  switch(name){
    case 'navigate': return 'Opening ' + (typeof vxLabel === 'function' ? vxLabel(a.page) : a.page);
    case 'search_app': return 'Searching for “' + String(a.query || '').slice(0, 40) + '”';
    case 'get_screen': return 'Looking at your screen';
    case 'get_overview': return 'Reading the headline numbers';
    case 'query_parties': return 'Checking ' + dir + (a.search ? ' matching “' + String(a.search).slice(0, 30) + '”' : '');
    case 'open_party': return 'Opening ' + String(a.name || 'the record').slice(0, 40);
    case 'filter_list': return 'Filtering ' + (a.direction || 'the list');
    case 'get_cash': return 'Reading cash and the forecast';
    case 'get_gst': return 'Checking GST';
    case 'get_margin': return 'Reading your margin';
    case 'get_inbox': return 'Checking what’s waiting on you';
    case 'show_view': return 'Drawing ' + (a.view === 'party' && a.name ? String(a.name).slice(0, 40) : (MGR_VIEW_LABEL[a.view] || a.view));
    case 'show_note': return 'Writing it down';
    case 'show_table': case 'show_chart': return 'Drawing ' + String(a.title || 'it').slice(0, 40);
    case 'sync_source': return 'Syncing ' + ((typeof MG_SRC_LABEL !== 'undefined' && MG_SRC_LABEL[a.source]) || a.source);
    case 'get_sources': return 'Checking your sources';
    case 'fill_form': return 'Filling in the form';
    case 'save_form': return 'Saving';
    case 'clear_workspace': return 'Tidying up';
    case 'scroll': return a.to ? 'Scrolling to ' + String(a.to).slice(0, 30) : 'Scrolling ' + (a.direction || 'down');
    case 'close': return 'Closing ' + ({ side_panel:'the side panel', dialog:'the dialog', card:'the card', page:'the page', margyn:'Margyn' }[a.target] || 'it');
    case 'run_command': return ({ export_current_view:'Exporting the list', new_invoice:'Opening a new invoice', add_party:'Opening a new ' + (a.party_type === 'vendor' ? 'vendor' : 'customer'),
      add_receivable:'Opening the ledger form', add_payable:'Opening the ledger form', upload_file:'Opening Import', build_chart:'Opening Reports', print_cfo_pack:'Opening the CFO pack',
      refresh_data:'Refreshing your figures', close_side_panel:'Closing the side panel', open_command_palette:'Opening search' })[a.command] || 'Working';
  }
  return 'Working';
}

/* What the server needs to know about the person and the app: their first
   name and the latest release notes, so a new feature is known the day it ships. */
function mgrAppInfo(){
  const rel = (typeof MG_RELEASES !== 'undefined' ? MG_RELEASES : []).slice(0, 4)
    .map(r => ({ title:r.date + ': ' + r.title, items:(r.items || []).map(i => i.t) }));
  return { firstName:mgrName || '', whatsNew:rel };
}
function mgrContext(focus){
  const c = (typeof buildMargynContext === 'function') ? buildMargynContext(focus || null) : {};
  c.app = mgrAppInfo();
  return c;
}
function mgrDepth(){
  let d = typeof askDepth === 'function' ? askDepth() : 'balanced';
  if(d === 'deep'){
    if(typeof askDeepRemaining === 'function' && askDeepRemaining() <= 0) d = 'balanced';
    else if(typeof askDeepConsume === 'function') askDeepConsume();
  }
  return d;
}
async function mgrPost(body){
  const { data:{ session } } = await sbClient.auth.getSession();
  const res = await fetch('/api/ask-margyn', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', ...(session ? { 'Authorization':'Bearer ' + session.access_token } : {}) },
    body:JSON.stringify(body)
  });
  if(!res.ok){
    const b = await res.json().catch(() => ({}));
    throw new Error(res.status === 429 ? (b.error || 'You’ve hit today’s chat limit. Resets tomorrow.') : 'Couldn’t reach Margyn just now, try again in a moment.');
  }
  return res.json();
}
/* Run the screen tools the server handed back, in order, showing each step. */
async function mgrRunCalls(calls, stepsEl){
  const results = [];
  for(const c of calls){
    await mgrStep(stepsEl, mgrStepLabel(c.name, c.input));
    let out;
    try { const fn = VX_TOOLS[c.name]; out = fn ? await fn(c.input || {}) : { error:'Unknown tool ' + c.name }; }
    catch(e){ console.error('[margyn] tool ' + c.name, e); out = { error:(e && e.message) || 'That failed.' }; }
    let s = JSON.stringify(out === undefined ? { ok:true } : out);
    if(s.length > 3500) s = s.slice(0, 3500) + '…(trimmed)';
    results.push({ id:c.id, content:s });
  }
  return results;
}
/* Ask Margyn something from the panel (typed, a suggestion, a nudge button,
   or anywhere else in the app that hands over a question). */
async function mgrAsk(text, opts){
  text = String(text || '').trim(); if(!text) return;
  opts = opts || {};
  if(!mgrIsOpen()) mgrOpen();
  if(typeof vxActive !== 'undefined' && vxActive){ vxSendText(text); return; }   // on a call: the call answers
  if(mgrBusy){ toast('Margyn is still answering', { sub:'Give it a second' }); return; }
  if(opts.focus) mgrFocus = opts.focus;
  mgrBusy = true; mgrSetBusy(true);
  const sugg = mgrEl('mgrSugg'); if(sugg) sugg.innerHTML = '';
  mgrLine('user', text);
  const history = mgrHistory.slice(-9);
  mgrRemember('user', text);
  if(typeof vxUtterances !== 'undefined') vxUtterances.push({ at:Date.now(), text });   // save_form's "yes, save it" check reads these
  const tk = mgrThreadKey();
  saveChatMessage(tk, mgrFocus, 'user', text, 'margyn');
  const row = mgrHtmlLine('<div class="mgr-steps"></div><div class="mgr-dots"><i></i><i></i><i></i></div>', 'working');
  const stepsEl = row.querySelector('.mgr-steps');
  const depth = mgrDepth();
  let data;
  try {
    data = await mgrPost({ message:text, history, context:mgrContext(mgrFocus), depth, surface:'panel' });
    for(let n = 0; data && data.clientCalls && n < 5; n++){
      for(const s of (data.steps || [])) await mgrStep(stepsEl, s);
      if(data.interim) await mgrStep(stepsEl, data.interim.slice(0, 160));
      const results = await mgrRunCalls(data.clientCalls, stepsEl);
      data = await mgrPost({ resume:Object.assign({}, data.resume, { results }), context:mgrContext(mgrFocus), depth, surface:'panel' });
    }
    for(const s of ((data && data.steps) || [])) await mgrStep(stepsEl, s);
    const reply = (data && data.reply) || 'I couldn’t work that out. Try saying it another way?';
    row.querySelector('.mgr-dots').remove();
    row.classList.remove('working');
    // Cards drawn during this turn sit above the answer; the answer comes last.
    const body = document.createElement('div'); body.className = 'mgr-text';
    const cardsAfter = row.nextElementSibling;
    if(cardsAfter){ const again = mgrHtmlLine('', 'follow'); again.querySelector('.mgr-b').appendChild(body); }
    else row.querySelector('.mgr-b').appendChild(body);
    await mgrType(body, reply);
    mgrRemember('assistant', reply);
    saveChatMessage(tk, mgrFocus, 'assistant', reply, 'margyn');
    if(data && data.actionCard && data.actionCard.type) mgrShowChange(data.actionCard, text);
    if(typeof mtrack === 'function') mtrack('ask_message_sent', { msg_len:text.length, surface:'panel' });
  } catch(err){
    const d = row.querySelector('.mgr-dots'); if(d) d.remove();
    row.classList.remove('working');
    row.querySelector('.mgr-b').insertAdjacentHTML('beforeend', '<div class="mgr-text">' + escapeHtml(err.message || 'Something went wrong.') + '</div>');
  } finally {
    mgrBusy = false; mgrSetBusy(false); mgrScroll();
  }
}
function mgrSetBusy(on){
  const s = mgrEl('mgrSend'); if(s) s.disabled = !!on;
  const r = mgrEl('mgRail'); if(r) r.classList.toggle('busy', !!on);
}
/* A change Margyn prepared: same confirm card as everywhere, nothing happens without a tap. */
function mgrShowChange(action, request){
  const card = vxAddCard('<h4>Needs your OK</h4><div class="vx-action">' + actionCardHtml(action) + '</div><div class="vx-note vx-how">Nothing changes until you confirm.</div>', 'vx-change');
  if(!card) return;
  const inner = card.querySelector('.action-card');
  if(!inner) return;
  wireActionCardConfirm(inner, action);
  const mo = new MutationObserver(() => {
    if(!card.querySelector('.action-card-done')) return;
    mo.disconnect();
    card.classList.add('vx-done');
    const h = card.querySelector('h4'); if(h) h.textContent = 'Done';
    const how = card.querySelector('.vx-how'); if(how) how.remove();
    mgStatus('Applied: ' + (action.humanSummary || action.type));
    saveChatMessage(mgrThreadKey(), mgrFocus, 'assistant', '[Applied by tap] ' + (action.humanSummary || action.type), 'margyn');
    mgrRemember('assistant', 'Done: ' + (action.humanSummary || action.type));
  });
  mo.observe(card, { childList:true, subtree:true });
}

/* New conversation / reopen an old one (from Conversations). */
function mgrNewThread(focus){
  mgrThread = null; mgrHistory.length = 0; mgrFocus = focus || null;
  const f = mgrFeed(); if(f) f.innerHTML = '';
  if(focus) mgrHtmlLine('Let’s talk about <b>' + escapeHtml(focus) + '</b>. What do you want to know?');
  else mgrHtmlLine('New conversation. What do you need?');
  mgrSuggest();
}
async function mgrLoadThread(threadKey, label){
  mgrOpen();
  mgrThread = threadKey; mgrHistory.length = 0; mgrFocus = null;
  const f = mgrFeed(); if(f) f.innerHTML = '';
  const past = await loadChatThread(threadKey, 60);
  past.forEach(m => {
    if(m.role !== 'user' && m.role !== 'assistant') return;
    mgrLine(m.role === 'user' ? 'user' : 'margyn', m.content);
    mgrRemember(m.role, m.content);
    if(m.vital && !mgrFocus) mgrFocus = m.vital;
  });
  mgrHtmlLine('That’s where we left off' + (label ? ' (' + escapeHtml(label) + ')' : '') + '. Carry on whenever you’re ready.', 'quiet');
}

/* Suggestions under the conversation: what's actually useful right now. */
function mgrSuggest(){
  const host = mgrEl('mgrSugg'); if(!host) return;
  const ideas = [];
  try { if(mgDecisions().length) ideas.push('What needs my OK?'); } catch(e){}
  try { if(mgMoneyGroups('recv').some(g => g.overdue > 0)) ideas.push('Who should I chase first?'); } catch(e){}
  ideas.push('Will cash dip soon?', 'Show my P&L');
  host.innerHTML = ideas.slice(0, 3).map(i => '<button type="button">' + escapeHtml(i) + '</button>').join('');
}

/* ---------- who am I talking to ---------- */
function mgrFirstWord(s){
  const w = String(s || '').trim().split(/[\s@._]+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
}
/* A person's name, not the product's or the business's ("Margyn Demo" as the
   owner row on a demo account greeted the founder as "Hey Margyn"). */
function mgrPersonName(s){
  const w = mgrFirstWord(s);
  if(!w || w.length < 2 || /\d/.test(w) || /^(margyn|admin|owner|test|demo|finance|accounts?|team|info|hello|support)$/i.test(w)) return '';
  const co = mgrFirstWord((currentProfile && currentProfile.company_name) || '');
  return co && co === w ? '' : w;
}
async function mgrResolveName(){
  try { const p = typeof mgPrefGet === 'function' ? mgPrefGet('display_name', null) : null; if(p && mgrPersonName(p)) return mgrPersonName(p); } catch(e){}
  try { if(typeof mgActor !== 'undefined' && mgActor && !mgActor.isOwner && mgActor.name && mgrPersonName(mgActor.name)) return mgrPersonName(mgActor.name); } catch(e){}
  try { const md = currentUser && currentUser.user_metadata; if(md && mgrPersonName(md.full_name || md.name)) return mgrPersonName(md.full_name || md.name); } catch(e){}
  if(typeof mgActor !== 'undefined' && mgActor && !mgActor.isOwner) return '';
  try {
    // The People page: the owner's own named number.
    const { data } = await sbClient.from('business_stakeholders').select('name,role,is_primary').eq('business_id', currentUser.id);
    const me = (data || []).find(r => r.role === 'owner') || (data || []).find(r => r.is_primary);
    if(me && mgrPersonName(me.name)) return mgrPersonName(me.name);
  } catch(e){}
  return '';
}
function mgrSaveName(v){
  v = String(v || '').trim().slice(0, 60); if(!v) return;
  try { if(typeof mgPrefSet === 'function') mgPrefSet('display_name', v); } catch(e){}
  mgrName = mgrPersonName(v) || mgrFirstWord(v);
  const pf = mgrEl('pfName'); if(pf) pf.value = v;
}

/* ---------- while you were away ---------- */
function mgrAgo(iso){
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + (Math.round(m / 1440) === 1 ? ' day ago' : ' days ago');
}
async function mgrAwayFacts(since){
  const out = { since, did:[], paid:0, paidNames:[], reminders:0, events:0, byPeople:[], docs:0 };
  if(!since) return out;
  const t0 = new Date(since).getTime();
  const after = iso => iso && new Date(iso).getTime() > t0;
  try {
    const { data } = await sbClient.from('whatsapp_chase_targets').select('party_name,amount,state,last_chase_at,resolved_at').eq('user_id', currentUser.id);
    (data || []).forEach(t => {
      if(after(t.last_chase_at)) out.reminders++;
      if(t.state === 'resolved_paid' && after(t.resolved_at)){ out.paid += Number(t.amount) || 0; out.paidNames.push(t.party_name); }
    });
  } catch(e){}
  try {
    const ev = (typeof loadLedgerEvents === 'function') ? await loadLedgerEvents() : [];
    const fresh = (ev || []).filter(e => after(e.created_at));
    out.events = fresh.length;
    const people = {};
    // Other people's changes; your own aren't news to you.
    const meId = (typeof mgActor !== 'undefined' && mgActor && mgActor.authId) || currentUser.id;
    const meName = typeof mgActor !== 'undefined' && mgActor && mgActor.name;
    fresh.forEach(e => { if(e.actor_name && e.actor_id !== meId && e.actor_name !== meName) people[e.actor_name] = (people[e.actor_name] || 0) + 1; });
    out.byPeople = Object.entries(people).slice(0, 2).map(([n, c]) => mgrFirstWord(n) + ' made ' + c + ' change' + (c === 1 ? '' : 's'));
  } catch(e){}
  try { out.docs = (pendingSuggestions || []).filter(p => after(p.created_at)).length; } catch(e){}
  if(out.reminders) out.did.push('I sent ' + out.reminders + ' payment reminder' + (out.reminders === 1 ? '' : 's'));
  if(out.paid) out.did.push(out.paidNames.slice(0, 2).join(' and ') + (out.paidNames.length > 2 ? ' and ' + (out.paidNames.length - 2) + ' more' : '') + ' paid ' + fmtINR(out.paid, 'tile') + ' after a reminder');
  if(out.docs) out.did.push(out.docs + ' document' + (out.docs === 1 ? '' : 's') + ' came in on WhatsApp for me to read');
  out.byPeople.forEach(p => out.did.push(p));
  if(out.events && !out.byPeople.length) out.did.push(out.events + ' ledger change' + (out.events === 1 ? '' : 's') + ' came through');
  return out;
}

/* ---------- the greeting ---------- */
async function mgrGreet(){
  if(mgrGreeted || !currentUser) return;
  mgrGreeted = true;
  const key = MGR_SEEN_KEY + currentUser.id;
  const since = lsGet(key, '');
  mgrMarkSeen();
  // The desk and the greeting read who's being chased and which automations are on.
  try { if(typeof loadAgentData === 'function' && !Object.keys(agentDeployments || {}).length) await loadAgentData(); } catch(e){}
  try { if(typeof loadChaseTargets === 'function') await loadChaseTargets(); } catch(e){}
  mgrName = await mgrResolveName();
  mgrAway = await mgrAwayFacts(since || null);
  let dec = []; try { dec = mgDecisions(); } catch(e){}
  const fresh = (typeof mgWnUnseen === 'function' && since) ? mgWnUnseen() : [];
  const hi = mgrName ? 'Hey ' + escapeHtml(mgrName) : 'Hey there';
  // Back within half an hour (a reload, another tab): no "welcome back", no recap.
  const quick = since && Date.now() - new Date(since).getTime() < 30 * 60000;
  let html = '<h5>' + hi + (quick ? '.' : since ? ', welcome back.' : ', welcome to Margyn.') + '</h5>';
  if(quick){ /* nothing to recap */ }
  else if(since){
    html += '<p>' + (mgrAway.did.length
      ? 'Since you were last here (' + escapeHtml(mgrAgo(since)) + '): ' + escapeHtml(mgrAway.did.join(', ')) + '.'
      : 'Quiet since you were last here (' + escapeHtml(mgrAgo(since)) + '). Nothing new came in.') + '</p>';
  } else {
    html += '<p>I’m Margyn. I watch your numbers, chase who owes you, read what you forward me and tell you when something needs you. Ask me anything, or press Talk.</p>';
  }
  html += dec.length
    ? '<p><b>' + dec.length + ' thing' + (dec.length === 1 ? ' needs' : 's need') + ' your OK.</b> The biggest: ' + escapeHtml(dec[0].t.replace(/[.\s]+$/, '')) + (dec[0].amt && !/₹/.test(dec[0].t) ? ' (' + escapeHtml(fmtINR(dec[0].amt, 'tile')) + ')' : '') + '.</p>'
    : '<p>Nothing is waiting on you right now.</p>';
  const acts = [];
  if(dec.length) acts.push('<button type="button" class="mgr-chip" data-mgr-ask="What needs my OK?">Go through them with me</button>');
  if(fresh.length){
    html += '<p class="mgr-new">New in Margyn: ' + escapeHtml(fresh.map(r => r.title).join('; ')) + '.</p>';
    acts.push('<button type="button" class="mgr-chip" data-mgr-wn>See what’s new</button>');
    try { mgWnMarkSeen(MG_RELEASES[0].id); } catch(e){}
  }
  if(acts.length) html += '<div class="mgr-acts">' + acts.join('') + '</div>';
  if(!mgrName) html += '<form class="mgr-name" data-mgr-name><label>What should I call you?</label><div><input type="text" maxlength="60" placeholder="Your first name" autocomplete="given-name"><button type="submit" class="mgr-chip on">Save</button></div></form>';
  const f = mgrFeed();
  if(f && since && !quick){ const d = document.createElement('div'); d.className = 'mgr-divider'; d.textContent = 'New since you were here'; f.appendChild(d); }
  const row = mgrHtmlLine('', 'greet');
  if(row) await mgrTypeHtml(row.querySelector('.mgr-b'), html);
  mgrSuggest();
  if(!quick && mgrAway.did.length) mgStatus(mgrAway.did[0].replace(/^I /, 'Margyn ').replace(/^./, c => c.toUpperCase()), true);
  // Closed panel or a small screen: say hello in the bubble instead.
  if(!mgrIsOpen()) mgrBubble({ key:'greet', text:(mgrName ? 'Hey ' + mgrName : 'Hey') + (since ? ', welcome back.' : '.') + (dec.length ? ' ' + dec.length + ' thing' + (dec.length === 1 ? ' needs' : 's need') + ' your OK.' : ''), acts:[{ label:'Open Margyn', run:() => mgrOpen(true) }] }, true);
  if(typeof mgRenderOwn === 'function' && typeof mgCurrentView !== 'undefined' && mgCurrentView === 'home') mgRenderOwn('home');
  setTimeout(mgrCheckNudges, 20000);
}
function mgrMarkSeen(){ if(currentUser) lsSet(MGR_SEEN_KEY + currentUser.id, new Date().toISOString()); }

/* ---------- nudges: Margyn speaks up ----------
   Rules over what's already loaded. One at a time, at most three a session,
   never during a call, and a dismissed one stays quiet for a day. */
let mgrNudgesShown = 0, mgrNudgeQueue = [];
const MGR_NUDGE_CAP = 3, MGR_SNOOZE_MS = 24 * 3600000;
function mgrSnoozed(key){
  try { const m = JSON.parse(lsGet(MGR_SNOOZE_KEY, '{}') || '{}'); return m[key] && Date.now() - m[key] < MGR_SNOOZE_MS; } catch(e){ return false; }
}
function mgrSnooze(key){
  try { const m = JSON.parse(lsGet(MGR_SNOOZE_KEY, '{}') || '{}'); m[key] = Date.now();
    Object.keys(m).forEach(k => { if(Date.now() - m[k] > MGR_SNOOZE_MS * 3) delete m[k]; });
    lsSet(MGR_SNOOZE_KEY, JSON.stringify(m)); } catch(e){}
}
function mgrShowView(view, extra){
  mgrOpen();
  const out = VX_TOOLS.show_view(Object.assign({ view }, extra || {}));
  if(out && out.shown === false) mgGo(view === 'cash' ? 'cash' : view);
}
function mgrNudgeRules(){
  const out = [];
  const name = mgrName ? mgrName + ', ' : '';
  try {
    if(typeof mgChan !== 'undefined' && mgChan) (mgChan.channels || []).filter(c => c.status === 'failing').slice(0, 1).forEach(c => out.push({
      key:'chan:' + c.label, text:name + c.label + ' isn’t delivering: ' + c.detail + '.',
      acts:[{ label:'Show me', run:() => mgGo('channels') }] }));
  } catch(e){}
  ['zoho', 'odoo', 'shopify', 'tally', 'razorpay', 'cashfree'].forEach(k => {
    const h = mgSourceHealth(k); if(!h.on || !h.warn) return;
    const label = MG_SRC_LABEL[k] || k;
    const canSync = ['zoho', 'odoo', 'shopify'].includes(k) && !/reconnect/i.test(h.text);
    out.push({ key:'src:' + k, text:(name ? name : '') + label + (/reconnect/i.test(h.text) ? ' needs you to sign in again. Until then its figures may be stale.' : ' ' + h.text + '. Its figures may be stale.'),
      acts:canSync ? [{ label:'Sync now', run:() => mgrAsk('Sync ' + label + ' now') }, { label:'Sources', run:() => mgGo('sources') }] : [{ label:'Reconnect', run:() => mgGo('sources') }] });
  });
  try {
    const f = mgForecast();
    if(f && f.firstBelow >= 0 && f.firstBelow < 6) out.push({ key:'fc:below', text:name + 'cash looks set to drop below your floor in week ' + (f.firstBelow + 1) + ' (lowest ' + fmtINR(f.min, 'tile') + ').',
      acts:[{ label:'Show cash', run:() => mgrShowView('cash') }, { label:'What can I do?', run:() => mgrAsk('Cash drops below my floor in week ' + (f.firstBelow + 1) + '. What are my options?') }] });
  } catch(e){}
  try {
    const old = mgMoneyGroups('recv').filter(g => g.oldestDays != null && g.oldestDays <= -60 && g.overdue > 0);
    const amt = old.reduce((t, g) => t + g.overdue, 0);
    if(old.length) out.push({ key:'od60:' + old.length, text:fmtINR(amt, 'tile') + ' is more than 60 days overdue across ' + old.length + ' customer' + (old.length === 1 ? '' : 's') + ', the biggest ' + old.slice().sort((a, b) => b.overdue - a.overdue)[0].party + '.',
      acts:[{ label:'Show them', run:() => { mgrOpen(); VX_TOOLS.filter_list({ direction:'receivables', age:'61-90' }); } }, { label:'Who first?', run:() => mgrAsk('Who should I chase first, and why?') }] });
  } catch(e){}
  try {
    const due = mgMoneyGroups('pay').reduce((t, g) => t + (g.due7 || 0), 0);
    if(due > 0) out.push({ key:'pay7', text:fmtINR(due, 'tile') + ' of bills fall due in the next 7 days.',
      acts:[{ label:'Show payables', run:() => mgrShowView('payables') }, { label:'Can we cover it?', run:() => mgrAsk('Can we cover the bills due in the next 7 days?') }] });
  } catch(e){}
  try {
    const g = zohoConnected && zohoVitals && zohoVitals.gst_leakage;
    if(g && Number(g.total_leakage) > 0) out.push({ key:'itc', text:fmtINR(g.total_leakage, 'tile') + ' of input tax credit is at risk: ' + (g.vendors_not_filed || 'some') + ' vendor' + (g.vendors_not_filed === 1 ? ' hasn’t' : 's haven’t') + ' filed.',
      acts:[{ label:'Show GST', run:() => mgrShowView('gst') }] });
  } catch(e){}
  return out;
}
function mgrCheckNudges(){
  if(!currentUser || !mgrGreeted) return;
  if(typeof vxActive !== 'undefined' && vxActive) return;
  if(mgrNudgesShown >= MGR_NUDGE_CAP || document.querySelector('.mgr-nudge-msg.live, .mg-wn-scrim, .mg-dialog-scrim')) return;
  const next = mgrNudgeRules().find(n => !mgrSnoozed(n.key) && !mgrNudgeQueue.includes(n.key));
  if(!next) return;
  mgrNudgeQueue.push(next.key);
  mgrNudgesShown++;
  mgrNudge(next);
}
function mgrNudge(n){
  mgStatus(n.text);
  if(mgrIsOpen()){
    const row = mgrHtmlLine('<p>' + escapeHtml(n.text) + '</p><div class="mgr-acts">' + n.acts.map((a, i) => '<button type="button" class="mgr-chip' + (i === 0 ? ' on' : '') + '" data-n="' + i + '">' + escapeHtml(a.label) + '</button>').join('') +
      '<button type="button" class="mgr-chip ghost" data-n="x">Later</button></div>', 'mgr-nudge-msg live');
    row.addEventListener('click', e => {
      const b = e.target.closest('[data-n]'); if(!b) return;
      mgrSnooze(n.key); row.classList.remove('live');
      row.querySelectorAll('.mgr-acts button').forEach(x => { x.disabled = true; });
      if(b.dataset.n !== 'x') n.acts[Number(b.dataset.n)].run();
    });
  } else mgrBubble(n);
}
/* The small bubble by the Margyn button, when the panel is closed. */
function mgrBubble(n, quiet){
  const el = mgrEl('mgrBubble'); if(!el) return;
  el.innerHTML = '<div class="mgr-bub-h"><img src="images/margyn-logo-mark.png" alt="">Margyn</div><p>' + escapeHtml(n.text) + '</p><div class="mgr-acts">' +
    n.acts.map((a, i) => '<button type="button" class="mgr-chip' + (i === 0 ? ' on' : '') + '" data-n="' + i + '">' + escapeHtml(a.label) + '</button>').join('') +
    '<button type="button" class="mgr-chip ghost" data-n="x">' + (quiet ? 'Close' : 'Later') + '</button></div>';
  el.classList.remove('hidden');
  el.onclick = e => {
    const b = e.target.closest('[data-n]'); if(!b) return;
    if(!quiet) mgrSnooze(n.key);
    mgrHideBubble();
    if(b.dataset.n !== 'x'){ mgrOpen(); n.acts[Number(b.dataset.n)].run(); }
  };
}
function mgrHideBubble(){ const el = mgrEl('mgrBubble'); if(el) el.classList.add('hidden'); }

/* ---------- status line: what Margyn is doing ----------
   Lives in the top bar where the sync pill was. Real events only (a sync,
   a change you approved, a call step); otherwise it shows the sync state. */
const mgStatusLog = [];
let mgStatusTimer = null, mgStatusBase = '';
function mgStatus(text, quiet){
  text = String(text || '').trim(); if(!text) return;
  const last = mgStatusLog[0];
  if(last && last.text === text && Date.now() - last.at < 5000) return;
  mgStatusLog.unshift({ at:Date.now(), text });
  if(mgStatusLog.length > 30) mgStatusLog.length = 30;
  // The panel header says it too (the top-bar line only fits on wide screens).
  const sub = mgrEl('mgrSub');
  if(sub){
    sub.textContent = text; sub.classList.add('live'); sub.title = text;
    clearTimeout(sub.__t); sub.__t = setTimeout(() => { sub.textContent = 'Your finance operator'; sub.classList.remove('live'); sub.title = ''; }, quiet ? 6000 : 12000);
  }
  const t = mgrEl('topSyncText'), chip = mgrEl('topSync'); if(!t || !chip) return;
  if(!mgStatusBase || !chip.classList.contains('live-act')) mgStatusBase = t.textContent;
  chip.classList.add('live-act');
  t.style.opacity = 0;
  setTimeout(() => { t.textContent = text; t.style.opacity = 1; }, 180);
  clearTimeout(mgStatusTimer);
  mgStatusTimer = setTimeout(() => { chip.classList.remove('live-act'); t.style.opacity = 0; setTimeout(() => { t.textContent = mgStatusBase; t.style.opacity = 1; }, 180); }, quiet ? 6000 : 12000);
  mgRenderStatusLog();
}
function mgRenderStatusLog(){
  const pop = mgrEl('mgStatusPop'); if(!pop) return;
  pop.innerHTML = '<h6>What Margyn has been doing</h6>' + (mgStatusLog.length
    ? mgStatusLog.slice(0, 12).map(x => '<div class="mg-act-row"><span>' + escapeHtml(new Date(x.at).toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit' })) + '</span>' + escapeHtml(x.text) + '</div>').join('')
    : '<div class="mg-note">Nothing yet this session.</div>') +
    '<div class="mg-act-src">' + ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo', 'shopify'].map(k => ({ k, h:mgSourceHealth(k) })).filter(x => x.h.on)
      .map(x => '<div><b>' + escapeHtml(MG_SRC_LABEL[x.k]) + '</b> <span' + (x.h.warn ? ' class="warn"' : '') + '>' + escapeHtml(x.h.text) + '</span></div>').join('') + '</div>';
}

/* ---------- Home: Margyn's desk ----------
   The read at the top of Home, from the same figures every page uses. */
function mgrMood(){
  const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
  let f = null; try { f = mgForecast(); } catch(e){}
  const recv = (() => { try { return mgMoneyGroups('recv'); } catch(e){ return []; } })();
  const overdue = recv.reduce((t, g) => t + (g.overdue || 0), 0);
  const over60 = recv.filter(g => g.oldestDays != null && g.oldestDays <= -60).reduce((t, g) => t + (g.overdue || 0), 0);
  const nOver = recv.filter(g => g.overdue > 0).length;
  let dec = []; try { dec = mgDecisions(); } catch(e){}
  const warnSrc = ['razorpay', 'cashfree', 'zoho', 'tally', 'odoo', 'shopify'].filter(k => { const h = mgSourceHealth(k); return h.on && h.warn; });
  const runway = s && (s.vitals || []).find(v => v.label === 'Working Capital Runway');
  const rNow = runway ? parseFloat(runway.value) : null;
  const pd = (s && p && s.pulse_score != null && p.pulse_score != null) ? s.pulse_score - p.pulse_score : null;
  let cashLine;
  if(f && f.firstBelow >= 0) cashLine = 'Cash dips below your floor in week ' + (f.firstBelow + 1) + '.';
  else if(f) cashLine = 'Cash stays above your floor for the next 13 weeks.';
  else if(rNow != null && isFinite(rNow)) cashLine = rNow <= 0 ? 'Cash is below zero on the books.' : 'You have about ' + rNow.toFixed(1) + ' months of runway.';
  else cashLine = s ? '' : 'I don’t have your figures yet.';
  const collLine = overdue > 0 ? (over60 > 0 ? 'Collections are slipping: ' + fmtINR(over60, 'tile') + ' is past 60 days.' : fmtINR(overdue, 'tile') + ' is overdue across ' + nOver + ' customer' + (nOver === 1 ? '' : 's') + '.') : (s ? 'Collections are on track.' : '');
  const level = (f && f.firstBelow >= 0 && f.firstBelow < 5) || (rNow != null && rNow < 1.5) ? 'act' : (over60 > 0 || dec.length || warnSrc.length || (pd != null && pd <= -3)) ? 'watch' : 'steady';
  const bits = [];
  if(s && s.pulse_score != null) bits.push('Pulse ' + s.pulse_score + (pd ? (pd > 0 ? ', up ' : ', down ') + Math.abs(pd) : ''));
  if(dec.length) bits.push(dec.length + ' thing' + (dec.length === 1 ? '' : 's') + ' need' + (dec.length === 1 ? 's' : '') + ' you');
  if(warnSrc.length) bits.push(warnSrc.map(k => MG_SRC_LABEL[k]).join(', ') + ' need' + (warnSrc.length === 1 ? 's' : '') + ' attention');
  return { level, tag:{ act:'Needs attention', watch:'Watchful', steady:'Steady' }[level], line:[cashLine, collLine].filter(Boolean).join(' '), sub:bits.join(' · ') };
}
/* How Margyn works on its own vs asks first: the real settings, not a promise. */
function mgrHowIWork(){
  const d = (typeof agentDeployments !== 'undefined' && agentDeployments) || {};
  const chase = (d.chase_agent && d.chase_agent.status) || 'not_deployed';
  const bell = (d.whatsapp_bell && d.whatsapp_bell.status) || 'not_deployed';
  const st = s => s === 'active' ? '<b class="pos">On my own</b>' : s === 'paused' ? '<b>Paused</b>' : '<b>Off</b>';
  return '<div class="mgd-how"><div class="mgd-how-h">How I work</div>' +
    '<div><span>Payment reminders on WhatsApp</span>' + st(chase) + '</div>' +
    '<div><span>Opening and Closing Bell</span>' + st(bell) + '</div>' +
    '<div><span>Matching payments to invoices</span><b>I suggest, you approve</b></div>' +
    '<div><span>Documents you forward</span><b>I read them, you approve</b></div>' +
    '<button type="button" class="mg-link" data-go-page="agents">Change in Automations →</button></div>';
}
function mgrWorkingOn(){
  const rows = [];
  let ct = []; try { ct = (chaseTargets || []).filter(t => ['active', 'paused_promise', 'disputed', 'escalated_human'].includes(t.state)); } catch(e){}
  const d = (typeof agentDeployments !== 'undefined' && agentDeployments) || {};
  if(ct.length){
    const next = ct.map(t => t.next_chase_at).filter(Boolean).sort()[0];
    rows.push({ dot:'doing', t:'Chasing ' + ct.length + ' customer' + (ct.length === 1 ? '' : 's'), s:fmtINR(ct.reduce((a, t) => a + (Number(t.amount) || 0), 0), 'tile') + ' outstanding' + (next ? ' · next reminder ' + fmtDay(next) : ''), st:d.chase_agent && d.chase_agent.status === 'paused' ? 'PAUSED' : 'ON IT', ask:'Who am I chasing and how is it going?' });
  }
  let props = 0; try { props = ((agentActions && agentActions.actions) || []).length; } catch(e){}
  let review = 0; try { review = ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).length; } catch(e){}
  if(props || review) rows.push({ dot:'wait', t:'Reconciliation', s:(props ? props + ' match' + (props === 1 ? '' : 'es') + ' proposed' : '') + (props && review ? ' · ' : '') + (review ? review + ' payment' + (review === 1 ? '' : 's') + ' to check' : ''), st:'NEEDS YOU', ask:'Walk me through the reconciliation items waiting on me.' });
  else if(reconSummary && reconSummary.connected) rows.push({ dot:'', t:'Reconciliation', s:'Everything I could match is matched', st:'DONE' });
  let docs = 0; try { docs = (pendingSuggestions || []).length; } catch(e){}
  if(docs) rows.push({ dot:'wait', t:'Reading ' + docs + ' forwarded document' + (docs === 1 ? '' : 's'), s:'Read and mapped; waiting for your OK', st:'NEEDS YOU', ask:'What documents are waiting for my approval?' });
  ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'].forEach(k => {
    const h = mgSourceHealth(k); if(!h.on) return;
    rows.push({ dot:h.warn ? 'warn' : '', t:'Keeping ' + MG_SRC_LABEL[k] + ' in sync', s:h.text, st:h.warn ? 'NEEDS YOU' : 'OK', ask:h.warn ? 'Is my ' + MG_SRC_LABEL[k] + ' connector working?' : null });
  });
  if(d.whatsapp_bell && d.whatsapp_bell.status === 'active') rows.push({ dot:'', t:'Opening and Closing Bell', s:'Your morning and evening briefing on WhatsApp', st:'SCHEDULED' });
  if(!rows.length) rows.push({ dot:'', t:'Nothing running yet', s:'Connect a source or switch on payment reminders and I’ll get to work.', st:'' });
  return rows.map(r => '<div class="mgd-task' + (r.ask ? ' click' : '') + '"' + (r.ask ? ' data-mgr-ask="' + escapeHtml(r.ask) + '"' : '') + '><span class="mgd-dot ' + r.dot + '"></span><div><b>' + escapeHtml(r.t) + '</b><span>' + escapeHtml(r.s) + '</span></div><span class="mgd-st">' + escapeHtml(r.st) + '</span></div>').join('');
}
/* The top of Home: Margyn's read, how it works, what needs you, what it's on. */
function mgrDeskTop(){
  const m = mgrMood();
  let dec = []; try { dec = mgDecisions(); } catch(e){}
  const away = mgrAway && mgrAway.did.length ? '<div class="mgd-away"><b>While you were away:</b> ' + escapeHtml(mgrAway.did.join(', ')) + '.</div>' : '';
  const need = dec.length
    ? dec.slice(0, 4).map(x => '<div class="mgd-need"><div><div class="mgd-need-t">' + escapeHtml(x.t) + '</div><div class="mgd-need-s">' + escapeHtml(x.s) + '</div></div><div class="mgd-need-a">' + (x.amt ? escapeHtml(fmtINR(x.amt, 'tile')) : '') + '</div></div>').join('') +
      '<div class="mgd-need-f"><button type="button" class="mg-btn primary mg-btn-sm" data-go-page="inbox">Review in Inbox</button><button type="button" class="mg-btn mg-btn-sm" data-mgr-ask="What needs my OK?">Go through them with Margyn</button></div>'
    : '<div class="mg-empty">Nothing is waiting on you. I’ll tell you when something is.</div>';
  return '<section class="mgd-hero mgd-' + m.level + '">' +
      '<div class="mgd-mark"><img src="images/margyn-logo-mark.png" alt=""></div>' +
      '<div class="mgd-read"><span class="mgd-tag">' + escapeHtml(m.tag) + '</span>' +
        '<h2>' + escapeHtml(m.line || 'Let’s get your figures in.') + '</h2>' +
        (m.sub ? '<div class="mgd-sub">' + escapeHtml(m.sub) + '</div>' : '') + away +
        '<form class="mgd-ask" data-mgd-ask><input type="text" placeholder="Ask or give me a task, e.g. “chase everyone past 90 days”" aria-label="Ask Margyn"><button type="submit" class="mg-btn primary mg-btn-sm">Ask</button><button type="button" class="mg-btn mg-btn-sm" data-mgr-talk>Talk</button></form>' +
      '</div>' + mgrHowIWork() +
    '</section>' +
    '<div class="mg-row2 mgd-row">' +
      '<div class="mg-panel"><div class="mg-panel-h"><h2>Needs you</h2><span class="mg-aside">' + (dec.length ? dec.length + ' waiting' : 'All clear') + '</span></div>' + need + '</div>' +
      '<div class="mg-panel"><div class="mg-panel-h"><h2>What I’m working on</h2><span class="mg-aside">live</span></div>' + mgrWorkingOn() + '</div>' +
    '</div>';
}

/* ---------- wiring ---------- */
(function wireMargyn(){
  const on = (id, ev, fn) => { const el = mgrEl(id); if(el) el.addEventListener(ev, fn); };
  on('mgrClose', 'click', () => mgrClose());
  on('mgrNew', 'click', () => mgrNewThread());
  on('mgrHistoryBtn', 'click', () => showView('history'));
  on('mgrLaunch', 'click', () => mgrOpen(true));
  on('mgrTalk', 'click', () => {
    if(typeof vxActive !== 'undefined' && vxActive) closeRealtimeOverlay();
    else { mgrOpen(); openRealtimeOverlay(); }
  });
  const form = mgrEl('mgrForm'), input = mgrEl('mgrInput');
  if(form && input){
    form.addEventListener('submit', e => { e.preventDefault(); const v = input.value; input.value = ''; input.style.height = ''; mgrAsk(v); });
    input.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true })); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
  }
  on('mgrSugg', 'click', e => { const b = e.target.closest('button'); if(b) mgrAsk(b.textContent); });
  // Anything, anywhere, that hands a question to Margyn, and the greeting's buttons.
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-mgr-ask]'); if(a){ e.preventDefault(); mgrAsk(a.dataset.mgrAsk); return; }
    if(e.target.closest('[data-mgr-talk]')){ mgrOpen(); if(!(typeof vxActive !== 'undefined' && vxActive)) openRealtimeOverlay(); return; }
    if(e.target.closest('[data-mgr-wn]')){ if(typeof mgWhatsNew === 'function') mgWhatsNew(true); return; }
  });
  document.addEventListener('submit', e => {
    const nf = e.target.closest('[data-mgr-name]');
    if(nf){ e.preventDefault(); const v = nf.querySelector('input').value; if(!v.trim()) return; mgrSaveName(v); nf.outerHTML = '<p>Nice to meet you, ' + escapeHtml(mgrName) + '.</p>'; if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'home') mgRenderOwn('home'); return; }
    const df = e.target.closest('[data-mgd-ask]');
    if(df){ e.preventDefault(); const i = df.querySelector('input'); const v = i.value; i.value = ''; mgrAsk(v); }
  });
  // The top bar's Ask button now opens the panel; the sync pill opens the activity log.
  const ask = mgrEl('mgAskBtn');
  if(ask){ ask.removeAttribute('data-go'); ask.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); mgrToggle(); }, true); }
  const chip = mgrEl('topSync'), pop = mgrEl('mgStatusPop');
  if(chip && pop){
    chip.setAttribute('role', 'button'); chip.tabIndex = 0; chip.title = 'What Margyn has been doing';
    const toggle = e => { e.stopPropagation(); mgRenderStatusLog(); pop.classList.toggle('open'); };
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(e); } });
    document.addEventListener('click', e => { if(!e.target.closest('#mgStatusPop')) pop.classList.remove('open'); });
  }
  // The panel header's status line: tap it for the day's activity, in the conversation.
  on('mgrSub', 'click', () => {
    const rows = mgStatusLog.slice(0, 10);
    mgrHtmlLine(rows.length
      ? '<p><b>What I’ve been doing</b></p>' + rows.map(x => '<div class="mg-act-row"><span>' + escapeHtml(new Date(x.at).toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit' })) + '</span>' + escapeHtml(x.text) + '</div>').join('')
      : 'Nothing to report yet this session. I’ll note syncs, changes you approve and anything I spot here.', 'quiet');
  });
  // ⌘J / Ctrl+J: open the panel and type.
  document.addEventListener('keydown', e => {
    if(e.code === 'KeyJ' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey){ e.preventDefault(); if(mgrIsOpen() && document.activeElement === mgrEl('mgrInput')) mgrClose(); else mgrOpen(true); }
  });
  // Last seen: when they leave, so "while you were away" starts from there.
  document.addEventListener('visibilitychange', () => { if(document.hidden) mgrMarkSeen(); });
  window.addEventListener('pagehide', mgrMarkSeen);
  setInterval(() => { if(!document.hidden) mgrMarkSeen(); }, 5 * 60000);
  setInterval(mgrCheckNudges, 4 * 60000);
})();

/* After the first load for a signed-in user: open the panel (on a wide
   screen, unless they closed it), say hello, and start watching. A later
   refresh re-checks nudges. A different login starts over. */
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    try {
      if(typeof currentUser !== 'undefined' && currentUser){
        if(mgrUserId !== currentUser.id){
          mgrUserId = currentUser.id; mgrGreeted = false; mgrThread = null; mgrHistory.length = 0; mgrName = null; mgrAway = null; mgrNudgesShown = 0; mgrNudgeQueue = [];
          const f = mgrFeed(); if(f) f.innerHTML = '';
          if(mgrWide() && lsGet(MGR_OPEN_KEY, 'open') !== 'closed') mgrOpen(); else mgrClose(true);
          const l = mgrEl('mgrLaunch'); if(l) l.classList.remove('hidden');
          setTimeout(mgrGreet, 400);
        } else if(mgrGreeted) setTimeout(mgrCheckNudges, 3000);
      }
    } catch(e){ console.error('[margyn] panel boot', e); }
    return out;
  };
})();
