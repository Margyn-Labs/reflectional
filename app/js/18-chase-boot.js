/* ============================================================
   PAYMENT CHASE AGENT
   UI for the chase_agent deployment (agent_deployments.config) plus the
   "Gone cold" panel and per-receivable chase timeline. All sending /
   classification / cadence lives server-side in api/whatsapp.js
   (?action=cron-chase) + api/_lib/chaseEngine.js — nothing here sends a
   WhatsApp message. The client only reads whatsapp_chases /
   whatsapp_chase_replies (SELECT-own RLS) and updates its own
   whatsapp_chase_targets rows (owner UPDATE policy) for the row actions.
   ============================================================ */
const CHASE_DEFAULTS = {
  tone_preset: 'friendly', escalation_steepness: 'standard',
  days_before_due: [3], days_after_due: [3, 7, 14],
  max_chases: 4, min_amount: 0, auto_include: 'overdue_only'
};
let chaseTargets = [];

function chaseParseDayList(s){
  return String(s || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
}
function chaseDaysOverdue(due){
  if(!due) return 0;
  return Math.floor((Date.now() - new Date(String(due).slice(0,10) + 'T00:00:00Z')) / 86400000);
}
function chaseSeg(label, name, value, opts){
  return '<div class="agent-fieldset"><span class="agent-fs-label">' + label + '</span>' +
    '<span class="agent-seg" data-cseg="' + name + '">' +
      opts.map(o => '<button data-val="' + o[0] + '" class="' + (o[0] === value ? 'on' : '') + '">' + o[1] + '</button>').join('') +
    '</span></div>';
}
function chaseFormHtml(cfg){
  const c = Object.assign({}, CHASE_DEFAULTS, cfg || {});
  return chaseSeg('Tone', 'tone_preset', c.tone_preset, [['friendly','Friendly'],['firm','Firm']]) +
    chaseSeg('Escalation speed', 'escalation_steepness', c.escalation_steepness, [['gentle','Gentle'],['standard','Standard'],['firm','Firm']]) +
    '<div class="agent-fieldset"><span class="agent-fs-label">Cadence (days)</span>' +
      '<div class="hint" style="margin-bottom:8px;">Comma-separated. Before-due sends a soft heads-up; after-due chases climb in urgency.</div>' +
      '<label style="font-size:11px; color:var(--text-2);">Before due</label>' +
      '<input type="text" id="chaseBefore" value="' + c.days_before_due.join(', ') + '" placeholder="3">' +
      '<label style="font-size:11px; color:var(--text-2);">After due</label>' +
      '<input type="text" id="chaseAfter" value="' + c.days_after_due.join(', ') + '" placeholder="3, 7, 14"></div>' +
    '<div class="agent-fieldset"><span class="agent-fs-label">Max chases before it comes back to you</span>' +
      '<input type="number" id="chaseMax" value="' + c.max_chases + '" min="1" max="8"></div>' +
    '<div class="agent-fieldset"><span class="agent-fs-label">Only chase receivables above (₹)</span>' +
      '<input type="number" id="chaseMinAmt" value="' + (c.min_amount || 0) + '" min="0"></div>' +
    '<div class="agent-fieldset"><span class="agent-fs-label">Which receivables</span>' +
      '<select id="chaseInclude"><option value="overdue_only"' + (c.auto_include !== 'all_open' ? ' selected' : '') + '>Overdue only (plus the pre-due heads-up)</option>' +
      '<option value="all_open"' + (c.auto_include === 'all_open' ? ' selected' : '') + '>All open receivables</option></select></div>' +
    '<div class="agent-ref-note">First contact goes out as a pre-approved WhatsApp utility template &ldquo;on behalf of ' + escapeHtml((currentProfile && currentProfile.company_name) || 'your business') + '&rdquo;. Customer numbers are read from your Customers &amp; Invoicing parties &mdash; a receivable with no matching party phone is listed but not messaged.</div>';
}
function chaseWireSegs(){
  document.querySelectorAll('#agentContent .agent-seg[data-cseg]').forEach(seg => {
    seg.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
    }));
  });
}
function chaseReadForm(prevCfg){
  const seg = (name) => { const b = document.querySelector('#agentContent .agent-seg[data-cseg="' + name + '"] button.on'); return b ? b.getAttribute('data-val') : null; };
  const before = chaseParseDayList(document.getElementById('chaseBefore').value);
  const after = chaseParseDayList(document.getElementById('chaseAfter').value);
  return Object.assign({}, prevCfg || {}, {
    enabled: true,
    tone_preset: seg('tone_preset') || 'friendly',
    escalation_steepness: seg('escalation_steepness') || 'standard',
    days_before_due: before.length ? before : [3],
    days_after_due: after.length ? after : [3, 7, 14],
    max_chases: Math.max(1, Math.min(8, parseInt(document.getElementById('chaseMax').value, 10) || 4)),
    min_amount: Math.max(0, parseInt(document.getElementById('chaseMinAmt').value, 10) || 0),
    auto_include: document.getElementById('chaseInclude').value,
    updated_from: 'agents_tab'
  });
}
function startChaseDeploy(){
  openAgentModal(
    '<div class="agent-modal-title">Deploy Payment Chase</div>' +
    '<div class="hint">Runs once a day. It only ever messages the customers on your overdue receivables &mdash; never changes a balance, never touches your Pulse Score.</div>' +
    chaseFormHtml(null) +
    '<div class="btn-row"><button class="primary" id="chaseDeploySave">Deploy agent</button>' +
    '<span class="note" id="chaseDeployNote"></span></div>'
  );
  chaseWireSegs();
  document.getElementById('chaseDeploySave').addEventListener('click', () => persistChase('deploy'));
}
function openChaseConfigure(){
  const dep = agentDeployments['chase_agent'] || {};
  openAgentModal(
    '<div class="agent-modal-title">Configure Payment Chase</div>' +
    '<div class="hint">Changes apply from the next daily run. Contacts already mid-sequence keep their place in the cadence.</div>' +
    chaseFormHtml(dep.config || {}) +
    '<div class="btn-row"><button class="primary" id="chaseCfgSave">Save configuration</button>' +
    '<span class="note" id="chaseCfgNote"></span></div>'
  );
  chaseWireSegs();
  document.getElementById('chaseCfgSave').addEventListener('click', () => persistChase('configure'));
}
async function persistChase(mode){
  const noteId = mode === 'deploy' ? 'chaseDeployNote' : 'chaseCfgNote';
  const note = document.getElementById(noteId);
  note.className = 'note'; note.textContent = 'Saving…';
  const prev = (agentDeployments['chase_agent'] && agentDeployments['chase_agent'].config) || {};
  const config = chaseReadForm(prev);
  const nowIso = new Date().toISOString();
  try {
    if(mode === 'deploy'){
      const { error } = await withTimeout(
        sbClient.from('agent_deployments').upsert(
          { user_id: currentUser.id, agent_id: 'chase_agent', status: 'active', config: config, deployed_at: nowIso, updated_at: nowIso },
          { onConflict: 'user_id,agent_id' }),
        20000, 'Deploying agent');
      if(error) throw error;
    } else {
      const { error } = await withTimeout(
        sbClient.from('agent_deployments').update({ config: config, updated_at: nowIso })
          .eq('user_id', currentUser.id).eq('agent_id', 'chase_agent'),
        20000, 'Saving configuration');
      if(error) throw error;
    }
    note.className = 'note ok'; note.textContent = 'Saved.';
    setTimeout(() => { closeAgentModal(); renderAgents(); }, 800);
  } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not save.'; }
}

