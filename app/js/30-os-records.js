/* ============================================================
   MARGYN OS RECORDS: every customer and supplier page gets a timeline
   across apps (what each app said, what Margyn did, what people did) and a
   thread; any piece of work can be assigned to a person.

   Threads and assignments live in record_notes (2026-10-05-margyn-os.sql):
   append-only, readable by the whole team, written only under your own name.
   Until that SQL has run the page works as before and says comments are off.
   ============================================================ */

let osNotes = [], osNotesOff = false, osNotesBusy = false, osNotesAt = 0;
async function osLoadNotes(force){
  if(!currentUser || !sbClient || osNotesBusy) return;
  if(!force && Date.now() - osNotesAt < 45000) return;
  osNotesBusy = true; osNotesAt = Date.now();
  try {
    const { data, error } = await sbClient.from('record_notes').select('id,record_type,record_key,kind,body,assignee,author_id,author_name,created_at')
      .eq('user_id', osOwner()).order('created_at', { ascending:false }).limit(800);
    if(error){ if(/record_notes|42P01|PGRST205|does not exist|schema cache/i.test((error.code || '') + ' ' + (error.message || ''))) osNotesOff = true; }
    else { osNotesOff = false; osNotes = data || []; }
  } catch(e){ /* offline: keep what we have */ }
  osNotesBusy = false;
  osNotesChanged();
}
function osNotesChanged(){
  document.querySelectorAll('[data-os-thread]').forEach(el => { el.innerHTML = osThreadInner(el.dataset.osThread); });
  if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'work' && typeof osRenderWork === 'function') osRenderWork();
  if(typeof osCounts === 'function') osCounts();
}
async function osAddNote(n){
  if(osNotesOff) return { ok:false, note:'Comments are off until the one-time setup step has run.' };
  const row = Object.assign({ user_id:osOwner(), author_id:currentUser.id, author_name:osMyName() }, n);
  try {
    const { data, error } = await sbClient.from('record_notes').insert(row).select().single();
    if(error) throw error;
    osNotes.unshift(data || Object.assign({ id:'local-' + Date.now(), created_at:new Date().toISOString() }, row));
    osNotesChanged();
    return { ok:true };
  } catch(e){
    if(/record_notes|42P01|PGRST205|does not exist|schema cache/i.test(String(e && (e.code || '') + ' ' + (e.message || '')))){ osNotesOff = true; osNotesChanged(); }
    return { ok:false, note:(e && e.message) || 'Couldn’t save' };
  }
}

/* ---------- the thread on a record ---------- */
function osThreadNotes(type, key){ return osNotes.filter(n => n.record_type === type && n.record_key === key && n.kind === 'comment').slice().reverse(); }
function osThreadInner(ref){
  const [type, key, label] = ref.split('|');
  if(osNotesOff) return '<div class="mg-empty">Comments switch on after a one-time setup step. Until then, use Ask Margyn below.</div>';
  const notes = osThreadNotes(type, key);
  return '<div class="os-thread-list">' + (notes.length ? notes.map(n => {
      const me = n.author_id === (currentUser && currentUser.id);
      return '<div class="os-msg' + (me ? ' me' : '') + '"><span class="os-av' + (me ? '' : ' on') + '">' + escapeHtml(osInitials(n.author_name || '?')) + '</span><div><b>' + escapeHtml(n.author_name || 'Someone') + ' <small>' + escapeHtml(osSince(n.created_at)) + '</small></b><p>' + escapeHtml(n.body || '') + '</p></div></div>';
    }).join('') : '<div class="mg-empty">No comments yet. Leave a note for your team, or write @Margyn to ask Margyn about ' + escapeHtml(label || 'this') + '.</div>') + '</div>' +
    '<form class="os-thread-f" data-os-thread-form="' + escapeHtml(ref) + '"><textarea rows="2" placeholder="Comment, or @Margyn to ask…" aria-label="Comment"></textarea><button class="mg-btn mg-btn-sm primary" type="submit">Post</button></form>';
}
function osThreadHtml(type, key, label){ return '<div data-os-thread="' + escapeHtml(type + '|' + key + '|' + (label || '')) + '">' + osThreadInner(type + '|' + key + '|' + (label || '')) + '</div>'; }
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-os-thread-form]'); if(!f) return;
  e.preventDefault();
  const ta = f.querySelector('textarea'), text = (ta.value || '').trim(); if(!text) return;
  const [type, key, label] = f.dataset.osThreadForm.split('|');
  const btn = f.querySelector('button'); btn.disabled = true;
  const r = await osAddNote({ record_type:type, record_key:key, kind:'comment', body:text });
  btn.disabled = false;
  if(r.ok){
    ta.value = '';
    if(typeof osActAdd === 'function') osActAdd({ agent:'team', text:osMyName() + ' commented on ' + (label || key) + ': “' + text.slice(0, 60) + (text.length > 60 ? '…' : '') + '”', state:'done', at:new Date().toISOString(), end:new Date().toISOString(), from:'app' });
    // @Margyn: Margyn answers in its panel, on this customer or supplier.
    if(/@margyn\b/i.test(text) && typeof mgrAsk === 'function'){
      if(typeof mgrOpen === 'function') mgrOpen();
      mgrAsk((label ? 'About ' + label + ': ' : '') + text.replace(/@margyn\b/ig, '').trim());
    }
  } else if(typeof toast === 'function') toast(r.note || 'Couldn’t post that');
});

