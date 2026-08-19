/**
 * api/_lib/shopifySync.js
 * Margyn: the Shopify sync engine. Called by /api/sync-shopify.js (user-triggered)
 * and /api/cron-sync-shopify.js (nightly, all active stores).
 *
 * Design notes:
 *  - Resumable. Vercel functions time out; the 90-day backfill saves its
 *    page_info cursor to shopify_stores.backfill_cursor and picks up next run.
 *  - Refunds come embedded on the order object. The per-order refunds endpoint
 *    would be one extra API call per order, which blows the leaky bucket on any
 *    store with real volume. Same data, one call.
 *  - cost_per_item does NOT live on the variant. It lives on the inventory item
 *    (hence the read_inventory scope). Products are fetched, then inventory items
 *    are batched 100 ids at a time to attach cost.
 *  - Nothing is ever hard-deleted. Voided orders are tracked via financial_status.
 */

const H = require('./shopify');

const BACKFILL_DAYS = 90;
const VARIANT_SYNC_INTERVAL_DAYS = 7;
const DELTA_OVERLAP_MINUTES = 90; // re-pull a small overlap so nothing is missed at the boundary

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function mapOrder(userId, storeId, o) {
  var gateway = null;
  if (Array.isArray(o.payment_gateway_names) && o.payment_gateway_names.length) {
    gateway = String(o.payment_gateway_names[0]).toLowerCase();
  } else if (o.gateway) {
    gateway = String(o.gateway).toLowerCase();
  }

  return {
    user_id: userId,
    store_id: storeId,
    order_id: String(o.id),
    order_number: o.name || (o.order_number != null ? String(o.order_number) : null),
    created_at_shopify: o.created_at,
    updated_at_shopify: o.updated_at || o.created_at,
    financial_status: o.financial_status || 'pending',
    fulfillment_status: o.fulfillment_status || null,
    total_price: H.num(o.total_price) || 0,
    subtotal_price: H.num(o.subtotal_price),
    total_discounts: H.num(o.total_discounts) || 0,
    total_tax: H.num(o.total_tax) || 0,
    currency: o.currency || 'INR',
    gateway: gateway,
    synced_at: new Date().toISOString()
  };
}

function mapLineItems(userId, orderUuid, o) {
  var out = [];
  var items = o.line_items || [];
  for (var i = 0; i < items.length; i++) {
    var li = items[i];
    out.push({
      user_id: userId,
      order_id: orderUuid,
      line_item_id: String(li.id),
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      product_id: li.product_id != null ? String(li.product_id) : null,
      sku: li.sku || null,
      quantity: li.quantity || 0,
      price: H.num(li.price) || 0,
      synced_at: new Date().toISOString()
    });
  }
  return out;
}

