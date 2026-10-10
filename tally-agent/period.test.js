/** Run: node tally-agent/period.test.js — which dates the agent reads (voucherSync.choosePeriod). No Tally, no network. */
const assert = require('assert');
const { choosePeriod, monthWindows } = require('./voucherSync')._internal;
const on = (d) => new Date(d + 'T10:00:00');
const cfg = {};

// Care Hygiene, 9 Oct 2026: one company holding 2025-26 and 2026-27; Tally reports 31 Mar 2026 as its last voucher date.
let p = choosePeriod(cfg, { books_from: '2025-04-01', last_voucher_date: '2026-03-31' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20250401', '20270331'], 'this year is always read, with last year: ' + JSON.stringify(p));
assert.ok(monthWindows(p.from, p.to).some((w) => w.key === '2026-10'), 'October 2026 is inside what is read');

// The same company when Tally reports a current date: the period does not depend on what Tally says its last voucher is.
p = choosePeriod(cfg, { books_from: '2025-04-01', last_voucher_date: '2027-03-10' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20250401', '20270331']);

// A company created for this year only: this year from its first day.
p = choosePeriod(cfg, { books_from: '2026-04-01', last_voucher_date: '2026-10-08' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20260401', '20270331']);

// Books begun mid-year.
p = choosePeriod(cfg, { books_from: '2026-07-01', last_voucher_date: '2026-10-08' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20260701', '20270331']);

// Books running for many years in one company: last year and this year, never the whole history.
p = choosePeriod(cfg, { books_from: '2019-04-01', last_voucher_date: '2026-10-08' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to], ['20250401', '20270331']);

// Tally gave no facts: this financial year.
p = choosePeriod(cfg, null, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to, p.source], ['20260401', '20270331', 'default']);

// Dates pinned in the config still win.
p = choosePeriod({ fromDateExplicit: true, fromDate: '20240401', toDate: '20250331' }, { books_from: '2025-04-01' }, on('2026-10-09'));
assert.deepStrictEqual([p.from, p.to, p.source], ['20240401', '20250331', 'config']);

// January to March belongs to the year that began the April before.
p = choosePeriod(cfg, { books_from: '2025-04-01', last_voucher_date: '2027-01-05' }, on('2027-02-10'));
assert.deepStrictEqual([p.from, p.to], ['20250401', '20270331']);

console.log('period.test.js: all passed');
