/**
 * Two Tally company files, end to end: agent 0.2.6 on a Tally shaped like the Care customer's, through the REAL
 * server ingest (api/tally.js) on an in-memory Supabase, through the server's readers and analytics, to chase.
 *
 *   node tally-agent/twofile.e2e.test.js
 *
 * The chain:  real agent code (tally-agent/, and 0.2.4 from test-fixtures/tally-agent-0.2.4/ for the "before")
 *   -> mock Tally (mock-tally.js, MOCK_BOOK=care2: two company files, mock-twofile.js) over local HTTP
 *   -> a fake cloud: every agent call to http://cloud.test/api/tally is handed to the real api/tally.js handler
 *   -> that handler runs on a fake PostgREST + Storage held in memory (no Supabase, no Vercel, no R2)
 *   -> the server's own readers: GET ?action=analytics (tallyData + tallyAnalytics + booksEngine), the party
 *      master (tallyParties), and remindCustomer (chase) with the WhatsApp send stubbed.
 * Any fetch to another host fails the test. Expected figures are worked out from the mock's own book.
 *
 * Scenarios: 1 upgrade 0.2.4 -> 0.2.6 · 2 both files open (9 Oct) · 3 only last year's file open, then this
 * year's again · 4 contacts request fails · 5 contact edge cases + a renamed debtor · 6 chase on/off ·
 * 7 the exact set of Tally requests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'margyn-twofile-'));
process.env.HOME = HOME; process.env.APPDATA = HOME; process.env.XDG_CONFIG_HOME = HOME;
for (const k of ['MARGYN_API_BASE', 'TALLY_HOST', 'TALLY_PORT', 'TALLY_COMPANY', 'TALLY_FROM_DATE', 'TALLY_TO_DATE', 'TALLY_READ_GSTIN',
  'ANTHROPIC_API_KEY', 'MARGYN_DEMO_ACCOUNTS', 'MARGYN_EXTERNAL_SENDS', 'TALLY_AGENT_MIN_VERSION']) delete process.env[k];
process.env.SUPABASE_URL = 'https://fake.supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.GUPSHUP_API_KEY = 'k'; process.env.GUPSHUP_SOURCE_NUMBER = '919000000000'; process.env.GUPSHUP_APP_NAME = 'margyn';
for (const n of ['pre_due', 'due_friendly', 'overdue_1_friendly', 'overdue_2_friendly', 'final']) process.env['WHATSAPP_TEMPLATE_CHASE_' + n.toUpperCase()] = 'tpl-' + n;

const ROOT = path.join(__dirname, '..');
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);   // India date, as the mock and server use
const books = require('./mock-twofile');
const B = books.buildBooks({ today: TODAY });
const { OLD, NEW } = books;
const EXP = B.expected;

/* ------------------------------ results ------------------------------ */
const results = [];   // { scenario, name, ok, detail }
let scenario = '';
function check(name, ok, detail) {
  results.push({ scenario, name, ok: !!ok, detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} - ${name}${!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}\n`);
}
function todo(name, ok, detail) {   // a real bug, reported, not failing the run (see the report)
  results.push({ scenario, name, ok: true, todo: !ok, detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'TODO'} - ${name}${!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}\n`);
}
const near = (a, b, tol = 0.01) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const numbers = [];   // printed at the end: mock vs server
function figure(label, mock, server) { numbers.push({ scenario, label, mock, server }); }

/* ------------------------------ fake Supabase (PostgREST + Storage + Auth) ------------------------------ */
const U = '7c2e4a10-5b3d-4f8e-9a61-0d2c3b4a5e6f';
const INSTALL_KEY = 'mtly_care_test';
const DB = {
  tally_installs: [{ id: 'inst-care', key_hash: crypto.createHash('sha256').update(INSTALL_KEY).digest('hex'), user_id: U, company_name: NEW, status: 'active',
    last_sync_at: null, last_seen_at: null, diagnostics: null, agent_command: null, agent_version: null, tally_edition: null }],
  tally_vouchers: [], tally_ledgers: [], tally_bills: [], tally_sync_runs: [], tally_ledger_classes: [],
  profiles: [{ id: U, company_name: 'Care Hygiene Pvt Ltd', preferences: {}, whatsapp_phone: '+919000000001' }],
  // A number the owner typed into Margyn for this customer, before Tally sent any (must never be overwritten).
  ledger_parties: [{ id: 'party-owner-typed', user_id: U, name: 'OWNER TYPED DISTRIBUTORS', type: 'customer', phone: '+919999900000', email: '', gstin: null,
    address: null, state: null, pincode: null, pan: null, source: 'manual', external_refs: {} }],
  agent_deployments: [], whatsapp_chase_targets: [], whatsapp_chases: [], receivables: [], connector_logs: []
};
const STORAGE = new Map();
const blocked = [];
let seq = 0;

