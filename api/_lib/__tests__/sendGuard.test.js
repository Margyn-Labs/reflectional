// No external sends in demo mode. Run: node api/_lib/__tests__/sendGuard.test.js
const assert = require('assert');
let calls = 0;
global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
process.env.WHATSAPP_BSP = 'gupshup';
process.env.GUPSHUP_API_KEY = 'k'; process.env.GUPSHUP_APP_NAME = 'a'; process.env.GUPSHUP_SOURCE_NUMBER = '911234567890';
const bsp = require('../whatsappBsp');
(async () => {
  process.env.MARGYN_EXTERNAL_SENDS = 'off';
  for (const r of [await bsp.sendTemplate({ to: '919800000000', templateId: 't', params: [] }),
                   await bsp.sendText({ to: '919800000000', text: 'hi' }),
                   await bsp.sendButtons({ to: '919800000000', text: 'hi', buttons: [] })]) {
    assert.strictEqual(r.blocked, true); assert.strictEqual(r.ok, true);
  }
  assert.strictEqual(calls, 0, 'env flag: nothing reaches the provider');
  delete process.env.MARGYN_EXTERNAL_SENDS;
  const r = await bsp.sendText({ to: '919800000000', text: 'hi', dryRun: true });
  assert.strictEqual(r.preview, true); assert.strictEqual(calls, 0, 'dryRun: nothing reaches the provider');
  await bsp.sendText({ to: '919800000000', text: 'hi' });
  assert.strictEqual(calls, 1, 'flag off: send goes through');
  // team invite email path
  process.env.SUPABASE_URL = 'https://t.supabase.co'; process.env.RESEND_API_KEY = 'r';
  const guard = require('../sendGuard');
  process.env.MARGYN_EXTERNAL_SENDS = 'off';
  assert.strictEqual(guard.sendsBlocked(), true);
  assert.strictEqual(guard.maskDest('a@b.com'), 'a***@b.com');
  console.log('sendGuard ok');
})().catch((e) => { console.error(e); process.exit(1); });
(async () => {
  const cfo = require('../cfoPack');
  let hit = 0;
  process.env.MARGYN_EXTERNAL_SENDS = 'off'; process.env.RESEND_API_KEY = 'r';
  const id = await cfo.sendViaResend(async () => { hit++; return { ok: true, json: async () => ({ id: 'x' }) }; }, { to: 'a@b.com', subject: 's', html: 'h', text: 't' });
  assert.strictEqual(hit, 0); assert.strictEqual(id, 'preview-not-sent');
  console.log('resend guard ok');
})().catch((e) => { console.error(e); process.exit(1); });

(async () => {
  // Per account: a demo tenant (profiles.preferences.external_sends = 'off') sends nothing, a normal account does.
  await new Promise((r) => setTimeout(r, 50));
  delete process.env.MARGYN_EXTERNAL_SENDS;
  process.env.SUPABASE_URL = 'https://t.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 's';
  const guard = require('../sendGuard');
  guard._clearCache();
  let gupshup = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/profiles')) {
      const demo = u.includes('id=eq.demo-1');
      return { ok: true, status: 200, json: async () => [{ preferences: demo ? { external_sends: 'off' } : {}, whatsapp_phone: demo ? '+91 98000 00099' : null }], text: async () => '[]' };
    }
    gupshup++;
    return { ok: true, status: 200, json: async () => ({ status: 'submitted', messageId: 'm' }), text: async () => '{}' };
  };
  const bsp2 = require('../whatsappBsp');
  const deep = () => bsp2.sendText({ to: '919800000001', text: 'hi' });   // no flag passed anywhere
  const a = await guard.runAsAccount('demo-1', () => deep());
  assert.strictEqual(a.blocked, true); assert.strictEqual(gupshup, 0, 'demo tenant: nothing reaches the provider');
  await guard.runAsAccount('real-1', () => deep());
  assert.strictEqual(gupshup, 1, 'normal account: send goes through');
  // A request that learns its account part-way (inbound webhook).
  const b = await guard.inRequest(async () => { await guard.markAccount('demo-1'); return deep(); });
  assert.strictEqual(b.blocked, true); assert.strictEqual(gupshup, 1, 'webhook for a demo tenant: blocked after markAccount');
  process.env.MARGYN_DEMO_ACCOUNTS = 'listed-1'; guard._clearCache();
  const c = await guard.runAsAccount('listed-1', () => deep());
  assert.strictEqual(c.blocked, true); assert.strictEqual(gupshup, 1, 'MARGYN_DEMO_ACCOUNTS: blocked');
  guard._clearCache(); delete process.env.MARGYN_DEMO_ACCOUNTS;
  const own = await guard.runAsAccount('demo-1', () => bsp2.sendText({ to: '919800000099', text: 'your update' }));
  assert.ok(!own.blocked); assert.strictEqual(gupshup, 2, "demo tenant: the owner's own WhatsApp still gets replies and updates");
  console.log('per-account guard ok');
})().catch((e) => { console.error(e); process.exit(1); });
