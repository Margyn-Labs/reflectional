/**
 * POST /api/reconcile?action=run          — reconcile one user (JWT-authed) or all users (cron)
 * POST /api/reconcile?action=resolve       — manually resolve a pending_review row (JWT-authed)
 * GET  /api/reconcile?action=summary       — read-only view of reconciliation output for the UI (JWT-authed)
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
const {
  matchBooksRazorpay,
  matchBooksShopify,
  matchRazorpayShopify
} = require('./_lib/reconcilerV2');

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

  // The authoritative verdict now lives on reconciliation_matches (status /
  // verified_at / source_a / source_b), written by the insert above. We still
  // mirror a coarse status onto zoho_invoices as a CONVENIENCE for any UI that
  // reads it directly — but it is no longer the source of truth, so if Zoho
  // re-syncs and drops the column value, the match verdict survives.
  for (const m of matches) {
    if (!m.invoice_ref) continue;
    const mirror = m.status === 'verified'
      ? 'verified'
      : m.status === 'unmatched'
        ? 'no_match'
        : 'review';
    const patch = { reconciliation_status: mirror };
    if (mirror === 'verified') patch.verified_paid_amount = m.matched_amount;
    await updateRows('zoho_invoices', `org_ref=eq.${orgRef}&invoice_id=eq.${m.invoice_ref}`, patch);
  }

  const summary = {
    processed: matches.length,
    verified: matches.filter((m) => m.status === 'verified').length,
    signal: matches.filter((m) => m.status === 'signal').length,
    pending_review: matches.filter((m) => m.status === 'needs_review').length,
    no_match: matches.filter((m) => m.status === 'unmatched').length
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

  const nowIso = new Date().toISOString();
  await updateRows('reconciliation_matches', `id=eq.${matchId}`, {
    razorpay_payment_id: razorpayPaymentId,
    matched_amount: matchedAmount,
    match_status: 'manually_confirmed',
    match_confidence: 'verified',
    status: 'verified',
    verified_at: nowIso,
    logical_payment_key: String(razorpayPaymentId).trim(),
    match_reason: 'Manually confirmed by user from ambiguous candidates.',
    resolved_at: nowIso,
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

/**
 * Read-only projection of what the nightly reconcile already wrote, for
 * app.html. No matching happens here — it just reads reconciliation_status
 * off zoho_invoices and the pending_review rows out of reconciliation_matches
 * so the UI can show them. Same active-org scoping as reconcileForUser.
 */
async function summaryForUser(userId) {
  const orgs = await selectRows(
    'zoho_organizations',
    `select=id&user_id=eq.${userId}&status=eq.active&limit=1`
  );
  if (!orgs.length) return { connected: false };
  const orgRef = orgs[0].id;

  const [invoices, allMatches] = await Promise.all([
    selectRows(
      'zoho_invoices',
      'select=invoice_id,invoice_number,customer_name,total,balance,reconciliation_status,verified_paid_amount' +
        `&org_ref=eq.${orgRef}&reconciliation_status=in.(verified,review)` +
        '&order=reconciliation_status.desc,invoice_number.asc'
    ),
    // reconciliation_matches is now the authoritative verdict store — counts
    // and provenance come from here, not from zoho_invoices.reconciliation_status.
    selectRows(
      'reconciliation_matches',
      'select=id,invoice_ref,zoho_payment_id,invoice_amount,match_reason,same_source_flag,date_diff_days,' +
        'candidate_payment_ids,status,match_status,source_a,source_b,verified_at,fetched_at_a,fetched_at_b' +
        `&user_id=eq.${userId}`
    )
  ]);

  const pending = allMatches.filter((m) => (m.status || m.match_status) === 'needs_review' || m.match_status === 'pending_review');

  const byId = {};
  for (const inv of invoices) byId[inv.invoice_id] = inv;

  const reviewQueue = pending.map((m) => {
    const inv = byId[m.invoice_ref] || {};
    return {
      id: m.id,
      invoice_ref: m.invoice_ref,
      invoice_number: inv.invoice_number || null,
      customer_name: inv.customer_name || null,
      amount: m.invoice_amount,
      reason: m.match_reason,
      same_source: !!m.same_source_flag,
      date_diff_days: m.date_diff_days,
      candidates: Array.isArray(m.candidate_payment_ids) ? m.candidate_payment_ids : []
    };
  });

  const verifiedMatches = allMatches.filter((m) => (m.status) === 'verified');
  const lastVerifiedAt = verifiedMatches
    .map((m) => m.verified_at)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    connected: true,
    counts: {
      verified: verifiedMatches.length,
      signal: allMatches.filter((m) => m.status === 'signal').length,
      needs_review: allMatches.filter((m) => m.status === 'needs_review').length,
      unmatched: allMatches.filter((m) => m.status === 'unmatched').length,
      pending_review: pending.length
    },
    // Provenance the AI context surfaces: which two sources, match tiers, when
    // last verified. See api/_lib/formatMargynContext.js.
    provenance: {
      source_a: 'zoho_books',
      source_b: 'razorpay',
      last_verified_at: lastVerifiedAt
    },
    invoices,
    review_queue: reviewQueue
  };
}

