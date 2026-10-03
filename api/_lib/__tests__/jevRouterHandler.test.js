/**
 * The front door inside the real chat handler (api/ask-margyn.js), with
 * Supabase, Claude and Jev faked at fetch(). Checks what Claude is actually
 * sent in live and shadow mode, the fixed greeting, the retry with every tool,
 * a paused panel turn keeping its pick, and an outage. Zero-dep, no network.
 * Run: node api/_lib/__tests__/jevRouterHandler.test.js
 */
process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.ANTHROPIC_API_KEY = 'ak';
process.env.JEV_API_KEY = 'jk';
process.env.MARGYN_RESUME_SECRET = 'test-secret';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const UID = '22222222-2222-4222-8222-222222222222';
const NO = (p) => ({ type: 'noul', noul: p });
const CH = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
let jevAnswers = null, jevDown = false, claudeQueue = [], claudeCalls = [], jevCalls = [];
const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/auth/v1/user')) return ok({ id: UID });
  if (url.includes('/rest/v1/ledger_parties')) return ok([{ name: 'Sharma Traders' }]);
  if (url.includes('/rest/v1/')) return ok([]);
  if (url.includes('typesafe')) { jevCalls.push(JSON.parse(init.body)); if (jevDown) throw new Error('down'); return ok({ answers: jevAnswers, usage: {} }); }
  if (url.includes('anthropic')) { const b = JSON.parse(init.body); claudeCalls.push(b); return ok(claudeQueue.shift() || { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }); }
  throw new Error('unexpected fetch ' + url);
};
const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: {} });
const answers = (o) => Object.assign({ depth: CH('balanced', 0.6), talk: CH('work', 0.99), g_books: NO(0.05), g_change: NO(0.05), g_chase: NO(0.05), g_imports: NO(0.05), g_screen: NO(0.05), g_show: NO(0.05) }, o);
function call(handler, body) {
  const req = { method: 'POST', query: {}, headers: { authorization: 'Bearer t' }, body };
  return new Promise((resolve) => {
    const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler(req, res);
  });
}
const names = (b) => (b.tools || []).map(t => t.name);

