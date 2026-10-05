/* ============================================================
   LIVE TEAM: seeing each other, threads, owners and handoffs.

   - Who is online: faces next to the bell (who, and which page they're on).
   - A customer's or supplier's drawer (19b-drawer.js) gets a Timeline across
     apps (what each app said, what Margyn did, what people did) and a
     Comments thread. The drawer says who else has it open, and the thread
     says "Priya is typing…".
   - Inbox: once you have a team, every item gets an owner.
   - Handoffs: a new item lands in your Inbox, a teammate hands you an item
     or comments on a customer: a card says who handed what, with Open.

   Comments and owners live in record_notes (2026-10-06-team-and-app-writes.sql):
   append-only, the whole team reads them, each writes only under their own
   name. Presence is a private Supabase Realtime channel only the account's
   people may join (same SQL). Until that SQL has run, comments say they're
   off, owners and faces don't show; everything else works as before.
   ============================================================ */

let ltOwnName = null;   // the owner's name as the team list has it, so owners match what teammates assign to
function ltMyName(){ try { return (typeof mgActorName === 'function' && mgActorName()) || ltOwnName || (typeof mgrName !== 'undefined' && mgrName) || (currentUser && String(currentUser.email || '').split('@')[0]) || 'You'; } catch(e){ return 'You'; } }
function ltInitials(n){ return String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?'; }
function ltFirst(n){ return String(n || 'Someone').split(/\s+/)[0]; }
function ltNames(ps){ const n = ps.map(p => ltFirst(p.name)); return n.length < 3 ? n.join(' and ') : n.slice(0, 2).join(', ') + ' and ' + (n.length - 2) + ' more'; }
function ltWhere(){ try { return (MG_PAGES[mgCurrentView] || {}).label || 'Home'; } catch(e){ return 'Home'; } }

/* ---------- comments and owners (record_notes) ---------- */
let ltNotes = [], ltNotesOff = false, ltNotesBusy = false, ltNotesAt = 0;
const LT_MISSING = /record_notes|42P01|PGRST205|does not exist|schema cache/i;
async function ltLoadNotes(force){
  if(!currentUser || !sbClient || ltNotesBusy) return;
  if(!force && Date.now() - ltNotesAt < 45000) return;
  ltNotesBusy = true; ltNotesAt = Date.now();
  try {
    const { data, error } = await sbClient.from('record_notes').select('id,record_type,record_key,kind,body,assignee,author_id,author_name,created_at')
      .eq('user_id', lwOwner()).order('created_at', { ascending:false }).limit(800);
    if(error){ if(LT_MISSING.test((error.code || '') + ' ' + (error.message || ''))) ltNotesOff = true; }
    else { ltNotesOff = false; ltNotes = data || []; }
  } catch(e){ /* offline: keep what we have */ }
  ltNotesBusy = false;
  ltNotesChanged();
}
function ltNotesChanged(){
  document.querySelectorAll('[data-lt-thread]').forEach(el => { el.innerHTML = ltThreadInner(el.dataset.ltThread); });
  ltDecorateInbox(); ltPaintPresence(); ltCheckNoteHandoffs();
}
async function ltAddNote(n){
  if(ltNotesOff) return { ok:false, note:'Comments are off until the one-time setup step has run.' };
  const row = Object.assign({ user_id:lwOwner(), author_id:currentUser.id, author_name:ltMyName() }, n);
  try {
    const { data, error } = await sbClient.from('record_notes').insert(row).select().single();
    if(error) throw error;
    ltNotes.unshift(data || Object.assign({ id:'local-' + Date.now(), created_at:new Date().toISOString() }, row));
    ltAnnounce();
    ltNotesChanged();
    return { ok:true };
  } catch(e){
    if(LT_MISSING.test(String(e && (e.code || '') + ' ' + (e.message || '')))){ ltNotesOff = true; ltNotesChanged(); }
    return { ok:false, note:(e && e.message) || 'Couldn’t save' };
  }
}

/* ---------- a thread on a customer or supplier ---------- */
function ltThreadInner(ref){
  const [type, key, label] = ref.split('|');
  if(ltNotesOff) return '<div class="mg-empty">Comments switch on after a one-time setup step. Until then, use Ask Margyn below.</div>';
  const notes = ltNotes.filter(n => n.record_type === type && n.record_key === key && n.kind === 'comment').slice().reverse();
  const me = currentUser && currentUser.id;
  return '<div class="lt-thread">' + (notes.length ? notes.map(n =>
      '<div class="lt-msg' + (n.author_id === me ? ' me' : '') + '"><span class="lt-av">' + escapeHtml(ltInitials(n.author_name)) + '</span><div><div class="lt-msg-h"><b>' + escapeHtml(n.author_name || 'Someone') + '</b><span>' + escapeHtml(lwSince(n.created_at)) + '</span></div><p>' + escapeHtml(n.body || '') + '</p></div></div>').join('')
    : '<div class="mg-empty">No comments yet. Leave a note for your team about ' + escapeHtml(label || 'this') + ', or write @Margyn to ask Margyn.</div>') + '</div>' +
    '<div class="lt-typing" hidden></div>' +
    '<form class="lt-thread-f" data-lt-thread-form="' + escapeHtml(ref) + '"><textarea rows="2" placeholder="Write a comment, or @Margyn to ask…" aria-label="Comment"></textarea><button class="mg-btn primary" type="submit">Post</button></form>';
}
function ltThreadHtml(type, key, label){ const ref = type + '|' + key + '|' + (label || ''); return '<div data-lt-thread="' + escapeHtml(ref) + '">' + ltThreadInner(ref) + '</div>'; }
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-lt-thread-form]'); if(!f) return;
  e.preventDefault();
  const ta = f.querySelector('textarea'), text = (ta.value || '').trim(); if(!text) return;
  const [type, key, label] = f.dataset.ltThreadForm.split('|');
  const btn = f.querySelector('button'); btn.disabled = true;
  const r = await ltAddNote({ record_type:type, record_key:key, kind:'comment', body:text });
  btn.disabled = false;
  if(!r.ok){ toast(r.note || 'Couldn’t post that', { kind:'bad' }); return; }
  ltTypingRef = null; ltTrack();
  lwAdd({ job:'team', text:ltMyName() + ' commented on ' + (label || 'a record'), state:'done', at:new Date().toISOString(), end:new Date().toISOString() });
  if(/@margyn\b/i.test(text) && typeof mgrAsk === 'function') mgrAsk((label ? 'About ' + label + ': ' : '') + text.replace(/@margyn\b/ig, '').trim());
});

