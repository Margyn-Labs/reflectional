// "Remind <customer>" from the Margyn panel (2026-10-31): POST /api/whatsapp?action=remind-now.
// Run: node api/_lib/__tests__/remindNow.test.js
// Without send it only drafts (nothing reaches WhatsApp). With send it goes through the same chase template,
// sendGuard and chase log as the 10:30 run: a demo account (external sends off) logs "Preview: not sent"; a
// customer with no number asks for one; a customer the owner switched off is refused.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.GUPSHUP_API_KEY = 'k'; process.env.GUPSHUP_SOURCE_NUMBER = '919000000000'; process.env.GUPSHUP_APP_NAME = 'margyn';
for (const n of ['pre_due', 'due_friendly', 'overdue_1_friendly', 'overdue_2_friendly', 'final']) process.env['WHATSAPP_TEMPLATE_CHASE_' + n.toUpperCase()] = 'tpl-' + n;
const assert = require('assert');
const chase = require('../chaseEngine');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const U = '33333333-3333-3333-3333-333333333333', U2 = '44444444-4444-4444-4444-444444444444';
process.env.MARGYN_DEMO_ACCOUNTS = U2;   // an investor demo tenant: external sends off

(async () => {
  await t('pickReminderItem: exact name first, books before a manual entry, then a name that contains the other', () => {
    const items = [
      { receivable_id: 'm1', party: 'Gupta Traders', amount: 90000, src: 'manual' },
      { receivable_id: 'z1', party: 'Gupta Traders', amount: 40000, src: 'zoho' },
      { receivable_id: 'z2', party: 'Iyer Retail Pvt Ltd', amount: 15000, src: 'zoho' },
      { receivable_id: 'z3', party: 'Paid Up', amount: 0, src: 'zoho' }
    ];
    assert.strictEqual(chase.pickReminderItem(items, 'gupta traders').receivable_id, 'z1');
    assert.strictEqual(chase.pickReminderItem(items, 'Iyer Retail').receivable_id, 'z2');
    assert.strictEqual(chase.pickReminderItem(items, 'Paid Up'), null, 'owes nothing');
    assert.strictEqual(chase.pickReminderItem(items, ''), null);
  });

  const DB = {
    profiles: [{ id: U, preferences: {}, whatsapp_phone: '+919000000001', company_name: 'Sharma Distributors' }],
    agent_deployments: [],
    zoho_organizations: [{ id: 'org1', user_id: U, status: 'active' }],
    zoho_invoices: [
      { invoice_id: 'i1', invoice_number: 'INV-000201', customer_name: 'Gupta Traders', balance: 200000, due_date: '2026-09-01', status: 'overdue' },
      { invoice_id: 'i2', invoice_number: 'INV-000202', customer_name: 'No Phone Co', balance: 30000, due_date: '2026-09-10', status: 'overdue' }
    ],
    ledger_parties: [{ id: 'p1', user_id: U, name: 'Gupta Traders', phone: '+919820012345', source: 'zoho' }],
    whatsapp_chase_targets: [], whatsapp_chases: [], receivables: [], tally_installs: [], odoo_connections: [], connector_logs: []
  };
  const gupshup = [];
  let seq = 0;
  global.fetch = async (url, opts = {}) => {
    const res = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
    const u = new URL(url);
    if (!/supabase/.test(u.host)) { gupshup.push({ url, body: opts.body }); return res({ status: 'submitted', messageId: 'wamid-' + gupshup.length }); }
    if (/\/auth\/v1\/user/.test(u.pathname)) return res({ id: /demo/.test(opts.headers.Authorization) ? U2 : U, email: 'owner@example.in' });
    const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?(.+)$/);
    if (m[1]) return res(m[2] === 'zoho_vitals' ? { connected: true, org_ref: 'org1' } : null);
    const table = m[2], method = opts.method || 'GET';
    if (method === 'POST') { const rows = JSON.parse(opts.body).map((r) => Object.assign({ id: table + '-' + (++seq) }, r)); (DB[table] = DB[table] || []).push(...rows); return res(rows); }
    if (method === 'PATCH') {
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
      for (const r of DB[table] || []) if (!id || r.id === id) Object.assign(r, JSON.parse(opts.body));
      return res([]);
    }
    let rows = DB[table] || [];
    const rid = u.searchParams.get('receivable_id');
    if (rid) rows = rows.filter((r) => r.receivable_id === rid.replace(/^eq\./, ''));
    if (table === 'zoho_invoices') rows = rows.filter((r) => r.balance > 0);
    return res(rows);
  };
  const handler = require('../../whatsapp.js');
  const call = (body, headers = { authorization: 'Bearer owner-token' }) => new Promise((resolve) => {
    const out = { headers: {} };
    const r = { status(c) { out.code = c; return r; }, json(b) { out.body = b; resolve(out); }, setHeader(k, v) { out.headers[k] = v; }, headersSent: false };
    handler({ query: { action: 'remind-now' }, method: 'POST', headers, body }, r);
  });

  await t('needs a signed-in user', async () => {
    const r = await call({ party: 'Gupta Traders' }, {});
    assert.strictEqual(r.code, 401);
  });

  await t('draft only: the exact reminder, the number it goes to (last 4), and nothing sent', async () => {
    const r = await call({ party: 'gupta traders' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.party, 'Gupta Traders');
    assert.strictEqual(r.body.amount, 200000);
    assert.strictEqual(r.body.phone_end, '2345');
    assert.ok(r.body.text.includes('Sharma Distributors') && r.body.text.includes('INV-000201') && r.body.text.includes('₹2,00,000'), r.body.text);
    assert.strictEqual(r.body.template_ready, true);
    assert.strictEqual(gupshup.length, 0, 'a draft never reaches WhatsApp');
    assert.strictEqual(DB.whatsapp_chase_targets.length, 0, 'a draft writes nothing');
  });

  await t('a customer with no WhatsApp number: the draft says so, a send asks for the number', async () => {
    const d = await call({ party: 'No Phone Co' });
    assert.strictEqual(d.body.has_phone, false);
    const s = await call({ party: 'No Phone Co', send: true });
    assert.strictEqual(s.code, 400);
    assert.strictEqual(s.body.error, 'need_phone');
    assert.strictEqual(gupshup.length, 0);
  });

  await t('someone who owes nothing: 404 in plain words', async () => {
    const r = await call({ party: 'Nobody Ltd' });
    assert.strictEqual(r.code, 404);
    assert.ok(/couldn.t find/.test(r.body.message));
  });

  await t('send (the owner tapped Send): one template to the customer, logged as a chase, target advanced', async () => {
    const r = await call({ party: 'Gupta Traders', send: true });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(gupshup.length, 1);
    const tg = DB.whatsapp_chase_targets[0];
    assert.strictEqual(tg.party_name, 'Gupta Traders');
    assert.strictEqual(tg.chases_sent, 1);
    assert.strictEqual(tg.next_chase_at, null, 'Chase is not switched on here, so nothing else is scheduled');
    const row = DB.whatsapp_chases[0];
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.chase_target_id, tg.id);
    assert.ok(row.message_body.includes('INV-000201'));
  });

  await t('demo account (external sends off): logged "Preview: not sent", nothing reaches the customer', async () => {
    const before = gupshup.length, rows = DB.whatsapp_chases.length;
    const r = await call({ party: 'Gupta Traders', send: true }, { authorization: 'Bearer demo-token' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.preview, true);
    assert.strictEqual(r.body.sent, false);
    assert.strictEqual(gupshup.length, before, 'blocked before WhatsApp');
    assert.strictEqual(DB.whatsapp_chases.length, rows + 1);
    assert.ok(chase.isPreviewChase(DB.whatsapp_chases[rows]), JSON.stringify(DB.whatsapp_chases[rows]));
  });

  await t('a customer the owner switched off is refused', async () => {
    DB.whatsapp_chase_targets[0].state = 'stopped';
    const before = gupshup.length;
    const r = await call({ party: 'Gupta Traders', send: true });
    assert.strictEqual(r.code, 409);
    assert.ok(/switched reminders off/.test(r.body.error), r.body.error);
    assert.strictEqual(gupshup.length, before);
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch((e) => { console.error(e); process.exit(1); });
