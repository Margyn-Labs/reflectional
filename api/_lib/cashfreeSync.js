/**
 * api/_lib/cashfreeSync.js
 *
 * Core Cashfree Payments sync — the Cashfree analogue of api/sync-razorpay.js's
 * syncRazorpayForUser(). Underscore-prefixed folder so Vercel does not route it;
 * imported by api/cashfree.js for both the "Sync now" action and the cron.
 *
 * Zero-npm: plain fetch() only.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA MODEL DIFFERS FROM RAZORPAY
 * ---------------------------------------------------------------------------
 * Razorpay exposes GET /v1/payments?from=&to= — a flat "list every payment"
 * feed. Cashfree's PG API has NO such endpoint. The only bulk, date-ranged,
 * transaction-level feed Cashfree gives a merchant is the SETTLEMENT RECON
 * endpoint (POST /pg/settlements/recon), which returns one row per payment /
 * refund / adjustment that has rolled into a settlement.
 *
 * Consequence: everything cashfreeSync ingests is money that HAS SETTLED (or is
 * in a known settlement). Captured-but-unsettled payments (the T+1/T+2 gateway
 * float) are not individually visible here yet — that is a deliberate v1 gap,
 * documented in the connector notes. For Margyn's purpose this is arguably the
 * better feed: it is the reconciled, bank-UTR-backed view, not gross authorised.
 *
 * PROVENANCE (THE ONE RULE): every row is stamped source='cashfree',
 * verification_status='signal'. Cashfree operates settlement/UTR data
 * independently of the merchant's books, so it corroborates an independent
 * source (bank statement via AA, or a books entry) — but on its own it is a
 * single self-selected feed and is never auto-trusted. No vitals / Pulse Score
 * math happens in this file.
 */

const {
  insertRows,
  updateRows,
  selectRows,
  logConnectorEvent,
  setConnectorStatus
} = require('./supabaseRest');
const { computePaymentsFromCashfree } = require('./computePaymentsFromCashfree');

const API_VERSION = '2023-08-01';
const PAGE_SIZE = 100;
const MAX_PAGES = 25;            // safety cap: 2,500 rows per feed per window
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const WINDOW_DAYS = 30;          // "this sync" lookback — settlements lag, so wider than Razorpay's 7d

class CashfreeAuthError extends Error {}

