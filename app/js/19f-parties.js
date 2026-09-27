/* ============================================================
   PARTY MASTER — one customer/vendor record for every path.
   Table: ledger_parties (the same rows Invoicing › Parties uses).

   Created from:
     - the Customers / Vendors pages (New customer / New vendor, or
       "Add to customers" on someone who only exists in a source);
     - the AI file import and WhatsApp import, when a document names a
       party that isn't in the master yet (the review card asks first);
     - Margyn in chat or voice, when it logs an invoice or bill for a
       party that doesn't exist yet (the confirm card says so);
     - the Ledger's own add form.
   Every receivable/payable Margyn writes carries party_id, so a later
   Tally / Zoho write-back pushes the party and its items together.

   Before 2026-09-27-party-master.sql has run, the extra columns
   (state, pincode, pan, credit_days, source, party_id...) don't exist:
   every write here retries without them, so nothing breaks in between.
   ============================================================ */

const MG_GST_STATES = {
  '01':'Jammu and Kashmir', '02':'Himachal Pradesh', '03':'Punjab', '04':'Chandigarh', '05':'Uttarakhand', '06':'Haryana',
  '07':'Delhi', '08':'Rajasthan', '09':'Uttar Pradesh', '10':'Bihar', '11':'Sikkim', '12':'Arunachal Pradesh', '13':'Nagaland',
  '14':'Manipur', '15':'Mizoram', '16':'Tripura', '17':'Meghalaya', '18':'Assam', '19':'West Bengal', '20':'Jharkhand',
  '21':'Odisha', '22':'Chhattisgarh', '23':'Madhya Pradesh', '24':'Gujarat', '26':'Dadra and Nagar Haveli and Daman and Diu',
  '27':'Maharashtra', '29':'Karnataka', '30':'Goa', '31':'Lakshadweep', '32':'Kerala', '33':'Tamil Nadu', '34':'Puducherry',
  '35':'Andaman and Nicobar Islands', '36':'Telangana', '37':'Andhra Pradesh', '38':'Ladakh', '97':'Other Territory'
};
const MG_PARTY_EXT = ['state', 'pincode', 'pan', 'credit_days', 'source', 'external_refs', 'updated_at'];

function mgGstinOk(g){ return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(g || '').toUpperCase()); }
function mgGstinState(g){ return MG_GST_STATES[String(g || '').slice(0, 2)] || null; }
function mgGstinPan(g){ return mgGstinOk(g) ? String(g).toUpperCase().slice(2, 12) : null; }
function mgPartyFits(p, dir){ return !dir || p.type === 'both' || (dir === 'recv' ? p.type === 'customer' : p.type === 'vendor'); }
function mgPartyWho(dir){ return dir === 'pay' ? 'vendor' : 'customer'; }
/* Postgres "no such column" / PostgREST "not in schema cache": the migration hasn't run yet. */
function mgMissingCol(e){ return !!e && (e.code === '42703' || e.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(e.message || '')); }
function mgStripCols(row, cols){ const r = Object.assign({}, row); cols.forEach(c => delete r[c]); return r; }

/* ---------- finding a party ---------- */
/* GSTIN first (exact), then the normalised name. `near` = names that
   contain each other ("Acme Retail" / "Acme Retail Stores"), for a
   "did you mean" rather than a silent merge. */
function mgFindMasterParty(name, gstin, dir){
  const list = (typeof khataParties !== 'undefined' && khataParties) || [];
  const g = String(gstin || '').toUpperCase().trim();
  if(g){ const p = list.find(x => String(x.gstin || '').toUpperCase() === g); if(p) return { party:p, how:'gstin', near:[] }; }
  const k = normPartyName(name);
  if(!k) return { party:null, near:[] };
  const same = list.filter(x => normPartyName(x.name) === k);
  if(same.length) return { party:same.find(x => mgPartyFits(x, dir)) || same[0], how:'name', near:[] };
  const near = list.filter(x => { const n = normPartyName(x.name); return n.length >= 5 && k.length >= 5 && (n.includes(k) || k.includes(n)); });
  return { party:null, near:near.slice(0, 3) };
}
/* How a connected source already spells this party ("ACME RETAIL PVT LTD"
   in Zoho), so a new master record matches the books it will sync with. */
