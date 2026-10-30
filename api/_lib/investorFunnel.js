/**
 * api/_lib/investorFunnel.js — investor-tenant funnel for the founder ops
 * console (api/ops.js?action=investor-tenants / investor-timeline).
 *
 * Pure functions: api/ops.js loads the rows, this file shapes them. No I/O,
 * so it is unit-tested in __tests__/investorFunnel.test.js.
 *
 * Funnel (each step = the earliest time it happened, or null):
 *   invite           ops_investor_tenants.invited_at
 *   first_login      first app_open event, else the auth signup if they have ever signed in
 *   preview_watched  first preview_views play/half/end for the tenant's ref
 *   connect_started  zoho_connect_started event, or connector_logs oauth_start
 *   org_picked       zoho_org_selected ok, or connector_logs select_org success
 *   first_sync       zoho_sync ok, or connector_logs sync_all/backfill_all success|partial
 *
 * connector_logs fallbacks mean accounts that connected before the new
 * events shipped still show the right stage.
 *
 * Privacy: output carries timestamps, step names, counts, statuses and closed
 * error codes only. preview_views city / user_agent and connector_logs
 * error_message are never passed through: errors are mapped to a code.
 */

const { sanitizeEventProps, zohoErrorCode } = require('./eventSchema');

const STEPS = ['invite', 'first_login', 'preview_watched', 'connect_started', 'org_picked', 'first_sync'];
const STEP_LABEL = {
  invite: 'Invited',
  first_login: 'First login',
  preview_watched: 'Preview watched',
  connect_started: 'Connect started',
  org_picked: 'Org picked',
  first_sync: 'First sync'
};
const WATCH_EVENTS = new Set(['play', 'half', 'end']);
const PREVIEW_DEPTH = { open: 1, play: 2, half: 3, end: 4 };
// sync_item_lines / import_export_lines: item-line fill runs (API queue, Zoho export import), as counts only.
const ZOHO_OPS = new Set(['oauth_start', 'oauth_callback', 'select_org', 'sync_all', 'backfill_all', 'sync_gstr2b', 'sync_item_lines', 'import_export_lines']);

const t = (x) => (x ? new Date(x).getTime() : NaN);
function earliest(list) {
  let best = null;
  for (const x of list) if (x && !isNaN(t(x)) && (best === null || t(x) < t(best))) best = x;
  return best ? new Date(best).toISOString() : null;
}

function cleanRef(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
}

const isZohoLog = (l) => l && (l.connector_type === 'zoho_books' || l.connector_type === 'zoho');

/** Funnel steps for one tenant. */
function funnelFor(tenant, { views, events, logs, users }) {
  const uid = tenant.user_id || null;
  const ev = uid ? events.filter((e) => e.user_id === uid) : [];
  const lg = uid ? logs.filter((l) => l.user_id === uid && isZohoLog(l)) : [];
  const vw = views.filter((v) => v.ref === tenant.ref);
  const u = uid && users ? users[uid] : null;
  const okProp = (e) => e.props && e.props.ok === true;

  const steps = {
    invite: tenant.invited_at ? new Date(tenant.invited_at).toISOString() : null,
    first_login: earliest([
      ...ev.filter((e) => e.name === 'app_open').map((e) => e.at),
      u && u.last_sign_in_at ? (u.created_at || u.last_sign_in_at) : null
    ]),
    preview_watched: earliest(vw.filter((v) => WATCH_EVENTS.has(v.event)).map((v) => v.created_at)),
    connect_started: earliest([
      ...ev.filter((e) => e.name === 'zoho_connect_started').map((e) => e.at),
      ...lg.filter((l) => l.operation === 'oauth_start').map((l) => l.created_at)
    ]),
    org_picked: earliest([
      ...ev.filter((e) => e.name === 'zoho_org_selected' && okProp(e)).map((e) => e.at),
      ...lg.filter((l) => l.operation === 'select_org' && l.status === 'success').map((l) => l.created_at)
    ]),
    first_sync: earliest([
      ...ev.filter((e) => e.name === 'zoho_sync' && okProp(e)).map((e) => e.at),
      ...lg.filter((l) => (l.operation === 'sync_all' || l.operation === 'backfill_all') &&
        (l.status === 'success' || l.status === 'partial')).map((l) => l.created_at)
    ])
  };

  let reached = null;
  for (const s of STEPS) if (steps[s]) reached = s;
  // Stuck = the next step after the furthest one reached; skipped = earlier steps
  // never seen (e.g. connected without watching the preview).
  const ri = reached ? STEPS.indexOf(reached) : 0;
  const stuck_at = STEPS.slice(ri + 1).find((s) => !steps[s]) || null;
  const skipped = STEPS.slice(1, ri).filter((s) => !steps[s]);
  const depth = vw.reduce((m, v) => Math.max(m, PREVIEW_DEPTH[v.event] || 0), 0);
  const lastSync = ev.filter((e) => e.name === 'zoho_sync').sort((a, b) => t(b.at) - t(a.at))[0] || null;
  const lastActivity = [
    ...ev.map((e) => e.at), ...vw.map((v) => v.created_at), ...lg.map((l) => l.created_at)
  ].filter(Boolean).sort((a, b) => t(b) - t(a))[0] || null;

  return {
    ref: tenant.ref,
    user_id: uid,
    linked: !!uid,
    steps,
    reached,
    reached_count: STEPS.filter((s) => steps[s]).length,
    stuck_at,
    skipped,
    preview: {
      opens: vw.filter((v) => v.event === 'open').length,
      furthest: Object.keys(PREVIEW_DEPTH).find((k) => PREVIEW_DEPTH[k] === depth) || null
    },
    last_sync: lastSync ? {
      at: lastSync.at,
      ok: !!(lastSync.props && lastSync.props.ok),
      error_code: (lastSync.props && lastSync.props.error_code) || null,
      rows_synced: lastSync.props && lastSync.props.rows_synced != null ? lastSync.props.rows_synced : null
    } : null,
    last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null
  };
}

