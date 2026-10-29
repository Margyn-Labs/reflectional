/**
 * _lib/booksSource.js
 * One books system per business (29 Oct 2026). Margyn reads one set of books (Tally, Zoho Books or Odoo)
 * and every screen, answer, update and agent reads it the same way (dataLayer/books.js). Two connected
 * would mean two versions of the same figures, so connecting a second is refused with a plain message.
 * Reconnecting a system the account has used before (a Zoho re-authorisation, pairing another Tally PC,
 * reconnecting after a disconnect) is always allowed, so an account that already had two keeps working.
 * CommonJS, zero-npm.
 */

const { selectRows } = require('./supabaseRest');

const NAME = { tally: 'Tally', zoho: 'Zoho Books', odoo: 'Odoo' };

/** The books systems this account has connected now, and every one it has ever connected. */
async function booksHistory(userId) {
  const id = encodeURIComponent(userId);
  const [t, z, o] = await Promise.all([
    selectRows('tally_installs', `select=status&user_id=eq.${id}&limit=50`).catch(() => []),
    selectRows('zoho_organizations', `select=status&user_id=eq.${id}&limit=50`).catch(() => []),
    selectRows('connector_credentials', `select=disconnected_at&user_id=eq.${id}&connector_type=eq.odoo&limit=50`).catch(() => [])
  ]);
  const connected = [], ever = [];
  if (t.length) ever.push('tally');
  if (z.length) ever.push('zoho');
  if (o.length) ever.push('odoo');
  if (t.some((r) => r.status === 'active')) connected.push('tally');
  if (z.some((r) => r.status === 'active' || r.status === 'needs_reauth')) connected.push('zoho');
  if (o.some((r) => !r.disconnected_at)) connected.push('odoo');
  return { connected, ever };
}

/** The books systems this account has connected: ['tally' | 'zoho' | 'odoo', ...]. */
async function connectedBooks(userId) {
  return (await booksHistory(userId)).connected;
}

/** Pure: null when `wanted` may be connected, else the refusal to send back. `ever`: systems used before. */
function refusal(connected, wanted, ever) {
  if ((ever || []).includes(wanted) || (connected || []).includes(wanted)) return null;
  const other = (connected || []).find((s) => s !== wanted);
  if (!other) return null;
  const message = `Margyn reads one books system per business, and ${NAME[other]} is connected. ` +
    `To use ${NAME[wanted]} instead, disconnect ${NAME[other]} under Organisations and sources first.`;
  return { status: 409, body: { error: message, message, code: 'one_books_system', connected: other } };
}

/** null when `wanted` may be connected for this account, else { status, body } to send. */
async function checkOneBooks(userId, wanted) {
  const h = await booksHistory(userId);
  return refusal(h.connected, wanted, h.ever);
}

module.exports = { connectedBooks, checkOneBooks, refusal, NAME };
