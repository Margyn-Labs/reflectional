/* ============================================================
   ACCOUNT PREFERENCES. Saved on the account (profiles.preferences,
   jsonb), so they follow the customer to any device.

   Keys: forecast {…}, score_bands {healthy, caution},
   metrics {summary:[…], scores:[…]}, analytics_charts […].
   A key set to null means "back to the defaults" (it also stops an
   old browser value being migrated in again).

   - Writes are debounced (600 ms). The flush re-reads the row and
     applies only the keys changed here, so one device never wipes a
     key another device saved.
   - First use on an account copies any value this browser still has
     in localStorage into the account, for keys the account doesn't
     have yet. localStorage is left as it is (read-only fallback).
   - If the column doesn't exist yet (code deployed before the SQL),
     everything reads and writes localStorage as before, silently.
   ============================================================ */
/* Where each key lived in localStorage before (read for migration and as the
   no-column fallback). Literal keys, so the UI contract can see them. */
function mgLsJson(raw){ try { return raw === null || raw === undefined ? undefined : JSON.parse(raw); } catch(e){ return undefined; } }
function mgLsPut(k, v){ try { if(v === undefined || v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
const MG_METRIC_SURFACES = ['summary', 'scores'];
const MG_PREF_LEGACY = {
  forecast:{ read:() => mgLsJson(lsGet('margyn_forecast_v1', null)), write:v => mgLsPut('margyn_forecast_v1', v) },
  score_bands:{ read:() => mgLsJson(lsGet('margyn_score_bands', null)), write:v => mgLsPut('margyn_score_bands', v) },
  analytics_charts:{ read:() => mgLsJson(lsGet('margyn_analytics_charts', null)), write:v => mgLsPut('margyn_analytics_charts', v) },
  metrics:{
    read:() => { const out = {}; let any = false;
      MG_METRIC_SURFACES.forEach(s => { let v; try { v = mgLsJson(localStorage.getItem('margyn_metrics_' + s)); } catch(e){} if(v !== undefined){ out[s] = v; any = true; } });
      return any ? out : undefined; },
    write:v => MG_METRIC_SURFACES.forEach(s => mgLsPut('margyn_metrics_' + s, v ? v[s] : null))
  }
};
let mgPrefInitFor = null, mgPrefOff = false, mgPrefDirty = {}, mgPrefTimer = null;

function mgPrefLsRead(key){ const L = MG_PREF_LEGACY[key]; return L ? L.read() : undefined; }
function mgPrefLsWrite(key, value){ const L = MG_PREF_LEGACY[key]; if(L) L.write(value); }
/* True when the account can hold preferences (column exists, signed in). */
function mgPrefOn(){
  if(mgPrefOff || !currentUser || !currentProfile) return false;
  if(!currentProfile.preferences || typeof currentProfile.preferences !== 'object') return false;   // select('*') had no such column
  if(mgPrefInitFor !== currentUser.id){
    mgPrefInitFor = currentUser.id;
    const p = currentProfile.preferences;
    Object.keys(MG_PREF_LEGACY).forEach(k => {
      if(k in p) return;
      const v = mgPrefLsRead(k);
      if(v !== undefined){ p[k] = v; mgPrefDirty[k] = true; }
    });
    if(Object.keys(mgPrefDirty).length) mgPrefSchedule();
  }
  return true;
}
function mgPrefGet(key, fallback){
  const v = mgPrefOn() ? currentProfile.preferences[key] : mgPrefLsRead(key);
  return v === undefined || v === null ? fallback : v;
}
function mgPrefSet(key, value){
  if(value === undefined) value = null;
  if(!mgPrefOn()){ mgPrefLsWrite(key, value); return; }
  currentProfile.preferences[key] = value;
  mgPrefDirty[key] = true;
  mgPrefSchedule();
}
function mgPrefWhere(){ return mgPrefOn() ? 'Saved to your account.' : 'Saved in this browser.'; }
function mgPrefSchedule(){ clearTimeout(mgPrefTimer); mgPrefTimer = setTimeout(mgPrefFlush, 600); }
function mgPrefMissingColumn(err){
  return !!err && (err.code === '42703' || err.code === 'PGRST204' || /preferences/.test(err.message || '') && /does not exist|could not find/i.test(err.message || ''));
}
async function mgPrefFlush(){
  clearTimeout(mgPrefTimer); mgPrefTimer = null;
  const keys = Object.keys(mgPrefDirty); if(!keys.length || !currentUser || !currentProfile) return;
  mgPrefDirty = {};
  const uid = currentUser.id, mine = currentProfile.preferences || {};
  // Start from what the account has now, so keys saved elsewhere survive.
  let base = mine;
  try {
    const { data, error } = await sbClient.from('profiles').select('preferences').eq('id', uid).maybeSingle();
    if(!error && data && data.preferences && typeof data.preferences === 'object') base = data.preferences;
  } catch(e){}
  const merged = Object.assign({}, base);
  keys.forEach(k => { merged[k] = mine[k] === undefined ? null : mine[k]; });
  try {
    const { error } = await sbClient.from('profiles').update({ preferences:merged }).eq('id', uid);
    if(error) throw error;
    // Take the account's view, except keys changed here since the flush began.
    if(currentProfile && currentUser && currentUser.id === uid){
      const now = currentProfile.preferences || {}, next = Object.assign({}, merged);
      Object.keys(mgPrefDirty).forEach(k => { next[k] = now[k]; });
      currentProfile.preferences = next;
    }
  } catch(err){
    if(mgPrefMissingColumn(err)){ mgPrefOff = true; keys.forEach(k => mgPrefLsWrite(k, mine[k])); return; }
    console.warn('[margyn] saving preferences:', err);
    keys.forEach(k => { mgPrefDirty[k] = true; });   // retry with the next change
    if(typeof toast === 'function') toast('Could not save that to your account', { sub:'It applies here for now. Margyn will retry with your next change.' });
  }
}
/* Don't lose a change made just before the tab closes or the user signs out. */
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden' && mgPrefTimer) mgPrefFlush(); });
