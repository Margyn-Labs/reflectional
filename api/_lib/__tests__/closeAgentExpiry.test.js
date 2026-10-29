/**
 * api/reconcile.js runAgentForUser: proposals still waiting from a books connection that's gone (Tally
 * disconnected, Zoho Books keeps the books) expire; ones from the live connection, ones already actioned and
 * untagged old ones are left alone. In-memory PostgREST (zohoHarness), no network.
 * Run: node api/_lib/__tests__/closeAgentExpiry.test.js
 */
const H = require('./zohoHarness');
H.setEnv();
const reconcile = require('../../reconcile');

const T = H.makeChecker();
const { check } = T;

(async () => {
  const db = new H.FakeDb();
  H.installFetch(db, new H.FakeZoho());
  const U = 'user-1';
  db.t('zoho_organizations').push({ id: 'zorg-live', user_id: U, status: 'active', connected_at: new Date().toISOString() });
  db.t('tally_installs').push({ id: 'tally-old', user_id: U, status: 'revoked', company_name: 'Test' });
  const row = (key, org, status) => ({ user_id: U, agent: 'close_collections', proposal_key: key, org_ref: org, status, kind: 'bad_debt', title: key });
  db.t('agent_actions').push(row('tally-test-customer', 'tally-old', 'proposed'), row('tally-approved', 'tally-old', 'approved'),
    row('zoho-old-proposal', 'zorg-live', 'proposed'), row('untagged', null, 'proposed'));

  const out = await reconcile.runAgentForUser(U);
  const st = (k) => db.t('agent_actions').find((r) => r.proposal_key === k).status;
  check('agent ran', out && out.status === 'ok', out);
  check('waiting proposal from the disconnected Tally expires', st('tally-test-customer') === 'expired');
  check('an actioned one is never touched', st('tally-approved') === 'approved');
  check('a waiting proposal from the live Zoho org stays', st('zoho-old-proposal') === 'proposed');
  check('an untagged old proposal stays', st('untagged') === 'proposed');
  T.done();
})().catch((e) => { console.error(e); process.exit(1); });
