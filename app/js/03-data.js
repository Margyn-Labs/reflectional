/* ============================================================
   RAZORPAY CONNECTOR (optional, supplements manual upload)
   ============================================================ */
async function checkRazorpayConnection(){
  try {
    const { data, error } = await sbClient.from('connector_credentials')
      .select('id,needs_reauth,last_success_at').eq('user_id', currentUser.id).eq('connector_type', 'razorpay')
      .is('disconnected_at', null).maybeSingle();
    if(error){ razorpayConnected = false; razorpayStatus = null; return; }
    razorpayConnected = !!data;
    razorpayStatus = data ? { needs_reauth: !!data.needs_reauth, last_success_at: data.last_success_at || null } : null;
    if(razorpayConnected) await loadLastSyncTime();
  } catch(e){ razorpayConnected = false; razorpayStatus = null; }
}
async function loadLastSyncTime(){
  try {
    const { data, error } = await sbClient.from('connector_logs')
      .select('created_at').eq('user_id', currentUser.id).eq('connector_type', 'razorpay')
      .order('created_at', { ascending:false }).limit(1).maybeSingle();
    if(!error && data) lastSyncedAt = data.created_at;
  } catch(e){}
}
function renderRazorpayStatus(){
  const host = document.getElementById('razorpayStatus'); if(!host) return;
  if(razorpayConnected){
    const syncText = lastSyncedAt ? 'Last synced ' + fmtDate(lastSyncedAt) : 'Connected, syncing tonight at 2 AM IST';
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Razorpay</div>' +
        '<div class="lr-meta">'+syncText+'</div>' +
      '</div><span class="lr-tag ok">Connected</span></div>';
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Razorpay</div>' +
        '<div class="lr-meta">Not connected · optional, adds payment detail nightly on top of your uploads</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="connectRazorpayBtn">Connect</button></div></div>';
    const btn = document.getElementById('connectRazorpayBtn');
    if(btn) btn.addEventListener('click', openRazorpayModal);
  }
}
function openRazorpayModal(){
  const overlay = document.getElementById('razorpayOverlay');
  const host = document.getElementById('razorpayContent');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect Razorpay</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Adds payment-level detail from Razorpay each night at 2 AM IST. Your manual upload stays the primary source. This is a supplement.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Manual API key entry</div>' +
      '<input type="password" id="rzpKeyId" placeholder="Key ID (rzp_live_xxxxxxxxxxxx)" style="margin-bottom:8px;">' +
      '<input type="password" id="rzpKeySecret" placeholder="Key Secret">' +
      '<div style="font-size:11px; color:var(--text-2); margin:8px 0;">Get these from razorpay.com/settings/api-keys</div>' +
      '<div class="note bad" id="rzpError" style="display:none; margin-bottom:8px;"></div>' +
      '<div class="note ok" id="rzpSuccess" style="display:none; margin-bottom:8px;"></div>' +
      '<button id="rzpConnectBtn">Connect</button>' +
    '</div>';
  document.getElementById('rzpConnectBtn').addEventListener('click', async () => {
    const keyId = document.getElementById('rzpKeyId').value.trim();
    const keySecret = document.getElementById('rzpKeySecret').value.trim();
    const errorEl = document.getElementById('rzpError');
    const successEl = document.getElementById('rzpSuccess');
    const btn = document.getElementById('rzpConnectBtn');
    errorEl.style.display = 'none'; successEl.style.display = 'none';
    if(!keyId || !keySecret){ errorEl.textContent = 'Both fields required'; errorEl.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const { data:{ session } } = await sbClient.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/sync-razorpay?action=connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ keyId, keySecret })
      });
      const data = await res.json().catch(() => ({}));
      if(res.status === 401){ errorEl.textContent = 'Invalid credentials'; errorEl.style.display = 'block'; }
      else if(!res.ok){ errorEl.textContent = data.error || 'Connection failed'; errorEl.style.display = 'block'; }
      else {
        successEl.textContent = '✓ Connected! Syncing now…'; successEl.style.display = 'block';
        setTimeout(async () => { await refreshAll(); overlay.classList.add('hidden'); }, 1400);
      }
    } catch(err){ errorEl.textContent = 'Network error'; errorEl.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  });
  overlay.classList.remove('hidden');
}
document.getElementById('razorpayClose').addEventListener('click', () => document.getElementById('razorpayOverlay').classList.add('hidden'));
document.getElementById('razorpayOverlay').addEventListener('click', (e) => { if(e.target.id === 'razorpayOverlay') e.currentTarget.classList.add('hidden'); });

