// "Chase Centaur" on WhatsApp for a Tally-only owner (2026-11-23).
// Run: node api/_lib/__tests__/chaseTallyWhatsapp.test.js
//
// 5 Oct 2026: Care Hygiene was offered a chase on Centaur Pharmaceuticals (₹17.2 L overdue, from Tally), said
// "Yes", and got "Centaur isn't on Margyn's reminder list ... read-only", then "no AR contact saved". Now:
//   (a) a Tally customer with a phone in ledger_parties gets ONE approved chase template after the owner's tap;
//   (b) no number -> no card, one plain message saying what's missing and the one step to add it;
//   (c) payment reminders switched off -> it says so and offers the switch, never a dead end.
// Everything here is fake: an in-memory Supabase and a fake Gupshup. Nothing reaches a real customer.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.GUPSHUP_API_KEY = 'k'; process.env.GUPSHUP_SOURCE_NUMBER = '919000000000'; process.env.GUPSHUP_APP_NAME = 'margyn';
for (const n of ['pre_due', 'due_friendly', 'overdue_1_friendly', 'overdue_2_friendly', 'final']) process.env['WHATSAPP_TEMPLATE_CHASE_' + n.toUpperCase()] = 'tpl-' + n;
const U = '55555555-5555-5555-5555-555555555555', DEMO = '66666666-6666-6666-6666-666666666666';
process.env.MARGYN_DEMO_ACCOUNTS = DEMO;
const assert = require('assert');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

// The reconciled receivables (moneyModel.position) as Tally gives them: one group per customer.
const grp = (party, rows) => ({ key: party.toLowerCase(), party, primary: 'tally', sources: ['tally'], by: { tally: { rows: rows.map((r) => Object.assign({ party, src: 'tally' }, r)) } } });
const GROUPS = [
  grp('Centaur Pharmaceuticals', [{ amount: 1200000, due: '2026-08-10', ref: 'CH/0412' }, { amount: 520000, due: '2026-09-01', ref: 'CH/0450' }]),
  grp('Nophone Labs', [{ amount: 80000, due: '2026-08-20', ref: 'CH/0420' }]),
  grp('Landline Traders', [{ amount: 45000, due: '2026-08-25', ref: 'CH/0431' }])
];
const moneyModel = require('../moneyModel');
moneyModel.positionForAccount = async () => ({ receivables: { groups: GROUPS, errors: {}, coverage: { tally: true } } });

const freshDB = () => ({
  profiles: [{ id: U, preferences: {}, whatsapp_phone: '+919000000001', company_name: 'Hygiene Test Co' },
    { id: DEMO, preferences: {}, whatsapp_phone: '+919000000002', company_name: 'Demo Co' }],
  agent_deployments: [],
  ledger_parties: [
    { id: 'p1', user_id: U, name: 'Centaur Pharmaceuticals Pvt Ltd', phone: '+919820012345', source: 'tally' },
    { id: 'p2', user_id: U, name: 'Nophone Labs', phone: null, source: 'tally' },
    { id: 'p3', user_id: U, name: 'Landline Traders', phone: '022 2345 6789', source: 'tally' },
    { id: 'p4', user_id: DEMO, name: 'Centaur Pharmaceuticals', phone: '+919820012345', source: 'tally' }
  ],
  whatsapp_chase_targets: [], whatsapp_chases: [], whatsapp_pending_actions: [], connector_logs: [], wa_deliveries: []
});
let DB = freshDB();
const gupshup = [];
let seq = 0;
const eqv = (v) => String(v || '').replace(/^eq\./, '');
global.fetch = async (url, opts = {}) => {
  const res = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
  const u = new URL(url);
  if (!/supabase/.test(u.host)) { gupshup.push({ url, body: String(opts.body || '') }); return res({ status: 'submitted', messageId: 'wamid-' + gupshup.length }); }
  const table = u.pathname.replace('/rest/v1/', ''), method = opts.method || 'GET';
  const match = (r) => {
    for (const [k, v] of u.searchParams) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      if (k === 'or') { const ids = [...v.matchAll(/\.eq\.([^,)]+)/g)].map((m) => m[1]); if (!ids.includes(r.id) && !ids.includes(r.receivable_id)) return false; continue; }
      if (/^eq\./.test(v) && String(r[k]) !== eqv(v)) return false;
    }
    return true;
  };
  if (method === 'POST') { const rows = JSON.parse(opts.body).map((r) => Object.assign({ id: table === 'whatsapp_chase_targets' ? '77777777-0000-4000-a000-00000000000' + (++seq % 10) : table + '-' + (++seq) }, r)); (DB[table] = DB[table] || []).push(...rows); return res(rows); }
  if (method === 'PATCH') { for (const r of DB[table] || []) if (match(r)) Object.assign(r, JSON.parse(opts.body)); return res([]); }
  return res((DB[table] || []).filter(match));
};

