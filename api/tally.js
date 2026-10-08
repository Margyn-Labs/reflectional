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
 *   GET  /api/tally?action=completeness   (user JWT)   is everything Tally sent stored, read and used (summaries only)
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
const { computeAnalytics, asOfToday, PL_BUCKETS } = require('./_lib/tallyAnalytics');
const { calibrateBills } = require('./_lib/tallyBills');
const { classifyLedgersWithAI } = require('./_lib/tallyAiClassify');
const { pagedAll, loadTallyBook } = require('./_lib/tallyData');
const { tallyCompleteness } = require('./_lib/dataCompleteness');
// The Books category in one place (Tally, Zoho Books, Odoo): the analytics read whichever keeps the books.
const { loadBooks, forgetBooks } = require('./_lib/dataLayer/books');
const { buildInsights, prepare: prepareBooks } = require('./_lib/booksEngine');
const cashFlow = require('./_lib/cashFlowModel');
const cashFlowStatement = require('./_lib/cashFlowStatement');
const forecastStore = require('./_lib/forecastStore');

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function json(res, status, body) {
  res.status(status).json(body);
}

/* Server-Timing: where a slow request spent its time, visible in the browser's network panel (timings only). */
function stopwatch() {
  const t0 = Date.now(), marks = [];
  let last = t0;
  return {
    mark(name) { const n = Date.now(); marks.push([name, n - last]); last = n; },
    header(res, extra) {
      const parts = marks.map(([k, ms]) => `${k};dur=${ms}`).concat([`total;dur=${Date.now() - t0}`]);
      if (extra) parts.push(extra);
      try { res.setHeader('Server-Timing', parts.join(', ')); } catch (e) { /* headers already sent */ }
    }
  };
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
    if (req.method === 'GET'  && action === 'completeness')   return await handleCompleteness(req, res);
    if (req.method === 'GET'  && action === 'books-check')    return await handleBooksCheck(req, res);
    if (req.method === 'POST' && action === 'books-check-set') return await handleBooksCheckSet(req, res);
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
    // Balances as of today: Tally's closing balances include entries already made for later dates
    // (EMIs entered in advance), which made cash look ₹9.45 L lower than the bank. Back those out.
    try {
      const todayYmd = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
      const F = await pagedAll('tally_vouchers', `select=date,is_cancelled,entries&install_id=in.${inList}&date=gt.${todayYmd}&order=date.asc,tally_guid.asc`, 2000);
      if (F.rows.length) {
        // This read has no opening balances or past entries, so it can't run asOfToday's tie-out guard itself: it
        // follows the decision the last books check made on the full books (books_health 'run:last').
        let decision;
        try {
          const run = await selectRows('books_health', `select=data&user_id=eq.${user.id}&key=eq.run:last&limit=1`);
          decision = run[0] && run[0].data && run[0].data.as_of_decision === 'kept' ? { decision: 'kept' } : undefined;
        } catch (e) { /* table not there yet: the usual reading */ }
        ledgers = asOfToday(ledgers, F.rows, Date.now(), undefined, decision).ledgers;
        vouchers = vouchers.filter((v) => !(String(v.date || '').replace(/-/g, '') > todayYmd));
      }
    } catch (e) { /* keep Tally's figures */ }
    try { bills = calibrateBills(bills, vouchers, { now: Date.now() }).bills; } catch (e) { /* keep stored labels */ }
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
  // A customer's on-account money shows in Tally as a bill on the vendor side; it isn't owed to anyone.
  const billItems = bills.filter((b) => !b.advance).map((b) => {
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
      // Counted over every bill: the list below is capped at 100, so counting it said "100" for Care Hygiene.
      overdue_count: billItems.filter((x) => (x.overdue_days || 0) > 0).length,
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

const AI_ASKED = new Map(), AI_ASK_AGAIN_MS = 24 * 3600000;   // user|company|ledger → when the model was last asked

// The whole answer for a book this instance already worked out today (same rows, same placements, same rate).
const _analyticsDone = new WeakMap();   // book -> { k, body }

async function handleAnalytics(req, res) {
  const sw = stopwatch();
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });
  sw.mark('auth');

  // One reader for the Margin page, Margyn's books tools and Margyn Watch (api/_lib/dataLayer/books.js).
  // Keyed on the last sync, so it is never older than the books (tallyData.js keeps a copy per sync).
  let book;
  try { book = await loadBooks(user.id, { company: req.query && req.query.company }); }
  catch (e) { return json(res, 500, { error: 'lookup_failed' }); }
  sw.mark('books');
  const rowsFrom = book.load ? `rows;desc="${book.load.rows_from}"` : null;
  if (!book.connected) return json(res, 200, { connected: false });
  const doneKey = [req.query && req.query.company || '', req.query && req.query.credit_rate || '', new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 13)].join('|');
  const done = _analyticsDone.get(book);
  if (done && done.k === doneKey) { sw.mark('reused'); sw.header(res, rowsFrom); return json(res, 200, done.body); }
  const { company, companies, chosen, ledgers, bills, vouchers, truncated, overrides, aiPlaced, syncRuns, diagnostics } = book;
  const lastSync = book.lastSync;

  const rate = parseFloat(req.query && req.query.credit_rate);
  const run = (ov) => computeAnalytics({ ledgers, vouchers, bills, overrides: ov, syncRuns, diagnostics, balance_convention: book.balance_convention, edition: (chosen.find((i) => i.tally_edition) || {}).tally_edition || null, creditRate: Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0.12 });
  let out = run(overrides);
  sw.mark('compute');

  // Whatever Tally's own groups could not place, the model places once and we remember it. Never overrides
  // a person's answer (those are in `overrides` already), and the arithmetic stays deterministic.
  // Ledgers the model was already asked about and couldn't place aren't asked again for a day: asking on every
  // load cost Care Hygiene up to 12 s a time for the same 5 ledgers and pushed the page past its time limit.
  const askedKey = (l) => user.id + '|' + (company || '') + '|' + l;
  const pending = (out.quality.unclassified_ledgers || []).concat(out.quality.guessed_ledgers || [])
    .filter((x) => !(x.ledger in overrides) && !(Date.now() - (AI_ASKED.get(askedKey(x.ledger)) || 0) < AI_ASK_AGAIN_MS)).slice(0, 40);
  let placedNow = false;
  if (pending.length && process.env.ANTHROPIC_API_KEY) {
    const groupOf = new Map(ledgers.map((l) => [l.name, l.primary_group || null]));
    const placed = await classifyLedgersWithAI(pending.map((x) => ({ ledger: x.ledger, parent: x.parent, primary_group: groupOf.get(x.ledger) || null, vouchers: x.vouchers, volume: x.volume })),
      { apiKey: process.env.ANTHROPIC_API_KEY, timeoutMs: 6000 });
    for (const x of pending) AI_ASKED.set(askedKey(x.ledger), Date.now());
    if (placed.length) {
      placedNow = true;
      try {
        await insertRows('tally_ledger_classes', placed.map((x) => ({
          user_id: user.id, company_name: company || '', ledger_name: x.ledger, bucket: x.bucket, set_by: null, updated_at: new Date().toISOString()
        })), { onConflict: 'user_id,company_name,ledger_name', merge: true });
      } catch (e) { /* table missing: still use the answers for this response */ }
      for (const x of placed) { overrides[x.ledger] = x.bucket; aiPlaced.add(x.ledger); }
      out = run(overrides);
    }
    sw.mark('ai');
  }
  if (aiPlaced.size) {
    out.quality.ai_classified = [...aiPlaced].slice(0, 30).map((l) => ({ ledger: l, bucket: overrides[l] }));
    out.quality.reasons.unshift(`Margyn placed ${aiPlaced.size} ledger(s) in the profit and loss for you (e.g. ${[...aiPlaced].slice(0, 3).join(', ')}). Change any of them under “Margyn needs your help”.`);
  }
  const staleH = lastSync ? Math.round((Date.now() - Date.parse(lastSync)) / 3600000) : null;
  const srcName = book.source_name || 'Tally';
  if (staleH != null && staleH > 48) out.quality.reasons.unshift(`Last sync was ${staleH} hours ago. Numbers may be behind ${srcName}.`);
  for (const n of book.notes || []) out.quality.reasons.unshift(n);
  if (book.source && book.source !== 'tally') out.quality.reasons = out.quality.reasons.map((r) => r.replace(/^Single source \(Tally\)/, `Single source (${srcName})`));
  if (truncated) out.quality.reasons.unshift('Voucher history was capped at 20,000 rows, so older months may be incomplete.');
  // What else the books say (kits, branches, commission, customers gone quiet, old debts...): the same list
  // Margyn answers "what should I know" with and Margyn Watch sends on WhatsApp.
  let extra = {};
  try { extra = buildInsights(book, out); } catch (e) { console.error('[tally] insights failed:', e.message); }
  sw.mark('insights');
  // The 13-week forecast learned from how money actually moved (cashFlowModel.js), graded by its own past runs,
  // and today's run kept so tomorrow's can be graded (forecastStore.js). Never blocks the page.
  let forecast_v2 = null, ctxB = null;
  try { ctxB = prepareBooks(book, { analytics: out }); } catch (e) { console.error('[tally] prepare failed:', e.message); }
  // Suppliers Tally doesn't keep bill by bill: what you owe is each supplier's balance rebuilt from the entries
  // (cashFlowModel.supplierOpenItems), the same figure the Payables page shows, not the few stray bills Tally has.
  const wc = out.working_capital || {};
  if (ctxB && wc.suppliers_tracked_billwise === false) {
    try {
      const led = cashFlow.supplierOpenItems(ctxB);
      Object.assign(wc, { payables_billwise: wc.payables, payables: led.total, supplier_advances: led.advances, payables_basis: 'supplier_ledgers' });
    } catch (e) { console.error('[tally] supplier ledgers failed:', e.message); }
  }
  // Customers: owed = their bills lined up with their ledger balances (billTieOut.js), the same list Receivables shows.
  if (ctxB && ctxB.billTie && (ctxB.billTie.trimmed.parties || ctxB.billTie.added.parties)) {
    const recvB = ctxB.bills.filter((b) => b.direction !== 'payable' && !b.advance);
    const tot = recvB.reduce((a, b) => a + Math.abs(Number(b.closing_balance) || 0), 0);
    const od = recvB.filter((b) => Number(b.overdue_days) > 0).reduce((a, b) => a + Math.abs(Number(b.closing_balance) || 0), 0);
    Object.assign(wc, { receivables_billwise: wc.receivables, receivables: Math.round(tot * 100) / 100, receivables_overdue: Math.round(od * 100) / 100, receivables_basis: 'bills_tied_to_ledgers', bill_tie: ctxB.billTie });
    const t = ctxB.billTie;
    out.quality.reasons.push(`What customers owe follows their ledger balances: ${t.trimmed.parties ? `₹${t.trimmed.amount.toLocaleString('en-IN')} of bills for ${t.trimmed.parties} customers is already paid by their ledgers (not knocked off in Tally)` : ''}${t.trimmed.parties && t.added.parties ? '; ' : ''}${t.added.parties ? `₹${t.added.amount.toLocaleString('en-IN')} owed by ${t.added.parties} customers isn't split into bills in Tally, so it is taken from their entries` : ''}.`);
  }
  // The cash flow statement (month by month, owner and accountant views) and every overdraft and loan day by day
  // (cashFlowStatement.js). Never blocks the page.
  let cash_flow = null, borrowing = null;
  if (ctxB) {
    try { cash_flow = cashFlowStatement.yearStatement(ctxB); } catch (e) { console.error('[tally] cash flow failed:', e.message); }
    try { borrowing = cashFlowStatement.borrowing(ctxB); } catch (e) { console.error('[tally] borrowing failed:', e.message); }
  }
  sw.mark('statement');
  try {
    const [promises, runs] = await Promise.all([forecastStore.promises(user.id), forecastStore.pastRuns(user.id)]);
    forecast_v2 = cashFlow.build(ctxB || prepareBooks(book, { analytics: out }), { promises, pastRuns: runs });
    if (forecast_v2 && !(req.query && req.query.company)) await forecastStore.recordDaily(user.id, forecast_v2);
  } catch (e) { console.error('[tally] forecast failed:', e.message); }
  sw.mark('forecast');
  const body = { connected: true, company_name: company, companies, last_sync_at: lastSync, stale_hours: staleH, truncated, ...out, ...extra,
    // Which books system this is, the others connected, and their headline figures side by side (never added).
    forecast_v2, cash_flow, borrowing,
    books_source: book.source || 'tally', books_source_name: srcName, books_sources: book.sources || [], books_compare: book.compare || [] };
  // A placement Margyn just made changes the book next time (it is read with the book), so this is never kept past it.
  if (!placedNow) _analyticsDone.set(book, { k: doneKey, body });
  sw.header(res, rowsFrom);
  return json(res, 200, body);
}

/* ------------------------------------------------------------------ */
/* completeness — GET ?action=completeness                             */
/* Sent → stored → read → used, for the Organisations and sources page */
/* (api/_lib/dataCompleteness.js). Counts and totals only.             */
/* ------------------------------------------------------------------ */
async function handleCompleteness(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });
  try {
    const book = await loadTallyBook(user.id);
    if (!book.connected) return json(res, 200, { connected: false });
    const out = tallyCompleteness(book, prepareBooks(book));
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, Object.assign({ connected: true }, out));
  } catch (e) {
    console.error('[tally] completeness failed:', e.message);
    return json(res, 500, { error: 'completeness_failed' });
  }
}

