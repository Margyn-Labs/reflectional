/**
 * _lib/dataLayer/books.js
 * The Books category in one place (2026-10-04).
 *
 * Margyn is not a Tally tool. A business keeps its books in Tally, Zoho Books, Odoo (or by hand), and every
 * screen, report, WhatsApp update, AI answer, Jev and agent reads the books from HERE, never from a connector's
 * tables. One loader, one shape: the book the engine (tallyAnalytics.computeAnalytics, booksEngine.prepare)
 * already reads, i.e. what tallyData.loadTallyBook returns:
 *   { connected, source, source_name, company, companies, chosen, lastSync, edition, agentVersion, diagnostics,
 *     ledgers:[{name,parent,primary_group,opening_balance,closing_balance}],
 *     vouchers:[{voucher_type,voucher_number,tally_guid,date,party_name,amount,is_cancelled,entries:[{ledger,amount,is_party}],narration}],
 *     bills:[{direction,party_name,bill_ref,bill_date,due_date,closing_balance,overdue_days}],
 *     truncated, overrides, aiPlaced, syncRuns, notes:[string], compare:[…] }
 * Conventions: voucher amounts are debit-negative (credit positive); ledger balances are debit-positive.
 *
 * Sources in a category are COMPARED, NEVER ADDED. When more than one books system is connected, one is primary
 * (most trusted, then most recently synced) and is the book everyone reads; the others are summarised in
 * `compare` (receivables, payables, cash, last sync) so a screen can show where they differ.
 *
 * Adapters:
 *  - Tally: tallyData.loadTallyBook (ledgers, vouchers, bills as the agent syncs them).
 *  - Zoho Books: chart of accounts + per-account transactions (P&L accounts only) for costs, invoices for sales
 *    (before GST, needs zoho_invoices.sub_total; otherwise sales come from the income accounts and there is no
 *    customer split), customer/vendor payments as receipts/payments, bank accounts for cash, open invoices and
 *    bills as bills.
 *  - Odoo: posted invoices and bills (before tax, needs amount_untaxed) and the cash aggregate. Odoo sync has no
 *    running costs yet, so its P&L is gross only, and the book says so.
 *
 * CommonJS, zero-npm.
 */

const { selectRows } = require('../supabaseRest');
const tallyData = require('../tallyData');

const TRUST = { tally: 3, zoho: 3, odoo: 2 };   // full double-entry books beat invoices-and-bills only
const SOURCE_NAME = { tally: 'Tally', zoho: 'Zoho Books', odoo: 'Odoo' };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const day = (d) => (d ? String(d).slice(0, 10) : null);

// Zoho account types -> the group names the engine already places (tallyAnalytics PARENT_RULES).
const ZOHO_GROUP = {
  income: 'Sales Accounts', other_income: 'Indirect Incomes', cost_of_goods_sold: 'Purchase Accounts',
  expense: 'Indirect Expenses', other_expense: 'Indirect Expenses'
};
const ZOHO_SALES = 'Sales (Zoho invoices, before GST)';
const ZOHO_GST_OUT = 'Output GST (Zoho invoices)';
const ODOO_SALES = 'Sales (Odoo invoices, before tax)';
const ODOO_PURCH = 'Purchases (Odoo bills, before tax)';
const ODOO_TAX_OUT = 'Output tax (Odoo)';
const ODOO_TAX_IN = 'Input tax (Odoo)';
const ODOO_CASH = 'Bank and cash (Odoo)';

async function pagedAll(table, query, max) { return tallyData.pagedAll(table, query, max); }
const safe = (p, fallback) => p.catch(() => fallback);

/* ------------------------------------------------------------------ Zoho */

