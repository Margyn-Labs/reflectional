/**
 * Zoho Net Margin reads a closed month, never the one in progress. Run: node api/_lib/__tests__/zohoMarginPeriod.test.js
 *
 * On 1 Nov 2026 the vital read November (no sales yet): Net Margin "n/a", net profit ₹0, Pulse 69 → 41.
 */
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

const { marginPeriods, latestClosedMargin } = require('../../_zoho/vitals');

// 1 Nov 2026, 12:15 IST
const NOW = Date.parse('2026-11-01T06:45:00Z');
const ps = marginPeriods(NOW);
check('first month tried is October, not November', ps[0] === '2026-10', ps);
check('six closed months, newest first', ps.length === 6 && ps[5] === '2026-05', ps);
check('January steps back into December', marginPeriods(Date.parse('2027-01-01T00:00:00Z'))[0] === '2026-12');
// 31 Oct 23:30 IST is still October in India: October is in progress, September is the closed month
check('IST month boundary, not UTC', marginPeriods(Date.parse('2026-10-31T18:00:00Z'))[0] === '2026-09');

const accounts = [{ id: 'S', account_type: 'income' }, { id: 'C', account_type: 'cost_of_goods_sold' }, { id: 'E', account_type: 'expense' }];
const post = (d, a, dr, cr) => ({ entry_date: d, account_ref: a, debit: dr, credit: cr });
const postings = [
  post('2026-09-10', 'S', 0, 500000), post('2026-09-11', 'E', 100000, 0),
  post('2026-10-05', 'S', 0, 800000), post('2026-10-06', 'C', 50000, 0), post('2026-10-07', 'E', 150000, 0),
  post('2026-11-01', 'E', 2000, 0)
];
const nm = latestClosedMargin(accounts, postings, ps);
check('October figures, whole month', nm && nm.period === '2026-10' && nm.income === 800000 && nm.net_profit === 600000, nm);
check('November postings ignored', nm && nm.opex === 150000, nm);

const noOct = postings.filter((p) => !p.entry_date.startsWith('2026-10'));
const nm2 = latestClosedMargin(accounts, noOct, ps);
check('no October sales → falls back to September', nm2 && nm2.period === '2026-09' && nm2.income === 500000, nm2);
check('no sales at all → null (keeps the SQL figure)', latestClosedMargin(accounts, [post('2026-10-02', 'E', 10, 0)], ps) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
