// Chase's per-account switch (2026-10-08). Run: node api/_lib/__tests__/chaseSwitch.test.js
// An account without include_connectors:true must behave exactly as before: only receivables typed into Margyn,
// and no read of Tally / Zoho / Odoo at all.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
const assert = require('assert');
const U = '11111111-1111-1111-1111-111111111111';
let touched = [];
const DB = {
  receivables: [{ id: 'r1', user_id: U, party_name: 'Small Shop', amount: 5000, due_date: '2020-01-01', status: 'open' }],
  ledger_parties: [{ id: 'p1', user_id: U, name: 'Small Shop', phone: '+919820012345' }],
  whatsapp_chase_targets: []
};
const inserted = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  touched.push(table);
  const res = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
  if ((opts.method || 'GET') === 'POST') { inserted.push({ table, rows: JSON.parse(opts.body) }); return res(JSON.parse(opts.body)); }
  if ((opts.method || 'GET') === 'GET') return res(DB[table] || []);
  return res([]);
};
const handler = require('../../whatsapp.js');
const run = handler._syncChaseQueue;

(async () => {
  // 1. default account (no flag)
  const r = await run(U, { enabled: true });
  const tables = [...new Set(touched)];
  assert.deepStrictEqual(tables.sort(), ['ledger_parties', 'receivables', 'whatsapp_chase_targets'], 'default account reads only the three tables it always did: ' + tables);
  assert.ok(!touched.some((t) => /tally|zoho|odoo|razorpay|cashfree/.test(t)), 'no connector table is read');
  assert.strictEqual(r.created, 1);
  assert.strictEqual(inserted[0].rows[0].receivable_id, 'r1');
  assert.strictEqual(inserted[0].rows[0].contact_phone, '9820012345'.length === 10 ? '919820012345' : inserted[0].rows[0].contact_phone);
  console.log('ok  - an account without the switch is untouched (manual receivables only, no connector reads)');

  // 2. include_connectors:false explicitly
  touched = []; inserted.length = 0; DB.whatsapp_chase_targets = [];
  await run(U, { enabled: true, include_connectors: false });
  assert.ok(!touched.some((t) => /tally|zoho|odoo/.test(t)));
  console.log('ok  - include_connectors:false behaves the same');

  // 3. switch on: reads the connector tables
  touched = []; inserted.length = 0; DB.whatsapp_chase_targets = [];
  await run(U, { enabled: true, include_connectors: true });
  assert.ok(touched.some((t) => /tally_installs|zoho_organizations/.test(t)), 'switched-on account reads the connectors: ' + [...new Set(touched)]);
  console.log('ok  - include_connectors:true reads the connectors');
  console.log('\n3 passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
