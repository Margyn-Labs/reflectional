/** Jev client: switches, fail-open, gates, cascade, redaction. Zero-dep. Run: node api/_lib/__tests__/jev.test.js */
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const jev = require('../jev');
const okFetch = (answers, calls) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13', answers, usage: { input_tokens: 50, output_tokens: 0 } }) }; };
const CH = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
const Q = { intent: jev.Choice('What is this message?', { ask: 'A question about data', change: 'A request to change something' }) };

(async () => {
  // switches
  delete process.env.JEV_API_KEY; process.env.JEV_MODE_ROUTER = 'live';
  check('no key means off, even if mode says live', jev.modeFor('router') === 'off');
  process.env.JEV_API_KEY = 'k';
  check('live when key and mode set', jev.modeFor('router') === 'live');
  check('unset job is off', jev.modeFor('imports') === 'off');
  process.env.JEV_MODE_ROUTER = 'banana';
  check('junk mode is off', jev.modeFor('router') === 'off');

  // builders
  check('Choice needs 2+ options', (() => { try { jev.Choice('x', { a: 'only' }); return false; } catch (e) { return true; } })());
  check('Score limited to 10 levels', (() => { try { jev.Score('x', Array(11).fill('l')); return false; } catch (e) { return true; } })());

  // wire format
  const calls = [];
  const r = await jev.systemOne({ msg: 'hi' }, Q, { fetchImpl: okFetch({ intent: CH('ask', 0.95) }, calls) });
  const body = JSON.parse(calls[0].init.body);
  check('sends model, state, questions with bearer key', body.model === 'jev-latest' && body.state.msg === 'hi' && body.questions.intent.type === 'choice' && calls[0].init.headers.Authorization === 'Bearer k', body);
  check('parses answers and usage', r.answers.intent.choice === 'ask' && r.usage.input_tokens === 50);

  // fail-open
  check('HTTP 429 returns null', (await jev.systemOne('s', Q, { fetchImpl: async () => ({ ok: false, status: 429 }) })) === null);
  check('network error returns null', (await jev.systemOne('s', Q, { fetchImpl: async () => { throw new Error('boom'); } })) === null);
  check('malformed body returns null', (await jev.systemOne('s', Q, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })) === null);
  check('timeout returns null', (await jev.systemOne('s', Q, { timeoutMs: 20, fetchImpl: (u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) })) === null);

  // gates
  check('pick returns label above threshold', jev.pick({ answers: { intent: CH('ask', 0.9) } }, 'intent', 0.8) === 'ask');
  check('pick returns null below threshold', jev.pick({ answers: { intent: CH('ask', 0.5) } }, 'intent', 0.8) === null);
  check('yesNo decisive true / false / unsure', jev.yesNo({ answers: { q: { type: 'noul', noul: 0.95 } } }, 'q') === true && jev.yesNo({ answers: { q: { type: 'noul', noul: 0.05 } } }, 'q') === false && jev.yesNo({ answers: { q: { type: 'noul', noul: 0.5 } } }, 'q') === null);

  // cascade
  const decide = (res) => jev.pick(res, 'intent', 0.8);
  let fb = 0; const fallback = async () => { fb++; return 'claude'; };
  process.env.JEV_MODE_ROUTER = 'off';
  let c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide, fallback, fetchImpl: okFetch({ intent: CH('ask', 0.99) }, []) });
  check('off: only fallback, Jev not called', c.source === 'fallback' && c.value === 'claude' && c.jev === null);

  process.env.JEV_MODE_ROUTER = 'shadow'; let seen = null;
  c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide, fallback, onShadow: (res, v) => { seen = { res, v }; }, fetchImpl: okFetch({ intent: CH('ask', 0.99) }, []) });
  check('shadow: fallback decides, both recorded', c.source === 'fallback' && seen.v === 'claude' && seen.res.answers.intent.choice === 'ask');

  process.env.JEV_MODE_ROUTER = 'live'; fb = 0;
  c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide, fallback, fetchImpl: okFetch({ intent: CH('ask', 0.99) }, []) });
  check('live + confident: Jev decides, Claude not called', c.source === 'jev' && c.value === 'ask' && fb === 0);
  c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide, fallback, fetchImpl: okFetch({ intent: CH('ask', 0.4) }, []) });
  check('live + unsure: escalates to fallback', c.source === 'fallback' && fb === 1);
  c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide, fallback, fetchImpl: async () => { throw new Error('down'); } });
  check('live + Jev down: falls back, no error', c.source === 'fallback' && c.value === 'claude');
  c = await jev.jevCascade({ job: 'router', state: 's', questions: Q, decide: () => { throw new Error('bad'); }, fallback, fetchImpl: okFetch({ intent: CH('ask', 0.99) }, []) });
  check('live + decide throws: falls back', c.source === 'fallback');

  // redaction
  const red = jev.redact('Lakshmi Traders (27AAKCA1234F1Z5) paid to a/c 123456789012, call 9876543210 or a@b.com. Lakshmi Traders again.', { parties: ['Lakshmi Traders'] });
  check('identifiers replaced by tokens', !/AAKCA|123456789012|9876543210|a@b\.com|Lakshmi/.test(red.text), red.text);
  check('same party gets the same token', (red.text.match(/PARTY_1/g) || []).length === 2 && red.map.PARTY_1 === 'Lakshmi Traders');

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
