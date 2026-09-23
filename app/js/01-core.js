const SUPABASE_URL = 'https://lmegnxrixlrvyodqfthn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TcTCDSECsRxbDVXAnI893w_3BJC0Kgh';
let sbClient = null;
let currentUser = null;
let currentProfile = null;
let snapshots = [];
let receivables = [];
let razorpayLiveSummary = null; // real per-transaction aggregates, mirrors generate-findings.js's aggregateRazorpayLive
let payables = [];
let findings = []; // server-computed, confidence-tiered — see api/generate-findings.js
// khata (NEW) — free-tier customers/vendors ledger + invoicing
let khataParties = [];
let khataEntries = [];
let khataInvoices = [];
let khataInvoiceLineItems = [];
let khataActivePartyId = null;
let khataActiveInvoiceId = null;
let khataSuperTab = 'quick';
let khataTab = 'parties';
let invoiceDraftLines = [];
let paymentsData = null; // NEW — session-only, not yet persisted (see roadmap)
let settlementRows = null; // itemized settlement batches — session-only, "Mark as settled" is local state (see roadmap)
let settlementDailyTrend = null; // real per-day gross totals, last 7 uploaded days — null until upload
let razorpayConnected = false; // optional connector — supplements manual upload, doesn't replace it
let razorpayStatus = null;    // { needs_reauth, last_success_at } from connector_credentials — durable provenance
let lastSyncedAt = null;
let cashfreeConnected = false; // Cashfree connector — manual App ID/Secret key entry, settled-payment feed
let cashfreeStatus = null;    // last /api/sync-razorpay?action=cashfree-status payload
let odooConnected = false;   // Odoo connector — External API / JSON-RPC, manual key entry
let odooStatus = null;       // last /api/zoho?action=odoo-status payload (pre-aggregated, Signal-tier)
let zohoConnected = false;   // Zoho Books connector — OAuth 2.0, org-picker gated
let zohoVitals = null;       // last /api/zoho?action=vitals payload
let zohoLedgerRows = { receivables: [], payables: [] }; // row-level open invoices/bills from the vitals payload — for the unified ledger + cross-source logic
let reconSummary = null;     // last /api/reconcile?action=summary payload — read-only view of nightly reconciliation output
let agentActions = null;     // last /api/reconcile?action=agent-actions payload — Close & Collections agent proposal queue
let zohoPendingOrgRef = null;
let zohoChosenOrgId = null;
let shopifyConnected = false;  // Shopify connector — Custom App token, read-only
let shopifyStore = null;       // last /api/shopify?action=status store row
let shopifyPollTimer = null;   // nudges the resumable 90-day backfill along
let tallyConnected = false;    // Tally connector — local Windows desktop agent, read-only XML/HTTP over port 9000
let tallyInstalls = [];        // last /api/tally?action=status installs
let tallyData = null;          // last /api/tally?action=summary — pre-aggregated bills/vouchers/ledgers, all Signal-tier
let tallyPairPollTimer = null; // polls status every ~3s while the pairing modal is open
function inr(n){ return '₹' + Math.round(Number(n)||0).toLocaleString('en-IN'); }
function clamp(n){ return Math.max(0, Math.min(100, n)); }
function fmtDate(iso){ 
  const d = new Date(iso);
  const utcTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return utcTime.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) + ', ' + 
         utcTime.toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit', hour12:true });
}
function fmtDay(iso){ 
  const d = new Date(iso);
  const utcTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return utcTime.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }); 
}
function scoreClass(s){ return s >= 70 ? 'score-good' : s >= 40 ? 'score-warn' : 'score-bad'; }
function scoreBandCutoffs(){
  try {
    const raw = localStorage.getItem('margyn_score_bands');
    if(raw){ const o = JSON.parse(raw); if(o && Number(o.healthy) > Number(o.caution) && Number(o.caution) > 0) return { healthy:Number(o.healthy), caution:Number(o.caution) }; }
  } catch(e){}
  return { healthy:70, caution:40 };
}
function scoreBand(s){
  const c = scoreBandCutoffs();
  if(s >= c.healthy) return { cls:'good', color:'#0E8F5C', label:'Healthy' };
  if(s >= c.caution) return { cls:'warn', color:'#5B6472', label:'Caution' };
  return { cls:'bad', color:'#B3432E', label:'At risk' };
}
function withTimeout(p, ms, label){
  return Promise.race([ p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out.')), ms)) ]);
}
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(src); s.onerror = () => reject(new Error('blocked: ' + src));
    document.head.appendChild(s);
  });
}
function showAuthError(msg){
  const f = document.querySelector('.auth-form.active');
  const el = f ? f.querySelector('.auth-error') : document.getElementById('loginError');
  if(!el) return;
  el.style.color = ''; el.textContent = msg; el.classList.add('show');
}
function clearAuthErrors(){ document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('show')); }
/* Ops-console usage ping — writes an allowlisted row to product_events via
   /api/ops?action=track. Founder-only surface; this call is pure telemetry.
   Fire-and-forget: never awaited on a UI path, every failure swallowed. */
