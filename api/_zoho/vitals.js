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
 *   gst_leakage:   { filing_period, total_leakage, vendors_not_filed, leakage_pct }
 *                  | null when GSTR-2B is not available (see gstr2b below),
 *   gst_top_at_risk_vendors: [ { vendor_gstin, vendor_name, at_risk } ],
 *   gstr2b:        { available, state, reason, message }  (api/_lib/gstr2bGate.js:
 *                  fail-closed — null gst_leakage means "not available", never ₹0),
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
// Drafts and voided invoices aren't money anyone owes (see moneyModel.js).
const { ZOHO_OPEN } = require('../_lib/moneyModel');
const { readGstr2bAvailability, applyGstr2bGate } = require('../_lib/gstr2bGate');

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

/** 'YYYY-MM' of a time in India. */
function istMonth(ms) {
  return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 7);
}

function nextMonth(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const PNL_TYPES = ['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense'];

/**
 * Pure: the month's P&L from chart-of-accounts rows and postings, as Zoho's
 * Profit and Loss report adds it. Income (operating + other) is credit minus
 * debit, so credit notes reduce it; costs are debit minus credit. Exported for tests.
 */
function netMarginFrom(accounts, postings, period) {
  const typeOf = new Map(accounts.map((a) => [String(a.id), String(a.account_type || '').toLowerCase()]));
  let income = 0, cogs = 0, opex = 0, seen = 0;
  for (const p of postings) {
    if (String(p.entry_date || '').slice(0, 7) !== period) continue;
    const t = typeOf.get(String(p.account_ref));
    const cr = Number(p.credit) || 0, dr = Number(p.debit) || 0;
    if (t === 'income' || t === 'other_income') income += cr - dr;
    else if (t === 'cost_of_goods_sold') cogs += dr - cr;
    else if (t === 'expense' || t === 'other_expense') opex += dr - cr;
    else continue;
    seen++;
  }
  if (!seen) return null;
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    period, income: r2(income), cogs: r2(cogs), opex: r2(opex),
    net_profit: r2(income - cogs - opex),
    net_margin_pct: income ? r2(((income - cogs - opex) / income) * 100) : 0,
    basis: 'zoho_postings'
  };
}

