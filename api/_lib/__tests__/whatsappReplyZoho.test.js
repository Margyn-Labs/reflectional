/** Run: node api/_lib/__tests__/whatsappReplyZoho.test.js
 * A question sent as a reply to an update gets its own fresh answer, never the saved full update, on a Zoho
 * account and from a team member's number too (the 22 Nov 2026 investor case: "how much are we getting this
 * month?" first got the whole welcome update). Runs runConversation itself with the network stubbed. No sends. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.WA_BURST_MS = '0';
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n)); };

// Stub the network: Supabase reads answer empty, the model call fails (we only care what happens before it).
let BOOKS = 'zoho';
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/zoho_organizations')) return { ok: true, status: 200, json: async () => (BOOKS === 'zoho' ? [{ status: 'active' }] : []), text: async () => '[]', headers: { get: () => null } };
  if (u.includes('/tally_installs')) return { ok: true, status: 200, json: async () => (BOOKS === 'tally' ? [{ status: 'active' }] : []), text: async () => '[]', headers: { get: () => null } };
  if (u.includes('anthropic')) return { ok: false, status: 500, json: async () => ({}), text: async () => 'stub' };
  return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
};
const sent = [];
const bsp = require('../whatsappBsp');
bsp.sendText = async ({ to, text }) => { sent.push({ to, text }); return { ok: true }; };
const watch = require('../margynWatch');
let taken = 0;
watch.takePending = async () => { taken++; return { text: 'SAVED FULL UPDATE', user_id: 'demo-owner' }; };
const A = require('../whatsappAgent');

const DEMO = 'demo-owner';            // a Zoho account (source never enters this decision)
const MEMBER_PHONE = '919800000001';  // a team member's linked number (fake)
const member = { id: 'stake-1', name: 'Test Member', role: 'finance', is_primary: false };
const owner = { id: 'stake-0', name: 'Owner', role: 'owner', is_primary: true };

async function run(text, sender, phone) {
  taken = 0; sent.length = 0;
  try { await A.runConversation({ profileId: DEMO, fromPhone: phone, sender, canAct: false, text, wamid: 'w' + Math.random() }); } catch (e) { /* model stub fails after the gate */ }
  return { taken, gotSaved: sent.some((s) => s.text === 'SAVED FULL UPDATE') };
}

(async () => {
  const questions = ['how much are we getting this month?', 'how much are we getting this month', 'Who owes me the most?',
    "What's my cash?", 'What will cash be in 4 weeks?', 'Which customers are late?', 'collections this month', 'kitna aana hai is mahine'];
  for (const [who, sender, phone] of [['team member', member, MEMBER_PHONE], ['owner', owner, '919800000002']]) {
    for (const q of questions) {
      const r = await run(q, sender, phone);
      check(`${who} on Zoho: "${q}" → fresh answer, saved update not sent`, r.taken === 0 && !r.gotSaved);
    }
    for (const t of ['See details', 'Yes', 'ok']) {
      const r = await run(t, sender, phone);
      check(`${who} on Zoho: "${t}" → saved update sent`, r.taken === 1 && r.gotSaved);
    }
  }
  // Tally accounts (Mihir) keep the 23 Nov rule byte-for-byte: a short topic reply still opens the saved update.
  BOOKS = 'tally';
  for (const q of ['collections this month', 'cash position']) {
    const r = await run(q, owner, '919800000003');
    check(`Tally unchanged: "${q}" → saved update sent as before`, r.taken === 1 && r.gotSaved);
  }
  for (const q of ['What is my total sales for this year?', 'Yes']) {
    const r = await run(q, owner, '919800000003');
    check(`Tally unchanged: "${q}"`, q === 'Yes' ? r.gotSaved : (r.taken === 0 && !r.gotSaved));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
