/** Run: node api/_lib/__tests__/tallyAgentIngest.test.js — agent 0.2.0 contract, fake Supabase, no network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };

const U = '11111111-1111-1111-1111-111111111111';
const DB = {
  tally_installs: [{ id: 'i1', key_hash: require('crypto').createHash('sha256').update('mtly_x').digest('hex'), user_id: U, company_name: 'CARE (2026-27)', status: 'active', last_sync_at: new Date().toISOString() }],
  tally_vouchers: [],
  tally_ledgers: [],
  tally_bills: [],
  tally_sync_runs: [],
  tally_ledger_classes: []
};
let diagnosticsColumn = true;

// Minimal PostgREST filter evaluator for the filters the handler uses.
function matches(row, search) {
  const p = new URLSearchParams(search);
  for (const [k, v] of p.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|gte|lte|lt|in)\.(.*)$/.exec(v);
    if (!m) continue;
    const val = row[k] == null ? '' : String(row[k]);
    if (m[1] === 'eq' && val !== m[2]) return false;
    if (m[1] === 'gte' && !(val >= m[2])) return false;
    if (m[1] === 'lte' && !(val <= m[2])) return false;
    if (m[1] === 'lt' && !(val < m[2])) return false;
    if (m[1] === 'in' && !m[2].replace(/[()]/g, '').split(',').includes(val)) return false;
  }
  return true;
}
// Repeated keys (date=gte..&date=lte..) — URLSearchParams.entries() keeps both. Good.

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const res = (b, s = 200, headers = {}) => ({ ok: s < 400, status: s, headers: { get: (h) => headers[h.toLowerCase()] || null }, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.pathname === '/auth/v1/user') return res({ id: U, email: 'a@b.c' });
  const table = u.pathname.replace('/rest/v1/', '');
  const rows = DB[table] || (DB[table] = []);
  if (method === 'HEAD') return res(null, 200, { 'content-range': `0-0/${rows.filter((r) => matches(r, u.search)).length}` });
  if (method === 'GET') {
    if (table === 'tally_installs' && /diagnostics/.test(u.search) && !diagnosticsColumn) return res({ message: 'column tally_installs.diagnostics does not exist' }, 400);
    return res(rows.filter((r) => matches(r, u.search)));
  }
  if (method === 'DELETE') { DB[table] = rows.filter((r) => !matches(r, u.search)); return res(null, 204); }
  if (method === 'PATCH') {
    const patch = JSON.parse(opts.body);
    if (table === 'tally_installs' && 'diagnostics' in patch && !diagnosticsColumn) return res({ message: "Could not find the 'diagnostics' column" }, 400);
    rows.filter((r) => matches(r, u.search)).forEach((r) => Object.assign(r, patch));
    return res([]);
  }
  if (method === 'POST') {
    const b = JSON.parse(opts.body);
    for (const r of b) {
      if (table === 'tally_vouchers') {
        const i = rows.findIndex((x) => x.install_id === r.install_id && x.tally_guid === r.tally_guid);
        if (i >= 0) rows[i] = Object.assign(rows[i], r); else rows.push(r);
      } else rows.push(r);
    }
    return res(b);
  }
  return res([]);
};

const handler = require('../../tally.js');
const call = async (method, query, body) => {
  let status, payload;
  const r = { setHeader() {}, status(s) { status = s; return this; }, json(p) { payload = p; return this; }, end() {} };
  await handler({ method, query, headers: { authorization: 'Bearer mtly_x' }, body }, r);
  return { status, payload };
};
const v = (guid, date, amt) => ({ guid, voucher_type: 'Sales', voucher_number: guid, date, party_name: 'P', amount: amt,
  entries: [{ ledger: 'P', amount: -amt, is_party: true }, { ledger: 'Sales', amount: amt }] });

(async () => {
  // Old rows from the 0.1 agent (Day Book days), one of which was later deleted in Tally.
  const old = '2026-09-01T00:00:00.000Z';
  DB.tally_vouchers.push(
    ...['a1', 'a2', 'a3'].map((g) => ({ install_id: 'i1', tally_guid: g, date: '2026-09-10', synced_at: old })),
    { install_id: 'i1', tally_guid: 'deleted-in-tally', date: '2026-09-15', synced_at: old },
    { install_id: 'i1', tally_guid: 'other-month', date: '2026-08-15', synced_at: old }
  );

  // First batch (not final) returns the server clock.
  let r = await call('POST', { action: 'ingest' }, { kind: 'vouchers', partial: true, rows: [v('a1', '2026-09-10', 100), v('a2', '2026-09-10', 200)] });
  check('ingest ok + server_time', r.status === 200 && typeof r.payload.server_time === 'string', r);
  const start = r.payload.server_time;
  check('non-final batch removes nothing', DB.tally_vouchers.length === 5);
  await new Promise((x) => setTimeout(x, 5));

  // Final batch of the verified window: a3 re-sent, deleted-in-tally not -> removed. August untouched.
  r = await call('POST', { action: 'ingest' }, { kind: 'vouchers', partial: true, rows: [v('a3', '2026-09-10', 300)],
    window: { from: '2026-09-01', to: '2026-09-30' }, window_final: true, window_started_at: start });
  check('voucher deleted in Tally is removed', !DB.tally_vouchers.some((x) => x.tally_guid === 'deleted-in-tally') && r.payload.removed === 1, r.payload);
  check('other months untouched', DB.tally_vouchers.some((x) => x.tally_guid === 'other-month'));
  check('re-sent vouchers kept', ['a1', 'a2', 'a3'].every((g) => DB.tally_vouchers.some((x) => x.tally_guid === g)));

  // Empty verified window: everything we hold there goes (Tally says zero).
  DB.tally_vouchers.push({ install_id: 'i1', tally_guid: 'stray', date: '2026-07-04', synced_at: old });
  r = await call('POST', { action: 'ingest' }, { kind: 'vouchers', partial: true, rows: [], window: { from: '2026-07-01', to: '2026-07-31' }, window_final: true });
  check('empty final window sweeps', r.status === 200 && !DB.tally_vouchers.some((x) => x.tally_guid === 'stray'), r);

  // Safety valve: a final window that would wipe most of a busy month is refused.
  for (let i = 0; i < 30; i++) DB.tally_vouchers.push({ install_id: 'i1', tally_guid: 'm' + i, date: '2026-06-1' + (i % 9), synced_at: old });
  r = await call('POST', { action: 'ingest' }, { kind: 'vouchers', partial: true, rows: [v('m0', '2026-06-10', 1)], window: { from: '2026-06-01', to: '2026-06-30' }, window_final: true });
  check('valve keeps a month that would be wiped', DB.tally_vouchers.filter((x) => /^m\d/.test(x.tally_guid)).length === 30, r.payload);

  // A PC clock in the future can't make the server delete what it just stored.
  r = await call('POST', { action: 'ingest' }, { kind: 'vouchers', partial: true, rows: [v('f1', '2026-05-02', 5)], window: { from: '2026-05-01', to: '2026-05-31' }, window_final: true, window_started_at: '2099-01-01T00:00:00Z' });
  check('future cutoff ignored', DB.tally_vouchers.some((x) => x.tally_guid === 'f1'), r.payload);

  // Ledger snapshot in two batches: the last batch sweeps with the first batch's server time.
  DB.tally_ledgers.push(...Array.from({ length: 10 }, (_, i) => ({ install_id: 'i1', tally_guid: 'L' + i, name: 'L' + i, synced_at: old })), { install_id: 'i1', tally_guid: 'gone', name: 'gone', synced_at: old });
  const led = (n) => ({ guid: n, name: n, parent: 'Sundry Debtors' });
  r = await call('POST', { action: 'ingest' }, { kind: 'ledgers', partial: true, rows: [0, 1, 2, 3, 4].map((i) => led('L' + i)) });
  const ls = r.payload.server_time;
  await new Promise((x) => setTimeout(x, 5));
  r = await call('POST', { action: 'ingest' }, { kind: 'ledgers', snapshot_started_at: ls, rows: [5, 6, 7, 8, 9].map((i) => led('L' + i)) });
  check('chunked ledger snapshot keeps batch 1', [0, 1, 2, 3, 4].every((i) => DB.tally_ledgers.some((x) => x.name === 'L' + i)), DB.tally_ledgers.map((x) => x.name));
  check('chunked ledger snapshot drops deleted ledger', !DB.tally_ledgers.some((x) => x.name === 'gone'), r.payload);

  // Health report stored; product facts filled; tolerated without the column.
  const health = { agent_version: '0.2.0', company: 'CARE (2026-27)', tally: { product: 'tallyprime', product_name: 'TallyPrime', version: '6.0', edition: 'gold' },
    vouchers: { strategy: 'collection-date', months: { '2026-04': { tally: 120, synced: 120, complete: true }, '2026-05': { tally: 124, synced: 124, complete: true } } } };
  r = await call('POST', { action: 'health' }, health);
  check('health stored', r.status === 200 && DB.tally_installs[0].diagnostics && DB.tally_installs[0].tally_product === 'tallyprime' && DB.tally_installs[0].agent_version === '0.2.0', DB.tally_installs[0]);
  diagnosticsColumn = false;
  DB.tally_installs[0].tally_version = null;
  r = await call('POST', { action: 'health' }, health);
  check('health without the column still records product', r.status === 200 && DB.tally_installs[0].tally_version === '6.0', DB.tally_installs[0]);
  diagnosticsColumn = true;
  r = await call('POST', { action: 'health' }, { junk: 'x'.repeat(70000) });
  check('oversized health rejected', r.status === 413);
  await call('POST', { action: 'health' }, health);

  // Analytics tells the user the books match Tally month by month.
  r = await call('GET', { action: 'analytics' });
  check('analytics proves completeness', r.status === 200 && r.payload.quality.tally_completeness && r.payload.quality.tally_completeness.tally_vouchers === 244 &&
    r.payload.quality.reasons.some((x) => /matches Tally's own voucher count/.test(x)), r.payload.quality);
  health.vouchers.months['2026-05'] = { tally: 124, synced: 100, complete: false };
  await call('POST', { action: 'health' }, health);
  r = await call('GET', { action: 'analytics' });
  check('a short month is called out and lowers confidence', r.payload.quality.confidence === 'low' && r.payload.quality.reasons.some((x) => /2026-05/.test(x)), r.payload.quality.reasons);
  diagnosticsColumn = false;
  r = await call('GET', { action: 'analytics' });
  check('analytics works before the migration', r.status === 200 && r.payload.connected === true, r.status);

  r = await call('POST', { action: 'health' }, health);
  const bad = await (async () => { let status; const rr = { setHeader() {}, status(s) { status = s; return this; }, json() { return this; }, end() {} }; await handler({ method: 'POST', query: { action: 'health' }, headers: {}, body: health }, rr); return status; })();
  check('health needs the install key', bad === 401, bad);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
