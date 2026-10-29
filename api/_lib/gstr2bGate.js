/**
 * api/_lib/gstr2bGate.js — fail-closed gate for the Zoho GSTR-2B / ITC-at-risk figure.
 *
 * api/_zoho/sync-gstr2b.js reads a Zoho endpoint whose path has never been
 * validated against a real org (see the caveat in that file). Until someone
 * has checked it against a sandbox org and set ZOHO_GSTR2B_VALIDATED=1, the
 * sync is skipped and every reader treats the figure as NOT AVAILABLE.
 *
 * The failure this prevents: the zoho_vitals() SQL sums an empty
 * zoho_gstr2b_reconciliation table to 0, and the app / briefing / WhatsApp
 * answer then says "₹0 of input credit at risk", which reads as a clean bill
 * of health. "We don't know" must never render as "nothing at risk".
 *
 * Available only when BOTH hold:
 *   1. ZOHO_GSTR2B_VALIDATED=1 in the environment, and
 *   2. the last gstr2b run for the org (zoho_sync_state.module='gstr2b')
 *      finished 'success' or 'partial'.
 * Anything else (no flag, never ran, skipped, module unavailable, error,
 * unreadable state) is not available.
 *
 * Zero-npm, no I/O except readGstr2bAvailability (takes selectRows as a dep).
 */

const NOT_AVAILABLE_LABEL = 'Not available';

// Reasons are a closed set: they are shown in the UI / briefing and logged.
const REASONS = {
  not_validated: 'GSTR-2B matching is not switched on yet for Zoho Books.',
  never_ran: 'GSTR-2B has not been read from Zoho Books yet.',
  module_unavailable: 'This Zoho Books organization does not expose GSTR-2B matching.',
  sync_failed: 'The last GSTR-2B read from Zoho Books failed.',
  no_data: 'Zoho Books returned no GSTR-2B figure.'
};

function gstr2bValidated(env) {
  const e = env || process.env;
  return String(e.ZOHO_GSTR2B_VALIDATED || '').trim() === '1';
}

/**
 * @param {{ validated: boolean, lastRunStatus?: string|null }} o
 * @returns {{ available: boolean, state: string, reason: string|null, message: string|null }}
 */
function gstr2bAvailability(o) {
  const validated = !!(o && o.validated);
  const status = o && o.lastRunStatus ? String(o.lastRunStatus) : null;
  const no = (reason) => ({ available: false, state: 'not_available', reason, message: REASONS[reason] });
  if (!validated) return no('not_validated');
  if (!status) return no('never_ran');
  if (status === 'skipped' || status === 'not_available' || status === 'module_unavailable') return no('module_unavailable');
  if (status !== 'success' && status !== 'partial') return no('sync_failed');
  return { available: true, state: 'available', reason: null, message: null };
}

/** Reads zoho_sync_state for the org. Never throws: an unreadable state is "not available". */
async function readGstr2bAvailability(selectRows, orgRef, env) {
  const validated = gstr2bValidated(env);
  if (!validated || !orgRef) return gstr2bAvailability({ validated, lastRunStatus: null });
  let lastRunStatus = null;
  try {
    const rows = await selectRows('zoho_sync_state', `select=last_run_status&org_ref=eq.${orgRef}&module=eq.gstr2b&limit=1`);
    lastRunStatus = rows && rows[0] ? rows[0].last_run_status : null;
  } catch (err) {
    console.error('[gstr2bGate] could not read sync state:', err && err.message);
  }
  return gstr2bAvailability({ validated, lastRunStatus });
}

/**
 * Applies the gate to a zoho_vitals payload. When not available:
 *   gst_leakage -> null, gst_top_at_risk_vendors -> [], the
 *   'gst_leakage_material' flag dropped, and gstr2b = { available:false, ... }.
 * When available but the SQL produced no total, it is still "not available"
 * (no_data) rather than a silent 0.
 * Returns a new object; the input is not mutated.
 */
function applyGstr2bGate(vitals, availability) {
  if (!vitals || typeof vitals !== 'object') return vitals;
  let a = availability || gstr2bAvailability({ validated: false });
  const g = vitals.gst_leakage;
  const hasTotal = g && g.total_leakage != null && g.total_leakage !== '' && isFinite(Number(g.total_leakage));
  if (a.available && !hasTotal) a = { available: false, state: 'not_available', reason: 'no_data', message: REASONS.no_data };
  if (a.available) return Object.assign({}, vitals, { gstr2b: a });
  const flags = Array.isArray(vitals.flags) ? vitals.flags.filter((f) => !/^gst_leakage/.test(String(f))) : vitals.flags;
  return Object.assign({}, vitals, {
    gst_leakage: null,
    gst_top_at_risk_vendors: [],
    flags,
    gstr2b: a
  });
}

/**
 * One wording for "ITC at risk" everywhere text is built server-side.
 * A missing / null / non-numeric figure is "Not available", never ₹0.
 */
function itcAtRiskText(gstLeakage, fmt) {
  const v = gstLeakage && gstLeakage.total_leakage;
  if (v == null || v === '' || !isFinite(Number(v))) return NOT_AVAILABLE_LABEL;
  return fmt ? fmt(Number(v)) : String(Number(v));
}

module.exports = {
  NOT_AVAILABLE_LABEL,
  REASONS,
  gstr2bValidated,
  gstr2bAvailability,
  readGstr2bAvailability,
  applyGstr2bGate,
  itcAtRiskText
};
