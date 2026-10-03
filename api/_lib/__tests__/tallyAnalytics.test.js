/** Run: node api/_lib/__tests__/tallyAnalytics.test.js — zero-dep, no network. */
const { computeAnalytics, classifyLedgers } = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };

const ledgers = [
  { name: 'Sales - Domestic', parent: 'Sales Accounts', opening_balance: 0, closing_balance: 300000 },
  { name: 'Purchase - Goods', parent: 'Purchase Accounts', opening_balance: 0, closing_balance: -130000 },
  { name: 'Freight Inward', parent: 'Direct Expenses', opening_balance: 0, closing_balance: -5000 },
  { name: 'Salaries', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: -40000 },
  { name: 'Admin Overheads', parent: 'Admin Costs', opening_balance: 0, closing_balance: -2000 },     // custom subgroup -> guessed
  { name: 'Mystery Ledger', parent: 'Misc Group X', opening_balance: 0, closing_balance: -700 },      // unknown
  { name: 'Output CGST', parent: 'Duties & Taxes', opening_balance: 0, closing_balance: 10000 },
  { name: 'Input CGST', parent: 'Duties & Taxes', opening_balance: 0, closing_balance: -6000 },
  { name: 'Stock-in-hand', parent: 'Stock-in-hand', opening_balance: 50000, closing_balance: 80000 },
  { name: 'HDFC Bank', parent: 'Bank Accounts', closing_balance: 120000 },
  { name: 'Acme Retail', parent: 'Sundry Debtors', closing_balance: 100000 },
  { name: 'Beta Stores', parent: 'Sundry Debtors', closing_balance: 50000 }
];
const V = (type, num, date, party, entries, extra) => Object.assign({ voucher_type: type, voucher_number: num, date, party_name: party, amount: Math.abs(entries[0][1]), is_cancelled: false,
  entries: entries.map(([ledger, amount, is_party]) => ({ ledger, amount, is_party: !!is_party })) }, extra || {});

const vouchers = [
  // Sales 2026-07: 100k ; 2026-08: 200k ; credit note 10k in Aug against Acme
  V('Sales', '1', '20260710', 'Acme Retail', [['Acme Retail', -118000, true], ['Sales - Domestic', 100000], ['Output CGST', 18000]]),
  V('Sales', '2', '20260815', 'Beta Stores', [['Beta Stores', -236000, true], ['Sales - Domestic', 200000], ['Output CGST', 36000]]),
  V('Credit Note', '1', '20260820', 'Acme Retail', [['Acme Retail', 10000, true], ['Sales - Domestic', -10000]]),
  // Purchases
  V('Purchase', '1', '20260705', 'Supplier A', [['Supplier A', 59000, true], ['Purchase - Goods', -50000], ['Input CGST', -9000]]),
  V('Purchase', '2', '20260805', 'Supplier A', [['Supplier A', 94400, true], ['Purchase - Goods', -80000], ['Input CGST', -14400]]),
  V('Payment', '1', '20260806', 'Transporter', [['Transporter', -5000, true], ['Freight Inward', -0, false], ['HDFC Bank', 5000]]),
  V('Journal', '1', '20260831', null, [['Salaries', -40000], ['HDFC Bank', 40000]]),
  V('Journal', '2', '20260831', null, [['Admin Overheads', -2000], ['Mystery Ledger', -700], ['HDFC Bank', 2700]]),
  V('Payment', '2', '20260812', null, [['Freight Inward', -5000], ['HDFC Bank', 5000]]),
  // cancelled one must be ignored
  V('Sales', '3', '20260818', 'Acme Retail', [['Acme Retail', -999999, true], ['Sales - Domestic', 999999]], { is_cancelled: true })
];
const bills = [
  { direction: 'receivable', party_name: 'Acme Retail', bill_ref: 'A1', closing_balance: 100000, overdue_days: 120 },
  { direction: 'receivable', party_name: 'Beta Stores', bill_ref: 'B1', closing_balance: 50000, overdue_days: 0 },
  { direction: 'payable', party_name: 'Supplier A', bill_ref: 'S1', closing_balance: 80000, overdue_days: 0 }
];

const now = '2026-09-15T00:00:00Z';
const a = computeAnalytics({ ledgers, vouchers, bills, now });