/* ---------- a customer's or supplier's timeline, across apps ---------- */
function ltPartyTimeline(g, dir){
  const ev = [], key = g.key, name = g.party;
  const same = n => { try { return normPartyName(n) === key; } catch(e){ return false; } };
  const add = (at, mark, who, text, tone) => { if(at) ev.push({ at, mark, who, text, tone }); };
  // what each app says is open
  g.sources.forEach(s => (g.by[s].rows || []).forEach(r => { if(r.due) add(r.due, s, MG_SRC_NAME[s] || s, (dir === 'recv' ? 'Invoice ' : 'Bill ') + (r.ref || '') + ' for ' + fmtINR(r.amount, 'tile') + (r.days != null && r.days < 0 ? ' was due' : ' is due'), r.days != null && r.days < 0 ? 'neg' : ''); }));
  // people and Margyn changing the ledger
  ((typeof ledgerEvents !== 'undefined' && ledgerEvents) || []).filter(e => same(e.party_name)).forEach(e =>
    add(e.created_at, e.channel === 'agent' ? 'margyn' : 'person', e.actor_name || (e.channel === 'agent' ? 'Margyn' : 'Someone'),
      ({ settled:'Settled', deleted:'Removed', created:'Added', imported:'Imported', updated:'Changed' }[e.event] || e.event || '') + ' ' + (e.entity_type || '') + (e.amount != null ? ' · ' + fmtINR(e.amount, 'tile') : '') + (e.channel && e.channel !== 'app' && e.channel !== 'agent' ? ' (' + e.channel + ')' : ''), ''));
  // reminders and replies
  ((typeof chaseTargets !== 'undefined' && chaseTargets) || []).filter(t => same(t.party_name)).forEach(t => {
    if(t.last_chase_at) add(t.last_chase_at, 'margyn', 'Margyn', 'sent payment reminder ' + (t.chases_sent || 1) + ' on WhatsApp' + (t.invoice_ref ? ' for ' + t.invoice_ref : ''), '');
    if(t.last_reply_at) add(t.last_reply_at, 'wa', name, 'replied on WhatsApp' + (t.last_reply_intent ? ': ' + String(t.last_reply_intent).replace(/_/g, ' ') : ''), '');
    if(t.promise_to_pay_date) add(t.last_reply_at || t.updated_at, 'wa', name, 'promised to pay by ' + fmtDay(t.promise_to_pay_date), 'warn');
    if(t.state === 'resolved_paid' && t.resolved_at) add(t.resolved_at, 'margyn', 'Margyn', 'marked it paid after the reminder', 'pos');
  });
  // payment matching (Zoho invoices against Razorpay)
  try { ((reconSummary && reconSummary.connected && reconSummary.invoices) || []).filter(i => same(i.customer_name)).forEach(i => {
    if(i.reconciliation_status && i.reconciliation_status !== 'unmatched') add(i.updated_at || (reconSummary.provenance && reconSummary.provenance.last_verified_at), 'razorpay', 'Margyn',
      'matched invoice ' + (i.invoice_number || '') + ': ' + String(i.reconciliation_status).replace(/_/g, ' ') + (i.verified_paid_amount ? ' · ' + fmtINR(i.verified_paid_amount, 'tile') + ' verified' : ''), i.reconciliation_status === 'verified' ? 'pos' : '');
  }); } catch(e){}
  // proposals and forwarded documents
  try { ((agentActions && agentActions.actions) || []).filter(a => a.title && a.title.toLowerCase().includes(name.toLowerCase())).forEach(a => add(a.created_at, 'margyn', 'Margyn', 'proposed: ' + a.title, 'ai')); } catch(e){}
  try { ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).forEach(p => { const ents = (p.proposal && p.proposal.entries) || []; if(ents.some(x => same(x.party))) add(p.received_at, 'wa', 'WhatsApp', 'a document from ' + name + ' came in, waiting for your OK', 'ai'); }); } catch(e){}
  // comments
  ltNotes.filter(n => n.record_type === 'party' && n.record_key === key && n.kind === 'comment').forEach(n => add(n.created_at, 'person', n.author_name || 'Someone', 'commented: “' + String(n.body || '').slice(0, 80) + (String(n.body || '').length > 80 ? '…' : '') + '”', ''));
  ev.sort((a, b) => new Date(b.at) - new Date(a.at));
  if(!ev.length) return '<div class="mg-empty">Nothing has happened with ' + escapeHtml(name) + ' yet that Margyn can see.</div>';
  const MARK = { margyn:['M', '#14181F'], wa:['W', '#0E8F5C'] };
  return '<p class="mg-fine" style="margin:0 0 12px">Everything about ' + escapeHtml(name) + ' from your apps, Margyn and your team, newest first.</p><ol class="lt-tl">' + ev.slice(0, 40).map(x => {
    const l = x.mark === 'person' ? [ltInitials(x.who), '#0B4B8C'] : (MG_SRC_LOGO[x.mark] || MARK[x.mark] || ['•', '#8B93A0']);
    return '<li class="' + (x.tone || '') + '"><span class="lt-tl-m" style="background:' + l[1] + '">' + escapeHtml(l[0]) + '</span><div><b>' + escapeHtml(x.who) + '</b> ' + escapeHtml(x.text) + '</div><small>' + escapeHtml(fmtDay(x.at)) + '</small></li>';
  }).join('') + '</ol>';
}

