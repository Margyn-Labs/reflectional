/** Run: node api/_lib/__tests__/renamedInTally.test.js — zero-dep, no network.
 * A ledger renamed in Tally after Margyn read its entries (tallyAnalytics.renamedInTally). Shaped like Care
 * Hygiene, 12-13 Oct 2026: a payment of 3,965 entered against "CHAMUNDA PACKGING", the name then corrected to
 * "CHAMUNDA PACKAGING" and the bill booked on it. Tally's balance for the supplier is 0; Margyn's copy of the
 * payment still names the old ledger. */
const A = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''))); };
const NOW = '2026-10-14T06:00:00Z';
let g = 0;
const V = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0][1]), is_cancelled: false,
  entries: entries.map(([ledger, amount, is_party]) => ({ ledger, amount, is_party: !!is_party })) });
// Entries and balances in Tally's own signs (negative = debit), Apr to Oct 2026.
function book(extra) {
  g = 0;
  const vouchers = [];
  for (let m = 4; m <= 10; m++) {
    const mm = String(m).padStart(2, '0');
    vouchers.push(V('Sales', `2026${mm}05`, 'Alkem', [['Alkem', -112000, true], ['GST Sale', 100000], ['Output GST', 12000]]));
    vouchers.push(V('Receipt', `2026${mm}20`, 'Alkem', [['Alkem', 112000, true], ['Kotak Bank', -112000]]));
    vouchers.push(V('Purchase', `2026${mm}06`, 'Supplier A', [['Supplier A', 56000, true], ['Purchase GST', -50000], ['Input GST', -6000]]));
    vouchers.push(V('Payment', `2026${mm}22`, 'Supplier A', [['Supplier A', -56000, true], ['Kotak Bank', 56000]]));
    vouchers.push(V('Payment', `2026${mm}28`, null, [['Salary', -30000], ['Kotak Bank', 30000]]));
  }
  vouchers.push(...extra(V));
  // Tally's balances: the opening and closing that the entries (as Tally holds them now) produce.
  const mv = new Map();
  for (const v of vouchers) for (const e of v.entries) mv.set(e.ledger, (mv.get(e.ledger) || 0) + e.amount);
  const tallyNames = { 'CHAMUNDA PACKGING': 'CHAMUNDA PACKAGING' };   // the rename, as Tally now holds it
  const tally = new Map();
  for (const [k, a] of mv) { const n = tallyNames[k] || k; tally.set(n, (tally.get(n) || 0) + a); }
  const parent = { Alkem: 'Sundry Debtors', 'Supplier A': 'Sundry Creditors', 'CHAMUNDA PACKAGING': 'Sundry Creditors', 'Kotak Bank': 'Bank Accounts', 'GST Sale': 'Sales Accounts',
    'Purchase GST': 'Purchase Accounts', 'Packing @ 18%': 'Purchase Accounts', 'Output GST': 'Duties & Taxes', 'Input GST': 'Duties & Taxes', Salary: 'Indirect Expenses', 'Other Supplier': 'Sundry Creditors' };
  const opening = { 'Kotak Bank': -500000 };
  const ledgers = [...tally.entries()].map(([name, a]) => ({ name, parent: parent[name] || 'Indirect Expenses', opening_balance: opening[name] || 0, closing_balance: Math.round(((opening[name] || 0) + a) * 100) / 100 }));
  return { ledgers, vouchers };
}
const chamunda = (V) => [
  V('Payment', '20261012', 'CHAMUNDA PACKGING', [['CHAMUNDA PACKGING', -3965, true], ['Kotak Bank', 3965]]),
  V('Journal', '20261013', 'CHAMUNDA PACKAGING', [['Packing @ 18%', -3360], ['Input GST', -605], ['CHAMUNDA PACKAGING', 3965, true]])
];

