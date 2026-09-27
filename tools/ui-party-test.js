// Party master test: New customer/vendor on the Customers and Vendors pages,
// duplicate and GSTIN checks, "Add to customers" from a source-only party,
// the import review creating new parties once and linking items by
// party_id, Margyn's create_ledger_item adding a missing party, and the
// retry path before 2026-09-27-party-master.sql has run.
// Usage: node tools/serve-static.js &   then   node tools/ui-party-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };

// Replaces the seed's write stub for the tables this feature writes, so
// inserts return the row (with an id) and every write is recorded.
function writableStub(opts){
  const T = window.__seedTables, base = sbClient.from;
  window.__w = [];
  let n = 0;
  sbClient.from = (table) => {
    if(!['ledger_parties', 'receivables', 'payables', 'ledger_events'].includes(table)) return base(table);
    let rows = T[table].slice(), payload = null, op = 'select', filt = {};
    const run = () => {
      if(op === 'select') return { data:rows.filter(r => Object.keys(filt).every(k => k === 'user_id' || r[k] === filt[k])), error:null };
      const list = Array.isArray(payload) ? payload : [payload];
      if(opts && opts.noNewCols && list.some(r => 'state' in r || 'party_id' in r)) return { data:null, error:{ code:'PGRST204', message:"Could not find the 'state' column of '" + table + "' in the schema cache" } };
      window.__w.push({ table, op, payload:JSON.parse(JSON.stringify(payload)), filt });
      if(op === 'insert'){ const made = list.map(r => Object.assign({ id:table + '-' + (++n) }, r)); T[table].push(...made); return { data:made, error:null }; }
      if(op === 'update'){ const hit = T[table].filter(r => r.id === filt.id); hit.forEach(r => Object.assign(r, payload)); return { data:hit, error:null }; }
      return { data:null, error:null };
    };
    const b = new Proxy({}, { get(_, prop){
      if(prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if(prop === 'single' || prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data:r.data ? r.data[0] : null, error:r.error }); };
      if(prop === 'insert' || prop === 'update'){ return (p) => { op = prop; payload = p; return b; }; }
      if(prop === 'eq') return (k, v) => { filt[k] = v; return b; };
      return () => b;
    } });
    return b;
  };
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const boot = async (stubOpts) => {
    await p.goto('about:blank'); await p.goto(B);
    await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });
    await p.waitForTimeout(400); await p.evaluate(seedApp); await p.waitForTimeout(700);
    await p.evaluate(writableStub, stubOpts || {});
  };
  const fill = async (name, v) => p.fill('.mg-drawer [name="' + name + '"]', v);

  // 1. Customers page: New customer button, GSTIN fills state + PAN, saved to ledger_parties
  await boot();
  await p.evaluate(() => mgGo('customers')); await p.waitForTimeout(300);
  ok(await p.isVisible('#view-customers [data-party-new="recv"]'), 'Customers page has a New customer button');
  ok(/GSTIN/.test(await p.textContent('#view-customers thead')), 'Customers table has a GSTIN column');
  await p.click('#view-customers [data-party-new="recv"]'); await p.waitForTimeout(200);
  ok(await p.isVisible('.mg-drawer .mg-pf'), 'New customer form opens in the drawer');
  await fill('name', 'Test Traders'); await fill('gstin', '29abcde1234f1z5');
  ok(await p.inputValue('.mg-drawer [name="state"]') === 'Karnataka', 'GSTIN fills the state (Karnataka)');
  ok(await p.inputValue('.mg-drawer [name="pan"]') === 'ABCDE1234F', 'GSTIN fills the PAN');
  await fill('phone', '9845012345'); await fill('credit_days', '30');
  await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(400);
  const ins = await p.evaluate(() => window.__w.filter(w => w.table === 'ledger_parties' && w.op === 'insert').map(w => w.payload));
  ok(ins.length === 1 && ins[0].name === 'Test Traders' && ins[0].type === 'customer' && ins[0].gstin === '29ABCDE1234F1Z5' && ins[0].state === 'Karnataka' && ins[0].credit_days === 30 && ins[0].source === 'manual', 'saved: ' + JSON.stringify(ins[0]));
  ok(!(await p.isVisible('.mg-drawer')), 'drawer closes after save');
  ok(await p.isVisible('#view-customers [data-open-master]'), 'new customer with no invoices is listed ("Your list")');
  ok(/Test Traders/.test(await p.textContent('#view-customers tbody')), 'Test Traders is in the Customers list');
  ok(await p.evaluate(() => [...document.querySelectorAll('#invCustomer option')].some(o => o.textContent === 'Test Traders')), 'and in the invoice customer picker');
  ok(await p.evaluate(() => window.__w.some(w => w.table === 'ledger_events' && w.payload.entity_type === 'party' && w.payload.event === 'created')), 'party creation is in the activity log');

  // 2. duplicates and bad input are blocked
  await p.click('#view-customers [data-party-new="recv"]'); await p.waitForTimeout(200);
  await fill('name', 'KAVERI STORES'); await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(200);
  ok(/already in your list/.test(await p.textContent('.mg-pf-msg')), 'duplicate name blocked: ' + await p.textContent('.mg-pf-msg'));
  await fill('name', 'Someone New'); await fill('gstin', '29AAKFK7781M1Z9'); await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(200);
  ok(/same GSTIN/.test(await p.textContent('.mg-pf-msg')), 'duplicate GSTIN blocked');
  await fill('gstin', '12345'); await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(200);
  ok(/GSTIN doesn’t look right/.test(await p.textContent('.mg-pf-msg')), 'malformed GSTIN blocked');
  await fill('gstin', ''); await fill('name', 'Kaveri'); await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(200);
  ok(/Similar name/.test(await p.textContent('.mg-pf-msg')) && (await p.textContent('.mg-drawer [data-pf-save]')) === 'Save anyway', 'similar name asks for a second click');
  ok(await p.evaluate(() => window.__w.filter(w => w.table === 'ledger_parties' && w.op === 'insert').length) === 1, 'nothing extra was written');
  await p.click('.mg-drawer [data-drawer-close]');

  // 3. a party only a source knows about: drawer offers "Add to customers", prefilled
  await p.click('#view-customers tr[data-open-party="bluedoorinteriors"]'); await p.waitForTimeout(250);
  ok(/Not in your customer list yet/.test(await p.textContent('.mg-drawer')), 'source-only customer shows "Not in your customer list yet"');
  await p.click('.mg-drawer [data-party-add-dir]'); await p.waitForTimeout(200);
  ok(await p.inputValue('.mg-drawer [name="name"]') === 'Blue Door Interiors', 'Add to customers opens the form with the name filled');
  await p.click('.mg-drawer [data-drawer-close]');
  await p.click('#view-customers tr[data-open-party="kaveristores"]'); await p.waitForTimeout(250);
  ok(/29AAKFK7781M1Z9/.test(await p.textContent('.mg-drawer')) && await p.isVisible('.mg-drawer [data-party-edit]'), 'saved customer drawer shows GSTIN and Edit');
  await p.click('.mg-drawer [data-party-edit]'); await p.waitForTimeout(200);
  await fill('email', 'accounts@kaveri.test'); await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(300);
  const up = await p.evaluate(() => window.__w.filter(w => w.table === 'ledger_parties' && w.op === 'update').map(w => w.payload));
  ok(up.length === 1 && up[0].email === 'accounts@kaveri.test' && up[0].gstin === '29AAKFK7781M1Z9', 'edit saves an update keeping the GSTIN');

  // 4. Vendors page
  await p.evaluate(() => mgGo('vendors')); await p.waitForTimeout(250);
  ok(await p.isVisible('#view-vendors [data-party-new="pay"]'), 'Vendors page has a New vendor button');

  // 5. import: existing party matched, new party created once for two invoices, known Zoho spelling used, items linked
  await p.evaluate(() => { showView('calculate'); renderImportReview({ entries:[
    { target:'receivable', label:'INV-1', amount:50000, party:'Kaveri Stores', confidence:0.9 },
    { target:'receivable', label:'INV-2', amount:20000, party:'New Horizon Foods', party_details:{ gstin:'27AAACN1234B1Z3', state:'Maharashtra', phone:'+91 98200 11111' }, confidence:0.9 },
    { target:'receivable', label:'INV-3', amount:30000, party:'NEW HORIZON FOODS PVT LTD', confidence:0.9 },
    { target:'payable', label:'BILL-9', amount:40000, party:'omkar steel fabricators', confidence:0.9 },
    { target:'payable', label:'BILL-10', amount:5000, party:'Skip Me Ltd', confidence:0.9 }
  ], anomalies:[], unmapped:[] }); });
  await p.waitForTimeout(200);
  const rev = await p.textContent('#aiReview');
  ok(/Existing customer: Kaveri Stores/.test(rev), 'import review: existing customer recognised');
  ok(/Create new customer: “New Horizon Foods”/.test(rev) && /GSTIN 27AAACN1234B1Z3/.test(rev), 'import review: new customer offered, with the GSTIN from the document');
  ok(/“Omkar Steel Fabricators” \(as in Zoho Books\)/.test(rev), 'import review: new vendor takes the Zoho Books spelling');
  await p.selectOption('#aiReview select[data-imp-party="u4"]', 'skip');
  await p.evaluate(() => { window.__w = []; });
  await p.click('#confirmImportBtn'); await p.waitForTimeout(900);
  const w5 = await p.evaluate(() => window.__w);
  const newParties = w5.filter(w => w.table === 'ledger_parties' && w.op === 'insert').map(w => w.payload);
  ok(newParties.length === 2, 'import created 2 parties (Horizon once, Omkar), not Skip Me: ' + newParties.map(x => x.name + '/' + x.type + '/' + x.source).join(', '));
  ok(newParties.some(x => x.name === 'New Horizon Foods' && x.gstin === '27AAACN1234B1Z3' && x.state === 'Maharashtra' && x.source === 'import'), 'new customer carries the document GSTIN/state, source import');
  ok(newParties.some(x => x.name === 'Omkar Steel Fabricators' && x.type === 'vendor'), 'new vendor saved with the books spelling');
  const recv = (w5.find(w => w.table === 'receivables' && w.op === 'insert') || {}).payload || [];
  const pay = (w5.find(w => w.table === 'payables' && w.op === 'insert') || {}).payload || [];
  ok(recv.length === 3 && recv.every(r => r.party_id) && recv.filter(r => r.party_name === 'New Horizon Foods').length === 2, 'all 3 receivables linked by party_id, both Horizon invoices under one name');
  ok(pay.length === 2 && pay.find(r => r.party_name === 'Skip Me Ltd' && !r.party_id) && pay.find(r => r.party_name === 'Omkar Steel Fabricators' && r.party_id), 'payables: Omkar linked, "don’t add" left unlinked');

  // 6. Margyn's create_ledger_item adds a missing customer, and the card says so
  const card = await p.evaluate(() => actionCardHtml({ type:'create_ledger_item', targetKind:'receivable', payload:{ party:'Fresh Farms', amount:12000 }, humanSummary:'Log ₹12,000 invoice for Fresh Farms' }));
  ok(/isn’t in your customers yet/.test(card), 'confirm card says the customer is new');
  await p.evaluate(() => { window.__w = []; });
  await p.evaluate(() => runProposedAction({ type:'create_ledger_item', targetKind:'receivable', payload:{ party:'Fresh Farms', amount:12000 } }));
  await p.waitForTimeout(400);
  const w6 = await p.evaluate(() => window.__w);
  const fp = w6.find(w => w.table === 'ledger_parties' && w.op === 'insert');
  const fr = w6.find(w => w.table === 'receivables' && w.op === 'insert');
  ok(fp && fp.payload.name === 'Fresh Farms' && fp.payload.source === 'margyn', 'create_ledger_item added Fresh Farms as a customer (source margyn)');
  ok(fr && !!fr.payload[0].party_id, 'invoice has party_id');

  // 7. before the migration: extra columns rejected -> retried without them
  await boot({ noNewCols:true });
  await p.evaluate(() => mgGo('customers')); await p.waitForTimeout(250);
  await p.click('#view-customers [data-party-new="recv"]'); await p.waitForTimeout(200);
  await fill('name', 'Old Schema Co'); await fill('gstin', '29ABCDE1234F1Z5');
  await p.click('.mg-drawer [data-pf-save]'); await p.waitForTimeout(400);
  const old = await p.evaluate(() => window.__w.filter(w => w.table === 'ledger_parties' && w.op === 'insert').map(w => w.payload));
  ok(old.length === 1 && !('state' in old[0]) && old[0].gstin === '29ABCDE1234F1Z5', 'pre-migration: saved without the new columns');
  await p.evaluate(() => runProposedAction({ type:'create_ledger_item', targetKind:'payable', payload:{ party:'Legacy Vendor', amount:900 } }));
  await p.waitForTimeout(400);
  const oldPay = await p.evaluate(() => window.__w.filter(w => w.table === 'payables' && w.op === 'insert').map(w => w.payload));
  ok(oldPay.length === 1 && !('party_id' in oldPay[0][0]), 'pre-migration: payable written without party_id');

  // 8. phone width: form is one column, no horizontal scroll
  await p.setViewportSize({ width:390, height:844 });
  await p.evaluate(() => mgPartyForm({ dir:'recv' })); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390px');
  await p.screenshot({ path:process.env.SHOT_DIR ? process.env.SHOT_DIR + '/party-form-phone.png' : '/tmp/party-form-phone.png' });

  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
