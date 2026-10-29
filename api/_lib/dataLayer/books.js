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
 *    bills as bills. Item lines (zoho_document_lines, read per document by _zoho/items.js) go on the Sales, Purchase,
 *    Credit Note and Debit Note vouchers in Tally's `items` shape; the item master's purchase rate is the fallback cost.
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

  // Item lines, in Tally's shape: { item, qty, unit, rate, amount, abs_amount, godown }. Quantity and value positive
  // as stored; `amount` takes Tally's sign (sales lines +, purchase lines −, credit notes −, debit notes +). Every
  // consumer reads abs_amount and gets the direction from the voucher type, exactly as for Tally.
  const itemName = new Map((z.items || []).map((i) => [String(i.item_id), i.name]));
  const linesByDoc = new Map();   // 'invoice:<id>' | 'bill:<id>' | 'creditnote:<id>' | 'vendorcredit:<id>' -> rows
  for (const l of z.lines || []) {
    if (!l || !l.doc_id || !l.item_id) continue;
    const k = l.doc_type + ':' + l.doc_id;
    if (!linesByDoc.has(k)) linesByDoc.set(k, []);
    linesByDoc.get(k).push(l);
  }
  const LINE_SIGN = { Sales: 1, Purchase: -1, 'Credit Note': -1, 'Debit Note': 1 };
  const attached = new Set();
  const recon = { docs: 0, gap: 0 };
  const itemsFor = (type, key, posted) => {
    const ls = linesByDoc.get(key);
    if (!ls || !ls.length || attached.has(key)) return null;   // a document split over several vouchers: first one only
    attached.add(key);
    const items = ls.map((l) => {
      const v = r2(Math.abs(num(l.value))), q = Math.abs(num(l.qty));
      return { item: itemName.get(String(l.item_id)) || l.item_name || 'Item', qty: q, unit: l.unit || null, rate: q ? r2(v / q) : null,
        amount: LINE_SIGN[type] * v, abs_amount: v, godown: l.location_name || null };
    });
    // Lines vs what the document posts before tax: shipping, an adjustment or a discount after tax sit outside them.
    const sum = items.reduce((t, it) => t + it.abs_amount, 0);
    if (posted != null && Math.abs(sum - Math.abs(posted)) > 1) { recon.docs++; recon.gap += Math.abs(sum - Math.abs(posted)); }
    return items;
  };
  const ledgers = new Map();
  const addLedger = (name, parent, closing) => { if (name && !ledgers.has(name)) ledgers.set(name, { name, parent, primary_group: parent, opening_balance: null, closing_balance: closing == null ? null : r2(closing) }); };

  // Bank, cash and card accounts: one ledger each, named as the Bank and cash section below names them.
  const bankName = (b) => (b.bank_name || 'Bank account') + (banks.filter((x) => x.bank_name === b.bank_name).length > 1 ? ' (' + String(b.account_id).slice(-4) + ')' : '');
  const bankLedgerById = new Map(banks.map((b) => [String(b.account_id), bankName(b)]));
  const bankAcct = new Map();   // zoho_chart_of_accounts.id -> bank ledger name
  for (const a of accounts) {
    const type = String(a.account_type || '').toLowerCase();
    if (['bank', 'cash', 'credit_card'].includes(type) && bankLedgerById.has(String(a.account_id))) bankAcct.set(String(a.id), bankLedgerById.get(String(a.account_id)));
  }

  const acct = new Map();   // zoho_chart_of_accounts.id -> { name, type }
  for (const a of accounts) {
    const type = String(a.account_type || '').toLowerCase();
    if (!ZOHO_GROUP[type] || !a.account_name) continue;
    acct.set(String(a.id), { name: a.account_name, type });
    addLedger(a.account_name, ZOHO_GROUP[type]);
  }

  const live = (r) => !['draft', 'void', 'deleted_at_source'].includes(String(r.status || '').toLowerCase());
  const inv = invoices.filter(live), bil = bills.filter(live);

  // Sales, first choice: the income postings themselves, which is what Zoho's own P&L adds up (credit notes
  // included). sync.js keys each posting "<document id>:<posting id>", so a posting from an invoice is put
  // against that invoice's customer. Exact to Zoho's P&L and split by customer (found live, 29 Oct 2026).
  const isIncome = (t) => t === 'income' || t === 'other_income';
  const invById = new Map(inv.map((i) => [String(i.invoice_id), i]));
  const salesByInvoice = new Map();   // invoice_id -> [{ ledger, amount }]
  for (const j of journals) {
    const a = acct.get(String(j.account_ref));
    if (!a || !isIncome(a.type) || !j.entry_date) continue;
    const doc = String(j.transaction_id || '').split(':')[0];
    if (!invById.has(doc)) continue;
    if (!salesByInvoice.has(doc)) salesByInvoice.set(doc, []);
    salesByInvoice.get(doc).push({ ledger: a.name, amount: num(j.credit) - num(j.debit), date: day(j.entry_date) });
  }
  const postingSales = salesByInvoice.size > 0;

  // Purchases the same way: postings from a bill, against the bill's vendor, the rest of the bill as input GST.
  const isCost = (t) => t === 'cost_of_goods_sold' || t === 'expense' || t === 'other_expense';
  const billById = new Map(bil.map((b) => [String(b.bill_id), b]));
  const costsByBill = new Map();
  for (const j of journals) {
    const a = acct.get(String(j.account_ref));
    if (!a || !isCost(a.type) || !j.entry_date) continue;
    const doc = String(j.transaction_id || '').split(':')[0];
    if (!billById.has(doc)) continue;
    if (!costsByBill.has(doc)) costsByBill.set(doc, []);
    costsByBill.get(doc).push({ ledger: a.name, amount: num(j.credit) - num(j.debit), date: day(j.entry_date) });
  }
  // Contact id -> name, for postings that carry a party but no invoice or bill in hand (credit notes, vendor credits).
  const contactName = new Map();
  for (const i of invoices) if (i.customer_ref && i.customer_name) contactName.set(String(i.customer_ref), { name: i.customer_name, group: 'Sundry Debtors' });
  for (const b of bills) if (b.vendor_ref && b.vendor_name && !contactName.has(String(b.vendor_ref))) contactName.set(String(b.vendor_ref), { name: b.vendor_name, group: 'Sundry Creditors' });
  const docOf = (j) => String(j.transaction_id || '').split(':')[0];
  // The bank side of each document. Customer and vendor payments carry no document id on the bank side, so
  // they never land here (they are the Receipt and Payment vouchers below); expenses and journals do.
  const bankByDoc = new Map();
  for (const j of journals) {
    const ledger = bankAcct.get(String(j.account_ref));
    if (!ledger || !j.entry_date || !String(j.transaction_id || '').includes(':')) continue;
    const doc = docOf(j);
    if (!bankByDoc.has(doc)) bankByDoc.set(doc, []);
    bankByDoc.get(doc).push({ ledger, amount: num(j.credit) - num(j.debit) });
  }
  const paidFromBank = new Map();   // document -> { date, lines: [{ ledger, amount }] }
  // Second choice (no income postings synced yet): invoices before GST, when every invoice carries that amount.
  const invoiceSales = !postingSales && inv.length > 0 && inv.every((i) => i.sub_total != null);
  if (inv.length && !postingSales && !invoiceSales) notes.push('Sales come from your Zoho income accounts, without the split by customer, until Zoho Books syncs again (it then sends each invoice before GST).');

  // What each document posts to income and cost accounts (credit notes and vendor credits may post to several).
  const plByDoc = new Map();
  for (const j of journals) {
    const a = acct.get(String(j.account_ref));
    if (!a || !String(j.transaction_id || '').includes(':')) continue;
    plByDoc.set(docOf(j), (plByDoc.get(docOf(j)) || 0) + num(j.credit) - num(j.debit));
  }

  const vouchers = [];
  for (const j of journals) {
    const a = acct.get(String(j.account_ref));
    if (!a || !j.entry_date) continue;
    if (postingSales && isIncome(a.type) && salesByInvoice.has(docOf(j))) continue;   // in the invoice's Sales voucher below
    if (isCost(a.type) && costsByBill.has(docOf(j))) continue;                       // in the bill's Purchase voucher below
    if (a.type === 'income' && invoiceSales) continue;   // the invoices carry these sales, with the customer
    const amt = num(j.credit) - num(j.debit);
    if (!amt) continue;
    const who = j.party_ref ? contactName.get(String(j.party_ref)) : null;
    if (!who && bankByDoc.has(docOf(j))) {
      // Paid or received straight through the bank (a Zoho Expense, a journal): one voucher with its bank side.
      const d = docOf(j);
      if (!paidFromBank.has(d)) paidFromBank.set(d, { date: day(j.entry_date), number: j.entry_number || null, lines: [] });
      paidFromBank.get(d).lines.push({ ledger: a.name, amount: r2(amt) });
      continue;
    }
    if (who) {
      // A credit note (income debited to a customer), a vendor credit (cost credited to a vendor) or any other
      // posting with a contact: against that party, balanced the way Tally books it.
      addLedger(who.name, who.group);
      const type = isIncome(a.type) && amt < 0 ? 'Credit Note' : isCost(a.type) && amt > 0 ? 'Debit Note' : 'Journal';
      const v = { voucher_type: type, voucher_number: j.entry_number || null, tally_guid: 'zj:' + j.account_ref + ':' + j.transaction_id, date: day(j.entry_date),
        party_name: who.name, amount: Math.abs(amt), is_cancelled: false,
        entries: [{ ledger: who.name, amount: -r2(amt), is_party: true }, { ledger: a.name, amount: r2(amt), is_party: false }], narration: null };
      if (type !== 'Journal') {
        const items = itemsFor(type, (type === 'Credit Note' ? 'creditnote:' : 'vendorcredit:') + docOf(j), plByDoc.get(docOf(j)));
        if (items) v.items = items;
      }
      vouchers.push(v);
      continue;
    }
    vouchers.push({ voucher_type: 'Journal', voucher_number: j.entry_number || null, tally_guid: 'zj:' + j.account_ref + ':' + j.transaction_id, date: day(j.entry_date),
      party_name: null, amount: Math.abs(amt), is_cancelled: false, entries: [{ ledger: a.name, amount: r2(amt), is_party: false }], narration: null });
  }

  for (const [d, v] of paidFromBank) {
    const entries = v.lines.map((l) => ({ ledger: l.ledger, amount: l.amount, is_party: false }));
    for (const b of bankByDoc.get(d)) entries.push({ ledger: b.ledger, amount: r2(b.amount), is_party: false });
    const rest = r2(-entries.reduce((x, e) => x + e.amount, 0));   // tax on the expense, if any
    if (Math.abs(rest) >= 0.01) { addLedger('Input GST (Zoho bills)', 'Duties & Taxes'); entries.push({ ledger: 'Input GST (Zoho bills)', amount: rest, is_party: false }); }
    const bankIn = bankByDoc.get(d).reduce((x, b) => x - b.amount, 0) > 0;   // bank debited: money came in
    vouchers.push({ voucher_type: bankIn ? 'Receipt' : 'Payment', voucher_number: v.number, tally_guid: 'zx:' + d, date: v.date, party_name: null,
      amount: Math.abs(bankByDoc.get(d).reduce((x, b) => x + b.amount, 0)), is_cancelled: false, entries, narration: null });
  }

  if (costsByBill.size) {
    const ZOHO_GST_IN = 'Input GST (Zoho bills)';
    addLedger(ZOHO_GST_IN, 'Duties & Taxes');
    for (const [id, lines] of costsByBill) {
      const b = billById.get(id);
      const party = b.vendor_name || 'Unknown vendor';
      addLedger(party, 'Sundry Creditors');
      const total = num(b.total);
      const entries = [{ ledger: party, amount: r2(total), is_party: true }];
      let posted = 0;
      for (const l of lines) { entries.push({ ledger: l.ledger, amount: r2(l.amount), is_party: false }); posted += l.amount; }
      const rest = r2(-total - posted);   // costs are debits (negative); the rest of the bill is input GST and the like
      if (Math.abs(rest) >= 0.01) entries.push({ ledger: ZOHO_GST_IN, amount: rest, is_party: false });
      const v = { voucher_type: 'Purchase', voucher_number: b.bill_number || null, tally_guid: 'zb:' + id, date: day(b.bill_date) || lines[0].date,
        party_name: party, amount: Math.abs(total), is_cancelled: false, entries, narration: null };
      const items = itemsFor('Purchase', 'bill:' + id, posted);
      if (items) v.items = items;
      vouchers.push(v);
    }
  }

  const custName = new Map();
  for (const i of invoices) if (i.customer_ref && i.customer_name) custName.set(String(i.customer_ref), i.customer_name);
  if (postingSales) {
    addLedger(ZOHO_GST_OUT, 'Duties & Taxes');
    for (const [id, lines] of salesByInvoice) {
      const i = invById.get(id);
      const party = i.customer_name || 'Unknown customer';
      addLedger(party, 'Sundry Debtors');
      const total = num(i.total);
      const entries = [{ ledger: party, amount: -r2(total), is_party: true }];
      let posted = 0;
      for (const l of lines) { entries.push({ ledger: l.ledger, amount: r2(l.amount), is_party: false }); posted += l.amount; }
      // GST, shipping and adjustment: the rest of the invoice, so the entry balances as Tally's does.
      const rest = r2(total - posted);
      if (Math.abs(rest) >= 0.01) entries.push({ ledger: ZOHO_GST_OUT, amount: rest, is_party: false });
      const v = { voucher_type: 'Sales', voucher_number: i.invoice_number || null, tally_guid: 'zi:' + id, date: day(i.invoice_date) || lines[0].date,
        party_name: party, amount: Math.abs(total), is_cancelled: false, entries, narration: null };
      const items = itemsFor('Sales', 'invoice:' + id, posted);
      if (items) v.items = items;
      vouchers.push(v);
    }
  }
  if (invoiceSales) {
    addLedger(ZOHO_SALES, 'Sales Accounts'); addLedger(ZOHO_GST_OUT, 'Duties & Taxes');
    for (const i of inv) {
      const party = i.customer_name || 'Unknown customer';
      addLedger(party, 'Sundry Debtors');
      const total = num(i.total), sub = num(i.sub_total), tax = r2(total - sub);
      const entries = [{ ledger: party, amount: -r2(total), is_party: true }, { ledger: ZOHO_SALES, amount: r2(sub), is_party: false }];
      if (Math.abs(tax) >= 0.01) entries.push({ ledger: ZOHO_GST_OUT, amount: tax, is_party: false });
      const v = { voucher_type: 'Sales', voucher_number: i.invoice_number || null, tally_guid: 'zi:' + i.invoice_id, date: day(i.invoice_date),
        party_name: party, amount: Math.abs(total), is_cancelled: false, entries, narration: null };
      const items = itemsFor('Sales', 'invoice:' + i.invoice_id, sub);
      if (items) v.items = items;
      vouchers.push(v);
    }
  }

  // Bank and cash: Zoho's balance per account. Payments move it, so the cash history can walk back through them.
  let primaryBank = null;
  for (const b of banks) {
    const t = String(b.account_type || '').toLowerCase();
    const name = bankName(b);
    const parent = t === 'cash' ? 'Cash-in-Hand' : t === 'credit_card' ? 'Bank OD A/c' : 'Bank Accounts';
    addLedger(name, parent, t === 'credit_card' ? -num(b.current_balance) : num(b.current_balance));
    if (parent !== 'Bank OD A/c' && (!primaryBank || b.is_primary)) primaryBank = name;
  }
  if (primaryBank) {
    for (const p of custPay) {
      if (!p.payment_date || !num(p.amount)) continue;
      const party = custName.get(String(p.customer_ref)) || 'Customer';
      addLedger(party, 'Sundry Debtors');
      vouchers.push({ voucher_type: 'Receipt', voucher_number: p.payment_number || null, tally_guid: 'zcp:' + p.payment_id, date: day(p.payment_date), party_name: party, amount: num(p.amount), is_cancelled: false,
        entries: [{ ledger: party, amount: r2(num(p.amount)), is_party: true }, { ledger: primaryBank, amount: -r2(num(p.amount)), is_party: false }], narration: p.payment_mode || null });
    }
    const vendName = new Map();
    for (const b of bills) if (b.vendor_ref && b.vendor_name) vendName.set(String(b.vendor_ref), b.vendor_name);
    for (const p of vendPay) {
      if (!p.payment_date || !num(p.amount)) continue;
      const party = vendName.get(String(p.vendor_ref)) || 'Vendor';
      addLedger(party, 'Sundry Creditors');
      vouchers.push({ voucher_type: 'Payment', voucher_number: p.payment_number || null, tally_guid: 'zvp:' + p.payment_id, date: day(p.payment_date), party_name: party, amount: num(p.amount), is_cancelled: false,
        entries: [{ ledger: party, amount: -r2(num(p.amount)), is_party: true }, { ledger: primaryBank, amount: r2(num(p.amount)), is_party: false }], narration: p.payment_mode || null });
    }
  }

  const openBills = [];
  for (const i of inv) if (num(i.balance) > 0.5) { addLedger(i.customer_name || 'Unknown customer', 'Sundry Debtors');
    openBills.push({ direction: 'receivable', party_name: i.customer_name || 'Unknown customer', bill_ref: i.invoice_number || String(i.invoice_id), bill_date: day(i.invoice_date), due_date: day(i.due_date), closing_balance: r2(i.balance), overdue_days: null }); }
  for (const b of bil) if (num(b.balance) > 0.5) { addLedger(b.vendor_name || 'Unknown vendor', 'Sundry Creditors');
    openBills.push({ direction: 'payable', party_name: b.vendor_name || 'Unknown vendor', bill_ref: b.bill_number || String(b.bill_id), bill_date: day(b.bill_date), due_date: day(b.due_date), closing_balance: r2(b.balance), overdue_days: null }); }

  if (recon.docs) notes.push(`${recon.docs} Zoho Books document${recon.docs === 1 ? '' : 's'} have item lines that differ from what ${recon.docs === 1 ? 'it posts' : 'they post'} before tax (by ${'₹' + Math.round(recon.gap).toLocaleString('en-IN')} in all): shipping, an adjustment or a discount after tax sits outside the item lines.`);
  // How far the per-document reads have got (newest first): item figures are whole only after the last unread date.
  const prog = z.lineProgress || null;
  if (prog && prog.pending > 0) notes.push(`Item lines are still coming in from Zoho Books: ${prog.read.toLocaleString('en-IN')} of ${prog.documents.toLocaleString('en-IN')} documents read, newest first${prog.complete_after ? ', so item figures are complete only after ' + prog.complete_after : ''}.`);
  // Item master: purchase rates, the fallback cost for items never bought on a bill in the synced period.
  const itemMaster = (z.items || []).filter((i) => i.name && num(i.purchase_rate) > 0).map((i) => ({ item: i.name, purchase_rate: num(i.purchase_rate), unit: i.unit || null }));

  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const company = org.organization_name || org.org_name || org.name || 'Zoho Books';
  const lastSync = org.last_sync_at || org.last_synced_at || org.last_success_at || null;
  return { connected: true, source: 'zoho', source_name: SOURCE_NAME.zoho, balance_convention: 'opposite', company, companies: [company], chosen: [], lastSync,
    edition: null, agentVersion: null, diagnostics: null,
    ledgers: [...ledgers.values()], vouchers, bills: openBills, truncated: !!z.truncated, overrides: z.overrides || {}, aiPlaced: new Set(), syncRuns: [], notes,
    item_master: itemMaster, item_coverage: prog, no_production_entries: true };
}