/* ==========================================================================
 * Reconciler v2 — multi-source pair jobs (Books x Razorpay, Books x Shopify,
 * Razorpay x Shopify). Books = Zoho Books OR Tally, never blended. No bank,
 * no GST. Findings land in recon_findings (2026-09-04-reconciler-v2-findings.sql).
 * The pure matching lives in api/_lib/reconcilerV2.js.
 * ========================================================================== */

const RECON_V2_LOOKBACK_DAYS = 60;

function containsRazorpay(...parts) {
  return parts.some((p) => String(p || '').toLowerCase().includes('razorpay'));
}

/** Which books source(s) does this user actually have connected? Never merged. */
async function detectBooksSources(userId) {
  const [zohoOrgs, tallyInstalls] = await Promise.all([
    selectRows('zoho_organizations', `select=id&user_id=eq.${userId}&status=eq.active&limit=1`).catch(() => []),
    selectRows('tally_installs', `select=id,company_name&user_id=eq.${userId}&status=eq.active&limit=1`).catch(() => [])
  ]);
  const out = [];
  if (zohoOrgs.length) out.push({ source: 'zoho_books', orgRef: zohoOrgs[0].id });
  if (tallyInstalls.length) out.push({ source: 'tally', orgRef: tallyInstalls[0].id, installId: tallyInstalls[0].id });
  return out;
}

/** needs_reauth check per connector — Reconciler skips a stale source, reports Signal. */
async function connectorNeedsReauth(userId) {
  const flags = { zoho_books: false, tally: false, razorpay: false, shopify: false };
  try {
    const orgs = await selectRows('zoho_organizations', `select=status&user_id=eq.${userId}&limit=1`);
    if (orgs[0] && orgs[0].status === 'needs_reauth') flags.zoho_books = true;
  } catch (e) { /* table optional */ }
  try {
    const st = await selectRows('shopify_stores', `select=status&user_id=eq.${userId}&limit=1`);
    if (st[0] && /reauth/i.test(st[0].status || '')) flags.shopify = true;
  } catch (e) { /* optional */ }
  try {
    const cc = await selectRows('connector_credentials', `select=connector_type,needs_reauth&user_id=eq.${userId}&disconnected_at=is.null`);
    for (const row of cc) if (row.needs_reauth && flags[row.connector_type] !== undefined) flags[row.connector_type] = true;
  } catch (e) { /* optional */ }
  return flags;
}

function normRazorpay(rows) {
  return (rows || []).map((r) => ({
    id: r.payment_id,
    amount: Number(r.amount || 0) / 100,
    currency: r.currency || 'INR',
    date: r.created_at,
    status: r.status,
    method: r.method || null,
    fee: Number(r.fee || 0) / 100,
    description: r.description || null,
    email: r.customer_email || null,
    fetchedAt: r.synced_at || null
  }));
}

