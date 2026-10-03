/** Run: node api/_lib/__tests__/tallyBills.test.js — days late as of today, advances, India date. */
const B = require('../tallyBills');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };

console.log('india date');
check('00:30 IST on 4 Oct is 4 Oct, not 3 Oct', new Date(B.todayIstMs('2026-10-03T19:00:00Z')).toISOString().slice(0, 10) === '2026-10-04');
check('20:00 IST on 3 Oct is 3 Oct', new Date(B.todayIstMs('2026-10-03T14:30:00Z')).toISOString().slice(0, 10) === '2026-10-03');

console.log('days late keep counting after the last sync');
const now = '2026-10-04T06:00:00Z';
check('from the due date', B.liveOverdueDays({ due_date: '20260917', overdue_days: 14 }, now) === 17);
check('ISO due date', B.liveOverdueDays({ due_date: '2026-09-17' }, now) === 17);
check('not yet due is 0', B.liveOverdueDays({ due_date: '20261020', overdue_days: 0 }, now) === 0);
check('no due date keeps what the agent said', B.liveOverdueDays({ overdue_days: 9 }, now) === 9);

console.log('advances');
const vouchers = [
  { voucher_type: 'Sales', party_name: 'Dr Reddys' }, { voucher_type: 'Sales', party_name: 'Dr Reddys' },
  { voucher_type: 'Purchase', party_name: 'Sanjay Plastics' }, { voucher_type: 'Purchase', party_name: 'Sanjay Plastics' },
  { voucher_type: 'Sales', party_name: 'Alkem' }, { voucher_type: 'Sales', party_name: 'Alkem' }
];
const bills = [
  { direction: 'receivable', party_name: 'Alkem', closing_balance: 500000, due_date: '20260920' },
  { direction: 'receivable', party_name: 'Dr Reddys', closing_balance: 100000, due_date: '20260901' },
  { direction: 'payable', party_name: 'Dr Reddys', closing_balance: -196000 },
  { direction: 'payable', party_name: 'Sanjay Plastics', closing_balance: -1400000, due_date: '20250801' }
];
const out = B.calibrateBills(bills, vouchers, { now }).bills;
check('a customer\'s credit on the vendor side is an advance', out[2].advance === true);
check('a real supplier bill is not', out[3].advance === false);
check('a customer bill is not', out[0].advance === false && out[0].overdue_days === 14, out[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