/* ---------- Gone-cold panel ---------- */
async function loadChaseTargets(){
  if(!currentUser) return;
  try {
    const { data, error } = await sbClient.from('whatsapp_chase_targets').select('*').eq('user_id', currentUser.id);
    if(error) throw error;
    chaseTargets = data || [];
  } catch(e){ console.error('[margyn] loadChaseTargets:', e); chaseTargets = []; }
}
function chaseIntentBadge(intent){
  if(!intent) return '<span class="lr-tag">no reply</span>';
  const map = {
    paid_claim:['ok','claims paid'], promise_to_pay:['ok','promised'], disputed:['review','disputed'],
    wrong_contact:['warn','wrong contact'], out_of_office:['','out of office'], no_response:['warn','no reply'],
    unclear:['','unclear'], opt_out:['warn','opted out']
  };
  const m = map[intent] || ['', intent];
  return '<span class="lr-tag ' + m[0] + '">' + m[1] + '</span>';
}
function chaseIsCold(t){
  if(['stopped','resolved_paid','opted_out','wrong_contact'].includes(t.state)) return false;
  if(t.state === 'disputed' || t.state === 'escalated_human') return true;
  if(t.broken_promise_count > 0) return true;
  return t.state === 'active' && (t.chases_sent || 0) >= 2 && !t.last_reply_at;
}
async function renderChaseCold(){
  const card = document.getElementById('chaseColdCard');
  if(!card) return;
  if(ledgerActiveTab !== 'receivables'){ card.classList.add('hidden'); return; }
  if(!currentUser){ card.classList.add('hidden'); return; }
  if(!Object.keys(agentDeployments).length){ try { await loadAgentData(); } catch(e){} }
  if(!agentDeployments['chase_agent']){ card.classList.add('hidden'); return; }
  await loadChaseTargets();
  const cold = chaseTargets.filter(chaseIsCold)
    .sort((a,b) => (Number(b.amount)||0) * Math.max(1, chaseDaysOverdue(b.due_date)) - (Number(a.amount)||0) * Math.max(1, chaseDaysOverdue(a.due_date)));
  if(!cold.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  document.getElementById('chaseColdTitle').textContent = 'Gone cold (' + cold.length + ')';
  const rows = cold.map(t => {
    const od = chaseDaysOverdue(t.due_date);
    return '<tr data-cid="' + t.id + '">' +
      '<td>' + escapeHtml(t.party_name || '—') + (t.contact_phone ? '' : ' <span class="lr-tag warn">no number</span>') + '</td>' +
      '<td class="num">' + inr(t.amount) + '</td>' +
      '<td>' + (od > 0 ? od + 'd overdue' : '—') + '</td>' +
      '<td>' + (t.chases_sent || 0) + '</td>' +
      '<td>' + (t.last_chase_at ? fmtDay(t.last_chase_at) : '—') + '</td>' +
      '<td>' + chaseIntentBadge(t.last_reply_intent) + '</td>' +
      '<td><div class="lr-actions">' +
        '<button class="lr-btn" data-cact="timeline">Timeline</button>' +
        '<button class="lr-btn" data-cact="takeover">Take over</button>' +
        '<button class="lr-btn" data-cact="paid">Mark paid</button>' +
        '<button class="lr-btn danger" data-cact="stop">Stop</button>' +
      '</div></td></tr>';
  }).join('');
  document.getElementById('chaseColdList').innerHTML =
    '<table class="ledger-table"><thead><tr><th>Customer</th><th class="num">Amount</th><th>Overdue</th><th>Chases</th><th>Last chase</th><th>Last reply</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  document.querySelectorAll('#chaseColdList tr[data-cid]').forEach(tr => {
    const t = cold.find(x => x.id === tr.dataset.cid);
    tr.querySelectorAll('[data-cact]').forEach(btn => btn.addEventListener('click', () => chaseRowAction(btn.dataset.cact, t)));
  });
}
/* Extracted so both the Gone-cold row buttons AND the Ask Margyn chat
   action cards can send a one-off chase / mark a chase paid through the
   exact same write path — see wireActionCardConfirm's runProposedAction. */
