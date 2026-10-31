/**
 * Zoho Books ↔ Tally parity, round 8 (2026-11-01), end to end against the in-memory PostgREST and Zoho of
 * zohoHarness.js. No network, timers fast-forwarded.
 *  - which invoice a payment cleared (list numbers free, detail read for amount + TDS, budget-capped, never wiped)
 *  - chat says "₹87,985 on 31 Oct cleared INV-00762 (₹1,796 TDS withheld)"; receivables say invoices; Tally unchanged
 *  - daytime money refresh before an update: cheap, inside the allowance, never on a Tally account
 *  - safety drills: revoked grant → needs_reauth → reconnect works; 429 mid-sync → stops, resumes next run;
 *    disconnect → token revoked, vault purged, data kept or removed as chosen, and the answer says which
 *  - self-cleanup: superseded copies removed (MARGYN DEMO's three rows), active copy and Tally accounts untouched
 * Run: node api/_lib/__tests__/zohoSafety.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
process.env.CRON_SECRET = 'cron-test-secret';
const sync = require('../../_zoho/sync');
const selectOrg = require('../../_zoho/select-org');
const disconnect = require('../../_zoho/disconnect');
const cleanup = require('../selfCleanup');
const { zohoToBook } = require('../dataLayer/books');
const E = require('../booksEngine');

const T = H.makeChecker();
const { check } = T;
const HOUR = 3600 * 1000;
const REFRESH = '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const PAY_ID = '4097757000000282014';   // payment 168, Bluecrate Exports, on INV-00762 (live, 31 Oct)

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (n) => { r.statusCode = n; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
}

function world(orgPatch) {
  const db = new H.FakeDb();
  const zoho = new H.FakeZoho();
  const strays = H.installFetch(db, zoho);
  db.t('zoho_organizations').push(Object.assign({
    id: 'org-live', user_id: 'user-1', organization_id: '60082308675', organization_name: 'MARGYN DEMO',
    api_domain: zoho.apiDomain, accounts_domain: zoho.accountsDomain, status: 'active', plan_type: 'free', base_currency: 'INR',
    connected_at: new Date().toISOString(), backfill_completed_at: new Date().toISOString(), last_synced_at: new Date(Date.now() - 8 * HOUR).toISOString()
  }, orgPatch || {}));
  db.vault['org-live'] = REFRESH;
  db.users['jwt-user-1'] = { id: 'user-1', email: 'demo@example.in' };
  const start = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
  zoho.collection('books/v3/invoices', 'invoices', H.makeRecords('invoice.record.json', 'invoice_id', 3, { startIso: start }));
  zoho.collection('books/v3/bills', 'bills', H.makeRecords('bill.record.json', 'bill_id', 2, { startIso: start, prefix: '8' }));
  zoho.collection('books/v3/customerpayments', 'customerpayments', [{
    payment_id: PAY_ID, payment_number: '168', invoice_numbers: 'INV-00762', date: '2026-10-31', payment_mode: 'Bank Transfer',
    amount: 87985.38, customer_id: 'C-BLUE', customer_name: 'Bluecrate Exports', last_modified_time: new Date(Date.now() - 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, '+0000')
  }]);
  zoho.collection('books/v3/vendorpayments', 'vendorpayments', H.makeRecords('vendorpayment.record.json', 'payment_id', 1, { startIso: start, prefix: '6' }));
  zoho.collection('books/v3/bankaccounts', 'bankaccounts', H.fixture('bankaccounts.json').bankaccounts);
  zoho.collection('books/v3/chartofaccounts', 'chartofaccounts', H.fixture('chartofaccounts.json').chartofaccounts);
  zoho.route('books/v3/chartofaccounts/transactions', () => H.json(200, H.fixture('account-transactions.json')));
  zoho.route('books/v3/customerpayments/' + PAY_ID, () => H.json(200, { code: 0, payment: {
    payment_id: PAY_ID, amount: 87985.38,
    invoices: [{ invoice_id: 'INV-ID-762', invoice_number: 'INV-00762', amount_applied: 87985.38, tax_amount_withheld: 1795.62 }]
  } }));
  zoho.route('books/v3/vendorpayments/600000000001', () => H.json(200, { code: 0, vendorpayment: {
    payment_id: '600000000001', bills: [{ bill_id: '460000000054321', bill_number: 'SP/26-27/0042', amount_applied: 50000, tax_amount_withheld: 0 }]
  } }));
  return { db, zoho, strays };
}
const payRow = (db) => db.t('zoho_customer_payments').find((r) => r.payment_id === PAY_ID);

(async () => {
  const timers = H.fastTimers();
  const origErr = console.error;
  console.error = () => {};
  try {
    // ------------------------------------------------ 1. which invoice a payment cleared
    console.log('# payment → invoice links');
    {
      const { db, zoho, strays } = world();
      const r = await sync.syncZohoForUser('user-1', 'delta');
      const p = payRow(db);
      check('the list\'s invoice numbers are stored at no extra cost', p && p.applied_numbers === 'INV-00762', p);
      check('one detail read per new payment fills the invoice, the amount and the TDS withheld',
        p && p.invoice_ref === 'INV-ID-762' && p.tax_withheld === 1795.62 && Array.isArray(p.applied_to) && p.applied_to[0].amount === 87985.38 && !!p.links_read_at, p);
      check('vendor payment detail fills the bill too', db.t('zoho_vendor_payments')[0].bill_ref === '460000000054321' && Array.isArray(db.t('zoho_vendor_payments')[0].applied_to));
      check('run reports the links it read', r.breakdown.payment_links === 2, r.breakdown);
      const before = zoho.calls.filter((c) => /customerpayments\//.test(c.path)).length;
      await sync.syncZohoForUser('user-1', 'delta');
      check('an unchanged payment is not read again', zoho.calls.filter((c) => /customerpayments\//.test(c.path)).length === before);
      check('re-listing the payment never wipes the link the detail read stored', payRow(db).invoice_ref === 'INV-ID-762' && payRow(db).tax_withheld === 1795.62, payRow(db));
      check('no stray network', strays.length === 0, strays);

      // A changed payment is read again.
      payRow(db).last_modified_time = new Date(Date.now() + 60000).toISOString();
      const again = await sync.linkPayments(require('../zohoClient').createSession(db.t('zoho_organizations')[0]), db.t('zoho_organizations')[0], 'user-1', { max: 10 });
      check('a payment changed in Zoho since its last read is read again', again.read === 1, again);
      const capped = await sync.linkPayments(require('../zohoClient').createSession(db.t('zoho_organizations')[0]), db.t('zoho_organizations')[0], 'user-1', { max: 0 });
      check('no allowance left: no detail reads', capped.read === 0, capped);
    }
    {
      // Live list shape (1 Nov): one invoice number + tax_amount_withheld on the list row → linked with no detail read.
      const { db, zoho } = world();
      zoho.collections['books/v3/customerpayments'].rows[0].tax_amount_withheld = 1795.62;
      zoho.collections['books/v3/customerpayments'].rows[0].unused_amount = 0;
      await sync.syncZohoForUser('user-1', 'delta');
      const p = payRow(db);
      check('single-invoice payment: linked from the list alone (no detail call)', !zoho.calls.some((c) => /customerpayments\//.test(c.path)) && p.tax_withheld === 1795.62 && p.applied_to[0].number === 'INV-00762' && p.applied_to[0].amount === 87985.38, p);
    }
    {
      // Zoho's 429 on a detail read: stop at once, keep the rest for the next run.
      const { db, zoho } = world();
      zoho.fault((c) => /customerpayments\//.test(c.path), () => H.json(429, H.fixture('error-429.json')), 1);
      await sync.syncZohoForUser('user-1', 'delta');
      check('429 on a payment detail: left unread, nothing else broken', payRow(db) && !payRow(db).links_read_at && db.t('zoho_invoices').length === 3, payRow(db));
      await sync.syncZohoForUser('user-1', 'delta');
      check('…and read on the next run', !!payRow(db).links_read_at && payRow(db).tax_withheld === 1795.62);
    }

    // ------------------------------------------------ 2. chat: what a payment cleared, invoices not bills
    console.log('# chat answers on Zoho (Tally unchanged)');
    {
      const now = new Date('2026-11-01T06:00:00Z');
      const zbook = zohoToBook({
        org: { organization_name: 'MARGYN DEMO', last_synced_at: now.toISOString() },
        accounts: [{ id: 'a-bank', account_id: 'BANK1', account_name: 'HDFC', account_type: 'bank' }],
        invoices: [
          { invoice_id: 'INV-ID-762', invoice_number: 'INV-00762', customer_ref: 'C-BLUE', customer_name: 'Bluecrate Exports', total: 89781, sub_total: 80000, balance: 0, status: 'paid', invoice_date: '2026-10-01', due_date: '2026-10-15' },
          { invoice_id: 'INV-ID-800', invoice_number: 'INV-00800', customer_ref: 'C-BLUE', customer_name: 'Bluecrate Exports', total: 50000, sub_total: 45000, balance: 50000, status: 'overdue', invoice_date: '2026-09-01', due_date: '2026-09-20' }
        ],
        customerPayments: [{ payment_id: PAY_ID, payment_number: '168', customer_ref: 'C-BLUE', amount: 87985.38, payment_date: '2026-10-31', payment_mode: 'Bank Transfer',
          invoice_ref: 'INV-ID-762', applied_numbers: 'INV-00762', applied_to: [{ id: 'INV-ID-762', number: 'INV-00762', amount: 87985.38, tax_withheld: 1795.62 }], tax_withheld: 1795.62 }],
        banks: [{ account_id: 'BANK1', bank_name: 'HDFC', account_type: 'bank', current_balance: 2555559.38, is_primary: true }]
      });
      const ctx = E.prepare(zbook, { now });
      ctx.source = 'zoho'; ctx.source_name = 'Zoho Books';
      const found = E.findEntries(ctx, { kind: 'receipt', party: 'Bluecrate' });
      check('find_entries: the payment says what it cleared and the TDS withheld', found.entries[0] && found.entries[0].cleared === 'cleared INV-00762 (₹1,796 TDS withheld)', found.entries);
      const inv = E.findEntries(ctx, { number: 'INV-00762' }).entries[0];
      check('find_entries: the invoice says which payment cleared it', inv && inv.paid_by && /₹87,985 on 31 Oct 2026 \(payment 168\) cleared INV-00762 \(₹1,796 TDS withheld\)/.test(inv.paid_by[0]) && /paid or settled/.test(inv.still_owed), inv);
      const prof = E.partyProfile(ctx, { name: 'Bluecrate' });
      check('customer profile: last payment cleared INV-00762 with TDS', prof.owes_you && prof.owes_you.last_payment && prof.owes_you.last_payment.cleared === 'cleared INV-00762 (₹1,796 TDS withheld)', prof.owes_you);
      check('customer profile says invoices, not bills', prof.owes_you && 'open_invoices' in prof.owes_you && 'oldest_invoice_days_late' in prof.owes_you && !('open_bills' in prof.owes_you) && prof.owes_you.open_invoices[0].invoice === 'INV-00800', prof.owes_you);
      const owed = E.moneyOwed(ctx, { direction: 'receivable' });
      check('receivables say invoices (largest[].invoices, oldest_invoice_days_late)', owed.largest[0].invoices === 1 && 'oldest_invoice_days_late' in owed.largest[0] && !('bills' in owed.largest[0]) && /Invoice by invoice/.test(owed.source), owed.largest);
      const pay = E.moneyOwed(ctx, { direction: 'payable' });
      check('payables still say bills on Zoho (they are bills)', !pay.largest.length || 'bills' in pay.largest[0]);

      // Tally: the same books as Tally keeps them carry no links, and the words stay "bills".
      const tbook = Object.assign({}, zbook, { source: 'tally', source_name: 'Tally', vouchers: zbook.vouchers.map((v) => { const { settles, ...rest } = v; return rest; }) });
      const tctx = E.prepare(tbook, { now });
      tctx.source = 'tally'; tctx.source_name = 'Tally';
      const tprof = E.partyProfile(tctx, { name: 'Bluecrate' });
      check('Tally profile unchanged: open_bills / oldest_bill_days_late, no cleared', 'open_bills' in tprof.owes_you && 'oldest_bill_days_late' in tprof.owes_you && !JSON.stringify(tprof).includes('cleared'), tprof.owes_you);
      check('Tally receivables unchanged: bills / oldest_bill_days_late', 'bills' in E.moneyOwed(tctx, { direction: 'receivable' }).largest[0] && /Bill-wise outstanding/.test(E.moneyOwed(tctx, { direction: 'receivable' }).source));
      check('Tally entries carry no cleared / paid_by', E.findEntries(tctx, {}).entries.every((e) => !('cleared' in e) && !('paid_by' in e)));
    }

    // ------------------------------------------------ 3. daytime money refresh
    console.log('# daytime refresh before an update');
    {
      const { db, zoho } = world();
      await sync.syncZohoForUser('user-1', 'delta');
      db.t('zoho_organizations')[0].last_synced_at = new Date(Date.now() - 8 * HOUR).toISOString();
      const n0 = zoho.calls.length;
      const r = await sync.refreshZohoMoney('user-1', { deadline: Date.now() + 25000 });
      const used = zoho.calls.slice(n0);
      check('refresh runs and stamps the sync time', r.refreshed === true && Date.now() - Date.parse(db.t('zoho_organizations')[0].last_synced_at) < 60000, r);
      check('money only: invoices, bills, payments, banks, chart of accounts', ['invoices', 'bills', 'customerpayments', 'vendorpayments', 'bankaccounts', 'chartofaccounts'].every((m) => used.some((c) => c.path === 'books/v3/' + m)), used.map((c) => c.path));
      check('no P&L postings, item lines, contacts or sweep', !used.some((c) => /transactions|items|contacts|documents/.test(c.path)) && used.length <= 10, used.map((c) => c.path));
      check('calls counted against today\'s allowance', db.t('zoho_sync_state').some((s) => s.module === 'api_calls' && s.remote_count > 0));
      check('one log line, not one per module', db.t('connector_logs').filter((l) => l.operation === 'refresh_money').length === 1);
      const again = await sync.refreshZohoMoney('user-1', {});
      check('synced minutes ago: skipped', again.refreshed === false && again.reason === 'fresh', again);

      db.t('zoho_organizations')[0].last_synced_at = new Date(Date.now() - 8 * HOUR).toISOString();
      const ist = new Date(Date.now() + 5.5 * HOUR).toISOString();
      db.t('zoho_sync_state').find((s) => s.module === 'api_calls').remote_count = 900;   // Free plan: 1,000 a day
      db.t('zoho_sync_state').find((s) => s.module === 'api_calls').last_synced_at = new Date().toISOString();
      const low = await sync.refreshZohoMoney('user-1', {});
      check('allowance nearly used: skipped, the nightly reserve kept', low.refreshed === false && low.reason === 'allowance' && !!ist, low);
    }
    {
      // 429 during the refresh: stops, cursor kept, no stamp.
      const { db, zoho } = world();
      await sync.syncZohoForUser('user-1', 'delta');
      db.t('zoho_organizations')[0].last_synced_at = new Date(Date.now() - 8 * HOUR).toISOString();
      const stamp = db.t('zoho_organizations')[0].last_synced_at;
      const cursorBills = db.t('zoho_sync_state').find((s) => s.module === 'bills').last_synced_at;
      zoho.fault((c) => c.path === 'books/v3/bills', () => H.json(429, H.fixture('error-429.json')), 5);
      const n0 = zoho.calls.length;
      const r = await sync.refreshZohoMoney('user-1', {});
      check('refresh 429: stops at once (no retries), not stamped', r.refreshed === false && r.reason === 'rate_limited' && db.t('zoho_organizations')[0].last_synced_at === stamp, r);
      check('refresh 429: bills cursor kept for the next run', db.t('zoho_sync_state').find((s) => s.module === 'bills').last_synced_at === cursorBills);
      check('refresh 429: no further modules called after the limit', zoho.calls.slice(n0).filter((c) => c.path === 'books/v3/bills').length === 1 && !zoho.calls.slice(n0).some((c) => /customerpayments|bankaccounts/.test(c.path)), zoho.calls.slice(n0).map((c) => c.path));
    }
    {
      // Never on a Tally account: runWatchAll refreshes Zoho-only accounts only.
      const db = new H.FakeDb();
      H.installFetch(db, new H.FakeZoho());
      db.t('tally_installs').push({ id: 't1', user_id: 'mihir', status: 'active' });
      db.t('zoho_organizations').push({ id: 'z-m', user_id: 'mihir', status: 'active' }, { id: 'z-d', user_id: 'demo', status: 'active' });
      const asked = [];
      const real = sync.refreshZohoMoney;
      sync.refreshZohoMoney = async (u) => { asked.push(u); return { refreshed: false, reason: 'test' }; };
      try { await require('../margynWatch').runWatchAll('noon', { budgetMs: 60000 }); } catch (e) { /* the update itself is not under test */ }
      sync.refreshZohoMoney = real;
      check('runWatchAll refreshes the Zoho-only account before its update', asked.includes('demo'), asked);
      check('runWatchAll never refreshes an account that has Tally', !asked.includes('mihir'), asked);
      // 3 pm, 31 Oct: the Tally account listed first used the slot waiting out its sync, so the Zoho account's
      // refresh found < 5 s left and silently never ran. Now every refresh starts up front, whatever the order.
      asked.length = 0;
      sync.refreshZohoMoney = async (u) => { asked.push(u); return { refreshed: false, reason: 'test' }; };
      try { await require('../margynWatch').runWatchAll('afternoon', { budgetMs: 31000 }); } catch (e) { /* not under test */ }
      sync.refreshZohoMoney = real;
      check('runWatchAll: a tight slot (old code skipped it) still refreshes the Zoho account', asked.includes('demo') && !asked.includes('mihir'), asked);
    }

    // ------------------------------------------------ 4. drill: 429 mid nightly sync
    console.log('# drill: rate limit mid-sync');
    {
      const { db, zoho } = world();
      zoho.fault((c) => c.path === 'books/v3/bills', () => H.json(429, H.fixture('error-429.json')), 4);
      const r = await sync.syncZohoForUser('user-1', 'delta');
      check('429 after retries: run says rate limited, partial', r.rate_limited === true && r.status === 'partial' && /slow down/.test(r.message), r);
      check('429: no P&L postings or item reads hammered after it', !zoho.calls.some((c) => /transactions|books\/v3\/items/.test(c.path)));
      check('429: invoices kept, bills cursor not advanced', db.t('zoho_invoices').length === 3 && !(db.t('zoho_sync_state').find((s) => s.module === 'bills') || {}).last_synced_at);
      check('429 logged in plain words', db.t('connector_logs').some((l) => /rate_limited: Zoho asked Margyn to slow down/.test(l.error_message || '')));
      check('backed off between retries (2 s, 4 s, 8 s)', timers.delays.includes(2000) && timers.delays.includes(4000) && timers.delays.includes(8000));
      const r2 = await sync.syncZohoForUser('user-1', 'delta');
      check('next run resumes and reads the bills', r2.status === 'success' && db.t('zoho_bills').length === 2, r2);
    }

    // ------------------------------------------------ 5. drill: revoked grant → reconnect
    console.log('# drill: revoked grant, then reconnect');
    {
      const { db, zoho } = world();
      await sync.syncZohoForUser('user-1', 'delta');
      zoho.refreshTokens.clear();            // the owner removed Margyn in Zoho (or the grant expired)
      zoho.expireAllAccessTokens();
      const res = mockRes();
      await sync.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { mode: 'delta' } }, res);
      check('revoked: Sync now answers 401 re-authorize', res.statusCode === 401 && /re-authorized/.test(res.body.message), res);
      check('revoked: connection marked needs_reauth', db.t('zoho_organizations')[0].status === 'needs_reauth');
      const refresh = await sync.refreshZohoMoney('user-1', {});
      check('revoked: the daytime refresh does nothing (not active)', refresh.refreshed === false && refresh.reason === 'not_connected', refresh);

      // Reconnect: the callback makes a pending row with the new grant; the owner picks the same organisation.
      zoho.refreshTokens.add('1000.newgrant');
      db.t('zoho_organizations').push({ id: 'org-pending', user_id: 'user-1', organization_id: '__pending__', api_domain: zoho.apiDomain, accounts_domain: zoho.accountsDomain, status: 'pending_org_selection', connected_at: new Date().toISOString() });
      db.vault['org-pending'] = '1000.newgrant';
      zoho.route('books/v3/organizations', () => H.json(200, { code: 0, organizations: [{ organization_id: '60082308675', name: 'MARGYN DEMO', plan_name: 'Free', currency_code: 'INR', is_default_org: true }] }));
      const invoicesBefore = db.t('zoho_invoices').length;
      const r2 = mockRes();
      await selectOrg.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { org_ref: 'org-pending', organization_id: '60082308675' } }, r2);
      const live = db.t('zoho_organizations').find((o) => o.id === 'org-live');
      check('reconnect works (no 409 "already connected")', r2.statusCode === 200 && r2.body.reconnected === true && r2.body.org_ref === 'org-live', r2.body);
      check('the old connection is active again with the new grant', live.status === 'active' && db.vault['org-live'] === '1000.newgrant');
      check('the pending row is put back, its vault entry purged', db.t('zoho_organizations').find((o) => o.id === 'org-pending').status === 'disconnected' && !db.vault['org-pending']);
      check('data kept and no duplicate copy made', db.t('zoho_invoices').length === invoicesBefore && db.t('zoho_invoices').every((i) => i.org_ref === 'org-live'));
      check('owner told in plain words', /kept everything/.test(r2.body.message), r2.body.message);
    }

    // ------------------------------------------------ 6. drill: disconnect, keep or remove
    console.log('# drill: disconnect');
    for (const removeData of [false, true]) {
      const { db, zoho } = world();
      await sync.syncZohoForUser('user-1', 'delta');
      // Another account's rows must never be touched.
      db.t('zoho_invoices').push({ org_ref: 'someone-else', invoice_id: 'X1' });
      const res = mockRes();
      await disconnect.handler({ method: 'POST', headers: { authorization: 'Bearer jwt-user-1' }, body: { remove_data: removeData } }, res);
      const org = db.t('zoho_organizations')[0];
      const tag = removeData ? 'remove' : 'keep';
      check(tag + ': token revoked at Zoho', zoho.tokenCalls.some((c) => c.path === '/oauth/v2/token/revoke'));
      check(tag + ': vault secret purged', !db.vault['org-live']);
      check(tag + ': connection disconnected', org.status === 'disconnected' && !!org.connector_disconnected_at);
      if (!removeData) {
        check('keep: data kept and the answer says so', res.body.data === 'kept' && db.t('zoho_invoices').filter((i) => i.org_ref === 'org-live').length === 3 && /stays visible/.test(res.body.message), res.body);
      } else {
        const left = cleanup.ZOHO_TABLES.reduce((t, tb) => t + db.t(tb).filter((r) => r.org_ref === 'org-live').length, 0);
        check('remove: every synced row of this connection removed and the answer says so', res.body.data === 'removed' && left === 0 && res.body.removed_rows > 0 && /is removed/.test(res.body.message), { left, body: res.body });
        check('remove: another account\'s rows untouched', db.t('zoho_invoices').some((i) => i.org_ref === 'someone-else'));
        check('remove: logged as a count only', db.t('connector_logs').some((l) => l.operation === 'disconnect' && /removed \d+ synced rows/.test(l.error_message || '')));
      }
      const r2 = await sync.syncZohoForUser('user-1', 'delta');
      check(tag + ': nothing syncs after disconnect', r2.status === 'error' && /not connected/.test(r2.message));
    }

    // ------------------------------------------------ 7. self-cleanup
    console.log('# self-cleanup: superseded copies');
    {
      const db = new H.FakeDb();
      H.installFetch(db, new H.FakeZoho());
      const at = (h) => new Date(Date.now() - h * HOUR).toISOString();
      // MARGYN DEMO: three rows for one Zoho org; e5a1… is live, 5385… and 4c47… were left by the 29 Oct reconnects.
      db.t('zoho_organizations').push(
        { id: '5385c7b8', user_id: 'demo', organization_id: '60082308675', status: 'disconnected', connected_at: at(60) },
        { id: '4c4748f4', user_id: 'demo', organization_id: '60082308675', status: 'disconnected', connected_at: at(50) },
        { id: 'e5a18507', user_id: 'demo', organization_id: '60082308675', status: 'active', connected_at: at(40) },
        { id: 'other-org', user_id: 'demo', organization_id: '99999', status: 'disconnected', connected_at: at(30) },   // no newer link: owner's choice, kept
        { id: 'pend', user_id: 'demo', organization_id: '__pending__', status: 'disconnected', connected_at: at(20) },
        { id: 'm-old', user_id: 'mihir', organization_id: '777', status: 'disconnected', connected_at: at(90) },
        { id: 'm-new', user_id: 'mihir', organization_id: '777', status: 'active', connected_at: at(10) });
      db.t('tally_installs').push({ id: 't1', user_id: 'mihir', status: 'active' });
      for (const ref of ['5385c7b8', '4c4748f4', 'e5a18507', 'other-org', 'm-old']) {
        db.t('zoho_chart_of_accounts').push({ id: 'acct-' + ref, org_ref: ref, account_id: 'A' });
        db.t('zoho_journal_entries').push({ org_ref: ref, account_ref: 'acct-' + ref, transaction_id: 't1' }, { org_ref: ref, account_ref: 'acct-' + ref, transaction_id: 't2' });
        for (const t of ['zoho_invoices', 'zoho_bills', 'zoho_customer_payments', 'zoho_document_lines', 'zoho_sync_state']) db.t(t).push({ org_ref: ref, x: 1 }, { org_ref: ref, x: 2 });
      }
      db.t('agent_actions').push({ user_id: 'demo', org_ref: '5385c7b8', status: 'proposed', proposal_key: 'old' }, { user_id: 'demo', org_ref: 'e5a18507', status: 'proposed', proposal_key: 'live' });
      db.t('margyn_signals').push(
        { user_id: 'demo', key: 'late:1', kind: 'late', status: 'resolved', last_seen: at(24 * 500) },
        { user_id: 'demo', key: 'late:2', kind: 'late', status: 'resolved', last_seen: at(24 * 10) },
        { user_id: 'demo', key: 'newly_overdue:1', kind: 'newly_overdue', status: 'resolved', last_seen: at(24 * 500) },
        { user_id: 'demo', key: 'stale:1', kind: 'stale', status: 'open', last_seen: at(24 * 500) });

      const dry = await cleanup.cleanupAccount('demo', { dryRun: true });
      check('dry run removes nothing', dry.zoho.length === 2 && db.t('zoho_invoices').filter((r) => r.org_ref === '5385c7b8').length === 2, dry);

      const out = await cleanup.cleanupAll({});
      const rowsOf = (ref) => ['zoho_invoices', 'zoho_bills', 'zoho_customer_payments', 'zoho_document_lines', 'zoho_journal_entries', 'zoho_chart_of_accounts', 'zoho_sync_state'].reduce((t, tb) => t + db.t(tb).filter((r) => r.org_ref === ref).length, 0);
      check('the two superseded copies are removed', rowsOf('5385c7b8') === 0 && rowsOf('4c4748f4') === 0, { a: rowsOf('5385c7b8'), b: rowsOf('4c4748f4') });
      check('the active connection\'s data is untouched', rowsOf('e5a18507') === 13, rowsOf('e5a18507'));
      check('a disconnected org with no newer connection is kept (owner\'s choice)', rowsOf('other-org') === 13);
      check('a Tally account is never touched', rowsOf('m-old') === 13 && out.results.find((r) => r.user === 'mihir').skipped === 'tally_account', out.results);
      check('the connection rows themselves stay, stamped', db.t('zoho_organizations').length === 7 && !!db.t('zoho_organizations').find((o) => o.id === '5385c7b8').data_removed_at);
      const logs = db.t('connector_logs').filter((l) => l.operation === 'cleanup_superseded');
      check('logged to connector_logs with counts only', logs.length === 2 && logs.every((l) => l.records_synced === 13 && !/₹|\d{4,}/.test(l.error_message.replace(/\b\d{1,3}\b/g, ''))), logs);
      check('a proposal waiting on a replaced copy expires; the live one stays', db.t('agent_actions').find((a) => a.proposal_key === 'old').status === 'expired' && db.t('agent_actions').find((a) => a.proposal_key === 'live').status === 'proposed');
      const keys = db.t('margyn_signals').map((s) => s.key).sort().join();
      check('only long-resolved repeatable findings go; once-only, recent and open ones stay', keys === 'late:2,newly_overdue:1,stale:1', keys);
      const second = await cleanup.cleanupAll({});
      check('running again finds nothing more', second.cleaned === 0, second);
    }
    check('pure: superseded picks only disconnected rows with a newer live one', cleanup.supersededZohoOrgs([
      { id: 'a', status: 'disconnected', organization_id: '1', connected_at: '2026-10-29T01:00:00Z' },
      { id: 'b', status: 'needs_reauth', organization_id: '1', connected_at: '2026-10-29T02:00:00Z' },
      { id: 'c', status: 'disconnected', organization_id: '1', connected_at: '2026-10-29T03:00:00Z' }
    ]).map((r) => r.id).join() === 'a');
    check('pure: Odoo, same database reconnected', cleanup.supersededOdooCreds([
      { id: 'o1', odoo_base_url: 'https://x.odoo.com/', odoo_db: 'x', created_at: '2026-10-01', disconnected_at: '2026-10-02' },
      { id: 'o2', odoo_base_url: 'https://x.odoo.com', odoo_db: 'x', created_at: '2026-10-02', disconnected_at: null },
      { id: 'o3', odoo_base_url: 'https://y.odoo.com', odoo_db: 'y', created_at: '2026-09-01', disconnected_at: '2026-09-02' }
    ]).map((r) => r.id).join() === 'o1');
    let refused = false;
    try { await cleanup.removeZohoData({ id: 'e5a18507', status: 'active' }); } catch (e) { refused = /still live/.test(e.message); }
    check('removing a live connection\'s data is refused', refused);
  } catch (e) {
    console.error = origErr;
    console.log('  FAIL- threw: ' + (e && e.stack));
    T.fail++;
  } finally {
    console.error = origErr;
    timers.restore();
  }
  T.done();
})();
