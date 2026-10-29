/** Run: node api/_lib/__tests__/zohoParity.test.js
 *  Tally parity for Zoho Books. One business, kept once in Zoho Books and once in Tally. The Zoho rows go
 *  through the real sync mappers (sync.js), then every books tool (the same tools the app chat, voice and
 *  WhatsApp use) runs on both books. The Zoho answers must match Zoho's own P&L, and match the Tally answers. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const ZU = 'aaaaaaaa-0000-0000-0000-00000000000z', TU = 'aaaaaaaa-0000-0000-0000-00000000000t';
const ORG = 'org-z';

/* ---------------- the business, as Zoho Books keeps it (shapes recorded from a live .in org, 29 Oct 2026) */
const sync = require('../../_zoho/sync');
const Z = {
  coa: [['S', 'Sales', 'income'], ['OI', 'Interest Income', 'other_income'], ['C', 'Cost of Goods Sold', 'cost_of_goods_sold'], ['R', 'Rent Expense', 'expense'], ['BK', 'HDFC Current A/c', 'bank']],
  invoices: [
    { invoice_id: 'I1', invoice_number: 'INV-1', customer_id: 'CA', customer_name: 'Alpha Pharma Ltd', total: 100000, balance: 100000, status: 'sent', date: '2026-10-05', due_date: '2026-11-04' },
    { invoice_id: 'I2', invoice_number: 'INV-2', customer_id: 'CB', customer_name: 'Beta Traders', total: 50000, balance: 20000, status: 'partially_paid', date: '2026-07-01', due_date: '2026-07-31' },
    { invoice_id: 'I3', invoice_number: 'INV-3', customer_id: 'CG', customer_name: 'Gamma Retail', total: 30000, balance: 30000, status: 'void', date: '2026-10-07', due_date: '2026-11-06' },
    { invoice_id: 'I4', invoice_number: 'INV-4', customer_id: 'CA', customer_name: 'Alpha Pharma Ltd', total: 20000, balance: 0, status: 'paid', date: '2026-10-10', due_date: '2026-10-20' }
  ],
  bills: [
    { bill_id: 'B1', bill_number: 'SUP-1', vendor_id: 'VA', vendor_name: 'Apex Supplies', total: 40000, balance: 40000, status: 'overdue', date: '2026-09-01', due_date: '2026-10-01' },
    { bill_id: 'B2', bill_number: 'RENT-OCT', vendor_id: 'VL', vendor_name: 'Landlord LLP', total: 10000, balance: 0, status: 'paid', date: '2026-10-01', due_date: '2026-10-05' }
  ],
  customerpayments: [
    { payment_id: 'P1', payment_number: 'R1', customer_id: 'CB', amount: 30000, date: '2026-09-01', invoices: [{ invoice_id: 'I2' }] },
    { payment_id: 'P2', payment_number: 'R2', customer_id: 'CA', amount: 20000, date: '2026-10-20', invoices: [{ invoice_id: 'I4' }] }
  ],
  vendorpayments: [{ payment_id: 'VP1', payment_number: 'V1', vendor_id: 'VL', amount: 10000, date: '2026-10-05', bills: [{ bill_id: 'B2' }] }],
  banks: [{ account_id: 'BK', account_name: 'HDFC Current A/c', bank_name: 'HDFC Bank', account_type: 'bank', balance: 185000, is_primary_account: true }],
  // GET chartofaccounts/transactions?account_id=..: debit_amount / credit_amount, "" on the unused side.
  postings: {
    // [document, posting, date, debit, credit, contact]; Zoho puts the contact in customer_id even on bills.
    S: [['I1', 'c1', '2026-10-05', '', 100000, 'CA'], ['I2', 'c2', '2026-07-01', '', 50000, 'CB'], ['I4', 'c4', '2026-10-10', '', 20000, 'CA'], ['CN1', 'c5', '2026-10-15', 5000, '', 'CA']],
    OI: [['J1', 'c6', '2026-10-28', '', 1000, '']],
    C: [['B1', 'c7', '2026-09-01', 40000, '', 'VA']],
    R: [['B2', 'c8', '2026-10-01', 10000, '', 'VL'], ['E1', 'c9', '2026-10-27', 15000, '', '']],
    // Bank side: the expense and the interest journal carry their document; payments carry none (live shape).
    BK: [['E1', 'c10', '2026-10-27', '', 15000, ''], ['J1', 'c11', '2026-10-28', 1000, '', ''],
      ['', 'c12', '2026-09-01', 30000, '', 'CB'], ['', 'c13', '2026-10-20', 20000, '', 'CA'], ['', 'c14', '2026-10-05', '', 10000, 'VL']]
  }
};
// Zoho's own Profit and Loss for October: income 1,00,000 + 20,000 - 5,000 (credit note) + 1,000 (interest)
// = 1,16,000; COGS 0 in October (the bill is September); rent 10,000 (bill) + 15,000 (expense). Net 91,000.
const ZOHO_PL_OCT = { income: 116000, cogs: 0, opex: 25000, net_profit: 91000 };

