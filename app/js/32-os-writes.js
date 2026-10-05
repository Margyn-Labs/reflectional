/* ============================================================
   MARGYN OS WRITES: what an approval changes in your apps.

   Every approval queues its changes for the app they belong in
   (api/_lib/writeBack.js, table app_writes). Each one shows one lifecycle:
     Approved -> Writing to <app> -> Confirmed by sync   (or Failed, with why)
   and, while an app isn't writable yet, "Saved in Margyn" with the reason.
   Today no app is writable, so every write says so plainly; as each
   connector gets write access the same screens show it going through.
   Where it shows: the message after you approve, Work › Sent to apps, the
   activity feed, the Apps page (what each app reads and writes) and Rules.
   ============================================================ */

let osWB = { setup:null, writes:[], caps:[] }, osWBLast = null, osWBBusy = false;
async function osLoadWrites(){
  if(osWBBusy || !currentUser || typeof zohoApi !== 'function') return;
  osWBBusy = true;
  try { const d = await zohoApi('/api/reconcile?action=app-writes'); osWB = { setup:!!d.setup, writes:d.writes || [], caps:d.capabilities || [] }; }
  catch(e){ /* the endpoint is new; until it answers, nothing is shown as sent */ }
  osWBBusy = false;
  osWritesChanged();
}
function osWritesChanged(){
  if(typeof mgCurrentView === 'undefined') return;
  if(mgCurrentView === 'work' && typeof osRenderWork === 'function') osRenderWork();
  if(mgCurrentView === 'connectors') osPaintAppWrites();
  if(mgCurrentView === 'rules' && typeof osRenderRules === 'function') osRenderRules();
}

const OS_WB_APP = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', razorpay:'Razorpay', cashfree:'Cashfree', shopify:'Shopify' };
function osWritePill(w){
  const app = OS_WB_APP[w.app] || w.app;
  if(w.status === 'confirmed') return '<span class="mg-pill os-pill-ok">Confirmed in ' + escapeHtml(app) + '</span>';
  if(w.status === 'writing') return '<span class="mg-pill os-pill-run">Writing to ' + escapeHtml(app) + '</span>';
  if(w.status === 'failed') return '<span class="mg-pill os-pill-bad">' + escapeHtml(app) + ' refused it</span>';
  if(w.status === 'queued') return '<span class="mg-pill os-pill-prop">Approved</span>';
  if(w.status === 'cancelled') return '<span class="mg-pill">Cancelled</span>';
  return '<span class="mg-pill" title="' + escapeHtml(w.status_note || '') + '">Saved in Margyn</span>';
}

/* What to tell the person who just approved, from the writes the server queued. */
function osApprovalLine(writes){
  writes = writes || (osWBLast && osWBLast.writes) || [];
  if(!writes.length) return 'Approved. Recorded in Margyn.';
  const apps = [...new Set(writes.map(w => OS_WB_APP[w.app] || w.app))].join(' and ');
  const going = writes.filter(w => w.status === 'writing').length, failed = writes.filter(w => w.status === 'failed').length;
  if(going && !failed) return 'Approved. Writing it to ' + apps + '; the next sync confirms it.';
  if(failed) return 'Approved, but ' + apps + ' refused ' + failed + ' change' + (failed === 1 ? '' : 's') + '. See Work › Sent to apps.';
  return 'Approved and saved in Margyn. ' + apps + ' write-back isn’t switched on yet, so make the same change in ' + apps + ' for now.';
}
function osAfterApproval(res){
  const wr = (res && res.writes) || null;
  osWBLast = wr;
  const list = (wr && wr.writes) || [];
  list.forEach(w => { if(typeof osActAdd === 'function') osActAdd({ agent:w.app === 'razorpay' || w.app === 'cashfree' ? 'payments' : 'books',
    text:(w.status === 'writing' ? 'Writing to ' : w.status === 'failed' ? 'Refused by ' : 'Saved for ') + (OS_WB_APP[w.app] || w.app) + ': ' + (w.summary || w.action),
    state:w.status === 'failed' ? 'error' : 'done', at:new Date().toISOString(), end:new Date().toISOString(), from:'app' }); });
  setTimeout(osLoadWrites, 300);
}
// Approvals from the app go through these calls; their answers carry the writes the server queued.
if(typeof zohoApi === 'function'){
  const baseApi = zohoApi;
  zohoApi = async function(path){
    const out = await baseApi.apply(this, arguments);
    try { if(/action=(agent-review|resolve)\b/.test(String(path)) && out && out.writes) osAfterApproval(out); } catch(e){}
    return out;
  };
}
/* A forwarded document approved in the app, chat or voice: queue its writes (the server re-reads what was approved). */
async function osQueueDocWrites(id, entryIdx){
  try {
    const out = await zohoApi('/api/reconcile?action=app-writes', { method:'POST', body:JSON.stringify({ kind:'suggestion', id, entries:entryIdx || null }) });
    osAfterApproval({ writes:out });
    return out;
  } catch(e){ return null; }
}