/* ------------------------------------------------------------------ */
/* books-check — GET ?action=books-check[&refresh=1]                   */
/* The daily books health check (api/_lib/booksHealth.js): what's wrong */
/* in the books for the accountant to fix, open / fixed / ignored. Runs */
/* each morning with Margyn Watch; here it runs again when the last     */
/* check is over 20 hours old or the person taps "Check again".         */
/* Works for Tally, Zoho Books and Odoo (the Books layer).              */
/* ------------------------------------------------------------------ */
const BOOKS_CHECK_STALE_MS = 20 * 3600000;
async function handleBooksCheck(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });
  const BH = require('./_lib/booksHealth');
  const perms = user.member ? user.member.permissions : null;
  try {
    let st = await BH.load(user.id);
    const runOf = (rows) => rows.find((r) => r.key === 'run:last') || null;
    let run = runOf(st.rows);
    const stale = !run || !run.last_seen || Date.now() - Date.parse(run.last_seen) > BOOKS_CHECK_STALE_MS;
    const refresh = (req.query && req.query.refresh === '1') || stale || !st.ready;
    let items = null, live = null;
    if (refresh) {
      const { ctx } = await require('./_lib/booksTools').contextFor(user.id);
      if (!ctx) return json(res, 200, { connected: false });
      if (!ctx.rows.length) return json(res, 200, { connected: true, empty: true, items: [] });
      live = { company: ctx.company || null, source: ctx.source_name || 'Tally' };
      const r = st.ready ? await BH.runForAccount(user.id, ctx) : null;
      if (r && r.stored) { st = await BH.load(user.id); run = runOf(st.rows); }
      else items = BH.merge(st.rows, BH.check(ctx));   // before the SQL, or a failed write: today's findings, unsaved
    }
    if (!items) items = st.rows.filter((r) => r.kind !== 'run');
    const monthAgo = Date.now() - 30 * 86400000;
    items = BH.filterFor(items, perms).filter((x) => x.status !== 'fixed' || (x.fixed_at && Date.parse(x.fixed_at) > monthAgo));
    items.sort((a, b) => BH.ORDER.indexOf(a.kind) - BH.ORDER.indexOf(b.kind) || Number(b.amount || 0) - Number(a.amount || 0));
    const company = (live && live.company) || (run && run.data && run.data.company) || null;
    const open = items.filter((x) => x.status === 'open');
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, {
      connected: true, ready: st.ready, checked_at: run ? run.last_seen : new Date().toISOString(), company,
      source: (live && live.source) || (run && run.data && run.data.source === 'zoho' ? 'Zoho Books' : run && run.data && run.data.source === 'odoo' ? 'Odoo' : 'Tally'),
      counts: { open: open.length, for_accountant: open.filter((x) => x.for_accountant !== false).length, high: open.filter((x) => x.severity === 'high').length,
        ignored: items.filter((x) => x.status === 'ignored').length, fixed: items.filter((x) => x.status === 'fixed').length },
      groups: BH.GROUP_TITLE,
      items: items.map((x) => ({ key: x.key, kind: x.kind, area: x.area, status: x.status, severity: x.severity, title: x.title, detail: x.detail, fix: x.fix,
        party: x.party || null, ledger: x.ledger || null, amount: x.amount != null ? Number(x.amount) : null, for_accountant: x.for_accountant !== false,
        first_seen: x.first_seen || null, last_seen: x.last_seen || null, fixed_at: x.fixed_at || null, ignored_by: x.ignored_by || null })),
      // The list for the accountant: WhatsApp links have a length limit, the copy has everything.
      accountant_text: BH.accountantText(items, { company, max: 3000 }),
      accountant_text_full: BH.accountantText(items, { company, perKind: 100 })
    });
  } catch (e) {
    console.error('[tally] books check failed:', e.message);
    return json(res, 500, { error: 'books_check_failed' });
  }
}

