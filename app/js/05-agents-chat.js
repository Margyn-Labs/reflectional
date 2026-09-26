/* ============================================================
   AGENTS TAB — one persistent "home" thread per agent, distinct from the
   ad hoc, topic-scoped threads in the Chats tab. Reuses the exact same
   chat_messages/ask-margyn.js machinery as every other thread — the only
   difference is the thread_key is deterministic (agent-home:<id>, one per
   user per agent, always the same) instead of freshly generated, so a
   given agent's conversation accumulates in one place over time instead of
   starting clean every time you open it. See the plan discussed with VP:
   Agents tab = stable identity (this thread is always that agent, and a
   handoff away from it redirects to the target agent's own home rather
   than rewriting this thread's identity); Chats tab = fluid identity
   (handoff switches the SAME thread in place, unchanged from before).
   ============================================================ */
const AGENT_HOME_PREFIX = 'agent-home:';
function agentHomeKey(agentId){ return AGENT_HOME_PREFIX + agentId; }
function isAgentHomeThread(tk){ return typeof tk === 'string' && tk.indexOf(AGENT_HOME_PREFIX) === 0; }

let askActiveTab = 'agents';
function askActivateTab(name){
  askActiveTab = name;
  const tabsEl = document.getElementById('askTabs');
  if(tabsEl) tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  const chatsTop = document.getElementById('askChatsTopBar');
  const chatsList = document.getElementById('historyThreadList');
  const agentsList = document.getElementById('askAgentsList');
  if(chatsTop) chatsTop.hidden = (name !== 'chats');
  if(chatsList) chatsList.hidden = (name !== 'chats');
  if(agentsList) agentsList.hidden = (name !== 'agents');
  if(name === 'agents' && currentUser) renderAgentsTab();
  if(name === 'chats' && currentUser) renderHistoryThreadList();
}

const AGENT_HOME_EMPTY = {
  margyn: "I lead the team and see everything — vitals, Pulse Score, every connected source. Ask me anything, or I'll bring in a specialist when it's their lane.",
  chase:  "I'm the Chase Agent. I own collections — who's overdue, who's being chased, and what to do about it. Ask me who's late, or tell me to pause/resume/adjust the chase.",
  close:  "I'm the Close Agent. I own reconciliation — the proposals in your Agent Queue. Ask me to explain one, or approve/dismiss it here.",
  import: "I'm the Import Agent. I own triage for invoices and bills forwarded over WhatsApp or uploaded. Ask what's pending, or approve/reject one."
};

/* Live one-line status per agent card. Fetched fresh every time the tab
   opens rather than trusting whatever other tabs happened to load already
   — four small queries is cheap and keeps this tab correct regardless of
   nav history. */
async function agentStatusLine(agentId){
  try {
    if(agentId === 'chase'){
      const { data, error } = await sbClient.from('whatsapp_chase_targets').select('id').eq('user_id', currentUser.id).eq('state','active');
      if(error) throw error;
      const n = (data||[]).length;
      return n ? { text: 'Chasing ' + n + ' ' + (n===1?'customer':'customers'), quiet:false } : { text:'Nothing being chased right now', quiet:true };
    }
    if(agentId === 'close'){
      const payload = await loadAgentActions();
      const n = (payload && payload.actions && payload.actions.length) || 0;
      return n ? { text: n + ' pending in the queue', quiet:false } : { text:'Queue is clear', quiet:true };
    }
    if(agentId === 'import'){
      const rows = await loadPendingSuggestions();
      const n = (rows||[]).length;
      return n ? { text: n + ' pending ' + (n===1?'import':'imports'), quiet:false } : { text:'Nothing waiting', quiet:true };
    }
    return { text:'Sees everything, leads the team', quiet:true };
  } catch(e){
    console.error('[margyn] agentStatusLine(' + agentId + '):', e);
    return { text:'', quiet:true };
  }
}

async function renderAgentsTab(){
  const el = document.getElementById('askAgentsList'); if(!el || !currentUser) return;
  const ids = ['margyn','chase','close','import'];
  el.innerHTML = ids.map(id => {
    const meta = AGENT_META[id] || AGENT_META.margyn;
    return '<button type="button" class="ap-tile" data-agent-home="' + id + '">' +
      '<span class="agent-avatar">' + agentAvatarInner(id) + '</span>' +
      '<span class="ac-body"><span class="ac-name">' + escapeHtml(meta.name) + '</span>' +
      '<span class="ac-sub">' + escapeHtml(meta.sub) + '</span>' +
      '<span class="ac-status quiet" data-status-for="' + id + '">…</span></span>' +
    '</button>';
  }).join('');
  el.querySelectorAll('[data-agent-home]').forEach(card => {
    card.addEventListener('click', () => openAgentHome(card.dataset.agentHome));
  });
  ids.forEach(async id => {
    const s = await agentStatusLine(id);
    const statusEl = el.querySelector('[data-status-for="' + id + '"]');
    if(statusEl && s.text){ statusEl.textContent = s.text; statusEl.classList.toggle('quiet', !!s.quiet); }
  });
}

