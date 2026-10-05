/** Run: node api/_lib/__tests__/margynWatch.test.js — fake Supabase and Gupshup, no network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.WHATSAPP_BSP = 'gupshup';
process.env.GUPSHUP_API_KEY = 'k'; process.env.GUPSHUP_SOURCE_NUMBER = '919000000000'; process.env.GUPSHUP_APP_NAME = 'margyn';
process.env.MARGYN_WATCH_PREVIEW_PHONE = '919999900000';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };

const U = '11111111-1111-1111-1111-111111111111';
const today = new Date();
const d = (daysAgo) => { const x = new Date(today.getTime() - daysAgo * 86400000); return x.toISOString().slice(0, 10); };
const sale = (date, party, v) => ({ tally_guid: 'g' + Math.random(), voucher_type: 'Sales', voucher_number: 'S' + Math.random(), date, party_name: party, amount: v, is_cancelled: false,
  entries: [{ ledger: party, amount: -v, is_party: true }, { ledger: 'Sales', amount: v }] });
const DB = {
  tally_installs: [{ id: 'i1', user_id: U, status: 'active', company_name: 'Acme Ltd (2026-27)', last_sync_at: new Date().toISOString() }],
  tally_ledgers: [{ name: 'Sales', parent: 'Sales Accounts' }, { name: 'Big Co', parent: 'Sundry Debtors' }],
  tally_vouchers: [sale(d(150), 'Big Co', 5000000), sale(d(120), 'Big Co', 5000000), sale(d(90), 'Big Co', 5000000), sale(d(60), 'Big Co', 5000000)],
  tally_bills: [{ direction: 'receivable', party_name: 'Big Co', bill_ref: 'B1', closing_balance: 9000000, overdue_days: 120 }],
  tally_ledger_classes: [], tally_sync_runs: [],
  profiles: [{ id: U, preferences: { margyn_watch: { mode: 'on' }, display_name: 'Mihir Shah' }, whatsapp_phone: '+919324000000', whatsapp_opt_in: true, company_name: 'Acme' }],
  margyn_signals: [],
  whatsapp_conversations: [],
  product_events: []
};
const sent = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.hostname === 'api.gupshup.io') {
    const body = new URLSearchParams(opts.body);
    sent.push({ path: u.pathname, destination: body.get('destination'), message: body.get('message'), template: body.get('template') });
    return ok({ status: 'submitted', messageId: 'm' + sent.length });
  }
  const table = u.pathname.replace('/rest/v1/', '');
  const method = opts.method || 'GET';
  const eq = (k) => { const v = u.searchParams.get(k); return v && v.startsWith('eq.') ? decodeURIComponent(v.slice(3)) : null; };
  if (method === 'GET') {
    let rows = DB[table] || [];
    if (eq('user_id')) rows = rows.filter((r) => !r.user_id || r.user_id === eq('user_id'));
    if (eq('from_phone')) rows = rows.filter((r) => r.from_phone === eq('from_phone'));
    if (eq('role')) rows = rows.filter((r) => r.role === eq('role'));
    if (eq('phone')) rows = rows.filter((r) => r.phone === eq('phone'));
    if (table === 'whatsapp_conversations') rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
    return ok(rows.slice(off, off + lim));
  }
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    if (table === 'watch_pending') for (const r of rows) { const i = (DB.watch_pending = DB.watch_pending || []).findIndex((x) => x.phone === r.phone); if (i >= 0) Object.assign(DB.watch_pending[i], r); else DB.watch_pending.push(Object.assign({}, r)); }
    else if (table === 'margyn_signals') for (const r of rows) { const i = DB.margyn_signals.findIndex((x) => x.key === r.key); if (i >= 0) Object.assign(DB.margyn_signals[i], r); else DB.margyn_signals.push(Object.assign({}, r)); }
    else (DB[table] = DB[table] || []).push(...rows.map((r) => Object.assign({ created_at: new Date().toISOString() }, r)));
    return ok(rows);
  }
  if (method === 'PATCH') {
    const key = eq('key'), id = eq('id'), phone = eq('phone');
    for (const r of DB[table] || []) if ((key && r.key === key) || (id && r.id === id) || (phone && r.phone === phone)) Object.assign(r, body);
    return ok([]);
  }
  return ok([]);
};

const W = require('../margynWatch');

(async () => {
  console.log('choosing what to send');
  const list = [
    { key: 'a', kind: 'overdue_total', severity: 'high', impact: 100 },
    { key: 'b', kind: 'quiet', severity: 'medium', impact: 50, party: 'BIG CO LTD' },
    { key: 'c', kind: 'receipt', severity: 'low', impact: 10, news: true },
    { key: 'e', kind: 'newly_overdue', severity: 'low', impact: 8, news: true, party: 'Big Co' },
    { key: 'd', kind: 'commission', severity: 'low', impact: 5 },
    { key: 'f', kind: 'old_debts', severity: 'low', impact: 4 }
  ];
  check('first time: up to three, one per customer, receipts are not points', W.choose(list, [], 'morning').map((x) => x.key).join() === 'a,b,d', W.choose(list, [], 'morning').map((x) => x.key));
  const sentYesterday = new Date(Date.now() - 86400000).toISOString();
  check('cooldown holds a repeat', !W.choose(list, [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: sentYesterday }], 'morning').some((x) => x.key === 'a'));
  const worse = W.choose([{ key: 'a', kind: 'overdue_total', severity: 'high', impact: 200 }], [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: new Date(Date.now() - 2 * 86400000).toISOString() }], 'morning');
  check('getting worse makes it news again, with the earlier figure', worse.length === 1 && worse[0].was && worse[0].was.impact === 100, worse);
  check('getting better is not a reason to repeat', W.choose([{ key: 'a', kind: 'overdue_total', severity: 'high', impact: 50 }], [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: new Date(Date.now() - 2 * 86400000).toISOString() }], 'morning').length === 0);
  check('a preview-only send does not hold back the owner', W.choose(list, [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: sentYesterday, sent_to: 'preview' }], 'morning', null, 'on').some((x) => x.key === 'a'));
  check('...but does hold back the next preview', !W.choose(list, [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: sentYesterday, sent_to: 'preview' }], 'morning', null, 'preview').some((x) => x.key === 'a'));
  check('muted finding stays quiet', !W.choose(list, [{ key: 'b', kind: 'quiet', status: 'muted' }], 'morning').some((x) => x.key === 'b'));
  check('muted kind stays quiet', !W.choose(list, [{ key: 'mute:quiet', kind: 'quiet', status: 'muted' }], 'morning').some((x) => x.kind === 'quiet'));
  check('midday: deadlines only, not news or the morning\'s points', W.choose(list.concat([{ key: 'g', kind: 'gst_due', severity: 'high', impact: 3 }]), [], 'midday').map((x) => x.key).join() === 'g');

  console.log('the message');
  const text = W.compose([{ title: '₹90 L of the ₹90 L customers owe you is overdue.', action: 'Call Big Co first.' }], { company: 'Acme Ltd (2026-27)', slot: 'morning', firstName: 'Mihir' });
  check('greets, numbers, says how to reply and stop', /^Good morning Mihir\./.test(text) && /\n1\. ₹90 L/.test(text) && /STOP ALERTS/.test(text), text);
  const t2 = W.compose([{ title: 'A is late.', action: 'Call A.', was: { impact: 4000000, at: '2026-10-01T03:00:00Z' } }, { title: 'B.' }], { company: 'Acme', slot: 'morning', lastSync: '2026-10-03T13:28:00Z', ctxLines: ['Money in since yesterday: ₹21.7 L (Sun Pharma ₹21.7 L).', 'Bank and cash ₹4.38 L.'] });
  check('says when the books are from, in India time', /as of 3 Oct, 6:58 pm/.test(t2), t2);
  check('money in and cash come before the points', t2.indexOf('Money in') > 0 && t2.indexOf('Money in') < t2.indexOf('1. '), t2);
  check('a repeat says what changed', /up from ₹40 L on 1 Oct/.test(t2), t2);
  check('reply hint matches the number of points', /Reply 1 or 2 to know more/.test(t2), t2);
  const tz = W.teaserParams([{ title: '₹1.82 Cr is more than a month late.' }, { title: 'x' }], { company: 'Acme Ltd', firstName: 'Mihir' });
  check('short template: name and one headline line', tz[0] === 'Mihir' && /^2 things in your books need you today\. The biggest: ₹1\.82 Cr/.test(tz[1]) && !/\n/.test(tz[1]), tz);
  check('preview is labelled', /^\[Preview for Acme\./.test(W.compose([{ title: 'x' }], { company: 'Acme Ltd (2026-27)', slot: 'evening', preview: true })));
  const tp = W.templateParams([{ title: 'one' }, { title: 'two' }], { company: 'Acme Ltd', firstName: null });
  check('template params have no new lines', tp.length === 2 && !/\n/.test(tp[1]) && tp[1] === '(1) one (2) two', tp);

  console.log('one account, owner on, no open chat, no template');
  let r = await W.watchAccount(U, { slot: 'morning' });
  check('found findings', r.found > 0, r);
  check('not sent: no session and no template', !r.sent && /24 hours/.test(r.not_sent || ''), r);
  check('nothing reached Gupshup', sent.length === 0, sent);
  const kept = DB.margyn_signals.filter((s) => !s.key.startsWith('snap:'));
  check('findings kept for the app', kept.length === r.found && kept.every((s) => s.status === 'open'), kept);
  check('the morning snapshot is kept for the next update', DB.margyn_signals.some((s) => s.key === 'snap:morning' && s.status === 'resolved' && JSON.parse(s.detail).recv_total === 9000000));

  console.log('owner texted Margyn an hour ago: free text goes out');
  DB.whatsapp_conversations.push({ profile_id: U, role: 'user', content: 'hi', from_phone: '919324000000', created_at: new Date(Date.now() - 3600000).toISOString() });
  r = await W.watchAccount(U, { slot: 'morning' });
  check('sent in the open chat', r.sent && r.sent.via === 'session' && r.sent.to === 'owner', r);
  check('to the owner\'s number', sent.length === 1 && sent[0].destination === '919324000000' && sent[0].path.endsWith('/msg'), sent);
  check('message lands in the owner\'s WhatsApp thread', DB.whatsapp_conversations.some((m) => m.role === 'assistant' && /Good morning Mihir/.test(m.content) && m.from_phone === '919324000000'));
  check('state says sent', DB.margyn_signals.filter((s) => s.status === 'sent').length === r.chosen.length, DB.margyn_signals);
  check('ops counter', DB.product_events.some((e) => e.name === 'watch_sent'));
  const firstRound = r.chosen.slice();
  r = await W.watchAccount(U, { slot: 'evening' });
  check('same findings are not sent twice the same day', !r.chosen.some((k) => firstRound.includes(k)), { firstRound, r });

  console.log('outside 24h with the alert template');
  DB.whatsapp_conversations = [];
  DB.margyn_signals = [];
  process.env.WHATSAPP_TEMPLATE_ALERT = 'tpl-1';
  r = await W.watchAccount(U, { slot: 'morning' });
  check('sent by template', r.sent && r.sent.via === 'template', r);
  const last = sent[sent.length - 1];
  check('template id and two params', last.template && JSON.parse(last.template).id === 'tpl-1' && JSON.parse(last.template).params.length === 2, last);

  console.log('short template + See details');
  DB.margyn_signals = [];
  DB.watch_pending = [];
  process.env.WHATSAPP_TEMPLATE_ALERT_V2 = 'tpl-2';
  r = await W.watchAccount(U, { slot: 'morning' });
  const t2last = sent[sent.length - 1];
  check('uses the short template when it exists', r.sent && JSON.parse(t2last.template).id === 'tpl-2', t2last);
  check('full update waits for the reply', DB.watch_pending.length === 1 && /Good morning Mihir/.test(DB.watch_pending[0].text), DB.watch_pending);
  const got = await W.takePending('+91 93240 00000');
  check('reply picks it up once', got && /Good morning/.test(got.text), got);
  check('...and only once', !(await W.takePending('919324000000')));
  delete process.env.WHATSAPP_TEMPLATE_ALERT_V2;

  console.log('preview today\'s update (app button)');
  DB.margyn_signals = [];
  const n0 = sent.length;
  r = await W.watchAccount(U, { slot: 'manual', previewOnly: true });
  check('returns the exact text, sends nothing to the owner, records nothing', /Good morning|Your update/.test(r.text) && sent.length === n0 && DB.margyn_signals.length === 0, r);

  console.log('preview mode');
  DB.profiles[0].preferences.margyn_watch.mode = 'preview';
  DB.margyn_signals = [];
  r = await W.watchAccount(U, { slot: 'morning' });
  check('goes to the preview number, not the owner', r.sent && r.sent.to === 'preview' && sent[sent.length - 1].destination === '919999900000', { r, last: sent[sent.length - 1] });
  check('preview is not written into the owner\'s thread', !DB.whatsapp_conversations.some((m) => /Preview for/.test(m.content || '')));
  check('preview does not count as sent to the owner', DB.margyn_signals.filter((x) => x.sent_to === 'preview').every((x) => !x.sent_count), DB.margyn_signals);
  DB.profiles[0].preferences.margyn_watch.mode = 'on';
  r = await W.watchAccount(U, { slot: 'evening' });
  check('switching to On still sends what was only previewed', r.sent && r.sent.to === 'owner' && r.chosen.length > 0, r);

  console.log('off');
  DB.profiles[0].preferences.margyn_watch.mode = 'off';
  DB.margyn_signals = [];
  const before = sent.length;
  r = await W.watchAccount(U, { slot: 'morning' });
  check('off sends nothing but keeps findings', sent.length === before && DB.margyn_signals.length > 0, r);

  console.log('owner controls');
  await W.setMode(U, 'on');
  check('mode saved, other preferences kept', DB.profiles[0].preferences.margyn_watch.mode === 'on' && DB.profiles[0].preferences.display_name === 'Mihir Shah', DB.profiles[0].preferences);
  let bad = null; try { await W.setMode(U, 'loud'); } catch (e) { bad = e.message; }
  check('unknown mode refused', /mode must be/.test(bad || ''));
  await W.mute(U, { kind: 'quiet' });
  check('mute a kind', DB.margyn_signals.some((s) => s.key === 'mute:quiet' && s.status === 'muted'));
  const s = await W.signals(U);
  check('signals for the hub', s.ready && s.mode === 'on' && s.preview_available && s.template_ready && s.signals.length > 0, s);

  console.log('only delivered sends count');
  DB.profiles[0].preferences.margyn_watch.mode = 'on';
  DB.margyn_signals = [];
  DB.wa_deliveries = [];
  r = await W.watchAccount(U, { slot: 'morning', dryRun: true });
  const keys = r.chosen;
  // Logged as sent to the owner yesterday, but WhatsApp never delivered it; reports are flowing (another message was delivered).
  const ghost = (await require('../booksTools').contextFor(U)).ctx;
  const firstIns = require('../booksEngine').insights(ghost).find((x) => x.kind === keys[0]), firstKey = firstIns.key;
  DB.margyn_signals = [{ user_id: U, key: firstKey, kind: keys[0], status: 'sent', impact: firstIns.impact, last_sent_at: new Date(Date.now() - 86400000 * 1.5).toISOString(), sent_to: 'owner', sent_via: 'template' }];
  DB.wa_deliveries = [{ user_id: U, kind: 'watch', message_id: 'x', sent_to: 'preview_copy', signal_keys: [], status: 'delivered', sent_at: new Date().toISOString() }];
  r = await W.watchAccount(U, { slot: 'morning', dryRun: true });
  check('a send WhatsApp never delivered does not count', r.chosen.includes(keys[0]), r);
  DB.wa_deliveries.push({ user_id: U, kind: 'watch', message_id: 'y', sent_to: 'owner', signal_keys: [firstKey], status: 'delivered', sent_at: new Date(Date.now() - 86400000 * 1.5).toISOString() });
  r = await W.watchAccount(U, { slot: 'morning', dryRun: true });
  check('a delivered one does', !r.chosen.includes(keys[0]), r);
  DB.wa_deliveries = [{ user_id: U, kind: 'watch', message_id: 'z', sent_to: 'owner', signal_keys: [firstKey], status: 'queued', sent_at: new Date(Date.now() - 86400000 * 1.5).toISOString() }];
  r = await W.watchAccount(U, { slot: 'morning', dryRun: true });
  check('no reports coming in at all: trust the log (never repeat every run)', !r.chosen.includes(keys[0]), r);
  DB.wa_deliveries = [];

  console.log('the day\'s cadence: detailed morning, changes-only afternoon, evening follow-ups');
  DB.margyn_signals = []; DB.wa_deliveries = []; DB.watch_pending = [];
  DB.profiles[0].preferences.margyn_watch.mode = 'on';
  DB.whatsapp_conversations = [{ profile_id: U, role: 'user', content: 'hi', from_phone: '919324000000', created_at: new Date(Date.now() - 3600000).toISOString() }];
  const lastText = () => { const m = sent[sent.length - 1].message; try { return JSON.parse(m).text; } catch (e) { return m; } };
  let n = sent.length;
  r = await W.watchAccount(U, { slot: 'morning' });
  const am = lastText();
  check('morning goes out', r.sent && sent.length === n + 1, r);
  check('morning: where you stand, yesterday, this week', /\*Where you stand\*/.test(am) && /Customers owe you ₹90 L; ₹90 L of it is more than a month late/.test(am) && /\*Yesterday\*/.test(am), am);
  check('morning: every point says why now, the backing and what to do', /Why now: /.test(am) && /Backing: /.test(am) && /Next: /.test(am), am);
  check('an actionable point about a customer wins over a background fact about them', /more than a month late/.test(am.split('things that need you')[1] || am.split('One thing that needs you')[1] || '') && !/100% of your sales/.test(am), am);
  check('morning promises the evening check', /check back this evening/.test(am), am);
  n = sent.length;
  r = await W.watchAccount(U, { slot: 'afternoon' });
  check('afternoon with nothing changed sends nothing', !r.sent && r.quiet && sent.length === n, r);
  // Big Co pays ₹40 L today; Tally syncs.
  const todayIso = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  DB.tally_ledgers.push({ name: 'HDFC Bank', parent: 'Bank Accounts' });
  DB.tally_vouchers.push({ tally_guid: 'r1', voucher_type: 'Receipt', voucher_number: 'R1', date: todayIso, party_name: 'Big Co', amount: 4000000, is_cancelled: false,
    entries: [{ ledger: 'Big Co', amount: 4000000, is_party: true }, { ledger: 'HDFC Bank', amount: -4000000 }] });
  DB.tally_bills[0].closing_balance = 5000000;
  DB.tally_installs[0].last_sync_at = new Date().toISOString();
  r = await W.watchAccount(U, { slot: 'afternoon' });
  const pm = lastText();
  check('pulse: money since this morning', r.sent && /^\d{1,2}:\d\d [ap]m update, Mihir\./.test(pm) && /\*Since this morning:\* ₹40 L in \(Big Co ₹40 L\)/.test(pm) && !/Where you stand/.test(pm), pm);
  check('pulse: getting better, tied to the morning point', /\*Getting better\*\n✅ Big Co paid ₹40 L \(point 1 this morning\)\. ₹50 L still open/.test(pm) && /✅ Money more than a month late is down to ₹50 L, from ₹90 L this morning/.test(pm), pm);
  check('pulse: invites plain-word questions', /in your own words/.test(pm), pm);
  n = sent.length;
  r = await W.watchAccount(U, { slot: 'afternoon' });
  check('...and does not say it again', !r.sent && sent.length === n, r);
  // Big Co gets a new invoice while ₹50 L of theirs is months late: more credit to someone who isn't paying.
  DB.tally_vouchers.push(Object.assign(sale(todayIso, 'Big Co', 300000), { tally_guid: 'new-inv' }));
  DB.tally_installs[0].last_sync_at = new Date(Date.now() + 1000).toISOString();
  r = await W.watchAccount(U, { slot: 'late' });
  const lt = lastText();
  check('pulse: new sale to a customer who is months late is flagged', r.sent && /\*Needs a look\*\n⚠️ New ₹3 L invoice to Big Co, who already owes ₹50 L/.test(lt) && r.headline && /^New ₹3 L invoice/.test(r.headline), { r, lt });
  check('pulse: says each thing once a day', !/Big Co paid/.test(lt), lt);
  check('pulse: the change since the last pulse, not since the morning', /\*Since \d{1,2}:\d\d [ap]m:\* new sales ₹3 L/.test(lt), lt);
  n = sent.length;
  r = await W.watchAccount(U, { slot: 'noon' });
  check('pulse: nothing new, nothing sent', !r.sent && sent.length === n, r);
  for (const a of [3, 5, 8, 10, 12, 15]) DB.tally_vouchers.push(sale(d(a), 'Small Co', 20000));   // a few working days to compare with
  DB.tally_installs[0].last_sync_at = new Date(Date.now() + 2000).toISOString();
  r = await W.watchAccount(U, { slot: 'evening' });
  const ev = lastText();
  check('evening: today against a usual day', /\*Today against a usual day\*\nCollected ₹40 L/.test(ev) && /Late money ₹50 L, down ₹40 L today ↓/.test(ev), ev);
  check('evening goes out', r.sent, r);
  check('evening: today\'s money', /\*Today\*\nIn: ₹40 L \(Big Co ₹40 L\)\./.test(ev), ev);
  check('evening: follows up on the morning point', /\*This morning's points\*\n1\. ✅ Big Co: paid ₹40 L today\. ₹50 L still open/.test(ev), ev);
  check('evening template headline counts what is still open', /^Evening wrap: ₹40 L came in today; 1 of this morning's 1 point is still open\.$/.test(r.headline), r);

  console.log('every account');
  const all = await W.runWatchAll('morning');
  check('runs over Tally accounts', all.accounts === 1 && all.results.length === 1, all);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
