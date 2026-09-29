/**
 * What counts as an open invoice, and the Odoo deleted-at-source sweep.
 * Zero-dep. Run: node api/_lib/__tests__/openItems.test.js
 * Fakes: PostgREST (incl. or=() filters) and Odoo's JSON-RPC, both via fetch.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/* ---------- a PostgREST subset good enough for these readers ---------- */
function cond(r, k, op) {
  if (op === 'is.null') return r[k] == null;
  if (op.startsWith('eq.')) return String(r[k]) === op.slice(3);
  if (op.startsWith('neq.')) return String(r[k]) !== op.slice(4);
  if (op.startsWith('gt.')) return Number(r[k]) > Number(op.slice(3));
  if (op.startsWith('in.(')) return op.slice(4, -1).split(',').includes(String(r[k]));
  if (op.startsWith('not.in.(')) return r[k] != null && !op.slice(8, -1).split(',').includes(String(r[k]));
  throw new Error('unsupported ' + op);
}
function orParts(v) {   // "(a.is.null,a.not.in.(x,y))" -> ["a.is.null", "a.not.in.(x,y)"]
  const inner = v.slice(1, -1), out = []; let depth = 0, cur = '';
  for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; }
  return out.concat(cur);
}
function query(rows, qs) {
  const p = new URLSearchParams(qs);
  let out = rows;
  for (const [k, v] of p) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'or') { const parts = orParts(v).map((s) => { const i = s.indexOf('.'); return [s.slice(0, i), s.slice(i + 1)]; }); out = out.filter((r) => parts.some(([f, op]) => cond(r, f, op))); }
    else out = out.filter((r) => cond(r, k, v));
  }
  const off = Number(p.get('offset') || 0), lim = p.get('limit') ? Number(p.get('limit')) : Infinity;
  return out.slice(off, off + lim);
}
const DB = {
  receivables: [], payables: [], tally_installs: [], connector_credentials: [{ id: 'c1', user_id: 'u1', connector_type: 'odoo', disconnected_at: null, created_at: '2026-09-01' }],
  zoho_invoices: [
    { org_ref: 'o1', invoice_id: 'z1', invoice_number: 'INV-1', customer_name: 'Sent Co', balance: 1000, due_date: '2026-09-01', status: 'overdue' },
    { org_ref: 'o1', invoice_id: 'z2', invoice_number: 'INV-2', customer_name: 'Draft Co', balance: 5000, due_date: '2026-09-01', status: 'draft' },
    { org_ref: 'o1', invoice_id: 'z3', invoice_number: 'INV-3', customer_name: 'Void Co', balance: 7000, due_date: '2026-09-01', status: 'void' },
    { org_ref: 'o1', invoice_id: 'z4', invoice_number: 'INV-4', customer_name: 'Old Sync Co', balance: 300, due_date: '2026-09-01', status: null }
  ],
  zoho_bills: [],
  odoo_invoices: [
    { id: 'a', user_id: 'u1', cred_id: 'c1', odoo_move_id: 11, invoice_number: 'O-11', customer_name: 'Posted Co', balance: 2000, amount_total: 2000, due_date: '2026-09-01', state: 'posted' },
    { id: 'b', user_id: 'u1', cred_id: 'c1', odoo_move_id: 12, invoice_number: 'O-12', customer_name: 'Cancelled Co', balance: 4000, amount_total: 4000, due_date: '2026-09-01', state: 'cancel' },
    { id: 'c', user_id: 'u1', cred_id: 'c1', odoo_move_id: 13, invoice_number: 'O-13', customer_name: 'Draft Odoo Co', balance: 900, amount_total: 900, due_date: '2026-09-01', state: 'draft' }
  ],
  odoo_bills: []
};
const ODOO = { moves: {} };   // what the fake Odoo server still has, by id
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.pathname === '/jsonrpc') {
    const { params } = JSON.parse(opts.body);
    const [, , , model, method, args] = params.args;
    if (model === 'account.move' && method === 'search_read') {
      const ids = args[0][0][2];
      return { ok: true, json: async () => ({ result: ids.filter((id) => ODOO.moves[id]).map((id) => ODOO.moves[id]) }) };
    }
    return { ok: true, json: async () => ({ result: [] }) };
  }
  if (u.pathname === '/rest/v1/rpc/zoho_vitals') return { ok: true, json: async () => ({ connected: true, org_ref: 'o1' }) };
  const table = u.pathname.replace('/rest/v1/', '');
  if ((opts.method || 'GET') === 'PATCH') {
    const patch = JSON.parse(opts.body);
    const hit = query(DB[table], u.search.slice(1)); hit.forEach((r) => Object.assign(r, patch));
    return { ok: true, json: async () => hit };
  }
  if ((opts.method || 'GET') === 'POST') return { ok: true, json: async () => [] };
  return { ok: true, json: async () => query(DB[table] || [], u.search.slice(1)).map((r) => ({ ...r })) };
};

