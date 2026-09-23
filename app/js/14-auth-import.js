/* ============================================================
   AUTH — tab switching, login/signup, Google OAuth, logout
   ============================================================ */
document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.getElementById(t.dataset.form + 'Form').classList.add('active');
  clearAuthErrors();
}));
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginSubmit'); clearAuthErrors(); btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const { error } = await sbClient.auth.signInWithPassword({ email: document.getElementById('loginEmail').value.trim(), password: document.getElementById('loginPassword').value });
    if(error) throw error;
  } catch(err){ showAuthError(err.message || 'Could not log in.'); }
  finally { btn.disabled = false; btn.textContent = 'Log in'; }
});
document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('signupSubmit'); clearAuthErrors(); btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const { error } = await sbClient.auth.signUp({ email: document.getElementById('signupEmail').value.trim(), password: document.getElementById('signupPassword').value });
    if(error) throw error;
  } catch(err){ showAuthError(err.message || 'Could not sign up.'); }
  finally { btn.disabled = false; btn.textContent = 'Create account'; }
});
document.getElementById('googleAuthBtn').addEventListener('click', async () => {
  const btn = document.getElementById('googleAuthBtn'); btn.disabled = true;
  try {
    const { error } = await sbClient.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin + window.location.pathname } });
    if(error) throw error;
  } catch(err){ showAuthError(err.message || 'Could not sign in with Google.'); btn.disabled = false; }
});
document.getElementById('logoutBtn').addEventListener('click', async () => { await sbClient.auth.signOut(); });
/* ============================================================
   ENTRY TABS — Upload vs Manual
   ============================================================ */
document.querySelectorAll('.tabs .tab[data-tab]').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tabs .tab[data-tab]').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + t.dataset.tab));
  if(t.dataset.tab === 'manual') prefillManualEntry();
}));
/**
 * Quick manual entry used to open blank every time. computeFromManual()
 * reads every field with `Number(x) || 0`, so any field left empty on a
 * resubmit — a correction to just one number, a stray click, whatever —
 * silently wrote 0 for cash / revenue / margin / receivables and got saved
 * as the new latest snapshot, wiping the Summary dashboard back to ₹0
 * even though nothing was actually deleted (the real history is still
 * sitting in `snapshots`, just shadowed under the new zero row).
 * saveLedgerSnapshot() already avoids this by carrying the previous
 * snapshot's values forward; this does the equivalent by pre-filling the
 * form so leaving a field untouched resubmits the real prior value instead
 * of a silent zero. Only pre-fills empty inputs, so it never clobbers
 * something the user is actively mid-typing.
 */
function prefillManualEntry(){
  if(!snapshots.length) return;
  const s = snapshots[0];
  const fill = (id, val) => {
    const el = document.getElementById(id);
    if(el && !el.value && val !== null && val !== undefined) el.value = val;
  };
  fill('m-cash', s.cash);
  fill('m-burn', s.burn);
  fill('m-rev', s.revenue);
  fill('m-profit', s.net_profit);
  fill('m-gstpay', s.gst_payable);
  fill('m-gst', s.gst_leak);
  // Only prefill the payments block from a prior *manual* entry — a
  // razorpay_live payments_data row has a different shape and is already
  // carried forward automatically by computeFromManual's own source-
  // priority check when these fields are left blank.
  if(s.payments_source === 'manual' && s.payments_data){
    const p = s.payments_data;
    fill('m-pay-gross', p.gross);
    fill('m-pay-mdr', p.mdr);
    fill('m-pay-failed', p.failed);
    fill('m-pay-total', p.total);
    fill('m-pay-lag', p.lag);
    fill('m-pay-upi', p.upiPct);
  }
}
/* ============================================================
   FILE UPLOAD — dropzone, parsing, sheet-to-rows
   ============================================================ */
let uploadedWorkbook = null;
let uploadedDoc = null;               // { mime, base64, filename } for a PDF/image
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--emerald-bright)'; });
dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = ''; });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.style.borderColor = '';
  if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if(fileInput.files.length) handleFile(fileInput.files[0]); });
