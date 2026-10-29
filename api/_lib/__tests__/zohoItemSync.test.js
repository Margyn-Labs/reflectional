/**
 * api/_zoho/items.js: the Zoho Books item-line queue, against an in-memory PostgREST and Zoho Books
 * (zohoHarness). Budget cap (plan cap − calls spent today − 200), newest first with this financial year first,
 * incremental (unchanged documents never re-read), void / deleted documents lose their lines, a 429 stops the
 * run and the next run resumes, a missing credit-note scope skips only credit notes, and the line value
 * (base currency, inclusive tax backed out, document discount spread pro rata). Also "Fill now" and the nightly
 * hook in sync.js. Zero-dep, no network, timers fast-forwarded.
 * Run: node api/_lib/__tests__/zohoItemSync.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
const items = require('../../_zoho/items');
const sync = require('../../_zoho/sync');
const { createSession } = require('../zohoClient');

const T = H.makeChecker();
const { check } = T;
const REFRESH = '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const ORG = 'org-1';
const now = Date.now();
const istToday = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const fyYear = (() => { const d = new Date(now + 5.5 * 3600e3); return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; })();
const lastFy = (fyYear - 1) + '-12-15';            // last financial year
const thisFy = (m, d) => fyYear + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const zt = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+0000');

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (n) => { r.statusCode = n; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** A small business: 6 invoices, 2 bills, 1 credit note, 1 vendor credit, 3 items. */
function world({ plan = 'free', usedToday = 0, creditScope = true } = {}) {
  const db = new H.FakeDb();
  const zoho = new H.FakeZoho();
  const strays = H.installFetch(db, zoho);
  db.t('zoho_organizations').push({ id: ORG, user_id: 'user-1', organization_id: '60082308675', organization_name: 'Demo', api_domain: zoho.apiDomain,
    accounts_domain: zoho.accountsDomain, status: 'active', plan_type: plan, connected_at: new Date().toISOString(), backfill_completed_at: new Date().toISOString() });
  db.vault[ORG] = REFRESH;
  db.users['jwt-user-1'] = { id: 'user-1', email: 'u@example.in' };
  if (usedToday) db.t('zoho_sync_state').push({ org_ref: ORG, module: 'api_calls', last_synced_at: new Date(now).toISOString(), remote_count: usedToday });

  zoho.collection('books/v3/items', 'items', [
    { item_id: 'IT1', name: 'Gauze Swab 10cm', unit: 'box', rate: 120, purchase_rate: 80, item_type: 'sales_and_purchases', product_type: 'goods', status: 'active' },
    { item_id: 'IT2', name: 'Surgical Mask', unit: 'pcs', rate: 10, purchase_rate: 12, item_type: 'sales_and_purchases', product_type: 'goods', status: 'active' },
    { item_id: 'IT3', name: 'Hand Rub 500ml', unit: 'btl', rate: 250, purchase_rate: 0, item_type: 'sales', product_type: 'goods', status: 'active' }
  ]);
  // Stored by the money sync already (zoho_invoices / zoho_bills).
  const inv = [
    ['I1', thisFy(10, 5), 'sent', '2026-10-05T10:00:00Z'], ['I2', thisFy(10, 20), 'paid', '2026-10-21T10:00:00Z'], ['I3', thisFy(6, 1), 'sent', '2026-10-28T10:00:00Z'],
    ['I4', lastFy, 'paid', '2026-10-29T10:00:00Z'], ['I5', thisFy(9, 9), 'void', '2026-09-10T10:00:00Z'], ['I6', thisFy(8, 1), 'sent', '2026-08-01T10:00:00Z']
  ];
  for (const [id, date, status, lm] of inv) db.t('zoho_invoices').push({ org_ref: ORG, invoice_id: id, invoice_number: 'INV-' + id, invoice_date: date, status, last_modified_time: lm });
  db.t('zoho_bills').push({ org_ref: ORG, bill_id: 'B1', bill_number: 'SUP-1', bill_date: thisFy(9, 1), status: 'paid', last_modified_time: '2026-09-01T10:00:00Z' },
    { org_ref: ORG, bill_id: 'B2', bill_number: 'SUP-2', bill_date: thisFy(10, 2), status: 'open', last_modified_time: '2026-10-02T10:00:00Z' });
  if (creditScope) zoho.collection('books/v3/creditnotes', 'creditnotes', [{ creditnote_id: 'CN1', creditnote_number: 'CN-1', date: thisFy(10, 15), status: 'open', last_modified_time: zt('2026-10-15T10:00:00Z') }]);
  else zoho.route('books/v3/creditnotes', () => H.json(401, { code: 57, message: 'You are not authorized to perform this operation' }));
  zoho.collection('books/v3/vendorcredits', 'vendorcredits', [{ vendor_credit_id: 'VC1', vendor_credit_number: 'DN-1', date: thisFy(10, 16), status: 'open', last_modified_time: zt('2026-10-16T10:00:00Z') }]);

  const line = (id, item, qty, rate, extra) => Object.assign({ line_item_id: id, item_id: item, name: item, quantity: qty, unit: 'box', rate, bcy_rate: rate, item_total: qty * rate, tax_percentage: 0, discount_amount: 0 }, extra || {});
  const docs = {
    'invoices/I1': { invoice: { invoice_id: 'I1', date: thisFy(10, 5), status: 'sent', exchange_rate: 1, line_items: [line('L11', 'IT1', 10, 120), line('L12', 'IT2', 100, 10)] } },
    'invoices/I2': { invoice: { invoice_id: 'I2', date: thisFy(10, 20), status: 'paid', exchange_rate: 1, line_items: [line('L21', 'IT1', 5, 118), { line_item_id: 'L22', item_id: '', name: 'Freight', quantity: 1, rate: 300, item_total: 300 }] } },
    'invoices/I3': { invoice: { invoice_id: 'I3', date: thisFy(6, 1), status: 'sent', exchange_rate: 1, line_items: [line('L31', 'IT3', 4, 250)] } },
    'invoices/I4': { invoice: { invoice_id: 'I4', date: lastFy, status: 'paid', exchange_rate: 1, line_items: [line('L41', 'IT1', 1, 100)] } },
    'invoices/I6': { invoice: { invoice_id: 'I6', date: thisFy(8, 1), status: 'sent', exchange_rate: 1, line_items: [line('L61', 'IT2', 50, 10)] } },
    'bills/B1': { bill: { bill_id: 'B1', date: thisFy(9, 1), status: 'paid', exchange_rate: 1, line_items: [line('LB1', 'IT1', 100, 80)] } },
    'bills/B2': { bill: { bill_id: 'B2', date: thisFy(10, 2), status: 'open', exchange_rate: 1, line_items: [line('LB2', 'IT2', 1000, 12)] } },
    'creditnotes/CN1': { creditnote: { creditnote_id: 'CN1', date: thisFy(10, 15), status: 'open', exchange_rate: 1, line_items: [line('LC1', 'IT1', 2, 120)] } },
    'vendorcredits/VC1': { vendor_credit: { vendor_credit_id: 'VC1', date: thisFy(10, 16), status: 'open', exchange_rate: 1, line_items: [line('LV1', 'IT2', 50, 12)] } }
  };
  for (const [p, body] of Object.entries(docs)) zoho.route('books/v3/' + p, () => H.json(200, Object.assign({ code: 0, message: 'success' }, body)));
  // I5 is void (never read). A detail route for it would be a bug.
  zoho.route('books/v3/invoices/I5', () => { throw new Error('void invoice must not be read'); });
  return { db, zoho, strays, docs, org: () => db.t('zoho_organizations')[0] };
}

