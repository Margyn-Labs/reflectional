/* ============================================================
   LIVE CONVERSATION — Margyn on a call, driving the app.
   OpenAI Realtime API over WebRTC (continuous speech-to-speech).

   Since 2026-09-30 a call is the Margyn panel in voice mode (25-margyn.js):
   the orb and controls sit at the top of the panel, the transcript is the
   same conversation you type into, and whatever Margyn shows (P&L,
   receivables, cash, charts, change cards) lands in it as cards, so
   answering "show me X" never needs a page change.

   Entry points: the top-bar mic, the "Talk to Margyn" pill on Ask Margyn,
   the command palette, and Option+M / Ctrl+M anywhere. The same keys again,
   or Esc, end the call. (Cmd+M can't be used: macOS and every Mac browser
   take it to minimise the window before the page ever sees it.) Saying
   "thank you, that's all" / "okay that was it" / "end the call" ends it too.

   Tools run in 23-voice-tools.js. The safety line is unchanged: nothing the
   voice model does writes on its own; see that file's header for the gate.
   ============================================================ */
let rtPc = null, rtDc = null, rtStream = null;
let vxActive = false, vxMuted = false, vxDriving = false;
let vxState = 'idle', vxCaption = '', vxThreadKey = null;
let vxCallsThisResponse = [], vxResponseActive = false, vxEnding = false;
let vxWantReply = false, vxWantAfterCreate = false, vxCreateSentAt = 0;   // a reply owed while another was still running, see vxRequestReply
let vxLastSaid = '', vxNudges = 0;   // follow-through check, see vxBrokenPromise
let vxUtterances = [];         // { at, text } — the user's own words (spoken or typed), for the confirm gate
let vxThinkHistory = [];       // think() thread so follow-up "why"s keep context
let vxLastActivity = 0, vxIdleTimer = null, vxAudioCtx = null, vxMicAn = null, vxOutAn = null, vxRaf = null;
const VX_IDLE_MS = 2 * 60 * 1000;   // hang up after 2 quiet minutes; a live session bills while open
const VX_HIDDEN_MS = 60 * 1000;     // ...or after a minute in a background tab

function vxEl(id){ return document.getElementById(id); }
function rtSend(obj){ if(rtDc && rtDc.readyState === 'open') rtDc.send(JSON.stringify(obj)); }

/* ---------- dock state ---------- */
const VX_STATE_TEXT = { connecting:'Connecting', listening:'Listening', hearing:'Hearing you', thinking:'Working', speaking:'Speaking', muted:'Muted' };
function vxSetState(state, caption){
  vxState = state;
  const dock = vxEl('vxDock'); if(!dock) return;
  dock.dataset.state = vxMuted && state === 'listening' ? 'muted' : state;
  const st = vxEl('vxState'); if(st) st.textContent = VX_STATE_TEXT[dock.dataset.state] || '';
  if(caption !== undefined) vxSetCaption(caption);
}
function vxSetCaption(text){
  vxCaption = text || '';   // the live line is drawn in the panel's mini transcript (vxMiniLine)
  const c = vxEl('vxCaption'); if(!c) return;
  // One line, newest words visible: trim from the front like live captions.
  const max = Math.max(24, Math.floor((c.clientWidth || 400) / 7.4));
  c.textContent = vxCaption.length > max ? '…' + vxCaption.slice(-max + 1).replace(/^\S*\s/, '') : vxCaption;
}
let vxActTimer = null;
function vxActivity(text){
  if(typeof mgStatus === 'function') mgStatus(text);
  const a = vxEl('vxAct'); if(!a) return;
  a.textContent = text; a.classList.add('on');
  clearTimeout(vxActTimer); vxActTimer = setTimeout(() => a.classList.remove('on'), 3200);
}
function vxTouch(){ vxLastActivity = Date.now(); }

/* ---------- the conversation lives in the Margyn panel ----------
   (app/js/25-margyn.js). A call is the panel in voice mode: the transcript
   is the same thread you type into, and what Margyn shows (views, tables,
   change cards) lands in it as cards. No floating windows any more. */
function vxFeed(){ return vxEl('vxFeed'); }
/* "Show the workspace" = make sure the panel is open. */
function vxDeskOpen(open){ if(open !== false && typeof mgrOpen === 'function') mgrOpen(); }
function vxCards(){ const f = vxFeed(); return f ? [...f.querySelectorAll(':scope > .vx-card')] : []; }
function vxClearWorkspace(){
  // A change still waiting for an OK stays: clearing must never hide it.
  vxCards().forEach(c => { if(!(vxPending && vxPending.card === c)) c.remove(); });
}
/* On a page change, cards about the old page fold to their title rather than
   vanish: they're part of the conversation. A change waiting for an OK stays open. */
function vxTidyWorkspace(){
  const now = Date.now();
  vxCards().forEach(c => { if(!(vxPending && vxPending.card === c) && now - Number(c.dataset.at || 0) > 4000) c.classList.add('vx-old'); });
}
/* Transcript lines are chat rows in the panel, updated in place while they stream. */
function vxAddLine(who, text, id){ if(typeof mgrLine === 'function') mgrLine(who === 'user' ? 'user' : 'margyn', text, id); }
function vxMiniLine(who, text, id){ vxAddLine(who, text, id); }
function vxMiniReset(){ if(typeof mgrSuggest === 'function') mgrSuggest(); }
const VX_MAX_CARDS = 14;
/* Cards join the conversation at the bottom. `key` makes a view replace its
   older copy ("show P&L" twice refreshes one card instead of stacking two). */
