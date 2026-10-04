/* ============================================================
   CONVERSATIONS HUB (2026-10-03). One place for every conversation with
   Margyn, whatever the channel: typed in the app, spoken on a call, or
   texted on WhatsApp.

   Above the thread list:
   - Ask anything: the questions an owner who doesn't follow the books
     closely actually asks, one tap each (answered in the Margyn panel).
   - Margyn noticed: what Margyn Watch found in the books (api/_lib/
     booksEngine.js insights via the Margin payload), whether it went out on
     WhatsApp, and the owner's switch for those messages.
   - What you've asked: every question across app, calls and WhatsApp,
     sorted into topics (app/js/margyn-topics.js), with the ones Margyn
     couldn't answer pulled out and a one-tap "Ask again".
   In the thread list: WhatsApp chats sit beside the app conversations.
   ============================================================ */
let mgHub = { chat:null, wa:null, watch:null, topic:null, missedOnly:false, busy:false, preview:null };

const MG_HUB_ASK = [
  'How much did I sell this year?',
  'What profit did I make last month?',
  'Who owes me the most, and how late are they?',
  'What should I look at today?',
  'Which products make me the most margin?',
  'How much cash and overdraft do I have?',
  'Which customers have stopped ordering?',
  'How much GST is due this month?'
];
const MG_HUB_CHANNEL = { app:'App', voice:'Call', whatsapp:'WhatsApp' };

async function mgHubLoad(force){
  if(mgHub.busy || (!force && mgHub.chat)) return;
  if(typeof currentUser === 'undefined' || !currentUser) return;
  mgHub.busy = true;
  try {
    // The newest 3,000, oldest first. Asking oldest-first with .limit(3000) got the OLDEST 1,000 (the database's
    // per-request ceiling), so once there were more, the latest conversations vanished from the hub.
    const mk = () => { let q = sbClient.from('chat_messages').select('role,content,thread_key,created_at').eq('user_id', currentUser.id); if(typeof mgChatScope === 'function') q = mgChatScope(q); return q.order('created_at', { ascending:false }); };
    const chat = await sbAll(mk, 3000);
    mgHub.chat = ((chat && chat.data) || []).reverse();
    // The owner's own WhatsApp chat only: other people on the account have their own threads with Margyn,
    // the same way app conversations are kept per person (mgChatScope).
    const mine = String((currentProfile && currentProfile.whatsapp_phone) || '').replace(/[^\d]/g, '');
    const owner = typeof mgActor === 'undefined' || !mgActor || mgActor.isOwner;
    const wa = owner ? await sbAll(() => sbClient.from('whatsapp_conversations').select('role,content,created_at,from_phone').order('created_at', { ascending:false }), 3000) : null;
    if(wa && wa.data) wa.data.reverse();
    const last10 = (x) => String(x || '').replace(/[^\d]/g, '').slice(-10);
    mgHub.wa = ((wa && !wa.error && wa.data) || []).filter(m => !m.from_phone || (mine && last10(m.from_phone) === last10(mine)));
  } catch(e){ console.warn('[margyn] hub:', e.message); mgHub.chat = mgHub.chat || []; mgHub.wa = mgHub.wa || []; }
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    const r = await fetch('/api/ask-margyn?action=watch', { headers:session ? { 'Authorization':'Bearer ' + session.access_token } : {} });
    mgHub.watch = r.ok ? await r.json() : null;
  } catch(e){ mgHub.watch = null; }
  mgHub.busy = false;
}

