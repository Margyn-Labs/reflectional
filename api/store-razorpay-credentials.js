/**
 * POST /api/store-razorpay-credentials
 *
 * Validates a Razorpay Key ID + Key Secret pair against Razorpay's API, then
 * stores them for the authenticated user. This is the manual-entry fallback
 * described in the Razorpay auth flow (Quick Connect / OAuth is Phase 2 and
 * not implemented here).
 *
 * Request:  { keyId: string, keySecret: string }
 * Response: 200 { status: "connected", message: "Razorpay connected" }
 *           401 { error: "Invalid credentials" }
 *           400 { error: "..." } (bad input / not authenticated)
 *           500 { error: "..." } (network/Razorpay/db failure)
 *
 * SECURITY: keySecret is never logged, never echoed back in a response, and
 * never included in the connector_logs error_message.
 */

const { getUserFromRequest, insertRows, updateRows, selectRows, logConnectorEvent } = require('./_lib/supabaseRest');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Authenticate the caller
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

  // 2. Parse + validate input
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const keyId = (body && body.keyId || '').trim();
  const keySecret = (body && body.keySecret || '').trim();

  if (!keyId || !keySecret) {
    res.status(400).json({ error: 'Key ID and Key Secret are both required' });
    return;
  }

  // 3. Validate credentials against Razorpay with a minimal read call
  let testCall;
  try {
    testCall = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
      }
    });
  } catch (err) {
    // Network failure talking to Razorpay — not a credentials problem
    await logConnectorEvent({
      userId: user.id,
      connectorType: 'razorpay',
      operation: 'store_credentials',
      status: 'error',
      errorMessage: 'Network error validating credentials with Razorpay'
    });
    res.status(500).json({ error: 'Could not reach Razorpay. Try again in a moment.' });
    return;
  }

  if (testCall.status === 401) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (testCall.status !== 200) {
    await logConnectorEvent({
      userId: user.id,
      connectorType: 'razorpay',
      operation: 'store_credentials',
      status: 'error',
      errorMessage: `Razorpay validation call returned ${testCall.status}`
    });
    res.status(500).json({ error: 'Razorpay could not be reached right now. Try again shortly.' });
    return;
  }

  // 4. Store credentials. If a previous connection exists, mark it
  //    disconnected first (the unique constraint on connector_credentials
  //    only allows one active row per user+connector at a time).
  try {
    const existing = await selectRows(
      'connector_credentials',
      `select=id&user_id=eq.${user.id}&connector_type=eq.razorpay&disconnected_at=is.null`
    );

    if (existing.length > 0) {
      await updateRows(
        'connector_credentials',
        `user_id=eq.${user.id}&connector_type=eq.razorpay&disconnected_at=is.null`,
        { disconnected_at: new Date().toISOString() }
      );
    }

    await insertRows('connector_credentials', [{
      user_id: user.id,
      connector_type: 'razorpay',
      key_id: keyId,
      key_secret: keySecret,
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    // err.message may include response text but never the secret itself,
    // since insertRows/updateRows only echo back what Postgres returns and
    // Postgres error bodies for this table don't include column values.
    await logConnectorEvent({
      userId: user.id,
      connectorType: 'razorpay',
      operation: 'store_credentials',
      status: 'error',
      errorMessage: 'Failed to persist credentials'
    });
    res.status(500).json({ error: 'Could not save credentials. Try again.' });
    return;
  }

  await logConnectorEvent({
    userId: user.id,
    connectorType: 'razorpay',
    operation: 'store_credentials',
    status: 'success',
    recordsSynced: 0
  });

  // 5. Kick off first sync in the background (fire-and-forget). If this
  //    fails, the nightly cron will still pick the user up — don't block
  //    the response on it.
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    if (host) {
      fetch(`${proto}://${host}/api/sync-razorpay`, {
        method: 'POST',
        headers: {
          Authorization: req.headers['authorization'],
          'Content-Type': 'application/json'
        }
      }).catch(() => {});
    }
  } catch {
    // best-effort only
  }

  res.status(200).json({ status: 'connected', message: 'Razorpay connected' });
};
