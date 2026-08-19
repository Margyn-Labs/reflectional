/**
 * api/_lib/shopify.js
 * Margyn: shared helpers for the Shopify connector.
 * Zero npm dependencies: plain fetch() only (Node 18+ global fetch on Vercel).
 *
 * Contains:
 *   - Shopify Admin REST client (cursor pagination, Retry-After aware backoff)
 *   - Thin Supabase REST helpers (service-role, server-side only)
 *   - Auth helper to resolve a Supabase user from a Bearer token
 *   - connector_logs writer
 */

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function isValidShopDomain(domain) {
  return typeof domain === 'string' && SHOP_DOMAIN_RE.test(domain.trim());
}

function normalizeShopDomain(input) {
  if (typeof input !== 'string') return null;
  var d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return isValidShopDomain(d) ? d : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/* ------------------------------------------------------------------ */
/* Shopify Admin REST client                                           */
/* ------------------------------------------------------------------ */

/**
 * One authenticated request against the Shopify Admin REST API.
 * Retries 3x. On 429 it honours the Retry-After header exactly rather than
 * guessing, per Shopify's leaky-bucket behaviour. On 5xx it backs off 1/2/4s.
 * Returns { status, body, linkHeader }.
 */
async function shopifyRequest(shopDomain, accessToken, path, opts) {
  opts = opts || {};
  // opts.unversioned = true targets /admin/<path> (e.g. oauth/access_scopes.json)
  var url = opts.unversioned
    ? 'https://' + shopDomain + '/admin/' + path.replace(/^\//, '')
    : 'https://' + shopDomain + '/admin/api/' + SHOPIFY_API_VERSION + path;
  var attempt = 0;
  var maxAttempts = 4; // initial + 3 retries

  while (attempt < maxAttempts) {
    attempt++;
    var res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
    } catch (netErr) {
      if (attempt >= maxAttempts) throw new Error('network_error: ' + netErr.message);
      await sleep(Math.pow(2, attempt - 1) * 1000);
      continue;
    }

    if (res.status === 429) {
      var retryAfter = parseFloat(res.headers.get('Retry-After') || '2');
      if (isNaN(retryAfter) || retryAfter <= 0) retryAfter = 2;
      if (attempt >= maxAttempts) {
        return { status: 429, body: null, linkHeader: null, error: 'rate_limited' };
      }
      await sleep(Math.ceil(retryAfter * 1000));
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= maxAttempts) {
        return { status: res.status, body: null, linkHeader: null, error: 'shopify_5xx' };
      }
      await sleep(Math.pow(2, attempt - 1) * 1000);
      continue;
    }

    var body = null;
    var text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = null; }
    }

    return {
      status: res.status,
      body: body,
      linkHeader: res.headers.get('Link') || res.headers.get('link') || null
    };
  }

  return { status: 0, body: null, linkHeader: null, error: 'exhausted_retries' };
}

/**
 * Shopify uses cursor pagination via the Link header:
 *   <https://shop/admin/api/2025-01/orders.json?page_info=XYZ&limit=250>; rel="next"
 * Never build page-number pagination: it silently breaks past page 1.
 * Returns the page_info token for the next page, or null.
 */
function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  var parts = linkHeader.split(',');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part.indexOf('rel="next"') === -1) continue;
    var m = part.match(/<([^>]+)>/);
    if (!m) continue;
    var pi = m[1].match(/[?&]page_info=([^&>]+)/);
    if (pi) return decodeURIComponent(pi[1]);
  }
  return null;
}

/**
 * Walk a cursor-paginated collection.
 * onPage(items) is awaited per page. Stops when: no next page, pageLimit hit,
 * or the runtime budget (deadlineMs epoch) is exceeded.
 * Returns { pages, items, nextPageInfo, timedOut }.
 */
async function paginate(shopDomain, accessToken, basePath, baseParams, collectionKey, onPage, options) {
  options = options || {};
  var pageInfo = options.startPageInfo || null;
  var deadline = options.deadlineMs || (Date.now() + 45000);
  var maxPages = options.maxPages || 100;
  var pages = 0;
  var total = 0;

  while (pages < maxPages) {
    var params;
    if (pageInfo) {
      // When paging with page_info, Shopify rejects every other filter except limit.
      params = 'limit=' + (baseParams.limit || 250) + '&page_info=' + encodeURIComponent(pageInfo);
    } else {
      var kv = [];
      for (var k in baseParams) {
        if (Object.prototype.hasOwnProperty.call(baseParams, k) && baseParams[k] !== undefined && baseParams[k] !== null) {
          kv.push(encodeURIComponent(k) + '=' + encodeURIComponent(baseParams[k]));
        }
      }
      params = kv.join('&');
    }

    var res = await shopifyRequest(shopDomain, accessToken, basePath + '?' + params);
    if (res.status !== 200) {
      var err = new Error('shopify_http_' + res.status);
      err.status = res.status;
      throw err;
    }

    var items = (res.body && res.body[collectionKey]) || [];
    pages++;
    total += items.length;
    if (items.length) await onPage(items);

    pageInfo = parseNextPageInfo(res.linkHeader);
    if (!pageInfo) return { pages: pages, items: total, nextPageInfo: null, timedOut: false };
    if (Date.now() > deadline) return { pages: pages, items: total, nextPageInfo: pageInfo, timedOut: true };
  }

  return { pages: pages, items: total, nextPageInfo: pageInfo, timedOut: true };
}