function importFileKind(name){
  const n = (name || '').toLowerCase();
  if(n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) return 'workbook';
  if(n.endsWith('.pdf')) return 'pdf';
  if(n.endsWith('.png')) return 'png';
  if(n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'jpg';
  return 'other';
}
function handleFile(file){
  const nameEl = document.getElementById('fileName');
  uploadedWorkbook = null; uploadedDoc = null;
  document.getElementById('computeFromFile').disabled = true;
  document.getElementById('aiParseBtn').disabled = true;
  document.getElementById('noteAiParse').textContent = '';
  document.getElementById('aiReview').classList.add('hidden');

  const kind = importFileKind(file.name);
  if(kind === 'other'){ nameEl.textContent = 'Unsupported file — use .xlsx, .csv, .pdf, .png or .jpg'; return; }
  if(file.size > MAX_IMPORT_BYTES){ nameEl.textContent = 'That file is over 2 MB — trim or split it for now.'; return; }

  const reader = new FileReader();
  if(kind === 'workbook'){
    nameEl.textContent = 'Reading ' + file.name + '…';
    reader.onload = (e) => {
      try {
        uploadedWorkbook = XLSX.read(new Uint8Array(e.target.result), { type:'array', cellDates:true });
        nameEl.textContent = '✓ ' + file.name;
        document.getElementById('computeFromFile').disabled = false;
        document.getElementById('aiParseBtn').disabled = false;
      } catch(err){ nameEl.textContent = 'Could not read file: ' + err.message; uploadedWorkbook = null; }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const mime = kind === 'pdf' ? 'application/pdf' : (kind === 'png' ? 'image/png' : 'image/jpeg');
    nameEl.textContent = 'Loading ' + file.name + '…';
    reader.onload = (e) => {
      uploadedDoc = { mime, base64: String(e.target.result).split(',')[1] || '', filename: file.name };
      nameEl.textContent = '✓ ' + file.name;
      document.getElementById('aiParseBtn').disabled = false;
    };
    reader.readAsDataURL(file);
  }
}
/* Compact "skeleton" of a workbook — first rows of each sheet as raw
   arrays — small enough to send to the parser without shipping the whole
   file or blowing the request-body limit. */
function buildWorkbookSkeleton(wb){
  const out = {};
  (wb.SheetNames || []).slice(0, 12).forEach(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:null, blankrows:false });
    out[name] = rows.slice(0, 25).map(r => (r || []).slice(0, 20));
  });
  return JSON.stringify(out);
}
function impEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const IMPORT_TARGET_LABELS = {
  cash:'Cash in bank', revenue:'Monthly revenue', net_profit:'Net profit', burn:'Operating expenses',
  gst_payable:'GST payable', gst_leak:'Unclaimed GST ITC', receivable:'Receivable', payable:'Payable',
  payments:'Gross payments processed'
};
let _importProposal = null;

document.getElementById('aiParseBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiParseBtn'); const note = document.getElementById('noteAiParse');
  if(!uploadedWorkbook && !uploadedDoc){ note.className = 'note bad'; note.textContent = 'No file loaded.'; return; }
  btn.disabled = true; note.className = 'note'; note.textContent = 'Margyn is reading the file…';
  document.getElementById('aiReview').classList.add('hidden');
  try {
    const { data:{ session } } = await sbClient.auth.getSession();
    const token = session && session.access_token;
    if(!token){ note.className = 'note bad'; note.textContent = 'Session expired — sign in again.'; btn.disabled = false; return; }
    const biz = {
      business: (currentProfile && currentProfile.company_name) || '',
      gstin: (currentProfile && currentProfile.gst_number) || ''
    };
    const payload = uploadedWorkbook
      ? { kind:'workbook', skeleton: buildWorkbookSkeleton(uploadedWorkbook), ...biz }
      : { kind:'document', mime: uploadedDoc.mime, base64: uploadedDoc.base64, filename: uploadedDoc.filename, ...biz };
    const res = await fetch('/api/generate-findings?action=parse-import', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
      body: JSON.stringify(payload)
    });
    if(!res.ok){ const t = await res.json().catch(() => ({})); throw new Error(t.error || ('Request failed: ' + res.status)); }
    const { proposal } = await res.json();
    renderImportReview(proposal);
    note.textContent = '';
  } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not read the file.'; }
  finally { btn.disabled = false; }
});

