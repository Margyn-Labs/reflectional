/**
 * api/zoho.js
 * Single router for the Zoho Books connector, merged to stay under the
 * Vercel Hobby plan's 12-function cap per deployment.
 *
 * The actual handler logic is UNCHANGED from the original 8 standalone
 * files — each one was moved as-is into api/_zoho/ (an underscore-prefixed
 * folder, which Vercel's file-system router excludes from function
 * detection) and only its export shape was adjusted. This file is new;
 * everything it calls is the original code.
 *
 * api/zoho-oauth-callback.js is deliberately NOT merged here and NOT
 * touched — its URL is registered as the redirect_uri in the Zoho
 * Developer Console (api-console.zoho.com). Changing that path would
 * require updating the registration there too, which is an external,
 * manual step outside this codebase. Leaving it alone means zero
 * external reconfiguration is needed for this consolidation.
 *
 * Dispatch is by ?action= query param:
 *   POST      /api/zoho?action=oauth-start   (was api/zoho-oauth-start.js)
 *   GET/POST  /api/zoho?action=select-org    (was api/zoho-select-org.js)
 *   POST      /api/zoho?action=disconnect    (was api/disconnect-zoho.js)
 *   GET       /api/zoho?action=vitals        (was api/zoho-vitals.js)
 *   POST      /api/zoho?action=sync          (was api/sync-zoho.js)
 *   POST      /api/zoho?action=sync-gstr2b   (was api/sync-zoho-gstr2b.js)
 *   GET       /api/zoho?action=cron          (was api/cron-sync-zoho.js;
 *                                              internal Vercel Cron target,
 *                                              still gated by CRON_SECRET
 *                                              inside the handler itself)
 *   GET       /api/zoho?action=cron-gstr2b   (was api/cron-sync-zoho-gstr2b.js;
 *                                              same CRON_SECRET gate)
 */

const oauthStart = require('./_zoho/oauth-start');
const selectOrg = require('./_zoho/select-org');
const disconnect = require('./_zoho/disconnect');
const vitals = require('./_zoho/vitals');
const sync = require('./_zoho/sync');
const syncGstr2b = require('./_zoho/sync-gstr2b');
const cron = require('./_zoho/cron');
const cronGstr2b = require('./_zoho/cron-gstr2b');

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || '';

  if (action === 'oauth-start') return oauthStart.handler(req, res);
  if (action === 'select-org') return selectOrg.handler(req, res);
  if (action === 'disconnect') return disconnect.handler(req, res);
  if (action === 'vitals') return vitals.handler(req, res);
  if (action === 'sync') return sync.handler(req, res);
  if (action === 'sync-gstr2b') return syncGstr2b.handler(req, res);
  if (action === 'cron') return cron.handler(req, res);
  if (action === 'cron-gstr2b') return cronGstr2b.handler(req, res);

  res.status(400).json({
    error: 'unknown_action',
    message: 'Expected ?action= one of oauth-start, select-org, disconnect, vitals, sync, sync-gstr2b, cron, cron-gstr2b.'
  });
};
