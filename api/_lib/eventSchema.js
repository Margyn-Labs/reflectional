/**
 * api/_lib/eventSchema.js — the allowlist for product_events (ops console).
 *
 * Every event name AND every property it may carry is listed here. Anything
 * not listed is dropped by track.js before it reaches the database. Values
 * are typed, never free-form:
 *
 *   ['a', 'b']  enum: one of these exact strings
 *   'bool'      true / false
 *   'count'     a whole number 0..10,000,000 (row counts, lengths, seconds)
 *   'slug'      an internal code: lowercase a-z 0-9 _ , max 40 chars, no long
 *               digit runs (so it can't smuggle a phone, amount or GSTIN)
 *
 * What may NEVER be in a payload: amounts, party / customer / vendor / org
 * names, GSTINs, free text, emails, phone numbers. DISALLOWED_KEY guards the
 * key names (a schema entry matching it fails the test suite), the typed
 * values guard the contents. Counts and metadata only.
 *
 * Keep in sync with the product_events_name_allowlist CHECK
 * (latest: 2026-10-29-ops-investor-funnel.sql). Adding an event = add it
 * here + in that CHECK, and run node api/_lib/__tests__/eventSchema.test.js.
 */

const CONNECTORS = ['razorpay', 'cashfree', 'shopify', 'zoho', 'tally', 'odoo', 'whatsapp'];
const ZOHO_REGIONS = ['in', 'com', 'eu', 'au', 'jp', 'ca', 'sa', 'uk'];

// Closed vocabulary for Zoho failures (see zohoErrorCode below).
const ZOHO_ERROR_CODES = [
  'none',
  'user_cancelled', 'invalid_state', 'missing_code', 'token_exchange_failed',
  'db_write_failed', 'vault_write_failed', 'org_list_failed', 'no_books_organization',
  'org_not_found', 'org_not_on_account', 'org_already_connected', 'org_verify_failed',
  'activate_failed', 'backfill_failed',
  'not_connected', 'needs_reauth', 'rate_limited', 'module_errors', 'unexpected',
  'gstr2b_not_validated', 'module_unavailable'
];

const EVENT_SCHEMA = {
  // ---- existing (2026-09-08 + 2026-10-03) ----
  app_open: {},
  connector_sync_manual: { connector: CONNECTORS },
  reconcile_run: {},
  reconcile_summary_view: {},
  mismatch_opened: { via: 'slug' },
  mismatch_resolved_marked: { via: 'slug' },
  ask_message_sent: { msg_len: 'count', surface: ['panel', 'chat'] },
  whatsapp_inbound: { kind: ['button', 'conversational'], reply_type: 'slug', msg_len: 'count' },
  whatsapp_outbound: { kind: 'slug', who: ['primary', 'member'] },
  tally_agent_sync: { kind: 'slug', rows: 'count' },
  briefing_opened: { regenerate: 'bool' },
  question_asked: { channel: ['panel', 'chat', 'whatsapp'], topic: 'slug', answered: 'bool' },
  watch_sent: { kind: 'slug', points: 'count', mode: 'slug', via: 'slug' },

  // ---- Zoho Books funnel, server-side (2026-10-29) ----
  zoho_connect_started: { region: ZOHO_REGIONS },
  zoho_callback: { ok: 'bool', error_code: ZOHO_ERROR_CODES, org_count: 'count' },
  zoho_org_selected: { ok: 'bool', error_code: ZOHO_ERROR_CODES, multi_currency: 'bool', backfill_ok: 'bool' },
  zoho_sync: {
    ok: 'bool', status: ['success', 'partial', 'error'], error_code: ZOHO_ERROR_CODES,
    mode: ['delta', 'backfill'], rows_synced: 'count', modules_failed: 'count', duration_s: 'count'
  },
  zoho_gstr2b_sync: {
    ok: 'bool', state: ['not_available', 'success', 'partial', 'error'], error_code: ZOHO_ERROR_CODES,
    rows_synced: 'count', periods: 'count'
  }
};

