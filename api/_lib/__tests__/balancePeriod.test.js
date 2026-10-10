/** Run: node api/_lib/__tests__/balancePeriod.test.js — zero-dep, no network.
 * Tally's balances cover whatever period is on its screen (tallyAnalytics.balancePeriod / alignToToday).
 * The books here are shaped like Care Hygiene on 11 Oct 2026: one Tally company holding FY 2025-26 and
 * FY 2026-27, the screen left on 2025-26 (so every balance stops at 31 Mar 2026), loan EMIs entered ahead. */
const A = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''))); };
const NOW = '2026-10-11T06:00:00Z';

// Tally's own signs: entries and balances both negative = debit.
let g = 0;
const V = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0][1]), is_cancelled: false,
  entries: entries.map(([ledger, amount, is_party]) => ({ ledger, amount, is_party: !!is_party })) });
const vouchers = [];
const months = [];
for (let i = 0; i < 19; i++) { const y = 2025 + Math.floor((3 + i) / 12), m = (3 + i) % 12 + 1; months.push([y, m]); }   // Apr 2025 .. Oct 2026
const ymd = (y, m, d) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
months.forEach(([y, m], i) => {
  const last = y === 2026 && m === 10;
  const sale = 1000000 + i * 50000, buy = 700000 + i * 20000;
  vouchers.push(V('Sales', ymd(y, m, 5), 'Alkem', [['Alkem', -sale * 1.12, true], ['GST Sale', sale], ['Output GST', sale * 0.12]]));
  vouchers.push(V('Purchase', ymd(y, m, 6), 'Supplier A', [['Supplier A', buy * 1.12, true], ['Purchase GST', -buy], ['Input GST', -buy * 0.12]]));
  if (!last) vouchers.push(V('Receipt', ymd(y, m, 20), 'Alkem', [['Alkem', sale * 0.9, true], ['Kotak Bank', -sale * 0.9]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 22), 'Supplier A', [['Supplier A', -buy, true], ['Kotak Bank', buy]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 28), null, [['Salary', -100000], ['Kotak Bank', 100000]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 10), null, [['Kotak Loan', -50000], ['Interest on Loan', -7573], ['Kotak Bank', 57573]]));
});
vouchers.push(V('Journal', '20260331', null, [['Depreciation', -500000], ['Plant', 500000]]));           // year end only
vouchers.push(V('Payment', '20260715', null, [['Packing @ 5%', -35000], ['Kotak Bank', 35000]]));         // a ledger new this year
// EMIs entered ahead for Nov 2026 to Mar 2027
const future = [11, 12, 1, 2, 3].map((m) => V('Payment', ymd(m >= 11 ? 2026 : 2027, m, 10), null, [['Kotak Loan', -50000], ['Interest on Loan', -7573], ['Kotak Bank', 57573]]));
const all = vouchers.concat(future);

const OPEN = { 'Kotak Bank': -2000000, 'Kotak Loan': 5000000, 'Alkem': -3000000, 'Supplier A': 1500000, 'Plant': -4000000, 'Stock-in-hand': -4062250 };
const GROUP = { 'Kotak Bank': 'Bank Accounts', 'Kotak Loan': 'Secured Loans', 'Alkem': 'Sundry Debtors', 'Supplier A': 'Sundry Creditors', 'Plant': 'Fixed Assets', 'Stock-in-hand': 'Stock-in-hand',
  'GST Sale': 'Sales Accounts', 'Purchase GST': 'Purchase Accounts', 'Salary': 'Indirect Expenses', 'Interest on Loan': 'Indirect Expenses', 'Depreciation': 'Indirect Expenses', 'Packing @ 5%': 'Direct Expenses',
  'Output GST': 'Duties & Taxes', 'Input GST': 'Duties & Taxes' };