function vxAddCard(html, cls, key){
  const f = vxFeed(); if(!f) return null;
  if(key){ const old = f.querySelector(':scope > [data-key="' + key + '"]'); if(old && !(vxPending && vxPending.card === old)) old.remove(); }
  const card = document.createElement('div');
  card.className = 'vx-card' + (cls ? ' ' + cls : '');
  card.dataset.at = Date.now();
  if(key) card.dataset.key = key;
  card.innerHTML = html;
  f.appendChild(card);
  const all = vxCards();
  all.slice(0, Math.max(0, all.length - VX_MAX_CARDS)).forEach(c => { if(!(vxPending && vxPending.card === c)) c.remove(); });
  vxFocusCard(card);
  vxDeskOpen(true);
  return card;
}
/* The newest card is open; older ones fold to their title (a change card
   waiting for an OK never folds). Clicking a folded card opens it again. */
function vxFocusCard(card){
  if(!card) return;
  vxCards().forEach(c => c.classList.toggle('vx-old', c !== card && !(vxPending && vxPending.card === c)));
  requestAnimationFrame(() => { const f = vxFeed(); if(f) f.scrollTop = f.scrollHeight; });
}
function vxPersist(role, content){
  if(!content) return;
  if(typeof mgrRemember === 'function') mgrRemember(role, content);
  if(!vxThreadKey || typeof saveChatMessage !== 'function') return;
  saveChatMessage(vxThreadKey, 'Voice conversation', role, String(content).slice(0, 4000), 'margyn');
}

/* ---------- audio level -> orb ---------- */
function vxAnalyser(stream){
  try {
    if(!vxAudioCtx) vxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = vxAudioCtx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.7;
    vxAudioCtx.createMediaStreamSource(stream).connect(an);
    return an;
  } catch(e){ return null; }
}
function vxLevel(an){
  if(!an) return 0;
  const buf = new Uint8Array(an.fftSize); an.getByteTimeDomainData(buf);
  let sum = 0; for(let i = 0; i < buf.length; i++){ const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}
function vxDrawOrb(){
  const cv = vxEl('vxOrb'); if(!cv || !vxActive){ vxRaf = null; return; }
  const dpr = window.devicePixelRatio || 1, S = 44;
  if(cv.width !== S * dpr){ cv.width = S * dpr; cv.height = S * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, S, S);
  const css = getComputedStyle(document.documentElement);
  const emerald = css.getPropertyValue('--emerald').trim() || '#0E8F5C', orange = css.getPropertyValue('--orange').trim() || '#CC5B34';
  const t = performance.now() / 1000, c = S / 2;
  const state = vxEl('vxDock') ? vxEl('vxDock').dataset.state : vxState;
  const lvl = state === 'speaking' ? vxLevel(vxOutAn) : state === 'muted' ? 0 : vxLevel(vxMicAn);
  const col = state === 'speaking' ? orange : state === 'muted' || state === 'connecting' ? '#8B93A0' : emerald;
  // halo
  const halo = 11 + lvl * 9 + (state === 'listening' ? Math.sin(t * 2.2) * 1.2 : 0);
  ctx.globalAlpha = 0.16; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c, c, halo + 5, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.28; ctx.beginPath(); ctx.arc(c, c, halo, 0, Math.PI * 2); ctx.fill();
  // core
  ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(c, c, 9 + lvl * 2.5, 0, Math.PI * 2); ctx.fill();
  if(state === 'thinking' || state === 'connecting'){
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(c, c, 17, t * 4, t * 4 + Math.PI * 0.7); ctx.stroke();
  }
  vxRaf = requestAnimationFrame(vxDrawOrb);
}

/* ---------- what the user is looking at ---------- */
function vxScreenBrief(){
  try { return { page:mgCurrentView, label:vxLabel(mgCurrentView) }; } catch(e){ return null; }
}
function vxPartyNames(){
  const names = new Set();
  ['recv', 'pay'].forEach(d => vxGroups(d).slice().sort((a, b) => b.amount - a.amount).slice(0, 20).forEach(g => names.add(g.party)));
  return [...names];
}
/* ---------- memory across channels ----------
   The last conversation the owner had with Margyn anywhere (their own
   WhatsApp thread, an earlier call, or Ask Margyn chat), if it was recent.
   Sent with the session so Margyn can offer to pick it up. Both tables are
   readable by the signed-in user under RLS; nothing new is exposed. */
const VX_RESUME_HOURS = 72;
let vxRecent = null;
function vxAgo(iso){
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? m + ' minute' + (m === 1 ? '' : 's') + ' ago' : m < 1440 ? Math.round(m / 60) + ' hour' + (Math.round(m / 60) === 1 ? '' : 's') + ' ago' : Math.round(m / 1440) + ' day' + (Math.round(m / 1440) === 1 ? '' : 's') + ' ago';
}
async function vxRecentConversation(){
  if(!sbClient || !currentUser) return null;
  const since = new Date(Date.now() - VX_RESUME_HOURS * 3600000).toISOString();
  const clean = (role, text) => ({ role, text:String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400) });
  const cands = [];
  if(typeof mgActor === 'undefined' || !mgActor || mgActor.isOwner) try {
    // Only the owner's own thread: other people on the account have theirs.
    const own = String((currentProfile && currentProfile.whatsapp_phone) || '').replace(/[^\d]/g, '');
    const { data } = await sbClient.from('whatsapp_conversations').select('role,content,created_at,from_phone')
      .eq('profile_id', currentUser.id).in('role', ['user', 'assistant']).gte('created_at', since)
      .order('created_at', { ascending:false }).limit(24);
    const rows = (data || []).filter(r => r.content && r.content.trim() && (!r.from_phone || !own || String(r.from_phone).replace(/[^\d]/g, '') === own));
    if(rows.length) cands.push({ channel:'whatsapp', label:'WhatsApp', last_at:rows[0].created_at, turns:rows.slice(0, 12).reverse().map(r => clean(r.role, r.content)) });
  } catch(e){ /* table missing or offline: no WhatsApp memory, carry on */ }
  try {
    let q = sbClient.from('chat_messages').select('thread_key,role,content,created_at').eq('user_id', currentUser.id).gte('created_at', since);
    if(typeof mgChatScope === 'function') q = mgChatScope(q);   // this person's own conversations
    const { data } = await q.order('created_at', { ascending:false }).limit(40);
    const rows = (data || []).filter(r => r.content && r.content.trim() && (r.role === 'user' || r.role === 'assistant'));
    if(rows.length){
      const key = rows[0].thread_key;
      const t = rows.filter(r => r.thread_key === key);
      const voice = String(key).startsWith('voice:');
      cands.push({ channel:voice ? 'voice' : 'app', label:voice ? 'our last call' : 'Ask Margyn in the app', last_at:t[0].created_at, thread_key:key, turns:t.slice(0, 12).reverse().map(r => clean(r.role, r.content)) });
    }
  } catch(e){}
  if(!cands.length) return null;
  const best = cands.sort((a, b) => new Date(b.last_at) - new Date(a.last_at))[0];
  best.ago = vxAgo(best.last_at);
  return best;
}
/* The recap shows what the last conversation was about: Margyn's last real
   answer and the question before it. The last two raw lines were often
   commands or mis-heard noise ("Close the workspace.", "An end of conversation."). */