// classification
const cl = classifyLedgers(ledgers, {});
check('standard groups classify by group', cl.get('Sales - Domestic').bucket === 'sales' && cl.get('Purchase - Goods').bucket === 'purchases' && cl.get('Freight Inward').bucket === 'direct_expense' && cl.get('Salaries').bucket === 'opex' && cl.get('Stock-in-hand').bucket === 'stock' && cl.get('HDFC Bank').bucket === 'bank');
check('custom subgroup guessed, flagged', cl.get('Admin Overheads').confidence === 'guessed' && cl.get('Admin Overheads').bucket === 'opex');
check('unplaceable ledger is unknown', cl.get('Mystery Ledger').bucket === 'unknown');
check('override wins', classifyLedgers(ledgers, { 'Mystery Ledger': 'opex' }).get('Mystery Ledger').confidence === 'confirmed');

// P&L
const jul = a.pnl.find((r) => r.month === '2026-07'), aug = a.pnl.find((r) => r.month === '2026-08');
check('months present and sorted', a.pnl.map((r) => r.month).join() === '2026-07,2026-08', a.pnl.map((r) => r.month));
check('July sales/purchases/margin', jul.net_sales === 100000 && jul.purchases === 50000 && jul.gross_profit_pre_stock === 50000 && jul.gross_margin_pct_pre_stock === 50, jul);
check('Aug: credit note = returns, nets sales', aug.gross_sales === 200000 && aug.sales_returns === 10000 && aug.net_sales === 190000, aug);
check('Aug: freight in direct expense, margin', aug.direct_expense === 5000 && aug.gross_profit_pre_stock === 190000 - 80000 - 5000, aug);
check('cancelled voucher ignored', a.period.gross_sales === 300000, a.period);
check('opex includes guessed ledger (Salaries+Admin)', a.period.opex === 42000, a.period.opex);
check('stock adjustment applied at period level', a.stock.available && a.stock.change === 30000 && a.period.gross_profit_after_stock === a.period.gross_profit_pre_stock + 30000, a.stock);
check('provisional flag uses now', a.pnl.every((r) => r.provisional === false));

// leaks
check('returns % of gross sales', a.leaks.returns.value === 10000 && a.leaks.returns.pct_of_gross_sales === 3.33, a.leaks.returns);
check('freight measured', a.leaks.freight_and_carriage.value === 5000, a.leaks.freight_and_carriage);
check('cancelled counted', a.leaks.cancelled_vouchers.count === 1);
check('receivable carrying cost', a.leaks.carrying_cost_of_receivables_annual.value === 18000, a.leaks.carrying_cost_of_receivables_annual);

// working capital + customers
check('receivables/payables from bills', a.working_capital.receivables === 150000 && a.working_capital.payables === 80000 && a.working_capital.receivables_overdue === 100000);
check('stock value carried', a.working_capital.stock_value === 80000);
const acme = a.customers.find((c) => /acme/i.test(c.party));
check('customer row: returns + overdue flag', acme && acme.returns === 10000 && acme.flags.includes('over_90_days'), acme);
check('customer credit-adjusted margin below company margin', acme.est_margin_after_credit_pct != null && acme.est_margin_after_credit_pct < acme.est_margin_pct, acme);
check('customer margin honestly labelled as proxy without items', acme.margin_basis === 'company_average_pre_stock');

// gst
const gAug = a.gst_estimate.find((g) => g.month === '2026-08');
check('GST estimate nets output vs input', gAug.output_tax === 36000 && gAug.input_tax === 14400 && gAug.net_payable_estimate === 21600, gAug);

// quality + questions
check('unclassified surfaced', a.quality.unclassified_ledgers.some((u) => u.ledger === 'Mystery Ledger'));
check('classify questions asked (guessed + unknown)', a.questions.filter((q) => q.kind === 'classify_ledger').length === 2, a.questions);
check('confidence is never high with unclassified', a.quality.confidence !== 'high-for-a-single-source');
check('states single-source limitation', a.quality.reasons.some((r) => /Single source/.test(r)));
check('item level honestly unavailable', a.items_available === false && a.items.length === 0 && a.quality.reasons.some((r) => /Stock lines not synced/.test(r)));
check('headlines are deterministic strings', a.headlines.length > 0 && a.headlines.every((h) => typeof h === 'string'), a.headlines);
check('tie-out computed', a.quality.tie_out.length > 0);