/** Pure: Zoho rows -> the canonical book. Exported for tests. */
function zohoToBook(z) {
  const org = z.org || {};
  const accounts = z.accounts || [], journals = z.journals || [], invoices = z.invoices || [], bills = z.bills || [];
  const custPay = z.customerPayments || [], vendPay = z.vendorPayments || [], banks = z.banks || [];
  const notes = [];
  const ledgers = new Map();
  const addLedger = (name, parent, closing) => { if (name && !ledgers.has(name)) ledgers.set(name, { name, parent, primary_group: parent, opening_balance: null, closing_balance: closing == null ? null : r2(closing) }); };

  const acct = new Map();   // zoho_chart_of_accounts.id -> { name, type }
  for (const a of accounts) {
    const type = String(a.account_type || '').toLowerCase();
    if (!ZOHO_GROUP[type] || !a.account_name) continue;
    acct.set(String(a.id), { name: a.account_name, type });
    addLedger(a.account_name, ZOHO_GROUP[type]);
  }

  const live = (r) => !['draft', 'void', 'deleted_at_source'].includes(String(r.status || '').toLowerCase());
  const inv = invoices.filter(live), bil = bills.filter(live);
  // Sales from invoices (with the customer) only when every invoice carries its amount before GST.
  const invoiceSales = inv.length > 0 && inv.every((i) => i.sub_total != null);
  if (inv.length && !invoiceSales) notes.push('Sales come from your Zoho income accounts, without the split by customer, until Zoho Books syncs again (it then sends each invoice before GST).');

  const vouchers = [];
  for (const j of journals) {
    const a = acct.get(String(j.account_ref));
    if (!a || !j.entry_date) continue;
    if (a.type === 'income' && invoiceSales) continue;   // the invoices carry these sales, with the customer
    const amt = num(j.credit) - num(j.debit);
    if (!amt) continue;
    vouchers.push({ voucher_type: 'Journal', voucher_number: null, tally_guid: 'zj:' + j.account_ref + ':' + j.transaction_id, date: day(j.entry_date),
      party_name: null, amount: Math.abs(amt), is_cancelled: false, entries: [{ ledger: a.name, amount: r2(amt), is_party: false }], narration: null });
  }

  const custName = new Map();
  for (const i of invoices) if (i.customer_ref && i.customer_name) custName.set(String(i.customer_ref), i.customer_name);
  if (invoiceSales) {
    addLedger(ZOHO_SALES, 'Sales Accounts'); addLedger(ZOHO_GST_OUT, 'Duties & Taxes');
    for (const i of inv) {
      const party = i.customer_name || 'Unknown customer';
      addLedger(party, 'Sundry Debtors');
      const total = num(i.total), sub = num(i.sub_total), tax = r2(total - sub);
      const entries = [{ ledger: party, amount: -r2(total), is_party: true }, { ledger: ZOHO_SALES, amount: r2(sub), is_party: false }];
      if (Math.abs(tax) >= 0.01) entries.push({ ledger: ZOHO_GST_OUT, amount: tax, is_party: false });
      vouchers.push({ voucher_type: 'Sales', voucher_number: i.invoice_number || null, tally_guid: 'zi:' + i.invoice_id, date: day(i.invoice_date),
        party_name: party, amount: Math.abs(total), is_cancelled: false, entries, narration: null });
    }
  }

  // Bank and cash: Zoho's balance per account. Payments move it, so the cash history can walk back through them.
  let primaryBank = null;
  for (const b of banks) {
    const t = String(b.account_type || '').toLowerCase();
    const name = (b.bank_name || 'Bank account') + (banks.filter((x) => x.bank_name === b.bank_name).length > 1 ? ' (' + String(b.account_id).slice(-4) + ')' : '');
    const parent = t === 'cash' ? 'Cash-in-Hand' : t === 'credit_card' ? 'Bank OD A/c' : 'Bank Accounts';
    addLedger(name, parent, t === 'credit_card' ? -num(b.current_balance) : num(b.current_balance));
    if (parent !== 'Bank OD A/c' && (!primaryBank || b.is_primary)) primaryBank = name;
  }
  if (primaryBank) {
    for (const p of custPay) {
      if (!p.payment_date || !num(p.amount)) continue;
      const party = custName.get(String(p.customer_ref)) || 'Customer';
      addLedger(party, 'Sundry Debtors');
      vouchers.push({ voucher_type: 'Receipt', voucher_number: null, tally_guid: 'zcp:' + p.payment_id, date: day(p.payment_date), party_name: party, amount: num(p.amount), is_cancelled: false,
        entries: [{ ledger: party, amount: r2(num(p.amount)), is_party: true }, { ledger: primaryBank, amount: -r2(num(p.amount)), is_party: false }], narration: p.payment_mode || null });
    }
    const vendName = new Map();
    for (const b of bills) if (b.vendor_ref && b.vendor_name) vendName.set(String(b.vendor_ref), b.vendor_name);
    for (const p of vendPay) {
      if (!p.payment_date || !num(p.amount)) continue;
      const party = vendName.get(String(p.vendor_ref)) || 'Vendor';
      addLedger(party, 'Sundry Creditors');
      vouchers.push({ voucher_type: 'Payment', voucher_number: null, tally_guid: 'zvp:' + p.payment_id, date: day(p.payment_date), party_name: party, amount: num(p.amount), is_cancelled: false,
        entries: [{ ledger: party, amount: -r2(num(p.amount)), is_party: true }, { ledger: primaryBank, amount: r2(num(p.amount)), is_party: false }], narration: p.payment_mode || null });
    }
  }

  const openBills = [];
  for (const i of inv) if (num(i.balance) > 0.5) { addLedger(i.customer_name || 'Unknown customer', 'Sundry Debtors');
    openBills.push({ direction: 'receivable', party_name: i.customer_name || 'Unknown customer', bill_ref: i.invoice_number || String(i.invoice_id), bill_date: day(i.invoice_date), due_date: day(i.due_date), closing_balance: r2(i.balance), overdue_days: null }); }
  for (const b of bil) if (num(b.balance) > 0.5) { addLedger(b.vendor_name || 'Unknown vendor', 'Sundry Creditors');
    openBills.push({ direction: 'payable', party_name: b.vendor_name || 'Unknown vendor', bill_ref: b.bill_number || String(b.bill_id), bill_date: day(b.bill_date), due_date: day(b.due_date), closing_balance: r2(b.balance), overdue_days: null }); }

  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const company = org.organization_name || org.org_name || org.name || 'Zoho Books';
  const lastSync = org.last_sync_at || org.last_synced_at || org.last_success_at || null;
  return { connected: true, source: 'zoho', source_name: SOURCE_NAME.zoho, company, companies: [company], chosen: [], lastSync,
    edition: null, agentVersion: null, diagnostics: null,
    ledgers: [...ledgers.values()], vouchers, bills: openBills, truncated: !!z.truncated, overrides: z.overrides || {}, aiPlaced: new Set(), syncRuns: [], notes };
}