function renderImportReview(proposal){
  _importProposal = proposal || { entries:[], anomalies:[], unmapped:[] };
  const host = document.getElementById('aiReview');
  const entries = _importProposal.entries || [];
  const anomalies = _importProposal.anomalies || [];
  const unmapped = _importProposal.unmapped || [];
  if(!entries.length && !anomalies.length){
    host.innerHTML = '<div class="card"><h2>Nothing to import</h2><div class="hint">Margyn couldn’t find figures it recognises in this file.</div></div>';
    host.classList.remove('hidden'); return;
  }
  let h = '<div class="card"><h2>Review what Margyn found</h2>'
    + '<div class="hint">Untick anything that’s wrong. Nothing is saved until you press Confirm.</div>'
    + '<div style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">';
  entries.forEach((e, i) => {
    const low = (e.confidence || 0) < 0.6;
    h += '<label style="display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--border-1); border-radius:10px; cursor:pointer;">'
      + '<input type="checkbox" data-imp="' + i + '"' + (low ? '' : ' checked') + ' style="margin-top:3px; flex-shrink:0;">'
      + '<span style="flex:1; font-size:13px; line-height:1.5;">'
      + '<strong>' + impEsc(IMPORT_TARGET_LABELS[e.target] || e.target) + '</strong>'
      + (e.party ? ' · ' + impEsc(e.party) : '')
      + ' · <span class="mono">' + inr(e.amount) + '</span>'
      + (e.due_date ? ' · due ' + impEsc(e.due_date) : '')
      + (low ? ' <span style="color:var(--orange); font-weight:600;">· low confidence, check this</span>' : '')
      + (e.reasoning ? '<br><span style="color:var(--text-3);">' + impEsc(e.reasoning) + '</span>' : '')
      + '</span></label>';
  });
  h += '</div>';
  if(anomalies.length){
    h += '<div style="margin-top:16px;"><div class="app-eyebrow" style="color:var(--orange);">Flagged — not imported</div>'
      + '<ul style="margin:8px 0 0; padding-left:18px; font-size:13px; color:var(--text-2); line-height:1.6;">';
    anomalies.forEach(a => { h += '<li>' + impEsc(a.issue) + (a.severity === 'high' ? ' <strong>(check carefully)</strong>' : '') + '</li>'; });
    h += '</ul></div>';
  }
  if(unmapped.length){
    h += '<div style="margin-top:12px; font-size:12px; color:var(--text-3);">Ignored: ' + unmapped.map(impEsc).join(', ') + '</div>';
  }
  h += '<div class="btn-row" style="margin-top:18px;"><button class="primary" id="confirmImportBtn">Confirm import</button>'
    + '<span class="note" id="noteConfirmImport"></span></div></div>';
  host.innerHTML = h;
  host.classList.remove('hidden');
  document.getElementById('confirmImportBtn').addEventListener('click', applyImportProposal);
}

async function applyImportProposal(){
  const btn = document.getElementById('confirmImportBtn'); const note = document.getElementById('noteConfirmImport');
  btn.disabled = true; note.className = 'note'; note.textContent = 'Saving…';
  try {
    const chosen = [];
    document.querySelectorAll('#aiReview input[data-imp]').forEach(cb => {
      if(cb.checked) chosen.push(_importProposal.entries[Number(cb.dataset.imp)]);
    });
    if(!chosen.length){ note.className = 'note bad'; note.textContent = 'Nothing ticked.'; btn.disabled = false; return; }
    await applyChosenImportEntries(chosen);
    note.className = 'note ok'; note.textContent = 'Saved.';
    triggerFindingsGeneration();
    showView('summary');
  } catch(err){ note.className = 'note bad'; note.textContent = 'Could not save: ' + (err.message || 'unknown error'); btn.disabled = false; }
}
/* Shared write path for an accepted list of import entries — used by BOTH
   the Upload-tab review card (applyImportProposal, above) and the
   Suggestions tab (decideSuggestion, below — WhatsApp-sourced proposals).
   Same source:'upload' delete-then-insert + ledger_events + snapshot save
   as computeFromFile(); the two callers differ only in what they do with
   the button/note DOM and whether they navigate away afterward. */