/**
 * All investor tenants: every registered tenant, plus any preview ref that
 * has views but no tenant row yet (shown unlinked, no invite time).
 */
function buildInvestorTenants({ tenants, views, events, logs, users }) {
  const all = (tenants || []).map((x) => ({ ref: cleanRef(x.ref), user_id: x.user_id || null, invited_at: x.invited_at || null }));
  const known = new Set(all.map((x) => x.ref));
  for (const v of views || []) {
    const r = cleanRef(v.ref);
    if (r && r !== 'direct' && !known.has(r)) { known.add(r); all.push({ ref: r, user_id: null, invited_at: null, from_preview_only: true }); }
  }
  const data = { views: views || [], events: events || [], logs: logs || [], users: users || {} };
  const rows = all.map((x) => Object.assign(funnelFor(x, data), { registered: !x.from_preview_only }));
  rows.sort((a, b) => (b.reached_count - a.reached_count) || (t(b.last_activity_at) || 0) - (t(a.last_activity_at) || 0));
  const totals = {};
  for (const s of STEPS) totals[s] = rows.filter((r) => r.steps[s]).length;
  return { steps: STEPS, step_labels: STEP_LABEL, totals, tenants: rows };
}

/** One tenant's ordered timeline: funnel milestones + events + preview + Zoho connector runs. */
function buildInvestorTimeline(tenant, { views, events, logs, users }) {
  const data = { views: views || [], events: events || [], logs: logs || [], users: users || {} };
  const funnel = funnelFor(tenant, data);
  const items = [];
  for (const s of STEPS) if (funnel.steps[s]) items.push({ at: funnel.steps[s], kind: 'funnel', label: STEP_LABEL[s], detail: { step: s } });
  for (const v of data.views.filter((x) => x.ref === tenant.ref)) {
    items.push({ at: v.created_at, kind: 'preview', label: 'preview_' + v.event, detail: v.country ? { country: String(v.country).slice(0, 4) } : {} });
  }
  if (tenant.user_id) {
    for (const e of data.events.filter((x) => x.user_id === tenant.user_id)) {
      // Re-filter on read: rows written before eventSchema.js may carry older props.
      items.push({ at: e.at, kind: 'event', label: e.name, detail: sanitizeEventProps(e.name, e.props || {}) });
    }
    for (const l of data.logs.filter((x) => x.user_id === tenant.user_id && isZohoLog(x) && ZOHO_OPS.has(x.operation))) {
      const failed = l.status === 'error';
      items.push({
        at: l.created_at, kind: 'connector', label: 'zoho_' + l.operation,
        detail: {
          status: l.status || null,
          rows_synced: Number.isFinite(Number(l.records_synced)) ? Number(l.records_synced) : 0,
          error_code: failed || /^gstr2b_|module_unavailable/.test(String(l.error_message || '')) ? zohoErrorCode(l.error_message || 'unexpected') : 'none'
        }
      });
    }
  }
  items.sort((a, b) => t(b.at) - t(a.at));
  return { ref: tenant.ref, user_id: tenant.user_id || null, funnel, timeline: items.slice(0, 200) };
}

module.exports = { STEPS, STEP_LABEL, cleanRef, funnelFor, buildInvestorTenants, buildInvestorTimeline };
