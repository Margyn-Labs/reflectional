/**
 * api/_lib/actor.js
 * Who is asking, and what they may see. Added 2026-09-29.
 *
 * Every new endpoint takes its scope from resolveActor(req), never from an
 * id the browser sends. Today one login is one business, so the actor is
 * always the account's owner: accountId === userId, full permissions.
 *
 * Team logins (SPEC-IDENTITY-AND-SINGLE-TRUTH-2026-09-29.md, Part 1) change
 * only this file: resolveActor will read workspace_members and return the
 * person's workspace, role and permissions. Callers that already filter by
 * accountId and check can() need no change when that lands.
 */

const { getUserFromRequest } = require('./supabaseRest');

// What a person may see or do in the app. The WhatsApp permissions in
// memberAccess.js (ask / act / forward / bells) join these when a WhatsApp
// number and a login become one Person.
const PERMISSIONS = [
  'view_cash', 'view_receivables', 'view_payables', 'view_gst',
  'edit', 'approve', 'manage_people', 'manage_connections'
];

const ROLE_DEFAULTS = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  finance: ['view_cash', 'view_receivables', 'view_payables', 'view_gst', 'edit', 'approve'],
  approver: ['view_receivables', 'view_payables', 'approve'],
  viewer: ['view_receivables']
};

/** Role defaults plus per-person overrides ({ view_cash: false, ... }). */
function effectivePermissions(role, overrides) {
  const set = new Set(ROLE_DEFAULTS[role] || []);
  if (overrides && typeof overrides === 'object') {
    for (const k of PERMISSIONS) {
      if (overrides[k] === true) set.add(k);
      if (overrides[k] === false) set.delete(k);
    }
  }
  return PERMISSIONS.filter((k) => set.has(k));
}

/**
 * @returns {Promise<null | { userId, accountId, email, role, permissions }>}
 *          null when the request carries no valid session.
 */
async function resolveActor(req) {
  const user = await getUserFromRequest(req);
  if (!user || !user.id) return null;
  return {
    userId: user.id,
    accountId: user.id,
    email: user.email || null,
    role: 'owner',
    permissions: effectivePermissions('owner')
  };
}

function can(actor, permission) {
  return !!actor && actor.permissions.includes(permission);
}

module.exports = { PERMISSIONS, ROLE_DEFAULTS, effectivePermissions, resolveActor, can };
