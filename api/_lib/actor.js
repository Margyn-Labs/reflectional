/**
 * api/_lib/actor.js
 * Who is asking, and what they may see. Added 2026-09-29.
 *
 * Every new endpoint takes its scope from resolveActor(req), never from an
 * id the browser sends. The account is the owner's login id (every table is
 * keyed to it). A team member working in that account arrives through
 * getUserFromRequest (supabaseRest.accountFor), which has already checked
 * the membership and whether their role allows this call.
 */

const { getUserFromRequest } = require('./supabaseRest');
const { PERMISSIONS, ROLE_DEFAULTS, effectivePermissions } = require('./teamAccess');

/**
 * @returns {Promise<null | { userId, accountId, email, role, name, permissions }>}
 *          null when the request carries no valid session or membership.
 */
async function resolveActor(req) {
  const user = await getUserFromRequest(req);
  if (!user || !user.id) return null;
  if (user.member) {
    return {
      userId: user.auth_id,
      accountId: user.id,
      email: user.email || null,
      role: user.member.role,
      name: user.member.name,
      permissions: user.member.permissions
    };
  }
  return { userId: user.id, accountId: user.id, email: user.email || null, role: 'owner', name: null, permissions: effectivePermissions('owner') };
}

function can(actor, permission) {
  return !!actor && actor.permissions.includes(permission);
}

module.exports = { PERMISSIONS, ROLE_DEFAULTS, effectivePermissions, resolveActor, can };