/* ---------- presence: who is online, where, on what, typing ---------- */
let ltPresence = null, ltState = {}, ltTypingRef = null, ltTypingAt = 0, ltTypingTimer = null, ltTrackAt = 0, ltTrackQueued = null;
function ltPresenceList(){
  const me = currentUser && currentUser.id, out = [];
  Object.values(ltState || {}).forEach(arr => (arr || []).forEach(p => { if(p && p.id && !out.some(x => x.id === p.id)) out.push(Object.assign({}, p, { me:p.id === me })); }));
  return out;
}
function ltOthers(){ return ltPresenceList().filter(p => !p.me); }
function ltRecNow(){
  const t = document.querySelector('.mg-drawer [data-lt-thread]'); if(!t) return null;
  const [type, key, label] = t.dataset.ltThread.split('|');
  return { ref:type + '|' + key, label:label || '' };
}
function ltStartPresence(){
  try {
    if(ltPresence || !sbClient || !sbClient.channel || !currentUser) return;
    const acct = lwOwner(); if(!acct) return;
    // Private: only the account's owner and members may join (2026-10-06-team-and-app-writes.sql).
    ltPresence = sbClient.channel('team-' + acct, { config:{ private:true, presence:{ key:currentUser.id } } });
    ltPresence.on('presence', { event:'sync' }, () => { ltState = ltPresence.presenceState(); ltPaintPresence(); })
      .on('broadcast', { event:'note' }, m => { const p = (m && m.payload) || {}; if(!(p.by && currentUser && p.by === currentUser.id)) ltLoadNotes(true); })
      .subscribe(st => {
        if(st === 'SUBSCRIBED') ltTrack();
        // Not allowed (the SQL hasn't run) or unreachable: stay quiet, don't keep retrying.
        else if(st === 'CHANNEL_ERROR'){ try { ltPresence.unsubscribe(); } catch(e){} }
      });
  } catch(e){ console.warn('[team] presence', e); }
}
function ltTrack(){
  try {
    if(!ltPresence || !currentUser) return;
    const r = ltRecNow();
    ltPresence.track({ id:currentUser.id, name:ltMyName(), where:r && r.label ? r.label : ltWhere(), rec:r ? r.ref : null,
      typing:ltTypingRef && Date.now() - ltTypingAt < 5000 ? ltTypingRef : null, at:new Date().toISOString() });
    ltTrackAt = Date.now();
  } catch(e){}
}
function ltTrackSoon(){   // at most one update every 1.5 s while typing; the last one always goes
  if(ltTrackQueued) return;
  ltTrackQueued = setTimeout(() => { ltTrackQueued = null; ltTrack(); }, Math.max(0, 1500 - (Date.now() - ltTrackAt)));
}
function ltAnnounce(){ try { if(ltPresence) ltPresence.send({ type:'broadcast', event:'note', payload:{ by:currentUser && currentUser.id } }); } catch(e){} }
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('[data-lt-thread-form]'); if(!f) return;
  const [type, key] = f.dataset.ltThreadForm.split('|');
  ltTypingRef = type + '|' + key; ltTypingAt = Date.now(); ltTrackSoon();
  clearTimeout(ltTypingTimer); ltTypingTimer = setTimeout(() => { ltTypingRef = null; ltTrack(); }, 4000);
});
function ltPaintPresence(){
  const others = ltOthers();
  // the top bar: faces of whoever else is in the app
  let faces = document.getElementById('ltFaces');
  if(!faces){ const bell = document.querySelector('nav.mg-top .mg-bell'); if(bell){ faces = document.createElement('button'); faces.type = 'button'; faces.id = 'ltFaces'; faces.className = 'lt-faces'; faces.addEventListener('click', () => showView('people')); bell.parentNode.insertBefore(faces, bell); } }
  if(faces){
    faces.hidden = !others.length;
    faces.title = others.map(p => p.name + ' · ' + (p.where || '')).join('\n');
    faces.innerHTML = others.slice(0, 3).map(p => '<span class="lt-av on">' + escapeHtml(ltInitials(p.name)) + '</span>').join('') + (others.length > 3 ? '<span class="lt-av more">+' + (others.length - 3) + '</span>' : '');
  }
  // the open drawer: who else is here, and who is typing in its thread
  const r = ltRecNow(), head = document.querySelector('.mg-drawer .mg-drawer-h');
  if(head){
    const on = r ? others.filter(p => p.rec === r.ref) : [];
    let here = head.querySelector('.lt-here');
    if(!here){ here = document.createElement('div'); here.className = 'lt-here'; head.insertBefore(here, head.querySelector('[data-drawer-close]')); }
    here.innerHTML = on.length ? on.slice(0, 3).map(p => '<span class="lt-av on">' + escapeHtml(ltInitials(p.name)) + '</span>').join('') + '<span>' + escapeHtml(ltNames(on)) + ' ' + (on.length === 1 ? 'is' : 'are') + ' here too</span>' : '';
    here.hidden = !on.length;
  }
  document.querySelectorAll('[data-lt-thread]').forEach(el => {
    const [type, key] = el.dataset.ltThread.split('|');
    const typing = others.filter(p => p.typing === type + '|' + key && Date.now() - new Date(p.at || 0) < 8000);
    const line = el.querySelector('.lt-typing'); if(!line) return;
    line.innerHTML = typing.length ? '<span class="lt-dots"><i></i><i></i><i></i></span>' + escapeHtml(ltNames(typing)) + (typing.length === 1 ? ' is' : ' are') + ' typing…' : '';
    line.hidden = !typing.length;
  });
}
if(typeof mgDrawer === 'function'){
  const baseDrawer = mgDrawer;
  mgDrawer = function(){ const out = baseDrawer.apply(this, arguments); setTimeout(() => { ltTrack(); ltPaintPresence(); }, 0); return out; };
}
if(typeof mgCloseDrawer === 'function'){
  const baseClose = mgCloseDrawer;
  mgCloseDrawer = function(){ const had = !!mgDrawerEl; const out = baseClose.apply(this, arguments); if(had){ ltTypingRef = null; setTimeout(ltTrack, 0); } return out; };
}
(function(){ const base = showView; showView = function(){ const out = base.apply(this, arguments); try { ltTrack(); } catch(e){} return out; }; })();