function mgKnownSpelling(name, dir){
  const k = normPartyName(name); if(!k) return null;
  try { const g = mgMoneyGroups(dir).find(x => x.key === k); if(g && g.primary !== 'manual') return { name:g.party, src:g.primary }; } catch(e){}
  return null;
}
function mgMasterFor(name, dir){ return mgFindMasterParty(name, null, dir).party; }

/* ---------- writing ---------- */
async function mgReloadParties(){
  khataParties = await loadKhataParties();
  try { if(typeof renderKhataParties === 'function') renderKhataParties(); } catch(e){}
  try { if(typeof populateInvoiceCustomerSelect === 'function') populateInvoiceCustomerSelect(); } catch(e){}
  try { if(typeof populateReportPartySelect === 'function') populateReportPartySelect(); } catch(e){}
}
function mgPartyRow(f){
  const gstin = String(f.gstin || '').toUpperCase().trim() || null;
  const credit = f.credit_days === '' || f.credit_days == null ? null : Math.max(0, Math.round(Number(f.credit_days)));
  return {
    name:String(f.name || '').trim().slice(0, 160), type:['customer', 'vendor', 'both'].includes(f.type) ? f.type : 'customer',
    phone:String(f.phone || '').trim() || null, email:String(f.email || '').trim() || null, gstin,
    address:String(f.address || '').trim() || null,
    state:String(f.state || '').trim() || (gstin ? mgGstinState(gstin) : null),
    pincode:String(f.pincode || '').trim() || null,
    pan:String(f.pan || '').toUpperCase().trim() || (gstin ? mgGstinPan(gstin) : null),
    credit_days:isFinite(credit) ? credit : null
  };
}
async function mgCreateParty(fields, source){
  const row = Object.assign({ user_id:currentUser.id, opening_balance:Number(fields.opening_balance) || 0, source:source || 'manual' }, mgPartyRow(fields));
  if(!row.name) throw new Error('A name is needed.');
  let { data, error } = await sbClient.from('ledger_parties').insert(row).select().single();
  if(error && mgMissingCol(error)) ({ data, error } = await sbClient.from('ledger_parties').insert(mgStripCols(row, MG_PARTY_EXT)).select().single());
  if(error) throw error;
  await logLedgerEvent({ entityType:'party', entityId:data.id, event:'created', partyName:data.name, source:source || 'manual', note:data.type });
  await mgReloadParties();
  return data;
}
async function mgUpdateParty(id, fields){
  const row = Object.assign(mgPartyRow(fields), { updated_at:new Date().toISOString() });
  let { data, error } = await sbClient.from('ledger_parties').update(row).eq('id', id).eq('user_id', currentUser.id).select().single();
  if(error && mgMissingCol(error)) ({ data, error } = await sbClient.from('ledger_parties').update(mgStripCols(row, MG_PARTY_EXT)).eq('id', id).eq('user_id', currentUser.id).select().single());
  if(error) throw error;
  await logLedgerEvent({ entityType:'party', entityId:id, event:'edited', partyName:data.name, source:'manual' });
  await mgReloadParties();
  return data;
}
/* The party behind a new open item: the existing record, or a new one
   (only when `create`). Returns { party, created }. A new party takes the
   spelling the connected books already use, if any. */
