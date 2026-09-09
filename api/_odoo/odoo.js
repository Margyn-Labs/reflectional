/**
 * api/_odoo/odoo.js
 * Odoo connector handler module. Routed from api/zoho.js (the shared cloud
 * books/ERP connector router) — this file lives in an underscore folder so
 * Vercel's file-system router does not count it as its own function.
 *
 * Auth model (see ODOO-CONNECTOR-DISCOVERY.md): manual credential entry, the
 * Razorpay pattern — NOT OAuth. The customer pastes { base_url, db, login,
 * api_key }. We verify with common.authenticate, then store base_url/db/login
 * on connector_credentials and the api_key in key_secret. The api_key is never
 * logged, never echoed back, never written to a log row.
 *
 * Transport: Odoo External API over JSON-RPC — POST <base>/jsonrpc, plain
 * fetch() + JSON, no XML. Works identically for Odoo Online, Odoo.sh and
 * reachable self-hosted instances.
 *
 * Provenance: every row written here is stamped source='odoo',
 * verification_status='signal', synced_at, cred_id. Odoo is a self-reported
 * books source (same trust class as Zoho Books) — nothing is auto-trusted and
 * no vitals / Pulse Score math happens here.
 *
 * Routes (dispatched by api/zoho.js on ?action=):
 *   POST /api/zoho?action=odoo-connect      (user JWT)  validate + store creds, first sync
 *   POST /api/zoho?action=odoo-sync         (user JWT)  re-sync now
 *   GET  /api/zoho?action=odoo-status       (user JWT)  connection + pre-aggregated summary
 *   POST /api/zoho?action=odoo-disconnect   (user JWT)  soft-disconnect, keep data
 *   GET  /api/zoho?action=odoo-cron         (CRON_SECRET) nightly sync across all active creds
 */

const {
  getUserFromRequest,
  restRequest,
  selectRows,
  insertRows,
  updateRows,
  setConnectorStatus
} = require('../_lib/supabaseRest');

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function json(res, status, body) { res.status(status).json(body); }

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}

function str(v) { return v == null ? null : String(v).trim() || null; }

function num(v) {
  if (v == null || v === '' || v === false) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Odoo many2one fields come back as [id, "Display Name"] or false. */
function m2oId(v) { return Array.isArray(v) ? v[0] : null; }
function m2oName(v) { return Array.isArray(v) ? v[1] : null; }

/** Normalise the pasted base URL: force https, strip trailing slash / path. */
function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.protocol.replace(':', '') + '://' + u.host;
  } catch {
    return '';
  }
}

