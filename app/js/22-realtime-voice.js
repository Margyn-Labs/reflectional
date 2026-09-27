/* ============================================================
   LIVE CONVERSATION — Margyn on a call, driving the app.
   OpenAI Realtime API over WebRTC (continuous speech-to-speech).

   The call lives in a floating dock, not a modal: the app stays fully
   visible and usable underneath, and Margyn moves it (pages, filters, the
   customer/vendor panel) while it talks. A side "conversation" panel holds
   the transcript plus anything Margyn puts on screen: tables, charts and
   change cards.

   Entry points: the top-bar mic, the "Talk to Margyn" pill on Ask Margyn,
   the command palette, and Alt+M anywhere (Alt+M again mutes).

   Tools run in 23-voice-tools.js. The safety line is unchanged: nothing the
   voice model does writes on its own; see that file's header for the gate.
   ============================================================ */
let rtPc = null, rtDc = null, rtStream = null;
let vxActive = false, vxMuted = false, vxDriving = false;
let vxState = 'idle', vxCaption = '', vxThreadKey = null;
let vxCallsThisResponse = [], vxResponseActive = false, vxEnding = false, vxQueuedCreate = false;
let vxUtterances = [];         // { at, text } — the user's own words (spoken or typed), for the confirm gate
let vxThinkHistory = [];       // think() thread so follow-up "why"s keep context
let vxLastActivity = 0, vxIdleTimer = null, vxAudioCtx = null, vxMicAn = null, vxOutAn = null, vxRaf = null;
const VX_IDLE_MS = 4 * 60 * 1000;   // hang up after 4 quiet minutes; a live session bills while open

function vxEl(id){ return document.getElementById(id); }
function rtSend(obj){ if(rtDc && rtDc.readyState === 'open') rtDc.send(JSON.stringify(obj)); }

/* ---------- dock state ---------- */
const VX_STATE_TEXT = { connecting:'Connecting', listening:'Listening', hearing:'Hearing you', thinking:'Working', speaking:'Margyn', muted:'Muted' };
function vxSetState(state, caption){
  vxState = state;
  const dock = vxEl('vxDock'); if(!dock) return;
  dock.dataset.state = vxMuted && state === 'listening' ? 'muted' : state;
  const st = vxEl('vxState'); if(st) st.textContent = VX_STATE_TEXT[dock.dataset.state] || '';
  if(caption !== undefined) vxSetCaption(caption);
}
function vxSetCaption(text){
  vxCaption = text || '';
  const c = vxEl('vxCaption'); if(!c) return;
  // One line, newest words visible: trim from the front like live captions.
  const max = Math.max(24, Math.floor((c.clientWidth || 400) / 7.4));
  c.textContent = vxCaption.length > max ? '…' + vxCaption.slice(-max + 1).replace(/^\S*\s/, '') : vxCaption;
}
let vxActTimer = null;
function vxActivity(text){
  const a = vxEl('vxAct'); if(!a) return;
  a.textContent = text; a.classList.add('on');
  clearTimeout(vxActTimer); vxActTimer = setTimeout(() => a.classList.remove('on'), 3200);
}
function vxTouch(){ vxLastActivity = Date.now(); }

