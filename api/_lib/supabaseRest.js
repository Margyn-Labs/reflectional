/**
 * Zero-npm Supabase helpers, shared by every function under /api.
 *
 * Margyn's serverless functions use plain fetch() only (matching the existing
 * api/briefing.js pattern) — no @supabase/supabase-js or other npm import.
 * Everything here talks to Supabase's PostgREST (`/rest/v1/...`) and Auth
 * (`/auth/v1/...`) HTTP APIs directly.
 *
 * Written as CommonJS (module.exports / require) to match Vercel's default
 * Node.js function runtime. If Margyn's existing /api files use ESM
 * (import/export) instead, convert this file to match before deploying —
 * check api/briefing.js first.
 *
 * Required env vars (set in Vercel dashboard):
 *   SUPABASE_URL              e.g. https://lmegnxrixlrvyodqfthn.supabase.co
 *   SUPABASE_ANON_KEY         used only to verify a user's JWT
 *   SUPABASE_SERVICE_ROLE_KEY used for all data reads/writes (bypasses RLS —
 *                             every query below filters by user_id explicitly)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function assertEnv() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are not configured');
  }
}

/**
 * Resolve the calling user from an `Authorization: Bearer <access_token>`
 * header by asking Supabase Auth to verify it. Returns the user object
 * (`{ id, email, ... }`) or null if the token is missing/invalid.
 */
async function getUserFromRequest(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const accessToken = authHeader.slice('Bearer '.length);

  if (!SUPABASE_URL || !ANON_KEY) {
    throw new Error('Supabase environment variables are not configured');
  }

  // The app makes a dozen calls on open, each verified with Supabase Auth (~150-300 ms apiece). A token this
  // instance verified in the last minute is taken as verified; the team check (accountFor) still runs every time.
  const tk = require('crypto').createHash('sha256').update(accessToken).digest('hex');
  const hit = _verified.get(tk);
  if (hit && Date.now() - hit.at < VERIFIED_MS) return accountFor(req, hit.user);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) return null;
  const user = await res.json();
  if (user && user.id) {
    _verified.set(tk, { at: Date.now(), user });
    while (_verified.size > 500) _verified.delete(_verified.keys().next().value);
  }
  return accountFor(req, user);
}
const VERIFIED_MS = 60 * 1000;
const _verified = new Map();   // sha256(access token) -> { at, user }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Team logins (2026-09-29). The app sends X-Margyn-Account when the person
 * signed in is working in someone else's account. Every endpoint then acts
 * on that account: the returned user's `id` is the ACCOUNT, `auth_id` is the
 * person, and `member` carries their role and permissions. A header that
 * doesn't match an active membership, or a call the person's role doesn't
 * allow (teamAccess.memberMayCall), is refused: null, which every endpoint
 * already answers with 401. No header = the login's own account, as before.
 */
async function accountFor(req, user) {
  if (!user || !user.id) return null;
  const hdr = (req.headers && (req.headers['x-margyn-account'] || req.headers['X-Margyn-Account'])) || '';
  const want = String(hdr).trim();
  if (!want || want === user.id) return user;
  if (!UUID_RE.test(want)) return null;
  let rows;
  try {
    rows = await selectRows('account_members',
      `select=id,role,permissions,name&account_id=eq.${want}&user_id=eq.${user.id}&status=eq.active&limit=1`);
  } catch (e) {
    return null;   // no team table yet: a membership can't be honoured
  }
  if (!rows.length) return null;
  const { effectivePermissions, memberMayCall } = require('./teamAccess');
  const m = rows[0];
  const permissions = effectivePermissions(m.role, m.permissions);
  if (!memberMayCall(req, permissions)) return null;
  return { ...user, id: want, auth_id: user.id, member: { id: m.id, role: m.role, name: m.name || null, permissions } };
}

/**
 * Low-level PostgREST request using the service-role key. Bypasses RLS —
 * callers MUST scope every query with `user_id=eq.<id>` themselves.
 */
async function restRequest(path, { method = 'GET', body, headers = {} } = {}) {
  assertEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return res;
}

