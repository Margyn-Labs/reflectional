/**
 * _lib/whatsappAgent.js
 * Claude-powered conversational routing layer for inbound WhatsApp messages
 * that are NOT a recognized Closing Bell button reply (free-text messages, or
 * a button reply that classified as 'unrecognized').
 *
 * READ-ONLY BY CONSTRUCTION. This flow can only:
 *   - answer a question using read-only tools, or
 *   - forward ("route") the message to a named stakeholder over WhatsApp.
 * It can NEVER move money, change a balance, or approve anything:
 *   1. no write-capable tool is wired in here,
 *   2. a regex guard short-circuits financial/approval intent BEFORE Claude
 *      is called, replying with a fixed "needs approval through the app" line,
 *   3. the system prompt states the rule explicitly.
 * Any future change that adds a write-capable tool to this file must be
 * treated as a security review, not a feature.
 *
 * Zero-npm: plain fetch() only, matching api/whatsapp.js and _lib/whatsappBsp.js.
 * CommonJS to match _lib/supabaseRest.js.
 *
 * Required env vars (set in Vercel dashboard):
 *   ANTHROPIC_API_KEY      shared with api/ask-margyn.js / api/generate-briefing.js
 *   WHATSAPP_AGENT_MODEL   optional, default 'claude-sonnet-5'
 */

const { selectRows, insertRows, rpc } = require('./supabaseRest');
const bsp = require('./whatsappBsp');

const MODEL = process.env.WHATSAPP_AGENT_MODEL || 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOOL_ITERATIONS = 5;
const HISTORY_TURNS = 10;
const MAX_INBOUND_CHARS = 1500;
const MAX_REPLY_CHARS = 900;

// Dedupe BSP webhook retries. The Claude loop runs ~8s, past Gupshup's
// webhook timeout, so the same inbound message gets re-delivered — each
// retry would otherwise generate another reply (the "loop"). Two layers:
//   1. in-memory: instant, catches retries hitting the same warm instance
//   2. persistent: a SELECT on whatsapp_conversations.wa_message_id, catches
//      retries that land on a different function instance
const _handledWamids = new Map();
const WAMID_TTL_MS = 5 * 60 * 1000;

function seenInMemory(wamid) {
  if (!wamid) return false;
  const now = Date.now();
  for (const [k, t] of _handledWamids) {
    if (now - t > WAMID_TTL_MS) _handledWamids.delete(k);
  }
  if (_handledWamids.has(wamid)) return true;
  _handledWamids.set(wamid, now);
  return false;
}

async function alreadyHandled(wamid) {
  if (!wamid) return false;
  if (seenInMemory(wamid)) return true;
  try {
    const rows = await selectRows(
      'whatsapp_conversations',
      `select=id&wa_message_id=eq.${encodeURIComponent(wamid)}&limit=1`
    );
    return rows.length > 0;
  } catch (e) {
    return false; // never block a real message on a dedupe-check failure
  }
}

const APPROVAL_REQUIRED_REPLY =
  "I can't action payments, approvals, or balance changes over WhatsApp — that has to go through the Margyn app where it's authenticated and logged. Anything else, I can help with here.";

// Fast hard block. Only an unambiguous IMPERATIVE aimed at the agent to move
// money / approve something is stopped before Claude. Questions ("how much
// have I paid in GST?") and relay requests ("tell my AP person...") are not
// caught here — Claude handles those, and it has no write tools regardless.
// A false negative is still safe: Claude cannot action anything and the
// system prompt refuses. So bias toward not blocking legitimate messages.
const FINANCIAL_COMMAND_RE = /^\s*(?:(?:please|pls|plz|kindly|hey\s+margyn|margyn|can\s+you|could\s+you|would\s+you|i\s+want\s+(?:you\s+)?to|i\s+need\s+(?:you\s+)?to)[\s,]+)*(?:go\s+(?:and\s+)?)?(pay|approve|transfer|remit|settle|disburse|refund|reimburse|authoris|authoriz|release\s+(?:the\s+)?funds?|wire|send\s+(?:the\s+)?(?:money|payment|funds))\b/i;
const FINANCIAL_MUTATION_RE = /\b(?:adjust|update|change|set|correct|reduce|increase)\s+[\w\s'-]{0,25}\bbalance\b|\bmark(?:ed|ing)?\s+[\w\s#'-]{0,25}\bpaid\b/i;