/* ============================================================
   CASHFREE CONNECTOR (optional, supplements manual upload)
   Manual App ID / Secret Key entry against /api/sync-razorpay?action=cashfree-connect;
   nightly cron sync server-side. Razorpay stays the primary gateway for
   the Payments tab — Cashfree adds its own tables + provenance.
   State vars (cashfreeConnected / cashfreeStatus) are declared near the
   Razorpay ones above.
   ============================================================ */
async function checkCashfreeConnection(){
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    const token = session?.access_token;
    const res = await fetch('/api/sync-razorpay?action=cashfree-status', { headers: { 'Authorization': `Bearer ${token}` } });
    if(!res.ok){ cashfreeConnected = false; cashfreeStatus = null; return; }
    const d = await res.json().catch(() => ({}));
    cashfreeConnected = !!d.connected;
    cashfreeStatus = d.connected ? { environment: d.environment, needs_reauth: !!d.needs_reauth, last_success_at: d.last_success_at || null } : null;
  } catch(e){ cashfreeConnected = false; cashfreeStatus = null; }
}
function renderCashfreeStatus(){
  const host = document.getElementById('cashfreeStatus'); if(!host) return;
  if(cashfreeConnected){
    const env = cashfreeStatus && cashfreeStatus.environment === 'production' ? '' : ' (sandbox)';
    const needsReauth = cashfreeStatus && cashfreeStatus.needs_reauth;
    const syncText = needsReauth
      ? 'Reconnect needed — Cashfree rejected the stored keys'
      : (cashfreeStatus && cashfreeStatus.last_success_at ? 'Last synced ' + fmtDate(cashfreeStatus.last_success_at) : 'Connected, syncing tonight');
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Cashfree' + env + '</div>' +
        '<div class="lr-meta">'+syncText+'</div>' +
      '</div><span class="lr-tag ' + (needsReauth ? 'bad' : 'ok') + '">' + (needsReauth ? 'Action needed' : 'Connected') + '</span></div>';
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Cashfree</div>' +
        '<div class="lr-meta">Not connected · optional, adds settled-payment and settlement detail nightly on top of your uploads</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="connectCashfreeBtn">Connect</button></div></div>';
    const btn = document.getElementById('connectCashfreeBtn');
    if(btn) btn.addEventListener('click', openCashfreeModal);
  }
}
function openCashfreeModal(){
  const overlay = document.getElementById('cashfreeOverlay');
  const host = document.getElementById('cashfreeContent');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect Cashfree</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Pulls settled payments and settlement batches from Cashfree each night. Your manual upload stays the primary source — this is a supplement.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Manual API key entry</div>' +
      '<select id="cfEnv" style="margin-bottom:8px;"><option value="production">Production</option><option value="sandbox">Sandbox (test)</option></select>' +
      '<input type="password" id="cfClientId" placeholder="App ID" style="margin-bottom:8px;">' +
      '<input type="password" id="cfClientSecret" placeholder="Secret Key">' +
      '<div style="font-size:11px; color:var(--text-2); margin:8px 0;">Get these from the Cashfree Merchant Dashboard → Developers → API Keys</div>' +
      '<div class="note bad" id="cfError" style="display:none; margin-bottom:8px;"></div>' +
      '<div class="note ok" id="cfSuccess" style="display:none; margin-bottom:8px;"></div>' +
      '<button id="cfConnectBtn">Connect</button>' +
    '</div>';
  document.getElementById('cfConnectBtn').addEventListener('click', async () => {
    const clientId = document.getElementById('cfClientId').value.trim();
    const clientSecret = document.getElementById('cfClientSecret').value.trim();
    const environment = document.getElementById('cfEnv').value;
    const errorEl = document.getElementById('cfError');
    const successEl = document.getElementById('cfSuccess');
    const btn = document.getElementById('cfConnectBtn');
    errorEl.style.display = 'none'; successEl.style.display = 'none';
    if(!clientId || !clientSecret){ errorEl.textContent = 'Both fields required'; errorEl.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const { data:{ session } } = await sbClient.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/sync-razorpay?action=cashfree-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ clientId, clientSecret, environment })
      });
      const data = await res.json().catch(() => ({}));
      if(res.status === 401){ errorEl.textContent = 'Invalid credentials'; errorEl.style.display = 'block'; }
      else if(!res.ok){ errorEl.textContent = data.error || 'Connection failed'; errorEl.style.display = 'block'; }
      else {
        successEl.textContent = '✓ Connected! Syncing now…'; successEl.style.display = 'block';
        setTimeout(async () => { await refreshAll(); overlay.classList.add('hidden'); }, 1400);
      }
    } catch(err){ errorEl.textContent = 'Network error'; errorEl.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  });
  overlay.classList.remove('hidden');
}
document.getElementById('cashfreeClose').addEventListener('click', () => document.getElementById('cashfreeOverlay').classList.add('hidden'));
document.getElementById('cashfreeOverlay').addEventListener('click', (e) => { if(e.target.id === 'cashfreeOverlay') e.currentTarget.classList.add('hidden'); });

