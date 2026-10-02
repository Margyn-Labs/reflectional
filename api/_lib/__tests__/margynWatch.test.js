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
    if (table === 'whatsapp_conversations') rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
    return ok(rows.slice(off, off + lim));
  }
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    if (table === 'margyn_signals') for (const r of rows) { const i = DB.margyn_signals.findIndex((x) => x.key === r.key); if (i >= 0) Object.assign(DB.margyn_signals[i], r); else DB.margyn_signals.push(Object.assign({}, r)); }
    else (DB[table] = DB[table] || []).push(...rows.map((r) => Object.assign({ created_at: new Date().toISOString() }, r)));
    return ok(rows);
  }
  if (method === 'PATCH') {
    const key = eq('key'), id = eq('id');
    for (const r of DB[table] || []) if ((key && r.key === key) || (id && r.id === id)) Object.assign(r, body);
    return ok([]);
  }
  return ok([]);
};

const W = require('../margynWatch');

(async () => {
  console.log('choosing what to send');
  const list = [
    { key: 'a', kind: 'overdue_total', severity: 'high', impact: 100 },
    { key: 'b', kind: 'quiet', severity: 'medium', impact: 50 },
    { key: 'c', kind: 'receipt', severity: 'low', impact: 10, news: true },
    { key: 'd', kind: 'commission', severity: 'low', impact: 5 }
  ];
  check('first time: up to three', W.choose(list, [], 'morning').map((x) => x.key).join() === 'a,b,c');
  const sentYesterday = new Date(Date.now() - 86400000).toISOString();
  check('cooldown holds a repeat', !W.choose(list, [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: sentYesterday }], 'morning').some((x) => x.key === 'a'));
  check('a big move makes it news again', W.choose([{ key: 'a', kind: 'overdue_total', severity: 'high', impact: 200 }], [{ key: 'a', kind: 'overdue_total', status: 'sent', impact: 100, last_sent_at: new Date(Date.now() - 2 * 86400000).toISOString() }], 'morning').length === 1);
  check('muted finding stays quiet', !W.choose(list, [{ key: 'b', kind: 'quiet', status: 'muted' }], 'morning').some((x) => x.key === 'b'));
  check('muted kind stays quiet', !W.choose(list, [{ key: 'mute:quiet', kind: 'quiet', status: 'muted' }], 'morning').some((x) => x.kind === 'quiet'));
  check('midday: urgent or news only', W.choose(list, [], 'midday').map((x) => x.key).join() === 'a,c');

  console.log('the message');
  const text = W.compose([{ title: '₹90 L of the ₹90 L customers owe you is overdue.', action: 'Call Big Co first.' }], { company: 'Acme Ltd (2026-27)', slot: 'morning', firstName: 'Mihir' });
  check('greets, numbers, says how to reply and stop', /^Good morning Mihir\./.test(text) && /\n1\. ₹90 L/.test(text) && /STOP ALERTS/.test(text), text);
  check('preview is labelled', /^\[Preview for Acme\./.test(W.compose([{ title: 'x' }], { company: 'Acme Ltd (2026-27)', slot: 'evening', preview: true })));
  const tp = W.templateParams([{ title: 'one' }, { title: 'two' }], { company: 'Acme Ltd', firstName: null });
  check('template params have no new lines', tp.length === 2 && !/\n/.test(tp[1]) && tp[1] === '(1) one (2) two', tp);

  console.log('one account, owner on, no open chat, no template');
  let r = await W.watchAccount(U, { slot: 'morning' });
  check('found findings', r.found > 0, r);
  check('not sent: no session and no template', !r.sent && /24 hours/.test(r.not_sent || ''), r);
  check('nothing reached Gupshup', sent.length === 0, sent);
  check('findings kept for the app', DB.margyn_signals.length === r.found && DB.margyn_signals.every((s) => s.status === 'open'), DB.margyn_signals);

  console.log('owner texted Margyn an hour ago: free text goes out');
  DB.whatsapp_conversations.push({ profile_id: U, role: 'user', content: 'hi', from_phone: '919324000000', created_at: new Date(Date.now() - 3600000).toISOString() });
  r = await W.watchAccount(U, { slot: 'morning' });
  check('sent in the open chat', r.sent && r.sent.via === 'session' && r.sent.to === 'owner', r);
  check('to the owner\'s number', sent.length === 1 && sent[0].destination === '919324000000' && sent[0].path.endsWith('/msg'), sent);
  check('message lands in the owner\'s WhatsApp thread', DB.whatsapp_conversations.some((m) => m.role === 'assistant' && /Good morning Mihir/.test(m.content) && m.from_phone === '919324000000'));
  check('state says sent', DB.margyn_signals.filter((s) => s.status === 'sent').length === r.chosen.length, DB.margyn_signals);
  check('ops counter', DB.product_events.some((e) => e.name === 'watch_sent'));
  r = await W.watchAccount(U, { slot: 'evening' });
  check('same findings are not sent twice the same day', !r.sent && r.chosen.length === 0, r);

  console.log('outside 24h with the alert template');
  DB.whatsapp_conversations = [];
  DB.margyn_signals = [];
  process.env.WHATSAPP_TEMPLATE_ALERT = 'tpl-1';
  r = await W.watchAccount(U, { slot: 'morning' });
  check('sent by template', r.sent && r.sent.via === 'template', r);
  const last = sent[sent.length - 1];
  check('template id and two params', last.template && JSON.parse(last.template).id === 'tpl-1' && JSON.parse(last.template).params.length === 2, last);

  console.log('preview mode');
  DB.profiles[0].preferences.margyn_watch.mode = 'preview';
  DB.margyn_signals = [];
  r = await W.watchAccount(U, { slot: 'morning' });
  check('goes to the preview number, not the owner', r.sent && r.sent.to === 'preview' && sent[sent.length - 1].destination === '919999900000', { r, last: sent[sent.length - 1] });
  check('preview is not written into the owner\'s thread', !DB.whatsapp_conversations.some((m) => /Preview for/.test(m.content || '')));

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

  console.log('every account');
  const all = await W.runWatchAll('morning');
  check('runs over Tally accounts', all.accounts === 1 && all.results.length === 1, all);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