const details = (zoho) => zoho.calls.filter((c) => /books\/v3\/(invoices|bills|creditnotes|vendorcredits)\/[^/]+$/.test(c.path)).map((c) => c.path.split('/').pop());
const lines = (db, id) => db.t('zoho_document_lines').filter((l) => l.doc_id === id);
const st = (db, id) => db.t('zoho_line_state').find((s) => s.doc_id === id);
const run = (W, extra) => items.syncItemLines(createSession(W.org()), W.org(), 'user-1', extra);

(async () => {
  const timers = H.fastTimers();
  const origErr = console.error;
  console.error = () => {};
  try {
    console.log('# line value: base currency, inclusive tax out, document discount spread pro rata');
    {
      const doc = { invoice_id: 'X', date: '2026-10-01', exchange_rate: 80, is_inclusive_tax: true, discount_type: 'entity_level', is_discount_before_tax: true, discount: '10%',
        line_items: [
          { line_item_id: 'a', item_id: 'P', name: 'P', quantity: -2, rate: 59, bcy_rate: 4720, item_total: 118, tax_percentage: 18, location_name: 'Vasai Godown' },
          { line_item_id: 'b', item_id: 'Q', name: 'Q', quantity: 1, rate: 118, bcy_rate: 9440, item_total: 118, tax_percentage: 18 },
          { line_item_id: 'c', item_id: '', name: 'Note line', quantity: 1, rate: 0, item_total: 0 }] };
      const r = items.documentLines(doc, 'invoice', ORG);
      // 118 incl. 18% -> 100 before tax; x80 -> 8,000; 10% document discount -> 7,200.
      check('free-text lines left out', r.length === 2, r.map((x) => x.item_id));
      check('value = item_total x bcy_rate/rate, tax backed out, discount spread', r[0].value === 7200 && r[1].value === 7200, r.map((x) => x.value));
      check('qty always positive, godown from location_name', r[0].qty === 2 && r[0].location_name === 'Vasai Godown', r[0]);
      const flat = items.documentLines({ bill_id: 'B', exchange_rate: 1, discount_type: 'entity_level', is_discount_before_tax: true, discount_amount: 300,
        line_items: [{ line_item_id: 'x', item_id: 'P', quantity: 1, rate: 1000, bcy_rate: 1000, item_total: 1000 }, { line_item_id: 'y', item_id: 'Q', quantity: 2, rate: 1000, bcy_rate: 1000, item_total: 2000 }] }, 'bill', ORG);
      check('flat discount split 1:2', flat[0].value === 900 && flat[1].value === 1800, flat.map((x) => x.value));
      const after = items.documentLines({ invoice_id: 'Y', discount_type: 'entity_level', is_discount_before_tax: false, discount: 500, line_items: [{ line_item_id: 'z', item_id: 'P', quantity: 1, rate: 1000, bcy_rate: 1000, item_total: 1000 }] }, 'invoice', ORG);
      check('discount after tax leaves the line alone', after[0].value === 1000, after[0].value);
      const billNet = items.documentLines({ bill_id: 'C', is_inclusive_tax: true, line_items: [{ line_item_id: 'w', item_id: 'P', quantity: 1, rate: 100, bcy_rate: 100, item_total: 100, item_total_inclusive_of_tax: 118, tax_percentage: 18 }] }, 'bill', ORG);
      check('bill line already net of tax (item_total_inclusive_of_tax sent) is not reduced twice', billNet[0].value === 100, billNet[0].value);
    }

    console.log('# first run reads everything, newest first, this financial year first');
    const W = world();
    {
      const out = await run(W);
      check('item master stored', W.db.t('zoho_items').length === 3 && W.db.t('zoho_items').find((i) => i.item_id === 'IT2').purchase_rate === 12);
      const order = details(W.zoho);
      check('void invoice never read', !order.includes('I5'));
      check('order: this FY newest first, last FY last', order.join() === ['I2', 'VC1', 'CN1', 'I1', 'B2', 'B1', 'I6', 'I3', 'I4'].join(), order);
      check('all lines stored (free-text line left out)', W.db.t('zoho_document_lines').length === 10 && lines(W.db, 'I2').length === 1, W.db.t('zoho_document_lines').map((l) => l.line_item_id));
      check('done, nothing pending', out.stopped === 'done' && out.pending === 0 && out.documents_read === 9, out);
      check('each document marked read at its modified time', st(W.db, 'I1').lines_read_at && new Date(st(W.db, 'I1').read_modified).getTime() === new Date('2026-10-05T10:00:00Z').getTime());
      // The clock barely moves under fast timers, so each read after the first waits about one more 650 ms gap:
      // 650, 1300, ... 5200 (a millisecond or two of real time comes off).
      const gaps = timers.delays.filter((d) => d >= 600).sort((a, b) => a - b);
      check('reads paced: call starts 650 ms apart across the readers', gaps.length === 8 && gaps.every((d, k) => Math.abs(d - 650 * (k + 1)) <= 10), timers.delays);
      check('reads three at a time', items.READERS === 3);
      check('no network strays', W.strays.length === 0, W.strays);
    }

    console.log('# incremental: unchanged documents are not re-read');
    {
      W.zoho.calls.length = 0;
      await run(W);
      check('second run reads no document', details(W.zoho).length === 0, details(W.zoho));
      const i1 = W.db.t('zoho_invoices').find((i) => i.invoice_id === 'I1');
      i1.last_modified_time = new Date(now).toISOString();   // edited in Zoho, picked up by the money sync
      W.docs['invoices/I1'].invoice.line_items = [{ line_item_id: 'L13', item_id: 'IT1', quantity: 12, rate: 120, bcy_rate: 120, item_total: 1440 }];
      W.zoho.route('books/v3/invoices/I1', () => H.json(200, Object.assign({ code: 0 }, W.docs['invoices/I1'])));
      W.zoho.calls.length = 0;
      await run(W);
      check('only the edited invoice is re-read', details(W.zoho).join() === 'I1', details(W.zoho));
      check('its old lines replaced', lines(W.db, 'I1').length === 1 && lines(W.db, 'I1')[0].line_item_id === 'L13' && lines(W.db, 'I1')[0].value === 1440, lines(W.db, 'I1'));
    }

    console.log('# void and deleted documents lose their lines');
    {
      const i6 = W.db.t('zoho_invoices').find((i) => i.invoice_id === 'I6');
      i6.status = 'void'; i6.last_modified_time = new Date(now).toISOString();
      const i3 = W.db.t('zoho_invoices').find((i) => i.invoice_id === 'I3');
      i3.last_modified_time = new Date(now).toISOString();
      W.zoho.route('books/v3/invoices/I3', () => H.json(404, { code: 1002, message: 'Invoice does not exist.' }));
      W.zoho.calls.length = 0;
      const out = await run(W);
      check('voided invoice: lines dropped without a call', lines(W.db, 'I6').length === 0 && !details(W.zoho).includes('I6'), lines(W.db, 'I6'));
      check('invoice gone from Zoho (404): lines dropped', lines(W.db, 'I3').length === 0 && st(W.db, 'I3').line_count === 0, lines(W.db, 'I3'));
      check('run still clean', !out.error && out.stopped === 'done', out);
    }

    console.log('# budget: plan cap − calls spent today − 200 reserve');
    {
      const B = world({ usedToday: 1000 - 200 - 6 });   // 6 calls left: items, credit notes, vendor credits, then 3 details
      const out = await run(B);
      check('stops on budget with documents left', out.stopped === 'budget' && out.documents_read === 3 && out.pending === 6, out);
      check('never past the reserve', B.zoho.calls.length === 6, B.zoho.calls.length);
      check('read the newest three', details(B.zoho).join() === 'I2,VC1,CN1', details(B.zoho));
      const none = world({ usedToday: 800 });
      const o2 = await run(none);
      check('nothing at all once only the reserve is left', o2.stopped === 'budget' && none.zoho.calls.length === 0, o2);
      const paid = world({ plan: 'standard', usedToday: 1000 });
      const o3 = await run(paid);
      check('standard plan: 2,000 a day, so the same spend still leaves room', o3.stopped === 'done', o3);
    }

    console.log('# time: stops at the deadline');
    {
      const W2 = world();
      const out = await run(W2, { deadline: Date.now() - 1 });
      check('deadline passed: no detail reads, all pending', out.stopped === 'time' && details(W2.zoho).length === 0 && out.pending === 9, out);
    }

    console.log('# 429: stop for this run, resume next run');
    {
      const R = world();
      R.zoho.fault((c) => c.path === 'books/v3/creditnotes/CN1', () => H.json(429, { code: 45, message: 'API call limit exceeded' }));
      const out = await run(R);
      check('stops at the first 429, no retries', out.stopped === 'rate_limited' && R.zoho.calls.filter((c) => c.path === 'books/v3/creditnotes/CN1').length === 1, out);
      check('what was read before the 429 is kept', lines(R.db, 'I2').length === 1 && lines(R.db, 'VC1').length === 1 && !st(R.db, 'CN1').lines_read_at);
      R.zoho.calls.length = 0;
      const o2 = await run(R);
      check('next run resumes at the credit note', details(R.zoho)[0] === 'CN1' && o2.stopped === 'done' && lines(R.db, 'CN1').length === 1, details(R.zoho));
    }

    console.log('# no creditnotes.READ yet (connected before the scope): only credit notes are skipped');
    {
      const S = world({ creditScope: false });
      const out = await run(S);
      check('credit notes unavailable, everything else read', out.unavailable.includes('creditnote') && out.stopped === 'done' && lines(S.db, 'VC1').length === 1 && !st(S.db, 'CN1'), out);
      check('connection not marked for reconnect', S.org().status === 'active');
    }

    console.log('# Fill now: same reserve, records the calls it spent');
    {
      const F = world({ usedToday: 300 });
      const res = mockRes();
      await items.handleFillNow({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' } }, res);
      check('fill now reads the queue', res.statusCode === 200 && res.body.documents_read === 9 && res.body.progress.pending === 0, res.body);
      const ledger = F.db.t('zoho_sync_state').find((s) => s.module === 'api_calls');
      check('today\'s spend recorded (300 + this run)', ledger && ledger.remote_count === 300 + res.body.api_calls_used, ledger);
      const G = world({ usedToday: 795 });
      const r2 = mockRes();
      await items.handleFillNow({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' } }, r2);
      check('fill now keeps 200 calls spare', r2.body.stopped === 'budget' && G.zoho.calls.length <= 5, { body: r2.body, calls: G.zoho.calls.length });
      const r3 = mockRes();
      await items.handleFillNow({ method: 'POST', headers: {} }, r3);
      check('fill now needs a signed-in owner', r3.statusCode === 401);
    }

    console.log('# deployed before the SQL ran: skipped quietly');
    {
      const M = world();
      const realHandle = M.db.handle.bind(M.db);
      M.db.handle = async (url, init) => (/rest\/v1\/zoho_items/.test(url) ? H.json(404, { code: 'PGRST205', message: "Could not find the table 'public.zoho_items' in the schema cache" }) : realHandle(url, init));
      const out = await run(M);
      check('no error, nothing read, sync stays clean', out.stopped === 'not_migrated' && !out.error && details(M.zoho).length === 0, out);
    }

    console.log('# progress');
    {
      const p = items.progressFrom([{ status: 'sent', doc_date: '2026-10-01', lines_read_at: 'x', read_modified: '2026-10-01T00:00:00Z', doc_last_modified: '2026-10-01T00:00:00Z' },
        { status: 'sent', doc_date: '2026-06-01', lines_read_at: null }, { status: 'void', doc_date: '2026-09-01', lines_read_at: null }]);
      check('read / pending / complete after the latest unread date', p.documents === 2 && p.read === 1 && p.pending === 1 && p.complete_after === '2026-06-01', p);
    }

    console.log('# nightly: the money sync then the item queue, calls recorded for the day');
    {
      const N = world();
      for (const [p, k] of [['invoices', 'invoices'], ['bills', 'bills'], ['customerpayments', 'customerpayments'], ['vendorpayments', 'vendorpayments'], ['bankaccounts', 'bankaccounts'], ['chartofaccounts', 'chartofaccounts']]) N.zoho.collection('books/v3/' + p, k, []);
      N.zoho.route('books/v3/contacts', () => H.json(200, { code: 0, contacts: [], page_context: { has_more_page: false } }));
      const r = await sync.syncZohoForUser('user-1', 'delta');
      check('sync reports the item step', r.item_lines && r.item_lines.documents_read === 9 && r.breakdown.item_documents === 9, r.item_lines);
      const ledger = N.db.t('zoho_sync_state').find((s) => s.module === 'api_calls');
      check('the run\'s calls are recorded against today (IST)', ledger && ledger.remote_count === r.api_calls_used && new Date(new Date(ledger.last_synced_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) === istToday, ledger);
    }

    console.log('# Sales by Item report probe: one call, weekly until it works, never fatal');
    {
      const P = world();
      let hits = 0;
      P.zoho.route('books/v3/reports/salesbyitem', () => { hits++; return H.json(401, { code: 57, message: 'You are not authorized to perform this operation' }); });
      const org = P.db.t('zoho_organizations')[0];
      const refused = await items.probeItemReports(createSession(org), org);
      const row = () => P.db.t('zoho_sync_state').find((x) => x.module === 'probe:salesbyitem');
      check('refused: recorded as error, nothing thrown', refused && refused.status === 'error' && row() && row().last_run_status === 'error');
      check('refused: connection not marked for reconnect', P.db.t('zoho_organizations')[0].status === 'active');
      check('refused: not asked again inside a week', (await items.probeItemReports(createSession(org), org)) === null && hits === 1);
      const later = Date.now() + 8 * 24 * 3600e3;
      P.zoho.route('books/v3/reports/salesbyitem', () => { hits++; return H.json(200, { code: 0, sales: [{ item_id: 'IT1', quantity_sold: 557, amount: 89120 }] }); });
      const ok = await items.probeItemReports(createSession(org), org, later);
      check('a week on: asked again, success recorded with the item count', ok && ok.status === 'success' && row().last_run_status === 'success' && row().remote_count === 1 && hits === 2, ok);
      check('after success: never asked again', (await items.probeItemReports(createSession(org), org, later + 30 * 24 * 3600e3)) === null && hits === 2);
    }
  } finally {
    timers.restore();
    console.error = origErr;
  }
  T.done();
})().catch((e) => { console.error(e); process.exit(1); });
