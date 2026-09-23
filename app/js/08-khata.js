/* ============================================================
   KHATA (NEW, FREE tier) — customers/vendors, running-balance
   ledger, ageing, GST invoicing. Deterministic math only, no AI.
   Mirrors the receivables/payables Supabase pattern above.
   ============================================================ */
async function loadKhataParties(){
  const { data, error } = await sbClient.from('ledger_parties').select('*').eq('user_id', currentUser.id).order('name', { ascending:true });
  if(error){ console.error('[margyn] loadKhataParties:', error); return []; }
  return data || [];
}
async function loadKhataEntries(){
  const { data, error } = await sbClient.from('ledger_entries').select('*').eq('user_id', currentUser.id).order('entry_date', { ascending:true });
  if(error){ console.error('[margyn] loadKhataEntries:', error); return []; }
  return data || [];
}
async function loadKhataInvoices(){
  const { data, error } = await sbClient.from('invoices').select('*, invoice_line_items(*)').eq('user_id', currentUser.id).order('issue_date', { ascending:false });
  if(error){ console.error('[margyn] loadKhataInvoices:', error); return []; }
  return data || [];
}
function khataEntriesForParty(partyId){ return khataEntries.filter(e => e.party_id === partyId).sort((a,b) => new Date(a.entry_date) - new Date(b.entry_date)); }
// sale/debit_note/purchase-inverse sign convention: sale & debit_note increase what's owed to us,
// receipt & credit_note reduce it. purchase increases what we owe, payment reduces it.
function entrySignedAmount(e){
  const amt = Number(e.amount) || 0;
  if(e.entry_type === 'sale' || e.entry_type === 'debit_note') return amt;
  if(e.entry_type === 'receipt' || e.entry_type === 'credit_note') return -amt;
  if(e.entry_type === 'purchase') return amt;
  if(e.entry_type === 'payment') return -amt;
  return amt;
}
function khataPartyBalance(partyId){
  const party = khataParties.find(p => p.id === partyId);
  const opening = party ? (Number(party.opening_balance) || 0) : 0;
  return khataEntriesForParty(partyId).reduce((s,e) => s + entrySignedAmount(e), opening);
}
function khataAgeingBuckets(partyId){
  const buckets = { current:0, d1_30:0, d31_60:0, d61_90:0, d90plus:0 };
  const today = new Date(new Date().toDateString());
  khataEntriesForParty(partyId).forEach(e => {
    if(e.entry_type !== 'sale' && e.entry_type !== 'purchase') return;
    const days = Math.round((today - new Date(e.entry_date)) / 86400000);
    const amt = Number(e.amount) || 0;
    if(days <= 0) buckets.current += amt;
    else if(days <= 30) buckets.d1_30 += amt;
    else if(days <= 60) buckets.d31_60 += amt;
    else if(days <= 90) buckets.d61_90 += amt;
    else buckets.d90plus += amt;
  });
  return buckets;
}
function khataInitials(name){ return String(name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase(); }
/* ---------- super tabs: Quick ledger vs Customers & Invoicing ---------- */
document.querySelectorAll('#ledgerSuperTabs .tab').forEach(t => t.addEventListener('click', () => {
  khataSuperTab = t.dataset.lsuper;
  document.querySelectorAll('#ledgerSuperTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.lsuper === khataSuperTab));
  document.getElementById('lsuper-quick').classList.toggle('active', khataSuperTab === 'quick');
  document.getElementById('lsuper-khata').classList.toggle('active', khataSuperTab === 'khata');
  if(khataSuperTab === 'khata') renderKhataParties();
}));
function showKhataTab(tab){
  khataTab = tab;
  document.querySelectorAll('#khataTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.ktab === tab));
  ['parties','party-detail','invoice-new','invoices','printing'].forEach(t => {
    const el = document.getElementById('khata-' + t); if(el) el.classList.toggle('active', t === tab);
  });
  if(tab === 'parties') renderKhataParties();
  if(tab === 'invoice-new') renderInvoiceForm();
  if(tab === 'invoices') renderKhataInvoiceList();
  if(tab === 'printing') renderPrintingTab();
}
document.querySelectorAll('#khataTabs .tab').forEach(t => t.addEventListener('click', () => showKhataTab(t.dataset.ktab)));
/* ---------- parties list ---------- */
function renderKhataParties(){
  const host = document.getElementById('khataPartyList'); if(!host) return;
  const q = (document.getElementById('khataSearch').value || '').toLowerCase();
  const filter = document.getElementById('khataFilter').value;
  let rows = khataParties.filter(p => {
    if(filter !== 'all' && p.type !== filter && p.type !== 'both') return false;
    if(!q) return true;
    return (p.name||'').toLowerCase().includes(q) || (p.phone||'').includes(q);
  });
  if(!rows.length){ host.innerHTML = '<div class="ledger-empty">No parties yet. Add your first customer or vendor above.</div>'; return; }
  host.innerHTML = '';
  rows.forEach(p => {
    const bal = khataPartyBalance(p.id);
    const isPayable = (p.type === 'vendor') || (p.type === 'both' && bal < 0);
    const row = document.createElement('div'); row.className = 'cust-row';
    const tags = p.type === 'both' ? '<span class="cust-tag customer">Customer</span><span class="cust-tag vendor">Vendor</span>' : '<span class="cust-tag ' + p.type + '">' + (p.type === 'customer' ? 'Customer' : 'Vendor') + '</span>';
    row.innerHTML =
      '<div class="cust-avatar">' + khataInitials(p.name) + '</div>' +
      '<div class="cust-main"><div class="cust-name">' + escapeHtml(p.name) + tags + '</div>' +
      '<div class="cust-meta">' + escapeHtml(p.phone||'no phone') + (p.gstin ? ' · ' + escapeHtml(p.gstin) : ' · no GSTIN') + '</div></div>' +
      '<div class="cust-balance"><div class="amt" style="color:' + (bal===0?'#0E8F5C':(isPayable?'#5B6472':'#B3432E')) + ';">' + inr(Math.abs(bal)) + '</div>' +
      '<div class="lbl">' + (bal===0?'settled':(isPayable?'payable':'receivable')) + '</div></div>';
    row.addEventListener('click', () => openKhataPartyDetail(p.id));
    host.appendChild(row);
  });
}
document.getElementById('khataSearch').addEventListener('input', renderKhataParties);
document.getElementById('khataFilter').addEventListener('change', renderKhataParties);
document.getElementById('khataAddPartyBtn').addEventListener('click', () => document.getElementById('khataPartyForm').classList.toggle('hidden'));
document.getElementById('khataSavePartyBtn').addEventListener('click', async () => {
  const name = document.getElementById('kpName').value.trim();
  if(!name){ return; }
  const row = {
    user_id: currentUser.id, name,
    phone: document.getElementById('kpPhone').value.trim() || null,
    email: document.getElementById('kpEmail').value.trim() || null,
    gstin: document.getElementById('kpGstin').value.trim().toUpperCase() || null,
    address: document.getElementById('kpAddress').value.trim() || null,
    opening_balance: Number(document.getElementById('kpOpening').value) || 0,
    type: document.getElementById('kpType').value
  };
  try {
    const { error } = await sbClient.from('ledger_parties').insert(row);
    if(error) throw error;
    khataParties = await loadKhataParties();
    ['kpName','kpPhone','kpEmail','kpGstin','kpAddress','kpOpening'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('khataPartyForm').classList.add('hidden');
    renderKhataParties(); populateInvoiceCustomerSelect(); populateReportPartySelect();
  } catch(err){ toast('Could not add party: ' + (err.message||'unknown error'), {kind:'bad'}); }
});
/* ---------- single party ledger detail ---------- */
function openKhataPartyDetail(partyId){
  khataActivePartyId = partyId;
  document.getElementById('khataPartyDetailTab').style.display = '';
  showKhataTab('party-detail');
  renderKhataPartyDetail();
}
function renderKhataPartyDetail(){
  const party = khataParties.find(p => p.id === khataActivePartyId); if(!party) return;
  const bal = khataPartyBalance(party.id);
  document.getElementById('kpdName').textContent = party.name;
  document.getElementById('kpdMeta').textContent = (party.type === 'both' ? 'Customer & vendor' : (party.type === 'customer' ? 'Customer' : 'Vendor')) + ' · ' + (party.phone || 'no phone') + (party.gstin ? ' · ' + party.gstin : '');
  const entries = khataEntriesForParty(party.id);
  const over90 = entries.filter(e => (e.entry_type==='sale') && Math.round((new Date(new Date().toDateString()) - new Date(e.entry_date))/86400000) > 90).reduce((s,e)=>s+Number(e.amount||0),0);
  document.getElementById('kpdFacts').innerHTML =
    '<div class="fact"><div class="f-label">Running balance</div><div class="f-value" style="color:'+(bal===0?'#0E8F5C':(bal>0?'#B3432E':'#5B6472'))+';">'+inr(Math.abs(bal))+'</div></div>' +
    '<div class="fact"><div class="f-label">Opening balance</div><div class="f-value">'+inr(party.opening_balance||0)+'</div></div>' +
    '<div class="fact"><div class="f-label">Over 90 days</div><div class="f-value" style="color:#B3432E;">'+inr(over90)+'</div></div>' +
    '<div class="fact"><div class="f-label">Last activity</div><div class="f-value" style="font-size:14px;">'+(entries.length?fmtDay(entries[entries.length-1].entry_date):'—')+'</div></div>';
  let running = Number(party.opening_balance) || 0;
  const body = document.getElementById('kpdTableBody'); body.innerHTML = '';
  if(!entries.length){ body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-2); padding:16px;">No entries yet.</td></tr>'; }
  entries.forEach(e => {
    running += entrySignedAmount(e);
    const tr = document.createElement('tr');
    const sign = entrySignedAmount(e) >= 0 ? '+' : '-';
    tr.innerHTML = '<td>'+fmtDay(e.entry_date)+'</td><td><span class="type-badge '+e.entry_type+'">'+e.entry_type.replace('_',' ')+'</span></td>' +
      '<td>'+escapeHtml(e.reference_number||'—')+'</td><td class="num">'+sign+inr(e.amount)+'</td><td class="num">'+inr(Math.abs(running))+'</td>';
    body.appendChild(tr);
  });
  const buckets = khataAgeingBuckets(party.id);
  const maxB = Math.max(buckets.current, buckets.d1_30, buckets.d31_60, buckets.d61_90, buckets.d90plus, 1);
  const rows = [['Current', buckets.current], ['1–30 days', buckets.d1_30], ['31–60 days', buckets.d31_60], ['61–90 days', buckets.d61_90], ['90+ days', buckets.d90plus]];
  document.getElementById('kpdAging').innerHTML = rows.map(r =>
    '<div class="aging-row"><span class="aging-label">'+r[0]+'</span><div class="aging-track"><div class="aging-fill" style="width:'+Math.max(2,(r[1]/maxB)*100)+'%;'+(r[0]==='90+ days'?'background:#B3432E;':'')+'"></div></div><span class="aging-val" style="'+(r[0]==='90+ days'?'color:#B3432E;':'')+'">'+inr(r[1])+'</span></div>'
  ).join('');
}
document.getElementById('kpdEntryBtn').addEventListener('click', () => {
  document.getElementById('keDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('kpdEntryForm').classList.toggle('hidden');
});
document.getElementById('keSaveBtn').addEventListener('click', async () => {
  const amount = Number(document.getElementById('keAmount').value);
  if(!amount){ return; }
  const row = {
    user_id: currentUser.id, party_id: khataActivePartyId,
    entry_type: document.getElementById('keType').value, amount,
    entry_date: document.getElementById('keDate').value || new Date().toISOString().slice(0,10),
    reference_number: document.getElementById('keRef').value.trim() || null,
    notes: document.getElementById('keNotes').value.trim() || null
  };
  try {
    const { error } = await sbClient.from('ledger_entries').insert(row);
    if(error) throw error;
    khataEntries = await loadKhataEntries();
    ['keAmount','keRef','keNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('kpdEntryForm').classList.add('hidden');
    renderKhataPartyDetail(); renderKhataParties();
  } catch(err){ toast('Could not add entry: ' + (err.message||'unknown error'), {kind:'bad'}); }
});
document.getElementById('kpdRemindBtn').addEventListener('click', () => {
  const party = khataParties.find(p => p.id === khataActivePartyId); if(!party) return;
  const bal = khataPartyBalance(party.id);
  const msg = 'Hi ' + party.name + ', a friendly reminder that ' + inr(Math.abs(bal)) + ' is outstanding on your account. Please let us know when we can expect payment. Thank you!';
  if(party.phone){
    const digits = party.phone.replace(/[^0-9]/g,'');
    window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg), '_blank');
  } else {
    navigator.clipboard && navigator.clipboard.writeText(msg);
    toast('No phone on file', { kind:'info', sub:'Reminder text copied to your clipboard instead.' });
  }
});
/* ---------- invoicing ---------- */
function populateInvoiceCustomerSelect(){
  const sel = document.getElementById('invCustomer'); if(!sel) return;
  const customers = khataParties.filter(p => p.type === 'customer' || p.type === 'both');
  sel.innerHTML = customers.length ? customers.map(p => '<option value="'+p.id+'">'+escapeHtml(p.name)+'</option>').join('') : '<option value="">Add a customer first</option>';
  const filt = document.getElementById('invFilterCustomer');
  if(filt) filt.innerHTML = '<option value="all">All customers</option>' + customers.map(p => '<option value="'+p.id+'">'+escapeHtml(p.name)+'</option>').join('');
}
function addInvoiceLine(){
  invoiceDraftLines.push({ description:'', hsn:'', qty:1, rate:0, gst:18 });
  renderInvoiceLines();
}
function renderInvoiceLines(){
  const host = document.getElementById('invLineItems'); if(!host) return;
  host.innerHTML = '';
  invoiceDraftLines.forEach((li, i) => {
    const row = document.createElement('div'); row.className = 'li-row';
    row.innerHTML =
      '<input type="text" data-f="description" placeholder="Description" value="'+escapeHtml(li.description)+'">' +
      '<input type="text" data-f="hsn" class="mono" placeholder="HSN/SAC" value="'+escapeHtml(li.hsn)+'">' +
      '<input type="number" data-f="qty" class="mono" value="'+li.qty+'">' +
      '<input type="number" data-f="rate" class="mono" value="'+li.rate+'">' +
      '<input type="number" data-f="gst" class="mono" value="'+li.gst+'">' +
      '<button class="li-del" type="button" aria-label="Remove line"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
      const f = inp.dataset.f; li[f] = (f==='description'||f==='hsn') ? inp.value : Number(inp.value)||0;
      renderInvoiceTotals();
    }));
    row.querySelector('.li-del').addEventListener('click', () => { invoiceDraftLines.splice(i,1); renderInvoiceLines(); renderInvoiceTotals(); });
    host.appendChild(row);
  });
  renderInvoiceTotals();
}
function isInterstateInvoice(customer){
  const bizGst = (currentProfile && currentProfile.gst_number) || '';
  const custGst = (customer && customer.gstin) || '';
  if(bizGst.length >= 2 && custGst.length >= 2) return bizGst.slice(0,2) !== custGst.slice(0,2);
  return false; // default to intra-state (CGST+SGST) when GSTIN is unknown on either side
}
function computeInvoiceTotals(){
  const custId = document.getElementById('invCustomer').value;
  const customer = khataParties.find(p => p.id === custId);
  const interstate = isInterstateInvoice(customer);
  let subtotal = 0, gstTotal = 0;
  invoiceDraftLines.forEach(li => {
    const line = (Number(li.qty)||0) * (Number(li.rate)||0);
    subtotal += line;
    gstTotal += line * ((Number(li.gst)||0)/100);
  });
  return { subtotal, gstTotal, cgst: interstate?0:gstTotal/2, sgst: interstate?0:gstTotal/2, igst: interstate?gstTotal:0, total: subtotal+gstTotal, interstate };
}
function renderInvoiceTotals(){
  const box = document.getElementById('invTotalsBox'); if(!box) return;
  const t = computeInvoiceTotals();
  box.innerHTML = t.interstate
    ? '<div class="tot-row"><span>Subtotal</span><span class="v">'+inr(t.subtotal)+'</span></div><div class="tot-row"><span>IGST</span><span class="v">'+inr(t.igst)+'</span></div><div class="tot-row grand"><span>Total</span><span class="v">'+inr(t.total)+'</span></div>'
    : '<div class="tot-row"><span>Subtotal</span><span class="v">'+inr(t.subtotal)+'</span></div><div class="tot-row"><span>CGST</span><span class="v">'+inr(t.cgst)+'</span></div><div class="tot-row"><span>SGST</span><span class="v">'+inr(t.sgst)+'</span></div><div class="tot-row grand"><span>Total</span><span class="v">'+inr(t.total)+'</span></div>';
  renderInvoicePreview(t);
}
function renderInvoicePreview(t){
  const box = document.getElementById('invPreviewBox'); if(!box) return;
  t = t || computeInvoiceTotals();
  const custId = document.getElementById('invCustomer') ? document.getElementById('invCustomer').value : '';
  const customer = (typeof khataParties !== 'undefined' ? khataParties : []).find(p => p.id === custId);
  box.className = '';
  box.innerHTML = buildInvoiceSheet({
    number: 'Invoice ' + ((document.getElementById('invNumber') || {}).value || ''),
    issue: (document.getElementById('invIssueDate') || {}).value || 'Not set',
    due: (document.getElementById('invDueDate') || {}).value || 'Not set',
    billToName: customer ? customer.name : null,
    billToLines: customer ? [customer.address, customer.gstin ? 'GSTIN ' + customer.gstin : null].filter(Boolean).join('<br>') : null,
    items: (invoiceDraftLines || []).map(li => ({ desc: li.description, hsn: li.hsn, qty: li.qty, rate: li.rate, gst: li.gst, amount: (Number(li.qty)||0) * (Number(li.rate)||0) })),
    subtotal: t.subtotal,
    taxLabel: t.interstate ? 'IGST' : 'CGST + SGST',
    taxAmount: t.interstate ? t.igst : (t.cgst + t.sgst),
    total: t.total,
    terms: (document.getElementById('invNotes') || {}).value || null
  });
}
function nextInvoiceNumber(){
  const n = khataInvoices.length + 1;
  return 'INV-' + String(n).padStart(4,'0');
}
function renderInvoiceForm(){
  populateInvoiceCustomerSelect();
  document.getElementById('invNumber').value = nextInvoiceNumber();
  document.getElementById('invIssueDate').value = new Date().toISOString().slice(0,10);
  const due = new Date(); due.setDate(due.getDate()+14);
  document.getElementById('invDueDate').value = due.toISOString().slice(0,10);
  invoiceDraftLines = [{ description:'', hsn:'', qty:1, rate:0, gst:18 }];
  renderInvoiceLines();
  document.getElementById('invCustomer').addEventListener('change', renderInvoiceTotals);
}
document.getElementById('invAddLineBtn').addEventListener('click', addInvoiceLine);
async function saveInvoice(status){
  const custId = document.getElementById('invCustomer').value;
  const note = document.getElementById('invNote');
  if(!custId){ note.className='note bad'; note.textContent='Add a customer first.'; return; }
  const validLines = invoiceDraftLines.filter(li => li.description && Number(li.rate) > 0);
  if(!validLines.length){ note.className='note bad'; note.textContent='Add at least one line item.'; return; }
  const t = computeInvoiceTotals();
  note.className='note'; note.textContent='Saving…';
  try {
    const invRow = {
      user_id: currentUser.id, party_id: custId, invoice_number: document.getElementById('invNumber').value,
      issue_date: document.getElementById('invIssueDate').value, due_date: document.getElementById('invDueDate').value,
      status, subtotal: t.subtotal, gst_breakup: { cgst:t.cgst, sgst:t.sgst, igst:t.igst }, total: t.total,
      notes: document.getElementById('invNotes').value.trim() || null
    };
    const { data: invData, error: invErr } = await sbClient.from('invoices').insert(invRow).select().single();
    if(invErr) throw invErr;
    const lineRows = validLines.map(li => ({ invoice_id: invData.id, description: li.description, hsn_sac: li.hsn||null, quantity: li.qty, rate: li.rate, gst_rate: li.gst, line_total: (li.qty*li.rate) }));
    const { error: liErr } = await sbClient.from('invoice_line_items').insert(lineRows);
    if(liErr) throw liErr;
    if(status !== 'draft'){
      const { error: entErr } = await sbClient.from('ledger_entries').insert({
        user_id: currentUser.id, party_id: custId, entry_type:'sale', amount: t.total,
        entry_date: invRow.issue_date, reference_number: invRow.invoice_number, notes: 'Auto-created from invoice'
      });
      if(entErr) throw entErr;
    }
    khataInvoices = await loadKhataInvoices(); khataEntries = await loadKhataEntries();
    note.className='note ok'; note.textContent='Saved.';
    setTimeout(() => { showKhataTab('invoices'); }, 500);
  } catch(err){ note.className='note bad'; note.textContent = 'Could not save: ' + (err.message||'unknown error'); }
}
document.getElementById('invSaveDraftBtn').addEventListener('click', () => saveInvoice('draft'));
document.getElementById('invCreateBtn').addEventListener('click', () => saveInvoice('sent'));
function invoiceDerivedStatus(inv){
  if(inv.status === 'paid') return 'paid';
  if(inv.status === 'draft') return 'draft';
  const days = Math.round((new Date(new Date().toDateString()) - new Date(inv.due_date)) / 86400000);
  return days > 0 ? 'overdue' : 'sent';
}
function renderKhataInvoiceList(){
  const host = document.getElementById('khataInvoiceList'); if(!host) return;
  populateInvoiceCustomerSelect();
  const statusFilter = document.getElementById('invFilterStatus').value;
  const custFilter = document.getElementById('invFilterCustomer').value;
  let rows = khataInvoices.filter(inv => {
    const st = invoiceDerivedStatus(inv);
    if(statusFilter !== 'all' && st !== statusFilter) return false;
    if(custFilter !== 'all' && inv.party_id !== custFilter) return false;
    return true;
  });
  if(!rows.length){ host.innerHTML = '<div class="ledger-empty">No invoices yet. Create one under New invoice.</div>'; return; }
  host.innerHTML = '';
  rows.forEach(inv => {
    const party = khataParties.find(p => p.id === inv.party_id);
    const st = invoiceDerivedStatus(inv);
    const row = document.createElement('div'); row.className = 'ledger-row';
    row.innerHTML =
      '<div class="lr-main"><div class="lr-party">'+escapeHtml(inv.invoice_number)+' · '+escapeHtml(party?party.name:'Unknown')+'<span class="inv-status '+st+'" style="margin-left:8px;">'+st+'</span></div>' +
      '<div class="lr-meta">issued '+fmtDay(inv.issue_date)+' · due '+fmtDay(inv.due_date)+'</div></div>' +
      '<div class="lr-amount">'+inr(inv.total)+'</div>' +
      '<div class="lr-actions"><button class="lr-btn" data-act="print">Print</button>'+(st!=='paid'?'<button class="lr-btn" data-act="paid">Mark paid</button>':'')+'</div>';
    row.querySelector('[data-act="print"]').addEventListener('click', () => printInvoice(inv));
    const paidBtn = row.querySelector('[data-act="paid"]'); if(paidBtn) paidBtn.addEventListener('click', () => markInvoicePaid(inv));
    host.appendChild(row);
  });
}
document.getElementById('invFilterStatus').addEventListener('change', renderKhataInvoiceList);
document.getElementById('invFilterCustomer').addEventListener('change', renderKhataInvoiceList);
async function markInvoicePaid(inv){
  try {
    const { error } = await sbClient.from('invoices').update({ status:'paid' }).eq('id', inv.id); if(error) throw error;
    // Book the offsetting receipt so the party's running balance actually reflects the payment,
    // instead of the invoice status changing while the khata still shows it outstanding.
    const { error: entErr } = await sbClient.from('ledger_entries').insert({
      user_id: currentUser.id, party_id: inv.party_id, entry_type:'receipt', amount: inv.total,
      entry_date: new Date().toISOString().slice(0,10), reference_number: inv.invoice_number, notes: 'Payment against invoice'
    });
    if(entErr) throw entErr;
    khataInvoices = await loadKhataInvoices(); khataEntries = await loadKhataEntries();
    renderKhataInvoiceList();
  } catch(err){ toast('Could not update: ' + (err.message||'unknown error'), {kind:'bad'}); }
}
/* ---------- printing / reports ---------- */
function populateReportPartySelect(){
  const sel = document.getElementById('reportPartySelect'); if(!sel) return;
  sel.innerHTML = khataParties.map(p => '<option value="'+p.id+'">'+escapeHtml(p.name)+'</option>').join('');
}
function renderPrintingTab(){
  populateReportPartySelect();
  const body = document.getElementById('dayBookTableBody'); if(!body) return;
  const rows = khataEntries.slice().sort((a,b) => new Date(b.entry_date) - new Date(a.entry_date));
  body.innerHTML = rows.length ? '' : '<tr><td colspan="4" style="text-align:center; color:var(--text-2); padding:16px;">No ledger activity yet.</td></tr>';
  rows.forEach(e => {
    const party = khataParties.find(p => p.id === e.party_id);
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+fmtDay(e.entry_date)+'</td><td>'+escapeHtml(party?party.name:'—')+'</td><td><span class="type-badge '+e.entry_type+'">'+e.entry_type.replace('_',' ')+'</span></td><td class="num">'+inr(e.amount)+'</td>';
    body.appendChild(tr);
  });
}
document.getElementById('printPartyStatementBtn').addEventListener('click', () => {
  const partyId = document.getElementById('reportPartySelect').value;
  const party = khataParties.find(p => p.id === partyId); if(!party) return;
  let running = Number(party.opening_balance)||0;
  const rows = khataEntriesForParty(party.id).map(e => {
    running += entrySignedAmount(e);
    return { date: fmtDay(e.entry_date), type: e.entry_type.replace('_',' '), ref: e.reference_number || '—', amount: inr(e.amount), balance: inr(Math.abs(running)) };
  });
  buildAndPrintSheet(buildStatementSheet({
    title: 'Statement of account',
    dateLine: 'As on ' + fmtDay(new Date().toISOString().slice(0,10)),
    party: { name: party.name, lines: [party.phone, party.gstin ? 'GSTIN ' + party.gstin : null].filter(Boolean).join('<br>') },
    columns: [ {key:'date',label:'Date'}, {key:'type',label:'Type'}, {key:'ref',label:'Reference'}, {key:'amount',label:'Amount',num:true}, {key:'balance',label:'Balance',num:true} ],
    rows: rows,
    closing: Math.abs(running),
    closingLabel: 'Closing balance',
    footNote: 'Thank you for your business'
  }));
});
document.getElementById('csvPartyStatementBtn').addEventListener('click', () => {
  const partyId = document.getElementById('reportPartySelect').value;
  const party = khataParties.find(p => p.id === partyId); if(!party) return;
  let running = Number(party.opening_balance)||0;
  const lines = ['Date,Type,Reference,Amount,Balance'];
  khataEntriesForParty(party.id).forEach(e => {
    running += entrySignedAmount(e);
    lines.push([fmtDay(e.entry_date), e.entry_type, e.reference_number||'', e.amount, Math.abs(running)].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = party.name.replace(/\s+/g,'_') + '_statement.csv'; a.click();
});
document.getElementById('printDayBookBtn').addEventListener('click', () => {
  const rows = khataEntries.slice().sort((a,b) => new Date(b.entry_date) - new Date(a.entry_date));
  const dbRows = rows.map(e => {
    const party = khataParties.find(p => p.id === e.party_id);
    return { date: fmtDay(e.entry_date), party: party ? party.name : '—', type: e.entry_type.replace('_',' '), amount: inr(e.amount) };
  });
  buildAndPrintSheet(buildStatementSheet({
    title: 'Day book',
    dateLine: 'As on ' + fmtDay(new Date().toISOString().slice(0,10)),
    columns: [ {key:'date',label:'Date'}, {key:'party',label:'Party'}, {key:'type',label:'Type'}, {key:'amount',label:'Amount',num:true} ],
    rows: dbRows
  }));
});
/* Renders one invoice as a print-ready document. `d` is a normalized shape,
   used by both the on-screen preview and window.print(). */
function buildInvoiceSheet(d){
  const co = (currentProfile && currentProfile.company_name) || 'Your company';
  const rows = (d.items || []).map(li =>
    '<tr><td>'+escapeHtml(li.desc || 'Item')+'</td><td>'+escapeHtml(li.hsn || '')+'</td>' +
    '<td class="n">'+(Number(li.qty)||0)+'</td><td class="n">'+inr(Number(li.rate)||0)+'</td>' +
    '<td class="n">'+(Number(li.gst)||0)+'%</td><td class="n">'+inr(Number(li.amount)||0)+'</td></tr>'
  ).join('') || '<tr><td colspan="6" style="color:#9AA1AD;">No line items yet.</td></tr>';
  return '<div class="rd-sheet">' +
    '<div class="sh-head">' +
      '<div><div class="sh-co"><span class="m">M</span>'+escapeHtml(co)+'</div>' +
        (d.companyLines ? '<div style="color:#5B6472;font-size:12px;margin-top:8px;line-height:1.6;">'+d.companyLines+'</div>' : '') + '</div>' +
      '<div class="sh-inv"><div class="big">'+escapeHtml(d.number || 'INV')+'</div>' +
        '<div class="k">Issued '+escapeHtml(d.issue || '')+'</div><div class="k">Due '+escapeHtml(d.due || '')+'</div></div>' +
    '</div>' +
    '<div class="sh-parties">' +
      '<div><div class="k">Billed to</div><div class="nm">'+escapeHtml(d.billToName || 'Not selected')+'</div>' +
        (d.billToLines ? '<div class="ln">'+d.billToLines+'</div>' : '') + '</div>' +
      '<div><div class="k">Payment to</div><div class="ln">'+(d.payToLines || 'Bank details on request')+'</div></div>' +
    '</div>' +
    '<table><thead><tr><th>Description</th><th>HSN</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">GST</th><th class="n">Amount</th></tr></thead><tbody>'+rows+'</tbody></table>' +
    '<div class="sh-totrow"><div class="sh-totbox">' +
      '<div class="tr"><span>Subtotal</span><span>'+inr(d.subtotal || 0)+'</span></div>' +
      '<div class="tr"><span>'+escapeHtml(d.taxLabel || 'Tax')+'</span><span>'+inr(d.taxAmount || 0)+'</span></div>' +
      '<div class="tr grand"><span>Total due</span><span>'+inr(d.total || 0)+'</span></div>' +
    '</div></div>' +
    (d.terms ? '<div style="margin-top:22px;font-size:12px;color:#5B6472;"><strong style="color:#5B6472;">Terms.</strong> '+escapeHtml(d.terms)+'</div>' : '') +
    '<div class="sh-foot"><span>Generated by Margyn</span><span>Thank you for your business</span></div>' +
  '</div>';
}
/* Renders a ledger statement / day book as a print-ready document in the same
   .rd-sheet shell as the invoice, so printed reports match the on-screen preview.
   `d.columns` is [{key,label,num}], `d.rows` is [{<key>: preformatted string}]. */
function buildStatementSheet(d){
  const co = (currentProfile && currentProfile.company_name) || 'Your company';
  const cols = d.columns || [];
  const head = '<tr>' + cols.map(c => '<th'+(c.num?' class="n"':'')+'>'+escapeHtml(c.label)+'</th>').join('') + '</tr>';
  const body = (d.rows || []).map(r =>
    '<tr>' + cols.map(c => '<td'+(c.num?' class="n"':'')+'>'+escapeHtml(String(r[c.key] == null ? '' : r[c.key]))+'</td>').join('') + '</tr>'
  ).join('') || '<tr><td colspan="'+(cols.length||1)+'" style="color:#9AA1AD;">No entries in this period.</td></tr>';
  return '<div class="rd-sheet">' +
    '<div class="sh-head">' +
      '<div><div class="sh-co"><span class="m">M</span>'+escapeHtml(co)+'</div></div>' +
      '<div class="sh-inv"><div class="big">'+escapeHtml(d.title || 'Statement')+'</div>' +
        '<div class="k">'+escapeHtml(d.dateLine || '')+'</div></div>' +
    '</div>' +
    (d.party ? '<div class="sh-parties">' +
      '<div><div class="k">Statement for</div><div class="nm">'+escapeHtml(d.party.name || '')+'</div>' +
        (d.party.lines ? '<div class="ln">'+d.party.lines+'</div>' : '') + '</div>' +
      '<div><div class="k">Prepared by</div><div class="ln">'+escapeHtml(co)+'</div></div>' +
    '</div>' : '<div style="height:20px"></div>') +
    '<table><thead>'+head+'</thead><tbody>'+body+'</tbody></table>' +
    (d.closing != null ? '<div class="sh-totrow"><div class="sh-totbox">' +
      '<div class="tr grand"><span>'+escapeHtml(d.closingLabel || 'Closing balance')+'</span><span>'+inr(d.closing)+'</span></div>' +
    '</div></div>' : '') +
    '<div class="sh-foot"><span>Generated by Margyn</span><span>'+escapeHtml(d.footNote || '')+'</span></div>' +
  '</div>';
}
function printInvoice(inv){
  const party = khataParties.find(p => p.id === inv.party_id);
  const gb = inv.gst_breakup || {};
  const igst = Number(gb.igst) || 0;
  buildAndPrintSheet(buildInvoiceSheet({
    number: 'Invoice ' + inv.invoice_number,
    issue: fmtDay(inv.issue_date), due: fmtDay(inv.due_date),
    billToName: party ? party.name : null,
    billToLines: party ? [party.address, party.gstin ? 'GSTIN ' + party.gstin : null].filter(Boolean).join('<br>') : null,
    items: (inv.invoice_line_items || []).map(li => ({ desc: li.description, hsn: li.hsn_sac, qty: li.quantity, rate: li.rate, gst: li.gst_rate, amount: li.line_total })),
    subtotal: Number(inv.subtotal) || (Number(inv.total) - igst - (Number(gb.cgst)||0) - (Number(gb.sgst)||0)),
    taxLabel: igst ? 'IGST' : 'CGST + SGST',
    taxAmount: igst || ((Number(gb.cgst)||0) + (Number(gb.sgst)||0)),
    total: Number(inv.total) || 0,
    terms: inv.notes || null
  }));
}
/* Print a document in a clean popup window so the app's layout, nav, fonts
   and CSS vars can't leak into the printout. Falls back to the in-page
   #printStatement method if the popup is blocked. */
const RD_PRINT_CSS = "\
*{box-sizing:border-box;margin:0}\
@page{margin:16mm}\
body{font-family:'Manrope',system-ui,sans-serif;color:#14181F;-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:24px}\
.rd-sheet{width:100%;max-width:720px;margin:0 auto;background:#fff;border:none;box-shadow:none;padding:0;font-size:12px}\
.rd-sheet .sh-head{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:22px;border-bottom:2px solid #14181F}\
.rd-sheet .sh-co{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.02em}\
.rd-sheet .sh-co .m{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#3FD79A,#0E8F5C);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px}\
.rd-sheet .sh-inv{text-align:right}\
.rd-sheet .sh-inv .big{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600}\
.rd-sheet .sh-inv .k{font-family:'IBM Plex Mono',monospace;font-size:10px;color:#9AA1AD;text-transform:uppercase;letter-spacing:.06em;margin-top:3px}\
.rd-sheet .sh-parties{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin:24px 0}\
.rd-sheet .sh-parties .k{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9AA1AD;margin-bottom:6px}\
.rd-sheet .sh-parties .nm{font-weight:700;font-size:13px}\
.rd-sheet .sh-parties .ln{color:#5B6472;font-size:11.5px;line-height:1.6}\
.rd-sheet table{width:100%;border-collapse:collapse;margin:8px 0 6px}\
.rd-sheet thead th{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9AA1AD;text-align:left;padding:9px 8px;border-bottom:1px solid #14181F}\
.rd-sheet tbody td{padding:11px 8px;border-bottom:1px solid #EEECE6;font-size:11.5px}\
.rd-sheet th.n,.rd-sheet td.n{text-align:right;font-family:'IBM Plex Mono',monospace}\
.rd-sheet .sh-totrow{display:flex;justify-content:flex-end;margin-top:14px}\
.rd-sheet .sh-totbox{width:280px}\
.rd-sheet .sh-totbox .tr{display:flex;justify-content:space-between;padding:6px 0;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#5B6472}\
.rd-sheet .sh-totbox .tr.grand{border-top:1.5px solid #14181F;margin-top:6px;padding-top:10px;font-size:14px;font-weight:700;color:#14181F}\
.rd-sheet .sh-foot{margin-top:34px;padding-top:16px;border-top:1px solid #EEECE6;display:flex;justify-content:space-between;font-size:10.5px;color:#9AA1AD;font-family:'IBM Plex Mono',monospace}\
.rd-sheet thead{display:table-header-group}\
.rd-sheet tbody tr{break-inside:avoid;page-break-inside:avoid}\
.rd-sheet .sh-totrow,.rd-sheet .sh-foot{break-inside:avoid}\
";
function buildAndPrintSheet(html){
  let w = null;
  try { w = window.open('', '_blank', 'width=860,height=1100'); } catch(e){ w = null; }
  if(!w){
    const box = document.getElementById('printStatement');
    box.innerHTML = html;
    box.classList.remove('hidden');
    window.print();
    setTimeout(() => box.classList.add('hidden'), 400);
    return;
  }
  w.document.open();
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Margyn document</title>' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<style>' + RD_PRINT_CSS + '</style></head><body>' + html +
    '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.focus();window.print();},400);};window.onafterprint=function(){window.close();};</scr' + 'ipt>' +
    '</body></html>');
  w.document.close();
}
// Redraws any .draw-line polyline/path and fades in any .area-fill inside host
// from empty, every time it's called — so charts visibly load in on every
// render (fresh page load, tab switch, new snapshot), not just snap into place.
function animateDrawLine(host){
  if(!host) return;
  requestAnimationFrame(() => {
    host.querySelectorAll('.draw-line').forEach(line => {
      const len = line.getTotalLength ? line.getTotalLength() : 0;
      if(!len) return;
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      line.getBoundingClientRect(); // force reflow so the start state registers before animating
      requestAnimationFrame(() => { line.style.strokeDashoffset = '0'; });
    });
    host.querySelectorAll('.area-fill').forEach(area => area.classList.add('in'));
  });
}
// Catmull-Rom to cubic-bezier: turns a jagged point-to-point polyline into a smooth curve
function smoothPath(points){
  if(points.length < 2) return '';
  let d = 'M'+points[0].x.toFixed(1)+','+points[0].y.toFixed(1);
  for(let i=0; i<points.length-1; i++){
    const p0 = points[i===0 ? i : i-1];
    const p1 = points[i];
    const p2 = points[i+1];
    const p3 = points[i+2===points.length ? i+1 : i+2];
    const c1x = p1.x + (p2.x-p0.x)/6, c1y = p1.y + (p2.y-p0.y)/6;
    const c2x = p2.x - (p3.x-p1.x)/6, c2y = p2.y - (p3.y-p1.y)/6;
    d += ' C'+c1x.toFixed(1)+','+c1y.toFixed(1)+' '+c2x.toFixed(1)+','+c2y.toFixed(1)+' '+p2.x.toFixed(1)+','+p2.y.toFixed(1);
  }
  return d;
}
function gridlinesSvg(W, H, PAD, count){
  count = count || 3;
  let out = '';
  for(let i=1; i<=count; i++){
    const y = PAD + (i/(count+1))*(H-2*PAD);
    out += '<line x1="'+PAD+'" y1="'+y.toFixed(1)+'" x2="'+(W-PAD)+'" y2="'+y.toFixed(1)+'" stroke="rgba(20,24,31,0.05)" stroke-width="1"/>';
  }
  return out;
}
function renderPulseTrendChart(){
  const host = document.getElementById('pulseTrendChart'); if(!host) return;
  // One point per calendar day (latest snapshot of each day), last 30 days, so
  // editing a receivable ten times in a day doesn't stack ten near-identical
  // points. Display-only collapse; the snapshot data itself is untouched.
  const seenDay = {}; const dailyDesc = [];
  snapshots.forEach(s => {
    const day = (s.created_at || '').slice(0, 10);
    if(day && !seenDay[day]){ seenDay[day] = 1; dailyDesc.push(s); }
  });
  const rows = dailyDesc.slice(0, 30).reverse();
  const sub = document.getElementById('scTrendSub');
  if(rows.length < 2){
    host.innerHTML = '<div class="ledger-empty">Record snapshots on at least two different days to see your Pulse Score trend.</div>';
    if(sub) sub.textContent = '';
    return;
  }
  const vals = rows.map(r => Number(r.pulse_score) || 0);
  host.innerHTML = rdChart({
    type:'area',
    labels: rows.map(r => fmtMon(r.created_at)),
    series: [{ type:'area', color:'#0E8F5C', name:'Pulse Score', unit:'score', data: vals }],
    h: 210
  });
  rdMountCharts(host);
  if(sub){
    const d = vals[vals.length - 1] - vals[0];
    sub.textContent = rows.length + ' days · ' + (d === 0 ? 'flat' : (d > 0 ? '▲ +' + d : '▼ ' + Math.abs(d)) + ' points');
  }
}
function renderHistory(rows){
  const host = document.getElementById('historyList'); host.innerHTML = '';
  if(!rows.length){ host.innerHTML = '<div style="font-size:13.5px; color:var(--text-2);">No snapshots recorded yet.</div>'; return; }
  rows.forEach((r, i) => {
    const prev = rows[i+1]; const d = prev ? r.pulse_score - prev.pulse_score : null;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--border-1); font-size:13.5px;';
    row.innerHTML = '<span class="mono" style="color:var(--text-2); font-size:12.5px;">'+fmtDate(r.created_at)+'</span>' +
      '<span class="mono" style="font-weight:600;">'+r.pulse_score+(d===null?'':d>0?' ▲+'+d:d<0?' ▼'+d:' —')+'</span>';
    host.appendChild(row);
  });
}
function computeFinancingEligibility(){
  if(!snapshots.length) return null;
  const latest = snapshots[0]; const monthlyRevenue = Number(latest.revenue) || 0;
  if(monthlyRevenue <= 0) return null;
  const band = scoreBand(latest.pulse_score);
  const multiplier = latest.pulse_score >= 70 ? 3 : latest.pulse_score >= 40 ? 2 : 1;
  const mid = monthlyRevenue * multiplier;
  return { low: Math.round(mid*0.8), high: Math.round(mid*1.2), band };
}
function renderFinancing(){
  const range = document.getElementById('finRange'); const note = document.getElementById('finNote');
  const elig = computeFinancingEligibility();
  if(!elig){ range.textContent = '—'; note.textContent = 'Upload or enter a snapshot with monthly revenue to see an estimate.'; }
  else { range.textContent = inr(elig.low) + ' – ' + inr(elig.high); note.textContent = 'A rough estimate based on revenue and Pulse Score band (' + elig.band.label + '). Not a credit decision.'; }
  document.getElementById('finEmail').value = currentUser ? currentUser.email : '';
}
document.getElementById('financingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = document.getElementById('finFormNote');
  note.className = 'note ok'; note.textContent = 'Interest recorded. We’ll reach out once a lending partner is live.';
});