const db = {};
const t = (n) => (db[n] = db[n] || []);
const coaRows = Z.coa.map(([id, name, type]) => ({ id: 'acc-' + id, org_ref: ORG, ...sync._mapAccount({ account_id: id, account_name: name, account_type: type }, ORG) }));
t('zoho_chart_of_accounts').push(...coaRows);
t('zoho_invoices').push(...Z.invoices.map((r) => sync._mapInvoice(r, ORG)));
t('zoho_bills').push(...Z.bills.map((r) => sync._mapBill(r, ORG)));
t('zoho_customer_payments').push(...Z.customerpayments.map((r) => sync._mapCustomerPayment(r, ORG)));
t('zoho_vendor_payments').push(...Z.vendorpayments.map((r) => sync._mapVendorPayment(r, ORG)));
t('zoho_bank_accounts').push(...Z.banks.map((r) => sync._mapBankAccount(r, ORG)));
for (const [acc, rows] of Object.entries(Z.postings)) {
  const txns = rows.map(([doc, cat, date, dr, cr, who]) => ({ transaction_id: doc || '', entry_number: doc || '', categorized_transaction_id: cat, transaction_date: date, debit_amount: dr, credit_amount: cr, debit_or_credit: dr ? 'debit' : 'credit', customer_id: who }));
  t('zoho_journal_entries').push(...sync.journalRows(txns, { id: 'acc-' + acc, account_id: acc }, ORG));
}
t('zoho_organizations').push({ id: ORG, user_id: ZU, status: 'active', organization_name: 'Acme (Zoho)', connected_at: '2026-10-01T00:00:00Z', last_synced_at: new Date().toISOString() });

/* ---------------- the same business, as Tally keeps it */
const tv = (type, date, party, entries, n) => ({ install_id: 'ti', tally_guid: 'tg-' + n, voucher_type: type, voucher_number: n, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
t('tally_installs').push({ id: 'ti', user_id: TU, status: 'active', company_name: 'Acme (Tally)', last_sync_at: new Date().toISOString() });
t('tally_ledgers').push(
  { install_id: 'ti', name: 'Sales', parent: 'Sales Accounts' }, { install_id: 'ti', name: 'Interest Income', parent: 'Indirect Incomes' },
  { install_id: 'ti', name: 'Cost of Goods Sold', parent: 'Purchase Accounts' }, { install_id: 'ti', name: 'Rent Expense', parent: 'Indirect Expenses' },
  { install_id: 'ti', name: 'HDFC Current A/c', parent: 'Bank Accounts', closing_balance: 185000 },
  { install_id: 'ti', name: 'Alpha Pharma Ltd', parent: 'Sundry Debtors' }, { install_id: 'ti', name: 'Beta Traders', parent: 'Sundry Debtors' },
  { install_id: 'ti', name: 'Apex Supplies', parent: 'Sundry Creditors' }, { install_id: 'ti', name: 'Landlord LLP', parent: 'Sundry Creditors' });
t('tally_vouchers').push(
  tv('Sales', '20261005', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: -100000, is_party: true }, { ledger: 'Sales', amount: 100000 }], 'INV-1'),
  tv('Sales', '20260701', 'Beta Traders', [{ ledger: 'Beta Traders', amount: -50000, is_party: true }, { ledger: 'Sales', amount: 50000 }], 'INV-2'),
  tv('Sales', '20261010', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: -20000, is_party: true }, { ledger: 'Sales', amount: 20000 }], 'INV-4'),
  tv('Credit Note', '20261015', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: 5000, is_party: true }, { ledger: 'Sales', amount: -5000 }], 'CN1'),
  tv('Receipt', '20261028', null, [{ ledger: 'HDFC Current A/c', amount: -1000 }, { ledger: 'Interest Income', amount: 1000 }], 'J1'),
  tv('Purchase', '20260901', 'Apex Supplies', [{ ledger: 'Apex Supplies', amount: 40000, is_party: true }, { ledger: 'Cost of Goods Sold', amount: -40000 }], 'P1'),
  tv('Purchase', '20261001', 'Landlord LLP', [{ ledger: 'Landlord LLP', amount: 10000, is_party: true }, { ledger: 'Rent Expense', amount: -10000 }], 'P2'),
  tv('Receipt', '20260901', 'Beta Traders', [{ ledger: 'Beta Traders', amount: 30000, is_party: true }, { ledger: 'HDFC Current A/c', amount: -30000 }], 'R1'),
  tv('Receipt', '20261020', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: 20000, is_party: true }, { ledger: 'HDFC Current A/c', amount: -20000 }], 'R2'),
  tv('Payment', '20261005', 'Landlord LLP', [{ ledger: 'Landlord LLP', amount: -10000, is_party: true }, { ledger: 'HDFC Current A/c', amount: 10000 }], 'V1'),
  tv('Payment', '20261027', null, [{ ledger: 'Rent Expense', amount: -15000 }, { ledger: 'HDFC Current A/c', amount: 15000 }], 'V2'));
