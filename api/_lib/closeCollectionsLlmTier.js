/**
 * Close & Collections Agent — Tier 2 (LLM), live-product version.
 *
 * Tier 1 (closeCollectionsAgent.js) resolves the large majority of
 * reconciliations deterministically and, for the rest, simply produces
 * nothing — those rows silently sit unresolved. This module takes exactly
 * those leftovers (`runAgent(bundle, { includeExceptions: true }).exceptions`)
 * and gives Claude a real attempt, with the same two safeguards validated in
 * the reference testbed (tools/scenario-gen/llmTier.js + validate.js) before
 * a proposal is ever trusted:
 *
 *   1. FULL CLUSTER CONTEXT — every still-open row for the same party (books
 *      payments, invoices, free gateway captures, bills), not one row at a
 *      time. Same-party exceptions are batched into ONE call so the model
 *      can see the whole picture at once (a payment that looks unexplainable
 *      alone often makes sense once you see two sibling invoices next to it).
 *   2. CHECKED BEFORE IT COUNTS — every proposal is run through
 *      validateProposal() below before it's returned. Fails the check ->
 *      dropped entirely (the row simply stays unresolved this run, exactly
 *      as it already was before this module existed — never worse).
 *
 * This module NEVER writes to the human queue itself and never touches
 * Tier 1's own output. api/reconcile.js calls it, gets back a plain array of
 * proposals in the exact same shape runAgent() produces, and merges them in
 * before persisting — so a Tier-2 win is just one more resolved card in the
 * existing Agent Queue, and a Tier-2 miss is silently nothing, same as today.
 *
 * Runs only when ANTHROPIC_API_KEY is set (same env var every other Claude
 * feature in this app already uses — ask-margyn.js, generate-briefing.js,
 * whatsappAgent.js). No key -> returns immediately, $0, no behavior change.
 *
 * Cost control: `opts.maxCalls` (default 12) bounds how many Claude calls one
 * run makes — extra exceptions beyond that just aren't attempted this run
 * (Tier 1 will keep surfacing them next run; nothing is lost, only delayed).
 */

const KNOWN_TDS_RATES = [
  { rate: 0.10, section: '194J' }, { rate: 0.05, section: '194H' },
  { rate: 0.02, section: '194J' }, { rate: 0.01, section: '194C' },
  { rate: 0.001, section: '194Q' }
];

const MODEL = process.env.AGENT_LLM_MODEL || 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_CALLS = 12;

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol != null ? tol : 0.5);
const daysBetween = (a, b) => (a && b) ? Math.abs((new Date(a) - new Date(b)) / 86400000) : 1e9;

const PROPOSE_TOOL = {
  name: 'propose',
  description: 'Propose how to reconcile one exception. A human approves — this never applies anything.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['match', 'split', 'partial', 'on_account', 'reallocate', 'duplicate', 'needs_human'] },
      confidence: { type: 'number', description: '0..1' },
      invoiceRefs: { type: 'array', items: { type: 'string' } },
      booksRefs: { type: 'array', items: { type: 'string' } },
      gatewayIds: { type: 'array', items: { type: 'string' } },
      billRefs: { type: 'array', items: { type: 'string' } },
      adjustments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, amount: { type: 'number' }, section: { type: 'string' } },
          required: ['type', 'amount']
        }
      },
      allocations: {
        type: 'array',
        items: { type: 'object', properties: { invoiceRef: { type: 'string' }, amount: { type: 'number' } } }
      },
      reason: { type: 'string' }
    },
    required: ['kind', 'confidence', 'reason']
  }
};

const PROPOSE_CLUSTER_TOOL = {
  name: 'proposeCluster',
  description: 'Propose resolutions for as many of the given exceptions as you can, for this one party. One entry may cover several sibling exceptions when they are really one payment story. Omit an exception you cannot improve on "needs_human" for.',
  input_schema: {
    type: 'object',
    properties: { proposals: { type: 'array', items: PROPOSE_TOOL.input_schema } },
    required: ['proposals']
  }
};

