/**
 * Bills that point the wrong way (api/_lib/billTieOut.js rescueMisSigned), 2026-10-11.
 * A small company's real invoice used to be set aside as an "advance" and rebuilt from the voucher (voucher number
 * as its reference, invoice date as its due date). Stress test over company sizes and both ways Tally can sign
 * amounts: real bills keep their reference and due date, totals tie to the ledgers, overpayments are never owed,
 * and a company that already reads correctly is not changed at all.
 * Zero-dep. Run: node api/_lib/__tests__/billSigns.test.js
 */
const E = require('../booksEngine');
const BT = require('../billTieOut');
const NOW = new Date('2026-10-11T06:00:00Z');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };

let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
let g = 0;
const vch = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
const day = (n) => new Date(Date.UTC(2026, 9, 11) - n * 86400000).toISOString().slice(0, 10);

/**
 * opts: nCust, nSup, billSign: 'recvPositive' | 'recvNegative' (how the AGENT labels customer bills by sign),
 *       ledgerSign: 'debitPositive' | 'debitNegative' (how ledger balances are signed),
 *       advances: number of customers who overpaid (credit balance, opposite-signed bill)
 */
function build(o) {
  g = 0; const ledgers = [], vouchers = [], bills = [], truth = { custBills: [], supBills: [], advCust: [] };
  const dp = o.ledgerSign === 'debitPositive';
  const ledg = (name, parent, dr) => ({ name, parent, opening_balance: 0, closing_balance: dp ? dr : -dr });   // dr = debit-positive value
  // P&L ledgers so the engine can learn the ledger sign from evidence, as it does on real books
  for (let i = 0; i < 3; i++) {
    const amt = 100000 * (i + 1);
    vouchers.push(vch('Sales', day(40 + i), 'Cash Cust', [{ ledger: 'Cash Cust', amount: -amt, is_party: true }, { ledger: 'Sales' + i, amount: amt }]));
    ledgers.push(ledg('Sales' + i, 'Sales Accounts', -amt));
  }
  ledgers.push(ledg('Cash Cust', 'Sundry Debtors', 0));
  const billRec = (party, ref, bd, due, amt, recv) => {
    // the agent labels by sign: recvPositive => +ve receivable; recvNegative => -ve receivable (so a receivable bill is negative and gets labelled 'payable')
    const raw = o.billSign === 'recvPositive' ? (recv ? amt : -amt) : (recv ? -amt : amt);
    return { direction: raw > 0 ? 'receivable' : 'payable', party_name: party, bill_ref: ref, bill_date: bd, due_date: due, closing_balance: raw, overdue_days: null };
  };
  for (let c = 0; c < o.nCust; c++) {
    const name = 'Cust' + c, isAdv = c < (o.advances || 0);
    if (isAdv) {   // overpaid: owes nothing, has credit. Tally lists an on-account (opposite-signed) bill.
      const amt = 5000 + Math.round(rnd() * 20000);
      vouchers.push(vch('Receipt', day(10), name, [{ ledger: name, amount: amt, is_party: true }, { ledger: 'Bank', amount: -amt }]));
      ledgers.push(ledg(name, 'Sundry Debtors', -amt));
      bills.push(billRec(name, 'ONACC-' + c, day(10), null, amt, false));
      truth.advCust.push(name); continue;
    }
    const nb = o.maxBills ? o.maxBills : 1 + Math.floor(rnd() * 3); let owed = 0;
    for (let k = 0; k < nb; k++) {
      const amt = 1000 + Math.round(rnd() * 90000), age = 5 + Math.floor(rnd() * 80), cr = [0, 15, 30, 45][Math.floor(rnd() * 4)];
      const ref = `C${c}-INV${k}`;
      vouchers.push(vch('Sales', day(age), name, [{ ledger: name, amount: -amt, is_party: true }, { ledger: 'Sales0', amount: amt }]));
      const due = new Date(Date.parse(day(age)) + cr * 86400000).toISOString().slice(0, 10);
      bills.push(billRec(name, ref, day(age), due, amt, true));
      truth.custBills.push({ party: name, ref, due, amt }); owed += amt;
    }
    ledgers.push(ledg(name, 'Sundry Debtors', owed));
  }
  for (let s = 0; s < o.nSup; s++) {
    const name = 'Sup' + s, amt = 2000 + Math.round(rnd() * 50000), age = 5 + Math.floor(rnd() * 60), ref = `S${s}-B0`;
    vouchers.push(vch('Purchase', day(age), name, [{ ledger: name, amount: amt, is_party: true }, { ledger: 'Purchases', amount: -amt }]));
    ledgers.push(ledg(name, 'Sundry Creditors', -amt));
    bills.push(billRec(name, ref, day(age), day(age - 30), amt, false));
    truth.supBills.push({ party: name, ref, amt });
  }
  ledgers.push(ledg('Bank', 'Bank Accounts', 100000));
  return { book: { connected: true, company: 'Sim', ledgers, vouchers, bills, overrides: {}, syncRuns: [] }, truth };
}


