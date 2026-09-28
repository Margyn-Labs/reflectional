/**
 * Server money model + actor — zero-dep. Run: node api/_lib/__tests__/moneyModel.test.js
 * No network: fetch is an in-memory fake over a small table store.
 *
 * The parity section pulls mgMoneyGroups() and its helpers straight out of
 * app/js, runs them in a sandbox over the same rows, and requires the server
 * to give the same answer. If either side changes the rules, this fails.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

/* ---------- fake Supabase (PostgREST subset: eq, in, gt, is.null, order, limit, offset) ---------- */
const DB = {};
const calls = [];
function applyQuery(rows, qs) {
  const p = new URLSearchParams(qs);
  let out = rows.slice();
  for (const [k, v] of p) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter((r) => String(r[k]) === v.slice(3));
    else if (v.startsWith('gt.')) out = out.filter((r) => Number(r[k]) > Number(v.slice(3)));
    else if (v === 'is.null') out = out.filter((r) => r[k] == null);
    else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(','); out = out.filter((r) => set.includes(String(r[k]))); }
  }
  const off = Number(p.get('offset') || 0), lim = p.get('limit') ? Number(p.get('limit')) : Infinity;
  return out.slice(off, off + lim);
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  if (u.pathname === '/auth/v1/user') {
    const tok = (opts.headers.Authorization || '').replace('Bearer ', '');
    return tok === 'good' ? { ok: true, json: async () => ({ id: 'u1', email: 'owner@x.in' }) } : { ok: false, json: async () => ({}) };
  }
  if (u.pathname === '/rest/v1/rpc/zoho_vitals') {
    const body = JSON.parse(opts.body);
    const org = (DB.zoho_organizations || []).find((o) => o.user_id === body.p_user_id);
    return { ok: true, json: async () => (org ? { connected: true, org_ref: org.id } : { connected: false }) };
  }
  const table = u.pathname.replace('/rest/v1/', '');
  if (DB[table] === 'ERR') return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
  return { ok: true, json: async () => applyQuery(DB[table] || [], u.search.slice(1)) };
};

const M = require('../moneyModel');
const A = require('../actor');
const { selectAllRows } = require('../supabaseRest');

/* ---------- pure ---------- */
const T = '2026-09-29';
check('todayIST: 29 Sep 20:00 UTC is 30 Sep in India', M.todayIST(new Date('2026-09-29T20:00:00Z')) === '2026-09-30');
check('todayIST: 29 Sep 06:00 UTC is 29 Sep in India', M.todayIST(new Date('2026-09-29T06:00:00Z')) === '2026-09-29');
check('daysBetween: due tomorrow = 1, overdue 10 = -10, none = null',
  M.daysBetween(T, '2026-09-30') === 1 && M.daysBetween(T, '2026-09-19') === -10 && M.daysBetween(T, null) === null);
check('daysBetween: timestamp is cut to its date', M.daysBetween(T, '2026-10-01T00:00:00+05:30') === 2);
check('buckets', M.bucketOf(null) === 'b0' && M.bucketOf(5) === 'b0' && M.bucketOf(-30) === 'b0' && M.bucketOf(-31) === 'b1' && M.bucketOf(-61) === 'b2' && M.bucketOf(-91) === 'b3');
check('normPartyName strips legal suffixes', M.normPartyName('Sharma Traders Pvt. Ltd.') === M.normPartyName('sharma traders'));