async function applyChosenImportEntries(chosen){
    const latest = snapshots[0] || {};
    const scalars = {
      cash: Number(latest.cash) || 0, revenue: Number(latest.revenue) || 0,
      netProfit: Number(latest.net_profit) || 0, burn: Number(latest.burn) || 1,
      gstPayable: Number(latest.gst_payable) || 0, gstLeak: Number(latest.gst_leak) || 0
    };
    const scalarKey = { revenue:'revenue', net_profit:'netProfit', burn:'burn', gst_payable:'gstPayable', gst_leak:'gstLeak' };
    const recvRows = [], payRows = [];
    let payGross = 0, cashSeen = false, cashSum = 0;
    chosen.forEach(e => {
      if(e.target === 'cash'){ cashSeen = true; cashSum += e.amount; }   // multiple bank accounts → sum, don't overwrite
      else if(scalarKey[e.target]){ scalars[scalarKey[e.target]] = e.amount; }
      else if(e.target === 'receivable'){ recvRows.push({ user_id: currentUser.id, party_name: e.party || e.label || 'Unknown', amount: e.amount, due_date: e.due_date || null, status:'open', source:'upload' }); }
      else if(e.target === 'payable'){ payRows.push({ user_id: currentUser.id, party_name: e.party || e.label || 'Unknown', amount: e.amount, due_date: e.due_date || null, status:'open', source:'upload' }); }
      else if(e.target === 'payments'){ payGross += e.amount; }
    });
    if(cashSeen) scalars.cash = cashSum;

    if(recvRows.length){
      await sbClient.from('receivables').delete().eq('user_id', currentUser.id).eq('status','open').eq('source','upload');
      await sbClient.from('receivables').insert(recvRows);
      await logLedgerEvent({ entityType:'receivable', event:'imported', source:'upload', note: recvRows.length + ' receivable(s) from AI file import' });
    }
    if(payRows.length){
      await sbClient.from('payables').delete().eq('user_id', currentUser.id).eq('status','open').eq('source','upload');
      await sbClient.from('payables').insert(payRows);
      await logLedgerEvent({ entityType:'payable', event:'imported', source:'upload', note: payRows.length + ' payable(s) from AI file import' });
    }
    receivables = await loadReceivables(); payables = await loadPayables();
    const { recvTotal, recv90, paySoon } = ledgerAggregates();

    // Payments-tab source priority — mirror computeFromFile(): a figure in
    // this import is a deliberate manual override; otherwise carry a live
    // Razorpay block forward rather than blanking the tab.
    let paymentsPayload = null, paymentsSource = null, settleRowsPayload = null, settleTrendPayload = null;
    if(payGross > 0){
      paymentsPayload = { gross: payGross, mdr: 0, failed: 0, total: 0, lag: 2, upiPct: 55 };
      paymentsSource = 'manual';
    } else if(razorpayConnected && snapshots.length && snapshots[0].payments_source === 'razorpay_live'){
      paymentsPayload = snapshots[0].payments_data;
      settleRowsPayload = snapshots[0].settlement_rows;
      settleTrendPayload = snapshots[0].settlement_daily_trend;
      paymentsSource = 'razorpay_live';
    }

    await saveSnapshot({
      cash: scalars.cash, revenue: scalars.revenue, netProfit: scalars.netProfit, burn: scalars.burn,
      gstLeak: scalars.gstLeak, gstPayable: scalars.gstPayable,
      recvTotal, recv90, paySoon,
      paymentsData: paymentsPayload, paymentsSource, settlementRows: settleRowsPayload, settlementDailyTrend: settleTrendPayload,
      shopifyOrdersData: (snapshots[0] && snapshots[0].shopify_orders_data) || null,
      source:'upload'
    });
    snapshots = await loadSnapshots();
    paymentsData = paymentsPayload; settlementRows = settleRowsPayload; settlementDailyTrend = settleTrendPayload;
    renderScores(); renderPayments(); renderFinancing(); renderSummary();
}
/* ============================================================
   SUGGESTIONS — the WhatsApp-forwarded-file review queue.
   A number forwards an invoice/bill/receipt to the Margyn WhatsApp
   number; api/whatsapp.js matches it to this account by whatsapp_phone,
   runs the same importMapper used by the Upload tab, and parks the
   result here as a `import_suggestions` row (status:'pending'). Nothing
   from WhatsApp is ever written straight to the ledger — this queue is
   the only door in, and every row's status transition (approved/rejected
   + decided_at) IS the permanent log, nothing here is ever deleted.
   ============================================================ */
let pendingSuggestions = [];
async function loadPendingSuggestions(){
  try {
    const { data, error } = await sbClient.from('import_suggestions').select('*')
      .eq('user_id', currentUser.id).eq('status','pending').order('received_at', { ascending:false });
    if(error){ console.error('[margyn] loadPendingSuggestions:', error); return []; }
    return data || [];
  } catch(e){ console.error('[margyn] loadPendingSuggestions:', e); return []; }
}
/* Kept under its old name because several call sites fire it after an
   approve/reject; it now updates the single Agents badge. */
