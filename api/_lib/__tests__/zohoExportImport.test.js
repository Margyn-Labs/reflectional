/**
 * Zoho Books item lines on every plan (ZOHO-AUDIT-2026-10-31.md "Slow item fill"):
 *   fix a  — Zoho's own export dropped into Import (importMapper.detectZohoExport / parseZohoExport,
 *            _zoho/exportImport.js): same lines as the API, documents marked read, only later edits re-read,
 *            active connection only, no Zoho calls;
 *   paid   — plan names → daily allowance, Zoho's own X-Rate-Limit headers win, the follow-on fill
 *            (handleFillChain) keeps going while documents and allowance are left, and the ETA on the Zoho card.
 * Zero-dep, no network, timers fast-forwarded.
 * Run: node api/_lib/__tests__/zohoExportImport.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
const items = require('../../_zoho/items');
const exp = require('../../_zoho/exportImport');
const { detectZohoExport, parseZohoExport } = require('../importMapper');
const { createSession, dailyCapFor } = require('../zohoClient');

const T = H.makeChecker();
const { check } = T;
const REFRESH = '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const ORG = 'org-1';

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (n) => { r.statusCode = n; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** Three invoices, one bill, one credit note, held by Margyn; their detail reads as Zoho's API returns them. */
function world({ plan = 'free', usedToday = 0, headers } = {}) {
  const db = new H.FakeDb();
  const zoho = new H.FakeZoho();
  const strays = H.installFetch(db, zoho);
  db.t('zoho_organizations').push({ id: ORG, user_id: 'user-1', organization_id: '60082308675', organization_name: 'Demo', api_domain: zoho.apiDomain,
    accounts_domain: zoho.accountsDomain, status: 'active', plan_type: plan, connected_at: '2026-10-30T00:00:00Z', backfill_completed_at: '2026-10-30T00:00:00Z' });
  // An old, disconnected connection to the same Zoho org, holding the same invoice numbers.
  db.t('zoho_organizations').push({ id: 'org-old', user_id: 'user-1', organization_id: '60082308675', status: 'disconnected', plan_type: plan, connected_at: '2026-10-01T00:00:00Z' });
  db.t('zoho_invoices').push({ org_ref: 'org-old', invoice_id: 'OLD1', invoice_number: 'INV-1', invoice_date: '2026-10-05', status: 'sent', last_modified_time: '2026-10-05T10:00:00Z' });
  db.vault[ORG] = REFRESH;
  db.users['jwt-user-1'] = { id: 'user-1', email: 'u@example.in' };
  if (usedToday) db.t('zoho_sync_state').push({ org_ref: ORG, module: 'api_calls', last_synced_at: new Date().toISOString(), remote_count: usedToday });
  zoho.collection('books/v3/items', 'items', [
    { item_id: 'IT1', name: 'Gauze Swab 10cm', sku: 'GZ-10', unit: 'box', rate: 120, purchase_rate: 80, status: 'active' },
    { item_id: 'IT2', name: 'Surgical Mask', sku: 'SM-1', unit: 'pcs', rate: 10, purchase_rate: 12, status: 'active' },
    { item_id: 'IT3', name: 'Hand Rub 500ml', unit: 'btl', rate: 250, purchase_rate: 0, status: 'active' }
  ]);
  for (const [id, date, status, lm] of [['I1', '2026-10-05', 'sent', '2026-10-05T10:00:00Z'], ['I2', '2026-10-20', 'paid', '2026-10-21T10:00:00Z'], ['I3', '2026-06-01', 'sent', '2026-06-02T10:00:00Z'], ['I9', '2026-09-09', 'void', '2026-09-10T10:00:00Z']]) {
    db.t('zoho_invoices').push({ org_ref: ORG, invoice_id: id, invoice_number: 'INV-' + id.slice(1), invoice_date: date, status, last_modified_time: lm });
  }
  db.t('zoho_bills').push({ org_ref: ORG, bill_id: 'B1', bill_number: 'SUP-1', bill_date: '2026-09-01', status: 'paid', last_modified_time: '2026-09-01T10:00:00Z' });
  zoho.collection('books/v3/creditnotes', 'creditnotes', [{ creditnote_id: 'CN1', creditnote_number: 'CN-00001', date: '2026-10-15', status: 'open', last_modified_time: '2026-10-15T10:00:00+0000' }]);
  zoho.collection('books/v3/vendorcredits', 'vendorcredits', []);
  const line = (id, item, qty, rate, extra) => Object.assign({ line_item_id: id, item_id: item, name: item, quantity: qty, unit: 'box', rate, bcy_rate: rate, item_total: qty * rate, tax_percentage: 0 }, extra || {});
  const docs = {
    'invoices/I1': { invoice: { invoice_id: 'I1', date: '2026-10-05', status: 'sent', exchange_rate: 1, line_items: [line('L11', 'IT1', 10, 120), line('L12', 'IT2', 100, 10)] } },
    // Inclusive tax at 18%, and a 10% discount before tax on the whole invoice.
    'invoices/I2': { invoice: { invoice_id: 'I2', date: '2026-10-20', status: 'paid', exchange_rate: 1, is_inclusive_tax: true, discount_type: 'entity_level', is_discount_before_tax: true, discount: '10%',
      line_items: [line('L21', 'IT1', 5, 118, { tax_percentage: 18 }), { line_item_id: 'L22', item_id: '', name: 'Freight', quantity: 1, rate: 300, item_total: 300 }] } },
    'invoices/I3': { invoice: { invoice_id: 'I3', date: '2026-06-01', status: 'sent', exchange_rate: 1, line_items: [line('L31', 'IT3', 4, 250)] } },
    'bills/B1': { bill: { bill_id: 'B1', date: '2026-09-01', status: 'paid', exchange_rate: 1, line_items: [line('LB1', 'IT1', 100, 80), line('LB2', 'IT2', 1000, 12)] } },
    'creditnotes/CN1': { creditnote: { creditnote_id: 'CN1', date: '2026-10-15', status: 'open', exchange_rate: 1, line_items: [line('LC1', 'IT1', 2, 120)] } }
  };
  for (const [p, body] of Object.entries(docs)) zoho.route('books/v3/' + p, () => {
    const r = H.json(200, Object.assign({ code: 0, message: 'success' }, body));
    if (headers) for (const [k, v] of Object.entries(headers())) r.headers.set(k, String(v));
    return r;
  });
  return { db, zoho, strays, docs, org: () => db.t('zoho_organizations')[0] };
}