function mapRefunds(userId, orderUuid, o) {
  var out = [];
  var refunds = o.refunds || [];
  for (var i = 0; i < refunds.length; i++) {
    var r = refunds[i];
    var amount = 0;
    var txns = r.transactions || [];
    for (var t = 0; t < txns.length; t++) {
      if (txns[t].kind === 'refund' && txns[t].status === 'success') {
        amount += H.num(txns[t].amount) || 0;
      }
    }
    // Fall back to refund_line_items when no transaction rows are present
    if (amount === 0 && Array.isArray(r.refund_line_items)) {
      for (var k = 0; k < r.refund_line_items.length; k++) {
        amount += H.num(r.refund_line_items[k].subtotal) || 0;
      }
    }
    out.push({
      user_id: userId,
      order_id: orderUuid,
      refund_id: String(r.id),
      amount: Math.round(amount * 100) / 100,
      reason: r.note || null,
      created_at_shopify: r.created_at,
      synced_at: new Date().toISOString()
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

async function syncOrders(store, token, deadline, result) {
  var isBackfill = !store.backfill_complete;
  var baseParams = { limit: 250, status: 'any', order: 'created_at asc' };

  if (isBackfill) {
    var since = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString();
    baseParams.created_at_min = since;
  } else {
    var last = store.last_synced_at
      ? new Date(new Date(store.last_synced_at).getTime() - DELTA_OVERLAP_MINUTES * 60000)
      : new Date(Date.now() - BACKFILL_DAYS * 86400000);
    baseParams.updated_at_min = last.toISOString();
    delete baseParams.order;
  }

  var gatewaysSeen = {};

  async function onPage(orders) {
    var orderRows = orders.map(function (o) { return mapOrder(store.user_id, store.id, o); });
    for (var i = 0; i < orderRows.length; i++) {
      if (orderRows[i].gateway) gatewaysSeen[orderRows[i].gateway] = true;
    }

    var saved = await H.sbUpsert('shopify_orders', orderRows, 'store_id,order_id', true);

    // Map Shopify order id -> our UUID
    var idMap = {};
    for (var s = 0; s < saved.length; s++) idMap[saved[s].order_id] = saved[s].id;

    var lineItems = [];
    var refunds = [];
    for (var j = 0; j < orders.length; j++) {
      var uuid = idMap[String(orders[j].id)];
      if (!uuid) continue;
      lineItems = lineItems.concat(mapLineItems(store.user_id, uuid, orders[j]));
      refunds = refunds.concat(mapRefunds(store.user_id, uuid, orders[j]));
    }

    if (lineItems.length) await H.sbUpsert('shopify_order_line_items', lineItems, 'order_id,line_item_id', false);
    if (refunds.length) await H.sbUpsert('shopify_refunds', refunds, 'order_id,refund_id', false);

    result.orders += orders.length;
    result.line_items += lineItems.length;
    result.refunds += refunds.length;
  }

  var walk = await H.paginate(
    store.shop_domain, token, '/orders.json', baseParams, 'orders', onPage,
    { startPageInfo: isBackfill ? (store.backfill_cursor || null) : null, deadlineMs: deadline, maxPages: 200 }
  );

  result.gateways = Object.keys(gatewaysSeen);
  result.timedOut = walk.timedOut;
  result.nextCursor = walk.nextPageInfo;
  result.wasBackfill = isBackfill;
  return result;
}

/* ------------------------------------------------------------------ */
/* Variants + cost (weekly)                                            */
/* ------------------------------------------------------------------ */

async function syncVariants(store, token, deadline, result) {
  var variants = [];
  var invItemIds = [];

  async function onPage(products) {
    for (var p = 0; p < products.length; p++) {
      var prod = products[p];
      var vs = prod.variants || [];
      for (var v = 0; v < vs.length; v++) {
        var vr = vs[v];
        variants.push({
          user_id: store.user_id,
          store_id: store.id,
          variant_id: String(vr.id),
          product_id: String(prod.id),
          inventory_item_id: vr.inventory_item_id != null ? String(vr.inventory_item_id) : null,
          sku: vr.sku || null,
          cost_per_item: null,
          price: H.num(vr.price),
          synced_at: new Date().toISOString()
        });
        if (vr.inventory_item_id != null) invItemIds.push(String(vr.inventory_item_id));
      }
    }
  }

  await H.paginate(
    store.shop_domain, token, '/products.json',
    { limit: 250, fields: 'id,variants' }, 'products', onPage,
    { deadlineMs: deadline, maxPages: 100 }
  );

  // cost_per_item lives on the inventory item, not the variant. Batch 100 ids per call.
  var costById = {};
  for (var i = 0; i < invItemIds.length; i += 100) {
    if (Date.now() > deadline) break;
    var batch = invItemIds.slice(i, i + 100);
    var res = await H.shopifyRequest(
      store.shop_domain, token,
      '/inventory_items.json?ids=' + batch.join(',') + '&limit=100'
    );
    if (res.status !== 200 || !res.body) continue;
    var items = res.body.inventory_items || [];
    for (var k = 0; k < items.length; k++) {
      costById[String(items[k].id)] = H.num(items[k].cost);
    }
  }

  for (var x = 0; x < variants.length; x++) {
    if (variants[x].inventory_item_id && costById[variants[x].inventory_item_id] !== undefined) {
      variants[x].cost_per_item = costById[variants[x].inventory_item_id];
    }
  }

  // Write in chunks so a large catalogue does not blow the request body size
  for (var c = 0; c < variants.length; c += 500) {
    await H.sbUpsert('shopify_variants', variants.slice(c, c + 500), 'store_id,variant_id', false);
  }

  result.variants = variants.length;
  result.variants_missing_cost = variants.filter(function (v) { return v.cost_per_item === null; }).length;
  return result;
}

/* ------------------------------------------------------------------ */
/* Payouts (Shopify Payments stores only)                              */
/* ------------------------------------------------------------------ */

async function syncPayouts(store, token, deadline, result) {
  var dateMin = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString().slice(0, 10);
  var res = await H.shopifyRequest(
    store.shop_domain, token,
    '/shopify_payments/payouts.json?limit=250&date_min=' + dateMin
  );

  // 403/404 means the store is not on Shopify Payments. Expected, not an error.
  if (res.status === 403 || res.status === 404) {
    result.payouts = 0;
    result.payouts_skipped = 'not_shopify_payments';
    return result;
  }
  if (res.status !== 200 || !res.body) {
    result.payouts = 0;
    result.payouts_skipped = 'http_' + res.status;
    return result;
  }

  var rows = (res.body.payouts || []).map(function (p) {
    return {
      user_id: store.user_id,
      store_id: store.id,
      payout_id: String(p.id),
      amount: H.num(p.amount) || 0,
      status: p.status || 'scheduled',
      payout_date: p.date,
      summary: p.summary || null,
      synced_at: new Date().toISOString()
    };
  });

  if (rows.length) await H.sbUpsert('shopify_payouts', rows, 'store_id,payout_id', false);
  result.payouts = rows.length;
  return result;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/**
 * Sync one store. Returns a result summary. Never throws for expected
 * conditions: auth failure sets needs_reauthentication and returns cleanly.
 */
async function runStoreSync(store, options) {
  options = options || {};
  var deadline = options.deadlineMs || (Date.now() + 45000);
  var result = {
    store_id: store.id,
    shop_domain: store.shop_domain,
    orders: 0, line_items: 0, refunds: 0, variants: 0, payouts: 0,
    flags: []
  };

  var token = await H.getStoreToken(store);
  if (!token) {
    await H.sbUpdate('shopify_stores', 'id=eq.' + store.id, {
      status: 'needs_reauthentication',
      last_sync_status: 'failed',
      last_sync_error: 'no_credential'
    });
    await H.logEvent(store.user_id, 'sync', 'failed', { reason: 'no_credential', shop: store.shop_domain });
    result.error = 'needs_reauthentication';
    return result;
  }

  try {
    await syncOrders(store, token, deadline, result);

    // Gateway detection drives whether payouts are worth fetching at all
    var usesShopifyPayments = store.uses_shopify_payments;
    if (result.gateways && result.gateways.length) {
      usesShopifyPayments = result.gateways.indexOf('shopify_payments') !== -1;
    }

    var needVariants = !store.variants_synced_at ||
      (Date.now() - new Date(store.variants_synced_at).getTime()) > VARIANT_SYNC_INTERVAL_DAYS * 86400000;

    if ((needVariants || options.forceVariants) && Date.now() < deadline) {
      await syncVariants(store, token, deadline, result);
    }

    if (usesShopifyPayments && Date.now() < deadline) {
      await syncPayouts(store, token, deadline, result);
    }

    // Flags
    if (result.variants > 0 && (result.variants_missing_cost / result.variants) > 0.2) {
      result.flags.push('cogs_data_incomplete');
    }
    if (result.wasBackfill && result.orders === 0 && !result.timedOut) {
      result.flags.push('store_possibly_empty_or_wrong_store');
    }

    var patch = {
      last_synced_at: new Date().toISOString(),
      last_sync_status: result.timedOut ? 'partial' : 'ok',
      last_sync_error: null,
      consecutive_failures: 0,
      status: 'active',
      uses_shopify_payments: usesShopifyPayments === undefined ? null : usesShopifyPayments
    };
    if (result.wasBackfill) {
      patch.backfill_cursor = result.timedOut ? result.nextCursor : null;
      patch.backfill_complete = !result.timedOut;
    }
    if (result.variants > 0) patch.variants_synced_at = new Date().toISOString();

    await H.sbUpdate('shopify_stores', 'id=eq.' + store.id, patch);
    await H.logEvent(store.user_id, result.wasBackfill ? 'backfill' : 'delta_sync',
      result.timedOut ? 'partial' : 'ok', result);

    return result;

  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    var isAuth = err && (err.status === 401 || err.status === 403);

    await H.sbUpdate('shopify_stores', 'id=eq.' + store.id, {
      status: isAuth ? 'needs_reauthentication' : store.status,
      last_sync_status: 'failed',
      last_sync_error: msg.slice(0, 500),
      consecutive_failures: (store.consecutive_failures || 0) + 1
    });
    await H.logEvent(store.user_id, 'sync', 'failed', { error: msg.slice(0, 500), shop: store.shop_domain });

    result.error = isAuth ? 'needs_reauthentication' : msg;
    return result;
  }
}

module.exports = { runStoreSync: runStoreSync, BACKFILL_DAYS: BACKFILL_DAYS };
