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
 *   GET  /api/tally?action=analytics      (user JWT)   P&L, margin, customers, working capital, GST est., data quality
 *   POST /api/tally?action=classify       (user JWT)   confirm which P&L bucket a ledger belongs to
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
const { track } = require('./_lib/track');
const { computeAnalytics, PL_BUCKETS } = require('./_lib/tallyAnalytics');
const { calibrateBills } = require('./_lib/tallyBills');
const { classifyLedgersWithAI } = require('./_lib/tallyAiClassify');

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
    if (req.method === 'POST' && action === 'health')         return await handleHealth(req, res);
    if (req.method === 'GET'  && action === 'status')         return await handleStatus(req, res);
    if (req.method === 'GET'  && action === 'summary')        return await handleSummary(req, res);
    if (req.method === 'GET'  && action === 'analytics')      return await handleAnalytics(req, res);
    if (req.method === 'POST' && action === 'classify')       return await handleClassify(req, res);
    if (req.method === 'POST' && action === 'revoke')         return await handleRevoke(req, res);
  } catch (err) {
    console.error('tally.js unhandled error:', err && err.message);
    return json(res, 500, { error: 'server_error', message: 'Something went wrong. Try again.' });
  }

  return json(res, 400, {
    error: 'unknown_action',
    message: 'Expected ?action= one of pair-init, pair-complete, ingest, status, summary, analytics, classify, revoke.'
  });
};

