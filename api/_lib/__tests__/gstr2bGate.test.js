/**
 * GSTR-2B fail-closed gate — zero-dep. Run: node api/_lib/__tests__/gstr2bGate.test.js
 *
 * The ITC-at-risk figure must never read as ₹0 when it simply hasn't been read.
 * Covers: the gate itself, the sync skipping Zoho without ZOHO_GSTR2B_VALIDATED=1,
 * the vitals endpoint nulling the figure, and the prompt text saying "not available".
 * supabaseRest and zohoClient are replaced with in-memory fakes; no network.
 */
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/* ---------- fakes ---------- */
const DB = { connector_logs: [], product_events: [], zoho_gstr2b_reconciliation: [], zoho_sync_state: [] };
const cursorCalls = [];
let zohoCalls = 0;
let rpcResult = null;
const ORG = { id: 'org-1', user_id: 'u-1', status: 'active' };

const fakeRest = {
  SUPABASE_URL: 'https://test.supabase.co',
  async selectRows(table, qs) {
    if (table === 'zoho_organizations') return /backfill_completed_at/.test(qs) ? [{ backfill_completed_at: '2026-10-01T00:00:00Z' }] : [ORG];
    if (table === 'zoho_sync_state') return DB.zoho_sync_state.filter((r) => qs.indexOf('org_ref=eq.' + r.org_ref) !== -1 && /module=eq\.gstr2b/.test(qs));
    return [];
  },
  async insertRows(table, rows) { (DB[table] = DB[table] || []).push(...rows); return rows; },
  async updateRows() { return []; },
  async logConnectorEvent(e) { DB.connector_logs.push(e); },
  async getUserFromRequest() { return { id: 'u-1' }; },
  async rpc() { return rpcResult; },
  async restRequest() { return { ok: true }; }
};
require.cache[require.resolve('../supabaseRest')] = { id: 's', filename: 's', loaded: true, exports: fakeRest };

class ZohoAuthError extends Error {}
class ZohoModuleUnavailable extends Error {}
const fakeZoho = {
  ZohoAuthError, ZohoModuleUnavailable,
  createSession: () => ({ apiGetAll: async () => { zohoCalls++; return []; }, callCount: () => 0 }),
  setSyncCursor: async (orgRef, mod, wm, status) => { cursorCalls.push({ orgRef, mod, status }); },
  markNeedsReauth: async () => {},
  toNumber: (x) => Number(x) || 0
};
require.cache[require.resolve('../zohoClient')] = { id: 'z', filename: 'z', loaded: true, exports: fakeZoho };

const G = require('../gstr2bGate');
const { syncGstr2bForUser } = require('../../_zoho/sync-gstr2b');
const vitals = require('../../_zoho/vitals');