/* ------------------------------------------------------------------ */
/* Supabase REST helpers (service role, server-side only)              */
/* ------------------------------------------------------------------ */

function sbHeaders(extra) {
  var h = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  for (var k in (extra || {})) h[k] = extra[k];
  return h;
}

async function sbSelect(table, query) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
    method: 'GET',
    headers: sbHeaders()
  });
  if (!res.ok) throw new Error('supabase_select_' + table + '_' + res.status + ': ' + (await res.text()));
  return res.json();
}

async function sbInsert(table, rows, returning) {
  if (!rows || !rows.length) return [];
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=' + (returning ? 'representation' : 'minimal') }),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error('supabase_insert_' + table + '_' + res.status + ': ' + (await res.text()));
  return returning ? res.json() : [];
}

/** Upsert on a unique constraint. onConflict is a comma-separated column list. */
async function sbUpsert(table, rows, onConflict, returning) {
  if (!rows || !rows.length) return [];
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
    method: 'POST',
    headers: sbHeaders({
      'Prefer': 'resolution=merge-duplicates,return=' + (returning ? 'representation' : 'minimal')
    }),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error('supabase_upsert_' + table + '_' + res.status + ': ' + (await res.text()));
  return returning ? res.json() : [];
}

async function sbUpdate(table, query, patch) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
    method: 'PATCH',
    headers: sbHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error('supabase_update_' + table + '_' + res.status + ': ' + (await res.text()));
  return true;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/** Resolve the Supabase user from the request's Bearer token. Returns user or null. */
async function getUserFromRequest(req) {
  var auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth || auth.indexOf('Bearer ') !== 0) return null;
  var token = auth.slice(7);
  var res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) return null;
  var user = await res.json();
  return user && user.id ? user : null;
}

/* ------------------------------------------------------------------ */
/* Credentials + logging                                               */
/* ------------------------------------------------------------------ */

/** Fetch the raw access token for a store. Server-side only. Never returned to a browser. */
async function getStoreToken(store) {
  var rows = await sbSelect(
    'connector_credentials',
    'id=eq.' + store.access_token_ref + '&disconnected_at=is.null&select=access_token'
  );
  if (!rows.length || !rows[0].access_token) return null;
  return rows[0].access_token;
}

/** Audit log. Never pass a token or credential into `detail`.
 *  Matches the live connector_logs schema: connector_type, operation,
 *  status, error_message, records_synced, sync_duration_ms.
 *  There is no JSONB detail column, so `detail` is folded into
 *  error_message (only) when the event failed; records_synced is
 *  pulled from detail.orders when present (sync results carry it). */
async function logEvent(userId, event, status, detail) {
  try {
    var errorMessage = null;
    if (status === 'failed' || status === 'partial') {
      if (detail && detail.error) errorMessage = String(detail.error).slice(0, 500);
      else if (detail) errorMessage = JSON.stringify(detail).slice(0, 500);
    }
    var recordsSynced = (detail && typeof detail.orders === 'number') ? detail.orders : null;

    await sbInsert('connector_logs', [{
      user_id: userId,
      connector_type: 'shopify',
      operation: event,
      status: status,
      error_message: errorMessage,
      records_synced: recordsSynced
    }]);
  } catch (e) {
    // logging must never break a sync
  }
}

function json(res, code, payload) {
  res.setHeader('Content-Type', 'application/json');
  res.status(code).send(JSON.stringify(payload));
}

module.exports = {
  SHOPIFY_API_VERSION: SHOPIFY_API_VERSION,
  sleep: sleep,
  num: num,
  isValidShopDomain: isValidShopDomain,
  normalizeShopDomain: normalizeShopDomain,
  shopifyRequest: shopifyRequest,
  parseNextPageInfo: parseNextPageInfo,
  paginate: paginate,
  sbSelect: sbSelect,
  sbInsert: sbInsert,
  sbUpsert: sbUpsert,
  sbUpdate: sbUpdate,
  getUserFromRequest: getUserFromRequest,
  getStoreToken: getStoreToken,
  logEvent: logEvent,
  json: json
};
