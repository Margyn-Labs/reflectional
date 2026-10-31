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
    C: [['B1', 'c7', '2026-09-01', 40000, '', 'VA'], ['VC1', 'c15', '2026-09-20', '', 2000, 'VA']],
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

/* ---------------- items, as Zoho Books keeps them: item master + one detail read per document (items.js) */
const zitems = require('../../_zoho/items');
Z.items = [
  { item_id: 'G', name: 'Gauze Swab 10cm', unit: 'box', rate: 200, purchase_rate: 60, item_type: 'sales_and_purchases', product_type: 'goods' },
  { item_id: 'M', name: 'Surgical Mask', unit: 'pcs', rate: 10, purchase_rate: 12, item_type: 'sales_and_purchases', product_type: 'goods' },
  { item_id: 'H', name: 'Hand Rub 500ml', unit: 'btl', rate: 200, purchase_rate: 250, item_type: 'sales_and_purchases', product_type: 'goods' }
];
const L = (id, item, qty, rate) => ({ line_item_id: id, item_id: item, name: item, quantity: qty, unit: { G: 'box', M: 'pcs', H: 'btl' }[item], rate, bcy_rate: rate, item_total: qty * rate, tax_percentage: 0, location_name: 'Main Godown' });
Z.details = [
  ['invoice', { invoice_id: 'I1', date: '2026-10-05', status: 'sent', line_items: [L('l1', 'G', 500, 200)] }],
  ['invoice', { invoice_id: 'I2', date: '2026-07-01', status: 'partially_paid', line_items: [L('l2', 'M', 5000, 10)] }],
  ['invoice', { invoice_id: 'I4', date: '2026-10-10', status: 'paid', line_items: [L('l4', 'H', 100, 200)] }],
  ['bill', { bill_id: 'B1', date: '2026-09-01', status: 'overdue', line_items: [L('b1', 'G', 400, 60), L('b2', 'H', 40, 250), L('b3', 'M', 500, 12)] }],
  ['creditnote', { creditnote_id: 'CN1', date: '2026-10-15', status: 'open', line_items: [L('c1', 'G', 25, 200)] }],
  ['vendorcredit', { vendor_credit_id: 'VC1', date: '2026-09-20', status: 'open', line_items: [L('v1', 'H', 8, 250)] }]
];
t('zoho_items').push(...Z.items.map((i) => zitems.mapItem(i, ORG)));
for (const [type, doc] of Z.details) t('zoho_document_lines').push(...zitems.documentLines(doc, type, ORG));

t('zoho_organizations').push({ id: ORG, user_id: ZU, status: 'active', organization_name: 'Acme (Zoho)', connected_at: '2026-10-01T00:00:00Z', last_synced_at: new Date().toISOString() });

/* ---------------- the same business, as Tally keeps it */
const tv = (type, date, party, entries, n, items) => ({ install_id: 'ti', tally_guid: 'tg-' + n, voucher_type: type, voucher_number: n, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries, items: items || null });
// Tally stock lines as the agent sends them (tallyClient.parseInventoryEntries): sales +, purchases −, credit notes −, debit notes +.
const ti = (item, qty, unit, rate, sign) => ({ item, qty, unit, rate, amount: sign * qty * rate, abs_amount: qty * rate, godown: 'Main Godown' });
t('tally_installs').push({ id: 'ti', user_id: TU, status: 'active', company_name: 'Acme (Tally)', last_sync_at: new Date().toISOString() });
t('tally_ledgers').push(
  { install_id: 'ti', name: 'Sales', parent: 'Sales Accounts' }, { install_id: 'ti', name: 'Interest Income', parent: 'Indirect Incomes' },
  { install_id: 'ti', name: 'Cost of Goods Sold', parent: 'Purchase Accounts' }, { install_id: 'ti', name: 'Rent Expense', parent: 'Indirect Expenses' },
  { install_id: 'ti', name: 'HDFC Current A/c', parent: 'Bank Accounts', closing_balance: 185000 },
  { install_id: 'ti', name: 'Alpha Pharma Ltd', parent: 'Sundry Debtors' }, { install_id: 'ti', name: 'Beta Traders', parent: 'Sundry Debtors' },
  { install_id: 'ti', name: 'Apex Supplies', parent: 'Sundry Creditors' }, { install_id: 'ti', name: 'Landlord LLP', parent: 'Sundry Creditors' });