// items path
const withItems = vouchers.map((v) => {
  if (v.voucher_number === '1' && v.voucher_type === 'Sales') return Object.assign({}, v, { items: [{ item: 'Widget', qty: 100, unit: 'Nos', rate: 1000, amount: 100000, abs_amount: 100000 }] });
  if (v.voucher_number === '2' && v.voucher_type === 'Sales') return Object.assign({}, v, { items: [{ item: 'Widget', qty: 160, unit: 'Nos', rate: 1250, amount: 200000, abs_amount: 200000 }, { item: 'Gadget', qty: 10, unit: 'Nos', rate: 10, amount: 100, abs_amount: 100 }] });
  if (v.voucher_number === '1' && v.voucher_type === 'Purchase') return Object.assign({}, v, { items: [{ item: 'Widget', qty: 100, unit: 'Nos', rate: 500, amount: -50000, abs_amount: 50000 }] });
  if (v.voucher_number === '2' && v.voucher_type === 'Purchase') return Object.assign({}, v, { items: [{ item: 'Widget', qty: 100, unit: 'Nos', rate: 800, amount: -80000, abs_amount: 80000 }] });
  return v;
});
const b = computeAnalytics({ ledgers, vouchers: withItems, bills, now });
const w = b.items.find((i) => i.item === 'Widget'), g = b.items.find((i) => i.item === 'Gadget');
check('items become available', b.items_available === true);
check('widget avg cost is weighted purchase cost', w.avg_cost === 650 && w.purchased_qty === 200, w);
check('widget margin uses avg cost', w.est_margin === r(300000 - 260 * 650), w);
check('item with no purchase flagged', g.flags.includes('no_purchase_cost_in_period') && b.questions.some((q) => q.kind === 'item_no_cost'), g);
check('margin bridge decomposes exactly', b.margin_bridge && Math.abs((b.margin_bridge.margin_to - b.margin_bridge.margin_from) - (b.margin_bridge.price_effect + b.margin_bridge.cost_effect + b.margin_bridge.volume_mix_effect)) < 1, b.margin_bridge);
function r(n) { return Math.round(n * 100) / 100; }


/* ---------- lessons from the connector build ---------- */
// 1. Day Book lists non-accounting vouchers: they must not be counted.
const withOrder = vouchers.concat([
  V('Sales Order', '9', '20260720', 'Acme Retail', [['Acme Retail', -500000, true], ['Sales - Domestic', 500000]]),
  V('Delivery Note', '9', '20260721', 'Acme Retail', [['Acme Retail', -500000, true], ['Sales - Domestic', 500000]]),
  V('Stock Journal', '1', '20260722', null, [['Purchase - Goods', -99999]])
]);
const o = computeAnalytics({ ledgers, vouchers: withOrder, bills, now });
check('orders, delivery notes and stock journals are not counted', o.period.gross_sales === 300000 && o.period.cogs_pre_stock === a.period.cogs_pre_stock, o.period);
check('excluded types are reported', o.quality.excluded_non_accounting_vouchers.count === 3 && o.quality.excluded_non_accounting_vouchers.by_type['Sales Order'] === 1, o.quality.excluded_non_accounting_vouchers);

// 2. Names arrive with control characters, stray spaces and different case.
const messy = vouchers.map((v) => Object.assign({}, v, { entries: v.entries.map((e) => e.ledger === 'Sales - Domestic' ? Object.assign({}, e, { ledger: ' sales -  domestic\u0004 ' }) : e) }));
const mz = computeAnalytics({ ledgers, vouchers: messy, bills, now });
check('ledger names match ignoring case, spacing and control characters', mz.period.gross_sales === 300000 && !mz.quality.unclassified_ledgers.some((u) => /sales/i.test(u.ledger)), mz.period);

// 3. Two active installs on one company carry the same GUIDs.
const g1 = vouchers.map((v, i) => Object.assign({}, v, { tally_guid: 'g' + i }));
const twice = computeAnalytics({ ledgers: ledgers.concat(ledgers), vouchers: g1.concat(g1), bills: bills.concat(bills), now });
check('duplicate installs do not double the books', twice.period.gross_sales === 300000 && twice.working_capital.receivables === 150000 && twice.working_capital.payables === 80000, [twice.period.gross_sales, twice.working_capital]);

// 4. Balance-sheet ledgers often come back with no balance.
const noBal = ledgers.map((l) => ['Stock-in-hand', 'HDFC Bank', 'Acme Retail', 'Beta Stores', 'Output CGST', 'Input CGST'].includes(l.name) ? Object.assign({}, l, { closing_balance: null, opening_balance: l.name === 'HDFC Bank' ? -100000 : l.opening_balance }) : l);
const nb = computeAnalytics({ ledgers: noBal, vouchers, bills, now });
check('stock with no returned balance is unavailable, not zero', nb.stock.available === false && nb.stock.reason === 'balance_not_returned' && nb.period.gross_profit_after_stock === null, nb.stock);
check('missing balance-sheet balances are counted and said', nb.quality.balance_sheet_balances.missing >= 5 && nb.quality.reasons.some((r) => /no balance for/.test(r)), nb.quality.balance_sheet_balances);
check('cash is derived from opening + vouchers when Tally gave no closing', nb.cash && nb.cash.derived_from_vouchers === 1 && nb.cash.total === 47300, nb.cash);   // debit opening 1,00,000 (negative = debit here) less 52,700 paid out
const noBoth = computeAnalytics({ ledgers: ledgers.map((l) => l.name === 'HDFC Bank' ? Object.assign({}, l, { closing_balance: null }) : l), vouchers, bills, now });
check('no closing and no opening: cash is unavailable, never a made-up number', noBoth.cash === null && noBoth.working_capital.cash === null, noBoth.cash);
check('stock question explains the real cause', nb.questions.some((q) => q.kind === 'stock_missing' && /no balance/.test(q.why)));