async function openAgentHome(agentId){
  const id = AGENT_META[agentId] ? agentId : 'margyn';
  const meta = AGENT_META[id];
  const threadKey = agentHomeKey(id);
  const openEl = document.getElementById('historyThreadOpen'); if(openEl) openEl.classList.remove('hidden');
  const messagesEl = document.getElementById('historyThreadMessages');
  messagesEl.innerHTML = '';
  askPageThreadKey = threadKey;
  askPageFocus = null;
  threadAgentMap.set(threadKey, id); // fixed — never overwritten by a handoff inside this thread, see wireChatForm
  askSetTitle(meta.name, meta.sub, id);
  const past = await loadChatThread(threadKey, 200);
  askPageHistory.length = 0;
  if(!past.length){
    messagesEl.innerHTML = '<div class="ask-empty"><div class="ae-mark">' + agentAvatarInner(id) + '</div><h3>' + escapeHtml(meta.name) + '</h3><p>' + escapeHtml(AGENT_HOME_EMPTY[id] || '') + '</p><div id="askHomeEmptyStatus"></div></div>';
    // The card you clicked already showed a live count (e.g. "1 pending
    // import") — the greeting above was static and never actually said
    // what that was, which read as the badge and the chat disagreeing.
    // Surface the same live number here, with one tap to have the agent
    // narrate the specifics rather than making you type the question.
    const s = await agentStatusLine(id);
    const statusEl = document.getElementById('askHomeEmptyStatus');
    if(statusEl && s.text){
      if(s.quiet){
        statusEl.innerHTML = '<span class="ac-status quiet">' + escapeHtml(s.text) + '</span>';
      } else {
        statusEl.innerHTML = '<button type="button" class="ae-status-btn"><span class="ac-status">' + escapeHtml(s.text) + '</span><span class="ae-status-cta">Show me →</span></button>';
        statusEl.querySelector('.ae-status-btn').addEventListener('click', () => askSubmitInPlace("What's pending right now?"));
      }
    }
  } else {
    past.forEach(m => {
      appendChatBubble(messagesEl, m.role, m.content, m.role === 'assistant' ? id : undefined);
      askPageHistory.push({ role:m.role, content:m.content });
    });
  }
  askRewireComposer();
  askDecorateStream();
  messagesEl.scrollTop = messagesEl.scrollHeight;
  document.querySelectorAll('#askAgentsList .ap-tile').forEach(c => c.classList.toggle('on', c.dataset.agentHome === id));
}

async function saveChatMessage(threadKey, vital, role, content, agentId){
  try {
    await sbClient.from('chat_messages').insert({ user_id: currentUser.id, thread_key: threadKey, vital: vital || null, role, content, agent_id: agentId || 'margyn' });
  } catch(e){ console.error('[margyn] saveChatMessage:', e); }
}

async function loadChatThread(threadKey, limit){
  const { data, error } = await sbClient.from('chat_messages')
    .select('*').eq('user_id', currentUser.id).eq('thread_key', threadKey)
    .order('created_at', { ascending:false }).limit(limit || (CHAT_CONTEXT_CAP * 2));
  if(error){ console.error('[margyn] loadChatThread:', error); return []; }
  return data.reverse(); // oldest first, for natural replay order
}

async function loadAllThreadSummaries(){
  // Scans recent messages across every thread and keeps the latest one per
  // thread_key. Raised well above what a normal session would produce —
  // 200 was silently dropping quieter threads once a couple of busier
  // ones ate most of that window. Not a perfect fix (a proper one would
  // be a small Postgres view doing DISTINCT ON thread_key server-side),
  // but comfortably covers real usage without a new migration.
  const { data, error } = await sbClient.from('chat_messages')
    .select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(3000);
  if(error){ console.error('[margyn] loadAllThreadSummaries:', error); return []; }
  const seen = new Map();
  data.forEach(m => { if(!seen.has(m.thread_key)) seen.set(m.thread_key, m); });
  return Array.from(seen.values());
}