async function chaseTakeOver(t){
  await chaseUpdateTarget(t.id, { state: 'escalated_human', resolution: 'Taken over by the founder.', next_chase_at: null });
  const od = chaseDaysOverdue(t.due_date);
  const msg = 'Hi ' + (t.party_name || '') + ', ' + ((currentProfile && currentProfile.company_name) || 'we') + ' here regarding invoice ' + (t.invoice_ref || '') + ' for ' + inr(t.amount) + (od > 0 ? ', now ' + od + ' days overdue' : '') + '. Could we sort out payment this week?';
  if(t.contact_phone) window.open('https://wa.me/' + String(t.contact_phone).replace(/[^0-9]/g,'') + '?text=' + encodeURIComponent(msg), '_blank');
  else { navigator.clipboard && navigator.clipboard.writeText(msg); toast('No number on file', { kind:'info', sub:'Message copied to your clipboard.' }); }
}
async function chaseMarkPaid(t){
  await chaseUpdateTarget(t.id, { state: 'resolved_paid', resolution: 'Marked paid by the founder.', resolved_at: new Date().toISOString(), next_chase_at: null });
  if(t.receivable_id){
    try {
      await sbClient.from('receivables').update({ status: 'settled', settled_at: new Date().toISOString(), settled_amount: t.amount, settled_kind: 'received' }).eq('id', t.receivable_id);
      if(typeof refreshAll === 'function') await refreshAll();
    } catch(e){ console.error('[margyn] chase mark paid receivable:', e); }
  }
  renderLedgerView();
}
async function chaseRowAction(act, t){
  if(act === 'timeline') return openChaseTimeline(t);
  if(act === 'takeover') return chaseTakeOver(t);
  if(act === 'stop'){
    if(!confirm('Stop chasing ' + (t.party_name || 'this customer') + '?')) return;
    await chaseUpdateTarget(t.id, { state: 'stopped', resolution: 'Stopped by the founder.', next_chase_at: null });
    return;
  }
  if(act === 'paid') return chaseMarkPaid(t);
}
async function chaseUpdateTarget(id, patch){
  try {
    const { error } = await sbClient.from('whatsapp_chase_targets').update(patch).eq('id', id).eq('user_id', currentUser.id);
    if(error) throw error;
    await renderChaseCold();
  } catch(e){ toast('Could not update', { kind:'bad', sub: e.message || '' }); }
}
async function openChaseTimeline(t){
  openAgentModal('<div class="agent-modal-title">Chase history — ' + escapeHtml(t.party_name || '') + '</div><div class="loading">Loading…</div>');
  let chases = [], replies = [];
  try {
    const [cRes, rRes] = await Promise.all([
      sbClient.from('whatsapp_chases').select('*').eq('chase_target_id', t.id).order('created_at', { ascending: true }),
      sbClient.from('whatsapp_chase_replies').select('*').eq('chase_target_id', t.id).order('created_at', { ascending: true })
    ]);
    chases = cRes.data || []; replies = rRes.data || [];
  } catch(e){ console.error('[margyn] openChaseTimeline:', e); }
  const items = []
    .concat(chases.map(c => ({ ts: c.created_at, dir: 'out', head: 'Chase ' + c.chase_number + ' · ' + (c.escalation_tier || '').replace('_',' ') + (c.status !== 'sent' ? ' · ' + c.status : ''), body: c.message_body })))
    .concat(replies.map(r => ({ ts: r.created_at, dir: 'in', head: 'Reply · ' + r.intent.replace('_',' ') + (r.promise_date ? ' (by ' + r.promise_date + ')' : ''), body: r.reply_text || '' })))
    .sort((a,b) => new Date(a.ts) - new Date(b.ts));
  const state = '<div class="hint" style="margin-bottom:10px;">Current: <strong>' + (t.state || '').replace('_',' ') + '</strong>' +
    (t.next_chase_at && t.state === 'active' ? ' · next chase ' + fmtDay(t.next_chase_at) : '') +
    (t.promise_to_pay_date ? ' · promised ' + t.promise_to_pay_date : '') + '</div>';
  const body = items.length ? items.map(it =>
    '<div style="padding:8px 0; border-bottom:1px solid var(--border);">' +
      '<div style="font-size:11px; color:var(--text-2);">' + fmtDay(it.ts) + ' · ' + (it.dir === 'out' ? 'Margyn → customer' : 'customer → Margyn') + '</div>' +
      '<div style="font-size:12px; font-weight:600; margin:2px 0;">' + escapeHtml(it.head) + '</div>' +
      (it.body ? '<div style="font-size:12px; color:var(--text-1);">' + escapeHtml(it.body) + '</div>' : '') +
    '</div>').join('') : '<div class="hint">No messages yet.</div>';
  document.getElementById('agentContent').innerHTML =
    '<div class="agent-modal-title">Chase history — ' + escapeHtml(t.party_name || '') + '</div>' + state + body;
}

