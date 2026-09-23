/* ============================================================
   BRIEFING — AI-generated narrative layer on top of deterministic vitals
   ============================================================ */
async function runBriefingGeneration(regenerate){
  const idle = document.getElementById('briefing-idle'); const text = document.getElementById('briefing-text');
  const meta = document.getElementById('briefing-meta'); const timestamp = document.getElementById('briefing-timestamp');
  const btn = regenerate ? document.getElementById('regenerateBriefing') : document.getElementById('generateBriefing');
  if(!snapshots.length) return;
  const latest = snapshots[0];
  btn.disabled = true; const origText = btn.textContent; btn.textContent = 'Generating…';
  idle.style.display = 'none'; meta.style.display = 'none';
  text.innerHTML = '<span class="loading">Margyn is reading your latest snapshot…</span>';
  try {
    const context = buildMargynContext(null);
    const res = await fetch('/api/generate-briefing', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ context })
    });
    if(!res.ok) throw new Error('Briefing request failed: ' + res.status);
    const data = await res.json();
    mtrack('briefing_opened', { regenerate: !!regenerate });
    const { error } = await sbClient.from('snapshots').update({ briefing: data.briefing, briefing_generated_at: new Date().toISOString() }).eq('id', latest.id);
    if(error) throw error;
    snapshots = await loadSnapshots();
    renderScores();
  } catch(err){
    text.textContent = "Couldn't generate a briefing just now, try again in a moment.";
    idle.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = origText; }
}
document.getElementById('generateBriefing').addEventListener('click', () => runBriefingGeneration(false));
document.getElementById('regenerateBriefing').addEventListener('click', () => runBriefingGeneration(true));
/* ============================================================
   AGENTS TAB
   Catalog of deployable automations. First real card: WhatsApp Bell,
   which wires the existing Opening/Closing Bell + inbound conversational
   backend (api/whatsapp.js, api/_lib/whatsappAgent.js) to a UI. No new
   WhatsApp backend logic is created here.

   Deploy state lives in agent_deployments (one row per user+agent_id).
   All of the Configure form saves into agent_deployments.config (JSONB)
   in a SINGLE write. Stakeholder routing rows are their own table
   (business_stakeholders, keyed on business_id) and are written
   independently of the config blob.

   NOTE (flagged to VP, not fixed here): api/whatsapp.js handleCron selects
   recipients purely on profiles.whatsapp_opt_in + whatsapp_phone and does
   NOT check agent_deployments.status. Pausing the agent sets status='paused'
   but the cron will keep sending until that filter is added server-side.
   ============================================================ */
const AGENT_VITALS = ['Cash Position','Receivables Aging','Payables Due (30d)','GST/ITC Leakage','Net Margin','Working Capital Runway'];
const WA_FREQ_LABELS = { opening:'Opening Bell only', closing:'Closing Bell only', both:'Both bells', none:'No Bells to this number', custom:'Custom schedule' };
let agentDeployments = {};
let agentStakeholders = [];

async function loadAgentData(){
  agentDeployments = {};
  agentStakeholders = [];
  // Every other load* guards on currentUser; this one didn't, so any call
  // before auth resolved threw twice into the console instead of no-opping.
  if(!currentUser) return;
  try {
    const { data } = await sbClient.from('agent_deployments').select('*').eq('user_id', currentUser.id);
    (data || []).forEach(r => { agentDeployments[r.agent_id] = r; });
  } catch(e){ console.error('[margyn] loadAgentData deployments:', e); }
  try {
    const { data } = await sbClient.from('business_stakeholders').select('*').eq('business_id', currentUser.id).order('created_at', { ascending:true });
    agentStakeholders = data || [];
  } catch(e){ console.error('[margyn] loadAgentData stakeholders:', e); }
}

function agentBadge(status){
  if(status === 'active') return '<span class="agent-badge active">Active</span>';
  if(status === 'paused') return '<span class="agent-badge paused">Paused</span>';
  return '<span class="agent-badge notdeployed">Not deployed</span>';
}

let agentsActiveTab = 'queue';
function setAgentsTab(tab){
  agentsActiveTab = tab;
  ['queue','roster','chat'].forEach(t => {
    const panel = document.getElementById('agentPanel-' + t);
    if(panel) panel.classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('#agentTabs button').forEach(b => b.classList.toggle('active', b.dataset.atab === tab));
  if(tab === 'queue'){ renderReconLedger(); renderAgentQueue(); renderSuggestionsView(); }
  if(tab === 'roster') renderAgentRoster();
  if(tab === 'chat') renderAgentChatList();
}
document.querySelectorAll('#agentTabs button').forEach(b => b.addEventListener('click', () => setAgentsTab(b.dataset.atab)));

/* Conversations tab: tiles that open the agent's own thread on Ask Margyn.
   Deliberately NOT a second chat UI — one composer, one thread store. */
function renderAgentChatList(){
  const el = document.getElementById('agentChatList'); if(!el || !currentUser) return;
  const ids = ['margyn','chase','close','import'];
  el.innerHTML = ids.map(id => {
    const meta = AGENT_META[id] || AGENT_META.margyn;
    return '<button type="button" class="ap-tile" data-agent-open="' + id + '">' +
      '<span class="agent-avatar">' + agentAvatarInner(id) + '</span>' +
      '<span class="ac-body"><span class="ac-name">' + escapeHtml(meta.name) + '</span>' +
      '<span class="ac-sub">' + escapeHtml(meta.sub) + '</span>' +
      '<span class="ac-status quiet" data-chat-status="' + id + '">…</span></span>' +
    '</button>';
  }).join('');
  el.querySelectorAll('[data-agent-open]').forEach(card => {
    card.addEventListener('click', () => { showView('history'); openAgentHome(card.dataset.agentOpen); });
  });
  ids.forEach(async id => {
    const st = await agentStatusLine(id);
    const n = el.querySelector('[data-chat-status="' + id + '"]');
    if(n && st.text){ n.textContent = st.text; n.classList.toggle('quiet', !!st.quiet); }
  });
}

/* Entry point for the whole page: paint the active tab, keep the badge true. */
async function renderAgents(){
  if(!currentUser) return;
  renderAgentsBadge();
  setAgentsTab(agentsActiveTab);
  if(agentsActiveTab === 'roster') return;          // renderAgentRoster already ran
  await renderAgentRoster();
}
