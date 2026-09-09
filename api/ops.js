/**
 * api/ops.js — Founder-only Ops Console v0 backend (2026-09-08-ops-console.sql).
 *
 * ONE Vercel function, dispatched by ?action= (Hobby-plan 12-function cap —
 * same reasoning as api/whatsapp.js / api/tally.js). Routes:
 *
 *   POST /api/ops?action=track                 (partner JWT)  write one product_event
 *   GET  /api/ops?action=partners              (ops allowlist) design-partner list
 *   GET  /api/ops?action=partner&userId=<id>   (ops allowlist) one partner deep dive
 *   PUT  /api/ops?action=note&userId=<id>      (ops allowlist) upsert ops_partner_notes
 *
 * AUTH
 *   - track: the partner user's own Supabase JWT (Authorization: Bearer ...).
 *   - everything else: the OPS_ADMIN gate below. If the caller is not a
 *     founder, we return 404 (NOT 403) so the surface is never advertised.
 *
 * OPS_ADMIN gate (either satisfies):
 *   - header  x-ops-secret: <OPS_ADMIN_SECRET>
 *   - Supabase JWT whose user id is in OPS_ADMIN_USER_IDS (comma-separated)
 *
 * Support mode / impersonation / partner data snapshot is OUT OF SCOPE for v0.
 * See the stub at the bottom of this file — do not build it here without a
 * fresh decision.
 *
 * Zero-npm: plain fetch() via the shared PostgREST helper.
 */

const {
  SUPABASE_URL,
  getUserFromRequest,
  selectRows,
  insertRows,
  restRequest
} = require('./_lib/supabaseRest');
const { track, ALLOWED_NAMES } = require('./_lib/track');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const hoursSince = (t) => (t ? (Date.now() - new Date(t).getTime()) / 3600000 : Infinity);

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

async function isOpsAdmin(req) {
  const secret = req.headers['x-ops-secret'] || req.headers['X-Ops-Secret'];
  if (secret && process.env.OPS_ADMIN_SECRET && secret === process.env.OPS_ADMIN_SECRET) {
    return { ok: true, by: 'secret' };
  }
  const ids = (process.env.OPS_ADMIN_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    try {
      const user = await getUserFromRequest(req);
      if (user && ids.includes(user.id)) return { ok: true, by: user.email || user.id };
    } catch (err) {
      console.error('isOpsAdmin token check failed:', err && err.message);
    }
  }
  return { ok: false };
}

function notFound(res) {
  res.status(404).json({ error: 'Not found' });
}

/* ------------------------------------------------------------------ */
/* shared data loaders                                                 */
/* ------------------------------------------------------------------ */

// id -> email, via the GoTrue admin API (service-role). Best-effort: if it
// fails we just show user ids.
async function loadUserEmails(ids) {
  const map = {};
  try {
    let page = 1;
    for (;;) {
      const res = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );
      if (!res.ok) break;
      const body = await res.json();
      const users = Array.isArray(body) ? body : (body.users || []);
      if (!users.length) break;
      for (const u of users) map[u.id] = u.email || null;
      if (users.length < 200) break;
      page += 1;
      if (page > 25) break;
    }
  } catch (err) {
    console.error('loadUserEmails failed:', err.message);
  }
  return ids ? Object.fromEntries(ids.map((i) => [i, map[i] || null])) : map;
}

const firstKey = (row, keys) => {
  for (const k of keys) if (row && row[k] != null) return row[k];
  return null;
};

// Normalise every connector table into { name, needs_reauth, last_success_at }.
function connectorRows({ credentials, zohoOrgs, shopifyStores, tallyInstalls }, userId) {
  const out = [];
  for (const r of credentials) {
    if (r.user_id !== userId) continue;
    if (r.disconnected_at) continue;
    out.push({
      name: r.connector_type,
      needs_reauth: !!r.needs_reauth,
      last_success_at: r.last_success_at || null,
      last_error_at: r.last_error_at || null
    });
  }
  for (const r of zohoOrgs) {
    if (r.user_id !== userId) continue;
    if (r.status && /disconnect|revok/i.test(r.status)) continue;
    out.push({
      name: 'zoho',
      needs_reauth: r.status === 'needs_reauth',
      last_success_at: firstKey(r, ['last_synced_at', 'last_sync_at', 'last_success_at', 'updated_at']),
      last_error_at: null
    });
  }
  for (const r of shopifyStores) {
    if (r.user_id !== userId) continue;
    if (r.status && /disconnect|revok/i.test(r.status)) continue;
    out.push({
      name: 'shopify',
      needs_reauth: !!(r.status && /reauth/i.test(r.status)),
      last_success_at: firstKey(r, ['last_synced_at', 'last_sync_at', 'last_success_at', 'updated_at']),
      last_error_at: null
    });
  }
  for (const r of tallyInstalls) {
    if (r.user_id !== userId) continue;
    if (r.status !== 'active') continue;
    out.push({
      name: 'tally',
      needs_reauth: false,
      last_success_at: r.last_sync_at || r.last_seen_at || null,
      last_error_at: null
    });
  }
  return out;
}

