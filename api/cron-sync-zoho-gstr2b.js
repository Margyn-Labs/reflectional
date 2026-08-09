/**
 * GET /api/cron-sync-zoho-gstr2b  (Vercel Cron)
 *
 * Weekly GSTR-2B reconciliation sync across every active org.
 * Schedule: "30 21 * * 6" UTC = Sunday 03:00 IST.
 *   (Saturday 21:30 UTC + 5:30 = Sunday 03:00 IST — day-of-week 6 is
 *    correct here precisely because IST is ahead of UTC. Setting this to
 *    "* * 0" would run it a full day late.)
 *
 * Weekly cadence matches the underlying GSTR-2B refresh cycle. Syncing
 * daily would consume the org's API budget for data that cannot have moved.
 */

const { selectRows } = require('./_lib/supabaseRest');
const { syncGstr2bForUser } = require('./sync-zoho-gstr2b');
const { ZohoAuthError, markNeedsReauth } = require('./_lib/zohoClient');

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
        subject: `Zoho GSTR-2B sync failures: ${failed.length} org(s)`,
        text: `The weekly GSTR-2B sync failed for ${failed.length} org(s):\n\n` +
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
    orgs = await selectRows('zoho_organizations', 'select=id,user_id&status=eq.active');
  } catch (err) {
    res.status(500).json({ error: 'Could not list connected organizations' });
    return;
  }

  const userIds = [...new Set(orgs.map((o) => o.user_id))];
  let succeeded = 0;
  let unavailable = 0;
  let totalRows = 0;
  const failed = [];

  for (const userId of userIds) {
    try {
      const result = await syncGstr2bForUser(userId);
      totalRows += result.records_synced || 0;
      if (result.module_unavailable) unavailable++;
      if (result.status === 'error') {
        failed.push({ userId, reason: (result.errors || []).join('; ') || 'gstr2b sync error' });
      } else {
        succeeded++;
      }
    } catch (err) {
      if (err instanceof ZohoAuthError) {
        const row = orgs.find((o) => o.user_id === userId);
        if (row) await markNeedsReauth(row.id);
        failed.push({ userId, reason: 'needs re-authorization' });
      } else {
        failed.push({ userId, reason: err.message });
      }
    }
  }

  await notifyFailures(failed);

  res.status(200).json({
    orgs_synced: succeeded,
    module_unavailable: unavailable,
    records_synced: totalRows,
    failed: failed.length,
    failed_users: failed,
    total_orgs: userIds.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
};