/* ============================================================
   SETTINGS — account delete (soft delete)
   Sets profiles.deleted_at, best-effort revokes every connector via the
   existing disconnect endpoints, then ends the Supabase session. The
   actual data purge is a separate scheduled job that keys off deleted_at.
   ============================================================ */
async function runAccountDelete(){
  const note = document.getElementById('delAcctNote');
  note.className = 'note'; note.textContent = 'Deleting…';
  const nowIso = new Date().toISOString();
  // Best-effort connector revokes — one failing must not block the others
  // or the deleted_at write.
  try { if(typeof shopifyStore !== 'undefined' && shopifyStore && shopifyStore.id)
    await shopifyApi('/api/shopify?action=disconnect', { method:'POST', body: JSON.stringify({ storeId: shopifyStore.id }) }); }
  catch(e){ console.error('[margyn] delete: shopify disconnect', e); }
  try { await zohoApi('/api/zoho?action=disconnect', { method:'POST', body: JSON.stringify({}) }); }
  catch(e){ console.error('[margyn] delete: zoho disconnect', e); }
  try { await sbClient.from('connector_credentials').update({ disconnected_at: nowIso })
    .eq('user_id', currentUser.id).is('disconnected_at', null); }
  catch(e){ console.error('[margyn] delete: razorpay/credentials revoke', e); }

  try {
    const { error } = await withTimeout(
      sbClient.from('profiles').update({ deleted_at: nowIso }).eq('id', currentUser.id),
      20000, 'Deleting account');
    if(error) throw error;
  } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not delete the account.'; return; }

  try { await sbClient.auth.signOut(); } catch(e){ /* session already gone is fine */ }

  document.getElementById('agentContent').innerHTML =
    '<div class="agent-modal-title">Account deleted</div>' +
    '<div class="hint">Your account is deactivated and all connectors have been revoked. Your data will be permanently removed by a scheduled cleanup. You have been signed out.</div>' +
    '<div class="btn-row"><button class="primary" id="delDoneBtn">Close</button></div>';
  document.getElementById('delDoneBtn').addEventListener('click', () => window.location.reload());
}

