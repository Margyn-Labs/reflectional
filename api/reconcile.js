/**
 * POST /api/reconcile?action=run          — reconcile one user (JWT-authed) or all users (cron)
 * POST /api/reconcile?action=resolve       — manually resolve a pending_review row (JWT-authed)
 *
 * Wraps the pure matching logic in api/_lib/reconcileMatcher.js with real
 * Supabase reads/writes. Zero-npm: plain fetch() only, matching the rest
 * of /api. See reconcileMatcher.js for the matching rules themselves.
 */

const {
  selectRows,
  insertRows,
  updateRows,
  getUserFromRequest,
  logConnectorEvent
} = require('./_lib/supabaseRest');
const { matchPayments } = require('./_lib/reconcileMatcher');

const LOOKBACK_DAYS = 30;

/** Reconcile a single user's Zoho customer payments against their Razorpay payments. */
async function reconcileForUser(userId) {
  const orgs = await selectRows(
    'zoho_organizations',
    `select=id&user_id=eq.${userId}&status=eq.active&limit=1`
  );
  if (!orgs.length) return { status: 'skipped', reason: 'no active Zoho organization' };
  const orgRef = orgs[0].id;

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const [zohoPayments, razorpayPayments, existing] = await Promise.all([
    selectRows('zoho_customer_payments', `select=*&org_ref=eq.${orgRef}&payment_date=gte.${since}&order=payment_date.desc&limit=500`),
    selectRows('razorpay_transactions', `select=payment_id,amount,status,created_at&user_id=eq.${userId}&status=eq.captured&order=created_at.desc&limit=1000`),
    selectRows('reconciliation_matches', `select=zoho_payment_id&user_id=eq.${userId}`)
  ]);

  const alreadyResolved = new Set(existing.map((e) => e.zoho_payment_id));
  const matches = matchPayments(zohoPayments, razorpayPayments, alreadyResolved);

  if (!matches.length) {
    return { status: 'noop', processed: 0 };
  }

  const rowsToInsert = matches.map((m) => ({ ...m, user_id: userId, org_ref: orgRef }));
  await insertRows('reconciliation_matches', rowsToInsert, {
    onConflict: 'user_id,invoice_ref,zoho_payment_id',
    merge: true
  });

  // Surface verification directly on the invoice — this is the "confirmed
  // credit balance" update. There's no separate ledger table today, so the
  // invoice row Zoho already gives us is the right place for it.
  for (const m of matches) {
    if (!m.invoice_ref) continue;
    const status = m.match_status === 'auto_matched' && m.match_confidence === 'verified'
      ? 'verified'
      : m.match_status === 'no_match'
        ? 'no_match'
        : 'review';
    const patch = { reconciliation_status: status };
    if (status === 'verified') patch.verified_paid_amount = m.matched_amount;
    await updateRows('zoho_invoices', `org_ref=eq.${orgRef}&invoice_id=eq.${m.invoice_ref}`, patch);
  }

  const summary = {
    processed: matches.length,
    verified: matches.filter((m) => m.match_confidence === 'verified').length,
    signal: matches.filter((m) => m.match_confidence === 'signal').length,
    pending_review: matches.filter((m) => m.match_status === 'pending_review').length,
    no_match: matches.filter((m) => m.match_status === 'no_match').length
  };

  await logConnectorEvent({
    userId,
    connectorType: 'reconciliation',
    operation: 'run',
    status: 'success',
    recordsSynced: summary.processed
  });

  return { status: 'ok', ...summary };
}

/** Cron path: loop every user with an active Zoho connection. */
async function reconcileAllUsers() {
  const orgs = await selectRows('zoho_organizations', 'select=user_id&status=eq.active');
  const userIds = [...new Set(orgs.map((o) => o.user_id))];
  const results = [];
  for (const userId of userIds) {
    try {
      results.push({ userId, ...(await reconcileForUser(userId)) });
    } catch (err) {
      results.push({ userId, status: 'error', reason: err.message });
    }
  }
  return results;
}

/** User manually picks the correct Razorpay payment for an ambiguous pending_review row. */
async function resolveManualMatch({ matchId, userId, razorpayPaymentId, matchedAmount }) {
  const rows = await selectRows('reconciliation_matches', `select=*&id=eq.${matchId}&user_id=eq.${userId}&limit=1`);
  if (!rows.length) throw new Error('Match not found');
  const match = rows[0];
  if (match.match_status !== 'pending_review') throw new Error('Only pending_review matches can be manually resolved');

  await updateRows('reconciliation_matches', `id=eq.${matchId}`, {
    razorpay_payment_id: razorpayPaymentId,
    matched_amount: matchedAmount,
    match_status: 'manually_confirmed',
    match_confidence: 'verified',
    match_reason: 'Manually confirmed by user from ambiguous candidates.',
    resolved_at: new Date().toISOString(),
    resolved_by: 'user'
  });

  if (match.invoice_ref) {
    await updateRows('zoho_invoices', `org_ref=eq.${match.org_ref}&invoice_id=eq.${match.invoice_ref}`, {
      reconciliation_status: 'verified',
      verified_paid_amount: matchedAmount
    });
  }

  return { status: 'ok' };
}

module.exports = async (req, res) => {
  const action = req.query.action;

  if (action === 'run') {
    const cronSecret = req.headers['authorization'];
    const isCron = cronSecret === `Bearer ${process.env.CRON_SECRET}`;

    if (isCron) {
      const results = await reconcileAllUsers();
      res.status(200).json({ users_processed: results.length, results });
      return;
    }

    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const result = await reconcileForUser(user.id);
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (action === 'resolve') {
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { matchId, razorpayPaymentId, matchedAmount } = req.body || {};
    if (!matchId || !razorpayPaymentId || !matchedAmount) {
      res.status(400).json({ error: 'matchId, razorpayPaymentId, matchedAmount are required' });
      return;
    }
    try {
      const result = await resolveManualMatch({ matchId, userId: user.id, razorpayPaymentId, matchedAmount });
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Unknown action. Use ?action=run or ?action=resolve.' });
};

module.exports.reconcileForUser = reconcileForUser;
