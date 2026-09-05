/**
 * api/tally.js
 * Single router for the Tally connector, dispatched by ?action= to stay under
 * the Vercel Hobby plan's 12-function cap (this is function 12/12 — anything
 * added after it has to merge into an existing router).
 *
 * The Tally connector is a local Windows desktop agent that talks to
 * TallyPrime's built-in HTTP/XML server (port 9000) and pushes normalised
 * data here. There is no Vercel cron for it — the agent drives its own
 * schedule — so no cron route is registered in vercel.json.
 *
 *   POST /api/tally?action=pair-init      (user JWT)   mint a short-lived pairing code
 *   POST /api/tally?action=pair-complete  (pair code)  exchange code -> long-lived install key
 *   POST /api/tally?action=ingest         (install key) receive a batch of rows, upsert w/ provenance
 *   GET  /api/tally?action=status         (user JWT)   list this user's paired installs + counts
 *   POST /api/tally?action=revoke         (user JWT)   revoke an install key
 *
 * AUTH MODEL
 *   - pair-init / status / revoke are authenticated by the user's Supabase JWT
 *     (Authorization: Bearer <access_token>), same as every other connector.
 *   - pair-complete is authenticated by the pairing code itself (the code IS the
 *     bearer of trust for that one exchange). Rate-limited + attempt-locked.
 *   - ingest is authenticated by the per-install key: Authorization: Bearer <install_key>.
 *     Only a SHA-256 hash of the key is ever stored; the raw key is returned to the
 *     agent exactly once, at pair-complete.
 *
 * PROVENANCE
 *   Every financial row written here is stamped source='tally',
 *   verification_status='signal', synced_at, install_id, company_name. Nothing is
 *   auto-trusted and no vitals / Pulse Score math happens here — that is the
 *   vitals engine's job downstream.
 */

const crypto = require('crypto');
const {
  getUserFromRequest,
  restRequest,
  insertRows,
  updateRows,
  selectRows
} = require('./_lib/supabaseRest');

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function json(res, status, body) {
  res.status(status).json(body);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  }
  return b || {};
}

/** Human-friendly pairing code: 8 chars, no ambiguous glyphs (0/O, 1/I/L). */
function generatePairingCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

/** Normalise a code the agent typed: strip spaces/dashes, uppercase. */
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Bearer token from the Authorization header, or ''. */
function bearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function logRun({ userId, installId, kind, received, upserted, status, error }) {
  try {
    await insertRows('tally_sync_runs', [{
      user_id: userId,
      install_id: installId || null,
      kind,
      rows_received: received || 0,
      rows_upserted: upserted || 0,
      status,
      error_message: error ? String(error).slice(0, 500) : null,
      finished_at: new Date().toISOString()
    }]);
  } catch (e) {
    console.error('tally_sync_runs write failed:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* router                                                            */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  try {
    if (req.method === 'POST' && action === 'pair-init')      return await handlePairInit(req, res);
    if (req.method === 'POST' && action === 'pair-complete')  return await handlePairComplete(req, res);
    if (req.method === 'POST' && action === 'ingest')         return await handleIngest(req, res);
    if (req.method === 'GET'  && action === 'status')         return await handleStatus(req, res);
    if (req.method === 'POST' && action === 'revoke')         return await handleRevoke(req, res);
  } catch (err) {
    console.error('tally.js unhandled error:', err && err.message);
    return json(res, 500, { error: 'server_error', message: 'Something went wrong. Try again.' });
  }

  return json(res, 400, {
    error: 'unknown_action',
    message: 'Expected ?action= one of pair-init, pair-complete, ingest, status, revoke.'
  });
};

/* ------------------------------------------------------------------ */
/* pair-init — POST ?action=pair-init   (user JWT)                    */
/* body (optional): { companyHint }                                   */
/* ------------------------------------------------------------------ */
async function handlePairInit(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  const body = parseBody(req);
  const companyHint = typeof body.companyHint === 'string' ? body.companyHint.trim().slice(0, 120) : null;

  // Invalidate any earlier unused codes for this user so only the newest works.
  try {
    await updateRows(
      'tally_pairings',
      `user_id=eq.${user.id}&used=is.false`,
      { used: true, used_at: new Date().toISOString() }
    );
  } catch (e) { /* non-fatal */ }

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    await insertRows('tally_pairings', [{
      user_id: user.id,
      code_hash: sha256(normalizeCode(code)),
      company_hint: companyHint,
      expires_at: expiresAt
    }]);
  } catch (e) {
    return json(res, 500, { error: 'pairing_create_failed', message: 'Could not create a pairing code. Try again.' });
  }

  return json(res, 200, { code, expires_at: expiresAt, ttl_seconds: 600 });
}