let askMargynGlobalHistory = [];
let currentGlobalThreadKey = 'global';
let currentGlobalFocusLabel = null;
function resolveThreadKey(tk){ return typeof tk === 'function' ? tk() : tk; }
function newGlobalThreadKey(){ return 'global:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// Session-scoped thread keys for the "click on a vital/KPI to chat" entry
// points (openMargynFocused, and the no-finding branch of
// renderVitalChatBlock). A key is generated fresh the first time a given
// topic is clicked THIS page load, cached here in a plain JS object, and
// reused if the same topic is clicked again without reloading — so a chat
// stays continuous within a session but always starts clean after a
// refresh or a fresh log in, since this object itself resets on reload.
// Findings ('finding:<id>' threads) intentionally don't use this — those
// stay tied to that specific finding's id, since re-opening the same
// already-generated finding should show the same explanation every time.
let sessionTopicThreadKeys = {};
function sessionThreadKeyFor(topic){
  if(!sessionTopicThreadKeys[topic]) sessionTopicThreadKeys[topic] = 'vital:' + topic + '::' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return sessionTopicThreadKeys[topic];
}

/* Deterministic topic → view lookup, used to offer a "Go to X" chip
   after a reply in the global panel. This is plain JS pattern-matching
   on the topic string, not the model choosing where to send someone —
   keeps navigation predictable and impossible for a reply to get wrong. */
const MARGYN_VIEW_HINTS = [
  { test: /receivable|customer|invoice/i, view:'ledger', ltab:'receivables', label:'Ledger: Receivables' },
  { test: /payable|vendor|bill/i, view:'ledger', ltab:'payables', label:'Ledger: Payables' },
  { test: /cash/i, view:'ledger', ltab:'cash', label:'Ledger: Cash' },
  { test: /gst|itc/i, view:'scores', label:'Scores' },
  { test: /razorpay|settlement|mdr|fail|gross processed|transaction value|method mix/i, view:'payments', label:'Payments' },
  { test: /shopify/i, view:'payments', label:'Payments' },
  { test: /zoho|books/i, view:'books', label:'Books' },
  { test: /financing|loan/i, view:'financing', label:'Financing' },
  { test: /connector/i, view:'connectors', label:'Connectors' },
  { test: /net margin|working capital|runway/i, view:'scores', label:'Scores' }
];
function findViewHint(topic){ return topic ? (MARGYN_VIEW_HINTS.find(h => h.test.test(topic)) || null) : null; }
/* Keep the FAB's aria-expanded in sync wherever the panel is opened/closed
   outside initAskMargynGlobal (focused topic chats, "Go to" chips). */
function reflectAskMargynFab(){
  const f = document.getElementById('askMargynFab'), p = document.getElementById('askMargynPanel');
  if(f && p) f.setAttribute('aria-expanded', p.classList.contains('hidden') ? 'false' : 'true');
}
function appendGoToChip(threadEl, hint){
  if(!hint) return;
  const viewEl = document.getElementById('view-' + hint.view);
  if(viewEl && !viewEl.classList.contains('hidden')) return; // already there
  const chip = document.createElement('button');
  chip.className = 'finding-explain';
  chip.style.marginTop = '2px';
  chip.textContent = '→ Go to ' + hint.label;
  chip.addEventListener('click', () => {
    if(hint.ltab) ledgerActiveTab = hint.ltab;
    showView(hint.view);
    document.getElementById('askMargynPanel').classList.add('hidden');
    reflectAskMargynFab();
  });
  threadEl.appendChild(chip);
}

/* Universal click-to-chat entry point. Any tile with data-margyn-topic
   (or the small chat-icon button on tiles that keep a navigate-on-click primary
   action, like the Summary KPIs) calls this instead of opening a whole
   detail modal — it reuses the same global panel and the same
   session-scoped 'vital:<topic>::<suffix>' thread-key convention as
   everywhere else, so it's saved, reopenable from the History tab, and
   capped the same way — but starts fresh each session (see
   sessionThreadKeyFor above). */
/* Click-to-chat from any tile now lands on the one Ask Margyn workspace
   (the page), focused on the tapped topic — there is no separate floating
   conversation to fall out of sync with. */
function openMargynFocused(topic, valueText){
  showView('history');
  setTimeout(() => {
    askNewConversation(topic);
    if(valueText){
      askSetTitle(topic, String(valueText));
    }
    const input = document.getElementById('historyThreadInput');
    if(input){ input.placeholder = 'Ask about ' + topic + '...'; input.focus(); }
  }, 60);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-margyn-topic]');
  if(!el) return;
  const valueEl = el.querySelector('.pc-value, .f-value, .v-value');
  openMargynFocused(el.dataset.margynTopic, valueEl ? (valueEl.dataset.mgFull || valueEl.textContent) : null);
});

/* Perceived streaming: the reply arrives whole (one blocking API call —
   see api/ask-margyn.js), but revealing it word-by-word instead of dumping
   the full block at once reads as live rather than batch, matching what
   every mainstream chat product does. Cheap and purely client-side; a real
   token-streamed response from the server is a bigger change (the tool-use
   loop in ask-margyn.js would need to stream per-iteration) that isn't
   justified until this stops feeling fast enough. */
function revealText(el, text, threadEl){
  const target = el.querySelector('.msg-body') || el;
  return new Promise(resolve => {
    const words = text.split(' ');
    let i = 0;
    target.textContent = '';
    const tick = () => {
      i += 2; // 2 words/tick reads as fluent without dragging out long replies
      target.textContent = words.slice(0, i).join(' ');
      if(threadEl) threadEl.scrollTop = threadEl.scrollHeight;
      if(i < words.length){ setTimeout(tick, 22); } else { resolve(); }
    };
    if(words.length <= 1){ target.textContent = text; resolve(); } else { tick(); }
  });
}