function renderSuggestionsBadge(){ renderAgentsBadge(); }
function renderSuggestionsView(){
  const host = document.getElementById('suggestionsList'); if(!host) return;
  const card = document.getElementById('agentSuggestCard');
  if(card) card.classList.toggle('hidden', !pendingSuggestions.length);
  if(!pendingSuggestions.length){ host.innerHTML = ''; return; }
  host.innerHTML = pendingSuggestions.map((s, idx) => renderOneSuggestionCard(s, idx)).join('');
  pendingSuggestions.forEach((s, idx) => {
    const approveBtn = document.getElementById('sugApprove' + idx);
    const rejectBtn = document.getElementById('sugReject' + idx);
    if(approveBtn) approveBtn.addEventListener('click', () => decideSuggestion(s, idx, 'approved'));
    if(rejectBtn) rejectBtn.addEventListener('click', () => decideSuggestion(s, idx, 'rejected'));
  });
}
function renderOneSuggestionCard(s, idx){
  const p = s.proposal || {}; const entries = p.entries || []; const anomalies = p.anomalies || [];
  const when = s.received_at ? new Date(s.received_at).toLocaleString('en-IN') : '';
  const fromLabel = s.from_phone ? waPrettyPhone(s.from_phone) : 'unknown number';
  let h = '<div class="card" style="margin-bottom:16px;">'
    + '<div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap;">'
    + '<h2 style="margin:0;">From WhatsApp · ' + impEsc(fromLabel) + '</h2>'
    + '<span style="font-family:\'IBM Plex Mono\',monospace; font-size:12px; letter-spacing:.04em; color:var(--text-3);">' + impEsc(when) + '</span></div>';
  if(!entries.length && !anomalies.length){
    h += '<div class="hint" style="margin-top:10px;">Nothing recognisable in this file.</div>';
  } else if(entries.length){
    h += '<div style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">';
    entries.forEach((e, i) => {
      const low = (e.confidence || 0) < 0.6;
      h += '<label style="display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--border-1); border-radius:10px; cursor:pointer;">'
        + '<input type="checkbox" data-sug-entry="' + idx + ':' + i + '"' + (low ? '' : ' checked') + ' style="margin-top:3px; flex-shrink:0;">'
        + '<span style="flex:1; font-size:13px; line-height:1.5;">'
        + '<strong>' + impEsc(IMPORT_TARGET_LABELS[e.target] || e.target) + '</strong>'
        + (e.party ? ' · ' + impEsc(e.party) : '') + ' · <span class="mono">' + inr(e.amount) + '</span>'
        + (e.due_date ? ' · due ' + impEsc(e.due_date) : '')
        + (low ? ' <span style="color:var(--orange); font-weight:600;">· low confidence, check this</span>' : '')
        + '</span></label>';
    });
    h += '</div>';
  }
  if(anomalies.length){
    h += '<div style="margin-top:14px;"><div class="app-eyebrow" style="color:var(--orange); margin-bottom:6px;">Flagged</div>'
      + '<ul style="margin:0; padding-left:18px; font-size:13px; color:var(--text-2); line-height:1.6;">'
      + anomalies.map(a => '<li>' + impEsc(a.issue) + '</li>').join('') + '</ul></div>';
  }
  h += '<div class="btn-row" style="margin-top:16px;">'
    + (entries.length ? '<button class="primary" id="sugApprove' + idx + '">Approve &amp; import</button>' : '')
    + '<button class="btn-ghost" id="sugReject' + idx + '">' + (entries.length ? 'Reject' : 'Dismiss') + '</button>'
    + '<span class="note" id="sugNote' + idx + '"></span></div></div>';
  return h;
}
async function decideSuggestion(sug, idx, decision){
  const note = document.getElementById('sugNote' + idx);
  const approveBtn = document.getElementById('sugApprove' + idx); const rejectBtn = document.getElementById('sugReject' + idx);
  if(approveBtn) approveBtn.disabled = true; if(rejectBtn) rejectBtn.disabled = true;
  if(note){ note.className = 'note'; note.textContent = decision === 'approved' ? 'Importing…' : 'Dismissing…'; }
  try {
    if(decision === 'approved'){
      const chosen = [];
      document.querySelectorAll('input[data-sug-entry^="' + idx + ':"]').forEach(cb => {
        if(cb.checked){
          const i = Number(cb.dataset.sugEntry.split(':')[1]);
          const entry = ((sug.proposal && sug.proposal.entries) || [])[i];
          if(entry) chosen.push(entry);
        }
      });
      if(chosen.length) await applyChosenImportEntries(chosen);
      triggerFindingsGeneration();
    }
    const { error } = await sbClient.from('import_suggestions')
      .update({ status: decision, decided_at: new Date().toISOString() }).eq('id', sug.id);
    if(error) throw error;
    pendingSuggestions = await loadPendingSuggestions();
    renderSuggestionsBadge();
    renderSuggestionsView();
    toast(decision === 'approved' ? 'Imported from WhatsApp' : 'Suggestion dismissed', {});
  } catch(err){
    if(note){ note.className = 'note bad'; note.textContent = 'Could not ' + (decision === 'approved' ? 'import' : 'dismiss') + ': ' + (err.message || 'unknown error'); }
    if(approveBtn) approveBtn.disabled = false; if(rejectBtn) rejectBtn.disabled = false;
  }
}
function sheetToRows(wb, sheetName){
  const sheet = wb.Sheets[sheetName];
  if(!sheet) return null;
  // The downloadable Margyn_Data_Template.xlsx puts a branding/title block
  // above the real header row on every sheet (blank row, "margyn" wordmark,
  // sheet title, blank row) — sheet_to_json defaults to row 1 as the
  // header, which swallowed those decorative cells as column names and
  // made every field lookup below come back empty/undefined no matter what
  // the user typed in. Scan for the row that actually looks like a header
  // (2+ populated cells — every title/instruction row in the template has
  // exactly one) and parse starting there instead.
  const raw = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null });
  let headerRow = raw.findIndex(row => row.filter(c => c !== null && c !== '').length >= 2);
  if(headerRow === -1) headerRow = 0;
  return XLSX.utils.sheet_to_json(sheet, { defval:null, range: headerRow });
}
function sumCol(rows, col){ return rows.reduce((s,r) => s + (Number(r[col]) || 0), 0); }
/**
 * P&L Summary in the template is a "Line Item" / "Amount" list — one row
 * per metric, e.g. {Line Item:'Revenue', Amount:600000} — not one row with
 * a column per metric. Look a value up by its line-item label first; fall
 * back to the columnar shape for any older/hand-built workbook that used
 * one row with a named column per metric.
 */