/* ---------- Work › Sent to apps ---------- */
function osWritesTableHtml(){
  if(osWB.setup === false) return '<div class="mg-empty">Sending approved changes to your apps switches on after a one-time setup step. Until then, approvals are recorded in Margyn.</div>';
  const rows = osWB.writes || [];
  if(!rows.length) return '<div class="mg-empty">Nothing sent yet. When you approve a match, a journal or a forwarded document, the change it makes in Zoho, Tally or Odoo shows here, from approved to confirmed.</div>';
  return '<table class="mg-grid os-work"><thead><tr><th></th><th>Change</th><th>App</th><th>Status</th><th>When</th></tr></thead><tbody>' +
    rows.map(w => '<tr><td class="os-own"><span class="os-av' + (w.approved_by_name ? ' on' : ' m') + '">' + escapeHtml(w.approved_by_name ? osInitials(w.approved_by_name) : 'M') + '</span></td>' +
      '<td><b>' + escapeHtml(w.summary || w.action) + '</b><div class="mg-muted">' + escapeHtml((w.approved_by_name ? 'Approved by ' + w.approved_by_name : 'Approved') + (w.status_note ? ' · ' + w.status_note : '')) + '</div></td>' +
      '<td>' + (typeof osSrcChips === 'function' ? osSrcChips([w.app]) : escapeHtml(OS_WB_APP[w.app] || w.app)) + '</td>' +
      '<td>' + osWritePill(w) + '</td><td class="mg-mono">' + escapeHtml(osSince(w.updated_at || w.created_at)) + '</td></tr>').join('') + '</tbody></table>';
}

/* ---------- Apps: what each app feeds Margyn, and what Margyn writes back ---------- */
function osPaintAppWrites(){
  const t = document.getElementById('connFeedTable'); if(!t || !osWB.caps.length || typeof CONN_FEED_MAP === 'undefined') return;
  const capOf = k => osWB.caps.find(c => c.app === k) || { writes:[] };
  t.innerHTML = '<thead><tr><th>App</th><th>Margyn reads</th><th>Margyn writes back</th><th>Tier</th></tr></thead><tbody>' +
    CONN_FEED_MAP.map(c => { const cap = capOf(c.key);
      const w = cap.writes.length ? cap.writes.map(a => '<div class="os-wcap"><span class="mg-pill ' + (a.on ? 'os-pill-ok' : '') + '">' + (a.on ? 'On' : 'Not yet') + '</span> ' + escapeHtml(a.label) + '</div>').join('') : '<span class="mg-muted">Nothing; read only</span>';
      return '<tr><td>' + escapeHtml(c.label) + '</td><td>' + escapeHtml(c.feeds) + '</td><td>' + w + '</td><td>' + escapeHtml(c.tier) + '</td></tr>'; }).join('') + '</tbody>';
  const lab = t.closest('.rd-section') && t.closest('.rd-section').querySelector('.rd-section-label');
  if(lab && !/writes/.test(lab.textContent)) lab.innerHTML = 'What Margyn reads and writes <span class="rd-note">Writes switch on app by app, once you give an app write permission</span>';
}
if(typeof renderConnectionsHub === 'function'){
  const baseHub = renderConnectionsHub;
  renderConnectionsHub = function(){ const out = baseHub.apply(this, arguments); try { osPaintAppWrites(); } catch(e){} return out; };
}

/* ---------- boot ---------- */
(function(){
  const base = refreshAll;
  refreshAll = async function(){ const out = await base.apply(this, arguments); try { osLoadWrites(); } catch(e){} return out; };
})();
setInterval(() => { if(!document.hidden && currentUser && (osWB.writes || []).some(w => w.status === 'writing' || w.status === 'queued')) osLoadWrites(); }, 30000);
// "See what was sent" (Rules) opens Work on Sent to apps.
document.addEventListener('click', e => { const b = e.target.closest('[data-os-worktab-go]'); if(b && typeof osWorkTab !== 'undefined') osWorkTab = b.dataset.osWorktabGo; }, true);