/* agentId (not a display name) for assistant/loading bubbles — resolved to
   name + icon internally so every call site just says who's talking. In the
   main Ask Margyn workspace (.ask-stream) each assistant bubble gets a real
   avatar + name header; elsewhere (the per-vital mini chat) it stays a
   plain bubble, unchanged — that surface never had per-agent identity and
   isn't the multi-agent entry point. */
function appendChatBubble(threadEl, role, text, agentId){
  const b = document.createElement('div');
  b.className = 'margyn-msg ' + role;
  const isAssistant = role.indexOf('assistant') === 0;
  const inStream = threadEl.classList.contains('ask-stream');
  if(isAssistant && inStream){
    const id = agentId || 'margyn';
    const meta = AGENT_META[id] || AGENT_META.margyn;
    b.dataset.agent = id;
    b.innerHTML =
      '<div class="msg-head"><span class="agent-avatar sm">' + agentAvatarInner(id) + '</span><span class="msg-agent-name">' + escapeHtml(meta.name) + '</span></div>' +
      '<div class="msg-body"></div>';
    if(text) b.querySelector('.msg-body').textContent = text;
  } else {
    b.textContent = text;
  }
  threadEl.appendChild(b);
  threadEl.scrollTop = threadEl.scrollHeight;
  return b;
}

function wireChatForm(formEl, inputEl, threadEl, historyRef, focusLabel, threadKey, showNavHint){
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = inputEl.value.trim();
    if(!msg) return;
    const tk = resolveThreadKey(threadKey);
    const fl = resolveThreadKey(focusLabel);
    inputEl.value = '';
    appendChatBubble(threadEl, 'user', msg);
    const historySnapshot = historyRef.slice(-CHAT_CONTEXT_CAP);
    historyRef.push({ role:'user', content: msg });
    if(tk) saveChatMessage(tk, fl, 'user', msg);
    const agentId = getThreadAgent(tk);
    const loadingBubble = appendChatBubble(threadEl, 'assistant loading', '', agentId);
    const submitBtn = formEl.querySelector('button');
    submitBtn.disabled = true;
    try {
      const data = await callAskMargyn(msg, historySnapshot, fl, null, agentId);
      const reply = data.reply;
      loadingBubble.classList.remove('loading');
      await revealText(loadingBubble, reply, threadEl);
      if(typeof voiceSpeak === 'function') voiceSpeak(reply);
      historyRef.push({ role:'assistant', content: reply });
      if(tk) saveChatMessage(tk, fl, 'assistant', reply, agentId);
      if(data.handoff && data.handoff.agentId){
        const hoAgentId = data.handoff.agentId;
        const meta = AGENT_META[hoAgentId] || { name: data.handoff.agentName || hoAgentId, sub:'', icon:'margyn' };
        if(isAgentHomeThread(tk)){
          // Agent-home threads keep a stable identity — a handoff here
          // never rewrites whose thread this is (that would pollute this
          // agent's own memory with someone else's lane). Point at that
          // agent's own home instead, one click away.
          const jump = document.createElement('button');
          jump.type = 'button';
          jump.className = 'margyn-msg handoff jump-agent';
          jump.innerHTML = '<span class="agent-avatar sm">' + agentAvatarInner(hoAgentId) + '</span><span>Talk to ' + escapeHtml(meta.name) + ' →</span>';
          jump.addEventListener('click', () => openAgentHome(hoAgentId));
          threadEl.appendChild(jump);
          threadEl.scrollTop = threadEl.scrollHeight;
          requestAnimationFrame(() => jump.querySelector('.agent-avatar').classList.add('pop'));
        } else {
          threadAgentMap.set(tk, hoAgentId);
          const divider = document.createElement('div');
          divider.className = 'margyn-msg handoff';
          divider.innerHTML = '<span class="agent-avatar sm">' + agentAvatarInner(hoAgentId) + '</span><span>Now with ' + escapeHtml(meta.name) + '</span>';
          threadEl.appendChild(divider);
          threadEl.scrollTop = threadEl.scrollHeight;
          requestAnimationFrame(() => divider.querySelector('.agent-avatar').classList.add('pop'));
          askSetTitle(meta.name, meta.sub, hoAgentId);
        }
      }
      if(data.actionCard && data.actionCard.type){
        const cardEl = document.createElement('div');
        cardEl.innerHTML = actionCardHtml(data.actionCard);
        const card = cardEl.firstElementChild;
        threadEl.appendChild(card);
        wireActionCardConfirm(card, data.actionCard);
        threadEl.scrollTop = threadEl.scrollHeight;
      }
      if(showNavHint) appendGoToChip(threadEl, findViewHint(fl));
    } catch(err){
      loadingBubble.textContent = (err && /chat limit/i.test(err.message)) ? err.message : "Couldn't reach Margyn just now, try again in a moment.";
      loadingBubble.classList.remove('loading');
    } finally {
      submitBtn.disabled = false;
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  });
}