/* POST ?action=books-check-set  body { key, status: 'ignored' | 'open' }: the owner ignores an item, or brings it back. */
async function handleBooksCheckSet(req, res) {
  let user;
  try { user = await getUserFromRequest(req); }
  catch { return json(res, 500, { error: 'auth_check_failed' }); }
  if (!user) return json(res, 401, { error: 'unauthorized' });
  const body = parseBody(req);
  const key = String(body.key || '').slice(0, 300), status = body.status;
  if (!key || key.startsWith('run:') || !['ignored', 'open'].includes(status)) return json(res, 400, { error: 'key and status (ignored | open) required' });
  let rows;
  try { rows = await selectRows('books_health', `select=key,status,amount,title&user_id=eq.${user.id}&key=eq.${encodeURIComponent(key)}&limit=1`); }
  catch (e) { return json(res, 409, { error: 'not_ready', note: 'Run the books health SQL (2026-10-07-books-health.sql) first.' }); }
  const row = rows[0];
  if (!row) return json(res, 404, { error: 'not_found' });
  const who = user.member ? (user.member.name || user.email) : user.email;
  const patch = status === 'ignored'
    ? { status: 'ignored', ignored_at: new Date().toISOString(), ignored_amount: row.amount, ignored_by: who || null }
    : { status: 'open', ignored_at: null, ignored_amount: null, ignored_by: null };
  try { await updateRows('books_health', `user_id=eq.${user.id}&key=eq.${encodeURIComponent(key)}`, patch); }
  catch (e) { return json(res, 500, { error: 'update_failed' }); }
  // Who ignored what goes in the Audit log, like other changes to how the books are read.
  try { await insertRows('ledger_events', [{ user_id: user.id, entity_type: 'books check', event: 'updated', party_name: String(row.title || key).slice(0, 200), source: 'margyn',
    note: status === 'ignored' ? 'Ignored in the books health check' : 'Brought back into the books health check', actor_id: user.auth_id || user.id, actor_name: who || null, channel: 'app' }]); }
  catch (e) { /* the audit columns may not exist yet; the change itself stands */ }
  return json(res, 200, { key, status });
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
      forgetBooks(user.id);
      await auditClassify(user, company, ledger, null);
      return json(res, 200, { ok: true, cleared: true });
    }
    await insertRows('tally_ledger_classes', [{
      user_id: user.id, company_name: company, ledger_name: ledger, bucket,
      set_by: user.auth_id || user.id, updated_at: new Date().toISOString()
    }], { onConflict: 'user_id,company_name,ledger_name', merge: true });
  } catch (e) { return json(res, 500, { error: 'save_failed' }); }
  forgetBooks(user.id);
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
  // A sync that stopped early (Tally closed, PC asleep) reports no counts. Keep the last report's Tally counts
  // (ledgers, monthly vouchers, bills) beside the new errors, dated, instead of wiping them (4 Oct 2026: Care
  // Hygiene's only report was a failed one, so "does Margyn have everything Tally holds?" had no answer).
  let diagnostics = body;
  try {
    const prevRows = await selectRows('tally_installs', `select=diagnostics&id=eq.${inst.id}&limit=1`);
    const prev = prevRows && prevRows[0] && prevRows[0].diagnostics && typeof prevRows[0].diagnostics === 'object' ? prevRows[0].diagnostics : null;
    if (prev) {
      diagnostics = Object.assign({}, body);
      const kept = {};
      const hasMonths = (d) => d && d.vouchers && d.vouchers.months && Object.keys(d.vouchers.months).length;
      if (!hasMonths(body) && hasMonths(prev)) { diagnostics.vouchers = Object.assign({}, prev.vouchers, body.vouchers ? { last_attempt: body.vouchers } : {}); kept.vouchers = (prev.kept_from && prev.kept_from.vouchers) || prev.at || null; }
      if (!(body.ledgers && body.ledgers.received != null) && prev.ledgers && prev.ledgers.received != null) { diagnostics.ledgers = prev.ledgers; kept.ledgers = (prev.kept_from && prev.kept_from.ledgers) || prev.at || null; }
      if (!body.bills && prev.bills) { diagnostics.bills = prev.bills; kept.bills = (prev.kept_from && prev.kept_from.bills) || prev.at || null; }
      if (Object.keys(kept).length) diagnostics.kept_from = kept;
    }
  } catch (e) { /* column missing or read failed: store the report as sent */ }
  try {
    await updateRows('tally_installs', `id=eq.${inst.id}`, Object.assign({}, patch, { diagnostics }));
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

  // Every install and every count at once (was one after another: ~4 s for an account with a few old installs).
  const zero = (p) => p.catch(() => 0);   // counts are cosmetic
  const out = await Promise.all(installs.map(async (inst) => {
    const [ledgersN, vouchersN, billsN, runs] = await Promise.all([
      zero(countRows('tally_ledgers', `install_id=eq.${inst.id}`)),
      zero(countRows('tally_vouchers', `install_id=eq.${inst.id}`)),
      zero(countRows('tally_bills', `install_id=eq.${inst.id}`)),
      selectRows('tally_sync_runs', `select=kind,status,rows_upserted,started_at,error_message&install_id=eq.${inst.id}&order=started_at.desc&limit=1`)
        .catch(() => [])   // non-fatal
    ]);
    return { ...inst, counts: { ledgers: ledgersN, vouchers: vouchersN, bills: billsN }, last_run: runs && runs[0] ? runs[0] : null };
  }));

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
