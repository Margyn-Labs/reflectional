/**
 * Customers' bills lined up with their ledger balances (api/_lib/billTieOut.js).
 * Zero-dep. Run: node api/_lib/__tests__/billTieOut.test.js
 */
const E = require('../booksEngine');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };
const NOW = new Date('2026-10-04T06:00:00Z');

let g = 0;
const v = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: 'V' + g, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
const sale = (date, party, amt) => v('Sales', date, party, [{ ledger: party, amount: -amt, is_party: true }, { ledger: 'Sales', amount: amt }]);
const receipt = (date, party, amt) => v('Receipt', date, party, [{ ledger: party, amount: amt, is_party: true }, { ledger: 'Bank', amount: -amt }]);
const V = [
  sale('2026-06-01', 'Agree', 30000), sale('2026-08-01', 'Agree', 20000), receipt('2026-07-01', 'Agree', 30000),     // owes 20,000
  sale('2026-05-01', 'Stale', 40000), sale('2026-07-15', 'Stale', 25000), receipt('2026-08-20', 'Stale', 65000),     // owes 0
  sale('2026-08-05', 'Unbilled', 10000), sale('2026-09-12', 'Unbilled', 15000),                                        // owes 25,000
  sale('2026-04-10', 'PartPaid', 50000), sale('2026-09-01', 'PartPaid', 30000), receipt('2026-09-15', 'PartPaid', 60000) // owes 20,000
];
// Debit-positive balances (the engine's default reading).
const L = [
  { name: 'Agree', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 20000 },
  { name: 'Stale', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: null },
  { name: 'Unbilled', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 25000 },
  { name: 'PartPaid', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 20000 },
  { name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: -190000 },
  { name: 'Bank', parent: 'Bank Accounts', opening_balance: 0, closing_balance: 155000 }
];
const B = [
  { direction: 'receivable', party_name: 'Agree', bill_ref: 'A2', bill_date: '2026-08-01', due_date: '2026-08-31', closing_balance: 20000, overdue_days: 34 },
  { direction: 'receivable', party_name: 'Stale', bill_ref: 'S1', bill_date: '2026-05-01', due_date: '2026-05-31', closing_balance: 40000, overdue_days: 126 },
  { direction: 'receivable', party_name: 'PartPaid', bill_ref: 'P1', bill_date: '2026-04-10', due_date: '2026-05-10', closing_balance: 50000, overdue_days: 147 },
  { direction: 'receivable', party_name: 'PartPaid', bill_ref: 'P2', bill_date: '2026-09-01', due_date: '2026-10-01', closing_balance: 30000, overdue_days: 3 }
];
const book = { connected: true, company: 'Test Co', ledgers: L, vouchers: V, bills: B, overrides: {}, syncRuns: [] };
const ctx = E.prepare(book, { now: NOW });
const recv = (p) => ctx.bills.filter((b) => b.direction !== 'payable' && !b.advance && b.party_name === p);
const sum = (xs) => xs.reduce((a, b) => a + Math.abs(b.closing_balance), 0);

check('bills that agree with the ledger are untouched', recv('Agree').length === 1 && recv('Agree')[0].bill_ref === 'A2' && !recv('Agree')[0].from_entries, recv('Agree'));
check('a customer whose ledger says nothing is owed: stale bills set aside', recv('Stale').length === 0, recv('Stale'));
check('owed but not in bills: added from the entries, newest first', sum(recv('Unbilled')) === 25000 && recv('Unbilled').every((b) => b.from_entries) && recv('Unbilled').some((b) => b.bill_date === '2026-09-12'), recv('Unbilled'));
check('more billed than owed: the oldest bill goes, the newest stays (partly paid)', sum(recv('PartPaid')) === 20000 && recv('PartPaid').length === 1 && recv('PartPaid')[0].bill_ref === 'P2' && recv('PartPaid')[0].part_paid, recv('PartPaid'));
check('summary says what moved', ctx.billTie.trimmed.parties === 2 && ctx.billTie.trimmed.amount === 100000 && ctx.billTie.added.parties === 1 && ctx.billTie.added.amount === 25000 && ctx.billTie.tied === 1, ctx.billTie);
check('Tally\'s own list is kept for comparison', ctx.billsAsInTally.length === 4);
const owed = E.moneyOwed(ctx, { direction: 'receivable' });
check('Margyn\'s answer on what customers owe = the ledgers (65,000)', owed.total === E.inr(65000), owed.total);
const off = E.prepare(book, { now: NOW, tieBills: false });
check('tieBills:false leaves Tally\'s bills as they are', off.bills.length === 4 && !off.billTie);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