function vxRecap(turns){
  const words = t => String(t.text || '').split(/\s+/).filter(Boolean).length;
  const i = turns.map((t, k) => (t.role === 'assistant' && words(t) >= 6) ? k : -1).filter(k => k >= 0).pop();
  if(i == null) return turns.filter(t => words(t) >= 5).slice(-2);
  const q = turns.slice(0, i).reverse().find(t => t.role === 'user' && words(t) >= 3);
  return q ? [q, turns[i]] : [turns[i]];
}
let vxResumeCard = null;
function vxDropResume(){
  const c = vxResumeCard; vxResumeCard = null;
  if(!c || !c.parentNode) return;
  c.remove();
  const f = vxFeed(); if(f && !f.children.length) vxDeskOpen(false);
}
function vxResumeChoice(r){
  const where = r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'voice' ? 'our last call' : 'Ask Margyn';
  const recap = vxRecap(r.turns);
  const card = vxAddCard('<h4>Pick up where you left off?</h4><div class="vx-note">You were last talking to Margyn on ' + escapeHtml(where) + ', ' + escapeHtml(r.ago) + '.</div>' +
    (recap.length ? '<div class="vx-recap">' + recap.map(t => '<div><b>' + (t.role === 'user' ? 'You' : 'Margyn') + ':</b> ' + escapeHtml(t.text.slice(0, 140)) + (t.text.length > 140 ? '…' : '') + '</div>').join('') + '</div>' : '') +
    '<div class="vx-choice"><button type="button" class="vx-idea on" data-resume="yes">Continue from ' + escapeHtml(r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'voice' ? 'last call' : 'chat') + '</button><button type="button" class="vx-idea" data-resume="no">Start fresh</button></div>', 'vx-resume');
  vxResumeCard = card;
  card.addEventListener('click', e => {
    const b = e.target.closest('[data-resume]'); if(!b) return;
    vxSendText(b.dataset.resume === 'yes' ? "Let's pick up where we left off." : "Let's start fresh.");
  });
}

/* A note to the model that isn't the user speaking. `reply` asks it to say
   something about it (only when it isn't mid-answer). */
function vxTellModel(text, reply){
  if(!vxActive) return;
  rtSend({ type:'conversation.item.create', item:{ type:'message', role:'system', content:[{ type:'input_text', text }] } });
  if(reply) vxRequestReply();
}
/* Ask Margyn to speak now, or the moment the current reply ends. A
   response.create sent while another reply is running is rejected by OpenAI
   ("conversation_already_has_active_response"), and that error used to be
   ignored: a finished search, a deep answer or "your sync is done" was then
   never said, and Margyn went quiet until asked again. */
function vxRequestReply(){
  if(!vxActive) return;
  if(vxResponseActive){ vxWantReply = true; return; }
  // A reply was just asked for but hasn't started: it won't see what came in
  // after the ask, so another one is owed once it ends.
  if(Date.now() - vxCreateSentAt < 2500){ vxWantAfterCreate = true; return; }
  vxWantReply = false; vxWantAfterCreate = false; vxCreateSentAt = Date.now();
  rtSend({ type:'response.create' });
}
function vxFlushReply(){ if(vxWantReply && !vxResponseActive){ vxCreateSentAt = 0; vxRequestReply(); } }

