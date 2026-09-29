/* ============================================================
   CHANNEL HEALTH (2026-09-30): which Bells, chases and emails are actually
   reaching people, and how much was paid after Margyn chased.
   Reads GET /api/reconcile?action=channel-health (api/_lib/channelHealth.js).
   Message templates that aren't approved fail silently; this makes it visible.
   ============================================================ */
let mgChan = null, mgChanBusy = false, mgChanErr = false, mgChanAt = 0;

async function mgLoadChannels(force){
  if(mgChanBusy || (!force && mgChan && Date.now() - mgChanAt < 60000)) return;
  mgChanBusy = true;
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    if(!session) return;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch('/api/reconcile?action=channel-health', { headers:{ 'Authorization':'Bearer ' + session.access_token }, signal:ctl.signal });
    clearTimeout(timer);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    mgChan = await res.json(); mgChanAt = Date.now(); mgChanErr = false;
  } catch(e){ mgChanErr = true; console.error('[margyn] channel health:', e.message); }
  finally { mgChanBusy = false; if(typeof mgCurrentView !== 'undefined' && mgCurrentView === 'channels') mgRenderChannels(); }
}

const MG_CHAN_TONE = { working:'', failing:'warn', not_set_up:'off', quiet:'off' };
function mgRenderChannels(){
  const host = document.getElementById('view-channels'); if(!host) return;
  if(!mgChan && !mgChanBusy && !mgChanErr) mgLoadChannels();
  const d = mgChan;
  const head = mgPageHead({ group:'Admin', title:'Channel health', sub:'Which messages are actually reaching people. WhatsApp templates that WhatsApp hasn’t approved fail without any warning, so this is where you’d see it.',
    actions:mgBtn('Refresh', 'data-chan-refresh') });
  if(!d){
    host.innerHTML = head + '<div class="mg-panel mg-empty-panel"><h2>' + (mgChanErr ? 'Couldn’t load channel health' : 'Loading…') + '</h2>' +
      '<p>' + (mgChanErr ? 'Try Refresh in a moment.' : 'Reading your recent sends.') + '</p></div>';
    return;
  }
  const r = d.recovered || {};
  const ago = iso => iso ? fmtDate(iso) : '—';
  const rows = d.channels.map(c =>
    '<tr><td><strong>' + escapeHtml(c.label) + '</strong><div class="mg-muted">' + escapeHtml(c.via) + '</div></td>' +
    '<td style="white-space:nowrap"><span class="mg-dot ' + (MG_CHAN_TONE[c.status] || '') + '" style="display:inline-block;vertical-align:middle;margin-right:8px' + (c.status === 'failing' ? ';background:var(--neg)' : '') + '"></span>' + escapeHtml(c.headline) + '</td>' +
    '<td class="r">' + c.sent_30d + '</td><td class="r">' + c.failed_30d + '</td>' +
    '<td class="mg-mono">' + escapeHtml(ago(c.last_success_at)) + '</td>' +
    '<td class="mg-muted" style="white-space:normal;min-width:280px">' + escapeHtml(c.detail) + '</td></tr>').join('');
  const recRows = (r.items || []).map(x =>
    '<tr><td>' + escapeHtml(x.party_name || '—') + '</td><td>' + escapeHtml(x.invoice_ref || '—') + '</td>' +
    '<td class="r">' + mgNum(x.amount) + '</td><td class="mg-mono">' + escapeHtml(ago(x.chased_at)) + '</td>' +
    '<td class="mg-mono">' + escapeHtml(ago(x.paid_at)) + '</td>' +
    '<td class="r">' + x.chases_before_payment + '</td></tr>').join('');
  host.__csv = [['Channel', 'Via', 'Status', 'Sent (30d)', 'Failed (30d)', 'Last delivered', 'Detail'],
    d.channels.map(c => [c.label, c.via, c.headline, c.sent_30d, c.failed_30d, c.last_success_at || '', c.detail])];
  host.innerHTML = head +
    '<div class="mg-tiles four">' +
      '<div class="mg-tile mg-static"><div class="mg-tile-l">Paid after Margyn chased</div><div class="mg-tile-v">' + escapeHtml(fmtINR(r.amount || 0)) + '</div><div class="mg-tile-chg flat">' + (r.invoices || 0) + ' invoice' + (r.invoices === 1 ? '' : 's') + ' · last ' + (r.window_days || 30) + ' days</div></div>' +
      '<div class="mg-tile mg-static"><div class="mg-tile-l">Still being chased</div><div class="mg-tile-v">' + escapeHtml(fmtINR((r.still_chasing || {}).amount || 0)) + '</div><div class="mg-tile-chg flat">' + ((r.still_chasing || {}).invoices || 0) + ' invoices</div></div>' +
      '<div class="mg-tile mg-static"><div class="mg-tile-l">Promised to pay</div><div class="mg-tile-v">' + escapeHtml(fmtINR((r.promised || {}).amount || 0)) + '</div><div class="mg-tile-chg flat">' + ((r.promised || {}).invoices || 0) + ' invoices</div></div>' +
    '</div>' +
    '<div class="mg-panel mg-gridwrap"><div class="mg-panel-h"><h2>Channels</h2><span class="mg-aside">Last ' + d.window_days + ' days</span></div>' +
      '<table class="mg-grid"><thead><tr><th>Channel</th><th>Status</th><th class="r">Sent</th><th class="r">Failed</th><th>Last delivered</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="mg-panel mg-gridwrap"><div class="mg-panel-h"><h2>Paid after a chase</h2><span class="mg-aside">Margyn chased, then the invoice closed as paid</span></div>' +
      (recRows ? '<table class="mg-grid"><thead><tr><th>Customer</th><th>Invoice</th><th class="r">Amount (₹)</th><th>Last chased</th><th>Paid</th><th class="r">Chases</th></tr></thead><tbody>' + recRows + '</tbody></table>'
        : '<div class="mg-panel-b"><p class="mg-muted">Nothing yet. An invoice shows here once Margyn has chased it and it later closes as paid.</p></div>') +
      '<div class="mg-panel-b"><p class="mg-muted">This counts payments that followed a chase. It can’t prove the customer wouldn’t have paid anyway.</p></div></div>';
}
MG_OWN_RENDER.channels = mgRenderChannels;

document.addEventListener('click', e => {
  if(e.target.closest('[data-chan-refresh]')) mgLoadChannels(true).then(() => mgRenderChannels());
});

// Load once in the background after sign-in so a failing channel reaches the bell without a visit to this page.
(function(){
  let tries = 0;
  const t = setInterval(() => {
    if(++tries > 30){ clearInterval(t); return; }
    if(typeof currentUser === 'undefined' || !currentUser) return;
    clearInterval(t);
    if(typeof mgCan === 'function' && !mgCan('view_receivables')) return;
    setTimeout(() => mgLoadChannels(), 3000);
  }, 2000);
})();
