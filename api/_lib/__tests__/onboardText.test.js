/** Run: node api/_lib/__tests__/onboardText.test.js — "onboard" on WhatsApp (onboardText.js). */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d) : ''))); };

const DB = { tally_installs: [], zoho_organizations: [], connector_credentials: [], zoho_line_state: [], zoho_sync_state: [], agent_deployments: [] };
global.fetch = async (url) => {
  const u = new URL(url);
  const t = u.pathname.replace('/rest/v1/', '');
  const uid = (u.searchParams.get('user_id') || '').replace('eq.', '');
  const org = (u.searchParams.get('org_ref') || '').replace('eq.', '');
  const rows = (DB[t] || []).filter((r) => (uid ? r.user_id === uid : true) && (org ? r.org_ref === org : true));
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
};
const O = require('../onboardText');

(async () => {
  // Which messages count
  ['onboard', 'Onboard', ' ONBOARD! ', 'on board', 'on-boarding', 'setup', 'set up', 'Set me up', 'get started', 'connect my books']
    .forEach((t) => check('"' + t + '" asks to onboard', O.isOnboardText(t)));
  ['how do I set up Chase?', 'who owes me', 'onboard my accountant please', '', null]
    .forEach((t) => check('"' + t + '" goes to the agent', !O.isOnboardText(t)));

  // Replies
  const stranger = O.onboardReply({ known: false });
  check('unknown number: sign-up link only, nothing about any business', /isn’t on a Margyn account/.test(stranger) && /\?setup=start/.test(stranger) && !/Zoho Books is connected/.test(stranger));
  const fresh = O.onboardReply({ known: true, books: [] });
  check('no books: one link per books system', /\?setup=zoho/.test(fresh) && /\?setup=tally/.test(fresh) && /\?setup=odoo/.test(fresh), fresh);
  check('no books: says it changes nothing and the owner presses Accept', /changes nothing/.test(fresh) && /Accept/.test(fresh));
  const filling = O.onboardReply({ known: true, books: ['zoho'], zoho: { name: 'Margyn Labs', items: { documents: 1054, read: 868, pending: 186, eta: { when: 'tomorrow_morning' } } }, chaseOn: false });
  check('Zoho filling: org name, read count, ETA', /Zoho Books is connected \(Margyn Labs\)/.test(filling) && /868 of 1,054/.test(filling) && /tomorrow morning/.test(filling), filling);
  check('Chase off: next step is the Chase link', /#\/agents/.test(filling));
  const done = O.onboardReply({ known: true, books: ['zoho'], zoho: { name: 'X', items: { documents: 1054, read: 1054, pending: 0 } }, chaseOn: true });
  check('all read + Chase on', /all in: 1,054/.test(done) && /Chase\) are on/.test(done) && !/#\/agents/.test(done), done);
  check('Tally connected', /Tally is connected/.test(O.onboardReply({ known: true, books: ['tally'] })));
  check('ETA in minutes', O.etaWords({ when: 'today', minutes: 12 }) === ', done in about 12 minutes');
  check('ETA in days', O.etaWords({ when: 'days', days: 3 }) === ', done in about 3 days');

  // Facts from the database
  DB.zoho_organizations.push({ id: 'org1', user_id: 'u1', status: 'active', organization_name: 'Margyn Labs', plan_type: 'free' });
  DB.zoho_line_state.push(
    { org_ref: 'org1', doc_type: 'invoice', doc_date: '2026-10-01', status: 'sent', doc_last_modified: '2026-10-01T00:00:00Z', read_modified: '2026-10-01T00:00:00Z', lines_read_at: '2026-10-02T00:00:00Z' },
    { org_ref: 'org1', doc_type: 'invoice', doc_date: '2026-10-03', status: 'sent', doc_last_modified: '2026-10-03T00:00:00Z', read_modified: null, lines_read_at: null },
    { org_ref: 'org1', doc_type: 'invoice', doc_date: '2026-10-04', status: 'void', doc_last_modified: '2026-10-04T00:00:00Z', read_modified: null, lines_read_at: null });
  DB.agent_deployments.push({ user_id: 'u1', agent_id: 'chase_agent', status: 'active', config: { enabled: true } });
  const f = await O.onboardFacts('u1');
  check('facts: Zoho connected, name, 1 of 2 live documents read, ETA set', f.books.includes('zoho') && f.zoho.name === 'Margyn Labs' && f.zoho.items.documents === 2 && f.zoho.items.read === 1 && f.zoho.items.eta && f.zoho.items.eta.when, f);
  check('facts: Chase on', f.chaseOn === true);
  const g = await O.onboardFacts('u9');
  check('facts: an account with nothing connected', g.known && g.books.length === 0 && g.zoho === null && g.chaseOn === false, g);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
