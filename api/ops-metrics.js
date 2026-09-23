/**
 * api/ops-metrics.js — the nightly ops_metrics aggregator.
 *
 * Takes the function slot freed by folding Cashfree into api/sync-razorpay.js.
 *
 *   GET /api/ops-metrics?action=cron  (CRON_SECRET)  recompute every account
 *
 * WHY THIS IS ITS OWN FUNCTION AND NOT AN ACTION ON api/ops.js
 * ------------------------------------------------------------
 * These two pieces of code are supposed to hold different credentials, and
 * putting them in one file makes that easy to lose by accident.
 *
 *   - This writer runs with SUPABASE_SERVICE_ROLE_KEY. It must, because
 *     compute_ops_metrics() reads every raw account table to produce its
 *     aggregates.
 *   - api/ops.js — the console the founder actually looks at — should read as
 *     `ops_reader`, a Postgres role granted SELECT on ops_metrics and nothing
 *     else (2026-09-21-ops-metrics.sql).
 *
 * The separation is the product claim. "Margyn cannot see your numbers" is
 * only true if the console physically cannot issue the query, and that stops
 * being true the moment the console shares a credential with this file.
 *
 * All the aggregation logic lives in Postgres, deliberately: one auditable
 * function you can read top to bottom to confirm no amount ever reaches
 * ops_metrics, instead of that guarantee being spread across Node.
 *
 * Zero-npm: plain fetch() only, matching the rest of /api.
 */

const { SUPABASE_URL } = require('./_lib/supabaseRest');

function json(res, status, body) { res.status(status).json(body); }

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  if (req.method !== 'GET' || (action !== 'cron' && action !== '')) {
    return json(res, 400, {
      error: 'unknown_action',
      message: 'Expected GET ?action=cron.'
    });
  }

  const expected = process.env.CRON_SECRET;
  if (!expected) return json(res, 500, { error: 'CRON_SECRET not configured' });

  const authValid =
    req.headers['authorization'] === `Bearer ${expected}` ||
    req.query.cron_secret === expected;
  if (!authValid) return json(res, 401, { error: 'Unauthorized' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json(res, 500, { error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/compute_ops_metrics`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      // Default argument means "today, UTC". Pass target_date to backfill.
      body: JSON.stringify(
        req.query.date ? { target_date: String(req.query.date) } : {}
      )
    });
  } catch (err) {
    return json(res, 502, {
      status: 'error',
      message: `Could not reach Supabase: ${err.message}`
    });
  }

  if (!response.ok) {
    // The body can carry Postgres detail (a renamed column, a missing table).
    // Surface it — this job failing silently is how the console goes stale
    // without anyone noticing.
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    return json(res, 502, {
      status: 'error',
      message: `compute_ops_metrics failed (${response.status})`,
      detail: detail.slice(0, 500)
    });
  }

  let accounts = null;
  try { accounts = await response.json(); } catch { /* RPC returns a bare int */ }

  return json(res, 200, {
    status: 'ok',
    accounts_computed: accounts,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
};