/* ------------------------------------------------------------------ */
/* summary — GET ?action=summary   (user JWT)                         */
/* A read-only, pre-aggregated view of everything this user's Tally   */
/* agents have synced — bills (receivable/payable), vouchers by type, */
/* and ledger closing balances. All maths happens here so the app and */
/* the AI layer can never quote different Tally numbers. Everything is */
/* provenance 'signal' — one source, never auto-trusted.              */
/* ------------------------------------------------------------------ */
async function handleSummary(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  let installs = [];
  try {
    installs = await selectRows(
      'tally_installs',
      `select=id,company_name,last_sync_at,last_seen_at&user_id=eq.${user.id}&status=eq.active&order=last_sync_at.desc`
    );
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const empty = {
    connected: false, company_name: null, as_of: null,
    bills: { receivable_total: 0, payable_total: 0, overdue_total: 0, count: 0, items: [] },
    vouchers: { count: 0, by_type: {}, sales_30d: 0, receipts_30d: 0 },
    ledgers: { count: 0, items: [] },
    provenance: 'signal'
  };
  if (!installs.length) return json(res, 200, empty);

  const ids = installs.map((i) => i.id);
  const inList = `(${ids.join(',')})`;
  const asOf = installs.map((i) => i.last_sync_at).filter(Boolean).sort().pop() || null;

  let bills = [], vouchers = [], ledgers = [];
  try {
    // Totals must cover every open bill and ledger, not the first 500 (the old cap made
    // receivables look tiny and payables huge, and dropped most bank/GST ledgers).
    const [B, V, L] = await Promise.all([
      pagedAll('tally_bills', `select=direction,party_name,bill_ref,bill_date,due_date,closing_balance,overdue_days,company_name&install_id=in.${inList}&order=overdue_days.desc.nullslast,party_name.asc,bill_ref.asc`, 20000),
      // PostgREST returns at most 1,000 rows per request, so page: a busy book has more than
      // 1,000 vouchers in 30 days and sales_30d was undercounting.
      pagedAll('tally_vouchers', `select=voucher_type,voucher_base,voucher_number,date,party_name,amount&install_id=in.${inList}&order=date.desc,tally_guid.asc`, 4000)
        .catch(() => pagedAll('tally_vouchers', `select=voucher_type,voucher_number,date,party_name,amount&install_id=in.${inList}&order=date.desc,tally_guid.asc`, 4000)),
      pagedAll('tally_ledgers', `select=name,parent,closing_balance&install_id=in.${inList}&order=name.asc,tally_guid.asc`, 10000)
    ]);
    bills = B.rows; vouchers = V.rows; ledgers = L.rows;
    try { bills = calibrateBills(bills, vouchers).bills; } catch (e) { /* keep stored labels */ }
  } catch (e) {
    return json(res, 500, { error: 'lookup_failed' });
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const cutoff = Date.now() - 30 * 86400000;
  const dateMs = (d) => {
    if (!d) return NaN;
    const s = String(d);
    const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
    return new Date(iso).getTime();
  };

  let receivableTotal = 0, payableTotal = 0, overdueTotal = 0, recvOver90 = 0, payDue30 = 0;
  const billItems = bills.map((b) => {
    const bal = Math.abs(Number(b.closing_balance) || 0);
    if (b.direction === 'payable') payableTotal += bal; else receivableTotal += bal;
    if ((b.overdue_days || 0) > 0) overdueTotal += bal;
    if (b.direction !== 'payable' && (b.overdue_days || 0) > 90) recvOver90 += bal;
    if (b.direction === 'payable') {
      const dueMs = dateMs(b.due_date);
      if (Number.isNaN(dueMs) || dueMs <= Date.now() + 30 * 86400000) payDue30 += bal;
    }
    return {
      direction: b.direction === 'payable' ? 'payable' : 'receivable',
      party_name: b.party_name || 'Unknown',
      bill_ref: b.bill_ref || null,
      bill_date: b.bill_date || null,
      due_date: b.due_date || null,
      amount: bal,
      overdue_days: b.overdue_days != null ? b.overdue_days : null
    };
  });

  const byType = {};
  let sales30 = 0, receipts30 = 0;
  for (const v of vouchers) {
    const t = v.voucher_type || 'Other';
    byType[t] = (byType[t] || 0) + 1;
    const ms = dateMs(v.date);
    if (!Number.isNaN(ms) && ms >= cutoff) {
      const amt = Math.abs(Number(v.amount) || 0);
      const bt = v.voucher_base || t;
      if (/\bsales?\b/i.test(bt) && !/credit|return|order/i.test(bt)) sales30 += amt;
      if (/receipt/i.test(t)) receipts30 += amt;
    }
  }

  const ledgerItems = ledgers
    .map((l) => ({ name: l.name, parent: l.parent || null, closing_balance: l.closing_balance != null ? Number(l.closing_balance) : null }))
    .filter((l) => l.name);
  // The browser only needs a bounded list: every bank, cash, loan and duties/tax ledger first
  // (Cash and GST pages read these), then the biggest remaining balances.
  const KEEP = /(bank|cash|overdraft|\bo\/?d\b|loan|duties|tax|gst|tds|tcs)/i;
  const keep = ledgerItems.filter((l) => KEEP.test(String(l.parent || '')) || KEEP.test(String(l.name || '')));
  const rest = ledgerItems.filter((l) => !keep.includes(l)).sort((a, b) => Math.abs(b.closing_balance || 0) - Math.abs(a.closing_balance || 0));
  const ledgerOut = keep.concat(rest).slice(0, 400);

  return json(res, 200, {
    connected: true,
    company_name: installs[0].company_name || (bills[0] && bills[0].company_name) || null,
    as_of: asOf,
    bills: {
      receivable_total: round2(receivableTotal),
      payable_total: round2(payableTotal),
      overdue_total: round2(overdueTotal),
      receivable_over_90: round2(recvOver90),
      payable_due_30d: round2(payDue30),
      count: billItems.length,
      items: billItems.slice(0, 100)
    },
    vouchers: {
      count: vouchers.length,
      by_type: byType,
      sales_30d: round2(sales30),
      receipts_30d: round2(receipts30),
      recent: vouchers.slice(0, 40).map((v) => ({
        voucher_type: v.voucher_type || 'Other',
        voucher_number: v.voucher_number || null,
        date: v.date || null,
        party_name: v.party_name || null,
        amount: Math.abs(Number(v.amount) || 0)
      }))
    },
    ledgers: { count: ledgerItems.length, items: ledgerOut },
    provenance: 'signal'
  });
}


/* ------------------------------------------------------------------ */
/* analytics — GET ?action=analytics[&company=NAME&credit_rate=0.12]   */
/* Everything the agent already syncs, turned into margin analytics.   */
/* All maths lives in api/_lib/tallyAnalytics.js (pure, unit-tested).  */
/* ------------------------------------------------------------------ */
// PostgREST caps a page at 1,000 rows. Fetch pages four at a time instead of one after
// another so a year of vouchers fits comfortably inside the function's time limit.
async function pagedAll(table, query, max) {
  const pageSize = 1000, rows = [];
  for (let offset = 0; offset < max; offset += pageSize * 4) {
    const pages = await Promise.all([0, 1, 2, 3].map((i) =>
      offset + i * pageSize < max ? selectRows(table, `${query}&limit=${pageSize}&offset=${offset + i * pageSize}`) : []));
    let short = false;
    for (const p of pages) { rows.push(...p); if (p.length < pageSize) short = true; }
    if (short) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function handleAnalytics(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  let installs;
  try {
    installs = await selectRows(
      'tally_installs',
      `select=id,company_name,last_sync_at,tally_edition&user_id=eq.${user.id}&status=eq.active&order=last_sync_at.desc.nullslast`
    );
  } catch (e) { return json(res, 500, { error: 'lookup_failed' }); }
  let diagnostics = null;
  try {
    const D = await selectRows('tally_installs', `select=id,diagnostics&user_id=eq.${user.id}&status=eq.active&order=last_sync_at.desc.nullslast`);
    const byId = Object.fromEntries(D.map((d) => [d.id, d.diagnostics]));
    installs.forEach((i) => { i.diagnostics = byId[i.id] || null; });
  } catch (e) { /* diagnostics column not migrated yet */ }
  if (!installs.length) return json(res, 200, { connected: false });

  const companies = [...new Set(installs.map((i) => i.company_name).filter(Boolean))];
  const want = String((req.query && req.query.company) || '').trim();
  const company = want && companies.includes(want) ? want : (installs[0].company_name || null);
  const chosen = installs.filter((i) => (company ? i.company_name === company : true));
  const inList = `(${chosen.map((i) => i.id).join(',')})`;
  const lastSync = chosen.map((i) => i.last_sync_at).filter(Boolean).sort().pop() || null;
  diagnostics = (chosen.find((i) => i.diagnostics) || {}).diagnostics || null;

  let ledgers, bills, vouchers, truncated = false, overrides = {}, syncRuns = [];
  const aiPlaced = new Set();
  try {
    // The three reads are independent; run them together. Vouchers are the big one,
    // so they page four requests at a time (see pagedAll).
    const base = 'voucher_type,voucher_number,tally_guid,date,party_name,amount,is_cancelled,entries';
    // Newer columns arrive with migrations; try the richest select first and fall back column by column.
    const voucherQ = async () => {
      let last;
      for (const extra of [',items,voucher_base', ',items', ',voucher_base', '']) {
        try { return await pagedAll('tally_vouchers', `select=${base}${extra}&install_id=in.${inList}&order=date.asc,tally_guid.asc`, 20000); }
        catch (e) { last = e; }
      }
      throw last;
    };
    const ledgerQ = async () => {
      try { return await pagedAll('tally_ledgers', `select=name,parent,primary_group,opening_balance,closing_balance&install_id=in.${inList}&order=name.asc,tally_guid.asc`, 5000); }
      catch (e) { return await pagedAll('tally_ledgers', `select=name,parent,opening_balance,closing_balance&install_id=in.${inList}&order=name.asc,tally_guid.asc`, 5000); }
    };
    const [L, B, V] = await Promise.all([
      ledgerQ(),
      pagedAll('tally_bills', `select=direction,party_name,bill_ref,bill_date,due_date,closing_balance,overdue_days&install_id=in.${inList}&order=party_name.asc,bill_ref.asc`, 10000),
      voucherQ()
    ]);
    ledgers = L.rows; bills = B.rows; vouchers = V.rows; truncated = V.truncated;
  } catch (e) { return json(res, 500, { error: 'lookup_failed' }); }

  try {
    const O = await selectRows('tally_ledger_classes', `select=ledger_name,bucket,set_by&user_id=eq.${user.id}${company ? '&company_name=eq.' + encodeURIComponent(company) : ''}`);
    overrides = Object.fromEntries(O.map((o) => [o.ledger_name, o.bucket]));
    for (const o of O) if (!o.set_by) aiPlaced.add(o.ledger_name);   // set_by null = placed by the model
  } catch (e) { /* table not created yet: no overrides */ }
  try {
    // The agent soft-fails vouchers and bills, so the last outcome per kind is part of how far to trust this.
    syncRuns = await selectRows('tally_sync_runs', `select=kind,status,error_message,rows_received,started_at&user_id=eq.${user.id}&install_id=in.${inList}&order=started_at.desc&limit=40`);
  } catch (e) { /* older deployments */ }

  const rate = parseFloat(req.query && req.query.credit_rate);
  const run = (ov) => computeAnalytics({ ledgers, vouchers, bills, overrides: ov, syncRuns, diagnostics, edition: (chosen.find((i) => i.tally_edition) || {}).tally_edition || null, creditRate: Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0.12 });
  let out = run(overrides);

  // Whatever Tally's own groups could not place, the model places once and we remember it. Never overrides
  // a person's answer (those are in `overrides` already), and the arithmetic stays deterministic.
  const pending = (out.quality.unclassified_ledgers || []).concat(out.quality.guessed_ledgers || [])
    .filter((x) => !(x.ledger in overrides)).slice(0, 40);
  if (pending.length && process.env.ANTHROPIC_API_KEY) {
    const groupOf = new Map(ledgers.map((l) => [l.name, l.primary_group || null]));
    const placed = await classifyLedgersWithAI(pending.map((x) => ({ ledger: x.ledger, parent: x.parent, primary_group: groupOf.get(x.ledger) || null, vouchers: x.vouchers, volume: x.volume })),
      { apiKey: process.env.ANTHROPIC_API_KEY });
    if (placed.length) {
      try {
        await insertRows('tally_ledger_classes', placed.map((x) => ({
          user_id: user.id, company_name: company || '', ledger_name: x.ledger, bucket: x.bucket, set_by: null, updated_at: new Date().toISOString()
        })), { onConflict: 'user_id,company_name,ledger_name', merge: true });
      } catch (e) { /* table missing: still use the answers for this response */ }
      for (const x of placed) { overrides[x.ledger] = x.bucket; aiPlaced.add(x.ledger); }
      out = run(overrides);
    }
  }
  if (aiPlaced.size) {
    out.quality.ai_classified = [...aiPlaced].slice(0, 30).map((l) => ({ ledger: l, bucket: overrides[l] }));
    out.quality.reasons.unshift(`Margyn placed ${aiPlaced.size} ledger(s) in the profit and loss for you (e.g. ${[...aiPlaced].slice(0, 3).join(', ')}). Change any of them under “Margyn needs your help”.`);
  }
  const staleH = lastSync ? Math.round((Date.now() - Date.parse(lastSync)) / 3600000) : null;
  if (staleH != null && staleH > 48) out.quality.reasons.unshift(`Last sync was ${staleH} hours ago. Numbers may be behind Tally.`);
  if (truncated) out.quality.reasons.unshift('Voucher history was capped at 20,000 rows, so older months may be incomplete.');
  return json(res, 200, { connected: true, company_name: company, companies, last_sync_at: lastSync, stale_hours: staleH, truncated, ...out });
}

/* ------------------------------------------------------------------ */
/* classify — POST ?action=classify  body { ledger, bucket, company? }  */
/* The user confirms which P&L bucket a ledger belongs to. Stored once  */
/* and reused on every later sync. bucket '' clears the override.       */
/* ------------------------------------------------------------------ */
const CLASSIFY_BUCKETS = PL_BUCKETS.concat(['tax', 'debtor', 'creditor', 'bank', 'cash', 'stock', 'balance_sheet']);

// Changing how a ledger is treated changes the margin, so it goes in the Audit log with who did it.
async function auditClassify(user, company, ledger, bucket) {
  const row = {
    user_id: user.id, entity_type: 'margin mapping', event: 'updated', party_name: ledger, source: 'tally',
    note: (bucket ? 'Counted as ' + bucket.replace(/_/g, ' ') : 'Mapping cleared') + (company ? ' (' + company + ')' : '')
  };
  try {
    const who = user.member ? (user.member.name || user.email) : user.email;
    await insertRows('ledger_events', [{ ...row, actor_id: user.auth_id || user.id, actor_name: who || null, channel: 'app' }]);
  } catch (e) {
    await insertRows('ledger_events', [row]).catch(() => {});   // before the 09-30 actor columns
  }
}

async function handleClassify(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });

  const body = parseBody(req);
  const ledger = str(body.ledger);
  const bucket = body.bucket == null ? '' : String(body.bucket);
  const company = str(body.company) || '';
  if (company.length > 200) return json(res, 400, { error: 'bad_company' });
  if (!ledger || ledger.length > 200) return json(res, 400, { error: 'bad_ledger' });
  if (bucket && !CLASSIFY_BUCKETS.includes(bucket)) return json(res, 400, { error: 'bad_bucket', message: 'bucket must be one of ' + CLASSIFY_BUCKETS.join(', ') });

  try {
    if (!bucket) {
      const del = await restRequest(`tally_ledger_classes?user_id=eq.${user.id}&company_name=eq.${encodeURIComponent(company)}&ledger_name=eq.${encodeURIComponent(ledger)}`, { method: 'DELETE' });
      if (!del.ok) return json(res, 500, { error: 'save_failed' });
      await auditClassify(user, company, ledger, null);
      return json(res, 200, { ok: true, cleared: true });
    }
    await insertRows('tally_ledger_classes', [{
      user_id: user.id, company_name: company, ledger_name: ledger, bucket,
      set_by: user.auth_id || user.id, updated_at: new Date().toISOString()
    }], { onConflict: 'user_id,company_name,ledger_name', merge: true });
  } catch (e) { return json(res, 500, { error: 'save_failed' }); }
  await auditClassify(user, company, ledger, bucket);
  return json(res, 200, { ok: true, ledger, bucket });
}

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
      primary_group: str(r.primary_group),
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
      voucher_base: ctx.voucherTypes ? (ctx.voucherTypes[str(r.voucher_type)] || null) : null,
      voucher_number: str(r.voucher_number),
      date: str(r.date),
      narration: str(r.narration),
      party_name: str(r.party_name),
      amount: num(r.amount),
      is_cancelled: r.is_cancelled === true,
      entries: Array.isArray(r.entries) ? r.entries : null,
      items: Array.isArray(r.items) ? r.items : null,
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

  const vt = body.voucher_types && typeof body.voucher_types === 'object' && !Array.isArray(body.voucher_types) ? body.voucher_types : null;
  const ctx = { userId: inst.user_id, installId: inst.id, companyName, asOfDate, now, voucherTypes: vt };

  const mapped = [];
  let skipped = 0;
  for (const r of rawRows) {
    if (!r || typeof r !== 'object' || !spec.valid(r)) { skipped++; continue; }
    mapped.push(spec.map(r, ctx));
  }

  if (mapped.length === 0) {
    // An empty, verified voucher window still matters: everything we hold in it was deleted in Tally.
    const swept0 = kind === 'vouchers' ? await sweepVoucherWindow(inst, body, now) : { removed: 0 };
    await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted: 0, status: 'ok' });
    return json(res, 200, { upserted: 0, received: rawRows.length, skipped, removed: swept0.removed, server_time: now, agent: agentDirective() });
  }

  let upserted = 0;
  try {
    // PostgREST upsert with merge-duplicates on the natural key.
    // Columns added by later migrations (items, voucher_base, primary_group) may not exist yet. A missing
    // column must never cost a whole batch: drop just that column and retry (PGRST204 names it).
    let result, rows = mapped;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await insertRows(spec.table, rows, { onConflict: spec.onConflict, merge: true });
        break;
      } catch (e) {
        const col = /Could not find the '([a-z_]+)' column/i.exec(String(e && e.message));
        if (!col || attempt >= 4 || !['items', 'voucher_base', 'primary_group'].includes(col[1])) throw e;
        console.warn(`[tally] ${spec.table}.${col[1]} missing; storing without it. Run the SQL migration.`);
        rows = rows.map((r) => { const o = Object.assign({}, r); delete o[col[1]]; return o; });
      }
    }
    upserted = Array.isArray(result) ? result.length : mapped.length;
  } catch (e) {
    await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted: 0, status: 'error', error: e.message });
    return json(res, 500, { error: 'ingest_failed', message: 'Could not store the synced data. Check the SQL migration ran.' });
  }

  const swept = kind === 'vouchers'
    ? await sweepVoucherWindow(inst, body, now)
    : await sweepStale(kind, inst, mapped, snapshotCutoff(body, now), body.partial === true);

  await updateRows('tally_installs', `id=eq.${inst.id}`, { last_sync_at: now }).catch(() => {});
  await logRun({ userId: inst.user_id, installId: inst.id, kind, received: rawRows.length, upserted, status: 'ok',
    error: swept.skipped ? 'stale_sweep_skipped: ' + swept.skipped : null });
  track(inst.user_id, 'tally_agent_sync', { kind, rows: upserted }); // ops console — fire-and-forget

  // server_time: agents chunk big snapshots/windows and use THIS clock (never their PC's) as the cutoff.
  return json(res, 200, { upserted, received: rawRows.length, skipped, removed: swept.removed, server_time: now, agent: agentDirective() });
}