/* ---------- Inbox: an owner for every item, once you have a team ---------- */
let ltTeamNames = null;
async function ltLoadTeamNames(){
  if(ltTeamNames || !currentUser) return;
  ltTeamNames = [];
  try {
    const d = (typeof mgTeamData !== 'undefined' && mgTeamData) || (typeof mgTeamApi === 'function' ? await mgTeamApi('team-list') : null);
    if(d){ const own = d.owner && (d.owner.name || d.owner.email); if(own) ltTeamNames.push(own); if(d.you && d.you.is_owner && own) ltOwnName = own;
      (d.members || []).filter(m => m.status === 'active').forEach(m => { const n = m.name || m.email; if(n && !ltTeamNames.includes(n)) ltTeamNames.push(n); }); }
  } catch(e){}
  ltDecorateInbox();
}
function ltOwnerOf(key){ const n = ltNotes.find(x => x.record_type === 'work' && x.record_key === key && x.kind === 'assign'); return n ? n.assignee : null; }
/* Inbox items by key: rq:<review id>, act:<proposal id>, doc:<forwarded document id>. */
function ltInboxItems(){
  const out = [];
  try { ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).forEach(q => out.push({ key:'rq:' + q.id, t:(q.customer_name || 'A payment') + ': ' + (q.reason || 'needs review'), amt:Number(q.amount) || 0, job:'payments' })); } catch(e){}
  try { ((agentActions && agentActions.actions) || []).forEach(a => out.push({ key:'act:' + a.id, t:a.title, amt:Number(a.amount) || 0, job:a.kind === 'itc_risk' ? 'gst' : 'close' })); } catch(e){}
  try { ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).forEach(p => { const ents = (p.proposal && p.proposal.entries) || [];
    out.push({ key:'doc:' + p.id, t:'A forwarded document' + (ents[0] && ents[0].party ? ' from ' + ents[0].party : ''), amt:ents.reduce((t, x) => t + (Number(x.amount) || 0), 0), job:'documents' }); }); } catch(e){}
  return out;
}
function ltInboxRows(){
  const rows = [];
  document.querySelectorAll('#reconReviewList [data-work-key], #agentQueueList [data-agent-id]').forEach(r => rows.push([r, r.dataset.workKey || 'act:' + r.dataset.agentId, r.querySelector('.lr-main') || r]));
  const sugs = (typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || [];
  document.querySelectorAll('#suggestionsList > .card').forEach((c, i) => { if(sugs[i]) rows.push([c, 'doc:' + sugs[i].id, c.querySelector('.btn-row') || c]); });
  return rows;
}
function ltDecorateInbox(){
  if(ltNotesOff) { document.querySelectorAll('.lt-owner').forEach(x => x.remove()); return; }
  if(!ltTeamNames){ ltLoadTeamNames(); return; }
  if(ltTeamNames.length < 2) return;   // just you: nobody to hand anything to
  const fresh = ltFreshUntil, now = Date.now();
  ltInboxRows().forEach(([row, key, slot]) => {
    const who = ltOwnerOf(key);
    let el = row.querySelector('.lt-owner');
    if(!el){ el = document.createElement('div'); el.className = 'lt-owner'; slot.appendChild(el); }
    el.innerHTML = '<span>Owner</span><select data-lt-assign="' + escapeHtml(key) + '" aria-label="Owner"><option value="">' + escapeHtml(who || 'Nobody yet') + '</option>' +
      ltTeamNames.filter(n => n !== who).map(n => '<option>' + escapeHtml(n) + '</option>').join('') + '</select>';
    row.classList.toggle('lt-fresh', (fresh.get(key) || 0) > now);
  });
}
document.addEventListener('change', async e => {
  const s = e.target.closest('[data-lt-assign]'); if(!s || !s.value) return;
  const who = s.value, key = s.dataset.ltAssign, item = ltInboxItems().find(x => x.key === key);
  s.disabled = true;
  const r = await ltAddNote({ record_type:'work', record_key:key, kind:'assign', assignee:who, body:item ? item.t : null });
  s.disabled = false;
  if(!r.ok){ toast(r.note || 'Couldn’t assign that', { kind:'bad' }); return; }
  toast(who === ltMyName() ? 'It’s yours.' : 'Handed to ' + ltFirst(who) + '.', { sub:item ? item.t : '' });
  lwAdd({ job:'team', text:ltMyName() + ' handed “' + (item ? item.t : key).slice(0, 60) + '” to ' + who, state:'done', at:new Date().toISOString(), end:new Date().toISOString() });
});
['renderReconLedger', 'renderAgentQueue', 'renderSuggestionsView'].forEach(fn => {
  if(typeof window[fn] !== 'function') return;
  const base = window[fn];
  window[fn] = function(){ const out = base.apply(this, arguments); try { ltCheckInboxHandoffs(); ltDecorateInbox(); } catch(e){} return out; };
});

/* ---------- handoffs ---------- */
let ltSeenWork = null, ltSeenNotes = null, ltArmAt = 0;
const ltFreshUntil = new Map();   // inbox key -> highlight until (ms)
function ltHandoff(o){
  const host = document.getElementById('toastHost'); if(!host) return;
  const cards = host.querySelectorAll('.lt-hand'); if(cards.length >= 3) cards[0].remove();
  const el = document.createElement('div');
  el.className = 'toast lt-hand'; el.setAttribute('role', 'status');
  el.innerHTML = (o.person ? '<span class="lt-av on">' + escapeHtml(ltInitials(o.who)) + '</span>' : '<img src="images/margyn-logo-mark.png" alt="" class="lt-hand-mark">') +
    '<div class="lt-hand-m"><div class="t-body">' + escapeHtml(o.head) + '</div><div class="t-sub">' + escapeHtml(o.title) + '</div></div>' +
    (o.open ? '<button type="button" class="mg-btn mg-btn-sm primary" data-lt-open>Open</button>' : '') +
    '<button type="button" class="lt-hand-x" aria-label="Dismiss">×</button>';
  host.appendChild(el);
  const out = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', e => {
    if(e.target.closest('[data-lt-open]')){ try { o.open(); } catch(err){} out(); }
    else if(e.target.closest('.lt-hand-x')) out();
  });
  setTimeout(out, o.ms || 9000);
}
function ltCheckInboxHandoffs(){
  if(!currentUser) return;
  const items = ltInboxItems(), keys = new Set(items.map(x => x.key));
  // While the first loads land, everything counts as already there.
  if(ltSeenWork === null || !ltArmAt || Date.now() < ltArmAt){ ltSeenWork = keys; return; }
  const fresh = items.filter(x => !ltSeenWork.has(x.key));
  ltSeenWork = keys;
  fresh.slice(0, 3).forEach(x => {
    ltFreshUntil.set(x.key, Date.now() + 8000);
    ltHandoff({ head:'Margyn handed you a decision', title:x.t + (x.amt ? ' · ' + fmtINR(x.amt, 'tile') : ''), open:() => showView('inbox') });
    lwAdd({ job:x.job, text:'Handed to you: ' + x.t, state:'done', at:new Date().toISOString(), end:new Date().toISOString() });
  });
  if(fresh.length > 3) ltHandoff({ head:'And ' + (fresh.length - 3) + ' more in your Inbox', title:'All waiting on your OK', open:() => showView('inbox') });
}
function ltPartyByKey(key){
  for(const dir of ['recv', 'pay']){ try { const g = mgMoneyGroups(dir).find(x => x.key === key); if(g) return { g, dir }; } catch(e){} }
  return null;
}
function ltCheckNoteHandoffs(){
  if(!currentUser) return;
  const ids = new Set(ltNotes.map(n => n.id));
  if(ltSeenNotes === null || !ltArmAt || Date.now() < ltArmAt){ ltSeenNotes = ids; return; }
  const fresh = ltNotes.filter(n => !ltSeenNotes.has(n.id) && n.author_id !== currentUser.id);
  ltSeenNotes = ids;
  const open = ltRecNow(), me = ltMyName();
  fresh.slice(0, 3).forEach(n => {
    const who = n.author_name || 'Someone';
    if(n.kind === 'assign' && n.assignee === me){
      ltFreshUntil.set(n.record_key, Date.now() + 8000);
      ltHandoff({ person:true, who, head:ltFirst(who) + ' handed you something', title:n.body || 'An item in your Inbox', open:() => showView('inbox') });
    } else if(n.kind === 'comment' && !(open && open.ref === n.record_type + '|' + n.record_key)){
      const p = n.record_type === 'party' ? ltPartyByKey(n.record_key) : null;
      ltHandoff({ person:true, who, head:ltFirst(who) + ' commented on ' + (p ? p.g.party : 'a record'), title:'“' + String(n.body || '').slice(0, 90) + '”', ms:8000,
        open:p ? () => { mgOpenParty(p.dir, p.g.key); setTimeout(() => { const t = document.querySelector('.mg-drawer [data-dtab="comments"]'); if(t) t.click(); }, 50); } : null });
    }
  });
}

/* ---------- boot ---------- */
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    if(!ltArmAt) ltArmAt = Date.now() + 8000;   // the first loads settle before anything counts as new
    try { ltStartPresence(); ltTrack(); ltLoadNotes(); ltCheckInboxHandoffs(); ltDecorateInbox(); } catch(e){ console.error('[team] after refresh', e); }
    return out;
  };
})();
setInterval(() => { if(!document.hidden && currentUser) ltLoadNotes(); }, 60000);
setInterval(() => { if(!document.hidden) ltPaintPresence(); }, 4000);