function confirmAccountDelete(){
  openAgentModal(
    '<div class="agent-modal-title">Delete account</div>' +
    '<div class="hint">This deactivates your account immediately, revokes every connected source (Razorpay, Zoho, Shopify), and signs you out. Data is purged later by a scheduled job. This cannot be undone from the app.</div>' +
    '<label style="text-transform:none; letter-spacing:0; font-family:\'Manrope\',sans-serif; font-size:13px; color:var(--text-1);">Type DELETE to confirm</label>' +
    '<input type="text" id="delAcctConfirm" placeholder="DELETE">' +
    '<div class="btn-row"><button class="primary" id="delAcctBtn" style="background:#B3432E;">Delete my account</button>' +
    '<button class="ghost" id="delAcctCancel" style="padding:13px 20px;">Cancel</button>' +
    '<span class="note" id="delAcctNote"></span></div>'
  );
  document.getElementById('delAcctCancel').addEventListener('click', closeAgentModal);
  document.getElementById('delAcctBtn').addEventListener('click', () => {
    if(document.getElementById('delAcctConfirm').value.trim() !== 'DELETE'){
      const n = document.getElementById('delAcctNote'); n.className = 'note bad'; n.textContent = 'Type DELETE to confirm.'; return;
    }
    runAccountDelete();
  });
}
document.getElementById('deleteAccountBtn').addEventListener('click', confirmAccountDelete);

renderVitals(ZERO_VITALS, false);
bootAuth();
