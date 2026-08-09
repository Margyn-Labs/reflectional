/**
 * GET /api/zoho-oauth-callback?code=...&state=...
 *
 * Step 2 of the Zoho Books OAuth flow. Zoho redirects the owner's browser
 * here. This handler must exchange the authorization code IMMEDIATELY —
 * it expires in 2 minutes and is single-use, so there is no queueing, no
 * async deferral, and no retry with the same code.
 *
 * What it does, in order:
 *   1. Verify the HMAC-signed state (carries user id + region). Reject otherwise.
 *   2. Exchange code -> { access_token, refresh_token, api_domain }.
 *   3. Create a `pending_org_selection` row in zoho_organizations.
 *   4. Put the refresh token in Supabase vault, keyed by that row's id.
 *   5. List the account's Zoho Books organizations.
 *   6. Return an HTML page that hands control back to app.html for the
 *      org picker. Activation does NOT complete here — never.
 *
 * The access token obtained here is used only for the organizations call
 * within this request and is then discarded. It is never persisted.
 */

const { insertRows, updateRows, selectRows, logConnectorEvent } = require('./_lib/supabaseRest');
const {
  verifyState,
  resolveAccountsDomain,
  exchangeCodeForTokens,
  storeRefreshToken,
  listOrganizations,
  ZohoAuthError
} = require('./_lib/zohoClient');

