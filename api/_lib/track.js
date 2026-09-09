/**
 * api/_lib/track.js — tiny fire-and-forget product-event writer for the
 * founder ops console (2026-09-08-ops-console.sql).
 *
 * track(userId, name, props) inserts one row into public.product_events.
 *
 * Contract:
 *   - NEVER throws into a product code path. Any failure is swallowed +
 *     console.error'd. A tracking outage must not break a sync / a chat / a
 *     webhook.
 *   - Unknown event names are dropped silently (allowlist below mirrors the
 *     CHECK constraint in the migration).
 *   - props is shape metadata only. Callers must not pass raw message text,
 *     bank account numbers, PAN/Aadhaar, full webhook bodies. This helper does
 *     a last-ditch strip of obviously-unsafe keys but the caller owns this.
 *
 * Zero-npm: uses the shared PostgREST helper, plain fetch() underneath.
 */

const { insertRows } = require('./supabaseRest');

const ALLOWED_NAMES = new Set([
  'app_open',
  'connector_sync_manual',
  'reconcile_run',
  'reconcile_summary_view',
  'mismatch_opened',
  'mismatch_resolved_marked',
  'ask_message_sent',
  'whatsapp_inbound',
  'whatsapp_outbound',
  'tally_agent_sync',
  'briefing_opened'
]);

// Keys we refuse to persist even if a caller passes them by mistake.
const BLOCKED_PROP_KEYS = new Set([
  'text', 'body', 'message', 'msg', 'content', 'raw', 'raw_payload', 'payload',
  'account_number', 'account_no', 'bank_account', 'pan', 'aadhaar', 'phone',
  'from_phone', 'email'
]);

function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (BLOCKED_PROP_KEYS.has(k.toLowerCase())) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      // never store anything long enough to be a message body
      out[k] = v.length > 120 ? v.slice(0, 120) : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
    // objects / arrays are dropped — props is flat shape metadata only
  }
  return out;
}

/**
 * @param {string} userId  auth.users.id of the partner the event belongs to
 * @param {string} name     one of ALLOWED_NAMES
 * @param {object} [props]   flat shape metadata, e.g. { pair: 'razorpay_shopify' }
 * @returns {Promise<void>}  always resolves
 */
async function track(userId, name, props) {
  try {
    if (!userId || !name || !ALLOWED_NAMES.has(name)) return;
    await insertRows('product_events', [{
      user_id: userId,
      name,
      props: sanitizeProps(props)
    }]);
  } catch (err) {
    console.error(`track(${name}) failed:`, err && err.message);
  }
}

module.exports = { track, ALLOWED_NAMES };
