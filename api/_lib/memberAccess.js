/**
 * api/_lib/memberAccess.js
 * What one WhatsApp number may do on a Margyn account. Added 2026-09-23.
 *
 * Stored per person in business_stakeholders.permissions (JSONB), set from
 * Settings > People:
 *
 *   ask           chat with Margyn about the business's numbers
 *   act           confirm actions Margyn proposes (needs ask)
 *   forward       forward invoices/bills/receipts for import
 *   opening_bell  receive the Opening Bell
 *   closing_bell  receive the Closing Bell
 *
 * The account's primary number (profiles.whatsapp_phone) can always ask,
 * act and forward; its Bells follow the Bell agent's frequency setting
 * (agent_deployments.config.frequency), not this object.
 *
 * whatsapp_access (the column the unique phone index keys on) is kept equal
 * to ask || forward by the app, i.e. "this number can send things in". A
 * Bells-only number is deliberately NOT access-linked, so the same person
 * (an outside CA, say) can get the Bell from several client accounts.
 */

const { effectivePermissions } = require('./teamAccess');

const PERM_KEYS = ['ask', 'act', 'forward', 'opening_bell', 'closing_bell'];
const FULL_INBOUND = { ask: true, act: true, forward: true, opening_bell: false, closing_bell: false };
const NONE = { ask: false, act: false, forward: false, opening_bell: false, closing_bell: false };

/**
 * @param member      business_stakeholders row, or null
 * @param viaPrimary  true when the number matched profiles.whatsapp_phone
 * @param login       the account_members row this number is linked to
 *                    (business_stakeholders.member_id, 2026-09-30), or null.
 *                    A linked number follows that person's app role: one
 *                    person, one set of permissions, on both channels.
 */
function memberPerms(member, viaPrimary, login) {
  if (viaPrimary || (member && member.is_primary)) return { ...FULL_INBOUND };
  if (!member) return { ...NONE };
  if (login) {
    if (login.status !== 'active') return { ...NONE };
    const eff = effectivePermissions(login.role, login.permissions);
    const p = member.permissions && typeof member.permissions === 'object' ? member.permissions : {};
    return {
      ask: true,
      act: eff.includes('approve') || eff.includes('edit'),
      forward: eff.includes('edit'),
      opening_bell: !!p.opening_bell,
      closing_bell: !!p.closing_bell,
      login: { user_id: login.user_id, role: login.role, permissions: eff }
    };
  }
  const p = member.permissions && typeof member.permissions === 'object' ? member.permissions : {};
  // A row saved before per-permission access existed: whatsapp_access was
  // the one "can chat" switch, which covered ask + act + forward.
  if (!PERM_KEYS.some(k => k in p)) return member.whatsapp_access ? { ...FULL_INBOUND } : { ...NONE };
  return {
    ask: !!p.ask,
    act: !!p.ask && !!p.act,
    forward: !!p.forward,
    opening_bell: !!p.opening_bell,
    closing_bell: !!p.closing_bell
  };
}

/* What confirming each WhatsApp action needs, for a number linked to a login.
   Approving or dismissing someone else's proposal is an approval; everything
   else changes the books or the agents, which is editing. */
const APPROVAL_ACTIONS = ['approve_suggestion', 'reject_suggestion', 'approve_agent_action', 'dismiss_agent_action'];
function actionNeeds(actionType) { return APPROVAL_ACTIONS.includes(actionType) ? 'approve' : 'edit'; }
/** May this sender confirm this action? Unlinked numbers keep the Act switch. */
function mayConfirm(perms, actionType) {
  if (!perms || !perms.act) return false;
  if (!perms.login) return true;
  return perms.login.permissions.includes(actionNeeds(actionType));
}

/** Short, human description of what a number CAN do, for "not allowed" replies. */
function describePerms(perms) {
  const bits = [];
  if (perms.ask) bits.push('ask Margyn questions');
  if (perms.forward) bits.push('forward documents');
  if (perms.opening_bell && perms.closing_bell) bits.push('receive both Bells');
  else if (perms.opening_bell) bits.push('receive the Opening Bell');
  else if (perms.closing_bell) bits.push('receive the Closing Bell');
  return bits.length ? bits.join(', ') : 'nothing yet';
}

module.exports = { PERM_KEYS, memberPerms, describePerms, actionNeeds, mayConfirm };