const rowsA = [
  { party: 'Acme Pvt Ltd', amount: 100000, due: '2026-08-01', ref: 'M1', src: 'manual' },
  { party: 'Acme', amount: 60000, due: '2026-09-01', ref: 'Z1', src: 'zoho' },
  { party: 'ACME LIMITED', amount: 40000, due: '2026-10-10', ref: 'Z2', src: 'zoho' },
  { party: 'Beta Co', amount: 50000, due: '2026-09-25', ref: 'Z3', src: 'zoho' },
  { party: 'Beta', amount: 50500, due: '2026-09-25', ref: 'T1', src: 'tally' },
  { party: 'Gamma', amount: 20000, due: null, ref: 'O1', src: 'odoo' }
];
const pos = M.position(rowsA, T);
const acme = pos.groups.find((g) => g.party === 'Acme Pvt Ltd');
check('Acme: Zoho outranks manual, amount is Zoho 1,00,000 (never 2,00,000)', acme && acme.primary === 'zoho' && acme.amount === 100000, acme);
check('Acme: sources agree (100000 vs 100000)', acme.status === 'agree');
check('Beta: 50,000 vs 50,500 is within 2% -> agree', pos.groups.find((g) => g.key === 'beta').status === 'agree');
check('Gamma: one source -> single', pos.groups.find((g) => g.key === 'gamma').status === 'single');
check('total = sum of each party once = 1,70,000', pos.totals.total === 170000, pos.totals);
check('overdue uses the primary source rows only (Acme Z1 60k + Beta Z3 50k)', pos.totals.overdue === 110000, pos.totals);
check('by_source kept apart: manual 1,00,000, zoho 1,50,000', pos.totals.by_source.manual.total === 100000 && pos.totals.by_source.zoho.total === 150000, pos.totals.by_source);
check('ageing sums to the total', Object.values(pos.totals.ageing).reduce((a, b) => a + b, 0) === pos.totals.total);
check('sorted largest first', pos.groups[0].party === 'Acme Pvt Ltd');
check('rows omitted when withRows=false', !M.position(rowsA, T, { withRows: false }).groups[0].by.zoho.rows);
const conflict = M.position([{ party: 'X', amount: 1000, src: 'zoho' }, { party: 'X', amount: 900, src: 'manual' }], T).groups[0];
check('10% gap -> conflict, diff 100', conflict.status === 'conflict' && conflict.diff === 100);

/* ---------- parity with the browser ---------- */
function extract(file, name, kind = 'function') {
  const src = fs.readFileSync(path.join(__dirname, '../../../app/js', file), 'utf8');
  const start = src.indexOf(kind === 'function' ? `function ${name}(` : `const ${name} =`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  if (kind === 'const') return src.slice(start, src.indexOf(';\n', start) + 1);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const browserSrc = [
  extract('07-ledger.js', 'normPartyName'),
  extract('07-ledger.js', 'unifiedLedgerRows'),
  extract('03-data.js', 'daysFromToday'),
  extract('19-pages.js', 'MG_SRC_ORDER', 'const'),
  extract('19-pages.js', 'mgMoneyRows'),
  extract('19-pages.js', 'mgMoneyGroups')
].join('\n') + '\nthis.groups = mgMoneyGroups;';

function browserGroups(dir, inputs) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super('2026-09-29T06:00:00Z'); }
    static now() { return new RealDate('2026-09-29T06:00:00Z').getTime(); }
  }
  const ctx = Object.assign({ Date: FixedDate, Math, Number, String, Set, Map, Object, console }, inputs);
  vm.createContext(ctx);
  vm.runInContext(browserSrc, ctx);
  return ctx.groups(dir);
}