async function mgEnsureParty({ name, dir, details, source, create }){
  const d = details || {};
  const f = mgFindMasterParty(name, d.gstin, dir);
  if(f.party){
    // Widen a customer to "both" when they now also bill us, and vice versa.
    if(!mgPartyFits(f.party, dir)){ try { f.party = await mgUpdateParty(f.party.id, Object.assign({}, f.party, { type:'both' })); } catch(e){} }
    return { party:f.party, created:false };
  }
  if(!create || !String(name || '').trim()) return { party:null, created:false };
  const known = mgKnownSpelling(name, dir);
  const party = await mgCreateParty({ name:known ? known.name : name, type:dir === 'pay' ? 'vendor' : 'customer',
    gstin:mgGstinOk(d.gstin) ? d.gstin : null, phone:d.phone, email:d.email, address:d.address, state:d.state }, source);
  return { party, created:true };
}
/* One new open item typed or dictated by the user (Ledger form, vital
   drill-downs, Margyn's create_ledger_item): link it to its party, adding
   the party to the master first if it's new. Returns { party, created }. */
async function mgAddOpenItem(table, row, source){
  const dir = table === 'payables' ? 'pay' : 'recv';
  let r = { party:null, created:false };
  try { r = await mgEnsureParty({ name:row.party_name, dir, source, create:true }); }
  catch(e){ console.error('[margyn] party for new item:', e); }   // the item still gets written
  await mgInsertOpenItems(table, [Object.assign({}, row, { party_name:r.party ? r.party.name : row.party_name, party_id:r.party ? r.party.id : null })]);
  if(r.created) toast('Added ' + r.party.name + ' to your ' + mgPartyWho(dir) + 's', { sub:'Add GSTIN and contact details on the ' + (dir === 'pay' ? 'Vendors' : 'Customers') + ' page' });
  return r;
}
/* Insert open receivables/payables with party_id; before the migration,
   the same rows without it. */
async function mgInsertOpenItems(table, rows){
  if(!rows.length) return;
  let { error } = await sbClient.from(table).insert(rows);
  if(error && mgMissingCol(error)) ({ error } = await sbClient.from(table).insert(rows.map(r => mgStripCols(r, ['party_id']))));
  if(error) throw error;
}

