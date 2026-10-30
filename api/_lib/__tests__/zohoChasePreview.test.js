// Payment Chase on a Zoho-only account, and the demo preview (2026-10-29).
// Run: node api/_lib/__tests__/zohoChasePreview.test.js
// Zoho contacts -> party master (so Chase has numbers), Zoho receivables -> one chase per customer, a reminder drafted
// word for word, and on an account with external sends off: blocked, logged "Preview: not sent", cadence still moves.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
for (const n of ['pre_due', 'due_friendly', 'overdue_1_friendly', 'overdue_2_friendly', 'final']) process.env['WHATSAPP_TEMPLATE_CHASE_' + n.toUpperCase()] = 'tpl-' + n;
process.env.CRON_SECRET = 'cron';
const assert = require('assert');
const { contactToLedger, syncZohoPartyContacts } = require('../zohoParties');
const { planPartyWrites } = require('../tallyParties');
const chase = require('../chaseEngine');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const U = '22222222-2222-2222-2222-222222222222';

(async () => {
  await t('a Zoho contact maps to the party ledger shape (customer / vendor, phone, email)', () => {
    assert.deepStrictEqual(contactToLedger({ contact_id: 9, contact_name: 'Acme Retail', contact_type: 'customer', mobile: '98200 12345', email: 'ap@acme.in' }),
      { zoho_contact_id: '9', name: 'Acme Retail', type: 'customer', contact: { mobile: '98200 12345', email: 'ap@acme.in' } });
    assert.strictEqual(contactToLedger({ contact_id: 9, contact_name: 'Supplier', contact_type: 'vendor', phone: '022 2650 1100' }).type, 'vendor');
    assert.strictEqual(contactToLedger({ contact_id: 9, contact_name: 'No details', contact_type: 'customer' }), null, 'nothing to store');
    assert.strictEqual(contactToLedger({ contact_id: 9, contact_name: 'Odd', contact_type: 'employee', email: 'x@y.in' }), null);
    assert.strictEqual(contactToLedger({ contact_name: 'No id', contact_type: 'customer', email: 'x@y.in' }), null);
  });

  await t('Zoho contacts: new party as source=zoho with zoho_contact_id; a number the owner typed is never overwritten', () => {
    const existing = [{ id: 'p1', name: 'Bharat Traders', type: 'customer', phone: '+919999900000', email: null, external_refs: {} }];
    const ledgers = [
      contactToLedger({ contact_id: 1, contact_name: 'Acme Retail', contact_type: 'customer', mobile: '9820012345' }),
      contactToLedger({ contact_id: 2, contact_name: 'Bharat Traders Pvt Ltd', contact_type: 'customer', mobile: '9820099999', email: 'a@b.in' })
    ];
    const { inserts, updates } = planPartyWrites(ledgers, existing, U, { source: 'zoho', refKey: 'zoho_contact_id' });
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].source, 'zoho');
    assert.strictEqual(inserts[0].phone, '+919820012345');
    assert.deepStrictEqual(inserts[0].external_refs, { zoho_contact_id: '1' });
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].patch.phone, undefined, 'typed number kept');
    assert.strictEqual(updates[0].patch.email, 'a@b.in', 'blank email filled');
    assert.deepStrictEqual(updates[0].patch.external_refs, { zoho_contact_id: '2' });
  });

  await t('Tally planning is unchanged when no opts are passed', () => {
    const { inserts } = planPartyWrites([{ tally_guid: 'g1', name: 'X', primary_group: 'Sundry Debtors', contact: { mobile: '9820012345' } }], [], U);
    assert.strictEqual(inserts[0].source, 'tally');
    assert.deepStrictEqual(inserts[0].external_refs, { tally_guid: 'g1' });
  });

  await t('the contacts read pages until has_more_page is false, read only', async () => {
    const calls = [];
    const session = { apiGet: async (path, q) => {
      calls.push([path, q.page]);
      if (q.page === '1') return { contacts: [{ contact_id: 1, contact_name: 'A', contact_type: 'customer', mobile: '9820012345' }], page_context: { has_more_page: true } };
      return { contacts: [{ contact_id: 2, contact_name: 'B', contact_type: 'customer', email: 'b@b.in' }, { contact_id: 3, contact_name: 'C', contact_type: 'customer' }], page_context: { has_more_page: false } };
    } };
    let plan = null;
    const out = await syncZohoPartyContacts(session, U, { pause: 0, selectRows: async () => [], writePartyPlan: async (u, p) => { plan = p; return { inserted: p.inserts.length, updated: 0 }; } });
    assert.deepStrictEqual(calls, [['books/v3/contacts', '1'], ['books/v3/contacts', '2']]);
    assert.deepStrictEqual(out, { read: 3, with_details: 2, inserted: 2, updated: 0 }, 'with_details: the contacts the party master can save (data check)');
    assert.deepStrictEqual(plan.inserts.map((r) => r.name), ['A', 'B']);
  });

  await t('a failed contacts read never throws (the Zoho sync carries on)', async () => {
    const out = await syncZohoPartyContacts({ apiGet: async () => { throw new Error('boom'); } }, U, { pause: 0 });
    assert.strictEqual(out.error, 'boom');
  });

  await t('a reminder is drafted word for word, as the run would send it', () => {
    const p = chase.previewNextChase({ id: 't1', party_name: 'Acme Retail', contact_phone: '919820012345', amount: 125000, due_date: '2020-01-01', invoice_ref: 'INV-000123 + 2 more', chases_sent: 0 },
      { tone_preset: 'friendly' }, 'Margyn Demo');
    assert.strictEqual(p.chase_number, 1);
    assert.strictEqual(p.has_phone, true);
    assert.ok(/^Hi, (a gentle nudge|following up)/.test(p.body) && p.body.includes('Margyn Demo') && p.body.includes('INV-000123 + 2 more') && p.body.includes('₹1,25,000'), p.body);
    assert.ok(!('contact_phone' in p), 'the preview never carries the customer number');
    assert.ok(chase.isPreviewChase({ wa_message_id: 'preview-not-sent' }) && chase.isPreviewChase({ error: chase.PREVIEW_NOTE }) && !chase.isPreviewChase({ status: 'sent', wa_message_id: 'abc' }));
  });

  // ---- the whole path through api/whatsapp.js with a fake Supabase + Gupshup ----
  const DB = {
    profiles: [{ id: U, preferences: { external_sends: 'off' }, whatsapp_phone: '+919000000001', company_name: 'Margyn Demo' }],
    agent_deployments: [{ user_id: U, status: 'active', config: { enabled: true, include_connectors: true, tone_preset: 'friendly' } }],
    zoho_organizations: [{ id: 'org1', user_id: U, status: 'active' }],
    zoho_invoices: [
      { invoice_id: 'i1', invoice_number: 'INV-000101', customer_name: 'Acme Retail', balance: 50000, due_date: '2026-09-01', status: 'overdue' },
      { invoice_id: 'i2', invoice_number: 'INV-000102', customer_name: 'Acme Retail', balance: 25000, due_date: '2026-09-15', status: 'overdue' }
    ],
    ledger_parties: [{ id: 'p1', user_id: U, name: 'Acme Retail', phone: '+919820012345', source: 'zoho' }],
    whatsapp_chase_targets: [], whatsapp_chases: [], receivables: [], tally_installs: [], odoo_connections: []
  };
  const gupshup = [];
  let seq = 0;
  global.fetch = async (url, opts = {}) => {
    const res = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
    const u = new URL(url);
    if (!/supabase/.test(u.host)) { gupshup.push(url); return res({ status: 'submitted', messageId: 'real' }); }
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
    const st = u.searchParams.get('state');
    if (st && st.startsWith('in.(')) rows = rows.filter((r) => st.slice(4, -1).split(',').includes(r.state));
    if (table === 'zoho_invoices') rows = rows.filter((r) => r.balance > 0);
    return res(rows);
  };
  const handler = require('../../whatsapp.js');
  const call = (query, headers = {}) => new Promise((resolve) => {
    const out = { headers: {} };
    const r = { status(c) { out.code = c; return r; }, json(b) { out.body = b; resolve(out); }, setHeader(k, v) { out.headers[k] = v; }, headersSent: false };
    handler({ query, method: 'GET', headers }, r);
  });

  await t('Zoho receivables become one chase target per customer, with the number from Zoho contacts', async () => {
    const q = await handler._syncChaseQueue(U, DB.agent_deployments[0].config);
    assert.strictEqual(q.created, 1, JSON.stringify(q));
    const tg = DB.whatsapp_chase_targets[0];
    assert.strictEqual(tg.party_name, 'Acme Retail');
    assert.strictEqual(tg.amount, 75000);
    assert.strictEqual(tg.invoice_ref, 'INV-000101 + 1 more');
    assert.ok(tg.contact_phone && tg.next_chase_at, 'has a number, so it is scheduled');
    tg.next_chase_at = new Date(Date.now() - 60000).toISOString();   // due now
  });

  await t('demo account (external sends off): the cron sends nothing to the customer, logs "Preview: not sent", moves the cadence', async () => {
    const out = await call({ action: 'cron-chase' }, { authorization: 'Bearer cron' });
    assert.strictEqual(out.code, 200, JSON.stringify(out.body));
    assert.strictEqual(gupshup.length, 0, 'nothing reached Gupshup');
    assert.strictEqual(out.body.sent, 0);
    assert.strictEqual(out.body.previewed, 1, JSON.stringify(out.body));
    const row = DB.whatsapp_chases[0];
    assert.strictEqual(row.status, 'skipped');
    assert.ok(chase.isPreviewChase(row), JSON.stringify(row));
    assert.ok(row.message_body.includes('INV-000101 + 1 more'), 'the drafted body is kept for the timeline');
    const tg = DB.whatsapp_chase_targets[0];
    assert.strictEqual(tg.chases_sent, 1, 'cadence moved on');
    assert.ok(tg.last_chase_at);
  });

  await t('chase-preview needs a signed-in user', async () => {
    const r = await new Promise((resolve) => {
      const out = {}; const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; resolve(out); }, setHeader() {} };
      handler({ query: { action: 'chase-preview' }, method: 'POST', headers: {} }, res);
    });
    assert.strictEqual(r.code, 401);
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch((e) => { console.error(e); process.exit(1); });