// A mixed book: manual + upload rows, Zoho, Tally, Odoo; name variants,
// agreement, conflict, missing due dates, several invoices per party.
const fx = {
  receivables: [
    { party_name: 'Sharma Traders Pvt Ltd', amount: 120000, due_date: '2026-07-15', source: 'manual' },
    { party_name: 'Kiran Stores', amount: 30000, due_date: '2026-10-20', source: 'upload' },
    { party_name: 'Only Manual LLP', amount: 9000, due_date: null, source: 'manual' }
  ],
  zoho: [
    { party_name: 'Sharma Traders', amount: 80000, due_date: '2026-08-01', ref: 'INV-1' },
    { party_name: 'SHARMA TRADERS', amount: 40000, due_date: '2026-09-28', ref: 'INV-2' },
    { party_name: 'Kiran Stores', amount: 45000, due_date: '2026-10-02', ref: 'INV-3' }
  ],
  tally: [
    { direction: 'receivable', party_name: 'Kiran Stores', amount: 44800, due_date: '2026-10-02', bill_ref: 'T-9' },
    { direction: 'receivable', party_name: 'Delta Exports', amount: 70000, due_date: '2026-05-01', bill_ref: 'T-10' },
    { direction: 'payable', party_name: 'Paper Mill', amount: 15000, due_date: '2026-09-30', bill_ref: 'T-11' }
  ],
  odoo: [
    { party_name: 'Delta Exports', amount: 90000, due_date: '2026-05-01', ref: 'O-1' },
    { party_name: 'Nova Labs', amount: 12000, due_date: '2026-09-10', ref: 'O-2' }
  ],
  payables: [{ party_name: 'Paper Mill Pvt Ltd', amount: 15000, due_date: '2026-09-30', source: 'manual' }]
};
function browserInputs() {
  return {
    receivables: fx.receivables, payables: fx.payables,
    zohoLedgerRows: { receivables: fx.zoho, payables: [] },
    tallyData: { bills: { items: fx.tally } },
    odooConnected: true,
    odooStatus: { receivables: { items: fx.odoo }, payables: { items: [] } }
  };
}
function serverRows(dir) {
  const rows = [];
  (dir === 'recv' ? fx.receivables : fx.payables).forEach((r) => rows.push({ party: r.party_name, amount: r.amount, due: r.due_date, ref: null, src: 'manual' }));
  if (dir === 'recv') fx.zoho.forEach((r) => rows.push({ party: r.party_name, amount: r.amount, due: r.due_date, ref: r.ref, src: 'zoho' }));
  fx.tally.filter((b) => b.direction === (dir === 'recv' ? 'receivable' : 'payable'))
    .forEach((b) => rows.push({ party: b.party_name, amount: b.amount, due: b.due_date, ref: b.bill_ref, src: 'tally' }));
  if (dir === 'recv') fx.odoo.forEach((r) => rows.push({ party: r.party_name, amount: r.amount, due: r.due_date, ref: r.ref, src: 'odoo' }));
  return rows;
}
const shape = (g) => ({ key: g.key, party: g.party, primary: g.primary, sources: [...g.sources], status: g.status, amount: g.amount, diff: g.diff, oldestDays: g.oldestDays, invoices: g.invoices, overdue: g.overdue, due7: g.due7 });
for (const dir of ['recv', 'pay']) {
  const b = browserGroups(dir, browserInputs()).map(shape);
  const s = M.groupRows(serverRows(dir), T).map(shape);
  check(`parity ${dir}: ${b.length} parties, identical to the browser`, JSON.stringify(b) === JSON.stringify(s), { browser: b, server: s });
}
check('parity fixture covers agree, conflict and single', (() => {
  const st = M.groupRows(serverRows('recv'), T).map((g) => g.status);
  return st.includes('agree') && st.includes('conflict') && st.includes('single');
})());

