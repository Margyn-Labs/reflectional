/* ============================================================
   MARGYN OS PAGES: the overview of each workflow (Collect, Pay, Close,
   Plan), Chasing, Transactions, Documents, Rules and How it works.

   Each page reads the same places every other page reads (mgMoneyGroups,
   mgDisagreements, reconSummary, chaseTargets, snapshots, the forecast),
   so a figure here always matches the page it links to.
   ============================================================ */

function osPanel(title, aside, body, extra){ return '<div class="mg-panel' + (extra ? ' ' + extra : '') + '"><div class="mg-panel-h"><h2>' + escapeHtml(title) + '</h2>' + (aside || '') + '</div>' + body + '</div>'; }
function osAside(t){ return '<span class="mg-aside">' + escapeHtml(t) + '</span>'; }
function osGoLink(label, go){ return '<button type="button" class="mg-link mg-aside" data-os-go="' + go + '">' + escapeHtml(label) + ' →</button>'; }
function osSrcChips(srcs){ return '<span class="os-srcs">' + (srcs || []).map(k => mgLogo(k)).join('') + '</span>'; }
function osAgentsBlock(keys){ return '<div class="os-ags">' + keys.map(k => osAgentRow(OS_AGENT[k])).join('') + '</div>'; }
function osKpis(items){
  return '<div class="os-kpis">' + items.map(x => '<div class="os-kpi' + (x.go ? ' click' : '') + '"' + (x.go ? ' data-os-go="' + x.go + '"' : '') + '><span class="os-kpi-l">' + escapeHtml(x.l) + '</span><span class="os-kpi-v' + (x.tone ? ' ' + x.tone : '') + '">' + escapeHtml(x.v) + '</span><span class="os-kpi-s">' + escapeHtml(x.s || '') + '</span></div>').join('') + '</div>';
}
function osChaseFor(party){
  try { const k = normPartyName(party); return (chaseTargets || []).find(t => normPartyName(t.party_name) === k && !['stopped', 'opted_out'].includes(t.state)) || null; } catch(e){ return null; }
}
const OS_CHASE_LABEL = { active:'Chasing', paused_promise:'Promised', resolved_paid:'Paid', disputed:'Disputed', wrong_contact:'Wrong number', escalated_human:'Needs you', stopped:'Stopped', opted_out:'Opted out' };
const OS_CHASE_TONE = { active:'os-pill-run', paused_promise:'os-pill-wait', resolved_paid:'os-pill-ok', disputed:'os-pill-bad', escalated_human:'os-pill-bad', wrong_contact:'os-pill-bad' };

