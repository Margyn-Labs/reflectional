/**
 * POST /api/disconnect-zoho
 *
 * Disconnection flow per zoho-books-auth-flow:
 *   1. Revoke the refresh token at Zoho (formally invalidates it there).
 *   2. Purge the vault entry.
 *   3. Mark the org `disconnected` and stamp `connector_disconnected_at`.
 *   4. The owner's choice for what Margyn already copied: kept (the default; vitals history stays viewable) or,
 *      with remove_data, deleted (selfCleanup.removeZohoData, counts in connector_logs). The answer says which.
 *   5. Log the event to connector_logs.
 *
 * Body: { org_ref?: uuid, remove_data?: boolean }  (defaults to the user's active org, data kept)
 * Response: 200 { status: "disconnected", revoked_at_zoho: boolean, data: "kept" | "removed", removed_rows?, message }
 *
 * Step 3 happens even if step 1 fails — a Zoho-side outage must not leave
 * Margyn holding a live token it thinks is dead. Steps 2 and 3 are the ones
 * that actually matter for Margyn's own security posture.
 */

const { getUserFromRequest, selectRows, updateRows, logConnectorEvent } = require('../_lib/supabaseRest');
const { readRefreshToken, revokeRefreshToken, purgeRefreshToken } = require('../_lib/zohoClient');
const { removeZohoData } = require('../_lib/selfCleanup');

async function handler(req, res) {
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

  // 4. The owner's choice: keep what was copied (default) or remove it.
  let removed = null;
  if (body.remove_data === true) {
    try {
      const counts = await removeZohoData(Object.assign({}, org, { status: 'disconnected' }));
      removed = Object.values(counts).reduce((t, n) => t + (Number(n) || 0), 0);
    } catch (err) {
      await logConnectorEvent({ userId: user.id, connectorType: 'zoho_books', operation: 'disconnect_remove_data', status: 'error', errorMessage: 'could not remove the synced data' });
      res.status(200).json({ status: 'disconnected', revoked_at_zoho: revoked, data: 'kept',
        message: 'Zoho Books is disconnected, but Margyn could not remove the data it copied. It is still in Margyn; try Disconnect again to remove it.' });
      return;
    }
  }

  await logConnectorEvent({
    userId: user.id,
    connectorType: 'zoho_books',
    operation: 'disconnect',
    status: 'success',
    recordsSynced: removed || 0,
    errorMessage: [revoked ? null : 'zoho_revocation_unconfirmed', removed != null ? `removed ${removed} synced rows` : 'data kept'].filter(Boolean).join('; ')
  });

  res.status(200).json({
    status: 'disconnected',
    revoked_at_zoho: revoked,
    data: removed != null ? 'removed' : 'kept',
    ...(removed != null ? { removed_rows: removed } : {}),
    message: removed != null
      ? 'Zoho Books disconnected and the data Margyn copied from it is removed. Customer and supplier contacts in your party list stay.'
      : 'Zoho Books disconnected. Your historical data stays visible in Margyn.'
  });
};

module.exports = { handler };