async function netMarginFromPostings(orgRef, period) {
  if (!orgRef) return null;
  const accounts = await selectRows('zoho_chart_of_accounts',
    `select=id,account_type&org_ref=eq.${orgRef}&account_type=in.(${PNL_TYPES.join(',')})&limit=5000`);
  if (!accounts.length) return null;
  const postings = await selectRows('zoho_journal_entries',
    `select=account_ref,entry_date,debit,credit&org_ref=eq.${orgRef}&entry_date=gte.${period}-01&entry_date=lt.${nextMonth(period)}-01&order=id.asc&limit=100000`);
  return netMarginFrom(accounts, postings, period);
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
  const raw = (vitals && typeof vitals === 'object' && !Array.isArray(vitals))
    ? vitals
    : (Array.isArray(vitals) ? vitals[0] : {});

  if (!raw || raw.connected !== true) {
    res.status(200).json({ connected: false });
    return;
  }

  // GSTR-2B / ITC at risk is fail-closed: unless the endpoint is validated
  // and the last gstr2b run succeeded, gst_leakage goes out as null with a
  // gstr2b.reason, so no surface can render an empty table as ₹0 at risk.
  const v = applyGstr2bGate(raw, await readGstr2bAvailability(selectRows, raw.org_ref));

  // Net margin the way Zoho's own Profit and Loss adds it up, from the synced postings (exact to the rupee on
  // a live org, 29 Oct 2026). The SQL function's figure is kept only when no postings have synced.
  try {
    const nm = await netMarginFromPostings(v.org_ref, istMonth(Date.now()));
    if (nm) v.net_margin = nm;
  } catch (err) {
    console.error('zoho net margin from postings failed:', err.message);
  }

  // Cash vs gateway: with no gateway settlements there is nothing to compare, so no divergence and no flag
  // (it read 100% and raised cash_position_mismatch on every Zoho-only account).
  const cp = v.cash_position;
  if (cp && !(Number(cp.gateway_settled_90d) > 0)) {
    cp.divergence_pct = null;
    if (Array.isArray(v.flags)) v.flags = v.flags.filter((f) => f !== 'cash_position_mismatch');
  }

  // The `zoho_vitals` SQL function's JSON payload never carried
  // backfill_completed_at — it's a column on zoho_organizations, not
  // something the vitals RPC computes. app.html's "First sync in
  // progress" banner (booksBackfillBanner) gates on
  // zohoVitals.backfill_completed_at, so that field was always
  // `undefined` here regardless of what sync.js had actually set on the
  // org row: the banner could never clear even after a clean sync. Pull
  // it straight from zoho_organizations and merge it in.
  let backfillCompletedAt = null, lastSyncedAt = null;
  if (v.org_ref) {
    try {
      const orgs = await selectRows(
        'zoho_organizations',
        `select=backfill_completed_at,last_synced_at&id=eq.${v.org_ref}&user_id=eq.${user.id}&limit=1`
      );
      backfillCompletedAt = orgs[0] ? orgs[0].backfill_completed_at : null;
      // when the books last came in: Home's source line, and chat/voice get_sources ("no successful sync on record", 30 Oct 2026)
      lastSyncedAt = orgs[0] ? orgs[0].last_synced_at || null : null;
    } catch (err) {
      console.error('Failed to read backfill_completed_at:', err.message);
    }
  }

  // ---- Row-level open receivables / payables ----------------------------
  // The vitals RPC only returns aggregates + top_overdue_customers. The
  // unified Ledger view and the cross-source reconciliation logic need every
  // open invoice / bill as a row, tagged source='zoho_books'. Every open
  // row (it was the first 250: 250 of 883 open invoices on a live org).
  let receivablesList = [];
  let payablesList = [];
  if (v.org_ref) {
    try {
      const invs = await selectRows(
        'zoho_invoices',
        `select=invoice_number,customer_name,balance,due_date,invoice_date,status&org_ref=eq.${v.org_ref}&balance=gt.0&${ZOHO_OPEN}&order=due_date.asc.nullslast,invoice_number.asc&limit=20000`
      );
      receivablesList = (invs || []).map((r) => ({
        party_name: r.customer_name || 'Unnamed customer',
        amount: Number(r.balance) || 0,
        due_date: r.due_date || null,
        doc_date: r.invoice_date || null,
        ref: r.invoice_number || null,
        status: r.status || null,
        source: 'zoho_books'
      }));
    } catch (err) {
      console.error('zoho receivables_list read failed:', err.message);
    }
    try {
      const bills = await selectRows(
        'zoho_bills',
        `select=bill_number,vendor_name,balance,due_date,bill_date,status&org_ref=eq.${v.org_ref}&balance=gt.0&${ZOHO_OPEN}&order=due_date.asc.nullslast,bill_number.asc&limit=20000`
      );
      payablesList = (bills || []).map((r) => ({
        party_name: r.vendor_name || 'Unnamed vendor',
        amount: Number(r.balance) || 0,
        due_date: r.due_date || null,
        doc_date: r.bill_date || null,
        ref: r.bill_number || null,
        status: r.status || null,
        source: 'zoho_books'
      }));
    } catch (err) {
      console.error('zoho payables_list read failed:', err.message);
    }
  }

  // Item lines read so far (_zoho/items.js), for the "Fill now" line on the Zoho card. Empty before the migration.
  let itemLines = null;
  if (v.org_ref) {
    try {
      const state = await selectRows('zoho_line_state', `select=doc_type,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${v.org_ref}&order=id.asc&limit=200000`);
      if (state.length) {
        const itemStep = require('./items');
        itemLines = itemStep.progressFrom(state);
        // When the rest will be in: today's allowance left, then a night's (the Zoho card's "done by" line).
        if (itemLines.pending > 0) {
          const orgRows = await selectRows('zoho_organizations', `select=id,plan_type,organization_id&id=eq.${v.org_ref}&limit=1`).catch(() => []);
          const org = orgRows[0] || { id: v.org_ref, plan_type: null };
          const cap = await itemStep.dailyCap(org);
          const usedToday = await itemStep.callsUsedToday(v.org_ref, Date.now());
          itemLines.eta = itemStep.fillEta({ pending: itemLines.pending, cap, usedToday });
          itemLines.daily_allowance = cap;
          itemLines.plan = org.plan_type || null;
          itemLines.organization_id = org.organization_id || null;   // for the limit-raise email
        }
      }
    } catch (err) { /* table not migrated yet */ }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...v,
    backfill_completed_at: backfillCompletedAt,
    last_synced_at: lastSyncedAt,
    item_lines: itemLines,
    receivables_list: receivablesList,
    payables_list: payablesList,
    briefing_hints: buildBriefingHints(v)
  });
};

module.exports = { handler, buildBriefingHints, netMarginFrom, istMonth, nextMonth };