async function loadReceivables(){
  const { data, error } = await sbClient.from('receivables').select('*').eq('user_id', currentUser.id).eq('status','open').order('due_date', { ascending:true, nullsFirst:false });
  if(error){ console.error('[margyn] loadReceivables:', error); return []; }
  return data || [];
}
/* Real, itemized Razorpay data for free-text chat — mirrors
   aggregateRazorpayLive() in api/generate-findings.js exactly (same math,
   same field names) so a Finding card and a chat answer can never
   disagree about what the real transaction data shows. Kept as two
   copies rather than one shared module because app.html and the
   serverless functions can't import from each other — if the aggregation
   logic ever changes, it has to change in both places together. */
async function loadRazorpayLiveSummary(){
  try {
    const [txRes, setRes, refRes] = await Promise.all([
      sbClient.from('razorpay_transactions').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(1000),
      sbClient.from('razorpay_settlements').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(300),
      sbClient.from('razorpay_refunds').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(300)
    ]);
    const transactions = txRes.data || [];
    const settlements = setRes.data || [];
    const refunds = refRes.data || [];
    if(transactions.length < 4) return null; // too little real volume to say anything meaningful yet

    const mid = Math.floor(transactions.length / 2);
    const newerHalf = transactions.slice(0, mid);
    const olderHalf = transactions.slice(mid);
    function statsFor(txns){
      const cap = txns.filter(t => t.status === 'captured');
      const avgTicket = cap.length ? cap.reduce((s,t) => s + Number(t.amount||0), 0) / cap.length / 100 : null;
      const failRate = txns.length ? (txns.filter(t => t.status === 'failed').length / txns.length) * 100 : null;
      return { avgTicket, failRate };
    }
    const newer = statsFor(newerHalf), older = statsFor(olderHalf);
    const captured = transactions.filter(t => t.status === 'captured');

    const methodCounts = {};
    transactions.forEach(t => { const m = t.method || 'unknown'; methodCounts[m] = (methodCounts[m]||0) + 1; });
    const topMethod = Object.entries(methodCounts).sort((a,b) => b[1]-a[1])[0];

    const refundRate = captured.length ? (refunds.length / captured.length) * 100 : null;
    const lagDays = settlements.filter(s => s.created_at && s.processed_at)
      .map(s => (new Date(s.processed_at) - new Date(s.created_at)) / (1000*60*60*24));
    const avgLag = lagDays.length ? lagDays.reduce((a,b)=>a+b,0)/lagDays.length : null;

    return {
      txnCount: transactions.length,
      avgTicket: newer.avgTicket,
      avgTicketTrendPct: (newer.avgTicket!==null && older.avgTicket!==null && older.avgTicket!==0) ? ((newer.avgTicket-older.avgTicket)/Math.abs(older.avgTicket))*100 : null,
      failRate: newer.failRate,
      failRateTrendPct: (newer.failRate!==null && older.failRate!==null && older.failRate!==0) ? ((newer.failRate-older.failRate)/Math.abs(older.failRate))*100 : null,
      refundRate,
      topMethod: topMethod ? topMethod[0] + ' ' + Math.round((topMethod[1]/transactions.length)*100) + '%' : null,
      avgSettlementLagDays: avgLag
    };
  } catch(e){ console.error('[margyn] loadRazorpayLiveSummary:', e); return null; }
}
async function loadPayables(){
  const { data, error } = await sbClient.from('payables').select('*').eq('user_id', currentUser.id).eq('status','open').order('due_date', { ascending:true, nullsFirst:false });
  if(error){ console.error('[margyn] loadPayables:', error); return []; }
  return data || [];
}
async function loadFindings(){
  const { data, error } = await sbClient.from('findings').select('*').eq('user_id', currentUser.id).order('generated_at', { ascending:false });
  if(error){ console.error('[margyn] loadFindings:', error); return []; }
  return data || [];
}
/* Append-only Quick Ledger activity log (public.ledger_events). Every add,
   settle, delete or CSV import writes one row so "Mark received" is a real
   audit event, not an untraceable DELETE. Best-effort: a logging failure
   must never block the underlying ledger action. */