function splitList(s) {
  const out = []; let cur = '', q = false;
  for (const ch of s) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { out.push(cur); cur = ''; continue; } cur += ch; }
  out.push(cur);
  return out;
}
const cmp = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && !/^\d{4}-/.test(String(a))) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
function opTest(val, op, arg) {
  switch (op) {
    case 'eq': return val != null && String(val) === arg;
    case 'neq': return val != null && String(val) !== arg;
    case 'gt': return val != null && cmp(val, arg) > 0;
    case 'gte': return val != null && cmp(val, arg) >= 0;
    case 'lt': return val != null && cmp(val, arg) < 0;
    case 'lte': return val != null && cmp(val, arg) <= 0;
    case 'in': return val != null && splitList(arg.replace(/^\(|\)$/g, '')).includes(String(val));
    case 'is': return arg === 'null' ? val == null : arg === 'true' ? val === true : arg === 'false' ? val === false : false;
    case 'like': case 'ilike': {
      const re = new RegExp('^' + arg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$', op === 'ilike' ? 'i' : '');
      return val != null && re.test(String(val));
    }
    default: throw new Error('fake PostgREST: unsupported operator ' + op);
  }
}
function compileFilter(params) {
  const preds = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or' || k === 'and') {
      const parts = splitList(v.replace(/^\(|\)$/g, '')).map((p) => { const m = /^([a-z_]+)\.(not\.)?([a-z]+)\.(.*)$/.exec(p); if (!m) throw new Error('fake PostgREST: bad ' + k + ' ' + v); return m; });
      preds.push((r) => (k === 'or' ? parts.some : parts.every).call(parts, (m) => { const t = opTest(r[m[1]], m[3], m[4]); return m[2] ? !t : t; }));
      continue;
    }
    const m = /^(not\.)?([a-z]+)\.([\s\S]*)$/.exec(v);
    if (!m) throw new Error(`fake PostgREST: bad filter ${k}=${v}`);
    if (m[2] === 'in') { const set = new Set(splitList(m[3].replace(/^\(|\)$/g, ''))); preds.push((r) => { const t = r[k] != null && set.has(String(r[k])); return m[1] ? !t : t; }); continue; }
    preds.push((r) => { const t = opTest(r[k], m[2], m[3]); return m[1] ? !t : t; });
  }
  return (r) => preds.every((p) => p(r));
}
function orderRows(rows, order) {
  if (!order) return rows;
  const keys = order.split(',').map((o) => { const [col, dir, nulls] = o.split('.'); return { col, desc: dir === 'desc', nullsLast: nulls ? nulls === 'nullslast' : dir !== 'desc' }; });
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x == null && y == null) continue;
      if (x == null) return k.nullsLast ? 1 : -1;
      if (y == null) return k.nullsLast ? -1 : 1;
      const c = cmp(x, y);
      if (c) return k.desc ? -c : c;
    }
    return 0;
  });
}
function project(rows, select) {
  if (!select || select === '*' || /[()]/.test(select)) return rows.map((r) => JSON.parse(JSON.stringify(r)));
  const cols = select.split(',').map((c) => c.trim()).filter(Boolean);
  return rows.map((r) => { const o = {}; for (const c of cols) o[c] = r[c] === undefined ? null : JSON.parse(JSON.stringify(r[c])); return o; });
}
const conflictIndex = new Map();   // table|cols -> Map(key -> row)
function indexFor(table, cols) {
  const k = table + '|' + cols;
  let ix = conflictIndex.get(k);
  if (!ix) { ix = new Map(); for (const r of DB[table] || []) ix.set(cols.split(',').map((c) => String(r[c])).join('\u0001'), r); conflictIndex.set(k, ix); }
  return ix;
}
const dropIndexes = (table) => { for (const k of [...conflictIndex.keys()]) if (k.startsWith(table + '|')) conflictIndex.delete(k); };

function response(body, status = 200, headers = {}) {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status < 400, status, headers: { get: (h) => headers[String(h).toLowerCase()] || null },
    json: async () => JSON.parse(text || 'null'), text: async () => text, arrayBuffer: async () => Buffer.from(text) };
}
function postgrest(u, opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const m = /^\/rest\/v1\/(rpc\/)?([^/?]+)/.exec(u.pathname);
  if (m[1]) return response(null);
  const table = m[2];
  const rows = DB[table] || (DB[table] = []);
  const params = [...u.searchParams.entries()];
  const get = (k) => u.searchParams.get(k);
  const hdr = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'POST') {
    const body = JSON.parse(opts.body);
    const list = Array.isArray(body) ? body : [body];
    const prefer = hdr.prefer || '';
    const oc = get('on_conflict');
    const out = [];
    for (const r0 of list) {
      const r = JSON.parse(JSON.stringify(r0));
      if (oc) {
        const ix = indexFor(table, oc);
        const key = oc.split(',').map((c) => String(r[c])).join('\u0001');
        const hit = ix.get(key);
        if (hit) { if (/merge-duplicates/.test(prefer)) { Object.assign(hit, r); out.push(hit); } continue; }
        if (!('id' in r)) r.id = table + '-' + (++seq);
        rows.push(r); ix.set(key, r); out.push(r);
      } else {
        if (!('id' in r)) r.id = table + '-' + (++seq);
        if (!('created_at' in r)) r.created_at = new Date().toISOString();
        rows.push(r); dropIndexes(table); out.push(r);
      }
    }
    return response(JSON.parse(JSON.stringify(out)), 201);
  }
  const pred = compileFilter(params);
  if (method === 'PATCH') {
    const patch = JSON.parse(opts.body);
    const hit = rows.filter(pred);
    hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(patch))));
    dropIndexes(table);
    return response(JSON.parse(JSON.stringify(hit)));
  }
  if (method === 'DELETE') {
    const keep = rows.filter((r) => !pred(r));
    DB[table] = keep; dropIndexes(table);
    return response(null, 204);
  }
  let hit = rows.filter(pred);
  if (method === 'HEAD') return response(null, 200, { 'content-range': `0-0/${hit.length}` });
  hit = orderRows(hit, get('order'));
  const off = parseInt(get('offset') || '0', 10), lim = get('limit') != null ? parseInt(get('limit'), 10) : null;
  hit = hit.slice(off, lim != null ? off + lim : undefined);
  return response(project(hit, get('select')));
}
function storage(u, opts) {
  const method = (opts.method || 'GET').toUpperCase();
  if (/\/storage\/v1\/bucket$/.test(u.pathname)) return response({ name: 'margyn-cache' });
  const key = u.pathname.replace(/^\/storage\/v1\/object\//, '');
  if (method === 'POST' || method === 'PUT') { STORAGE.set(key, Buffer.from(opts.body)); return response({ Key: key }); }
  const b = STORAGE.get(key);
  if (!b) return response({ error: 'not_found' }, 404);
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => b, json: async () => JSON.parse(b), text: async () => b.toString() };
}

/* ------------------------------ fake cloud: agent -> REAL api/tally.js ------------------------------ */
const inflight = new Set();
let handler = null;
function callHandler(req) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { setHeader() {}, getHeader() {}, status(s) { status = s; return this; }, json(p) { resolve({ status, body: p }); return this; }, end(p) { resolve({ status, body: p || null }); return this; } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
async function cloud(u, opts) {
  const action = u.searchParams.get('action');
  const hdr = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const p = callHandler({ method: (opts.method || 'GET').toUpperCase(), query: { action }, headers: { authorization: hdr.authorization }, body: opts.body ? JSON.parse(opts.body) : undefined });
  inflight.add(p);
  try { const r = await p; return response(r.body, r.status); } finally { inflight.delete(p); }
}
const settle = async () => { while (inflight.size) await Promise.allSettled([...inflight]); await new Promise((r) => setTimeout(r, 20)); };

global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.host === 'cloud.test') return cloud(u, opts);
  if (u.host === 'fake.supabase.test') {
    if (u.pathname === '/auth/v1/user') return response({ id: U, email: 'owner@care.example' });
    if (u.pathname.startsWith('/storage/v1/')) return storage(u, opts);
    if (u.pathname.startsWith('/rest/v1/')) return postgrest(u, opts);
  }
  blocked.push(String(url));
  throw new TypeError('network blocked in this test: ' + url);
};