async function loadZoho(userId) {
  const orgs = await safe(selectRows('zoho_organizations', `select=*&user_id=eq.${userId}&status=eq.active&order=connected_at.desc&limit=1`), []);
  const org = orgs[0];
  if (!org) return { connected: false };
  const o = encodeURIComponent(org.id);
  const [A, J, I, B, CP, VP, BK, OV] = await Promise.all([
    safe(pagedAll('zoho_chart_of_accounts', `select=id,account_id,account_name,account_type&org_ref=eq.${o}&order=id.asc`, 5000), { rows: [] }),
    safe(pagedAll('zoho_journal_entries', `select=account_ref,transaction_id,entry_date,debit,credit&org_ref=eq.${o}&order=entry_date.asc,transaction_id.asc`, 60000), { rows: [] }),
    safe(pagedAll('zoho_invoices', `select=*&org_ref=eq.${o}&order=invoice_date.asc,invoice_id.asc`, 20000), { rows: [] }),
    safe(pagedAll('zoho_bills', `select=*&org_ref=eq.${o}&order=bill_date.asc,bill_id.asc`, 20000), { rows: [] }),
    safe(pagedAll('zoho_customer_payments', `select=payment_id,customer_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000), { rows: [] }),
    safe(pagedAll('zoho_vendor_payments', `select=payment_id,vendor_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000), { rows: [] }),
    safe(selectRows('zoho_bank_accounts', `select=account_id,bank_name,account_type,current_balance,is_primary&org_ref=eq.${o}`), []),
    safe(selectRows('tally_ledger_classes', `select=ledger_name,bucket&user_id=eq.${userId}&company_name=eq.${encodeURIComponent(org.organization_name || org.org_name || org.name || 'Zoho Books')}`), [])
  ]);
  const overrides = {};
  for (const x of OV) overrides[x.ledger_name] = x.bucket;
  return zohoToBook({ org, accounts: A.rows, journals: J.rows, invoices: I.rows, bills: B.rows, customerPayments: CP.rows, vendorPayments: VP.rows, banks: BK, overrides,
    truncated: [J, I, B, CP, VP].some((x) => x.truncated) });
}

/* ------------------------------------------------------------------ Odoo */

