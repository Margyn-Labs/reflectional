/* ============================================================
   LIVE CONVERSATION — OpenAI Realtime API (WebRTC), continuous speech-to-
   speech. This is the "Talk to Margyn" pill's destination (see
   21-voice.js's wireVoiceToggle).

   Safety line held here regardless of using OpenAI's own live model: this
   session is handed exactly two tools (REALTIME_TOOLS in api/ask-margyn.js)
   and NEITHER of them writes anything.
     - show_data       -> rendered straight into the canvas panel below,
                          client-side only, no write.
     - request_confirmation -> the spoken request is piped through the
                          EXISTING callAskMargyn() text pipeline (06-ask.js),
                          which runs Claude's own propose_action validation
                          and returns a real confirm/cancel card. That card
                          is rendered with the same actionCardHtml/
                          wireActionCardConfirm as typed chat (05-agents-
                          chat.js) — the write only happens if the human
                          clicks Confirm there, exactly like every other
                          action in the app. The live OpenAI model never
                          gets a path to a write, only a path to a card.
   ============================================================ */
let rtPc = null, rtDc = null, rtStream = null, rtOpen = false;

function rtEls(){
  return {
    overlay: document.getElementById('rtOverlay'),
    orb: document.getElementById('rtOrb'),
    status: document.getElementById('rtStatus'),
    transcript: document.getElementById('rtTranscript'),
    canvas: document.getElementById('rtCanvas'),
    canvasEmpty: document.getElementById('rtCanvasEmpty'),
    audio: document.getElementById('rtRemoteAudio'),
    endBtn: document.getElementById('rtEndBtn')
  };
}
function rtSetOrb(state){
  const { orb } = rtEls(); if(!orb) return;
  orb.classList.remove('listening', 'speaking', 'connecting');
  if(state) orb.classList.add(state);
}
function rtSetStatus(text){
  const { status } = rtEls(); if(status) status.textContent = text;
}
function rtAddTranscriptLine(who, text){
  const { transcript } = rtEls(); if(!transcript || !text) return;
  const row = document.createElement('div');
  row.className = 'rt-line ' + who;
  row.innerHTML = '<div class="who">' + (who === 'user' ? 'You' : 'Margyn') + '</div><div>' + escapeHtml(text) + '</div>';
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
}
function rtSend(obj){
  if(rtDc && rtDc.readyState === 'open') rtDc.send(JSON.stringify(obj));
}

async function openRealtimeOverlay(){
  if(!navigator.mediaDevices || !window.RTCPeerConnection){
    toast('Live conversation needs a modern browser', { sub:'Try Chrome or Edge' });
    return;
  }
  const { overlay, canvas, canvasEmpty, transcript } = rtEls();
  if(!overlay) return;
  overlay.classList.remove('hidden');
  rtSetOrb('connecting');
  rtSetStatus('Connecting…');
  if(transcript) transcript.innerHTML = '';
  if(canvas) Array.from(canvas.querySelectorAll('.rt-card')).forEach(el => el.remove());
  if(canvasEmpty) canvasEmpty.style.display = '';
  wireRealtimeOverlayChrome();

  try {
    const context = (typeof buildMargynContext === 'function') ? buildMargynContext() : {};
    const headers = await voiceAuthHeaders();
    const sessRes = await fetch('/api/ask-margyn?action=realtime-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ context })
    });
    const sessData = await sessRes.json().catch(() => ({}));
    if(!sessRes.ok || !sessData.client_secret || !sessData.client_secret.value){
      throw new Error((sessData && sessData.error) || 'Could not start a live conversation');
    }
    const ephemeralKey = sessData.client_secret.value;
    const model = sessData.model || 'gpt-realtime';

    rtStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    rtPc = new RTCPeerConnection();
    rtPc.ontrack = (e) => {
      const { audio } = rtEls();
      if(audio) audio.srcObject = e.streams[0];
    };
    rtStream.getTracks().forEach(track => rtPc.addTrack(track, rtStream));

    rtDc = rtPc.createDataChannel('oai-events');
    rtDc.addEventListener('open', () => {
      rtOpen = true;
      rtSetOrb('listening');
      rtSetStatus('Listening — say something');
      rtSend({ type: 'response.create', response: { instructions: 'Greet the user with one short sentence and ask what they want to know.' } });
    });
    rtDc.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch(err){ return; }
      handleRealtimeEvent(msg);
    });
    rtDc.addEventListener('close', () => { rtOpen = false; });

    const offer = await rtPc.createOffer();
    await rtPc.setLocalDescription(offer);
    const sdpRes = await fetch('https://api.openai.com/v1/realtime?model=' + encodeURIComponent(model), {
      method: 'POST',
      body: offer.sdp,
      headers: {
        'Authorization': 'Bearer ' + ephemeralKey,
        'Content-Type': 'application/sdp'
      }
    });
    if(!sdpRes.ok) throw new Error('Could not connect the live audio session');
    const answerSdp = await sdpRes.text();
    await rtPc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch(err){
    console.error('openRealtimeOverlay error:', err);
    toast('Could not start the live conversation', { sub: (err && err.message) || 'Try again' });
    closeRealtimeOverlay();
  }
}