/* ------------------------------ mock Tally + agents ------------------------------ */
const TALLY_PORT = 9731;
function startMock() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mock-tally.js')], { env: Object.assign({}, process.env, { PORT: String(TALLY_PORT), MOCK_BOOK: 'care2', MOCK_TODAY: TODAY }), stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.once('data', () => resolve(p));
    p.once('exit', (code) => { if (code) reject(new Error('mock failed to start')); });
  });
}
function mockCall(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: TALLY_PORT, path: pathname, method: body ? 'POST' : 'GET', headers: { 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.end(data);
  });
}
const control = (o) => mockCall('/__control', o);
const takeLog = () => mockCall('/__log?reset=1');

const config = require('./config');
const agent = require('./agent');
const agent024 = require(path.join(ROOT, 'test-fixtures', 'tally-agent-0.2.4', 'agent.js'));
const agentLines = [];
agent.setLogger((l) => agentLines.push('0.2.6 ' + l));
agent024.setLogger((l) => agentLines.push('0.2.4 ' + l));

/** Run one sync with the console quiet (agent + server chatter kept for the end if something fails). */
const chatter = [];
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => chatter.push(a.join(' '));
  console.warn = (...a) => chatter.push('[warn] ' + a.join(' '));
  console.error = (...a) => chatter.push('[error] ' + a.join(' '));
  try { const r = await fn(); await settle(); return r; } finally { Object.assign(console, saved); }
}
const sync = (ag) => quiet(() => ag.runFullSync(config.load()));

