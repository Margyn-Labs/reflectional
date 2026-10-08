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
/* One rupee formatter for the whole app (plan §6).
   fmtINR(n)          -> full Indian grouping, for tables: ₹1,24,36,500
   fmtINR(n, 'tile')  -> lakh / crore, for KPI tiles: ₹1.24 Cr, ₹18.6 L
   Tiles should carry the full figure in a title attribute for hover. */
function fmtINR(n, mode){
  const v = Math.round(Number(n) || 0), a = Math.abs(v), s = v < 0 ? '−' : '';
  if(mode === 'tile'){
    if(a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
    if(a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + ' L';
  }
  return (v < 0 ? '-' : '') + '₹' + a.toLocaleString('en-IN');
}
function inr(n){ return fmtINR(n); }
/* Tally names can carry a line break inside them ("GLENMARK&#13;&#10;PHARMA" or a real CR/LF): one clean line. */
function mgCleanName(n){ return String(n == null ? '' : n).replace(/(&#13;|&#10;|&#x0?[dD];|&#x0?[aA];|[\r\n\t])+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
function clamp(n){ return Math.max(0, Math.min(100, n)); }
// India time, whatever the computer's clock is set to. These used to add 5h30 by hand on top of the browser's
// own India time, so every time in the app read 5h30 late (a 6:58 pm sync showed as 12:28 am the next day).
const MG_TZ = 'Asia/Kolkata';
function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { timeZone:MG_TZ, day:'numeric', month:'short', year:'numeric' }) + ', ' +
         d.toLocaleTimeString('en-IN', { timeZone:MG_TZ, hour:'numeric', minute:'2-digit', hour12:true });
}
function fmtDay(iso){
  return new Date(iso).toLocaleDateString('en-IN', { timeZone:MG_TZ, day:'numeric', month:'short', year:'numeric' });
}
/** Today's date in India as 'YYYY-MM-DD'. new Date().toISOString() is the UTC date, which is yesterday until 5:30 am. */
function mgTodayIST(plusDays){
  const d = new Date(Date.now() + 5.5 * 3600000 + (plusDays || 0) * 86400000);
  return d.toISOString().slice(0, 10);
}
function scoreClass(s){ return s >= 70 ? 'score-good' : s >= 40 ? 'score-warn' : 'score-bad'; }
function scoreBandCutoffs(){
  try {
    const o = typeof mgPrefGet === 'function' ? mgPrefGet('score_bands', null) : JSON.parse(localStorage.getItem('margyn_score_bands') || 'null');
    if(o && Number(o.healthy) > Number(o.caution) && Number(o.caution) > 0) return { healthy:Number(o.healthy), caution:Number(o.caution) };
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
function showAuthInfo(msg){
  const f = document.querySelector('.auth-form.active');
  const el = f && f.querySelector('.auth-error');
  if(!el) return;
  el.style.color = 'var(--emerald-bright)'; el.textContent = msg; el.classList.add('show');
}
/* Password recovery: the email link lands here with a recovery session.
   Until a new password is set we must NOT route into the app. */
let mgRecovery = /[#&?]type=recovery\b/.test(location.hash + location.search);
function showAuthForm(id){
  document.querySelectorAll('.auth-form').forEach(f => f.classList.toggle('active', f.id === id));
  const bar = document.querySelector('.auth-tab-bar'); if(bar) bar.style.display = (id === 'loginForm' || id === 'signupForm') ? '' : 'none';
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', (t.dataset.form + 'Form') === id));
  clearAuthErrors();
}
function showRecoveryGate(){
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('onboardGate').classList.add('hidden');
  document.getElementById('authGate').classList.remove('hidden');
  const t = document.getElementById('authTitle'); if(t) t.textContent = 'Set a new password.';
  const sub = document.querySelector('#authGate .sub'); if(sub) sub.style.display = 'none';
  const g = document.getElementById('googleAuthBtn'); if(g) g.style.display = 'none';
  const d = document.querySelector('.oauth-divider'); if(d) d.style.display = 'none';
  showAuthForm('resetForm');
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
  // supabase.js is preloaded, so this can run before the page's last scripts have: start-up needs them all
  // (30-boot-cache.js draws the saved screen first).
  if(document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once:true }));
  const { data:{ session } } = await sbClient.auth.getSession();
  if(mgRecovery && session){ showRecoveryGate(); }
  else {
    mgRecovery = false;
    if(/error_code=otp_expired|error_description=/.test(location.hash)){
      showAuthForm('forgotForm');
      showAuthError('That reset link has expired or was already used. Request a new one.');
      history.replaceState(null, '', location.pathname);
    } else await routeFor(session);
  }
  sbClient.auth.onAuthStateChange((e, s) => {
    if(e === 'PASSWORD_RECOVERY'){ mgRecovery = true; showRecoveryGate(); return; }
    if(mgRecovery) return;
    // The same person, already in: INITIAL_SESSION right after start-up, SIGNED_IN when the tab regains focus,
    // TOKEN_REFRESHED every hour. Each used to re-run the whole start-up (Care Hygiene: every load ran twice,
    // ~20 s each). Only a different person, or signing out, routes again.
    if(s && s.user && mgRoutedAuthId === s.user.id && e !== 'USER_UPDATED') return;
    routeFor(s);
  });
}
let mgRoutedAuthId = null;   // the signed-in person routeFor() last set the app up for
async function routeFor(session){
  // The saved screen (30-boot-cache.js) is drawn first: a ~50 ms read, never waited on for long.
  if(window.mgBcReady && session && !mgRoutedAuthId) await Promise.race([window.mgBcReady, new Promise(r => setTimeout(r, 800))]);
  mgRoutedAuthId = session && session.user ? session.user.id : null;
  if(!session){
    if(typeof mgBcClear === 'function') mgBcClear();   // signed out: nothing of the account stays on this device
    currentUser = null; currentProfile = null; snapshots = []; paymentsData = null;
    receivables = []; payables = []; settlementRows = null; settlementDailyTrend = null; shopifyOrdersData = null;
    khataParties = []; khataEntries = []; khataInvoices = []; khataInvoiceLineItems = []; khataActivePartyId = null; khataActiveInvoiceId = null; invoiceDraftLines = [];
    razorpayConnected = false; lastSyncedAt = null;
    zohoConnected = false; zohoVitals = null; zohoLedgerRows = { receivables: [], payables: [] }; zohoPendingOrgRef = null; zohoChosenOrgId = null;
    odooConnected = false; odooStatus = null;
    if(typeof mgPos !== 'undefined'){ mgPos = null; mgPosSigAt = null; }
    if(typeof mgActor !== 'undefined'){ mgActor = null; mgMe = null; mgTeamData = null; mgTeamFresh = null; document.body.classList.remove('mg-member', 'mg-ro'); }
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
  // The saved screen is up (30-boot-cache.js): fetch fresh data for the business on screen straight away, while
  // who-is-this and the profile are checked alongside (they used to come first, ~2-3 s). If the answer is a
  // different business (a membership changed), the saved copy is dropped and the app starts again.
  const joining = typeof mgPendingJoin === 'function' && mgPendingJoin();
  if(typeof mgBcShownFor !== 'undefined' && mgBcShownFor === session.user.id && currentUser && currentProfile && !joining){
    const shownAcct = currentUser.id, shownUser = currentUser;
    const checkP = (async () => {
      const acct = typeof mgResolveAccount === 'function' ? await mgResolveAccount(session.user) : session.user.id;
      const prof = (await sbClient.from('profiles').select('*').eq('id', acct || session.user.id).maybeSingle()).data || null;
      return { acct:acct || session.user.id, prof };
    })();
    const freshP = refreshAll();
    let chk;
    try { chk = await checkP; } catch(e){ chk = null; }
    if(chk && (chk.acct !== shownAcct || !chk.prof)){
      if(typeof mgBcClear === 'function') await mgBcClear();
      location.reload();
      return;
    }
    if(chk){ currentUser = shownUser; currentProfile = chk.prof; }
    mtrack('app_open');
    await freshP;
    if(typeof mgApplyActor === 'function') mgApplyActor();
    if(typeof mgBcSaveSoon === 'function') mgBcSaveSoon();
    return;
  }
  currentUser = session.user;
  document.getElementById('userEmail').textContent = currentUser.email;
  document.getElementById('authGate').classList.add('hidden');
  // Team logins (19g-team.js): who is this, and which business are they
  // working in? currentUser.id becomes that ACCOUNT (every query is keyed
  // to it); mgActor is the person, their role and permissions.
  if(typeof mgResolveAccount === 'function'){
    const accountId = await mgResolveAccount(session.user);
    if(accountId && accountId !== session.user.id) currentUser = Object.assign({}, session.user, { id:accountId });
  }
  currentProfile = await loadProfile();
  if(!currentProfile){ document.getElementById('appShell').classList.add('hidden'); document.getElementById('onboardGate').classList.remove('hidden'); return; }
  document.getElementById('onboardGate').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  mtrack('app_open');
  await refreshAll();
  if(typeof mgApplyActor === 'function') mgApplyActor();
  if(typeof mgBcSaveSoon === 'function') mgBcSaveSoon();   // the next open draws this straight away (30-boot-cache.js)
}
/* Every row a query matches, past the database's 1,000-row ceiling (a plain .limit(3000) still returns
   1,000). `make` builds a fresh query each call; pages of 1,000 via .range(), up to `max`. Same { data, error }
   shape as a supabase-js call. */
async function sbAll(make, max){
  max = max || 20000;
  const out = [];
  for(let from = 0; from < max; from += 1000){
    const { data, error } = await make().range(from, Math.min(from + 999, max - 1));
    if(error) return { data:out.length ? out : null, error };
    out.push(...(data || []));
    if(!data || data.length < 1000) break;
  }
  return { data:out, error:null };
}
async function loadProfile(){
  const { data, error } = await sbClient.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if(error){ console.error('[margyn] loadProfile:', error); return null; }
  return data;
}
/* profiles.preferences.history_from: readings before this ISO time are left out everywhere
   (app, findings, CFO pack email). Used when early readings were built from wrong data;
   the rows stay in the table, so clearing the preference brings them back. */
function mgHistoryFrom(){
  const v = currentProfile && currentProfile.preferences && currentProfile.preferences.history_from;
  return v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}
async function loadSnapshots(){
  let q = sbClient.from('snapshots').select('*').eq('user_id', currentUser.id);
  const from = mgHistoryFrom();
  if(from) q = q.gte('created_at', from);
  const { data, error } = await q.order('created_at', { ascending:false }).limit(50);
  if(error){ console.error('[margyn] loadSnapshots:', error); return []; }
  const list = data || [];
  if(typeof mgApplyCashHistory === 'function') mgApplyCashHistory(list);   // 19i-margin.js: cash from the books' day-by-day history
  return list;
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
    currentProfile = Object.assign({}, currentProfile, row);
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