/* ---------- conversation panel ---------- */
function vxFeed(){ return vxEl('vxFeed'); }
function vxDeskOpen(open){
  const desk = vxEl('vxDesk'), btn = vxEl('vxDeskBtn'); if(!desk) return;
  const on = open === undefined ? desk.classList.contains('hidden') : open;
  desk.classList.toggle('hidden', !on);
  if(btn){ btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.classList.toggle('on', on); }
  if(on){ const n = vxEl('vxDeskBadge'); if(n) n.classList.add('hidden'); }
}
function vxBadge(){
  const desk = vxEl('vxDesk'), n = vxEl('vxDeskBadge');
  if(desk && n && desk.classList.contains('hidden')) n.classList.remove('hidden');
}
function vxScrollFeed(){ const f = vxFeed(); if(f) f.scrollTop = f.scrollHeight; }
function vxAddLine(who, text, id){
  const f = vxFeed(); if(!f) return null;
  const empty = vxEl('vxEmpty'); if(empty) empty.remove();
  let row = id ? f.querySelector('[data-item="' + id + '"]') : null;
  if(!row){
    row = document.createElement('div');
    row.className = 'vx-line ' + who;
    if(id) row.dataset.item = id;
    row.innerHTML = '<div class="who">' + (who === 'user' ? 'You' : 'Margyn') + '</div><div class="txt"></div>';
    f.appendChild(row);
  }
  row.querySelector('.txt').textContent = text;
  row.classList.toggle('pending', !text);
  vxBadge();
  vxScrollFeed();
  return row;
}
function vxAddCard(html, cls){
  const f = vxFeed(); if(!f) return null;
  const empty = vxEl('vxEmpty'); if(empty) empty.remove();
  const card = document.createElement('div');
  card.className = 'vx-card' + (cls ? ' ' + cls : '');
  card.innerHTML = html;
  f.appendChild(card);
  vxDeskOpen(true);
  vxScrollFeed();
  return card;
}
function vxPersist(role, content){
  if(!vxThreadKey || !content || typeof saveChatMessage !== 'function') return;
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
  try {
    // Only the owner's own thread: other people on the account have theirs.
    const own = String((currentProfile && currentProfile.whatsapp_phone) || '').replace(/[^\d]/g, '');
    const { data } = await sbClient.from('whatsapp_conversations').select('role,content,created_at,from_phone')
      .eq('profile_id', currentUser.id).in('role', ['user', 'assistant']).gte('created_at', since)
      .order('created_at', { ascending:false }).limit(24);
    const rows = (data || []).filter(r => r.content && r.content.trim() && (!r.from_phone || !own || String(r.from_phone).replace(/[^\d]/g, '') === own));
    if(rows.length) cands.push({ channel:'whatsapp', label:'WhatsApp', last_at:rows[0].created_at, turns:rows.slice(0, 12).reverse().map(r => clean(r.role, r.content)) });
  } catch(e){ /* table missing or offline: no WhatsApp memory, carry on */ }
  try {
    const { data } = await sbClient.from('chat_messages').select('thread_key,role,content,created_at')
      .eq('user_id', currentUser.id).gte('created_at', since).order('created_at', { ascending:false }).limit(40);
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
function vxResumeChoice(r){
  const where = r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'voice' ? 'our last call' : 'Ask Margyn';
  const card = vxAddCard('<h4>Pick up where you left off?</h4><div class="vx-note">You were last talking to Margyn on ' + escapeHtml(where) + ', ' + escapeHtml(r.ago) + '.</div>' +
    '<div class="vx-recap">' + r.turns.slice(-2).map(t => '<div><b>' + (t.role === 'user' ? 'You' : 'Margyn') + ':</b> ' + escapeHtml(t.text.slice(0, 140)) + (t.text.length > 140 ? '…' : '') + '</div>').join('') + '</div>' +
    '<div class="vx-choice"><button type="button" class="vx-idea on" data-resume="yes">Continue from ' + escapeHtml(r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'voice' ? 'last call' : 'chat') + '</button><button type="button" class="vx-idea" data-resume="no">Start fresh</button></div>', 'vx-resume');
  card.addEventListener('click', e => {
    const b = e.target.closest('[data-resume]'); if(!b) return;
    card.querySelectorAll('[data-resume]').forEach(x => { x.disabled = true; x.classList.toggle('on', x === b); });
    vxSendText(b.dataset.resume === 'yes' ? "Let's pick up where we left off." : "Let's start fresh.");
  });
}

/* A note to the model that isn't the user speaking. `reply` asks it to say
   something about it (only when it isn't mid-answer). */
function vxTellModel(text, reply){
  if(!vxActive) return;
  rtSend({ type:'conversation.item.create', item:{ type:'message', role:'system', content:[{ type:'input_text', text }] } });
  if(reply && !vxResponseActive) rtSend({ type:'response.create' });
}

/* ---------- start / stop ---------- */
async function openRealtimeOverlay(){
  if(vxActive){ vxDeskOpen(true); return; }
  if(!navigator.mediaDevices || !window.RTCPeerConnection){
    toast('Talking to Margyn needs a modern browser', { sub:'Try Chrome, Edge or Safari' });
    return;
  }
  const dock = vxEl('vxDock'); if(!dock) return;
  vxActive = true; vxEnding = false; vxMuted = false; vxRecent = null; vxUtterances = []; vxThinkHistory = []; vxCallsThisResponse = []; vxResponseActive = false;
  vxThreadKey = 'voice:' + new Date().toISOString();
  document.body.classList.add('vx-on');
  dock.classList.remove('hidden');
  const f = vxFeed(); if(f) f.innerHTML = vxEmptyHtml();
  vxSetState('connecting', 'Getting Margyn on the line…');
  vxTouch();
  if(!vxRaf) vxRaf = requestAnimationFrame(vxDrawOrb);
  try {
    const [headers, recent] = await Promise.all([voiceAuthHeaders(), vxRecentConversation().catch(() => null)]);
    vxRecent = recent;
    const [sessRes, stream] = await Promise.all([
      fetch('/api/ask-margyn?action=realtime-session', {
        method:'POST', headers:{ 'Content-Type':'application/json', ...headers },
        body:JSON.stringify({ context:(typeof buildMargynContext === 'function') ? buildMargynContext() : {}, screen:vxScreenBrief(), parties:vxPartyNames(), recent })
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
      if(vxRecent){
        vxResumeChoice(vxRecent);
        vxTellModel('Open the call now. One short greeting that fits the time of day in India. Then say that last time, on ' + (vxRecent.channel === 'whatsapp' ? 'WhatsApp' : vxRecent.channel === 'voice' ? 'your last call' : 'Ask Margyn in the app') + ' ' + vxRecent.ago + ', you were talking about <the topic of the RECENT CONVERSATION in five words or fewer>, and ask if they want to pick that up or start something new. Under 30 words. No tools, no figures yet.', true);
      } else {
        vxTellModel('Open the call now. One short greeting that fits the time of day in India. Then, in one sentence, the single thing that most needs their attention according to your snapshot (an overdue customer, a cash dip, a pending decision), with the amount. Then ask what they want to do. Under 25 words in total. No tools for this greeting.', true);
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
}
/* end_conversation: let the sign-off finish playing first. */
function vxEndAfterSpeech(){
  vxEnding = true;
  setTimeout(() => { if(vxActive && vxEnding) closeRealtimeOverlay(); }, 6000);
}

function vxToggleMute(force){
  vxMuted = force === undefined ? !vxMuted : force;
  if(rtStream) rtStream.getAudioTracks().forEach(t => { t.enabled = !vxMuted; });
  const b = vxEl('vxMuteBtn');
  if(b){ b.classList.toggle('on', vxMuted); b.setAttribute('aria-pressed', vxMuted ? 'true' : 'false'); b.title = vxMuted ? 'Unmute (Alt+M)' : 'Mute (Alt+M)'; }
  vxSetState(vxState);
}

/* Typed input goes into the same call: for noisy rooms, or spelling a name. */
function vxSendText(text){
  text = String(text || '').trim(); if(!text || !vxActive) return;
  vxUtterances.push({ at:Date.now(), text });
  vxAddLine('user', text);
  vxPersist('user', text);
  vxTouch();
  rtSend({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text }] } });
  if(vxResponseActive){ rtSend({ type:'response.cancel' }); vxQueuedCreate = true; }   // answer the typed message once the cancel lands
  else rtSend({ type:'response.create' });
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

/* ---------- realtime events ---------- */
function vxOnEvent(m){
  switch(m.type){
    case 'input_audio_buffer.speech_started':
      vxTouch(); vxSetState('hearing', ''); break;
    case 'input_audio_buffer.committed':
      if(m.item_id) vxAddLine('user', '', m.item_id);   // placeholder keeps transcript order right
      vxSetState('thinking', ''); break;
    case 'conversation.item.input_audio_transcription.completed': {
      const text = (m.transcript || '').trim();
      if(text){ vxUtterances.push({ at:Date.now(), text }); vxAddLine('user', text, m.item_id); vxPersist('user', text); }
      else { const row = vxFeed() && vxFeed().querySelector('[data-item="' + m.item_id + '"]'); if(row) row.remove(); }
      break;
    }
    case 'conversation.item.input_audio_transcription.failed': {
      const row = vxFeed() && vxFeed().querySelector('[data-item="' + m.item_id + '"]'); if(row) row.remove(); break;
    }
    case 'response.created':
      vxResponseActive = true; vxCallsThisResponse = []; break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      if(m.delta){ vxSetState('speaking'); vxSetCaption(vxCaption + m.delta); vxAddLine('margyn', vxCaption, 'r' + m.response_id); }
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if(m.transcript){ vxAddLine('margyn', m.transcript, 'r' + m.response_id); vxPersist('assistant', m.transcript); }
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
      vxCallsThisResponse.push(vxRunTool(m)); break;
    case 'response.done': {
      vxResponseActive = false;
      const calls = vxCallsThisResponse; vxCallsThisResponse = [];
      vxSetCaption('');
      if(calls.length){
        vxSetState('thinking');
        // Every tool output must be in before the next response starts.
        Promise.all(calls).then(names => {
          if(!vxActive || names.includes('end_conversation')) return;
          rtSend({ type:'response.create' });
        });
      } else if(vxQueuedCreate) rtSend({ type:'response.create' });
      else if(vxState !== 'speaking') vxSetState('listening');
      vxQueuedCreate = false;
      break;
    }
    case 'error': {
      const code = m.error && m.error.code;
      if(['response_cancel_not_active', 'conversation_already_has_active_response'].includes(code)) break;
      console.error('Realtime error event:', m);
      toast('Margyn hit a snag on the call', { sub:(m.error && m.error.message) || 'Try again' });
      break;
    }
  }
}

async function vxRunTool(m){
  let args = {}; try { args = JSON.parse(m.arguments || '{}'); } catch(e){}
  const fn = VX_TOOLS[m.name];
  let out;
  vxTouch();
  try { out = fn ? await fn(args) : { error:'Unknown tool ' + m.name }; }
  catch(e){ console.error('[voice] tool ' + m.name, e); out = { error:(e && e.message) || 'That failed.' }; }
  let s = JSON.stringify(out === undefined ? { ok:true } : out);
  if(s.length > 12000) s = s.slice(0, 12000) + '…';   // keep the model's context lean
  rtSend({ type:'conversation.item.create', item:{ type:'function_call_output', call_id:m.call_id, output:s } });
  return m.name;
}

/* ---------- screen awareness: tell Margyn when the user moves on their own ---------- */
(function(){
  const base = showView;
  showView = function(name){
    const out = base.apply(this, arguments);
    if(vxActive && !vxDriving){
      try { vxTellModel('The user opened the ' + vxLabel(mgCurrentView) + ' page themselves. "This page" now means that page.', false); } catch(e){}
    }
    return out;
  };
})();

/* ---------- chrome ---------- */
function vxEmptyHtml(){
  const ideas = ['Who owes us the most?', 'Show me payables over 60 days', 'Will cash dip in the next 13 weeks?', 'What needs my decision today?', 'Kitna GST credit risk pe hai?', 'Log a ₹50,000 payment received from…'];
  return '<div class="vx-empty" id="vxEmpty"><div class="vx-empty-t">Talk naturally. Margyn listens, answers and moves the app for you.</div>' +
    '<div class="vx-ideas">' + ideas.map(i => '<button type="button" class="vx-idea">' + escapeHtml(i) + '</button>').join('') + '</div>' +
    '<div class="vx-fine">Changes always show a card first. Nothing is saved until you say yes or tap Confirm.</div></div>';
}
(function wireVoiceDock(){
  const on = (id, ev, fn) => { const el = vxEl(id); if(el) el.addEventListener(ev, fn); };
  on('vxEndBtn', 'click', closeRealtimeOverlay);
  on('vxMuteBtn', 'click', () => vxToggleMute());
  on('vxDeskBtn', 'click', () => vxDeskOpen());
  on('vxDeskClose', 'click', () => vxDeskOpen(false));
  on('vxTopBtn', 'click', () => vxActive ? vxDeskOpen() : openRealtimeOverlay());
  on('vxType', 'submit', e => { e.preventDefault(); const i = vxEl('vxTypeInput'); if(i){ vxSendText(i.value); i.value = ''; } });
  const feed = vxEl('vxFeed');
  if(feed) feed.addEventListener('click', e => {
    const b = e.target.closest('.vx-idea'); if(!b || b.dataset.resume) return;   // resume buttons have their own handler
    const t = b.textContent.replace(/…$/, '');
    if(/…$/.test(b.textContent)){ const i = vxEl('vxTypeInput'); if(i){ i.value = t; i.focus(); } return; }
    vxSendText(t);
  });
  document.addEventListener('keydown', e => {
    if(!e.altKey || e.metaKey || e.ctrlKey || e.code !== 'KeyM') return;
    e.preventDefault();
    if(vxActive) vxToggleMute(); else openRealtimeOverlay();
  });
})();
