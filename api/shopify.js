/**
 * api/shopify.js
 * Single router for the four non-cron Shopify endpoints, merged into one
 * Vercel serverless function to stay under the Hobby plan's 12-function
 * cap per deployment. cron-sync-shopify.js stays separate since crons
 * need their own dedicated route in vercel.json.
 *
 * Dispatch is by ?action= query param:
 *   GET  /api/shopify?action=status      (was api/shopify-status.js)
 *   POST /api/shopify?action=connect     (was api/store-shopify-credentials.js)
 *   POST /api/shopify?action=sync        (was api/sync-shopify.js)
 *   POST /api/shopify?action=disconnect  (was api/disconnect-shopify.js)
 *   GET  /api/shopify?action=cron        (was api/cron-sync-shopify.js;
 *                                          internal Vercel Cron target, still
 *                                          gated by CRON_SECRET inside the
 *                                          handler itself)
 *
 * Behavior of each action is unchanged from the original standalone
 * files — only the entry point and routing are new. Folding the cron in
 * here (rather than keeping it as its own file) frees another slot under
 * the Vercel Hobby plan's 12-function cap.
 */

const H = require('./_lib/shopify');
const { runStoreSync } = require('./_lib/shopifySync');

const CRON_MAX_CONSECUTIVE_FAILURES = 3;

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || '';

  if (req.method === 'GET' && (action === 'status' || action === '')) {
    return handleStatus(req, res);
  }
  if (req.method === 'POST' && action === 'connect') {
    return handleConnect(req, res);
  }
  if (req.method === 'POST' && action === 'sync') {
    return handleSync(req, res);
  }
  if (req.method === 'POST' && action === 'disconnect') {
    return handleDisconnect(req, res);
  }
  if (req.method === 'GET' && action === 'cron') {
    return handleCron(req, res);
  }

  return H.json(res, 400, { error: 'unknown_action', message: 'Expected ?action= one of status, connect, sync, disconnect, cron.' });
};

/* ------------------------------------------------------------------ */
/* cron — GET ?action=cron (Vercel Cron target)                       */
/* Nightly sync across every active store. Same logic as the former   */
/* standalone cron-sync-shopify.js, unchanged.                        */
/* ------------------------------------------------------------------ */
async function handleCron(req, res) {
  var auth = req.headers['authorization'] || '';
  var expected = 'Bearer ' + (process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || auth !== expected) {
    return H.json(res, 401, { error: 'unauthorized' });
  }

  var stores;
  try {
    stores = await H.sbSelect(
      'shopify_stores',
      'status=eq.active&select=*&order=last_synced_at.asc.nullsfirst&limit=50'
    );
  } catch (e) {
    return H.json(res, 500, { error: 'lookup_failed', detail: String(e.message).slice(0, 200) });
  }

  var isSunday = new Date().getUTCDay() === 0;
  var deadline = Date.now() + 280000; // stay inside a 300s maxDuration
  var results = [];
  var alerts = [];

  for (var i = 0; i < stores.length; i++) {
    if (Date.now() > deadline) break;
    var store = stores[i];
    var r = await runStoreSync(store, {
      deadlineMs: Math.min(deadline, Date.now() + 60000),
      forceVariants: isSunday
    });
    results.push(r);

    if (r.error && (store.consecutive_failures || 0) + 1 >= CRON_MAX_CONSECUTIVE_FAILURES) {
      alerts.push({ shop: store.shop_domain, user_id: store.user_id, error: r.error });
    }
  }

  if (alerts.length) {
    await H.logEvent(null, 'cron_alert', 'failed', { alerts: alerts });
  }

  return H.json(res, 200, {
    ran_at: new Date().toISOString(),
    stores_processed: results.length,
    variants_refreshed: isSunday,
    alerts: alerts.length,
    results: results
  });
}