/** Pure: Odoo rows -> the canonical book. Exported for tests. */
function odooToBook(d) {
  const notes = ['Odoo sends invoices and bills only, so running costs (salaries, rent…) aren’t in these figures yet: profit here is before running costs.'];
  const ledgers = new Map();
  const addLedger = (name, parent, closing) => { if (name && !ledgers.has(name)) ledgers.set(name, { name, parent, primary_group: parent, opening_balance: null, closing_balance: closing == null ? null : r2(closing) }); };
  addLedger(ODOO_SALES, 'Sales Accounts'); addLedger(ODOO_PURCH, 'Purchase Accounts');
  addLedger(ODOO_TAX_OUT, 'Duties & Taxes'); addLedger(ODOO_TAX_IN, 'Duties & Taxes');
  if (d.cash && d.cash.balance != null) addLedger(ODOO_CASH, 'Bank Accounts', num(d.cash.balance));
  const posted = (r) => !r.state || r.state === 'posted';
  const vouchers = [], openBills = [];
  let untaxedMissing = 0;
  const add = (r, sales) => {
    const party = (sales ? r.customer_name : r.vendor_name) || (sales ? 'Unknown customer' : 'Unknown vendor');
    addLedger(party, sales ? 'Sundry Debtors' : 'Sundry Creditors');
    const total = num(r.amount_total);
    if (r.amount_untaxed == null) { untaxedMissing++; return; }
    const untaxed = num(r.amount_untaxed), refund = /refund/.test(String(r.move_type || ''));
    // Odoo's signed amounts: customer invoices +, their refunds −; vendor bills −, their refunds +.
    const entries = [{ ledger: party, amount: -r2(total), is_party: true }, { ledger: sales ? ODOO_SALES : ODOO_PURCH, amount: r2(untaxed), is_party: false }];
    const tax = r2(total - untaxed);
    if (Math.abs(tax) >= 0.01) entries.push({ ledger: sales ? ODOO_TAX_OUT : ODOO_TAX_IN, amount: tax, is_party: false });
    vouchers.push({ voucher_type: sales ? (refund ? 'Credit Note' : 'Sales') : (refund ? 'Debit Note' : 'Purchase'), voucher_number: (sales ? r.invoice_number : r.bill_number) || null,
      tally_guid: 'o:' + r.odoo_move_id, date: day(sales ? r.invoice_date : r.bill_date), party_name: party, amount: Math.abs(total), is_cancelled: false, entries, narration: null });
  };
  for (const r of (d.invoices || []).filter(posted)) {
    add(r, true);
    if (Math.abs(num(r.balance)) > 0.5) openBills.push({ direction: 'receivable', party_name: r.customer_name || 'Unknown customer', bill_ref: r.invoice_number || String(r.odoo_move_id), bill_date: day(r.invoice_date), due_date: day(r.due_date), closing_balance: r2(Math.abs(num(r.balance))), overdue_days: null });
  }
  for (const r of (d.bills || []).filter(posted)) {
    add(r, false);
    if (Math.abs(num(r.balance)) > 0.5) openBills.push({ direction: 'payable', party_name: r.vendor_name || 'Unknown vendor', bill_ref: r.bill_number || String(r.odoo_move_id), bill_date: day(r.bill_date), due_date: day(r.due_date), closing_balance: r2(Math.abs(num(r.balance))), overdue_days: null });
  }
  if (untaxedMissing) notes.push(untaxedMissing + ' Odoo invoices and bills arrived before Margyn read amounts before tax, so they’re left out of sales and purchases until Odoo syncs again.');
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const company = d.company || 'Odoo';
  return { connected: true, source: 'odoo', source_name: SOURCE_NAME.odoo, company, companies: [company], chosen: [], lastSync: d.lastSync || null,
    edition: null, agentVersion: null, diagnostics: null, ledgers: [...ledgers.values()], vouchers, bills: openBills, truncated: !!d.truncated,
    overrides: d.overrides || {}, aiPlaced: new Set(), syncRuns: [], notes };
}

async function loadOdoo(userId) {
  const creds = await safe(selectRows('connector_credentials', `select=id,last_success_at&user_id=eq.${userId}&connector_type=eq.odoo&disconnected_at=is.null&order=created_at.desc&limit=1`), []);
  if (!creds.length) return { connected: false };
  const c = encodeURIComponent(creds[0].id);
  const [I, B, C] = await Promise.all([
    safe(pagedAll('odoo_invoices', `select=*&user_id=eq.${userId}&cred_id=eq.${c}&order=invoice_date.asc,odoo_move_id.asc`, 20000), { rows: [] }),
    safe(pagedAll('odoo_bills', `select=*&user_id=eq.${userId}&cred_id=eq.${c}&order=bill_date.asc,odoo_move_id.asc`, 20000), { rows: [] }),
    safe(selectRows('odoo_cash_balances', `select=balance,basis,account_count,as_of&cred_id=eq.${c}&limit=1`), [])
  ]);
  const company = (I.rows.find((r) => r.company_name) || B.rows.find((r) => r.company_name) || {}).company_name || 'Odoo';
  return odooToBook({ invoices: I.rows, bills: B.rows, cash: C[0] || null, company, lastSync: creds[0].last_success_at || (C[0] && C[0].as_of) || null, truncated: I.truncated || B.truncated });
}

