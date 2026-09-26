/* ============================================================
   TALK TO MARGYN — voice mode for the Ask Margyn workspace.
   Speech-to-text and text-to-speech both go through OpenAI (proxied by
   api/ask-margyn.js?action=transcribe|speak — VP decision, see
   HANDOFF notes: OpenAI voice quality over the free browser APIs).
   Deliberately NOT OpenAI's Realtime speech-to-speech API: the transcript
   still lands in the same composer and goes through the same callAskMargyn
   -> propose_action confirm/cancel gate as typed chat (05-agents-chat.js /
   06-ask.js). Voice only ever changes how a message goes in and how the
   reply comes back — never a new way to write data.
   ============================================================ */
function voiceModeOn(){ return lsGet('margyn_voice_mode', '0') === '1'; }
function setVoiceMode(on){
  lsSet('margyn_voice_mode', on ? '1' : '0');
  reflectVoiceToggle();
  if(!on){ voiceStopSpeaking(); voiceStopListening(); }
}
function reflectVoiceToggle(){
  const on = voiceModeOn();
  const btn = document.getElementById('askVoiceToggle');
  if(btn){ btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  const mic = document.getElementById('askMicBtn');
  if(mic) mic.classList.toggle('hidden', !on);
}
async function voiceAuthHeaders(){
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    return session ? { 'Authorization': 'Bearer ' + session.access_token } : {};
  } catch(e){ return {}; }
}
function voiceMicSupported(){ return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }

let _voiceStream = null, _voiceRecorder = null, _voiceChunks = [], _voiceListening = false;
async function voiceStartListening(){
  if(_voiceListening) return;
  if(!voiceMicSupported()){ toast('Voice input needs microphone access', { sub:'Not supported in this browser' }); return; }
  voiceStopSpeaking(); // don't record over Margyn's own reply
  const mic = document.getElementById('askMicBtn');
  try {
    _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch(e){
    toast('Microphone permission needed', { sub:'Allow mic access to talk to Margyn' });
    return;
  }
  const mimeType = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm'))
    ? 'audio/webm'
    : (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
  try {
    _voiceRecorder = mimeType ? new MediaRecorder(_voiceStream, { mimeType }) : new MediaRecorder(_voiceStream);
  } catch(e){
    toast('Could not start recording', { sub: e.message });
    _voiceStream.getTracks().forEach(t => t.stop());
    return;
  }
  _voiceChunks = [];
  _voiceListening = true;
  if(mic) mic.classList.add('listening');
  _voiceRecorder.ondataavailable = (e) => { if(e.data && e.data.size) _voiceChunks.push(e.data); };
  _voiceRecorder.onstop = () => {
    if(mic) mic.classList.remove('listening');
    if(_voiceStream) _voiceStream.getTracks().forEach(t => t.stop());
    _voiceStream = null;
    _voiceListening = false;
    const blob = new Blob(_voiceChunks, { type: (_voiceRecorder && _voiceRecorder.mimeType) || 'audio/webm' });
    _voiceChunks = [];
    if(blob.size < 800) return; // accidental tap, no real audio
    voiceTranscribeAndSubmit(blob);
  };
  _voiceRecorder.start();
}
function voiceStopListening(){
  if(_voiceRecorder && _voiceRecorder.state !== 'inactive'){ try{ _voiceRecorder.stop(); }catch(e){} }
}
function voiceBlobToBase64(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function voiceTranscribeAndSubmit(blob){
  const mic = document.getElementById('askMicBtn');
  if(mic) mic.classList.add('transcribing');
  try {
    const audioBase64 = await voiceBlobToBase64(blob);
    const headers = await voiceAuthHeaders();
    const res = await fetch('/api/ask-margyn?action=transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ audioBase64, mimeType: blob.type })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok || !data.text || !data.text.trim()){
      toast('Could not hear that', { sub: (data && data.error) || 'Try again' });
      return;
    }
    const input = document.getElementById('historyThreadInput');
    const form = document.getElementById('historyThreadForm');
    if(input) input.value = data.text.trim();
    if(form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
  } catch(e){
    toast('Could not hear that', { sub:'Try again' });
  } finally {
    if(mic) mic.classList.remove('transcribing');
  }
}

let _voiceAudioEl = null;
async function voiceSpeak(text){
  if(!voiceModeOn() || !text) return;
  voiceStopSpeaking();
  const clean = String(text).replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if(!clean) return;
  try {
    const headers = await voiceAuthHeaders();
    const res = await fetch('/api/ask-margyn?action=speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: clean })
    });
    if(!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    _voiceAudioEl = new Audio(url);
    _voiceAudioEl.onended = () => { URL.revokeObjectURL(url); if(_voiceAudioEl && _voiceAudioEl.src === url) _voiceAudioEl = null; };
    _voiceAudioEl.play().catch(() => {});
  } catch(e){ /* silent — a failed reply readback shouldn't block chat */ }
}
function voiceStopSpeaking(){
  if(_voiceAudioEl){ try{ _voiceAudioEl.pause(); }catch(e){} _voiceAudioEl = null; }
}
/* Called from askWireComposerInput (06-ask.js) every time the composer form
   is cloned/replaced, since cloneNode(true) carries the mic button's
   markup but not its listener. */
function wireVoiceComposer(){
  const mic = document.getElementById('askMicBtn');
  if(mic && !mic._voiceWired){
    mic._voiceWired = true;
    mic.addEventListener('click', (e) => {
      e.preventDefault();
      if(_voiceListening) voiceStopListening(); else voiceStartListening();
    });
  }
}
(function wireVoiceToggle(){
  const btn = document.getElementById('askVoiceToggle');
  if(btn) btn.addEventListener('click', () => setVoiceMode(!voiceModeOn()));
  reflectVoiceToggle();
  wireVoiceComposer();
})();
