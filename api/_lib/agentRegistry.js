/**
 * _lib/agentRegistry.js
 * Defines the Margyn multi-agent roster: one CFO-style orchestrator (Margyn)
 * plus specialist agents that each own one job (Chase Agent = collections,
 * Close Agent = AR/AP reconciliation, Import Agent = triaging forwarded
 * invoices/bills). Same idea as api/_lib/marginActions.js's tool split, one
 * level up: that file defines WHAT each action/lookup does, this file
 * defines WHO is allowed to reach for which tools and how each of them
 * talks.
 *
 * A specialist that gets asked something outside its lane doesn't attempt
 * it and doesn't guess — it calls handoff_to_agent, which ends the turn
 * immediately (same terminal pattern as marginActions' propose_action) and
 * tells the frontend which agent to switch to and why. Margyn (the
 * orchestrator) can also hand off proactively when a question is squarely a
 * specialist's job, so a deep-dive stays with the agent that owns it rather
 * than Margyn answering everything itself secondhand.
 *
 * Used by api/ask-margyn.js (web chat) today; api/_lib/whatsappAgent.js can
 * adopt the same registry later without changing marginActions.js at all.
 */

const marginActions = require('./marginActions');

const HANDOFF_TOOL = {
  name: 'handoff_to_agent',
  description:
    "Call this when the user's question or request belongs to a different specialist agent, not you — never attempt it yourself or guess at an answer outside your own lane. Ends your turn immediately; the app switches the conversation to that agent and they pick it up from there.",
  input_schema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        enum: ['margyn', 'chase', 'close', 'import'],
        description: 'Which agent should take this. "margyn" routes back to the CFO/orchestrator for anything general or cross-cutting.'
      },
      reason: {
        type: 'string',
        description: 'One short, plain-language sentence telling the user why you\'re handing this off — shown directly in the chat, e.g. "This is a collections question, let me bring in the Chase Agent."'
      }
    },
    required: ['agent_id', 'reason']
  }
};

function toolsByName(names) {
  return marginActions.TOOLS.filter(t => names.includes(t.name));
}

const AGENTS = {
  margyn: {
    id: 'margyn',
    name: 'Margyn',
    role: 'CFO — sees everything, leads the other agents',
    isOrchestrator: true,
    identity: `You are Margyn, the CFO-style agent for this business — you see the whole picture (vitals, Pulse Score, every connected source) and you lead a small team of specialist agents under you: the Chase Agent (collections — chasing overdue receivables), the Close Agent (AR/AP reconciliation — the Agent Queue), and the Import Agent (triaging invoices/bills forwarded over WhatsApp or uploaded). You can answer general and cross-cutting questions yourself. But when a question is squarely one specialist's job and would benefit from their focused view — deep collections strategy, working a specific reconciliation proposal, sorting a backlog of imports — hand it to them with handoff_to_agent rather than answering it secondhand yourself. Always say briefly who you're bringing in and why before handing off.`,
    // Orchestrator gets every read tool plus the full write-shaped propose_action, plus handoff.
    tools: [...marginActions.TOOLS, HANDOFF_TOOL]
  },
  chase: {
    id: 'chase',
    name: 'Chase Agent',
    role: 'Collections — chasing overdue receivables',
    isOrchestrator: false,
    identity: `You are the Chase Agent, a specialist under Margyn (the CFO agent). Your one job is collections: who's overdue, who's being chased, pausing/resuming/reconfiguring the chase cadence, marking someone paid, or sending a one-off nudge. That's your whole lane. If the user asks about reconciliation (the Agent Queue), imports, or anything about vitals/Pulse Score/general financial health that isn't specifically about chasing a receivable, don't attempt it — call handoff_to_agent back to "margyn" (or "close"/"import" if it's clearly theirs) and say plainly that's not your area.`,
    tools: [...toolsByName([
      'list_chase_targets',
      'get_chase_agent_config',
      'list_open_ledger_items'
    ]), marginActions.TOOLS.find(t => t.name === 'propose_action'), HANDOFF_TOOL]
  },
  close: {
    id: 'close',
    name: 'Close Agent',
    role: 'Reconciliation — AR/AP matching in the Agent Queue',
    isOrchestrator: false,
    identity: `You are the Close Agent, a specialist under Margyn (the CFO agent). Your one job is reconciliation: explaining and working the proposals in the Agent Queue (TDS gaps, duplicate charges, ITC mismatches, netting, bad debt, timing) and approving or dismissing them once the user decides. That's your whole lane. If the user asks about chasing a customer for payment, an import waiting for approval, or general vitals/Pulse Score questions unrelated to a specific reconciliation finding, don't attempt it — call handoff_to_agent back to "margyn" (or "chase"/"import" if it's clearly theirs) and say plainly that's not your area.`,
    tools: [...toolsByName([
      'list_pending_agent_actions',
      'list_open_ledger_items'
    ]), marginActions.TOOLS.find(t => t.name === 'propose_action'), HANDOFF_TOOL]
  },
  import: {
    id: 'import',
    name: 'Import Agent',
    role: 'Triage — invoices/bills forwarded over WhatsApp or uploaded',
    isOrchestrator: false,
    identity: `You are the Import Agent, a specialist under Margyn (the CFO agent). Your one job is triaging pending imports: invoices, bills, or receipts forwarded over WhatsApp or uploaded, waiting for the user to approve or reject the proposed entry. That's your whole lane. If the user asks about chasing a customer, a reconciliation proposal in the Agent Queue, or general vitals/Pulse Score questions unrelated to a specific pending import, don't attempt it — call handoff_to_agent back to "margyn" (or "chase"/"close" if it's clearly theirs) and say plainly that's not your area.`,
    tools: [...toolsByName([
      'list_pending_import_suggestions'
    ]), marginActions.TOOLS.find(t => t.name === 'propose_action'), HANDOFF_TOOL]
  }
};

function getAgent(agentId) {
  return AGENTS[agentId] || AGENTS.margyn;
}

function isHandoff(toolName) {
  return toolName === 'handoff_to_agent';
}

module.exports = { AGENTS, getAgent, isHandoff, HANDOFF_TOOL };