t('tally_bills').push(
  { install_id: 'ti', user_id: TU, direction: 'receivable', party_name: 'Alpha Pharma Ltd', bill_ref: 'INV-1', bill_date: '2026-10-05', due_date: '2026-11-04', closing_balance: 100000, overdue_days: null },
  { install_id: 'ti', user_id: TU, direction: 'receivable', party_name: 'Beta Traders', bill_ref: 'INV-2', bill_date: '2026-07-01', due_date: '2026-07-31', closing_balance: 20000, overdue_days: null },
  { install_id: 'ti', user_id: TU, direction: 'payable', party_name: 'Apex Supplies', bill_ref: 'SUP-1', bill_date: '2026-09-01', due_date: '2026-10-01', closing_balance: -40000, overdue_days: null });

/* ---------------- fake PostgREST over db */
function match(row, k, v) {
  const val = row[k];
  if (v.startsWith('eq.')) return String(val) === decodeURIComponent(v.slice(3));
  if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(val));
  if (v.startsWith('gt.')) return Number(val) > Number(v.slice(3));
  if (v.startsWith('gte.')) return String(val) >= v.slice(4);
  if (v.startsWith('lt.')) return String(val) < v.slice(3);
  if (v.startsWith('lte.')) return String(val) <= v.slice(4);
  if (v.startsWith('not.in.(')) return !v.slice(8, -1).split(',').includes(String(val));
  if (v === 'is.null') return val == null;
  if (v === 'not.is.null') return val != null;
  return true;
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.pathname === '/auth/v1/user') return ok({ id: ZU });
  if (u.pathname.startsWith('/rest/v1/rpc/')) return ok(null);
  const table = u.pathname.replace('/rest/v1/', '');
  if ((opts.method || 'GET') !== 'GET') return ok([]);
  let rows = (db[table] || []).slice();
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(k)) continue;
    rows = rows.filter((r) => match(r, k, v));
  }
  const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
  return ok(rows.slice(off, off + Math.min(lim, 1000)));
};

const B = require('../booksTools');
const CALLS = {
  books_summary: { period: 'this_fy' }, books_breakdown: { measure: 'sales', by: 'customer' }, customer_or_vendor: { name: 'alpha' },
  products: { sort: 'sales' }, money_owed: {}, find_entries: { kind: 'receipt' }, cash_and_loans: {}, cash_flow_statement: {},
  borrowing_history: {}, what_needs_attention: {}, books_health_check: {}, how_its_calculated: { figure: 'net profit' }
};