/* ---------- a customer's or supplier's timeline, across apps ---------- */
function osPartyTimeline(g, dir){
  const ev = [], key = g.key, name = g.party;
  const same = n => { try { return normPartyName(n) === key; } catch(e){ return false; } };
  const add = (at, mark, who, text, tone) => { if(at) ev.push({ at, mark, who, text, tone }); };
  // what each app says is open
  g.sources.forEach(s => (g.by[s].rows || []).forEach(r => { if(r.due) add(r.due, s, MG_SRC_NAME[s] || s, (dir === 'recv' ? 'Invoice ' : 'Bill ') + (r.ref || '') + ' ' + fmtINR(r.amount, 'tile') + (r.days != null && r.days < 0 ? ' was due' : ' is due'), r.days != null && r.days < 0 ? 'neg' : ''); }));
  // people and Margyn changing the ledger
  ((typeof ledgerEvents !== 'undefined' && ledgerEvents) || []).filter(e => same(e.party_name)).forEach(e =>
    add(e.created_at, e.channel === 'agent' ? 'margyn' : 'person', e.actor_name || (e.channel === 'agent' ? 'Margyn' : 'Someone'),
      ({ settled:'Settled', deleted:'Removed', created:'Added', imported:'Imported', updated:'Changed' }[e.event] || e.event || '') + ' ' + (e.entity_type || '') + (e.amount != null ? ' · ' + fmtINR(e.amount, 'tile') : '') + (e.channel && e.channel !== 'app' && e.channel !== 'agent' ? ' (' + e.channel + ')' : ''), ''));
  // reminders and replies
  ((typeof chaseTargets !== 'undefined' && chaseTargets) || []).filter(t => same(t.party_name)).forEach(t => {
    if(t.last_chase_at) add(t.last_chase_at, 'margyn', 'Margyn', 'Sent payment reminder ' + (t.chases_sent || 1) + ' on WhatsApp' + (t.invoice_ref ? ' for ' + t.invoice_ref : ''), '');
    if(t.last_reply_at) add(t.last_reply_at, 'wa', name, 'Replied on WhatsApp' + (t.last_reply_intent ? ': ' + String(t.last_reply_intent).replace(/_/g, ' ') : ''), '');
    if(t.promise_to_pay_date) add(t.last_reply_at || t.updated_at, 'wa', name, 'Promised to pay by ' + fmtDay(t.promise_to_pay_date), 'warn');
    if(t.state === 'resolved_paid' && t.resolved_at) add(t.resolved_at, 'margyn', 'Margyn', 'Marked paid after the reminder', 'pos');
  });
  // payment matching (Zoho invoices against Razorpay)
  try { ((reconSummary && reconSummary.connected && reconSummary.invoices) || []).filter(i => same(i.customer_name)).forEach(i => {
    if(i.reconciliation_status && i.reconciliation_status !== 'unmatched') add(i.updated_at || (reconSummary.provenance && reconSummary.provenance.last_verified_at), 'razorpay', 'Payments agent',
      'Invoice ' + (i.invoice_number || '') + ': ' + String(i.reconciliation_status).replace(/_/g, ' ') + (i.verified_paid_amount ? ' · ' + fmtINR(i.verified_paid_amount, 'tile') + ' verified' : ''), i.reconciliation_status === 'verified' ? 'pos' : '');
  }); } catch(e){}
  // proposals and forwarded documents
  try { ((agentActions && agentActions.actions) || []).filter(a => a.title && a.title.toLowerCase().includes(name.toLowerCase())).forEach(a => add(a.created_at, 'margyn', 'Margyn', 'Proposed: ' + a.title, 'ai')); } catch(e){}
  try { ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).forEach(p => { const ents = (p.proposal && p.proposal.entries) || []; if(ents.some(x => same(x.party))) add(p.received_at, 'wa', 'WhatsApp', 'A document from ' + name + ' came in; waiting for your OK', 'ai'); }); } catch(e){}
  // assignments
  osNotes.filter(n => n.record_type === 'party' && n.record_key === key && n.kind === 'assign').forEach(n => add(n.created_at, 'person', n.author_name || 'Someone', 'Assigned to ' + (n.assignee || '—'), ''));
  ev.sort((a, b) => new Date(b.at) - new Date(a.at));
  const MARK = { margyn:['M', '#14181F'], person:['', '#0B4B8C'], wa:['W', '#0E8F5C'] };
  return ev.length ? '<ol class="os-tl">' + ev.slice(0, 40).map(x => {
      const l = MG_SRC_LOGO[x.mark] || MARK[x.mark] || ['•', '#8B93A0'];
      const letter = x.mark === 'person' ? osInitials(x.who) : l[0];
      return '<li class="' + (x.tone || '') + '"><span class="os-tl-m" style="background:' + l[1] + '">' + escapeHtml(letter) + '</span><div><b>' + escapeHtml(x.who) + '</b> ' + escapeHtml(x.text) + '</div><small>' + escapeHtml(fmtDay(x.at)) + '</small></li>';
    }).join('') + '</ol>' : '<div class="mg-empty">Nothing has happened with ' + escapeHtml(name) + ' yet that Margyn can see.</div>';
}

