/**
 * GET /api/cron-sync-razorpay
 *
 * Triggered by Vercel Cron at 0 2 * * * (2 AM UTC — see note in vercel.json
 * about IST offset). Loops over every user with an active Razorpay
 * connection and runs a sync for each, sequentially (not parallel, to stay
 * well under Razorpay's 100 req/min rate limit across concurrent users).
 *
 * Vercel Cron requests are authenticated by comparing the incoming
 * Authorization header to the CRON_SECRET env var — Vercel automatically
 * sends `Authorization: Bearer <CRON_SECRET>` on cron-triggered invocations
 * when that env var is set. Reject anything else so this endpoint can't be
 * used to trigger mass syncs from outside.
 */

const { selectRows } = require('./_lib/supabaseRest');
const { syncRazorpayForUser, RazorpayAuthError } = require('./sync-razorpay');

async function notifyFailures(failed) {
  // Best-effort alert to VP. Wire up a transactional email provider (Resend,
  // Postmark, etc.) by setting ALERT_EMAIL_WEBHOOK + ALERT_EMAIL_TO. No-ops
  // silently if not configured, so a missing env var never breaks the cron.
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

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && authHeader !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

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

  // De-dupe in case a user somehow has more than one active row.
  const userIds = [...new Set(connections.map((c) => c.user_id))];

  let succeeded = 0;
  let failed = [];

  for (const userId of userIds) {
    try {
      const result = await syncRazorpayForUser(userId);
      if (result.status === 'error') {
        failed.push({ userId, reason: result.message || 'sync error' });
      } else {
        succeeded++;
      }
    } catch (err) {
      if (err instanceof RazorpayAuthError) {
        failed.push({ userId, reason: 'needs re-authorization' });
      } else {
        failed.push({ userId, reason: err.message });
      }
    }
  }

  await notifyFailures(failed);

  const summary = {
    users_synced: succeeded,
    failed: failed.length,
    failed_users: failed,
    total_users: userIds.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  };

  res.status(200).json(summary);
};
