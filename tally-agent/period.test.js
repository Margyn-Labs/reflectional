/** Run: node tally-agent/period.test.js — which dates the agent reads for a company file (voucherSync.choosePeriod). No Tally, no network. */
const assert = require('assert');
const { choosePeriod } = require('./voucherSync')._internal;
const on = (d) => new Date(d + 'T10:00:00');

// This year's file.
let p = choosePeriod({}, { books_from: '2026-04-01', last_voucher_date: '2027-03-10' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20260401', '20270331']);
// Last year's file (Care Hygiene 2025-26, opened for the audit): its own year.
p = choosePeriod({}, { books_from: '2025-04-01', last_voucher_date: '2026-03-31' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20250401', '20260331']);
// Books begun mid-year.
p = choosePeriod({}, { books_from: '2026-07-01', last_voucher_date: '2026-10-08' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20260701', '20270331']);
// No facts from Tally: this financial year. Pinned dates win.
p = choosePeriod({}, null, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to, p.source], ['20260401', '20270331', 'default']);
p = choosePeriod({ fromDateExplicit: true, fromDate: '20240401', toDate: '20250331' }, { books_from: '2025-04-01' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to, p.source], ['20240401', '20250331', 'config']);
console.log('period.test.js: all passed');