const SYSTEM = `You are Margyn's Close & Collections Agent, LLM tier. You reconcile Indian SME
receivables that the deterministic rules could not resolve. You PROPOSE only — a human approves.

You are given the full open cluster for one party: every still-unmatched books payment, every
unclaimed gateway capture, every open invoice, every open bill with them. Use all of it — a
payment that looks unexplainable alone often makes sense once you see it sits alongside sibling
invoices that sum to it.

Rules of the house:
- Never invent a link. If two things could both be the answer and nothing in the data
  disambiguates them, propose kind "needs_human" and say what would resolve it.
- Every row you reference (invoiceRefs, booksRefs, gatewayIds, billRefs) must be one you were
  actually given in the context. Do not name a row that isn't there.
- Name reconciling items precisely: a short payment from a services client is usually TDS (name
  the rate and section if you can tell); a payment a hair over the invoice is TCS 206C; books
  lower than the gateway by the gateway's own reported fee is a gateway fee + 18% GST.
- Money is INR. Amounts are rupees.
- A round-number books payment with NO invoiceRef of its own (booked "on account" / "unallocated")
  is NEVER a single "match" — even if one specific open invoice happens to equal the payment
  exactly. It must be kind "on_account", with allocations covering the FULL amount across this
  party's open invoices, oldest-due first (FIFO), stopping when the amount runs out — list every
  invoiceRef it actually covers with its own allocated amount. If a remainder is left over after
  every eligible invoice is covered, that remainder is a customer advance — say so.
  IMPORTANT — only FIFO across invoices dated ON OR BEFORE this payment's own date. An invoice
  raised after the payment was received could not be what it was paying against, even if it's
  still open today and shows up in the same list — check every invoice's date before including
  it, and stop the FIFO walk at the payment's own amount exactly.
- If you cannot improve on "needs_human" for something, say so with that kind and explain why.`;

const CLUSTER_ADDENDUM = `
You are being given SEVERAL open exceptions for the SAME party in one call. Return one proposal
per distinct resolution — a single proposal may cover more than one exception when they're really
one payment story. Omit anything you can't improve on "needs_human" for; it just stays unresolved.`;

function findingShape(o, prefix) {
  return {
    kind: o.kind, confidence: o.confidence,
    invoiceRefs: o.invoiceRefs || [], booksRefs: o.booksRefs || [], gatewayIds: o.gatewayIds || [],
    billRefs: o.billRefs || [], adjustments: o.adjustments || [], allocations: o.allocations || [],
    reason: o.reason || '', _proposalKey: `${prefix}:${(o.booksRefs || [])[0] || (o.gatewayIds || [])[0] || Math.random().toString(36).slice(2)}`
  };
}

/** The deterministic checker — do the rows exist, are they open, does the arithmetic close,
 * do allocations respect invoice dates. A proposal failing any of this is dropped, never persisted. */
function validateProposal(idx, proposal, claimed) {
  const { invByRef, bpByRef, gById, billByRef } = idx;
  const claimedBp = claimed.booksRefs, claimedG = claimed.gatewayIds;

  for (const ref of proposal.invoiceRefs || []) if (!invByRef.has(ref)) return { ok: false };
  for (const ref of proposal.booksRefs || []) {
    if (!bpByRef.has(ref)) return { ok: false };
    if (claimedBp.has(ref)) return { ok: false };
  }
  for (const id of proposal.gatewayIds || []) {
    if (!gById.has(id)) return { ok: false };
    if (claimedG.has(id)) return { ok: false };
    if (norm(gById.get(id).status) !== 'captured') return { ok: false };
  }
  for (const ref of proposal.billRefs || []) if (!billByRef.has(ref)) return { ok: false };

  const bpAmount = (proposal.booksRefs || []).reduce((s, r) => s + (bpByRef.get(r) ? bpByRef.get(r).amount : 0), 0);
  const gAmount = (proposal.gatewayIds || []).reduce((s, id) => s + (gById.get(id) ? gById.get(id).amount : 0), 0);
  const adjTotal = (proposal.adjustments || []).reduce((s, a) => s + Math.abs(Number(a.amount) || 0), 0);

  if ((proposal.kind === 'match' || proposal.kind === 'partial') && bpAmount > 0 && gAmount > 0) {
    if (!near(bpAmount, gAmount) && !near(bpAmount, gAmount + adjTotal) && !near(bpAmount, gAmount - adjTotal)) return { ok: false };
  }

  if (['split', 'on_account'].includes(proposal.kind) && (proposal.allocations || []).length) {
    const allocTotal = proposal.allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const claimedTotal = gAmount || bpAmount;
    const cap = claimedTotal + adjTotal + Math.max(2, claimedTotal * 0.01);
    // "on_account" may legitimately allocate LESS than the full amount (a
    // genuine unallocated remainder/advance) — only reject for going OVER,
    // matching tools/scenario-gen/validate.js's identical rule and rationale.
    if (claimedTotal > 0 && allocTotal > cap) return { ok: false };
    if (proposal.kind !== 'on_account' && claimedTotal > 0 && !near(allocTotal, claimedTotal) && !near(allocTotal, claimedTotal + adjTotal)) return { ok: false };

    const seen = new Set();
    for (const a of proposal.allocations) {
      const key = a.invoiceRef;
      if (!key || seen.has(key)) return { ok: false };
      seen.add(key);
    }

    // an invoice raised AFTER the payment cannot be what it settled — see
    // tools/scenario-gen/validate.js for the full account of why this check
    // exists (a model's own stated reasoning correctly excluded a later
    // invoice, then included it anyway in the actual tool call).
    const payDates = [
      ...(proposal.booksRefs || []).map((r) => bpByRef.get(r)).filter(Boolean).map((b) => b.date),
      ...(proposal.gatewayIds || []).map((id) => gById.get(id)).filter(Boolean).map((g) => g.date)
    ].sort();
    if (payDates.length) {
      const cutoff = new Date(payDates[0]); cutoff.setDate(cutoff.getDate() + 2);
      for (const a of proposal.allocations) {
        const inv = a.invoiceRef && invByRef.get(a.invoiceRef);
        if (inv && new Date(inv.date) > cutoff) return { ok: false };
      }
    }
  }

  const c = Number(proposal.confidence);
  if (!isFinite(c) || c < 0 || c > 1) return { ok: false };

  const rowCount = (proposal.invoiceRefs || []).length + (proposal.booksRefs || []).length +
    (proposal.gatewayIds || []).length + (proposal.billRefs || []).length;
  if (proposal.kind !== 'needs_human' && rowCount === 0) return { ok: false };

  return { ok: true };
}

