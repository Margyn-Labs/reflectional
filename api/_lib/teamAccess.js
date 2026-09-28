/**
 * api/_lib/teamAccess.js
 * Roles, permissions, and which API calls a team member may make.
 * Added 2026-09-29 (team logins). Pure: no network.
 *
 * The same role table lives in SQL (mg_role_allows in
 * 2026-09-29-team-logins.sql) for the database's own row rules. Change one,
 * change the other; the test checks this file against the SQL copy quoted in
 * SQL_ROLE_TABLE below.
 *
 * The account's owner is the login whose id every row is keyed to. Owners
 * are never stored as members and always have every permission.
 */

const PERMISSIONS = [
  'view_cash', 'view_receivables', 'view_payables', 'view_gst',
  'edit', 'approve', 'manage_people', 'manage_connections'
];
const VIEW_ALL = ['view_cash', 'view_receivables', 'view_payables', 'view_gst'];

const ROLE_DEFAULTS = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  finance: [...VIEW_ALL, 'edit', 'approve'],
  approver: ['view_receivables', 'view_payables', 'approve'],
  viewer: VIEW_ALL,
  advisor: VIEW_ALL
};
const ROLES = ['admin', 'finance', 'approver', 'viewer', 'advisor'];   // what an invite can grant
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', finance: 'Finance', approver: 'Approver', viewer: 'Viewer', advisor: 'Advisor (CA)' };

// Mirror of mg_role_allows() in the SQL migration, for the drift test.
const SQL_ROLE_TABLE = {
  admin: 'all',
  finance: ['view', 'view_cash', 'view_receivables', 'view_payables', 'view_gst', 'edit', 'approve'],
  approver: ['view', 'view_receivables', 'view_payables', 'approve'],
  viewer: ['view', 'view_cash', 'view_receivables', 'view_payables', 'view_gst'],
  advisor: ['view', 'view_cash', 'view_receivables', 'view_payables', 'view_gst']
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

/** Only known keys, only booleans. What an admin may store as overrides. */
function cleanOverrides(o) {
  const out = {};
  if (o && typeof o === 'object') for (const k of PERMISSIONS) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

function actionOf(req) {
  if (req.query && req.query.action) return String(req.query.action);
  try { return new URL(req.url || '', 'http://x').searchParams.get('action') || ''; } catch (e) { return ''; }
}
function pathOf(req) { return String(req.url || '').split('?')[0]; }

/**
 * May a member with these permissions make this request? Checked once, in
 * getUserFromRequest, for every router. The database's row rules enforce the
 * same permissions for anything the app writes directly.
 */
function memberMayCall(req, perms) {
  const has = (p) => perms.includes(p);
  const path = pathOf(req), action = actionOf(req), method = (req.method || 'GET').toUpperCase();

  // Team administration
  if (path.startsWith('/api/ops') && /^team-(invite|revoke|update|remove)$/.test(action)) return has('manage_people');
  if (path.startsWith('/api/ops') && (/^team-/.test(action) || action === 'track')) return true;
  // Everything else on the ops router is founder-internal, never via a membership
  if (path.startsWith('/api/ops')) return false;

  // Connecting, disconnecting and pairing sources
  if (/^\/api\/(zoho|shopify|tally|sync-razorpay)/.test(path) &&
      /(^|-)(connect|disconnect|oauth-start|select-org|pair-init|revoke)$/.test(action)) return has('manage_connections');

  // Approvals
  if (path.startsWith('/api/reconcile') && /^(resolve|agent-review)$/.test(action)) return has('approve');

  // Asking and narration read, though they POST
  if (path.startsWith('/api/ask-margyn') || path.startsWith('/api/generate-briefing')) return true;

  if (method === 'GET') return true;
  return has('edit');
}

module.exports = { PERMISSIONS, ROLES, ROLE_LABEL, ROLE_DEFAULTS, SQL_ROLE_TABLE, effectivePermissions, cleanOverrides, memberMayCall };
