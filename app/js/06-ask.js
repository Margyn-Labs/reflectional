/* ============================================================
   ASK MARGYN workspace (the "Ask Margyn" page). The floating FAB
   panel stays for quick questions from any tab; this is the room
   you sit in. Thread rail on the left, conversation in the middle,
   composer with a response-depth control at the bottom.
   ============================================================ */
const ASK_PROMPTS = [
  { k:'Collections', q:'Which customers should I chase first, and why those?' },
  { k:'Pulse Score', q:'Why did my Pulse Score move since the last snapshot?' },
  { k:'Runway',      q:'Is my working capital runway a problem right now?' },
  { k:'GST',         q:'Where is my biggest GST input-credit risk?' },
  { k:'Margin',      q:'What is actually driving my net margin this month?' },
  { k:'Sources',     q:'Where do my connected sources disagree with each other?' }
];
/* Response depth. Changes how much Margyn writes and how much of the
   thread it carries, never how a number is computed. */
const ASK_DEPTHS = {
  quick:    { label:'Quick',    note:'Short answer, fastest' },
  balanced: { label:'Balanced', note:'Default depth' },
  deep:     { label:'Deep',     note:'Heaviest model, slower. Use it when Balanced misses something' }
};
/* Deep runs the largest model. Soft daily cap per browser so a pilot leaning on
   it can't quietly run up the bill; once spent, Deep questions fall back to
   Balanced for the rest of the day. */
const ASK_DEEP_DAILY_CAP = 5;
function askDeepUsage(){
  const today = new Date().toISOString().slice(0,10);
  let u = { date: today, n: 0 };
  try { const raw = lsGet('margyn_ask_deep_usage', ''); if(raw){ const p = JSON.parse(raw); if(p && p.date === today) u = p; } } catch(e){}
  return u;
}
function askDeepRemaining(){ return Math.max(0, ASK_DEEP_DAILY_CAP - askDeepUsage().n); }
function askDeepConsume(){
  const u = askDeepUsage(); u.n += 1;
  lsSet('margyn_ask_deep_usage', JSON.stringify(u));
}
function askDepth(){
  const d = lsGet('margyn_ask_depth', 'balanced');
  return ASK_DEPTHS[d] ? d : 'balanced';
}
function setAskDepth(d){
  if(!ASK_DEPTHS[d]) return;
  lsSet('margyn_ask_depth', d);
  reflectAskDepth();
  toast('Response depth: ' + ASK_DEPTHS[d].label, {
    sub: d === 'deep'
      ? ASK_DEPTHS[d].note + ' · ' + askDeepRemaining() + ' of ' + ASK_DEEP_DAILY_CAP + ' left today'
      : ASK_DEPTHS[d].note
  });
}
function reflectAskDepth(){
  const d = askDepth();
  document.querySelectorAll('#askDepth button').forEach(b => b.classList.toggle('on', b.dataset.d === d));
  const note = document.getElementById('askDepthNote');
  if(note) note.textContent = d === 'deep'
    ? ASK_DEPTHS[d].note + ' · ' + askDeepRemaining() + ' of ' + ASK_DEEP_DAILY_CAP + ' left today'
    : ASK_DEPTHS[d].note;
}
function askGroundChips(){
  const host = document.getElementById('askGround'); if(!host) return;
  const live = (typeof CONN_FEED_MAP !== 'undefined' ? CONN_FEED_MAP : []).filter(c => connIsLive(c.key));
  const bits = live.map(c => '<span class="gchip"><i></i>' + escapeHtml(c.label) + '</span>');
  bits.unshift('<span class="gchip"><i></i>Your ledger</span>');
  host.innerHTML = bits.slice(0, 4).join('') + (bits.length > 4 ? '<span class="gchip">+' + (bits.length - 4) + '</span>' : '');
}
function askSetTitle(title, meta, agentId){
  const t = document.getElementById('askThreadTitle'); if(t) t.textContent = title;
  const m = document.getElementById('askThreadMeta'); if(m) m.textContent = meta || 'Grounded in your connected data';
  if(agentId) setThreadAvatar(agentId);
}
function renderAskEmpty(){
  const stream = document.getElementById('historyThreadMessages'); if(!stream) return;
  stream.innerHTML =
    '<div class="ask-empty">' +
      '<div class="ae-mark"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>' +
      '<h3>What do you want to know?</h3>' +
      '<p>Margyn reads the figures Margyn already computed, your ledger and every connected source, and explains them. It will tell you when something is a single-source signal rather than confirmed.</p>' +
      '<div class="ae-grid">' +
        ASK_PROMPTS.map(p => '<button type="button" data-q="' + escapeHtml(p.q) + '"><span class="k">' + escapeHtml(p.k) + '</span>' + escapeHtml(p.q) + '</button>').join('') +
      '</div>' +
    '</div>';
  stream.querySelectorAll('.ae-grid button').forEach(b => b.addEventListener('click', () => askSubmit(b.dataset.q)));
}
/* Start a clean thread in the page workspace. */
function askNewConversation(focus){
  const stream = document.getElementById('historyThreadMessages'); if(!stream) return;
  if(askActiveTab !== 'chats') askActivateTab('chats');
  askPageThreadKey = newGlobalThreadKey();
  askPageHistory.length = 0;
  askPageFocus = focus || null;
  askSetTitle(focus ? focus : 'New conversation', focus ? 'Focused on ' + focus : 'Grounded in your connected data', 'margyn');
  renderAskEmpty();
  askRewireComposer();
  document.querySelectorAll('#historyThreadList .chat-history-row').forEach(r => r.classList.remove('on'));
}
let askPageThreadKey = null, askPageFocus = null;
const askPageHistory = [];
function askRewireComposer(){
  const oldForm = document.getElementById('historyThreadForm'); if(!oldForm) return;
  const newForm = oldForm.cloneNode(true);
  oldForm.replaceWith(newForm);
  const input = document.getElementById('historyThreadInput');
  const stream = document.getElementById('historyThreadMessages');
  wireChatForm(newForm, input, stream, askPageHistory, () => askPageFocus, () => askPageThreadKey, false);
  askWireComposerInput(input, newForm);
}
function askWireComposerInput(input, form){
  if(!input) return;
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      if(input.value.trim()) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
      setTimeout(grow, 0);
    }
  });
  grow();
}
/* Same mechanics as askSubmit below, minus the title/header rewrite — used
   from an agent-home thread's empty state ("1 pending import → Show me")
   where the header should keep showing the agent's identity, not get
   replaced by the question text. */
