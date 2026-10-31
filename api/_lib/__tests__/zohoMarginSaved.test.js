/**
 * The Margin page's saved answer (api/tally.js handleAnalytics) on a Zoho Books account (2026-11-01): worked out
 * once, served saved after, and a new Zoho sync (last_synced_at moves) makes it stale so this sync's answer is
 * worked out. Tally's own key and rule are unchanged (tallyAnalyticsEndpoint.test.js). Fake PostgREST + Storage.
 * Run: node api/_lib/__tests__/zohoMarginSaved.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
const T = H.makeChecker();
const { check } = T;
const sync = require('../../_zoho/sync');

const db = new H.FakeDb();
const store = {};
const writes = [];
H.installFetch(db, new H.FakeZoho());
const dbFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  url = String(url);
  const m = /\/storage\/v1\/(object|bucket)\/?(?:margyn-cache\/)?(.*)$/.exec(url);
  if (!m) return dbFetch(url, init);
  if (m[1] === 'bucket') return H.json(200, {});
  if ((init.method || 'GET') === 'POST') { store[m[2]] = Buffer.from(init.body); writes.push(m[2]); return H.json(200, {}); }
  return store[m[2]] ? new Response(store[m[2]], { status: 200 }) : H.json(404, { error: 'not found' });
};
const U = 'zoho-user';
db.users['jwt-z'] = { id: U, email: 'z@example.in' };
db.t('zoho_organizations').push({ id: 'zo', user_id: U, organization_id: '1', organization_name: 'MARGYN DEMO', status: 'active', connected_at: '2026-10-29T00:00:00Z', last_synced_at: '2026-11-01T01:00:00Z' });
db.t('zoho_chart_of_accounts').push({ id: 'a1', org_ref: 'zo', account_id: 'B1', account_name: 'HDFC', account_type: 'bank' });
db.t('zoho_bank_accounts').push({ org_ref: 'zo', account_id: 'B1', bank_name: 'HDFC', account_type: 'bank', current_balance: 2555559.38, is_primary: true });
for (const r of [['I1', 'Bluecrate Exports', 89781, 0], ['I2', 'Iyer Retail', 50000, 50000]]) {
  db.t('zoho_invoices').push(sync._mapInvoice({ invoice_id: r[0], invoice_number: 'INV-' + r[0], customer_id: 'C' + r[0], customer_name: r[1], total: r[2], sub_total: r[2], balance: r[3], status: r[3] ? 'overdue' : 'paid', date: '2026-10-01', due_date: '2026-10-15' }, 'zo'));
}

const handler = require('../../tally.js');
async function call(query) {
  let status, payload, timing = '';
  const res = { setHeader(k, v) { if (k === 'Server-Timing') timing = v; }, status(s) { status = s; return this; }, json(p) { payload = p; return this; }, end() {} };
  await handler({ method: 'GET', query: Object.assign({ action: 'analytics' }, query || {}), headers: { authorization: 'Bearer jwt-z' } }, res);
  return { status, payload, timing };
}

(async () => {
  const origErr = console.error, origWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try {
    const first = await call();
    check('Zoho Margin answer works out', first.status === 200 && first.payload.connected && first.payload.books_source === 'zoho', first.payload);
    check('…and is saved for every instance (Zoho, not only Tally)', writes.some((p) => p.startsWith('analytics/' + U + '/')), writes);
    const second = await call();
    check('same sync: served saved', /answer;desc="saved"/.test(second.timing) && !second.payload.stale, second.timing);
    check('saved answer = worked-out answer (cash)', JSON.stringify(second.payload.cash) === JSON.stringify(first.payload.cash), second.payload.cash);
    // A new Zoho sync (Sync now, the nightly run or a daytime refresh) stamps last_synced_at.
    db.t('zoho_organizations')[0].last_synced_at = '2026-11-01T05:00:00Z';
    require('../dataLayer/books').forgetBooks(U);
    const third = await call();
    check('after a new Zoho sync: last answer marked stale, so the page asks for this sync\'s', third.payload.stale === true && /answer;desc="stale"/.test(third.timing), third.timing);
    const fresh = await call({ fresh: '1' });
    check('fresh=1 works it out again', fresh.status === 200 && !fresh.payload.stale && !/answer;desc/.test(fresh.timing) && /compute/.test(fresh.timing));
    const fourth = await call();
    check('then served saved again', /answer;desc="saved"/.test(fourth.timing));
  } catch (e) {
    console.log('  FAIL- threw: ' + (e && e.stack)); T.fail++;
  } finally { console.error = origErr; console.warn = origWarn; }
  T.done();
})();
