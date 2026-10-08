/* ============================================================
   OPEN INSTANTLY (2026-10-09). The app used to show an empty shell until
   every read had come back (Care Hygiene: ~15 s). Now the last screen's
   data is kept on this device, per login, and drawn the moment the page
   loads, before the sign-in library or any read; the real start-up then
   runs as before and redraws with fresh data. WhatsApp-style.

   - Kept in IndexedDB (margyn-boot / state), one entry per signed-in person,
     as JSON. Never sent anywhere. Wiped on sign-out.
   - Saved after each full start-up and when Margin, the books check or the
     position land later (debounced).
   - Read-only: drawing from it calls render functions only, never a save.
     If anything about it fails, start-up carries on exactly as before.
   ============================================================ */
const MG_BC_DB = 'margyn-boot', MG_BC_STORE = 'state', MG_BC_VER = 1, MG_BC_MAX_AGE = 14 * 86400000;
let mgBcShownFor = null;   // the auth user whose saved screen is on display (routeFor skips the empty-shell wait)
let mgBcTimer = null;

function mgBcDb(){
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open(MG_BC_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(MG_BC_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch(e){ rej(e); }
  });
}
async function mgBcTx(mode, fn){
  const db = await mgBcDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(MG_BC_STORE, mode), st = tx.objectStore(MG_BC_STORE);
    let out;
    try { out = fn(st); } catch(e){ rej(e); return; }
    tx.oncomplete = () => { db.close(); res(out && 'result' in out ? out.result : undefined); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const mgBcGet = key => mgBcTx('readonly', st => st.get(key));
const mgBcPut = (key, val) => mgBcTx('readwrite', st => st.put(val, key));
function mgBcClear(){ try { return mgBcTx('readwrite', st => st.clear()).catch(() => {}); } catch(e){ return Promise.resolve(); } }

/* The signed-in person, straight from the session supabase-js keeps in localStorage (no library needed). */
function mgBcAuthUser(){
  try {
    const ref = (SUPABASE_URL.match(/https:\/\/([^.]+)\./) || [])[1];
    const raw = ref && localStorage.getItem('sb-' + ref + '-auth-token');
    const s = raw && JSON.parse(raw);
    const u = s && (s.user || (s.currentSession && s.currentSession.user));
    return u && u.id ? u : null;
  } catch(e){ return null; }
}

function mgBcState(){
  const g = (fn) => { try { return fn(); } catch(e){ return null; } };
  return {
    v:MG_BC_VER, at:Date.now(), accountId:currentUser && currentUser.id,
    me:g(() => mgMe), actor:g(() => mgActor), profile:currentProfile,
    snapshots, receivables, payables, findings, pendingSuggestions:g(() => pendingSuggestions),
    khataParties, khataEntries, khataInvoices,
    razorpayLiveSummary, razorpayConnected, razorpayStatus, lastSyncedAt,
    cashfreeConnected, cashfreeStatus, odooConnected, odooStatus, zohoConnected, zohoVitals, zohoLedgerRows,
    reconSummary, agentActions, shopifyConnected, shopifyStore, tallyConnected, tallyInstalls, tallyData,
    mar:g(() => (mgMar && !mgMarCompany && !mgMar.stale ? mgMar : null)), pos:g(() => mgPos), posSig:g(() => mgPosSigAt),
    bh:g(() => (mgBH && !mgBH.error ? mgBH : null)), chan:g(() => mgChan)
  };
}
/* Keep the screen as it is now for next time (after the data settles). */
function mgBcSaveSoon(){
  clearTimeout(mgBcTimer);
  mgBcTimer = setTimeout(async () => {
    try {
      const auth = mgBcAuthUser();
      if(!auth || !currentUser || !currentProfile || !mgFirstLoadDone) return;
      await mgBcPut(auth.id, JSON.stringify(mgBcState()));
    } catch(e){ /* storage full or blocked: next time opens the usual way */ }
  }, 1500);
}

/* Put the saved screen back into the app's state. Returns false if there's nothing usable. */
function mgBcHydrate(c, auth){
  if(!c || c.v !== MG_BC_VER || !c.profile || !c.accountId || Date.now() - c.at > MG_BC_MAX_AGE) return false;
  currentUser = Object.assign({}, auth, { id:c.accountId });
  currentProfile = c.profile;
  try { mgMe = c.me; mgActor = c.actor; } catch(e){}
  snapshots = c.snapshots || []; receivables = c.receivables || []; payables = c.payables || []; findings = c.findings || [];
  try { pendingSuggestions = c.pendingSuggestions || []; } catch(e){}
  khataParties = c.khataParties || []; khataEntries = c.khataEntries || []; khataInvoices = c.khataInvoices || [];
  razorpayLiveSummary = c.razorpayLiveSummary || null; razorpayConnected = !!c.razorpayConnected; razorpayStatus = c.razorpayStatus || null; lastSyncedAt = c.lastSyncedAt || null;
  cashfreeConnected = !!c.cashfreeConnected; cashfreeStatus = c.cashfreeStatus || null;
  odooConnected = !!c.odooConnected; odooStatus = c.odooStatus || null;
  zohoConnected = !!c.zohoConnected; zohoVitals = c.zohoVitals || null; zohoLedgerRows = c.zohoLedgerRows || { receivables: [], payables: [] };
  reconSummary = c.reconSummary || null; agentActions = c.agentActions || null;
  shopifyConnected = !!c.shopifyConnected; shopifyStore = c.shopifyStore || null;
  tallyConnected = !!c.tallyConnected; tallyInstalls = c.tallyInstalls || []; tallyData = c.tallyData || null;
  // Margin, position, books check: shown now, and still fetched fresh (their "loaded at" stays 0).
  try { if(c.mar){ mgMar = c.mar; mgMarAt = 0; } } catch(e){}
  try { if(c.pos){ mgPos = c.pos; mgPosSigAt = c.posSig || null; } } catch(e){}
  try { if(c.bh){ mgBH = c.bh; mgBHAt = 0; } } catch(e){}
  try { if(c.chan){ mgChan = c.chan; mgChanAt = 0; } } catch(e){}
  mgApplySnapshotState();
  return true;
}

/* Draw everything from the state in memory: the same renders refreshAll ends with. */
function mgBcRender(){
  const run = (name) => { try { const f = window[name]; if(typeof f === 'function') f(); } catch(e){ console.warn('[margyn] instant open:', name, e && e.message); } };
  document.getElementById('authGate').classList.add('hidden');
  document.getElementById('onboardGate').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  const em = document.getElementById('userEmail'); if(em && currentUser) em.textContent = currentUser.email || '';
  if(typeof renderSuggestionsBadge === 'function') run('renderSuggestionsBadge');
  ['renderHeader', 'renderProfile', 'renderScores', 'renderFinancing', 'renderPayments', 'renderSummary',
    'renderReconBooksCard', 'renderReconLedger', 'renderAgentQueue', 'renderTallyTab', 'renderBooksHub',
    'renderConnectionsHub', 'renderAnalyticsView', 'updateTopBar', 'lwFromGlobals'].forEach(run);
  try {
    if(!mgFirstLoadDone){ mgFirstLoadDone = true; if(!mgApplyRoute()){ showView(mgCurrentView); mgWriteHash(false); } }
    else if(MG_PAGES[mgCurrentView] && MG_PAGES[mgCurrentView].own) mgRenderOwn(mgCurrentView);
    mgRefreshScope();
  } catch(e){ console.warn('[margyn] instant open: route', e && e.message); }
  run('mgApplyActor');
}

/* As the page loads: the saved screen for whoever is signed in on this device. */
async function mgBcEarly(){
  const auth = mgBcAuthUser();
  if(!auth) return;
  try {
    const raw = await mgBcGet(auth.id);
    if(!raw || mgRoutedAuthId) return;           // the real start-up already drew the screen
    if(!mgBcHydrate(JSON.parse(raw), auth)) return;
    mgBcShownFor = auth.id;
    mgBcRender();
  } catch(e){ mgBcShownFor = null; console.warn('[margyn] instant open skipped:', e && e.message); }
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mgBcEarly); else mgBcEarly();
