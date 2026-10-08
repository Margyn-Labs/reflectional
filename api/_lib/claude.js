/**
 * _lib/claude.js
 * One place for how Margyn calls Claude: reasoning level, prompt caching, and
 * a usage log line per call. Every paid Claude call in /api goes through
 * callClaude() so cost behaviour is decided here, not re-invented per file.
 *
 * REASONING FOLLOWS THE JOB, NOT THE ENDPOINT
 * Sonnet 5.5 thinks by default at effort "high" and Opus 5.5 at "medium"
 * unless told otherwise (Opus 5.5 can't turn thinking off at all), and that
 * thinking is billed as output. So every call names the
 * kind of job it is doing and gets the reasoning that job needs:
 *
 *   narrate   Explain numbers JS already computed (chat, WhatsApp). Frequent,
 *             short, and the arithmetic is never the model's. -> low
 *   judge     A rare call whose output a person acts on (the daily briefing
 *             picks what matters most; the Deep chat tier the user chose).
 *             Rare, so reasoning is cheap here. -> medium
 *   extract   Structured JSON that code then checks (findings, file import).
 *             -> medium, and escalate() to high only when the check fails
 *   reconcile Multi-row allocation arithmetic (Close agent Tier 2). Validated
 *             at high in tools/scenario-gen; volume is capped and deduped,
 *             so it keeps the reasoning it was validated with. -> high
 *   classify  One label out of a fixed list (chase reply intent). Runs on
 *             Haiku, which has no effort setting.
 *
 * Effort is fixed per job on purpose: changing it between requests throws
 * away the prompt cache, so it is never varied per message. The one
 * exception is escalate(): a single retry one level up, only when a check
 * proves the cheap attempt failed (unparseable JSON, cut-off or empty reply).
 *
 * Each job's level can be overridden in Vercel without a code change:
 * CLAUDE_EFFORT_NARRATE, CLAUDE_EFFORT_JUDGE, CLAUDE_EFFORT_EXTRACT,
 * CLAUDE_EFFORT_RECONCILE (low | medium | high | xhigh | max).
 *
 * Zero-npm: plain fetch(). CommonJS; ESM callers import the default export.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const JOB_EFFORT = {
  narrate: process.env.CLAUDE_EFFORT_NARRATE || 'low',
  judge: process.env.CLAUDE_EFFORT_JUDGE || 'medium',
  extract: process.env.CLAUDE_EFFORT_EXTRACT || 'medium',
  reconcile: process.env.CLAUDE_EFFORT_RECONCILE || 'high',
  classify: null
};

function effortFor(job) {
  const e = JOB_EFFORT[job];
  return LEVELS.includes(e) ? e : null;
}

// One level up, capped at high: escalation is a retry, not a blank cheque.
function escalate(effort) {
  const i = LEVELS.indexOf(effort);
  if (i < 0) return null;
  return LEVELS[Math.min(i + 1, LEVELS.indexOf('high'))];
}

// Haiku 4.5 rejects output_config.effort (and doesn't think unless asked).
function supportsEffort(model) {
  return !/haiku/i.test(String(model || ''));
}

// System prompt as [static, dynamic]: the static half (instructions, voice,
// rules) is byte-identical across calls and carries the cache breakpoint;
// the dynamic half (business data, who is texting) comes after it.
function systemBlocks(staticText, dynamicText) {
  const blocks = [{ type: 'text', text: staticText, cache_control: { type: 'ephemeral' } }];
  if (dynamicText && dynamicText.trim()) blocks.push({ type: 'text', text: dynamicText });
  return blocks;
}

/**
 * @param {object} opts  Messages API body fields (model, max_tokens, system,
 *   tools, tool_choice, messages) plus:
 *   job      one of the JOB_EFFORT keys — sets output_config.effort
 *   effort   explicit level, overrides job (used by escalation retries)
 *   cacheTail  true -> top-level automatic caching of the growing tail
 *              (tool loops and multi-turn chat re-send the same prefix)
 *   label    short name for the usage log line
 * @returns the parsed Messages API response
 * @throws Error with .status and .body on a non-2xx response
 */