let ledgerEvents = [];
async function loadLedgerEvents(){
  const { data, error } = await sbClient.from('ledger_events').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(50);
  if(error){ console.error('[margyn] loadLedgerEvents:', error); return []; }
  return data || [];
}
async function logLedgerEvent(evt){
  try {
    await sbClient.from('ledger_events').insert({
      user_id: currentUser.id,
      entity_type: evt.entityType || null,
      entity_id: evt.entityId || null,
      event: evt.event,
      party_name: evt.partyName || null,
      amount: (evt.amount != null) ? Number(evt.amount) : null,
      source: evt.source || null,
      note: evt.note || null
    });
  } catch(e){ console.error('[margyn] logLedgerEvent:', e); }
}
/* Fire-and-forget trigger for the server-side Findings pipeline
   (api/generate-findings.js) — called right after a snapshot is saved so
   findings are already computed and persisted by the time anyone opens
   the panel. Non-blocking: never awaited by the save flow itself, and
   failures here should never surface as an error to the user — the app
   works fine without fresh findings, it just won't have new ones yet. */
async function triggerFindingsGeneration(){
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    if(!session) return;
    const res = await fetch('/api/generate-findings', {
      method:'POST',
      headers:{ 'Authorization':'Bearer ' + session.access_token }
    });
    if(res.ok) findings = await loadFindings();
  } catch(e){ console.error('[margyn] triggerFindingsGeneration:', e); }
}
function daysFromToday(dateStr){
  if(!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date(new Date().toDateString())) / 86400000);
}
function recvBucket(dueDate){
  const days = daysFromToday(dueDate);
  if(days === null) return { label:'no due date', tag:'' };
  const overdue = -days;
  if(overdue <= 0) return { label:'not yet due', tag:'ok' };
  if(overdue <= 90) return { label:overdue+'d overdue', tag:'warn' };
  return { label:overdue+'d overdue', tag:'bad' };
}
function payUrgency(dueDate){
  const days = daysFromToday(dueDate);
  if(days === null) return { label:'no due date', tag:'warn' };
  if(days < 0) return { label:(-days)+'d overdue', tag:'bad' };
  if(days <= 7) return { label:'due in '+days+'d', tag:'bad' };
  if(days <= 30) return { label:'due in '+days+'d', tag:'warn' };
  return { label:'due in '+days+'d', tag:'ok' };
}
function ledgerAggregates(){
  const recvTotal = receivables.reduce((s,r) => s + Number(r.amount), 0);
  const recv90 = receivables.reduce((s,r) => { const d = daysFromToday(r.due_date); return (d !== null && -d > 90) ? s + Number(r.amount) : s; }, 0);
  const paySoon = payables.reduce((s,p) => { const d = daysFromToday(p.due_date); return (d === null || d <= 30) ? s + Number(p.amount) : s; }, 0);
  return { recvTotal, recv90, paySoon };
}
async function saveLedgerSnapshot(){
  const latest = snapshots[0];
  if(!latest){ return; } // no baseline cash/revenue yet — user needs one snapshot from Upload & calculate first
  const { recvTotal, recv90, paySoon } = ledgerAggregates();
  // Don't spawn a near-duplicate snapshot when the ledger aggregates haven't
  // actually moved (e.g. a settle immediately followed by a re-render) — it
  // just pollutes the Scores/History timeline with identical source:'ledger' rows.
  if(latest.source === 'ledger'
     && Math.round(Number(latest.recv_total)||0) === Math.round(recvTotal)
     && Math.round(Number(latest.recv_90)||0) === Math.round(recv90)
     && Math.round(Number(latest.pay_soon)||0) === Math.round(paySoon)){
    return;
  }
  // Carry the latest snapshot's payments block forward untouched — a ledger
  // edit has no payments data of its own, and creating a new snapshot with
  // payments_data left out would otherwise blank the Payments tab back to
  // zero until the next Razorpay sync re-populates it.
  const carryPayments = latest.payments_data ? {
    paymentsData: latest.payments_data, paymentsSource: latest.payments_source || 'manual',
    settlementRows: latest.settlement_rows, settlementDailyTrend: latest.settlement_daily_trend
  } : {};
  await saveSnapshot({ cash: Number(latest.cash)||0, recvTotal, recv90, paySoon, revenue: Number(latest.revenue)||0,
    netProfit: Number(latest.net_profit)||0, burn: Number(latest.burn)||1, gstLeak: Number(latest.gst_leak)||0,
    gstPayable: Number(latest.gst_payable)||0, source:'ledger', ...carryPayments });
  snapshots = await loadSnapshots();
  renderScores();
}
function renderHeader(){
  document.getElementById('headCompany').textContent = currentProfile.company_name;
  const bits = [REV_LABEL[currentProfile.revenue_range], currentProfile.industry, currentProfile.city].filter(Boolean);
  document.getElementById('headSub').textContent = bits.join(' · ');
}
function renderProfile(){
  document.getElementById('pfCount').textContent = snapshots.length;
  document.getElementById('pfPulse').textContent = snapshots.length ? snapshots[0].pulse_score : 0;
  document.getElementById('pfSince').textContent = snapshots.length ? fmtDay(snapshots[snapshots.length-1].created_at) : '—';
  document.getElementById('pfEmail').textContent = currentUser.email;
  document.getElementById('pfCreated').textContent = currentUser.created_at ? fmtDay(currentUser.created_at) : '—';
  document.getElementById('pfCompany').value = currentProfile.company_name || '';
  document.getElementById('pfRevenue').value = currentProfile.revenue_range || '';
  document.getElementById('pfIndustry').value = currentProfile.industry || '';
  document.getElementById('pfCity').value = currentProfile.city || '';
  renderRazorpayStatus();
  renderCashfreeStatus();
  renderPeopleMounts(true);
}
document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('pfSave'); const note = document.getElementById('pfNote');
  note.className = 'note'; note.textContent = 'Saving…'; btn.disabled = true;
  try {
    const row = { id: currentUser.id, company_name: document.getElementById('pfCompany').value.trim(),
      revenue_range: document.getElementById('pfRevenue').value, industry: document.getElementById('pfIndustry').value.trim() || null,
      city: document.getElementById('pfCity').value.trim() || null };
    const { error } = await withTimeout(sbClient.from('profiles').upsert(row), 20000, 'Saving profile');
    if(error) throw error;
    currentProfile = row; renderHeader();
    note.className = 'note ok'; note.textContent = 'Saved.';
    setTimeout(() => { note.textContent = ''; note.className = 'note'; }, 2500);
  } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not save.'; }
  finally { btn.disabled = false; }
});
const VITAL_ACCENTS = { 'Cash Position':'#0E8F5C','Receivables Aging':'#B3432E','Payables Due (30d)':'#5B6472','GST/ITC Leakage':'#B3432E','Net Margin':'#0E8F5C','Working Capital Runway':'#0E8F5C' };
const ZERO_VITALS = [
  { label:'Cash Position', value:'₹0', score:0 },
  { label:'Receivables Aging', value:'₹0 over 90d', score:0 },
  { label:'Payables Due (30d)', value:'₹0', score:0 },
  { label:'GST/ITC Leakage', value:'₹0', score:0 },
  { label:'Net Margin', value:'0.0%', score:0 },
  { label:'Working Capital Runway', value:'0.0 months', score:0 }
];
// Mirrors generate-findings.js's SELF_REPORTED_SOURCES exactly — these are
// the only snapshots.source values that exist in the schema today, and all
// three mean a human typed or uploaded the number. Kept as one small
// constant in both places rather than a shared import, since app.html and
// the serverless functions can't share a module — if this list ever
// changes, it has to change in both files together.
// Keep byte-identical with SELF_REPORTED_SOURCES in api/generate-findings.js —
// both lists define which snapshots.source values mean "a human typed/uploaded this".
const SELF_REPORTED_SOURCES = ['manual', 'upload', 'ledger'];
function sourceLabel(source){
  if(source === 'manual') return 'Manual entry';
  if(source === 'upload') return 'CSV upload';
  if(source === 'ledger') return 'Ledger entry';
  if(source === 'resolved') return 'Resolved from connected sources';
  return 'Connector-synced';
}
/* One provenance/reconciliation tag vocabulary, used everywhere a data
   element's origin or match state is shown. Returns {label, cls} where cls
   is a .source-badge / .lr-tag modifier. */
