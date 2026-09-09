/**
 * /api/sync-razorpay  — Razorpay connector router (dispatched by ?action=)
 *
 * Consolidated to stay under the Vercel Hobby 12-function cap: this one file
 * now covers what used to be three separate functions.
 *
 *   POST /api/sync-razorpay                 (user JWT)      "Sync now" for the caller
 *   POST /api/sync-razorpay?action=sync     (user JWT)      same, explicit
 *   POST /api/sync-razorpay?action=connect  (user JWT)      validate + store Key ID/Secret, kick first sync
 *                                                           (was POST /api/store-razorpay-credentials)
 *   GET  /api/sync-razorpay?action=cron     (CRON_SECRET)   nightly sync across all connected users
 *                                                           (was GET  /api/cron-sync-razorpay)
 *
 * Zero-npm: plain fetch() only, matching the rest of /api.
 */

const {
  restRequest,
  insertRows,
  updateRows,
  selectRows,
  getUserFromRequest,
  logConnectorEvent,
  setConnectorStatus
} = require('./_lib/supabaseRest');
const { track } = require('./_lib/track');
const { computePaymentsFromRazorpay } = require('./_lib/computePaymentsFromRazorpay');

const RAZORPAY_BASE = 'https://api.razorpay.com/v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap: 2,000 records per entity per sync window
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

class RazorpayAuthError extends Error {}

function toIso(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

function basicAuthHeader(keyId, keySecret) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

/** fetch() with 401/403 -> RazorpayAuthError, 429 -> exponential backoff retry. */
async function fetchRazorpay(url, keyId, keySecret) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: basicAuthHeader(keyId, keySecret) } });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      throw new Error(`Network error calling Razorpay: ${err.message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new RazorpayAuthError(`Razorpay auth failed (${res.status})`);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      continue;
    }

    if (!res.ok) {
      lastError = new Error(`Razorpay returned ${res.status}`);
      if (attempt < MAX_RETRIES && res.status >= 500) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    return res.json();
  }
  throw lastError || new Error('Razorpay request failed after retries');
}

/** Fetch every page of a Razorpay collection endpoint for [from, to]. */
async function fetchAllPages(entity, keyId, keySecret, from, to) {
  const items = [];
  let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${RAZORPAY_BASE}/${entity}?from=${from}&to=${to}&count=${PAGE_SIZE}&skip=${skip}`;
    const data = await fetchRazorpay(url, keyId, keySecret);
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return items;
}

function mapPayment(p, userId) {
  if (!p.id || !p.amount || !p.status) return null; // malformed, skip
  return {
    user_id: userId,
    payment_id: p.id,
    amount: p.amount,
    currency: p.currency || 'INR',
    status: p.status,
    fee: p.fee || 0,
    tax: p.tax || 0,
    method: p.method || null,
    customer_email: p.email || null,
    description: p.description || null,
    created_at: toIso(p.created_at),
    created_epoch: p.created_at,
    synced_at: new Date().toISOString()
  };
}

function mapSettlement(s, userId) {
  if (!s.id || !s.amount || !s.status) return null;
  return {
    user_id: userId,
    settlement_id: s.id,
    amount: s.amount,
    status: s.status,
    fee_deducted: s.fee_deducted || s.fees || 0,
    utr: s.utr || null,
    payout_id: s.payout_id || null,
    created_at: toIso(s.created_at),
    processed_at: s.processed_at ? toIso(s.processed_at) : null,
    created_epoch: s.created_at,
    synced_at: new Date().toISOString()
  };
}

function mapRefund(r, userId) {
  if (!r.id || !r.amount || !r.status || !r.payment_id) return null;
  return {
    user_id: userId,
    refund_id: r.id,
    payment_id: r.payment_id,
    amount: r.amount,
    status: r.status,
    reason: r.reason || 'unspecified',
    notes: r.notes && typeof r.notes === 'object' ? JSON.stringify(r.notes) : (r.notes || null),
    created_at: toIso(r.created_at),
    created_epoch: r.created_at,
    synced_at: new Date().toISOString()
  };
}

/** Upsert rows in a single batch, keyed on the entity's unique id column. */
async function upsertBatch(table, rows, conflictColumn) {
  if (rows.length === 0) return 0;
  await insertRows(table, rows, { onConflict: conflictColumn, merge: true });
  return rows.length;
}