const moved = (name, from, to) => all.filter((v) => v.date >= from && v.date <= to).reduce((s, v) => s + v.entries.filter((e) => e.ledger === name).reduce((a, e) => a + e.amount, 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;
// What Tally answers with the given period on its screen.
const tallyLedgers = (from, to) => Object.keys(GROUP).map((name) => {
  const pl = /Sales|Purchase|Expenses/.test(GROUP[name]);
  const opening = pl ? 0 : r2((OPEN[name] || 0) + moved(name, '20250401', String(+from - 1)));
  return { name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: opening, closing_balance: name === 'Stock-in-hand' ? -5759321 : r2(opening + moved(name, from, to)) };
});
const truth = (name) => r2((OPEN[name] || 0) + moved(name, '20250401', '20261011'));
const bal = (t, name) => t.ledgers.find((l) => l.name === name);

/* ---- the screen left on last year: balances stop at 31 Mar 2026 ---- */
{
  const led = tallyLedgers('20250401', '20260331');
  const bp = A.balancePeriod(led, all);
  check('the period Tally used is found from the entries alone', bp && new Date(bp.from).toISOString().slice(0, 10) === '2025-04-01' && new Date(bp.to).toISOString().slice(0, 10) === '2026-03-31' && bp.sign === 'same', bp && { from: new Date(bp.from), to: new Date(bp.to), tied: bp.tied, tested: bp.tested, sign: bp.sign });
  check('every ledger with entries ties to that period', bp.tied === bp.tested && bp.tie.every((t) => t.ok), bp.tie.filter((t) => !t.ok));
  const t = A.asOfToday(led, all, NOW);
  check('balances are carried forward to today', t.balances && t.balances.rolled_forward && t.guard.decision === 'rolled_forward' && t.balances.carried_vouchers > 0, t.balances && { ...t.balances, tie: undefined });
  for (const n of ['Kotak Bank', 'Kotak Loan', 'Alkem', 'Supplier A']) check(`${n}: today's balance, to the rupee`, bal(t, n).closing_balance === truth(n), { got: bal(t, n).closing_balance, want: truth(n), tally_said: bal(t, n).tally_closing_balance });
  check('March\'s bank balance was NOT today\'s (the bug this fixes)', bal(t, 'Kotak Bank').tally_closing_balance !== truth('Kotak Bank'));
  check('EMIs entered for later dates wait for their date and are not taken off a balance that never had them', t.future.length === 5 && t.vouchers.length === all.length - 5 && bal(t, 'Kotak Loan').closing_balance === truth('Kotak Loan'));
  check('opening balances are left as Tally gave them (they are as at the first entry)', bal(t, 'Kotak Bank').opening_balance === OPEN['Kotak Bank']);
  check('opening + every synced entry to today = closing, for every ledger (what every reader assumes)', t.ledgers.every((l) => l.name === 'Stock-in-hand' || Math.abs(l.opening_balance + moved(l.name, '20250401', '20261011') - l.closing_balance) < 0.01));

  const a = A.computeAnalytics({ ledgers: led, vouchers: all, bills: [{ direction: 'receivable', party_name: 'Alkem', bill_ref: 'A1', closing_balance: 3000000, overdue_days: 40 }], now: NOW });
  const fy = months.filter(([y, m]) => (y === 2026 && m >= 4)), sumSales = fy.reduce((s, [y, m]) => s + 1000000 + months.findIndex((x) => x[0] === y && x[1] === m) * 50000, 0);
  check('the totals are this financial year, not both years added', a.period.from === '2026-04-05' && a.period.net_sales === sumSales, a.period);
  check('each year is shown on its own', a.years.length === 2 && a.years[0].fy === '2025-26' && a.years[1].fy === '2026-27' && a.years[1].current && r2(a.years[0].net_sales + a.years[1].net_sales) === a.pnl.reduce((s, r) => s + r.net_sales, 0), a.years);
  check('stock movement goes to the year Tally\'s stock value belongs to', a.years[0].stock_change === 1697071 && a.years[0].gross_margin_pct_after_stock != null && a.years[1].gross_margin_pct_after_stock == null && a.period.gross_margin_pct_after_stock == null, { y: a.years, p: a.period });
  check('stock is dated, and days of stock is not claimed from March\'s value', a.stock.as_at === '2026-03-31' && a.working_capital.stock_as_at === '2026-03-31' && a.working_capital.dio_days == null, a.stock);
  check('the ledger check compares like with like: nothing fails', a.quality.tie_out.length >= 5 && a.quality.tie_out.every((x) => x.ok) && !a.quality.reasons.some((r) => /don't tie/.test(r)), a.quality.tie_out);
  check('a ledger first used this year is not called a mismatch', a.quality.tie_out.every((x) => x.ledger !== 'Packing @ 5%' || x.ok));
  check('cash is today\'s', a.cash && a.cash.total === -truth('Kotak Bank'), { cash: a.cash, want: -truth('Kotak Bank') });
  check('the owner is told, in plain words', a.quality.reasons.some((r) => /Tally's balances stop at 31 Mar 2026/.test(r)) && a.quality.balances_period.rolled_forward === true, a.quality.reasons);
  check('where the money goes is this year only', a.cost_structure.find((c) => c.ledger === 'Salary').amount === 600000, a.cost_structure);
  check('confidence is no longer dragged to Low by a false mismatch', a.quality.confidence !== 'low', a.quality.confidence);
  // days to get paid: owed (with GST) against billed (with GST)
  const billed90 = all.filter((v) => v.voucher_type === 'Sales' && v.date >= '20260713' && v.date <= '20261011').reduce((s, v) => s + -v.entries[0].amount, 0);
  check('days to get paid compares what is owed with what was billed, GST on both sides', a.working_capital.dso_days === r2(3000000 / billed90 * 90) && a.working_capital.billed_90d === r2(billed90), { dso: a.working_capital.dso_days, billed90 });
  A.applyTiedReceivables(a, [{ direction: 'receivable', party_name: 'Alkem', bill_ref: 'A1', closing_balance: 1500000, overdue_days: 40 }]);
  check('...and follows the tied "owed to you" figure, on the tile, the customer row and the headline', a.working_capital.dso_days === r2(1500000 / billed90 * 90) && a.customers.find((c) => c.party === 'Alkem').outstanding === 1500000 && a.headlines.some((h) => /Carrying ₹15,00,000 owed/.test(h)), { wc: a.working_capital.dso_days, h: a.headlines });
}

/* ---- the screen on this year (1 Apr 2026 to 31 Mar 2027), last year's entries also synced ---- */
{
  const led = tallyLedgers('20260401', '20270331');
  const t = A.asOfToday(led, all, NOW);
  check('this year on screen: the period is found and the later EMIs are backed out', t.balances && t.balances.from === '2026-04-01' && !t.balances.rolled_forward && t.guard.decision === 'backed_out' && bal(t, 'Kotak Bank').closing_balance === truth('Kotak Bank') && bal(t, 'Kotak Loan').closing_balance === truth('Kotak Loan'), t.balances && { ...t.balances, tie: undefined, bank: bal(t, 'Kotak Bank') });
  check('...and opening balances move back to the first synced entry', bal(t, 'Kotak Bank').opening_balance === OPEN['Kotak Bank'] && bal(t, 'Alkem').opening_balance === OPEN['Alkem'], bal(t, 'Kotak Bank'));
}

/* ---- a two-year period on screen (first entry to 31 Mar 2027): already fits, the usual reading is kept ---- */
{
  const led = Object.keys(GROUP).map((name) => ({ name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: OPEN[name] || 0, closing_balance: r2((OPEN[name] || 0) + moved(name, '20250401', '20270331')) }));
  const t = A.asOfToday(led, all, NOW, 'same');
  check('balances that already run from the first entry past today are read the usual way', !t.balances && t.guard.decision === 'backed_out' && bal(t, 'Kotak Bank').closing_balance === truth('Kotak Bank'), { b: t.balances && { ...t.balances, tie: undefined }, g: t.guard });
}

/* ---- entries missing from the sync: no clear period, nothing is changed ---- */
{
  const led = tallyLedgers('20250401', '20260331').map((l, i) => Object.assign({}, l, { closing_balance: l.closing_balance + (i + 1) * 1234.5 }));
  const bp = A.balancePeriod(led, all);
  check('when the ledgers don\'t clearly tie to one period, Margyn does not guess', bp === null, bp && { tied: bp.tied, tested: bp.tested });
}

/* ---- the other sign convention (debit positive balances) ---- */
{
  const led = tallyLedgers('20250401', '20260331').map((l) => Object.assign({}, l, { opening_balance: -l.opening_balance, closing_balance: -l.closing_balance }));
  const t = A.asOfToday(led, all, NOW);
  check('balances that carry debit as positive are carried forward the right way round', t.balances && t.balances.sign === 'opposite' && bal(t, 'Kotak Bank').closing_balance === -truth('Kotak Bank'), t.balances && { ...t.balances, tie: undefined });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
