/** Run: node api/_lib/__tests__/savedCopy.test.js — tallyData.recoverCurrentFile, fake Storage, no network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
const zlib = require('zlib'), crypto = require('crypto');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };
const store = {};
global.fetch = async (url) => {
  const m = /\/storage\/v1\/object\/margyn-cache\/(.+)$/.exec(String(url));
  const body = m && store[m[1]];
  return body ? { ok: true, status: 200, arrayBuffer: async () => body } : { ok: false, status: 404, text: async () => 'not found' };
};
const { recoverCurrentFile, companyFiles } = require('../tallyData');
const U = 'u1', inst = { chosen: [{ id: 'i1' }] }, NEW = 'CARE (2026-27)', OLD = 'CARE (2025-26)';
const path = (company) => `tally/${U}/${crypto.createHash('sha1').update(company + '|i1').digest('hex')}.json.gz`;
const v = (guid, date, company, amt) => ({ tally_guid: guid, date, company_name: company, voucher_type: 'Sales', voucher_number: guid, amount: amt, is_cancelled: false, entries: [] });

(async () => {
  // The books as saved on 8 Oct while this year's file was being read (rows carried no company then).
  const savedVouchers = [];
  for (let i = 1; i <= 40; i++) savedVouchers.push({ tally_guid: 'g' + (65000 + i), date: i <= 20 ? '2026-04-0' + (1 + (i % 9)) : '2026-08-1' + (i % 9), voucher_type: 'Sales', voucher_number: 'V' + i, amount: i * 100, is_cancelled: false, entries: [] });
  const saved = { v: 1, key: `${NEW}|i1|2026-10-08T13:19:00+00:00`, at: '2026-10-09T02:30:00.000Z', vouchers: savedVouchers,
    ledgers: [{ name: 'Kotak Bank', parent: 'Bank Accounts', opening_balance: -100, closing_balance: -663287 }, { name: 'Alkem', parent: 'Sundry Debtors', opening_balance: -5, closing_balance: -900 }],
    bills: [{ direction: 'receivable', party_name: 'Alkem', bill_ref: '808', closing_balance: 900 }] };
  store[path(NEW)] = zlib.gzipSync(Buffer.from(JSON.stringify(saved)));

  // The tables today: last year's file took the GUIDs of five April vouchers, replaced every ledger, and mixed the bills.
  const tableVouchers = savedVouchers.filter((_, i) => i >= 5).map((x) => Object.assign({}, x, { company_name: NEW }))
    .concat([1, 2, 3, 4, 5].map((i) => v('g' + (65000 + i), '2026-03-31', OLD, 7)), [v('g60000', '2025-06-01', OLD, 9), v('g60001', '2025-07-01', OLD, 9)]);
  const tableLedgers = [{ name: 'Kotak Bank', parent: 'Bank Accounts', opening_balance: -50, closing_balance: -816864, company_name: OLD }];
  const tableBills = [{ direction: 'receivable', party_name: 'Alkem', bill_ref: '808', closing_balance: 5000, company_name: OLD }];
  const files = companyFiles(tableLedgers, tableBills, tableVouchers);
  const rows = { ledgers: files.ledgers, bills: files.bills, vouchers: tableVouchers, files: files.summary };
  check('before: balances held are last year\'s file\'s', rows.files.current === NEW && rows.files.ledgers_from === OLD);

  const r = await recoverCurrentFile(U, inst, rows);
  check('this year\'s balances come back from the saved copy, as at its last sync', r && r.ledgers.length === 2 && r.ledgers.find((l) => l.name === 'Kotak Bank').closing_balance === -663287 && r.files.ledgers_from === NEW && r.files.recovered.as_at === '2026-10-08T13:19:00+00:00', r && r.files);
  check('this year\'s open bills come back too', r.bills.length === 1 && r.bills[0].closing_balance === 900 && r.bills[0].company_name === NEW);
  const cur = r.vouchers.filter((x) => x.company_name === NEW);
  check('the five overwritten April vouchers are put back, nothing is doubled', r.files.recovered.vouchers_restored === 5 && cur.length === 40 && new Set(cur.map((x) => x.voucher_number)).size === 40 && cur.filter((x) => x.restored).every((x) => /~saved$/.test(x.tally_guid) && x.date.startsWith('2026-04')), { n: cur.length, back: r.files.recovered.vouchers_restored });
  check('last year\'s vouchers that took those GUIDs are kept as last year\'s', r.vouchers.filter((x) => x.company_name === OLD).length === 7 && r.vouchers.length === 47);

  // Once Tally sends this year's file again, the tables are right and the saved copy is not used.
  const fresh = companyFiles([{ name: 'Kotak Bank', company_name: NEW, closing_balance: -1 }], [], tableVouchers);
  check('not used once the current file\'s balances are held again', (await recoverCurrentFile(U, inst, { ledgers: fresh.ledgers, bills: [], vouchers: tableVouchers, files: fresh.summary })) === null);
  // No saved copy, or a copy of other books: nothing is done.
  delete store[path(NEW)];
  check('no saved copy: nothing is done', (await recoverCurrentFile(U, inst, rows)) === null);
  store[path(NEW)] = zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, saved, { vouchers: savedVouchers.map((x, i) => Object.assign({}, x, { tally_guid: 'other' + i })) }))));
  check('a copy that would "restore" most of the year is not trusted', (await recoverCurrentFile(U, inst, rows)) === null);
  store[path(NEW)] = zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, saved, { vouchers: savedVouchers.slice(0, 10) }))));
  check('an older, smaller copy is not preferred to the tables', (await recoverCurrentFile(U, inst, rows)) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