/* ---------- work items and who owns them ---------- */
function osWorkItems(){
  const out = [];
  try { ((agentActions && agentActions.actions) || []).forEach(a => out.push({ key:'act:' + a.id, t:a.title, s:(AGENT_KIND_LABEL[a.kind] || a.kind) + ' · Margyn' + (a.confidence != null ? ' · ' + Math.round(a.confidence * 100) + '% sure' : ''), amt:Number(a.amount) || 0, go:'close/proposals', wf:a.kind === 'itc_risk' ? 'Tax' : 'Close' })); } catch(e){}
  try { ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).forEach(q => out.push({ key:'rq:' + q.id, t:(q.customer_name || 'Payment') + ': ' + (q.reason || 'needs review'), s:'Reconciliation · ' + (q.invoice_number || ''), amt:Number(q.amount) || 0, go:'collect/matching', wf:'Collect' })); } catch(e){}
  try { ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).forEach(p => { const ents = (p.proposal && p.proposal.entries) || [];
    out.push({ key:'doc:' + p.id, t:'Forwarded on WhatsApp' + (ents[0] && ents[0].party ? ': ' + ents[0].party : ''), s:'Import' + (ents.length > 1 ? ' · ' + ents.length + ' figures' : ''), amt:ents.reduce((t, x) => t + (Number(x.amount) || 0), 0), go:'documents/forwarded', wf:'Documents' }); }); } catch(e){}
  try { (typeof mgDisagreements === 'function' ? mgDisagreements() : []).forEach(d => out.push({ key:'dis:' + d.t, t:d.t + ': your books disagree', s:d.s, amt:d.amt || 0, go:'close/books', wf:'Close' })); } catch(e){}
  return out.sort((a, b) => b.amt - a.amt);
}
function osAssignee(key){ const n = osNotes.find(x => x.record_type === 'work' && x.record_key === key && x.kind === 'assign'); return n ? n.assignee : null; }
let osTeamNames = null;
async function osLoadTeamNames(){
  if(osTeamNames || !currentUser) return;
  osTeamNames = [];
  try {
    const d = (typeof mgTeamData !== 'undefined' && mgTeamData) || (typeof mgTeamApi === 'function' ? await mgTeamApi('team-list') : null);
    if(d){ const own = d.owner && (d.owner.name || d.owner.email); if(own) osTeamNames.push(own);
      (d.members || []).filter(m => m.status === 'active').forEach(m => osTeamNames.push(m.name || m.email)); }
  } catch(e){}
  if(!osTeamNames.length) osTeamNames.push(osMyName());
  if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'work') osRenderWork();
}
function osWorkTableHtml(tab){
  const items = osWorkItems().filter(x => tab === 'assigned' ? !!osAssignee(x.key) : true);
  if(!items.length) return '<div class="mg-empty">' + (tab === 'assigned' ? 'Nothing is assigned to anyone yet. Use Assign on any item to hand it to a person.' : 'Nothing is waiting on a person.') + '</div>';
  if(!osTeamNames) osLoadTeamNames();
  const names = osTeamNames || [osMyName()];
  const canAssign = !osNotesOff;
  return '<table class="mg-grid os-work"><thead><tr><th></th><th>What</th><th class="r">Amount</th><th>Owner</th><th></th></tr></thead><tbody>' +
    items.map(x => { const who = osAssignee(x.key);
      return '<tr><td class="os-own">' + (who ? '<span class="os-av on">' + escapeHtml(osInitials(who)) + '</span>' : '<span class="os-av m">M</span>') + '</td>' +
        '<td><span class="os-wfc">' + escapeHtml(x.wf) + '</span><b>' + escapeHtml(x.t) + '</b><div class="mg-muted">' + escapeHtml(x.s) + '</div></td><td class="r">' + (x.amt ? mgNum(x.amt) : '') + '</td>' +
        '<td>' + (canAssign ? '<select class="os-assign" data-os-assign="' + escapeHtml(x.key) + '" aria-label="Assign"><option value="">' + (who ? escapeHtml(who) : 'Unassigned') + '</option>' + names.filter(n => n !== who).map(n => '<option>' + escapeHtml(n) + '</option>').join('') + '</select>' : (who ? escapeHtml(who) : '<span class="mg-muted">Unassigned</span>')) + '</td>' +
        '<td class="r"><button type="button" class="mg-btn mg-btn-sm primary" data-os-go="' + x.go + '">Review</button></td></tr>'; }).join('') + '</tbody></table>' +
    (osNotesOff ? '<div class="os-note">Assigning work switches on after a one-time setup step.</div>' : '');
}
function osAssignedCount(){ return osWorkItems().filter(x => osAssignee(x.key)).length; }
document.addEventListener('change', async e => {
  const s = e.target.closest('[data-os-assign]'); if(!s || !s.value) return;
  const who = s.value, key = s.dataset.osAssign;
  const item = osWorkItems().find(x => x.key === key);
  const r = await osAddNote({ record_type:'work', record_key:key, kind:'assign', assignee:who, body:item ? item.t : null });
  if(r.ok && typeof osActAdd === 'function') osActAdd({ agent:'team', text:osMyName() + ' assigned “' + (item ? item.t : key).slice(0, 60) + '” to ' + who, state:'done', at:new Date().toISOString(), end:new Date().toISOString(), from:'app' });
});

/* ---------- boot ---------- */
(function(){
  const base = refreshAll;
  refreshAll = async function(){ const out = await base.apply(this, arguments); try { osLoadNotes(); } catch(e){} return out; };
})();
setInterval(() => { if(!document.hidden && currentUser) osLoadNotes(); }, 60000);
