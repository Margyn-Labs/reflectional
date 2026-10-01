/**
 * AI cost controls — zero-dep. Run: node api/_lib/__tests__/aiCost.test.mjs
 *
 * No network, no keys: global fetch is replaced with a fake that answers
 * Anthropic and Supabase calls and records every request body, so each test
 * can assert what would actually be sent (and billed).
 *
 * Covers:
 *   1. Reasoning follows the job: narrate=low, judge=medium, extract=medium,
 *      reconcile=high; Haiku gets no effort field.
 *   2. Chat: instructions cached as their own block, business data after it,
 *      automatic tail caching on.
 *   3. Chat: an empty cheap reply escalates once, one level up.
 *   4. Close agent Tier 2: an unchanged cluster is skipped; LLM kinds map onto
 *      the agent_actions check constraint.
 *   5. WhatsApp: ledger tool returns aging totals + at most 40 rows; the
 *      second call in the tool loop re-sends the identical cached prefix.
 *   6. Import mapper: unreadable output retries once at high.
 *   7. Briefing: rejected without a login, never reaching Claude.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.WHATSAPP_BSP = process.env.WHATSAPP_BSP || 'gupshup';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- fake fetch -----------------------------------------------------------
let claudeQueue = [];      // responses handed out to Anthropic calls, in order
let claudeBodies = [];     // bodies Anthropic received
let supabase = () => [];   // (path) => rows
function reset() { claudeQueue = []; claudeBodies = []; supabase = () => []; }
const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) {
    claudeBodies.push(JSON.parse(init.body));
    const next = claudeQueue.shift();
    if (!next) throw new Error('unexpected extra Claude call');
    return json({ usage: { input_tokens: 1, output_tokens: 1 }, ...next });
  }
  if (url.startsWith('https://sb.test/auth/v1/user')) {
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    return auth.includes('good-token') ? json({ id: 'user-1' }) : json({}, 401);
  }
  if (url.startsWith('https://sb.test/rest/v1/')) {
    const path = url.slice('https://sb.test/rest/v1/'.length);
    if ((init.method || 'GET') !== 'GET') return json([]);
    const rows = supabase(path);
    return rows === null ? json({ message: 'relation does not exist' }, 404) : json(rows);
  }
  return json({ ok: true });  // WhatsApp BSP etc.
};
const text = (t, stop = 'end_turn') => ({ content: [{ type: 'text', text: t }], stop_reason: stop });
function fakeRes() {
  const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {}, send(b) { r.body = b; } };
  return r;
}

// ---- 1. helper ------------------------------------------------------------
console.log('1. reasoning follows the job');
const claude = require('../claude.js');
{
  reset();
  claudeQueue = [text('a'), text('b'), text('c'), text('d'), text('e')];
  await claude.callClaude({ job: 'narrate', model: 'claude-sonnet-5', max_tokens: 10, messages: [] });
  await claude.callClaude({ job: 'judge', model: 'claude-sonnet-5', max_tokens: 10, messages: [] });
  await claude.callClaude({ job: 'extract', model: 'claude-sonnet-5', max_tokens: 10, messages: [] });
  await claude.callClaude({ job: 'reconcile', model: 'claude-sonnet-5', max_tokens: 10, messages: [] });
  await claude.callClaude({ job: 'narrate', model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [] });
  const efforts = claudeBodies.map(b => b.output_config && b.output_config.effort);
  check('narrate/judge/extract/reconcile = low/medium/medium/high', JSON.stringify(efforts.slice(0, 4)) === JSON.stringify(['low', 'medium', 'medium', 'high']), JSON.stringify(efforts));
  check('Haiku gets no effort field', !claudeBodies[4].output_config);
  check('escalate is capped at high', claude.escalate('low') === 'medium' && claude.escalate('high') === 'high');
}

// ---- 2 + 3. chat ----------------------------------------------------------
console.log('2/3. Ask Margyn chat');
const askMargyn = (await import('../../ask-margyn.js')).default;
const chatReq = (depth) => ({
  method: 'POST', query: {}, headers: { authorization: 'Bearer good-token' },
  body: { message: 'how is cash?', history: [], depth, context: { companyName: 'Acme Traders' } }
});
{
  reset();
  claudeQueue = [text('Cash is ₹4L.')];
  const res = fakeRes();
  await askMargyn(chatReq('balanced'), res);
  const b = claudeBodies[0];
  check('reply returned', res.body && res.body.reply === 'Cash is ₹4L.', JSON.stringify(res.body));
  check('balanced runs at low reasoning', b.output_config && b.output_config.effort === 'low');
  check('system = [cached instructions, data]', Array.isArray(b.system) && b.system.length === 2 && b.system[0].cache_control && !b.system[1].cache_control);
  check('instructions carry no business name', !b.system[0].text.includes('Acme Traders') && b.system[1].text.includes('Acme Traders'));
  check('automatic tail caching on', b.cache_control && b.cache_control.type === 'ephemeral');

  reset();
  claudeQueue = [{ content: [], stop_reason: 'end_turn' }, text('Cash is ₹4L.')];
  const res2 = fakeRes();
  await askMargyn(chatReq('balanced'), res2);
  check('empty reply escalates once, low -> medium', claudeBodies.length === 2 && claudeBodies[1].output_config.effort === 'medium' && res2.body.reply === 'Cash is ₹4L.');

  reset();
  claudeQueue = [text('Deep answer.')];
  await askMargyn(chatReq('deep'), fakeRes());
  check('deep runs at medium', claudeBodies[0].output_config.effort === 'medium' && claudeBodies[0].model === 'claude-opus-5-5');

  reset();
  claudeQueue = [text('Quick.')];
  await askMargyn(chatReq('quick'), fakeRes());
  check('quick (Haiku) sends no effort', !claudeBodies[0].output_config);
}

// ---- 4. Close agent Tier 2 ------------------------------------------------
console.log('4. Close agent Tier 2');
const { runLlmTier } = require('../closeCollectionsLlmTier.js');
{
  const bundle = {
    invoices: [{ ref: 'INV1', party: 'Acme', amount: 1000, date: '2026-09-01', dueDate: '2026-09-15' }],
    booksPayments: [{ ref: 'BP1', invoiceRef: 'INV1', amount: 1000, date: '2026-09-10' }],
    gateway: [{ id: 'G1', amount: 1000, date: '2026-09-10', status: 'captured' }],
    bills: []
  };
  const exceptions = [{ ref: 'BP1', party: 'Acme', amount: 1000, date: '2026-09-10', invoiceRef: 'INV1' }];
  const toolCall = { content: [{ type: 'tool_use', id: 't1', name: 'propose', input: { kind: 'match', confidence: 0.8, invoiceRefs: ['INV1'], booksRefs: ['BP1'], gatewayIds: ['G1'], reason: 'same amount' } }], stop_reason: 'tool_use' };

  reset();
  claudeQueue = [toolCall];
  const first = await runLlmTier(bundle, exceptions, { keyPrefix: 'tally|' });
  check('first night: one call, attempt recorded', claudeBodies.length === 1 && first.attempts.length === 1);
  check('LLM "match" maps to queue kind reconcile_match', first.proposals[0] && first.proposals[0].kind === 'reconcile_match', first.proposals[0] && first.proposals[0].kind);
  check('reconcile runs at high with cached instructions', claudeBodies[0].output_config.effort === 'high' && claudeBodies[0].system[0].cache_control);

  reset();
  const seen = new Set(first.attempts.map(a => a.cluster_key + ':' + a.ctx_hash));
  const second = await runLlmTier(bundle, exceptions, { keyPrefix: 'tally|', seen });
  check('next night, same rows: no call', claudeBodies.length === 0 && second.skipped === 1);

  reset();
  claudeQueue = [toolCall];
  const changed = { ...bundle, invoices: [...bundle.invoices, { ref: 'INV2', party: 'Acme', amount: 500, date: '2026-09-20' }] };
  await runLlmTier(changed, exceptions, { keyPrefix: 'tally|', seen });
  check('new invoice for the party: tried again', claudeBodies.length === 1);
}

// ---- 5. WhatsApp ----------------------------------------------------------
console.log('5. WhatsApp agent');
const { runConversation } = require('../whatsappAgent.js');
{
  reset();
  const bills = Array.from({ length: 200 }, (_, i) => ({ party_name: 'Party ' + i, closing_balance: 1000 + i, due_date: new Date(Date.now() - (i % 120) * 86400000).toISOString().slice(0, 10), direction: 'receivable' }));
  supabase = (path) => {
    if (path.startsWith('tally_installs')) return [{ id: 'inst-1' }];
    if (path.startsWith('tally_bills')) return bills;
    if (path.startsWith('profiles')) return [{ company_name: 'Acme Traders' }];
    return [];
  };
  claudeQueue = [
    { content: [{ type: 'tool_use', id: 'tu1', name: 'list_receivables', input: {} }], stop_reason: 'tool_use' },
    text('₹2L is over 90 days.')
  ];
  await runConversation({ profileId: 'user-1', fromPhone: '919999999999', sender: null, text: 'who owes me 90+ days', wamid: 'w-' + Date.now() });
  const second = claudeBodies[1];
  const result = second && JSON.parse(second.messages[second.messages.length - 1].content[0].content);
  check('two calls, both low reasoning', claudeBodies.length === 2 && claudeBodies.every(b => b.output_config.effort === 'low'));
  check('instructions cached, business name only in ACCOUNT block', second.system[0].cache_control && !second.system[0].text.includes('Acme Traders') && second.system[1].text.includes('Acme Traders'));
  check('same cached prefix on both calls', JSON.stringify(claudeBodies[0].system) === JSON.stringify(second.system) && JSON.stringify(claudeBodies[0].tools) === JSON.stringify(second.tools));
  check('ledger tool: capped list of 200, ageing totals present', result && Array.isArray(result.open_receivables) && result.open_receivables.length < 200 && result.ageing && /of 200/.test(result.showing || ''), result && JSON.stringify(Object.keys(result)));
}

// ---- 6. import mapper -----------------------------------------------------
console.log('6. import mapper');
const { runImportMapper } = require('../importMapper.js');
{
  reset();
  claudeQueue = [text('sorry, I cannot tell'), text('{"entries":[{"target":"revenue","label":"Sales","amount":5000,"confidence":0.9}],"anomalies":[],"unmapped":[]}')];
  const { proposal } = await runImportMapper({ kind: 'workbook', skeleton: '[["Sales",5000]]', business: 'Acme' }, 'k');
  check('unreadable first try retries once at high', claudeBodies.length === 2 && claudeBodies[0].output_config.effort === 'medium' && claudeBodies[1].output_config.effort === 'high');
  check('proposal from the retry', proposal.entries.length === 1 && proposal.entries[0].target === 'revenue');
}

// ---- 7. briefing auth -----------------------------------------------------
console.log('7. briefing');
const briefing = (await import('../../generate-briefing.js')).default;
{
  reset();
  const res = fakeRes();
  await briefing({ method: 'POST', headers: {}, body: { context: {} } }, res);
  check('no login -> 401, no Claude call', res.code === 401 && claudeBodies.length === 0);
  reset();
  claudeQueue = [text('Nothing urgent this week.')];
  const res2 = fakeRes();
  await briefing({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { context: { companyName: 'Acme' } } }, res2);
  check('signed in -> briefing at medium', res2.body && res2.body.briefing === 'Nothing urgent this week.' && claudeBodies[0].output_config.effort === 'medium');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