// 1. The Care Hygiene case: the payment moves to the renamed ledger, and the supplier owes nothing.
{
  const b = book(chamunda);
  const t = A.asOfToday(b.ledgers, b.vouchers, NOW);
  check('the rename is found', t.renamed.length === 1 && t.renamed[0].from === 'CHAMUNDA PACKGING' && t.renamed[0].to === 'CHAMUNDA PACKAGING' && t.renamed[0].amount === 3965, t.renamed);
  const pay = t.vouchers.find((v) => v.voucher_type === 'Payment' && v.date === '20261012');
  check('the payment now names the new ledger', pay && pay.party_name === 'CHAMUNDA PACKAGING' && pay.entries[0].ledger === 'CHAMUNDA PACKAGING' && pay.entries[0].renamed_from === 'CHAMUNDA PACKGING', pay);
  check('the stored entries are not changed', b.vouchers.some((v) => v.party_name === 'CHAMUNDA PACKGING'));
  // The supplier view the app shows, built the way api/tally.js builds it (supplier ledgers, then each against its ledger).
  const E = require('../booksEngine'), CF = require('../cashFlowModel'), T = require('../billTieOut');
  const ctx = E.prepare({ connected: true, company: 'Care Hygiene', ledgers: b.ledgers, vouchers: b.vouchers, bills: [], overrides: {}, syncRuns: [] }, { now: NOW });
  const open = CF.supplierOpenItems(ctx).items;
  check('nothing is shown as owed to the renamed supplier', !open.some((x) => /CHAMUNDA/.test(x.party)), open);
  const sup = T.shownVsLedger(ctx, open).suppliers;
  check('the supplier check is exact for every supplier', sup.differ === 0, sup);
  const out = A.computeAnalytics({ ledgers: b.ledgers, vouchers: b.vouchers, bills: [], overrides: {}, now: NOW });
  check('the quality notes say so', (out.quality.renamed_in_tally || []).length === 1 && out.quality.reasons.some((r) => /renamed in Tally/.test(r)), out.quality.reasons);
}
// 2. Nothing renamed: nothing moves, and the same array comes back.
{
  const b = book(() => []);
  const t = A.asOfToday(b.ledgers, b.vouchers, NOW);
  check('no rename when every name is in the books', t.renamed.length === 0);
}
// 3. The old name's amount doesn't explain any ledger's gap: left as it is.
{
  const b = book(chamunda);
  b.ledgers.find((l) => l.name === 'CHAMUNDA PACKAGING').closing_balance += 1000;   // Tally's balance not explained by the move
  const t = A.asOfToday(b.ledgers, b.vouchers, NOW);
  check('no rename without proof from the balances', t.renamed.length === 0, t.renamed);
}
// 4. A small amount and a different name: an equal gap could be chance, so nothing moves.
{
  const b = book((V) => [
    V('Payment', '20261012', 'ZXQ OLD NAME', [['ZXQ OLD NAME', -472, true], ['Kotak Bank', 472]]),
    V('Journal', '20261013', 'Other Supplier', [['Packing @ 18%', -472], ['Other Supplier', 472, true]])
  ]);
  b.ledgers = b.ledgers.filter((l) => l.name !== 'ZXQ OLD NAME');
  b.ledgers.find((l) => l.name === 'Other Supplier').closing_balance = 0;
  const t = A.asOfToday(b.ledgers, b.vouchers, NOW);
  check('small amount, unrelated name: left alone', t.renamed.length === 0, t.renamed);
}
// 5. Two ledgers out by the same amount, neither name similar: ambiguous, nothing moves.
{
  const b = book((V) => [
    V('Payment', '20261012', 'TOTALLY DIFFERENT', [['TOTALLY DIFFERENT', -5000, true], ['Kotak Bank', 5000]]),
    V('Journal', '20261013', 'Other Supplier', [['Packing @ 18%', -5000], ['Other Supplier', 5000, true]]),
    V('Journal', '20261013', 'Supplier A', [['Packing @ 18%', -5000], ['Supplier A', 5000, true]])
  ]);
  b.ledgers = b.ledgers.filter((l) => l.name !== 'TOTALLY DIFFERENT');
  b.ledgers.find((l) => l.name === 'Other Supplier').closing_balance -= 5000;
  b.ledgers.find((l) => l.name === 'Supplier A').closing_balance -= 5000;
  const t = A.asOfToday(b.ledgers, b.vouchers, NOW);
  check('two equal gaps: left alone', t.renamed.length === 0, t.renamed);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