async function loadZoho(userId) {
  const orgs = await safe(selectRows('zoho_organizations', `select=*&user_id=eq.${userId}&status=eq.active&order=connected_at.desc&limit=1`), []);
  const org = orgs[0];
  if (!org) return { connected: false };
  const o = encodeURIComponent(org.id);
  const [A, J, I, B, CP, VP, BK, OV, L, IT, LS] = await Promise.all([
    safe(pagedAll('zoho_chart_of_accounts', `select=id,account_id,account_name,account_type&org_ref=eq.${o}&order=id.asc`, 5000), { rows: [] }),
    safe(pagedAll('zoho_journal_entries', `select=account_ref,transaction_id,entry_date,debit,credit,party_ref,entry_number&org_ref=eq.${o}&order=entry_date.asc,transaction_id.asc`, 60000)
      .catch(() => pagedAll('zoho_journal_entries', `select=account_ref,transaction_id,entry_date,debit,credit&org_ref=eq.${o}&order=entry_date.asc,transaction_id.asc`, 60000)), { rows: [] }),
    safe(pagedAll('zoho_invoices', `select=*&org_ref=eq.${o}&order=invoice_date.asc,invoice_id.asc`, 20000), { rows: [] }),
    safe(pagedAll('zoho_bills', `select=*&org_ref=eq.${o}&order=bill_date.asc,bill_id.asc`, 20000), { rows: [] }),
    safe(pagedAll('zoho_customer_payments', `select=payment_id,payment_number,customer_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000)
      .catch(() => pagedAll('zoho_customer_payments', `select=payment_id,customer_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000)), { rows: [] }),
    safe(pagedAll('zoho_vendor_payments', `select=payment_id,payment_number,vendor_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000)
      .catch(() => pagedAll('zoho_vendor_payments', `select=payment_id,vendor_ref,amount,payment_date,payment_mode&org_ref=eq.${o}&order=payment_date.asc`, 20000)), { rows: [] }),
    safe(selectRows('zoho_bank_accounts', `select=account_id,bank_name,account_type,current_balance,is_primary&org_ref=eq.${o}`), []),
    safe(selectRows('tally_ledger_classes', `select=ledger_name,bucket&user_id=eq.${userId}&company_name=eq.${encodeURIComponent(org.organization_name || org.org_name || org.name || 'Zoho Books')}`), []),
    // Item lines (2026-10-30-zoho-items.sql). Until that migration runs these come back empty and nothing changes.
    safe(pagedAll('zoho_document_lines', `select=doc_type,doc_id,item_id,item_name,qty,unit,value,location_name&org_ref=eq.${o}&order=id.asc`, 200000), { rows: [] }),
    safe(selectRows('zoho_items', `select=item_id,name,unit,purchase_rate&org_ref=eq.${o}&order=id.asc&limit=20000`), []),
    safe(selectRows('zoho_line_state', `select=doc_type,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${o}&order=id.asc&limit=200000`), [])
  ]);
  const overrides = {};
  for (const x of OV) overrides[x.ledger_name] = x.bucket;
  return zohoToBook({ org, accounts: A.rows, journals: J.rows, invoices: I.rows, bills: B.rows, customerPayments: CP.rows, vendorPayments: VP.rows, banks: BK, overrides,
    lines: L.rows, items: IT, lineProgress: LS.length ? require('../../_zoho/items').progressFrom(LS) : null,
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
  return { connected: true, source: 'odoo', source_name: SOURCE_NAME.odoo, balance_convention: 'opposite', company, companies: [company], chosen: [], lastSync: d.lastSync || null,
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

/**
 * Which connected book everyone reads: one with entries, then most trusted, then most recently synced, then the one
 * with most entries. A book with open invoices but no entries can't make an update, a P&L or a cash figure: on the demo
 * account (12–15 Oct 2026) Zoho Books (0 entries, 1 invoice) synced nightly after the Tally laptop went quiet, won on
 * "most recent", and every WhatsApp update said "No books to read yet" while Tally held the books.
 */
function choosePrimary(books) {
  const usable = books.filter((b) => b && b.connected && ((b.vouchers || []).length || (b.bills || []).length || (b.ledgers || []).length));
  const pool = usable.length ? usable : books.filter((b) => b && b.connected);
  const hasEntries = (b) => ((b.vouchers || []).length ? 1 : 0);
  return pool.slice().sort((a, b) => hasEntries(b) - hasEntries(a)
    || (TRUST[b.source] || 0) - (TRUST[a.source] || 0)
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
