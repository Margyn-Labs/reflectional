/** Run: node api/_lib/__tests__/whatsappThread.test.js — whose history a WhatsApp reply reads, and bursts. No network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };

const ACCT = '11111111-1111-4111-8111-111111111111';
const ROWS = [
  { role: 'user', content: 'owner old: who are you?', from_phone: null, created_at: '2026-09-01T10:00:00Z' },
  { role: 'assistant', content: 'I don\'t know who you are. Shall I mark Meridian Fitness paid?', from_phone: null, created_at: '2026-09-01T10:00:05Z' },
  { role: 'assistant', content: 'Hi Varad, I\'m Margyn. Welcome update.', from_phone: '919833007845', created_at: '2026-11-21T12:38:15Z' },
  { role: 'user', content: 'To', from_phone: '919833007845', created_at: '2026-11-21T12:40:32Z' },
  { role: 'user', content: 'Yo', from_phone: '919833007845', created_at: '2026-11-21T12:40:33Z' },
  { role: 'user', content: 'You\'re great', from_phone: '919833007845', created_at: '2026-11-21T12:40:37Z' }
];
const seen = [];
global.fetch = async (url) => {
  const u = new URL(url);
  seen.push(decodeURIComponent(u.search));
  let rows = ROWS.slice();
  const fp = u.searchParams.get('from_phone'), or = u.searchParams.get('or'), gt = u.searchParams.get('created_at'), role = u.searchParams.get('role');
  if (fp && fp.startsWith('eq.')) rows = rows.filter((r) => r.from_phone === fp.slice(3));
  if (or) { const p = /from_phone\.eq\.(\d+)/.exec(or)[1]; rows = rows.filter((r) => r.from_phone === p || r.from_phone == null); }
  if (role) rows = rows.filter((r) => r.role === role.slice(3));
  if (gt && gt.startsWith('gt.')) rows = rows.filter((r) => r.created_at > decodeURIComponent(gt.slice(3)));
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
};
const A = require('../whatsappAgent');

(async () => {
  console.log('whose history');
  let m = await A.buildMessages(ACCT, '919833007845', 'You\'re great', { legacy: false });
  const all = JSON.stringify(m);
  check('a team member\'s number never reads the owner\'s old chat', !/Meridian|who are you/.test(all), m);
  check('...but reads its own thread, including what Margyn sent first', /Welcome update/.test(all) && /To\\nYo/.test(all) && m[0].role === 'user' && /messaged this number first/.test(m[0].content) && m[1].role === 'assistant', m);
  check('roles alternate', m.every((x, i) => i === 0 || x.role !== m[i - 1].role), m.map((x) => x.role));
  check('the burst is one turn ending with the newest message', m[m.length - 1].content === 'To\nYo\nYou\'re great', m[m.length - 1]);
  m = await A.buildMessages(ACCT, '919800000099', 'hi', { legacy: true });
  check('the owner\'s number still reads its old, number-less history', /Meridian/.test(JSON.stringify(m)));
  m = await A.buildMessages(ACCT, '919833007845', 'hi');
  check('default (no sender info) stays as before', /Meridian/.test(JSON.stringify(m)));

  console.log('bursts');
  const first = ROWS[3], last = ROWS[5];
  check('"To" then "Yo" a second later: "To" lets "Yo" answer', await A.newerFromSameNumber(ACCT, '919833007845', first, 5) === true);
  check('the last one in the burst answers', await A.newerFromSameNumber(ACCT, '919833007845', last, 5) === false);
  check('no saved row (old database): answers as before', await A.newerFromSameNumber(ACCT, '919833007845', null, 5) === false);
  check('wait switched off: answers straight away', await A.newerFromSameNumber(ACCT, '919833007845', first, 0) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