function contextForCluster(bundle, idx, party, items, claimedBp, claimedG) {
  const { bpByRef, invByRef, gById, billByRef } = idx;
  const belongsTo = (ref) => {
    if (!party) return true;
    const b = bpByRef.get(ref);
    return b ? norm(b._party || '') === norm(party) : false;
  };
  const gatewayIsParty = (g) => {
    if (!party) return true;
    const p = g._party;
    return !p || norm(p) === norm(party);
  };

  const openBooksPayments = bundle.booksPayments.filter((b) =>
    b.amount > 0 && !claimedBp.has(String(b.ref)) && (party ? norm(b._party || '') === norm(party) : items.some((f) => f.ref === b.ref)));
  const freeGateway = bundle.gateway.filter((g) =>
    (norm(g.status) === 'captured' || !g.status) && !claimedG.has(String(g.id)) && gatewayIsParty(g));
  const openInvoices = party ? bundle.invoices.filter((i) => norm(i.party || '') === norm(party)) : [];
  const openBills = party ? bundle.bills.filter((b) => norm(b.vendor || '') === norm(party)) : [];

  return {
    exceptions: items.map((f, i) => ({ exceptionIndex: i, booksRef: f.ref, amount: f.amount, date: f.date, invoiceRef: f.invoiceRef })),
    party: party || null,
    openBooksPayments: openBooksPayments.map((b) => ({ ref: b.ref, invoiceRef: b.invoiceRef, amount: b.amount, date: b.date, mode: b.mode, reference: b.reference })),
    openInvoices: openInvoices.map((i) => ({ ref: i.ref, number: i.number, amount: i.amount, date: i.date, dueDate: i.dueDate })),
    freeGatewayCaptures: freeGateway.map((g) => ({ id: g.id, amount: g.amount, date: g.date, fee: g.fee, description: g.description })),
    openBills: openBills.map((b) => ({ ref: b.ref, vendor: b.vendor, amount: b.amount, date: b.date }))
  };
}

async function callClaude(tool, toolName, system, userContent) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048, system,
      tools: [tool], tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = (data.content || []).find((c) => c.type === 'tool_use');
  if (!call) throw new Error('no tool_use in response');
  return call.input;
}

/**
 * @param {object} bundle     same shape passed to runAgent()
 * @param {object[]} exceptions  runAgent(bundle, {includeExceptions:true}).exceptions
 * @param {object} [opts]     { maxCalls?: number }
 * @returns {Promise<{proposals: object[], usedLlm: boolean, attempted: number, improved: number, errors: string[]}>}
 */
