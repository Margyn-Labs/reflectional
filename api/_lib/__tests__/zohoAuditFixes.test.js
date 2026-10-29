/** Run: node api/_lib/__tests__/zohoAuditFixes.test.js
 *  Fixes from the live audit of MARGYN DEMO's Zoho books (30 Oct 2026):
 *   1. invoice-number gaps are a Tally-only alarm (Zoho had INV-00001..01000 complete, yet "322 missing");
 *   2. the Margin page's basis line names the books it came from, not always Tally;
 *   3. a Zoho "sales only" item is labelled, listed after the products, and never counted as missing cost;
 *   4. amounts in Close & Collections proposals read ₹50,000, not ₹50000. */
const A = require('../tallyAnalytics');
const { runAgent } = require('../closeCollectionsAgent');

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const NOW = Date.parse('2026-10-30T06:00:00Z');
const ymd = (m, d) => '2026' + String(m).padStart(2, '0') + String(d).padStart(2, '0');
const ledgers = [
  { name: 'Sales', parent: 'Sales Accounts', primary_group: 'Sales Accounts', closing_balance: null },
  { name: 'Purchases', parent: 'Purchase Accounts', primary_group: 'Purchase Accounts', closing_balance: null },
  { name: 'Alpha Pharma', parent: 'Sundry Debtors', primary_group: 'Sundry Debtors', closing_balance: null },
  { name: 'Apex Supplies', parent: 'Sundry Creditors', primary_group: 'Sundry Creditors', closing_balance: null }
];
const sale = (n, m, d, amt, items) => ({ tally_guid: 'zi:' + n, voucher_type: 'Sales', voucher_number: 'INV-' + String(n).padStart(5, '0'), date: ymd(m, d), party_name: 'Alpha Pharma', amount: amt, is_cancelled: false,
  entries: [{ ledger: 'Alpha Pharma', amount: -amt, is_party: true }, { ledger: 'Sales', amount: amt, is_party: false }], items: items || null });
const buy = (n, m, d, amt, items) => ({ tally_guid: 'zb:' + n, voucher_type: 'Purchase', voucher_number: 'B-' + n, date: ymd(m, d), party_name: 'Apex Supplies', amount: amt, is_cancelled: false,
  entries: [{ ledger: 'Apex Supplies', amount: amt, is_party: true }, { ledger: 'Purchases', amount: -amt, is_party: false }], items: items || null });
const line = (item, qty, rate) => ({ item, qty, unit: 'nos', rate, amount: qty * rate, abs_amount: qty * rate, godown: null });

/* ---- 1 + 2: invoice numbers out of date order (MARGYN DEMO's shape), Zoho vs Tally ---- */
{
  // Numbers 1..360 with dates that don't follow them: every third one is dated Jan–Mar 2026 (last financial year),
  // so this year's run of numbers has holes that are really last year's invoices. That was MARGYN DEMO.
  const vouchers = [];
  for (let n = 1; n <= 360; n++) {
    const v = sale(n, 4 + ((n * 5) % 7), 1 + ((n * 13) % 27), 1000);
    if (n % 3 === 0) v.date = '2026' + String(1 + (n % 3 + n) % 3).padStart(2, '0') + '15';
    vouchers.push(v);
  }
  const zoho = A.computeAnalytics({ ledgers, vouchers, bills: [], now: NOW, source: 'zoho' });
  const tally = A.computeAnalytics({ ledgers, vouchers, bills: [], now: NOW });
  check('Zoho: invoice numbers out of date order raise no "missing invoices" alarm', !zoho.quality.reasons.some((r) => /invoices are missing/.test(r)), zoho.quality.reasons.slice(0, 2));
  check('Tally: the same scattered numbering does raise it (so the Zoho skip is what stops it)', tally.quality.reasons.some((r) => /invoices are missing/.test(r)), tally.quality.reasons.slice(0, 2));
  check('Zoho: basis names Zoho Books, not Tally', /^Zoho Books invoices, bills and accounts\./.test(zoho.basis) && !/Tally/.test(zoho.basis), zoho.basis);
  check('Odoo: basis names Odoo', /^Odoo /.test(A.computeAnalytics({ ledgers, vouchers, bills: [], now: NOW, source: 'odoo' }).basis));
  check('Tally: basis unchanged', /^Tally ledgers, vouchers and bills\./.test(tally.basis), tally.basis);
}

