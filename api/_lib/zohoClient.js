/**
 * Shared Zoho Books client. Zero-npm — plain fetch() + node:crypto only,
 * matching the api/briefing.js and api/_lib/supabaseRest.js pattern.
 *
 * Everything region-, token-, and rate-limit-sensitive lives here so the
 * sync functions can't get it wrong individually.
 *
 * Hard rules enforced in this file (from zoho-books-auth-flow):
 *   - Authorization header is `Zoho-oauthtoken <token>`, NEVER `Bearer`.
 *   - `api_domain` / `accounts_domain` are read from the DB per org.
 *     There is no hardcoded zohoapis.com / accounts.zoho.com fallback.
 *   - Every API call carries `organization_id` as a query param.
 *   - Access token is held in memory for the life of the invocation and
 *     refreshed proactively at 50 minutes, not reactively on a 401.
 *   - Refresh token is read from Supabase vault on demand and never logged.
 *
 * Required env vars (Vercel):
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REDIRECT_URI      e.g. https://app.margynlabs.com/api/zoho-oauth-callback
 *   ZOHO_STATE_SECRET      random 32+ char string, signs the OAuth state param
 *   ZOHO_GSTR2B_PATH       optional override, default books/v3/gstreports/2b/reconciliation
 */

const crypto = require('crypto');
const { rpc, selectRows, updateRows, insertRows } = require('./supabaseRest');

// --------------------------------------------------------------- config

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const STATE_SECRET = process.env.ZOHO_STATE_SECRET;

/**
 * Read-only, per-module scopes. Margyn never writes to a customer's books,
 * so no CREATE / UPDATE / DELETE / ALL scope appears anywhere. There is no
 * "fullaccess" scope in Zoho Books and none is requested.
 */
const SCOPES = [
  'ZohoBooks.invoices.READ',
  'ZohoBooks.bills.READ',
  'ZohoBooks.customerpayments.READ',
  'ZohoBooks.vendorpayments.READ',
  'ZohoBooks.banking.READ',
  'ZohoBooks.settings.READ',
  'ZohoBooks.contacts.READ'
].join(',');

/**
 * Zoho data centres. The owner picks one at connect time (UI defaults to
 * 'in'); this only determines where consent + token exchange happen. The
 * API base URL always comes from the token response's `api_domain`.
 */
const ACCOUNTS_DOMAINS = {
  in: 'https://accounts.zoho.in',
  com: 'https://accounts.zoho.com',
  eu: 'https://accounts.zoho.eu',
  au: 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  ca: 'https://accounts.zohocloud.ca',
  sa: 'https://accounts.zoho.sa',
  uk: 'https://accounts.zoho.uk'
};
const DEFAULT_REGION = 'in';

const PER_PAGE = 200;             // Zoho max; minimises calls against the 100/min ceiling
const MAX_PAGES = 200;            // safety cap (40,000 records per module per run)
const PAGE_DELAY_MS = 700;        // ~85 req/min, comfortably under the 100/min per-org limit
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const TOKEN_TTL_MS = 50 * 60 * 1000;  // proactive refresh at 50 min of a 60 min token

const DAILY_CAP_BY_PLAN = {
  free: 1000, standard: 2000, professional: 5000,
  premium: 10000, elite: 10000, ultimate: 10000
};

// --------------------------------------------------------------- errors

class ZohoAuthError extends Error {}          // refresh token dead -> needs_reauth
class ZohoModuleUnavailable extends Error {}  // module not on this plan / not enabled

// --------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function accountsDomainForRegion(region) {
  return ACCOUNTS_DOMAINS[(region || DEFAULT_REGION).toLowerCase()] || ACCOUNTS_DOMAINS[DEFAULT_REGION];
}

/**
 * Resolve the accounts domain from what Zoho ACTUALLY tells us on the
 * callback, falling back to what the owner picked in the connect UI.
 *
 * With Multi-DC enabled, Zoho appends `location` (e.g. "in") and
 * `accounts-server` (e.g. "https://accounts.zoho.in") to the redirect. Those
 * describe the user's real data centre, so they beat the dropdown — a
 * customer who leaves it on the default still lands on the right DC.
 *
 * `accounts-server` arrives from a redirect, so it is validated against the
 * known-domain allowlist rather than trusted. An unrecognised value is
 * discarded, not followed.
 */