(async () => {
  const M = await import('../../ask-margyn.js');
  const H = M.default;
  const logs = []; const origLog = console.log;
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[jev-router]')) logs.push(s); else if (!s.startsWith('[claude-usage]') && !s.startsWith('[ask-margyn]')) origLog(...a); };

  // live: a one-fact books question
  process.env.JEV_MODE_ROUTER = 'live';
  jevAnswers = answers({ g_books: NO(0.96), depth: CH('quick', 0.95) });
  claudeCalls = []; claudeQueue = [text('Sharma owes the most.')];
  let r = await call(H, { message: 'who owes me the most, is Sharma Traders top?', history: [], depth: 'balanced' });
  check('live: reply comes back', r.code === 200 && r.body.reply === 'Sharma owes the most.', r);
  check('live: Claude gets only the books tools (8 of 14)', claudeCalls.length === 1 && names(claudeCalls[0]).length === 8 && !names(claudeCalls[0]).includes('propose_action'), names(claudeCalls[0]));
  check('live: Balanced dropped to Quick (Haiku)', /haiku/.test(claudeCalls[0].model) && r.body.depth === 'quick');
  check('live: the last sent tool carries the cache mark', claudeCalls[0].tools[claudeCalls[0].tools.length - 1].cache_control);
  check('Jev never saw the customer name', !/sharma/i.test(JSON.stringify(jevCalls)));
  check('one log line, no text', logs.length === 1 && /chat live/.test(logs[0]) && !/sharma|owes/i.test(logs[0]), logs);

  // live: a change request keeps propose_action and Balanced
  jevAnswers = answers({ g_books: NO(0.5), g_change: NO(0.97), depth: CH('quick', 0.95) });
  claudeCalls = []; claudeQueue = [text('Shall I?')];
  r = await call(H, { message: 'mark it paid', history: [], depth: 'balanced' });
  check('live: change request sends propose_action, stays Balanced', names(claudeCalls[0]).includes('propose_action') && !/haiku/.test(claudeCalls[0].model), [names(claudeCalls[0]), claudeCalls[0].model]);

  // live: the user's own Deep is never lowered
  jevAnswers = answers({ g_books: NO(0.96), depth: CH('quick', 0.99) });
  claudeCalls = []; claudeQueue = [text('x')];
  await call(H, { message: 'cash?', history: [], depth: 'deep' });
  check('live: a chosen Deep stays Deep', /opus/.test(claudeCalls[0].model));

  // live: greeting
  jevAnswers = answers({ talk: CH('greeting', 0.99), depth: CH('quick', 0.99) });
  claudeCalls = [];
  r = await call(H, { message: 'hello', history: [], depth: 'balanced', context: { app: { firstName: 'Varad' } } });
  check('live: a bare greeting gets a fixed reply, no Claude call', claudeCalls.length === 0 && /^Hi Varad!/.test(r.body.reply) && r.body.model === 'none', r.body);

  // live: trimmed too far -> retried with every tool
  jevAnswers = answers({ g_imports: NO(0.9) });
  claudeCalls = []; claudeQueue = [text("I don't have that data yet."), text('Here it is.')];
  r = await call(H, { message: 'what came in from the forwarded stuff', history: [], depth: 'balanced' });
  check('live: an "I can\'t see that" reply retries with all 14 tools', claudeCalls.length === 2 && names(claudeCalls[0]).length < 14 && names(claudeCalls[1]).length === 14 && r.body.reply === 'Here it is.', claudeCalls.map(names));
  check('live: the retry is logged', /retry=1/.test(logs[logs.length - 1]), logs[logs.length - 1]);

  // live: a short "yes" -> full set, Jev not asked
  jevCalls = []; claudeCalls = []; claudeQueue = [text('Done.')];
  await call(H, { message: 'haan kar do', history: [{ role: 'user', content: 'remind sharma' }, { role: 'assistant', content: 'Shall I send it?' }], depth: 'balanced' });
  check('live: "haan kar do" goes with every tool and no Jev call', jevCalls.length === 0 && names(claudeCalls[0]).length === 14);

  // live: Jev down -> today's turn
  jevDown = true; claudeCalls = []; claudeQueue = [text('ok')];
  await call(H, { message: 'sales this month', history: [], depth: 'balanced' });
  check('live: Jev outage = full tools at the asked depth', names(claudeCalls[0]).length === 14 && !/haiku/.test(claudeCalls[0].model));
  jevDown = false;

  // live panel: a paused turn keeps its pick
  jevAnswers = answers({ g_books: NO(0.95), g_screen: NO(0.9), depth: CH('balanced', 0.9) });
  claudeCalls = [];
  claudeQueue = [{ content: [{ type: 'tool_use', id: 'tu1', name: 'navigate', input: { page: 'cash' } }], stop_reason: 'tool_use', usage: {} }, text('Cash is open.')];
  r = await call(H, { message: 'open cash and tell me the balance', history: [], depth: 'balanced', surface: 'panel' });
  const sent1 = names(claudeCalls[0]);
  check('panel: paused for the browser with the pick in the signed state', r.body.clientCalls && r.body.resume && r.body.resume.rt && r.body.resume.rt.g.join() === 'books,screen', r.body.resume && r.body.resume.rt);
  check('panel: trimmed below 37 tools, core tools present', sent1.length < 37 && ['get_screen', 'show_view', 'navigate'].every(n => sent1.includes(n)), sent1.length);
  jevCalls = [];
  r = await call(H, { resume: Object.assign({}, r.body.resume, { results: [{ id: 'tu1', content: '{"ok":true}' }] }), depth: 'balanced', surface: 'panel' });
  check('panel: resume uses the same tools, no new Jev call', r.body.reply === 'Cash is open.' && JSON.stringify(names(claudeCalls[1])) === JSON.stringify(sent1) && jevCalls.length === 0);

  // shadow: Claude sees exactly today's request
  process.env.JEV_MODE_ROUTER = 'shadow';
  jevAnswers = answers({ g_books: NO(0.96), depth: CH('quick', 0.95), talk: CH('work', 0.99) });
  claudeCalls = []; logs.length = 0;
  claudeQueue = [{ content: [{ type: 'tool_use', id: 'a', name: 'money_owed', input: {} }, { type: 'tool_use', id: 'b', name: 'list_chase_targets', input: {} }], stop_reason: 'tool_use', usage: {} }, text('Done.')];
  r = await call(H, { message: 'who owes me', history: [], depth: 'balanced' });
  check('shadow: Claude gets all 14 tools at Balanced', names(claudeCalls[0]).length === 14 && !/haiku/.test(claudeCalls[0].model));
  check('shadow: log compares the pick with what Claude used', logs.length === 1 && /chat shadow/.test(logs[0]) && /g=books/.test(logs[0]) && /miss=change\+chase|miss=chase\+change/.test(logs[0]), logs);
  jevAnswers = answers({ talk: CH('greeting', 0.99) }); claudeCalls = [];
  r = await call(H, { message: 'hello', history: [], depth: 'balanced' });
  check('shadow: a greeting still goes to Claude', claudeCalls.length === 1);

  // off
  delete process.env.JEV_MODE_ROUTER; jevCalls = []; logs.length = 0;
  await call(H, { message: 'who owes me', history: [], depth: 'balanced' });
  check('off: no Jev call, no log line', jevCalls.length === 0 && logs.length === 0);

  console.log = origLog;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
