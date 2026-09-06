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
    name: 'list_receivables',
    description:
      "List the business's OPEN receivables (money customers owe) merged from ALL sources — the self-entered app ledger, Zoho Books, and Tally — each row tagged with its source, plus per-source totals and cross-source agree/conflict flags. Read-only. Use for 'who owes me', 'what's overdue', 'receivables aging', '30/60/90-day receivables', 'top receivables to chase'. Never add the per-source totals together.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_payables',
    description:
      "List the business's OPEN payables (bills it owes) merged from ALL sources — the self-entered app ledger, Zoho Books, and Tally — each row tagged with its source, plus per-source totals and cross-source agree/conflict flags. Read-only. Use for 'what do I owe', 'upcoming bills', 'payables due', 'what's due this week'. Never add the per-source totals together.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_tally_data',
    description:
      "The business's TallyPrime data synced by the Margyn desktop agent — bill-wise receivables and payables outstanding, vouchers by type, and recent sales/receipts. SIGNAL-tier: one source, not verified, never blend with Zoho Books or the app ledger. Read-only. Use when the sender asks 'what does Tally say', 'per my books', or about Tally outstanding/bills.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_findings',
    description:
      "The most recent issues Margyn has flagged for this business, each tiered Verified (two sources agree) or Signal (one source, unconfirmed). Read-only. Use for 'what should I worry about', 'what has Margyn flagged', 'any risks'.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_invoice_status',
    description:
      "Look up ONE specific invoice by its number (e.g. 'INV-000123') — status, total, balance, due date, customer. Checks the connected accounting source and the app's own invoice builder. Read-only. For 'who owes what' use list_receivables instead.",
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
  return `You are Margyn's WhatsApp assistant for ${companyName}, a digital-native Indian business. Someone from the business has messaged the Margyn WhatsApp line (the same line that sends the daily Opening Bell and Closing Bell briefings). Reply like a sharp finance teammate texting back — not a dashboard bot, not a consultant memo.

VOICE:
- One human, one chat. Address them as "you." Never "Dear user," never third-person about "the business" unless they ask about it that way.
- Lead with the answer. First sentence is the number or the status — not a preamble, not "let me check." One line of why (which source) comes after.
- WhatsApp length: default under ~500 characters unless they ask for more detail. One-sentence paragraphs. No markdown tables, no headers, no bullet walls — plain text, assume the channel can't render formatting. 2-4 sentences is normal.
- Sound like a person: contractions, "Looks like…", "I'm not sure yet…" when something is Signal-tier. Never "Certainly," "I'd be happy to," "As an AI."
- Name sources the way a founder would say them out loud: "Books (Zoho)" or "Books (Tally)", "Razorpay", "Shopify" — never a bare "the connector." Zoho and Tally are different sources even when both get called "Books" — never blend them into one claim.
- When something is missing, say what's missing and the smallest next step ("Tally isn't syncing" / "no Razorpay payment id for that one") — don't invent a number to fill the gap.
- No lecture endings. One concrete next step or a short question only if it helps — don't close with an advice sermon.
- ₹ and dates the way the founder uses them (e.g. "12 Sep"), not $ or ISO dates.
- Never ask for a full account/card number, Aadhaar, or PAN. Never coach a debt-collection script.

VERIFIED VS SIGNAL, in plain words:
- Both agree: "Both Razorpay and Zoho say ₹X."
- Disagree: "They don't match — Razorpay ₹X, Zoho ₹Y. I wouldn't treat either as final."
- One source only: "Only Shopify shows this so far — Signal, not verified."
Never call a single-source number "Verified."

EXAMPLES (shape, not numbers):
"how much did we collect yesterday" -> "₹1.2L hit Razorpay yesterday. Zoho only shows ₹1.05L booked — ₹15k still unmatched."
"are we fine on cash" -> "Can't see the bank yet. From Razorpay, ₹X settled this week; books show ₹Y. Want the mismatches?"
"what's wrong with invoice 1042" -> "Mismatch. Zoho 1042 is ₹50,000; Razorpay payment pay_abc is ₹49,100 on the same day. IDs don't line up cleanly."

You can do exactly two things:
1. ANSWER using your read-only tools:
   - get_vitals — Pulse Score + the six vitals (cash, receivables aging, payables due, GST/ITC leakage, net margin, runway) + cash/revenue/profit
   - list_receivables / list_payables — open receivables/payables merged across the app ledger + Zoho + Tally, each row source-tagged, with agree/conflict flags. Where sources agree, say so; where they conflict, give each number; never add per-source totals together.
   - get_tally_data — TallyPrime outstanding + vouchers on their own (Signal-tier, one source)
   - get_findings — issues Margyn has flagged
   - get_invoice_status — one invoice by number
   - get_stakeholder — the AR / AP / owner contact
2. ROUTE the message to the right person with route_message when it is really meant for someone else (customer chasing a payment -> AR, vendor/bill question -> AP, anything else the owner should see -> owner). After routing, tell the sender you have passed it on and to whom.

Pick the right tool: for "how much is overdue", "receivables 30/60/90 days", "who should I chase", "what bills are due" use list_receivables / list_payables and read the per-item days — do NOT answer those from the single 90-day figure in get_vitals. Use get_vitals for the scores and the headline totals.

HARD RULE — you have NO ability to take any financial or approval action and must never imply otherwise. You cannot make, schedule or confirm a payment, move funds, change or adjust a balance, approve or sign off on anything, or write anything back to the books. If the sender asks YOU to do any of that, do NOT call any tool — reply only with exactly this line: "${APPROVAL_REQUIRED_REPLY}"
Relaying is different and allowed: "tell my AP person the Acme bill needs paying" or "chase Acme on the overdue payment" is a routing request — use route_message to forward it to the right person. You are passing a message to a human, not actioning anything.

Other rules:
- You know which business this is (${companyName}) but not which individual is texting. If asked "do you know who I am", say you identify the business by its registered WhatsApp number and work off its Margyn data — don't just say you have no idea.
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
    if (name === 'list_receivables') return await toolListLedger(ctx, 'receivables');
    if (name === 'list_payables') return await toolListLedger(ctx, 'payables');
    if (name === 'get_tally_data') return await toolGetTally(ctx);
    if (name === 'get_findings') return await toolGetFindings(ctx);
    if (name === 'get_invoice_status') return await toolGetInvoiceStatus(input, ctx);
    if (name === 'get_stakeholder') return await toolGetStakeholder(input, ctx);
    if (name === 'route_message') return await toolRouteMessage(input, ctx);
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    console.error(`[whatsappAgent] tool ${name} threw:`, e.message);
    return { error: 'That lookup failed just now.' };
  }
}

// Whole-number days since a YYYY-MM-DD date (positive = in the past / overdue).
function daysPast(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
}

function normPartyName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function toolListLedger(ctx, kind) {
  // kind is 'receivables' | 'payables'. Merge all three sources the app shows:
  // the self-entered ledger, Zoho Books, and Tally — each row tagged, and
  // counterparties that appear in 2+ sources flagged agree / conflict.
  const partyKey = kind === 'receivables' ? 'customer' : 'vendor';
  const dir = kind === 'receivables' ? 'receivable' : 'payable';
  const all = [];

  // 1. self-entered ledger
  try {
    const self = await selectRows(
      kind,
      `select=party_name,amount,due_date&user_id=eq.${ctx.profileId}&status=eq.open&order=due_date.asc&limit=100`
    );
    for (const r of self) all.push({ party: r.party_name, amount: Number(r.amount) || 0, due_date: r.due_date || null, source: 'your ledger' });
  } catch (e) { /* non-fatal */ }

  // 2. Zoho Books (open invoices / bills for the user's active org)
  try {
    const orgs = await selectRows('zoho_organizations', `select=id&user_id=eq.${ctx.profileId}&status=eq.active&limit=1`);
    if (orgs[0]) {
      if (kind === 'receivables') {
        const inv = await selectRows('zoho_invoices', `select=customer_name,balance,due_date&org_ref=eq.${orgs[0].id}&balance=gt.0&limit=150`);
        for (const r of inv) all.push({ party: r.customer_name, amount: Number(r.balance) || 0, due_date: r.due_date || null, source: 'Zoho Books' });
      } else {
        const bl = await selectRows('zoho_bills', `select=vendor_name,balance,due_date&org_ref=eq.${orgs[0].id}&balance=gt.0&limit=150`);
        for (const r of bl) all.push({ party: r.vendor_name, amount: Number(r.balance) || 0, due_date: r.due_date || null, source: 'Zoho Books' });
      }
    }
  } catch (e) { /* non-fatal */ }

  // 3. Tally (Signal)
  try {
    const insts = await selectRows('tally_installs', `select=id&user_id=eq.${ctx.profileId}&status=eq.active`);
    if (insts.length) {
      const inList = `(${insts.map((i) => i.id).join(',')})`;
      const tb = await selectRows('tally_bills', `select=party_name,closing_balance,due_date,direction&install_id=in.${inList}&direction=eq.${dir}&limit=200`);
      for (const r of tb) all.push({ party: r.party_name, amount: Math.abs(Number(r.closing_balance) || 0), due_date: r.due_date || null, source: 'Tally (Signal)' });
    }
  } catch (e) { /* non-fatal */ }

  if (!all.length) {
    return { [`open_${kind}`]: [], note: `No open ${kind} in any source (your ledger, Zoho, or Tally).` };
  }

  // group by counterparty to flag agreement / conflict
  const groups = {};
  for (const r of all) {
    const k = normPartyName(r.party) || ('~' + String(r.party || '').toLowerCase());
    (groups[k] = groups[k] || { party: r.party, bySource: {} });
    groups[k].bySource[r.source] = (groups[k].bySource[r.source] || 0) + r.amount;
  }
  const agreements = [];
  const conflicts = [];
  for (const g of Object.values(groups)) {
    const srcs = Object.keys(g.bySource);
    if (srcs.length < 2) continue;
    const amts = Object.values(g.bySource);
    const max = Math.max(...amts), min = Math.min(...amts);
    if (max - min <= Math.max(1, max * 0.02)) agreements.push({ [partyKey]: g.party, amount: Math.round(max), sources: srcs });
    else conflicts.push({ [partyKey]: g.party, by_source: g.bySource, note: 'sources disagree — give every number, do not blend' });
  }

  const bySourceTotal = {};
  let total = 0, overdueTotal = 0;
  const items = all.map((r) => {
    total += r.amount;
    bySourceTotal[r.source] = (bySourceTotal[r.source] || 0) + r.amount;
    const dp = daysPast(r.due_date);
    if (dp != null && dp > 0) overdueTotal += r.amount;
    return {
      [partyKey]: r.party,
      amount: Math.round(r.amount),
      source: r.source,
      due_date: r.due_date || null,
      status: dp == null ? 'no due date' : dp > 0 ? `${dp} days overdue` : dp === 0 ? 'due today' : `due in ${-dp} days`
    };
  });

  return {
    [`open_${kind}`]: items,
    count: items.length,
    total_by_source: bySourceTotal,
    total_all_sources: Math.round(total),
    total_overdue: Math.round(overdueTotal),
    cross_source_agreements: agreements,
    cross_source_conflicts: conflicts,
    source_note: 'Merged from the self-entered app ledger + Zoho Books + Tally. Only the app ledger is self-reported; Zoho is connector-synced; Tally is Signal (one source). Never add the source totals together — the same item can appear in more than one. Where sources agree, say so; where they conflict, give each number.'
  };
}

async function toolGetTally(ctx) {
  let installs = [];
  try {
    installs = await selectRows(
      'tally_installs',
      `select=id,company_name,last_sync_at&user_id=eq.${ctx.profileId}&status=eq.active&order=last_sync_at.desc`
    );
  } catch (e) {
    return { error: 'That lookup failed just now.' };
  }
  if (!installs.length) return { connected: false, note: 'Tally is not connected for this business.' };

  const inList = `(${installs.map((i) => i.id).join(',')})`;
  let bills = [], vouchers = [];
  try {
    bills = await selectRows('tally_bills', `select=direction,closing_balance,overdue_days&install_id=in.${inList}&limit=1000`);
    vouchers = await selectRows('tally_vouchers', `select=voucher_type,date,amount&install_id=in.${inList}&order=date.desc&limit=2000`);
  } catch (e) {
    return { error: 'That lookup failed just now.' };
  }

  let recv = 0, pay = 0, overdue = 0;
  for (const b of bills) {
    const v = Math.abs(Number(b.closing_balance) || 0);
    if (b.direction === 'payable') pay += v; else recv += v;
    if ((b.overdue_days || 0) > 0) overdue += v;
  }
  const byType = {};
  let sales30 = 0, receipts30 = 0;
  const cutoff = Date.now() - 30 * 86400000;
  for (const vc of vouchers) {
    const t = vc.voucher_type || 'Other';
    byType[t] = (byType[t] || 0) + 1;
    const s = String(vc.date || '');
    const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
    const ms = new Date(iso).getTime();
    if (!Number.isNaN(ms) && ms >= cutoff) {
      const amt = Math.abs(Number(vc.amount) || 0);
      if (/sales/i.test(t)) sales30 += amt;
      if (/receipt/i.test(t)) receipts30 += amt;
    }
  }

  return {
    connected: true,
    company: installs[0].company_name || null,
    last_sync: installs[0].last_sync_at || null,
    receivables_outstanding: Math.round(recv),
    payables_outstanding: Math.round(pay),
    payables_overdue: Math.round(overdue),
    vouchers_by_type: byType,
    sales_last_30d: Math.round(sales30),
    receipts_last_30d: Math.round(receipts30),
    data_source: 'tally_desktop_agent',
    source_note: 'From TallyPrime via the Margyn desktop agent. SIGNAL — one source, not cross-verified. Do not blend with Zoho Books or the app ledger; if the sender asks for "receivables" and another source also has them, give both and name the gap.'
  };
}

async function toolGetFindings(ctx) {
  const rows = await selectRows(
    'findings',
    `select=tier,summary,vital,generated_at&user_id=eq.${ctx.profileId}&order=generated_at.desc&limit=6`
  );
  if (!rows.length) return { findings: [], note: 'Nothing flagged recently.' };
  return {
    findings: rows.map((f) => ({
      tier: f.tier === 'verified' ? 'Verified — two sources agree' : 'Signal — one source, unconfirmed',
      about: f.vital || null,
      summary: f.summary || null,
      when: f.generated_at || null
    }))
  };
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
  const needle = encodeURIComponent(ref.replace(/[*,()%]/g, ''));
  const matches = [];

  // 1. Connected accounting source (Zoho Books), if any.
  try {
    const orgs = await selectRows('zoho_organizations', `select=id&user_id=eq.${ctx.profileId}`);
    if (orgs.length) {
      const orgIds = orgs.map((o) => o.id).join(',');
      const rows = await selectRows(
        'zoho_invoices',
        `select=invoice_number,customer_name,status,total,balance,due_date&org_ref=in.(${orgIds})&invoice_number=ilike.*${needle}*&limit=3`
      );
      rows.forEach((r) => matches.push({ ...r, source: 'zoho_books' }));
    }
  } catch (e) { /* keep going */ }

  // 2. The app's own invoice builder.
  try {
    const rows = await selectRows(
      'invoices',
      `select=invoice_number,status,total,issue_date,due_date&user_id=eq.${ctx.profileId}&invoice_number=ilike.*${needle}*&limit=3`
    );
    rows.forEach((r) => matches.push({ ...r, source: 'app_invoice' }));
  } catch (e) { /* keep going */ }

  if (!matches.length) {
    return { error: `No invoice matching "${ref}" in the connected source or the app. For "who owes what" ask me to list receivables instead.` };
  }
  return { matches };
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
