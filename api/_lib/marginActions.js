/**
 * _lib/marginActions.js
 * Shared "chat can act, not just narrate" layer for Ask Margyn (web chat,
 * api/ask-margyn.js) and, in a later pass, the WhatsApp agent
 * (api/_lib/whatsappAgent.js). Both channels get the same tools and the
 * same discipline: read tools return data, and the one write-shaped tool
 * (`propose_action`) never executes anything itself — it just hands back a
 * structured proposal for the human to confirm. Every actual write still
 * happens through the same code paths the app's existing buttons already
 * use (app.html), or a narrow single-purpose helper here for the few
 * actions that don't have a button yet. Nothing here moves money, and
 * nothing here executes without an explicit confirm click downstream.
 *
 * Zero-npm: plain fetch() only via _lib/supabaseRest.js. CommonJS to match
 * that file and _lib/whatsappAgent.js.
 */

const { selectRows, insertRows, updateRows } = require('./supabaseRest');
const { reviewAgentAction } = require('../reconcile');

/* ------------------------------------------------------------------ */
/* Read-only lookup tools                                              */
/* ------------------------------------------------------------------ */
const READ_TOOLS = [
  {
    name: 'list_pending_import_suggestions',
    description:
      "List pending AI-imported invoices/bills/receipts awaiting the user's approve/reject decision (from the Suggestions tab, usually forwarded over WhatsApp). Read-only. Use to find 'the Acme import' or answer 'what's pending to approve'.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_pending_agent_actions',
    description:
      "List pending Close & Collections reconciliation proposals awaiting approve/dismiss (the Agent Queue in the Ledger tab). Read-only.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_open_ledger_items',
    description:
      "List OPEN self-entered receivables or payables (the app's own Quick Ledger, not Zoho/Tally), optionally filtered by a party-name search. Read-only. Use to resolve which specific row 'mark Acme's invoice paid' refers to.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['receivable', 'payable'] },
        party_query: { type: 'string', description: 'Optional substring of the customer/vendor name to filter by.' }
      },
      required: ['kind']
    }
  },
  {
    name: 'list_chase_targets',
    description:
      "List WhatsApp Chase Agent targets (customers currently being chased for payment), optionally filtered by state or a party-name search. Read-only. Use to resolve 'stop chasing Acme', 'mark X's chase as paid', or 'chase Y right now'.",
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['active', 'paused_promise', 'resolved_paid', 'disputed', 'wrong_contact', 'escalated_human', 'stopped', 'opted_out'] },
        party_query: { type: 'string', description: 'Optional substring of the customer name to filter by.' }
      }
    }
  },
  {
    name: 'get_chase_agent_config',
    description:
      "Get the Chase Agent's current deployment status and config (cadence, tone). Read-only.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

/**
 * The one write-shaped tool. Calling it NEVER executes anything server-side
 * and never loops back to Claude — seeing this tool call ends the
 * conversation turn immediately and the caller returns { reply, actionCard }
 * instead of just { reply }. The actual write happens only after the human
 * clicks Confirm on that card, via existing app functions or one of the
 * narrow helpers below.
 */
const PROPOSE_ACTION_TOOL = {
  name: 'propose_action',
  description:
    "Call this when you've identified exactly one specific action the user wants to take and resolved it to a specific row (via the list_* tools above). This does NOT execute anything — it shows the user a confirm card. Never call this to just answer a question; only when the user is clearly asking you to change something.",
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [
          'approve_suggestion', 'reject_suggestion',
          'approve_agent_action', 'dismiss_agent_action',
          'pause_chase_agent', 'resume_chase_agent', 'update_chase_agent_config',
          'mark_ledger_item_paid', 'create_ledger_item',
          'stop_chasing_party', 'mark_chase_target_paid', 'send_one_off_chase',
          'list_for_review'
        ]
      },
      target_id: { type: 'string', description: 'The id of the specific row this acts on (from a list_* tool). Omit for create_ledger_item/update_chase_agent_config, or when type is list_for_review.' },
      target_kind: { type: 'string', enum: ['receivable', 'payable'], description: 'Required for mark_ledger_item_paid / create_ledger_item.' },
      payload: {
        type: 'object',
        description: "Extra structured data the action needs, e.g. {party, amount, due_date} for create_ledger_item, {cadence_days, tone} for update_chase_agent_config, or {items:[{id, kind, label}]} for list_for_review."
      },
      human_summary: { type: 'string', description: 'One plain-language sentence describing exactly what will happen, shown to the user on the confirm card.' }
    },
    required: ['type', 'human_summary']
  }
};

