/**
 * Sent → stored → read → used (api/_lib/dataCompleteness.js) on a small made-up Tally book.
 * Zero-dep. Run: node api/_lib/__tests__/dataCompleteness.test.js
 */
const E = require('../booksEngine');
const { tallyCompleteness } = require('../dataCompleteness');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };
const NOW = new Date('2026-10-04T06:00:00Z');

let g = 0;
const v = (type, date, party, entries, extra) => Object.assign({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries }, extra || {});
const V = [
  v('Sales', '2026-09-02', 'Alpha', [{ ledger: 'Alpha', amount: -118000, is_party: true }, { ledger: 'Sales', amount: 100000 }, { ledger: 'Output GST', amount: 18000 }]),
  v('Sales', '2026-09-10', 'Beta', [{ ledger: 'Beta', amount: -59000, is_party: true }, { ledger: 'Sales', amount: 50000 }, { ledger: 'Output GST', amount: 9000 }]),
  v('Receipt', '2026-09-20', 'Alpha', [{ ledger: 'Alpha', amount: 118000, is_party: true }, { ledger: 'Bank', amount: -118000 }]),
  v('Sales', '2026-09-21', 'Alpha', [{ ledger: 'Alpha', amount: -11800, is_party: true }, { ledger: 'Sales', amount: 10000 }, { ledger: 'Output GST', amount: 1800 }], { is_cancelled: true }),
  v('Payroll', '2026-09-30', null, [{ ledger: 'Salary', amount: -200000 }, { ledger: 'Salary Payable', amount: 200000 }]),
  v('Sales Order', '2026-09-25', 'Beta', [{ ledger: 'Beta', amount: -5000 }, { ledger: 'Sales', amount: 5000 }]),
  v('Journal', '2026-09-28', null, [{ ledger: 'Mystery Ledger', amount: -7000 }, { ledger: 'Bank', amount: 7000 }]),
  v('Payment', '2026-10-10', null, [{ ledger: 'Loan', amount: -50000 }, { ledger: 'Bank', amount: 50000 }])
];
// Balances debit-positive, the engine's default reading of a Tally export it can't calibrate (few ledgers).
const L = [
  { name: 'Alpha', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: null },     // nets to 0: genuinely zero
  { name: 'Beta', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 59000 },
  { name: 'Bank', parent: 'Bank Accounts', opening_balance: 500000, closing_balance: null },  // moved: should have a balance
  { name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: -150000 },
  { name: 'Output GST', parent: 'Duties & Taxes', opening_balance: 0, closing_balance: -27000 },
  { name: 'Salary', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: 200000 },
  { name: 'Salary Payable', parent: 'Current Liabilities', opening_balance: 0, closing_balance: -200000 },
  { name: 'Loan', parent: 'Secured Loans', opening_balance: 0, closing_balance: 50000 },
  { name: 'Mystery Ledger', parent: 'Odd Group', opening_balance: 0, closing_balance: 7000 }
];
// Beta's ledger says 59,000; its only open bill says 40,000 (a bill missing).
const B = [{ direction: 'receivable', party_name: 'Beta', bill_ref: 'B1', bill_date: '2026-09-10', due_date: '2026-10-10', closing_balance: 40000, overdue_days: 0 }];
const diagnostics = { agent_version: '0.2.4', at: '2026-10-03T13:43:00Z', errors: {}, ledgers: { received: 9 }, bills: { receivable: 1, payable: 0 },
  vouchers: { period: { from: '2026-04-01', to: '2027-03-31' }, months: { '2026-08': { tally: 0, synced: 0, complete: true }, '2026-09': { tally: 8, synced: 6, complete: false } } } };
const book = { connected: true, company: 'Test Co', ledgers: L, vouchers: V, bills: B, overrides: {}, syncRuns: [], diagnostics, agentVersion: '0.2.4',
  caps: { ledgers: { cap: 5000, truncated: false }, bills: { cap: 10000, truncated: false }, vouchers: { cap: 20000, truncated: false } } };
const out = tallyCompleteness(book, E.prepare(book, { now: NOW }), { now: NOW });
const C = Object.fromEntries(out.checks.map((c) => [c.key, c]));

check('a month short of Tally’s own count is flagged', C.vouchers_sent.status === 'warn' && /2026-09/.test(C.vouchers_sent.detail), C.vouchers_sent);
check('...with the stored count beside Tally’s', out.months.find((m) => m.month === '2026-09').stored === 6, out.months);   // 6 not cancelled in Sept, the Sales Order included; the EMI is October
check('every ledger Tally sent is stored', C.ledgers_sent.status === 'ok', C.ledgers_sent);
check('payroll is counted, not set aside (it posts salaries)', !/Payroll/.test(C.set_aside.detail) && C.set_aside.status === 'info', C.set_aside);
const ctxP = E.prepare(book, { now: NOW });
check('...so salaries reach the P&L', ctxP.rows.some((r) => r.type === 'Payroll' && r.opex === 200000), ctxP.rows.filter((r) => r.type === 'Payroll'));
check('cancelled, orders and dated-later vouchers are listed with their reason', /cancelled/.test(C.set_aside.detail) && /Sales Order/.test(C.set_aside.detail) && /after today/.test(C.set_aside.detail), C.set_aside.detail);
check('a blank balance that should be zero is fine; one that moved is flagged', C.ledger_balances.status === 'warn' && /^1 of 2/.test(C.ledger_balances.detail), C.ledger_balances.detail);
check('a ledger counted nowhere is named', C.ledgers_placed.status === 'warn' && /Mystery Ledger/.test(C.ledgers_placed.detail), C.ledgers_placed.detail);
check('customer bills that don’t add up to the ledger are flagged', C.bills_tie.status === 'warn' && C.bills_tie.gaps[0].party === 'Beta' && C.bills_tie.gaps[0].billed === 40000 && C.bills_tie.gaps[0].ledger === 59000, C.bills_tie);
check('read caps not hit', C.read_caps.status === 'ok', C.read_caps);
check('the year covered is said', /2026-04-01/.test(C.period.detail));
check('overall status is warn', out.status === 'warn');

const quiet = tallyCompleteness(Object.assign({}, book, { diagnostics: null }), E.prepare(book, { now: NOW }), { now: NOW });
check('no agent report: says so instead of guessing', quiet.checks.find((c) => c.key === 'agent_report').status === 'warn');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