async function callClaude(opts) {
  const { job, effort: effortOverride, cacheTail, label, apiKey, ...params } = opts;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  const body = { ...params };
  const effort = effortOverride || effortFor(job);
  if (effort && supportsEffort(body.model)) {
    body.output_config = { ...(body.output_config || {}), effort };
  }
  if (cacheTail) body.cache_control = { type: 'ephemeral' };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const data = await res.json();
  logUsage(label || job || 'claude', body.model, supportsEffort(body.model) ? effort : null, data);
  return data;
}

/**
 * callClaude, streamed (2026-10-09): the same request and the same returned message ({ content, stop_reason,
 * stop_details, usage, ... }), but onText(chunk) is called with each piece of visible text as it is written, so
 * a chat reply appears word by word instead of after the whole answer. Blocks are rebuilt exactly as sent,
 * thinking blocks with their signature included, so tool rounds can pass them back unchanged.
 */
async function callClaudeStream(opts, onText) {
  const { job, effort: effortOverride, cacheTail, label, apiKey, ...params } = opts;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  const body = { ...params, stream: true };
  const effort = effortOverride || effortFor(job);
  if (effort && supportsEffort(body.model)) body.output_config = { ...(body.output_config || {}), effort };
  if (cacheTail) body.cache_control = { type: 'ephemeral' };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  let msg = null;
  const blocks = [], partial = {};
  const handle = (ev) => {
    switch (ev.type) {
      case 'message_start': msg = Object.assign({}, ev.message, { content: [] }); break;
      case 'content_block_start': blocks[ev.index] = Object.assign({}, ev.content_block); if (blocks[ev.index].type === 'tool_use' || blocks[ev.index].type === 'server_tool_use') partial[ev.index] = ''; break;
      case 'content_block_delta': {
        const b = blocks[ev.index], d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; if (onText && d.text) { try { onText(d.text); } catch (e) { /* the page went away */ } } }
        else if (d.type === 'input_json_delta') partial[ev.index] += d.partial_json || '';
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
        else if (d.type === 'citations_delta') (b.citations || (b.citations = [])).push(d.citation);
        break;
      }
      case 'content_block_stop':
        if (ev.index in partial) { const raw = partial[ev.index]; try { blocks[ev.index].input = raw ? JSON.parse(raw) : {}; } catch (e) { blocks[ev.index].input = {}; } delete partial[ev.index]; }
        break;
      case 'message_delta':
        if (msg) { Object.assign(msg, ev.delta || {}); msg.usage = Object.assign({}, msg.usage || {}, ev.usage || {}); }
        break;
      case 'error': { const err = new Error('Anthropic stream error: ' + JSON.stringify(ev.error || {}).slice(0, 300)); err.status = 529; throw err; }
      default: break;
    }
  };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) handle(JSON.parse(data));
    }
  }
  const data = Object.assign(msg || {}, { content: blocks.filter(Boolean) });
  logUsage((label || job || 'claude') + ' stream', body.model, supportsEffort(body.model) ? effort : null, data);
  return data;
}

// One line per call so real spend (and whether the cache is hitting) can be
// read straight from the Vercel function logs: search "[claude-usage]".
function logUsage(label, model, effort, data) {
  const u = (data && data.usage) || {};
  console.log(
    `[claude-usage] ${label} model=${model} effort=${effort || '-'} in=${u.input_tokens || 0}` +
    ` cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0}` +
    ` out=${u.output_tokens || 0} stop=${data && data.stop_reason}`
  );
}

function textOf(data) {
  return ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

module.exports = { callClaude, callClaudeStream, systemBlocks, effortFor, escalate, supportsEffort, textOf };
