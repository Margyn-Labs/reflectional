/**
 * POST /api/sync-zoho-gstr2b
 *
 * Weekly GSTR-2B reconciliation sync — the single highest-value object in
 * this connector. Zoho Books already reconciles purchase bills against
 * government-filed GSTR-2B data via its own GSP integration, so Margyn
 * reads the result rather than rebuilding the reconciliation.
 *
 * `itc_at_risk_amount` IS the GST/ITC leakage figure. It is stored and read
 * directly, with no inference — that is what makes this Margyn's most
 * defensible vital.
 *
 * Weekly, not nightly: the underlying GSTR-2B data only refreshes on the
 * business's own filing cadence (monthly, or quarterly under QRMP). Polling
 * more often buys nothing and burns the org's daily API cap.
 *
 * Endpoint caveat: this module is newer than the core CRUD objects and its
 * path is not as stable in Zoho's docs. It is therefore configurable via
 * ZOHO_GSTR2B_PATH, and a 404/plan error is treated as "not available for
 * this org" rather than a sync failure. Validate the real path against a
 * sandbox org before pilot use.
 *
 * FAIL CLOSED (2026-10-29): until ZOHO_GSTR2B_VALIDATED=1 is set, this sync
 * does not call Zoho at all. It records last_run_status='not_available' in
 * zoho_sync_state and a 'skipped' connector_logs line, and every reader
 * (api/_lib/gstr2bGate.js) shows ITC at risk as "Not available" — never an
 * empty table summed to ₹0.
 */

const {
  selectRows,
  insertRows,
  getUserFromRequest,
  logConnectorEvent
} = require('../_lib/supabaseRest');

const {
  createSession,
  setSyncCursor,
  markNeedsReauth,
  toNumber,
  ZohoAuthError,
  ZohoModuleUnavailable
} = require('../_lib/zohoClient');
const { gstr2bValidated } = require('../_lib/gstr2bGate');
const { track } = require('../_lib/track');

const GSTR2B_PATH = process.env.ZOHO_GSTR2B_PATH || 'books/v3/gstreports/2b/reconciliation';
const PERIODS_TO_SYNC = 3;   // current + 2 prior filing periods (covers late vendor filings)

/** ['2026-08', '2026-07', '2026-06'] */
function recentFilingPeriods(count) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

function normaliseMatchStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (s.indexOf('missing') !== -1 || s.indexOf('not_in_2b') !== -1) return 'missing_in_2b';
  if (s.indexOf('partial') !== -1) return 'partially_matched';
  if (s.indexOf('unmatch') !== -1 || s.indexOf('mismatch') !== -1) return 'unmatched';
  if (s.indexOf('match') !== -1) return 'matched';
  return s || 'unmatched';
}

function mapReconciliation(r, orgRef, period, billIdToUuid) {
  const billId = r.bill_id ? String(r.bill_id) : '';
  return {
    org_ref: orgRef,
    bill_ref: billId && billIdToUuid[billId] ? billIdToUuid[billId] : null,
    bill_id: billId,
    vendor_gstin: r.vendor_gstin || r.gstin || null,
    vendor_name: r.vendor_name || r.contact_name || null,
    filing_period: r.filing_period || r.return_period || period,
    match_status: normaliseMatchStatus(r.match_status || r.reconciliation_status),
    itc_eligible_amount: toNumber(r.itc_eligible_amount != null ? r.itc_eligible_amount : r.eligible_itc),
    itc_at_risk_amount: toNumber(r.itc_at_risk_amount != null ? r.itc_at_risk_amount : r.itc_at_risk),
    synced_at: new Date().toISOString()
  };
}