/* ---------- paging ---------- */
(async () => {
  DB.big = Array.from({ length: 2500 }, (_, i) => ({ id: i, user_id: 'u1' }));
  let r = await selectAllRows('big', 'select=id&user_id=eq.u1&order=id.asc');
  check('selectAllRows reads all 2,500 rows over 3 pages', r.rows.length === 2500 && !r.truncated);
  r = await selectAllRows('big', 'select=id&user_id=eq.u1&order=id.asc', { max: 2000 });
  check('selectAllRows past the cap: 2,000 rows, truncated', r.rows.length === 2000 && r.truncated);
  DB.big = Array.from({ length: 2000 }, (_, i) => ({ id: i, user_id: 'u1' }));
  r = await selectAllRows('big', 'select=id&user_id=eq.u1&order=id.asc', { max: 2000 });
  check('exactly at the cap is not truncated', r.rows.length === 2000 && !r.truncated);

  /* ---------- loaders over the fake store ---------- */
  Object.assign(DB, {
    receivables: [
      { id: 1, user_id: 'u1', status: 'open', party_name: 'Acme', amount: 1000, due_date: '2026-09-01' },
      { id: 2, user_id: 'u1', status: 'paid', party_name: 'Paid Co', amount: 5000, due_date: '2026-09-01' },
      { id: 3, user_id: 'u2', status: 'open', party_name: 'Other Account', amount: 777, due_date: '2026-09-01' }
    ],
    payables: [],
    zoho_organizations: [{ id: 'org1', user_id: 'u1' }, { id: 'org2', user_id: 'u2' }],
    zoho_invoices: [
      { org_ref: 'org1', invoice_id: 'a', invoice_number: 'INV-1', customer_name: 'Acme', balance: 1000, due_date: '2026-09-01' },
      { org_ref: 'org2', invoice_id: 'b', invoice_number: 'INV-X', customer_name: 'Leak Ltd', balance: 999, due_date: '2026-09-01' }
    ],
    zoho_bills: [],
    tally_installs: [{ id: 't1', user_id: 'u1', status: 'active' }],
    tally_bills: Array.from({ length: 150 }, (_, i) => ({ id: 'tb' + i, user_id: 'u1', install_id: 't1', direction: 'receivable', party_name: 'Tally Party ' + i, bill_ref: 'B' + i, due_date: '2026-09-20', closing_balance: i === 0 ? 0 : -1000, overdue_days: 9 })),
    connector_credentials: [{ id: 'c1', user_id: 'u1', connector_type: 'odoo', disconnected_at: null, created_at: '2026-09-01' }],
    odoo_invoices: [{ id: 'o1', user_id: 'u1', cred_id: 'c1', invoice_number: 'O-1', customer_name: 'Acme', balance: 0.2, due_date: '2026-09-01' }],
    odoo_bills: []
  });
  const p = await M.positionForAccount('u1', { now: new Date('2026-09-29T06:00:00Z') });
  const rc = p.receivables;
  check('another account\'s rows never appear', !JSON.stringify(p).includes('Other Account') && !JSON.stringify(p).includes('Leak Ltd'));
  check('closed manual rows are not read', !JSON.stringify(p).includes('Paid Co'));
  check('all 149 open Tally bills read (the browser saw 100)', rc.coverage.tally.rows === 149 && !rc.coverage.tally.truncated, rc.coverage);
  check('zero-balance Tally bill and sub-Rs 0.5 Odoo balance dropped', rc.coverage.odoo.rows === 0 && !JSON.stringify(rc).includes('Tally Party 0"'));
  check('Acme: Zoho and manual agree at 1,000', rc.groups.find((g) => g.key === 'acme').status === 'agree');
  check('receivables total = 1,000 + 149 x 1,000', rc.totals.total === 150000, rc.totals);
  check('as_of is the India date', p.as_of === '2026-09-29');
  check('payables present and empty', p.payables && p.payables.totals.parties === 0);
  const onlyRecv = await M.positionForAccount('u1', { dirs: ['recv'] });
  check('dirs limits what is returned', onlyRecv.receivables && !onlyRecv.payables);

  DB.tally_installs = 'ERR';   // a source that errors is reported, not guessed
  const broken = await M.positionForAccount('u1', { dirs: ['recv'] });
  check('a failing source lands in errors, others still load',
    'tally' in broken.receivables.errors && !broken.receivables.coverage.tally && broken.receivables.coverage.zoho.rows === 1, broken.receivables.errors);

  /* ---------- actor ---------- */
  const actor = await A.resolveActor({ headers: { authorization: 'Bearer good' } });
  check('owner today: accountId is the login, every permission', actor.accountId === 'u1' && A.can(actor, 'view_payables') && A.can(actor, 'manage_people'));
  check('no session -> null', (await A.resolveActor({ headers: {} })) === null && (await A.resolveActor({ headers: { authorization: 'Bearer bad' } })) === null);
  check('viewer default sees receivables only', JSON.stringify(A.effectivePermissions('viewer')) === '["view_receivables"]');
  check('overrides add and remove', (() => { const p2 = A.effectivePermissions('finance', { approve: false, manage_people: true }); return !p2.includes('approve') && p2.includes('manage_people'); })());
  check('unknown role gets nothing', A.effectivePermissions('intruder').length === 0);
  check('can() with no actor is false', A.can(null, 'view_cash') === false);

  /* ---------- endpoint ---------- */
  const handler = require('../../reconcile');
  const mkRes = () => { const r = { code: 0, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
  DB.tally_installs = [{ id: 't1', user_id: 'u1', status: 'active' }];
  let res = mkRes();
  await handler({ method: 'GET', query: { action: 'position', dir: 'recv', rows: '0' }, headers: { authorization: 'Bearer good' } }, res);
  check('GET position: 200, receivables only, no rows', res.code === 200 && res.body.receivables && !res.body.payables && !res.body.receivables.groups[0].by[res.body.receivables.groups[0].primary].rows, res.body && Object.keys(res.body));
  res = mkRes();
  await handler({ method: 'GET', query: { action: 'position' }, headers: {} }, res);
  check('no session -> 401', res.code === 401);
  res = mkRes();
  await handler({ method: 'POST', query: { action: 'position' }, headers: { authorization: 'Bearer good' } }, res);
  check('POST -> 405', res.code === 405);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
