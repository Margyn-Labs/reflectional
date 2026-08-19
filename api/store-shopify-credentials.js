/**
 * api/store-shopify-credentials.js
 * Connect a Shopify store using a Custom App Admin API access token.
 *
 * POST body: { shopDomain: "mystore.myshopify.com", accessToken: "shpat_..." }
 * Header:    Authorization: Bearer <supabase user access token>
 *
 * The token is validated against Shopify before anything is written, stored in
 * connector_credentials (service-role read only, no client SELECT policy), and
 * referenced from shopify_stores.access_token_ref. The raw token never touches
 * shopify_stores, connector_logs, or any response body.
 */

const H = require('./_lib/shopify');
const { runStoreSync } = require('./_lib/shopifySync');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return H.json(res, 405, { error: 'method_not_allowed' });

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

  // 1. Validate the token with a minimal real call before storing anything.
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

  // 2. Confirm the required read scopes are actually granted.
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
    // 3. Retire any previous credential for this store, then store the new one.
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

    // 4. Start the backfill inline with a short budget so the owner sees numbers
    //    immediately. Anything unfinished resumes on the nightly cron or on a
    //    follow-up call to /api/sync-shopify.
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
};