/* ---------- start / stop ---------- */
async function openRealtimeOverlay(){
  if(vxActive) return;
  if(!navigator.mediaDevices || !window.RTCPeerConnection){
    toast('Talking to Margyn needs a modern browser', { sub:'Try Chrome, Edge or Safari' });
    return;
  }
  const dock = vxEl('vxDock'); if(!dock) return;
  vxActive = true; vxEnding = false; vxMuted = false; vxRecent = null; vxResumeCard = null; vxUtterances = []; vxThinkHistory = []; vxCallsThisResponse = []; vxResponseActive = false; vxWantReply = false; vxWantAfterCreate = false; vxCreateSentAt = 0;
  // One conversation: the call joins the panel's thread, typed lines and all.
  vxThreadKey = typeof mgrThreadKey === 'function' ? mgrThreadKey() : 'voice:' + new Date().toISOString();
  document.body.classList.add('vx-on');
  if(typeof mgrOpen === 'function') mgrOpen();
  dock.classList.remove('hidden');
  vxSetState('connecting', 'Getting Margyn on the line…');
  vxTouch();
  if(!vxRaf) vxRaf = requestAnimationFrame(vxDrawOrb);
  try {
    // Already talking in the panel: the call carries straight on from it.
    const inPanel = typeof mgrHistory !== 'undefined' && mgrHistory.length
      ? { channel:'app', ago:'just now', continuing:true, turns:mgrHistory.slice(-12).map(m => ({ role:m.role, text:m.content })) } : null;
    const [headers, recent] = await Promise.all([voiceAuthHeaders(), inPanel ? Promise.resolve(inPanel) : vxRecentConversation().catch(() => null)]);
    vxRecent = recent;
    const [sessRes, stream] = await Promise.all([
      fetch('/api/ask-margyn?action=realtime-session', {
        method:'POST', headers:{ 'Content-Type':'application/json', ...headers },
        body:JSON.stringify({ context:(typeof mgrContext === 'function') ? mgrContext() : (typeof buildMargynContext === 'function') ? buildMargynContext() : {}, screen:vxScreenBrief(), parties:vxPartyNames(), recent })
      }),
      navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } })
    ]);
    rtStream = stream;
    if(!vxActive){ stream.getTracks().forEach(t => t.stop()); return; }   // ended while connecting
    const sessData = await sessRes.json().catch(() => ({}));
    if(!sessRes.ok || !sessData.client_secret) throw new Error((sessData && sessData.error) || 'Could not start a live conversation');
    const model = sessData.model || 'gpt-realtime';
    vxMicAn = vxAnalyser(rtStream);

    rtPc = new RTCPeerConnection();
    rtPc.ontrack = (e) => {
      const audio = vxEl('rtRemoteAudio');
      if(audio) audio.srcObject = e.streams[0];
      vxOutAn = vxAnalyser(e.streams[0]);
    };
    rtPc.onconnectionstatechange = () => {
      if(rtPc && ['failed', 'disconnected'].includes(rtPc.connectionState) && vxActive){
        toast('The call dropped', { sub:'Tap the mic to start again' }); closeRealtimeOverlay();
      }
    };
    rtStream.getTracks().forEach(track => rtPc.addTrack(track, rtStream));
    rtDc = rtPc.createDataChannel('oai-events');
    rtDc.addEventListener('open', () => {
      vxSetState('listening', '');
      // A system note, not response.instructions: those would replace the
      // session prompt (and its snapshot) for this response.
      const who = (typeof mgrName !== 'undefined' && mgrName) ? ' Greet ' + mgrName + ' by first name.' : '';
      if(typeof mgrOpen === 'function'){
        // From the Margyn panel: the panel already said hello and shows the
        // conversation, so the call just says hi and listens. Past
        // conversations stay in Margyn's memory for if they bring them up.
        vxTellModel('Open the call: say hi' + (who ? ' to ' + mgrName : '') + ' and ask what they want to do, in under eight words, in English. Nothing else: no figures, no past conversations.', true);
      } else if(vxRecent && vxRecent.continuing){
        vxTellModel('You are joining the conversation they were just having with you in the Margyn panel (the RECENT CONVERSATION). Say a very short hello' + (who ? ' using their first name' : '') + ', then pick up naturally: if their last request is still open, get on with it; otherwise ask what is next. Under 20 words. No figures yet.', true);
      } else if(vxRecent){
        vxResumeChoice(vxRecent);
        vxTellModel('Open the call now. One short greeting that fits the time of day in India.' + who + ' Then say that last time, on ' + (vxRecent.channel === 'whatsapp' ? 'WhatsApp' : vxRecent.channel === 'voice' ? 'your last call' : 'Ask Margyn in the app') + ' ' + vxRecent.ago + ', you were talking about <the topic of the RECENT CONVERSATION in five words or fewer>, and ask if they want to pick that up or start something new. Under 30 words. No tools, no figures yet.', true);
      } else {
        vxTellModel('Open the call now. One short greeting that fits the time of day in India.' + who + ' Then, in one sentence, the single thing that most needs their attention according to your snapshot (an overdue customer, a cash dip, a pending decision), with the amount. Then ask what they want to do. Under 25 words in total. No tools for this greeting.', true);
      }
      vxIdleTimer = setInterval(() => {
        if(vxActive && Date.now() - vxLastActivity > VX_IDLE_MS){ toast('Ended the call after a quiet few minutes'); closeRealtimeOverlay(); }
      }, 15000);
    });
    rtDc.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch(err){ return; } vxOnEvent(m); });

    const offer = await rtPc.createOffer();
    await rtPc.setLocalDescription(offer);
    // GA SDP exchange: multipart `sdp` + `session` to /v1/realtime/calls.
    const fd = new FormData();
    fd.set('sdp', offer.sdp);
    fd.set('session', JSON.stringify({ type:'realtime', model }));
    const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', { method:'POST', headers:{ 'Authorization':'Bearer ' + sessData.client_secret }, body:fd });
    if(!sdpRes.ok) throw new Error('Could not connect the live audio');
    await rtPc.setRemoteDescription({ type:'answer', sdp:await sdpRes.text() });
    if(typeof mtrack === 'function') mtrack('voice_call_started', { page:mgCurrentView });
  } catch(err){
    console.error('openRealtimeOverlay error:', err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(denied ? 'Microphone access is blocked' : 'Could not start the call', { sub:denied ? 'Allow the microphone for this site, then try again' : ((err && err.message) || 'Try again') });
    closeRealtimeOverlay();
  }
}