async function syncGstr2bForUser(userId) {
  const startedAt = Date.now();

  const orgs = await selectRows(
    'zoho_organizations',
    `select=*&user_id=eq.${userId}&status=eq.active&order=connected_at.desc&limit=1`
  );
  const org = orgs[0];

  if (!org) {
    return { status: 'error', message: 'Zoho Books not connected' };
  }

  // Fail closed: the endpoint path is unvalidated, so don't call it and don't
  // write anything that a reader could sum to 0.
  if (!gstr2bValidated()) {
    await setSyncCursor(org.id, 'gstr2b', new Date().toISOString(), 'not_available');
    // status 'success' + a reason code, same shape as the module-unavailable
    // path below: a deliberate skip is not a sync failure (ops-metrics counts
    // status='error' as one).
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'sync_gstr2b',
      status: 'success', errorMessage: 'gstr2b_not_validated',
      recordsSynced: 0, syncDurationMs: Date.now() - startedAt
    });
    await track(userId, 'zoho_gstr2b_sync', { ok: false, state: 'not_available', error_code: 'gstr2b_not_validated', rows_synced: 0, periods: 0 });
    return {
      status: 'skipped',
      state: 'not_available',
      reason: 'gstr2b_not_validated',
      org_ref: org.id,
      records_synced: 0,
      module_unavailable: true,
      duration_ms: Date.now() - startedAt
    };
  }

  // Map Zoho bill_id -> our zoho_bills.id so bill_ref resolves.
  const billIdToUuid = {};
  try {
    const bills = await selectRows('zoho_bills', `select=id,bill_id&org_ref=eq.${org.id}`);
    for (const b of bills) billIdToUuid[b.bill_id] = b.id;
  } catch (err) {
    console.error('Could not build bill id map; bill_ref will be null');
  }

  const session = createSession(org);
  const periods = recentFilingPeriods(PERIODS_TO_SYNC);
  const errors = [];
  let totalRows = 0;
  let unavailable = false;

  for (const period of periods) {
    try {
      const raw = await session.apiGetAll(GSTR2B_PATH, 'reconciliation', {
        filing_period: period,
        return_period: period
      });

      if (!raw.length) {
        // Expected for the current month before the business has filed.
        // Not an error — the next weekly run will pick it up.
        continue;
      }

      const rows = raw
        .map((r) => mapReconciliation(r, org.id, period, billIdToUuid))
        .filter((r) => r.filing_period);

      // Upsert on (org_ref, bill_id, filing_period): when a vendor files late
      // and match_status flips missing_in_2b -> matched, the existing row is
      // updated in place rather than duplicated.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await insertRows('zoho_gstr2b_reconciliation', rows.slice(i, i + CHUNK), {
          onConflict: 'org_ref,bill_id,filing_period',
          merge: true
        });
      }
      totalRows += rows.length;
    } catch (err) {
      if (err instanceof ZohoAuthError) throw err;
      if (err instanceof ZohoModuleUnavailable) {
        unavailable = true;
        break;   // module isn't on this org at all; no point trying other periods
      }
      errors.push(`${period}: ${err.message}`);
    }
  }

  await setSyncCursor(org.id, 'gstr2b', new Date().toISOString(),
    unavailable ? 'skipped' : (errors.length ? 'error' : 'success'));

  const status = unavailable
    ? 'success'
    : (errors.length === 0 ? 'success' : (totalRows > 0 ? 'partial' : 'error'));

  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: 'sync_gstr2b',
    status: status === 'error' ? 'error' : (status === 'partial' ? 'partial' : 'success'),
    errorMessage: unavailable
      ? 'gstr2b_module_unavailable'
      : (errors.length ? errors.join('; ') : null),
    recordsSynced: totalRows,
    syncDurationMs: Date.now() - startedAt
  });

  await track(userId, 'zoho_gstr2b_sync', {
    ok: status !== 'error' && !unavailable,
    state: unavailable ? 'not_available' : status,
    error_code: unavailable ? 'module_unavailable' : (errors.length ? 'module_errors' : 'none'),
    rows_synced: totalRows,
    periods: periods.length
  });

  return {
    status,
    org_ref: org.id,
    periods_checked: periods,
    records_synced: totalRows,
    module_unavailable: unavailable,
    errors: errors.length ? errors : undefined,
    duration_ms: Date.now() - startedAt
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const result = await syncGstr2bForUser(user.id);
    res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) {
    if (err instanceof ZohoAuthError) {
      const orgs = await selectRows(
        'zoho_organizations',
        `select=id&user_id=eq.${user.id}&status=eq.active&limit=1`
      );
      if (orgs[0]) await markNeedsReauth(orgs[0].id);
      res.status(401).json({ status: 'error', message: 'Zoho Books connection needs to be re-authorized' });
      return;
    }
    res.status(500).json({ status: 'error', message: 'GSTR-2B sync failed unexpectedly' });
  }
};

module.exports = { handler, syncGstr2bForUser };