const PENDING_ORG_SENTINEL = '__pending__';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title, message, payload) {
  const appOrigin = process.env.APP_ORIGIN || '';
  const data = JSON.stringify(payload || {});
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{background:#0A0E12;color:#E6EDF3;font-family:Manrope,-apple-system,Segoe UI,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
  .box{max-width:420px;padding:32px}
  h1{font-size:18px;font-weight:600;margin:0 0 8px}
  p{font-size:14px;color:#8B98A5;line-height:1.6;margin:0}
  .dot{width:8px;height:8px;border-radius:50%;background:#00D97F;box-shadow:0 0 12px #00D97F;
       display:inline-block;margin-bottom:16px}
</style></head>
<body><div class="box"><span class="dot"></span>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
<script>
(function(){
  var payload = ${data};
  try {
    if (window.opener) {
      window.opener.postMessage({ source: 'margyn-zoho-oauth', payload: payload }, ${JSON.stringify(appOrigin || '*')});
      setTimeout(function(){ window.close(); }, 600);
      return;
    }
  } catch (e) {}
  var q = payload.ok
    ? '#zoho=select-org&org_ref=' + encodeURIComponent(payload.org_ref || '')
    : '#zoho=error&reason=' + encodeURIComponent(payload.reason || 'unknown');
  setTimeout(function(){ window.location.replace('/app.html' + q); }, 1200);
})();
</script></body></html>`;
}

function send(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(html);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const code = req.query && req.query.code;
  const state = req.query && req.query.state;
  const zohoError = req.query && req.query.error;

  if (zohoError) {
    send(res, 400, page('Connection cancelled',
      'Zoho reported: ' + zohoError + '. You can close this window and try again.',
      { ok: false, reason: String(zohoError) }));
    return;
  }

  const claims = verifyState(state);
  if (!claims || !claims.uid) {
    // Expired (>10 min), tampered, or replayed state.
    send(res, 400, page('Connection link expired',
      'This connection link is no longer valid. Start again from Margyn > Connectors > Zoho Books.',
      { ok: false, reason: 'invalid_state' }));
    return;
  }

  const userId = claims.uid;

  // Trust Zoho's own account-location params over the dropdown the owner
  // picked. With Multi-DC enabled, Zoho appends `location` and
  // `accounts-server` describing the user's real data centre — so a customer
  // on .com who left the selector on the India default still works.
  // Both are validated against the shipped domain allowlist before use.
  const accountsDomain = resolveAccountsDomain({
    accountsServer: req.query && (req.query['accounts-server'] || req.query.accounts_server),
    location: req.query && req.query.location,
    fallbackRegion: claims.region
  });

  if (!code) {
    send(res, 400, page('Something went wrong',
      'Zoho did not return an authorization code. Please try connecting again.',
      { ok: false, reason: 'missing_code' }));
    return;
  }

  // ---- 2. Exchange immediately. No awaits before this that could burn time.
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, accountsDomain);
  } catch (err) {
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'oauth_callback',
      status: 'error',
      errorMessage: err instanceof ZohoAuthError ? err.message : 'Token exchange failed'
    });
    send(res, 400, page('Could not complete the connection',
      'The Zoho authorization expired before it could be used. This usually means the approval screen was left open too long. Please try again.',
      { ok: false, reason: 'token_exchange_failed' }));
    return;
  }

  // ---- 3. Pending org row. Reuse any existing pending row for this user.
  let orgRef;
  try {
    const existing = await selectRows(
      'zoho_organizations',
      `select=id&user_id=eq.${userId}&organization_id=eq.${PENDING_ORG_SENTINEL}&limit=1`
    );
    if (existing.length > 0) {
      orgRef = existing[0].id;
      await updateRows('zoho_organizations', `id=eq.${orgRef}`, {
        api_domain: tokens.apiDomain,
        accounts_domain: accountsDomain,
        status: 'pending_org_selection',
        connected_at: new Date().toISOString(),
        last_token_refresh: new Date().toISOString(),
        connector_disconnected_at: null
      });
    } else {
      const inserted = await insertRows('zoho_organizations', [{
        user_id: userId,
        organization_id: PENDING_ORG_SENTINEL,
        api_domain: tokens.apiDomain,        // always from the token response
        accounts_domain: accountsDomain,
        status: 'pending_org_selection',
        connected_at: new Date().toISOString(),
        last_token_refresh: new Date().toISOString()
      }]);
      orgRef = inserted[0].id;
    }
  } catch (err) {
    send(res, 500, page('Could not save the connection',
      'Margyn could not record this connection. Please try again.',
      { ok: false, reason: 'db_write_failed' }));
    return;
  }

  // ---- 4. Refresh token -> vault. Never to a table, never to a log.
  try {
    await storeRefreshToken(orgRef, tokens.refreshToken);
  } catch (err) {
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'oauth_callback',
      status: 'error', errorMessage: 'Vault write failed'
    });
    send(res, 500, page('Could not secure the connection',
      'Margyn could not securely store the Zoho authorization. Please try again.',
      { ok: false, reason: 'vault_write_failed' }));
    return;
  }

  // ---- 5. Organizations list (drives the picker).
  let orgs = [];
  try {
    orgs = await listOrganizations(tokens.apiDomain, tokens.accessToken);
  } catch (err) {
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'oauth_callback',
      status: 'error', errorMessage: 'Could not list organizations'
    });
    send(res, 502, page('Could not read your organizations',
      'Margyn connected to Zoho but could not list your Books organizations. Please try again.',
      { ok: false, reason: 'org_list_failed', org_ref: orgRef }));
    return;
  }

  if (orgs.length === 0) {
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'oauth_callback',
      status: 'error', errorMessage: 'no_books_organization'
    });
    send(res, 200, page('No Zoho Books organization found',
      'This Zoho login does not have access to any Zoho Books organization. If you use other Zoho apps but not Books, you will need a Zoho Books subscription (the free plan works) before connecting.',
      { ok: false, reason: 'no_books_organization', org_ref: orgRef }));
    return;
  }

  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: 'oauth_callback',
    status: 'success', recordsSynced: orgs.length
  });

  // ---- 6. Hand back to app.html. Activation is NOT complete: the org
  //         picker must be answered explicitly before any sync runs.
  send(res, 200, page('Connected to Zoho',
    orgs.length === 1
      ? 'Almost done. Confirm which organization to connect in Margyn.'
      : 'Almost done. Choose which organization to connect in Margyn.',
    { ok: true, org_ref: orgRef, organizations: orgs, needs_org_selection: true }));
};
