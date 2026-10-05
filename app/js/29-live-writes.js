/* ============================================================
   LIVE WRITES: what an approval changes in your apps.

   Approving a match, a proposal or a forwarded document queues the change it
   makes in the app it belongs in (api/_lib/writeBack.js, table app_writes).
   Each change has one lifecycle:
     Approved -> Writing to <app> -> Confirmed by the next sync   (or refused, with why)
   and, while an app isn't writable yet, "Saved in Margyn" with the reason.
   Today no app is writable, so every change says so plainly; as each
   connector gets write access the same places show it going through.

   Where it shows, in the live pages:
   - the message after you approve (Inbox, chat, forwarded documents),
   - Inbox: a "Sent to your apps" card under the items,
   - Organisations and sources: what Margyn reads and writes back, per app,
   - Home "Just done".
   Until 2026-10-06-team-and-app-writes.sql has run, nothing here shows and
   approvals say what they always said.
   ============================================================ */

let lxWB = { setup:null, writes:[], caps:[] }, lxBusy = false;
const LX_APP = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', razorpay:'Razorpay', cashfree:'Cashfree', shopify:'Shopify' };
async function lxLoad(){
  if(lxBusy || !currentUser || typeof zohoApi !== 'function') return;
  lxBusy = true;
  try { const d = await zohoApi('/api/reconcile?action=app-writes'); lxWB = { setup:!!d.setup, writes:d.writes || [], caps:d.capabilities || [] }; }
  catch(e){ /* not deployed yet: nothing is shown as sent */ }
  lxBusy = false;
  lxPaintInbox(); lxPaintApps();
}

/* ---------- after you approve ---------- */
function lxApprovalLine(res, fallback){
  const wr = res && res.writes, list = (wr && wr.writes) || [];
  if(!wr || wr.off || !list.length) return fallback;
  const apps = [...new Set(list.map(w => LX_APP[w.app] || w.app))].join(' and ');
  const going = list.filter(w => w.status === 'writing').length, failed = list.filter(w => w.status === 'failed').length;
  if(failed) return 'Approved, but ' + apps + ' refused ' + failed + ' change' + (failed === 1 ? '' : 's') + '. See Inbox › Sent to your apps.';
  if(going) return 'Approved. Writing it to ' + apps + '; the next sync confirms it.';
  return 'Approved and saved in Margyn. Writing to ' + apps + ' isn’t switched on yet, so make the same change in ' + apps + ' for now.';
}
function lxAfterApproval(res){
  const list = (res && res.writes && res.writes.writes) || [];
  list.forEach(w => lwAdd({ job:w.app === 'razorpay' || w.app === 'cashfree' ? 'payments' : 'books',
    text:(w.status === 'writing' ? 'Writing to ' : w.status === 'failed' ? 'Refused by ' : 'Saved for ') + (LX_APP[w.app] || w.app) + ': ' + (w.summary || w.action),
    state:w.status === 'failed' ? 'error' : 'done', at:new Date().toISOString(), end:new Date().toISOString() }));
  setTimeout(lxLoad, 300);
}
/* A forwarded document approved in Inbox or in chat: queue its changes (the server re-reads what was approved). */
async function lxQueueDoc(id, entryIdx){
  try { const out = await zohoApi('/api/reconcile?action=app-writes', { method:'POST', body:JSON.stringify({ kind:'suggestion', id, entries:entryIdx || null }) }); const res = { writes:out }; lxAfterApproval(res); return res; }
  catch(e){ return null; }
}