const M = require('../moneyModel');
const odoo = require('../../_odoo/odoo');

(async () => {
  /* ---------- only real open items reach the figures ---------- */
  const p = await M.positionForAccount('u1', { dirs: ['recv'], now: new Date('2026-09-30T06:00:00Z') });
  const names = p.receivables.groups.map((g) => g.party).sort();
  check('Zoho: drafts and voided invoices are not receivables', !names.includes('Draft Co') && !names.includes('Void Co') && names.includes('Sent Co'), names);
  check('Zoho: rows from older syncs without a status still count', names.includes('Old Sync Co'));
  check('Odoo: only posted moves count; cancelled and drafts do not', names.includes('Posted Co') && !names.includes('Cancelled Co') && !names.includes('Draft Odoo Co'), names);
  check('receivables total = 1,000 + 300 + 2,000', p.receivables.totals.total === 3300, p.receivables.totals.total);

  /* ---------- the Odoo sweep ---------- */
  DB.odoo_invoices = [
    { user_id: 'u1', cred_id: 'c1', odoo_move_id: 21, balance: 1000, amount_total: 1000, state: 'posted' },   // seen in this sync
    { user_id: 'u1', cred_id: 'c1', odoo_move_id: 22, balance: 2000, amount_total: 2000, state: 'posted' },   // cancelled in Odoo since
    { user_id: 'u1', cred_id: 'c1', odoo_move_id: 23, balance: 3000, amount_total: 3000, state: 'posted' },   // deleted in Odoo
    { user_id: 'u1', cred_id: 'c1', odoo_move_id: 24, balance: 0, amount_total: 500, state: 'posted' }       // already paid: left alone
  ];
  ODOO.moves = { 22: { id: 22, name: 'O-22', partner_id: [7, 'Acme'], amount_total_signed: 2000, amount_residual_signed: 2000, state: 'cancel', move_type: 'out_invoice', company_id: [1, 'Co'] } };
  const spec = { table: 'odoo_invoices', map: (r) => ({ odoo_move_id: r.id, state: r.state, balance: r.amount_residual_signed }) };
  const ctx = { userId: 'u1', credId: 'c1', now: '2026-09-30T06:00:00Z' };
  const out = await odoo.sweepMissing({ baseUrl: 'https://odoo.test', db: 'd', uid: 1, apiKey: 'k', fields: [], spec, ctx, seen: new Set([21]) });
  const row = (id) => DB.odoo_invoices.find((r) => r.odoo_move_id === id);
  check('a move Odoo still has comes back with its real state (cancelled) for the upsert', out.refreshed.length === 1 && out.refreshed[0].odoo_move_id === 22 && out.refreshed[0].state === 'cancel');
  check('a move Odoo no longer has is closed, its original amount kept', out.deleted === 1 && row(23).balance === 0 && row(23).state === 'deleted_at_source' && row(23).amount_total === 3000);
  check('moves seen in the sync, or already paid, are untouched', row(21).balance === 1000 && row(24).state === 'posted');

  // Fails safe: a sweep that would close most of the book is skipped.
  DB.odoo_invoices = Array.from({ length: 12 }, (_, i) => ({ user_id: 'u1', cred_id: 'c1', odoo_move_id: 100 + i, balance: 100, amount_total: 100, state: 'posted' }));
  ODOO.moves = {};
  let threw = null;
  try { await odoo.sweepMissing({ baseUrl: 'https://odoo.test', db: 'd', uid: 1, apiKey: 'k', fields: [], spec, ctx, seen: new Set([100]) }); } catch (e) { threw = e.message; }
  check('would close 11 of 12: skipped as a likely Odoo-side glitch, nothing closed', /likely Odoo-side glitch/.test(threw || '') && DB.odoo_invoices.every((r) => r.balance === 100), threw);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