// ...but NOT when the message asks the agent to relay/forward to a person
// ("tell my AP person the bill needs paying", "ask AR to chase receivables").
// Those are routing requests — Claude handles them via route_message.
const RELAY_INTENT_RE = /\b(tell|ask|let\s+[\w'-]+\s+know|message|forward|pass\s+(it\s+|this\s+)?(on|along)|remind|loop\s+in|notify|chase|follow\s*up|nudge|ping)\b/i;

function isHardFinancialCommand(text) {
  if (RELAY_INTENT_RE.test(text)) return false;
  return FINANCIAL_COMMAND_RE.test(text) || FINANCIAL_MUTATION_RE.test(text);
}

/* ------------------------------------------------------------------ */
/* Tools — every one is read-only except route_message, which only     */
/* sends a WhatsApp text (no financial side effect).                   */
/* ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: 'get_vitals',
    description:
      "Get the business's current six financial vitals and Pulse Score (cash position, receivables aging, payables due, GST/ITC leakage, net margin, working capital runway). Read-only. Use when the sender asks about financial health, cash, runway, margin or a specific vital.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_invoice_status',
    description:
      "Look up one invoice by its number/reference (e.g. 'INV-000123'). Returns status, total, outstanding balance, due date and customer. Read-only.",
    input_schema: {
      type: 'object',
      properties: { invoice_ref: { type: 'string', description: 'Invoice number/reference as the sender wrote it.' } },
      required: ['invoice_ref']
    }
  },
  {
    name: 'get_stakeholder',
    description:
      "Find the person responsible for a function. role is 'AR' (receivables/collections), 'AP' (payables/vendor bills) or 'owner'. Returns name and WhatsApp number. Read-only.",
    input_schema: {
      type: 'object',
      properties: { role: { type: 'string', enum: ['AR', 'AP', 'owner'] } },
      required: ['role']
    }
  },
  {
    name: 'route_message',
    description:
      "Forward the sender's message to a stakeholder over WhatsApp when it's really meant for someone else (customer chasing payment -> AR, vendor/bill query -> AP, otherwise -> owner). Only sends a text message; it does not and cannot action anything financial. After calling this, tell the sender you've passed it on and to whom.",
    input_schema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['AR', 'AP', 'owner'] },
        note: { type: 'string', description: 'One-line summary of what the stakeholder needs to do or know.' }
      },
      required: ['role', 'note']
    }
  }
];

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */
/**
 * @param {{ profileId: string, fromPhone: string, text: string,
 *           contextMessageId?: string|null }} opts
 */
async function runConversation({ profileId, fromPhone, text, wamid }) {
  const cleanText = String(text || '').trim().slice(0, MAX_INBOUND_CHARS);
  if (!profileId || !cleanText) return;

  // Drop BSP retries of a message we're already handling / have handled.
  if (await alreadyHandled(wamid)) {
    console.log('[whatsappAgent] duplicate inbound ignored:', wamid);
    return;
  }

  // Persist the inbound turn first (with its wamid, so a retry that arrives
  // after this point is caught by the persistent dedupe check above).
  await persist(profileId, 'user', cleanText, null, wamid);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[whatsappAgent] ANTHROPIC_API_KEY not set — cannot reply');
    return;
  }

  // Hard financial-intent block: never reaches Claude, never touches a tool.
  // Skipped when the message is a relay request (see isHardFinancialCommand).
  if (isHardFinancialCommand(cleanText)) {
    await persist(profileId, 'assistant', APPROVAL_REQUIRED_REPLY, null);
    await sendReply(fromPhone, APPROVAL_REQUIRED_REPLY);
    return;
  }

  let companyName = 'the business';
  try {
    const p = await selectRows('profiles', `select=company_name&id=eq.${profileId}&limit=1`);
    if (p[0] && p[0].company_name) companyName = p[0].company_name;
  } catch (e) {
    // non-fatal — fall back to the generic label
  }

  const messages = await buildMessages(profileId, cleanText);
  const system = buildSystemPrompt(companyName);
  const ctx = {
    profileId,
    inboundText: cleanText,
    senderLabel: fromPhone ? '+' + String(fromPhone).replace(/[^\d]/g, '') : 'a WhatsApp contact'
  };

  let finalText = '';
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let data;
    try {
      data = await callClaude(apiKey, system, messages);
    } catch (e) {
      console.error('[whatsappAgent] Claude call failed:', e.message);
      break;
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUses = blocks.filter(b => b.type === 'tool_use');
    const textOut = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    await persist(
      profileId,
      'assistant',
      textOut,
      toolUses.length ? toolUses.map(t => ({ name: t.name, input: t.input })) : null
    );

    if (data.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const tu of toolUses) {
        const out = await execTool(tu.name, tu.input, ctx);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
      await persist(profileId, 'tool', JSON.stringify(results.map(r => r.content)), null);
      continue;
    }

    finalText = textOut;
    break;
  }

  if (finalText) {
    await sendReply(fromPhone, finalText.slice(0, MAX_REPLY_CHARS));
    return;
  }

  // No usable answer (Claude error, or ran out of tool iterations).
  const fallback = "Sorry — I couldn't work that one out over WhatsApp. Try rephrasing, or open the Margyn app.";
  await persist(profileId, 'assistant', fallback, null);
  await sendReply(fromPhone, fallback);
}

/** Send an outbound WhatsApp reply, logging (not throwing) on failure so a
 *  BSP-side problem — wallet, session window, unregistered number — is
 *  visible in the function logs instead of vanishing. */
async function sendReply(to, text) {
  let result;
  try {
    result = await bsp.sendText({ to, text });
  } catch (e) {
    console.error('[whatsappAgent] sendText threw:', e.message);
    return;
  }
  if (!result || !result.ok) {
    console.error('[whatsappAgent] sendText failed:', result && result.error);
  }
}

/* ------------------------------------------------------------------ */
/* Claude call                                                         */
/* ------------------------------------------------------------------ */
async function callClaude(apiKey, system, messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system, tools: TOOLS, messages })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