/* ------------------------------------------------------------------ */
/* status — GET ?action=status                                        */
/* ------------------------------------------------------------------ */
async function handleStatus(req, res) {
  var user = await H.getUserFromRequest(req);
  if (!user) return H.json(res, 401, { error: 'unauthorized' });

  var stores;
  try {
    stores = await H.sbSelect(
      'shopify_stores',
      'user_id=eq.' + user.id +
      '&select=id,shop_domain,status,uses_shopify_payments,connected_at,last_synced_at,backfill_complete,last_sync_status'
    );
  } catch (e) {
    return H.json(res, 500, { error: 'lookup_failed' });
  }

  if (!stores.length) return H.json(res, 200, { connected: false, stores: [] });

  var out = [];
  for (var i = 0; i < stores.length; i++) {
    var s = stores[i];
    var counts = { orders: 0, refunds: 0, variants: 0, variants_missing_cost: 0 };

    try {
      counts.orders = await countRows('shopify_orders', 'store_id=eq.' + s.id);
      counts.variants = await countRows('shopify_variants', 'store_id=eq.' + s.id);
      counts.variants_missing_cost = await countRows('shopify_variants', 'store_id=eq.' + s.id + '&cost_per_item=is.null');
    } catch (e) { /* counts are cosmetic, never fail the card over them */ }

    var cogsPct = counts.variants
      ? Math.round(1000 * counts.variants_missing_cost / counts.variants) / 10
      : null;

    out.push({
      id: s.id,
      shop_domain: s.shop_domain,
      status: s.status,
      uses_shopify_payments: s.uses_shopify_payments,
      connected_at: s.connected_at,
      last_synced_at: s.last_synced_at,
      last_sync_status: s.last_sync_status,
      backfill_complete: s.backfill_complete,
      counts: counts,
      cogs_missing_pct: cogsPct,
      flags: (cogsPct !== null && cogsPct > 20) ? ['cogs_data_incomplete'] : []
    });
  }

  return H.json(res, 200, {
    connected: out.some(function (s) { return s.status === 'active'; }),
    stores: out
  });
}

async function countRows(table, filter) {
  var r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + table + '?' + filter + '&select=id', {
    method: 'HEAD',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'count=exact',
      'Range-Unit': 'items',
      'Range': '0-0'
    }
  });
  var cr = r.headers.get('content-range') || '';
  var total = cr.split('/')[1];
  return total && total !== '*' ? parseInt(total, 10) : 0;
}

/* ------------------------------------------------------------------ */
/* connect — POST ?action=connect                                     */
/* body: { shopDomain, accessToken }                                  */
/* ------------------------------------------------------------------ */
async function handleConnect(req, res) {
  var user;
  try {
    user = await H.getUserFromRequest(req);
  } catch (e) {
    return H.json(res, 401, { error: 'unauthorized' });
  }
  if (!user) return H.json(res, 401, { error: 'unauthorized' });

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  var shopDomain = H.normalizeShopDomain(body.shopDomain);
  var accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';

  if (!shopDomain) {
    return H.json(res, 400, {
      error: 'invalid_shop_domain',
      message: 'Enter your store domain in the form mystore.myshopify.com'
    });
  }
  if (!accessToken) {
    return H.json(res, 400, { error: 'missing_token', message: 'Paste the Admin API access token from your Custom App.' });
  }

  var test = await H.shopifyRequest(shopDomain, accessToken, '/shop.json?fields=id,name,currency');
  if (test.status === 401) {
    await H.logEvent(user.id, 'connect', 'failed', { reason: 'invalid_token', shop: shopDomain });
    return H.json(res, 401, {
      error: 'invalid_token',
      message: 'Shopify rejected that token. Reveal it again in your Custom App under API credentials, or recreate the app.'
    });
  }
  if (test.status === 403) {
    await H.logEvent(user.id, 'connect', 'failed', { reason: 'missing_scope', shop: shopDomain });
    return H.json(res, 403, {
      error: 'missing_scope',
      message: 'That token is missing required permissions. Add read_orders, read_products and read_inventory to the Custom App, then reinstall it.'
    });
  }
  if (test.status !== 200) {
    await H.logEvent(user.id, 'connect', 'failed', { reason: 'http_' + test.status, shop: shopDomain });
    return H.json(res, 502, { error: 'shopify_unreachable', message: 'Could not reach that store. Check the domain and try again.' });
  }

  var scopeRes = await H.shopifyRequest(shopDomain, accessToken, 'oauth/access_scopes.json', { unversioned: true });
  var granted = [];
  if (scopeRes.status === 200 && scopeRes.body && scopeRes.body.access_scopes) {
    granted = scopeRes.body.access_scopes.map(function (s) { return s.handle; });
    var required = ['read_orders', 'read_products', 'read_inventory'];
    var missing = required.filter(function (r) { return granted.indexOf(r) === -1; });
    if (missing.length) {
      await H.logEvent(user.id, 'connect', 'failed', { reason: 'missing_scope', missing: missing, shop: shopDomain });
      return H.json(res, 403, {
        error: 'missing_scope',
        message: 'Missing permissions: ' + missing.join(', ') + '. Add them in the Custom App configuration and reinstall.'
      });
    }
  }

  try {
    var existing = await H.sbSelect(
      'shopify_stores',
      'user_id=eq.' + user.id + '&shop_domain=eq.' + encodeURIComponent(shopDomain) + '&select=id,access_token_ref'
    );

    if (existing.length) {
      await H.sbUpdate(
        'connector_credentials',
        'id=eq.' + existing[0].access_token_ref,
        { disconnected_at: new Date().toISOString() }
      );
    }

    var cred = await H.sbInsert('connector_credentials', [{
      user_id: user.id,
      connector_type: 'shopify',
      access_token: accessToken
    }], true);

    var credId = cred[0].id;

    var storeRows = await H.sbUpsert('shopify_stores', [{
      user_id: user.id,
      shop_domain: shopDomain,
      access_token_ref: credId,
      status: 'active',
      backfill_complete: false,
      backfill_cursor: null,
      last_sync_status: null,
      last_sync_error: null,
      consecutive_failures: 0
    }], 'user_id,shop_domain', true);

    var store = storeRows[0];
    await H.logEvent(user.id, 'connect', 'ok', { shop: shopDomain, scopes: granted });

    var result = await runStoreSync(store, { deadlineMs: Date.now() + 30000, forceVariants: true });

    return H.json(res, 200, {
      connected: true,
      shop_domain: shopDomain,
      store_id: store.id,
      backfill_complete: !result.timedOut,
      synced: {
        orders: result.orders,
        refunds: result.refunds,
        variants: result.variants,
        payouts: result.payouts
      },
      flags: result.flags || []
    });

  } catch (err) {
    await H.logEvent(user.id, 'connect', 'failed', { error: String(err.message).slice(0, 500), shop: shopDomain });
    return H.json(res, 500, { error: 'store_failed', message: 'Could not save the connection. Try again.' });
  }
}

