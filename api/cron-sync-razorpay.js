const { selectRows } = require('./_lib/supabaseRest');
const { syncRazorpayForUser, RazorpayAuthError } = require('./sync-razorpay');

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

module.exports = async (req, res) => {
  // Accept cron_secret as either Authorization header (from Vercel Cron) or query param (for manual testing)
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.cron_secret;
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