/* ---------- Collect › Overview ---------- */
function osRenderCollect(){
  const host = document.getElementById('view-collect'); if(!host) return;
  let g = []; try { g = mgMoneyGroups('recv'); } catch(e){}
  const total = g.reduce((t, x) => t + x.amount, 0), overdue = g.reduce((t, x) => t + (x.overdue || 0), 0);
  const age = (() => { try { return mgInvoiceAgeing(g); } catch(e){ return { b0:0, b1:0, b2:0, b3:0 }; } })();
  const rec = (typeof mgChan !== 'undefined' && mgChan && mgChan.recovered) || null;
  const c = reconSummary && reconSummary.connected ? reconSummary.counts : null;
  const late = g.filter(x => x.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 10);
  const maxB = Math.max(1, age.b0, age.b1, age.b2, age.b3);
  host.innerHTML = mgPageHead({ group:'Collect', title:'Collect', sub:'What customers owe you, how late it is, and what Margyn is doing to get it paid.', scope:mgScopeText('Reconciled') }) +
    osKpis([
      { l:'Customers owe you', v:total ? fmtINR(total, 'tile') : '—', s:g.length + ' customer' + (g.length === 1 ? '' : 's'), go:'collect/receivables' },
      { l:'Overdue', v:overdue ? fmtINR(overdue, 'tile') : '₹0', s:late.length + ' customer' + (late.length === 1 ? '' : 's') + ' late', tone:overdue ? 'neg' : '' },
      { l:'Past 90 days', v:fmtINR(age.b3 || 0, 'tile'), s:'the hardest to collect', tone:age.b3 ? 'neg' : '' },
      { l:'Collected after chasing', v:rec && rec.amount != null ? fmtINR(rec.amount, 'tile') : '—', s:rec ? 'last ' + (rec.window_days || 30) + ' days · ' + (rec.invoices || 0) + ' invoice' + (rec.invoices === 1 ? '' : 's') : 'Shows once reminders go out', tone:rec && rec.amount ? 'pos' : '', go:'margyn/delivery' }
    ]) +
    '<div class="mg-row2">' +
      osPanel('Ageing', osGoLink('Open receivables', 'collect/receivables'),
        '<div class="os-age">' + MG_BUCKETS.map(([k, l]) => '<button type="button" class="os-age-r" data-os-age="' + k + '"><span>' + escapeHtml(l) + '</span><span class="os-age-bar"><i class="' + k + '" style="width:' + Math.round((age[k] || 0) / maxB * 100) + '%"></i></span><b>' + escapeHtml(fmtINR(age[k] || 0, 'tile')) + '</b></button>').join('') + '</div>') +
      osPanel('Margyn on it', osGoLink('See it live', 'margyn/live'), osAgentsBlock(['payments', 'collections']) +
        (c ? '<div class="os-note">' + c.verified + ' payments matched to invoices · ' + osAgentState('payments').need + ' to check · ' + (c.unmatched || 0) + ' unmatched</div>' : '')) +
    '</div>' +
    osPanel('Late customers', osAside(late.length ? 'Biggest first' : ''),
      late.length ? '<div class="mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>Customer</th><th class="r">Overdue (₹)</th><th>Oldest</th><th>Chasing</th><th>Apps</th></tr></thead><tbody>' +
        late.map(x => { const t = osChaseFor(x.party);
          return '<tr class="click" data-os-party="recv|' + escapeHtml(x.key) + '"><td>' + escapeHtml(x.party) + '</td><td class="r">' + mgNum(x.overdue) + '</td><td class="mg-mono">' + (x.oldestDays != null && x.oldestDays < 0 ? Math.abs(x.oldestDays) + ' days' : '') + '</td><td>' +
            (t ? '<span class="mg-pill ' + (OS_CHASE_TONE[t.state] || '') + '">' + escapeHtml(OS_CHASE_LABEL[t.state] || t.state) + '</span>' : '<span class="mg-muted">Not chasing</span>') + '</td><td>' + osSrcChips(x.sources) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<div class="mg-empty">Nobody is late. Margyn tells you the moment someone is.</div>');
}

/* ---------- Collect › Chasing ---------- */
function osRenderChasing(){
  const host = document.getElementById('view-chasing'); if(!host) return;
  const all = (typeof chaseTargets !== 'undefined' && chaseTargets) || [];
  const order = { escalated_human:0, disputed:1, active:2, paused_promise:3, wrong_contact:4, resolved_paid:5, stopped:6, opted_out:7 };
  const rows = all.slice().sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || (Number(b.amount) || 0) - (Number(a.amount) || 0));
  const st = (typeof agentDeployments !== 'undefined' && agentDeployments && agentDeployments.chase_agent && agentDeployments.chase_agent.status) || 'not_deployed';
  const act = rows.filter(t => ['active', 'paused_promise'].includes(t.state));
  const rec = (typeof mgChan !== 'undefined' && mgChan && mgChan.recovered) || null;
  host.innerHTML = mgPageHead({ group:'Collect', title:'Chasing', sub:'Every customer Margyn is reminding on WhatsApp: where each one stands, what they said, and when the next reminder goes.',
      actions:'<button class="mg-btn" type="button" data-os-go="rules/autonomy">Chasing rules</button>' }) +
    osKpis([
      { l:'Reminders', v:st === 'active' ? 'On' : st === 'paused' ? 'Paused' : 'Off', s:st === 'active' ? 'Margyn sends them on its own' : 'Switch on in Rules', tone:st === 'active' ? 'pos' : '', go:'rules/autonomy' },
      { l:'Being chased', v:String(act.length), s:fmtINR(act.reduce((t, x) => t + (Number(x.amount) || 0), 0), 'tile') + ' outstanding' },
      { l:'Need you', v:String(rows.filter(t => ['disputed', 'escalated_human', 'wrong_contact'].includes(t.state)).length), s:'disputed, wrong number or escalated' },
      { l:'Paid after a reminder', v:rec && rec.amount != null ? fmtINR(rec.amount, 'tile') : '—', s:rec ? 'last ' + (rec.window_days || 30) + ' days' : '', tone:rec && rec.amount ? 'pos' : '', go:'margyn/delivery' }
    ]) +
    osPanel('Customers', osAside(rows.length + ' in total'),
      rows.length ? '<div class="mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>Customer</th><th class="r">Amount (₹)</th><th>Status</th><th class="r">Reminders</th><th>Last</th><th>Next</th><th>Last reply</th></tr></thead><tbody>' +
        rows.map(t => '<tr><td>' + escapeHtml(t.party_name || '—') + (t.invoice_ref ? '<div class="mg-muted">' + escapeHtml(t.invoice_ref) + '</div>' : '') + '</td><td class="r">' + mgNum(Number(t.amount) || 0) + '</td>' +
          '<td><span class="mg-pill ' + (OS_CHASE_TONE[t.state] || '') + '">' + escapeHtml(OS_CHASE_LABEL[t.state] || t.state) + '</span>' + (t.state === 'paused_promise' && t.promise_to_pay_date ? '<div class="mg-muted">by ' + escapeHtml(fmtDay(t.promise_to_pay_date)) + '</div>' : '') + '</td>' +
          '<td class="r">' + (t.chases_sent || 0) + '</td><td class="mg-mono">' + escapeHtml(t.last_chase_at ? osSince(t.last_chase_at) : '—') + '</td><td class="mg-mono">' + escapeHtml(t.next_chase_at && ['active'].includes(t.state) ? fmtDay(t.next_chase_at) : '—') + '</td>' +
          '<td class="mg-muted">' + escapeHtml(t.last_reply_intent ? String(t.last_reply_intent).replace(/_/g, ' ') + (t.last_reply_at ? ' · ' + osSince(t.last_reply_at) : '') : '') + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="mg-empty">' + (st === 'active' ? 'Nobody needs a reminder right now.' : 'Payment reminders are off. Switch them on and Margyn reminds late customers on WhatsApp, politely, on a schedule you set.') + '</div>');
}

/* ---------- Pay › Overview ---------- */
function osRenderPay(){
  const host = document.getElementById('view-payover'); if(!host) return;
  let g = []; try { g = mgMoneyGroups('pay'); } catch(e){}
  const total = g.reduce((t, x) => t + x.amount, 0), overdue = g.reduce((t, x) => t + (x.overdue || 0), 0), due7 = g.reduce((t, x) => t + (x.due7 || 0), 0);
  let itc = []; try { itc = ((agentActions && agentActions.actions) || []).filter(a => a.kind === 'itc_risk'); } catch(e){}
  const top = g.filter(x => x.due7 > 0 || x.overdue > 0).sort((a, b) => (b.due7 || 0) - (a.due7 || 0)).slice(0, 10);
  host.innerHTML = mgPageHead({ group:'Pay', title:'Pay', sub:'What you owe suppliers, what’s due this week, and what to hold back.', scope:mgScopeText('Reconciled') }) +
    osKpis([
      { l:'You owe suppliers', v:total ? fmtINR(total, 'tile') : '—', s:g.length + ' supplier' + (g.length === 1 ? '' : 's'), go:'pay/payables' },
      { l:'Due in 7 days', v:fmtINR(due7, 'tile'), s:'including anything already late' },
      { l:'Already late', v:fmtINR(overdue, 'tile'), s:'past the due date', tone:overdue ? 'neg' : '' },
      { l:'Holds suggested', v:String(itc.length), s:itc.length ? fmtINR(itc.reduce((t, a) => t + (Number(a.amount) || 0), 0), 'tile') + ' until suppliers file GST' : 'No GST holds', go:itc.length ? 'close/proposals' : 'tax/gst' }
    ]) +
    osPanel('To pay this week', osGoLink('All suppliers', 'pay/payables'),
      top.length ? '<div class="mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>Supplier</th><th class="r">Owed (₹)</th><th class="r">Due in 7 days (₹)</th><th>Status</th><th>Apps</th></tr></thead><tbody>' +
        top.map(x => '<tr class="click" data-os-party="pay|' + escapeHtml(x.key) + '"><td>' + escapeHtml(x.party) + '</td><td class="r">' + mgNum(x.amount) + '</td><td class="r">' + (x.due7 ? mgNum(x.due7) : '') + '</td><td>' + (x.overdue > 0 ? '<span class="mg-pill os-pill-bad">Late</span>' : '<span class="mg-pill">Open</span>') + '</td><td>' + osSrcChips(x.sources) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="mg-empty">' + (g.length ? 'Nothing is due this week.' : 'No supplier bills yet. Connect your books or add a bill.') + '</div>');
}

/* ---------- Close › Overview: the month-end checklist, worked out from the books ---------- */
function osRenderClose(){
  const host = document.getElementById('view-closeover'); if(!host) return;
  const on = ['tally', 'zoho', 'odoo', 'razorpay', 'cashfree', 'shopify'].filter(k => mgSourceHealth(k).on);
  const stale = on.filter(k => mgSourceHealth(k).warn);
  let dis = []; try { dis = mgDisagreements(); } catch(e){}
  const c = reconSummary && reconSummary.connected ? reconSummary.counts : null;
  let props = 0; try { props = ((agentActions && agentActions.actions) || []).length; } catch(e){}
  const docs = ((typeof pendingSuggestions !== 'undefined' && pendingSuggestions) || []).length;
  const sends = typeof mgPackSends !== 'undefined' && Array.isArray(mgPackSends) ? mgPackSends : [];
  const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const packSent = sends.some(x => String(x.period || x.month || '').slice(0, 7) === lastMonth && /sent|deliver/i.test(x.status || 'sent'));
  const steps = [
    { t:'Every app synced', ok:on.length > 0 && !stale.length, s:!on.length ? 'No app connected yet' : stale.length ? stale.map(k => MG_SRC_LABEL[k]).join(', ') + ' haven’t synced in 2 days' : on.length + ' app' + (on.length === 1 ? '' : 's') + ' up to date', who:'Books agent', go:'apps/connected' },
    { t:'Your books agree', ok:!dis.length, s:dis.length ? dis.length + ' place' + (dis.length === 1 ? '' : 's') + ' where two sources disagree' : 'Every source agrees within 2%', who:dis.length ? 'You' : 'Books agent', go:'close/books' },
    { t:'Payments matched to invoices', ok:!!c && !osAgentState('payments').need, s:c ? c.verified + ' matched · ' + osAgentState('payments').need + ' to check' : 'Connect Razorpay or Cashfree and Zoho Books', who:'Payments agent', go:'collect/matching' },
    { t:'Proposals decided', ok:!props, s:props ? props + ' waiting for your OK' : 'Nothing waiting', who:props ? 'You' : 'Close agent', go:'close/proposals' },
    { t:'Forwarded documents placed', ok:!docs, s:docs ? docs + ' to approve' : 'Nothing waiting', who:docs ? 'You' : 'Documents agent', go:'documents/forwarded' },
    { t:'CFO pack for ' + mgMonthLabel(lastMonth), ok:packSent, s:packSent ? 'Sent' : 'Not sent yet', who:'You', go:'reports/cfo-pack' }
  ];
  const done = steps.filter(x => x.ok).length;
  host.innerHTML = mgPageHead({ group:'Close', title:'Close', sub:'Getting the books right: every app synced, every source agreeing, every payment matched, every proposal decided.' }) +
    '<div class="mg-panel os-check"><div class="mg-panel-h"><h2>Month-end checklist</h2>' + osAside(done + ' of ' + steps.length + ' done') + '</div>' +
      '<div class="os-prog"><i style="width:' + Math.round(done / steps.length * 100) + '%"></i></div>' +
      steps.map((x, i) => '<button type="button" class="os-step' + (x.ok ? ' ok' : '') + '" data-os-go="' + x.go + '"><span class="os-step-n">' + (x.ok ? '✓' : i + 1) + '</span><span class="os-step-m"><b>' + escapeHtml(x.t) + '</b><span>' + escapeHtml(x.s) + '</span></span><span class="os-step-w">' + escapeHtml(x.who) + '</span></button>').join('') + '</div>' +
    '<div class="mg-row2">' +
      osPanel('Margyn on it', osGoLink('See it live', 'margyn/live'), osAgentsBlock(['books', 'close', 'documents'])) +
    '</div>';
}

/* ---------- Plan › Overview ---------- */
function osRenderPlan(){
  const host = document.getElementById('view-plan'); if(!host) return;
  const s = (snapshots || [])[0] || null, p = (snapshots || [])[1] || null;
  const vit = l => { const v = mgVital(s, l); return v ? v.value : '—'; };
  let f = null; try { f = mgForecast(); } catch(e){}
  const pd = s && p && s.pulse_score != null && p.pulse_score != null ? s.pulse_score - p.pulse_score : null;
  const band = s && s.pulse_score != null && typeof scoreBand === 'function' ? scoreBand(s.pulse_score) : null;
  host.innerHTML = mgPageHead({ group:'Plan', title:'Plan', sub:'How healthy the business is and where it’s heading: Pulse, margin, runway and the forecast in one place.' }) +
    osKpis([
      { l:'Pulse Score', v:s && s.pulse_score != null ? String(s.pulse_score) : '—', s:(band && band.label ? band.label + ' · ' : '') + (pd != null ? (pd >= 0 ? 'up ' : 'down ') + Math.abs(pd) + ' on last reading' : 'operating health, not a credit score'), go:'plan/pulse' },
      { l:'Net margin', v:String(vit('Net Margin')), s:'from your books', go:'plan/margin' },
      { l:'Working-capital runway', v:String(vit('Working Capital Runway')), s:'at today’s burn' },
      { l:'Cash low point', v:f ? fmtINR(f.min, 'tile') : '—', s:f ? 'week ' + (f.minWeek + 1) + ' of 13' + (f.firstBelow >= 0 ? ' · below your floor' : '') : 'Forecast needs more figures', tone:f && f.firstBelow >= 0 ? 'neg' : '', go:'cash/forecast' }
    ]) +
    '<div class="mg-row2">' +
      osPanel('Margyn on it', osGoLink('See it live', 'margyn/live'), osAgentsBlock(['forecast', 'watch'])) +
    '</div>';
}

/* ---------- Transactions ---------- */
let osTxType = 'all', osTxQ = '';
function osRenderTransactions(){
  const host = document.getElementById('view-transactions'); if(!host) return;
  const rows = [];
  const can = p => typeof mgCan !== 'function' || mgCan(p);   // each row only for a role that may see it
  [['recv', 'Invoice', 'view_receivables'], ['pay', 'Bill', 'view_payables']].forEach(([dir, type, need]) => { if(!can(need)) return; try { mgMoneyRows(dir).forEach(r => rows.push({ type, dir, party:r.party, ref:r.ref, src:r.src, due:r.due, days:r.days, amount:r.amount })); } catch(e){} });
  if(can('view_cash')) try { const gw = typeof mgCashGw !== 'undefined' && mgCashGw;
    if(gw && gw.rz) (gw.rz.settlements || []).slice(0, 60).forEach(x => rows.push({ type:'Settlement', dir:'in', party:'Razorpay settlement', ref:x.utr || x.id || '', src:'razorpay', due:x.settled_at || x.created_at || null, days:null, amount:Number(x.amount) || 0 }));
    if(gw && gw.cf) (gw.cf.settlements || []).slice(0, 60).forEach(x => rows.push({ type:'Settlement', dir:'in', party:'Cashfree settlement', ref:x.utr || x.id || '', src:'cashfree', due:x.settled_at || x.created_at || null, days:null, amount:Number(x.amount) || 0 })); } catch(e){}
  const q = osTxQ.trim().toLowerCase();
  const shown = rows.filter(r => (osTxType === 'all' || r.type === osTxType) && (!q || [r.party, r.ref, r.src, r.type].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.amount || 0) - (a.amount || 0));
  const count = t => rows.filter(r => t === 'all' || r.type === t).length;
  host.__csv = [['Type', 'Party', 'Reference', 'App', 'Date', 'Amount (INR)'], shown.map(r => [r.type, r.party, r.ref || '', MG_SRC_LABEL[r.src] || r.src, r.due || '', Math.round(r.amount)])];
  host.innerHTML = mgPageHead({ group:'Records', title:'Transactions', sub:'Open invoices and bills from every connected app, and the settlements Margyn has read, in one list. Each row says which app it came from.', actions:mgExportBtn('mgExport-transactions') }) +
    '<div class="os-subtabs">' + [['all', 'All'], ['Invoice', 'Invoices'], ['Bill', 'Bills'], ['Settlement', 'Settlements']].map(([k, l]) => '<button type="button" class="' + (k === osTxType ? 'on' : '') + '" data-os-tx="' + k + '">' + l + '<i>' + count(k) + '</i></button>').join('') + '</div>' +
    '<div class="mg-toolbar"><input class="mg-search" type="search" placeholder="Find a party, reference or app" value="' + escapeHtml(osTxQ) + '" data-os-txq><span class="mg-count">' + shown.length + ' shown</span></div>' +
    (shown.length ? '<div class="mg-panel mg-gridwrap"><table class="mg-grid"><thead><tr><th>Type</th><th>Party</th><th>Reference</th><th>App</th><th>Date</th><th class="r">Amount (₹)</th></tr></thead><tbody>' +
      shown.slice(0, 400).map(r => '<tr><td>' + escapeHtml(r.type) + '</td><td>' + escapeHtml(r.party) + '</td><td class="mg-mono">' + escapeHtml(r.ref || '') + '</td><td>' + mgLogo(r.src) + ' ' + escapeHtml(MG_SRC_LABEL[r.src] || r.src || '') + '</td><td class="mg-mono">' + escapeHtml(r.due ? fmtDate(r.due) : '') + (r.days != null && r.days < 0 ? ' <span class="mg-pill os-pill-bad">' + Math.abs(r.days) + 'd late</span>' : '') + '</td><td class="r">' + mgNum(r.amount) + '</td></tr>').join('') +
      '</tbody></table>' + (shown.length > 400 ? '<div class="os-note">Showing the 400 largest. Use Export for the full list.</div>' : '') + '</div>'
      : '<div class="mg-panel mg-empty-panel"><h2>Nothing here yet</h2><p>Connect your books or a payment gateway and every invoice, bill and settlement shows here.</p>' + mgBtn('Connect an app', 'data-os-go="apps/connected"', true) + '</div>');
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-os-tx]'); if(t){ osTxType = t.dataset.osTx; osRenderTransactions(); return; }
  const a = e.target.closest('[data-os-age]'); if(a){ mgMoneyAge = a.dataset.osAge; osGo('collect', 'receivables'); return; }
  const p = e.target.closest('[data-os-party]'); if(p && typeof mgOpenParty === 'function'){ const [dir, key] = p.dataset.osParty.split('|'); mgOpenParty(dir, key); return; }
});
document.addEventListener('input', e => {
  if(!e.target.matches('[data-os-txq]')) return;
  osTxQ = e.target.value; const pos = e.target.selectionStart;
  osRenderTransactions();
  const again = document.querySelector('#view-transactions [data-os-txq]'); if(again){ again.focus(); try { again.setSelectionRange(pos, pos); } catch(err){} }
});

/* ---------- Documents ---------- */
let osDocs = null, osDocsBusy = false;
async function osLoadDocs(){
  if(osDocsBusy || !currentUser) return; osDocsBusy = true;
  try { const { data } = await sbClient.from('import_suggestions').select('id,status,source,from_phone,mime_type,received_at,decided_at,proposal').eq('user_id', currentUser.id).order('received_at', { ascending:false }).limit(60); osDocs = data || []; }
  catch(e){ osDocs = []; }
  osDocsBusy = false;
  if(mgCurrentView === 'documents') osRenderDocuments();
}
function osRenderDocuments(){
  const host = document.getElementById('view-documents'); if(!host) return;
  if(osDocs === null) osLoadDocs();
  const docs = osDocs || [];
  const sends = typeof mgPackSends !== 'undefined' && Array.isArray(mgPackSends) ? mgPackSends : [];
  const ST = { pending:['Waiting for you', 'os-pill-prop'], approved:['Placed in your books', 'os-pill-ok'], rejected:['Rejected', ''] };
  host.innerHTML = mgPageHead({ group:'Records', title:'Documents', sub:'Everything sent to Margyn on WhatsApp, what it read in each, and what happened to it. Nothing reaches your books until you approve it.',
      actions:mgBtn('Import a file', 'data-os-go="documents/import"', true) }) +
    osPanel('Sent to Margyn', osAside(docs.length + ' document' + (docs.length === 1 ? '' : 's')),
      docs.length ? '<div class="mg-gridwrap"><table class="mg-grid comfy"><thead><tr><th>Received</th><th>From</th><th>What Margyn read</th><th class="r">Amount (₹)</th><th>Status</th></tr></thead><tbody>' +
        docs.map(d => { const ents = (d.proposal && d.proposal.entries) || [], amt = ents.reduce((t, x) => t + (Number(x.amount) || 0), 0), s = ST[d.status] || [d.status, ''];
          return '<tr><td class="mg-mono">' + escapeHtml(d.received_at ? fmtDate(d.received_at) : '') + '</td><td>' + escapeHtml(d.from_phone && typeof waPrettyPhone === 'function' ? waPrettyPhone(d.from_phone) : (d.source || '')) + '</td><td>' + escapeHtml(ents.slice(0, 2).map(x => [x.party, x.kind || x.type].filter(Boolean).join(' · ')).join('; ') || (d.mime_type || 'Document')) + (ents.length > 2 ? ' +' + (ents.length - 2) : '') + '</td><td class="r">' + (amt ? mgNum(amt) : '') + '</td><td><span class="mg-pill ' + s[1] + '">' + escapeHtml(s[0]) + '</span></td></tr>'; }).join('') + '</tbody></table></div>' +
        (docs.some(d => d.status === 'pending') ? '<div class="os-note"><button type="button" class="mg-btn mg-btn-sm primary" data-os-go="documents/forwarded">Approve what’s waiting</button></div>' : '')
        : '<div class="mg-empty">' + (osDocs === null ? 'Loading…' : 'Forward a bill, invoice or receipt to your Margyn WhatsApp number, or import a file, and it shows here.') + '</div>') +
    osPanel('Packs sent', osGoLink('CFO pack', 'reports/cfo-pack'), sends.length ? '<div class="os-feed">' + sends.map(x => '<div class="os-fe done"><span class="os-fe-dot"></span><span class="os-fe-t">CFO pack' + (x.period ? ' for ' + escapeHtml(mgMonthLabel(String(x.period).slice(0, 7))) : '') + (x.recipients ? ' to ' + escapeHtml([].concat(x.recipients).join(', ')) : '') + '</span><small>' + escapeHtml(x.created_at ? fmtDate(x.created_at) : '') + '</small></div>').join('') + '</div>' : '<div class="mg-empty">No packs sent yet.</div>');
}

/* ---------- Rules: what Margyn may do on its own (the real settings) ---------- */
function osRenderRules(){
  const host = document.getElementById('view-rules'); if(!host) return;
  // Permissions only: what each agent may do without a person. Whether an agent is
  // switched on, and what it is doing, is on its card under Margyn › Agents.
  const OWN = ['Does it on its own', 'os-pill-ok'], ASK = ['You approve', 'os-pill-prop'], SOON = ['Coming app by app', ''];
  const rows = [
    { a:'Payments', what:'Match payments to invoices', may:ASK, note:'Exact single matches are verified automatically; anything ambiguous comes to Work.' },
    { a:'Collections', what:'Send payment reminders on WhatsApp', may:OWN, note:'Once switched on, reminders follow your schedule and stop the moment a customer pays, disputes or promises a date.', go:'margyn/agents' },
    { a:'Close', what:'Book journal entries for exceptions', may:ASK, note:'Nothing is booked until you approve it in Work.' },
    { a:'GST', what:'Hold payments to suppliers who haven’t filed', may:ASK, note:'Margyn drafts the message to the supplier; you see it before it goes.' },
    { a:'Documents', what:'Place forwarded bills and invoices in your books', may:ASK, note:'Every document waits in Documents until you approve it.' },
    { a:'Watch', what:'Send you WhatsApp updates and the Opening and Closing Bell', may:OWN, note:'Once switched on: morning detail, short updates at 10:30 and 3:00, an evening wrap-up.', go:'margyn/agents' },
    (() => { const caps = (typeof osWB !== 'undefined' && osWB.caps) || [], on = caps.filter(c => c.any_on).map(c => c.label);
      return { a:'Books', what:'Write approved changes back to your apps', may:on.length ? ASK : SOON,
        note:on.length ? 'Writes to ' + on.join(', ') + ' after you approve. Other apps: saved in Margyn until they get write permission.' : 'Every approval is queued for its app (Work › Sent to apps). Until an app gets write permission, the change is saved in Margyn and you make it in the app.', go:'work/all', goLabel:'See what was sent' }; })()
  ];
  host.innerHTML = mgPageHead({ group:'Rules', title:'What Margyn may do', sub:'For each job: whether Margyn may do it on its own, or suggests and waits for a person. Switching an agent on or off is on its card under Margyn › Agents.' }) +
    '<div class="mg-panel"><div class="mg-gridwrap"><table class="mg-grid comfy os-rules"><thead><tr><th>Agent</th><th>Job</th><th>Margyn may</th><th></th></tr></thead><tbody>' +
      rows.map(r => '<tr><td><b>' + escapeHtml(r.a) + '</b></td><td>' + escapeHtml(r.what) + '<div class="mg-muted">' + escapeHtml(r.note) + '</div></td><td><span class="mg-pill ' + r.may[1] + '">' + escapeHtml(r.may[0]) + '</span></td><td class="r">' + (r.go ? '<button type="button" class="mg-btn mg-btn-sm"' + (r.go === 'work/all' ? ' data-os-worktab-go="apps"' : '') + ' data-os-go="' + r.go + '">' + escapeHtml(r.goLabel || 'Switch on or off') + '</button>' : '') + '</td></tr>').join('') +
    '</tbody></table></div></div>' +
    '<div class="os-note">Every change Margyn makes, and every approval, is recorded with who did it in the Audit log.</div>';
}

/* ---------- How Margyn works ---------- */
function osRenderHow(){
  const host = document.getElementById('view-howitworks'); if(!host) return;
  const F = (typeof MG_FORMULAS !== 'undefined' && MG_FORMULAS) || null;
  const figs = F ? Object.keys(F.FIGURES).map(k => F.FIGURES[k]) : [];
  const how = F ? Object.keys(F.HOW).map(k => [k, F.HOW[k]]) : [];
  const HOW_T = { pipeline:'How your figures are made', sources:'Which source Margyn trusts', differences:'Why two sources can differ', ai_role:'What the AI does, and doesn’t', freshness:'How fresh your figures are', readings:'Readings and history', approvals:'What needs your approval', privacy:'Your data and privacy', single_truth:'Counted once, never twice' };
  const rel = (typeof MG_RELEASES !== 'undefined' && MG_RELEASES) || [];
  host.innerHTML = mgPageHead({ group:'Margyn', title:'How Margyn works', sub:'Every figure, how it is worked out and where its inputs come from, in plain words. Ask Margyn about any of them.' }) +
    '<div class="mg-row2">' +
      osPanel('How Margyn works', '', '<div class="os-how">' + how.map(([k, t]) => '<details><summary>' + escapeHtml(HOW_T[k] || k.replace(/_/g, ' ')) + '</summary><p>' + escapeHtml(t) + '</p></details>').join('') + '</div>') +
      osPanel('What’s new', '<button type="button" class="mg-link mg-aside" data-mgr-wn>Show the latest →</button>', '<div class="os-feed">' + rel.slice(0, 10).map(r => '<div class="os-fe done"><span class="os-fe-dot"></span><span class="os-fe-t"><b>' + escapeHtml(r.title || '') + '</b></span><small>' + escapeHtml(r.date || '') + '</small></div>').join('') + '</div>') +
    '</div>' +
    osPanel('Every figure', osAside(figs.length + ' figures'), '<div class="os-how">' + figs.map(f => '<details><summary>' + escapeHtml(f.label) + '<span>' + escapeHtml(f.what || '') + '</span></summary><p><b>Formula.</b> ' + escapeHtml(f.formula || '') + '</p>' + ((f.notes || []).length ? '<p class="mg-muted">' + escapeHtml(f.notes.join(' ')) + '</p>' : '') + '<button type="button" class="mg-link" data-mgr-ask="' + escapeHtml('How is my ' + f.label + ' worked out?') + '">Ask Margyn about my ' + escapeHtml(f.label) + ' →</button></details>').join('') + '</div>');
}

/* ---------- register ---------- */
Object.assign(MG_OWN_RENDER, { collect:osRenderCollect, chasing:osRenderChasing, payover:osRenderPay, closeover:osRenderClose, plan:osRenderPlan,
  transactions:osRenderTransactions, documents:osRenderDocuments, rules:osRenderRules, howitworks:osRenderHow });