function pnlValue(rows, labels){
  for(const r of rows){
    const label = String(r['Line Item'] ?? r['line_item'] ?? '').trim().toLowerCase();
    if(labels.some(l => l.toLowerCase() === label)) return Number(r['Amount'] ?? r['amount'] ?? 0) || 0;
  }
  const row = rows[0] || {};
  for(const l of labels){ if(row[l] !== undefined && row[l] !== null && row[l] !== '') return Number(row[l]) || 0; }
  return 0;
}
function findSheetCI(wb, target){
  const names = wb.SheetNames;
  const exact = names.find(n => n.toLowerCase() === target.toLowerCase());
  if(exact) return exact;
  return names.find(n => n.toLowerCase().includes(target.toLowerCase().split(' ')[0]));
}
document.getElementById('computeFromFile').addEventListener('click', async () => {
  const btn = document.getElementById('computeFromFile'); const note = document.getElementById('noteUpload');
  const summaryBox = document.getElementById('importSummaryUpload');
  if(!uploadedWorkbook){ note.className = 'note bad'; note.textContent = 'No file loaded.'; return; }
  btn.disabled = true; note.className = 'note'; note.textContent = 'Computing…'; summaryBox.classList.add('hidden');
  try {
    const wb = uploadedWorkbook;
    const bankSheet = findSheetCI(wb, 'Bank Accounts');
    const recvSheet = findSheetCI(wb, 'Receivables');
    const paySheet = findSheetCI(wb, 'Payables');
    const pnlSheet = findSheetCI(wb, 'P&L Summary') || findSheetCI(wb, 'PnL Summary') || findSheetCI(wb, 'P&L');
    const gstSheet = findSheetCI(wb, 'GST ITC') || findSheetCI(wb, 'GST');
    const rzpSheet = findSheetCI(wb, 'Razorpay Settlements') || findSheetCI(wb, 'Razorpay');
    const shopSheet = findSheetCI(wb, 'Shopify Orders') || findSheetCI(wb, 'Shopify');

    const bankRows = bankSheet ? sheetToRows(wb, bankSheet) : [];
    const recvRows = recvSheet ? sheetToRows(wb, recvSheet) : [];
    const payRows = paySheet ? sheetToRows(wb, paySheet) : [];
    const pnlRows = pnlSheet ? sheetToRows(wb, pnlSheet) : [];
    const gstRows = gstSheet ? sheetToRows(wb, gstSheet) : [];
    const rzpRows = rzpSheet ? sheetToRows(wb, rzpSheet) : [];
    const shopRows = shopSheet ? sheetToRows(wb, shopSheet) : [];

    const cash = sumCol(bankRows, 'Balance') || sumCol(bankRows, 'Balance (₹)') || sumCol(bankRows, 'balance');
    const revenue = pnlValue(pnlRows, ['Revenue', 'Monthly Revenue']);
    const netProfit = pnlValue(pnlRows, ['Net Profit']);
    const burn = pnlValue(pnlRows, ['Operating Expenses', 'Monthly Operating Expenses']) || 1;
    // GST Payable lives on the GST ITC sheet (one row per month), not P&L —
    // sum across months. gstLeak = unclaimed ITC = ITC Available - ITC
    // Claimed per month, floored at 0 so an over-claimed month can't net
    // negative against a genuinely leaking one.
    const gstPayable = sumCol(gstRows, 'GST Payable') || pnlValue(pnlRows, ['GST Payable']);
    const gstLeak = gstRows.reduce((s, r) => {
      const available = Number(r['ITC Available'] ?? r['itc_available'] ?? 0);
      const claimed = Number(r['ITC Claimed'] ?? r['itc_claimed'] ?? 0);
      return s + Math.max(available - claimed, 0);
    }, 0) || sumCol(gstRows, 'Unclaimed ITC') || sumCol(gstRows, 'Unclaimed Amount');

    // Populate receivables/payables tables from the sheet. Replace only the
    // rows that came from a previous upload (source='upload') — never touch
    // items the user added by hand in the Quick Ledger (source='manual').
    if(recvRows.length){
      await sbClient.from('receivables').delete().eq('user_id', currentUser.id).eq('status','open').eq('source','upload');
      // Template columns are Customer / Amount / Amount Received — the open
      // balance is Amount minus Amount Received, per the sheet's own
      // instruction row. 'Party Name' is kept as a fallback for any
      // hand-built workbook using the older columnar naming.
      const rows = recvRows
        .filter(r => r['Customer'] || r['Party Name'] || r['party_name'])
        .map(r => {
          const amt = Number(r['Amount'] ?? r['amount'] ?? 0);
          const received = Number(r['Amount Received'] ?? r['amount_received'] ?? 0);
          return {
            user_id: currentUser.id,
            party_name: r['Customer'] || r['Party Name'] || r['party_name'] || 'Unknown',
            amount: amt - received,
            due_date: r['Due Date'] || r['due_date'] || null,
            status: 'open',
            source: 'upload'
          };
        })
        .filter(r => r.amount > 0);
      if(rows.length){ await sbClient.from('receivables').insert(rows); await logLedgerEvent({ entityType:'receivable', event:'imported', source:'upload', note: rows.length + ' receivable(s) from workbook upload' }); }
    }
    if(payRows.length){
      await sbClient.from('payables').delete().eq('user_id', currentUser.id).eq('status','open').eq('source','upload');
      // Template column is Vendor, not Party Name.
      const rows = payRows
        .filter(r => r['Vendor'] || r['Party Name'] || r['party_name'])
        .map(r => ({
          user_id: currentUser.id,
          party_name: r['Vendor'] || r['Party Name'] || r['party_name'] || 'Unknown',
          amount: Number(r['Amount'] ?? r['amount'] ?? 0),
          due_date: r['Due Date'] || r['due_date'] || null,
          status: 'open',
          source: 'upload'
        }))
        .filter(r => r.amount > 0);
      if(rows.length){ await sbClient.from('payables').insert(rows); await logLedgerEvent({ entityType:'payable', event:'imported', source:'upload', note: rows.length + ' payable(s) from workbook upload' }); }
    }
    receivables = await loadReceivables(); payables = await loadPayables();
    const { recvTotal, recv90, paySoon } = ledgerAggregates();

    // Razorpay settlements sheet → Payments tab
    let paymentsPayload = null, settleRowsPayload = null, settleTrendPayload = null;
    if(rzpRows.length){
      const gross = sumCol(rzpRows, 'Gross Amount') || sumCol(rzpRows, 'Amount') || sumCol(rzpRows, 'gross');
      const mdr = sumCol(rzpRows, 'Fees') || sumCol(rzpRows, 'MDR') || sumCol(rzpRows, 'fees');
      const failed = rzpRows.filter(r => (r['Status']||r['status']||'').toLowerCase() === 'failed').length;
      const total = rzpRows.length;
      paymentsPayload = { gross, mdr, failed, total, lag: Number(rzpRows[0]?.['Settlement Lag Days'] || 2), upiPct: Number(rzpRows[0]?.['UPI %'] || 55) };
      settleRowsPayload = rzpRows.slice(0, 20).map((r,i) => ({
        id: r['Settlement ID'] || r['settlement_id'] || ('BATCH-' + (i+1)),
        date: r['Date'] || r['date'] || null,
        gross: Number(r['Gross Amount'] || r['Amount'] || 0),
        net: Number(r['Net Amount'] || r['Amount'] || 0) - Number(r['Fees'] || 0),
        settled: (r['Status']||'').toLowerCase() === 'settled'
      }));
      const byDay = {};
      rzpRows.forEach(r => { const d = r['Date'] || r['date']; if(d){ byDay[d] = (byDay[d]||0) + Number(r['Gross Amount']||r['Amount']||0); } });
      const days = Object.keys(byDay).sort().slice(-7);
      if(days.length) settleTrendPayload = days.map(d => byDay[d]);
    }
    let shopifyPayload = null;
    if(shopRows.length){
      const totalOrders = shopRows.length;
      const totalValue = sumCol(shopRows, 'Total') || sumCol(shopRows, 'total') || sumCol(shopRows, 'Order Total');
      shopifyPayload = [
        { label:'Orders', value: totalOrders },
        { label:'Order value', value: Math.round(totalValue), isCurrency:true },
        { label:'Avg order value', value: Math.round(totalValue/(totalOrders||1)), isCurrency:true }
      ];
    }

    // Source priority: this upload didn't include a Razorpay Settlements
    // sheet, but Razorpay is connected and already has live-synced data on
    // the current snapshot — carry it forward rather than blanking the
    // Payments tab back to zero. If this upload DID include a settlements
    // sheet, that's a deliberate manual override and takes precedence.
    let paymentsSource = paymentsPayload ? 'manual' : null;
    if(!paymentsPayload && razorpayConnected && snapshots.length && snapshots[0].payments_source === 'razorpay_live'){
      paymentsPayload = snapshots[0].payments_data;
      settleRowsPayload = snapshots[0].settlement_rows;
      settleTrendPayload = snapshots[0].settlement_daily_trend;
      paymentsSource = 'razorpay_live';
    }

    await saveSnapshot({
      cash, revenue, netProfit, burn, gstLeak, gstPayable, recvTotal, recv90, paySoon,
      paymentsData: paymentsPayload, paymentsSource, settlementRows: settleRowsPayload, settlementDailyTrend: settleTrendPayload,
      shopifyOrdersData: shopifyPayload, source:'upload'
    });
    snapshots = await loadSnapshots();
    paymentsData = paymentsPayload; settlementRows = settleRowsPayload; settlementDailyTrend = settleTrendPayload; shopifyOrdersData = shopifyPayload;
    renderScores(); renderPayments(); renderFinancing(); renderSummary();

    const sheetsFound = [bankSheet, recvSheet, paySheet, pnlSheet, gstSheet, rzpSheet, shopSheet].filter(Boolean).length;
    summaryBox.innerHTML = '✓ Snapshot saved from ' + sheetsFound + ' sheet' + (sheetsFound===1?'':'s') + '. Cash: ' + inr(cash) + ', Revenue: ' + inr(revenue) + ', Receivables: ' + inr(recvTotal) + ', Payables due soon: ' + inr(paySoon) + '.';
    summaryBox.classList.remove('hidden');
    note.className = 'note ok'; note.textContent = 'Saved.';
    triggerFindingsGeneration();
    showView('summary');
  } catch(err){ note.className = 'note bad'; note.textContent = 'Could not compute: ' + (err.message||'unknown error'); }
  finally { btn.disabled = false; }
});
/* ============================================================
   MANUAL ENTRY
   ============================================================ */
