/** Run: node api/_lib/__tests__/booksSource.test.js — one books system per business (booksSource.js). */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d) : ''))); };

const DB = { tally_installs: [], zoho_organizations: [], connector_credentials: [] };
global.fetch = async (url) => {
  const u = new URL(url);
  const t = u.pathname.replace('/rest/v1/', '');
  const uid = (u.searchParams.get('user_id') || '').replace('eq.', '');
  const rows = (DB[t] || []).filter((r) => r.user_id === uid);
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
};
const B = require('../booksSource');

(async () => {
  check('nothing connected: any system may connect', (await B.checkOneBooks('u1', 'zoho')) === null);
  DB.tally_installs.push({ user_id: 'u1', status: 'active' });
  const r = await B.checkOneBooks('u1', 'zoho');
  check('Tally connected: Zoho refused with 409 and a plain message', r && r.status === 409 && r.body.code === 'one_books_system' && /Tally is connected/.test(r.body.message) && r.body.error === r.body.message, r);
  check('Tally connected: pairing another Tally PC is allowed', (await B.checkOneBooks('u1', 'tally')) === null);
  check('Tally connected: Odoo refused', (await B.checkOneBooks('u1', 'odoo')).body.connected === 'tally');
  DB.zoho_organizations.push({ user_id: 'u2', status: 'needs_reauth' });
  check('Zoho needing re-authorisation: reconnecting Zoho is allowed', (await B.checkOneBooks('u2', 'zoho')) === null);
  check('Zoho needing re-authorisation still counts: Tally refused', (await B.checkOneBooks('u2', 'tally')).body.connected === 'zoho');
  check('another account is unaffected', (await B.checkOneBooks('u3', 'tally')) === null);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
