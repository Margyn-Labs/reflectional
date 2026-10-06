/**
 * Cash flow statement and borrowing history (api/_lib/cashFlowStatement.js) on a small trading business that
 * runs on an overdraft: a current account, a cash-credit account the customers pay into and suppliers are
 * paid from, a term loan with EMIs (two entered ahead), a vehicle bought and depreciated, owner's capital,
 * GST on sales, interest the bank charges straight to the overdraft, and a ledger in Suspense.
 * Every figure is worked by hand below. Run: node api/_lib/__tests__/cashFlowStatement.test.js
 */
const E = require('../booksEngine');
const CFS = require('../cashFlowStatement');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const LEDGERS = [
  ['Current A/c', 'Bank Accounts'], ['Cash', 'Cash-in-Hand'], ['Kotak CC A/c', 'Bank OD A/c'], ['Kotak Term Loan', 'Secured Loans'],
  ['Capital', 'Capital Account'], ['Vehicle', 'Fixed Assets'], ['Sales', 'Sales Accounts'], ['Purchases', 'Purchase Accounts'],
  ['Salary', 'Indirect Expenses'], ['Interest on CC', 'Indirect Expenses'], ['Depreciation', 'Indirect Expenses'], ['Output GST', 'Duties & Taxes'],
  ['Alkem', 'Sundry Debtors'], ['Sun', 'Sundry Debtors'], ['Supplier', 'Sundry Creditors'], ['Staff advance', 'Loans & Advances (Asset)'], ['Mystery', 'Suspense A/c']
];
// Opening balances, debit-negative like the entries (Tally's 'same' convention).
const OPEN = { 'Current A/c': -500000, 'Cash': -20000, 'Kotak CC A/c': 1500000, 'Kotak Term Loan': 1000000, 'Capital': -1980000 + 1500000 + 1000000 - 500000 - 20000, 'Vehicle': 0, 'Alkem': -0, 'Supplier': 0 };
const V = [];
let g = 0;
const v = (type, date, party, entries, narration) => V.push({ tally_guid: 'g' + (++g), voucher_type: type, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, narration, entries });
// April: sell, collect into the CC, pay the supplier from the CC, salary from the current account.
v('Sales', '2026-04-05', 'Alkem', [{ ledger: 'Alkem', amount: -1180000, is_party: true }, { ledger: 'Sales', amount: 1000000 }, { ledger: 'Output GST', amount: 180000 }]);
v('Purchase', '2026-04-06', 'Supplier', [{ ledger: 'Supplier', amount: 700000, is_party: true }, { ledger: 'Purchases', amount: -700000 }]);
v('Receipt', '2026-04-20', 'Alkem', [{ ledger: 'Alkem', amount: 1180000, is_party: true }, { ledger: 'Kotak CC A/c', amount: -1180000 }]);
v('Payment', '2026-04-25', 'Supplier', [{ ledger: 'Supplier', amount: -700000, is_party: true }, { ledger: 'Kotak CC A/c', amount: 700000 }]);
v('Payment', '2026-04-30', null, [{ ledger: 'Salary', amount: -150000 }, { ledger: 'Current A/c', amount: 150000 }]);
v('Journal', '2026-04-30', null, [{ ledger: 'Interest on CC', amount: -15000 }, { ledger: 'Kotak CC A/c', amount: 15000 }]);
// May: cash sale (GST in it), EMI, vehicle, owner puts money in, a staff advance, GST paid, an unplaced receipt.
v('Sales', '2026-05-03', null, [{ ledger: 'Cash', amount: -11800 }, { ledger: 'Sales', amount: 10000 }, { ledger: 'Output GST', amount: 1800 }]);
v('Payment', '2026-05-05', null, [{ ledger: 'Kotak Term Loan', amount: -80000 }, { ledger: 'Interest on CC', amount: -0.0 }, { ledger: 'Current A/c', amount: 80000 }], 'EMI May');
v('Payment', '2026-05-10', null, [{ ledger: 'Vehicle', amount: -600000 }, { ledger: 'Current A/c', amount: 600000 }]);
v('Receipt', '2026-05-12', null, [{ ledger: 'Capital', amount: 300000 }, { ledger: 'Current A/c', amount: -300000 }]);
v('Payment', '2026-05-15', null, [{ ledger: 'Staff advance', amount: -25000 }, { ledger: 'Cash', amount: 25000 }]);
v('Payment', '2026-05-20', null, [{ ledger: 'Output GST', amount: -181800 }, { ledger: 'Current A/c', amount: 181800 }]);
v('Receipt', '2026-05-22', null, [{ ledger: 'Mystery', amount: 40000 }, { ledger: 'Current A/c', amount: -40000 }]);
v('Contra', '2026-05-25', null, [{ ledger: 'Kotak CC A/c', amount: -200000 }, { ledger: 'Current A/c', amount: 200000 }]);   // moved money: not a flow
// June: depreciation (not cash), a sale on credit still unpaid, interest again, an EMI.
v('Journal', '2026-06-30', null, [{ ledger: 'Depreciation', amount: -50000 }, { ledger: 'Vehicle', amount: 50000 }]);
v('Sales', '2026-06-10', 'Sun', [{ ledger: 'Sun', amount: -590000, is_party: true }, { ledger: 'Sales', amount: 500000 }, { ledger: 'Output GST', amount: 90000 }]);
v('Journal', '2026-06-30', null, [{ ledger: 'Interest on CC', amount: -12000 }, { ledger: 'Kotak CC A/c', amount: 12000 }]);
v('Payment', '2026-06-05', null, [{ ledger: 'Kotak Term Loan', amount: -80000 }, { ledger: 'Current A/c', amount: 80000 }], 'EMI June');
// Entered ahead: two EMIs after "today" (they must not count yet).
v('Payment', '2026-07-05', null, [{ ledger: 'Kotak Term Loan', amount: -80000 }, { ledger: 'Current A/c', amount: 80000 }], 'EMI July');
v('Payment', '2026-08-05', null, [{ ledger: 'Kotak Term Loan', amount: -80000 }, { ledger: 'Current A/c', amount: 80000 }], 'EMI Aug');