// 5. Sign convention is inferred from the data, not assumed silently.
const opp = computeAnalytics({ ledgers, vouchers, bills, now });   // fixture balances: sales +ve (credit), purchases -ve (debit) vs voucher sales +, purchases -  => same
check('convention detected from P&L ledgers that tie', opp.quality.balance_sign.convention === 'same' && opp.quality.balance_sign.assumed === false, opp.quality.balance_sign);
const flipped = ledgers.map((l) => Object.assign({}, l, { opening_balance: -(l.opening_balance || 0), closing_balance: l.closing_balance == null ? null : -l.closing_balance }));
const fl = computeAnalytics({ ledgers: flipped, vouchers, bills, now });
check('opposite convention detected too', fl.quality.balance_sign.convention === 'opposite', fl.quality.balance_sign);
const noEv = computeAnalytics({ ledgers: [], vouchers: [], bills: [], now });
check('no data: convention unknown and flagged assumed', noEv.quality.balance_sign.convention === 'unknown' && noEv.quality.balance_sign.assumed === true);

// 6. Agent phases 2/3 soft-fail; the last outcome feeds confidence.
const failed = computeAnalytics({ ledgers, vouchers, bills, now, syncRuns: [
  { kind: 'vouchers', status: 'ok', started_at: '2026-09-01T00:00:00Z' },
  { kind: 'vouchers', status: 'error', error_message: 'Tally: timeout', started_at: '2026-09-10T00:00:00Z' },
  { kind: 'bills', status: 'ok', started_at: '2026-09-10T00:00:00Z' }] });
check('latest failed voucher sync lowers confidence and is said', failed.quality.confidence === 'low' && failed.quality.reasons[0].includes('vouchers sync from Tally failed') && failed.quality.sync.length === 2, failed.quality.reasons);
const okRuns = computeAnalytics({ ledgers, vouchers, bills, now, syncRuns: [{ kind: 'vouchers', status: 'error', started_at: '2026-09-01T00:00:00Z' }, { kind: 'vouchers', status: 'ok', started_at: '2026-09-10T00:00:00Z' }] });
check('a later good sync clears the failure', !okRuns.quality.reasons.some((r) => /failed/.test(r)));

// 7. Educational mode is flagged.
check('educational edition is called out', computeAnalytics({ ledgers, vouchers, bills, now, edition: 'educational' }).quality.reasons.some((r) => /Educational/.test(r)));

// 8. A non-party ledger used in vouchers but missing from the ledger list is asked about; party-only ones are not.
const ghost = computeAnalytics({ ledgers: ledgers.filter((l) => l.name !== 'Salaries'), vouchers, bills, now });
check('ledger missing from the list (used as an expense line) is asked about', ghost.questions.some((q) => q.ledger === 'Salaries'), ghost.questions.map((q) => q.ledger));
check('party-only ledgers missing from the list are not asked about', !a.questions.some((q) => /Supplier A|Transporter/.test(q.ledger || '')));

// empty input is safe
const e = computeAnalytics({ ledgers: [], vouchers: [], bills: [], now });
check('empty input does not throw, says so', e.pnl.length === 0 && e.quality.confidence === 'low' && e.headlines.length === 0);


