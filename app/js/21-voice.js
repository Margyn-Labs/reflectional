/* ============================================================
   TALK TO MARGYN — two separate voice surfaces on the Ask Margyn workspace.

   1. The composer mic (#askMicBtn, always visible): tap-to-talk for a single
      question. Records a clip, transcribes + speaks the reply via OpenAI
      (api/ask-margyn.js?action=transcribe|speak). The transcript still goes
      through the normal composer submit -> callAskMargyn -> the same
      propose_action confirm/cancel gate as typed chat (05-agents-chat.js).
      If you asked out loud, the reply is read back out loud — no separate
      mode toggle needed.

   2. The "Talk to Margyn" pill (#askVoiceToggle): opens the full live,
      continuous conversation overlay — see 22-realtime-voice.js for that
      (OpenAI Realtime API / WebRTC). This file only owns the pill's click
      wiring; the overlay's own logic lives in that file so a missing/failed
      Realtime session never breaks the simpler tap-to-talk path above.
   ============================================================ */
async function voiceAuthHeaders(){
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    return session ? { 'Authorization': 'Bearer ' + session.access_token } : {};
  } catch(e){ return {}; }
}
function voiceMicSupported(){ return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }

// Set right before a mic-triggered submit, read once by voiceMaybeSpeak when
// that turn's reply comes back, then cleared — so only answers to spoken
// questions get read aloud, typed ones stay silent.
let _voiceLastAskWasSpoken = false;
function voiceMaybeSpeak(reply){
  if(!_voiceLastAskWasSpoken) return;
  _voiceLastAskWasSpoken = false;
  voiceSpeak(reply);
}

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
    _voiceLastAskWasSpoken = true;
    if(form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
  } catch(e){
    toast('Could not hear that', { sub:'Try again' });
  } finally {
    if(mic) mic.classList.remove('transcribing');
  }
}

let _voiceAudioEl = null;
async function voiceSpeak(text){
  if(!text) return;
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
  if(btn) btn.addEventListener('click', () => {
    if(typeof openRealtimeOverlay === 'function') openRealtimeOverlay();
    else toast('Live conversation is loading, try again in a moment');
  });
  wireVoiceComposer();
})();