// Keys that may never appear in an event payload, by substring.
const DISALLOWED_KEY = /amount|name|gstin|text|email|phone|body|message|msg$|content|raw|payload|pan$|aadhaar|account_n|bank_account|address|token|secret|password/i;

const SLUG = /^[a-z][a-z0-9_]{0,39}$/;
const LONG_DIGITS = /\d{6,}/;
const MAX_COUNT = 10000000;

function validValue(spec, v) {
  if (Array.isArray(spec)) return typeof v === 'string' && spec.indexOf(v) !== -1;
  if (spec === 'bool') return typeof v === 'boolean';
  if (spec === 'count') return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
  if (spec === 'slug') return typeof v === 'string' && SLUG.test(v) && !LONG_DIGITS.test(v);
  return false;
}

/**
 * Checks a payload strictly. Returns { ok, problems: [string] }.
 * Used by tests and by sanitizeEventProps (which drops instead of failing).
 */
function checkEventProps(name, props) {
  const problems = [];
  const schema = EVENT_SCHEMA[name];
  if (!schema) return { ok: false, problems: ['unknown event ' + name] };
  if (props == null) return { ok: true, problems };
  if (typeof props !== 'object' || Array.isArray(props)) return { ok: false, problems: ['props must be a flat object'] };
  for (const [k, v] of Object.entries(props)) {
    if (DISALLOWED_KEY.test(k)) { problems.push('disallowed key ' + k); continue; }
    if (!Object.prototype.hasOwnProperty.call(schema, k)) { problems.push('unlisted key ' + k); continue; }
    if (v === null || v === undefined) continue;
    if (!validValue(schema[k], v)) problems.push('bad value for ' + k);
  }
  return { ok: problems.length === 0, problems };
}

/** Keeps only listed keys with valid values. Never throws. */
function sanitizeEventProps(name, props) {
  const schema = EVENT_SCHEMA[name];
  const out = {};
  if (!schema || !props || typeof props !== 'object' || Array.isArray(props)) return out;
  for (const k of Object.keys(schema)) {
    if (DISALLOWED_KEY.test(k)) continue;              // belt and braces: a bad schema edit still can't leak
    if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
    let v = props[k];
    // Counts arrive as floats sometimes (durations, lengths): round, don't drop.
    if (schema[k] === 'count' && typeof v === 'number' && isFinite(v)) v = Math.min(MAX_COUNT, Math.max(0, Math.round(v)));
    if (validValue(schema[k], v)) out[k] = v;
  }
  return out;
}

/**
 * Maps a Zoho failure (an Error, a message, or one of our own reason strings)
 * onto ZOHO_ERROR_CODES. The raw message never leaves this function.
 */
function zohoErrorCode(errOrMsg) {
  if (!errOrMsg) return 'none';
  const name = errOrMsg && errOrMsg.name ? String(errOrMsg.name) : '';
  const msg = String((errOrMsg && errOrMsg.message) || errOrMsg).toLowerCase();
  if (ZOHO_ERROR_CODES.indexOf(msg) !== -1) return msg;
  if (/access_denied|cancel/.test(msg)) return 'user_cancelled';
  if (name === 'ZohoAuthError' || /reauth|invalid_token|invalid_code|unauthori[sz]ed|\b401\b/.test(msg)) return 'needs_reauth';
  if (name === 'ZohoModuleUnavailable' || /module_unavailable|not available for this org/.test(msg)) return 'module_unavailable';
  if (/rate|too many|\b429\b|daily api/.test(msg)) return 'rate_limited';
  if (/not connected|org not selected/.test(msg)) return 'not_connected';
  return 'unexpected';
}

module.exports = {
  EVENT_SCHEMA,
  EVENT_NAMES: Object.keys(EVENT_SCHEMA),
  ZOHO_ERROR_CODES,
  DISALLOWED_KEY,
  checkEventProps,
  sanitizeEventProps,
  zohoErrorCode
};