async function runLlmTier(bundle, exceptions, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY || !exceptions || !exceptions.length) {
    return { proposals: [], usedLlm: false, attempted: 0, improved: 0, errors: [] };
  }
  const maxCalls = opts.maxCalls || DEFAULT_MAX_CALLS;

  const invByRef = new Map(bundle.invoices.map((i) => [String(i.ref), i]));
  const bpByRef = new Map(bundle.booksPayments.map((b) => [String(b.ref), { ...b, _party: (invByRef.get(String(b.invoiceRef)) || {}).party }]));
  const gById = new Map(bundle.gateway.map((g) => [String(g.id), g]));
  const billByRef = new Map((bundle.bills || []).map((b) => [String(b.ref), b]));
  const idx = { invByRef, bpByRef, gById, billByRef };
  const bundleForCtx = { ...bundle, booksPayments: [...bpByRef.values()] };

  const claimedBp = new Set();
  const claimedG = new Set();
  const errors = [];
  const proposals = [];
  let improved = 0, calls = 0;

  const groups = new Map();
  const order = [];
  for (const f of exceptions) {
    const key = f.party ? 'p:' + norm(f.party) : 's:' + f.ref;
    if (!groups.has(key)) { groups.set(key, { party: f.party, items: [] }); order.push(key); }
    groups.get(key).items.push(f);
  }

  for (const key of order) {
    if (calls >= maxCalls) break;
    const { party, items } = groups.get(key);

    if (items.length === 1) {
      calls++;
      const f = items[0];
      const ctx = contextForCluster(bundleForCtx, idx, party, items, claimedBp, claimedG);
      let raw;
      try {
        raw = await callClaude(PROPOSE_TOOL, 'propose', SYSTEM, 'Reconcile this exception. Context JSON:\n\n' + JSON.stringify({ exception: ctx.exceptions[0], ...ctx }));
      } catch (e) { errors.push(String(e).slice(0, 160)); continue; }
      if (!raw || !raw.kind || raw.kind === 'needs_human') continue;
      const shaped = findingShape(raw, 'llm');
      if (!validateProposal(idx, shaped, { booksRefs: claimedBp, gatewayIds: claimedG }).ok) continue;
      (shaped.booksRefs || []).forEach((r) => claimedBp.add(r));
      (shaped.gatewayIds || []).forEach((r) => claimedG.add(r));
      proposals.push(toAgentProposal(shaped));
      improved++;
      continue;
    }

    calls++;
    const ctx = contextForCluster(bundleForCtx, idx, party, items, claimedBp, claimedG);
    let rawList;
    try {
      rawList = await callClaude(PROPOSE_CLUSTER_TOOL, 'proposeCluster', SYSTEM + CLUSTER_ADDENDUM, 'Reconcile as many as you can. Context JSON:\n\n' + JSON.stringify(ctx));
    } catch (e) { errors.push(String(e).slice(0, 160)); continue; }
    for (const raw of (Array.isArray(rawList && rawList.proposals) ? rawList.proposals : [])) {
      if (!raw || !raw.kind || raw.kind === 'needs_human') continue;
      const shaped = findingShape(raw, 'llm');
      if (!validateProposal(idx, shaped, { booksRefs: claimedBp, gatewayIds: claimedG }).ok) continue;
      (shaped.booksRefs || []).forEach((r) => claimedBp.add(r));
      (shaped.gatewayIds || []).forEach((r) => claimedG.add(r));
      proposals.push(toAgentProposal(shaped));
      improved++;
    }
  }

  return { proposals, usedLlm: true, attempted: exceptions.length, improved, errors };
}

/** Shape a validated LLM finding into the same proposal shape runAgent() emits,
 * so api/reconcile.js can merge and persist it identically. */
function toAgentProposal(f) {
  const primary = (f.booksRefs || [])[0] || (f.gatewayIds || [])[0] || '';
  return {
    kind: f.kind, confidence: f.confidence,
    proposalKey: `llm:${primary}`,
    sourceFindingKey: null,
    title: `${f.kind === 'on_account' ? 'Allocate' : 'Match'} — Tier-2 (AI-assisted)`,
    rationale: f.reason,
    amount: (f.allocations || []).reduce((s, a) => s + (Number(a.amount) || 0), 0) || null,
    currency: 'INR',
    evidence: { booksRefs: f.booksRefs, gatewayIds: f.gatewayIds, tier: 'llm' },
    proposal: {
      match: { booksRef: (f.booksRefs || [])[0] || null, gatewayId: (f.gatewayIds || [])[0] || null, invoiceRef: (f.invoiceRefs || [])[0] || null },
      allocations: (f.allocations || []).map((a) => ({ invoiceRef: a.invoiceRef, amount: money(a.amount) })),
      adjustments: f.adjustments || []
    }
  };
}

module.exports = { runLlmTier, validateProposal, contextForCluster };