function buildSystemPrompt(companyName) {
  return `You are Margyn's WhatsApp assistant for ${companyName}, a digital-native Indian business. Someone from the business has messaged the Margyn WhatsApp line (the same line that sends the daily Opening Bell and Closing Bell briefings). Reply like a sharp, friendly finance colleague — short, plain, WhatsApp-length (2-4 sentences, no markdown, no headers).

You can do exactly two things:
1. ANSWER a question using your read-only tools: get_vitals, get_invoice_status, get_stakeholder.
2. ROUTE the message to the right person with route_message when it is really meant for someone else (customer chasing a payment -> AR, vendor/bill question -> AP, anything else the owner should see -> owner). After routing, tell the sender you have passed it on and to whom.

HARD RULE — you have NO ability to take any financial or approval action and must never imply otherwise. You cannot make, schedule or confirm a payment, move funds, change or adjust a balance, approve or sign off on anything, or write anything back to the books. If the sender asks YOU to do any of that, do NOT call any tool — reply only with exactly this line: "${APPROVAL_REQUIRED_REPLY}"
Relaying is different and allowed: "tell my AP person the Acme bill needs paying" or "chase Acme on the overdue payment" is a routing request — use route_message to forward it to the right person. You are passing a message to a human, not actioning anything.

Other rules:
- Only state numbers, statuses or names that a tool actually returned. Never invent a figure, an invoice status, or a contact.
- get_vitals returns real figures even when nothing is connected — data entered manually in the app still counts. Give the actual numbers. When data_source is "manual" or "upload", add one short caveat that they're self-reported and not yet connector-verified — do not refuse, hedge the whole answer, or claim the data is missing/empty/wrong.
- If a tool genuinely returns an error or no data at all, say so plainly and suggest opening the Margyn app.
- Never call the Pulse Score a "credit score" — it is an operating/financial health score.
- Keep every reply under 90 words.`;
}

