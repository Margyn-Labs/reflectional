/**
 * POST /api/sync-razorpay
 *
 * Pulls the last 7 days of payments, settlements, and refunds from Razorpay
 * for one user and upserts them into Supabase. Called two ways:
 *   1. Directly by the client (Authorization: Bearer <user JWT>) — the
 *      "Sync Now" button, and the auto-trigger right after connecting.
 *   2. Internally by api/cron-sync-razorpay.js, which imports
 *      `syncRazorpayForUser` directly and loops over every connected user.
 *
 * Zero-npm: plain fetch() only, matching the rest of /api.
 */

const {
  restRequest,
  insertRows,
  selectRows,
  getUserFromRequest,
  logConnectorEvent
} = require('./_lib/supabaseRest');

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

  const totalSynced = (results.payments || 0) + (results.settlements || 0) + (results.refunds || 0);
  const durationMs = Date.now() - startedAt;

  await logConnectorEvent({
    userId,
    connectorType: 'razorpay',
    operation: 'sync_all',
    status: errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error'),
    errorMessage: errors.length ? errors.join('; ') : null,
    recordsSynced: totalSynced,
    syncDurationMs: durationMs
  });

  return {
    status: errors.length === 0 ? 'success' : 'partial',
    records_synced: totalSynced,
    breakdown: results,
    errors: errors.length ? errors : undefined,
    duration_ms: durationMs
  };
}

/**
 * Handle a Razorpay auth failure at the top level: flag the credentials so
 * the UI can prompt a reconnect, and log it.
 *
 * NOTE: connector_credentials doesn't yet have a dedicated `needs_reauth`
 * flag column. As a stopgap this only writes to connector_logs (status:
 * 'error', error_message: 'needs_reauth') — the Settings page should treat
 * "most recent sync_all log is needs_reauth" as the reconnect trigger. A
 * follow-up migration should add `needs_reauth BOOLEAN DEFAULT false` to
 * connector_credentials and set it here directly instead.
 */
async function handleAuthFailure(userId) {
  await logConnectorEvent({
    userId,
    connectorType: 'razorpay',
    operation: 'sync_all',
    status: 'error',
    errorMessage: 'needs_reauth'
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const result = await syncRazorpayForUser(user.id);
    res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) {
    if (err instanceof RazorpayAuthError) {
      await handleAuthFailure(user.id);
      res.status(401).json({ status: 'error', message: 'Razorpay connection needs to be re-authorized' });
      return;
    }
    res.status(500).json({ status: 'error', message: 'Sync failed unexpectedly' });
  }
};

module.exports.syncRazorpayForUser = syncRazorpayForUser;
module.exports.RazorpayAuthError = RazorpayAuthError;
