/**
 * Streamed Margyn replies (api/ask-margyn.js, stream:true): words arrive as `delta` events, a tool round's
 * lead-in is cleared with `reset`, and `done` carries the same body the JSON reply has. Without stream:true the
 * reply is unchanged JSON. Fake Supabase and a fake Anthropic stream, no network. Run:
 *   node api/_lib/__tests__/askMargynStream.test.js
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'k';
process.env.MARGYN_RESUME_SECRET = 'test-secret';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const U = '11111111-1111-4111-8111-111111111111';
const ev = (o) => 'event: ' + o.type + '\ndata: ' + JSON.stringify(o) + '\n\n';
function sseBody(text) {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return { getReader: () => ({ read: async () => { if (pos >= bytes.length) return { done: true }; const v = bytes.slice(pos, pos + 11); pos += 11; return { value: v, done: false }; } }) };
}
function textTurn(words) {
  return [ev({ type: 'message_start', message: { id: 'm', model: 'x', role: 'assistant', usage: { input_tokens: 5 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...words.map((w) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } })),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }), ev({ type: 'message_stop' })].join('');
}
function toolTurn(lead, tool) {
  return [ev({ type: 'message_start', message: { id: 'm', model: 'x', role: 'assistant', usage: { input_tokens: 5 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: lead } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: tool, input: {} } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    ev({ type: 'content_block_stop', index: 1 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }), ev({ type: 'message_stop' })].join('');
}
let turns = [], anthropicBodies = [], overCap = false;
global.fetch = async (url, init) => {
  url = String(url);
  if (url.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: U, email: 'a@b.c' }) };
  if (url.includes('api.anthropic.com')) {
    const body = JSON.parse(init.body); anthropicBodies.push(body);
    const t = turns.shift();
    if (body.stream) return { ok: true, body: sseBody(t.sse) };
    return { ok: true, json: async () => t.json };
  }
  if (overCap && url.includes('/rest/v1/chat_messages')) { const rows = Array.from({ length: 700 }, (_, i) => ({ id: i })); return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows), headers: { get: () => null } }; }
  return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
};
function mkRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], ended: false, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.flushHeaders = () => {};
  r.write = (c) => { r.chunks.push(String(c)); return true; };
  r.end = () => { r.ended = true; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  return r;
}
function events(res) {
  return res.chunks.join('').split('\n\n').filter(Boolean).map((blk) => {
    const e = /^event: (.+)$/m.exec(blk), d = /^data: (.+)$/m.exec(blk);
    return { ev: e && e[1], data: d ? JSON.parse(d[1]) : null };
  });
}
(async () => {
  const M = await import('../../ask-margyn.js');
  const req = (body) => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, query: {}, body });

  // streamed, one round
  turns = [{ sse: textTurn(['You are ', 'owed ', '₹5 L.']) }];
  let res = mkRes();
  await M.default(req({ message: 'how much am I owed?', history: [], context: {}, depth: 'quick', surface: 'panel', stream: true }), res);
  let E = events(res);
  check('asks Anthropic to stream', anthropicBodies[0] && anthropicBodies[0].stream === true);
  check('sent as Server-Sent Events', /text\/event-stream/.test(res.headers['content-type'] || ''), res.headers);
  check('words arrive as deltas, in order', E.filter((x) => x.ev === 'delta').map((x) => x.data.t).join('') === 'You are owed ₹5 L.', E);
  const done = E.find((x) => x.ev === 'done');
  check('done carries the reply and status 200', done && done.data.status === 200 && done.data.reply === 'You are owed ₹5 L.', done);
  check('the stream is closed', res.ended);

  // streamed, a server tool round first: its lead-in is reset
  anthropicBodies = [];
  turns = [{ sse: toolTurn('Let me check. ', 'list_chase_targets') }, { sse: textTurn(['Nobody ', 'is being chased.']) }];
  res = mkRes();
  await M.default(req({ message: 'who are you chasing?', history: [], context: {}, depth: 'quick', surface: 'panel', stream: true }), res);
  E = events(res);
  const iReset = E.findIndex((x) => x.ev === 'reset'), iLast = E.map((x) => x.ev).lastIndexOf('delta');
  check('a tool round\'s lead-in is cleared before the answer', iReset > 0 && iLast > iReset, E.map((x) => x.ev));
  const after = E.slice(iReset + 1).filter((x) => x.ev === 'delta').map((x) => x.data.t).join('');
  check('what follows the reset is the answer', after === 'Nobody is being chased.', after);
  const d2 = E.find((x) => x.ev === 'done');
  check('done has the final answer only', d2 && d2.data.reply === 'Nobody is being chased.', d2);
  check('the tool round went back to Claude with the tool result', anthropicBodies.length === 2 && JSON.stringify(anthropicBodies[1].messages).includes('tool_result'));

  // not streamed: unchanged JSON
  turns = [{ json: { content: [{ type: 'text', text: 'Plain.' }], stop_reason: 'end_turn', usage: {} } }];
  res = mkRes();
  await M.default(req({ message: 'hi there', history: [], context: {}, depth: 'quick', surface: 'panel' }), res);
  check('without stream:true the reply is JSON as before', res.body && res.body.reply === 'Plain.' && !res.chunks.length, res.body);

  // an early refusal (bad input) on a streamed request is plain JSON with its status
  res = mkRes();
  await M.default(req({ message: '', history: [], stream: true, surface: 'panel' }), res);
  check('an error before any word is plain JSON with its status', res.statusCode === 400 && res.body && res.body.error && !res.chunks.length, { s: res.statusCode, b: res.body });

  // over the daily limit: nothing is streamed, the answer is the usual 429
  overCap = true;
  turns = [{ sse: textTurn(['This ', 'should ', 'not show.']) }];
  res = mkRes();
  await M.default(req({ message: 'how much cash?', history: [], context: {}, depth: 'quick', surface: 'panel', stream: true }), res);
  check('over the limit: a 429, and no word of the answer went out', res.statusCode === 429 && !res.chunks.join('').includes('should'), { s: res.statusCode, c: res.chunks.join('').slice(0, 200) });
  overCap = false;

  // warm-up: reads the books, no model call
  anthropicBodies = [];
  res = mkRes();
  await M.default({ method: 'POST', headers: { authorization: 'Bearer tok' }, query: { action: 'warm' }, body: {} }, res);
  check('warm-up answers ok without calling the model', res.body && res.body.ok === true && anthropicBodies.length === 0, res.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