function normShopify(rows) {
  return (rows || []).map((o) => ({
    name: o.order_number || String(o.order_id),
    amount: Number(o.total_price || 0),
    currency: o.currency || 'INR',
    date: o.created_at_shopify,
    financialStatus: o.financial_status || 'pending',
    gateway: o.gateway || null,
    fetchedAt: o.synced_at || null
  }));
}

async function loadBooksPayments(userId, src) {
  if (src.source === 'zoho_books') {
    const since = new Date(Date.now() - RECON_V2_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const rows = await selectRows(
      'zoho_customer_payments',
      `select=*&org_ref=eq.${src.orgRef}&payment_date=gte.${since}&order=payment_date.desc&limit=1000`
    ).catch(() => []);
    return rows.map((p) => ({
      ref: p.payment_id,
      amount: Number(p.amount),
      date: p.payment_date,
      currency: p.currency || 'INR',
      invoiceRef: p.invoice_ref || null,
      mode: p.payment_mode || null,
      reference: p.reference_number || null,
      sameSourced: containsRazorpay(p.payment_mode, p.reference_number),
      fetchedAt: p.synced_at || null
    }));
  }
  // Tally: Receipt vouchers are the books-side payment record.
  const rows = await selectRows(
    'tally_vouchers',
    `select=*&user_id=eq.${userId}&voucher_type=eq.Receipt&order=date.desc&limit=1000`
  ).catch(() => []);
  return rows.map((v) => ({
    ref: v.voucher_number || v.tally_guid,
    amount: Math.abs(Number(v.amount || 0)),
    date: v.date,
    currency: 'INR',
    invoiceRef: null,
    mode: null,
    reference: v.narration || null,
    sameSourced: containsRazorpay(v.narration),
    fetchedAt: v.synced_at || null
  }));
}

async function loadBooksInvoices(userId, src) {
  if (src.source === 'zoho_books') {
    const rows = await selectRows(
      'zoho_invoices',
      `select=invoice_id,invoice_number,invoice_date,date,total,customer_name,currency_code&org_ref=eq.${src.orgRef}&order=invoice_number.desc&limit=1000`
    ).catch(() => []);
    return rows.map((i) => ({
      ref: i.invoice_id,
      number: i.invoice_number,
      amount: Number(i.total),
      date: i.invoice_date || i.date || null,
      currency: i.currency_code || 'INR',
      party: i.customer_name || null,
      fetchedAt: null
    }));
  }
  const rows = await selectRows(
    'tally_vouchers',
    `select=*&user_id=eq.${userId}&voucher_type=eq.Sales&order=date.desc&limit=1000`
  ).catch(() => []);
  return rows.map((v) => ({
    ref: v.tally_guid,
    number: v.voucher_number,
    amount: Math.abs(Number(v.amount || 0)),
    date: v.date,
    currency: 'INR',
    party: v.party_name || null,
    fetchedAt: v.synced_at || null
  }));
}

async function reconcileV2ForUser(userId) {
  const [booksSources, reauth] = await Promise.all([
    detectBooksSources(userId),
    connectorNeedsReauth(userId)
  ]);

  const [rpRaw, shopRaw] = await Promise.all([
    selectRows('razorpay_transactions', `select=payment_id,amount,currency,status,method,fee,description,customer_email,created_at,synced_at&user_id=eq.${userId}&order=created_at.desc&limit=1000`).catch(() => []),
    selectRows('shopify_orders', `select=order_id,order_number,total_price,currency,financial_status,gateway,created_at_shopify,synced_at&user_id=eq.${userId}&order=created_at_shopify.desc&limit=1000`).catch(() => [])
  ]);

  const razorpay = reauth.razorpay ? [] : normRazorpay(rpRaw);
  const shopify = reauth.shopify ? [] : normShopify(shopRaw);
  const skipped = Object.entries(reauth).filter(([, v]) => v).map(([k]) => k);

  let allFindings = [];

  // --- Books pairs, once per connected books source, kept distinct ---
  if (booksSources.length === 0) {
    // No books source at all: gateway/store money must not be a silent no-op.
    allFindings = allFindings.concat(
      matchBooksRazorpay([], razorpay, { booksSource: 'zoho_books', hasBooksSnapshot: false })
    );
    allFindings = allFindings.concat(
      matchBooksShopify([], shopify, { booksSource: 'zoho_books', hasBooksSnapshot: false })
    );
  } else {
    for (const src of booksSources) {
      if (reauth[src.source]) continue; // stale books source — skip, report Signal
      const [payments, invoices] = await Promise.all([
        loadBooksPayments(userId, src),
        loadBooksInvoices(userId, src)
      ]);
      const brF = matchBooksRazorpay(payments, razorpay, { booksSource: src.source, hasBooksSnapshot: true });
      const bsF = matchBooksShopify(invoices, shopify, { booksSource: src.source, hasBooksSnapshot: true });
      // Prefix match_key + carry org_ref so two books sources never collide on upsert.
      for (const f of brF.concat(bsF)) {
        f.match_key = src.source + ':' + f.match_key;
        f.org_ref = src.orgRef || null;
      }
      allFindings = allFindings.concat(brF, bsF);
    }
  }

  // --- Razorpay x Shopify (books-independent) ---
  allFindings = allFindings.concat(matchRazorpayShopify(razorpay, shopify, {}));

  // --- Upsert into recon_findings ---
  const nowIso = new Date().toISOString();
  const rows = allFindings.map((f) => ({
    user_id: userId,
    org_ref: f.org_ref || null,
    pair: f.pair,
    source_a: f.source_a,
    source_b: f.source_b,
    source_a_ref: f.source_a_ref || null,
    source_b_ref: f.source_b_ref || null,
    amount_a: f.amount_a != null ? f.amount_a : null,
    amount_b: f.amount_b != null ? f.amount_b : null,
    currency: f.currency || 'INR',
    status: f.status,
    match_key: f.match_key,
    match_basis: f.match_basis || 'none',
    date_diff_days: f.date_diff_days != null ? f.date_diff_days : null,
    reason: f.reason || null,
    evidence: f.evidence || {},
    verified_at: f.verified_at || null,
    fetched_at_a: f.fetched_at_a || null,
    fetched_at_b: f.fetched_at_b || null,
    updated_at: nowIso
  }));

  if (rows.length) {
    await insertRows('recon_findings', rows, { onConflict: 'user_id,pair,match_key', merge: true });
  }

  const tally = (pred) => rows.filter(pred).length;
  const summary = {
    findings: rows.length,
    verified: tally((r) => r.status === 'verified'),
    mismatch: tally((r) => r.status === 'mismatch'),
    partial: tally((r) => r.status === 'partial'),
    awaiting_books: tally((r) => r.status === 'awaiting_books'),
    fee_unallocated: tally((r) => r.status === 'fee_unallocated'),
    unmatched: tally((r) => r.status === 'unmatched_a' || r.status === 'unmatched_b'),
    by_pair: ['books_razorpay', 'books_shopify', 'razorpay_shopify'].reduce((acc, p) => {
      acc[p] = {
        verified: tally((r) => r.pair === p && r.status === 'verified'),
        mismatch: tally((r) => r.pair === p && r.status === 'mismatch'),
        awaiting: tally((r) => r.pair === p && r.status === 'awaiting_books'),
        total: tally((r) => r.pair === p)
      };
      return acc;
    }, {}),
    books_sources: booksSources.map((s) => s.source),
    skipped_sources: skipped
  };

  await logConnectorEvent({
    userId, connectorType: 'reconciliation', operation: 'run-v2',
    status: skipped.length ? 'partial' : 'success', recordsSynced: rows.length
  });

  return { status: 'ok', ...summary };
}

async function reconcileV2AllUsers() {
  // Union of everyone with any of the four sources connected.
  const [zoho, tally, rp, shop] = await Promise.all([
    selectRows('zoho_organizations', 'select=user_id&status=eq.active').catch(() => []),
    selectRows('tally_installs', 'select=user_id&status=eq.active').catch(() => []),
    selectRows('connector_credentials', 'select=user_id&connector_type=eq.razorpay&disconnected_at=is.null').catch(() => []),
    selectRows('shopify_stores', 'select=user_id').catch(() => [])
  ]);
  const userIds = [...new Set([...zoho, ...tally, ...rp, ...shop].map((o) => o.user_id).filter(Boolean))];
  const results = [];
  for (const userId of userIds) {
    try { results.push({ userId, ...(await reconcileV2ForUser(userId)) }); }
    catch (err) { results.push({ userId, status: 'error', reason: err.message }); }
  }
  return results;
}

async function summaryV2ForUser(userId) {
  const rows = await selectRows(
    'recon_findings',
    `select=pair,source_a,source_b,source_a_ref,source_b_ref,amount_a,amount_b,currency,status,match_basis,date_diff_days,reason,verified_at,updated_at&user_id=eq.${userId}&order=updated_at.desc&limit=2000`
  ).catch(() => []);

  const count = (pred) => rows.filter(pred).length;
  const pairs = ['books_razorpay', 'books_shopify', 'razorpay_shopify'];
  const byPair = pairs.reduce((acc, p) => {
    acc[p] = {
      verified: count((r) => r.pair === p && r.status === 'verified'),
      mismatch: count((r) => r.pair === p && r.status === 'mismatch'),
      partial: count((r) => r.pair === p && r.status === 'partial'),
      awaiting_books: count((r) => r.pair === p && r.status === 'awaiting_books'),
      fee_unallocated: count((r) => r.pair === p && r.status === 'fee_unallocated'),
      unmatched: count((r) => r.pair === p && (r.status === 'unmatched_a' || r.status === 'unmatched_b')),
      total: count((r) => r.pair === p)
    };
    return acc;
  }, {});

  const lastVerifiedAt = rows.filter((r) => r.verified_at).map((r) => r.verified_at).sort().pop() || null;

  // Mismatches are the screening case — surface them explicitly, capped.
  const mismatches = rows
    .filter((r) => r.status === 'mismatch')
    .slice(0, 25)
    .map((r) => ({
      pair: r.pair,
      source_a: r.source_a, source_b: r.source_b,
      a_ref: r.source_a_ref, b_ref: r.source_b_ref,
      amount_a: r.amount_a, amount_b: r.amount_b, currency: r.currency,
      date_diff_days: r.date_diff_days,
      reason: r.reason
    }));

  return {
    connected: rows.length > 0,
    counts: {
      verified: count((r) => r.status === 'verified'),
      mismatch: count((r) => r.status === 'mismatch'),
      partial: count((r) => r.status === 'partial'),
      awaiting_books: count((r) => r.status === 'awaiting_books'),
      fee_unallocated: count((r) => r.status === 'fee_unallocated'),
      unmatched: count((r) => r.status === 'unmatched_a' || r.status === 'unmatched_b')
    },
    by_pair: byPair,
    last_verified_at: lastVerifiedAt,
    mismatches
  };
}

module.exports = async (req, res) => {
  const action = req.query.action;

  if (action === 'summary') {
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const result = await summaryForUser(user.id);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

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

  if (action === 'run-v2') {
    const isCron = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
    if (isCron) {
      const results = await reconcileV2AllUsers();
      res.status(200).json({ users_processed: results.length, results });
      return;
    }
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const result = await reconcileV2ForUser(user.id);
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (action === 'summary-v2') {
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const result = await summaryV2ForUser(user.id);
      res.setHeader('Cache-Control', 'no-store');
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

  res.status(400).json({ error: 'Unknown action. Use ?action=run | run-v2 | summary | summary-v2 | resolve.' });
};

module.exports.reconcileForUser = reconcileForUser;
module.exports.summaryForUser = summaryForUser;
module.exports.reconcileV2ForUser = reconcileV2ForUser;
module.exports.summaryV2ForUser = summaryV2ForUser;
