/* ============================================================
   MARGYN OS PEOPLE: seeing each other, and handoffs as they happen.

   - Presence (28-os-live.js) also carries the record a person has open and
     whether they are typing in its thread. The thread shows "Priya is
     typing…", the record shows who else is on it, and any list row for that
     customer or supplier gets their initials.
   - A comment or assignment is announced on the same Realtime channel, so a
     teammate's copy reloads at once instead of on the next poll.
   - Handoffs: when a new decision lands in Work, or a teammate assigns you
     something or comments, a card says who handed what, with Review. The item
     is highlighted in Work for a few seconds.
   Nothing here needs new SQL; without a team or the record_notes table it
   stays quiet.
   ============================================================ */

/* ---------- what this person is on, and typing ---------- */
let osTypingRef = null, osTypingAt = 0, osTypingTimer = null, osTrackAt = 0, osTrackQueued = null;
function osRecNow(){
  const t = document.querySelector('.mg-drawer [data-os-thread]'); if(!t) return null;
  const [type, key, label] = t.dataset.osThread.split('|');
  return { ref:type + '|' + key, label:label || '' };
}
osTrack = function(){
  try {
    if(!osPresence || !currentUser) return;
    const r = osRecNow();
    osPresence.track({ id:currentUser.id, name:osMyName(), where:r && r.label ? r.label : osWhere(), rec:r ? r.ref : null,
      typing:osTypingRef && Date.now() - osTypingAt < 5000 ? osTypingRef : null, at:new Date().toISOString() });
    osTrackAt = Date.now();
  } catch(e){}
};
// At most one presence update every 1.5 s while typing; the last one always goes.
function osTrackSoon(){
  if(osTrackQueued) return;
  const wait = Math.max(0, 1500 - (Date.now() - osTrackAt));
  osTrackQueued = setTimeout(() => { osTrackQueued = null; osTrack(); }, wait);
}
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('[data-os-thread-form]'); if(!f) return;
  const [type, key] = f.dataset.osThreadForm.split('|');
  osTypingRef = type + '|' + key; osTypingAt = Date.now();
  osTrackSoon();
  clearTimeout(osTypingTimer);
  osTypingTimer = setTimeout(() => { osTypingRef = null; osTrack(); }, 4000);
});
if(typeof mgDrawer === 'function'){
  const baseDrawer = mgDrawer;
  mgDrawer = function(){ const out = baseDrawer.apply(this, arguments); setTimeout(() => { osTrack(); osPaintPresence(); }, 0); return out; };
}
if(typeof mgCloseDrawer === 'function'){
  const baseClose = mgCloseDrawer;
  mgCloseDrawer = function(){ const had = !!mgDrawerEl; const out = baseClose.apply(this, arguments); if(had){ osTypingRef = null; setTimeout(osTrack, 0); } return out; };
}

