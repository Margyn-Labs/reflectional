/**
 * The Books layer (api/_lib/dataLayer/books.js): Tally, Zoho Books and Odoo become one book the engine reads;
 * one source is primary, the others compared, never added. Zero-dep. Run: node api/_lib/__tests__/booksLayer.test.js
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
const L = require('../dataLayer/books');
const A = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };
const NOW = new Date('2026-10-04T06:00:00Z');
const month = (an, m) => (an.pnl || []).find((r) => r.month === m) || {};

// ---------- Zoho ----------
const zoho = {
  org: { id: 'o1', organization_name: 'Zeta Traders', last_sync_at: '2026-10-04T01:00:00Z' },
  accounts: [{ id: 'a1', account_name: 'Sales', account_type: 'income' }, { id: 'a2', account_name: 'Rent', account_type: 'expense' }, { id: 'a3', account_name: 'Cost of goods', account_type: 'cost_of_goods_sold' }],
  journals: [
    { account_ref: 'a1', transaction_id: 't1', entry_date: '2026-08-05', credit: 100000, debit: 0 },
    { account_ref: 'a2', transaction_id: 't2', entry_date: '2026-08-01', debit: 20000, credit: 0 },
    { account_ref: 'a3', transaction_id: 't3', entry_date: '2026-08-06', debit: 50000, credit: 0 },
    { account_ref: 'a2', transaction_id: 't4', entry_date: '2026-09-01', debit: 20000, credit: 0 }
  ],
  invoices: [
    { invoice_id: 'i1', invoice_number: 'INV-1', customer_ref: 'c1', customer_name: 'Alpha', total: 118000, sub_total: 100000, balance: 18000, status: 'partially_paid', invoice_date: '2026-08-05', due_date: '2026-08-20' },
    { invoice_id: 'i2', invoice_number: 'INV-2', customer_ref: 'c1', customer_name: 'Alpha', total: 59000, sub_total: 50000, balance: 59000, status: 'sent', invoice_date: '2026-09-10', due_date: '2026-10-10' },
    { invoice_id: 'i3', invoice_number: 'INV-3', customer_ref: 'c2', customer_name: 'Beta', total: 1000, sub_total: 1000, balance: 1000, status: 'draft', invoice_date: '2026-09-11', due_date: '2026-10-10' }
  ],
  bills: [{ bill_id: 'b1', bill_number: 'B-1', vendor_ref: 'v1', vendor_name: 'Vendor One', total: 30000, balance: 30000, status: 'open', bill_date: '2026-09-01', due_date: '2026-09-15' }],
  customerPayments: [{ payment_id: 'p1', customer_ref: 'c1', amount: 100000, payment_date: '2026-09-20' }],
  vendorPayments: [{ payment_id: 'q1', vendor_ref: 'v1', amount: 10000, payment_date: '2026-09-25' }],
  banks: [{ account_id: 'k1', bank_name: 'HDFC', account_type: 'bank', current_balance: 250000, is_primary: true }]
};
let zb = L.zohoToBook(zoho);
let an = A.computeAnalytics({ ledgers: zb.ledgers, vouchers: zb.vouchers, bills: zb.bills, overrides: {}, now: NOW });
check('Zoho: sales before GST from invoices (Aug ₹1 L, not ₹1.18 L)', Math.round(month(an, '2026-08').net_sales) === 100000, month(an, '2026-08'));
check('Zoho: income journals not counted on top of invoices', Math.round(month(an, '2026-08').net_sales) === 100000);
check('Zoho: draft invoices left out', Math.round(month(an, '2026-09').net_sales) === 50000, month(an, '2026-09'));
check('Zoho: running costs from expense accounts', Math.round(month(an, '2026-08').opex) === 20000, month(an, '2026-08').opex);
check('Zoho: cost of goods from COGS accounts', Math.round(month(an, '2026-08').cogs_pre_stock) === 50000, month(an, '2026-08'));
check('Zoho: cash = bank balance', an.cash && Math.round(an.cash.total) === 250000, an.cash);
const pt = (d) => (an.cash_history.points.find((p) => p.date === d) || {}).cash;
check('Zoho: cash history walks back through payments (money in → lower before)', pt('2026-09-19') === 250000 - 100000 + 10000 && pt('2026-09-24') === 250000 + 10000, { a: pt('2026-09-19'), b: pt('2026-09-24') });
check('Zoho: open receivables = unpaid invoice balances', zb.bills.filter((b) => b.direction === 'receivable').reduce((t, b) => t + b.closing_balance, 0) === 77000);
check('Zoho: open payables', zb.bills.filter((b) => b.direction === 'payable').length === 1);
check('Zoho: customer split exists', (an.customers || []).some((c) => /alpha/i.test(c.party)), an.customers);
check('Zoho: source named', zb.source === 'zoho' && zb.source_name === 'Zoho Books' && zb.company === 'Zeta Traders');

// Older rows without sub_total: sales from the income account, said plainly.
zb = L.zohoToBook(Object.assign({}, zoho, { invoices: zoho.invoices.map(({ sub_total, ...r }) => r) }));
an = A.computeAnalytics({ ledgers: zb.ledgers, vouchers: zb.vouchers, bills: zb.bills, overrides: {}, now: NOW });
check('Zoho without sub_total: sales from income journals', Math.round(month(an, '2026-08').net_sales) === 100000, month(an, '2026-08'));
check('Zoho without sub_total: note says why', zb.notes.some((n) => /without the split by customer/.test(n)));

// ---------- Odoo ----------
const ob = L.odooToBook({
  company: 'Omega', lastSync: '2026-10-03T10:00:00Z', cash: { balance: 40000 },
  invoices: [
    { odoo_move_id: 1, invoice_number: 'INV/1', customer_name: 'Cust', invoice_date: '2026-09-02', due_date: '2026-09-30', amount_total: 11800, amount_untaxed: 10000, balance: 11800, move_type: 'out_invoice', state: 'posted' },
    { odoo_move_id: 2, invoice_number: 'RINV/1', customer_name: 'Cust', invoice_date: '2026-09-05', due_date: '2026-09-05', amount_total: -1180, amount_untaxed: -1000, balance: 0, move_type: 'out_refund', state: 'posted' },
    { odoo_move_id: 3, invoice_number: 'INV/2', customer_name: 'Cust', invoice_date: '2026-09-06', amount_total: 500, amount_untaxed: 500, balance: 500, move_type: 'out_invoice', state: 'draft' }
  ],
  bills: [
    { odoo_move_id: 4, bill_number: 'BILL/1', vendor_name: 'Supp', bill_date: '2026-09-03', due_date: '2026-09-20', amount_total: -5900, amount_untaxed: -5000, balance: -5900, move_type: 'in_invoice', state: 'posted' },
    { odoo_move_id: 5, bill_number: 'BILL/2', vendor_name: 'Supp', bill_date: '2026-09-04', amount_total: -100, amount_untaxed: null, balance: 0, move_type: 'in_invoice', state: 'posted' }
  ]
});
an = A.computeAnalytics({ ledgers: ob.ledgers, vouchers: ob.vouchers, bills: ob.bills, overrides: {}, now: NOW });
const sep = month(an, '2026-09');
check('Odoo: sales before tax, less refunds (₹9,000)', Math.round(sep.net_sales) === 9000, sep);
check('Odoo: purchases before tax (₹5,000)', Math.round(sep.cogs_pre_stock) === 5000, sep);
check('Odoo: drafts left out', !ob.vouchers.some((v) => v.voucher_number === 'INV/2'));
check('Odoo: rows without untaxed left out and said', !ob.vouchers.some((v) => v.voucher_number === 'BILL/2') && ob.notes.some((n) => /before tax/.test(n)));
check('Odoo: says running costs are missing', ob.notes.some((n) => /running costs/.test(n)));
check('Odoo: open payable amount positive', ob.bills.find((b) => b.direction === 'payable').closing_balance === 5900);
check('Odoo: cash', an.cash && an.cash.total === 40000, an.cash);

// ---------- one place ----------
const T = { connected: true, source: 'tally', lastSync: '2026-10-01T00:00:00Z', vouchers: [1], bills: [], ledgers: [] };
const Z = { connected: true, source: 'zoho', lastSync: '2026-10-03T00:00:00Z', vouchers: [1], bills: [], ledgers: [] };
const O = { connected: true, source: 'odoo', lastSync: '2026-10-04T00:00:00Z', vouchers: [1], bills: [], ledgers: [] };
check('primary: equal trust → most recent (Zoho over older Tally)', L.choosePrimary([T, Z]) === Z);
check('primary: full books beat invoices-only, even if older', L.choosePrimary([T, O]) === T);
check('primary: an empty connection loses to one with entries', L.choosePrimary([Object.assign({}, Z, { vouchers: [], bills: [], ledgers: [] }), T]) === T);

// loadBooks over a fake Supabase: Tally-only, Zoho-only, both (compared, never added).
const U1 = 'u-tally', U2 = 'u-zoho', U3 = 'u-both', NONE = 'u-none';
const DB = {
  tally_installs: [{ id: 'i1', user_id: U1, status: 'active', company_name: 'Acme', last_sync_at: '2026-10-01T00:00:00Z' }, { id: 'i3', user_id: U3, status: 'active', company_name: 'Both Co', last_sync_at: '2026-10-01T00:00:00Z' }],
  tally_ledgers: [{ install_id: 'i1', name: 'Sales', parent: 'Sales Accounts' }, { install_id: 'i3', name: 'Sales', parent: 'Sales Accounts' }],
  tally_vouchers: [{ install_id: 'i1', tally_guid: 'g1', voucher_type: 'Sales', date: '2026-09-01', party_name: 'X', amount: 100, entries: [{ ledger: 'X', amount: -100, is_party: true }, { ledger: 'Sales', amount: 100 }] },
    { install_id: 'i3', tally_guid: 'g3', voucher_type: 'Sales', date: '2026-09-01', party_name: 'X', amount: 100, entries: [{ ledger: 'X', amount: -100, is_party: true }, { ledger: 'Sales', amount: 100 }] }],
  tally_bills: [{ install_id: 'i3', direction: 'receivable', party_name: 'X', bill_ref: 'A', closing_balance: 100 }],
  zoho_organizations: [{ id: 'o2', user_id: U2, status: 'active', organization_name: 'Zed', last_sync_at: '2026-10-03T00:00:00Z' }, { id: 'o3', user_id: U3, status: 'active', organization_name: 'Both Co', last_sync_at: '2026-10-04T00:00:00Z' }],
  zoho_invoices: [{ org_ref: 'o2', invoice_id: 'z1', customer_name: 'Y', total: 118, sub_total: 100, balance: 118, status: 'sent', invoice_date: '2026-09-02' },
    { org_ref: 'o3', invoice_id: 'z3', customer_name: 'X', total: 236, sub_total: 200, balance: 236, status: 'sent', invoice_date: '2026-09-02' }]
};
const val = (u, k) => (u.searchParams.get(k) || '').replace(/^(eq|in)\./, '').replace(/[()]/g, '');
global.fetch = async (url) => {
  const u = new URL(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const table = u.pathname.replace('/rest/v1/', '');
  let rows = DB[table] || [];
  const uid = val(u, 'user_id'), inst = val(u, 'install_id'), org = val(u, 'org_ref');
  if (uid && rows.length && 'user_id' in rows[0]) rows = rows.filter((r) => r.user_id === uid);
  if (inst) rows = rows.filter((r) => inst.split(',').includes(r.install_id));
  if (org) rows = rows.filter((r) => r.org_ref === org);
  const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
  return ok(rows.slice(off, off + lim));
};
(async () => {
  let b = await L.loadBooks(U1);
  check('loadBooks: Tally-only account reads Tally', b.connected && b.source === 'tally' && b.vouchers.length === 1 && !b.compare.length, { s: b.source, c: b.compare });
  b = await L.loadBooks(U2);
  check('loadBooks: Zoho-only account reads Zoho', b.connected && b.source === 'zoho' && b.company === 'Zed', { s: b.source, co: b.company });
  b = await L.loadBooks(U3);
  check('loadBooks: both → one primary (Zoho, newer), the other compared', b.source === 'zoho' && b.compare.length === 2 && b.sources.filter((s) => s.primary).length === 1, { s: b.source, cmp: b.compare });
  check('loadBooks: sources are never added (primary receivables = Zoho only)', b.bills.filter((x) => x.direction === 'receivable').reduce((t, x) => t + x.closing_balance, 0) === 236);
  check('loadBooks: compare carries each source\'s own figure', b.compare.find((c) => c.source === 'tally').receivables === 100 && b.compare.find((c) => c.source === 'zoho').receivables === 236, b.compare);
  const again = await L.loadBooks(U3);
  check('loadBooks: same object while nothing changed (callers can cache on it)', again === b);
  b = await L.loadBooks(NONE);
  check('loadBooks: nothing connected', b.connected === false);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