async function mtrack(name, props){
  try {
    if(!sbClient) return;
    const { data:{ session } } = await sbClient.auth.getSession();
    if(!session) return;
    await fetch('/api/ops?action=track', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + session.access_token },
      body: JSON.stringify({ name, props: props || {} }),
      keepalive: true
    });
  } catch(e){ /* tracking must never break the app */ }
}

async function bootAuth(){
  const sources = ['/supabase.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js', 'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js'];
  for(const src of sources){
    try { await loadScript(src); if(window.supabase){ initSupabase(); return; } } catch(e){ console.warn('[margyn]', e.message); }
  }
  showAuthError('Could not load the authentication library. Reload to retry.');
}
async function initSupabase(){
  const { createClient } = window.supabase;
  sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data:{ session } } = await sbClient.auth.getSession();
  await routeFor(session);
  sbClient.auth.onAuthStateChange((_e, s) => routeFor(s));
}
async function routeFor(session){
  if(!session){
    currentUser = null; currentProfile = null; snapshots = []; paymentsData = null;
    receivables = []; payables = []; settlementRows = null; settlementDailyTrend = null; shopifyOrdersData = null;
    khataParties = []; khataEntries = []; khataInvoices = []; khataInvoiceLineItems = []; khataActivePartyId = null; khataActiveInvoiceId = null; invoiceDraftLines = [];
    razorpayConnected = false; lastSyncedAt = null;
    zohoConnected = false; zohoVitals = null; zohoLedgerRows = { receivables: [], payables: [] }; zohoPendingOrgRef = null; zohoChosenOrgId = null;
    odooConnected = false; odooStatus = null;
    cashfreeConnected = false; cashfreeStatus = null;
    shopifyConnected = false; shopifyStore = null;
    if(shopifyPollTimer){ clearInterval(shopifyPollTimer); shopifyPollTimer = null; }
    tallyConnected = false; tallyInstalls = []; tallyData = null;
    if(tallyPairPollTimer){ clearInterval(tallyPairPollTimer); tallyPairPollTimer = null; }
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('authGate').classList.remove('hidden');
    document.getElementById('onboardGate').classList.add('hidden');
    document.getElementById('userEmail').textContent = '';
    document.getElementById('headCompany').textContent = '—';
    document.getElementById('headSub').textContent = '';
    renderVitals(ZERO_VITALS, false);
    document.getElementById('pulseNum').textContent = '0';
    clearAuthErrors();
    showView('summary');
    return;
  }
  currentUser = session.user;
  document.getElementById('userEmail').textContent = currentUser.email;
  document.getElementById('authGate').classList.add('hidden');
  currentProfile = await loadProfile();
  if(!currentProfile){ document.getElementById('appShell').classList.add('hidden'); document.getElementById('onboardGate').classList.remove('hidden'); return; }
  document.getElementById('onboardGate').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  mtrack('app_open');
  await refreshAll();
}
async function loadProfile(){
  const { data, error } = await sbClient.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if(error){ console.error('[margyn] loadProfile:', error); return null; }
  return data;
}
async function loadSnapshots(){
  const { data, error } = await sbClient.from('snapshots').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false }).limit(50);
  if(error){ console.error('[margyn] loadSnapshots:', error); return []; }
  return data || [];
}
document.getElementById('onboardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('obSubmit'); const err = document.getElementById('obError');
  err.classList.remove('show'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const row = { id: currentUser.id, company_name: document.getElementById('obCompany').value.trim(),
      revenue_range: document.getElementById('obRevenue').value, industry: document.getElementById('obIndustry').value.trim() || null,
      city: document.getElementById('obCity').value.trim() || null, gst_number: document.getElementById('obGst').value.trim().toUpperCase() || null };
    const ownerName = document.getElementById('obOwnerName').value.trim();
    const ownerRaw = document.getElementById('obOwnerPhone').value.trim();
    const owner = ownerRaw ? waNormalizeMobile(ownerRaw) : { digits:null, error:null };
    if(owner.error) throw new Error('WhatsApp number: ' + owner.error);
    const { error } = await withTimeout(sbClient.from('profiles').upsert(row), 20000, 'Saving profile');
    if(error) throw error;
    currentProfile = row;
    // Name the person behind the account. With a number, this becomes the
    // primary WhatsApp line + its named people row; without one, the name is
    // kept to prefill the WhatsApp Bell setup later. Best-effort: a failure
    // here must never block getting into the app.
    lsSet('margyn_owner_name', ownerName);
    if(owner.digits){
      try { await savePrimaryPerson(ownerName, owner.digits); }
      catch(pe){ console.error('[margyn] onboarding primary person:', pe); }
    }
    document.getElementById('onboardGate').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    await refreshAll();
  } catch(e2){ err.textContent = e2.message || 'Could not save.'; err.classList.add('show'); }
  finally { btn.disabled = false; btn.textContent = 'Continue'; }
});
const REV_LABEL = { under_5cr:'Under ₹5 cr', '5_25cr':'₹5–25 cr', '25_50cr':'₹25–50 cr', '50_100cr':'₹50–100 cr', '100_200cr':'₹100–200 cr', over_200cr:'Over ₹200 cr' };
function showView(name){
  // Ledger is now the Manual source on the Books hub. Old entry points
  // (⌘K actions, vital drill-downs, agent deep links) still say 'ledger'.
  if(name === 'ledger'){ booksActiveSource = 'manual'; name = 'books'; }
  ['summary','profile','ledger','invoicing','calculate','scores','history','payments','books','tally','analytics','connectors','settings','financing','agents'].forEach(v => { const el = document.getElementById('view-' + v); if(el){ el.classList.toggle('hidden', v !== name); if(v === name){ el.classList.remove('rd-fade'); void el.offsetWidth; el.classList.add('rd-fade'); } } });
  document.querySelectorAll('.pagenav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if(name === 'ledger'){ renderLedgerView(); }
  if(name === 'invoicing'){ renderInvoicingView(); }
  if(name === 'books'){ if(typeof renderBooksHub === 'function') renderBooksHub(); else renderZohoBooksTab(); }
  if(name === 'tally') renderTallyTab();
  if(name === 'analytics'){ if(typeof renderAnalyticsView === 'function') renderAnalyticsView(); }
  if(name === 'connectors'){ if(typeof renderConnectionsHub === 'function') renderConnectionsHub(); }
  if(name === 'settings'){ if(typeof renderSettingsView === 'function') renderSettingsView(); }
  if(name === 'scores'){ if(typeof renderScores === 'function') renderScores(); }
  if(name === 'history') renderHistoryView();
  if(name === 'agents') renderAgents();
  if(typeof rdRefreshCharts === 'function') rdRefreshCharts();
  window.scrollTo({ top:0, behavior:'smooth' });
}