/* ---------- show who is where ---------- */
function osOthersOn(ref){ return osPresenceList().filter(p => !p.me && p.rec === ref); }
function osOthersTyping(ref){ return osPresenceList().filter(p => !p.me && p.typing === ref && Date.now() - new Date(p.at || 0) < 8000); }
function osNames(ps){ const n = ps.map(p => String(p.name || 'Someone').split(/\s+/)[0]); return n.length < 3 ? n.join(' and ') : n.slice(0, 2).join(', ') + ' and ' + (n.length - 2) + ' more'; }
function osPaintPresence(){
  // the thread: who is typing
  document.querySelectorAll('[data-os-thread]').forEach(el => {
    const [type, key] = el.dataset.osThread.split('|'), ref = type + '|' + key;
    const typing = osOthersTyping(ref);
    let line = el.querySelector('.os-typing');
    if(!line){ const form = el.querySelector('form'); if(!form) return; line = document.createElement('div'); line.className = 'os-typing'; form.parentNode.insertBefore(line, form); }
    line.innerHTML = typing.length ? '<span class="os-typing-dots"><i></i><i></i><i></i></span>' + escapeHtml(osNames(typing)) + (typing.length === 1 ? ' is' : ' are') + ' typing…' : '';
    line.hidden = !typing.length;
  });
  // the open record: who else is here
  const r = osRecNow(), head = document.querySelector('.mg-drawer .mg-drawer-h');
  if(head){
    let here = head.querySelector('.os-here');
    const on = r ? osOthersOn(r.ref) : [];
    if(!here){ here = document.createElement('div'); here.className = 'os-here'; head.insertBefore(here, head.querySelector('[data-drawer-close]')); }
    here.innerHTML = on.length ? on.slice(0, 3).map(p => '<span class="os-av on" title="' + escapeHtml(p.name) + '">' + escapeHtml(osInitials(p.name)) + '</span>').join('') + '<span>' + escapeHtml(osNames(on)) + ' ' + (on.length === 1 ? 'is' : 'are') + ' here</span>' : '';
    here.hidden = !on.length;
  }
  // list rows for a customer or supplier someone has open
  document.querySelectorAll('[data-os-party]').forEach(row => {
    const key = row.dataset.osParty.split('|')[1], on = osOthersOn('party|' + key), typing = osOthersTyping('party|' + key);
    let chip = row.querySelector('.os-rowhere');
    if(!on.length){ if(chip) chip.remove(); return; }
    if(!chip){ chip = document.createElement('span'); chip.className = 'os-rowhere'; const cell = row.querySelector('td') || row; cell.appendChild(chip); }
    chip.className = 'os-rowhere' + (typing.length ? ' typing' : '');
    chip.title = osNames(on) + (typing.length ? ' typing' : ' on this');
    chip.innerHTML = on.slice(0, 2).map(p => '<span class="os-av on">' + escapeHtml(osInitials(p.name)) + '</span>').join('') + (typing.length ? '<em>typing</em>' : '');
  });
}

/* ---------- tell teammates at once when a note is added ---------- */
function osAnnounce(kind, ref){
  try { if(osPresence) osPresence.send({ type:'broadcast', event:'note', payload:{ kind, ref, by:currentUser && currentUser.id } }); } catch(e){}
}
function osOnBroadcast(msg){
  const p = (msg && msg.payload) || {};
  if(p.by && currentUser && p.by === currentUser.id) return;
  if(typeof osLoadNotes === 'function') osLoadNotes(true);
}
if(typeof osAddNote === 'function'){
  const baseAdd = osAddNote;
  osAddNote = async function(n){
    const r = await baseAdd.apply(this, arguments);
    if(r && r.ok){ osAnnounce(n.kind, n.record_type + '|' + n.record_key); if(n.kind === 'comment'){ osTypingRef = null; osTrack(); } }
    return r;
  };
}

