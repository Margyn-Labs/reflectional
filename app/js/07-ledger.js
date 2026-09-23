/* ============================================================
   LEDGER (NEW) — receivables, payables & cash, toggleable
   individually or consolidated, with inline mark-received /
   mark-paid actions. Reuses the same receivables/payables tables
   and recvBucket/payUrgency/ledgerAggregates logic as the vital
   detail modals — this is just a dedicated, always-open page for it.
   ============================================================ */
let ledgerActiveTab = 'all';
let ledgerSourceFilter = 'all'; // all | self | zoho | tally — filters the unified ledger table

/* ============================================================
   UNIFIED LEDGER — one view over all three receivables/payables
   sources: self-entered (manual/CSV upload) + Zoho Books + Tally.
   IMPORTANT: only the self-entered rows are editable and only they
   feed ledgerAggregates()/saveLedgerSnapshot()/the Pulse Score.
   Connector rows are read-only and shown for comparison only —
   they are NEVER summed into the self-entered totals or the vitals.
   ============================================================ */
function normPartyName(s){
  return String(s||'').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g,'')
    .replace(/[^a-z0-9]/g,'');
}
const LEDGER_SOURCE_META = {
  manual: { label:'Manual',      cls:'self-reported', group:'self' },
  upload: { label:'CSV upload',  cls:'self-reported', group:'self' },
  zoho:   { label:'Zoho Books',  cls:'connector',     group:'zoho' },
  tally:  { label:'Tally',       cls:'connector',     group:'tally' }
};
/* every open row, from every source, for one direction ('recv'|'pay') */
function unifiedLedgerRows(direction){
  const out = [];
  const selfArr = direction === 'recv' ? receivables : payables;
  selfArr.forEach(r => out.push({
    party: r.party_name, amount: Number(r.amount)||0, due_date: r.due_date || null,
    source: (r.source === 'upload' ? 'upload' : 'manual'), editable: true,
    kind: direction, raw: r, ref: null, recon: r.reconciliation_status || null
  }));
  const zArr = direction === 'recv'
    ? (zohoLedgerRows && zohoLedgerRows.receivables) || []
    : (zohoLedgerRows && zohoLedgerRows.payables) || [];
  zArr.forEach(r => out.push({
    party: r.party_name, amount: Number(r.amount)||0, due_date: r.due_date || null,
    source: 'zoho', editable: false, kind: direction, ref: r.ref || null
  }));
  if(tallyData && tallyData.bills && Array.isArray(tallyData.bills.items)){
    const want = direction === 'recv' ? 'receivable' : 'payable';
    tallyData.bills.items.filter(b => b.direction === want).forEach(b => out.push({
      party: b.party_name, amount: Number(b.amount)||0, due_date: b.due_date || null,
      source: 'tally', editable: false, kind: direction, ref: b.bill_ref || null,
      overdue: b.overdue_days != null ? b.overdue_days : null
    }));
  }
  return out;
}
/* group a direction's rows by normalised counterparty, flag cross-source agree/conflict */
function crossLedgerGroups(direction){
  const map = new Map();
  unifiedLedgerRows(direction).forEach(r => {
    const key = normPartyName(r.party) || ('~' + (r.party||'').toLowerCase());
    if(!map.has(key)) map.set(key, { party: r.party, bySource:{}, srcGroups:new Set() });
    const g = map.get(key);
    const grp = (LEDGER_SOURCE_META[r.source]||{}).group || r.source;
    g.bySource[grp] = (g.bySource[grp]||0) + r.amount;
    g.srcGroups.add(grp);
  });
  return [...map.values()].map(g => {
    const amts = Object.values(g.bySource);
    const max = Math.max(...amts), min = Math.min(...amts);
    const multi = g.srcGroups.size >= 2;
    const agree = multi && (max - min) <= Math.max(1, max * 0.02); // within 2% or ₹1
    return { party: g.party, bySource: g.bySource, sources:[...g.srcGroups], multi, agree, conflict: multi && !agree };
  });
}
/* compact structure passed to the AI context so it can reason across sources */
function buildCrossLedgerSummary(){
  const pack = dir => {
    const groups = crossLedgerGroups(dir);
    const bySourceTotal = {};
    unifiedLedgerRows(dir).forEach(r => {
      const grp = (LEDGER_SOURCE_META[r.source]||{}).group || r.source;
      bySourceTotal[grp] = (bySourceTotal[grp]||0) + r.amount;
    });
    return {
      totalsBySource: bySourceTotal,
      agree: groups.filter(g => g.agree).map(g => ({ party:g.party, amount: Math.max(...Object.values(g.bySource)), sources:g.sources })),
      conflict: groups.filter(g => g.conflict).map(g => ({ party:g.party, bySource:g.bySource, sources:g.sources })),
      singleSource: groups.filter(g => !g.multi).map(g => ({ party:g.party, amount: Object.values(g.bySource)[0], source:g.sources[0] }))
    };
  };
  const hasAny = receivables.length || payables.length
    || (zohoLedgerRows && ((zohoLedgerRows.receivables||[]).length || (zohoLedgerRows.payables||[]).length))
    || (tallyData && tallyData.bills && (tallyData.bills.items||[]).length);
  if(!hasAny) return null;
  return {
    sourcesPresent: {
      self: !!(receivables.length || payables.length),
      zoho: !!(zohoConnected && zohoLedgerRows && ((zohoLedgerRows.receivables||[]).length || (zohoLedgerRows.payables||[]).length)),
      tally: !!(tallyConnected && tallyData && tallyData.bills && (tallyData.bills.items||[]).length)
    },
    receivables: pack('recv'),
    payables: pack('pay')
  };
}
function ledgerSourceChip(src){
  const m = LEDGER_SOURCE_META[src] || { label: src, cls:'' };
  let html = '<span class="lr-tag ' + m.cls + '">' + m.label + '</span>';
  if(src === 'tally') html += '<span class="lr-tag unreconciled">Signal</span>';
  return html;
}
const LT_AV_PALETTE = ['#0E8F5C','#0B4B8C','#CC5B34','#5B6472','#0A6E46','#767E8B'];
function ltInitials(name){ return (name||'?').trim().split(/\s+/).slice(0,2).map(w => w[0] || '').join('').toUpperCase() || '?'; }
function ltAvColor(name){ let h = 0; for(let i=0;i<(name||'').length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0; return LT_AV_PALETTE[h % LT_AV_PALETTE.length]; }
function renderLedgerFacts(){
  const host = document.getElementById('ledgerFacts'); if(!host) return;
  host.className = 'rd-strip';
  const { recvTotal } = ledgerAggregates();               // self-entered only, feeds the Pulse Score
  const payTotal = payables.reduce((s,p) => s + Number(p.amount), 0);
  const net = recvTotal - payTotal;
  const overdue = [...receivables, ...payables].filter(r => { const d = daysFromToday(r.due_date); return d != null && d < 0; }).length;
  host.innerHTML =
    '<div data-margyn-topic="Total receivable"><div class="l">Receivable</div><div class="v" style="color:var(--rose);">'+inr(recvTotal)+'</div></div>' +
    '<div data-margyn-topic="Total payable"><div class="l">Payable</div><div class="v" style="color:var(--text-1);">'+inr(payTotal)+'</div></div>' +
    '<div data-margyn-topic="Net position"><div class="l">Net position</div><div class="v" style="color:'+(net>=0?'var(--emerald-bright)':'var(--rose)')+';">'+(net>=0?'+':'')+inr(net)+'</div></div>' +
    '<div><div class="l">Overdue count</div><div class="v">'+overdue+'</div></div>';
}
function renderLedgerView(){
  renderLedgerFacts();
  renderChaseCold();
  document.querySelectorAll('#ledgerTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.ltab === ledgerActiveTab));
  const addForm = document.getElementById('ledgerAddForm');
  const addTitle = document.getElementById('ledgerAddTitle');
  const listTitle = document.getElementById('ledgerListTitle');
  const host = document.getElementById('ledgerListHost');
  const srcSel = document.getElementById('ledgerSourceFilter');
  const srcNote = document.getElementById('ledgerSourceNote');
  if(srcSel && srcSel.value !== ledgerSourceFilter) srcSel.value = ledgerSourceFilter;
  if(ledgerActiveTab === 'cash'){
    addForm.classList.add('hidden');
    if(srcSel) srcSel.parentElement.style.display = 'none';
    if(srcNote) srcNote.textContent = '';
    listTitle.textContent = 'Cash balance readings';
    if(!snapshots.length){ host.innerHTML = '<div class="ledger-empty">No cash readings yet. Add one on Upload &amp; calculate.</div>'; return; }
    let rowsHtml = '';
    snapshots.forEach((s, i) => {
      const prev = snapshots[i+1];
      const d = prev ? Number(s.cash) - Number(prev.cash) : null;
      const changeCell = d===null ? '—' : (d>0?'<span class="lr-tag ok">▲ '+inr(d)+'</span>':d<0?'<span class="lr-tag warn">▼ '+inr(Math.abs(d))+'</span>':'—');
      rowsHtml += '<tr><td>'+fmtDate(s.created_at)+'</td><td style="text-transform:capitalize;">'+(s.source||'manual')+'</td><td>'+changeCell+'</td><td class="num">'+inr(s.cash)+'</td></tr>';
    });
    let cashExtra = '';
    if(tallyData && tallyData.ledgers && Array.isArray(tallyData.ledgers.items)){
      const led = tallyData.ledgers.items.filter(x => x.closing_balance != null).slice(0,30);
      if(led.length) cashExtra = '<div class="ledger-list-title" style="display:flex; gap:8px; align-items:center;">Tally ledger balances <span class="lr-tag unreconciled">Signal</span></div>' +
        '<table class="ledger-table"><thead><tr><th>Ledger</th><th>Group</th><th class="num">Closing balance</th></tr></thead><tbody>' +
        led.map(x => '<tr><td>'+escapeHtml(x.name)+'</td><td>'+escapeHtml(x.parent||'—')+'</td><td class="num">'+inr(x.closing_balance)+'</td></tr>').join('') + '</tbody></table>';
    }
    host.innerHTML = '<table class="ledger-table"><thead><tr><th>Date</th><th>Source</th><th>Change</th><th class="num">Balance</th></tr></thead><tbody>'+rowsHtml+'</tbody></table>' + cashExtra;
    return;
  }
  if(srcSel) srcSel.parentElement.style.display = '';
  addForm.classList.toggle('hidden', !ledgerAddOpen);
  const tgl = document.getElementById('ledgerAddToggle');
  if(tgl) tgl.textContent = ledgerAddOpen ? 'Close' : '+ Add entry';
  addTitle.textContent = ledgerActiveTab === 'payables' ? 'Add payable' : 'Add receivable';
  document.getElementById('ledgerParty').placeholder = ledgerActiveTab === 'payables' ? 'Vendor name' : 'Customer name';
  const farFuture = new Date(8640000000000000);
  let rows = [];
  if(ledgerActiveTab === 'receivables') rows = unifiedLedgerRows('recv');
  else if(ledgerActiveTab === 'payables') rows = unifiedLedgerRows('pay');
  else rows = [ ...unifiedLedgerRows('recv'), ...unifiedLedgerRows('pay') ];
  if(ledgerSourceFilter !== 'all'){
    rows = rows.filter(r => ((LEDGER_SOURCE_META[r.source]||{}).group) === ledgerSourceFilter);
  }
  rows.sort((a,b) => (a.due_date?new Date(a.due_date):farFuture) - (b.due_date?new Date(b.due_date):farFuture));
  // cross-source lookup so a row can show "2 sources agree" / "sources differ"
  const groupIndex = {};
  ['recv','pay'].forEach(dir => crossLedgerGroups(dir).forEach(g => { groupIndex[dir + '|' + normPartyName(g.party)] = g; }));
  const showType = ledgerActiveTab === 'all';
  listTitle.textContent = (ledgerActiveTab === 'receivables' ? 'Open receivables' : ledgerActiveTab === 'payables' ? 'Open payables' : 'All open entries') + ' (' + rows.length + ')';
  if(srcNote){
    const parts = [];
    if(receivables.length || payables.length) parts.push('your manual/CSV ledger');
    if(zohoConnected) parts.push('Zoho Books');
    if(tallyConnected) parts.push('Tally (Signal)');
    srcNote.innerHTML = parts.length > 1
      ? 'Showing entries from ' + parts.join(' + ') + '. Only your manual/CSV rows are editable and count toward your Pulse Score — connector rows are shown for comparison.'
      : '';
  }
  if(!rows.length){ host.innerHTML = '<div class="ledger-empty">Nothing open in this view.</div>'; return; }
  const srcMeta = src => (LEDGER_SOURCE_META[src] || { label: src });
  let rowsHtml =
    '<div class="lt-head"><span>' + (ledgerActiveTab==='payables'?'Vendor':ledgerActiveTab==='receivables'?'Customer':'Party') + '</span>' +
    '<span>' + (showType ? 'Type' : 'Source') + '</span><span>Due</span><span>Status</span><span style="text-align:right;">Amount</span><span></span></div>';
  rows.forEach((r, i) => {
    const isRecv = r.kind === 'recv';
    const badge = isRecv ? recvBucket(r.due_date) : payUrgency(r.due_date);
    const g = groupIndex[(isRecv?'recv':'pay') + '|' + normPartyName(r.party)];
    const xtag = g && g.agree ? '<span class="lt-pill ok">2+ agree</span>'
      : g && g.conflict ? '<span class="lt-pill warn">sources differ</span>' : '';
    const sub = (srcMeta(r.source).label || r.source || '').toUpperCase() + (r.ref ? ' · ' + escapeHtml(r.ref) : '') + (r.source === 'tally' ? ' · SIGNAL' : '');
    const typeCell = showType
      ? '<span class="lt-pill' + (isRecv ? '' : ' warn') + '">' + (isRecv ? 'Receivable' : 'Payable') + '</span>'
      : '<span class="lt-pill">' + escapeHtml(srcMeta(r.source).label || r.source || '') + '</span>';
    const badgeCls = badge.tag === 'bad' ? 'bad' : badge.tag === 'ok' ? 'ok' : badge.tag ? 'warn' : '';
    const actions = r.editable
      ? '<div style="display:flex;gap:4px;justify-content:flex-end;"><button class="lt-kebab" data-idx="' + i + '" data-act="settle" title="' + (isRecv ? 'Mark received' : 'Mark paid') + '">&#10003;</button><button class="lt-kebab" data-idx="' + i + '" data-act="del" title="Delete">&times;</button></div>'
      : '<span></span>';
    rowsHtml +=
      '<div class="lt-row" data-idx="' + i + '">' +
      '<div class="lt-party"><span class="lt-av" style="background:' + ltAvColor(r.party) + '">' + escapeHtml(ltInitials(r.party)) + '</span>' +
        '<span style="min-width:0;"><span class="nm">' + escapeHtml(r.party || 'Unnamed') + '</span><span class="mt">' + sub + '</span></span></div>' +
      '<div>' + typeCell + (xtag ? ' ' + xtag : '') + '</div>' +
      '<div class="mono" style="font-size:12px;color:var(--text-1);">' + (r.due_date ? fmtDay(r.due_date) : 'No date') + '</div>' +
      '<div>' + (badge.label ? '<span class="lt-pill ' + badgeCls + '">' + badge.label + '</span>' : '<span class="lt-pill">Open</span>') + '</div>' +
      '<div class="lt-amt">' + inr(r.amount) + '</div>' +
      actions +
      '</div>';
  });
  host.innerHTML = '<div class="lt-table">' + rowsHtml + '</div>';
  host.querySelectorAll('.lt-kebab[data-idx]').forEach(btn => {
    const r = rows[Number(btn.dataset.idx)];
    if(!r || !r.editable) return;
    const isRecv = r.kind === 'recv';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if(btn.dataset.act === 'settle'){ isRecv ? ledgerSettleReceivable(r.raw) : ledgerSettlePayable(r.raw); }
      else if(await mgConfirm({ title:'Delete this entry?', body:'It is removed from your ledger and your figures are recalculated. The deletion stays in the activity log.',
        effect:[[isRecv ? 'Customer' : 'Vendor', r.raw.party_name || '—'], ['Amount', inr(r.raw.amount)]], confirmLabel:'Delete entry', danger:true })){ isRecv ? ledgerRemoveReceivable(r.raw) : ledgerRemovePayable(r.raw); }
    });
  });
  host.querySelectorAll('.lt-row[data-idx]').forEach(row => {
    const r = rows[Number(row.dataset.idx)];
    if(!r) return;
    row.addEventListener('click', () => openLedgerRowDetail(r));
  });
}
/* Row detail: reuses the app's one generic detail modal (#detailOverlay /
   #detailContent — the same shell openVitalDetail uses) instead of a new
   component, and shows this entry's own ledger_events history inline so
   provenance is visible without leaving the row. */