// A chunked ledger snapshot sweeps on its last batch with the server time of its first batch as the
// cutoff. Accept only a sane time: in the past, within the last six hours.
function snapshotCutoff(body, now) {
  const t = Date.parse(body && body.snapshot_started_at);
  const n = Date.parse(now);
  return Number.isFinite(t) && t <= n && n - t < 6 * 3600 * 1000 ? new Date(t).toISOString() : now;
}

/* ------------------------------------------------------------------ */
/* voucher window replace (agent 0.2.0+)                              */
/* ------------------------------------------------------------------ */
// The agent sends a month of vouchers it has verified complete against Tally's own count, ending
// with window_final. Vouchers we hold in that month that were not re-sent since the window started
// were deleted (or re-dated) in Tally, so they go. Same safety valve as sweepStale: a batch that
// would wipe most of a month is treated as a Tally-side glitch and kept.
async function sweepVoucherWindow(inst, body, now) {
  if (!body || body.window_final !== true || !body.window) return { removed: 0 };
  const from = str(body.window.from), to = str(body.window.to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) return { removed: 0, skipped: 'bad_window' };
  const cutoff = snapshotCutoff({ snapshot_started_at: body.window_started_at }, now);
  const scope = `install_id=eq.${inst.id}&date=gte.${from}&date=lte.${to}`;
  const stale = `${scope}&synced_at=lt.${encodeURIComponent(cutoff)}`;
  try {
    const [total, toRemove] = await Promise.all([countRows('tally_vouchers', scope), countRows('tally_vouchers', stale)]);
    if (!toRemove) return { removed: 0 };
    if (total >= 20 && toRemove > total * 0.6) {
      console.warn(`[tally] voucher window sweep skipped: would remove ${toRemove}/${total} (${from}..${to}) for install ${inst.id}`);
      return { removed: 0, skipped: `would_remove_${toRemove}_of_${total}` };
    }
    const r = await restRequest(`tally_vouchers?${stale}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return r.ok ? { removed: toRemove } : { removed: 0, skipped: 'delete_failed' };
  } catch (e) {
    console.error('[tally] voucher window sweep error:', e.message);
    return { removed: 0, skipped: 'error' };
  }
}

/* ------------------------------------------------------------------ */
/* health — POST ?action=health   (install key)                       */
/* What the agent saw in the client's Tally and what it sent: product, */
/* open companies, books period, which voucher request works there,    */
/* and per-month voucher counts vs Tally's own. Lets Margyn diagnose a */
/* client's sync without access to their machine.                      */
/* ------------------------------------------------------------------ */
async function handleHealth(req, res) {
  const inst = await resolveInstall(req);
  if (!inst) return json(res, 401, { error: 'unauthorized' });
  const body = parseBody(req);
  let text = '';
  try { text = JSON.stringify(body || {}); } catch (e) { return json(res, 400, { error: 'bad_body' }); }
  if (text.length > 60000) return json(res, 413, { error: 'too_large' });
  const t = body && body.tally && typeof body.tally === 'object' ? body.tally : {};
  const patch = { last_seen_at: new Date().toISOString() };
  if (typeof body.agent_version === 'string') patch.agent_version = body.agent_version.slice(0, 40);
  if (t.product) patch.tally_product = String(t.product).slice(0, 20);
  if (t.product_name) patch.tally_product_name = String(t.product_name).slice(0, 60);
  if (t.version) patch.tally_version = String(t.version).slice(0, 40);
  if (t.edition) patch.tally_edition = String(t.edition).slice(0, 20);
  if (typeof body.company === 'string' && body.company.trim()) patch.company_name = body.company.trim().slice(0, 120);
  try {
    await updateRows('tally_installs', `id=eq.${inst.id}`, Object.assign({}, patch, { diagnostics: body }));
  } catch (e) {
    // diagnostics column not migrated yet: keep the product facts at least
    await updateRows('tally_installs', `id=eq.${inst.id}`, patch).catch(() => {});
  }
  // One-off command for this PC (set by us in tally_installs.agent_command), delivered once.
  let command = null;
  try {
    const rows = await selectRows('tally_installs', `select=agent_command&id=eq.${inst.id}&limit=1`);
    command = rows && rows[0] && rows[0].agent_command && typeof rows[0].agent_command === 'object' ? rows[0].agent_command : null;
    if (command) await updateRows('tally_installs', `id=eq.${inst.id}`, { agent_command: null });
  } catch (e) { command = null; /* column not migrated yet */ }
  return json(res, 200, { ok: true, agent: agentDirective(command) });
}

/* ------------------------------------------------------------------ */
/* Agent directives — how Margyn steers agents it can't otherwise reach */
/* ------------------------------------------------------------------ */
// min_version: agents older than this update themselves immediately (agent 0.2.4+). Raise it with
// every agent release that must reach clients now: set TALLY_AGENT_MIN_VERSION in Vercel, or bump
// the default here. command: one-off per-install action, e.g. {"action":"resync"} — see
// 2026-10-02-tally-agent-commands.sql.
const TALLY_AGENT_MIN_VERSION_DEFAULT = '0.2.4';
function agentDirective(command) {
  const min = String(process.env.TALLY_AGENT_MIN_VERSION || TALLY_AGENT_MIN_VERSION_DEFAULT).trim();
  const out = { min_version: /^\d+\.\d+\.\d+$/.test(min) ? min : TALLY_AGENT_MIN_VERSION_DEFAULT };
  if (command && typeof command.action === 'string') out.command = { action: command.action.slice(0, 40) };
  return out;
}

/* ------------------------------------------------------------------ */
/* stale sweep — drop rows the latest full snapshot no longer contains */
/* ------------------------------------------------------------------ */
// Ledgers and bills arrive as a COMPLETE snapshot per request: the agent
// sends every ledger in one call, and every outstanding bill for one
// direction in one call (runFullSync in tally-agent/agent.js). So a row this
// install sent before but not in this batch no longer exists in Tally's
// report — for bills that almost always means it was PAID. Without this
// sweep a settled bill kept its old balance forever and inflated aging
// (2026-09-23 audit). These tables mirror Tally's current reports, not a
// history — the history lives in tally_vouchers, which is never swept
// (vouchers arrive by date window, not as a full snapshot).
//
// Safety valve: if a batch would remove most of what we hold, treat it as a
// Tally-side glitch (wrong company open, report truncated) and keep the rows.
// An agent that ever starts chunking a snapshot must send partial:true.
async function sweepStale(kind, inst, mapped, now, partial) {
  if (partial || (kind !== 'bills' && kind !== 'ledgers')) return { removed: 0 };
  const table = kind === 'bills' ? 'tally_bills' : 'tally_ledgers';
  let scope = `install_id=eq.${inst.id}`;
  if (kind === 'bills') {
    const dirs = [...new Set(mapped.map((r) => r.direction))];
    if (dirs.length !== 1) return { removed: 0, skipped: 'mixed_directions' };
    scope += `&direction=eq.${dirs[0]}`;
  }
  const stale = `${scope}&synced_at=lt.${encodeURIComponent(now)}`;
  try {
    const [total, toRemove] = await Promise.all([countRows(table, scope), countRows(table, stale)]);
    if (!toRemove) return { removed: 0 };
    if (total >= 20 && toRemove > total * 0.6) {
      console.warn(`[tally] sweep skipped: ${kind} batch would remove ${toRemove}/${total} rows for install ${inst.id}`);
      return { removed: 0, skipped: `would_remove_${toRemove}_of_${total}` };
    }
    const r = await restRequest(`${table}?${stale}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!r.ok) {
      console.error(`[tally] sweep delete failed: ${r.status}`);
      return { removed: 0, skipped: 'delete_failed' };
    }
    return { removed: toRemove };
  } catch (e) {
    console.error('[tally] sweep error:', e.message);
    return { removed: 0, skipped: 'error' };
  }
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