/* ------------------------------------------------------------------ */
/* pair-complete — POST ?action=pair-complete   (pairing code)        */
/* body: { code, companyName, companyGuid?, machineHint?,             */
/*         agentVersion?, tallyVersion? }                             */
/* Returns the install key exactly ONCE.                              */
/* ------------------------------------------------------------------ */
async function handlePairComplete(req, res) {
  const body = parseBody(req);
  const codeNorm = normalizeCode(body.code);
  const companyName = typeof body.companyName === 'string' ? body.companyName.trim().slice(0, 120) : '';

  if (codeNorm.length < 6) return json(res, 400, { error: 'bad_code', message: 'Enter the pairing code from Margyn.' });
  if (!companyName)        return json(res, 400, { error: 'missing_company', message: 'Enter the TallyPrime company name.' });

  const codeHash = sha256(codeNorm);

  let rows;
  try {
    rows = await selectRows(
      'tally_pairings',
      `select=id,user_id,used,attempts,expires_at,company_hint&code_hash=eq.${codeHash}&order=created_at.desc&limit=1`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const pairing = rows && rows[0];
  // Uniform response for "no such code" / expired / used / locked — don't leak which.
  const reject = () => json(res, 401, { error: 'pairing_invalid', message: 'That pairing code is invalid or has expired. Generate a new one in Margyn.' });

  if (!pairing) return reject();
  if (pairing.attempts >= 5) return reject();
  if (pairing.used) return reject();
  if (new Date(pairing.expires_at).getTime() < Date.now()) return reject();

  // Mint the install key. 32 random bytes, hex-encoded -> 64 chars.
  const installKey = 'mtly_' + crypto.randomBytes(32).toString('hex');
  const keyHash = sha256(installKey);

  let install;
  try {
    const inserted = await insertRows('tally_installs', [{
      user_id: pairing.user_id,
      key_hash: keyHash,
      company_name: companyName,
      company_guid: typeof body.companyGuid === 'string' ? body.companyGuid.trim().slice(0, 120) : null,
      machine_hint: typeof body.machineHint === 'string' ? body.machineHint.trim().slice(0, 160) : null,
      agent_version: typeof body.agentVersion === 'string' ? body.agentVersion.trim().slice(0, 40) : null,
      tally_product: ['tallyprime', 'erp9', 'unknown'].indexOf(body.tallyProduct) !== -1 ? body.tallyProduct : null,
      tally_product_name: typeof body.tallyProductName === 'string' ? body.tallyProductName.trim().slice(0, 60) : null,
      tally_version: typeof body.tallyVersion === 'string' ? body.tallyVersion.trim().slice(0, 40) : null,
      tally_edition: ['silver', 'gold', 'educational'].indexOf(body.tallyEdition) !== -1 ? body.tallyEdition : null,
      tally_serial_last4: typeof body.tallySerialLast4 === 'string' ? body.tallySerialLast4.replace(/\D/g, '').slice(-4) : null,
      status: 'active',
      last_seen_at: new Date().toISOString()
    }]);
    install = inserted[0];
  } catch (e) {
    return json(res, 500, { error: 'install_create_failed', message: 'Could not register this agent. Try again.' });
  }

  try {
    await updateRows('tally_pairings', `id=eq.${pairing.id}`, {
      used: true,
      used_at: new Date().toISOString()
    });
  } catch (e) { /* the install exists; a stale unused flag is harmless */ }

  await logRun({ userId: pairing.user_id, installId: install.id, kind: 'pair', status: 'ok' });

  return json(res, 200, {
    install_id: install.id,
    install_key: installKey,       // shown once, never retrievable again
    company_name: companyName
  });
}

/* ------------------------------------------------------------------ */
/* Resolve an agent request to its active install via the bearer key. */
/* ------------------------------------------------------------------ */
async function resolveInstall(req) {
  const key = bearer(req);
  if (!key) return null;
  let rows;
  try {
    rows = await selectRows(
      'tally_installs',
      `select=id,user_id,company_name,status&key_hash=eq.${sha256(key)}&limit=1`
    );
  } catch (e) {
    return null;
  }
  const inst = rows && rows[0];
  if (!inst || inst.status !== 'active') return null;
  return inst;
}

/* ------------------------------------------------------------------ */
/* ingest — POST ?action=ingest   (install key)                       */
/* body: { kind: 'ledgers'|'vouchers'|'bills', company_name?,         */
/*         company_guid?, as_of_date?, rows: [...] }                  */
/* ------------------------------------------------------------------ */

const INGEST = {
  ledgers: {
    table: 'tally_ledgers',
    onConflict: 'install_id,tally_guid',
    map: (r, ctx) => ({
      user_id: ctx.userId,
      install_id: ctx.installId,
      company_name: ctx.companyName,
      tally_guid: str(r.guid) || synthGuid(ctx.installId, 'ledger', r.name),
      tally_master_id: str(r.master_id),
      name: str(r.name),
      parent: str(r.parent),
      opening_balance: num(r.opening_balance),
      closing_balance: num(r.closing_balance),
      closing_balance_raw: str(r.closing_balance_raw != null ? r.closing_balance_raw : r.closing_balance),
      currency: str(r.currency) || 'INR',
      as_of_date: ctx.asOfDate,
      source: 'tally',
      verification_status: 'signal',
      synced_at: ctx.now
    }),
    valid: (r) => !!str(r.name)
  },
  vouchers: {
    table: 'tally_vouchers',
    onConflict: 'install_id,tally_guid',
    map: (r, ctx) => ({
      user_id: ctx.userId,
      install_id: ctx.installId,
      company_name: ctx.companyName,
      tally_guid: str(r.guid) || synthGuid(ctx.installId, 'voucher', (r.voucher_type || '') + '|' + (r.voucher_number || '') + '|' + (r.date || '')),
      voucher_type: str(r.voucher_type),
      voucher_number: str(r.voucher_number),
      date: str(r.date),
      narration: str(r.narration),
      party_name: str(r.party_name),
      amount: num(r.amount),
      is_cancelled: r.is_cancelled === true,
      entries: Array.isArray(r.entries) ? r.entries : null,
      source: 'tally',
      verification_status: 'signal',
      synced_at: ctx.now
    }),
    valid: (r) => !!str(r.voucher_type) || !!str(r.voucher_number)
  },
  bills: {
    table: 'tally_bills',
    onConflict: 'install_id,direction,party_name,bill_ref',
    map: (r, ctx) => ({
      user_id: ctx.userId,
      install_id: ctx.installId,
      company_name: ctx.companyName,
      direction: r.direction === 'payable' ? 'payable' : 'receivable',
      party_name: str(r.party_name) || 'Unknown',
      bill_ref: str(r.bill_ref) || '(unspecified)',
      bill_date: str(r.bill_date),
      due_date: str(r.due_date),
      closing_balance: num(r.closing_balance),
      overdue_days: r.overdue_days != null ? parseInt(r.overdue_days, 10) : null,
      source: 'tally',
      verification_status: 'signal',
      synced_at: ctx.now
    }),
    valid: (r) => !!str(r.party_name)
  }
};

function str(v) { return v == null ? null : String(v).trim() || null; }
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function synthGuid(installId, kind, seed) {
  return kind + ':' + crypto.createHash('sha1').update(installId + '|' + seed).digest('hex').slice(0, 24);
}

async function handleIngest(req, res) {
  const inst = await resolveInstall(req);
  if (!inst) return json(res, 401, { error: 'unauthorized', message: 'Invalid or revoked install key. Re-pair this agent in Margyn.' });

  const body = parseBody(req);
  const kind = body.kind;
  const spec = INGEST[kind];
  if (!spec) return json(res, 400, { error: 'bad_kind', message: 'kind must be one of ledgers, vouchers, bills.' });

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (rawRows.length > 5000) return json(res, 413, { error: 'batch_too_large', message: 'Send at most 5000 rows per request.' });

  // Touch last_seen_at on every authenticated call.
  const now = new Date().toISOString();
  updateRows('tally_installs', `id=eq.${inst.id}`, { last_seen_at: now }).catch(() => {});

  const companyName = str(body.company_name) || inst.company_name;
  const asOfDate = str(body.as_of_date);

  const ctx = { userId: inst.user_id, installId: inst.id, companyName, asOfDate, now };

  const mapped = [];
  let skipped = 0;
  for (const r of rawRows) {
    if (!r || typeof r !== 'object' || !spec.valid(r)) { skipped++; continue; }
    mapped.push(spec.map(r, ctx));
  }

  if (mapped.length === 0) {
    await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted: 0, status: 'ok' });
    return json(res, 200, { upserted: 0, received: rawRows.length, skipped });
  }

  let upserted = 0;
  try {
    // PostgREST upsert with merge-duplicates on the natural key.
    const result = await insertRows(spec.table, mapped, { onConflict: spec.onConflict, merge: true });
    upserted = Array.isArray(result) ? result.length : mapped.length;
  } catch (e) {
    await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted: 0, status: 'error', error: e.message });
    return json(res, 500, { error: 'ingest_failed', message: 'Could not store the synced data. Check the SQL migration ran.' });
  }

  await updateRows('tally_installs', `id=eq.${inst.id}`, { last_sync_at: now }).catch(() => {});
  await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted, status: 'ok' });

  return json(res, 200, { upserted, received: rawRows.length, skipped });
}