/* ------------------------------------------------------------------ */
/* Tool execution — profileId is always the authenticated sender's;    */
/* any id the model puts in tool input is ignored.                     */
/* ------------------------------------------------------------------ */
async function execTool(name, input, ctx) {
  try {
    if (name === 'get_vitals') return await toolGetVitals(ctx);
    if (name === 'get_invoice_status') return await toolGetInvoiceStatus(input, ctx);
    if (name === 'get_stakeholder') return await toolGetStakeholder(input, ctx);
    if (name === 'route_message') return await toolRouteMessage(input, ctx);
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    console.error(`[whatsappAgent] tool ${name} threw:`, e.message);
    return { error: 'That lookup failed just now.' };
  }
}

async function toolGetVitals(ctx) {
  // Primary source: the latest `snapshots` row — the exact same thing the app
  // dashboard reads. It carries the computed six vitals, the Pulse Score, and
  // a `source` ('manual' | 'upload' | 'ledger' | a connector name) regardless
  // of whether the figures were typed in or synced. Manual data is still real
  // data — surface it, just flagged as self-reported.
  let rows;
  try {
    rows = await selectRows(
      'snapshots',
      `select=vitals,pulse_score,source,cash,revenue,net_profit,burn,created_at` +
        `&user_id=eq.${ctx.profileId}&order=created_at.desc&limit=1`
    );
  } catch (e) {
    return { error: 'Could not load your figures right now.' };
  }

  if (rows && rows.length) {
    const s = rows[0];
    const src = s.source || 'manual';
    return {
      pulse_score: s.pulse_score,
      vitals: s.vitals,
      cash: s.cash,
      revenue: s.revenue,
      net_profit: s.net_profit,
      burn: s.burn,
      as_of: s.created_at,
      data_source: src,
      source_note: (src === 'manual' || src === 'upload')
        ? 'These figures were entered/uploaded by the business in the app — self-reported, not yet cross-checked against a connected source.'
        : `These figures are derived from the ${src} data.`
    };
  }

  // No snapshot at all — fall back to the Zoho Books vitals RPC.
  try {
    const v = await rpc('zoho_vitals', { p_user_id: ctx.profileId, p_org_ref: null });
    const vitals = Array.isArray(v) ? v[0] : v;
    if (vitals && typeof vitals === 'object') return Object.assign({ data_source: 'zoho_books' }, vitals);
  } catch (e) {
    // fall through
  }
  return { error: 'No figures on file yet — nothing has been entered in the app or synced from a connector.' };
}

async function toolGetInvoiceStatus(input, ctx) {
  const ref = String((input && input.invoice_ref) || '').trim();
  if (!ref) return { error: 'No invoice reference given.' };

  const orgs = await selectRows('zoho_organizations', `select=id&user_id=eq.${ctx.profileId}`);
  if (!orgs.length) return { error: 'No accounting source connected, so invoices are not available here.' };

  const orgIds = orgs.map(o => o.id).join(',');
  const needle = ref.replace(/[*,()%]/g, '');
  const rows = await selectRows(
    'zoho_invoices',
    `select=invoice_number,customer_name,status,total,balance,due_date` +
      `&org_ref=in.(${orgIds})&invoice_number=ilike.*${encodeURIComponent(needle)}*&limit=3`
  );
  if (!rows.length) return { error: `No invoice matching "${ref}".` };
  return { matches: rows };
}

async function toolGetStakeholder(input, ctx) {
  const role = String((input && input.role) || '').trim();
  const rows = await selectRows(
    'business_stakeholders',
    `select=name,phone,role&business_id=eq.${ctx.profileId}&role=eq.${encodeURIComponent(role)}&limit=1`
  );
  if (!rows.length) return { error: `No ${role || 'matching'} contact on file.` };
  return rows[0];
}

