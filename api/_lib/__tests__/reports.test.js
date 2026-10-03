/**
 * Reports model (app/js/margyn-reports.js): figures per period from the books, never summed readings.
 * Zero-dep. Run: node api/_lib/__tests__/reports.test.js
 */
const R = require('../../../app/js/margyn-reports.js');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const NOW = Date.parse('2026-10-04T06:00:00Z');
const pnl = [
  { month: '2026-07', net_sales: 2.5e7, cogs_pre_stock: 1.6e7, opex: 4.2e6, net_profit_pre_stock: 4.8e6 },
  { month: '2026-08', net_sales: 2.8e7, cogs_pre_stock: 1.8e7, opex: 4.1e6, net_profit_pre_stock: 5.9e6 },
  { month: '2026-09', net_sales: 2.2e7, cogs_pre_stock: 1.5e7, opex: 2.66e5, net_profit_pre_stock: 6.7e6, costs_incomplete: true },
  { month: '2026-10', net_sales: 1.4e5, cogs_pre_stock: 1e5, opex: 2.9e5, net_profit_pre_stock: -2.5e5, provisional: true }
];
const cashPoints = [];
for (let t = Date.parse('2026-07-01'); t <= Date.parse('2026-10-04'); t += 86400000) cashPoints.push({ date: new Date(t).toISOString().slice(0, 10), cash: 1e6 + (t - Date.parse('2026-07-01')) / 86400000 * 1000 });
// Five readings in one week, each saying "₹26 Cr a month" (wrong) — must never be summed.
const readings = [0, 1, 2, 3, 4].map((d) => ({ created_at: new Date(NOW - d * 3600000).toISOString(), revenue: 2.6e8, burn: 1e8, net_profit: 1e7, cash: 4.38e5, pulse_score: 40 + d }));

let m = R.build({ pnl, cashPoints, readings, metrics: ['revenue', 'netprofit'], group: 'Month', rangeDays: 372, now: NOW });
const sep = m.periods.find((p) => p.key === '2026-09');
check('monthly revenue = that month in the books', sep && sep.values.revenue === 2.2e7, sep);
check('readings are not added to the books', m.periods.find((p) => p.key === '2026-10').values.revenue === 1.4e5);
check('October is in progress', m.periods.find((p) => p.key === '2026-10').in_progress === true);
check('cash at month end from book history', sep.values.cash === cashPoints.find((p) => p.date === '2026-09-30').cash, sep.values.cash);

m = R.build({ pnl, cashPoints, readings, metrics: ['margin'], group: 'Month', rangeDays: 372, now: NOW });
check('no margin for a month in progress', m.periods.find((p) => p.key === '2026-10').values.margin === null);
check('no margin when costs incomplete', m.periods.find((p) => p.key === '2026-09').values.margin === null);
check('margin = profit / revenue', Math.abs(m.periods.find((p) => p.key === '2026-08').values.margin - 5.9e6 / 2.8e7 * 100) < 1e-9);

m = R.build({ pnl, cashPoints, readings, metrics: ['revenue'], group: 'Week', rangeDays: 372, now: NOW });
check('weekly revenue from monthly books is drawn by month, with a note', m.group === 'Month' && /by month/.test(m.note));

m = R.build({ pnl, cashPoints, readings, metrics: ['revenue'], group: 'Quarter', rangeDays: 372, now: NOW });
const q3 = m.periods.find((p) => p.key === '2026-Q3');
check('quarter sums its months', q3 && q3.values.revenue === 2.5e7 + 2.8e7 + 2.2e7, q3);

m = R.build({ pnl, cashPoints, readings, metrics: ['cash'], group: 'Week', rangeDays: 31, now: NOW });
check('weekly cash from book history, not ₹0', m.periods.length >= 4 && m.periods.every((p) => p.values.cash > 0), m.periods.map((p) => p.values.cash));
check('this week ends today', m.periods[m.periods.length - 1].values.cash === cashPoints[cashPoints.length - 1].cash);

m = R.build({ pnl: [], cashPoints: [], readings, metrics: ['revenue'], group: 'Week', rangeDays: 93, now: NOW });
check('without books: last reading in the period, never the sum', m.periods.length === 1 && m.periods[0].values.revenue === 2.6e8, m.periods);

m = R.build({ pnl, cashPoints, readings, metrics: ['pulse'], group: 'Month', rangeDays: 93, now: NOW });
check('Pulse comes from readings; month without one has none', m.periods.length === 1 && m.periods[0].values.pulse === 40, m.periods);

const ch = R.lastChange(R.build({ pnl, cashPoints, readings, metrics: ['revenue'], group: 'Month', rangeDays: 372, now: NOW }).periods, 'revenue');
check('change compares whole months only (Aug vs Jul)', ch && ch.to === "Aug '26" && ch.from === "Jul '26", ch);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
