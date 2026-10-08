/** Run: node api/_lib/__tests__/tallyAnalyticsEndpoint.test.js — fake Supabase, no network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };

const U = '11111111-1111-1111-1111-111111111111';
const DB = {
  tally_installs: [{ id: 'i1', tally_edition: 'educational', company_name: 'Acme Ltd', last_sync_at: new Date().toISOString(), user_id: U, status: 'active' }],
  tally_ledgers: [
    { name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: 1000 },
    { name: 'Purchases', parent: 'Purchase Accounts', opening_balance: 0, closing_balance: -400 },
    { name: 'Weird', parent: 'Zzz', opening_balance: 0, closing_balance: -10 }
  ],
  tally_bills: [{ direction: 'receivable', party_name: 'P', bill_ref: '1', closing_balance: 500, overdue_days: 5 }],
  tally_vouchers: [
    { voucher_type: 'Sales', voucher_number: '1', date: '20260701', party_name: 'P', amount: 1000, is_cancelled: false, entries: [{ ledger: 'P', amount: -1000, is_party: true }, { ledger: 'Sales', amount: 1000 }] },
    { voucher_type: 'Purchase', voucher_number: '1', date: '20260702', party_name: 'S', amount: 400, is_cancelled: false, entries: [{ ledger: 'S', amount: 400, is_party: true }, { ledger: 'Purchases', amount: -400 }, { ledger: 'Weird', amount: -10 }] }
  ],
  tally_ledger_classes: [],
  tally_sync_runs: [{ kind: 'vouchers', status: 'error', error_message: 'Tally: timeout', rows_received: 0, started_at: '2026-09-29T00:00:00Z' }],
  ledger_events: []
};
let itemsColumnExists = false;
const writes = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.pathname === '/auth/v1/user') return ok({ id: U, email: 'a@b.c' });
  const table = u.pathname.replace('/rest/v1/', '');
  if ((opts.method || 'GET') === 'GET') {
    if (table === 'tally_vouchers' && /select=[^&]*items/.test(u.search) && !itemsColumnExists) return ok({ message: 'column tally_vouchers.items does not exist' }, 400);
    const rows = DB[table] || [];
    const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
    return ok(rows.slice(off, off + lim));
  }
  writes.push({ table, method: opts.method, body: opts.body, search: u.search });
  if (opts.method === 'POST') { const b = JSON.parse(opts.body); DB[table].push(...b); return ok(b); }
  return ok([]);
};

const handler = require('../../tally.js');
const call = async (method, query, body) => {
  let status, payload;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(p) { payload = p; return this; }, end() {} };
  await handler({ method, query, headers: { authorization: 'Bearer t' }, body }, res);
  return { status, payload };
};

(async () => {
  let r = await call('GET', { action: 'analytics' });
  check('analytics 200 and connected', r.status === 200 && r.payload.connected === true, r);
  check('falls back when items column is missing', r.payload.pnl && r.payload.pnl.length === 1, r.payload.pnl);
  check('gross margin computed', r.payload.pnl[0].gross_margin_pct_pre_stock === 60, r.payload.pnl[0]);
  check('unknown ledger asked about', r.payload.questions.some((q) => q.ledger === 'Weird'), r.payload.questions);
  check('last sync failure and edition reach the confidence story', r.payload.quality.reasons.some((x) => /vouchers sync from Tally failed/.test(x)) && r.payload.quality.reasons.some((x) => /Educational/.test(x)), r.payload.quality.reasons);
  check('company reported', r.payload.company_name === 'Acme Ltd' && r.payload.companies.length === 1);

  r = await call('POST', { action: 'classify' }, { ledger: 'Weird', bucket: 'opex', company: 'Acme Ltd' });
  check('classify saves', r.status === 200 && writes.some((w) => w.table === 'tally_ledger_classes' && /on_conflict/.test(w.search)), r);
  r = await call('GET', { action: 'analytics' });
  check('override applied to next analytics call', r.payload.pnl[0].opex === 10 && !r.payload.questions.some((q) => q.ledger === 'Weird'), r.payload.pnl[0]);

  const ev = DB.ledger_events[0];
  check('classify is written to the audit log', ev && ev.entity_type === 'margin mapping' && ev.party_name === 'Weird' && /opex/.test(ev.note) && ev.source === 'tally', DB.ledger_events);
  r = await call('POST', { action: 'classify' }, { ledger: 'Weird', bucket: 'nonsense' });
  check('no audit row for a rejected change', DB.ledger_events.length === 1);
  check('bad bucket rejected', r.status === 400);
  r = await call('POST', { action: 'classify' }, { bucket: 'opex' });
  check('missing ledger rejected', r.status === 400);

  // a second active install on the same company must not double the books
  DB.tally_installs.push({ id: 'i2', tally_edition: 'educational', company_name: 'Acme Ltd', last_sync_at: new Date().toISOString(), user_id: U, status: 'active' });
  const v0 = DB.tally_vouchers.map((v, i) => Object.assign({}, v, { tally_guid: 'g' + i }));
  DB.tally_vouchers = v0.concat(v0.map((v) => Object.assign({}, v)));
  r = await call('GET', { action: 'analytics' });
  check('duplicate installs do not double sales', r.payload.period.gross_sales === 1000, r.payload.period);
  DB.tally_installs.pop(); DB.tally_vouchers = v0;

  itemsColumnExists = true;
  DB.tally_vouchers[0].items = [{ item: 'W', qty: 10, unit: 'Nos', rate: 100, amount: 1000, abs_amount: 1000 }];
  // Rows only change through a sync, which moves last_sync_at (the books are read once per sync).
  DB.tally_installs.forEach((i) => { i.last_sync_at = new Date(Date.now() + 1000).toISOString(); });
  r = await call('GET', { action: 'analytics' });
  check('items flow through once the column exists', r.payload.items_available === true && r.payload.items.length === 1, r.payload.items);

  DB.tally_installs = [];
  r = await call('GET', { action: 'analytics' });
  check('not connected is a clean 200', r.status === 200 && r.payload.connected === false);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