async function toolRouteMessage(input, ctx) {
  const role = String((input && input.role) || '').trim();
  const note = String((input && input.note) || '').trim();

  const rows = await selectRows(
    'business_stakeholders',
    `select=name,phone,role&business_id=eq.${ctx.profileId}&role=eq.${encodeURIComponent(role)}&limit=1`
  );
  if (!rows.length) return { error: `No ${role || 'matching'} contact on file — cannot route. Tell the sender.` };

  const s = rows[0];

  // Preferred: an approved Utility template (WHATSAPP_TEMPLATE_RELAY). A
  // template can be delivered even when the recipient has no open 24h session
  // with our number — which is the normal case for a teammate who hasn't
  // messaged Margyn. Body params: [1] who it's from, [2] the message, [3] note.
  const relayTemplate = process.env.WHATSAPP_TEMPLATE_RELAY;
  if (relayTemplate) {
    const r = await bsp.sendTemplate({
      to: s.phone,
      templateId: relayTemplate,
      params: [ctx.senderLabel, ctx.inboundText.slice(0, 600), note || 'No extra context given.']
    });
    if (!r.ok) return { error: `Could not deliver to ${s.name}: ${r.error}` };
    return { routed_to: s.name, role: s.role, via: 'template' };
  }

  // Fallback until the template is approved: free-form text. Only lands if the
  // stakeholder already has an open 24h WhatsApp session with our number.
  const forwarded =
    `Forwarded via Margyn from ${ctx.senderLabel}:\n\n"${ctx.inboundText}"` +
    (note ? `\n\nContext: ${note}` : '');
  const r = await bsp.sendText({ to: s.phone, text: forwarded });
  if (!r.ok) {
    return { error: `Could not deliver to ${s.name} — they may not have messaged Margyn recently, and the relay template isn't set up yet. ${r.error}` };
  }
  return { routed_to: s.name, role: s.role, via: 'session_text' };
}

/* ------------------------------------------------------------------ */
/* Conversation history                                                */
/* ------------------------------------------------------------------ */
async function buildMessages(profileId, cleanText) {
  let rows = [];
  try {
    rows = await selectRows(
      'whatsapp_conversations',
      `select=role,content&profile_id=eq.${profileId}&order=created_at.desc&limit=40`
    );
  } catch (e) {
    rows = [];
  }

  // Newest-first from the query -> oldest-first for the transcript. Keep only
  // non-empty user/assistant turns, then the last HISTORY_TURNS of them.
  const turns = rows
    .filter(r => (r.role === 'user' || r.role === 'assistant') && r.content && r.content.trim())
    .reverse()
    .slice(-HISTORY_TURNS)
    .map(r => ({ role: r.role, content: String(r.content).slice(0, MAX_INBOUND_CHARS) }));

  // The inbound turn we just persisted will usually be the last row — drop a
  // trailing user turn so we don't duplicate it when we append cleanText.
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();

  // Anthropic requires alternating roles starting with 'user'. Collapse any
  // consecutive same-role turns and trim a leading assistant turn.
  const collapsed = [];
  for (const t of turns) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === t.role) last.content += '\n' + t.content;
    else collapsed.push({ role: t.role, content: t.content });
  }
  while (collapsed.length && collapsed[0].role !== 'user') collapsed.shift();

  return [...collapsed, { role: 'user', content: cleanText }];
}

/* ------------------------------------------------------------------ */
/* Persistence — never throws (a logging failure must not break reply) */
/* ------------------------------------------------------------------ */
async function persist(profileId, role, content, toolCalls, waMessageId) {
  try {
    await insertRows('whatsapp_conversations', [{
      profile_id: profileId,
      role,
      content: content || '',
      tool_calls: toolCalls || null,
      wa_message_id: waMessageId || null
    }]);
  } catch (e) {
    console.error('[whatsappAgent] persist failed:', e.message);
  }
}

module.exports = { runConversation, APPROVAL_REQUIRED_REPLY, isHardFinancialCommand };
