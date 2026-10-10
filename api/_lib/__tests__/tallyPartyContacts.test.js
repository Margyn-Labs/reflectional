// Tally party contacts -> party master, and Chase over every receivables source (2026-10-08).
// Run: node api/_lib/__tests__/tallyPartyContacts.test.js
const assert = require('assert');
const { planPartyWrites, bestPhone, cleanContact, indianMobile } = require('../tallyParties');
const chase = require('../chaseEngine');
const { position } = require('../moneyModel');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok  -', name); };

t('mobile numbers normalise to +91', () => {
  assert.strictEqual(indianMobile('98200 12345'), '+919820012345');
  assert.strictEqual(indianMobile('+91-98200-12345'), '+919820012345');
  assert.strictEqual(indianMobile('09820012345'), '+919820012345');
  assert.strictEqual(indianMobile('022-2650 1100'), null);
});

t('mobile beats landline; a list of numbers yields the first mobile', () => {
  assert.strictEqual(bestPhone({ phone: '022-2650 1100', mobile: '98200 12345' }), '+919820012345');
  assert.strictEqual(bestPhone({ phone: '022 2650 1100, 99300 54321' }), '+919930054321');
  assert.strictEqual(bestPhone({ phone: '022-2650 1100' }), '022-2650 1100');
});

t('bad GSTIN / PAN / email are dropped, not stored', () => {
  const c = cleanContact({ gstin: 'not a gstin', pan: 'x', email: 'nope', mobile: ' 98200 12345 ' });
  assert.deepStrictEqual(c, { mobile: '98200 12345' });
  assert.strictEqual(cleanContact({}), null);
});

const L = (o) => Object.assign({ tally_guid: 'g-' + o.name, primary_group: 'Sundry Debtors' }, o);

t('new customer with a phone is created as source=tally', () => {
  const { inserts, updates } = planPartyWrites([L({ name: 'Acme Retail', contact: { mobile: '9820012345', gstin: '27AABCA1234A1Z5' } })], [], 'u1');
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].phone, '+919820012345');
  assert.strictEqual(inserts[0].type, 'customer');
  assert.strictEqual(inserts[0].source, 'tally');
  assert.strictEqual(inserts[0].pan, 'AABCA1234A');
  assert.deepStrictEqual(inserts[0].external_refs, { tally_guid: 'g-Acme Retail' });
});

t('a number the owner typed is never overwritten; blanks are filled', () => {
  const existing = [{ id: 'p1', name: 'ACME RETAIL PVT LTD', type: 'customer', phone: '+919999999999', email: '', external_refs: {} }];
  const { inserts, updates } = planPartyWrites([L({ name: 'Acme Retail', contact: { mobile: '9820012345', email: 'a@acme.in' } })], existing, 'u1');
  assert.strictEqual(inserts.length, 0);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].patch.phone, undefined);
  assert.strictEqual(updates[0].patch.email, 'a@acme.in');
  assert.strictEqual(updates[0].patch.external_refs.tally_guid, 'g-Acme Retail');
});

t('expense/bank ledgers and parties with no phone/email are not created', () => {
  const { inserts } = planPartyWrites([
    L({ name: 'Electricity', primary_group: 'Indirect Expenses', contact: { mobile: '9820012345' } }),
    L({ name: 'Quiet Co', contact: { gstin: '27AABCA1234A1Z5' } })
  ], [], 'u1');
  assert.strictEqual(inserts.length, 0);
});

t('a supplier already saved as a customer becomes both', () => {
  const existing = [{ id: 'p1', name: 'Verma Supplies', type: 'customer', phone: '+919930054321', external_refs: { tally_guid: 'g-Verma Supplies' } }];
  const { updates } = planPartyWrites([L({ name: 'Verma Supplies', primary_group: 'Sundry Creditors', contact: { mobile: '9930054321' } })], existing, 'u1');
  assert.strictEqual(updates[0].patch.type, 'both');
});

// ---- Chase over the reconciled position ----
const today = '2026-10-08';
const rows = [
  { id: 'm-1', party: 'Small Shop', amount: 5000, due: '2026-09-20', ref: null, src: 'manual' },
  { party: 'Acme Retail', amount: 100000, due: '2026-08-01', ref: 'INV-7', src: 'tally' },
  { party: 'Acme Retail', amount: 50000, due: '2026-09-01', ref: 'INV-9', src: 'tally' },
  { party: 'Acme Retail', amount: 25000, due: '2026-10-01', ref: '(unspecified)', src: 'tally' },
  { id: 'm-2', party: 'ACME RETAIL PVT LTD', amount: 150000, due: '2026-08-01', ref: null, src: 'manual' }
];

t('one chase per connector customer, manual entries stay per entry', () => {
  const { groups } = position(rows, today, { withRows: true });
  const { items, openIds } = chase.chaseItemsFromPosition(groups);
  assert.strictEqual(items.length, 2);
  const acme = items.find((i) => i.src === 'tally');
  assert.strictEqual(acme.amount, 175000);
  assert.strictEqual(acme.due, '2026-08-01');
  assert.strictEqual(acme.ref, 'INV-7 + 2 more');
  assert.strictEqual(acme.receivable_id, chase.stableChaseId('tally', acme.key));
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(acme.receivable_id), 'uuid-shaped');
  assert.ok(items.some((i) => i.receivable_id === 'm-1'));
  assert.ok(openIds.has('m-2'), 'a manual entry under a Tally customer is still open, not "paid"');
});

t('the same customer maps to the same chase every day', () => {
  const a = chase.chaseItemsFromPosition(position(rows, today, { withRows: true }).groups).items.find((i) => i.src === 'tally');
  const b = chase.chaseItemsFromPosition(position(rows.slice(1, 3), today, { withRows: true }).groups).items.find((i) => i.src === 'tally');
  assert.strictEqual(a.receivable_id, b.receivable_id);
});

console.log(`\n${passed} passed, 0 failed`);
