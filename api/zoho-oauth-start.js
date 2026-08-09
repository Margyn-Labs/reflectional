/**
 * POST /api/zoho-oauth-start
 *
 * Step 1 of the Zoho Books OAuth flow. Returns the Zoho consent URL for the
 * authenticated user; app.html opens it in a popup/redirect.
 *
 * Request:  { region?: "in" | "com" | "eu" | "au" | "jp" | "ca" | "sa" | "uk" }
 *           (defaults to "in" — India-first, but the owner can override in
 *            the connect UI per the region-routing rule in the auth-flow skill)
 * Response: 200 { authorize_url, accounts_domain, region }
 *
 * The `state` param is an HMAC-signed, 10-minute-lifetime token carrying the
 * user id and chosen region — the callback trusts nothing else.
 */

const { getUserFromRequest, logConnectorEvent } = require('./_lib/supabaseRest');
const { buildAuthorizeUrl, ACCOUNTS_DOMAINS, DEFAULT_REGION } = require('./_lib/zohoClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    res.status(500).json({ error: 'Authentication check failed' });
    return;
  }
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }

  const region = (body.region || DEFAULT_REGION).toLowerCase();
  if (!ACCOUNTS_DOMAINS[region]) {
    res.status(400).json({ error: 'Unsupported Zoho region' });
    return;
  }

  let built;
  try {
    built = buildAuthorizeUrl({ userId: user.id, region });
  } catch (err) {
    res.status(500).json({ error: 'Zoho connector is not configured on the server' });
    return;
  }

  await logConnectorEvent({
    userId: user.id,
    connectorType: 'zoho_books',
    operation: 'oauth_start',
    status: 'success',
    recordsSynced: 0
  });

  res.status(200).json({
    authorize_url: built.url,
    accounts_domain: built.accountsDomain,
    region
  });
};