t('tally_vouchers').push(
  tv('Sales', '20261005', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: -100000, is_party: true }, { ledger: 'Sales', amount: 100000 }], 'INV-1', [ti('Gauze Swab 10cm', 500, 'box', 200, 1)]),
  tv('Sales', '20260701', 'Beta Traders', [{ ledger: 'Beta Traders', amount: -50000, is_party: true }, { ledger: 'Sales', amount: 50000 }], 'INV-2', [ti('Surgical Mask', 5000, 'pcs', 10, 1)]),
  tv('Sales', '20261010', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: -20000, is_party: true }, { ledger: 'Sales', amount: 20000 }], 'INV-4', [ti('Hand Rub 500ml', 100, 'btl', 200, 1)]),
  tv('Credit Note', '20261015', 'Alpha Pharma Ltd', [{ ledger: 'Alpha Pharma Ltd', amount: 5000, is_party: true }, { ledger: 'Sales', amount: -5000 }], 'CN1', [ti('Gauze Swab 10cm', 25, 'box', 200, -1)]),
  tv('Receipt', '20261028', null, [{ ledger: 'HDFC Current A/c', amount: -1000 }, { ledger: 'Interest Income', amount: 1000 }], 'J1'),
  tv('Purchase', '20260901', 'Apex Supplies', [{ ledger: 'Apex Supplies', amount: 40000, is_party: true }, { ledger: 'Cost of Goods Sold', amount: -40000 }], 'P1',
    [ti('Gauze Swab 10cm', 400, 'box', 60, -1), ti('Hand Rub 500ml', 40, 'btl', 250, -1), ti('Surgical Mask', 500, 'pcs', 12, -1)]),
  tv('Debit Note', '20260920', 'Apex Supplies', [{ ledger: 'Apex Supplies', amount: -2000, is_party: true }, { ledger: 'Cost of Goods Sold', amount: 2000 }], 'VC1', [ti('Hand Rub 500ml', 8, 'btl', 250, 1)]),
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
  products: { sort: 'sales' }, products_below_cost: { sort: 'below_cost' }, product_detail: { name: 'gauze' }, vendor: { name: 'apex' },
  item_entries: { kind: 'sales', item: 'hand rub' }, money_owed: {}, find_entries: { kind: 'receipt' }, cash_and_loans: {}, cash_flow_statement: {},
  borrowing_history: {}, what_needs_attention: {}, books_health_check: {}, how_its_calculated: { figure: 'net profit' }
};

const TOOL = { products_below_cost: 'products', product_detail: 'products', vendor: 'customer_or_vendor', item_entries: 'find_entries' };