function closeRealtimeOverlay(){
  const { overlay } = rtEls();
  if(overlay) overlay.classList.add('hidden');
  rtOpen = false;
  try { if(rtDc) rtDc.close(); } catch(e){}
  try { if(rtPc) rtPc.close(); } catch(e){}
  if(rtStream) rtStream.getTracks().forEach(t => t.stop());
  rtDc = null; rtPc = null; rtStream = null;
}
(function wireRealtimeEndOnce(){
  // Wired once at load — separate from wireRealtimeOverlayChrome (which runs
  // every open) since this button never gets replaced/cloned.
  const btn = document.getElementById('rtEndBtn');
  if(btn) btn.addEventListener('click', closeRealtimeOverlay);
})();
function wireRealtimeOverlayChrome(){
  const { overlay } = rtEls();
  if(overlay && !overlay._escWired){
    overlay._escWired = true;
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && !overlay.classList.contains('hidden')) closeRealtimeOverlay();
    });
  }
}

function handleRealtimeEvent(msg){
  switch(msg.type){
    case 'input_audio_buffer.speech_started':
      rtSetOrb('listening');
      rtSetStatus('Listening…');
      break;
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      rtSetOrb('speaking');
      rtSetStatus('Margyn is speaking…');
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      if(msg.transcript) rtAddTranscriptLine('margyn', msg.transcript);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      if(msg.transcript) rtAddTranscriptLine('user', msg.transcript);
      break;
    case 'response.done':
      rtSetOrb('listening');
      rtSetStatus('Listening — say something');
      break;
    case 'response.function_call_arguments.done':
      rtHandleToolCall(msg);
      break;
    case 'error':
      console.error('Realtime error event:', msg);
      toast('Live conversation hit an error', { sub: (msg.error && msg.error.message) || 'Try again' });
      break;
    default:
      break;
  }
}

async function rtHandleToolCall(msg){
  let args = {};
  try { args = JSON.parse(msg.arguments || '{}'); } catch(e){}
  if(msg.name === 'show_data'){
    rtRenderTable(args);
    rtSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify({ shown: true }) } });
    rtSend({ type: 'response.create' });
    return;
  }
  if(msg.name === 'request_confirmation'){
    await rtRenderConfirmation(args.request || '');
    rtSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify({ shown_for_review: true }) } });
    rtSend({ type: 'response.create' });
    return;
  }
}

function rtCardHost(){
  const { canvas, canvasEmpty } = rtEls();
  if(canvasEmpty) canvasEmpty.style.display = 'none';
  return canvas;
}
function rtRenderTable(args){
  const host = rtCardHost(); if(!host) return;
  const cols = Array.isArray(args.columns) ? args.columns : [];
  const rows = Array.isArray(args.rows) ? args.rows : [];
  const card = document.createElement('div');
  card.className = 'rt-card';
  card.innerHTML =
    '<h4>' + escapeHtml(args.title || 'Data') + '</h4>' +
    '<table><thead><tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead>' +
    '<tbody>' + rows.map(r => '<tr>' + r.map(v => '<td>' + escapeHtml(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' +
    (args.note ? '<div class="rt-note">' + escapeHtml(args.note) + '</div>' : '');
  host.insertBefore(card, host.firstChild);
}
async function rtRenderConfirmation(requestText){
  const host = rtCardHost(); if(!host || !requestText) return;
  const card = document.createElement('div');
  card.className = 'rt-card';
  card.innerHTML = '<h4>Reviewing your request</h4><div class="rt-note">"' + escapeHtml(requestText) + '"</div>';
  host.insertBefore(card, host.firstChild);
  try {
    // Same call typed chat uses — Claude resolves the request, validates it
    // against real rows the user owns, and returns a card or a plain-text
    // reason it couldn't (never a silent write either way).
    const data = await callAskMargyn(requestText, [], null, null, 'margyn');
    if(data.actionCard && data.actionCard.type){
      const cardEl = document.createElement('div');
      cardEl.innerHTML = actionCardHtml(data.actionCard);
      const inner = cardEl.firstElementChild;
      card.appendChild(inner);
      wireActionCardConfirm(inner, data.actionCard);
    } else {
      const note = document.createElement('div');
      note.className = 'rt-note';
      note.textContent = data.reply || "Couldn't find anything to confirm there.";
      card.appendChild(note);
    }
  } catch(e){
    const note = document.createElement('div');
    note.className = 'rt-note';
    note.textContent = "Couldn't reach Margyn to check that just now.";
    card.appendChild(note);
  }
}