async function getCredentials(userId) {
  const rows = await selectRows(
    'connector_credentials',
    `select=key_id,key_secret&user_id=eq.${userId}&connector_type=eq.razorpay&disconnected_at=is.null&limit=1`
  );
  return rows[0] || null;
}

/**
 * Core sync routine for a single user. Fetches the last 7 days of payments,
 * settlements, and refunds, upserts each independently (a failure in one
 * doesn't block the others — partial success is logged as such), and writes
 * one connector_logs row per operation.
 */
async function syncRazorpayForUser(userId) {
  const startedAt = Date.now();
  const creds = await getCredentials(userId);

  if (!creds) {
    await logConnectorEvent({
      userId,
      connectorType: 'razorpay',
      operation: 'sync_all',
      status: 'error',
      errorMessage: 'Razorpay not connected'
    });
    return { status: 'error', message: 'Razorpay not connected' };
  }

  const { key_id: keyId, key_secret: keySecret } = creds;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 7 * 24 * 60 * 60;

  const results = { payments: null, settlements: null, refunds: null };
  const errors = [];

  // Payments
  try {
    const opStart = Date.now();
    const raw = await fetchAllPages('payments', keyId, keySecret, from, to);
    const rows = raw.map((p) => mapPayment(p, userId)).filter(Boolean);
    const synced = await upsertBatch('razorpay_transactions', rows, 'payment_id');
    results.payments = synced;
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_payments',
      status: 'success', recordsSynced: synced, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof RazorpayAuthError) throw err; // stop everything, handled by caller
    errors.push(`payments: ${err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_payments',
      status: 'error', errorMessage: err.message
    });
  }

  // Settlements
  try {
    const opStart = Date.now();
    const raw = await fetchAllPages('settlements', keyId, keySecret, from, to);
    const rows = raw.map((s) => mapSettlement(s, userId)).filter(Boolean);
    const synced = await upsertBatch('razorpay_settlements', rows, 'settlement_id');
    results.settlements = synced;
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_settlements',
      status: 'success', recordsSynced: synced, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof RazorpayAuthError) throw err;
    errors.push(`settlements: ${err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_settlements',
      status: 'error', errorMessage: err.message
    });
  }

  // Refunds
  try {
    const opStart = Date.now();
    const raw = await fetchAllPages('refunds', keyId, keySecret, from, to);
    const rows = raw.map((r) => mapRefund(r, userId)).filter(Boolean);
    const synced = await upsertBatch('razorpay_refunds', rows, 'refund_id');
    results.refunds = synced;
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_refunds',
      status: 'success', recordsSynced: synced, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof RazorpayAuthError) throw err;
    errors.push(`refunds: ${err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'razorpay', operation: 'sync_refunds',
      status: 'error', errorMessage: err.message
    });
  }

  // Payments tab: write live-synced data onto the user's latest snapshot.
  // Source-priority rule — live always wins when it has anything to show:
  //   - transactions found in the window -> aggregate and overwrite
  //     payments_data/settlement_rows/settlement_daily_trend, tagged
  //     payments_source: 'razorpay_live'.
  //   - nothing synced in the window (not connected long enough, or a
  //     genuinely quiet period) -> leave payments_data untouched, so
  //     whatever manual/upload data (or an earlier live sync) is already
  //     there keeps showing rather than getting zeroed out.
  // If the user has no snapshot row at all yet, there's nowhere to write
  // this — the Payments tab only reads from snapshots[0], so live data
  // will start showing once their first snapshot exists (upload/manual
  // entry, or a future onboarding bootstrap snapshot).
  let paymentsWrite = 'skipped_no_transactions';
  try {
    const agg = await computePaymentsFromRazorpay(userId);
    if (agg) {
      const latestSnap = await selectRows(
        'snapshots',
        `select=id&user_id=eq.${userId}&order=created_at.desc&limit=1`
      );
      if (latestSnap.length) {
        await updateRows('snapshots', `id=eq.${latestSnap[0].id}`, {
          payments_data: agg.paymentsData,
          settlement_rows: agg.settlementRows,
          settlement_daily_trend: agg.settlementDailyTrend,
          payments_source: 'razorpay_live',
          payments_updated_at: new Date().toISOString()
        });
        paymentsWrite = 'updated';
      } else {
        // No snapshot to write onto yet (Razorpay connected before any
        // upload/manual entry). Park the aggregate with provenance instead
        // of dropping it silently — app.html replays it onto the first
        // snapshot that appears. See connector_pending_data
        // (2026-09-04-provenance-connector-status.sql).
        try {
          // Keep a single unresolved row per user — refresh it in place if
          // one already exists, otherwise insert.
          const refreshed = await updateRows(
            'connector_pending_data',
            `user_id=eq.${userId}&connector_type=eq.razorpay&kind=eq.payments_aggregate&resolved_at=is.null`,
            { payload: agg, fetched_at: new Date().toISOString() }
          );
          if (!Array.isArray(refreshed) || refreshed.length === 0) {
            await insertRows('connector_pending_data', [{
              user_id: userId,
              connector_type: 'razorpay',
              kind: 'payments_aggregate',
              payload: agg,
              reason: 'no_snapshot_yet',
              fetched_at: new Date().toISOString()
            }]);
          }
          paymentsWrite = 'parked_no_snapshot';
        } catch (e) {
          errors.push(`pending payments park: ${e.message}`);
          paymentsWrite = 'skipped_no_snapshot';
        }
      }
    }
  } catch (err) {
    errors.push(`payments_data write: ${err.message}`);
    paymentsWrite = 'error';
  }

  const totalSynced = (results.payments || 0) + (results.settlements || 0) + (results.refunds || 0);
  const durationMs = Date.now() - startedAt;

  const syncStatus = errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error');

  await logConnectorEvent({
    userId,
    connectorType: 'razorpay',
    operation: 'sync_all',
    status: syncStatus,
    errorMessage: errors.length ? errors.join('; ') : null,
    recordsSynced: totalSynced,
    syncDurationMs: durationMs
  });

  // Durable connector status (2026-09-04-provenance-connector-status.sql).
  // A sync that got this far did not hit an auth error, so clear needs_reauth
  // and record freshness. A RazorpayAuthError would have thrown before here.
  await setConnectorStatus(userId, 'razorpay', {
    needsReauth: false,
    lastSyncStatus: syncStatus,
    lastErrorCode: errors.length ? 'partial_sync' : null,
    ...(syncStatus !== 'error' ? { lastSuccessAt: new Date().toISOString() } : {})
  });

  return {
    status: errors.length === 0 ? 'success' : 'partial',
    records_synced: totalSynced,
    breakdown: results,
    payments_tab: paymentsWrite,
    errors: errors.length ? errors : undefined,
    duration_ms: durationMs
  };
}

/**
 * Handle a Razorpay auth failure at the top level: flag the credentials so
 * the UI can prompt a reconnect, and log it.
 *
 * Writes both: the durable `connector_credentials.needs_reauth` column
 * (added by 2026-09-04-provenance-connector-status.sql — this is what the
 * Connectors UI and the AI context read) and a connector_logs line for the
 * event history.
 */
async function handleAuthFailure(userId) {
  await setConnectorStatus(userId, 'razorpay', {
    needsReauth: true,
    lastSyncStatus: 'error',
    lastErrorCode: 'auth_failed',
    lastErrorAt: new Date().toISOString()
  });
  await logConnectorEvent({
    userId,
    connectorType: 'razorpay',
    operation: 'sync_all',
    status: 'error',
    errorMessage: 'needs_reauth'
  });
}

/* ------------------------------------------------------------------ */
/* sync — POST (default) or POST ?action=sync                          */
/* ------------------------------------------------------------------ */
async function handleSync(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const result = await syncRazorpayForUser(user.id);
    if (result.status !== 'error') {
      track(user.id, 'connector_sync_manual', { connector: 'razorpay' }); // ops console
    }
    res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) {
    if (err instanceof RazorpayAuthError) {
      await handleAuthFailure(user.id);
      res.status(401).json({ status: 'error', message: 'Razorpay connection needs to be re-authorized' });
      return;
    }
    res.status(500).json({ status: 'error', message: 'Sync failed unexpectedly' });
  }
}

/* ------------------------------------------------------------------ */
/* connect — POST ?action=connect  (was /api/store-razorpay-credentials) */
/*                                                                    */
/* SECURITY: keySecret is never logged, never echoed back in a        */
/* response, never included in a connector_logs error_message.        */
/* ------------------------------------------------------------------ */
async function handleConnect(req, res) {
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

  // Validate credentials against Razorpay with a minimal read call
  let testCall;
  try {
    testCall = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: basicAuthHeader(keyId, keySecret) }
    });
  } catch (err) {
    await logConnectorEvent({
      userId: user.id, connectorType: 'razorpay', operation: 'store_credentials',
      status: 'error', errorMessage: 'Network error validating credentials with Razorpay'
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
      userId: user.id, connectorType: 'razorpay', operation: 'store_credentials',
      status: 'error', errorMessage: `Razorpay validation call returned ${testCall.status}`
    });
    res.status(500).json({ error: 'Razorpay could not be reached right now. Try again shortly.' });
    return;
  }

  // Store — one active row per user+connector; retire any existing one first.
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
    await logConnectorEvent({
      userId: user.id, connectorType: 'razorpay', operation: 'store_credentials',
      status: 'error', errorMessage: 'Failed to persist credentials'
    });
    res.status(500).json({ error: 'Could not save credentials. Try again.' });
    return;
  }

  await logConnectorEvent({
    userId: user.id, connectorType: 'razorpay', operation: 'store_credentials',
    status: 'success', recordsSynced: 0
  });

  // Fire-and-forget first sync (fresh invocation so the response isn't blocked).
  // If it fails, the nightly cron still picks the user up.
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
  } catch { /* best-effort only */ }

  res.status(200).json({ status: 'connected', message: 'Razorpay connected' });
}

/* ------------------------------------------------------------------ */
/* cron — GET ?action=cron  (was /api/cron-sync-razorpay)              */
/* ------------------------------------------------------------------ */
async function notifyFailures(failed) {
  const webhook = process.env.ALERT_EMAIL_WEBHOOK;
  const to = process.env.ALERT_EMAIL_TO || 'varadpandey98@gmail.com';
  if (!webhook || failed.length === 0) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        subject: `Razorpay sync failures: ${failed.length} user(s)`,
        text: `The nightly Razorpay sync failed for ${failed.length} user(s):\n\n` +
          failed.map((f) => `- ${f.userId}: ${f.reason}`).join('\n')
      })
    });
  } catch (err) {
    console.error('Failed to send alert email:', err.message);
  }
}

async function handleCron(req, res) {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.cron_secret;
  const expected = process.env.CRON_SECRET;
  if (!expected) { res.status(500).json({ error: 'CRON_SECRET not configured' }); return; }

  const authValid = authHeader === `Bearer ${expected}` || querySecret === expected;
  if (!authValid) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const startedAt = Date.now();
  let connections;
  try {
    connections = await selectRows(
      'connector_credentials',
      'select=user_id&connector_type=eq.razorpay&disconnected_at=is.null'
    );
  } catch (err) {
    res.status(500).json({ error: 'Could not list connected users' });
    return;
  }

  const userIds = [...new Set(connections.map((c) => c.user_id))];
  let succeeded = 0;
  const failed = [];

  for (const userId of userIds) {
    try {
      const result = await syncRazorpayForUser(userId);
      if (result.status === 'error') failed.push({ userId, reason: result.message || 'sync error' });
      else succeeded++;
    } catch (err) {
      if (err instanceof RazorpayAuthError) {
        await handleAuthFailure(userId);
        failed.push({ userId, reason: 'needs re-authorization' });
      } else {
        failed.push({ userId, reason: err.message });
      }
    }
  }

  await notifyFailures(failed);

  res.status(200).json({
    users_synced: succeeded,
    failed: failed.length,
    failed_users: failed,
    total_users: userIds.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
}

/* ------------------------------------------------------------------ */
/* dispatcher                                                          */
/* ------------------------------------------------------------------ */
module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET' && action === 'cron') return handleCron(req, res);
  if (req.method === 'POST' && action === 'connect') return handleConnect(req, res);
  if (req.method === 'POST' && (action === '' || action === 'sync')) return handleSync(req, res);

  res.status(400).json({
    error: 'Expected POST (sync), POST ?action=connect, or GET ?action=cron'
  });
};

module.exports.syncRazorpayForUser = syncRazorpayForUser;
module.exports.RazorpayAuthError = RazorpayAuthError;
