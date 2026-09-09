/**
 * api/cashfree.js
 *
 * Single router for the Cashfree Payments connector, dispatched by ?action= to
 * stay under the Vercel Hobby plan's 12-function cap. api/tally.js was already
 * "12/12", so this connector could not be added as new standalone files — it
 * ships as ONE function, and the deploy notes pair it with folding the three
 * legacy Razorpay files (cron-sync-razorpay.js / store-razorpay-credentials.js
 * / sync-razorpay.js) into a matching api/razorpay.js router to stay net under
 * the cap. See CASHFREE-CONNECTOR-NOTES.md.
 *
 *   POST /api/cashfree?action=connect      (user JWT)  validate + store App ID / Secret Key
 *   POST /api/cashfree?action=sync         (user JWT)  "Sync now" for the calling user
 *   POST /api/cashfree?action=disconnect   (user JWT)  revoke the active connection
 *   GET  /api/cashfree?action=status       (user JWT)  connection + freshness for the UI
 *   GET  /api/cashfree?action=cron         (CRON_SECRET) nightly sync across all connected users
 *
 * Zero-npm: plain fetch() only. CommonJS to match the rest of /api.
 *
 * AUTH MODEL — Cashfree PG uses header API keys (x-client-id / x-client-secret
 * + a pinned x-api-version), NOT Basic Auth and NOT OAuth for a merchant's own
 * account. (Cashfree Connect partner-OAuth exists only for platforms
 * onboarding sub-merchants — out of scope.) So this is manual key entry, stored
 * exactly like Razorpay's key_id / key_secret, plus an `environment` tag
 * because the API base URL differs sandbox vs production and the App ID does
 * not encode which it is.
 *
 * SECURITY: the Secret Key is never logged, never echoed in a response, never
 * put in a connector_logs error_message.
 */

const {
  getUserFromRequest,
  insertRows,
  updateRows,
  selectRows,
  logConnectorEvent
} = require('./_lib/supabaseRest');
const {
  syncCashfreeForUser,
  handleAuthFailure,
  CashfreeAuthError,
  baseUrl,
  authHeaders
} = require('./_lib/cashfreeSync');

function json(res, status, body) { res.status(status).json(body); }

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  }
  return b || {};
}

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET' && action === 'cron') return handleCron(req, res);
  if (req.method === 'GET' && (action === 'status' || action === '')) return handleStatus(req, res);
  if (req.method === 'POST' && action === 'connect') return handleConnect(req, res);
  if (req.method === 'POST' && action === 'sync') return handleSync(req, res);
  if (req.method === 'POST' && action === 'disconnect') return handleDisconnect(req, res);

  return json(res, 400, {
    error: 'unknown_action',
    message: 'Expected ?action= one of connect, sync, disconnect, status, cron.'
  });
};

/* ------------------------------------------------------------------ */
/* connect — POST ?action=connect                                     */
/* ------------------------------------------------------------------ */
async function handleConnect(req, res) {
  let user;
  try {
    user = await getUserFromRequest(req);
  } catch {
    return json(res, 500, { error: 'Authentication check failed' });
  }
  if (!user) return json(res, 401, { error: 'Not authenticated' });

  const body = parseBody(req);
  const clientId = String(body.clientId || body.appId || '').trim();
  const clientSecret = String(body.clientSecret || body.secretKey || '').trim();
  const environment = body.environment === 'production' ? 'production' : 'sandbox';

  if (!clientId || !clientSecret) {
    return json(res, 400, { error: 'App ID and Secret Key are both required' });
  }

  // Validate against Cashfree with a minimal settlements read.
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  let testCall;
  try {
    testCall = await fetch(`${baseUrl(environment)}/settlements`, {
      method: 'POST',
      headers: authHeaders(clientId, clientSecret),
      body: JSON.stringify({
        pagination: { limit: 1 },
        filters: { start_date: start.toISOString(), end_date: end.toISOString() }
      })
    });
  } catch {
    await logConnectorEvent({
      userId: user.id, connectorType: 'cashfree', operation: 'store_credentials',
      status: 'error', errorMessage: 'Network error validating credentials with Cashfree'
    });
    return json(res, 500, { error: 'Could not reach Cashfree. Try again in a moment.' });
  }

  if (testCall.status === 401 || testCall.status === 403) {
    return json(res, 401, { error: 'Invalid credentials' });
  }
  if (testCall.status !== 200) {
    await logConnectorEvent({
      userId: user.id, connectorType: 'cashfree', operation: 'store_credentials',
      status: 'error', errorMessage: `Cashfree validation call returned ${testCall.status}`
    });
    return json(res, 500, { error: 'Cashfree could not be reached right now. Try again shortly.' });
  }

  // Store. One active row per user+connector — retire any existing one first.
  try {
    const existing = await selectRows(
      'connector_credentials',
      `select=id&user_id=eq.${user.id}&connector_type=eq.cashfree&disconnected_at=is.null`
    );
    if (existing.length > 0) {
      await updateRows(
        'connector_credentials',
        `user_id=eq.${user.id}&connector_type=eq.cashfree&disconnected_at=is.null`,
        { disconnected_at: new Date().toISOString() }
      );
    }
    await insertRows('connector_credentials', [{
      user_id: user.id,
      connector_type: 'cashfree',
      key_id: clientId,
      key_secret: clientSecret,
      environment,
      created_at: new Date().toISOString()
    }]);
  } catch {
    await logConnectorEvent({
      userId: user.id, connectorType: 'cashfree', operation: 'store_credentials',
      status: 'error', errorMessage: 'Failed to persist credentials'
    });
    return json(res, 500, { error: 'Could not save credentials. Try again.' });
  }

  await logConnectorEvent({
    userId: user.id, connectorType: 'cashfree', operation: 'store_credentials',
    status: 'success', recordsSynced: 0
  });

  // Fire-and-forget first sync. If it fails, the nightly cron still picks the
  // user up — don't block the response.
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    if (host) {
      fetch(`${proto}://${host}/api/cashfree?action=sync`, {
        method: 'POST',
        headers: {
          Authorization: req.headers['authorization'],
          'Content-Type': 'application/json'
        }
      }).catch(() => {});
    }
  } catch { /* best effort */ }

  return json(res, 200, { status: 'connected', message: 'Cashfree connected', environment });
}