/* ---------- handoffs ---------- */
let osSeenWork = null, osSeenNotes = null, osHandArmAt = 0;
const osFreshKeys = new Map();   // work key -> until (ms)
function osAgentForWork(x){
  const k = x.key || '';
  if(k.indexOf('rq:') === 0) return 'payments';
  if(k.indexOf('doc:') === 0) return 'documents';
  if(k.indexOf('dis:') === 0) return 'books';
  if(k.indexOf('act:') === 0) return x.wf === 'Tax' ? 'gst' : 'close';
  return null;
}
function osPartyLabel(key){
  try { const g = mgMoneyGroups('recv').concat(mgMoneyGroups('pay')).find(x => x.key === key); if(g) return g.party; } catch(e){}
  return 'a customer or supplier';
}
function osHandoff(o){
  const host = document.getElementById('toastHost'); if(!host) return;
  host.querySelectorAll('.os-hand').forEach((el, i, all) => { if(all.length >= 3 && i === 0) el.remove(); });   // at most three on screen
  const el = document.createElement('div');
  el.className = 'toast os-hand';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span class="os-av' + (o.person ? ' on' : ' m') + '">' + escapeHtml(o.person ? osInitials(o.who) : 'M') + '</span>' +
    '<div class="os-hand-m"><div class="t-body">' + escapeHtml(o.head) + '</div><div class="t-sub">' + escapeHtml(o.title) + '</div></div>' +
    (o.go ? '<button type="button" class="mg-btn mg-btn-sm primary" data-os-go="' + escapeHtml(o.go) + '">Review</button>' : '') +
    '<button type="button" class="mg-icon-btn os-hand-x" aria-label="Dismiss">×</button>';
  host.appendChild(el);
  const out = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', e => { if(e.target.closest('[data-os-go], .os-hand-x')) setTimeout(out, 30); });
  setTimeout(out, o.ms || 9000);
}
function osCheckWorkHandoffs(){
  if(!currentUser || typeof osWorkItems !== 'function') return;
  let items = []; try { items = osWorkItems(); } catch(e){ return; }
  const keys = new Set(items.map(x => x.key));
  // While the first loads are still landing, everything counts as already there.
  if(osSeenWork === null || Date.now() < osHandArmAt){ osSeenWork = keys; return; }
  const fresh = items.filter(x => !osSeenWork.has(x.key));
  osSeenWork = keys;
  fresh.slice(0, 3).forEach(x => {
    const ag = osAgentForWork(x), a = ag && OS_AGENT[ag];
    osFreshKeys.set(x.key, Date.now() + 8000);
    osHandoff({ head:(a ? a.name + ' agent' : 'Margyn') + ' handed you a decision', title:x.t + (x.amt ? ' · ' + fmtINR(x.amt, 'tile') : ''), go:x.go });
    if(typeof osActAdd === 'function') osActAdd({ agent:ag || 'margyn', text:'Handed to you: ' + x.t, state:'done', at:new Date().toISOString(), end:new Date().toISOString(), from:'app' });
  });
  if(fresh.length > 3) osHandoff({ head:'And ' + (fresh.length - 3) + ' more waiting on you', title:'All of them are in Work', go:'work/all' });
}
function osCheckNoteHandoffs(){
  if(!currentUser || typeof osNotes === 'undefined') return;
  const ids = new Set(osNotes.map(n => n.id));
  if(osSeenNotes === null || Date.now() < osHandArmAt){ osSeenNotes = ids; return; }
  const me = currentUser.id, myName = osMyName();
  const fresh = osNotes.filter(n => !osSeenNotes.has(n.id) && n.author_id !== me);
  osSeenNotes = ids;
  const open = osRecNow();
  fresh.slice(0, 3).forEach(n => {
    const who = n.author_name || 'Someone';
    if(n.kind === 'assign' && n.assignee && n.assignee === myName){
      osHandoff({ person:true, who, head:who.split(/\s+/)[0] + ' handed you work', title:n.body || 'A piece of work', go:'work/all' });
    } else if(n.kind === 'comment' && !(open && open.ref === n.record_type + '|' + n.record_key)){
      const label = n.record_type === 'party' ? osPartyLabel(n.record_key) : 'a piece of work';
      osHandoff({ person:true, who, head:who.split(/\s+/)[0] + ' commented on ' + label, title:'“' + String(n.body || '').slice(0, 90) + '”', go:null, ms:7000 });
    }
  });
}

/* ---------- wiring ---------- */
osRefreshLive = (function(base){ return function(){ base.apply(this, arguments); requestAnimationFrame(() => { osPaintPresence(); osCheckWorkHandoffs(); }); }; })(osRefreshLive);
osNotesChanged = (function(base){ return function(){ base.apply(this, arguments); osPaintPresence(); osCheckNoteHandoffs(); }; })(osNotesChanged);
(function(){
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    if(!osHandArmAt) osHandArmAt = Date.now() + 8000;   // the first loads settle before anything counts as new
    try { osCheckWorkHandoffs(); osPaintPresence(); } catch(e){}
    return out;
  };
})();
// A row handed over a moment ago is highlighted in Work.
if(typeof osWorkTableHtml === 'function'){
  const baseTable = osWorkTableHtml;
  osWorkTableHtml = function(){
    const html = baseTable.apply(this, arguments), now = Date.now();
    let out = html;
    osFreshKeys.forEach((until, key) => { if(until < now){ osFreshKeys.delete(key); return; }
      out = out.replace('data-os-assign="' + escapeHtml(key) + '"', 'data-os-assign="' + escapeHtml(key) + '" data-os-fresh'); });
    return out;
  };
}
setInterval(() => { if(!document.hidden) osPaintPresence(); }, 4000);
