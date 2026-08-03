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

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) return null;
  return res.json();
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
async function selectRows(table, query) {
  const res = await restRequest(`${table}?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Select on ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
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

module.exports = {
  SUPABASE_URL,
  getUserFromRequest,
  restRequest,
  insertRows,
  updateRows,
  selectRows,
  rpc,
  logConnectorEvent
};
