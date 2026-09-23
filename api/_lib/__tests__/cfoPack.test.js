/**
 * CFO pack delivery — zero-dep. Run: node api/_lib/__tests__/cfoPack.test.js
 * No network: selectRows / insertRows / fetch are in-memory fakes.
 */
process.env.RESEND_API_KEY = 'test-key';
process.env.CFO_PACK_FROM = 'Margyn <reports@margynlabs.com>';
const P = require('../cfoPack');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail) : '')); }
}

/* dates */
check('previous period in IST: 1 Oct 00:10 IST -> 2026-09', P.previousPeriod(new Date('2026-09-30T18:40:00Z')) === '2026-09');
check('previous period: 30 Sep 23:00 IST -> 2026-08', P.previousPeriod(new Date('2026-09-30T17:30:00Z')) === '2026-08');
check('January -> previous December', P.previousPeriod(new Date('2027-01-05T06:00:00Z')) === '2026-12');
const b = P.periodBounds('2026-09');
check('IST month bounds', b.start === '2026-08-31T18:30:00.000Z' && b.end === '2026-09-30T18:30:00.000Z', b);

/* config */
const cfg = P.packConfig({ cfo_pack: { enabled: true, day_of_month: 40, recipients: [
  { name: 'A', email: 'a@x.in' }, { name: 'dup', email: 'A@X.IN' }, { name: 'bad', email: 'not-an-email' }, { email: 'b@y.co' }] } });
check('day clamped to 28, bad and duplicate emails dropped', cfg.day === 28 && cfg.recipients.map((r) => r.email).join() === 'a@x.in,b@y.co', cfg);
check('disabled by default', P.packConfig({}).enabled === false);
check('due once the day has come', P.isDue({ enabled: true, day: 3, recipients: [1] }, new Date('2026-10-05T04:00:00Z')) && !P.isDue({ enabled: true, day: 7, recipients: [1] }, new Date('2026-10-05T04:00:00Z')));

/* email */
const snap = { created_at: '2026-09-29T06:00:00Z', cash: 18400000, revenue: 25600000, net_profit: 1820000, recv_total: 31200000, recv_90: 4600000, pay_soon: 8900000, gst_payable: 3100000, pulse_score: 64, briefing: 'Collections are the story <b>this</b> month.' };
const prev = { cash: 16900000, revenue: 24100000, net_profit: 1640000, recv_total: 29400000, recv_90: 3900000, pay_soon: 8200000, gst_payable: 2950000, pulse_score: 61 };
const m = P.buildEmail({ company: 'Anvaya Home Goods', period: '2026-09', snap, prev, link: 'https://www.margynlabs.com/app.html#/cfo-pack?period=2026-09', recipientName: 'Ravi' });
check('subject', m.subject === 'September 2026 CFO pack · Anvaya Home Goods', m.subject);
check('scope line with closing reading date', m.html.includes('Anvaya Home Goods · Reconciled · September 2026 · closing reading 29 Sep 2026'));
check('full Indian grouping', m.html.includes('1,84,00,000') && m.text.includes('₹1,84,00,000'));
check('briefing escaped and labelled', m.html.includes('Written by Margyn') && m.html.includes('&lt;b&gt;this&lt;/b&gt;') && !m.html.includes('<b>this</b>'));
check('Pulse framed as operating health', m.html.includes('operating health, not a credit score'));
check('link to the pack, login noted', m.html.includes('#/cfo-pack?period=2026-09') && /log in/.test(m.html));

/* cron */
function fakeDb({ deliveries = [], prefsMissing = false, logMissing = false } = {}) {
  const logged = [], sent = [];
  const profiles = [{ id: 'u1', company_name: 'Anvaya Home Goods', preferences: { cfo_pack: { enabled: true, day_of_month: 3, recipients: [{ name: 'Ravi', email: 'ravi@ca.in' }, { name: 'Meera', email: 'meera@anvaya.in' }] } } }];
  const deps = {
    now: new Date('2026-10-04T02:30:00Z'),
    selectRows: async (table, q) => {
      if (table === 'report_deliveries') {
        if (logMissing) throw new Error('relation does not exist');
        if (q === 'select=id&limit=1') return [];
        return deliveries.filter((d) => q.includes('user_id=eq.' + d.user_id) && q.includes('period=eq.' + d.period) && d.status === 'sent' && d.kind === 'scheduled');
      }
      if (table === 'profiles') { if (prefsMissing) throw new Error('column preferences does not exist'); return profiles; }
      if (table === 'snapshots') return q.includes('2026-08-31T18') ? [snap] : q.includes('2026-07-31T18') ? [prev] : [];
      return [];
    },
    insertRows: async (t, rows) => { logged.push(...rows); return rows; },
    fetch: async (url, o) => { const body = JSON.parse(o.body); sent.push(body); return { ok: true, json: async () => ({ id: 'em_' + sent.length }) }; }
  };
  return { deps, logged, sent };
}
(async () => {
  let t = fakeDb();
  let r = await P.runCron(t.deps);
  check('sends September pack to both recipients, one email each', r.sent === 2 && t.sent.length === 2 && t.sent[0].to.length === 1 && r.period === '2026-09', r);
  check('each send logged as sent with provider id', t.logged.length === 2 && t.logged.every((l) => l.status === 'sent' && l.kind === 'scheduled' && l.provider_message_id), t.logged);

  t = fakeDb({ deliveries: [{ user_id: 'u1', period: '2026-09', status: 'sent', kind: 'scheduled', recipient_email: 'ravi@ca.in' }] });
  r = await P.runCron(t.deps);
  check('already-sent recipient is skipped', r.sent === 1 && t.sent[0].to[0] === 'meera@anvaya.in', r);

  t = fakeDb(); t.deps.now = new Date('2026-10-02T02:30:00Z');
  r = await P.runCron(t.deps);
  check('before the chosen day nothing is sent', r.sent === 0 && t.sent.length === 0, r);
  r = await P.runCron(t.deps, { force: true });
  check('force ignores the day', r.sent === 2, r);

  t = fakeDb({ logMissing: true });
  r = await P.runCron(t.deps);
  check('fails closed when the delivery log is missing', !r.ok && r.sent === 0 && t.sent.length === 0, r);

  t = fakeDb({ prefsMissing: true });
  r = await P.runCron(t.deps);
  check('no preferences column: nothing sent, clear reason', !r.ok && /preferences/.test(r.reason), r);

  t = fakeDb(); t.deps.fetch = async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) });
  r = await P.runCron(t.deps);
  check('provider refusal is logged as failed, retried next run', r.failed === 2 && t.logged.every((l) => l.status === 'failed' && /domain not verified/.test(l.error)), t.logged);

  t = fakeDb();
  const tr = await P.sendTest(t.deps, { user: { id: 'u1', email: 'Owner@Anvaya.in' }, period: '2026-09' });
  check('test send goes only to the signed-in user', tr.status === 200 && t.sent.length === 1 && t.sent[0].to[0] === 'Owner@Anvaya.in' && t.sent[0].subject.startsWith('[Test]'), tr);

  delete process.env.RESEND_API_KEY;
  r = await P.runCron(fakeDb().deps);
  check('no API key: nothing sent, clear reason', !r.ok && /RESEND_API_KEY/.test(r.reason));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