document.getElementById('computeFromManual').addEventListener('click', async () => {
  const btn = document.getElementById('computeFromManual'); const note = document.getElementById('noteManual');
  btn.disabled = true; note.className = 'note'; note.textContent = 'Computing…';
  try {
    const cash = Number(document.getElementById('m-cash').value) || 0;
    const burn = Number(document.getElementById('m-burn').value) || 1;
    const revenue = Number(document.getElementById('m-rev').value) || 0;
    const netProfit = Number(document.getElementById('m-profit').value) || 0;
    const gstPayable = Number(document.getElementById('m-gstpay').value) || 0;
    const gstLeak = Number(document.getElementById('m-gst').value) || 0;
    const { recvTotal, recv90, paySoon } = ledgerAggregates();

    const payGross = Number(document.getElementById('m-pay-gross').value) || 0;
    const payMdr = Number(document.getElementById('m-pay-mdr').value) || 0;
    const payFailed = Number(document.getElementById('m-pay-failed').value) || 0;
    const payTotal = Number(document.getElementById('m-pay-total').value) || 0;
    const payLag = Number(document.getElementById('m-pay-lag').value) || 0;
    const payUpi = Number(document.getElementById('m-pay-upi').value) || 0;
    let paymentsPayload = payGross > 0 ? { gross:payGross, mdr:payMdr, failed:payFailed, total:payTotal, lag:payLag, upiPct:payUpi } : null;
    let settleRowsPayload = null, settleTrendPayload = null;

    // Source priority: this entry left the Payments fields blank, but
    // Razorpay is connected and already has live-synced data on the current
    // snapshot — carry it forward rather than blanking the Payments tab
    // back to zero. Typing Payments numbers here is a deliberate manual
    // override and takes precedence.
    let paymentsSource = paymentsPayload ? 'manual' : null;
    if(!paymentsPayload && razorpayConnected && snapshots.length && snapshots[0].payments_source === 'razorpay_live'){
      paymentsPayload = snapshots[0].payments_data;
      settleRowsPayload = snapshots[0].settlement_rows;
      settleTrendPayload = snapshots[0].settlement_daily_trend;
      paymentsSource = 'razorpay_live';
    }

    await saveSnapshot({ cash, revenue, netProfit, burn, gstLeak, gstPayable, recvTotal, recv90, paySoon, paymentsData: paymentsPayload, paymentsSource, settlementRows: settleRowsPayload, settlementDailyTrend: settleTrendPayload, source:'manual' });
    snapshots = await loadSnapshots();
    paymentsData = paymentsPayload; settlementRows = settleRowsPayload; settlementDailyTrend = settleTrendPayload;
    renderScores(); renderPayments(); renderFinancing(); renderSummary();
    note.className = 'note ok'; note.textContent = 'Saved.';
    triggerFindingsGeneration();
    showView('summary');
  } catch(err){ note.className = 'note bad'; note.textContent = 'Could not compute: ' + (err.message||'unknown error'); }
  finally { btn.disabled = false; }
});