const TOOLS = [...READ_TOOLS, PROPOSE_ACTION_TOOL];

function isProposeAction(name) {
  return name === 'propose_action';
}

/* ------------------------------------------------------------------ */
/* Read-tool execution — every query is scoped by the verified userId, */
/* never anything the model or the client supplies.                    */
/* ------------------------------------------------------------------ */
async function execReadTool(name, input, userId) {
  try {
    if (name === 'list_pending_import_suggestions') return await toolListPendingSuggestions(userId);
    if (name === 'list_pending_agent_actions') return await toolListPendingAgentActions(userId);
    if (name === 'list_open_ledger_items') return await toolListOpenLedgerItems(input, userId);
    if (name === 'list_chase_targets') return await toolListChaseTargets(input, userId);
    if (name === 'get_chase_agent_config') return await toolGetChaseAgentConfig(userId);
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    console.error(`[marginActions] tool ${name} threw:`, e.message);
    return { error: 'That lookup failed just now.' };
  }
}

async function toolListPendingSuggestions(userId) {
  const rows = await selectRows(
    'import_suggestions',
    `select=id,from_phone,mime_type,proposal,received_at&user_id=eq.${userId}&status=eq.pending&order=received_at.desc&limit=25`
  );
  if (!rows.length) return { suggestions: [], note: 'Nothing pending.' };
  return {
    suggestions: rows.map(r => ({
      id: r.id,
      received_at: r.received_at,
      entries: ((r.proposal && r.proposal.entries) || []).map(e => ({ target: e.target, party: e.party || e.label || null, amount: e.amount }))
    }))
  };
}

async function toolListPendingAgentActions(userId) {
  const rows = await selectRows(
    'agent_actions',
    `select=id,kind,title,rationale,amount,currency,confidence&user_id=eq.${userId}&agent=eq.close_collections&status=eq.proposed&order=confidence.desc.nullslast,created_at.desc&limit=50`
  );
  if (!rows.length) return { actions: [], note: 'Nothing pending in the Agent Queue.' };
  return { actions: rows };
}

async function toolListOpenLedgerItems(input, userId) {
  const kind = (input && input.kind === 'payable') ? 'payable' : 'receivable';
  const table = kind === 'payable' ? 'payables' : 'receivables';
  let query = `select=id,party_name,amount,due_date,source&user_id=eq.${userId}&status=eq.open&order=due_date.asc.nullslast&limit=100`;
  const partyQuery = (input && input.party_query) ? String(input.party_query).trim() : '';
  if (partyQuery) query += `&party_name=ilike.*${encodeURIComponent(partyQuery)}*`;
  const rows = await selectRows(table, query);
  if (!rows.length) return { items: [], note: `No open ${kind}s${partyQuery ? ' matching "' + partyQuery + '"' : ''}.` };
  return { kind, items: rows };
}

async function toolListChaseTargets(input, userId) {
  let query = `select=id,party_name,amount,due_date,invoice_ref,state,contact_phone,receivable_id&user_id=eq.${userId}&order=updated_at.desc&limit=100`;
  if (input && input.state) query += `&state=eq.${encodeURIComponent(input.state)}`;
  const partyQuery = (input && input.party_query) ? String(input.party_query).trim() : '';
  if (partyQuery) query += `&party_name=ilike.*${encodeURIComponent(partyQuery)}*`;
  const rows = await selectRows('whatsapp_chase_targets', query);
  if (!rows.length) return { targets: [], note: 'No matching chase targets.' };
  return { targets: rows };
}