/* ------------------------------------------------------------------ */
/* sync — POST ?action=sync                                           */
/* body (optional): { storeId, forceVariants }                        */
/* ------------------------------------------------------------------ */
async function handleSync(req, res) {
  var user = await H.getUserFromRequest(req);
  if (!user) return H.json(res, 401, { error: 'unauthorized' });

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  var query = 'user_id=eq.' + user.id + '&status=eq.active&select=*';
  if (body.storeId) query = 'id=eq.' + body.storeId + '&user_id=eq.' + user.id + '&select=*';

  var stores;
  try {
    stores = await H.sbSelect('shopify_stores', query);
  } catch (e) {
    return H.json(res, 500, { error: 'lookup_failed' });
  }

  if (!stores.length) return H.json(res, 404, { error: 'no_active_store' });

  var results = [];
  var deadline = Date.now() + 45000;

  for (var i = 0; i < stores.length; i++) {
    if (Date.now() > deadline) break;
    results.push(await runStoreSync(stores[i], { deadlineMs: deadline, forceVariants: !!body.forceVariants }));
  }

  var anyIncomplete = results.some(function (r) { return r.timedOut; });

  return H.json(res, 200, {
    synced: results.length,
    backfill_in_progress: anyIncomplete,
    results: results
  });
}

/* ------------------------------------------------------------------ */
/* disconnect — POST ?action=disconnect                                */
/* body: { storeId }                                                   */
/* ------------------------------------------------------------------ */
async function handleDisconnect(req, res) {
  var user = await H.getUserFromRequest(req);
  if (!user) return H.json(res, 401, { error: 'unauthorized' });

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (!body.storeId) return H.json(res, 400, { error: 'missing_store_id' });

  var stores;
  try {
    stores = await H.sbSelect(
      'shopify_stores',
      'id=eq.' + body.storeId + '&user_id=eq.' + user.id + '&select=id,shop_domain,access_token_ref'
    );
  } catch (e) {
    return H.json(res, 500, { error: 'lookup_failed' });
  }
  if (!stores.length) return H.json(res, 404, { error: 'store_not_found' });

  var store = stores[0];

  try {
    await H.sbUpdate('connector_credentials', 'id=eq.' + store.access_token_ref, {
      access_token: null,
      disconnected_at: new Date().toISOString()
    });

    await H.sbUpdate('shopify_stores', 'id=eq.' + store.id, {
      status: 'disconnected',
      last_sync_status: null,
      last_sync_error: null
    });

    await H.logEvent(user.id, 'disconnect', 'ok', { shop: store.shop_domain });

    return H.json(res, 200, {
      disconnected: true,
      shop_domain: store.shop_domain,
      message: 'Disconnected. Your historical data stays visible. To revoke access entirely, uninstall the Margyn app in your Shopify admin under Settings then Apps.'
    });
  } catch (err) {
    return H.json(res, 500, { error: 'disconnect_failed' });
  }
}