function fakeRes() {
  return { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

(async () => {
  console.log('gate');
  check('flag unset -> not validated', G.gstr2bValidated({}) === false);
  check('flag "true" is not "1" -> not validated', G.gstr2bValidated({ ZOHO_GSTR2B_VALIDATED: 'true' }) === false);
  check('flag "1" -> validated', G.gstr2bValidated({ ZOHO_GSTR2B_VALIDATED: '1' }) === true);

  const a0 = G.gstr2bAvailability({ validated: false, lastRunStatus: 'success' });
  check('not validated wins over a success status', !a0.available && a0.reason === 'not_validated', a0);
  check('validated, never ran -> not available', G.gstr2bAvailability({ validated: true }).reason === 'never_ran');
  check('validated, skipped -> module_unavailable', G.gstr2bAvailability({ validated: true, lastRunStatus: 'skipped' }).reason === 'module_unavailable');
  check('validated, not_available -> module_unavailable', G.gstr2bAvailability({ validated: true, lastRunStatus: 'not_available' }).reason === 'module_unavailable');
  check('validated, error -> sync_failed', G.gstr2bAvailability({ validated: true, lastRunStatus: 'error' }).reason === 'sync_failed');
  check('validated, success -> available', G.gstr2bAvailability({ validated: true, lastRunStatus: 'success' }).available === true);
  check('validated, partial -> available', G.gstr2bAvailability({ validated: true, lastRunStatus: 'partial' }).available === true);

  const sqlZero = { connected: true, org_ref: 'org-1', gst_leakage: { total_leakage: 0, leakage_pct: 0, vendors_not_filed: 0, filing_period: '2026-09' },
    gst_top_at_risk_vendors: [{ vendor_name: 'X', at_risk: 0 }], flags: ['gst_leakage_material', 'receivables_90_plus'] };
  const off = G.applyGstr2bGate(sqlZero, a0);
  check('not available: the SQL zero is replaced by null', off.gst_leakage === null, off.gst_leakage);
  check('not available: vendor list emptied', Array.isArray(off.gst_top_at_risk_vendors) && off.gst_top_at_risk_vendors.length === 0);
  check('not available: gst flag dropped, others kept', off.flags.join() === 'receivables_90_plus', off.flags);
  check('not available: gstr2b says why', off.gstr2b && off.gstr2b.available === false && off.gstr2b.state === 'not_available' && !!off.gstr2b.message);
  check('input is not mutated', sqlZero.gst_leakage && sqlZero.gst_leakage.total_leakage === 0);

  const on = G.applyGstr2bGate(sqlZero, G.gstr2bAvailability({ validated: true, lastRunStatus: 'success' }));
  check('available + real read: a true zero stays zero', on.gst_leakage && on.gst_leakage.total_leakage === 0 && on.gstr2b.available === true);
  const noTotal = G.applyGstr2bGate({ connected: true, gst_leakage: { total_leakage: null } }, G.gstr2bAvailability({ validated: true, lastRunStatus: 'success' }));
  check('available but SQL gave no total -> not available (no_data)', noTotal.gst_leakage === null && noTotal.gstr2b.reason === 'no_data');

  check('text: null -> Not available', G.itcAtRiskText(null) === 'Not available');
  check('text: missing total -> Not available', G.itcAtRiskText({}) === 'Not available');
  check('text: "" -> Not available', G.itcAtRiskText({ total_leakage: '' }) === 'Not available');
  check('text: a number formats', G.itcAtRiskText({ total_leakage: 1200 }, (n) => 'Rs ' + n) === 'Rs 1200');

  console.log('sync (no ZOHO_GSTR2B_VALIDATED)');
  delete process.env.ZOHO_GSTR2B_VALIDATED;
  const r = await syncGstr2bForUser('u-1');
  check('sync is skipped, not an error', r.status === 'skipped' && r.state === 'not_available' && r.reason === 'gstr2b_not_validated', r);
  check('Zoho is never called', zohoCalls === 0);
  check('nothing written to zoho_gstr2b_reconciliation', DB.zoho_gstr2b_reconciliation.length === 0);
  check('sync state recorded as not_available', cursorCalls.length === 1 && cursorCalls[0].mod === 'gstr2b' && cursorCalls[0].status === 'not_available', cursorCalls);
  const log = DB.connector_logs[DB.connector_logs.length - 1];
  check('connector log has the reason code and is not an error', log && log.operation === 'sync_gstr2b' && log.status !== 'error' && log.errorMessage === 'gstr2b_not_validated', log);
  const ev = DB.product_events.find((e) => e.name === 'zoho_gstr2b_sync');
  check('ops event recorded with safe props only', ev && ev.props.state === 'not_available' && ev.props.ok === false && Object.keys(ev.props).every((k) => ['ok', 'state', 'error_code', 'rows_synced', 'periods'].includes(k)), ev);

  console.log('sync (validated)');
  process.env.ZOHO_GSTR2B_VALIDATED = '1';
  const r2 = await syncGstr2bForUser('u-1');
  check('validated: Zoho is called for each period', zohoCalls === 3, zohoCalls);
  check('validated: run status success', r2.status === 'success', r2);
  delete process.env.ZOHO_GSTR2B_VALIDATED;

  console.log('vitals endpoint');
  rpcResult = sqlZero;
  DB.zoho_sync_state.push({ org_ref: 'org-1', module: 'gstr2b', last_run_status: 'success' });
  let res = fakeRes();
  await vitals.handler({ method: 'GET', query: {}, headers: {} }, res);
  check('vitals 200', res.code === 200, res.body);
  check('vitals: no flag -> gst_leakage null even though SQL said 0 and state says success', res.body.gst_leakage === null, res.body.gst_leakage);
  check('vitals: gstr2b.available false', res.body.gstr2b && res.body.gstr2b.available === false && res.body.gstr2b.reason === 'not_validated');
  check('vitals: briefing hints carry no ITC line', !res.body.briefing_hints.lines.some((l) => /input tax credit/i.test(l)), res.body.briefing_hints.lines);

  process.env.ZOHO_GSTR2B_VALIDATED = '1';
  rpcResult = Object.assign({}, sqlZero, { gst_leakage: { total_leakage: 54000, leakage_pct: 6, vendors_not_filed: 2, filing_period: '2026-09' } });
  res = fakeRes();
  await vitals.handler({ method: 'GET', query: {}, headers: {} }, res);
  check('vitals: validated + success -> real figure passes through', res.body.gst_leakage && res.body.gst_leakage.total_leakage === 54000 && res.body.gstr2b.available === true);
  DB.zoho_sync_state.length = 0;
  res = fakeRes();
  await vitals.handler({ method: 'GET', query: {}, headers: {} }, res);
  check('vitals: validated but never ran -> not available', res.body.gst_leakage === null && res.body.gstr2b.reason === 'never_ran');
  delete process.env.ZOHO_GSTR2B_VALIDATED;

  console.log('prompt context');
  const { formatMargynContext } = await import(path.join(__dirname, '../formatMargynContext.js'));
  const txt = (books) => JSON.stringify(formatMargynContext({ connectors: { zoho: true }, booksVitals: books }));
  const t1 = txt({ receivables: { total: 100000 }, gst_leakage: null, gstr2b: { available: false, message: 'GSTR-2B matching is not switched on yet for Zoho Books.' } });
  check('context: unavailable -> "ITC at risk: not available"', /ITC at risk: not available/.test(t1));
  check('context: unavailable -> never "ITC at risk: ₹0"', !/ITC at risk: ₹\s?0/.test(t1));
  const t2 = txt({ receivables: { total: 100000 }, gst_leakage: null });
  check('context: missing figure, no gstr2b block -> still "not available"', /ITC at risk: not available/.test(t2));
  const t3 = txt({ gst_leakage: { total_leakage: 54000, leakage_pct: 6 }, gstr2b: { available: true } });
  check('context: real figure is shown', /ITC at risk: ₹/.test(t3) && !/ITC at risk: not available/.test(t3));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