/** Insert one or more rows. Returns the inserted rows. */
async function insertRows(table, rows, { onConflict, merge = false } = {}) {
  let path = table;
  const headers = { Prefer: 'return=representation' };
  if (onConflict) {
    path += `?on_conflict=${onConflict}`;
    headers.Prefer = merge
      ? 'resolution=merge-duplicates,return=representation'
      : 'resolution=ignore-duplicates,return=representation';
  }
  const res = await restRequest(path, { method: 'POST', body: rows, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Insert into ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Update rows matching a PostgREST filter string, e.g. "user_id=eq.<id>". */
async function updateRows(table, filter, patch) {
  const res = await restRequest(`${table}?${filter}`, {
    method: 'PATCH',
    body: patch,
    headers: { Prefer: 'return=representation' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update on ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Select rows matching a PostgREST query string, e.g. "select=*&user_id=eq.<id>". */
async function selectOnce(table, query) {
  const res = await restRequest(`${table}?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Select on ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// PostgREST on this project answers at most 1,000 rows per request, whatever `limit=` asks for. Readers
// asking for limit=2000/5000/20000 (reconciliation's Tally sales, Razorpay payments, Odoo, Zoho's
// deleted-at-source sweep, the WhatsApp agent...) were silently getting the first 1,000 (4 Oct 2026).
const ROW_CEILING = 1000;
const AUTO_PAGE_MAX = 100000;

/**
 * Rows matching a query. Asks beyond the 1,000-row ceiling are paged transparently: `limit=N` above
 * 1,000 returns up to N rows; no limit returns every row (up to 100,000), paging only when the first
 * page comes back full. A query that sets its own `offset=` is a single request, as before.
 */
async function selectRows(table, query) {
  const q = String(query || '');
  const lm = /(?:^|&)limit=(\d+)(?=&|$)/.exec(q);
  const want = lm ? parseInt(lm[1], 10) : null;
  if (/(?:^|&)offset=\d+/.test(q) || (want != null && want <= ROW_CEILING)) return selectOnce(table, q);
  const base = q.replace(/(?:^|&)limit=\d+(?=&|$)/, '').replace(/^&/, '');
  const cap = want != null ? want : AUTO_PAGE_MAX;
  // Paging needs a stable order; most tables have an id to break ties.
  let ordered = /(?:^|&)order=/.test(base) ? base : (base ? base + '&' : '') + 'order=id.asc';
  const rows = [];
  for (let offset = 0; offset < cap; offset += ROW_CEILING) {
    const n = Math.min(ROW_CEILING, cap - offset);
    let page;
    try { page = await selectOnce(table, `${ordered}${ordered ? '&' : ''}limit=${n}&offset=${offset}`); }
    catch (e) {
      // No id column to order by: page without it (still far better than stopping at 1,000).
      if (offset === 0 && ordered !== base && /column .*id.* does not exist|failed to parse order/i.test(e.message)) { ordered = base; offset -= ROW_CEILING; continue; }
      throw e;
    }
    rows.push(...page);
    if (page.length < n) break;
    if (want == null && offset + ROW_CEILING >= AUTO_PAGE_MAX) console.warn(`[supabaseRest] ${table}: stopped at ${AUTO_PAGE_MAX} rows`);
  }
  return rows;
}

/**
 * Every row matching a query, paged 1,000 at a time (PostgREST's own
 * per-request ceiling), up to `max`. `query` must not carry limit/offset
 * and needs a stable `order=` so pages don't overlap.
 * Returns { rows, truncated } — truncated means more than `max` rows exist,
 * so the caller can say "latest N of more" instead of a silently short total.
 */
async function selectAllRows(table, query, { pageSize = 1000, max = 20000 } = {}) {
  const rows = [];
  for (let offset = 0; offset <= max; offset += pageSize) {
    const page = await selectRows(table, `${query}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.length > max ? { rows: rows.slice(0, max), truncated: true } : { rows, truncated: false };
}

/** Call a Postgres function exposed via PostgREST (`/rest/v1/rpc/<name>`). */
async function rpc(fnName, args) {
  const res = await restRequest(`rpc/${fnName}`, { method: 'POST', body: args });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${fnName} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Write one row to connector_logs. Never throws — logging must not break a sync. */
async function logConnectorEvent({ userId, connectorType, operation, status, errorMessage, recordsSynced, syncDurationMs }) {
  try {
    await insertRows('connector_logs', [{
      user_id: userId,
      connector_type: connectorType,
      operation,
      status,
      error_message: errorMessage || null,
      records_synced: recordsSynced || 0,
      sync_duration_ms: syncDurationMs != null ? Math.round(syncDurationMs) : null
    }]);
  } catch (err) {
    console.error('Failed to write connector_logs entry:', err.message);
  }
}

/**
 * Set durable connector sync-status on connector_credentials (added by
 * 2026-09-04-provenance-connector-status.sql). Never throws — a status
 * write must not break a sync. Patches the one active row for
 * user+connector (disconnected_at IS NULL).
 *
 * Pass only the fields you want to change:
 *   { needsReauth, lastSuccessAt, lastErrorAt, lastErrorCode, lastSyncStatus }
 */
async function setConnectorStatus(userId, connectorType, patch = {}) {
  const map = {
    needsReauth: 'needs_reauth',
    lastSuccessAt: 'last_success_at',
    lastErrorAt: 'last_error_at',
    lastErrorCode: 'last_error_code',
    lastSyncStatus: 'last_sync_status'
  };
  const body = {};
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) body[col] = patch[k];
  }
  if (!Object.keys(body).length) return;
  try {
    await updateRows(
      'connector_credentials',
      `user_id=eq.${userId}&connector_type=eq.${connectorType}&disconnected_at=is.null`,
      body
    );
  } catch (err) {
    console.error(`Failed to set ${connectorType} connector status:`, err.message);
  }
}

module.exports = {
  SUPABASE_URL,
  getUserFromRequest,
  restRequest,
  insertRows,
  updateRows,
  selectRows,
  selectAllRows,
  accountFor,
  rpc,
  logConnectorEvent,
  setConnectorStatus
};