/* ------------------------------ readers ------------------------------ */
async function analytics() {
  const r = await quiet(() => callHandler({ method: 'GET', query: { action: 'analytics', fresh: '1' }, headers: { authorization: 'Bearer owner-token' } }));
  if (r.status !== 200 || !r.body || !r.body.connected) throw new Error('analytics failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
  const a = r.body, wc = a.working_capital || {};
  const fy = (a.years || []).find((y) => y.fy === '2026-27');
  const ly = (a.years || []).find((y) => y.fy === '2025-26');
  return { raw: a, net_sales: fy ? fy.net_sales : a.period && a.period.net_sales, period_net_sales: a.period && a.period.net_sales, last_year_net_sales: ly ? ly.net_sales : null,
    receivables: wc.receivables, payables: wc.payables, cash: wc.cash, cash_total: a.cash && a.cash.total };
}
function checkFigures(label, f) {
  const e = EXP[NEW];
  figure(label + ': this-year net sales', e.net_sales_fy, f.net_sales);
  figure(label + ': receivables', e.receivables, f.receivables);
  figure(label + ': payables', e.payables, f.payables);
  figure(label + ': cash + bank today', e.cash, f.cash);
  check(`${label}: this year's sales = mock (${e.net_sales_fy})`, near(f.net_sales, e.net_sales_fy), { server: f.net_sales, period: f.period_net_sales });
  check(`${label}: receivables = mock open bills (${e.receivables})`, near(f.receivables, e.receivables), { server: f.receivables, basis: f.raw.working_capital.receivables_basis });
  check(`${label}: payables = mock open bills (${e.payables})`, near(f.payables, e.payables), { server: f.payables, basis: f.raw.working_capital.payables_basis });
  check(`${label}: cash + bank today = mock, post-dated cheque left out (${e.cash})`, near(f.cash, e.cash), { server: f.cash, with_future: e.cash_with_future, reasons: (f.raw.quality.reasons || []).slice(0, 4) });
}
const rowsOf = (table, co) => DB[table].filter((r) => r.install_id === 'inst-care' && (!co || r.company_name === co));
// Scenario 5 renames one debtor in Tally; a full re-read then carries the new name on its old vouchers (as Tally
// does). Snapshots compare under the new name so that legitimate change isn't counted as an overwrite.
const vouchersSnap = (co) => new Map(rowsOf('tally_vouchers', co).map((r) => [r.tally_guid, JSON.stringify([r.date, r.amount, r.voucher_type, r.party_name, r.entries]).split('OLD NAME TRADERS').join('NEW NAME TRADERS')]));
function countsOk(label, co, e) {
  const v = rowsOf('tally_vouchers', co).length, l = rowsOf('tally_ledgers', co).length;
  const br = rowsOf('tally_bills', co).filter((b) => b.direction === 'receivable').length, bp = rowsOf('tally_bills', co).filter((b) => b.direction === 'payable').length;
  figure(`${label}: rows (vouchers/ledgers/recv bills/pay bills)`, [e.vouchers, e.ledgers, e.bills_receivable, e.bills_payable].join('/'), [v, l, br, bp].join('/'));
  check(`${label}: ${co} vouchers stored = mock (${e.vouchers})`, v === e.vouchers, v);
  check(`${label}: ${co} ledgers stored = mock (${e.ledgers})`, l === e.ledgers, l);
  if (e.bills_receivable != null) check(`${label}: ${co} open bills stored = mock (${e.bills_receivable} receivable, ${e.bills_payable} payable)`, br === e.bills_receivable && bp === e.bills_payable, { br, bp });
}
const companiesRead = (log) => Object.keys(log.companies).sort();

/* ------------------------------ scenarios ------------------------------ */
(async () => {
  console.log(`twofile e2e — run date ${TODAY} (IST). Mock book: ${OLD} ${EXP[OLD].vouchers} vouchers; ${NEW} ${EXP[NEW].vouchers} vouchers (one dated 2027-03-10), ${EXP[NEW].ledgers} ledgers per file, ${EXP.customers} customers, ${EXP[NEW].bills_receivable} receivable + ${EXP[NEW].bills_payable} payable open bills.`);
  handler = require(path.join(ROOT, 'api', 'tally.js'));
  const remind = require(path.join(ROOT, 'api', '_lib', 'remindCustomer.js'));
  const bsp = require(path.join(ROOT, 'api', '_lib', 'whatsappBsp.js'));
  const sent = [];
  bsp.sendTemplate = async (msg) => { sent.push(msg); return { ok: true, messageId: 'wamid-test-' + sent.length }; };
  const mock = await startMock();
  const shapes = { v024: new Map(), v026: new Map() };
  const keep = (ver, log) => { for (const s of log.shapes) if (!shapes[ver].has(s.shape)) shapes[ver].set(s.shape, s.label); };

  try {
    config.save({ apiBase: 'http://cloud.test', tallyHost: '127.0.0.1', tallyPort: TALLY_PORT, company: NEW, installKey: INSTALL_KEY, syncState: {} });

    /* ---------- 1. upgrade path ---------- */
    scenario = '1 upgrade 0.2.4 -> 0.2.6';
    console.log('\n[1] Upgrade: the database as 0.2.4 leaves it, then 0.2.6 on the same PC (only 2026-27 open)');
    await control({ open: [NEW], contacts: 'ok' });
    await takeLog();
    const r024 = await sync(agent024);
    const log024 = await takeLog();
    keep('v024', log024);
    check('0.2.4 baseline sync completed (this is the DB the customer has today)', r024 && r024.vouchers && !r024.vouchers.error, r024);
    countsOk('after 0.2.4', NEW, EXP[NEW]);
    check('0.2.4 stores no contacts', rowsOf('tally_ledgers').every((r) => !r.contact));
    const before = vouchersSnap(NEW);
    const ledgersBefore = new Set(rowsOf('tally_ledgers').map((r) => r.tally_guid));
    const f024 = await analytics();
    figure('after 0.2.4: this-year net sales', EXP[NEW].net_sales_fy, f024.net_sales);
    figure('after 0.2.4: receivables', EXP[NEW].receivables, f024.receivables);
    const partiesBefore = DB.ledger_parties.length;

    const r1 = await sync(agent);
    const log1 = await takeLog();
    keep('v026', log1);
    check('0.2.6 sync completed with no errors', r1 && r1.ledgers && r1.vouchers && !r1.vouchers.error && r1.bills && !r1.bills.receivable.error && !r1.bills.payable.error, r1);
    check('0.2.6 read the same company file (only 2026-27 named to Tally)', JSON.stringify(companiesRead(log1)) === JSON.stringify([NEW]) && config.load().company === NEW, log1.companies);
    countsOk('after 0.2.6', NEW, EXP[NEW]);
    const after = vouchersSnap(NEW);
    let changed = 0; for (const [g, s] of before) if (after.get(g) !== s) changed++;
    check('nothing 0.2.4 stored is wiped: every voucher still there, unchanged', changed === 0 && [...before.keys()].every((g) => after.has(g)), { changed });
    check('nothing duplicated: one row per voucher GUID, one per ledger GUID', after.size === rowsOf('tally_vouchers', NEW).length && new Set(rowsOf('tally_ledgers').map((r) => r.tally_guid)).size === rowsOf('tally_ledgers').length
      && [...ledgersBefore].every((g) => rowsOf('tally_ledgers').some((r) => r.tally_guid === g)));
    const voucherGuidsMock = new Set(B.files[NEW].vouchers.map((v) => v.guid));
    check('stored voucher GUIDs are exactly the mock file\'s', after.size === voucherGuidsMock.size && [...after.keys()].every((g) => voucherGuidsMock.has(g)));
    checkFigures('after 0.2.6', await analytics());
    // contacts
    const { cleanContact, indianMobile } = require(path.join(ROOT, 'api', '_lib', 'tallyParties.js'));
    const tagMap = { MARGYNPHONE: 'phone', MARGYNMOBILE: 'mobile', MARGYNEMAIL: 'email', MARGYNCONTACT: 'contact_person', MARGYNGSTIN: 'gstin', MARGYNSTATE: 'state', MARGYNPIN: 'pincode', MARGYNPAN: 'pan', MARGYNADDRESS: 'address' };
    const mockContact = (l) => { const o = {}; for (const [t, k] of Object.entries(tagMap)) if (l.contact && l.contact[t]) o[k] = l.contact[t]; return cleanContact(o); };
    const withC = B.ledgers.filter((l) => mockContact(l));
    const storedC = rowsOf('tally_ledgers', NEW).filter((r) => r.contact);
    figure('contacts on ledgers', withC.length, storedC.length);
    check(`contacts arrive on the ledgers (${withC.length} ledgers carry details in Tally)`, storedC.length === withC.length && withC.every((l) => { const s = rowsOf('tally_ledgers', NEW).find((r) => r.tally_guid === l.guid); return s && JSON.stringify(s.contact) === JSON.stringify(mockContact(l)); }), { stored: storedC.length });
    // party master
    const parties = () => DB.ledger_parties.filter((p) => p.user_id === U);
    const byGuid = (g) => parties().filter((p) => p.external_refs && p.external_refs.tally_guid === g);
    const partyLedgers = B.ledgers.filter((l) => (l.kind === 'debtor' || l.kind === 'creditor') && mockContact(l) && (mockContact(l).mobile || mockContact(l).phone || mockContact(l).email));
    figure('party master rows from Tally', partyLedgers.length, parties().length);
    check(`a party for every debtor/creditor with a phone or email (${partyLedgers.length}), linked by Tally GUID, none twice`,
      partyLedgers.every((l) => byGuid(l.guid).length === 1) && parties().length === partiesBefore + partyLedgers.length - 1, { parties: parties().length, expected: partiesBefore + partyLedgers.length - 1 });
    const mobiles = partyLedgers.filter((l) => indianMobile(mockContact(l).mobile || ''));
    check(`mobiles normalised to +91XXXXXXXXXX (${mobiles.length} parties)`, mobiles.every((l) => {
      const p = byGuid(l.guid)[0]; if (l.name === 'OWNER TYPED DISTRIBUTORS') return true;
      return p && /^\+91[6-9]\d{9}$/.test(p.phone) && p.phone === '+91' + mockContact(l).mobile.replace(/\D/g, '').slice(-10);
    }), mobiles.filter((l) => !(byGuid(l.guid)[0] || {}).phone).map((l) => l.name).slice(0, 5));
    const owner = DB.ledger_parties.find((p) => p.id === 'party-owner-typed');
    check('owner-typed phone never overwritten; blank email filled from Tally; linked to the Tally ledger', owner.phone === '+919999900000' && owner.email === 'tally@ownertyped.example' && owner.source === 'manual'
      && owner.external_refs.tally_guid === B.customers.find((c) => c.name === 'OWNER TYPED DISTRIBUTORS').guid, owner);
    check('debtors become customers, creditors vendors', parties().filter((p) => p.source === 'tally').every((p) => (B.customers.some((c) => c.guid === p.external_refs.tally_guid) ? p.type === 'customer' : p.type === 'vendor')));

    /* ---------- 5. contact edge cases (on what scenario 1 stored) ---------- */
    scenario = '5 contact edge cases';
    console.log('\n[5] Contact edge cases');
    const P = (name) => { const l = B.ledgers.find((x) => x.name === name); return byGuid(l.guid); };
    const one = (name) => P(name)[0] || null;
    check('blank phone/mobile/email: no party, no contact on the ledger', P('BLANK PHONE TRADERS').length === 0 && !rowsOf('tally_ledgers', NEW).find((r) => r.name === 'BLANK PHONE TRADERS').contact);
    check('landline with STD code: stored as typed (not a mobile)', one('LANDLINE MEDICALS') && one('LANDLINE MEDICALS').phone === '022-2650 1100', one('LANDLINE MEDICALS'));
    check('"+91 98765 43210" -> +919876543210', one('PLUS NINETY ONE PHARMA') && one('PLUS NINETY ONE PHARMA').phone === '+919876543210', one('PLUS NINETY ONE PHARMA'));
    check('two numbers in one field (landline, mobile) -> the mobile, +919930054321', one('TWO NUMBER CLINIC') && one('TWO NUMBER CLINIC').phone === '+919930054321', one('TWO NUMBER CLINIC'));
    check('email only: party with the email and no phone', one('EMAIL ONLY HOSPITAL') && one('EMAIL ONLY HOSPITAL').phone == null && one('EMAIL ONLY HOSPITAL').email === 'ap@emailonly.example', one('EMAIL ONLY HOSPITAL'));
    check('phone on a creditor: vendor party +919930011111', one('VERMA SUPPLIES') && one('VERMA SUPPLIES').type === 'vendor' && one('VERMA SUPPLIES').phone === '+919930011111', one('VERMA SUPPLIES'));
    check('creditor with no details: no party', P('NO CONTACT SUPPLIER').length === 0);
    check('GSTIN, PAN, address, state, pincode carried for ACME', (() => { const a = one('ACME RETAIL PVT LTD'); return a && a.phone === '+919820012345' && a.gstin === '27AABCA1234A1Z5' && a.pan === 'AABCA1234A' && a.state === 'Maharashtra' && a.pincode === '400001'; })(), one('ACME RETAIL PVT LTD'));
    // A debtor renamed in Tally (same GUID, new name).
    const renamedGuid = B.ledgers.find((l) => l.name === 'OLD NAME TRADERS').guid;
    await control({ rename: { from: 'OLD NAME TRADERS', to: 'NEW NAME TRADERS' } });
    const nParties = DB.ledger_parties.length;
    const r5 = await sync(agent);
    const log5 = await takeLog(); keep('v026', log5);
    check('renamed debtor: sync ok, ledger row renamed in place (same GUID, one row)', !r5.vouchers.error && rowsOf('tally_ledgers', NEW).filter((r) => r.tally_guid === renamedGuid).length === 1
      && rowsOf('tally_ledgers', NEW).find((r) => r.tally_guid === renamedGuid).name === 'NEW NAME TRADERS');
    check('renamed debtor: no second party created (matched on Tally GUID), number kept', DB.ledger_parties.length === nParties && byGuid(renamedGuid).length === 1 && byGuid(renamedGuid)[0].phone === '+919811122233', byGuid(renamedGuid));
    check('renamed debtor: the party master follows the new name', byGuid(renamedGuid)[0].name === 'NEW NAME TRADERS', { party_name: byGuid(renamedGuid)[0].name });
    { const remind5 = require(path.join(ROOT, 'api', '_lib', 'remindCustomer.js'));
      const p5 = await quiet(() => remind5.prepare(U, 'NEW NAME TRADERS'));
      figure('renamed debtor, reminder lookup right after the rename', 'phone ending 2233', p5.found ? `found as "${p5.item.party}", has_phone ${p5.out.has_phone}` : 'not found');
      check('renamed debtor: a reminder right after the rename finds the number Tally sent', p5.found && p5.out.has_phone, { found: p5.found, party: p5.found && p5.item.party, has_phone: p5.found && p5.out.has_phone }); }
    const f5 = await analytics();
    check('renamed debtor: receivables total unchanged', near(f5.receivables, EXP[NEW].receivables), { server: f5.receivables });

    /* ---------- 2. both files open, config on last year's (9 Oct) ---------- */
    scenario = '2 both files open';
    console.log('\n[2] Both files open, 2025-26 listed first, agent config pointing at 2025-26 (the 9 Oct situation)');
    await control({ open: [OLD, NEW] });
    const newBefore = vouchersSnap(NEW);
    const ledgerBal = new Map(rowsOf('tally_ledgers', NEW).map((r) => [r.tally_guid, r.closing_balance]));
    const billsBefore = JSON.stringify(rowsOf('tally_bills').map((b) => [b.direction, b.party_name, b.bill_ref, b.closing_balance]).sort());
    // 2a. Replay of 9 Oct: 0.2.4 with config on 2025-26 reads last year's file, into TODAY's server.
    config.save({ company: OLD });
    const r2a = await sync(agent024);
    const log2a = await takeLog(); keep('v024', log2a);
    check('replay 9 Oct: 0.2.4 reads 2025-26 (what happened), the server keeps it apart', JSON.stringify(companiesRead(log2a)) === JSON.stringify([OLD]) && !r2a.vouchers.error, { companies: log2a.companies, r: r2a.vouchers });
    const after2a = vouchersSnap(NEW);
    let ch2a = 0; for (const [g, s] of newBefore) if (after2a.get(g) !== s) ch2a++;
    check('replay 9 Oct: none of this year\'s vouchers overwritten (incl. the 3 whose GUIDs last year\'s audit entries reuse)', ch2a === 0 && after2a.size === newBefore.size, { changed: ch2a });
    const oldRows = rowsOf('tally_vouchers', OLD);
    check(`replay 9 Oct: last year's ${EXP[OLD].vouchers} vouchers kept under 2025-26`, oldRows.length === EXP[OLD].vouchers, oldRows.length);
    const tagged = oldRows.filter((r) => /~[0-9a-f]{8}$/.test(r.tally_guid));
    check('replay 9 Oct: the shared GUIDs are stored for 2025-26 under a per-file key, dated 2026-03-31', tagged.length === 3 && tagged.every((r) => r.date === '2026-03-31' && EXP.audit_guids.includes(r.tally_guid.replace(/~[0-9a-f]{8}$/, ''))), tagged.map((r) => [r.tally_guid, r.date]));
    check('replay 9 Oct: this year\'s ledger balances untouched; last year\'s ledgers kept beside them',
      rowsOf('tally_ledgers', NEW).every((r) => ledgerBal.get(r.tally_guid) === r.closing_balance) && rowsOf('tally_ledgers', OLD).length === EXP[OLD].ledgers);
    check('replay 9 Oct: last year\'s open bills not laid over this year\'s', JSON.stringify(rowsOf('tally_bills').map((b) => [b.direction, b.party_name, b.bill_ref, b.closing_balance]).sort()) === billsBefore && rowsOf('tally_bills', OLD).length === 0);
    checkFigures('after the 9 Oct replay', await analytics());
    // 2b. 0.2.6 in the same situation.
    const r2b = await sync(agent);
    const log2b = await takeLog(); keep('v026', log2b);
    check('0.2.6 with both open and config on 2025-26 reads 2026-27 only', JSON.stringify(companiesRead(log2b)) === JSON.stringify([NEW]) && config.load().company === NEW && !r2b.vouchers.error, { companies: log2b.companies, company: config.load().company });
    const after2b = vouchersSnap(NEW);
    let ch2b = 0; for (const [g, s] of newBefore) if (after2b.get(g) !== s) ch2b++;
    check('this year\'s rows not overwritten by last year\'s; shared GUIDs don\'t collide', ch2b === 0 && after2b.size === EXP[NEW].vouchers && rowsOf('tally_vouchers', OLD).length === EXP[OLD].vouchers, { changed: ch2b });
    countsOk('after 0.2.6 (both open)', NEW, EXP[NEW]);
    checkFigures('after 0.2.6 (both open)', await analytics());

    /* ---------- 3. only last year's file open, then this year's again ---------- */
    scenario = '3 only 2025-26 open';
    console.log('\n[3] Only 2025-26 open (the audit), then 2026-27 reopened');
    const newUntouched = (label) => { const sn = vouchersSnap(NEW); const diff = [...newBefore].filter(([g, v]) => sn.get(g) !== v).map(([g, v]) => ({ g, was: v.slice(0, 120), now: (sn.get(g) || 'MISSING').slice(0, 120) }));
      check(label, diff.length === 0 && sn.size === EXP[NEW].vouchers, { size: sn.size, changed: diff.length, sample: diff.slice(0, 3) }); };
    // a) Last year's file alone. 0.2.6 already holds progress for it (parked when it left the 9 Oct replay's read).
    await control({ open: [OLD] });
    const r3 = await sync(agent);
    const log3 = await takeLog(); keep('v026', log3);
    check('agent reads 2025-26 as history (only that file named to Tally)', JSON.stringify(companiesRead(log3)) === JSON.stringify([OLD]) && !r3.vouchers.error && config.load().company === OLD, { companies: log3.companies, v: r3.vouchers });
    check('...picking up the progress parked for 2025-26, so its year is not read again for nothing', r3.vouchers.mode === 'unchanged', r3.vouchers);
    // b) A full re-read of last year's file by 0.2.6 itself.
    agent.applyCommand({ action: 'resync' });
    const r3r = await sync(agent);
    const log3r = await takeLog(); keep('v026', log3r);
    check('0.2.6 full read of 2025-26: every voucher of its year, only that file named', JSON.stringify(companiesRead(log3r)) === JSON.stringify([OLD]) && r3r.vouchers.mode === 'full' && r3r.vouchers.received === EXP[OLD].vouchers, { companies: log3r.companies, v: r3r.vouchers });
    check('its own year is read (FY 2025-26: April 2025 to March 2026)', (() => { const ms = Object.keys(((config.load().syncState || {}).months) || {}).sort(); return ms.length === 12 && ms[0] === '2025-04' && ms[11] === '2026-03'; })(), Object.keys((config.load().syncState || {}).months || {}));
    countsOk('after reading 2025-26', OLD, { vouchers: EXP[OLD].vouchers, ledgers: EXP[OLD].ledgers });
    check('last year\'s open bills are not stored over this year\'s', rowsOf('tally_bills', OLD).length === 0 && rowsOf('tally_bills', NEW).length === EXP[NEW].bills_receivable + EXP[NEW].bills_payable);
    newUntouched('this year\'s rows untouched while last year\'s file is read');
    { const tallyParties = DB.ledger_parties.filter((p) => p.source === 'tally' || p.id === 'party-owner-typed');
      const tagged = tallyParties.filter((p) => /~[0-9a-f]{8}$/.test((p.external_refs || {}).tally_guid || ''));
      check('reading last year\'s file leaves each party linked to its ledger GUID (not the per-file "~tag" key)', tagged.length === 0, { relinked: tagged.length, of: tallyParties.length, sample: tagged.slice(0, 2).map((p) => [p.name, p.external_refs.tally_guid]) }); }
    const f3 = await analytics();
    checkFigures('while only 2025-26 is open', f3);
    figure('last year (2025-26) net sales', EXP[OLD].net_sales_fy, f3.last_year_net_sales);
    check(`last year's sales shown for 2025-26 = mock (${EXP[OLD].net_sales_fy})`, near(f3.last_year_net_sales, EXP[OLD].net_sales_fy), f3.last_year_net_sales);
    // c) This year's file reopened: the agent goes back to it by itself (a full read: resync cleared its progress).
    await control({ open: [OLD, NEW] });
    const r3b = await sync(agent);
    const log3b = await takeLog(); keep('v026', log3b);
    check('2026-27 reopened: agent goes back to it by itself', JSON.stringify(companiesRead(log3b)) === JSON.stringify([NEW]) && config.load().company === NEW && !r3b.vouchers.error, { companies: log3b.companies, v: r3b.vouchers });
    newUntouched('...this year\'s rows as before');
    checkFigures('after 2026-27 reopened', await analytics());
    // d) Back and forth once more: each file carries on from its own progress.
    await control({ open: [OLD] });
    const r3c = await sync(agent);
    const log3c = await takeLog(); keep('v026', log3c);
    check('only 2025-26 again: read, carrying on from its own progress (no full re-read)', JSON.stringify(companiesRead(log3c)) === JSON.stringify([OLD]) && r3c.vouchers.mode === 'unchanged', { companies: log3c.companies, v: r3c.vouchers });
    await control({ open: [OLD, NEW] });
    const r3d = await sync(agent);
    const log3d = await takeLog(); keep('v026', log3d);
    check('2026-27 again: back on it, carrying on from its own progress (no full re-read)', JSON.stringify(companiesRead(log3d)) === JSON.stringify([NEW]) && r3d.vouchers.mode === 'unchanged', { companies: log3d.companies, v: r3d.vouchers });
    check('...and keeps last year\'s progress parked for next time', !!(((config.load().syncState || {}).byCompany || {})[OLD] || {}).periodKey);
    newUntouched('...this year\'s rows still as before');
    checkFigures('after going back and forth', await analytics());

    /* ---------- 4. contacts request fails ---------- */
    scenario = '4 contacts request fails';
    console.log('\n[4] The contacts request fails (Tally error, then a dropped connection)');
    const contactsBefore = JSON.stringify(rowsOf('tally_ledgers', NEW).filter((r) => r.contact).map((r) => [r.tally_guid, r.contact]));
    const partiesSnap = JSON.stringify(DB.ledger_parties);
    await control({ open: [NEW], contacts: 'error' });
    agent.applyCommand({ action: 'resync' });   // a full re-read of the year, so vouchers are exercised too
    const r4 = await quiet(() => agent.runFullSync(config.load()));
    const log4 = await takeLog(); keep('v026', log4);
    check('Tally error on contacts: ledgers still sync', r4.ledgers && r4.ledgers.upserted === EXP[NEW].ledgers, r4.ledgers);
    check('...vouchers still sync (full re-read, every one)', r4.vouchers && !r4.vouchers.error && r4.vouchers.mode === 'full' && r4.vouchers.received === EXP[NEW].vouchers, r4.vouchers);
    check('...bills still sync', r4.bills && r4.bills.receivable && r4.bills.receivable.upserted === EXP[NEW].bills_receivable && r4.bills.payable.upserted === EXP[NEW].bills_payable, r4.bills);
    check('...both forms of the contacts request were tried, nothing else extra', log4.shapes.some((s) => s.label === 'MargynLedgerContacts (full)') && log4.shapes.some((s) => s.label === 'MargynLedgerContacts (lean)'), log4.shapes.map((s) => s.label));
    check('...contacts already stored survive; party master untouched', JSON.stringify(rowsOf('tally_ledgers', NEW).filter((r) => r.contact).map((r) => [r.tally_guid, r.contact])) === contactsBefore && JSON.stringify(DB.ledger_parties) === partiesSnap);
    countsOk('contacts failed', NEW, EXP[NEW]);
    checkFigures('contacts failed', await analytics());
    await control({ contacts: 'reset' });
    const r4b = await quiet(() => agent.runFullSync(config.load()));
    const log4b = await takeLog(); keep('v026', log4b);
    check('connection dropped on contacts: ledgers, vouchers, bills still sync', r4b.ledgers.upserted === EXP[NEW].ledgers && !r4b.vouchers.error && r4b.bills.receivable.upserted === EXP[NEW].bills_receivable, { l: r4b.ledgers, v: r4b.vouchers, b: r4b.bills });
    check('...and the contacts request is not switched off for good (sent again next sync)', !((config.load().syncState || {}).blockedRequests || []).some((k) => /contact/i.test(k)));
    checkFigures('contacts dropped', await analytics());
    await control({ contacts: 'ok' });
    const r4c = await sync(agent);
    await takeLog();
    check('contacts back: details arrive again', !r4c.vouchers.error && rowsOf('tally_ledgers', NEW).filter((r) => r.contact).length === withC.length);

    /* ---------- 6. chase ---------- */
    scenario = '6 chase';
    console.log('\n[6] Chase reminders from the synced party master');
    const run = async (who) => { const prep = await quiet(() => remind.prepare(U, who)); const r = prep.found ? await quiet(() => remind.send(U, prep)) : null; return { prep, r }; };
    // Reminders off: not set up at all, then paused.
    let x = await run('ACME RETAIL');
    check('reminders not set up: ACME (has a phone) is refused, nothing sent', x.prep.found && x.prep.out.has_phone && x.r.code === 409 && x.r.body.reminders_off === true && sent.length === 0, { code: x.r && x.r.code, err: x.r && x.r.body.error, sent: sent.length });
    DB.agent_deployments.push({ id: 'dep-chase', user_id: U, agent_id: 'chase_agent', status: 'paused', config: { enabled: true } });
    x = await run('ACME RETAIL');
    check('reminders OFF (paused): refused with plain words, stubbed send called 0 times', x.r.code === 409 && /switched off/.test(x.r.body.error) && sent.length === 0, { code: x.r.code, err: x.r.body.error, sent: sent.length });
    check('reminders OFF: WhatsApp door offers to switch them on instead', remind.whatsappVerdict(x.prep).reason === 'paused');
    // Reminders on.
    DB.agent_deployments[0].status = 'active';
    x = await run('ACME RETAIL');
    check('reminders ON: ACME found with the +91 number from the synced party, exactly one message', x.r.code === 200 && x.r.body.sent === true && sent.length === 1 && sent[0].to === '919820012345' && /^tpl-/.test(sent[0].templateId), { code: x.r.code, body: x.r.body && x.r.body.error, sent });
    check('...the chase is logged against the customer', DB.whatsapp_chases.length === 1 && DB.whatsapp_chases[0].contact_phone === '919820012345' && DB.whatsapp_chases[0].status === 'sent');
    x = await run('ACME RETAIL');
    check('...asking again the same day sends nothing more', x.r.code === 409 && sent.length === 1, { code: x.r.code });
    x = await run('BLANK PHONE TRADERS');
    check('debtor with no phone: plain "no WhatsApp number" refusal, nothing sent', x.prep.found && !x.prep.out.has_phone && x.r.code === 400 && x.r.body.error === 'need_phone' && /no WhatsApp number/.test(remind.whatsappVerdict(x.prep).say) && sent.length === 1,
      { found: x.prep.found, code: x.r && x.r.code, say: x.prep.found && remind.whatsappVerdict(x.prep).say });
    x = await run('LANDLINE MEDICALS');
    check('debtor with only a landline: "doesn\'t look like a mobile", nothing sent', x.prep.found && x.prep.out.phone_unusable && x.r.code === 400 && /doesn't look like a mobile/.test(remind.whatsappVerdict(x.prep).say) && sent.length === 1, { out: x.prep.out });
    x = await run('OWNER TYPED DISTRIBUTORS');
    check('owner-typed number is the one used (not Tally\'s)', x.r.code === 200 && sent.length === 2 && sent[1].to === '919999900000', { code: x.r.code, to: sent[1] && sent[1].to });
    x = await run('TWO NUMBER CLINIC');
    check('two numbers in Tally: the mobile is used', x.r.code === 200 && sent.length === 3 && sent[2].to === '919930054321', { code: x.r.code, to: sent[2] && sent[2].to });
    x = await run('NEW NAME TRADERS');
    { const rn = DB.ledger_parties.filter((p) => String((p.external_refs || {}).tally_guid || '').startsWith(renamedGuid));
      check('renamed debtor: still one party after last year\'s file was read (no duplicate)', rn.length === 1, rn.map((p) => [p.name, p.phone, p.external_refs.tally_guid])); }
    figure('party rows for the renamed debtor at chase time', 1, JSON.stringify(DB.ledger_parties.filter((p) => /NAME TRADERS/.test(p.name)).map((p) => [p.id, p.name, p.phone, p.source, p.external_refs])));
    figure('renamed debtor reminder (asked as NEW NAME TRADERS)', 'phone ending 2233', x.prep.found ? `found as "${x.prep.item.party}", phone ending ${x.prep.out.phone_end}` : 'not found');
    check('renamed debtor: reminder finds the number on its one party', x.prep.found && x.prep.out.has_phone, { found: x.prep.found, party: x.prep.found && x.prep.item.party, has_phone: x.prep.found && x.prep.out.has_phone, say: x.prep.found && remind.whatsappVerdict(x.prep).say });

    /* ---------- 7. request shapes ---------- */
    scenario = '7 request shapes';
    console.log('\n[7] Every distinct Tally request (company names, dates, change counters stripped)');
    const v24 = [...shapes.v024.keys()], v26 = [...shapes.v026.keys()];
    const contactsFull = v26.filter((s) => shapes.v026.get(s) === 'MargynLedgerContacts (full)');
    const contactsLean = v26.filter((s) => shapes.v026.get(s) === 'MargynLedgerContacts (lean)');
    const extra = v26.filter((s) => !v24.includes(s));
    const missing = v24.filter((s) => !v26.includes(s));
    console.log('  sent by 0.2.4: ' + [...new Set(shapes.v024.values())].sort().join(' | '));
    console.log('  sent by 0.2.6: ' + [...new Set(shapes.v026.values())].sort().join(' | '));
    console.log('  0.2.6 only:    ' + extra.map((s) => shapes.v026.get(s)).join(' | '));
    check('0.2.6 normal syncs send exactly 0.2.4\'s requests + the full contacts request', (() => {
      const normal = new Set([...log1.shapes, ...log2b.shapes, ...log3.shapes, ...log3r.shapes, ...log3b.shapes, ...log3c.shapes, ...log3d.shapes].map((s) => s.shape));
      const want = new Set(v24.concat(contactsFull));
      return normal.size === want.size && [...normal].every((s) => want.has(s));
    })(), { extra: extra.map((s) => shapes.v026.get(s)), missing: missing.map((s) => shapes.v024.get(s)) });
    check('over all runs, 0.2.6 = 0.2.4 ∪ {contacts full, contacts lean (only after the full one failed)}', extra.length === contactsFull.length + contactsLean.length && contactsFull.length === 1 && contactsLean.length === 1 && missing.length === 0,
      { extra: extra.map((s) => shapes.v026.get(s)), missing: missing.map((s) => shapes.v024.get(s)) });
    check('the GSTIN request is never sent to a client\'s Tally', !v26.some((s) => /MargynLedgerGstin/.test(s)));
    check('no fetch left this process (no Vercel, Supabase, Gupshup, R2)', blocked.length === 0, blocked);
    global.__shapes = { v24: [...shapes.v024.entries()], v26: [...shapes.v026.entries()] };
  } catch (e) {
    check('test ran to the end', false, e && (e.stack || e.message));
  } finally {
    mock.kill();
  }

  /* ------------------------------ report ------------------------------ */
  console.log('\nKey numbers (mock book vs what the server shows):');
  for (const n of numbers) console.log(`  [${n.scenario}] ${n.label}: mock ${n.mock}  server ${n.server}${typeof n.mock === 'number' && typeof n.server === 'number' && !near(n.mock, n.server) ? '   <-- differs' : ''}`);
  if (global.__shapes) {
    console.log('\nRequest shapes (label, then the body with names/dates stripped):');
    const all = new Map(global.__shapes.v26.concat(global.__shapes.v24));
    for (const [s, label] of [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const by = [global.__shapes.v24.some(([x]) => x === s) ? '0.2.4' : null, global.__shapes.v26.some(([x]) => x === s) ? '0.2.6' : null].filter(Boolean).join('+');
      console.log(`  - ${label}  [${by}]  ${crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)}  ${s.length} chars`);
    }
  }
  const failed = results.filter((r) => !r.ok), todos = results.filter((r) => r.todo);
  const by = {};
  for (const r of results) { by[r.scenario] = by[r.scenario] || { pass: 0, fail: 0, todo: 0 }; by[r.scenario][r.ok ? (r.todo ? 'todo' : 'pass') : 'fail']++; }
  console.log('\nPer scenario:');
  for (const [s, c] of Object.entries(by)) console.log(`  ${c.fail ? 'FAIL' : 'pass'}  ${s}: ${c.pass} passed, ${c.fail} failed${c.todo ? `, ${c.todo} TODO (known bug)` : ''}`);
  if (failed.length && process.env.SHOW_CHATTER === '1') console.log('\n' + chatter.slice(-80).join('\n') + '\n' + agentLines.slice(-60).join('\n'));
  console.log(`\n${results.length - failed.length - todos.length} passed, ${failed.length} failed, ${todos.length} TODO`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
