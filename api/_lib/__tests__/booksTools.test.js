/** Run: node api/_lib/__tests__/booksTools.test.js — the books tools end to end over a fake Supabase:
 *  every tool answers, an account without Tally gets a plain note, the app chat, voice and WhatsApp
 *  all carry the same tools, and the voice endpoint (?action=books) runs them for the signed-in account. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };

const U = '11111111-1111-1111-1111-111111111111', NOBODY = '22222222-2222-2222-2222-222222222222';
const v = (type, date, party, amt, extra) => Object.assign({ tally_guid: 'g' + Math.random(), voucher_type: type, voucher_number: type[0] + Math.round(Math.random() * 1e6), date, party_name: party, amount: amt, is_cancelled: false,
  entries: type === 'Receipt' ? [{ ledger: party, amount: amt, is_party: true }, { ledger: 'Bank', amount: -amt }]
    : [{ ledger: party, amount: -amt, is_party: true }, { ledger: 'Sales', amount: amt }] }, extra || {});
const DB = {
  tally_installs: [{ id: 'i1', user_id: U, status: 'active', company_name: 'Acme', last_sync_at: new Date().toISOString() }],
  tally_ledgers: [{ name: 'Sales', parent: 'Sales Accounts' }, { name: 'Bank', parent: 'Bank Accounts', opening_balance: 100000 }, { name: 'Alpha Pharma Ltd', parent: 'Sundry Debtors' }],
  tally_vouchers: [v('Sales', '2026-08-05', 'Alpha Pharma Ltd', 2500000, { items: [{ item: 'Gloves', qty: 1000, amount: 2500000, abs_amount: 2500000 }] }), v('Receipt', '2026-08-20', 'Alpha Pharma Ltd', 1000000)],
  tally_bills: [{ direction: 'receivable', party_name: 'Alpha Pharma Ltd', bill_ref: 'A1', closing_balance: 1500000, overdue_days: 30 }],
  tally_ledger_classes: [], tally_sync_runs: []
};
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.pathname === '/auth/v1/user') return ok({ id: U, email: 'a@b.c' });
  const table = u.pathname.replace('/rest/v1/', '');
  const want = (u.searchParams.get('user_id') || '').replace('eq.', '');
  let rows = DB[table] || [];
  if (table === 'tally_installs' && want) rows = rows.filter((r) => r.user_id === want);
  const off = parseInt(u.searchParams.get('offset') || '0', 10), lim = parseInt(u.searchParams.get('limit') || '1000', 10);
  return ok((opts.method || 'GET') === 'GET' ? rows.slice(off, off + lim) : []);
};

const B = require('../booksTools');

(async () => {
  console.log('every tool answers from the books');
  const calls = {
    books_summary: { period: 'this_fy' }, books_breakdown: { measure: 'sales', by: 'customer' }, customer_or_vendor: { name: 'alpha' },
    products: { sort: 'sales' }, money_owed: {}, find_entries: { kind: 'receipt' }, cash_and_loans: {}, what_needs_attention: {}
  };
  for (const [name, input] of Object.entries(calls)) {
    const out = await B.exec(name, input, U);
    check(name + ' answers', out && !out.error && (out.source || out.things_to_know), out);
  }
  const s = await B.exec('books_summary', {}, U);
  check('sales in lakh', s.sales_before_gst === '₹25 L', s.sales_before_gst);
  const p = await B.exec('customer_or_vendor', { name: 'alpha' }, U);
  check('customer owes', p.owes_you && p.owes_you.total === '₹15 L', p.owes_you);

  console.log('no Tally, unknown tool');
  const none = await B.exec('books_summary', {}, NOBODY);
  check('plain note when no books are connected', none.connected === false && /No books are connected/.test(none.note), none);
  check('unknown tool', (await B.exec('drop_tables', {}, U)).error);

  console.log('team permissions');
  check('a member without cash access is refused cash', /doesn't include/.test((await B.exec('cash_and_loans', {}, U, ['view', 'view_receivables'])).error || ''));
  check('the same member may see receivables', !(await B.exec('money_owed', {}, U, ['view', 'view_receivables'])).error);
  check('the owner sees everything', !(await B.exec('cash_and_loans', {}, U, null)).error);

  console.log('same tools on every channel');
  const reg = require('../agentRegistry');
  const names = new Set(reg.getAgent().tools.map((t) => t.name));
  check('typed chat has every books tool', B.TOOLS.every((t) => names.has(t.name)));
  check('books tools are in Anthropic shape', B.TOOLS.every((t) => t.input_schema && t.input_schema.type === 'object' && t.description.length > 40));
  const M = await import('../../ask-margyn.js');
  const rt = new Set(M.REALTIME_TOOLS.map((t) => t.name));
  check('voice has every books tool (formulas come through explain instead)', B.TOOLS.every((t) => rt.has(t.name) || t.name === 'how_its_calculated'));
  check('voice books tools are in Realtime shape', M.REALTIME_TOOLS.filter((t) => B.has(t.name)).every((t) => t.type === 'function' && t.parameters));
  check('panel screen tools do not duplicate books tools', !M.APP_TOOLS.some((t) => B.has(t.name)));
  const allNames = [...reg.getAgent().tools, ...M.APP_TOOLS].map((t) => t.name);
  check('no duplicate tool names in the panel', allNames.length === new Set(allNames).size, allNames);

  console.log('voice endpoint');
  const handler = M.default;
  const call = async (body, query) => {
    let status, payload;
    const res = { setHeader() {}, status(x) { status = x; return this; }, json(x) { payload = x; return this; }, end() {}, send() {} };
    await handler({ method: 'POST', query: query || { action: 'books' }, headers: { authorization: 'Bearer t' }, body }, res);
    return { status, payload };
  };
  let r = await call({ tool: 'money_owed', input: {} });
  check('?action=books runs a tool for the signed-in account', r.status === 200 && r.payload.total === '₹15 L', r);
  r = await call({ tool: 'nope' });
  check('?action=books refuses unknown tools', r.status === 400, r);

  console.log('watch status is readable with GET');
  {
    let status, payload;
    const res = { setHeader() {}, status(x) { status = x; return this; }, json(x) { payload = x; return this; }, end() {}, send() {} };
    await handler({ method: 'GET', query: { action: 'watch' }, headers: { authorization: 'Bearer t' } }, res);
    check('GET ?action=watch is not refused as a non-POST', status === 200 && payload && 'mode' in payload, { status, payload });
    let s2;
    const res2 = { setHeader() {}, status(x) { s2 = x; return this; }, json() { return this; }, end() {}, send() {} };
    await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer t' } }, res2);
    check('other GETs are still refused', s2 === 405, s2);
  }

  console.log('prompts');
  const sys = M.buildSystemPrompt({ companyName: 'Acme' }, reg.getAgent(), { inPanel: true });
  check('chat prompt tells Margyn to use the books', /YOUR BOOKS \(TALLY\)/.test(sys[0].text) && /Never say you can only see the last 30 days/.test(sys[0].text));
  check('chat prompt: copy money exactly', /Never convert between lakh and crore/.test(sys[0].text));
  check('identity no longer promises chasing on its own', !/you chase overdue customers/.test(reg.getAgent().identity));
  const voice = M.buildRealtimeInstructions({ companyName: 'Acme' });
  check('voice prompt names the books tools', /books_summary/.test(voice) && /Never turn crore into lakh/.test(voice));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