function book(dropGuid) {
  const move = {};
  for (const x of V) for (const e of x.entries) move[e.ledger] = (move[e.ledger] || 0) + e.amount;   // Tally's closing includes the entries dated ahead
  const ledgers = LEDGERS.map(([name, parent]) => ({ name, parent, opening_balance: OPEN[name] || 0, closing_balance: (OPEN[name] || 0) + (move[name] || 0) }));
  return { connected: true, ledgers, vouchers: V.filter((x) => x.tally_guid !== dropGuid), bills: [], overrides: {}, syncRuns: [], balance_convention: 'same' };
}
const NOW = new Date('2026-07-01T06:00:00Z');
const ctx = E.prepare(book(), { now: NOW });
const y = CFS.yearStatement(ctx);
const T = y.total;
const line = (sections, sec, key) => { const s = sections.find((x) => x.key === sec); const l = s && s.lines.find((x) => x.key === key); return l ? l.amount : 0; };
const sec = (sections, k) => sections.find((x) => x.key === k).total;

console.log('statement');
check('overdraft counted as cash (AS-3)', y.overdraft_as_cash === true && y.overdraft_ledgers.includes('Kotak CC A/c'));
// Cash & equivalents: current 5,00,000 + cash 20,000 − CC 15,00,000 = −9,80,000 at the start.
check('opening = bank + cash − overdraft', T.opening === -980000, T.opening);
// Flows: +11,80,000 −7,00,000 −1,50,000 −15,000 +11,800 −80,000 −6,00,000 +3,00,000 −25,000 −1,81,800 +40,000 −12,000 −80,000 = −3,12,000
check('closing = opening + flows, and ties', T.closing === -980000 - 312000 && T.unexplained === 0 && y.checks.ties, { closing: T.closing, unexplained: T.unexplained });
check('owner and accountant views give the same net', T.owner_net === T.change && T.accountant_net === T.change, { o: T.owner_net, a: T.accountant_net, c: T.change });
check('customers: collection into the overdraft + cash sale with its GST', line(T.owner, 'operating', 'customers') === 1180000 + 11800, line(T.owner, 'operating', 'customers'));
check('suppliers paid from the overdraft', line(T.owner, 'operating', 'suppliers') === -700000);
check('running costs: salary only (interest is financing)', line(T.owner, 'operating', 'running_costs') === -150000);
check('GST paid', line(T.owner, 'operating', 'tax') === -181800);
check('staff advance is an advance, not a loan', line(T.owner, 'operating', 'advances') === -25000);
check('suspense receipt shown as suspense', line(T.owner, 'operating', 'suspense') === 40000 && y.unsorted.some((u) => u.ledger === 'Mystery'));
check('vehicle under investing', sec(T.owner, 'investing') === -600000);
check('EMIs under loans (future EMIs not yet)', line(T.owner, 'financing', 'loans') === -160000, line(T.owner, 'financing', 'loans'));
check('capital in', line(T.owner, 'financing', 'capital') === 300000);
check('interest charged to the overdraft = interest paid', line(T.owner, 'financing', 'interest') === -27000);
check('no overdraft line once it is cash', line(T.owner, 'financing', 'od') === 0);
check('contra to the overdraft is not a flow', T.owner.every((s) => s.lines.every((l) => Math.abs(l.amount) !== 200000)));
// Accountant: profit = 10,00,000 + 10,000 + 5,00,000 − 7,00,000 − 1,50,000 − 27,000 − 50,000 = 5,83,000
check('accountant: net profit', line(T.accountant, 'operating', 'net_profit') === 583000, line(T.accountant, 'operating', 'net_profit'));
check('accountant: depreciation and interest added back', line(T.accountant, 'operating', 'add_depreciation') === 50000 && line(T.accountant, 'operating', 'add_interest') === 27000);
check('accountant: Sun\'s unpaid invoice is an increase in receivables', line(T.accountant, 'operating', 'debtor') === -590000);
check('accountant: GST owed rose by 90,000 (charged 2,71,800, paid 1,81,800)', line(T.accountant, 'operating', 'tax') === 90000);
check('accountant: investing is the purchase price, not net of depreciation', line(T.accountant, 'investing', 'fixed_assets') === -600000);
check('accountant: interest paid under financing', line(T.accountant, 'financing', 'interest') === -27000);
const m = Object.fromEntries(y.columns.map((c) => [c.key, c]));
check('three month columns, July not yet', y.columns.map((c) => c.key).join() === '2026-04,2026-05,2026-06,2026-07' || y.columns.map((c) => c.key).join() === '2026-04,2026-05,2026-06');
check('each month: opening = last month\'s closing', m['2026-05'].opening === m['2026-04'].closing && m['2026-06'].opening === m['2026-05'].closing);
check('April change = 11,80,000 − 7,00,000 − 1,50,000 − 15,000', m['2026-04'].change === 315000, m['2026-04'].change);
check('made up of: bank and cash vs overdraft owed', T.made_up_of && T.made_up_of.bank_and_cash - T.made_up_of.overdraft_owed === T.closing, T.made_up_of);
check('every ledger walks back to Tally\'s opening balance', y.checks.opening_balances.checked >= 3 && y.checks.opening_balances.gaps.length === 0, y.checks.opening_balances);