function closeRealtimeOverlay(){
  vxActive = false;
  document.body.classList.remove('vx-on');
  const dock = vxEl('vxDock'); if(dock) dock.classList.add('hidden');
  vxDeskOpen(false);
  clearInterval(vxIdleTimer); vxIdleTimer = null;
  try { if(rtDc) rtDc.close(); } catch(e){}
  try { if(rtPc) rtPc.close(); } catch(e){}
  if(rtStream) rtStream.getTracks().forEach(t => t.stop());
  const audio = vxEl('rtRemoteAudio'); if(audio) audio.srcObject = null;
  rtDc = null; rtPc = null; rtStream = null; vxMicAn = null; vxOutAn = null;
  if(vxAudioCtx){ try { vxAudioCtx.close(); } catch(e){} vxAudioCtx = null; }
  if(vxPending){ try { vxResolveCard(vxPending, 'Call ended before this was confirmed. Nothing changed.'); } catch(e){} }
  vxPending = null;
  // "Close Margyn" on a call: the panel goes too, once the goodbye has played.
  if(window.__mgrCloseAfterCall){ window.__mgrCloseAfterCall = false; if(typeof mgrClose === 'function') mgrClose(); }
}
/* end_conversation: let the sign-off finish playing first. */
function vxEndAfterSpeech(){
  vxEnding = true;
  setTimeout(() => { if(vxActive && vxEnding) closeRealtimeOverlay(); }, 8000);
}
/* "Thank you, that's all", "okay that was it", "end the conversation", "bye":
   the call ends by itself after a short goodbye, whether or not the model
   remembers end_conversation. Only short sign-offs count: "Thank you. Can you
   close the workspace?" is a request, not a goodbye. */
const VX_BYE = /(\bthank(s| you| u)\b|shukriya|dhanyavaad|dhanyavad|that'?s (all|it|everything)|that (is|was) (all|it|everything)|(we'?re|i'?m|we are|i am) (done|good)|(end|close|stop|finish) (the |this |our )?(call|conversation|chat|session)|\bbye\b|good ?bye|talk (to you )?later|see you|bas itna|ho gaya)/i;
const VX_NOT_BYE = /\?|\b(can|could|would|will) you\b|\b(show|open|close the workspace|clear|what|how|why|when|where|which|who|tell me|also|and then|but|next|another|one more)\b/i;
function vxIsGoodbye(text){
  const t = String(text || '').trim();
  return !!t && t.split(/\s+/).length <= 10 && VX_BYE.test(t) && !VX_NOT_BYE.test(t);
}
function vxGoodbye(){
  if(vxEnding) return;
  vxEnding = true;
  vxActivity('Ending the call');
  // A reply may already be on its way (the model heard it before the words
  // were transcribed); it ends the call when it finishes playing. If not,
  // ask for a two-second goodbye.
  if(!vxResponseActive) vxTellModel('The user is ending the call. Say a warm goodbye in under eight words, in their language. Do not call any tool.', true);
  setTimeout(() => { if(vxActive && vxEnding) closeRealtimeOverlay(); }, 8000);
}

function vxToggleMute(force){
  vxMuted = force === undefined ? !vxMuted : force;
  if(rtStream) rtStream.getAudioTracks().forEach(t => { t.enabled = !vxMuted; });
  const b = vxEl('vxMuteBtn');
  if(b){ b.classList.toggle('on', vxMuted); b.setAttribute('aria-pressed', vxMuted ? 'true' : 'false'); b.title = vxMuted ? 'Unmute' : 'Mute'; }
  vxSetState(vxState);
}

/* Typed input goes into the same call: for noisy rooms, or spelling a name. */
function vxSendText(text){
  text = String(text || '').trim(); if(!text || !vxActive) return;
  vxUtterances.push({ at:Date.now(), text });
  vxNudges = 0; vxDropResume(); vxLastUserText = text; vxCallsSinceCommit = 0;
  vxAddLine('user', text);
  vxPersist('user', text);
  vxTouch();
  if(vxIsGoodbye(text)){ rtSend({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text }] } }); vxGoodbye(); return; }
  rtSend({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text }] } });
  if(vxResponseActive){ rtSend({ type:'response.cancel' }); vxWantReply = true; }   // answer the typed message once the cancel lands
  else vxRequestReply();
}
/* The confirm gate waits briefly for the transcript of the "yes" that
   triggered the tool call; transcription can land just after it. */