function openLedgerRowDetail(r){
  const overlay = document.getElementById('detailOverlay');
  const modal = overlay.querySelector('.detail-modal');
  modal.classList.remove('wide');
  const host = document.getElementById('detailContent');
  const isRecv = r.kind === 'recv';
  const badge = isRecv ? recvBucket(r.due_date) : payUrgency(r.due_date);
  const badgeCls = badge.tag === 'bad' ? 'bad' : badge.tag === 'ok' ? 'ok' : badge.tag ? 'warn' : '';
  const srcMeta = (LEDGER_SOURCE_META[r.source] || { label: r.source });
  const history = (ledgerEvents || []).filter(e => r.raw && e.entity_id === r.raw.id);
  host.innerHTML =
    '<div class="detail-eyebrow">' + (isRecv ? 'Receivable' : 'Payable') + '</div>' +
    '<div class="detail-title">' + escapeHtml(r.party || 'Unnamed') + '</div>' +
    '<div class="detail-score-row" style="align-items:baseline;">' +
      '<div class="detail-score-num" style="color:var(--text-0); font-size:26px;">' + inr(r.amount) + '</div>' +
      (badge.label ? '<span class="lt-pill ' + badgeCls + '" style="margin-left:12px;">' + badge.label + '</span>' : '') +
    '</div>' +
    '<div class="detail-body" style="margin-bottom:4px;">Due ' + (r.due_date ? fmtDay(r.due_date) : 'no date') +
      ' &nbsp;·&nbsp; Source: <span class="source-badge">' + escapeHtml(srcMeta.label || r.source || 'manual') + '</span>' +
      (r.ref ? ' &nbsp;·&nbsp; Ref ' + escapeHtml(r.ref) : '') + '</div>' +
    '<div class="ledger-list-title">History</div>' +
    (history.length
      ? '<div class="rd-timeline">' + history.map(e =>
          '<div class="rd-tl"><div class="t">' + escapeHtml((e.event || 'updated').replace(/^\w/, c => c.toUpperCase())) + (e.note ? ' — ' + escapeHtml(e.note) : '') + '</div>' +
          '<div class="m">' + (e.created_at ? fmtDate(e.created_at) : '') + '</div></div>'
        ).join('') + '</div>'
      : '<div class="hint">No recorded events for this entry yet.</div>') +
    (r.editable ? '<div class="btn-row" style="margin-top:18px;">' +
      '<button class="btn-primary" id="ldrSettle">' + (isRecv ? 'Mark received' : 'Mark paid') + '</button>' +
      '<button class="btn-ghost" id="ldrDelete">Delete</button></div>' : '');
  overlay.classList.remove('hidden');
  const settleBtn = document.getElementById('ldrSettle');
  if(settleBtn) settleBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
    isRecv ? ledgerSettleReceivable(r.raw) : ledgerSettlePayable(r.raw);
  });
  const delBtn = document.getElementById('ldrDelete');
  if(delBtn) delBtn.addEventListener('click', async () => {
    if(!(await mgConfirm({ title:'Delete this entry?', body:'It is removed from your ledger and your figures are recalculated. The deletion stays in the activity log.',
        effect:[[isRecv ? 'Customer' : 'Vendor', r.raw.party_name || '—'], ['Amount', inr(r.raw.amount)]], confirmLabel:'Delete entry', danger:true }))) return;
    overlay.classList.add('hidden');
    isRecv ? ledgerRemoveReceivable(r.raw) : ledgerRemovePayable(r.raw);
  });
}
/* Read-only row detail for Books/Tally lists (bills, vouchers, ledger
   balances) — same shared modal as openLedgerRowDetail, so clicking a row
   anywhere in the app behaves the same way. Books rows have no settle/delete
   actions (they're Signal, not an editable ledger — see the Books vs Ledger
   note in the page's own copy), so this is read-only by design, not a gap. */
