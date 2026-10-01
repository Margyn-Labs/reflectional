/** Run: node api/_lib/__tests__/tallyAiClassify.test.js — fake fetch, no network. */
const { classifyLedgersWithAI } = require('../tallyAiClassify');
const { computeAnalytics } = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };
const reply = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(obj) + '\n```' }] }) });

(async () => {
  const items = [{ ledger: 'A', vouchers: 3, volume: 10 }, { ledger: 'B', vouchers: 1, volume: 5 }, { ledger: 'C', vouchers: 1, volume: 5 }];
  const r = await classifyLedgersWithAI(items, { apiKey: 'k', fetchImpl: reply({ ledgers: [
    { ledger: 'A', bucket: 'debtor', confidence: 0.95 }, { ledger: 'B', bucket: 'opex', confidence: 0.5 },
    { ledger: 'C', bucket: 'nonsense', confidence: 0.99 }, { ledger: 'Z', bucket: 'opex', confidence: 0.99 }] }) });
  check('keeps only sure, valid answers for ledgers we asked about', r.length === 1 && r[0].ledger === 'A' && r[0].bucket === 'debtor', r);
  check('no key means no call and no answers', (await classifyLedgersWithAI(items, { apiKey: '', fetchImpl: () => { throw new Error('called'); } })).length === 0);
  check('an API failure returns nothing instead of throwing', (await classifyLedgersWithAI(items, { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })).length === 0);
  check('garbage output returns nothing', (await classifyLedgersWithAI(items, { apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'sorry' }] }) }) })).length === 0);

  // Tally's own structure beats name guessing
  const o = computeAnalytics({
    ledgers: [
      { name: 'Sales Dom', parent: 'MY SALES GROUP', primary_group: 'Sales Accounts', opening_balance: 0, closing_balance: 100 },
      { name: 'ACME', parent: 'PHARMA GIFTING', primary_group: 'Sundry Debtors', opening_balance: 0, closing_balance: -100 }
    ],
    vouchers: [{ tally_guid: 'x', voucher_type: 'XYZ BILLING', voucher_base: 'Sales', voucher_number: '1', date: '2026-09-10', party_name: 'ACME', is_cancelled: false,
      entries: [{ ledger: 'ACME', amount: -100, is_party: true }, { ledger: 'Sales Dom', amount: 100 }] }],
    bills: [], now: '2026-09-30'
  });
  check('custom group placed through its primary group', o.period.net_sales === 100 && !o.quality.unclassified_ledgers.length && !o.quality.guessed_ledgers.length, o.quality);
  const o2 = computeAnalytics({
    ledgers: [{ name: 'ACME', parent: 'Sundry Debtors', opening_balance: 0, closing_balance: -100 }],
    vouchers: [{ tally_guid: 'y', voucher_type: 'XYZ BILLING', voucher_base: 'Sales', voucher_number: '1', date: '2026-09-10', party_name: 'ACME', is_cancelled: false,
      entries: [{ ledger: 'ACME', amount: -118, is_party: true }, { ledger: 'IGST', amount: 18 }] }], bills: [], now: '2026-09-30' });
  check('renamed voucher type counted as sales through its base type', o2.period.net_sales === 100, o2.period);

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