async function toolGetChaseAgentConfig(userId) {
  const rows = await selectRows(
    'agent_deployments',
    `select=status,config,deployed_at&user_id=eq.${userId}&agent_id=eq.chase_agent&limit=1`
  );
  if (!rows.length) return { deployed: false, note: 'Chase Agent has never been deployed for this business.' };
  return { deployed: true, status: rows[0].status, config: rows[0].config || {} };
}

/* ------------------------------------------------------------------ */
/* Proposal validation — before any confirm card is shown               */
/* ------------------------------------------------------------------ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_TABLE = {
  mark_ledger_item_paid: (p) => (p.target_kind === 'payable' ? 'payables' : 'receivables'),
  approve_suggestion: () => 'import_suggestions',
  reject_suggestion: () => 'import_suggestions',
  approve_agent_action: () => 'agent_actions',
  dismiss_agent_action: () => 'agent_actions',
  stop_chasing_party: () => 'whatsapp_chase_targets',
  mark_chase_target_paid: () => 'whatsapp_chase_targets',
  send_one_off_chase: () => 'whatsapp_chase_targets'
};
const NAME_SEARCHABLE = { receivables: 'status=eq.open', payables: 'status=eq.open', whatsapp_chase_targets: null };

/**
 * Make sure a proposal points at one real row this user owns BEFORE a
 * confirm card goes out. The model sometimes puts a name ("meridian") where
 * the row id belongs; the card then looks fine but Confirm can never work
 * (2026-09-23). A name is resolved to its row when exactly one open row
 * matches; otherwise the caller gets a plain message to send instead.
 *
 * @returns {Promise<{ok:true, proposal:object} | {ok:false, message:string}>}
 */