function findingTierLabel(f){
  if(f.tier !== 'verified') return 'Signal · single source, unconfirmed';
  const srcNames = { razorpay:'live Razorpay', razorpay_live:'live Razorpay', shopify:'Shopify', zoho:'Zoho Books' };
  const srcs = (f.evidence && Array.isArray(f.evidence.corroboratorSources)) ? f.evidence.corroboratorSources : [];
  const named = srcs.map(s => srcNames[s] || s).filter(Boolean);
  return named.length ? ('Verified · corroborated by ' + named.join(' + ')) : 'Verified · 2 sources agree';
}
function findingCardHtml(f){
  return '<div class="finding-card ' + f.tier + '">' +
    '<div class="finding-tier">' + findingTierLabel(f) + '</div>' +
    '<div class="finding-summary">' + escapeHtml(f.summary) + '</div>' +
    // Only self-reported (Signal) findings carry the "not cross-checked" note —
    // a Verified finding is corroborated by an independent source by definition.
    ((f.self_reported && f.tier !== 'verified') ? '<div class="finding-provenance">Based on manually entered / uploaded data, not yet cross-checked against a live connector.</div>' : '') +
    '<button class="finding-explain">Explain why →</button>' +
  '</div>';
}

/* Narration was already written server-side when the finding was
   generated — this is an instant local reveal, not an API call. Saved as
   the first message of that finding's own thread so it's there on reopen. */
function wireFindingExplain(cardEl, f, threadEl, historyRef){
  const btn = cardEl.querySelector('.finding-explain');
  btn.addEventListener('click', () => {
    let text = f.narration || f.summary;
    if(f.suggested_action) text += '\n\n→ ' + f.suggested_action;
    appendChatBubble(threadEl, 'assistant', text);
    threadEl.scrollTop = threadEl.scrollHeight;
    if(historyRef) historyRef.push({ role:'assistant', content: text });
    saveChatMessage('finding:' + f.id, f.vital, 'assistant', text);
    btn.remove();
  });
}

/* Ask Margyn action cards — the chat can PROPOSE approving an import,
   dismissing a reconciliation flag, pausing the chase agent, logging a
   ledger entry, etc. (api/ask-margyn.js's propose_action tool) but never
   executes anything itself. This card is the confirm/cancel gate: nothing
   in runProposedAction fires until the user clicks Confirm, and every
   branch below reuses the exact write path the matching tab button already
   uses — decideSuggestion's approve logic, the Agent Queue's agent-review
   fetch, setAgentStatus, the Ledger tab's settle/create helpers, and
   chaseUpdateTarget/chaseTakeOver/chaseMarkPaid. No new write logic here
   beyond create_ledger_item, which mirrors the existing ledgerAddBtn insert. */
function actionCardHtml(actionCard){
  if(actionCard.type === 'list_for_review'){
    const items = (actionCard.payload && actionCard.payload.items) || [];
    const rows = items.map((it, i) =>
      '<label class="action-card-item"><input type="checkbox" data-review-idx="' + i + '" checked> ' + escapeHtml(it.label || it.type) + '</label>'
    ).join('');
    return '<div class="action-card" data-action-type="list_for_review">' +
      '<div class="action-card-summary">' + escapeHtml(actionCard.humanSummary || 'Review these items:') + '</div>' +
      '<div class="action-card-items">' + rows + '</div>' +
      '<button class="primary action-confirm">Confirm selected</button>' +
      '<button class="btn-ghost action-cancel">Cancel</button>' +
    '</div>';
  }
  return '<div class="action-card" data-action-type="' + escapeHtml(actionCard.type) + '">' +
    '<div class="action-card-summary">' + escapeHtml(actionCard.humanSummary || 'Confirm this action?') + '</div>' +
    '<button class="primary action-confirm">Confirm</button>' +
    '<button class="btn-ghost action-cancel">Cancel</button>' +
  '</div>';
}

function wireActionCardConfirm(cardEl, actionCard){
  const confirmBtn = cardEl.querySelector('.action-confirm');
  const cancelBtn = cardEl.querySelector('.action-cancel');
  if(cancelBtn) cancelBtn.addEventListener('click', () => cardEl.remove());
  if(!confirmBtn) return;
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true; if(cancelBtn) cancelBtn.disabled = true;
    confirmBtn.textContent = 'Working…';
    try {
      if(actionCard.type === 'list_for_review'){
        const items = (actionCard.payload && actionCard.payload.items) || [];
        const checked = Array.from(cardEl.querySelectorAll('input[data-review-idx]'))
          .filter(cb => cb.checked).map(cb => items[Number(cb.dataset.reviewIdx)]).filter(Boolean);
        for(const it of checked) await runProposedAction(it);
        cardEl.outerHTML = '<div class="action-card-done">Done — ' + checked.length + ' item(s) actioned.</div>';
      } else {
        await runProposedAction(actionCard);
        cardEl.outerHTML = '<div class="action-card-done">Done.</div>';
      }
    } catch(err){
      confirmBtn.textContent = 'Confirm';
      confirmBtn.disabled = false; if(cancelBtn) cancelBtn.disabled = false;
      toast('Could not do that: ' + (err.message || 'unknown error'), { kind:'bad' });
    }
  });
}