/* Every question asked anywhere, with the answer that followed it. */
function mgHubQuestions(){
  const T = window.MG_TOPICS;
  if(!T) return [];
  const out = [];
  const take = (rows, channelOf) => {
    rows.forEach((m, i) => {
      if(m.role !== 'user' || !T.isQuestion(m.content)) return;
      let ans = null;
      for(let j = i + 1; j < rows.length && j < i + 8; j++){
        const n = rows[j];
        if(n.role === 'user' && (n.thread_key || n.from_phone) === (m.thread_key || m.from_phone)) break;
        if(n.role === 'assistant' && (n.thread_key || n.from_phone) === (m.thread_key || m.from_phone) && String(n.content || '').trim()){ ans = n.content; break; }
      }
      out.push({ text:m.content, at:m.created_at, channel:channelOf(m), topics:T.topicsOf(m.content), answer:ans,
        missed:!ans || T.looksUnanswered(ans), thread:m.thread_key || null, phone:m.from_phone || null });
    });
  };
  take(mgHub.chat || [], m => String(m.thread_key || '').startsWith('voice:') ? 'voice' : 'app');
  take(mgHub.wa || [], () => 'whatsapp');
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

function mgHubAskPanel(){
  const wa = mgHub.watch && mgHub.watch.has_number;
  return '<div class="mg-panel"><div class="mg-panel-h"><h2>Ask Margyn anything</h2><span class="mg-aside">In plain words, English or Hindi. The same answers on WhatsApp' + (wa ? '' : ' once your number is added') + ' and on a call.</span></div>' +
    '<div class="mg-panel-b mg-hub-asks">' + MG_HUB_ASK.map(q => '<button type="button" class="mgr-chip" data-hub-ask="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('') + '</div></div>';
}

/* Whose phone each setting texts, said plainly. "On" used to read like "on for me"; on 3 Oct it sent three
   updates to the business owner's own WhatsApp when the team meant to test. */
function mgHubOwnerLabel(w){
  const who = w.owner_name ? w.owner_name + '’s' : 'the owner’s';
  return who + ' WhatsApp' + (w.owner_phone_end ? ' (…' + w.owner_phone_end + ')' : '');
}
/* Did it arrive? From WhatsApp's own delivery report, not from "Gupshup accepted it". */
function mgHubTime(iso){ return iso ? new Date(iso).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' }) : ''; }
function mgHubDeliveryText(d, w){
  if(!d) return null;
  const who = d.sent_to === 'owner' ? mgHubOwnerLabel(w) : 'the Margyn test phone';
  if(d.status === 'read') return { cls:'pos', text:'Read on ' + who + ' · ' + mgHubTime(d.read_at) };
  if(d.status === 'delivered') return { cls:'pos', text:'Delivered to ' + who + ' · ' + mgHubTime(d.delivered_at) };
  if(d.status === 'failed') return { cls:'neg', text:'Didn’t arrive on ' + who + ': ' + (d.error || 'WhatsApp didn’t say why') };
  const mins = (Date.now() - Date.parse(d.sent_at)) / 60000;
  return mins > 30 ? { cls:'warn', text:'WhatsApp hasn’t confirmed delivery to ' + who + ' (sent ' + mgHubTime(d.sent_at) + ')' }
    : { cls:'', text:'Sent to ' + who + ' · waiting for WhatsApp to confirm' };
}
function mgHubDeliveryFor(key){
  const list = (mgHub.watch && mgHub.watch.deliveries) || [];
  return list.find(d => (d.signal_keys || []).includes(key)) || null;
}

function mgHubWatchControls(){
  const w = mgHub.watch || {};
  const mode = w.mode || 'off';
  const opts = [['off', 'Off']];
  if(w.preview_available || mode === 'preview') opts.push(['preview', 'Test on Margyn’s phone']);
  opts.push(['on', 'Send to ' + mgHubOwnerLabel(w)]);
  const seg = '<div class="mg-seg" role="group" aria-label="WhatsApp updates">' + opts.map(o => '<button type="button" data-hub-mode="' + o[0] + '" class="' + (mode === o[0] ? 'on' : '') + '">' + escapeHtml(o[1]) + '</button>').join('') + '</div>';
  const when = 'around 7:30 am and 7 pm, plus 10:30 am only for a deadline (GST due, Tally gone quiet)';
  let note;
  if(!w.ready) note = 'Keeping a history of these needs one setup step on Margyn’s side. They still show here.';
  else if(mode === 'off') note = 'Nothing is texted to anyone. Margyn still lists what it noticed here.';
  else if(mode === 'preview') note = 'Updates go only to the Margyn team’s test phone, ' + when + '. ' + (w.owner_name || 'The owner') + ' gets nothing until you pick “Send to ' + mgHubOwnerLabel(w) + '”.';
  else note = w.has_number ? 'Margyn texts ' + mgHubOwnerLabel(w) + ' ' + when + ', at most three points, one per customer. Reply STOP ALERTS to pause.' : 'Add a WhatsApp number under Settings first, then Margyn can text it.';
  if(mode !== 'off' && w.ready && !w.template_ready) note += ' Until Margyn’s WhatsApp template is approved, messages only go out within 24 hours of the last message to Margyn.';
  const pv = mgHub.preview;
  const last = ((w.deliveries || []).filter(d => d.sent_to === 'owner' || d.sent_to === 'preview'))[0];
  const lt = mgHubDeliveryText(last, w);
  const deliveryLine = w.deliveries === null && mode !== 'off'
    ? '<p class="mg-fine">Margyn can’t yet confirm that updates arrive (one setup step on Margyn’s side).</p>'
    : lt ? '<p class="mg-fine"><span class="mg-bdg ' + lt.cls + '">Last update</span> ' + escapeHtml(lt.text) + '</p>' : '';
  return '<div class="mg-panel-b mg-hub-watch"><span class="mg-hub-lbl">WhatsApp updates</span>' + seg +
    mgBtn('Preview today’s update', 'data-hub-send') +
    '<p class="mg-fine">' + escapeHtml(note) + '</p>' + deliveryLine +
    (pv ? '<div class="mg-hub-preview"><div class="mg-li-s">' + escapeHtml(pv.note) + '</div><pre style="white-space:pre-wrap;font:inherit;margin:6px 0 0">' + escapeHtml(pv.text) + '</pre></div>' : '') +
    '</div>';
}

function mgHubNoticed(){
  const live = (typeof mgMar !== 'undefined' && mgMar && Array.isArray(mgMar.insights)) ? mgMar.insights : [];
  const state = new Map(((mgHub.watch && mgHub.watch.signals) || []).map(s => [s.key, s]));
  const items = live.length ? live : ((mgHub.watch && mgHub.watch.signals) || []).filter(s => s.status !== 'resolved' && !String(s.key).startsWith('mute:'));
  const body = items.length ? items.slice(0, 8).map(x => {
    const s = state.get(x.key) || x;
    const when = s.last_sent_at ? fmtDay(s.last_sent_at) : null;
    const dv = mgHubDeliveryText(mgHubDeliveryFor(x.key), mgHub.watch || {});
    const badge = s.status === 'muted' ? '<span class="mg-bdg">Muted</span>'
      : dv ? '<span class="mg-bdg ' + dv.cls + '">' + escapeHtml(dv.text) + '</span>'
      : when ? '<span class="mg-bdg">Sent ' + escapeHtml(when) + (s.sent_to === 'preview' ? ' to the test phone' : '') + ', not confirmed</span>'
      : '<span class="mg-bdg">In the app</span>';
    const sev = x.severity === 'high' ? 'neg' : x.severity === 'medium' ? 'warn' : '';
    return '<div class="mg-li mg-hub-note"><span class="mg-dot ' + sev + '"></span><div style="min-width:0;flex:1"><div class="mg-li-t">' + escapeHtml(x.title || '') + '</div>' +
      (x.detail ? '<div class="mg-li-s">' + escapeHtml(x.detail) + '</div>' : '') +
      '<div class="mg-hub-acts">' + badge +
        '<button type="button" class="mg-link" data-hub-ask="' + escapeHtml(x.ask || x.title || '') + '">Ask about this</button>' +
        (s.status === 'muted' ? '<button type="button" class="mg-link" data-hub-unmute="' + escapeHtml(x.key) + '">Unmute</button>'
          : '<button type="button" class="mg-link" data-hub-mute="' + escapeHtml(x.key) + '">Don’t send this again</button>') +
      '</div></div></div>';
  }).join('') : '<div class="mg-empty">' + (((typeof mgBooksConnected === 'function' ? mgBooksConnected() : (typeof tallyConnected !== 'undefined' && tallyConnected))) ? (typeof mgMar !== 'undefined' && !mgMar ? 'Reading your books…' : 'Nothing needs your attention right now.') : 'Connect your books (Tally, Zoho Books or Odoo) and Margyn will read them and tell you what needs a look.') + '</div>';
  return '<div class="mg-panel"><div class="mg-panel-h"><h2>Margyn noticed</h2><span class="mg-aside">Worked out from your books, biggest first</span></div>' + mgHubWatchControls() + '<div>' + body + '</div></div>';
}

function mgHubAsked(){
  const qs = mgHubQuestions();
  const T = window.MG_TOPICS;
  if(!qs.length) return '<div class="mg-panel"><div class="mg-panel-h"><h2>What you’ve asked</h2></div><div class="mg-empty">Questions you ask in the app, on a call or on WhatsApp show up here, sorted by topic.</div></div>';
  const counts = {};
  qs.forEach(q => q.topics.forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const missed = qs.filter(q => q.missed).length;
  const chips = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(k =>
    '<button type="button" class="mg-chip' + (mgHub.topic === k ? ' on' : '') + '" data-hub-topic="' + k + '">' + escapeHtml((T && T.LABEL[k]) || k) + ' · ' + counts[k] + '</button>').join('') +
    (missed ? '<button type="button" class="mg-chip' + (mgHub.missedOnly ? ' on' : '') + '" data-hub-missed>Couldn’t answer · ' + missed + '</button>' : '');
  const shown = qs.filter(q => (!mgHub.topic || q.topics.includes(mgHub.topic)) && (!mgHub.missedOnly || q.missed)).slice(0, 12);
  const rows = shown.map(q => '<div class="mg-li"><div style="min-width:0;flex:1"><div class="mg-li-t">' + escapeHtml(q.text.slice(0, 140)) + '</div>' +
    '<div class="mg-li-s">' + escapeHtml(MG_HUB_CHANNEL[q.channel] + ' · ' + fmtDay(q.at)) + (q.missed ? ' · <span class="mg-hub-miss">Margyn couldn’t answer this then</span>' : '') + '</div></div>' +
    '<button type="button" class="mg-btn mg-btn-sm" data-hub-ask="' + escapeHtml(q.text) + '">Ask again</button></div>').join('');
  return '<div class="mg-panel"><div class="mg-panel-h"><h2>What you’ve asked</h2><span class="mg-aside">' + qs.length + ' question' + (qs.length === 1 ? '' : 's') + ' across the app, calls and WhatsApp</span></div>' +
    '<div class="mg-panel-b mg-hub-chips">' + chips + '</div><div>' + (rows || '<div class="mg-empty">Nothing in this topic yet.</div>') + '</div></div>';
}

async function mgHubRender(force){
  const host = document.getElementById('mgHub'); if(!host) return;
  if(!mgHub.chat || force){
    host.innerHTML = mgHubAskPanel() + '<div class="mg-row3"><div class="mg-panel"><div class="mg-empty">Loading…</div></div></div>';
    await mgHubLoad(force);
  }
  if(typeof mgMar !== 'undefined' && !mgMar && typeof mgLoadMargin === 'function' && (typeof mgBooksConnected === 'function' ? mgBooksConnected() : (typeof tallyConnected !== 'undefined' && tallyConnected))){
    mgLoadMargin().then(() => { if(document.body.contains(host)) host.innerHTML = mgHubAskPanel() + '<div class="mg-row3">' + mgHubNoticed() + mgHubAsked() + '</div>'; });
  }
  host.innerHTML = mgHubAskPanel() + '<div class="mg-row3">' + mgHubNoticed() + mgHubAsked() + '</div>';
}

async function mgHubWatchPost(body){
  const { data:{ session } } = await sbClient.auth.getSession();
  const r = await fetch('/api/ask-margyn?action=watch', { method:'POST', headers:{ 'Content-Type':'application/json', ...(session ? { 'Authorization':'Bearer ' + session.access_token } : {}) }, body:JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(out.error || 'That didn’t work');
  return out;
}

document.addEventListener('click', async e => {
  const ask = e.target.closest('[data-hub-ask]');
  if(ask){ if(typeof mgrAsk === 'function') mgrAsk(ask.getAttribute('data-hub-ask')); return; }
  const tp = e.target.closest('[data-hub-topic]');
  if(tp){ const k = tp.getAttribute('data-hub-topic'); mgHub.topic = mgHub.topic === k ? null : k; mgHubRender(); return; }
  if(e.target.closest('[data-hub-missed]')){ mgHub.missedOnly = !mgHub.missedOnly; mgHubRender(); return; }
  const md = e.target.closest('[data-hub-mode]');
  if(md){
    const mode = md.getAttribute('data-hub-mode');
    if(mgHub.watch && mgHub.watch.mode === mode) return;
    const w = mgHub.watch || {};
    if(mode === 'on' && typeof mgConfirm === 'function'){
      const lastTest = (w.deliveries || []).find(d => d.sent_to === 'preview');
      const proven = lastTest && (lastTest.status === 'delivered' || lastTest.status === 'read');
      const yes = await mgConfirm({ title:'Text ' + mgHubOwnerLabel(w) + '?',
        body:(proven ? 'The last test update was delivered, so the same route works. ' : 'No test update has been confirmed delivered yet. Try “Test on Margyn’s phone” first so you know it arrives. ') + 'From the next update, Margyn sends what it notices in these books to ' + mgHubOwnerLabel(w) + ', around 7:30 am and 7 pm (10:30 am only for a deadline). Use Preview today’s update first to see exactly what they’ll get.',
        confirmLabel:'Yes, send to ' + (w.owner_name || 'the owner') });
      if(!yes) return;
    }
    try { await mgHubWatchPost({ op:'mode', mode }); mgHub.watch = Object.assign({}, mgHub.watch, { mode });
      toast(mode === 'off' ? 'Updates are off' : mode === 'on' ? 'Margyn will text ' + mgHubOwnerLabel(w) : 'Updates go to the Margyn team’s test phone only'); }
    catch(err){ toast(err.message, { kind:'bad' }); }
    mgHubRender(); return;
  }
  const mu = e.target.closest('[data-hub-mute], [data-hub-unmute]');
  if(mu){
    const key = mu.getAttribute('data-hub-mute') || mu.getAttribute('data-hub-unmute');
    const unmute = mu.hasAttribute('data-hub-unmute');
    try { await mgHubWatchPost({ op:'mute', key, unmute }); await mgHubLoad(true); toast(unmute ? 'Margyn can mention this again' : 'Margyn won’t send this one again'); }
    catch(err){ toast(err.message, { kind:'bad' }); }
    mgHubRender(); return;
  }
  if(e.target.closest('[data-hub-send]')){
    const b = e.target.closest('[data-hub-send]'); b.disabled = true;
    try {
      const r = await mgHubWatchPost({ op:'preview' });
      if(r.skipped) toast(r.skipped, { kind:'bad' });
      else mgHub.preview = { text:r.text || '', note:'This is the next update exactly as it would go out. Nothing was sent to ' + (mgHub.watch && mgHub.watch.owner_name || 'the owner') + ' and nothing is used up.' + (r.sent_to_preview_phone ? ' A copy went to the Margyn team’s test phone.' : '') };
    } catch(err){ toast(err.message, { kind:'bad' }); }
    b.disabled = false; mgHubRender(); return;
  }
  const wa = e.target.closest('[data-hub-wa]');
  if(wa){ mgHubOpenWhatsApp(wa.getAttribute('data-hub-wa'), wa); return; }
});

/* WhatsApp chats in the thread list, beside the app conversations. */
function mgHubWaThreads(){
  const by = new Map();
  (mgHub.wa || []).forEach(m => {
    if((m.role !== 'user' && m.role !== 'assistant') || !String(m.content || '').trim()) return;
    const k = m.from_phone || 'whatsapp';
    by.set(k, m);   // rows are oldest first, so the last one wins
  });
  return [...by.entries()].map(([phone, last]) => ({ phone, last }));
}
async function mgHubAppendWhatsApp(){
  const listEl = document.getElementById('historyThreadList'); if(!listEl) return;
  if(!mgHub.wa) await mgHubLoad();
  listEl.querySelectorAll('.mg-hub-wa-row').forEach(r => r.remove());
  const rows = mgHubWaThreads().sort((a, b) => (a.last.created_at < b.last.created_at ? 1 : -1));
  if(!rows.length) return;
  const hint = listEl.querySelector('.hint'); if(hint && /No conversations yet/.test(hint.textContent)) hint.remove();
  rows.forEach(t => {
    const row = document.createElement('div');
    row.className = 'chat-history-row mg-hub-wa-row';
    row.setAttribute('data-hub-wa', t.phone);
    const who = t.phone === 'whatsapp' ? 'WhatsApp' : 'WhatsApp · ••' + String(t.phone).slice(-4);
    const when = new Date(t.last.created_at).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    row.innerHTML = '<div class="chr-label">' + escapeHtml(who) + ' · ' + when + '</div><div class="chr-preview">' + escapeHtml(String(t.last.content).slice(0, 90)) + '</div>';
    listEl.insertBefore(row, listEl.firstChild);   // WhatsApp chats lead the list: they're where the owner talks most
  });
}
function mgHubOpenWhatsApp(phone, rowEl){
  const listEl = document.getElementById('historyThreadList');
  if(listEl) listEl.querySelectorAll('.chat-history-row').forEach(r => r.classList.toggle('on', r === rowEl));
  const messagesEl = document.getElementById('historyThreadMessages'); if(!messagesEl) return;
  messagesEl.innerHTML = '';
  if(typeof askSetTitle === 'function') askSetTitle('WhatsApp' + (phone && phone !== 'whatsapp' ? ' · ••' + String(phone).slice(-4) : ''), 'Your chat with Margyn on WhatsApp. Reply from your phone, or ask here', 'margyn');
  const ground = document.getElementById('askGround');
  if(ground) ground.innerHTML = '<button type="button" class="mg-btn primary mg-btn-sm" data-mgr-open>Ask in the Margyn panel</button>';
  (mgHub.wa || []).filter(m => (m.from_phone || 'whatsapp') === phone && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .forEach(m => appendChatBubble(messagesEl, m.role, m.content, 'margyn'));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* Hooks into the existing Conversations page (06-ask.js). */
(function(){
  if(typeof renderHistoryView === 'function'){
    const base = renderHistoryView;
    renderHistoryView = async function(){ const r = await base.apply(this, arguments); mgHubRender(); return r; };
  }
  if(typeof renderHistoryThreadList === 'function'){
    const baseList = renderHistoryThreadList;
    renderHistoryThreadList = async function(){ const r = await baseList.apply(this, arguments); await mgHubAppendWhatsApp(); return r; };
  }
})();
