/**
 * GET /api/zoho-vitals
 *
 * Reads the six vitals for the authenticated user's Zoho Books org by
 * calling the `zoho_vitals(p_user_id, p_org_ref)` Postgres function created
 * in sql/zoho_books_migration.sql.
 *
 * All the arithmetic lives in SQL, not here, for three reasons: it stays
 * close to the data, the briefing generator and app.html read the identical
 * numbers, and the calculations can be spot-checked directly in the Supabase
 * SQL Editor against the owner's native Zoho Books figures.
 *
 * Response shape (when connected):
 * {
 *   connected: true, org_ref, organization_name, status,
 *   cash_position: { zoho_reported_balance, gateway_settled_90d, divergence_pct, bank_data_available },
 *   receivables:   { current, days_1_30, days_31_60, days_61_90, days_90_plus, total },
 *   top_overdue_customers: [ { customer_name, invoice_number, balance, days_overdue } ],
 *   payables:      { current, due_this_week, overdue, total, projected_cash_after_this_weeks_payables },
 *   gst_leakage:   { filing_period, total_leakage, vendors_not_filed, leakage_pct },
 *   gst_top_at_risk_vendors: [ { vendor_gstin, vendor_name, at_risk } ],
 *   net_margin:    { period, income, cogs, opex, net_margin_pct },
 *   working_capital_runway: { adjusted_cash_position, receivables_due_30d, payables_due_30d, avg_daily_burn, runway_days },
 *   flags: [ ... ],
 *   briefing_hints: { ... }   <- added here, see below
 * }
 *
 * `briefing_hints` is the Zoho-specific prompt enhancement from the
 * vitals-calculator skill: when Books data is available, the AI briefing
 * should prefer NAMED counterparties (this customer, this vendor) over
 * aggregate figures. Passing the named entities alongside the aggregates
 * means the briefing prompt does not have to re-derive them.
 */

const { getUserFromRequest, rpc, selectRows } = require('../_lib/supabaseRest');

function inr(n) {
  const v = Number(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toFixed(0)}`;
}

/**
 * Turn the raw vitals into ready-to-use, named-entity briefing lines.
 * Aggregates are kept too, but these are what the Opening Bell prompt
 * should reach for first.
 */
function buildBriefingHints(v) {
  const lines = [];

  const topOverdue = Array.isArray(v.top_overdue_customers) ? v.top_overdue_customers : [];
  if (topOverdue.length > 0) {
    const t = topOverdue[0];
    if (t.customer_name) {
      lines.push(
        `${t.customer_name} owes you ${inr(t.balance)}, ${t.days_overdue} days overdue` +
        (topOverdue.length > 1 ? ` — your largest single receivable of ${topOverdue.length} overdue accounts.` : '.')
      );
    }
  }

  const vendors = Array.isArray(v.gst_top_at_risk_vendors) ? v.gst_top_at_risk_vendors : [];
  const gst = v.gst_leakage || {};
  if (Number(gst.total_leakage) > 0) {
    const who = vendors.length
      ? ` ${vendors.length} vendor${vendors.length > 1 ? 's' : ''} (${vendors.map((x) => x.vendor_name || x.vendor_gstin).filter(Boolean).slice(0, 2).join(', ')}) ${vendors.length > 1 ? "haven't" : "hasn't"} filed.`
      : '';
    lines.push(
      `${inr(gst.total_leakage)} in input tax credit is at risk for ${gst.filing_period || 'the latest period'}` +
      ` (${gst.leakage_pct || 0}% of claimed ITC).${who} Follow up before the GSTR-3B deadline.`
    );
  }

  const pay = v.payables || {};
  if (Number(pay.projected_cash_after_this_weeks_payables) < 0) {
    lines.push(
      `Payables due in the next 7 days (${inr(pay.due_this_week)}) exceed your book cash balance — ` +
      `projected shortfall of ${inr(Math.abs(pay.projected_cash_after_this_weeks_payables))}.`
    );
  }

  const cash = v.cash_position || {};
  if (Number(cash.divergence_pct) > 10 && cash.bank_data_available) {
    lines.push(
      `Books balance (${inr(cash.zoho_reported_balance)}) and 90-day gateway settlements (${inr(cash.gateway_settled_90d)}) ` +
      `diverge by ${cash.divergence_pct}% — worth a look at what hasn't been recorded.`
    );
  }

  return {
    prefer_named_entities: true,
    note: 'Zoho Books data is connected. Prefer named customers and vendors over aggregate figures in the briefing.',
    lines
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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

  const orgRef = (req.query && req.query.org_ref) || null;

  let vitals;
  try {
    vitals = await rpc('zoho_vitals', { p_user_id: user.id, p_org_ref: orgRef });
  } catch (err) {
    res.status(500).json({ error: 'Could not compute Zoho Books vitals' });
    return;
  }

  // PostgREST returns the JSONB directly for a scalar-returning function.
  const v = (vitals && typeof vitals === 'object' && !Array.isArray(vitals))
    ? vitals
    : (Array.isArray(vitals) ? vitals[0] : {});

  if (!v || v.connected !== true) {
    res.status(200).json({ connected: false });
    return;
  }

  // The `zoho_vitals` SQL function's JSON payload never carried
  // backfill_completed_at — it's a column on zoho_organizations, not
  // something the vitals RPC computes. app.html's "First sync in
  // progress" banner (booksBackfillBanner) gates on
  // zohoVitals.backfill_completed_at, so that field was always
  // `undefined` here regardless of what sync.js had actually set on the
  // org row: the banner could never clear even after a clean sync. Pull
  // it straight from zoho_organizations and merge it in.
  let backfillCompletedAt = null;
  if (v.org_ref) {
    try {
      const orgs = await selectRows(
        'zoho_organizations',
        `select=backfill_completed_at&id=eq.${v.org_ref}&user_id=eq.${user.id}&limit=1`
      );
      backfillCompletedAt = orgs[0] ? orgs[0].backfill_completed_at : null;
    } catch (err) {
      console.error('Failed to read backfill_completed_at:', err.message);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...v, backfill_completed_at: backfillCompletedAt, briefing_hints: buildBriefingHints(v) });
};

module.exports = { handler, buildBriefingHints };