function evaluate(o, noRescue) {
  const { book, truth } = build(o);
  const orig = BT.rescueMisSigned;
  if (noRescue) BT.rescueMisSigned = (ctx) => ({ bills: ctx.bills, rescued: 0 });
  const ctx = E.prepare(book, { now: NOW });
  BT.rescueMisSigned = orig;
  const recv = ctx.bills.filter((b) => b.direction !== 'payable' && !b.advance);
  const pay = ctx.bills.filter((b) => b.direction === 'payable' && !b.advance);
  const keep = truth.custBills.filter((t) => recv.some((b) => b.party_name === t.party && b.bill_ref === t.ref && String(b.due_date).slice(0, 10) === t.due && !b.from_entries)).length;
  const owedTotal = truth.custBills.reduce((s, t) => s + t.amt, 0), recvTotal = recv.reduce((s, b) => s + Math.abs(b.closing_balance), 0);
  return { ctx, want: truth.custBills.length, keep, totalOk: Math.abs(recvTotal - owedTotal) <= Math.max(1, owedTotal * 0.01),
    advWrong: truth.advCust.filter((n) => recv.some((b) => b.party_name === n)).length,
    supKeep: truth.supBills.filter((t) => pay.some((b) => b.party_name === t.party && b.bill_ref === t.ref)).length, supN: truth.supBills.length };
}