function askSubmitInPlace(q){
  q = (q || '').trim(); if(!q) return;
  const stream = document.getElementById('historyThreadMessages');
  if(stream && stream.querySelector('.ask-empty')) stream.innerHTML = '';
  const input = document.getElementById('historyThreadInput');
  const form = document.getElementById('historyThreadForm');
  if(!input || !form) return;
  input.value = q;
  form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
}
function askSubmit(q){
  q = (q || '').trim(); if(!q) return;
  const stream = document.getElementById('historyThreadMessages');
  if(stream && stream.querySelector('.ask-empty')) stream.innerHTML = '';
  if(!askPageThreadKey) askPageThreadKey = newGlobalThreadKey();
  const input = document.getElementById('historyThreadInput');
  const form = document.getElementById('historyThreadForm');
  if(!input || !form) return;
  input.value = q;
  form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
  askSetTitle(q.length > 54 ? q.slice(0, 54) + '…' : q, 'Grounded in your connected data');
}
/* Entry point used by the command palette and by any other surface that
   wants to hand a question to Margyn: land on the page and ask it there. */
function askFromPage(q){
  q = (q || '').trim(); if(!q) return;
  showView('history');
  setTimeout(() => { askNewConversation(); askSubmit(q); }, 60);
}
/* Copy / regenerate actions on each answer, attached as a sibling row so
   wireChatForm can still set .textContent on the bubble itself. */