// ---- item invoices without Sales line, custom customer groups, inverted bills (Care Hygiene, 2026-10-01) ----
{
  const L = [
    { name: 'SUN PHARMA', parent: 'PHARMA GIFTING', opening_balance: 0, closing_balance: -118000 },
    { name: 'IGST', parent: 'Duties & Taxes', opening_balance: 0, closing_balance: 18000 },
    { name: 'VEER PACKAGING', parent: 'SUNDRY CREDITORS FOR EXPENSES', opening_balance: 0, closing_balance: 5000 },
    { name: 'Bank', parent: 'Bank Accounts', opening_balance: 0, closing_balance: 100 }
  ];
  const V = [
    { tally_guid: 'a', voucher_type: 'VASAI SALES', voucher_number: '1', date: '2026-09-10', party_name: 'SUN PHARMA', is_cancelled: false,
      entries: [{ ledger: 'SUN PHARMA', amount: -118000, is_party: true }, { ledger: 'IGST', amount: 18000, is_party: false }] },
    { tally_guid: 'b', voucher_type: 'Payment', voucher_number: '2', date: '2026-09-12', party_name: 'VEER PACKAGING', is_cancelled: false,
      entries: [{ ledger: 'VEER PACKAGING', amount: -5000, is_party: true }, { ledger: 'Bank', amount: 5000, is_party: false }] }
  ];
  const B = [
    { direction: 'payable', party_name: 'SUN PHARMA', bill_ref: 'x', closing_balance: -118000, overdue_days: 5 },
    { direction: 'payable', party_name: 'SUN PHARMA', bill_ref: 'y', closing_balance: -10, overdue_days: 5 },
    { direction: 'payable', party_name: 'SUN PHARMA', bill_ref: 'z', closing_balance: -10, overdue_days: 5 }
  ];
  const o = computeAnalytics({ ledgers: L, vouchers: V, bills: B, now: '2026-09-30' });
  check('item invoice: sales = total less tax', o.period.net_sales === 100000, o.period);
  check('payment to a creditor is not running cost', o.period.opex === 0, o.period);
  check('custom customer group is placed, not asked about', !o.quality.unclassified_ledgers.some((u) => u.ledger === 'SUN PHARMA'), o.quality.unclassified_ledgers);
  check('creditor group with "expenses" in the name is not guessed as opex', !o.quality.guessed_ledgers.some((u) => u.ledger === 'VEER PACKAGING'), o.quality.guessed_ledgers);
  check('inverted bill signs flipped to receivables', o.working_capital.receivables > 100000 && o.working_capital.payables === 0, o.working_capital);
}

// ---- renamed sales voucher types, short history ----
{
  const o = computeAnalytics({
    ledgers: [{ name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: 100 }, { name: 'Cust', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: -100 }],
    vouchers: [{ tally_guid: 's1', voucher_type: 'KANDIVALI SALE', voucher_number: '1', date: '2026-09-10', party_name: 'Cust', is_cancelled: false,
      entries: [{ ledger: 'Cust', amount: -100, is_party: true }, { ledger: 'Sales', amount: 100 }] }],
    bills: [{ direction: 'receivable', party_name: 'Cust', bill_ref: '1', closing_balance: 5000, overdue_days: 9 }], now: '2026-09-30'
  });
  check('KANDIVALI SALE counts as sales', o.period.net_sales === 100, o.period);
  check('days-to-pay hidden on under 80 days of vouchers', o.working_capital.dso_days === null && o.quality.reasons.some((r) => /days of vouchers/.test(r)), o.working_capital);
}
// Custom sub-groups of Indirect Expenses/Incomes are running costs/other income, not direct ones.
{
  const { guessBucket } = require('../tallyAnalytics');
  check('guess: "Indirect Expenses - Admin" is opex', guessBucket('Office Rent', 'Indirect Expenses - Admin') === 'opex', guessBucket('Office Rent', 'Indirect Expenses - Admin'));
  check('guess: "Indirect Exp (Office)" is opex', guessBucket('x', 'Indirect Exp (Office)') === 'opex', guessBucket('x', 'Indirect Exp (Office)'));
  check('guess: "Indirect Incomes - Misc" is other_income', guessBucket('x', 'Indirect Incomes - Misc') === 'other_income', guessBucket('x', 'Indirect Incomes - Misc'));
  check('guess: "Direct Expenses - Factory" still direct_expense', guessBucket('x', 'Direct Expenses - Factory') === 'direct_expense');
  check('guess: "Direct Incomes - Scrap" still direct_income', guessBucket('x', 'Direct Incomes - Scrap') === 'direct_income');
}

// Supplier days only when suppliers are tracked bill by bill
{
  const v2 = vouchers.concat([V('Purchase', '9', '20260901', 'Supplier B', [['Supplier B', 118000, true], ['Purchase - Goods', -100000], ['Input CGST', -18000]])]);
  const untracked = computeAnalytics({ ledgers, vouchers: v2, bills: bills.filter((b) => b.direction !== 'payable'), now });
  check('no open supplier bills for last month\'s suppliers: no supplier days', untracked.working_capital.dpo_days == null && untracked.working_capital.suppliers_tracked_billwise === false, untracked.working_capital);
  check('a supplier with an open bill is not called untracked', a.working_capital.suppliers_tracked_billwise !== false, a.working_capital);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