function countEvents(events, userId, name, sinceMs) {
  return events.filter((e) =>
    e.user_id === userId && e.name === name && new Date(e.at).getTime() >= sinceMs
  ).length;
}

/* ------------------------------------------------------------------ */
/* status / value pulse / suggested-next rules (encode exactly)        */
/* ------------------------------------------------------------------ */

function classify(p) {
  const conns = p.connectors;
  const hasConn = conns.length > 0;
  const lastSuccess = conns
    .map((c) => (c.last_success_at ? new Date(c.last_success_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const syncAgeH = lastSuccess ? (Date.now() - lastSuccess) / 3600000 : Infinity;

  const reauth = conns.filter((c) => c.needs_reauth);
  const reauthAgeH = (c) => Math.min(hoursSince(c.last_error_at), hoursSince(c.last_success_at));
  const reauthOver = (h) => reauth.some((c) => reauthAgeH(c) > h || (!c.last_error_at && !c.last_success_at));

  const events7 = p.events_7d_total;
  const quietDays = p.last_active_at ? (Date.now() - new Date(p.last_active_at).getTime()) / DAY : Infinity;

  const mismatchesAccumulating = p.recon_open_mismatches > 0 && p.recon_cleared_7d === 0;
  const usageActive = p.ask_7d > 0 || p.whatsapp_in_7d > 0 || p.whatsapp_out_7d > 0 || p.reconcile_runs_7d > 0 || events7 > 0;
  const syncFlaky = hasConn && syncAgeH > 24 && syncAgeH <= 48;
  const syncHealthy = hasConn && syncAgeH <= 48 && reauth.length === 0;

  // ---- status (reliability-first) ----
  let status;
  if (
    reauthOver(72) ||
    (hasConn && syncAgeH > 48) ||
    (hasConn && lastSuccess === 0 && quietDays > 7)
  ) {
    status = 'red';
  } else if (
    reauthOver(24) ||
    (usageActive && syncFlaky) ||
    mismatchesAccumulating
  ) {
    status = 'yellow';
  } else if (syncHealthy) {
    status = 'green';
  } else {
    status = hasConn ? 'yellow' : 'red';
  }

  // ---- value_pulse ----
  let value_pulse;
  const askWaActive = p.ask_7d > 0 || p.whatsapp_in_7d > 0 || p.whatsapp_out_7d > 0;
  const connectOnlyQuiet14 =
    hasConn &&
    p.recon_runs_14d === 0 &&
    p.ask_14d === 0 &&
    p.whatsapp_14d === 0;
  if (syncHealthy && (p.recon_cleared_7d > 0 || askWaActive)) {
    value_pulse = 'green';
  } else if ((usageActive && syncFlaky) || mismatchesAccumulating) {
    value_pulse = 'yellow';
  } else if ((quietDays > 7 && !syncHealthy) || connectOnlyQuiet14) {
    value_pulse = 'red';
  } else {
    value_pulse = 'yellow';
  }

  // ---- suggested_next (first match wins) ----
  let suggested_next;
  const reauthConn = reauth[0];
  if (reauthConn) {
    suggested_next = `Reauth ${reauthConn.name}`;
  } else if (syncHealthy && p.reconcile_runs_7d === 0 && p.reconcile_summary_view_7d === 0) {
    suggested_next = 'Push recon onboarding — sync only so far';
  } else if (p.mismatch_opened_7d >= 3 && p.mismatch_resolved_marked_7d === 0) {
    suggested_next = 'Fix resolve/ignore UX — opens without closes';
  } else if (p.whatsapp_in_7d >= 3 && p.reconcile_summary_view_7d <= 1) {
    suggested_next = 'Invest in WhatsApp answers, not dashboard chrome';
  } else if (
    (p.tally_agent_sync_7d > 0 && p.zoho_idle) ||
    (p.zoho_active && p.tally_agent_sync_7d === 0 && conns.some((c) => c.name === 'tally'))
  ) {
    suggested_next = 'Books-source UX / active ledger picker';
  } else {
    suggested_next = 'Check-in call — ask what broke last week';
  }

  return { status, value_pulse, suggested_next };
}

/* ------------------------------------------------------------------ */
/* partners list                                                       */
/* ------------------------------------------------------------------ */

async function buildPartners() {
  const since30 = Date.now() - 30 * DAY;
  const [
    events, credentials, zohoOrgs, shopifyStores, tallyInstalls, findings, notes, profiles
  ] = await Promise.all([
    selectRows('product_events', `select=user_id,name,at&at=gte.${iso(since30)}&order=at.desc&limit=20000`).catch(() => []),
    selectRows('connector_credentials', 'select=*&limit=2000').catch(() => []),
    selectRows('zoho_organizations', 'select=*&limit=2000').catch(() => []),
    selectRows('shopify_stores', 'select=*&limit=2000').catch(() => []),
    selectRows('tally_installs', 'select=*&limit=2000').catch(() => []),
    selectRows('recon_findings', 'select=user_id,status,verified_at,updated_at,first_seen_at&limit=20000').catch(() => []),
    selectRows('ops_partner_notes', 'select=*&limit=2000').catch(() => []),
    selectRows('profiles', 'select=id,company_name&limit=5000').catch(() => [])
  ]);

  const ids = new Set();
  events.forEach((e) => ids.add(e.user_id));
  credentials.forEach((r) => { if (!r.disconnected_at) ids.add(r.user_id); });
  zohoOrgs.forEach((r) => ids.add(r.user_id));
  shopifyStores.forEach((r) => ids.add(r.user_id));
  tallyInstalls.forEach((r) => { if (r.status === 'active') ids.add(r.user_id); });
  notes.forEach((r) => ids.add(r.user_id));

  const idList = [...ids].filter(Boolean);
  const emails = await loadUserEmails(idList);
  const companyById = Object.fromEntries(profiles.map((p) => [p.id, p.company_name || null]));
  const noteById = Object.fromEntries(notes.map((n) => [n.user_id, n]));

  const tables = { credentials, zohoOrgs, shopifyStores, tallyInstalls };
  const now = Date.now();
  const s7 = now - 7 * DAY;
  const s14 = now - 14 * DAY;

  const rows = idList.map((uid) => {
    const connectors = connectorRows(tables, uid);
    const f = findings.filter((r) => r.user_id === uid);
    const recon_open_mismatches = f.filter((r) => r.status === 'mismatch').length;
    const recon_verified_7d = f.filter((r) => r.status === 'verified' && r.verified_at && new Date(r.verified_at).getTime() >= s7).length;
    const recon_cleared_7d = recon_verified_7d; // v0 proxy: a finding reaching 'verified' == cleared

    const evUser = events.filter((e) => e.user_id === uid);
    const lastEventAt = evUser.map((e) => e.at).sort().pop() || null;

    const c = (name, since) => countEvents(events, uid, name, since);
    const p = {
      user_id: uid,
      label: emails[uid] || companyById[uid] || uid,
      email: emails[uid] || null,
      company_name: companyById[uid] || null,
      connectors,
      last_active_at: lastEventAt,
      recon_open_mismatches,
      recon_verified_7d,
      recon_cleared_7d,
      whatsapp_in_7d: c('whatsapp_inbound', s7),
      whatsapp_out_7d: c('whatsapp_outbound', s7),
      ask_7d: c('ask_message_sent', s7),
      reconcile_runs_7d: c('reconcile_run', s7),
      reconcile_summary_view_7d: c('reconcile_summary_view', s7),
      mismatch_opened_7d: c('mismatch_opened', s7),
      mismatch_resolved_marked_7d: c('mismatch_resolved_marked', s7),
      tally_agent_sync_7d: c('tally_agent_sync', s7),
      events_7d_total: evUser.filter((e) => new Date(e.at).getTime() >= s7).length,
      recon_runs_14d: c('reconcile_run', s14),
      ask_14d: c('ask_message_sent', s14),
      whatsapp_14d: c('whatsapp_inbound', s14) + c('whatsapp_outbound', s14),
      zoho_active: connectors.some((x) => x.name === 'zoho'),
      zoho_idle: connectors.some((x) => x.name === 'zoho') && c('reconcile_run', s7) === 0,
      note_preview: noteById[uid] ? String(noteById[uid].note || '').slice(0, 80) : null
    };
    const verdict = classify(p);
    return {
      user_id: p.user_id,
      label: p.label,
      email: p.email,
      company_name: p.company_name,
      status: verdict.status,
      value_pulse: verdict.value_pulse,
      suggested_next: verdict.suggested_next,
      last_active_at: p.last_active_at,
      connectors: connectors.map((x) => ({ name: x.name, needs_reauth: x.needs_reauth, last_success_at: x.last_success_at })),
      recon_open_mismatches: p.recon_open_mismatches,
      recon_verified_7d: p.recon_verified_7d,
      recon_cleared_7d: p.recon_cleared_7d,
      whatsapp_in_7d: p.whatsapp_in_7d,
      whatsapp_out_7d: p.whatsapp_out_7d,
      ask_7d: p.ask_7d,
      reconcile_runs_7d: p.reconcile_runs_7d,
      note_preview: p.note_preview
    };
  });

  const rank = { red: 0, yellow: 1, green: 2 };
  rows.sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    (new Date(b.last_active_at || 0) - new Date(a.last_active_at || 0))
  );
  return rows;
}

/* ------------------------------------------------------------------ */
/* one partner deep dive                                               */
/* ------------------------------------------------------------------ */

async function buildPartnerDetail(userId) {
  const now = Date.now();
  const [events, credentials, zohoOrgs, shopifyStores, tallyInstalls, findings, notes, profiles, logs] =
    await Promise.all([
      selectRows('product_events', `select=name,at,props&user_id=eq.${userId}&order=at.desc&limit=2000`).catch(() => []),
      selectRows('connector_credentials', `select=*&user_id=eq.${userId}`).catch(() => []),
      selectRows('zoho_organizations', `select=*&user_id=eq.${userId}`).catch(() => []),
      selectRows('shopify_stores', `select=*&user_id=eq.${userId}`).catch(() => []),
      selectRows('tally_installs', `select=*&user_id=eq.${userId}`).catch(() => []),
      selectRows('recon_findings', `select=*&user_id=eq.${userId}&order=first_seen_at.asc&limit=5000`).catch(() => []),
      selectRows('ops_partner_notes', `select=*&user_id=eq.${userId}`).catch(() => []),
      selectRows('profiles', `select=id,company_name&id=eq.${userId}`).catch(() => []),
      selectRows('connector_logs', `select=connector_type,operation,status,error_message,created_at&user_id=eq.${userId}&order=created_at.desc&limit=25`).catch(() => [])
    ]);

  const emails = await loadUserEmails([userId]);
  const connectors = connectorRows({ credentials, zohoOrgs, shopifyStores, tallyInstalls }, userId);

  const countBy = (sinceMs) => {
    const o = {};
    for (const n of ALLOWED_NAMES) o[n] = 0;
    for (const e of events) {
      if (new Date(e.at).getTime() >= sinceMs && o[e.name] != null) o[e.name] += 1;
    }
    return o;
  };

  const activeDays = new Set(
    events.filter((e) => new Date(e.at).getTime() >= now - 30 * DAY)
      .map((e) => new Date(e.at).toISOString().slice(0, 10))
  ).size;

  // time-to-first-mismatch: earliest connector connect -> earliest mismatch finding
  const connectAts = [
    ...credentials.map((r) => r.created_at),
    ...zohoOrgs.map((r) => firstKey(r, ['connected_at', 'created_at'])),
    ...shopifyStores.map((r) => firstKey(r, ['connected_at', 'created_at'])),
    ...tallyInstalls.map((r) => r.created_at)
  ].filter(Boolean).sort();
  const firstConnect = connectAts[0] || null;
  const firstMismatch = findings
    .filter((r) => r.status === 'mismatch')
    .map((r) => r.first_seen_at).filter(Boolean).sort()[0] || null;
  const timeToFirstMismatchHours =
    firstConnect && firstMismatch
      ? Math.max(0, Math.round((new Date(firstMismatch) - new Date(firstConnect)) / 3600000))
      : null;

  const lastSuccess = connectors
    .map((c) => (c.last_success_at ? new Date(c.last_success_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);

  return {
    user_id: userId,
    label: emails[userId] || (profiles[0] && profiles[0].company_name) || userId,
    email: emails[userId] || null,
    company_name: (profiles[0] && profiles[0].company_name) || null,
    health: {
      connectors: connectors.map((c) => ({
        name: c.name,
        needs_reauth: c.needs_reauth,
        last_success_at: c.last_success_at,
        days_since_last_sync: c.last_success_at
          ? Math.round((now - new Date(c.last_success_at).getTime()) / DAY)
          : null
      })),
      days_since_any_sync: lastSuccess ? Math.round((now - lastSuccess) / DAY) : null,
      recent_track_errors: logs.filter((l) => l.status && /error|fail/i.test(l.status)).slice(0, 10)
    },
    usage: {
      by_name_7d: countBy(now - 7 * DAY),
      by_name_30d: countBy(now - 30 * DAY),
      unique_active_days_30d: activeDays
    },
    outcomes: {
      recon_open_mismatches: findings.filter((r) => r.status === 'mismatch').length,
      recon_verified_total: findings.filter((r) => r.status === 'verified').length,
      recon_verified_7d: findings.filter((r) => r.status === 'verified' && r.verified_at && new Date(r.verified_at).getTime() >= now - 7 * DAY).length,
      first_connect_at: firstConnect,
      first_mismatch_at: firstMismatch,
      time_to_first_mismatch_hours: timeToFirstMismatchHours
    },
    timeline: events.slice(0, 50).map((e) => ({ name: e.name, at: e.at, props: e.props || {} })),
    note: notes[0] ? notes[0].note : '',
    note_updated_at: notes[0] ? notes[0].updated_at : null,
    note_updated_by: notes[0] ? notes[0].updated_by : null,
    suggested_next: (() => {
      // reuse list-level classifier on a compact projection
      const s7 = now - 7 * DAY, s14 = now - 14 * DAY;
      const c7 = countBy(s7);
      const p = {
        connectors,
        last_active_at: events[0] ? events[0].at : null,
        recon_open_mismatches: findings.filter((r) => r.status === 'mismatch').length,
        recon_cleared_7d: findings.filter((r) => r.status === 'verified' && r.verified_at && new Date(r.verified_at).getTime() >= s7).length,
        whatsapp_in_7d: c7.whatsapp_inbound, whatsapp_out_7d: c7.whatsapp_outbound,
        ask_7d: c7.ask_message_sent, reconcile_runs_7d: c7.reconcile_run,
        reconcile_summary_view_7d: c7.reconcile_summary_view,
        mismatch_opened_7d: c7.mismatch_opened, mismatch_resolved_marked_7d: c7.mismatch_resolved_marked,
        tally_agent_sync_7d: c7.tally_agent_sync,
        events_7d_total: Object.values(c7).reduce((a, b) => a + b, 0),
        recon_runs_14d: countBy(s14).reconcile_run,
        ask_14d: countBy(s14).ask_message_sent,
        whatsapp_14d: countBy(s14).whatsapp_inbound + countBy(s14).whatsapp_outbound,
        zoho_active: connectors.some((x) => x.name === 'zoho'),
        zoho_idle: connectors.some((x) => x.name === 'zoho') && c7.reconcile_run === 0
      };
      return classify(p);
    })()
  };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';

  // ---- track: partner-authed, fail-open ----
  if (action === 'track') {
    if (req.method !== 'POST') { notFound(res); return; }
    try {
      const user = await getUserFromRequest(req);
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      await track(user.id, body.name, body.props);
      res.status(202).json({ ok: true });
    } catch (err) {
      // never surface tracking failure to the product
      res.status(202).json({ ok: true });
    }
    return;
  }

  // ---- everything else: founder allowlist, 404 if not ----
  const gate = await isOpsAdmin(req);
  if (!gate.ok) { notFound(res); return; }

  try {
    if (action === 'partners' && req.method === 'GET') {
      const rows = await buildPartners();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ partners: rows, generated_at: new Date().toISOString() });
      return;
    }

    if (action === 'partner' && req.method === 'GET') {
      const userId = req.query.userId;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const detail = await buildPartnerDetail(userId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(detail);
      return;
    }

    if (action === 'note' && req.method === 'PUT') {
      const userId = req.query.userId;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const note = String(body.note == null ? '' : body.note).slice(0, 4000);
      const saved = await insertRows(
        'ops_partner_notes',
        [{ user_id: userId, note, updated_at: new Date().toISOString(), updated_by: gate.by }],
        { onConflict: 'user_id', merge: true }
      );
      res.status(200).json({ ok: true, note: saved[0] || { user_id: userId, note } });
      return;
    }

    // ---- OUT OF SCOPE v0: support mode / impersonation / full data snapshot ----
    if (action === 'support-mode' || action === 'impersonate' || action === 'snapshot') {
      // TODO(v1): decide the consent + audit-log model before building this.
      // Deliberately not implemented. Returns 404 like any unknown action.
      notFound(res);
      return;
    }

    notFound(res);
  } catch (err) {
    console.error('api/ops error:', err && err.message);
    res.status(500).json({ error: 'ops query failed' });
  }
};