function provTag(kind){
  switch(kind){
    case 'self':            return { label:'Self-reported',       cls:'self-reported' };
    case 'connector':       return { label:'Connector-synced',    cls:'connector' };
    case 'verified':        return { label:'Verified · 2 sources',cls:'verified' };
    case 'unreconciled':    return { label:'Not yet reconciled',  cls:'unreconciled' };
    case 'review':          return { label:'Needs review',        cls:'review' };
    case 'matched_bank':    return { label:'Matched to bank',     cls:'verified' };
    case 'matched_gateway': return { label:'Matched to gateway',  cls:'verified' };
    default:                return { label:kind || '',            cls:'' };
  }
}
/* Provenance + reconciliation tags for a Quick Ledger row (receivable/payable). */
function ledgerRowTags(r){
  const src = provTag('self'); // Quick Ledger rows are always self-entered (manual or CSV upload)
  const recRaw = r.reconciliation_status || 'unreconciled';
  const rec = provTag(recRaw === 'matched_bank' ? 'matched_bank' : recRaw === 'matched_gateway' ? 'matched_gateway' : recRaw === 'review' ? 'review' : 'unreconciled');
  return '<span class="lr-tag ' + src.cls + '">' + src.label + '</span>' +
         '<span class="lr-tag ' + rec.cls + '">' + rec.label + '</span>';
}
const RING_CIRC = 238.76; // semicircle arc length of the Pulse Score gauge (r=76)
function renderScores(){
  const hasData = snapshots.length > 0;
  const latest = hasData ? snapshots[0] : null;
  const prev = snapshots[1];
  const card = document.getElementById('pulseCard');
  card.classList.toggle('is-zero', !hasData);
  const pulseVal = hasData ? latest.pulse_score : 0;
  document.getElementById('pulseNum').textContent = pulseVal;
  const band = hasData ? scoreBand(pulseVal) : { color:'#5C6B7A', label:'No data yet' };
  card.style.setProperty('--band-color', band.color);
  const badge = document.getElementById('pulseBandBadge');
  badge.textContent = band.label; badge.style.display = hasData ? 'inline-block' : 'none';
  const srcBadge = document.getElementById('pulseSourceBadge');
  if(hasData){
    const selfReported = SELF_REPORTED_SOURCES.includes(latest.source);
    srcBadge.textContent = selfReported ? (sourceLabel(latest.source)) : 'Connector-synced';
    srcBadge.className = 'source-badge ' + (selfReported ? 'self-reported' : 'connector');
    srcBadge.style.display = 'inline-flex';
    srcBadge.title = selfReported ? 'This snapshot was entered or uploaded by hand, not pulled from a live connector.' : 'This snapshot was synced from a connected data source.';
  } else {
    srcBadge.style.display = 'none';
  }
  const arc = document.getElementById('pulseArc');
  const pct = Math.max(0, Math.min(100, pulseVal));
  arc.setAttribute('stroke-dashoffset', (RING_CIRC * (1 - pct/100)).toFixed(2));
  arc.setAttribute('stroke', band.color);
  const deltaEl = document.getElementById('pulseDelta');
  if(!hasData){ deltaEl.textContent = 'no snapshots yet, upload data to calculate'; }
  else if(prev){ const d = latest.pulse_score - prev.pulse_score;
    deltaEl.textContent = d === 0 ? 'No change since last snapshot'
      : (d > 0 ? '▲ +' : '▼ ') + Math.abs(d) + (Math.abs(d) === 1 ? ' point' : ' points') + ' since last';
    deltaEl.style.color = d === 0 ? '' : (d > 0 ? 'var(--emerald-bright)' : 'var(--rose)'); }
  else { deltaEl.textContent = 'first snapshot'; }
  let asOfText = hasData ? 'Synced ' + fmtDate(latest.created_at) : 'No snapshot yet';
  document.getElementById('pulseAsOf').textContent = asOfText;
  const head = document.getElementById('scHeadline');
  if(head) head.textContent = hasData ? ('Why your Pulse Score is ' + pulseVal) : 'Your Pulse Score';
  renderConfidence();
  renderScoreMetrics();
  renderVitals(hasData ? (latest.vitals || ZERO_VITALS) : ZERO_VITALS, hasData);
  renderHistory(snapshots);
  renderPulseTrendChart();
  renderPulseBreakdown();
  const idle = document.getElementById('briefing-idle'); const text = document.getElementById('briefing-text'); const hint = document.getElementById('briefHint');
  const meta = document.getElementById('briefing-meta'); const timestamp = document.getElementById('briefing-timestamp');
  if(!hasData){ idle.style.display = 'none'; text.textContent = ''; hint.textContent = 'Add a snapshot on the Upload & calculate tab to generate your first briefing.'; meta.style.display = 'none'; }
  else {
    hint.textContent = 'Generated from your latest snapshot.'; idle.style.display = latest.briefing ? 'none' : 'block'; text.textContent = latest.briefing || '';
    if(latest.briefing){ meta.style.display = 'flex'; timestamp.textContent = latest.briefing_generated_at ? 'Generated ' + fmtDate(latest.briefing_generated_at) : ''; }
    else { meta.style.display = 'none'; }
  }
}
function splitValue(raw){ const i = String(raw).indexOf(' over '); return i === -1 ? { main:String(raw), suffix:'' } : { main:String(raw).slice(0,i), suffix:String(raw).slice(i+1) }; }
const VITAL_EXPLAIN = {
  'Cash Position': 'How many months your current cash balance covers at your current monthly burn, mapped against a 3–6 month healthy range.',
  'Receivables Aging': 'Share of outstanding receivables that are overdue by more than 90 days: the money you’re least likely to collect without a push.',
  'Payables Due (30d)': 'How much of your cash is already spoken for by bills due in the next 30 days.',
  'GST/ITC Leakage': 'Input tax credit sitting unclaimed, as a share of your monthly GST payable: cash you’re entitled to but haven’t reconciled yet.',
  'Net Margin': 'Net profit as a share of revenue, benchmarked against your industry.',
  'Working Capital Runway': 'Months of operating expenses covered by cash plus receivables, minus payables due.'
};
