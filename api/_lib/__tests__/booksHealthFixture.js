/**
 * A Care Hygiene-shaped book for the books health check (booksHealth.test.js, tools/ui-books-health-test.js):
 * every problem the 4 Oct 2026 audit found by hand, in the shapes it was found.
 */
const NOW = new Date('2026-10-07T06:00:00Z');
// Debit-positive balances (the engine's default reading).
let g = 0;
const v = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: 'V' + g, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
const pay = (date, ledger, amt) => v('Payment', date, null, [{ ledger, amount: -amt }, { ledger: 'Kotak Bank', amount: amt }]);
const V = [];
const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
for (const m of months) {
  V.push(v('Sales', m + '-05', 'Agastya Corporation', [{ ledger: 'Agastya Corporation', amount: -5000000, is_party: true }, { ledger: 'Sales', amount: 5000000 }]));
  V.push(v('Receipt', m + '-20', 'Agastya Corporation', [{ ledger: 'Agastya Corporation', amount: 5000000, is_party: true }, { ledger: 'Kotak Bank', amount: -5000000 }]));
  // Usual running costs ₹41.8 L a month; September only ₹2.66 L (not booked yet).
  if (m !== '2026-09') { V.push(pay(m + '-28', 'Salaries', 3000000)); V.push(pay(m + '-28', 'Rent', 1180000)); }
  else V.push(pay(m + '-28', 'Rent', 266000));
  V.push(pay(m + '-10', 'INTEREST ON OD', 90500));                 // 6 × 90,500 = ₹5.43 L paid, filed under income
  V.push(pay(m + '-12', 'TRANSPORT/COURIER EXPENSES', 20000));     // spent, filed under Sales Accounts
  V.push(v('Receipt', m + '-15', null, [{ ledger: 'INTEREST ON FD', amount: 3000 }, { ledger: 'Kotak Bank', amount: -3000 }]));   // real interest earned
  V.push(v('Receipt', m + '-16', null, [{ ledger: 'FREIGHT COLLECTED', amount: 5000 }, { ledger: 'Kotak Bank', amount: -5000 }])); // charged to customers
}
// Partner remuneration journaled out of Cash: Cash in hand goes to −₹41,091.
V.push(v('Journal', '2026-08-31', null, [{ ledger: 'PARTNER REMUNERATION', amount: -51091 }, { ledger: 'Cash', amount: 51091 }]));
// Recent purchases from suppliers Tally doesn't keep bill by bill.
V.push(v('Purchase', '2026-09-25', 'Supplier A', [{ ledger: 'Supplier A', amount: 400000, is_party: true }, { ledger: 'Purchase', amount: -400000 }]));
V.push(v('Purchase', '2026-09-26', 'Supplier B', [{ ledger: 'Supplier B', amount: 300000, is_party: true }, { ledger: 'Purchase', amount: -300000 }]));
// Loan EMIs entered ahead (Oct–Mar), two of them dated after today.
const emi = (date) => Object.assign(v('Payment', date, null, [{ ledger: 'Kotak Loan', amount: -67000 }, { ledger: 'Interest on Loan', amount: -90573 }, { ledger: 'Kotak Bank', amount: 157573 }]), { amount: 157573, narration: 'Kotak loan EMI' });
V.push(emi('2026-11-05'), emi('2026-12-05'));

const L = [
  { name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: -30000000 },
  { name: 'Purchase', parent: 'Purchase Accounts', opening_balance: 0, closing_balance: 700000 },
  { name: 'Salaries', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: 15000000 },
  { name: 'Rent', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: 6166000 },
  { name: 'PARTNER REMUNERATION', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: 51091 },
  { name: 'INTEREST ON OD', parent: 'Indirect Incomes', opening_balance: 0, closing_balance: 543000 },
  { name: 'INTEREST ON FD', parent: 'Indirect Incomes', opening_balance: 0, closing_balance: -18000 },
  { name: 'FREIGHT COLLECTED', parent: 'Indirect Incomes', opening_balance: 0, closing_balance: -30000 },
  { name: 'TRANSPORT/COURIER EXPENSES', parent: 'Sales Accounts', opening_balance: 0, closing_balance: 120000 },
  { name: 'TRANSPORT/ COURIER EXPENSES', parent: 'Sales Accounts', opening_balance: 0, closing_balance: null },   // unused this year
  { name: 'FREIGHT ON SALES', parent: 'Sales Accounts', opening_balance: 0, closing_balance: null },
  { name: 'Interest on Loan', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: 181146 },
  { name: 'Cash', parent: 'Cash-in-Hand', opening_balance: 10000, closing_balance: null },
  { name: 'Kotak Bank', parent: 'Bank Accounts', opening_balance: 2000000, closing_balance: null },
  { name: 'Kotak Loan', parent: 'Secured Loans', opening_balance: -11828670, closing_balance: null },
  // Suppliers: credit balances are negative here. Sanjay Plastics: ₹11.5k left by the ledger, 7 bills open (₹14 L).
  { name: 'Sanjay Plastics', parent: 'Sundry Creditors', opening_balance: -1411500, closing_balance: -11500 },
  { name: 'Royal International', parent: 'Sundry Creditors', opening_balance: -910000, closing_balance: 0 },
  { name: 'Supplier A', parent: 'Sundry Creditors', opening_balance: 0, closing_balance: -400000 },
  { name: 'Supplier B', parent: 'Sundry Creditors', opening_balance: 0, closing_balance: -300000 },
  // Customers: S.S.D Surgical ₹9.79 L of bills against a ledger of ₹12; Agastya owes ₹13.55 L with no bill; Glenmark 1,327 days.
  { name: 'S.S.D SURGICAL', parent: 'Sundry Debtors', opening_balance: 979000, closing_balance: 12 },
  { name: 'Agastya Corporation', parent: 'Sundry Debtors', opening_balance: 1355000, closing_balance: 1355000 },
  { name: 'GLENMARK PHARMACEUTICALS LTD', parent: 'Sundry Debtors', opening_balance: 250000, closing_balance: 250000 }
];
const bill = (direction, party, ref, date, amt, late) => ({ direction, party_name: party, bill_ref: ref, bill_date: date, due_date: date, closing_balance: amt, overdue_days: late });
const B = [
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => bill('payable', 'Sanjay Plastics', 'SP' + i, i === 0 ? '2025-08-01' : '2026-0' + (i + 1) + '-01', 200000, i === 0 ? 432 : 100)),
  bill('payable', 'Royal International', 'RI1', '2026-03-01', 500000, 220), bill('payable', 'Royal International', 'RI2', '2026-04-01', 410000, 189),
  bill('receivable', 'S.S.D SURGICAL', 'S1', '2026-02-01', 500000, 248), bill('receivable', 'S.S.D SURGICAL', 'S2', '2026-03-01', 479000, 220),
  bill('receivable', 'GLENMARK PHARMACEUTICALS LTD', 'G1', '2023-02-18', 250000, 1327)
];
const book = { connected: true, company: 'Care Hygiene Products', ledgers: L, vouchers: V, bills: B, overrides: {}, syncRuns: [] };

module.exports = { book, NOW, L, V, B, v, pay };