/* The only place any of these six new-ish writes actually happen. Every
   branch either calls an existing app function unchanged, or (for
   create_ledger_item) mirrors one inline — see the comment above. */
async function runProposedAction(action){
  const type = action.type;
  if(type === 'approve_suggestion' || type === 'reject_suggestion'){
    const { data: sug, error } = await sbClient.from('import_suggestions').select('*').eq('id', action.targetId).single();
    if(error || !sug) throw new Error('Could not find that import suggestion.');
    if(type === 'approve_suggestion'){
      const entries = (sug.proposal && sug.proposal.entries) || [];
      if(entries.length) await applyChosenImportEntries(entries);
      triggerFindingsGeneration();
    }
    const { error: uErr } = await sbClient.from('import_suggestions')
      .update({ status: type === 'approve_suggestion' ? 'approved' : 'rejected', decided_at: new Date().toISOString() })
      .eq('id', sug.id);
    if(uErr) throw uErr;
    pendingSuggestions = await loadPendingSuggestions();
    if(typeof renderSuggestionsView === 'function') renderSuggestionsView();
    return;
  }
  if(type === 'approve_agent_action' || type === 'dismiss_agent_action'){
    const decision = type === 'approve_agent_action' ? 'approve' : 'reject';
    await zohoApi('/api/reconcile?action=agent-review', { method:'POST', body: JSON.stringify({ actionId: action.targetId, decision }) });
    if(typeof loadAgentActions === 'function') await loadAgentActions();
    if(typeof renderAgentQueue === 'function') renderAgentQueue();
    return;
  }
  if(type === 'pause_chase_agent') return setAgentStatus('chase_agent', 'paused');
  if(type === 'resume_chase_agent') return setAgentStatus('chase_agent', 'active');
  if(type === 'update_chase_agent_config'){
    const dep = (typeof agentDeployments !== 'undefined' && agentDeployments['chase_agent']) || {};
    const newConfig = Object.assign({}, dep.config || {}, action.payload || {});
    const { error } = await sbClient.from('agent_deployments')
      .update({ config: newConfig, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id).eq('agent_id', 'chase_agent');
    if(error) throw error;
    if(typeof renderAgents === 'function') renderAgents();
    return;
  }
  if(type === 'mark_ledger_item_paid'){
    const table = action.targetKind === 'payable' ? 'payables' : 'receivables';
    const { data: row, error } = await sbClient.from(table).select('*').eq('id', action.targetId).single();
    if(error || !row) throw new Error('Could not find that ledger item.');
    return table === 'payables' ? ledgerSettlePayable(row) : ledgerSettleReceivable(row);
  }
  if(type === 'create_ledger_item'){
    const p = action.payload || {};
    const table = action.targetKind === 'payable' ? 'payables' : 'receivables';
    const { error } = await sbClient.from(table).insert({
      user_id: currentUser.id, party_name: p.party || 'Unknown', amount: Number(p.amount) || 0,
      due_date: p.due_date || null, status: 'open', source: 'manual'
    });
    if(error) throw error;
    await logLedgerEvent({ entityType: table === 'payables' ? 'payable' : 'receivable', event:'created', partyName: p.party, amount: p.amount, source:'manual' });
    receivables = await loadReceivables(); payables = await loadPayables();
    if(typeof saveLedgerSnapshot === 'function') await saveLedgerSnapshot();
    if(typeof renderLedgerView === 'function') renderLedgerView();
    return;
  }
  if(type === 'stop_chasing_party'){
    return chaseUpdateTarget(action.targetId, { state:'stopped', resolution:'Stopped via Ask Margyn.', next_chase_at:null });
  }
  if(type === 'mark_chase_target_paid' || type === 'send_one_off_chase'){
    const { data: t, error } = await sbClient.from('whatsapp_chase_targets').select('*').eq('id', action.targetId).single();
    if(error || !t) throw new Error('Could not find that chase.');
    return type === 'mark_chase_target_paid' ? chaseMarkPaid(t) : chaseTakeOver(t);
  }
  throw new Error('Unknown action type: ' + type);
}

/* per-vital finding + fallback ask, injected at the bottom of the open detail modal.
   Async: replays that vital's (or that finding's) saved thread if one exists. */
async function renderVitalChatBlock(focusLabel){
  const host = document.getElementById('detailContent');
  if(!host) return;
  const existing = host.querySelector('.margyn-chat'); if(existing) existing.remove();
  const match = findings.find(f => f.vital === focusLabel && snapshots[0] && f.snapshot_id === snapshots[0].id);
  const threadKey = match ? ('finding:' + match.id) : sessionThreadKeyFor(focusLabel);
  const vitalChatHistory = [];
  const block = document.createElement('div');
  block.className = 'margyn-chat';
  block.innerHTML =
    '<div class="margyn-chat-label">Margyn</div>' +
    (match ? findingCardHtml(match) : '') +
    '<div class="margyn-chat-thread" id="vitalChatThread"></div>' +
    '<form class="margyn-chat-form" id="vitalChatForm">' +
      '<input type="text" id="vitalChatInput" placeholder="e.g. what does this number mean?" autocomplete="off">' +
      '<button type="submit">Ask</button>' +
    '</form>';
  host.appendChild(block);
  const thread = document.getElementById('vitalChatThread');
  wireChatForm(document.getElementById('vitalChatForm'), document.getElementById('vitalChatInput'), thread, vitalChatHistory, focusLabel, threadKey);
  const findingCard = block.querySelector('.finding-card');
  const past = await loadChatThread(threadKey);
  if(past.length){
    past.forEach(m => { appendChatBubble(thread, m.role, m.content); vitalChatHistory.push({ role:m.role, content:m.content }); });
    if(findingCard) findingCard.querySelector('.finding-explain')?.remove();
  } else if(findingCard){
    wireFindingExplain(findingCard, match, thread, vitalChatHistory);
  }
}

/* global panel: leads with cross-vital findings, not a blank greeting.
   Each finding card replays its own saved thread if it's already been asked about. */
async function renderGlobalFindings(thread){
  const latestBatch = snapshots[0] ? findings.filter(f => f.snapshot_id === snapshots[0].id) : [];
  const sorted = latestBatch.slice().sort((a,b) => (a.tier === b.tier) ? 0 : (a.tier === 'verified' ? -1 : 1)).slice(0,3);
  if(!sorted.length){
    appendChatBubble(thread, 'assistant', snapshots.length > 1
      ? "Nothing's moved enough to flag since your last snapshot, or I'm still crunching it, check back in a moment. Ask me anything about your numbers below."
      : "Add another snapshot and I'll start flagging what's actually changed, cross-checked against Razorpay and Shopify where you're connected, not just a single number.");
    return;
  }
  for(const f of sorted){
    const card = document.createElement('div');
    card.innerHTML = findingCardHtml(f);
    const cardEl = card.firstElementChild;
    thread.appendChild(cardEl);
    const threadKey = 'finding:' + f.id;
    const past = await loadChatThread(threadKey);
    if(past.length){
      cardEl.querySelector('.finding-explain')?.remove();
      past.forEach(m => { appendChatBubble(thread, m.role, m.content); askMargynGlobalHistory.push({ role:m.role, content:m.content }); });
    } else {
      wireFindingExplain(cardEl, f, thread, askMargynGlobalHistory);
    }
  }
}

/* History browser — lists every thread on the account, click one to
   reopen and continue it (the free-text form below switches to that
   thread's key via currentGlobalThreadKey). */
async function renderChatHistoryList(thread){
  thread.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'chat-history-row';
  back.innerHTML = '<div class="chr-label">← Back</div><div class="chr-preview">Return to current findings</div>';
  back.addEventListener('click', () => { currentGlobalThreadKey = 'global'; currentGlobalFocusLabel = null; thread.innerHTML = ''; renderGlobalFindings(thread); });
  thread.appendChild(back);

  const summaries = (await loadAllThreadSummaries()).filter(m => !isAgentHomeThread(m.thread_key));
  if(!summaries.length){
    appendChatBubble(thread, 'assistant', 'No past conversations yet.');
    return;
  }
  summaries.forEach(m => {
    const row = document.createElement('div');
    row.className = 'chat-history-row';
    const label = (m.thread_key === 'global' || m.thread_key.startsWith('global:')) ? 'General' : (m.vital || m.thread_key.replace(/^finding:|^vital:/, ''));
    row.innerHTML = '<div class="chr-label">' + escapeHtml(label) + '</div><div class="chr-preview">' + escapeHtml(m.content.slice(0,70)) + '</div>';
    row.addEventListener('click', async () => {
      thread.innerHTML = '';
      currentGlobalThreadKey = m.thread_key;
      currentGlobalFocusLabel = m.thread_key === 'global' ? null : (m.vital || label);
      askMargynGlobalHistory.length = 0;
      // Topic chip — same "Talking about" convention used everywhere else a
      // chat opens focused on something, so picking an old thread from this
      // browser says what it was about instead of dropping straight into
      // messages with no label.
      if(currentGlobalFocusLabel){
        const chip = document.createElement('div');
        chip.className = 'finding-card';
        chip.style.borderLeftColor = 'var(--border-2)';
        chip.innerHTML = '<div class="finding-tier" style="color:var(--text-2);">Talking about</div><div class="finding-summary">' + escapeHtml(currentGlobalFocusLabel) + '</div>';
        thread.appendChild(chip);
      }
      const past = await loadChatThread(m.thread_key, CHAT_CONTEXT_CAP * 2);
      past.forEach(pm => { appendChatBubble(thread, pm.role, pm.content); askMargynGlobalHistory.push({ role:pm.role, content:pm.content }); });
    });
    thread.appendChild(row);
  });
}

/* The floating button is now just a shortcut into the one Ask Margyn
   workspace (the page). There is no second conversation surface, so a
   question asked from the button and one asked on the page are the same
   thread, and the page's depth control governs every send. */
function initAskMargynGlobal(){
  const fab = document.getElementById('askMargynFab');
  if(!fab) return;
  const panel = document.getElementById('askMargynPanel');
  if(panel) panel.classList.add('hidden');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'view-history');
  fab.addEventListener('click', () => {
    showView('history');
    setTimeout(() => { const i = document.getElementById('historyThreadInput'); if(i) i.focus(); }, 80);
  });
}
initAskMargynGlobal();
/* Click the Pulse Score card to expand the deterministic breakdown of how
   it was calculated — the six vitals, their weights and how they roll up.
   This is the actual scoring math (computePulseScore / VITAL_WEIGHTS),
   not an AI explanation. */