// The same documents, as Zoho's export writes them: one row per line, the document's fields repeated, Indian dates.
const INV_HEADER = ['Invoice Date', 'Invoice ID', 'Invoice Number', 'Invoice Status', 'Customer Name', 'Exchange Rate', 'Is Inclusive Tax', 'Discount Type', 'Is Discount Before Tax',
  'Entity Discount Percent', 'Entity Discount Amount', 'Item Name', 'SKU', 'Product ID', 'Quantity', 'Usage unit', 'Item Price', 'Item Tax %', 'Item Total', 'Total'];
const invoiceExport = () => [
  INV_HEADER,
  ['05/10/2026', '', 'INV-1', 'Sent', 'Alpha', '1', 'false', '', '', '', '', 'Gauze Swab 10cm', 'GZ-10', '', '10', 'box', '120.00', '0', '1,200.00', '2200'],
  ['05/10/2026', '', 'INV-1', 'Sent', 'Alpha', '1', 'false', '', '', '', '', 'Surgical Mask', '', '', '100', 'pcs', '10.00', '0', '1000', '2200'],
  ['20/10/2026', '', 'INV-2', 'Paid', 'Beta', '1', 'true', 'entity_level', 'true', '10', '', 'gauze swab 10CM', '', '', '5', 'box', '118', '18', '590', '890'],
  ['20/10/2026', '', 'INV-2', 'Paid', 'Beta', '1', 'true', 'entity_level', 'true', '10', '', '', '', '', '', '', '', '', '', '890'],   // free-text freight line, no item
  ['01/06/2026', '', 'INV-3', 'Sent', 'Gamma', '1', 'false', '', '', '', '', 'Hand Rub 500ml', '', 'IT3', '4', 'btl', '250', '0', '₹1,000.00', '1000'],
  ['09/09/2026', '', 'INV-9', 'Void', 'Delta', '1', 'false', '', '', '', '', 'Surgical Mask', '', '', '1', 'pcs', '10', '0', '10', '10'],
  ['01/01/2026', '', 'INV-404', 'Sent', 'Nobody', '1', 'false', '', '', '', '', 'Surgical Mask', '', '', '1', 'pcs', '10', '0', '10', '10']
];
const billExport = () => [
  ['Bill Date', 'Bill Number', 'Bill Status', 'Vendor Name', 'Item Name', 'SKU', 'Quantity', 'Rate', 'Item Total'],
  ['2026-09-01', 'SUP-1', 'Paid', 'Apex', 'Gauze Swab 10cm', '', '100', '80', '8000'],
  ['2026-09-01', 'SUP-1', 'Paid', 'Apex', 'Unknown Widget', 'SM-1', '1000', '12', '12000'],   // name differs, SKU matches
];
const cnExport = () => [
  ['Credit Note Date', 'Credit Note Number', 'Credit Note Status', 'Invoice Number', 'Item Name', 'Quantity', 'Item Price', 'Item Total'],
  ['15/10/2026', 'CN-00001', 'Open', 'INV-1', 'Gauze Swab 10cm', '2', '120', '240']
];