function askDecorateStream(){
  const stream = document.getElementById('historyThreadMessages'); if(!stream) return;
  stream.querySelectorAll('.margyn-msg.assistant:not(.loading)').forEach(msg => {
    if(msg.nextElementSibling && msg.nextElementSibling.classList.contains('msg-actions')) return;
    const row = document.createElement('div');
    row.className = 'msg-actions';
    row.innerHTML = '<button type="button" data-a="copy">Copy</button><button type="button" data-a="again">Ask again</button>';
    row.querySelector('[data-a="copy"]').addEventListener('click', () => {
      const body = msg.querySelector('.msg-body');
      if(navigator.clipboard) navigator.clipboard.writeText((body ? body.textContent : msg.textContent) || '');
      toast('Answer copied');
    });
    row.querySelector('[data-a="again"]').addEventListener('click', () => {
      let prev = msg.previousElementSibling;
      while(prev && !prev.classList.contains('user')) prev = prev.previousElementSibling;
      if(prev) askSubmit(prev.textContent);
    });
    msg.insertAdjacentElement('afterend', row);
  });
}
async function renderHistoryView(){
  const openEl = document.getElementById('historyThreadOpen');
  if(openEl) openEl.classList.remove('hidden');
  reflectAskDepth();
  askGroundChips();
  askActivateTab(askActiveTab); // re-applies current tab's visibility; refreshes its list/statuses
  // First visit this session lands on Margyn's own home thread (Agents tab
  // default) rather than an ad hoc conversation — matches the sidebar
  // defaulting to Agents. Returning to an already-open thread just rewires
  // the composer instead of resetting anything.
  if(!askPageThreadKey) await openAgentHome('margyn');
  else askRewireComposer();
  askGroundChips();
}
(function wireAskWorkspace(){
  const tabs = document.getElementById('askTabs');
  if(tabs) tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => askActivateTab(b.dataset.tab)));
  const depth = document.getElementById('askDepth');
  if(depth) depth.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setAskDepth(b.dataset.d)));
  const nc = document.getElementById('askNewChat');
  if(nc) nc.addEventListener('click', () => askNewConversation());
  const search = document.getElementById('askThreadSearch');
  if(search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('#historyThreadList .chat-history-row').forEach(r => {
      r.style.display = (!q || r.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
  const stream = document.getElementById('historyThreadMessages');
  if(stream && window.MutationObserver){
    new MutationObserver(() => askDecorateStream()).observe(stream, { childList:true, subtree:true });
  }
})();

async function renderHistoryLedgerList(){
  const listEl = document.getElementById('historyLedgerList');
  if(!listEl) return;
  listEl.innerHTML = '<div class="hint">Loading…</div>';
  ledgerEvents = await loadLedgerEvents();
  if(!ledgerEvents.length){
    listEl.innerHTML = '<div class="hint">No ledger activity yet. Add a receivable or payable under Ledger to start the trail.</div>';
    return;
  }
  const verb = { created:'Added', settled:'Settled', deleted:'Deleted', imported:'Imported', edited:'Edited' };
  listEl.innerHTML = ledgerEvents.map(e => {
    const d = new Date(e.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
    const who = e.party_name ? escapeHtml(e.party_name) : (e.note ? escapeHtml(e.note) : '—');
    const amt = (e.amount != null) ? inr(e.amount) : '';
    const src = e.source ? '<span class="source-badge self-reported">' + (e.source === 'upload' ? 'CSV upload' : 'Manual entry') + '</span>' : '';
    return '<div class="ledger-row"><div class="lr-main">' +
      '<div class="lr-party">' + (verb[e.event] || e.event) + ' ' + (e.entity_type || '') + ' · ' + who + ' ' + src + '</div>' +
      '<div class="lr-meta">' + d + (e.note && e.party_name ? ' · ' + escapeHtml(e.note) : '') + '</div>' +
      '</div><div class="lr-amount">' + amt + '</div></div>';
  }).join('');
}

async function renderHistoryThreadList(){
  const listEl = document.getElementById('historyThreadList');
  listEl.innerHTML = '<div class="hint">Loading…</div>';
  // Agent-home threads (Margyn/Chase/Close/Import's persistent conversations,
  // see the Agents tab) live in the same chat_messages table but belong in
  // that tab, not this ad hoc thread list.
  const summaries = (await loadAllThreadSummaries()).filter(m => !isAgentHomeThread(m.thread_key));
  if(!summaries.length){
    listEl.innerHTML = '<div class="hint" style="padding:14px 11px;">No conversations yet. Ask something on the right, or tap any number anywhere in Margyn.</div>';
    return;
  }
  listEl.innerHTML = '';
  summaries.forEach(m => {
    const row = document.createElement('div');
    row.className = 'chat-history-row';
    const label = (m.thread_key === 'global' || m.thread_key.startsWith('global:')) ? 'General' : (m.vital || m.thread_key.replace(/^finding:|^vital:/, ''));
    const when = new Date(m.created_at).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    row.innerHTML = '<div class="chr-label">' + escapeHtml(label) + ' · ' + when + '</div><div class="chr-preview">' + escapeHtml(m.content.slice(0,90)) + '</div>';
    row.addEventListener('click', () => {
      listEl.querySelectorAll('.chat-history-row').forEach(r => r.classList.remove('on'));
      row.classList.add('on');
      openHistoryThread(m.thread_key, label);
    });
    listEl.appendChild(row);
  });
}

async function openHistoryThread(threadKey, label){
  const openEl = document.getElementById('historyThreadOpen');
  openEl.classList.remove('hidden');
  const messagesEl = document.getElementById('historyThreadMessages');
  messagesEl.innerHTML = '';
  askPageThreadKey = threadKey;
  askSetTitle(label || 'Conversation', 'Reopened, same context as when you left it', 'margyn');
  const historyRef = [];
  const past = await loadChatThread(threadKey, 200); // full read for browsing, API calls still cap at CHAT_CONTEXT_CAP
  let lastAgentId = 'margyn';
  past.forEach(m => {
    appendChatBubble(messagesEl, m.role, m.content, m.agent_id);
    historyRef.push({ role:m.role, content:m.content });
    if(m.role === 'assistant' && m.agent_id) lastAgentId = m.agent_id;
  });
  threadAgentMap.set(threadKey, lastAgentId);
  if(lastAgentId !== 'margyn'){
    const meta = AGENT_META[lastAgentId] || AGENT_META.margyn;
    askSetTitle(label || meta.name, 'Reopened with ' + meta.name + ' — ' + meta.sub, lastAgentId);
  }
  askPageHistory.length = 0;
  historyRef.forEach(m => askPageHistory.push(m));
  // Prefer the vital recorded on the messages themselves over parsing the
  // thread key — the key format is internal (vital keys now carry a
  // session suffix, see sessionThreadKeyFor) and can change, while the
  // stored vital column on each message can't.
  askPageFocus = (past.length && past[0].vital) ? past[0].vital
    : (threadKey.startsWith('finding:') ? (findings.find(f => ('finding:' + f.id) === threadKey) || {}).vital : null);
  askRewireComposer();
  askDecorateStream();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
(function wireThreadBack(){
  const b = document.getElementById('historyThreadBack'); if(!b) return;
  b.addEventListener('click', () => askNewConversation());
})();

function renderHistoryFindingsList(){
  const listEl = document.getElementById('historyFindingsList');
  if(!findings.length){
    listEl.innerHTML = '<div class="hint">No findings yet, save a couple of snapshots to get started.</div>';
    return;
  }
  const sorted = findings.slice().sort((a,b) => new Date(b.generated_at) - new Date(a.generated_at));
  listEl.innerHTML = '';
  sorted.forEach(f => {
    const when = new Date(f.generated_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
    const row = document.createElement('div');
    row.className = 'finding-card ' + f.tier;
    row.style.marginBottom = '10px';
    row.innerHTML =
      '<div class="finding-tier">' + (f.tier === 'verified' ? 'Verified' : 'Signal') + ' · ' + escapeHtml(f.vital) + ' · ' + when + '</div>' +
      '<div class="finding-summary">' + escapeHtml(f.summary) + '</div>';
    listEl.appendChild(row);
  });
}

function numericFromVitalValue(raw){
  const { main } = splitValue(raw);
  const cleaned = String(main).replace(/[₹,%\s]/g,'');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/* Shared delta helper for the optional free-text context builder below —
   the model narrates pre-computed deltas, it never re-derives them. */
function numDelta(cur, prev){
  if(cur === null || cur === undefined || prev === null || prev === undefined) return { delta:null, pctChange:null, text:null };
  const delta = cur - prev;
  const pctChange = prev !== 0 ? (delta/Math.abs(prev))*100 : null;
  const text = pctChange !== null ? ((pctChange >= 0 ? '+' : '') + pctChange.toFixed(1) + '% vs last snapshot') : null;
  return { delta, pctChange, text };
}

function vitalTrendText(nd, scoreDelta, curVal, prevVal){
  if(scoreDelta === null) return null;
  const scoreText = scoreDelta === 0 ? 'score unchanged' : (scoreDelta > 0 ? 'score up ' + scoreDelta + ' pts' : 'score down ' + Math.abs(scoreDelta) + ' pts');
  return curVal + ' now, was ' + prevVal + (nd.text ? ' (' + nd.text + ')' : '') + ' — ' + scoreText + ' vs last snapshot.';
}

/* Context for the optional free-text follow-up only (/api/ask-margyn) —
   findings themselves no longer come from this path. Kept close to the
   original design: six vitals + Razorpay + Shopify + ledger digest, all
   arithmetic done here in plain JS. */
function buildMargynContext(focusLabel){
  const hasData = snapshots.length > 0;
  const latest = hasData ? snapshots[0] : null;
  const prev = hasData ? snapshots[1] : null;
  const vitals = hasData ? (latest.vitals || ZERO_VITALS) : ZERO_VITALS;

  // Raw P&L inputs behind the vitals — "Net Margin: 16%" alone doesn't
  // tell Margyn the actual revenue/profit figures that produced it. This
  // is what's usually meant by "the P&L" in casual use: top-line revenue,
  // net profit, spend, GST. It's still not a category-level breakdown
  // (no COGS vs opex split, no per-line-item detail) — that distinction
  // matters for what Margyn is honest about not having.
  const pnl = hasData ? {
    cash: Number(latest.cash) || 0,
    revenue: Number(latest.revenue) || 0,
    netProfit: Number(latest.net_profit) || 0,
    burn: Number(latest.burn) || 0,
    gstLeak: Number(latest.gst_leak) || 0,
    gstPayable: Number(latest.gst_payable) || 0,
    revenueTrend: prev ? numDelta(Number(latest.revenue)||0, Number(prev.revenue)||0).text : null,
    netProfitTrend: prev ? numDelta(Number(latest.net_profit)||0, Number(prev.net_profit)||0).text : null
  } : null;

  const vitalsOut = vitals.map(v => {
    const prevV = (prev && Array.isArray(prev.vitals)) ? prev.vitals.find(pv => pv.label === v.label) : null;
    const scoreDelta = prevV ? Math.round((v.score||0) - (prevV.score||0)) : null;
    const nd = prevV ? numDelta(numericFromVitalValue(v.value), numericFromVitalValue(prevV.value)) : { delta:null, pctChange:null, text:null };
    return {
      label: v.label, value: v.value, score: Math.round(v.score || 0),
      scoreDelta, pctChange: nd.pctChange,
      trend: prevV ? vitalTrendText(nd, scoreDelta, v.value, prevV.value) : null
    };
  });

  let payments = null;
  if(latest && latest.payments_data){
    const cur = computePaymentsMetrics(latest.payments_data);
    const prevMetrics = (prev && prev.payments_data) ? computePaymentsMetrics(prev.payments_data) : null;
    const failNd = prevMetrics ? numDelta(cur.failRate, prevMetrics.failRate) : { delta:null, text:null };
    const mdrNd = prevMetrics ? numDelta(cur.mdrPct, prevMetrics.mdrPct) : { delta:null, text:null };
    const lagNd = prevMetrics ? numDelta(cur.lag, prevMetrics.lag) : { delta:null, text:null };
    const grossNd = prevMetrics ? numDelta(cur.gross, prevMetrics.gross) : { delta:null, text:null };
    payments = {
      grossProcessed: Math.round(cur.gross), netSettled: Math.round(cur.netSettled),
      mdrPct: +cur.mdrPct.toFixed(2), failRatePct: +cur.failRate.toFixed(1),
      settlementLagDays: +cur.lag.toFixed(1), topPaymentMethod: cur.topMethodName + ' ' + Math.round(cur.topMethodPct) + '%',
      failRateTrend: failNd.text, mdrTrend: mdrNd.text, lagTrend: lagNd.text, grossTrend: grossNd.text
    };
  }

  let shopify = null;
  if(latest && latest.shopify_orders_data){
    const prevRows = (prev && prev.shopify_orders_data) ? prev.shopify_orders_data : null;
    shopify = latest.shopify_orders_data.map(r => {
      const prevR = prevRows ? prevRows.find(pr => pr.label === r.label) : null;
      return { label: r.label, value: r.value, trend: prevR ? numDelta(Number(r.value), Number(prevR.value)).text : null };
    });
  }

  const { recvTotal, recv90, paySoon } = ledgerAggregates();
  const topReceivables = receivables.slice().sort((a,b) => Number(b.amount) - Number(a.amount)).slice(0,5)
    .map(r => ({ party: r.party_name, amount: Number(r.amount), overdueDays: Math.max(0, -(daysFromToday(r.due_date)||0)) }));
  const topPayables = payables.slice().sort((a,b) => Number(b.amount) - Number(a.amount)).slice(0,5)
    .map(p => ({ party: p.party_name, amount: Number(p.amount), dueInDays: daysFromToday(p.due_date) }));

  // Last 10 findings across ALL past snapshots (not just the current
  // batch) so a question like "compare this to last month" has real
  // dated history to draw on instead of only the two most recent
  // snapshots. This is recency-based grounding, not full search — the
  // model sees a short dated list, it doesn't query the database itself.
  const findingsHistory = findings.slice()
    .sort((a,b) => new Date(b.generated_at) - new Date(a.generated_at))
    .slice(0, 10)
    .map(f => ({ date: f.generated_at, vital: f.vital, tier: f.tier, summary: f.summary }));

  // Zoho Books connector vitals — the CONNECTOR-SYNCED view of receivables/
  // payables/cash/GST/margin. Kept strictly separate from the self-entered
  // Quick Ledger below so the AI never blends the two (see formatMargynContext.js).
  const booksVitals = (zohoConnected && zohoVitals) ? {
    receivables: zohoVitals.receivables || null,
    payables: zohoVitals.payables || null,
    cash_position: zohoVitals.cash_position || null,
    gst_leakage: zohoVitals.gst_leakage || null,
    net_margin: zohoVitals.net_margin || null,
    working_capital_runway: zohoVitals.working_capital_runway || null,
    top_overdue_customers: zohoVitals.top_overdue_customers || null,
    flags: zohoVitals.flags || null
  } : null;

  // Divergence between the connector view and the self-entered view — surfaced
  // as a lead fact rather than silently double-recorded.
  let sourceDivergence = null;
  if (booksVitals) {
    const pairs = [
      ['receivables', booksVitals.receivables && Number(booksVitals.receivables.total), recvTotal],
      ['payables', booksVitals.payables && Number(booksVitals.payables.total), payables.reduce((s,p) => s + Number(p.amount||0), 0)]
    ];
    const msgs = [];
    pairs.forEach(([label, bookVal, ledgerVal]) => {
      if (bookVal == null || isNaN(bookVal) || !ledgerVal) return;
      const gap = Math.abs(bookVal - ledgerVal);
      if (gap > 25000 && gap / Math.max(bookVal, ledgerVal) > 0.10) {
        msgs.push(`Books ${label} ${inr(bookVal)} vs Quick Ledger ${inr(ledgerVal)} — ${inr(gap)} unexplained gap`);
      }
    });
    if (msgs.length) sourceDivergence = msgs.join('. ');
  }

  const reconciliation = (reconSummary && reconSummary.connected) ? {
    connected: true,
    counts: reconSummary.counts || {},
    provenance: reconSummary.provenance || null,
    reviewQueueLen: (reconSummary.review_queue || []).length
  } : null;

  // Durable connector provenance (needs_reauth / freshness) — see the
  // connector-status columns from the 2026-09-04 provenance migration and
  // formatMargynContext.js's connectorFreshnessBlock.
  const connectorStatus = [
    { type: 'Razorpay', connected: !!razorpayConnected,
      needsReauth: !!(razorpayStatus && razorpayStatus.needs_reauth),
      lastSuccessAt: (razorpayStatus && razorpayStatus.last_success_at) || null },
    { type: 'Zoho Books', connected: !!zohoConnected,
      needsReauth: !!(zohoVitals && zohoVitals.status === 'needs_reauth'),
      lastSuccessAt: (zohoVitals && zohoVitals.last_synced_at) || null },
    { type: 'Shopify', connected: !!shopifyConnected,
      needsReauth: !!(shopifyStore && shopifyStore.status === 'needs_reauthentication'),
      lastSuccessAt: (shopifyStore && shopifyStore.last_synced_at) || null }
  ];

  return {
    companyName: (currentProfile && currentProfile.company_name) || null,
    pulseScore: hasData ? latest.pulse_score : null,
    pulseScoreTrend: (hasData && prev) ? numDelta(latest.pulse_score, prev.pulse_score).text : null,
    vitals: vitalsOut,
    focusVital: focusLabel || null,
    payments,
    paymentsSource: hasData ? (latest.payments_source || null) : null,
    shopify,
    receivablesPayables: {
      selfEntered: true,
      totalOutstandingReceivables: Math.round(recvTotal),
      receivablesOver90d: Math.round(recv90),
      payablesDueNext30d: Math.round(paySoon),
      topReceivables,
      topPayables
    },
    booksVitals,
    reconciliation,
    sourceDivergence,
    findingsHistory,
    pnl,
    dataProvenance: hasData ? {
      source: latest.source,
      label: sourceLabel(latest.source),
      selfReported: SELF_REPORTED_SOURCES.includes(latest.source),
      // Per-field origin + tier, so the briefing can say which vitals are
      // verified, which rest on one connector, and which are still typed.
      fields: latest.input_provenance || null,
      confidence: latest.confidence != null ? Number(latest.confidence) : null,
      confidenceText: confidenceSummary(latest.input_provenance || null).text,
      conflicts: latest.source_conflicts || null
    } : null,
    razorpayLive: razorpayLiveSummary,
    connectors: { razorpay: !!razorpayConnected, shopify: !!shopifyConnected, zoho: !!zohoConnected, tally: !!tallyConnected },
    connectorStatus,
    tally: tallyData,
    crossLedger: buildCrossLedgerSummary()
  };
}

async function callAskMargyn(message, history, focusLabel, findingTier, agentId){
  const context = buildMargynContext(focusLabel);
  if(findingTier) context.focusFindingTier = findingTier;
  let depth = (typeof askDepth === 'function' ? askDepth() : 'balanced');
  if(depth === 'deep'){
    if(askDeepRemaining() <= 0){
      depth = 'balanced';
      toast('Deep limit reached for today', { sub: 'Answering at Balanced depth. Resets tomorrow.' });
    } else {
      askDeepConsume();
      if(typeof reflectAskDepth === 'function') reflectAskDepth();
    }
  }
  const { data: { session } } = await sbClient.auth.getSession();
  const res = await fetch('/api/ask-margyn', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      ...(session ? { 'Authorization':'Bearer ' + session.access_token } : {})
    },
    body: JSON.stringify({ message, history, context, depth, agentId: agentId || 'margyn' })
  });
  if(!res.ok){
    if(res.status === 429){
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "You've hit today's chat limit. Resets tomorrow.");
    }
    throw new Error('Ask Margyn request failed: ' + res.status);
  }
  const data = await res.json();
  mtrack('ask_message_sent', { msg_len: (message || '').length });
  return data;
}

