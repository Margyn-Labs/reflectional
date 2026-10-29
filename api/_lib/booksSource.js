/**
 * _lib/booksSource.js
 * One books system per business (29 Oct 2026). Margyn reads one set of books (Tally, Zoho Books or Odoo)
 * and every screen, answer, update and agent reads it the same way (dataLayer/books.js). Two connected
 * would mean two versions of the same figures, so connecting a second is refused with a plain message.
 * Reconnecting the same system (a Zoho re-authorisation, pairing another Tally PC) is always allowed.
 * CommonJS, zero-npm.
 */

const { selectRows } = require('./supabaseRest');

const NAME = { tally: 'Tally', zoho: 'Zoho Books', odoo: 'Odoo' };

/** The books systems this account has connected: ['tally' | 'zoho' | 'odoo', ...]. */
async function connectedBooks(userId) {
  const id = encodeURIComponent(userId);
  const [t, z, o] = await Promise.all([
    selectRows('tally_installs', `select=id&user_id=eq.${id}&status=eq.active&limit=1`).catch(() => []),
    selectRows('zoho_organizations', `select=id&user_id=eq.${id}&status=in.(active,needs_reauth)&limit=1`).catch(() => []),
    selectRows('connector_credentials', `select=user_id&user_id=eq.${id}&connector_type=eq.odoo&disconnected_at=is.null&limit=1`).catch(() => [])
  ]);
  const out = [];
  if (t.length) out.push('tally');
  if (z.length) out.push('zoho');
  if (o.length) out.push('odoo');
  return out;
}

/** Pure: null when `wanted` may be connected, else the refusal to send back. */
function refusal(connected, wanted) {
  const other = (connected || []).find((s) => s !== wanted);
  if (!other) return null;
  const message = `Margyn reads one books system per business, and ${NAME[other]} is connected. ` +
    `To use ${NAME[wanted]} instead, disconnect ${NAME[other]} under Organisations and sources first.`;
  return { status: 409, body: { error: message, message, code: 'one_books_system', connected: other } };
}

/** null when `wanted` may be connected for this account, else { status, body } to send. */
async function checkOneBooks(userId, wanted) {
  return refusal(await connectedBooks(userId), wanted);
}

module.exports = { connectedBooks, checkOneBooks, refusal, NAME };
