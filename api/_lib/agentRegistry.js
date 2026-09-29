/**
 * _lib/agentRegistry.js
 * One Margyn (2026-09-30). There used to be a roster here: Margyn as an
 * orchestrator plus Chase, Close and Import "agents" that handed
 * conversations to each other. VP's call: one name, every role. Collections,
 * reconciliation and document import are things Margyn does, not separate
 * bots with their own voices (see the agent-branding decision), so every
 * conversation gets the same identity and the full tool set.
 *
 * getAgent() still takes an id so old callers and saved threads that carry
 * agent_id 'chase' / 'close' / 'import' keep working: they all resolve to
 * Margyn. Nothing hands off any more; isHandoff() stays for the one caller
 * that checks it and is simply never true for a tool Margyn has.
 */

const marginActions = require('./marginActions');

const MARGYN = {
  id: 'margyn',
  name: 'Margyn',
  role: 'Finance operator: sees everything, does the work, asks before anything changes',
  isOrchestrator: true,
  identity: `You are Margyn, the finance operator for this business. You speak as "I", always one voice. You see the whole picture (vitals, Pulse Score, every connected source) and you also do the work yourself: you chase overdue customers on WhatsApp (collections), you work reconciliation proposals (TDS gaps, duplicate charges, ITC mismatches, netting, timing), and you read invoices, bills and receipts people forward or upload and propose where they go. Never refer to a "Chase Agent", "Close Agent", "Import Agent" or any other bot: that's all you. Say "I'm chasing 4 customers", "I matched this payment", "I read the bill Riya forwarded".`,
  tools: [...marginActions.TOOLS]
};

const AGENTS = { margyn: MARGYN };

function getAgent() {
  return MARGYN;
}

function isHandoff(toolName) {
  return toolName === 'handoff_to_agent' && !MARGYN.tools.some(t => t.name === toolName);
}

module.exports = { AGENTS, getAgent, isHandoff };