async function vxAwaitUtteranceAfter(t, maxMs){
  const until = Date.now() + maxMs;
  while(Date.now() < until){
    const u = vxUtterances.filter(x => x.at > t);
    if(u.length) return u[u.length - 1].text;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

const VX_PROMPT_ECHO = /Roman \(Latin\) letters|Urdu, Arabic or Devanagari|mix of the two \(Hinglish\)/i;
/* Anything not in Roman letters: Devanagari, Urdu/Arabic, Gujarati, Bengali,
   Gurmukhi, Cyrillic, Hebrew. Shown in Roman Hinglish instead (vxRomanize). */
const VX_ODD_SCRIPT = /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const VX_NOISE_SCRIPT = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF]/;
let vxSpokeSinceUser = false;
/* Lines are batched (a reply and the question before it often land together)
   and sent to a small, cheap model that rewrites them in Roman letters. */
let vxRomanQueue = [], vxRomanTimer = null, vxRomanCount = 0;
const VX_ROMAN_MAX = 80;   // per page load; beyond that the original script shows
function vxRomanize(text){
  if(!text || vxRomanCount >= VX_ROMAN_MAX) return Promise.resolve(null);
  vxRomanCount++;
  return new Promise(resolve => {
    vxRomanQueue.push({ text, resolve });
    clearTimeout(vxRomanTimer);
    vxRomanTimer = setTimeout(vxRomanFlush, 250);
  });
}
async function vxRomanFlush(){
  const batch = vxRomanQueue.splice(0, 8); if(!batch.length) return;
  try {
    const res = await fetch('/api/ask-margyn?action=romanize', { method:'POST', headers:{ 'Content-Type':'application/json', ...(await voiceAuthHeaders()) }, body:JSON.stringify({ texts:batch.map(b => b.text) }) });
    const d = await res.json();
    batch.forEach((b, i) => { const t = d && !d.failed && d.texts && d.texts[i]; b.resolve(t && !VX_ODD_SCRIPT.test(t) ? t : null); });
  } catch(e){ batch.forEach(b => b.resolve(null)); }
  if(vxRomanQueue.length) vxRomanTimer = setTimeout(vxRomanFlush, 0);
}
/* "One sec, let me pull that up" with no tool call behind it. Asking
   permission ("Shall I open it?") is fine and doesn't count. */
const VX_PROMISE = /\b(one (sec|second|moment)|just a (sec|second|moment)|give me a (sec|second|moment)|let me|i'?ll (now )?(pull|open|get|show|put|draw|create|make|set|check|sync|run|bring|summari[sz]e|write|go|add|log|draft)|i am (pulling|opening|setting|creating)|pulling (that |it |this )?up|opening (that|it|the)|setting (that |it )?up|ek (second|minute|pal)|abhi (dikhata|dikhati|kholta|kholti|karta|karti|laata|lati))/i;
const VX_ASKS = /\b(shall i|should i|would you like|do you want|want me to|kya main|karoon|karun)\b[^.!]*\?\s*$/i;
function vxBrokenPromise(said){ said = String(said || '').trim(); return !!said && VX_PROMISE.test(said) && !VX_ASKS.test(said); }

/* Every turn gets an answer. In the recording, "Open it." and "Open that up,
   please." got silence: either no response started, or one finished with no
   words and no tool. Both are caught here and the model is asked again, once. */
let vxLastUserText = '', vxCallsSinceCommit = 0, vxLastCommitAt = 0, vxLastResponseAt = 0, vxReplyTimer = null;
/* Armed when the turn is committed, not when its transcript lands: a line
   the transcriber returned empty (noise, wrong script) never armed it, and
   that turn got no answer ("I have to say it two or three times"). */
function vxWatchReply(){
  clearTimeout(vxReplyTimer);
  // Long enough that the server's own reply has always started by then:
  // at 3.5s the watchdog could race it and Margyn answered the same line twice.
  vxReplyTimer = setTimeout(() => {
    if(vxActive && !vxEnding && !vxResponseActive && vxState !== 'speaking' && vxLastResponseAt < vxLastCommitAt) vxRequestReply();
  }, 6000);
}
/* Tools that only draw or move the screen. When Margyn already answered in
   full while calling them, a second reply is just "it's in the workspace now". */
const VX_DISPLAY_TOOLS = ['show_view', 'show_note', 'show_table', 'show_chart', 'clear_workspace', 'navigate', 'open_party', 'filter_list', 'run_command', 'fill_form'];
/* Tools that take seconds: say so on the panel, so a quiet moment reads as work, not a hang. */
const VX_SLOW_TOOLS = { think:'Thinking it through…', propose_change:'Preparing the change…', save_form:'Saving…', confirm_pending_change:'Applying…' };
let vxToolFailed = false;

/* ---------- realtime events ---------- */
function vxOnEvent(m){
  switch(m.type){
    case 'input_audio_buffer.speech_started':
      vxTouch(); vxSetState('hearing', ''); break;
    case 'input_audio_buffer.committed':
      vxNudges = 0; vxLastCommitAt = Date.now(); vxCallsSinceCommit = 0; vxSpokeSinceUser = false;
      if(m.item_id) vxAddLine('user', '', m.item_id);   // placeholder keeps transcript order right
      vxWatchReply();
      vxSetState('thinking', ''); break;
    case 'conversation.item.input_audio_transcription.completed': {
      let text = (m.transcript || '').trim();
      // On background noise a transcriber can read its own instruction back:
      // that isn't the user talking.
      if(VX_PROMPT_ECHO.test(text)) text = '';
      // Noise that came back as Korean, Japanese, Chinese, Thai, Greek, Russian...:
      // nobody here speaks those, so it isn't shown or kept.
      if(VX_NOISE_SCRIPT.test(text)) text = '';
      // "What does our cash look like? What does our cash look like?": the transcriber doubled it.
      const twice = text.match(/^(.{6,}?[.?!]?)\s+\1$/i); if(twice) text = twice[1];
      // Hindi and Urdu sound the same, so a line can still come back in Urdu
      // (Arabic) script, or Gujarati, Cyrillic... Margyn heard the audio itself
      // and answers correctly; only the written line is off. Show that plainly
      // instead of a script the user doesn't read, and keep it out of the
      // spoken-yes check (it can't be matched reliably).
      if(text && VX_ODD_SCRIPT.test(text)){
        // Written in Roman letters before it's shown or saved (see vxRomanize).
        const id = m.item_id;
        vxAddLine('user', '…', id); vxDropResume(); vxLastUserText = text;
        vxRomanize(text).then(r => {
          const roman = r || '(spoken in Hindi)';
          vxAddLine('user', roman, id); vxPersist('user', r || text);
          if(r){ vxUtterances.push({ at:Date.now(), text:r }); vxLastUserText = r; if(vxIsGoodbye(r)) vxGoodbye(); }
        });
        break;
      }
      if(text){
        vxUtterances.push({ at:Date.now(), text }); vxAddLine('user', text, m.item_id); vxPersist('user', text); vxDropResume();
        vxLastUserText = text;
        if(vxIsGoodbye(text)) vxGoodbye();
      }
      else document.querySelectorAll('#vxFeed [data-item="' + m.item_id + '"], #vxMini [data-item="' + m.item_id + '"]').forEach(r => r.remove());
      break;
    }
    case 'conversation.item.input_audio_transcription.failed': {
      document.querySelectorAll('#vxFeed [data-item="' + m.item_id + '"], #vxMini [data-item="' + m.item_id + '"]').forEach(r => r.remove()); break;
    }
    case 'response.created':
      // This reply reads everything said and every result handed in so far, so a reply owed until now is covered.
      vxResponseActive = true; vxWantReply = vxWantAfterCreate; vxWantAfterCreate = false; vxCreateSentAt = 0; vxCallsThisResponse = []; vxCaption = ''; vxToolFailed = false; vxLastResponseAt = Date.now(); break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      if(m.delta){ vxSpokeSinceUser = true; vxSetState('speaking'); vxSetCaption(vxCaption + m.delta); vxAddLine('margyn', VX_ODD_SCRIPT.test(vxCaption) ? '…' : vxCaption, 'r' + m.response_id); }
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if(m.transcript){
        vxLastSaid = m.transcript;
        if(VX_ODD_SCRIPT.test(m.transcript)){
          const id = 'r' + m.response_id, said = m.transcript;
          vxRomanize(said).then(r => { vxAddLine('margyn', r || said, id); vxPersist('assistant', r || said); });
        } else { vxAddLine('margyn', m.transcript, 'r' + m.response_id); vxPersist('assistant', m.transcript); }
      }
      break;
    case 'output_audio_buffer.started':
      vxSetState('speaking'); break;
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      vxTouch();
      if(vxEnding){ closeRealtimeOverlay(); break; }
      if(!vxResponseActive) vxSetState('listening');
      break;
    case 'response.function_call_arguments.done':
      vxCallsSinceCommit++; vxCallsThisResponse.push(vxRunTool(m)); break;
    case 'response.done': {
      vxResponseActive = false;
      const calls = vxCallsThisResponse; vxCallsThisResponse = [];
      const said = vxLastSaid || vxCaption; vxLastSaid = '';
      vxSetCaption('');
      const status = m.response && m.response.status;
      if(calls.length) vxNudges = 0;
      else if(vxActive && !vxEnding && vxNudges < 1 && status === 'completed' && !String(said).trim() && vxLastUserText && !vxCallsSinceCommit){
        // Finished with nothing said and nothing done.
        vxNudges++;
        vxTellModel('The user said "' + vxLastUserText.slice(0, 160) + '" and you did not answer. Answer now: if it asks you to open, show or do something, call the right tool; if it is unclear, ask one short question.', true);
        break;
      }
      else if(vxActive && !vxEnding && vxNudges < 2 && status === 'completed' && !String(said).trim() && !vxSpokeSinceUser && vxCallsSinceCommit > 0){
        // Did something ("Yes, open.") and then said nothing about it.
        vxNudges++;
        vxTellModel('You just did that but said nothing. Tell the user in one short sentence what you did or found' + (vxToolFailed ? ' (a tool reported a problem: say what, and what they can do)' : '') + '.', true);
        break;
      }
      else if(vxActive && !vxEnding && vxNudges < 1 && vxBrokenPromise(said)){
        // It said "one sec, let me pull that up" and stopped. Make it act now,
        // instead of the user having to ask "why haven't you done it?".
        vxNudges++;
        vxTellModel('You just told the user you would do something ("' + said.slice(0, 160) + '") but ended your turn without calling any tool. Do it now: call the right tool immediately, without repeating the filler. If no tool can do it, say so in one short sentence.', true);
        break;
      }
      if(calls.length){
        vxSetState('thinking');
        const spokeInFull = String(said).trim().split(/\s+/).length >= 12 && !vxBrokenPromise(said);
        // Every tool output must be in before the next response starts.
        Promise.all(calls).then(names => {
          if(!vxActive || names.includes('end_conversation')) return;
          // Already answered and only drew something: don't talk again.
          if(spokeInFull && !vxToolFailed && names.every(n => VX_DISPLAY_TOOLS.includes(n))){ if(vxState !== 'speaking') vxSetState('listening'); return; }
          vxRequestReply();
        });
        // The reply that narrates these results is asked for once they're all in.
        vxWantReply = false;
      } else if(vxWantReply) vxFlushReply();
      else if(vxState !== 'speaking') vxSetState('listening');
      break;
    }
    case 'error': {
      const code = m.error && m.error.code;
      if(code === 'response_cancel_not_active') break;
      // Another reply was still running: say it as soon as that one ends.
      if(code === 'conversation_already_has_active_response'){ vxCreateSentAt = 0; vxWantReply = true; vxWantAfterCreate = false; break; }
      console.error('Realtime error event:', m);
      toast('Margyn hit a snag on the call', { sub:(m.error && m.error.message) || 'Try again' });
      break;
    }
  }
}

/* A look-up that takes longer than a few seconds carries on in the
   background: Margyn says it's still on it, and speaks the answer the moment
   it lands, without being asked again. Changes (saving, applying, a proposed
   change) always wait for their real result, so nothing is done twice. */
const VX_BG_AFTER_MS = 6000;
const VX_WAIT_TOOLS = ['propose_change', 'confirm_pending_change', 'save_form', 'fill_form', 'end_conversation'];
const VX_LATE = {};
async function vxRunTool(m){
  let args = {}; try { args = JSON.parse(m.arguments || '{}'); } catch(e){}
  const fn = VX_TOOLS[m.name];
  let out;
  vxTouch();
  if(VX_SLOW_TOOLS[m.name]) vxActivity(VX_SLOW_TOOLS[m.name]);
  const run = (async () => {
    try { return fn ? await fn(args) : { error:'Unknown tool ' + m.name }; }
    catch(e){ console.error('[voice] tool ' + m.name, e); return { error:(e && e.message) || 'That failed.' }; }
  })();
  out = VX_WAIT_TOOLS.includes(m.name) ? await run
    : await Promise.race([run, new Promise(r => setTimeout(() => r(VX_LATE), VX_BG_AFTER_MS))]);
  if(out === VX_LATE){
    vxActivity('Still working on it…');
    run.then(res => vxLateResult(m.name, res));
    out = { still_working:true, note:'This is taking a few more seconds and is still running. Tell the user in under ten words that you are on it and will tell them the moment it is ready. Do not guess the answer and do not call this tool again: the result will be handed to you.' };
  }
  if(out && (out.error || out.ok === false || out.shown === false || out.found === false)) vxToolFailed = true;
  let s = JSON.stringify(out === undefined ? { ok:true } : out);
  // Every tool result stays in the conversation and is re-read on every later
  // turn, so keep them small. The tools return compact summaries by design.
  if(s.length > 3500) s = s.slice(0, 3500) + '…(trimmed)';
  rtSend({ type:'conversation.item.create', item:{ type:'function_call_output', call_id:m.call_id, output:s } });
  return m.name;
}

/* The background result is in: Margyn says it now. If the call ended in the
   meantime, a deep answer still lands in the panel. */
function vxLateResult(name, out){
  vxTouch();
  // sync_source announces its own finish (see VX_TOOLS.sync_source).
  if(out && out.still_running) return;
  if(!vxActive){
    if(out && out.answer){ vxAddLine('margyn', out.answer); vxPersist('assistant', out.answer); if(typeof mgrDoneNotice === 'function') mgrDoneNotice(out.answer); }
    return;
  }
  vxActivity(out && out.error ? 'That ran into a problem' : 'Got it');
  let s = JSON.stringify(out === undefined ? { ok:true } : out);
  if(s.length > 3500) s = s.slice(0, 3500) + '…(trimmed)';
  vxTellModel('The ' + name + ' you started earlier has finished. Result: ' + s + '\nTell the user now, briefly and in your own words, without being asked. Keep every figure exactly as given. Do not call ' + name + ' again for this.', true);
}

/* ---------- screen awareness: tell Margyn when the user moves on their own ---------- */
(function(){
  const base = showView;
  showView = function(name){
    const out = base.apply(this, arguments);
    if(vxActive) vxTidyWorkspace();
    if(vxActive && !vxDriving){
      try { vxTellModel('The user opened the ' + vxLabel(mgCurrentView) + ' page themselves. "This page" now means that page.', false); } catch(e){}
    }
    return out;
  };
})();

/* ---------- chrome ---------- */
/* A call left running in a background tab bills for nothing. */
let vxHiddenTimer = null;
document.addEventListener('visibilitychange', () => {
  clearTimeout(vxHiddenTimer);
  if(document.hidden && vxActive) vxHiddenTimer = setTimeout(() => { if(vxActive && document.hidden){ closeRealtimeOverlay(); toast('Ended the call while the tab was in the background'); } }, VX_HIDDEN_MS);
});
(function wireVoiceDock(){
  const on = (id, ev, fn) => { const el = vxEl(id); if(el) el.addEventListener(ev, fn); };
  on('vxEndBtn', 'click', closeRealtimeOverlay);
  on('vxMuteBtn', 'click', () => vxToggleMute());
  on('vxTopBtn', 'click', () => { if(!vxActive) openRealtimeOverlay(); });
  on('vxFeed', 'click', e => { const c = e.target.closest('.vx-card.vx-old'); if(c){ e.preventDefault(); vxFocusCard(c); } });
  // Option+M or Ctrl+M: start the call; the same again ends it.
  document.addEventListener('keydown', e => {
    if(e.code !== 'KeyM' || e.metaKey || e.shiftKey || !(e.altKey || e.ctrlKey) || (e.altKey && e.ctrlKey)) return;
    e.preventDefault();
    if(vxActive) closeRealtimeOverlay(); else openRealtimeOverlay();
  });
  // Esc ends the call, unless something on top should close first (a dialog,
  // the side panel, the search palette): those take Esc as before.
  document.addEventListener('keydown', e => {
    if(e.key !== 'Escape' || !vxActive || e.defaultPrevented) return;
    if(document.querySelector('.mg-dialog-scrim') || (typeof mgDrawerEl !== 'undefined' && mgDrawerEl) || document.querySelector('.cmdk:not(.hidden)')) return;
    const t = e.target;
    if(t && t.closest && t.closest('input, textarea, select') && !t.closest('#mgrInput')) return;
    closeRealtimeOverlay();
  });
})();