/* Tally still raises a real gap: a complete series with a run of numbers removed in one month. */
{
  const vouchers = [];
  let n = 0;
  for (let m = 4; m <= 9; m++) for (let i = 0; i < 60; i++) { n++; vouchers.push(sale(n, m, 1 + (i % 27), 1000)); }
  const holed = vouchers.filter((v) => { const k = +v.voucher_number.slice(4); return !(k >= 70 && k <= 100); });
  const tally = A.computeAnalytics({ ledgers, vouchers: holed, bills: [], now: NOW, source: 'tally' });
  const zoho = A.computeAnalytics({ ledgers, vouchers: holed, bills: [], now: NOW, source: 'zoho' });
  check('Tally: a run of missing numbers is still flagged first', /sales invoices are missing/.test(tally.quality.reasons[0]), tally.quality.reasons.slice(0, 1));
  check('Zoho: the same holes are not called missing (the API sends every invoice)', !zoho.quality.reasons.some((r) => /invoices are missing/.test(r)));
}

/* ---- 3: sales-only items ---- */
{
  const vouchers = [
    buy(1, 10, 2, 9500, [line('Surgical Mask', 100, 95)]),
    sale(1, 10, 5, 18000, [line('Surgical Mask', 100, 180)]),
    sale(2, 10, 6, 500000, [line('Consulting', 10, 50000)]),
    sale(3, 10, 7, 300000, [line('Goods', 30, 10000)]),
    sale(4, 10, 8, 40000, [line('Mystery Widget', 10, 4000)])
  ];
  const itemMaster = [
    { item: 'Consulting', purchase_rate: 0, unit: null, sales_only: true },
    { item: 'Goods', purchase_rate: 0, unit: null, sales_only: true }
  ];
  const a = A.computeAnalytics({ ledgers, vouchers, bills: [], now: NOW, source: 'zoho', itemMaster });
  const row = (n) => a.items.find((i) => i.item === n);
  check('sales-only item is labelled, not "no purchase cost"', row('Consulting').flags.includes('sales_only_item') && !row('Consulting').flags.includes('no_purchase_cost_in_period'), row('Consulting'));
  check('an item with no cost that can be bought is still flagged', row('Mystery Widget').flags.includes('no_purchase_cost_in_period'), row('Mystery Widget'));
  const order = a.items.map((i) => i.item);
  check('products come first, sales-only items after (each group by sales)', order.join() === 'Mystery Widget,Surgical Mask,Consulting,Goods', order);
  check('sales-only items are not listed as missing cost', !a.leaks.items_without_cost.some((i) => i.item === 'Consulting' || i.item === 'Goods') && a.leaks.items_without_cost.some((i) => i.item === 'Mystery Widget'), a.leaks.items_without_cost);
  check('a purchase-rate-0 sales-only item gets no made-up cost', row('Goods').avg_cost == null && row('Goods').est_margin == null);
}

/* ---- 4: proposal amounts read in Indian grouping ---- */
{
  const props = runAgent({ asOf: '2026-10-30', invoices: [{ ref: 'INV-1', number: 'INV-1', party: 'Test Customer', amount: 50000, balance: 50000, status: 'overdue', date: '2026-03-01', dueDate: '2026-04-03' }] });
  const bd = props.find((p) => p.kind === 'bad_debt');
  check('bad-debt card reads ₹50,000 unpaid', bd && /₹50,000 unpaid/.test(bd.title) && /₹50,000 outstanding/.test(bd.rationale), bd && bd.title);
  check('the journal amount stays a number', bd && bd.amount === 50000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