async function validateProposal(p, userId) {
  const tableFor = TARGET_TABLE[p && p.type];
  if (!tableFor) return { ok: true, proposal: p };           // no row target (create, pause, config, list_for_review)
  const table = tableFor(p);
  const raw = String(p.target_id || '').trim();

  if (UUID_RE.test(raw)) {
    const rows = await selectRows(table, `select=id&id=eq.${raw}&user_id=eq.${userId}&limit=1`).catch(() => []);
    if (rows.length) return { ok: true, proposal: p };
    return { ok: false, message: "I couldn't find that item any more. It may already be done. Ask me to list what's open." };
  }

  const name = raw || String((p.payload && (p.payload.party || p.payload.party_name)) || '').trim();
  if (!name || !(table in NAME_SEARCHABLE)) {
    return { ok: false, message: "I couldn't pin down which item you mean. Ask me to list them first, then tell me which one." };
  }
  const extra = NAME_SEARCHABLE[table] ? '&' + NAME_SEARCHABLE[table] : '';
  const rows = await selectRows(
    table,
    `select=id,party_name,amount&user_id=eq.${userId}${extra}&party_name=ilike.*${encodeURIComponent(name)}*&limit=6`
  ).catch(() => []);
  if (rows.length === 1) return { ok: true, proposal: Object.assign({}, p, { target_id: rows[0].id }) };
  if (!rows.length) {
    const what = table === 'payables' ? 'open payable' : table === 'receivables' ? 'open receivable' : 'chase';
    return { ok: false, message: `I couldn't find an ${what} for "${name}" in your Margyn ledger. It may already be marked paid, or it lives in Zoho, Tally or Odoo, which have to be updated there.` };
  }
  const list = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.party_name}${r.amount != null ? ' (₹' + Number(r.amount).toLocaleString('en-IN') + ')' : ''}`).join('\n');
  return { ok: false, message: `More than one match for "${name}":\n${list}\nWhich one?` };
}

/* ------------------------------------------------------------------ */
/* WhatsApp confirm/cancel handshake                                   */
/* ------------------------------------------------------------------ */
/**
 * Persist a proposed action so a later, disconnected webhook event (the
 * button tap) can find it again. Called by whatsappAgent.js right before it
 * sends the confirm/cancel buttons; the row is updated with the outbound
 * message id once the send call returns (see setPendingActionMessageId).
 */
async function createPendingAction({ userId, fromPhone, type, targetId, targetKind, payload, humanSummary }) {
  const rows = await insertRows('whatsapp_pending_actions', [{
    user_id: userId,
    from_phone: fromPhone,
    action_type: type,
    target_id: targetId || null,
    target_kind: targetKind || null,
    payload: payload || {},
    human_summary: humanSummary || ''
  }]);
  return rows[0];
}

async function setPendingActionMessageId(id, waMessageId) {
  if (!waMessageId) return;
  await updateRows('whatsapp_pending_actions', `id=eq.${id}`, { wa_message_id: waMessageId }).catch(() => {});
}

/**
 * Look up a still-pending action by the outbound message it was attached to.
 * Accepts one id or several: a reply can reference either WhatsApp's wamid or
 * Gupshup's gsId, and we stored whichever Gupshup returned on send.
 */
async function findPendingAction(userId, contextIds) {
  const ids = (Array.isArray(contextIds) ? contextIds : [contextIds]).filter(Boolean).map(String);
  if (!ids.length) return null;
  const list = ids.map((i) => '"' + i.replace(/"/g, '') + '"').join(',');
  const rows = await selectRows(
    'whatsapp_pending_actions',
    `select=*&user_id=eq.${userId}&wa_message_id=in.(${encodeURIComponent(list)})&status=eq.pending&order=created_at.desc&limit=1`
  ).catch(() => []);
  return rows[0] || null;
}

/**
 * Fallback when a Confirm/Cancel reply can't be tied to a message id: the
 * user's most recent pending action, if it was proposed in the last
 * `withinMinutes`. Only ever used when the reply itself is an unambiguous
 * "confirm" or "cancel", so a stale proposal can't be executed by accident.
 */
async function findLatestPendingAction(userId, withinMinutes = 30) {
  const since = new Date(Date.now() - withinMinutes * 60000).toISOString();
  const rows = await selectRows(
    'whatsapp_pending_actions',
    `select=*&user_id=eq.${userId}&status=eq.pending&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1`
  ).catch(() => []);
  return rows[0] || null;
}

/** After one pending action resolves, retire any duplicates of it (same type
 *  + target) so a later tap on an older copy can't run it a second time. */
async function expireDuplicatePending(pending) {
  let filter = `user_id=eq.${pending.user_id}&status=eq.pending&action_type=eq.${encodeURIComponent(pending.action_type)}&id=neq.${pending.id}`;
  filter += pending.target_id ? `&target_id=eq.${encodeURIComponent(pending.target_id)}` : '&target_id=is.null';
  await updateRows('whatsapp_pending_actions', filter, { status: 'expired', resolved_at: new Date().toISOString() }).catch(() => {});
}

/**
 * Resolve a pending action once the button reply arrives. `confirmed` is
 * decided by the caller from the button id/text — this function only ever
 * executes a write when confirmed is exactly true, and marks the row
 * cancelled otherwise. Errors during execution are recorded on the row
 * (status: 'failed') rather than thrown, so the webhook can still 200 and
 * reply to the sender with what happened.
 */
async function resolvePendingAction(pending, confirmed) {
  if (!confirmed) {
    await updateRows('whatsapp_pending_actions', `id=eq.${pending.id}`, { status: 'cancelled', resolved_at: new Date().toISOString() });
    await expireDuplicatePending(pending);
    return { ok: true, executed: false };
  }
  try {
    await executeAction({
      type: pending.action_type,
      targetId: pending.target_id,
      targetKind: pending.target_kind,
      payload: pending.payload
    }, pending.user_id);
    await updateRows('whatsapp_pending_actions', `id=eq.${pending.id}`, { status: 'confirmed', resolved_at: new Date().toISOString() });
    await expireDuplicatePending(pending);
    return { ok: true, executed: true };
  } catch (e) {
    await updateRows('whatsapp_pending_actions', `id=eq.${pending.id}`, { status: 'failed', error: e.message, resolved_at: new Date().toISOString() }).catch(() => {});
    return { ok: false, executed: false, error: e.message };
  }
}

/**
 * Server-side execution of a confirmed action, using the service-role key —
 * the WhatsApp channel has no browser to run app.html's runProposedAction,
 * so this is that function's counterpart for this one channel. Every branch
 * mirrors the exact same table/columns/status values runProposedAction
 * uses, so a receivable settled from WhatsApp looks identical to one
 * settled from the app. Scope is intentionally narrower in one place:
 * approve_suggestion here only handles receivable/payable entries (the
 * common case for a forwarded invoice/bill) — an import suggestion that
 * also touches scalar P&L figures (cash/revenue/etc, which live on the
 * `snapshots` row computed by the app's own ledgerAggregates()) still needs
 * the app to finish, and this leaves those entries alone rather than
 * guessing at a snapshot write.
 */
async function executeAction(action, userId) {
  const { type, targetId, targetKind, payload } = action;

  if (type === 'approve_suggestion' || type === 'reject_suggestion') {
    const rows = await selectRows('import_suggestions', `select=*&id=eq.${targetId}&user_id=eq.${userId}&limit=1`);
    if (!rows.length) throw new Error('Suggestion not found');
    const sug = rows[0];
    if (type === 'approve_suggestion') {
      const entries = ((sug.proposal && sug.proposal.entries) || []).filter(e => e.target === 'receivable' || e.target === 'payable');
      const recvRows = entries.filter(e => e.target === 'receivable').map(e => ({ user_id: userId, party_name: e.party || e.label || 'Unknown', amount: e.amount, due_date: e.due_date || null, status: 'open', source: 'upload' }));
      const payRows = entries.filter(e => e.target === 'payable').map(e => ({ user_id: userId, party_name: e.party || e.label || 'Unknown', amount: e.amount, due_date: e.due_date || null, status: 'open', source: 'upload' }));
      if (recvRows.length) await insertRows('receivables', recvRows);
      if (payRows.length) await insertRows('payables', payRows);
      if (recvRows.length || payRows.length) {
        await insertRows('ledger_events', [{ user_id: userId, entity_type: recvRows.length ? 'receivable' : 'payable', event: 'imported', source: 'upload', note: (recvRows.length + payRows.length) + ' item(s) imported via WhatsApp' }]).catch(() => {});
      }
    }
    await updateRows('import_suggestions', `id=eq.${sug.id}`, { status: type === 'approve_suggestion' ? 'approved' : 'rejected', decided_at: new Date().toISOString() });
    return;
  }

  if (type === 'approve_agent_action' || type === 'dismiss_agent_action') {
    await reviewAgentAction({ actionId: targetId, userId, decision: type === 'approve_agent_action' ? 'approve' : 'reject' });
    return;
  }

  if (type === 'pause_chase_agent' || type === 'resume_chase_agent') {
    await updateRows('agent_deployments', `user_id=eq.${userId}&agent_id=eq.chase_agent`, { status: type === 'pause_chase_agent' ? 'paused' : 'active', updated_at: new Date().toISOString() });
    return;
  }

  if (type === 'update_chase_agent_config') {
    const rows = await selectRows('agent_deployments', `select=config&user_id=eq.${userId}&agent_id=eq.chase_agent&limit=1`);
    const newConfig = Object.assign({}, (rows[0] && rows[0].config) || {}, payload || {});
    await updateRows('agent_deployments', `user_id=eq.${userId}&agent_id=eq.chase_agent`, { config: newConfig, updated_at: new Date().toISOString() });
    return;
  }

  if (type === 'mark_ledger_item_paid') {
    const table = targetKind === 'payable' ? 'payables' : 'receivables';
    const rows = await selectRows(table, `select=*&id=eq.${targetId}&user_id=eq.${userId}&limit=1`);
    if (!rows.length) throw new Error('Ledger item not found');
    const r = rows[0];
    const settledKind = table === 'payables' ? 'paid' : 'received';
    await updateRows(table, `id=eq.${r.id}`, { status: 'settled', settled_at: new Date().toISOString(), settled_amount: r.amount, settled_kind: settledKind });
    await insertRows('ledger_events', [{ user_id: userId, entity_type: table === 'payables' ? 'payable' : 'receivable', entity_id: r.id, event: 'settled', party_name: r.party_name, amount: r.amount, source: r.source || 'manual', note: 'marked ' + settledKind + ' via WhatsApp' }]).catch(() => {});
    return;
  }

  if (type === 'create_ledger_item') {
    const p = payload || {};
    const table = targetKind === 'payable' ? 'payables' : 'receivables';
    await insertRows(table, [{ user_id: userId, party_name: p.party || 'Unknown', amount: Number(p.amount) || 0, due_date: p.due_date || null, status: 'open', source: 'manual' }]);
    await insertRows('ledger_events', [{ user_id: userId, entity_type: table === 'payables' ? 'payable' : 'receivable', event: 'created', party_name: p.party, amount: p.amount, source: 'manual', note: 'logged via WhatsApp' }]).catch(() => {});
    return;
  }

  if (type === 'stop_chasing_party') {
    await updateRows('whatsapp_chase_targets', `id=eq.${targetId}&user_id=eq.${userId}`, { state: 'stopped', resolution: 'Stopped via WhatsApp.', next_chase_at: null });
    return;
  }

  if (type === 'mark_chase_target_paid') {
    const rows = await selectRows('whatsapp_chase_targets', `select=*&id=eq.${targetId}&user_id=eq.${userId}&limit=1`);
    if (!rows.length) throw new Error('Chase target not found');
    const t = rows[0];
    await updateRows('whatsapp_chase_targets', `id=eq.${t.id}`, { state: 'resolved_paid', resolution: 'Marked paid via WhatsApp.', resolved_at: new Date().toISOString(), next_chase_at: null });
    if (t.receivable_id) {
      await updateRows('receivables', `id=eq.${t.receivable_id}`, { status: 'settled', settled_at: new Date().toISOString(), settled_amount: t.amount, settled_kind: 'received' }).catch(() => {});
    }
    return;
  }

  if (type === 'send_one_off_chase') {
    const rows = await selectRows('whatsapp_chase_targets', `select=*&id=eq.${targetId}&user_id=eq.${userId}&limit=1`);
    if (!rows.length) throw new Error('Chase target not found');
    const t = rows[0];
    await updateRows('whatsapp_chase_targets', `id=eq.${t.id}`, { state: 'escalated_human', resolution: 'One-off reminder sent via WhatsApp agent.', next_chase_at: null });
    // Best-effort only: a free-text session send to the CUSTOMER's number,
    // which only lands if they've messaged this WABA in the last 24h — same
    // constraint sendText always carries. Untested against a real account.
    if (t.contact_phone) {
      const bsp = require('./whatsappBsp');
      const msg = 'Hi ' + (t.party_name || '') + ', following up on invoice ' + (t.invoice_ref || '') + ' for ' + (t.amount || 0) + '. Could we sort out payment this week?';
      await bsp.sendText({ to: t.contact_phone, text: msg }).catch(() => {});
    }
    return;
  }

  throw new Error('Unknown action type: ' + type);
}

module.exports = {
  TOOLS, isProposeAction, execReadTool, validateProposal,
  createPendingAction, setPendingActionMessageId, findPendingAction, findLatestPendingAction, resolvePendingAction, executeAction
};