(async () => {
  const out = { z: {}, t: {} };
  for (const [name, input] of Object.entries(CALLS)) {
    out.z[name] = await B.exec(name, input, ZU);
    out.t[name] = await B.exec(name, input, TU);
  }
  if (process.env.DUMP) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log('# every tool answers on both books');
  for (const name of Object.keys(CALLS)) {
    check(name + ': Zoho answers', out.z[name] && !out.z[name].error, out.z[name]);
    check(name + ': Tally answers', out.t[name] && !out.t[name].error, out.t[name]);
  }

  console.log('# same answers, figure for figure');
  // Only the books system's own name may differ ("Zoho Books" where Tally says "Tally").
  const flat = (x, p = '', o = {}) => { if (x && typeof x === 'object') { for (const k of Object.keys(x)) flat(x[k], p ? p + '.' + k : k, o); } else o[p] = x; return o; };
  const neutral = (v) => (typeof v === 'string' ? v.replace(/Zoho Books|Tally books|Tally/g, 'BOOKS').replace(/Acme \((Zoho|Tally|BOOKS)\)/g, 'Acme').replace(/last synced [^.]*/g, 'last synced') : v);
  for (const name of Object.keys(CALLS)) {
    const a = flat(out.z[name]), b = flat(out.t[name]);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const diff = keys.filter((k) => JSON.stringify(neutral(a[k])) !== JSON.stringify(neutral(b[k])));
    check(name + ': Zoho answer = Tally answer', diff.length === 0, diff.map((k) => k + ' Z=' + JSON.stringify(a[k]) + ' T=' + JSON.stringify(b[k])));
  }

  console.log('# Zoho answers name Zoho Books, never Tally');
  // how_its_calculated explains every source by design ("Tally: ...; Zoho Books: ..."), so it is left out.
  const zText = JSON.stringify(Object.fromEntries(Object.entries(out.z).filter(([k]) => k !== 'how_its_calculated')));
  check('no "Tally" in any Zoho answer', !/Tally/.test(zText), (zText.match(/.{60}Tally.{40}/g) || []).slice(0, 3));
  check('source line reads "From your Zoho Books"', /^From your Zoho Books \(Acme \(Zoho\)\)/.test(out.z.books_summary.source), out.z.books_summary.source);

  console.log("# matches Zoho's own Profit and Loss");
  const vit = require('../../_zoho/vitals');
  const nm = vit.netMarginFrom(db.zoho_chart_of_accounts, db.zoho_journal_entries, '2026-10');
  check('vitals net margin = Zoho P&L for October', nm.income === ZOHO_PL_OCT.income && nm.cogs === ZOHO_PL_OCT.cogs && nm.opex === ZOHO_PL_OCT.opex && nm.net_profit === ZOHO_PL_OCT.net_profit, nm);
  const oct = (out.z.books_summary.by_month || []).find((m) => /Oct 2026/.test(m.month));
  check('books layer October profit = Zoho P&L net', oct && oct.profit === '₹91,000', oct);
  check('receipts carry Zoho\'s numbers', out.z.find_entries.entries.every((e) => /^(R|J)\d$/.test(e.number)), out.z.find_entries.entries);
  check('cash = Zoho bank balance', out.z.cash_and_loans.cash_and_bank_total === '₹1.85 L', out.z.cash_and_loans.cash_and_bank_total);

  console.log('# "Is all your data in?" works for Zoho too');
  const { zohoCompleteness } = require('../dataCompleteness');
  const { loadBooks } = require('../dataLayer/books');
  const zb = await loadBooks(ZU);
  const live = (r) => Number(r.balance) > 0 && !/^(draft|void|deleted_at_source)$/.test(r.status);
  const comp = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2 },
    stored: { invoices: db.zoho_invoices.length, bills: db.zoho_bills.length, customer_payments: 2, vendor_payments: 1, postings: db.zoho_journal_entries.length, pnl_accounts: 5,
      open_invoices: db.zoho_invoices.filter(live).length, open_bills: db.zoho_bills.filter(live).length }, sweptAt: new Date().toISOString() });
  check('completeness: all green on a whole Zoho book', comp.status === 'ok' && comp.checks.every((c) => c.status !== 'warn'), comp.checks);
  const noPnl = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2 }, stored: { invoices: 4, bills: 2, postings: 0, open_invoices: 2, open_bills: 1 } });
  check('completeness: says to reconnect when P&L postings are missing', noPnl.checks.some((c) => c.key === 'pnl' && c.status === 'warn' && /Reconnect Zoho Books/.test(c.detail)));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