function baseUrl(environment) {
  return environment === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function authHeaders(clientId, clientSecret) {
  return {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': API_VERSION,
    'Content-Type': 'application/json'
  };
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** POST helper: 401/403 -> CashfreeAuthError, 429/5xx -> exponential backoff. */
async function cfPost(url, headers, body) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) { await sleep(BACKOFF_MS[attempt]); continue; }
      throw new Error(`Network error calling Cashfree: ${err.message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new CashfreeAuthError(`Cashfree auth failed (${res.status})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cashfree returned ${res.status}: ${String(text).slice(0, 180)}`);
    }
    return res.json();
  }
  throw lastError || new Error('Cashfree request failed after retries');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Cursor-paginate a Cashfree collection endpoint. Cashfree returns
 * { data: [...], cursor: "<next>" | null }. Some API versions nest the cursor
 * under pagination — tolerate both.
 */
async function fetchAllPages(url, headers, filters) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pagination = { limit: PAGE_SIZE };
    if (cursor) pagination.cursor = cursor;
    const data = await cfPost(url, headers, { pagination, filters });
    const batch = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    items.push(...batch);
    cursor = data.cursor || (data.pagination && data.pagination.cursor) || null;
    if (!cursor || batch.length < PAGE_SIZE) break;
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* row mappers                                                        */
/* ------------------------------------------------------------------ */

// A recon row can describe a sale, a refund, or an adjustment. Cashfree has
// used both `sale_type` and `event_type` across versions; check both.
function reconKind(r) {
  const t = String(r.event_type || r.sale_type || r.type || '').toUpperCase();
  if (t.includes('REFUND')) return 'REFUND';
  if (t.includes('ADJUST') || t.includes('CHARGEBACK') || t.includes('DISPUTE')) return 'ADJUSTMENT';
  return 'SETTLEMENT';
}

function mapReconTransaction(r, userId) {
  const cfPaymentId = r.cf_payment_id || r.payment_id || r.cf_transaction_id;
  if (!cfPaymentId) return null;
  const gross = num(r.payment_amount != null ? r.payment_amount : r.amount);
  if (!gross) return null;
  const fee = num(r.service_charge != null ? r.service_charge : r.commission);
  const feeGst = num(r.service_tax != null ? r.service_tax : r.gst);
  const net = r.settlement_amount != null ? num(r.settlement_amount) : (gross - fee - feeGst);
  return {
    user_id: userId,
    cf_payment_id: String(cfPaymentId),
    order_id: r.order_id ? String(r.order_id) : null,
    amount: gross,
    currency: r.payment_currency || r.currency || 'INR',
    payment_method: (r.payment_group || r.payment_method || r.payment_mode || null),
    fee,
    fee_gst: feeGst,
    net_amount: net,
    settlement_utr: r.settlement_utr || r.utr || null,
    event_type: 'SETTLEMENT',
    payment_time: toIso(r.payment_time || r.payment_completion_time || r.event_time || r.txn_time),
    settled_at: toIso(r.settlement_time || r.settled_on || r.event_time),
    source: 'cashfree',
    verification_status: 'signal',
    synced_at: new Date().toISOString(),
    raw: r
  };
}

function mapReconRefund(r, userId) {
  const cfRefundId = r.cf_refund_id || r.refund_id;
  if (!cfRefundId) return null;
  return {
    user_id: userId,
    cf_refund_id: String(cfRefundId),
    cf_payment_id: r.cf_payment_id ? String(r.cf_payment_id) : null,
    order_id: r.order_id ? String(r.order_id) : null,
    amount: num(r.refund_amount != null ? r.refund_amount : r.amount),
    currency: r.refund_currency || r.currency || 'INR',
    status: r.refund_status || r.status || null,
    settlement_utr: r.settlement_utr || r.utr || null,
    refund_time: toIso(r.refund_time || r.processed_at || r.event_time),
    source: 'cashfree',
    verification_status: 'signal',
    synced_at: new Date().toISOString(),
    raw: r
  };
}

function mapSettlement(s, userId) {
  const settlementId = s.settlement_id || s.cf_settlement_id || s.id;
  if (!settlementId) return null;
  return {
    user_id: userId,
    settlement_id: String(settlementId),
    utr: s.utr || s.settlement_utr || null,
    amount_settled: num(s.amount_settled != null ? s.amount_settled : s.settlement_amount),
    amount_adjusted: num(s.amount_adjusted != null ? s.amount_adjusted : s.adjustment),
    status: s.status || s.settlement_status || null,
    payment_from: toIso(s.payment_from || s.from || s.start_date),
    payment_till: toIso(s.payment_till || s.till || s.end_date),
    settled_on: toIso(s.settled_on || s.settlement_time || s.processed_at || s.settlement_date),
    source: 'cashfree',
    verification_status: 'signal',
    synced_at: new Date().toISOString(),
    raw: s
  };
}

/* ------------------------------------------------------------------ */
/* main sync                                                          */
/* ------------------------------------------------------------------ */

async function getCredentials(userId) {
  const rows = await selectRows(
    'connector_credentials',
    `select=key_id,key_secret,environment&user_id=eq.${userId}&connector_type=eq.cashfree&disconnected_at=is.null&limit=1`
  );
  return rows[0] || null;
}

async function upsertBatch(table, rows, conflictColumn) {
  if (rows.length === 0) return 0;
  await insertRows(table, rows, { onConflict: conflictColumn, merge: true });
  return rows.length;
}

/**
 * Sync one user. Pulls the last WINDOW_DAYS of settlements + settlement-recon
 * rows, splits recon rows into transactions vs refunds, upserts each feed
 * independently (a failure in one does not block the others), writes one
 * connector_logs row per operation, then aggregates into the Payments tab.
 */
async function syncCashfreeForUser(userId) {
  const startedAt = Date.now();
  const creds = await getCredentials(userId);
  if (!creds) {
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_all',
      status: 'error', errorMessage: 'Cashfree not connected'
    });
    return { status: 'error', message: 'Cashfree not connected' };
  }

  const clientId = creds.key_id;
  const clientSecret = creds.key_secret;
  const environment = creds.environment === 'production' ? 'production' : 'sandbox';
  const headers = authHeaders(clientId, clientSecret);
  const root = baseUrl(environment);

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const filters = { start_date: start.toISOString(), end_date: end.toISOString() };

  const results = { transactions: null, refunds: null, settlements: null };
  const errors = [];

  // --- Settlement batches -------------------------------------------------
  try {
    const opStart = Date.now();
    const raw = await fetchAllPages(`${root}/settlements`, headers, filters);
    const rows = raw.map((s) => mapSettlement(s, userId)).filter(Boolean);
    results.settlements = await upsertBatch('cashfree_settlements', rows, 'user_id,settlement_id');
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_settlements',
      status: 'success', recordsSynced: results.settlements, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof CashfreeAuthError) throw err;
    errors.push(`settlements: ${err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_settlements',
      status: 'error', errorMessage: err.message
    });
  }

  // --- Settlement recon -> transactions + refunds -----------------------
  try {
    const opStart = Date.now();
    const raw = await fetchAllPages(`${root}/settlements/recon`, headers, filters);

    const txnRows = [];
    const refundRows = [];
    for (const r of raw) {
      const kind = reconKind(r);
      if (kind === 'REFUND') {
        const m = mapReconRefund(r, userId);
        if (m) refundRows.push(m);
      } else if (kind === 'SETTLEMENT') {
        const m = mapReconTransaction(r, userId);
        if (m) txnRows.push(m);
      }
      // ADJUSTMENT rows (chargebacks/disputes) are kept in the raw payload of
      // the settlement they belong to but not surfaced as their own entity in
      // v1 — documented gap.
    }

    results.transactions = await upsertBatch('cashfree_transactions', txnRows, 'user_id,cf_payment_id');
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_transactions',
      status: 'success', recordsSynced: results.transactions, syncDurationMs: Date.now() - opStart
    });

    results.refunds = await upsertBatch('cashfree_refunds', refundRows, 'user_id,cf_refund_id');
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_refunds',
      status: 'success', recordsSynced: results.refunds
    });
  } catch (err) {
    if (err instanceof CashfreeAuthError) throw err;
    errors.push(`recon: ${err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'cashfree', operation: 'sync_transactions',
      status: 'error', errorMessage: err.message
    });
  }

  // --- Payments tab aggregate -----------------------------------------
  // Source-priority rule for v1:
  //   Razorpay stays the primary gateway for the Payments tab. If the user
  //   also has Razorpay connected, Cashfree does NOT overwrite payments_data
  //   (the nightly Razorpay sync owns it) — Cashfree's normalised tables and
  //   'cashfree_live' provenance are still written, they just don't claim the
  //   single payments_data slot. If Cashfree is the ONLY gateway, it writes
  //   payments_data tagged payments_source='cashfree_live', exactly like
  //   Razorpay does.
  //   OPEN QUESTION for margyn-fin-guy: a merchant on BOTH gateways should
  //   have payments_data = Razorpay + Cashfree combined, not either-or.
  let paymentsWrite = 'skipped_no_transactions';
  try {
    const rzp = await selectRows(
      'connector_credentials',
      `select=id&user_id=eq.${userId}&connector_type=eq.razorpay&disconnected_at=is.null&limit=1`
    );
    const razorpayConnected = rzp.length > 0;

    const agg = await computePaymentsFromCashfree(userId);
    if (!agg) {
      paymentsWrite = 'skipped_no_transactions';
    } else if (razorpayConnected) {
      paymentsWrite = 'skipped_razorpay_primary';
    } else {
      const latestSnap = await selectRows(
        'snapshots',
        `select=id&user_id=eq.${userId}&order=created_at.desc&limit=1`
      );
      if (latestSnap.length) {
        await updateRows('snapshots', `id=eq.${latestSnap[0].id}`, {
          payments_data: agg.paymentsData,
          settlement_rows: agg.settlementRows,
          settlement_daily_trend: agg.settlementDailyTrend,
          payments_source: 'cashfree_live',
          payments_updated_at: new Date().toISOString()
        });
        paymentsWrite = 'updated';
      } else {
        try {
          const refreshed = await updateRows(
            'connector_pending_data',
            `user_id=eq.${userId}&connector_type=eq.cashfree&kind=eq.payments_aggregate&resolved_at=is.null`,
            { payload: agg, fetched_at: new Date().toISOString() }
          );
          if (!Array.isArray(refreshed) || refreshed.length === 0) {
            await insertRows('connector_pending_data', [{
              user_id: userId,
              connector_type: 'cashfree',
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

  const totalSynced =
    (results.transactions || 0) + (results.settlements || 0) + (results.refunds || 0);
  const durationMs = Date.now() - startedAt;
  const syncStatus = errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error');

  await logConnectorEvent({
    userId, connectorType: 'cashfree', operation: 'sync_all',
    status: syncStatus,
    errorMessage: errors.length ? errors.join('; ') : null,
    recordsSynced: totalSynced, syncDurationMs: durationMs
  });

  await setConnectorStatus(userId, 'cashfree', {
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
    environment,
    errors: errors.length ? errors : undefined,
    duration_ms: durationMs
  };
}

async function handleAuthFailure(userId) {
  await setConnectorStatus(userId, 'cashfree', {
    needsReauth: true,
    lastSyncStatus: 'error',
    lastErrorCode: 'auth_failed',
    lastErrorAt: new Date().toISOString()
  });
  await logConnectorEvent({
    userId, connectorType: 'cashfree', operation: 'sync_all',
    status: 'error', errorMessage: 'needs_reauth'
  });
}

module.exports = {
  syncCashfreeForUser,
  handleAuthFailure,
  CashfreeAuthError,
  baseUrl,
  authHeaders,
  API_VERSION,
  WINDOW_DAYS
};