/* togglePulseBreakdown() now scrolls to the one canonical vitals accordion
   rather than building a second breakdown table, so the old #pulseBreakdown
   container is gone from the markup. What still matters is that "Show the
   math" is only offered when there IS math to show — with no snapshot the
   toggle returns early, and the control was sitting there inviting a click
   that did nothing. */
function renderPulseBreakdown(){
  const card = document.getElementById('pulseCard');
  const hint = document.getElementById('pulseTapHint');
  const hasData = snapshots.length > 0;
  if(hint) hint.style.display = hasData ? 'flex' : 'none';
  if(!hasData && card) card.classList.remove('expanded');
  const host = document.getElementById('pulseBreakdown');
  if(!host || !hasData) return;
  const latest = snapshots[0];
  const vitals = latest.vitals || ZERO_VITALS;
  let weightedTotal = 0;
  const rows = vitals.map(v => {
    const w = VITAL_WEIGHTS[v.label] || 0;
    const score = Math.max(0, Math.min(100, v.score || 0));
    const contrib = score * w;
    weightedTotal += contrib;
    return '<div class="pb-row">' +
      '<div><div class="pb-label">' + v.label + '</div>' +
        '<div class="pb-bar-track"><div class="pb-bar-fill" data-w="' + Math.round(score) + '"></div></div></div>' +
      '<span class="pb-calc">' + Math.round(score) + ' × ' + Math.round(w * 100) + '%</span>' +
      '<span class="pb-points">' + contrib.toFixed(1) + '</span>' +
    '</div>';
  }).join('');
  host.innerHTML =
    '<div class="pb-eyebrow">How this number is calculated</div>' +
    '<div class="pb-intro">Your Pulse Score is a fixed weighted average of the six vitals below — computed directly from your numbers, not estimated or predicted.</div>' +
    '<div class="pb-row pb-head"><span>Vital</span><span>Score × weight</span><span>Points</span></div>' +
    rows +
    '<div class="pb-row pb-total"><div class="pb-label">Weighted total</div><span class="pb-calc"></span><span class="pb-points">' + weightedTotal.toFixed(1) + '</span></div>' +
    '<div class="pb-foot">Rounded to Pulse Score ' + latest.pulse_score + (latest.created_at ? ' · snapshot ' + fmtDate(latest.created_at) : '') + '</div>';
  if(host.classList.contains('open')){
    requestAnimationFrame(() => host.querySelectorAll('.pb-bar-fill').forEach(b => { b.style.width = b.dataset.w + '%'; }));
  }
}
/* "Show the math" no longer opens its own duplicate breakdown table —
   it jumps to and opens the first row of the one canonical vitals
   accordion below, so the score × weight = points math lives in exactly
   one place on this page instead of three. */
function togglePulseBreakdown(force){
  if(snapshots.length === 0) return;
  const section = document.getElementById('vitalsAccordionSection');
  if(!section) return;
  section.scrollIntoView({ behavior:'smooth', block:'start' });
  const firstRow = document.querySelector('#vitalsAccordion .sv-acc-row');
  if(firstRow && force !== false) openVitalAccordionRow(firstRow, true);
}
document.getElementById('pulseCard').addEventListener('click', (e) => {
  if(e.target.closest('.vital')) return;
  togglePulseBreakdown();
});

/* ---------- History tab ----------
   Full-page version of the same data the panel's history browser shows —
   every chat thread (reopenable and continuable) and every finding
   Margyn has ever surfaced, not just the latest batch. */