/* ------------------------------------------------------------------ */
/* status — GET ?action=status   (user JWT)                           */
/* ------------------------------------------------------------------ */
async function handleStatus(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  let installs;
  try {
    installs = await selectRows(
      'tally_installs',
      // NOTE: key_hash is deliberately excluded from this select list.
      `select=id,company_name,company_guid,machine_hint,agent_version,tally_product,tally_product_name,tally_version,tally_edition,status,created_at,last_seen_at,last_sync_at,revoked_at&user_id=eq.${user.id}&order=created_at.desc`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const out = [];
  for (const inst of installs) {
    const counts = { ledgers: 0, vouchers: 0, bills: 0 };
    try {
      counts.ledgers = await countRows('tally_ledgers', `install_id=eq.${inst.id}`);
      counts.vouchers = await countRows('tally_vouchers', `install_id=eq.${inst.id}`);
      counts.bills = await countRows('tally_bills', `install_id=eq.${inst.id}`);
    } catch (e) { /* counts are cosmetic */ }

    let lastRun = null;
    try {
      const runs = await selectRows(
        'tally_sync_runs',
        `select=kind,status,rows_upserted,started_at,error_message&install_id=eq.${inst.id}&order=started_at.desc&limit=1`
      );
      lastRun = runs && runs[0] ? runs[0] : null;
    } catch (e) { /* non-fatal */ }

    out.push({ ...inst, counts, last_run: lastRun });
  }

  return json(res, 200, {
    connected: out.some((i) => i.status === 'active'),
    installs: out
  });
}

async function countRows(table, filter) {
  const r = await restRequest(`${table}?${filter}&select=id`, {
    method: 'HEAD',
    headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }
  });
  const cr = r.headers.get('content-range') || '';
  const total = cr.split('/')[1];
  return total && total !== '*' ? parseInt(total, 10) : 0;
}

/* ------------------------------------------------------------------ */
/* revoke — POST ?action=revoke   (user JWT)                          */
/* body: { installId }                                                */
/* ------------------------------------------------------------------ */
async function handleRevoke(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  const body = parseBody(req);
  const installId = str(body.installId);
  if (!installId) return json(res, 400, { error: 'missing_install_id' });

  let rows;
  try {
    rows = await selectRows('tally_installs', `select=id&id=eq.${installId}&user_id=eq.${user.id}&limit=1`);
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }
  if (!rows || !rows[0]) return json(res, 404, { error: 'install_not_found' });

  try {
    await updateRows('tally_installs', `id=eq.${installId}&user_id=eq.${user.id}`, {
      status: 'revoked',
      revoked_at: new Date().toISOString()
    });
  } catch (e) {
    return json(res, 500, { error: 'revoke_failed' });
  }

  return json(res, 200, {
    revoked: true,
    message: 'This agent can no longer sync. Your already-synced Tally data stays visible. To fully stop it, also close the agent on that PC.'
  });
}
