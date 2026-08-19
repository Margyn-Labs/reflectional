/**
 * api/sync-shopify.js
 * User-triggered sync. Also the endpoint the UI polls to resume an
 * incomplete 90-day backfill until backfill_complete flips true.
 *
 * POST  Authorization: Bearer <supabase user access token>
 * Body (optional): { storeId: "<uuid>", forceVariants: true }
 */

const H = require('./_lib/shopify');
const { runStoreSync } = require('./_lib/shopifySync');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return H.json(res, 405, { error: 'method_not_allowed' });

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
  // Budget the whole invocation, not each store, so multi-store users
  // still return inside the function timeout.
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
};