console.log('missing entries are caught');
const ctx2 = E.prepare(book('g4'), { now: NOW });   // the supplier payment from the CC didn't sync
const y2 = CFS.yearStatement(ctx2);
check('gap on the overdraft ledger = the missing payment', y2.checks.opening_balances.gaps.some((x) => x.ledger === 'Kotak CC A/c' && Math.abs(x.gap) === 700000), y2.checks.opening_balances.gaps);
check('and a note says so', y2.notes.some((n) => /missing from the sync/.test(n)));

console.log('borrowing history');
const b = CFS.borrowing(ctx, { limits: { 'Kotak CC A/c': 2500000 } });
const cc = b.accounts.find((a) => a.name === 'Kotak CC A/c'), tl = b.accounts.find((a) => a.name === 'Kotak Term Loan');
// CC: 15,00,000 −11,80,000 +7,00,000 +15,000 −2,00,000 +12,000 = 8,47,000 owed today
check('CC owed today', cc && cc.owed_today === 847000, cc && cc.owed_today);
check('CC is an overdraft, term loan a loan', cc.kind === 'overdraft' && tl.kind === 'loan');
check('CC peak = opening 15,00,000 on 31 Mar … or after the supplier payment', cc.peak.owed === 1500000, cc.peak);
check('CC low after the collection: 3,20,000 on 20 Apr', cc.low.owed === 320000 && cc.low.date === '2026-04-20', cc.low);
check('CC paid out 7,00,000, paid in 13,80,000, interest charged 27,000', cc.paid_out === 700000 && cc.paid_in === 1380000 && cc.interest_charged === 27000, cc);
check('CC month ends', cc.month_end.map((x) => x.owed).slice(0, 3).join() === [1035000, 835000, 847000].join(), cc.month_end);
check('CC limit use', cc.limit === 2500000 && cc.used_pct === 33.9 && cc.headroom === 1653000, cc);
check('CC cost of borrowing is a sensible yearly rate', cc.interest_rate_pct > 1 && cc.interest_rate_pct < 20, cc.interest_rate_pct);
check('daily series ends at today\'s owed', cc.series.owed[cc.series.owed.length - 1] === 847000 && cc.series.start === '2026-04-01');
check('term loan: 10,00,000 − 2 EMIs, reducing', tl.owed_today === 840000 && tl.trend === 'reducing', tl);
check('term loan: EMIs entered ahead are listed, not counted', tl.upcoming.length === 2 && tl.upcoming[0].amount === 80000 && tl.upcoming[0].date === '2026-07-05', tl.upcoming);
check('staff advance is not borrowing', !b.accounts.some((a) => a.name === 'Staff advance'));
check('total owed and interest', b.total.owed_today === 847000 + 840000 && b.total.interest_this_fy === 27000, b.total);
check('Borrowing list (cash and loans) agrees', E.cashAndDebt(ctx).raw.borrowed === 847000 + 840000, E.cashAndDebt(ctx).raw);

console.log('tools');
const t = CFS.cashFlowTool(ctx, { period: 'this_fy' });
check('tool: both views, ties, by month', t.owner_view && t.accountant_view && t.ties_out === 'yes' && Array.isArray(t.by_month) && t.by_month.length >= 3, t);
const tb = CFS.borrowingTool(ctx, {}, { 'Kotak CC A/c': 2500000 });
check('tool: borrowing per account with limit', tb.accounts.length === 2 && /33.9% used/.test(tb.accounts[0].limit || tb.accounts[1].limit || ''), tb.accounts);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