/* ---------- the form (Customers / Vendors pages, voice add_party) ---------- */
function mgPartyForm(o){
  o = o || {};
  const edit = o.party || null, dir = o.dir || (edit && edit.type === 'vendor' ? 'pay' : 'recv');
  const v = Object.assign({ type:dir === 'pay' ? 'vendor' : 'customer', name:o.name || '' }, o.details || {}, edit || {});
  const who = mgPartyWho(dir), Who = who[0].toUpperCase() + who.slice(1);
  const inp = (k, label, attrs, full) => '<label class="mg-pf-f' + (full ? ' full' : '') + '"><span>' + label + '</span><input name="' + k + '" value="' + escapeHtml(v[k] == null ? '' : String(v[k])) + '" ' + (attrs || '') + '></label>';
  const states = Object.values(MG_GST_STATES).sort();
  const body = '<form class="mg-pf" novalidate>' +
    inp('name', 'Name <i>*</i>', 'required maxlength="160" autocomplete="off"', true) +
    '<label class="mg-pf-f"><span>Type</span><select name="type">' + [['customer', 'Customer'], ['vendor', 'Vendor'], ['both', 'Both']].map(([k, l]) => '<option value="' + k + '"' + (v.type === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
    inp('gstin', 'GSTIN', 'maxlength="15" autocomplete="off" spellcheck="false" style="text-transform:uppercase"') +
    inp('phone', 'Phone', 'inputmode="tel" maxlength="20"') +
    inp('email', 'Email', 'type="email" maxlength="120"') +
    '<label class="mg-pf-f full"><span>Billing address</span><textarea name="address" rows="2" maxlength="400">' + escapeHtml(v.address || '') + '</textarea></label>' +
    '<label class="mg-pf-f"><span>State</span><select name="state"><option value="">—</option>' + states.map(s => '<option' + (v.state === s ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('') + '</select></label>' +
    inp('pincode', 'Pincode', 'inputmode="numeric" maxlength="6"') +
    inp('pan', 'PAN', 'maxlength="10" style="text-transform:uppercase"') +
    inp('credit_days', 'Credit period (days)', 'type="number" min="0" max="365"') +
    (edit ? '' : inp('opening_balance', 'Opening balance (₹)', 'type="number" step="0.01"', false)) +
    '<div class="mg-pf-msg full" role="status" aria-live="polite"></div>' +
  '</form>';
  mgDrawer({
    title:edit ? 'Edit ' + edit.name : 'New ' + who,
    sub:escapeHtml(edit ? Who + ' details' : 'Saved to your ' + who + ' list, the same list invoicing and imports use.'),
    body,
    foot:'<button class="mg-btn" type="button" data-drawer-close>Cancel</button><button class="mg-btn primary" type="button" data-pf-save>' + (edit ? 'Save changes' : 'Save ' + who) + '</button>'
  });
  const el = mgDrawerEl; if(!el) return;
  const form = el.querySelector('.mg-pf'), msg = el.querySelector('.mg-pf-msg'), save = el.querySelector('[data-pf-save]');
  const get = () => Object.fromEntries([...form.elements].filter(x => x.name).map(x => [x.name, x.value]));
  let confirmNear = false;
  const say = (text, kind, html) => { msg.className = 'mg-pf-msg full' + (kind ? ' ' + kind : ''); if(html) msg.innerHTML = html; else msg.textContent = text || ''; };
  form.addEventListener('input', e => {
    confirmNear = false; save.textContent = edit ? 'Save changes' : 'Save ' + who;
    if(e.target.name === 'gstin'){
      const g = e.target.value.toUpperCase().trim();
      if(mgGstinOk(g)){
        // The GSTIN carries the state and the PAN: fill them if empty.
        const st = form.elements.state, pan = form.elements.pan;
        if(st && !st.value && mgGstinState(g)) st.value = mgGstinState(g);
        if(pan && !pan.value) pan.value = mgGstinPan(g);
        say('');
      } else if(g.length === 15) say('That GSTIN doesn’t look right. It should be 15 characters, like 29ABCDE1234F1Z5.', 'bad');
    }
  });
  const nameIn = form.elements.name; if(nameIn){ nameIn.focus(); try { nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); } catch(e){} }
  save.addEventListener('click', async () => {
    const f = get();
    f.gstin = String(f.gstin || '').toUpperCase().trim();
    if(!f.name.trim()){ say('Add a name.', 'bad'); nameIn.focus(); return; }
    if(f.gstin && !mgGstinOk(f.gstin)){ say('That GSTIN doesn’t look right. It should be 15 characters, like 29ABCDE1234F1Z5.', 'bad'); return; }
    if(f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)){ say('That email doesn’t look right.', 'bad'); return; }
    if(f.pincode && !/^\d{6}$/.test(f.pincode)){ say('A pincode is 6 digits.', 'bad'); return; }
    if(f.pan && !/^[A-Z]{5}\d{4}[A-Z]$/i.test(f.pan)){ say('A PAN looks like ABCDE1234F.', 'bad'); return; }
    // Never add the same party twice: by GSTIN, then by name.
    const m = mgFindMasterParty(f.name, f.gstin, null);
    if(m.party && (!edit || m.party.id !== edit.id)){
      say('', 'bad', escapeHtml(m.party.name) + ' is already in your list (same ' + (m.how === 'gstin' ? 'GSTIN' : 'name') + '). <button class="mg-link-btn" type="button" data-pf-open="' + escapeHtml(m.party.id) + '">Open it</button>');
      return;
    }
    if(!edit && m.near.length && !confirmNear){
      confirmNear = true; save.textContent = 'Save anyway';
      say('Similar name already in your list: ' + m.near.map(p => p.name).join(', ') + '. Save anyway if this is someone different.', 'warn');
      return;
    }
    save.disabled = true; say('Saving…');
    try {
      const p = edit ? await mgUpdateParty(edit.id, Object.assign({}, edit, f)) : await mgCreateParty(f, o.source || 'manual');
      mgCloseDrawer();
      toast(edit ? 'Saved' : (p.type === 'vendor' ? 'Vendor' : 'Customer') + ' added', { sub:p.name });
      if(mgCurrentView === 'customers' || mgCurrentView === 'vendors') mgRenderOwn(mgCurrentView);
      if(typeof o.onSaved === 'function') o.onSaved(p);
    } catch(err){ save.disabled = false; say('Could not save: ' + (err.message || 'unknown error'), 'bad'); }
  });
  el.addEventListener('click', e => { const b = e.target.closest('[data-pf-open]'); if(b) mgOpenMasterParty(b.dataset.pfOpen); });
}

/* ---------- a master record's profile ---------- */
function mgPartyProfileHtml(p, dir){
  if(!p) return '<div class="mg-pf-none"><div><b>Not in your ' + mgPartyWho(dir) + ' list yet.</b><div class="mg-fine">Save them to keep GSTIN, contact and address in one place for invoicing and syncing to your books.</div></div>' +
    '<button class="mg-btn" type="button" data-party-add-dir="' + dir + '">Add to ' + mgPartyWho(dir) + 's</button></div>';
  const line = (k, v) => v ? '<div><span>' + k + '</span><b class="txt">' + escapeHtml(String(v)) + '</b></div>' : '';
  const rows = line('GSTIN', p.gstin) + line('PAN', p.pan) + line('Phone', p.phone) + line('Email', p.email) + line('Address', [p.address, p.state, p.pincode].filter(Boolean).join(', ')) + line('Credit period', p.credit_days != null ? p.credit_days + ' days' : '');
  return '<div class="mg-pf-card"><div class="mg-pf-card-h"><b>' + (p.type === 'both' ? 'Customer and vendor' : p.type === 'vendor' ? 'Vendor' : 'Customer') + ' details</b>' +
    '<button class="mg-link-btn" type="button" data-party-edit="' + escapeHtml(p.id) + '">Edit</button></div>' +
    (rows ? '<div class="mg-dl mg-dl-1">' + rows + '</div>' : '<div class="mg-fine">No GSTIN or contact details yet. <button class="mg-link-btn" type="button" data-party-edit="' + escapeHtml(p.id) + '">Add them</button></div>') + '</div>';
}
/* Someone in the master with no open items (so not in any source's list). */
function mgOpenMasterParty(id){
  const p = (khataParties || []).find(x => x.id === id); if(!p) return;
  const dir = p.type === 'vendor' ? 'pay' : 'recv';
  const bal = typeof khataPartyBalance === 'function' ? khataPartyBalance(p.id) : 0;
  mgDrawer({
    title:p.name,
    sub:escapeHtml((p.type === 'both' ? 'Customer and vendor' : p.type === 'vendor' ? 'Vendor' : 'Customer') + ' · no open ' + (dir === 'recv' ? 'invoices' : 'bills')),
    body:mgPartyProfileHtml(p, dir) + (bal ? '<div class="mg-fine" style="margin-top:12px">Invoicing balance: ' + escapeHtml(fmtINR(Math.abs(bal))) + (bal > 0 ? ' receivable' : ' payable') + '</div>' : ''),
    foot:(p.type !== 'vendor' ? '<button class="mg-btn primary" type="button" data-party-invoice="' + escapeHtml(p.id) + '">New invoice</button>' : '<button class="mg-btn primary" type="button" data-party-bill="' + escapeHtml(p.name) + '">Add a bill</button>')
  });
}

/* ---------- clicks ---------- */
document.addEventListener('click', e => {
  const t = e.target;
  const nw = t.closest('[data-party-new]');
  if(nw){ mgPartyForm({ dir:nw.dataset.partyNew, name:nw.dataset.partyName || '' }); return; }
  const add = t.closest('[data-party-add-dir]');
  if(add){ const title = document.getElementById('mgDrawerTitle'); mgPartyForm({ dir:add.dataset.partyAddDir, name:title ? title.textContent : '' }); return; }
  const ed = t.closest('[data-party-edit]');
  if(ed){ const p = (khataParties || []).find(x => x.id === ed.dataset.partyEdit); if(p) mgPartyForm({ party:p }); return; }
  const mo = t.closest('[data-open-master]');
  if(mo && !t.closest('button')){ mgOpenMasterParty(mo.dataset.openMaster); return; }
  const inv = t.closest('[data-party-invoice]');
  if(inv){
    mgCloseDrawer(); mgGo('invoicing');
    if(typeof showKhataTab === 'function') showKhataTab('invoice-new');
    setTimeout(() => { const s = document.getElementById('invCustomer'); if(s && [...s.options].some(o => o.value === inv.dataset.partyInvoice)){ s.value = inv.dataset.partyInvoice; s.dispatchEvent(new Event('change', { bubbles:true })); } }, 60);
    return;
  }
  const bill = t.closest('[data-party-bill]');
  if(bill){
    mgCloseDrawer(); ledgerActiveTab = 'payables'; ledgerAddOpen = true; showView('ledger');
    setTimeout(() => { const f = document.getElementById('ledgerParty'); if(f){ f.value = bill.dataset.partyBill; const a = document.getElementById('ledgerAmt'); if(a) a.focus(); } }, 80);
  }
});

/* ---------- import review: who each invoice/bill belongs to ----------
   Shown under every receivable/payable the AI found. The default is the
   existing party when there is a confident match, otherwise "create new".
   `key` identifies the entry in its card (upload: "u3", WhatsApp: "2:3"). */
function mgImportPartyHtml(e, key){
  if(!e || (e.target !== 'receivable' && e.target !== 'payable') || !e.party) return '';
  const dir = e.target === 'payable' ? 'pay' : 'recv', who = mgPartyWho(dir);
  const d = e.party_details || {};
  const m = mgFindMasterParty(e.party, d.gstin, dir);
  const detail = [d.gstin && 'GSTIN ' + d.gstin, d.state, d.phone].filter(Boolean).join(' · ');
  if(m.party) return '<div class="mg-imp-party ok">✓ Existing ' + who + ': <b>' + escapeHtml(m.party.name) + '</b>' + (m.how === 'gstin' ? ' (same GSTIN)' : '') +
    '<input type="hidden" data-imp-party="' + escapeHtml(key) + '" value="id:' + escapeHtml(m.party.id) + '"></div>';
  const known = mgKnownSpelling(e.party, dir);
  const opts = [['new', 'Create new ' + who + ': “' + (known ? known.name : e.party) + '”' + (known ? ' (as in ' + (MG_SRC_NAME[known.src] || known.src) + ')' : '')]]
    .concat(m.near.map(p => ['id:' + p.id, 'Use existing: ' + p.name]))
    .concat([['skip', 'Don’t add to my ' + who + 's']]);
  return '<div class="mg-imp-party new"><span>New ' + who + '</span><select data-imp-party="' + escapeHtml(key) + '">' +
    opts.map(([v, l]) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(l) + '</option>').join('') + '</select>' +
    (detail ? '<span class="mg-fine">' + escapeHtml(detail) + '</span>' : '') + '</div>';
}
/* Apply the choices: create the parties that need creating (once each,
   even if a file has five invoices for the same new customer) and stamp
   every entry with its canonical name and party_id. Returns what was created. */
async function mgResolveImportParties(entries, keys, source){
  const made = new Map(), created = [];
  for(let i = 0; i < entries.length; i++){
    const e = entries[i];
    if(e.target !== 'receivable' && e.target !== 'payable') continue;
    const dir = e.target === 'payable' ? 'pay' : 'recv';
    const sel = document.querySelector('[data-imp-party="' + keys[i] + '"]');
    const choice = sel ? sel.value : 'new';
    if(choice === 'skip' || !e.party) continue;
    let p = null;
    if(choice.startsWith('id:')) p = (khataParties || []).find(x => x.id === choice.slice(3)) || null;
    else {
      const k = normPartyName(e.party) + '|' + dir;
      if(made.has(k)) p = made.get(k);
      else {
        const r = await mgEnsureParty({ name:e.party, dir, details:e.party_details, source, create:true });
        p = r.party; made.set(k, p); if(r.created) created.push(p);
      }
    }
    if(p){ e.party = p.name; e.party_id = p.id; }
  }
  return created;
}