(async () => {
  const out = { z: {}, t: {} };
  for (const [name, input] of Object.entries(CALLS)) {
    const tool = TOOL[name] || name;
    out.z[name] = await B.exec(tool, input, ZU);
    out.t[name] = await B.exec(tool, input, TU);
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
    // Receivables on Zoho Books say "invoices" where Tally says "bills" (1 Nov): the same figures under the word
    // Zoho uses, so the Zoho key is read back as Tally's before comparing. Every figure is still compared.
    const asTallyWords = (k) => k.replace(/\.oldest_invoice_days_late$/, '.oldest_bill_days_late').replace(/(^|\.)open_invoices\.(\d+)\.invoice$/, '$1open_bills.$2.bill')
      .replace(/(^|\.)open_invoices\./, '$1open_bills.').replace(/^(largest\.\d+)\.invoices$/, '$1.bills');
    const a = Object.fromEntries(Object.entries(flat(out.z[name])).map(([k, v]) => [asTallyWords(k), k === 'source' && typeof v === 'string' ? v.replace(/ Invoice by invoice, as of the last sync\.$/, ' Bill-wise outstanding as of the last sync.') : v]));
    const b = flat(out.t[name]);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    // cost_note is the one honest difference: Zoho Books has no production entries (no Manufacturing Journals).
    // Zoho-only extras (31 Oct): each document's own balance, bills due in 7 days, TDS balances and "no GST booked"
    // come from what Zoho keeps and Tally answers don't carry; Tally stays as it was. Checked on their own below.
    // 1 Nov: which invoice a payment cleared (cleared, paid_by, recent_payments), from Zoho's payment detail.
    // 31 Oct (Round 9): the 13-week cash forecast rides along with cash on Zoho (WhatsApp has no Cash page to read).
    const ZOHO_EXTRA = /(^|\.)(still_owed|due_next_7_days|tds|gst|cleared|paid_by|recent_payments|cash_forecast)(\.|$)|^gst_estimate\./;
    const diff = keys.filter((k) => k !== 'cost_note' && !ZOHO_EXTRA.test(k) && JSON.stringify(neutral(a[k])) !== JSON.stringify(neutral(b[k])));
    check(name + ': Zoho answer = Tally answer', diff.length === 0, diff.map((k) => k + ' Z=' + JSON.stringify(a[k]) + ' T=' + JSON.stringify(b[k])));
  }

  console.log('# item level: products, below cost, top items, item filter (same on both books, checked against the figures)');
  const p = out.z.products, item = (n) => p.items.find((x) => x.item === n);
  check('products: three items, sales net of the credit note', p.items_sold === 3 && item('Gauze Swab 10cm').sold === '475 box' && item('Gauze Swab 10cm').sales === '₹95,000', p.items);
  check('item cost = average purchase price net of the vendor credit', item('Hand Rub 500ml').avg_cost === '₹250' && item('Gauze Swab 10cm').avg_cost === '₹60', p.items);
  check('below cost: Hand Rub and Surgical Mask', out.z.products_below_cost.items.map((x) => x.item).sort().join() === 'Hand Rub 500ml,Surgical Mask', out.z.products_below_cost.items);
  check('one item in detail: by month, customers, bought from', out.z.product_detail.item === 'Gauze Swab 10cm' && out.z.product_detail.customers[0].customer === 'Alpha Pharma Ltd' && out.z.product_detail.bought_from[0].vendor === 'Apex Supplies', out.z.product_detail);
  check('customer top items with estimated margin', JSON.stringify(out.z.customer_or_vendor).includes('Gauze Swab 10cm'), out.z.customer_or_vendor);
  check('vendor top items', JSON.stringify(out.z.vendor).includes('Hand Rub 500ml'), out.z.vendor);
  check('find_entries by item finds the invoice with its lines', out.z.item_entries.entries.length === 1 && /Hand Rub 500ml x100/.test(out.z.item_entries.entries[0].items), out.z.item_entries.entries);
  check('Zoho cost note says there are no production entries', /Zoho Books has no production entries/.test(p.cost_note), p.cost_note);

  console.log('# Margin page item analytics: same on both books');
  const A = require('../tallyAnalytics');
  const { loadBooks: lb } = require('../dataLayer/books');
  const zBook = await lb(ZU), tBook = await lb(TU);
  const an = (bk) => A.computeAnalytics({ ledgers: bk.ledgers, vouchers: bk.vouchers, bills: bk.bills, overrides: bk.overrides || {}, balance_convention: bk.balance_convention, itemMaster: bk.item_master || [] });
  const za = an(zBook), ta = an(tBook);
  const itemKeys = Object.keys(za).filter((k) => /item/i.test(k));
  check('items_available on the Zoho book', za.items_available === true, itemKeys);
  check('Margin page item table has all three items, Hand Rub flagged below cost', (za.items || []).length === 3 && za.items.find((x) => x.item === 'Hand Rub 500ml').flags.includes('sold_below_cost'), za.items);
  for (const k of itemKeys) check('analytics.' + k + ': Zoho = Tally', JSON.stringify(za[k]) === JSON.stringify(ta[k]), { z: za[k], t: ta[k] });
  check('no reconcile note: every document\'s lines add up to what it posts', !zBook.notes.some((n) => /item lines that differ/.test(n)), zBook.notes);
  const E = require('../booksEngine');
  check('Margin page: Zoho says it has no production entries', /Zoho Books has no production entries/.test(E.buildInsights(zBook, za).kits_note || ''));

  console.log('# Zoho-only fallbacks');
  const { zohoToBook } = require('../dataLayer/books');
  const rows = { org: db.zoho_organizations[0], accounts: db.zoho_chart_of_accounts, journals: db.zoho_journal_entries, invoices: db.zoho_invoices, bills: db.zoho_bills,
    customerPayments: db.zoho_customer_payments, vendorPayments: db.zoho_vendor_payments, banks: db.zoho_bank_accounts, items: db.zoho_items };
  const noBills = zohoToBook(Object.assign({}, rows, { lines: db.zoho_document_lines.filter((l) => l.doc_type === 'invoice' || l.doc_type === 'creditnote') }));
  const fb = E.products(E.prepare(noBills, {}), { name: 'mask' });
  check('no bill lines: cost from the item master, labelled', fb.avg_cost === '₹12' && /item list, not from bills/.test(fb.cost_basis) && fb.flags.some((f) => /item list/.test(f)), fb);
  const off = db.zoho_document_lines.map((l) => (l.doc_id === 'I1' ? Object.assign({}, l, { value: l.value - 500 }) : l));
  const shipped = zohoToBook(Object.assign({}, rows, { lines: off }));
  check('lines ₹500 short of what the invoice posts: reconcile note', shipped.notes.some((n) => /1 Zoho Books document have item lines that differ from what it posts before tax \(by ₹500/.test(n)), shipped.notes);
  const partial = zohoToBook(Object.assign({}, rows, { lines: db.zoho_document_lines, lineProgress: { documents: 6, read: 4, pending: 2, complete_after: '2026-07-01' } }));
  const pc = E.products(E.prepare(partial, {}), {});
  check('still filling: the products answer says which dates are whole', /4 of 6 documents read, newest first\), so item figures are complete only after/.test(pc.coverage_note || ''), pc.coverage_note);
  console.log('# Zoho export import (fix a): same products answer and Margin item table as the API lines');
  {
    const { parseZohoExport } = require('../importMapper');
    const ex = require('../../_zoho/exportImport');
    const HDR = { invoice: ['Invoice Date', 'Invoice Number', 'Item Name', 'Quantity', 'Usage unit', 'Item Price', 'Item Total'], bill: ['Bill Date', 'Bill Number', 'Item Name', 'Quantity', 'Usage unit', 'Rate', 'Item Total'],
      creditnote: ['Credit Note Date', 'Credit Note Number', 'Invoice Number', 'Item Name', 'Quantity', 'Usage unit', 'Item Price', 'Item Total'], vendorcredit: ['Vendor Credit Date', 'Vendor Credit Number', 'Item Name', 'Quantity', 'Usage unit', 'Rate', 'Item Total'] };
    const NUM = { I1: 'INV-1', I2: 'INV-2', I4: 'INV-4', B1: 'SUP-1', CN1: 'CN-00001', VC1: 'DN-00001' };
    const ID = { invoice: 'invoice_id', bill: 'bill_id', creditnote: 'creditnote_id', vendorcredit: 'vendor_credit_id' };
    const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
    const match = ex.itemMatcher(Z.items.map((i) => ({ item_id: i.item_id, name: i.name })));
    const expLines = [];
    for (const type of Object.keys(HDR)) {
      const docs = Z.details.filter(([t]) => t === type).map(([, d]) => d);
      const file = [HDR[type]].concat(...docs.map((d) => d.line_items.map((l) => {
        const name = Z.items.find((i) => i.item_id === l.item_id).name;   // the export names the item, it has no id column here
        return type === 'creditnote' ? [ddmm(d.date), NUM[d[ID[type]]], 'INV-1', name, l.quantity, l.unit, l.rate, l.item_total]
          : [ddmm(d.date), NUM[d[ID[type]]], name, l.quantity, l.unit, l.rate, l.item_total];
      })));
      const parsed = parseZohoExport(file);
      for (const doc of parsed.documents) {
        const docId = Object.keys(NUM).find((k) => NUM[k] === doc.number);
        const { api, unknown } = ex.exportDocToApi(doc, type, docId, match);
        check(`export ${doc.number}: every item recognised`, unknown === 0);
        api.date = (Z.details.find(([, d]) => d[ID[type]] === docId) || [])[1].date;
        expLines.push(...zitems.documentLines(api, type, ORG));
      }
    }
    const apiBook = zohoToBook(Object.assign({}, rows, { lines: db.zoho_document_lines }));
    const expBook = zohoToBook(Object.assign({}, rows, { lines: expLines }));
    const strip = (x) => JSON.parse(JSON.stringify(x));
    for (const args of [{}, { sort: 'below_cost' }, { name: 'gauze' }]) {
      const a = strip(E.products(E.prepare(apiBook, {}), args)), b = strip(E.products(E.prepare(expBook, {}), args));
      check('products ' + JSON.stringify(args) + ': export = API', JSON.stringify(a) === JSON.stringify(b), { api: a, exp: b });
    }
    const an2 = (bk) => A.computeAnalytics({ ledgers: bk.ledgers, vouchers: bk.vouchers, bills: bk.bills, overrides: {}, balance_convention: bk.balance_convention, itemMaster: bk.item_master || [] });
    const ia = an2(apiBook), ib = an2(expBook);
    check('Margin item table: export = API', JSON.stringify(ia.items) === JSON.stringify(ib.items) && (ia.items || []).length === 3, { api: ia.items, exp: ib.items });
    // Sales / Purchases by Item, month by month (Margin page panel): the months add up to the year's item table, and
    // chat's breakdown gives the same figures, purchases net of vendor credits (tied to Zoho's reports live, 30 Oct).
    const ibm = ia.items_by_month || [];
    const sumSold = (item) => ibm.filter((r) => r.item === item).reduce((t, r) => t + r.sold_value, 0);
    check('items by month: sold value per item adds up to the Margin item table', ibm.length > 0 && (ia.items || []).every((i) => Math.abs(sumSold(i.item) - i.sold_value) < 0.01), { ibm, items: ia.items });
    check('items by month: export = API', JSON.stringify(ibm) === JSON.stringify(ib.items_by_month || []));
    const ctxA = E.prepare(apiBook, {});
    const chatBuy = E.breakdown(ctxA, { measure: 'purchases', by: 'item', period: 'this_fy', top: 50 });
    const bought = (item) => ibm.filter((r) => r.item === item).reduce((t, r) => t + r.bought_value, 0);
    check('chat purchases by item = the panel (purchases, not sales)', (chatBuy.rows || []).length > 0 && (chatBuy.rows || []).every((g) => Math.abs(g.rupees - Math.round(bought(g.name))) <= 1), { chat: chatBuy.rows, ibm });
    check('no reconcile note on the export lines either', !expBook.notes.some((n) => /item lines that differ/.test(n)), expBook.notes);
  }
  const cnVouchers = zBook.vouchers.filter((v) => v.voucher_type === 'Credit Note' && v.items);
  check('credit note lines sit on one Credit Note voucher with Tally\'s signs', cnVouchers.length === 1 && cnVouchers[0].items[0].amount === -5000 && cnVouchers[0].items[0].abs_amount === 5000 && cnVouchers[0].items[0].godown === 'Main Godown', cnVouchers);

  console.log('# Margyn Watch WhatsApp updates (morning, 12:30, 3 pm, 5 pm, evening): Zoho = Tally, figure for figure');
  {
    const Wt = require('../margynWatch');
    const NOWW = new Date('2026-10-29T03:30:00Z');   // 9 am IST
    for (const slot of ['morning', 'noon', 'afternoon', 'late', 'evening']) {
      const z = await Wt.watchAccount(ZU, { slot, previewOnly: true, mode: 'on', now: NOWW });
      const tt = await Wt.watchAccount(TU, { slot, previewOnly: true, mode: 'on', now: NOWW });
      check(slot + ': Zoho-only account gets an update run (not skipped)', z && !z.skipped && !z.error, z);
      check(slot + ': Zoho text never says Tally', !/Tally/.test(z.text || ''), z.text);
      check(slot + ': Zoho text = Tally text (books name aside)', neutral(z.text || '') === neutral(tt.text || ''), { z: z.text, t: tt.text });
    }
    const mz = await Wt.watchAccount(ZU, { slot: 'morning', previewOnly: true, mode: 'on', now: NOWW });
    check('"Your Zoho Books as of", never "Zoho Books books"', /Your Zoho Books as of/.test(mz.text || '') && !/Books books/.test(mz.text || ''), (mz.text || '').slice(0, 80));
    check('morning names Zoho Books and carries the bank balance (₹1.85 L)', /Zoho Books/.test(mz.text || '') && /1\.85 L/.test(mz.text || ''), mz.text);
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
      open_invoices: db.zoho_invoices.filter(live).length, open_bills: db.zoho_bills.filter(live).length,
      bank_accounts: 2, contacts: 6, contacts_with_phone: 1, items: 3 }, sweptAt: new Date().toISOString() });
  check('completeness: all green on a whole Zoho book', comp.status === 'ok' && comp.checks.every((c) => c.status !== 'warn'), comp.checks);
  const noPnl = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2 }, stored: { invoices: 4, bills: 2, postings: 0, open_invoices: 2, open_bills: 1 } });
  check('completeness: says to reconnect when P&L postings are missing', noPnl.checks.some((c) => c.key === 'pnl' && c.status === 'warn' && /Reconnect Zoho Books/.test(c.detail)));

  // Every module Margyn reads gets a row, and what it doesn't read is said plainly (30 Oct 2026).
  const keys = comp.checks.map((c) => c.key);
  check('completeness: banks, contacts and items each get a row', ['banks', 'contacts', 'items', 'not_read'].every((k) => keys.includes(k)), keys);
  check('completeness: contacts row says how many have a phone (Chase needs it)', /1 has a phone number/.test(comp.checks.find((c) => c.key === 'contacts').detail));
  const short = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2, contacts: 66 }, stored: { invoices: 4, bills: 2, postings: 3, open_invoices: 2, open_bills: 1, bank_accounts: 1, contacts: 60 } });
  check('completeness: fewer contacts than Zoho holds is flagged', short.checks.some((c) => c.key === 'contacts' && c.status === 'warn' && /60 of the 66/.test(c.detail)));
  // MARGYN DEMO, 30 Oct: 91 contacts, 1 with a phone; the check said "1 of the 91 are in Margyn" and warned,
  // though the other 90 have nothing to save and show on Customers/Vendors from their invoices.
  const demo = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2, contacts: 91, contacts_with_details: 1 }, stored: { invoices: 4, bills: 2, postings: 3, open_invoices: 2, open_bills: 1, bank_accounts: 1, contacts: 1, contacts_with_phone: 1 } });
  const dc = demo.checks.find((c) => c.key === 'contacts');
  check('completeness: contacts with no details in Zoho are not called missing', dc.status === 'ok' && /all 1 with a phone, email or GSTIN are saved/.test(dc.detail) && /other 90 have no contact details/.test(dc.detail), dc);
  check('completeness: header counts Zoho\'s contacts, not saved parties', demo.counts.contacts === 91, demo.counts);
  const demoShort = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2, contacts: 91, contacts_with_details: 5 }, stored: { invoices: 4, bills: 2, postings: 3, open_invoices: 2, open_bills: 1, bank_accounts: 1, contacts: 1 } });
  check('completeness: a contact with details that isn\'t saved is still flagged', demoShort.checks.some((c) => c.key === 'contacts' && c.status === 'warn' && /1 of the 5 with a phone/.test(c.detail)));
  const noBank = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2 }, stored: { invoices: 4, bills: 2, postings: 3, open_invoices: 2, open_bills: 1 } });
  check('completeness: no bank accounts is flagged, not shown as fine', noBank.checks.some((c) => c.key === 'banks' && c.status === 'warn'));
  const filling = zohoCompleteness({ book: zb, remote: { invoices: 4, bills: 2 }, stored: { invoices: 4, bills: 2, postings: 3, open_invoices: 2, open_bills: 1, bank_accounts: 1 },
    lines: { documents: 1053, read: 220, pending: 833, complete_after: '2026-09-14', creditnotes: 12, vendorcredits: 4 } });
  const il = filling.checks.find((c) => c.key === 'item_lines');
  check('completeness: item lines filling in says N of N and the date figures are complete after', il && il.status === 'info' && /220 of 1,053/.test(il.detail) && /2026-09-14/.test(il.detail), il);
  // Varad, 30 Oct: connecting must be enough; never send the owner to a manual export.
  check('completeness: while filling, says Margyn keeps reading on its own and what a paid plan allows, never a manual export', /keeps reading on its own until they are all in; nothing to do/.test(il.detail) && /Professional 5,000/.test(il.detail) && !/export|Import/.test(il.detail), il.detail);
  check('completeness: credit notes and vendor credits counted', /12 credit notes and 4 vendor credits/.test(filling.checks.find((c) => c.key === 'returns').detail));

  console.log('# Zoho-only extras (31 Oct live chat check): still owed, due this week, TDS, no GST');
  {
    const zc = E.prepare(zBook, {}), tc = E.prepare(tBook, {});
    const paid = E.findEntries(zc, { number: 'INV-4' }).entries[0], open = E.findEntries(zc, { number: 'INV-1' }).entries[0];
    check('find_entries: a paid Zoho invoice says nothing is still owed', paid && /paid or settled in full/.test(paid.still_owed), paid);
    check('find_entries: an open Zoho invoice says what is still owed', open && open.still_owed === '₹1 L', open);
    check('find_entries: Tally entries carry no still_owed (unchanged)', E.findEntries(tc, { number: 'INV-4' }).entries.every((e) => !('still_owed' in e)));
    const due = E.moneyOwed(zc, { direction: 'receivable' }).due_next_7_days;
    check('money_owed: lists what falls due in the next 7 days on Zoho', due && due.count === 1 && due.list[0].number === 'INV-1', due);
    check('money_owed: Tally answer unchanged (no due_next_7_days)', !('due_next_7_days' in E.moneyOwed(tc, { direction: 'receivable' })));
    const zcash = E.cashAndDebt(zc), tcash = E.cashAndDebt(tc);
    check('cash_and_loans: Zoho with no GST booked says GST can\'t be estimated, not ₹0 due', !zcash.gst_estimate && /can't estimate GST payable/.test(zcash.gst), zcash.gst);
    check('cash_and_loans: Tally GST estimate unchanged', tcash.gst_estimate && tcash.gst_estimate.net_payable === '₹0' && !('gst' in tcash) && !('tds' in tcash), tcash);
    check('cash_and_loans: no TDS section when Zoho balances aren\'t synced yet', !('tds' in zcash));
    const withTds = Object.assign({}, zBook, { tds: [{ account: 'TDS Receivable', side: 'deducted_by_customers', balance: 1795.62 }, { account: 'TDS Payable', side: 'deducted_by_you', balance: 1000 }] });
    const t2 = E.cashAndDebt(E.prepare(withTds, {})).tds;
    check('cash_and_loans: TDS deducted by customers and by you, from Zoho\'s balances', t2 && t2.deducted_by_customers.total === '₹1,796' && t2.deducted_by_you.total === '₹1,000', t2);
    const coa = sync._mapAccount({ account_id: 'T', account_name: 'TDS Receivable', account_type: 'other_current_asset', current_balance: 1795.62 }, ORG);
    check('sync: chart of accounts keeps Zoho\'s balance', coa.current_balance === 1795.62, coa);
    // A ₹50,000 bill with 2% TDS: Zoho's total is ₹49,000. The ₹1,000 is TDS owed, never input GST.
    const { zohoToBook } = require('../dataLayer/books');
    const tb = zohoToBook({ org: { organization_name: 'T' },
      accounts: [{ id: 'acc-X', account_id: 'X', account_name: 'Consultant Expense', account_type: 'expense' }, { id: 'acc-G', account_id: 'G', account_name: 'Office Supplies', account_type: 'expense' }],
      journals: [{ account_ref: 'acc-X', transaction_id: 'BT:1', entry_date: '2026-10-31', debit: 50000, credit: 0 }, { account_ref: 'acc-G', transaction_id: 'BG:1', entry_date: '2026-10-30', debit: 100, credit: 0 }],
      bills: [{ bill_id: 'BT', bill_number: 'TDS-1', vendor_name: 'Metro Services', total: 49000, balance: 49000, status: 'open', bill_date: '2026-10-31', due_date: '2026-11-15' },
        { bill_id: 'BG', bill_number: 'GST-1', vendor_name: 'Paper Co', total: 118, balance: 118, status: 'open', bill_date: '2026-10-30', due_date: '2026-11-15' }] });
    const led = (n) => tb.vouchers.find((v) => v.voucher_number === n).entries.filter((e) => !e.is_party && !/Expense|Supplies/.test(e.ledger));
    check('TDS bill: the ₹1,000 shortfall is TDS held back, not input GST', JSON.stringify(led('TDS-1')) === JSON.stringify([{ ledger: 'TDS held back (Zoho bills)', amount: 1000, is_party: false }]), led('TDS-1'));
    check('GST bill: the ₹18 on top is still input GST', JSON.stringify(led('GST-1')) === JSON.stringify([{ ledger: 'Input GST (Zoho bills)', amount: -18, is_party: false }]), led('GST-1'));
    const { zohoToBook: z2b } = require('../dataLayer/books');
    const adv = z2b({ org: {}, accounts: [{ id: 'a1', account_id: '1', account_name: 'Advance Tax', account_type: 'other_current_asset', current_balance: 1795.62 },
      { id: 'a2', account_id: '2', account_name: 'TDS Receivable', account_type: 'other_current_asset', current_balance: 0 }, { id: 'a3', account_id: '3', account_name: 'TDS Payable', account_type: 'other_current_liability', current_balance: 1000 }] }).tds;
    const advT = E.cashAndDebt(E.prepare(Object.assign({}, zBook, { tds: adv }), {})).tds;
    check('TDS: Zoho\'s default Advance Tax account counts as tax customers withheld (live shape)', advT.deducted_by_customers.total === '₹1,796' && advT.deducted_by_you.total === '₹1,000' && /default account/.test(advT.deducted_by_customers.accounts.find((x) => x.account === 'Advance Tax').note), advT);
    check('sync: no balance from Zoho, no column sent', !('current_balance' in sync._mapAccount({ account_id: 'S', account_name: 'Sales', account_type: 'income' }, ORG)));
  }

  console.log('# Round 9 (31 Oct): forecast on cash, invoice wording in "what needs attention"');
  {
    const zc = out.z.cash_and_loans.cash_forecast;
    check('cash_and_loans: Zoho carries the 13-week forecast (today, 4 and 13 weeks, week by week)', zc && zc.today === '₹1.85 L' && zc.week_by_week.length === 13 && /Cash page/.test(zc.note) && zc.in_4_weeks, zc);
    const CF = require('../cashFlowModel');
    const { ctx } = await B.contextFor(ZU);
    const fc = CF.build(ctx, { promises: [], pastRuns: [] });
    check('cash_and_loans: the forecast is the Cash page\'s own (cashFlowModel.build)', zc.in_4_weeks === E.inr(fc.weeks[3].close) && zc.in_13_weeks === E.inr(fc.weeks[12].close), { zc, w4: fc.weeks[3] });
    check('cash_and_loans: Tally answer has no forecast added (unchanged)', !('cash_forecast' in out.t.cash_and_loans), Object.keys(out.t.cash_and_loans));
    // A customer far behind (Beta Traders, INV-2, ₹20,000, 92 days; small threshold so it is a point): Zoho says
    // "invoice" and, when they owe more than the late part, the whole balance first. Tally exactly as before.
    const { ctx: tctx } = await B.contextFor(TU);
    const point = (c, src) => E.insights(Object.assign({}, c, { material: 5000 }, src ? { source: 'zoho', source_name: 'Zoho Books' } : {})).find((x) => x.kind === 'late');
    const zt = point(tctx, true), tt = point(tctx, false);
    check('attention: Zoho says invoice, never bill', zt && /oldest is invoice INV-2/.test(zt.title) && /Call Beta Traders about invoice INV-2/.test(zt.action), zt);
    check('attention: Tally wording unchanged (bill)', tt && /^Beta Traders owes ₹20,000 that's more than a month late; oldest is bill INV-2/.test(tt.title) && /about bill INV-2\.$/.test(tt.action), tt);
    const z2 = E.insights(Object.assign({}, tctx, { material: 5000, source: 'zoho', source_name: 'Zoho Books', analytics: tctx.analytics }));
    check('attention: Zoho overdue total action names the invoice', !z2.find((x) => x.kind === 'overdue_total') || /oldest invoice/.test(z2.find((x) => x.kind === 'overdue_total').action || 'oldest invoice'), z2.map((x) => x.action));
  }

  console.log('# opening read (sign-in): the first read and what changed since the last visit, same on both books');
  {
    const SINCE = '2026-10-15T04:30:00Z';
    const z = await B.exec('opening_read', { since: SINCE }, ZU), tt = await B.exec('opening_read', { since: SINCE }, TU);
    check('opening_read: answers on both books', z && !z.error && z.numbers && tt && !tt.error && tt.numbers, { z, tt });
    const n = z.numbers, m = tt.numbers;
    check('opening_read: same cash, owed, overdue and money in on Zoho and Tally', n.cash === m.cash && n.recv_total === m.recv_total && n.recv_overdue === m.recv_overdue && n.since.money_in === m.since.money_in, { n, m });
    check('opening_read: cash is the bank balance (₹1.85 L)', z.cash === '₹1.85 L', z.cash);
    check('opening_read: who owes most = Alpha Pharma ₹1 L, then Beta ₹20,000', n.top[0].party === 'Alpha Pharma Ltd' && n.top[0].owed === 100000 && n.top[1].party === 'Beta Traders' && n.top[1].owed === 20000, n.top);
    check('opening_read: overdue is Beta Traders only', n.late.length === 1 && n.late[0].party === 'Beta Traders' && n.recv_overdue === 20000, n.late);
    check('opening_read: since 15 Oct, ₹20,000 came in from Alpha Pharma (receipt of 20 Oct)', n.since.money_in === 20000 && n.since.paid[0].party === 'Alpha Pharma Ltd' && n.since.paid[0].on === '2026-10-20', n.since);
    check('opening_read: nothing went overdue since 15 Oct (Beta was already late)', n.since.went_overdue === 0, n.since);
    const none = await B.exec('opening_read', {}, ZU);
    check('opening_read: without since, no "since" part', none && !none.since && !none.numbers.since, Object.keys(none));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