function openTallyRowDetail(kind, title, amount, fields){
  const overlay = document.getElementById('detailOverlay');
  const modal = overlay.querySelector('.detail-modal');
  modal.classList.remove('wide');
  const host = document.getElementById('detailContent');
  const rows = (fields || []).filter(Boolean);
  host.innerHTML =
    '<div class="detail-eyebrow">' + escapeHtml(kind) + ' <span class="lr-tag ok" style="margin-left:4px;">Signal</span></div>' +
    '<div class="detail-title">' + escapeHtml(title) + '</div>' +
    (amount != null ? '<div class="detail-score-row"><div class="detail-score-num" style="color:var(--text-0); font-size:26px;">' + inr(amount) + '</div></div>' : '') +
    (rows.length ? '<div class="ledger-list-title">Details</div><div class="kv-list">' +
      rows.map(([k, v]) => '<div class="kv"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(String(v)) + '</span></div>').join('') +
    '</div>' : '') +
    '<div class="hint" style="margin-top:16px;">From your TallyPrime books, pulled by the desktop agent. Read-only here — edit it in Tally, the next sync picks it up.</div>';
  overlay.classList.remove('hidden');
}
let ledgerAddOpen = false;
document.querySelectorAll('#ledgerTabs .tab').forEach(t => t.addEventListener('click', () => { ledgerActiveTab = t.dataset.ltab; renderLedgerView(); }));
(function wireLedgerAdd(){
  const b = document.getElementById('ledgerAddToggle'); if(!b) return;
  b.addEventListener('click', () => {
    if(ledgerActiveTab === 'cash'){ ledgerActiveTab = 'receivables'; }
    ledgerAddOpen = !ledgerAddOpen;
    renderLedgerView();
    if(ledgerAddOpen){ const f = document.getElementById('ledgerParty'); if(f) setTimeout(() => f.focus(), 60); }
  });
})();
document.getElementById('ledgerSourceFilter').addEventListener('change', (e) => { ledgerSourceFilter = e.target.value; renderLedgerView(); });
document.getElementById('ledgerAddBtn').addEventListener('click', async () => {
  const party = document.getElementById('ledgerParty').value.trim();
  const amt = Number(document.getElementById('ledgerAmt').value);
  const due = document.getElementById('ledgerDue').value || null;
  if(!party || !amt) return;
  try {
    const table = ledgerActiveTab === 'payables' ? 'payables' : 'receivables';
    const { error } = await sbClient.from(table).insert({ user_id:currentUser.id, party_name:party, amount:amt, due_date:due, status:'open', source:'manual' });
    if(error) throw error;
    await logLedgerEvent({ entityType: table === 'payables' ? 'payable' : 'receivable', event:'created', partyName:party, amount:amt, source:'manual' });
    receivables = await loadReceivables(); payables = await loadPayables();
    await saveLedgerSnapshot();
    document.getElementById('ledgerParty').value = ''; document.getElementById('ledgerAmt').value = ''; document.getElementById('ledgerDue').value = '';
    ledgerAddOpen = false;
    renderLedgerView();
    toast((ledgerActiveTab === 'payables' ? 'Payable' : 'Receivable') + ' added', { sub: party + ' \u00b7 ' + inr(amt) });
  } catch(err){ toast('Could not add: ' + (err.message||'unknown error'), {kind:'bad'}); }
});
async function ledgerSettleReceivable(r){
  try { const { error } = await sbClient.from('receivables').update({ status:'settled', settled_at:new Date().toISOString(), settled_amount:r.amount, settled_kind:'received' }).eq('id', r.id); if(error) throw error;
    await logLedgerEvent({ entityType:'receivable', entityId:r.id, event:'settled', partyName:r.party_name, amount:r.amount, source:r.source||'manual', note:'marked received' });
    receivables = await loadReceivables(); await saveLedgerSnapshot(); renderLedgerView();
    toast('Marked received', { sub: (r.party_name || '') + ' \u00b7 ' + inr(r.amount) });
  } catch(err){ toast('Could not mark as received: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
async function ledgerRemoveReceivable(r){
  try { await logLedgerEvent({ entityType:'receivable', entityId:r.id, event:'deleted', partyName:r.party_name, amount:r.amount, source:r.source||'manual' });
    const { error } = await sbClient.from('receivables').delete().eq('id', r.id); if(error) throw error;
    receivables = await loadReceivables(); await saveLedgerSnapshot(); renderLedgerView();
  } catch(err){ toast('Could not delete: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
async function ledgerSettlePayable(p){
  try { const { error } = await sbClient.from('payables').update({ status:'settled', settled_at:new Date().toISOString(), settled_amount:p.amount, settled_kind:'paid' }).eq('id', p.id); if(error) throw error;
    await logLedgerEvent({ entityType:'payable', entityId:p.id, event:'settled', partyName:p.party_name, amount:p.amount, source:p.source||'manual', note:'marked paid' });
    payables = await loadPayables(); await saveLedgerSnapshot(); renderLedgerView();
    toast('Marked paid', { sub: (p.party_name || '') + ' \u00b7 ' + inr(p.amount) });
  } catch(err){ toast('Could not mark as paid: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
async function ledgerRemovePayable(p){
  try { await logLedgerEvent({ entityType:'payable', entityId:p.id, event:'deleted', partyName:p.party_name, amount:p.amount, source:p.source||'manual' });
    const { error } = await sbClient.from('payables').delete().eq('id', p.id); if(error) throw error;
    payables = await loadPayables(); await saveLedgerSnapshot(); renderLedgerView();
  } catch(err){ toast('Could not delete: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