function resolveAccountsDomain({ accountsServer, location, fallbackRegion }) {
  if (accountsServer) {
    const normalised = String(accountsServer).replace(/\/+$/, '').toLowerCase();
    for (const key of Object.keys(ACCOUNTS_DOMAINS)) {
      if (ACCOUNTS_DOMAINS[key].toLowerCase() === normalised) return ACCOUNTS_DOMAINS[key];
    }
    // Unknown host: ignore it. Never fetch a domain we did not ship.
  }
  if (location && ACCOUNTS_DOMAINS[String(location).toLowerCase()]) {
    return ACCOUNTS_DOMAINS[String(location).toLowerCase()];
  }
  return accountsDomainForRegion(fallbackRegion);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

/** HMAC-signed, 10-minute state param. Carries the user id + chosen region. */
function signState(payload) {
  if (!STATE_SECRET) throw new Error('ZOHO_STATE_SECRET is not configured');
  const body = b64url(JSON.stringify({ ...payload, ts: Date.now() }));
  const sig = b64url(crypto.createHmac('sha256', STATE_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (!STATE_SECRET) throw new Error('ZOHO_STATE_SECRET is not configured');
  if (typeof state !== 'string' || state.indexOf('.') === -1) return null;
  const idx = state.lastIndexOf('.');
  const body = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  const expected = b64url(crypto.createHmac('sha256', STATE_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(body));
  } catch {
    return null;
  }
  if (!parsed.ts || Date.now() - parsed.ts > 10 * 60 * 1000) return null;
  return parsed;
}

/** Zoho wants dates as YYYY-MM-DDTHH:mm:ss+05:30 style local time, not Z. */
function toZohoTimestamp(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0000`;
}

function toDateOnly(value) {
  if (!value) return null;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function toNumber(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// --------------------------------------------------------- OAuth: consent

function buildAuthorizeUrl({ userId, region }) {
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new Error('ZOHO_CLIENT_ID / ZOHO_REDIRECT_URI are not configured');
  }
  const accountsDomain = accountsDomainForRegion(region);
  const params = new URLSearchParams({
    scope: SCOPES,
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent',
    state: signState({ uid: userId, region: (region || DEFAULT_REGION).toLowerCase() })
  });
  return {
    url: `${accountsDomain}/oauth/v2/auth?${params.toString()}`,
    accountsDomain
  };
}

/**
 * Exchange the authorization code. Must be called immediately in the
 * callback handler — the code is single-use and expires in 2 minutes.
 */
async function exchangeCodeForTokens(code, accountsDomain) {
  const params = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const res = await fetch(`${accountsDomain}/oauth/v2/token?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const data = await res.json().catch(() => ({}));

  // Zoho returns HTTP 200 with an { error } body on failure.
  if (!res.ok || data.error) {
    throw new ZohoAuthError(`Token exchange failed: ${data.error || res.status}`);
  }
  if (!data.refresh_token) {
    // Almost always a missing access_type=offline, or a code that was reused.
    throw new ZohoAuthError('Zoho did not return a refresh_token (authorization code may have expired or been reused)');
  }
  if (!data.api_domain) {
    throw new ZohoAuthError('Zoho did not return an api_domain');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    apiDomain: data.api_domain.replace(/\/+$/, ''),
    expiresIn: data.expires_in || 3600
  };
}

async function refreshAccessToken(refreshToken, accountsDomain) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await fetch(`${accountsDomain}/oauth/v2/token?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const data = await res.json().catch(() => ({}));

  if (data.error === 'invalid_grant' || data.error === 'invalid_code') {
    // Owner revoked in Zoho, or the 20-refresh-token cap evicted ours.
    throw new ZohoAuthError('invalid_grant');
  }
  if (!res.ok || !data.access_token) {
    throw new ZohoAuthError(`Token refresh failed: ${data.error || res.status}`);
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in || 3600 };
}

/** Revoke the refresh token at Zoho. Best-effort — never blocks disconnect. */
async function revokeRefreshToken(refreshToken, accountsDomain) {
  try {
    const params = new URLSearchParams({ token: refreshToken });
    const res = await fetch(`${accountsDomain}/oauth/v2/token/revoke?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.ok;
  } catch (err) {
    console.error('Zoho token revocation failed (continuing with local purge)');
    return false;
  }
}

// ------------------------------------------------------------ vault I/O

async function storeRefreshToken(orgRef, refreshToken) {
  await rpc('zoho_vault_store', { p_org_ref: orgRef, p_token: refreshToken });
}

async function readRefreshToken(orgRef) {
  const token = await rpc('zoho_vault_get', { p_org_ref: orgRef });
  // PostgREST returns a bare JSON scalar for a scalar-returning function.
  const value = typeof token === 'string' ? token : (token && token.zoho_vault_get) || null;
  if (!value) throw new ZohoAuthError('No refresh token stored for this organization');
  return value;
}

async function purgeRefreshToken(orgRef) {
  await rpc('zoho_vault_purge', { p_org_ref: orgRef });
}

// ------------------------------------------------------------- session

/**
 * A per-invocation token session. The access token lives only in this
 * closure — it is never written to Supabase, never logged, never returned
 * to the client. Refreshed proactively once it is 50 minutes old.
 */
function createSession(org) {
  const state = { accessToken: null, obtainedAt: 0, refreshToken: null, calls: 0 };

  async function getAccessToken() {
    const age = Date.now() - state.obtainedAt;
    if (state.accessToken && age < TOKEN_TTL_MS) return state.accessToken;

    if (!state.refreshToken) {
      state.refreshToken = await readRefreshToken(org.id);
    }
    const { accessToken } = await refreshAccessToken(state.refreshToken, org.accounts_domain);
    state.accessToken = accessToken;
    state.obtainedAt = Date.now();

    // Fire-and-forget health timestamp; failure here must not break a sync.
    updateRows('zoho_organizations', `id=eq.${org.id}`, {
      last_token_refresh: new Date().toISOString()
    }).catch(() => {});

    return accessToken;
  }

  /** Seed the session with a token we already have (activation path). */
  function seed(accessToken, refreshToken) {
    state.accessToken = accessToken;
    state.refreshToken = refreshToken;
    state.obtainedAt = Date.now();
  }

  function callCount() {
    return state.calls;
  }

  /**
   * One authenticated Zoho API call.
   * `path` is relative, e.g. 'books/v3/invoices'. `organization_id` is
   * injected here so no caller can forget it.
   */
  async function apiGet(path, query = {}) {
    const token = await getAccessToken();
    const params = new URLSearchParams({
      organization_id: org.organization_id,   // required on EVERY Zoho Books call
      ...query
    });
    const url = `${org.api_domain}/${path.replace(/^\/+/, '')}?${params.toString()}`;

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res;
      try {
        state.calls++;
        res = await fetch(url, {
          headers: {
            // Zoho Books requires this exact prefix. `Bearer` fails.
            Authorization: `Zoho-oauthtoken ${token}`,
            Accept: 'application/json'
          }
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) { await sleep(BACKOFF_MS[attempt]); continue; }
        throw new Error(`Network error calling Zoho: ${err.message}`);
      }

      if (res.status === 401) {
        // Should be rare given the 50-min proactive refresh. Refresh once and retry.
        if (attempt < MAX_RETRIES) {
          state.accessToken = null;
          state.obtainedAt = 0;
          const fresh = await getAccessToken();
          return apiGetWithToken(url, fresh);
        }
        throw new ZohoAuthError('Zoho returned 401 after refresh');
      }

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) { await sleep(BACKOFF_MS[attempt] * 2); continue; }
        throw new Error('Zoho rate limit exceeded after retries');
      }

      if (res.status === 404 || res.status === 400) {
        const body = await res.text();
        // 400 with a "not available"/plan message, or 404, means the module
        // isn't enabled for this org — a data condition, not a failure.
        if (res.status === 404 || /not\s*(be\s*)?(available|enabled|supported)|upgrade|plan/i.test(body)) {
          throw new ZohoModuleUnavailable(`Zoho module unavailable at ${path} (${res.status})`);
        }
        throw new Error(`Zoho ${res.status} at ${path}: ${body.slice(0, 300)}`);
      }

      if (res.status >= 500) {
        lastError = new Error(`Zoho returned ${res.status}`);
        if (attempt < MAX_RETRIES) { await sleep(BACKOFF_MS[attempt]); continue; }
        throw lastError;
      }

      if (!res.ok) throw new Error(`Zoho returned ${res.status} at ${path}`);
      return res.json();
    }
    throw lastError || new Error('Zoho request failed after retries');
  }

  async function apiGetWithToken(url, token) {
    state.calls++;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Zoho retry returned ${res.status}`);
    return res.json();
  }

  /**
   * Paginate a Zoho collection endpoint. Sequential only — Zoho allows 5-10
   * concurrent calls per org and parallelising inside one org's sync is the
   * fastest way to trip the limit.
   */
  async function apiGetAll(path, collectionKey, query = {}) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await apiGet(path, { ...query, page: String(page), per_page: String(PER_PAGE) });
      const batch = data[collectionKey] || [];
      out.push(...batch);
      const ctx = data.page_context || {};
      if (!ctx.has_more_page || batch.length === 0) break;
      await sleep(PAGE_DELAY_MS);
    }
    return out;
  }

  return { apiGet, apiGetAll, getAccessToken, seed, callCount };
}

// ---------------------------------------------------------- org helpers

/** List every Zoho Books org this token can see. Drives the org picker. */
async function listOrganizations(apiDomain, accessToken) {
  const res = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new ZohoAuthError(`Could not list Zoho organizations (${res.status})`);
  }
  const data = await res.json();
  return (data.organizations || []).map((o) => ({
    organization_id: o.organization_id,
    name: o.name,
    plan_type: (o.plan_name || o.plan_type || '').toString().toLowerCase() || null,
    currency_code: o.currency_code || 'INR',
    is_default: !!o.is_default_org,
    country: o.country || null
  }));
}

async function getActiveOrgForUser(userId) {
  const rows = await selectRows(
    'zoho_organizations',
    'select=*&user_id=eq.' + userId + '&status=in.(active,needs_reauth)&order=connected_at.desc&limit=1'
  );
  return rows[0] || null;
}

async function getSyncCursor(orgRef, moduleName) {
  const rows = await selectRows(
    'zoho_sync_state',
    `select=last_synced_at&org_ref=eq.${orgRef}&module=eq.${moduleName}&limit=1`
  );
  return rows[0] ? rows[0].last_synced_at : null;
}

async function setSyncCursor(orgRef, moduleName, watermarkIso, status) {
  try {
    await insertRows('zoho_sync_state', [{
      org_ref: orgRef,
      module: moduleName,
      last_synced_at: watermarkIso,
      last_run_at: new Date().toISOString(),
      last_run_status: status
    }], { onConflict: 'org_ref,module', merge: true });
  } catch (err) {
    console.error(`Failed to persist sync cursor for ${moduleName}`);
  }
}

async function markNeedsReauth(orgRef) {
  try {
    await updateRows('zoho_organizations', `id=eq.${orgRef}`, { status: 'needs_reauth' });
  } catch (err) {
    console.error('Failed to mark org needs_reauth');
  }
}

function dailyCapFor(planType) {
  return DAILY_CAP_BY_PLAN[(planType || '').toLowerCase()] || 1000;
}

module.exports = {
  SCOPES,
  ACCOUNTS_DOMAINS,
  DEFAULT_REGION,
  PER_PAGE,
  ZohoAuthError,
  ZohoModuleUnavailable,
  accountsDomainForRegion,
  resolveAccountsDomain,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeRefreshToken,
  signState,
  verifyState,
  storeRefreshToken,
  readRefreshToken,
  purgeRefreshToken,
  createSession,
  listOrganizations,
  getActiveOrgForUser,
  getSyncCursor,
  setSyncCursor,
  markNeedsReauth,
  dailyCapFor,
  toZohoTimestamp,
  toDateOnly,
  toNumber,
  sleep
};
