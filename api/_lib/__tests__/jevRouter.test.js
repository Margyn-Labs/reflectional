/**
 * The front door (api/_lib/jevRouter.js + its use in api/ask-margyn.js and
 * api/_lib/whatsappAgent.js). Zero-dep, no network.
 * Run: node api/_lib/__tests__/jevRouter.test.js
 */
process.env.MARGYN_RESUME_SECRET = 'test-secret';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const R = require('../jevRouter');
const root = path.join(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const NO = (p) => ({ type: 'noul', noul: p });
const CH = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
const answers = (o = {}) => Object.assign({ depth: CH('balanced', 0.6), talk: CH('work', 0.99) },
  ...R.GROUP_IDS.map(g => ({ ['g_' + g]: NO(0.05) })), o);
const fakeFetch = (ans, calls) => async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ answers: ans, usage: {} }) }; };
const parties = ['Sun Pharma Laboratories Ltd', 'Sharma Traders', 'Mehta & Sons'];

(async () => {
  const M = await import('../../ask-margyn.js');
  const reg = require('../agentRegistry');
  const wa = require('../whatsappAgent');
  const FULL = { chat: reg.getAgent().tools, panel: [...reg.getAgent().tools, ...M.APP_TOOLS], whatsapp: wa.ALL_TOOLS };

  // groups cover the real tools
  const all = new Set([...FULL.panel, ...FULL.whatsapp].map(t => t.name));
  const grouped = new Set(R.GROUP_IDS.flatMap(g => R.GROUPS[g].tools));
  check('every group tool is a real tool', [...grouped].every(n => all.has(n)), [...grouped].filter(n => !all.has(n)));
  check('every real tool sits in a group', [...all].every(n => grouped.has(n)), [...all].filter(n => !grouped.has(n)));
  check('propose_action is in the change group', R.GROUPS.change.tools.includes('propose_action'));
  check('chat has no panel or WhatsApp-only groups', R.groupsFor('chat').join() === 'books,change,chase,imports');
  check('panel adds screen and show, WhatsApp adds relay', R.groupsFor('panel').includes('screen') && R.groupsFor('panel').includes('show') && R.groupsFor('whatsapp').includes('relay') && !R.groupsFor('panel').includes('relay'));
  check('Choice sizes are within Jev limits', Object.values(R.questions('panel')).every(q => q.type !== 'choice' || (Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255)));

  // what leaves us
  const re = R.partyRegex(parties);
  const red = R.redactMessage('sun pharma owes ₹4,50,000; mail a@b.co, call 9876543210, GSTIN 27ABCDE1234F1Z5, ref INV-000123, 2 lakh from mehta', re);
  check('names, amounts, phone, email, GSTIN and long numbers are gone', !/sun pharma|4,50,000|a@b\.co|9876543210|27ABCDE|000123|mehta|2 lakh/i.test(red), red);
  check('names become PARTY and amounts NUM', /PARTY owes NUM/.test(red) && /NUM from PARTY/.test(red), red);
  check('small numbers stay (top 5)', R.redactMessage('top 5 customers', null) === 'top 5 customers');
  check('a common word alone is not a name', !R.partyVariants(['Sales Corporation']).includes('Sales'));
  check('text is capped', R.redactMessage('x'.repeat(2000), null).length <= R.MAX_TEXT);

  process.env.JEV_API_KEY = 'k';
  const calls = [];
  const r1 = await R.route({ surface: 'chat', text: 'how much does Sharma Traders owe, call 9876543210', earlier: 'sales of sun pharma', userId: 'u1', depth: 'balanced' },
    { mode: 'live', loadNames: async () => parties, fetchImpl: fakeFetch(answers({ g_books: NO(0.95) }), calls) });
  const sent = calls[0];
  check('state is the redacted message, earlier message, where and a fixed note', Object.keys(sent.state).sort().join() === 'earlier_message,message,note,where', sent.state);
  check('no name or phone in what is sent', !/sharma|sun pharma|9876543210/i.test(JSON.stringify(sent)), sent.state);
  check('one call: depth, talk and one Noul per group', sent.questions.depth.type === 'choice' && sent.questions.talk.type === 'choice' && R.groupsFor('chat').every(g => sent.questions['g_' + g].type === 'noul'));
  check('live pick applied: books only', r1.apply.groups && r1.apply.groups.join() === 'books', r1);

  // gates
  const d = (o, text, surface = 'chat') => R.decide({ answers: answers(o) }, { text, surface });
  check('no Jev answer -> full tool set', R.decide(null, { text: 'sales?', surface: 'chat' }).full);
  check('a "yes / haan kar do" -> full tool set, Jev not asked', R.decide({ answers: answers() }, { text: 'haan kar do', surface: 'chat' }).full);
  const calls2 = [];
  await R.route({ surface: 'chat', text: 'yes', userId: 'u1' }, { mode: 'live', loadNames: async () => [], fetchImpl: fakeFetch(answers(), calls2) });
  check('confirmations never call Jev', calls2.length === 0);
  check('keyword rule adds a group even when Jev says no', d({}, 'mark it paid').groups.includes('change'));
  check('change goes in at a low probability (0.2)', d({ g_change: NO(0.2), g_books: NO(0.9) }, 'uska kya hua').groups.includes('change'));
  check('other groups need 0.4', !d({ g_chase: NO(0.3), g_books: NO(0.9) }, 'uska kya hua').groups.includes('chase') && d({ g_chase: NO(0.45), g_books: NO(0.9) }, 'uska kya hua').groups.includes('chase'));
  check('a missing Noul counts as needed', d({ g_imports: undefined, g_books: NO(0.9) }, 'uska kya hua').groups.includes('imports'));
  check('nothing picked -> full tool set', d({}, 'what can you do').full);
  check('every group picked -> full', d({ g_books: NO(1), g_change: NO(1), g_chase: NO(1), g_imports: NO(1) }, 'x y').full);

  // small talk
  const talk = (text, o = {}) => d(Object.assign({ talk: CH('greeting', 0.97) }, o), text).why === 'talk';
  check('bare greeting -> fixed reply', talk('hello margyn'));
  check('greeting with a figure word is not small talk', !talk('hi, how much cash do I have'));
  check('digits block small talk', !talk('hi 5'));
  check('a question mark blocks small talk', !talk('hello?'));
  check('a likely group blocks small talk', !talk('hey there', { g_books: NO(0.6) }));
  check('unsure talk blocks small talk', !talk('hello margyn', { talk: CH('greeting', 0.8) }));
  check('long message blocks small talk', !talk('hello hello hello hello hello hello hello'));
  check('ok / yes is never small talk', !talk('ok'));

  // depth
  const p = (o) => Object.assign({ full: false, groups: ['books'], depth: 'quick', depthConf: 0.95 }, o);
  check('Balanced drops to Quick when sure', R.liveDepth(p(), 'balanced') === 'quick');
  check('never with a change on the way', R.liveDepth(p({ groups: ['books', 'change'] }), 'balanced') === 'balanced');
  check('never when unsure', R.liveDepth(p({ depthConf: 0.7 }), 'balanced') === 'balanced');
  check('never raises, never overrides the user\'s Quick or Deep', R.liveDepth(p({ depth: 'deep' }), 'balanced') === 'balanced' && R.liveDepth(p(), 'deep') === 'deep');
  check('full pick keeps the asked depth', R.liveDepth(p({ full: true }), 'balanced') === 'balanced');

  // tools
  const sel = R.selectTools(FULL.panel, ['books'], 'panel').map(t => t.name);
  check('panel core always goes (get_screen, show_view, navigate)', ['get_screen', 'show_view', 'navigate'].every(n => sel.includes(n)));
  check('books pick sends books tools, no propose_action', sel.includes('books_breakdown') && !sel.includes('propose_action'));
  check('change pick sends propose_action and the row lookups', ['propose_action', 'list_open_ledger_items'].every(n => R.selectTools(FULL.chat, ['change'], 'chat').some(t => t.name === n)));
  check('a tool in no group is always sent', R.selectTools([{ name: 'brand_new_tool' }, { name: 'products' }], ['change'], 'chat').map(t => t.name).join() === 'brand_new_tool');
  check('order is kept (cache-friendly)', JSON.stringify(R.selectTools(FULL.chat, ['books', 'change'], 'chat').map(t => t.name)) === JSON.stringify(FULL.chat.filter(t => sel.includes(t.name) || R.GROUPS.change.tools.includes(t.name)).map(t => t.name)));

  // modes and failure
  delete process.env.JEV_MODE_ROUTER;
  check('off by default', R.mode() === 'off' && (await R.route({ surface: 'chat', text: 'hi', userId: 'u' })) === null);
  process.env.JEV_MODE_ROUTER = 'shadow';
  const sh = await R.route({ surface: 'chat', text: 'hi', userId: 'u2', depth: 'balanced' }, { loadNames: async () => [], fetchImpl: fakeFetch(answers({ talk: CH('greeting', 0.99) }), []) });
  check('shadow picks but applies nothing', sh.mode === 'shadow' && sh.pick.why === 'talk' && sh.apply.reply === null && sh.apply.groups === null && sh.apply.depth === 'balanced', sh);
  process.env.JEV_MODE_ROUTER = 'live';
  const lv = await R.route({ surface: 'panel', text: 'hello', userId: 'u3', depth: 'balanced', name: 'Varad Pandey' }, { loadNames: async () => [], fetchImpl: fakeFetch(answers({ talk: CH('greeting', 0.99) }), []) });
  check('live greeting gets a fixed reply with the first name', lv.apply.reply && /^Hi Varad!/.test(lv.apply.reply), lv.apply);
  const calls3 = [];
  const nop = await R.route({ surface: 'chat', text: 'sales of x', userId: 'u4', depth: 'balanced' }, { loadNames: async () => { throw new Error('db down'); }, fetchImpl: fakeFetch(answers(), calls3) });
  check('customer list unreadable -> Jev not called, full set', calls3.length === 0 && nop.pick.full && nop.apply.groups === null, nop.pick);
  const down = await R.route({ surface: 'chat', text: 'sales of x', userId: 'u5', depth: 'balanced' }, { loadNames: async () => [], fetchImpl: async () => { throw new Error('down'); } });
  check('Jev outage -> full set at the asked depth', down.pick.full && down.apply.groups === null && down.apply.depth === 'balanced');
  delete process.env.JEV_MODE_ROUTER;

  // log line
  const orig = console.log; let line = '';
  console.log = (s) => { line = s; };
  R.logLine(r1, { used: ['books_summary', 'list_chase_targets'], depthUsed: 'balanced', sent: 8, full: 14 });
  console.log = orig;
  check('log line has labels, not text', /^\[jev-router\] chat live pick=pick/.test(line) && !/sharma|owe|9876/i.test(line), line);
  check('log line names what Claude used outside the pick', /miss=change\+chase|miss=chase\+change/.test(line), line);

  // ask-margyn: the pick rides in the signed resume state
  const uid = '11111111-1111-4111-8111-111111111111';
  const messages = [{ role: 'user', content: 'open cash' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'navigate', input: { page: 'cash' } }] }];
  const rt = { m: 'live', p: R.slimPick(r1.pick), g: ['books'], d: 'quick' };
  const st = { messages, serverResults: [], round: 1, rt };
  const sig = M.signState(st, uid);
  const names = new Set(FULL.panel.map(t => t.name));
  check('a signed state with a pick resumes', M.checkResumeState({ ...st, sig, results: [{ id: 'tu1', content: '{}' }] }, uid, names).ok);
  check('an edited pick is refused', !M.checkResumeState({ ...st, rt: { ...rt, g: null }, sig, results: [] }, uid, names).ok);
  check('old states without a pick still resume', M.checkResumeState({ messages, serverResults: [], round: 1, sig: M.signState({ messages, serverResults: [], round: 1 }, uid), results: [] }, uid, names).ok);

  // wiring
  const am = read('api/ask-margyn.js');
  check('chat path runs the front door before Claude', /jevRouterPkg\.route\(/.test(am) && am.indexOf('jevRouterPkg.route(') < am.indexOf('await callClaude('));
  check('chat path retries with every tool when trimmed too far', /looksUnanswered\(finalText\)/.test(am) && /tools = fullTools/.test(am));
  const wsrc = read('api/_lib/whatsappAgent.js');
  check('WhatsApp runs it after the hard financial block', wsrc.indexOf('isHardFinancialCommand(cleanText)') < wsrc.indexOf('jevRouter.route('));
  check('WhatsApp retries with every tool when trimmed too far', /retried = true; tools = fullTools/.test(wsrc));
  const fns = fs.readdirSync(path.join(root, 'api')).filter(f => /\.(js|mjs|ts)$/.test(f));
  check('still 12 Vercel functions under api/', fns.length === 12, fns);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