/* ---------- Inbox: Sent to your apps ---------- */
function lxStatus(w){
  const app = LX_APP[w.app] || w.app;
  if(w.status === 'confirmed') return '<span class="lr-tag ok">Confirmed in ' + escapeHtml(app) + '</span>';
  if(w.status === 'writing') return '<span class="lr-tag lx-run">Writing to ' + escapeHtml(app) + '</span>';
  if(w.status === 'failed') return '<span class="lr-tag lx-bad">' + escapeHtml(app) + ' refused it</span>';
  if(w.status === 'queued') return '<span class="lr-tag review">Approved</span>';
  if(w.status === 'cancelled') return '<span class="lr-tag unreconciled">Cancelled</span>';
  return '<span class="lr-tag unreconciled">Saved in Margyn</span>';
}
function lxPaintInbox(){
  const host = document.getElementById('agentPanel-queue'); if(!host) return;
  let card = document.getElementById('lxSentCard');
  const rows = lxWB.setup ? (lxWB.writes || []) : [];
  if(!rows.length){ if(card) card.classList.add('hidden'); return; }
  if(!card){
    card = document.createElement('div'); card.className = 'card'; card.id = 'lxSentCard';
    const empty = document.getElementById('agentQueueEmpty'); host.insertBefore(card, empty || null);
  }
  card.classList.remove('hidden');
  const open = rows.filter(w => w.status !== 'confirmed' && w.status !== 'cancelled').length;
  card.innerHTML = '<div class="ledger-list-title" style="margin-top:0; padding-top:0; border-top:none;">Sent to your apps (' + rows.length + ')</div>' +
    '<div class="hint" style="margin-bottom:10px;">What each approval changes in Zoho Books, Tally or Odoo, from approved to confirmed by the next sync.' + (open ? ' Until an app is switched on for writing, the change is saved in Margyn: make it in the app yourself for now.' : '') + '</div>' +
    rows.slice(0, 20).map(w => '<div class="ledger-row"><div class="lr-main">' +
      '<div class="lr-party">' + escapeHtml(w.summary || w.action) + lxStatus(w) + '</div>' +
      '<div class="lr-meta">' + escapeHtml([w.approved_by_name ? 'Approved by ' + w.approved_by_name : 'Approved', lwSince(w.updated_at || w.created_at), w.status_note || ''].filter(Boolean).join(' · ')) + '</div>' +
      '</div><div class="lx-app">' + (typeof mgLogo === 'function' ? mgLogo(w.app) : '') + '</div></div>').join('');
}

/* ---------- Organisations and sources: reads and writes, per app ---------- */
function lxPaintApps(){
  const t = document.getElementById('connFeedTable'); if(!t || !lxWB.caps.length || typeof CONN_FEED_MAP === 'undefined') return;
  const capOf = k => lxWB.caps.find(c => c.app === k) || { writes:[] };
  t.innerHTML = '<thead><tr><th>Source</th><th>Status</th><th>Feeds</th><th>Writes back</th><th>Tier</th></tr></thead><tbody>' +
    CONN_FEED_MAP.map(c => { const cap = capOf(c.key), live = connIsLive(c.key);
      const w = cap.writes.length ? cap.writes.map(a => '<div class="lx-cap"><span class="lr-tag ' + (a.on ? 'ok' : 'unreconciled') + '" style="margin-left:0">' + (a.on ? 'On' : 'Not yet') + '</span> ' + escapeHtml(a.label) + '</div>').join('') : '<span class="mg-fine">Read only</span>';
      return '<tr><td>' + escapeHtml(c.label) + '</td><td>' + (live ? '<span class="lr-tag ok">Connected</span>' : '<span class="lr-tag unreconciled">Not connected</span>') + '</td><td>' + escapeHtml(c.feeds) + '</td><td>' + w + '</td><td>' + escapeHtml(c.tier) + '</td></tr>'; }).join('') + '</tbody>';
}
if(typeof renderConnectionsHub === 'function'){
  const baseHub = renderConnectionsHub;
  renderConnectionsHub = function(){ const out = baseHub.apply(this, arguments); try { lxPaintApps(); } catch(e){} return out; };
}
if(typeof renderAgentQueue === 'function'){
  const baseQ = renderAgentQueue;
  renderAgentQueue = function(){ const out = baseQ.apply(this, arguments); try { lxPaintInbox(); } catch(e){} return out; };
}

/* ---------- boot ---------- */
(function(){
  const base = refreshAll;
  refreshAll = async function(){ const out = await base.apply(this, arguments); try { lxLoad(); } catch(e){} return out; };
})();
setInterval(() => { if(!document.hidden && currentUser && (lxWB.writes || []).some(w => w.status === 'writing' || w.status === 'queued')) lxLoad(); }, 30000);
