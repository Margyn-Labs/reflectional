/**
 * GET /api/cron-sync-zoho  (Vercel Cron)
 *
 * Nightly delta sync across every active Zoho Books organization.
 * Schedule: "0 21 * * *" UTC = 02:30 IST — inside the same 2-3 AM IST
 * window as the Razorpay cron, staggered 30 minutes after it so the two
 * connectors don't contend.
 *
 * Same auth pattern as cron-sync-razorpay.js: CRON_SECRET as either an
 * Authorization header (Vercel Cron) or a ?cron_secret= query param
 * (manual testing).
 *
 * Orgs are synced sequentially. Zoho's rate limit is per-organization, but
 * running them one at a time keeps the function's own memory and socket
 * usage predictable and makes partial failures easy to attribute.
 */

const { selectRows } = require('./_lib/supabaseRest');
const { syncZohoForUser, handleAuthFailure } = require('./sync-zoho');
const { ZohoAuthError } = require('./_lib/zohoClient');

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
        subject: `Zoho Books sync failures: ${failed.length} org(s)`,
        text: `The nightly Zoho Books sync failed for ${failed.length} org(s):\n\n` +
          failed.map((f) => `- user ${f.userId}: ${f.reason}`).join('\n')
      })
    });
  } catch (err) {
    console.error('Failed to send alert email:', err.message);
  }
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query && req.query.cron_secret;
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET not configured' });
    return;
  }

  const authValid = authHeader === `Bearer ${expected}` || querySecret === expected;
  if (!authValid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();

  let orgs;
  try {
    orgs = await selectRows(
      'zoho_organizations',
      'select=user_id,organization_id&status=eq.active'
    );
  } catch (err) {
    res.status(500).json({ error: 'Could not list connected organizations' });
    return;
  }

  const userIds = [...new Set(orgs.map((o) => o.user_id))];
  let succeeded = 0;
  let partial = 0;
  const failed = [];

  for (const userId of userIds) {
    try {
      const result = await syncZohoForUser(userId, 'delta');
      if (result.status === 'error') {
        failed.push({ userId, reason: result.message || 'sync error' });
      } else if (result.status === 'partial') {
        partial++;
        failed.push({ userId, reason: (result.errors || []).join('; ') || 'partial sync' });
      } else {
        succeeded++;
      }
    } catch (err) {
      if (err instanceof ZohoAuthError) {
        // Marks the org needs_reauth so the UI can prompt a reconnect.
        // Deliberately NOT retried — re-consent burns one of the 20
        // refresh tokens Zoho allows per user account.
        await handleAuthFailure(userId);
        failed.push({ userId, reason: 'needs re-authorization' });
      } else {
        failed.push({ userId, reason: err.message });
      }
    }
  }

  await notifyFailures(failed);

  res.status(200).json({
    orgs_synced: succeeded,
    partial,
    failed: failed.length,
    failed_users: failed,
    total_orgs: userIds.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
};
