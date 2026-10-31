/**
 * api/_zoho/sync.js (+ select-org activation and the nightly cron) end to end
 * against an in-memory PostgREST and an in-memory Zoho Books built from
 * test-fixtures/zoho/: pagination at 200 rows, empty org, non-INR org, delta
 * cursor, idempotent re-runs (no duplicate rows), token expiry mid-sync
 * (recoverable and fatal), code 57 / plan-gated modules, deleted-at-source sweep.
 * Zero-dep, no network, timers fast-forwarded.
 * Run: node api/_lib/__tests__/zohoSync.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
process.env.CRON_SECRET = 'cron-test-secret';
const sync = require('../../_zoho/sync');
const selectOrg = require('../../_zoho/select-org');
const cron = require('../../_zoho/cron');

const T = H.makeChecker();
const { check } = T;
const HOUR = 3600 * 1000;
const REFRESH = '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const P_AND_L = 4;           // income + COGS + expense + bank accounts in chartofaccounts.json (all read for postings)
const TXNS_PER_ACCOUNT = 2;  // account-transactions.json

const zohoTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

function populated(zoho, { invoices = 450, currency } = {}) {
  const start = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  const cur = currency ? () => ({ currency_code: currency }) : undefined;
  zoho.collection('books/v3/invoices', 'invoices', H.makeRecords('invoice.record.json', 'invoice_id', invoices, { startIso: start, extra: cur }));
  zoho.collection('books/v3/bills', 'bills', H.makeRecords('bill.record.json', 'bill_id', 5, { startIso: start, prefix: '8', extra: cur }));
  zoho.collection('books/v3/customerpayments', 'customerpayments', H.makeRecords('customerpayment.record.json', 'payment_id', 3, { startIso: start, prefix: '7' }));
  zoho.collection('books/v3/vendorpayments', 'vendorpayments', H.makeRecords('vendorpayment.record.json', 'payment_id', 2, { startIso: start, prefix: '6' }));
  zoho.collection('books/v3/bankaccounts', 'bankaccounts', H.fixture('bankaccounts.json').bankaccounts);
  zoho.collection('books/v3/chartofaccounts', 'chartofaccounts', H.fixture('chartofaccounts.json').chartofaccounts);
  zoho.route('books/v3/chartofaccounts/transactions', () => H.json(200, H.fixture('account-transactions.json')));
}

function empty(zoho) {
  for (const [p, k] of [['invoices', 'invoices'], ['bills', 'bills'], ['customerpayments', 'customerpayments'], ['vendorpayments', 'vendorpayments'], ['bankaccounts', 'bankaccounts'], ['chartofaccounts', 'chartofaccounts']]) {
    zoho.collection('books/v3/' + p, k, []);
  }
}

function world({ orgPatch = {}, users = ['user-1'] } = {}) {
  const db = new H.FakeDb();
  const zoho = new H.FakeZoho();
  const strays = H.installFetch(db, zoho);
  users.forEach((uid, i) => {
    const id = 'org-' + (i + 1);
    db.t('zoho_organizations').push({
      id, user_id: uid, organization_id: '6001234567' + i, organization_name: 'Northwind Trading Co.',
      api_domain: zoho.apiDomain, accounts_domain: zoho.accountsDomain,
      status: 'active', plan_type: 'standard', base_currency: 'INR',
      connected_at: new Date().toISOString(), backfill_completed_at: null, ...orgPatch
    });
    db.vault[id] = REFRESH;
    db.users['jwt-' + uid] = { id: uid, email: uid + '@example.in' };
  });
  return { db, zoho, strays, org: () => db.t('zoho_organizations')[0] };
}

const count = (db, t) => db.t(t).length;
const uniq = (db, t, cols) => new Set(db.t(t).map((r) => cols.map((c) => r[c]).join('|'))).size;
const cursorOf = (db, mod) => { const r = db.t('zoho_sync_state').find((x) => x.module === mod); return r && r.last_synced_at; };
const booksCalls = (zoho, p) => zoho.calls.filter((c) => c.path === p);

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (n) => { r.statusCode = n; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
}

const TABLES = [
  ['zoho_invoices', ['org_ref', 'invoice_id']],
  ['zoho_bills', ['org_ref', 'bill_id']],
  ['zoho_customer_payments', ['org_ref', 'payment_id']],
  ['zoho_vendor_payments', ['org_ref', 'payment_id']],
  ['zoho_bank_accounts', ['org_ref', 'account_id']],
  ['zoho_chart_of_accounts', ['org_ref', 'account_id']],
  ['zoho_journal_entries', ['org_ref', 'account_ref', 'transaction_id']]
];

(async () => {
  const timers = H.fastTimers();
  const origErr = console.error;
  console.error = () => {};
  const started = Date.now();
  try {
    // ------------------------------------------------------- backfill + pagination
    console.log('# backfill: pagination at 200 rows');
    const W = world();
    {
      const { db, zoho, strays } = W;
      populated(zoho);
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('backfill succeeds', r.status === 'success' && r.mode === 'backfill', r);
      check('breakdown counts match the fixtures', r.breakdown.invoices === 450 && r.breakdown.bills === 5 && r.breakdown.customerpayments === 3 &&
        r.breakdown.vendorpayments === 2 && r.breakdown.bankaccounts === 2 && r.breakdown.chartofaccounts === 4 && r.breakdown.journals === P_AND_L * TXNS_PER_ACCOUNT, r.breakdown);
      const inv = booksCalls(zoho, 'books/v3/invoices').filter((c) => c.params.last_modified_time);
      check('450 invoices fetched as 3 pages of per_page=200', inv.length === 3 && inv.map((c) => c.params.page + '/' + c.params.per_page).join() === '1/200,2/200,3/200', inv.map((c) => c.params));
      check('450 invoice rows stored', count(db, 'zoho_invoices') === 450);
      const since = new Date(inv[0].params.last_modified_time).getTime();
      check('backfill window is ~12 months, Zoho +0000 format, sorted by last_modified_time',
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/.test(inv[0].params.last_modified_time) && Math.abs(Date.now() - since - 365 * 24 * HOUR) < 4 * 24 * HOUR && inv[0].params.sort_column === 'last_modified_time', inv[0].params);
      check('chart of accounts / bank accounts pulled without a modified-time filter', !booksCalls(zoho, 'books/v3/chartofaccounts')[0].params.last_modified_time && !booksCalls(zoho, 'books/v3/bankaccounts')[0].params.last_modified_time);
      check('postings read for P&L and bank accounts', zoho.calls.filter((c) => /transactions$/.test(c.path)).length === P_AND_L && zoho.calls.some((c) => /transactions$/.test(c.path) && c.params.account_id === '460000000099001'));
      const j = db.t('zoho_journal_entries');
      check('journal amounts read from debit_amount / credit_amount', j.some((r) => r.credit === 203644.07 && r.debit === 0) && j.some((r) => r.debit === 45000 && r.credit === 0), j.slice(0, 2));
      check('journal key is "<document>:<posting>"', j.every((r) => /^TXN-\d:CT-\d$/.test(r.transaction_id)), j.map((r) => r.transaction_id).slice(0, 3));
      check('every Books call: Zoho-oauthtoken + organization_id', zoho.calls.every((c) => /^Zoho-oauthtoken /.test(c.auth) && c.params.organization_id === '60012345670'));
      const maxMod = db.t('zoho_invoices').map((x) => x.last_modified_time).sort().pop();
      check('invoice cursor = newest last_modified_time seen', cursorOf(db, 'invoices') === maxMod, [cursorOf(db, 'invoices'), maxMod]);
      check('backfill_completed_at + last_synced_at stamped', !!W.org().backfill_completed_at && !!W.org().last_synced_at);
      check('backfill runs the two-way sweep once and records Zoho\'s counts', !!cursorOf(db, 'deleted_sweep') && db.t('zoho_sync_state').some((r) => r.module === 'count:invoices' && r.remote_count === 450));
      const reading = db.t('zoho_sync_state').filter((r) => /^reading:/.test(r.module));
      const fr = require('../../_zoho/vitals').firstReadFrom({ status: 'active', organization_name: 'X', backfill_completed_at: 'x' }, reading);
      check('first read: progress rows per module, all done, invoices counted (Margyn panel narration)', reading.some((r) => r.module === 'reading:invoices' && r.last_run_status === 'success' && r.remote_count > 0) && fr.done && fr.steps.every((x) => x.done) && fr.current === null, { reading, fr });
      check('mapped row: INR, sub_total = total - tax, dates trimmed', (() => { const x = db.t('zoho_invoices')[0]; return x.currency_code === 'INR' && Math.abs(x.sub_total - (240300 - 36655.93)) < 0.01 && x.invoice_date === '2026-09-01' && x.org_ref === 'org-1'; })(), db.t('zoho_invoices')[0]);
      check('one token refresh for the whole run', zoho.refreshCount === 1);
      check('no stray network', strays.length === 0, strays);
    }

    // ------------------------------------------------------- idempotent re-run
    console.log('# running sync twice yields no duplicate rows');
    {
      const { db, zoho } = W;
      const before = Object.fromEntries(TABLES.map(([t]) => [t, count(db, t)]));
      const cursorBefore = cursorOf(db, 'invoices');
      zoho.calls.length = 0;
      const r = await sync.syncZohoForUser('user-1', 'delta');
      check('second (delta) run succeeds', r.status === 'success', r);
      for (const [t, cols] of TABLES) {
        check(`${t}: ${before[t]} rows before, same after, all keys unique`, count(db, t) === before[t] && uniq(db, t, cols) === count(db, t), [before[t], count(db, t)]);
      }
      const inv = booksCalls(zoho, 'books/v3/invoices').filter((c) => c.params.last_modified_time);
      check('delta asks from cursor minus the 1-hour overlap', inv[0].params.last_modified_time === zohoTime(new Date(cursorBefore).getTime() - HOUR), [inv[0].params.last_modified_time, cursorBefore]);
      check('delta re-fetches only the overlap window, one page', inv.length === 1 && r.breakdown.invoices === 7 /* rows 10 min apart, inclusive 1h */, r.breakdown.invoices);
      check('sweep ran on the first delta and closed nothing', !!cursorOf(db, 'deleted_sweep') && !db.t('zoho_invoices').some((x) => x.status === 'deleted_at_source'));

      const r3 = await sync.syncZohoForUser('user-1', 'backfill');
      check('a forced re-backfill is also idempotent', r3.status === 'success' && TABLES.every(([t, cols]) => count(db, t) === before[t] && uniq(db, t, cols) === before[t]));
    }

    // ------------------------------------------------------- delta cursor
    console.log('# delta cursor picks up changes since the watermark');
    {
      const { db, zoho } = W;
      const inv = zoho.collections['books/v3/invoices'].rows;
      const cursorBefore = cursorOf(db, 'invoices');
      const recent = zohoTime(Date.now() - 5 * 60 * 1000);
      Object.assign(inv[9], { status: 'paid', balance: 0, last_modified_time: recent });
      inv.push(Object.assign(JSON.parse(JSON.stringify(inv[0])), { invoice_id: '9NEW00000001', invoice_number: 'INV-NEW', total: 5000, balance: 5000, last_modified_time: recent }));
      zoho.calls.length = 0;
      const r = await sync.syncZohoForUser('user-1', 'delta');
      const call = booksCalls(zoho, 'books/v3/invoices')[0];
      check('filter = previous cursor - 1h', call.params.last_modified_time === zohoTime(new Date(cursorBefore).getTime() - HOUR));
      check('the two changed invoices + the 7 already-seen rows inside the 1h overlap come back', r.breakdown.invoices === 9, r.breakdown);
      check('paid invoice updated in place (balance 0, status paid)', (() => { const x = db.t('zoho_invoices').find((y) => y.invoice_id === inv[9].invoice_id); return x.balance === 0 && x.status === 'paid'; })());
      check('new invoice inserted, no duplicates (451 unique)', count(db, 'zoho_invoices') === 451 && uniq(db, 'zoho_invoices', ['org_ref', 'invoice_id']) === 451);
      check('cursor advanced to the newest modification', cursorOf(db, 'invoices') === new Date(recent).toISOString() && cursorOf(db, 'invoices') > cursorBefore);
      const billCursor = cursorOf(db, 'bills');
      zoho.calls.length = 0;
      await sync.syncZohoForUser('user-1', 'delta');
      check('untouched module keeps its cursor', cursorOf(db, 'bills') === billCursor);
    }

    // ------------------------------------------------------- deleted at source
    console.log('# sweep both ways (weekly, and once after the first sync)');
    {
      const { db, zoho } = world();
      populated(zoho, { invoices: 20 });
      await sync.syncZohoForUser('user-1', 'backfill');
      const gone = zoho.collections['books/v3/invoices'].rows.splice(4, 1)[0];
      db.t('zoho_sync_state').find((r) => r.module === 'deleted_sweep').last_synced_at = new Date(Date.now() - 8 * 24 * HOUR).toISOString();   // a week on
      await sync.syncZohoForUser('user-1', 'delta');
      const row = db.t('zoho_invoices').find((x) => x.invoice_id === gone.invoice_id);
      check('invoice deleted in Zoho -> balance 0, status deleted_at_source, total kept', row.balance === 0 && row.status === 'deleted_at_source' && row.total === 240300, row);
      check('others untouched', db.t('zoho_invoices').filter((x) => x.status === 'deleted_at_source').length === 1);
      zoho.calls.length = 0;
      await sync.syncZohoForUser('user-1', 'delta');
      check('sweep does not run again within the week', booksCalls(zoho, 'books/v3/invoices').every((c) => c.params.last_modified_time));
    }
    {
      // An invoice raised 14 months ago, still open and untouched since: outside the 12-month backfill,
      // so only the sweep's full listing brings it in. Receivables must match Zoho's aging.
      const { db, zoho } = world();
      populated(zoho, { invoices: 5 });
      const old = { ...zoho.collections['books/v3/invoices'].rows[0], invoice_id: '900000000777', invoice_number: 'INV-OLD', date: '2025-08-20', due_date: '2025-09-19',
        balance: 55000, total: 55000, status: 'overdue', last_modified_time: '2025-08-20T10:00:00+0530' };
      const paidOld = { ...old, invoice_id: '900000000778', invoice_number: 'INV-OLD-PAID', balance: 0, status: 'paid' };
      zoho.collections['books/v3/invoices'].rows.push(old, paidOld);
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      const got = db.t('zoho_invoices').find((x) => x.invoice_id === '900000000777');
      check('open invoice older than 12 months is brought in by the sweep', got && got.balance === 55000 && r.breakdown.invoices_added_from_sweep === 1, r.breakdown);
      check('old paid invoice is not added (nothing owed)', !db.t('zoho_invoices').some((x) => x.invoice_id === '900000000778'));
    }

    // ------------------------------------------------------- empty org
    console.log('# empty org');
    {
      const { db, zoho, org, strays } = world();
      empty(zoho);
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('empty org: success, 0 records, no errors', r.status === 'success' && r.records_synced === 0 && !r.errors, r);
      check('empty org: no journal calls (no P&L accounts)', !zoho.calls.some((c) => /transactions$/.test(c.path)) && r.breakdown.journals === 0);
      check('empty org: still marked synced (banner clears)', !!org().backfill_completed_at && !!org().last_synced_at);
      check('empty org: no rows written anywhere', TABLES.every(([t]) => count(db, t) === 0));
      check('empty org: cursor falls back to now', Math.abs(new Date(cursorOf(db, 'invoices')).getTime() - Date.now()) < 60000);
      const r2 = await sync.syncZohoForUser('user-1', 'delta');
      check('empty org: delta run also clean', r2.status === 'success' && r2.records_synced === 0 && strays.length === 0);
    }
    {
      const { db } = world();
      db.t('zoho_organizations')[0].status = 'pending_org_selection';
      const r = await sync.syncZohoForUser('user-1', 'delta');
      check('org not yet selected -> error result, no Zoho calls', r.status === 'error' && /not connected/.test(r.message));
    }

    // ------------------------------------------------------- non-INR org
    console.log('# non-INR org');
    {
      const { db, zoho, org } = world({ orgPatch: { base_currency: 'USD', plan_type: 'professional' } });
      populated(zoho, { invoices: 10, currency: 'USD' });
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('USD org flags multi_currency_detected', r.status === 'success' && r.flags.includes('multi_currency_detected'), r.flags);
      check('flag persisted on the org row', org().multi_currency_detected === true);
      check('USD amounts are stored as USD, never relabelled INR', db.t('zoho_invoices').every((x) => x.currency_code === 'USD') && db.t('zoho_bills').every((x) => x.currency_code === 'USD'));
    }
    {
      // Activation through select-org for a US-DC, USD-only login.
      const { db, zoho } = world({ orgPatch: { status: 'pending_org_selection', organization_id: '__pending__', api_domain: 'https://www.zohoapis.in' } });
      zoho.route('books/v3/organizations', () => H.json(200, H.fixture('organizations.usd.json')));
      empty(zoho);
      const res = mockRes();
      await selectOrg.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, query: {}, body: { org_ref: 'org-1', organization_id: '70011112222' } }, res);
      const o = db.t('zoho_organizations')[0];
      check('select-org activates the USD org', res.statusCode === 200 && res.body.status === 'active' && o.status === 'active' && o.organization_id === '70011112222', res.body);
      check('base_currency USD + multi_currency_detected at activation', o.base_currency === 'USD' && o.multi_currency_detected === true && res.body.multi_currency_detected === true);
      check('activation awaits the backfill', res.body.backfill === 'completed' && !!o.backfill_completed_at);
      const res2 = mockRes();
      await selectOrg.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, query: {}, body: { org_ref: 'org-1', organization_id: '99999' } }, res2);
      check('select-org refuses an org the token cannot see', res2.statusCode === 400, [res2.statusCode, res2.body]);
    }

    // ------------------------------------------------------- module gating
    console.log('# code 57 / plan-gated modules');
    {
      const { db, zoho, org } = world();
      populated(zoho, { invoices: 5 });
      zoho.fault((c) => c.path === 'books/v3/chartofaccounts', () => H.json(403, H.fixture('error-403-code57.json')), 99);
      zoho.fault((c) => c.path === 'books/v3/bankaccounts', () => H.json(400, H.fixture('error-400-plan.json')), 99);
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('code 57 on chartofaccounts: run still success, connection stays active', r.status === 'success' && org().status === 'active', r);
      check('plan-gated bank accounts -> bank_data_unavailable flag persisted', r.flags.includes('bank_data_unavailable') && org().bank_data_unavailable === true);
      check('skipped modules recorded as skipped, others synced', db.t('zoho_sync_state').find((x) => x.module === 'chartofaccounts').last_run_status === 'skipped' && r.breakdown.invoices === 5);
    }

    // ------------------------------------------------------- token expiry mid-sync
    console.log('# token expiry mid-sync');
    {
      const { db, zoho, org } = world();
      populated(zoho);
      let fired = false;
      zoho.onCall = (c) => { if (!fired && c.path === 'books/v3/invoices' && c.params.page === '2') { fired = true; zoho.expireAllAccessTokens(); } };
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('Zoho expires the token on invoices page 2 -> refresh + retry, run succeeds', r.status === 'success' && r.breakdown.invoices === 450 && count(db, 'zoho_invoices') === 450, r);
      check('exactly one extra refresh, one 401 seen', zoho.refreshCount === 2 && zoho.unauthorized === 1, [zoho.refreshCount, zoho.unauthorized]);
      check('connection stays active', org().status === 'active');
    }
    {
      const { zoho } = world();
      populated(zoho);
      const clock = H.fakeClock();
      let fired = false;
      zoho.onCall = (c) => { if (!fired && c.path === 'books/v3/invoices' && c.params.page === '2') { fired = true; clock.advance(51 * 60 * 1000); } };
      try {
        const r = await sync.syncZohoForUser('user-1', 'backfill');
        check('a sync that outlives 50 minutes refreshes proactively, with no 401', r.status === 'success' && zoho.refreshCount === 2 && zoho.unauthorized === 0, [zoho.refreshCount, zoho.unauthorized]);
      } finally { clock.restore(); }
    }
    {
      const { db, zoho, org } = world();
      populated(zoho);
      zoho.onCall = (c) => { if (c.path === 'books/v3/invoices' && c.params.page === '2') { zoho.expireAllAccessTokens(); zoho.refreshTokens.clear(); } };
      const res = mockRes();
      await sync.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { mode: 'backfill' } }, res);
      const after = zoho.calls.length;
      check('revoked mid-sync: handler answers 401 re-authorize', res.statusCode === 401 && /re-authorized/.test(res.body.message), res);
      check('org flipped to needs_reauth', org().status === 'needs_reauth');
      check('connector_logs keeps the reason (needs_reauth: ...)', db.t('connector_logs').some((l) => /^needs_reauth: /.test(l.error_message || '')));
      check('nothing after the auth failure is called (bills untouched)', booksCalls(zoho, 'books/v3/bills').length === 0 && zoho.calls[after - 1].path === 'books/v3/invoices');
      check('invoice cursor not advanced past what was stored', !cursorOf(db, 'invoices'));
      check('modules finished before the failure keep their data', count(db, 'zoho_chart_of_accounts') === 4);
    }
    {
      const res = mockRes();
      await sync.handler({ method: 'POST', headers: {}, body: {} }, res);
      check('sync handler without a user JWT -> 401', res.statusCode === 401);
    }

    // ------------------------------------------------------- nightly cron
    console.log('# nightly cron: one dead grant does not stop the others');
    {
      const { db, zoho } = world({ users: ['user-a', 'user-b'] });
      populated(zoho, { invoices: 3 });
      delete db.vault['org-1'];                     // user-a's refresh token is gone
      const res = mockRes();
      await cron.handler({ headers: { authorization: 'Bearer cron-test-secret' }, query: {} }, res);
      const orgs = db.t('zoho_organizations');
      check('cron: 1 synced, 1 failed', res.statusCode === 200 && res.body.orgs_synced === 1 && res.body.failed === 1, res.body);
      check('cron: dead grant -> needs_reauth, healthy org untouched', orgs[0].status === 'needs_reauth' && orgs[1].status === 'active');
      const res2 = mockRes();
      await cron.handler({ headers: { authorization: 'Bearer wrong' }, query: {} }, res2);
      check('cron without CRON_SECRET -> 401', res2.statusCode === 401);
    }
    // ------------------------------------------------ journal key collisions
    console.log('# journal rows without transaction_id');
    {
      const acct = { id: 'acct-row-1', account_id: '4600001' };
      const t = { date: '2026-10-01', debit_or_credit: 'debit', amount: 5000 };
      const rows = sync.journalRows([t, { ...t }, { ...t }, { ...t, amount: 700 }], acct, 'org-1');
      const ids = rows.map((r) => r.transaction_id);
      check('same-day same-amount postings keep distinct keys', new Set(ids).size === 4, ids);
      check('first repeat keeps the legacy bare key', ids[0] === '4600001:2026-10-01:debit:5000' && ids[1] === ids[0] + '#2' && ids[2] === ids[0] + '#3');
      const again = sync.journalRows([t, { ...t }, { ...t }, { ...t, amount: 700 }], acct, 'org-1').map((r) => r.transaction_id);
      check('keys are stable across runs (idempotent upsert)', JSON.stringify(again) === JSON.stringify(ids));
      const withId = sync.journalRows([{ ...t, transaction_id: 'T1' }, { ...t, transaction_id: 'T2' }], acct, 'org-1');
      check('real transaction_id wins over the fallback key', withId[0].transaction_id === 'T1' && withId[1].transaction_id === 'T2');
      check('debit total preserved: 3 x 5000 + 700', rows.reduce((a, r) => a + r.debit, 0) === 15700);
    }
    {
      // A posting deleted (or moved out of the window) in Zoho must leave the P&L on the next run.
      const W3 = world();
      populated(W3.zoho);
      await sync.syncZohoForUser('user-1', 'backfill');
      const before = W3.db.t('zoho_journal_entries').length;
      const one = H.fixture('account-transactions.json');
      one.transactions = one.transactions.slice(0, 1);
      W3.zoho.route('books/v3/chartofaccounts/transactions', () => H.json(200, one));
      await sync.syncZohoForUser('user-1', 'delta');
      const after = W3.db.t('zoho_journal_entries');
      check('posting gone from Zoho is removed on the next sync', before === P_AND_L * 2 && after.length === P_AND_L && after.every((r) => r.transaction_id === 'TXN-1:CT-1'), [before, after.length]);
      const jc = W3.zoho.calls.filter((c) => /transactions$/.test(c.path)).pop();
      check('delta still reads the full 12-month window', jc && Math.abs(Date.now() - new Date(jc.params.date_start).getTime() - 365 * 24 * HOUR) < 4 * 24 * HOUR, jc && jc.params);
    }
    {
      // Accounts Zoho reports at zero balance, with nothing stored, are not read (calls saved).
      const W4 = world();
      populated(W4.zoho);
      const chart = H.fixture('chartofaccounts.json').chartofaccounts.map((a, i) => ({ ...a, current_balance: i === 0 ? 0 : 1000 }));
      W4.zoho.route('books/v3/chartofaccounts', (q) => H.json(200, { code: 0, chartofaccounts: chart, page_context: { page: 1, per_page: 200, has_more_page: false } }));
      await sync.syncZohoForUser('user-1', 'backfill');
      const read = W4.zoho.calls.filter((c) => /transactions$/.test(c.path)).map((c) => c.params.account_id);
      check('unused zero-balance account skipped', read.length === P_AND_L - 1 && !read.includes(chart[0].account_id), read);
    }
    {
      const W2 = world();
      populated(W2.zoho);
      W2.zoho.route('books/v3/chartofaccounts/transactions', () => H.json(404, { code: 5, message: 'Invalid URL Passed' }));
      W2.zoho.route('books/v3/chartofaccounts/accounttransactions', () => H.json(200, H.fixture('account-transactions.json')));
      const rf = await sync.syncZohoForUser('user-1', 'backfill');
      check('journal path 404 falls back to the documented accounttransactions path', rf.status === 'success' && rf.breakdown.journals === P_AND_L * TXNS_PER_ACCOUNT, rf.breakdown);
      W2.zoho.route('books/v3/chartofaccounts/accounttransactions', () => H.json(404, { code: 5, message: 'Invalid URL Passed' }));
      const r = await sync.syncZohoForUser('user-1', 'backfill');
      check('journal endpoint 404 on every P&L account is reported, not a silent zero', r.status === 'partial' && (r.errors || []).some((e) => /journals: transactions unavailable for all/.test(e)), r.errors);
    }
  } catch (err) {
    console.error = origErr;
    console.error(err);
    T.fail++;
  } finally {
    console.error = origErr;
    timers.restore();
  }
  console.log('# elapsed ' + (Date.now() - started) + 'ms');
  T.done();
})();