async function logRun({ userId, credId, kind, received, upserted, status, error }) {
  try {
    await insertRows('odoo_sync_runs', [{
      user_id: userId,
      cred_id: credId || null,
      kind,
      rows_received: received || 0,
      rows_upserted: upserted || 0,
      status,
      error_message: error ? String(error).slice(0, 500) : null,
      finished_at: new Date().toISOString()
    }]);
  } catch (e) {
    console.error('odoo_sync_runs write failed:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Odoo JSON-RPC client                                               */
/* ------------------------------------------------------------------ */

async function rpc(baseUrl, service, method, args) {
  const resp = await fetch(baseUrl + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: Math.floor(Math.random() * 1e9)
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error('odoo_http_' + resp.status + (text ? ': ' + text.slice(0, 200) : ''));
    err.httpStatus = resp.status;
    throw err;
  }

  let data;
  try { data = await resp.json(); }
  catch { throw new Error('odoo_bad_json'); }

  if (data.error) {
    const msg = (data.error.data && data.error.data.message) || data.error.message || 'odoo_rpc_error';
    const err = new Error(String(msg).slice(0, 300));
    err.odoo = true;
    // Odoo returns AccessDenied / AccessError for bad creds or missing rights.
    if (/access ?denied|authenticationerror|invalid|wrong login|expired/i.test(msg)) err.authFailed = true;
    throw err;
  }

  return data.result;
}

/** Returns uid (int) on success, or throws with authFailed=true. */
async function authenticate(baseUrl, db, login, apiKey) {
  const uid = await rpc(baseUrl, 'common', 'authenticate', [db, login, apiKey, {}]);
  if (!uid || typeof uid !== 'number') {
    const err = new Error('Odoo rejected those credentials.');
    err.authFailed = true;
    throw err;
  }
  return uid;
}

function execKw(baseUrl, db, uid, apiKey, model, method, args, kwargs) {
  return rpc(baseUrl, 'object', 'execute_kw', [db, uid, apiKey, model, method, args || [], kwargs || {}]);
}

/* ------------------------------------------------------------------ */
/* sync                                                               */
/* ------------------------------------------------------------------ */

const MOVE_FIELDS = [
  'name', 'partner_id', 'invoice_date', 'invoice_date_due',
  'amount_total_signed', 'amount_residual_signed', 'currency_id',
  'move_type', 'state', 'payment_state', 'company_id'
];

// l10n_in field — requested separately so a db without the India localization
// (where the field doesn't exist) doesn't fail the whole read.
const GST_FIELD = 'l10n_in_gst_treatment';

const SETS = {
  invoices: {
    table: 'odoo_invoices',
    types: ['out_invoice', 'out_refund'],
    numberField: 'invoice_number',
    partyField: 'customer_name',
    partyIdField: 'customer_odoo_id',
    dateField: 'invoice_date',
    map: (r, ctx) => ({
      user_id: ctx.userId,
      cred_id: ctx.credId,
      odoo_move_id: r.id,
      company_name: m2oName(r.company_id) || ctx.companyName,
      invoice_number: str(r.name),
      customer_name: m2oName(r.partner_id) || 'Unknown customer',
      customer_odoo_id: m2oId(r.partner_id),
      invoice_date: str(r.invoice_date),
      due_date: str(r.invoice_date_due),
      amount_total: num(r.amount_total_signed),
      balance: num(r.amount_residual_signed),
      currency_code: m2oName(r.currency_id),
      move_type: str(r.move_type),
      state: str(r.state),
      payment_state: str(r.payment_state),
      gst_treatment: ctx.hasGst ? str(r[GST_FIELD]) : null,
      source: 'odoo',
      verification_status: 'signal',
      synced_at: ctx.now
    })
  },
  bills: {
    table: 'odoo_bills',
    types: ['in_invoice', 'in_refund'],
    map: (r, ctx) => ({
      user_id: ctx.userId,
      cred_id: ctx.credId,
      odoo_move_id: r.id,
      company_name: m2oName(r.company_id) || ctx.companyName,
      bill_number: str(r.name),
      vendor_name: m2oName(r.partner_id) || 'Unknown vendor',
      vendor_odoo_id: m2oId(r.partner_id),
      bill_date: str(r.invoice_date),
      due_date: str(r.invoice_date_due),
      amount_total: num(r.amount_total_signed),
      balance: num(r.amount_residual_signed),
      currency_code: m2oName(r.currency_id),
      move_type: str(r.move_type),
      state: str(r.state),
      payment_state: str(r.payment_state),
      gst_treatment: ctx.hasGst ? str(r[GST_FIELD]) : null,
      source: 'odoo',
      verification_status: 'signal',
      synced_at: ctx.now
    })
  }
};

/**
 * Full sync for one connector_credentials row. Pulls all open moves plus any
 * move touched in the last 45 days (so a just-paid invoice flips to paid here
 * too). Bounded + paged so a large book can't blow the function budget.
 */
async function runSync(cred, opts) {
  opts = opts || {};
  const deadline = opts.deadlineMs || (Date.now() + 40000);
  const now = new Date().toISOString();
  const baseUrl = cred.odoo_base_url;
  const db = cred.odoo_db;
  const login = cred.odoo_login;
  const apiKey = cred.key_secret;

  const uid = await authenticate(baseUrl, db, login, apiKey);

  // Detect the India localization once — decides whether we can read the GST field.
  let hasGst = false;
  try {
    const f = await execKw(baseUrl, db, uid, apiKey, 'account.move', 'fields_get',
      [[GST_FIELD]], { attributes: ['type'] });
    hasGst = !!(f && f[GST_FIELD]);
  } catch { hasGst = false; }

  const fields = hasGst ? MOVE_FIELDS.concat([GST_FIELD]) : MOVE_FIELDS.slice();

  const recentCutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const ctx = { userId: cred.user_id, credId: cred.id, now, hasGst, companyName: null };

  const summary = { invoices: { received: 0, upserted: 0 }, bills: { received: 0, upserted: 0 } };

  for (const kind of ['invoices', 'bills']) {
    const spec = SETS[kind];
    const domain = [
      '&',
      ['move_type', 'in', spec.types],
      '|',
      ['amount_residual_signed', '!=', 0],
      ['write_date', '>=', recentCutoff + ' 00:00:00']
    ];

    let offset = 0;
    const pageSize = 200;
    const mapped = [];

    while (Date.now() < deadline) {
      const rows = await execKw(baseUrl, db, uid, apiKey, 'account.move', 'search_read',
        [domain, fields], { limit: pageSize, offset, order: 'id asc' });
      if (!Array.isArray(rows) || rows.length === 0) break;
      summary[kind].received += rows.length;
      for (const r of rows) {
        if (!ctx.companyName) ctx.companyName = m2oName(r.company_id);
        mapped.push(spec.map(r, ctx));
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }

    if (mapped.length) {
      // chunked upsert, merge on the natural key (cred_id, odoo_move_id)
      for (let i = 0; i < mapped.length; i += 500) {
        const chunk = mapped.slice(i, i + 500);
        const out = await insertRows(spec.table, chunk, { onConflict: 'cred_id,odoo_move_id', merge: true });
        summary[kind].upserted += Array.isArray(out) ? out.length : chunk.length;
      }
    }
  }

  await setConnectorStatus(cred.user_id, 'odoo', {
    needsReauth: false,
    lastSuccessAt: now,
    lastSyncStatus: 'success'
  });

  await logRun({
    userId: cred.user_id, credId: cred.id, kind: 'full',
    received: summary.invoices.received + summary.bills.received,
    upserted: summary.invoices.upserted + summary.bills.upserted,
    status: 'ok'
  });

  return {
    company_name: ctx.companyName,
    invoices: summary.invoices.upserted,
    bills: summary.bills.upserted,
    has_gst: hasGst
  };
}

/* ------------------------------------------------------------------ */
/* route: odoo-connect  (POST, user JWT)                              */
/* body: { baseUrl, db, login, apiKey }                              */
/* ------------------------------------------------------------------ */

async function handleConnect(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  const body = parseBody(req);
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const db = str(body.db);
  const login = str(body.login);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (!baseUrl) return json(res, 400, { error: 'bad_base_url', message: 'Enter your Odoo URL, e.g. acme.odoo.com' });
  if (!db)      return json(res, 400, { error: 'missing_db', message: 'Enter your Odoo database name.' });
  if (!login)   return json(res, 400, { error: 'missing_login', message: 'Enter the Odoo user login (email).' });
  if (!apiKey)  return json(res, 400, { error: 'missing_api_key', message: 'Paste an Odoo API key (or the account password on Odoo below v14).' });

  // 1. Verify credentials
  let uid;
  try {
    uid = await authenticate(baseUrl, db, login, apiKey);
  } catch (e) {
    if (e.authFailed) {
      return json(res, 401, { error: 'invalid_credentials', message: 'Odoo rejected that database / login / key combination. Check the database name is exact and the key belongs to that login.' });
    }
    if (e.httpStatus === 404 || e.httpStatus === 0 || /fetch|network|enotfound|econnrefused/i.test(e.message)) {
      return json(res, 502, { error: 'odoo_unreachable', message: 'Could not reach that Odoo URL. Check it is public over HTTPS.' });
    }
    return json(res, 502, { error: 'odoo_error', message: 'Odoo returned an error while connecting. Try again.' });
  }

  // 2. Store credentials — one active row per user+connector.
  let credId;
  try {
    const existing = await selectRows(
      'connector_credentials',
      `select=id&user_id=eq.${user.id}&connector_type=eq.odoo&disconnected_at=is.null`
    );
    if (existing.length) {
      await updateRows(
        'connector_credentials',
        `user_id=eq.${user.id}&connector_type=eq.odoo&disconnected_at=is.null`,
        { disconnected_at: new Date().toISOString() }
      );
    }
    const inserted = await insertRows('connector_credentials', [{
      user_id: user.id,
      connector_type: 'odoo',
      odoo_base_url: baseUrl,
      odoo_db: db,
      odoo_login: login,
      key_secret: apiKey,
      created_at: new Date().toISOString()
    }]);
    credId = inserted[0].id;
  } catch (e) {
    await logRun({ userId: user.id, kind: 'connect', status: 'error', error: 'persist_failed' });
    return json(res, 500, { error: 'store_failed', message: 'Could not save the connection. Try again.' });
  }

  // 3. First sync inline, with a tight budget. If it times out the cron picks up.
  let result = null;
  try {
    const cred = { id: credId, user_id: user.id, odoo_base_url: baseUrl, odoo_db: db, odoo_login: login, key_secret: apiKey };
    result = await runSync(cred, { deadlineMs: Date.now() + 25000 });
  } catch (e) {
    console.error('odoo first sync failed:', e.message);
    await logRun({ userId: user.id, credId, kind: 'connect', status: 'error', error: e.message });
    // connection is still saved — the nightly cron will retry
  }

  return json(res, 200, {
    connected: true,
    company_name: result ? result.company_name : null,
    synced: result ? { invoices: result.invoices, bills: result.bills } : { invoices: 0, bills: 0 },
    gst_available: result ? result.has_gst : null,
    first_sync_complete: !!result
  });
}

/* ------------------------------------------------------------------ */
/* route: odoo-sync  (POST, user JWT)                                 */
/* ------------------------------------------------------------------ */

async function handleSync(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  let creds;
  try {
    creds = await selectRows(
      'connector_credentials',
      `select=id,user_id,odoo_base_url,odoo_db,odoo_login,key_secret&user_id=eq.${user.id}&connector_type=eq.odoo&disconnected_at=is.null&limit=1`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }
  if (!creds.length) return json(res, 404, { error: 'not_connected' });

  try {
    const result = await runSync(creds[0], { deadlineMs: Date.now() + 45000 });
    return json(res, 200, { synced: true, company_name: result.company_name, invoices: result.invoices, bills: result.bills });
  } catch (e) {
    if (e.authFailed) {
      await setConnectorStatus(user.id, 'odoo', { needsReauth: true, lastErrorAt: new Date().toISOString(), lastErrorCode: 'auth_failed', lastSyncStatus: 'error' });
      await logRun({ userId: user.id, credId: creds[0].id, kind: 'full', status: 'error', error: 'auth_failed' });
      return json(res, 401, { error: 'needs_reauth', message: 'Odoo rejected the stored key. Reconnect to resume syncing.' });
    }
    await setConnectorStatus(user.id, 'odoo', { lastErrorAt: new Date().toISOString(), lastErrorCode: 'server_error', lastSyncStatus: 'error' });
    await logRun({ userId: user.id, credId: creds[0].id, kind: 'full', status: 'error', error: e.message });
    return json(res, 502, { error: 'sync_failed', message: 'Odoo sync failed. Try again shortly.' });
  }
}

/* ------------------------------------------------------------------ */
/* route: odoo-status  (GET, user JWT)                                */
/* Pre-aggregated summary — all maths here so the app and the AI layer  */
/* can never quote different Odoo numbers. Everything 'signal' tier.    */
/* ------------------------------------------------------------------ */

async function handleStatus(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  let creds;
  try {
    creds = await selectRows(
      'connector_credentials',
      `select=id,odoo_base_url,odoo_db,odoo_login,needs_reauth,last_success_at,last_sync_status,created_at&user_id=eq.${user.id}&connector_type=eq.odoo&disconnected_at=is.null&order=created_at.desc&limit=1`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  if (!creds.length) {
    return json(res, 200, { connected: false });
  }
  const cred = creds[0];

  let invoices = [], bills = [];
  try {
    invoices = await selectRows(
      'odoo_invoices',
      `select=invoice_number,customer_name,balance,amount_total,due_date,invoice_date,payment_state,currency_code&cred_id=eq.${cred.id}&order=due_date.asc.nullslast&limit=500`
    );
    bills = await selectRows(
      'odoo_bills',
      `select=bill_number,vendor_name,balance,amount_total,due_date,bill_date,payment_state,currency_code&cred_id=eq.${cred.id}&order=due_date.asc.nullslast&limit=500`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const todayMs = Date.now();
  const dueMs = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isNaN(t) ? null : t; };

  function agg(rows, party) {
    let outstanding = 0, overdue = 0, openCount = 0;
    const items = [];
    for (const r of rows) {
      const bal = Math.abs(Number(r.balance) || 0);
      if (bal > 0.5) {
        openCount++;
        outstanding += bal;
        const dm = dueMs(r.due_date);
        const isOverdue = dm != null && dm < todayMs;
        if (isOverdue) overdue += bal;
        items.push({
          ref: r.invoice_number || r.bill_number || null,
          party_name: r[party] || 'Unknown',
          amount: round2(bal),
          total: round2(Math.abs(Number(r.amount_total) || 0)),
          due_date: r.due_date || null,
          doc_date: r.invoice_date || r.bill_date || null,
          payment_state: r.payment_state || null,
          overdue_days: dm != null && dm < todayMs ? Math.floor((todayMs - dm) / 86400000) : null,
          currency: r.currency_code || null,
          source: 'odoo'
        });
      }
    }
    items.sort((a, b) => (b.overdue_days || 0) - (a.overdue_days || 0));
    return {
      outstanding_total: round2(outstanding),
      overdue_total: round2(overdue),
      open_count: openCount,
      total_rows: rows.length,
      items: items.slice(0, 100)
    };
  }

  return json(res, 200, {
    connected: true,
    needs_reauth: !!cred.needs_reauth,
    instance: (cred.odoo_base_url || '').replace(/^https?:\/\//, ''),
    db: cred.odoo_db,
    last_success_at: cred.last_success_at || null,
    last_sync_status: cred.last_sync_status || null,
    connected_at: cred.created_at,
    receivables: agg(invoices, 'customer_name'),
    payables: agg(bills, 'vendor_name'),
    provenance: 'signal'
  });
}

/* ------------------------------------------------------------------ */
/* route: odoo-disconnect  (POST, user JWT)                           */
/* ------------------------------------------------------------------ */

async function handleDisconnect(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  try {
    await updateRows(
      'connector_credentials',
      `user_id=eq.${user.id}&connector_type=eq.odoo&disconnected_at=is.null`,
      { disconnected_at: new Date().toISOString(), key_secret: null }
    );
  } catch (e) {
    return json(res, 500, { error: 'disconnect_failed' });
  }

  return json(res, 200, {
    disconnected: true,
    message: 'Disconnected. Your already-synced Odoo data stays visible. To fully revoke access, delete the API key inside Odoo under Account Security.'
  });
}

/* ------------------------------------------------------------------ */
/* route: odoo-cron  (GET, CRON_SECRET)                               */
/* ------------------------------------------------------------------ */

async function handleCron(req, res) {
  const auth = req.headers['authorization'] || '';
  const expected = 'Bearer ' + (process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || auth !== expected) {
    return json(res, 401, { error: 'unauthorized' });
  }

  let creds;
  try {
    creds = await selectRows(
      'connector_credentials',
      'select=id,user_id,odoo_base_url,odoo_db,odoo_login,key_secret&connector_type=eq.odoo&disconnected_at=is.null&order=last_success_at.asc.nullsfirst&limit=50'
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const deadline = Date.now() + 280000; // stay inside the 300s maxDuration
  const results = [];

  for (const cred of creds) {
    if (Date.now() > deadline - 30000) break;
    try {
      const r = await runSync(cred, { deadlineMs: Math.min(deadline, Date.now() + 60000) });
      results.push({ cred_id: cred.id, ok: true, invoices: r.invoices, bills: r.bills });
    } catch (e) {
      if (e.authFailed) {
        await setConnectorStatus(cred.user_id, 'odoo', { needsReauth: true, lastErrorAt: new Date().toISOString(), lastErrorCode: 'auth_failed', lastSyncStatus: 'error' });
      } else {
        await setConnectorStatus(cred.user_id, 'odoo', { lastErrorAt: new Date().toISOString(), lastErrorCode: 'server_error', lastSyncStatus: 'error' });
      }
      await logRun({ userId: cred.user_id, credId: cred.id, kind: 'full', status: 'error', error: e.message });
      results.push({ cred_id: cred.id, ok: false, error: e.authFailed ? 'auth_failed' : 'error' });
    }
  }

  return json(res, 200, { ran_at: new Date().toISOString(), processed: results.length, results });
}

module.exports = {
  handleConnect,
  handleSync,
  handleStatus,
  handleDisconnect,
  handleCron,
  // exported for tests / reuse
  _internal: { normalizeBaseUrl, runSync, authenticate }
};
