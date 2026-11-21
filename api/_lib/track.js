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
 *   - Unknown event names are dropped silently. The allowlist of names AND
 *     of each event's properties lives in ./eventSchema.js (mirrors the
 *     product_events_name_allowlist CHECK in the migrations).
 *   - props is counts and metadata only. Any key the schema does not list
 *     for that event, or any value that is not the listed type (enum / bool /
 *     count / slug), is dropped here — so amounts, party names, GSTINs, free
 *     text, emails and phone numbers cannot reach the table even if a caller
 *     passes them by mistake.
 *
 * Zero-npm: uses the shared PostgREST helper, plain fetch() underneath.
 */

const { insertRows } = require('./supabaseRest');
const { EVENT_NAMES, sanitizeEventProps } = require('./eventSchema');

const ALLOWED_NAMES = new Set(EVENT_NAMES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Back-compat name: sanitizeProps(name, props) -> the schema-filtered props. */
function sanitizeProps(name, props) {
  return sanitizeEventProps(name, props);
}

/**
 * @param {string} userId  auth.users.id of the partner the event belongs to
 * @param {string} name     one of ALLOWED_NAMES
 * @param {object} [props]   flat metadata listed for this event in eventSchema.js
 * @param {string} [by]      the person who did it, when that isn't the account's owner (a team login's
 *                           auth id, 21 Nov 2026). An internal id, never an email; kept as props.by so the
 *                           Ops Console can tell team members apart. Anything not a uuid is dropped.
 * @returns {Promise<void>}  always resolves
 */
async function track(userId, name, props, by) {
  try {
    if (!userId || !name || !ALLOWED_NAMES.has(name)) return;
    const clean = sanitizeProps(name, props);
    if (by && UUID_RE.test(String(by)) && String(by) !== String(userId)) clean.by = String(by).toLowerCase();
    await insertRows('product_events', [{
      user_id: userId,
      name,
      props: clean
    }]);
  } catch (err) {
    console.error(`track(${name}) failed:`, err && err.message);
  }
}

module.exports = { track, ALLOWED_NAMES, sanitizeProps };