/* ------------------------------------------------------------------ */
/* sync — POST ?action=sync                                           */
/* ------------------------------------------------------------------ */
async function handleSync(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return json(res, 401, { error: 'Not authenticated' });

  try {
    const result = await syncCashfreeForUser(user.id);
    return json(res, result.status === 'error' ? 502 : 200, result);
  } catch (err) {
    if (err instanceof CashfreeAuthError) {
      await handleAuthFailure(user.id);
      return json(res, 401, { status: 'error', message: 'Cashfree connection needs to be re-authorized' });
    }
    return json(res, 500, { status: 'error', message: 'Sync failed unexpectedly' });
  }
}

/* ------------------------------------------------------------------ */
/* disconnect — POST ?action=disconnect                              */
/* ------------------------------------------------------------------ */
async function handleDisconnect(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return json(res, 401, { error: 'Not authenticated' });

  try {
    await updateRows(
      'connector_credentials',
      `user_id=eq.${user.id}&connector_type=eq.cashfree&disconnected_at=is.null`,
      { disconnected_at: new Date().toISOString(), needs_reauth: false }
    );
    await logConnectorEvent({
      userId: user.id, connectorType: 'cashfree', operation: 'disconnect', status: 'success'
    });
  } catch {
    return json(res, 500, { error: 'Could not disconnect. Try again.' });
  }
  return json(res, 200, { status: 'disconnected' });
}

/* ------------------------------------------------------------------ */
/* status — GET ?action=status                                        */
/* ------------------------------------------------------------------ */
async function handleStatus(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return json(res, 401, { error: 'Not authenticated' });

  try {
    const rows = await selectRows(
      'connector_credentials',
      `select=environment,needs_reauth,last_success_at,last_sync_status,created_at&user_id=eq.${user.id}&connector_type=eq.cashfree&disconnected_at=is.null&limit=1`
    );
    if (!rows.length) return json(res, 200, { connected: false });
    const r = rows[0];
    return json(res, 200, {
      connected: true,
      environment: r.environment || 'sandbox',
      needs_reauth: !!r.needs_reauth,
      last_success_at: r.last_success_at || null,
      last_sync_status: r.last_sync_status || null,
      connected_at: r.created_at || null
    });
  } catch {
    return json(res, 500, { error: 'Could not read connection status' });
  }
}

/* ------------------------------------------------------------------ */
/* cron — GET ?action=cron (Vercel Cron target)                       */
/* ------------------------------------------------------------------ */
async function handleCron(req, res) {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.cron_secret;
  const expected = process.env.CRON_SECRET;
  if (!expected) return json(res, 500, { error: 'CRON_SECRET not configured' });

  const authValid = authHeader === `Bearer ${expected}` || querySecret === expected;
  if (!authValid) return json(res, 401, { error: 'Unauthorized' });

  const startedAt = Date.now();
  let connections;
  try {
    connections = await selectRows(
      'connector_credentials',
      'select=user_id&connector_type=eq.cashfree&disconnected_at=is.null'
    );
  } catch {
    return json(res, 500, { error: 'Could not list connected users' });
  }

  const userIds = [...new Set(connections.map((c) => c.user_id))];
  let succeeded = 0;
  const failed = [];
  const deadline = Date.now() + 280000; // stay inside a 300s maxDuration

  for (const userId of userIds) {
    if (Date.now() > deadline) { failed.push({ userId, reason: 'time_budget_exhausted' }); continue; }
    try {
      const result = await syncCashfreeForUser(userId);
      if (result.status === 'error') failed.push({ userId, reason: result.message || 'sync error' });
      else succeeded++;
    } catch (err) {
      if (err instanceof CashfreeAuthError) {
        await handleAuthFailure(userId);
        failed.push({ userId, reason: 'needs re-authorization' });
      } else {
        failed.push({ userId, reason: err.message });
      }
    }
  }

  return json(res, 200, {
    users_synced: succeeded,
    failed: failed.length,
    failed_users: failed,
    total_users: userIds.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
}