const key = (l) => [l.doc_type, l.doc_id, l.item_id, l.qty, l.value, l.doc_date].join('|');
const sortedKeys = (rows) => rows.map(key).sort();
const details = (zoho) => zoho.calls.filter((c) => /books\/v3\/(invoices|bills|creditnotes|vendorcredits)\/[^/]+$/.test(c.path)).map((c) => c.path.split('/').pop());

(async () => {
  const timers = H.fastTimers();
  const origErr = console.error, origLog = console.log;
  console.error = () => {};
  try {
    console.log('# detect: Zoho\'s export header, any type, and nothing else');
    {
      check('invoices export', detectZohoExport(INV_HEADER).doc_type === 'invoice');
      check('bills export (Rate, not Item Price)', detectZohoExport(billExport()[0]).doc_type === 'bill');
      check('credit notes export carrying an Invoice Number is still credit notes', detectZohoExport(cnExport()[0]).doc_type === 'creditnote');
      check('vendor credits export', detectZohoExport(['Vendor Credit Date', 'Vendor Credit Number', 'Item Name', 'Quantity', 'Item Total']).doc_type === 'vendorcredit');
      check('snake_case headers read the same', detectZohoExport(['invoice_number', 'item_name', 'quantity', 'item_total']).doc_type === 'invoice');
      check('Margyn\'s own template is not a Zoho export', detectZohoExport(['Party', 'Invoice', 'Amount', 'Due date']) === null);
      check('a document list without line items is not one', detectZohoExport(['Invoice Number', 'Customer Name', 'Total', 'Balance']) === null);
    }

    console.log('# parse: grouped by document, numbers with ₹ and commas, free-text lines dropped');
    {
      const p = parseZohoExport([['Exported from Zoho Books'], ...invoiceExport()]);
      check('header found below a title row', p && p.doc_type === 'invoice');
      check('five documents, in file order', p.documents.map((d) => d.number).join() === 'INV-1,INV-2,INV-3,INV-9,INV-404', p.documents.map((d) => d.number));
      check('INV-1 has two lines, ₹ and commas read', p.documents[0].lines.length === 2 && p.documents[0].lines[0].item_total === 1200 && p.documents[2].lines[0].item_total === 1000, p.documents[0].lines);
      check('free-text line dropped', p.documents[1].lines.length === 1 && p.skipped === 1, p.documents[1]);
      check('inclusive tax and document discount carried', p.documents[1].is_inclusive_tax === true && p.documents[1].discount && p.documents[1].discount.percent === 10, p.documents[1]);
      check('Indian date read day first', p.documents[0].date === '2026-10-05', p.documents[0].date);
      const noTotal = parseZohoExport([['Invoice Number', 'Item Name', 'Quantity', 'Item Price'], ['INV-1', 'Gauze Swab 10cm', '3', '120']]);
      check('no Item Total column: quantity × price', noTotal.documents[0].lines[0].item_total === 360);
    }

    console.log('# import = the API, line for line (same values, same document dates)');
    const A = world();   // read by the API
    await items.syncItemLines(createSession(A.org()), A.org(), 'user-1', {});
    const apiLines = A.db.t('zoho_document_lines');
    const E = world();   // the same books, filled from the export instead
    const org = E.org();
    // The queue has listed the credit note once (a first sync), so its number is known.
    await items.syncItemLines(createSession(org), org, 'user-1', { deadline: Date.now() - 1 });
    E.zoho.calls.length = 0;
    const inv = await exp.importExportRows(org, invoiceExport());
    const bil = await exp.importExportRows(org, billExport());
    const cn = await exp.importExportRows(org, cnExport());
    {
      check('no Zoho calls made by the import', E.zoho.calls.length === 0 && E.strays.length === 0, E.zoho.calls.map((c) => c.path));
      check('invoices: 3 written, void skipped, unknown number reported', inv.written === 3 && inv.dead === 1 && inv.not_found === 1 && inv.not_found_numbers[0] === 'INV-404', inv);
      check('bill: unknown name matched by SKU', bil.written === 1 && bil.lines === 2 && bil.unknown_items === 0, bil);
      check('credit note matched by its number on the line queue', cn.written === 1 && cn.lines === 1, cn);
      const mine = E.db.t('zoho_document_lines');
      check('every line equal to the API\'s (item, qty, value, date)', JSON.stringify(sortedKeys(mine)) === JSON.stringify(sortedKeys(apiLines)), { exp: sortedKeys(mine), api: sortedKeys(apiLines) });
      check('inclusive tax backed out and 10% discount spread: 5 × 118 → ₹450', mine.find((l) => l.doc_id === 'I2').value === 450, mine.find((l) => l.doc_id === 'I2'));
      check('only the active connection: the old one\'s INV-1 untouched', !mine.some((l) => l.doc_id === 'OLD1' || l.org_ref === 'org-old'));
      const st = (id) => E.db.t('zoho_line_state').find((s) => s.doc_id === id);
      check('documents marked read at the version Margyn knows', st('I1') && st('I1').lines_read_at && new Date(st('I1').read_modified).getTime() === new Date('2026-10-05T10:00:00Z').getTime(), st('I1'));
      check('progress: everything in', items.progressFrom(E.db.t('zoho_line_state')).pending === 0, items.progressFrom(E.db.t('zoho_line_state')));
    }

    console.log('# after the import the API queue reads only later edits');
    {
      E.zoho.calls.length = 0;
      await items.syncItemLines(createSession(E.org()), E.org(), 'user-1', {});
      check('nothing re-read', details(E.zoho).length === 0, details(E.zoho));
      E.db.t('zoho_invoices').find((i) => i.invoice_id === 'I3').last_modified_time = new Date().toISOString();   // edited in Zoho after the export
      E.zoho.calls.length = 0;
      await items.syncItemLines(createSession(E.org()), E.org(), 'user-1', {});
      check('the edited invoice alone is read again', details(E.zoho).join() === 'I3', details(E.zoho));
      const again = await exp.importExportRows(E.org(), invoiceExport());
      check('importing the same file again changes nothing already read', again.written === 0 && again.already_read === 3, again);
    }

    console.log('# Import page endpoint');
    {
      const W = world();
      const r0 = mockRes();
      await exp.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { rows: invoiceExport() } }, r0);
      check('before the item list is synced: asks for Sync now, writes nothing', r0.statusCode === 409 && /Sync now/.test(r0.body.error) && W.db.t('zoho_line_state').length === 0, r0.body);
      await items.syncItemLines(createSession(W.org()), W.org(), 'user-1', { deadline: Date.now() - 1 });   // item master in, nothing read
      const res = mockRes();
      await exp.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { rows: invoiceExport() } }, res);
      check('signed-in owner: lines written', res.statusCode === 200 && res.body.written === 3 && W.db.t('zoho_document_lines').length === 4, res.body);
      Object.assign(W.db.t('zoho_line_state').find((s) => s.doc_id === 'I1'), { lines_read_at: null, read_modified: null });   // not read yet
      const renamed = invoiceExport().map((r, i) => (i === 2 ? r.map((v, k) => (k === 11 ? 'Mask (old name)' : v)) : r));
      const r1 = await exp.importExportRows(W.org(), renamed);
      const st1 = W.db.t('zoho_line_state').find((s) => s.doc_id === 'I1');
      check('a line with an item Margyn doesn\'t know: that document stays with the API queue', r1.left_for_api === 1 && r1.unknown_items === 1 && items.needsRead(st1), { r1, st1 });
      const r2 = mockRes();
      await exp.handler({ method: 'POST', headers: {}, body: { rows: invoiceExport() } }, r2);
      check('needs a signed-in owner', r2.statusCode === 401);
      const r3 = mockRes();
      await exp.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { rows: [['Party', 'Amount'], ['A', '1']] } }, r3);
      check('another spreadsheet is refused (the AI import handles it)', r3.statusCode === 400);
    }

    console.log('# plan allowance: names as Zoho sends them');
    {
      const caps = { Free: 1000, Standard: 2000, 'Standard (Annual)': 2000, Professional: 5000, 'Professional Plan': 5000, Premium: 10000, Elite: 10000, Ultimate: 10000, Basic: 2000, 'Premium Trial': 1000, '': 1000, Mystery: 1000 };
      for (const [name, cap] of Object.entries(caps)) check(`"${name}" → ${cap}`, dailyCapFor(name) === cap, dailyCapFor(name));
    }

    console.log('# Zoho\'s own X-Rate-Limit headers win over the plan table');
    {
      // A trial org says "trial" (1,000 by our table) but Zoho reports 10,000 left: the queue uses Zoho's figure.
      let remaining = 9000;
      const R = world({ plan: 'Premium Trial', usedToday: 790, headers: () => ({ 'X-Rate-Limit-Limit': 10000, 'X-Rate-Limit-Remaining': --remaining }) });
      const out = await items.syncItemLines(createSession(R.org()), R.org(), 'user-1', {});
      check('reads past the table\'s budget once Zoho says there is room', out.stopped === 'done' && out.documents_read === 5, out);
      const lim = R.db.t('zoho_sync_state').find((s) => s.module === 'api_limit');
      check('Zoho\'s allowance remembered for the next run', lim && lim.remote_count === 10000, lim);
      check('and used as the day\'s cap', (await items.dailyCap(R.org())) === 10000);
      remaining = 203;
      const S = world({ plan: 'Professional', headers: () => ({ 'X-Rate-Limit-Limit': 5000, 'X-Rate-Limit-Remaining': --remaining }) });
      const o2 = await items.syncItemLines(createSession(S.org()), S.org(), 'user-1', {});
      check('Zoho says only the reserve is left: stops even though our ledger shows room', o2.stopped === 'budget' && o2.documents_read < 5, o2);
    }

    console.log('# when it will be done (the Zoho card)');
    {
      const eta = items.fillEta;
      check('nothing left', eta({ pending: 0, cap: 1000, usedToday: 0 }).when === 'done');
      check('Professional, 3,000 documents, fresh day: today, about 36 minutes', JSON.stringify(eta({ pending: 3000, cap: 5000, usedToday: 300 })) === JSON.stringify({ when: 'today', minutes: 36 }), eta({ pending: 3000, cap: 5000, usedToday: 300 }));
      check('fits in today but no fill running (a lost hop, or none started): by tomorrow morning, never a stuck "minutes"', eta({ pending: 3000, cap: 5000, usedToday: 300, running: false }).when === 'tomorrow_morning');
      check('Standard, 2,500 documents after today\'s 1,800 used: tomorrow morning', eta({ pending: 1700, cap: 2000, usedToday: 1800 }).when === 'tomorrow_morning', eta({ pending: 1700, cap: 2000, usedToday: 1800 }));
      check('Free, 1,053 documents with 526 read and today spent: 1 night', eta({ pending: 527, cap: 1000, usedToday: 800 }).when === 'tomorrow_morning');
      const free = eta({ pending: 3000, cap: 1000, usedToday: 800 });
      check('Free, 3,000 documents: about 5 days', free.when === 'days' && free.days === 5, free);
    }

    console.log('# follow-on fill: keeps going while documents and allowance are left');
    {
      process.env.CRON_SECRET = 'cron-s';
      process.env.ZOHO_REDIRECT_URI = 'https://www.margynlabs.com/api/zoho-oauth-callback';
      const C = world({ plan: 'Professional' });
      const hops = [];
      const realFetch = global.fetch;
      global.fetch = async (url, init) => {
        if (String(url).startsWith('https://www.margynlabs.com/')) { hops.push({ url: String(url), auth: init.headers.Authorization }); return H.json(200, {}); }
        return realFetch(url, init);
      };
      const r0 = mockRes();
      await items.handleFillChain({ headers: {}, query: { hop: '1' } }, r0);
      check('needs the cron secret', r0.statusCode === 401);
      // First run hits the deadline with documents left (time, not allowance): hand on to the next hop.
      await items.syncItemLines(createSession(C.org()), C.org(), 'user-1', { deadline: Date.now() - 1 });   // lists the documents
      const realNow = Date.now;
      let calls = 0;
      C.zoho.onCall = () => { if (++calls === 3) Date.now = () => realNow() + 10 * 60 * 1000; };   // time runs out mid-run
      const r1 = mockRes();
      await items.handleFillChain({ headers: { authorization: 'Bearer cron-s' }, query: { hop: '1' } }, r1);
      Date.now = realNow; C.zoho.onCall = null;
      check('hop 1 read some, stopped on time', r1.statusCode === 200 && r1.body.orgs[0].stopped === 'time' && r1.body.orgs[0].pending > 0, r1.body);
      check('hop 2 started, same secret, production origin', hops.length === 1 && /\/api\/zoho\?action=fill-chain&hop=2$/.test(hops[0].url) && hops[0].auth === 'Bearer cron-s', hops);
      const r2 = mockRes();
      await items.handleFillChain({ headers: { authorization: 'Bearer cron-s' }, query: { hop: '2' } }, r2);
      check('hop 2 finishes the queue and starts no more', r2.body.orgs[0].stopped === 'done' && r2.body.next_hop === null && hops.length === 1, r2.body);
      const r3 = mockRes();
      await items.handleFillChain({ headers: { authorization: 'Bearer cron-s' }, query: { hop: '3' } }, r3);
      check('nothing left: no Zoho calls, no hop', r3.body.orgs.length === 0 && r3.body.next_hop === null, r3.body);
      // Allowance down to the reserve: nothing is read and no hop starts.
      const D = world({ usedToday: 800 });
      await items.syncItemLines(createSession(D.org()), D.org(), 'user-1', { deadline: Date.now() - 1, usedBefore: 0 });
      D.zoho.calls.length = 0;
      global.fetch = async (url, init) => (String(url).startsWith('https://www.margynlabs.com/') ? (hops.push(url), H.json(200, {})) : realFetch(url, init));
      const r4 = mockRes();
      await items.handleFillChain({ headers: { authorization: 'Bearer cron-s' }, query: { hop: '1' } }, r4);
      check('Free plan with only the reserve left: skipped', r4.body.orgs.length === 0 && D.zoho.calls.length === 0 && hops.length === 1, r4.body);
      check('never more than CHAIN_MAX_HOPS', (await items.triggerFillChain(items.CHAIN_MAX_HOPS + 1)) === false);
      delete process.env.ZOHO_REDIRECT_URI;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      check('no production address known: no hop, nothing breaks', (await items.triggerFillChain(2)) === false);
      global.fetch = realFetch;
    }
  } finally {
    timers.restore();
    console.error = origErr;
    console.log = origLog;
  }
  T.done();
})().catch((e) => { console.error(e); process.exit(1); });
