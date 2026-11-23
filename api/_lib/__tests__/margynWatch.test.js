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
  tally_installs: [{ id: 'i1', user_id: U, status: 'active', company_name: 'Acme Ltd (2026-27)', last_sync_at: new Date().toISOString(),
    // The agent's health report closes every sync (tally.js handleHealth); later than any write here = books whole.
    diagnostics: { received_at: '2099-01-01T00:00:00.000Z' } }],
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
    if (eq('id')) rows = rows.filter((r) => String(r.id) === eq('id'));
    if (eq('business_id')) rows = rows.filter((r) => !r.business_id || r.business_id === eq('business_id'));
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
    const key = eq('key'), id = eq('id'), phone = eq('phone'), cat = eq('created_at');
    const notEmpty = u.searchParams.get('text') === 'neq.';
    const hit = [];
    for (const r of DB[table] || []) if (((key && r.key === key) || (id && r.id === id) || (phone && r.phone === phone))
      && (!cat || r.created_at === cat) && (!notEmpty || r.text !== '')) { Object.assign(r, body); hit.push(Object.assign({}, r)); }
    return ok(hit);
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
  const kept = DB.margyn_signals.filter((s) => !/^(snap|run):/.test(s.key));
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

  console.log('the numbers in one template');
  DB.margyn_signals = [];
  DB.watch_pending = [];
  process.env.WHATSAPP_TEMPLATE_UPDATE = 'tpl-3';
  process.env.WHATSAPP_TEMPLATE_ALERT_V2 = 'tpl-2';
  r = await W.watchAccount(U, { slot: 'morning' });
  const t3 = JSON.parse(sent[sent.length - 1].template);
  check('uses the numbers template first', r.sent && t3.id === 'tpl-3' && t3.params.length === 6, t3);
  check('values carry figures, one line each, body fits 1024', t3.params.every((x) => x && !/\n/.test(x)) && /₹/.test(t3.params.slice(2).join(' ')) && t3.params.join('').length + 330 <= 1024, t3.params);
  check('greets by name, says which update', t3.params[0] === 'Mihir' && /^morning, \d+ [A-Z][a-z]{2}$/.test(t3.params[1]), t3.params);
  check('what needs him is in it, under its own label', /late|days/i.test(t3.params[5]) && /₹/.test(t3.params[2]), t3.params);
  check('full update still follows a reply', DB.watch_pending.length === 1 && /Good morning Mihir/.test(DB.watch_pending[0].text));
  const runLog = JSON.parse((DB.margyn_signals.find((x) => /^run:.*:morning$/.test(x.key)) || {}).detail || '{}');
  check('the day\'s log knows which template and the name, for a re-send', runLog.tpl === 'update' && runLog.name === 'Mihir', runLog);
  delete process.env.WHATSAPP_TEMPLATE_UPDATE;
  delete process.env.WHATSAPP_TEMPLATE_ALERT_V2;
  const sp = W.updateParams({ text: 'Good morning.\n\n*Where you stand*\nBank ₹5 L.\n\n*2 things that need you*\n\n1. A owes ₹1 L\nWhy now: x\nBacking: y\n\n2. B owes ₹2 L\nNext: z\n\nReply 1 or 2. Reply STOP ALERTS to pause these.' }, { company: 'Acme', firstName: null, slot: 'evening' });
  check('each section under its label, points by title only, foot dropped, gaps said plainly', sp[2] === 'Bank ₹5 L.' && sp[3] === 'nothing new entered in your books yet' && sp[4] === 'in the full update' && sp[5] === '1. A owes ₹1 L; 2. B owes ₹2 L.' && !/STOP/.test(sp.join(' ')), sp);

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

  console.log('the day\'s log');
  const runsNow = await W.runs(U);
  const bySlot = Object.fromEntries(runsNow.map((x) => [x.slot, x]));
  check('every run of the day is logged with its outcome', bySlot.morning && bySlot.morning.outcome === 'sent' && bySlot.noon && bySlot.noon.outcome === 'quiet' && /Nothing moved/.test(bySlot.noon.reason) && bySlot.evening && bySlot.evening.outcome === 'sent', runsNow.map((x) => [x.slot, x.outcome, x.reason]));
  check('a sent run keeps the message and its WhatsApp id (to match the delivery report)', /^Evening wrap/.test(bySlot.evening.text) && !!bySlot.evening.message_id && bySlot.evening.to === 'owner', bySlot.evening);
  const hub = await W.signals(U);
  check('the app gets the runs, not as findings', Array.isArray(hub.runs) && hub.runs.length >= 4 && !hub.signals.some((x) => /^(snap|run):/.test(x.key)), hub.runs && hub.runs.length);

  console.log('a morning snapshot from before pulses (no seen list)');
  const yIso = new Date(Date.now() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
  DB.tally_vouchers.push(Object.assign(sale(yIso, 'Yesterday Co', 900000), { tally_guid: 'y1' }));
  DB.tally_installs[0].last_sync_at = new Date(Date.now() + 3000).toISOString();
  for (const row of DB.margyn_signals) if (row.key === 'snap:morning' || row.key === 'snap:last') { const j = JSON.parse(row.detail); delete j.seen; j.said = []; j.pulses = 0; row.detail = JSON.stringify(j); }
  r = await W.watchAccount(U, { slot: 'late', previewOnly: true });
  check('yesterday\'s entries are never counted as new', !/Yesterday Co|₹9 L/.test(r.text || '') && (r.text == null || /update/.test(r.text)), r);
  console.log('never reads half-synced books (26 Oct 2026: late money ₹51.6 L at 12:30, ₹1.35 Cr at 3 pm)');
  const keepDiag = DB.tally_installs[0].diagnostics;
  DB.tally_installs[0].last_sync_at = new Date().toISOString();
  DB.tally_installs[0].diagnostics = { received_at: new Date(Date.now() - 600000).toISOString() };   // report before the latest write
  const sentBefore = sent.length;
  r = await W.watchAccount(U, { slot: 'noon', waitMs: 0 });
  check('a pulse mid-sync is held, nothing sent', r.skipped === 'mid_sync' && sent.length === sentBefore, r);
  r = await W.watchAccount(U, { slot: 'morning', waitMs: 0, dryRun: true });
  check('the morning still goes out after its wait', !r.skipped, r);
  DB.tally_installs[0].diagnostics = { received_at: new Date(Date.now() + 1000).toISOString() };
  r = await W.watchAccount(U, { slot: 'noon', waitMs: 0, dryRun: true });
  check('once the sync\'s report is in, the pulse reads the books', r.skipped !== 'mid_sync', r);
  DB.tally_installs[0].diagnostics = null;
  DB.tally_installs[0].last_sync_at = new Date(Date.now() - 10 * 60000).toISOString();
  r = await W.watchAccount(U, { slot: 'noon', waitMs: 0, dryRun: true });
  check('an agent with no stamped report: a write 10 minutes ago is not mid-sync', r.skipped !== 'mid_sync', r);
  DB.tally_installs[0].diagnostics = keepDiag;
  console.log('every account');
  const all = await W.runWatchAll('morning');
  check('runs over Tally accounts', all.accounts === 1 && all.results.length === 1, all);

  console.log('greets the owner by name even without a display name (21 Nov 2026)');
  check('no display name: the sign-up name, first word', W.firstNameOf({ preferences: {}, owner_name: 'Varad Pandey' }) === 'Varad');
  check('a display name still wins', W.firstNameOf({ preferences: { display_name: 'Mihir Shah' }, owner_name: 'Someone' }) === 'Mihir');
  {
    const prefs = DB.profiles[0].preferences, dn = prefs.display_name;
    delete prefs.display_name;
    DB.business_stakeholders = [{ business_id: U, name: 'Varad Pandey', is_primary: true }];
    DB.margyn_signals = []; DB.watch_pending = [];
    const rr = await W.watchAccount(U, { slot: 'morning' });
    const last = sent[sent.length - 1];
    check('a Tally account keeps exactly the greeting it had (no sign-up-name fallback)', rr.sent && !/Varad/.test(last.message || last.template || ''), (last.message || '').slice(0, 80));
    prefs.display_name = dn; DB.business_stakeholders = [];
  }
  console.log('first message to a newly linked team member (21 Nov 2026)');
  check('welcome wording: a name ending in s gets an apostrophe only, and the business is the one they were added to',
    /^Hi Varad, I'm Margyn\. You've been added to Margyn Demos on Margyn as Finance.*\n\nMargyn Demos' Zoho Books as of/.test(W.welcomeText('Good morning Varad. Your Zoho Books as of 21 Nov.\n\nx', { firstName: 'Varad', company: 'Margyn Demos', role: 'Finance' })));
  DB.profiles[0].preferences.margyn_watch.mode = 'on';
  DB.margyn_signals = []; DB.watch_pending = [];
  process.env.WHATSAPP_TEMPLATE_UPDATE = 'tpl-3';
  let n1 = sent.length;
  let w = await W.welcomeMember(U, { to: '919811100000', firstName: 'Yash', role: 'Finance' });
  const wt = sent[sent.length - 1] && sent[sent.length - 1].template ? JSON.parse(sent[sent.length - 1].template) : {};
  check('welcome: sent to the member, as the approved numbers template', w.sent && w.via === 'template' && sent.length === n1 + 1 && sent[sent.length - 1].destination === '919811100000' && wt.id === 'tpl-3', { w, last: sent[sent.length - 1] });
  check('welcome: greets the member by name, says it is the first update, carries figures', wt.params && wt.params[0] === 'Yash' && /^first update, \d+ [A-Z][a-z]{2}$/.test(wt.params[1]) && /₹/.test(wt.params.slice(2).join(' ')), wt.params);
  check('welcome: nothing to the owner, nothing used up', !sent.slice(n1).some((x) => x.destination === '919324000000') && DB.margyn_signals.length === 0, DB.margyn_signals);
  const wp = (DB.watch_pending || []).find((x) => x.phone === '919811100000');
  check('welcome: any reply brings the full update, opening as a hello', wp && /^Hi Yash, I'm Margyn\. You've been added to Acme on Margyn as Finance/.test(wp.text) && /Acme's Tally/.test(wp.text), wp && wp.text.slice(0, 220));
  check('welcome: no "Good morning" at any hour, none of the owner\'s scheduled-update promises', wp && !/Good morning|check back this evening|STOP ALERTS/.test(wp.text));
  check('welcome: kept in his number\'s thread for context', DB.whatsapp_conversations.some((x) => x.role === 'assistant' && x.from_phone === '919811100000' && /Hi Yash, I'm Margyn/.test(x.content)));
  DB.whatsapp_conversations.push({ role: 'user', from_phone: '919811100001', content: 'hi', created_at: new Date().toISOString() });
  n1 = sent.length;
  w = await W.welcomeMember(U, { to: '919811100001', firstName: 'Yash' });
  check('welcome: an open chat gets the hello + update as plain text', w.sent && w.via === 'session' && sent.length === n1 + 1 && /Hi Yash, I'm Margyn/.test(sent[sent.length - 1].message || ''), { w, last: sent[sent.length - 1] });
  process.env.WHATSAPP_TEMPLATE_WELCOME = 'tpl-w';
  n1 = sent.length;
  w = await W.welcomeMember(U, { to: '919811100003', firstName: 'Yash', role: 'Finance' });
  const ww = JSON.parse(sent[sent.length - 1].template || '{}');
  check('welcome: the welcome template once it is approved: name, business, role, where it stands', w.sent && ww.id === 'tpl-w' && ww.params[0] === 'Yash' && ww.params[1] === 'Acme' && ww.params[2] === 'Finance' && /₹/.test(ww.params[3]) && ww.params.every((x) => !/\n/.test(x)), ww);
  delete process.env.WHATSAPP_TEMPLATE_WELCOME;
  delete process.env.WHATSAPP_TEMPLATE_UPDATE;
  n1 = sent.length;
  w = await W.welcomeMember(U, { to: '919811100002', firstName: 'Yash' });
  check('welcome: no template and no open chat = nothing sent, and says why', !w.sent && w.reason === 'no update template set' && sent.length === n1, w);
  w = await W.welcomeMember(U, { to: '' });
  check('welcome: no number, no send', !w.sent);

  console.log('daily update for team members (23 Nov 2026)');
  const owner = "Good morning Varad. Your Zoho Books as of 23 Nov, 7:00 am.\n\n*Where you stand*\nBank and cash ₹25.6 L.\n\nAsk me anything about your books. I'll check back this evening on what moved. Reply STOP ALERTS to pause these.";
  const mt = W.memberUpdateText(owner, { firstName: 'Yash', company: 'MARGYN DEMO' });
  check('member text: greets the member, names the business\'s books', /^Good morning Yash\. MARGYN DEMO's Zoho Books as of 23 Nov/.test(mt), mt);
  check('member text: no owner promises, STOP ALERTS stops only theirs', !/Varad|check back this evening|pause these/.test(mt) && /STOP ALERTS to stop getting these/.test(mt), mt);
  DB.business_stakeholders = [
    { id: 's1', business_id: U, name: 'Varad Pandey', phone: '919324000000', is_primary: true, whatsapp_access: true, permissions: { opening_bell: true } },
    { id: 's2', business_id: U, name: 'Yash Kumar', phone: '919811105508', is_primary: false, whatsapp_access: true, permissions: { ask: true, opening_bell: true } },
    { id: 's3', business_id: U, name: 'Old Bell', phone: '919811100099', is_primary: false, whatsapp_access: false, permissions: { opening_bell: true } }
  ];
  process.env.WHATSAPP_TEMPLATE_UPDATE = 'tpl-3';
  const build = (fn) => owner.replace('Varad', fn || '');
  n1 = sent.length;
  let ms = await W.sendToMembers(U, { slot: 'morning', ownerTo: '+919324000000', company: 'Acme', ctx: { source: 'tally', source_name: 'Tally' }, build });
  check('Tally accounts: members get nothing (Mihir untouched)', ms.length === 0 && sent.length === n1, ms);
  ms = await W.sendToMembers(U, { slot: 'midday', ownerTo: '+919324000000', company: 'Acme', ctx: { source: 'zoho' }, build });
  check('pulses through the day stay with the owner', ms.length === 0 && sent.length === n1, ms);
  ms = await W.sendToMembers(U, { slot: 'morning', ownerTo: '+919324000000', company: 'MARGYN DEMO', ctx: { source: 'zoho', source_name: 'Zoho Books' }, build });
  const mine = sent.slice(n1);
  const mtp = mine[0] && mine[0].template ? JSON.parse(mine[0].template) : {};
  check('Zoho: morning update to the member with it switched on, as the numbers template', ms.length === 1 && ms[0].sent && mine.length === 1 && mine[0].destination === '919811105508' && mtp.id === 'tpl-3' && mtp.params[0] === 'Yash', { ms, mine });
  check('Zoho: never the primary number again, never a number without WhatsApp access', !mine.some((x) => x.destination === '919324000000' || x.destination === '919811100099'));
  const mp = (DB.watch_pending || []).find((x) => x.phone === '919811105508');
  check('Zoho: any reply brings the member\'s full update, in his thread', mp && /^Good morning Yash\. MARGYN DEMO's/.test(mp.text) && DB.whatsapp_conversations.some((x) => x.from_phone === '919811105508' && /Good morning Yash/.test(x.content)), mp && mp.text);
  await W.setMemberUpdates('s2', false);
  check('STOP ALERTS from a member turns off only their own update', DB.business_stakeholders[1].permissions.opening_bell === false && DB.business_stakeholders[1].permissions.ask === true && DB.business_stakeholders[0].permissions.opening_bell === true, DB.business_stakeholders);
  delete process.env.WHATSAPP_TEMPLATE_UPDATE;

  console.log('hand-written update to one team member (23 Nov 2026)');
  const P = ['Yash', 'MARGYN DEMO, 23 Nov, 1 pm', 'Bank ₹43.1 L. Customers owe ₹1.31 Cr.', 'You asked what is coming in this month: ₹14 L so far.', '₹9 L due this week.', 'Mehta Traders ₹11.6 L, about 4 months late.'];
  check('note: six values, no line breaks, within limits', W.checkNoteParams(P) === null && /Six values/.test(W.checkNoteParams(P.slice(0, 5))) && /line break/.test(W.checkNoteParams(P.map((x, i) => (i === 3 ? 'a\nb' : x)))) && /too long/.test(W.checkNoteParams(P.map((x, i) => (i === 4 ? 'x'.repeat(300) : x)))));
  process.env.WHATSAPP_TEMPLATE_UPDATE = 'tpl-3';
  n1 = sent.length;
  let nt = await W.sendMemberNote(U, 's2', { params: P, dryRun: true });
  check('note: dry run shows the text and sends nothing', nt.dry_run && nt.via === 'template' && /Hi Yash, this is your Margyn account update \(MARGYN DEMO, 23 Nov, 1 pm\)/.test(nt.text) && sent.length === n1, nt);
  nt = await W.sendMemberNote(U, 's1', { params: P });
  check('note: never to the main number', !nt.sent && /not the main number/.test(nt.error) && sent.length === n1, nt);
  nt = await W.sendMemberNote('22222222-2222-2222-2222-222222222222', 's2', { params: P });
  check('note: only a person on that account', !nt.sent && sent.length === n1, nt);
  DB.watch_pending = (DB.watch_pending || []).filter((x) => x.phone !== '919811105508');
  nt = await W.sendMemberNote(U, 's2', { params: P, resetComparison: true });
  const nm = sent[sent.length - 1], ntp = nm && nm.template ? JSON.parse(nm.template) : {};
  check('note: closed chat = the numbers template with exactly the six values', nt.sent && nt.via === 'template' && sent.length === n1 + 1 && nm.destination === '919811105508' && ntp.id === 'tpl-3' && JSON.stringify(ntp.params) === JSON.stringify(P), { nt, ntp });
  const np = (DB.watch_pending || []).find((x) => x.phone === '919811105508');
  check('note: a reply brings his full update; kept in his thread; comparison cleared', np && /^Good morning Yash\./.test(np.text) && DB.whatsapp_conversations.some((x) => x.from_phone === '919811105508' && /Margyn account update \(MARGYN DEMO/.test(x.content)) && nt.comparison_reset === true, { np: np && np.text.slice(0, 80), nt });
  const dr = await W.draftMemberNote(U, 's2', { now: Date.parse('2026-11-23T07:40:00Z') });
  check('draft: six lines pre-filled from his update, ready to send as they are', !dr.error && dr.params.length === 6 && dr.params[0] === 'Yash' && dr.params[1] === 'Acme, 23 Nov, afternoon' && /₹/.test(dr.params[2]) && W.checkNoteParams(dr.params) === null && dr.to_end === '5508', dr);
  check('draft: never for the main number', /not the main number/.test((await W.draftMemberNote(U, 's1')).error || ''));
  delete process.env.WHATSAPP_TEMPLATE_UPDATE;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
