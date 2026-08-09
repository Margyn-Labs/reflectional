/**
 * POST /api/disconnect-zoho
 *
 * Disconnection flow per zoho-books-auth-flow:
 *   1. Revoke the refresh token at Zoho (formally invalidates it there).
 *   2. Purge the vault entry.
 *   3. Mark the org `disconnected` and stamp `connector_disconnected_at`.
 *      Historical synced rows are RETAINED — vitals history stays viewable.
 *      No cascading delete.
 *   4. Log the event to connector_logs.
 *
 * Body: { org_ref?: uuid }  (defaults to the user's active org)
 * Response: 200 { status: "disconnected", revoked_at_zoho: boolean }
 *
 * Step 3 happens even if step 1 fails — a Zoho-side outage must not leave
 * Margyn holding a live token it thinks is dead. Steps 2 and 3 are the ones
 * that actually matter for Margyn's own security posture.
 */

const { getUserFromRequest, selectRows, updateRows, logConnectorEvent } = require('./_lib/supabaseRest');
const { readRefreshToken, revokeRefreshToken, purgeRefreshToken } = require('./_lib/zohoClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    res.status(500).json({ error: 'Authentication check failed' });
    return;
  }
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }

  const filter = body.org_ref
    ? `select=*&id=eq.${body.org_ref}&user_id=eq.${user.id}&limit=1`
    : `select=*&user_id=eq.${user.id}&status=in.(active,needs_reauth,pending_org_selection)&order=connected_at.desc&limit=1`;

  let org;
  try {
    const rows = await selectRows('zoho_organizations', filter);
    org = rows[0];
  } catch (err) {
    res.status(500).json({ error: 'Could not load the connection' });
    return;
  }

  if (!org) {
    res.status(404).json({ error: 'No Zoho Books connection found' });
    return;
  }

  // 1. Revoke at Zoho. Best-effort; never blocks the local purge.
  let revoked = false;
  try {
    const refreshToken = await readRefreshToken(org.id);
    revoked = await revokeRefreshToken(refreshToken, org.accounts_domain);
  } catch (err) {
    // Token already gone from the vault, or Zoho unreachable. Continue.
    revoked = false;
  }

  // 2. Purge the vault entry. This one must succeed.
  try {
    await purgeRefreshToken(org.id);
  } catch (err) {
    await logConnectorEvent({
      userId: user.id, connectorType: 'zoho_books', operation: 'disconnect',
      status: 'error', errorMessage: 'Vault purge failed'
    });
    res.status(500).json({ error: 'Could not fully remove the stored authorization. Nothing was disconnected — please retry.' });
    return;
  }

  // 3. Mark disconnected. Historical data is deliberately retained.
  try {
    await updateRows('zoho_organizations', `id=eq.${org.id}`, {
      status: 'disconnected',
      connector_disconnected_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Connection was revoked but the record could not be updated' });
    return;
  }

  await logConnectorEvent({
    userId: user.id,
    connectorType: 'zoho_books',
    operation: 'disconnect',
    status: 'success',
    recordsSynced: 0,
    errorMessage: revoked ? null : 'zoho_revocation_unconfirmed'
  });

  res.status(200).json({
    status: 'disconnected',
    revoked_at_zoho: revoked,
    message: 'Zoho Books disconnected. Your historical data stays visible in Margyn.'
  });
};