/* ------------------------------------------------------------------ one place */

/** Headline figures of a book, for comparing sources side by side (never added). */
function summarise(book) {
  const recv = (book.bills || []).filter((b) => b.direction === 'receivable').reduce((t, b) => t + Math.abs(num(b.closing_balance)), 0);
  const pay = (book.bills || []).filter((b) => b.direction === 'payable').reduce((t, b) => t + Math.abs(num(b.closing_balance)), 0);
  return { source: book.source, source_name: book.source_name, company: book.company, last_sync: book.lastSync || null,
    receivables: r2(recv), payables: r2(pay), entries: (book.vouchers || []).length };
}

/** Which connected book everyone reads: most trusted, then most recently synced, then the one with most entries. */
function choosePrimary(books) {
  const usable = books.filter((b) => b && b.connected && ((b.vouchers || []).length || (b.bills || []).length || (b.ledgers || []).length));
  const pool = usable.length ? usable : books.filter((b) => b && b.connected);
  return pool.slice().sort((a, b) => (TRUST[b.source] || 0) - (TRUST[a.source] || 0)
    || (Date.parse(b.lastSync || 0) || 0) - (Date.parse(a.lastSync || 0) || 0)
    || (b.vouchers || []).length - (a.vouchers || []).length)[0] || null;
}

// Zoho and Odoo books are kept a few minutes per account, like tallyData does for Tally, so a conversation that asks
// five questions reads them once. The same book object comes back, so callers can cache work on it (booksTools).
const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map();   // userId|source -> { at, book }
function cached(source, load) {
  return async (userId, o) => {
    const k = userId + '|' + source, hit = _cache.get(k);
    if (!(o && o.fresh) && hit && Date.now() - hit.at < CACHE_MS) return hit.book;
    const book = await load(userId);
    _cache.set(k, { at: Date.now(), book });
    while (_cache.size > 40) _cache.delete(_cache.keys().next().value);
    return book;
  };
}
const _tallyWrapped = new WeakMap();   // tallyData's cached book -> the same wrapped object every time
const ADAPTERS = {
  tally: async (userId, o) => {
    const b = await tallyData.loadTallyBook(userId, o);
    if (!b.connected) return b;
    if (!_tallyWrapped.has(b)) _tallyWrapped.set(b, Object.assign({ source: 'tally', source_name: SOURCE_NAME.tally, notes: [] }, b));
    return _tallyWrapped.get(b);
  },
  zoho: cached('zoho', loadZoho),
  odoo: cached('odoo', loadOdoo)
};
const _merged = new WeakMap();   // primary book -> { key, out }: one stable object per book + its comparison

/**
 * The account's books, from whichever system keeps them.
 * @param {string} userId
 * @param {{ company?:string, fresh?:boolean, source?:'tally'|'zoho'|'odoo' }} [opts]  source: read that one (for a source picker)
 */
async function loadBooks(userId, opts) {
  const o = opts || {};
  const names = o.source && ADAPTERS[o.source] ? [o.source] : Object.keys(ADAPTERS);
  const got = await Promise.all(names.map((n) => ADAPTERS[n](userId, o).then((b) => (b.connected ? b : Object.assign({ source: n }, b))).catch((e) => ({ connected: false, source: n, error: e.message }))));
  const connected = got.filter((b) => b.connected);
  if (!connected.length) {
    const failed = got.find((b) => b.error);
    if (failed && names.length === 1) throw new Error(failed.error);
    return { connected: false, companies: [], sources: [] };
  }
  const primary = choosePrimary(connected);
  const others = connected.filter((b) => b !== primary);
  const key = connected.map((b) => b.source + '@' + (b.lastSync || '')).join('|');
  const hit = _merged.get(primary);
  if (hit && hit.key === key) return hit.out;
  const out = Object.assign({}, primary, {
    sources: connected.map((b) => ({ source: b.source, source_name: b.source_name, primary: b === primary, last_sync: b.lastSync || null })),
    compare: others.length ? [summarise(primary)].concat(others.map(summarise)) : []
  });
  _merged.set(primary, { key, out });
  return out;
}

/** Drop what this instance remembers for an account (after a ledger is re-classified). */
function forgetBooks(userId) {
  tallyData.forgetTallyBook(userId);
  for (const k of [..._cache.keys()]) if (k.startsWith(userId + '|')) _cache.delete(k);
}

module.exports = { loadBooks, forgetBooks, zohoToBook, odooToBook, choosePrimary, summarise, SOURCE_NAME, TRUST };
