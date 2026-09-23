/* ============================================================
   RECONCILIATION — surface the nightly api/reconcile.js output.
   Read-only: the matching itself lives in api/_lib/reconcileMatcher.js.
   ============================================================ */
async function loadReconSummary(){
  try {
    return await zohoApi('/api/reconcile?action=summary');
  } catch(e){
    console.error('[margyn] loadReconSummary:', e.message);
    return null;
  }
}
/* Books tab: a "Payment matched" / "Needs review" tag per reconciled invoice. */
function renderReconBooksCard(){
  const card = document.getElementById('zvReconCard');
  const list = document.getElementById('zvReconList');
  if(!card || !list) return;
  const invs = (reconSummary && reconSummary.connected && reconSummary.invoices) || [];
  if(!invs.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.innerHTML =
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:150px"><col style="width:112px"></colgroup>' +
    '<thead><tr><th>Customer</th><th>Match</th><th class="num">Amount</th></tr></thead><tbody>' +
    invs.map(inv => {
      const verified = inv.reconciliation_status === 'verified';
      const tag = verified
        ? '<span class="lr-tag verified">✓ Matched to gateway</span>'
        : '<span class="lr-tag review">Needs review</span>';
      const amt = (verified && inv.verified_paid_amount != null) ? inv.verified_paid_amount : inv.total;
      return '<tr><td><div class="dt-main">' + escapeHtml(inv.customer_name || 'Unnamed customer') + '</div>' +
        '<div class="dt-sub">' + escapeHtml(inv.invoice_number || '—') + '</div></td>' +
        '<td>' + tag + '</td>' +
        '<td class="num">' + inr(amt) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}
/* Ledger tab: the pending_review queue + a nav badge so it isn't invisible. */
function renderReconLedger(){
  const queue = (reconSummary && reconSummary.connected && reconSummary.review_queue) || [];
  renderAgentsBadge();
  const card = document.getElementById('reconReviewCard');
  const list = document.getElementById('reconReviewList');
  const title = document.getElementById('reconReviewTitle');
  if(!card || !list) return;
  if(!queue.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  if(title) title.textContent = 'Payments needing review (' + queue.length + ')';
  list.innerHTML = queue.map((q, qi) => {
    const meta = [q.invoice_number ? 'Invoice ' + q.invoice_number : null, q.reason].filter(Boolean).join(' · ');
    const cands = Array.isArray(q.candidates) ? q.candidates : [];
    const picker = cands.length
      ? '<div class="recon-picker" style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">' +
        cands.map((c, ci) =>
          '<button class="lr-btn" data-recon-pick="' + qi + ':' + ci + '">' +
          inr((Number(c.amount)||0)/100) + ' on ' + (c.created_at ? fmtDay(c.created_at) : '—') +
          (c.method ? ' · ' + escapeHtml(c.method) : '') + ' — this is the one</button>'
        ).join('') +
        '</div>'
      : '';
    return '<div class="ledger-row" style="flex-wrap:wrap;"><div class="lr-main">' +
      '<div class="lr-party">' + escapeHtml(q.customer_name || 'Unknown customer') + '<span class="lr-tag review">Needs review</span></div>' +
      '<div class="lr-meta">' + escapeHtml(meta) + '</div>' + picker +
      '</div><div class="lr-amount">' + inr(q.amount) + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-recon-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [qi, ci] = btn.dataset.reconPick.split(':').map(Number);
      const q = queue[qi]; const c = (q.candidates || [])[ci];
      if(!q || !c) return;
      btn.disabled = true; btn.textContent = 'Confirming…';
      try {
        await zohoApi('/api/reconcile?action=resolve', { method:'POST', body: JSON.stringify({
          matchId: q.id, razorpayPaymentId: c.id, matchedAmount: q.amount
        })});
        mtrack('mismatch_resolved_marked', { via: 'candidate_pick' });
        reconSummary = await loadReconSummary();
        renderReconLedger();
        renderReconBooksCard();
      } catch(err){
        btn.disabled = false; btn.textContent = 'Try again';
        toast('Could not confirm: ' + (err.message || 'unknown error'), { kind:'bad' });
      }
    });
  });
}

/* ============================================================
   CLOSE & COLLECTIONS AGENT — the proposal queue.
   The agent (api/reconcile.js?action=run-agent, nightly) works the
   reconciliation exceptions and stages typed proposals. This surface
   is the human approval step: nothing is applied until Approve.
   ============================================================ */
const AGENT_KIND_LABEL = {
  reconcile_match: 'Match', journal: 'Journal', split: 'Split payment',
  flag: 'Flag', itc_risk: 'GST / ITC', bad_debt: 'Bad debt', needs_human: 'Review'
};
async function loadAgentActions(){
  try { return await zohoApi('/api/reconcile?action=agent-actions'); }
  catch(e){ console.error('[margyn] loadAgentActions:', e.message); return null; }
}
/* One number for everything an agent is waiting on: reconciliation
   exceptions + Close agent proposals + forwarded documents. Previously these
   three drove two different nav badges on two different pages. */
function agentQueueTotals(){
  const proposals = ((agentActions && agentActions.actions) || []).length;
  const recon = ((reconSummary && reconSummary.connected && reconSummary.review_queue) || []).length;
  const imports = (typeof pendingSuggestions !== 'undefined' ? pendingSuggestions.length : 0);
  return { proposals, recon, imports, total: proposals + recon + imports };
}
function renderAgentsBadge(){
  const { total } = agentQueueTotals();
  const badge = document.getElementById('agentsBadge');
  if(badge){
    badge.textContent = total ? String(total) : '';
    badge.classList.toggle('hidden', total === 0);
  }
  const seg = document.getElementById('agentQueueCount');
  if(seg){
    seg.textContent = total ? String(total) : '';
    seg.classList.toggle('hidden', total === 0);
  }
  const empty = document.getElementById('agentQueueEmpty');
  if(empty) empty.classList.toggle('hidden', total > 0);
  const asOf = document.getElementById('agentsAsOf');
  if(asOf) asOf.textContent = total ? (total + (total === 1 ? ' item waiting' : ' items waiting')) : 'Queue clear';
}
function renderAgentQueue(){
  const items = (agentActions && agentActions.actions) || [];
  renderAgentsBadge();
  const card = document.getElementById('agentQueueCard');
  const list = document.getElementById('agentQueueList');
  const title = document.getElementById('agentQueueTitle');
  if(!card || !list) return;
  if(!items.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  if(title) title.innerHTML = 'Close &amp; Collections proposals (' + items.length + ') <span class="tier-chip" style="margin-left:6px; background:rgba(230,126,34,.14); color:#c0621b;">BETA</span>';

  list.innerHTML = items.map((a) => {
    const kind = AGENT_KIND_LABEL[a.kind] || a.kind;
    const conf = a.confidence != null ? Math.round(a.confidence * 100) + '% sure' : '';
    const j = (a.proposal && a.proposal.journal) || null;
    const alloc = (a.proposal && a.proposal.allocations) || null;
    const draft = a.proposal && a.proposal.vendorQueryDraft;
    let detail = '';
    if(j && j.length){
      detail = '<div class="hint" style="margin-top:8px; white-space:pre-line; font-family:\'IBM Plex Mono\',monospace; font-size:11.5px;">' +
        j.map(l => escapeHtml(l.account) + '  ' + (l.debit ? 'Dr ' + inr(l.debit) : 'Cr ' + inr(l.credit))).join('\n') + '</div>';
    } else if(alloc && alloc.length){
      detail = '<div class="hint" style="margin-top:8px;">' +
        alloc.map(x => escapeHtml(x.invoiceRef || x.booksRef || '—') + ' → ' + inr(x.amount)).join('<br>') + '</div>';
    } else if(draft){
      detail = '<div class="hint" style="margin-top:8px; font-style:italic;">Draft to vendor: “' + escapeHtml(draft.slice(0, 220)) + '…”</div>';
    }
    return '<div class="ledger-row" style="flex-wrap:wrap; align-items:flex-start;" data-agent-id="' + a.id + '">' +
      '<div class="lr-main">' +
        '<div class="lr-party">' + escapeHtml(a.title) +
          '<span class="lr-tag review">' + escapeHtml(kind) + '</span>' +
          (conf ? '<span class="lr-tag" style="background:var(--surface-2); color:var(--text-3);">' + conf + '</span>' : '') +
        '</div>' +
        '<div class="lr-meta" style="max-width:80ch;">' + escapeHtml(a.rationale || '') + '</div>' +
        detail +
        '<div style="margin-top:10px; display:flex; gap:8px;">' +
          '<button class="btn-primary" style="padding:6px 14px; font-size:12px;" data-agent-do="approve">Approve</button>' +
          '<button class="lr-btn" data-agent-do="reject">Dismiss</button>' +
        '</div>' +
      '</div>' +
      (a.amount != null ? '<div class="lr-amount">' + inr(a.amount) + '</div>' : '') +
      '</div>';
  }).join('');

  list.querySelectorAll('[data-agent-do]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('[data-agent-id]');
      const id = row && row.dataset.agentId;
      const decision = btn.dataset.agentDo;
      if(!id) return;
      row.querySelectorAll('button').forEach(b => b.disabled = true);
      btn.textContent = decision === 'approve' ? 'Approving…' : 'Dismissing…';
      try {
        await zohoApi('/api/reconcile?action=agent-review', { method:'POST', body: JSON.stringify({ actionId: id, decision }) });
        mtrack('close_agent_review', { decision, kind: (agentActions.actions.find(x => x.id === id) || {}).kind });
        agentActions = await loadAgentActions();
        renderAgentQueue();
        if(decision === 'approve'){
          reconSummary = await loadReconSummary();
          renderReconLedger(); renderReconBooksCard();
          toast('Approved — recorded for your books.', { kind:'good' });
        }
      } catch(err){
        row.querySelectorAll('button').forEach(b => b.disabled = false);
        btn.textContent = decision === 'approve' ? 'Approve' : 'Dismiss';
        toast('Could not ' + decision + ': ' + (err.message || 'unknown error'), { kind:'bad' });
      }
    });
  });
}

