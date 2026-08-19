/**
 * GET  /api/zoho-select-org?org_ref=<uuid>   -> list selectable organizations
 * POST /api/zoho-select-org                  -> commit the owner's choice
 *
 * Step 3, and the ONLY path that turns a Zoho connection from
 * `pending_org_selection` into `active`. Activation blocks here until the
 * owner explicitly names one organization — even when the account only has
 * one, Margyn never auto-selects. Picking wrong means pulling a different
 * business's financials, so this is deliberately a hard gate.
 *
 * POST body: { org_ref: uuid, organization_id: string }
 * Response:  200 { status: "active", organization_id, organization_name, backfill: "started" }
 *
 * On success it kicks off the one-time 12-month backfill in the background.
 */

const { getUserFromRequest, selectRows, updateRows, logConnectorEvent } = require('../_lib/supabaseRest');
const {
  readRefreshToken,
  refreshAccessToken,
  listOrganizations,
  ZohoAuthError
} = require('../_lib/zohoClient');

async function loadPendingOrg(userId, orgRef) {
  const rows = await selectRows(
    'zoho_organizations',
    `select=*&id=eq.${orgRef}&user_id=eq.${userId}&limit=1`
  );
  return rows[0] || null;
}

/** Fresh org list straight from Zoho — nothing about the account is cached. */
async function fetchOrganizations(org) {
  const refreshToken = await readRefreshToken(org.id);
  const { accessToken } = await refreshAccessToken(refreshToken, org.accounts_domain);
  return listOrganizations(org.api_domain, accessToken);
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

  // ------------------------------------------------------------ GET: list
  if (req.method === 'GET') {
    const orgRef = req.query && req.query.org_ref;
    if (!orgRef) {
      res.status(400).json({ error: 'org_ref is required' });
      return;
    }
    const org = await loadPendingOrg(user.id, orgRef);
    if (!org) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    try {
      const organizations = await fetchOrganizations(org);
      res.status(200).json({
        org_ref: org.id,
        needs_org_selection: true,
        organizations
      });
    } catch (err) {
      if (err instanceof ZohoAuthError) {
        res.status(401).json({ error: 'Zoho authorization is no longer valid. Please reconnect.' });
        return;
      }
      res.status(502).json({ error: 'Could not read organizations from Zoho' });
    }
    return;
  }

  // ----------------------------------------------------------- POST: commit
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const orgRef = (body.org_ref || '').trim();
  const chosenId = (body.organization_id || '').trim();

  if (!orgRef || !chosenId) {
    res.status(400).json({ error: 'org_ref and organization_id are both required' });
    return;
  }

  const org = await loadPendingOrg(user.id, orgRef);
  if (!org) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  if (org.status === 'active' && org.organization_id === chosenId) {
    res.status(200).json({ status: 'active', organization_id: chosenId, message: 'Already connected' });
    return;
  }

  // Re-verify the choice against Zoho. A client cannot name an org the
  // token does not actually grant access to.
  let organizations;
  try {
    organizations = await fetchOrganizations(org);
  } catch (err) {
    res.status(502).json({ error: 'Could not verify the organization with Zoho' });
    return;
  }

  const match = organizations.find((o) => o.organization_id === chosenId);
  if (!match) {
    res.status(400).json({ error: 'That organization is not available on this Zoho account' });
    return;
  }

  // Guard against connecting the same Zoho org twice for one user.
  const duplicate = await selectRows(
    'zoho_organizations',
    `select=id&user_id=eq.${user.id}&organization_id=eq.${chosenId}&limit=1`
  );
  if (duplicate.length > 0 && duplicate[0].id !== org.id) {
    res.status(409).json({ error: 'That organization is already connected to Margyn' });
    return;
  }

  const isMultiCurrency = (match.currency_code || 'INR') !== 'INR';

  try {
    await updateRows('zoho_organizations', `id=eq.${org.id}`, {
      organization_id: match.organization_id,
      organization_name: match.name || null,
      plan_type: match.plan_type || null,
      base_currency: match.currency_code || 'INR',
      multi_currency_detected: isMultiCurrency,
      status: 'active',
      connector_disconnected_at: null
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not activate the connection' });
    return;
  }

  await logConnectorEvent({
    userId: user.id,
    connectorType: 'zoho_books',
    operation: 'select_org',
    status: 'success',
    recordsSynced: 0
  });

  // One-time 12-month backfill, fire-and-forget. If it fails or the function
  // times out, the nightly cron picks the org up and resumes from the
  // sync cursors — nothing is lost.
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    if (host) {
      fetch(`${proto}://${host}/api/zoho?action=sync`, {
        method: 'POST',
        headers: {
          Authorization: req.headers['authorization'],
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: 'backfill' })
      }).catch(() => {});
    }
  } catch {
    // best-effort only
  }

  res.status(200).json({
    status: 'active',
    org_ref: org.id,
    organization_id: match.organization_id,
    organization_name: match.name || null,
    plan_type: match.plan_type || null,
    multi_currency_detected: isMultiCurrency,
    backfill: 'started'
  });
};

module.exports = { handler };