// 1. Small companies, one bill each, every way Tally can sign: every real bill kept, totals right.
let tinyOk = true, tinyDetail = null;
for (const billSign of ['recvPositive', 'recvNegative']) for (const ledgerSign of ['debitPositive', 'debitNegative']) for (const [c, s] of [[1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [1, 2]]) {
  const r = evaluate({ nCust: c, nSup: s, maxBills: 1, billSign, ledgerSign, advances: 0 });
  if (r.keep !== r.want || !r.totalOk || r.supKeep !== r.supN) { tinyOk = false; tinyDetail = { billSign, ledgerSign, c, s, keep: r.keep, want: r.want, sup: r.supKeep + '/' + r.supN }; }
}
check('small companies (1-3 customers, 1 bill each): every real bill keeps its reference and due date, both sign conventions', tinyOk, tinyDetail);

// 2. Mid and large companies, with overpayments: nothing lost, overpayments never shown as owed.
let bigOk = true, bigDetail = null;
for (const billSign of ['recvPositive', 'recvNegative']) for (const ledgerSign of ['debitPositive', 'debitNegative']) for (const n of [3, 5, 10, 50, 200]) {
  const r = evaluate({ nCust: n, nSup: Math.max(1, Math.round(n / 3)), billSign, ledgerSign, advances: n >= 10 ? Math.round(n / 10) : 0 });
  if (r.keep !== r.want || !r.totalOk || r.advWrong || r.supKeep !== r.supN) { bigOk = false; bigDetail = { billSign, ledgerSign, n, keep: r.keep + '/' + r.want, adv: r.advWrong, sup: r.supKeep + '/' + r.supN }; }
}
check('3 to 200 customers, with overpayments, both conventions: all bills kept, totals tie, overpayments never owed', bigOk, bigDetail);

// 3. A company that already reads correctly is not changed by the rescue at all (same company, run both ways).
let same = true, turned = 0;
for (const billSign of ['recvPositive', 'recvNegative']) for (const ledgerSign of ['debitPositive', 'debitNegative']) for (const n of [10, 50, 200]) for (const adv of [0, Math.round(n / 5)]) {
  const { book } = build({ nCust: n, nSup: Math.round(n / 3), billSign, ledgerSign, advances: adv });
  const a = E.prepare(book, { now: NOW });
  const orig = BT.rescueMisSigned; BT.rescueMisSigned = (ctx) => ({ bills: ctx.bills, rescued: 0 });
  const b = E.prepare(book, { now: NOW }); BT.rescueMisSigned = orig;
  turned += a.billsTurned || 0;
  if (JSON.stringify(a.bills) !== JSON.stringify(b.bills) || JSON.stringify(a.billsAsInTally) !== JSON.stringify(b.billsAsInTally)) same = false;
}
check('companies with 10-200 customers: output identical with and without the rescue, no bill turned round', same && turned === 0, { same, turned });

// 4. Overpayments outweigh the one normal bill: the old vote flipped every sign; the customer\'s own balance now settles it.
const v = (g, type, date, party, entries) => ({ tally_guid: g, voucher_type: type, voucher_number: g, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
const book = { connected: true, company: 'T', overrides: {}, syncRuns: [],
  ledgers: [ { name: 'Normal', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 10000 }, { name: 'PaidAhead1', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: -50000 }, { name: 'PaidAhead2', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: -50000 }, { name: 'Sales', parent: 'Sales Accounts', opening_balance: 0, closing_balance: -10000 }, { name: 'Bank', parent: 'Bank Accounts', opening_balance: 0, closing_balance: 90000 } ],
  vouchers: [ v('a', 'Sales', '2026-09-01', 'Normal', [{ ledger: 'Normal', amount: -10000, is_party: true }, { ledger: 'Sales', amount: 10000 }]),
              v('b', 'Receipt', '2026-09-05', 'PaidAhead1', [{ ledger: 'PaidAhead1', amount: 50000, is_party: true }, { ledger: 'Bank', amount: -50000 }]),
              v('c', 'Receipt', '2026-09-06', 'PaidAhead2', [{ ledger: 'PaidAhead2', amount: 50000, is_party: true }, { ledger: 'Bank', amount: -50000 }]) ],
  bills: [ { direction: 'receivable', party_name: 'Normal', bill_ref: 'INV-1', bill_date: '2026-09-01', due_date: '2026-10-01', closing_balance: 10000 },
           { direction: 'payable', party_name: 'PaidAhead1', bill_ref: 'ONACC1', bill_date: '2026-09-05', due_date: null, closing_balance: -50000 },
           { direction: 'payable', party_name: 'PaidAhead2', bill_ref: 'ONACC2', bill_date: '2026-09-06', due_date: null, closing_balance: -50000 } ] };
const ctx = E.prepare(book, { now: NOW });
const rows = ctx.bills.filter((b) => b.direction !== 'payable' && !b.advance);
check('overpayments outweigh the normal bill: the real invoice INV-1 is kept (not rebuilt from the voucher)', rows.length === 1 && rows[0].bill_ref === 'INV-1' && !rows[0].from_entries && String(rows[0].due_date).slice(0, 10) === '2026-10-01', rows);

// 5. The demo case: one customer, one bill labelled the wrong way round, due 8 Oct, invoice dated 2 Oct.
const demo = { connected: true, company: 'Demo', overrides: {}, syncRuns: [],
  ledgers: [ { name: 'Chase Test Co.', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: 5000 }, { name: 'Sales Account', parent: 'Sales Accounts', opening_balance: 0, closing_balance: -5000 } ],
  vouchers: [ v('d', 'Sales', '2026-10-02', 'Chase Test Co.', [{ ledger: 'Chase Test Co.', amount: -5000, is_party: true }, { ledger: 'Sales Account', amount: 5000 }]) ],
  bills: [ { direction: 'payable', party_name: 'Chase Test Co.', bill_ref: 'TEST-001', bill_date: '2026-10-02', due_date: '2026-10-08', closing_balance: -5000 } ] };
const dctx = E.prepare(demo, { now: NOW });
const drows = dctx.bills.filter((b) => b.direction !== 'payable' && !b.advance);
check('demo case: TEST-001, due 8 Oct, 3 days overdue on 11 Oct (not "2", 9 days)', drows.length === 1 && drows[0].bill_ref === 'TEST-001' && String(drows[0].due_date).slice(0, 10) === '2026-10-08' && drows[0].overdue_days === 3 && !drows[0].from_entries, drows);

// 6. A genuinely overpaid customer is never turned into a receivable.
const adv = JSON.parse(JSON.stringify(demo)); adv.ledgers[0].closing_balance = -5000; adv.vouchers = [ v('e', 'Receipt', '2026-10-02', 'Chase Test Co.', [{ ledger: 'Chase Test Co.', amount: 5000, is_party: true }, { ledger: 'Sales Account', amount: -5000 }]) ]; adv.bills[0].bill_ref = 'ONACC';
const actx = E.prepare(adv, { now: NOW });
check('a customer in credit (overpaid) stays out of receivables', actx.bills.filter((b) => b.direction !== 'payable' && !b.advance).length === 0, actx.bills);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