const sendGuard = require('../sendGuard');
const MA = require('../marginActions');
const RC = require('../remindCustomer');
const on = () => { DB.agent_deployments = [{ user_id: U, agent_id: 'chase_agent', status: 'active', config: { enabled: true, include_connectors: true } }]; };
const paused = () => { DB.agent_deployments = [{ user_id: U, agent_id: 'chase_agent', status: 'paused', config: { enabled: true, include_connectors: true } }]; };
const propose = (party, extra) => Object.assign({ type: 'send_one_off_chase', target_id: party, human_summary: 'Chase ' + party }, extra || {});
const pendingOf = (p, userId) => ({ id: 'pa-' + (++seq), user_id: userId || U, action_type: p.type, target_id: p.target_id || null, target_kind: null, payload: p.payload || {}, human_summary: p.human_summary, status: 'pending' });
// The webhook runs every inbound event inside sendGuard.inRequest + markAccount; the tap does too.
const tap = (pending, confirmed) => sendGuard.inRequest(async () => { await sendGuard.markAccount(pending.user_id); return MA.resolvePendingAction(pending, confirmed, { name: 'Owner', channel: 'whatsapp' }); });

(async () => {
  await t('waNumber: Indian mobiles in any shape become 91…; landlines and short numbers are not WhatsApp numbers', () => {
    assert.strictEqual(RC.waNumber('+91 98200 12345'), '919820012345');
    assert.strictEqual(RC.waNumber('98200-12345'), '919820012345');
    assert.strictEqual(RC.waNumber('09820012345'), '919820012345');
    assert.strictEqual(RC.waNumber('022 2345 6789'), null);
    assert.strictEqual(RC.waNumber('12345'), null);
    assert.strictEqual(RC.waNumber(''), null);
    assert.strictEqual(RC.waNumber('+44 7700 900123'), '447700900123');
  });

  await t('5 Oct replay, reminders paused: no dead end, the card offered is the switch (nothing sent)', async () => {
    paused();
    const r = await MA.validateProposal(propose('Centaur'), U);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.proposal.type, 'resume_chase_agent');
    assert.ok(/switch payment reminders back on/.test(r.proposal.human_summary), r.proposal.human_summary);
    assert.ok(/Centaur Pharmaceuticals/.test(r.proposal.human_summary));
    assert.ok(!/read-only|reminder list|AR contact/i.test(r.proposal.human_summary));
    assert.strictEqual(gupshup.length, 0);
  });

  await t('reminders switched on from that card: deployment active (and enabled), the reply says to ask again', async () => {
    paused(); DB.agent_deployments[0].config.enabled = false;
    const r = await MA.validateProposal(propose('Centaur'), U);
    const out = await tap(pendingOf(r.proposal), true);
    assert.strictEqual(out.executed, true, JSON.stringify(out));
    assert.strictEqual(DB.agent_deployments[0].status, 'active');
    assert.strictEqual(DB.agent_deployments[0].config.enabled, true);
    assert.ok(/reminders are on again/.test(out.reply) && /remind Centaur Pharmaceuticals/.test(out.reply), out.reply);
    assert.strictEqual(gupshup.length, 0, 'switching on sends no reminder by itself');
  });

  await t('reminders never set up: one plain message with the one step, no card', async () => {
    DB.agent_deployments = [];
    const r = await MA.validateProposal(propose('Centaur'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/aren't switched on/.test(r.message) && /Automations > Roster > Payment Chase/.test(r.message), r.message);
  });

  await t('a resume card when nothing was ever deployed says so, never "Done"', async () => {
    DB.agent_deployments = [];
    const out = await tap(pendingOf({ type: 'resume_chase_agent', human_summary: 'switch on' }), true);
    assert.strictEqual(out.ok, false);
    assert.ok(/never set up/.test(out.userMessage), out.userMessage);
  });

  await t('(a) reminders on + Tally customer with a phone: a Confirm card with amount, number end and the exact words', async () => {
    on();
    const r = await MA.validateProposal(propose('centaur'), U);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const p = r.proposal;
    assert.strictEqual(p.type, 'send_one_off_chase');
    assert.strictEqual(p.payload.party, 'Centaur Pharmaceuticals');
    assert.ok(/^[0-9a-f-]{36}$/.test(p.target_id), p.target_id);
    assert.ok(p.human_summary.includes('₹17,20,000') && p.human_summary.includes('ending 2345') && p.human_summary.includes('CH/0412 + 1 more'), p.human_summary);
    assert.ok(p.human_summary.includes('Hygiene Test Co'), 'the template body is shown');
    assert.strictEqual(gupshup.length, 0, 'a card sends nothing');
    assert.strictEqual(DB.whatsapp_chase_targets.length, 0, 'a card writes nothing');
  });

  await t('(a) the owner taps Confirm: ONE approved template to the customer, logged as a chase, honest reply', async () => {
    on();
    const r = await MA.validateProposal(propose('Centaur'), U);
    const out = await tap(pendingOf(r.proposal), true);
    assert.strictEqual(out.executed, true, JSON.stringify(out));
    assert.strictEqual(gupshup.length, 1);
    const body = decodeURIComponent(gupshup[0].body);
    assert.ok(/tpl-/.test(body) && body.includes('919820012345'), body);
    assert.ok(!/following up on invoice/.test(body), 'never the old free-text message');
    const row = DB.whatsapp_chases[0];
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.channel, 'whatsapp_template');
    const tg = DB.whatsapp_chase_targets[0];
    assert.strictEqual(tg.party_name, 'Centaur Pharmaceuticals');
    assert.strictEqual(tg.chases_sent, 1);
    assert.strictEqual(tg.state, 'active', 'not parked as escalated_human like the old one-off');
    assert.ok(/^Sent ✅ Centaur Pharmaceuticals/.test(out.reply), out.reply);
  });

  await t('a second "chase Centaur" the same day: no card, it says they were already reminded', async () => {
    const before = gupshup.length;
    const r = await MA.validateProposal(propose('Centaur'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/already reminded/.test(r.message), r.message);
    assert.strictEqual(gupshup.length, before);
  });

  await t('(b) no number for the customer: no card; says what is missing and the one step (app, or Tally ledger)', async () => {
    on();
    const r = await MA.validateProposal(propose('Nophone Labs'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/no WhatsApp number/.test(r.message), r.message);
    assert.ok(/Customers > Nophone Labs > Edit/.test(r.message) && /Tally/.test(r.message), r.message);
    assert.ok(!/also switched off/.test(r.message));
  });

  await t('(b)+(c) no number and reminders off: both said in one message', async () => {
    paused();
    const r = await MA.validateProposal(propose('Nophone Labs'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/no WhatsApp number/.test(r.message) && /also switched off/.test(r.message), r.message);
  });

  await t('(b) a landline saved: says it isn\'t a mobile instead of failing at WhatsApp', async () => {
    on();
    const r = await MA.validateProposal(propose('Landline Traders'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/doesn't look like a mobile/.test(r.message), r.message);
  });

  await t('someone who owes nothing: plain message, no card', async () => {
    const r = await MA.validateProposal(propose('Nobody Enterprises'), U);
    assert.strictEqual(r.ok, false);
    assert.ok(/couldn't find anything Nobody Enterprises owes/.test(r.message), r.message);
  });

  await t('reminders switched off between the card and the tap: nothing sent, the reply says why', async () => {
    DB = freshDB(); on();
    const r = await MA.validateProposal(propose('Centaur'), U);
    paused();
    const before = gupshup.length;
    const out = await tap(pendingOf(r.proposal), true);
    assert.strictEqual(out.ok, false);
    assert.ok(/switched off/.test(out.userMessage) && /Nothing was sent/.test(out.userMessage), out.userMessage);
    assert.strictEqual(gupshup.length, before);
  });

  await t('Cancel sends nothing', async () => {
    on();
    const r = await MA.validateProposal(propose('Centaur'), U);
    const before = gupshup.length;
    const out = await tap(pendingOf(r.proposal), false);
    assert.strictEqual(out.executed, false);
    assert.strictEqual(gupshup.length, before);
  });

  await t('an older card (Chase row id, no party in payload) still resolves to its customer', async () => {
    DB = freshDB(); on();
    DB.whatsapp_chase_targets.push({ id: '88888888-0000-4000-a000-000000000001', user_id: U, receivable_id: null, party_name: 'Centaur Pharmaceuticals', contact_phone: '919820012345', state: 'active', chases_sent: 0 });
    const r = await MA.validateProposal({ type: 'send_one_off_chase', target_id: '88888888-0000-4000-a000-000000000001', human_summary: 'x' }, U);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.proposal.payload.party, 'Centaur Pharmaceuticals');
  });

  await t('demo account (external sends off): the tap logs "Preview: not sent" and says so', async () => {
    DB = freshDB();
    DB.agent_deployments = [{ user_id: DEMO, agent_id: 'chase_agent', status: 'active', config: { enabled: true } }];
    const r = await MA.validateProposal(propose('Centaur'), DEMO);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(/Preview only/.test(r.proposal.human_summary), r.proposal.human_summary);
    const before = gupshup.length;
    const out = await tap(pendingOf(r.proposal, DEMO), true);
    assert.strictEqual(gupshup.length, before, 'blocked before WhatsApp');
    assert.ok(/^Preview only/.test(out.reply), out.reply);
    assert.strictEqual(DB.whatsapp_chases[0].status, 'skipped');
  });

  await t('list_chase_targets(party_query) answers for a Tally customer with no Chase row: reminder_check', async () => {
    DB = freshDB(); paused();
    const r = await MA.execReadTool('list_chase_targets', { party_query: 'Centaur' }, U);
    assert.strictEqual(r.targets.length, 0);
    const c = r.reminder_check;
    assert.strictEqual(c.found, true);
    assert.strictEqual(c.owes, 1720000);
    assert.strictEqual(c.has_whatsapp_number, true);
    assert.strictEqual(c.can_remind, false);
    assert.strictEqual(c.missing, 'paused');
    assert.ok(/resume_chase_agent/.test(c.offer));
    on();
    const r2 = await MA.execReadTool('list_chase_targets', { party_query: 'Centaur' }, U);
    assert.strictEqual(r2.reminder_check.can_remind, true);
    const r3 = await MA.execReadTool('list_chase_targets', { party_query: 'Nophone' }, U);
    assert.strictEqual(r3.reminder_check.can_remind, false);
    assert.ok(/no WhatsApp number/.test(r3.reminder_check.say));
  });

  await t('web chat works the same as WhatsApp: same card for a Tally customer, same refusals, nothing sent by the card', async () => {
    DB = freshDB(); on();
    const before = gupshup.length;
    const r = await MA.validateProposal(propose('Centaur'), U, { channel: 'web' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.proposal.type, 'send_one_off_chase');
    assert.strictEqual(r.proposal.payload.party, 'Centaur Pharmaceuticals', 'the app posts this name to remind-now');
    assert.ok(/^Send Centaur Pharmaceuticals one WhatsApp payment reminder for ₹17,20,000/.test(r.proposal.human_summary), r.proposal.human_summary);
    const wa = await MA.validateProposal(propose('Centaur'), U);
    assert.strictEqual(r.proposal.human_summary.slice(1), wa.proposal.human_summary.slice(1), 'same words, only the first letter differs');
    const np = await MA.validateProposal(propose('Nophone Labs'), U, { channel: 'web' });
    assert.strictEqual(np.ok, false);
    assert.ok(/no WhatsApp number/.test(np.message), np.message);
    paused();
    const off = await MA.validateProposal(propose('Centaur'), U, { channel: 'web' });
    assert.strictEqual(off.proposal.type, 'resume_chase_agent');
    assert.ok(/^Switch payment reminders back on/.test(off.proposal.human_summary), off.proposal.human_summary);
    assert.strictEqual(gupshup.length, before);
  });

  await t('a one-off to a books customer on an account whose Chase doesn\'t cover books schedules no automatic follow-up', async () => {
    DB = freshDB();
    DB.agent_deployments = [{ user_id: U, agent_id: 'chase_agent', status: 'active', config: { enabled: true } }];
    const r = await MA.validateProposal(propose('Centaur'), U);
    const out = await tap(pendingOf(r.proposal), true);
    assert.strictEqual(out.executed, true, JSON.stringify(out));
    assert.strictEqual(DB.whatsapp_chase_targets[0].next_chase_at, null);
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch((e) => { console.error(e); process.exit(1); });
