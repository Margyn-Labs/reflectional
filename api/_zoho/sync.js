/**
 * POST /api/sync-zoho
 *
 * Daily delta sync for one Zoho Books organization: invoices, bills,
 * customer payments, vendor payments, bank accounts, chart of accounts,
 * and P&L journal entries.
 *
 * Called three ways, exactly like sync-razorpay.js:
 *   1. Directly by the client (Authorization: Bearer <user JWT>) — the
 *      "Sync Now" button.
 *   2. In-process, awaited, from zoho-select-org.js right after activation
 *      — the one-time 12-month backfill. It used to be a fire-and-forget
 *      self-fetch that Vercel could cut off mid-run; it's now a direct,
 *      awaited call to syncZohoForUser so the invocation can't be torn
 *      down before the backfill finishes.
 *   3. Internally by api/cron-sync-zoho.js, which imports syncZohoForUser.
 *
 * Body: { mode?: "delta" | "backfill" }   (default "delta")
 *
 * Delta vs backfill:
 *   - delta    : every module filtered by `last_modified_time` >= its stored
 *                cursor. This is the normal nightly path. Never a full-table pull.
 *   - backfill : one-time on activation, 12 months of history (not 90 days —
 *                receivables/payables and GST leakage need the longer lookback).
 *                Sets zoho_organizations.backfill_completed_at when done.
 *
 * Each module is independent: a failure in one does not block the others,
 * and each writes its own connector_logs row. Only an auth failure stops
 * everything, because nothing else can succeed after it.
 *
 * Zero-npm: plain fetch() only.
 */

const {
  selectRows,
  insertRows,
  updateRows,
  deleteRows,
  getUserFromRequest,
  logConnectorEvent
} = require('../_lib/supabaseRest');

const {
  createSession,
  getSyncCursor,
  setSyncCursor,
  markNeedsReauth,
  dailyCapFor,
  toDateOnly,
  toNumber,
  sleep,
  ZohoAuthError,
  ZohoModuleUnavailable,
  ZohoRateLimited
} = require('../_lib/zohoClient');
const { track } = require('../_lib/track');

// Ops funnel event (api/_lib/eventSchema.js): outcome, a closed error code and
// row counts. Never amounts, party names or Zoho's raw error text.
function syncEvent(userId, props) {
  return track(userId, 'zoho_sync', props);
}

const BACKFILL_MONTHS = 12;
// P&L accounts, plus bank / cash / card: an expense or journal paid straight from the bank has its other
// side there, so the books layer can book it as a Payment or Receipt the way Tally does.
const JOURNAL_ACCOUNT_TYPES = ['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense', 'bank', 'cash', 'credit_card'];
const MAX_JOURNAL_ACCOUNTS = 150;  // rate-limit guard: 1+ call per account read (unused accounts are skipped)
const ACCOUNT_CALL_DELAY_MS = 700;

// ------------------------------------------------------------ date helpers

function monthsAgoIso(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/** Zoho's last_modified_time filter wants 'YYYY-MM-DDTHH:mm:ss+0000'. */
function toZohoFilterTime(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function windowFor(mode, cursor) {
  if (mode === 'backfill' || !cursor) {
    return { since: monthsAgoIso(BACKFILL_MONTHS), isBackfill: true };
  }
  // 1-hour overlap absorbs clock skew between Zoho and Vercel.
  const overlapped = new Date(new Date(cursor).getTime() - 60 * 60 * 1000).toISOString();
  return { since: overlapped, isBackfill: false };
}

// ---------------------------------------------------------------- mappers

function mapInvoice(i, orgRef) {
  if (!i.invoice_id || !i.date) return null;
  return {
    org_ref: orgRef,
    invoice_id: String(i.invoice_id),
    invoice_number: i.invoice_number || null,
    customer_ref: i.customer_id ? String(i.customer_id) : null,
    customer_name: i.customer_name || null,
    total: toNumber(i.total),
    // Before GST: sales in the books layer (dataLayer/books.js). The list API may only carry tax_total.
    sub_total: i.sub_total != null ? toNumber(i.sub_total) : (i.total != null && i.tax_total != null ? toNumber(i.total) - toNumber(i.tax_total) : null),
    balance: toNumber(i.balance),
    status: i.status || 'sent',
    invoice_date: toDateOnly(i.date),
    due_date: toDateOnly(i.due_date),
    gst_treatment: i.gst_treatment || null,
    place_of_supply: i.place_of_supply || null,
    currency_code: i.currency_code || 'INR',
    last_modified_time: i.last_modified_time ? new Date(i.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

function mapBill(b, orgRef) {
  if (!b.bill_id || !b.date) return null;
  return {
    org_ref: orgRef,
    bill_id: String(b.bill_id),
    bill_number: b.bill_number || null,
    vendor_ref: b.vendor_id ? String(b.vendor_id) : null,
    vendor_name: b.vendor_name || null,
    total: toNumber(b.total),
    sub_total: b.sub_total != null ? toNumber(b.sub_total) : (b.total != null && b.tax_total != null ? toNumber(b.total) - toNumber(b.tax_total) : null),
    balance: toNumber(b.balance),
    status: b.status || 'open',
    bill_date: toDateOnly(b.date),
    due_date: toDateOnly(b.due_date),
    is_reverse_charge: !!(b.is_reverse_charge_applied || b.is_reverse_charge),
    currency_code: b.currency_code || 'INR',
    last_modified_time: b.last_modified_time ? new Date(b.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

function mapCustomerPayment(p, orgRef) {
  if (!p.payment_id) return null;
  const firstInvoice = Array.isArray(p.invoices) && p.invoices.length ? p.invoices[0].invoice_id : null;
  return {
    org_ref: orgRef,
    payment_id: String(p.payment_id),
    payment_number: p.payment_number || null,
    invoice_ref: firstInvoice ? String(firstInvoice) : (p.invoice_id ? String(p.invoice_id) : null),
    customer_ref: p.customer_id ? String(p.customer_id) : null,
    amount: toNumber(p.amount),
    payment_date: toDateOnly(p.date) || toDateOnly(p.payment_date),
    payment_mode: p.payment_mode || null,
    applied_numbers: paymentNumbers(p, 'customer'),
    ...listLink(p),
    last_modified_time: p.last_modified_time ? new Date(p.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

/**
 * A payment applied to ONE invoice, when the list row also says the tax withheld (Zoho's list does, found live
 * 1 Nov: payment 168 → invoice_numbers "INV-00762", tax_amount_withheld 1795.62): the whole link is in the list,
 * so no detail read is needed. Several invoices, or a list without the tax field: the detail read fills it.
 */
function listLink(p) {
  const nums = String(p.invoice_numbers || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(p.invoices) || nums.length !== 1 || p.tax_amount_withheld === undefined) return {};
  const tax = Math.round(toNumber(p.tax_amount_withheld) * 100) / 100;
  return {
    applied_to: [{ id: null, number: nums[0], amount: Math.round((toNumber(p.amount) - toNumber(p.unused_amount)) * 100) / 100, tax_withheld: tax }],
    tax_withheld: tax,
    links_read_at: new Date().toISOString()
  };
}

function mapVendorPayment(p, orgRef) {
  if (!p.payment_id) return null;
  const firstBill = Array.isArray(p.bills) && p.bills.length ? p.bills[0].bill_id : null;
  return {
    org_ref: orgRef,
    payment_id: String(p.payment_id),
    payment_number: p.payment_number || null,
    bill_ref: firstBill ? String(firstBill) : (p.bill_id ? String(p.bill_id) : null),
    vendor_ref: p.vendor_id ? String(p.vendor_id) : null,
    amount: toNumber(p.amount),
    payment_date: toDateOnly(p.date) || toDateOnly(p.payment_date),
    payment_mode: p.payment_mode || null,
    // The bill numbers the list already gives (2026-11-01-zoho-parity.sql). Amounts and TDS come from the detail read.
    applied_numbers: paymentNumbers(p, 'vendor'),
    last_modified_time: p.last_modified_time ? new Date(p.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

/* ------------------------------------------------------- payment -> invoice links */

/**
 * Which invoice (or bill) each payment cleared. Zoho's payments list carries only the numbers ("invoice_numbers":
 * "INV-00762, INV-00763"); the detail carries each document with the amount applied and the tax the customer
 * withheld (tax_amount_withheld, TDS). So the numbers are stored from the list at no cost, and the detail is read
 * once per payment that is new or changed since it was last read, inside the day's allowance (linkPayments).
 */
function paymentNumbers(p, kind) {
  const list = kind === 'vendor' ? p.bills : p.invoices;
  const fromList = Array.isArray(list) ? list.map((x) => x[kind === 'vendor' ? 'bill_number' : 'invoice_number']).filter(Boolean) : [];
  const text = kind === 'vendor' ? p.bill_numbers : p.invoice_numbers;
  const nums = fromList.length ? fromList : String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
  return nums.length ? nums.join(', ') : null;
}

/** Pure: a payment detail -> [{ id, number, amount, tax_withheld }] for every document it was applied to. */
function appliedFrom(p, kind) {
  const list = kind === 'vendor' ? p.bills : p.invoices;
  if (!Array.isArray(list)) return [];
  const idF = kind === 'vendor' ? 'bill_id' : 'invoice_id', noF = kind === 'vendor' ? 'bill_number' : 'invoice_number';
  return list.map((x) => ({
    id: x[idF] ? String(x[idF]) : null,
    number: x[noF] || null,
    amount: x.amount_applied != null ? toNumber(x.amount_applied) : null,
    tax_withheld: Math.round(toNumber(x.tax_amount_withheld) * 100) / 100
  })).filter((x) => x.id || x.number);
}

const LINK_SPECS = [
  { kind: 'customer', table: 'zoho_customer_payments', path: 'books/v3/customerpayments/', key: 'payment', ref: 'invoice_ref' },
  { kind: 'vendor', table: 'zoho_vendor_payments', path: 'books/v3/vendorpayments/', key: 'vendorpayment', ref: 'bill_ref' }
];
const LINK_MAX_NIGHTLY = 150;   // detail reads per nightly run; the rest carry on in the daytime refreshes and next night
const LINK_MAX_DAYTIME = 25;
const LINK_DELAY_MS = 650;      // under Zoho's 100 calls a minute

/** Payments whose detail hasn't been read since they last changed in Zoho, newest first. Pure. */
function paymentsToLink(rows) {
  return rows.filter((r) => !r.links_read_at || (r.last_modified_time && Date.parse(r.last_modified_time) > Date.parse(r.links_read_at)));
}

/**
 * Read payment details (one call each) and store every document each payment was applied to, the amount and any
 * tax withheld. At most `max` calls, stopping at `deadline` or at Zoho's first 429; what's left is read next run.
 * → { read, pending, stopped?, skipped? }
 */
async function linkPayments(session, org, userId, opts) {
  const o = opts || {};
  let left = Math.max(0, Math.floor(o.max || 0));
  const out = { read: 0, pending: 0 };
  for (const s of LINK_SPECS) {
    let rows;
    try {
      rows = await selectRows(s.table, `select=payment_id,payment_date,last_modified_time,links_read_at&org_ref=eq.${org.id}&order=payment_date.desc&limit=20000`);
    } catch (e) {
      out.skipped = 'links_read_at column missing (2026-11-01-zoho-parity.sql)';
      return out;
    }
    const need = paymentsToLink(rows);
    out.pending += need.length;
    for (const r of need) {
      if (left <= 0) { out.stopped = 'allowance'; break; }
      if (o.deadline && Date.now() > o.deadline) { out.stopped = 'time'; break; }
      let detail = null;
      left--;
      try {
        detail = await session.apiGet(s.path + encodeURIComponent(r.payment_id), {}, { failFast429: true });
      } catch (err) {
        if (err instanceof ZohoAuthError) throw err;
        if (err instanceof ZohoRateLimited) { out.stopped = 'rate_limit'; return out; }
        if (!(err instanceof ZohoModuleUnavailable)) { out.errors = (out.errors || 0) + 1; continue; }
        // Gone in Zoho (404): nothing to link. Marked read so it isn't asked for again.
      }
      const p = (detail && (detail[s.key] || detail.payment)) || {};
      const applied = appliedFrom(p, s.kind);
      const patch = {
        applied_to: applied,
        tax_withheld: Math.round(applied.reduce((t, x) => t + x.tax_withheld, 0) * 100) / 100,
        links_read_at: new Date().toISOString()
      };
      if (applied[0] && applied[0].id) patch[s.ref] = applied[0].id;
      if (applied.length) patch.applied_numbers = applied.map((x) => x.number).filter(Boolean).join(', ') || null;
      try { await updateRows(s.table, `org_ref=eq.${org.id}&payment_id=eq.${encodeURIComponent(r.payment_id)}`, patch); }
      catch (e) { out.skipped = 'could not store payment links'; return out; }
      out.read++; out.pending--;
      await sleep(LINK_DELAY_MS);
    }
  }
  if (out.read) {
    await logConnectorEvent({ userId, connectorType: 'zoho_books', operation: 'sync_payment_links', status: 'success', recordsSynced: out.read });
  }
  return out;
}

function mapBankAccount(a, orgRef) {
  if (!a.account_id) return null;
  return {
    org_ref: orgRef,
    account_id: String(a.account_id),
    // The account name the owner sees in Zoho ("HDFC Current A/c"), not just the bank's.
    bank_name: a.account_name || a.bank_name || null,
    account_type: a.account_type || null,
    currency_code: a.currency_code || 'INR',
    current_balance: toNumber(a.balance !== undefined ? a.balance : a.current_balance),
    is_primary: !!a.is_primary_account,
    synced_at: new Date().toISOString()
  };
}

function mapAccount(a, orgRef) {
  if (!a.account_id) return null;
  return {
    org_ref: orgRef,
    account_id: String(a.account_id),
    account_name: a.account_name || null,
    account_type: (a.account_type || '').toLowerCase() || null,
    is_active: a.is_active !== false,
    // Balance-sheet figures postings don't carry (TDS receivable / payable). Column from 2026-10-31-on-time-crons.sql.
    ...(a.current_balance != null ? { current_balance: toNumber(a.current_balance) } : {}),
    synced_at: new Date().toISOString()
  };
}

// ----------------------------------------------------------------- upsert

const OPTIONAL_COLUMNS = ['sub_total', 'party_ref', 'payment_number', 'entry_number', 'current_balance', 'applied_numbers', 'applied_to', 'tax_withheld', 'links_read_at'];

async function upsert(table, rows, conflictColumns) {
  if (!rows.length) return 0;
  // Chunk so a very large backfill batch doesn't blow the PostgREST payload limit.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    let chunk = rows.slice(i, i + CHUNK);
    // Columns added by later migrations: sub_total (2026-10-04-books-layer.sql), party_ref
    // (2026-10-29-zoho-journal-party.sql). Until a migration is run, sync exactly as before without it.
    for (;;) {
      try { await insertRows(table, chunk, { onConflict: conflictColumns, merge: true }); break; }
      catch (e) {
        const col = OPTIONAL_COLUMNS.find((c) => c in chunk[0] && new RegExp(c).test(String(e && e.message)));
        if (!col) throw e;
        chunk = chunk.map((r) => { const { [col]: _drop, ...rest } = r; return rest; });
      }
    }
  }
  return rows.length;
}

function maxWatermark(rows, field) {
  let max = null;
  for (const r of rows) {
    const v = r[field];
    if (v && (!max || v > max)) max = v;
  }
  return max;
}

// ------------------------------------------------------------- module sync

/**
 * Sync one paginated collection module end to end. `spec` describes the
 * endpoint, the response key, the target table, and the row mapper.
 */
async function syncCollection(session, org, userId, spec, mode, results, errors, flags, opts) {
  const o = opts || {};
  const opStart = Date.now();
  const cursor = await getSyncCursor(org.id, spec.module);
  const { since, isBackfill } = windowFor(mode, cursor);

  const query = Object.assign({}, spec.query || {});
  if (spec.supportsLastModified) {
    // Delta sync. This is the whole point — never a full-table pull.
    query.last_modified_time = toZohoFilterTime(since);
    query.sort_column = 'last_modified_time';
  } else if (spec.dateField) {
    query[spec.dateField] = toDateOnly(since);
  }

  try {
    const raw = await session.apiGetAll(spec.path, spec.collectionKey, query, o.failFast429 ? { failFast429: true } : {});
    let rows = raw.map((r) => spec.map(r, org.id)).filter(Boolean);
    // A link the list doesn't carry (a customer payment's invoice) is left out rather than written as null, so
    // re-listing a payment never wipes what the detail read stored (linkPayments).
    if (spec.keepIfMissing) rows = rows.map((r) => { const c = Object.assign({}, r); for (const k of spec.keepIfMissing) if (c[k] == null) delete c[k]; return c; });

    // Multi-currency detection: excluded from vitals until conversion exists.
    if (spec.checksCurrency && rows.some((r) => r.currency_code && r.currency_code !== 'INR')) {
      if (flags.indexOf('multi_currency_detected') === -1) flags.push('multi_currency_detected');
    }

    // One insert per set of columns (PostgREST wants every row of an insert to have the same keys).
    const shapes = new Map();
    for (const r of rows) { const k = Object.keys(r).sort().join(','); if (!shapes.has(k)) shapes.set(k, []); shapes.get(k).push(r); }
    let count = 0;
    for (const group of shapes.values()) count += await upsert(spec.table, group, spec.conflict);
    results[spec.module] = count;

    const watermark = maxWatermark(rows, 'last_modified_time') || new Date().toISOString();
    await setSyncCursor(org.id, spec.module, watermark, 'success');

    if (!o.quiet) await logConnectorEvent({
      userId, connectorType: 'zoho_books',
      operation: (isBackfill ? 'backfill_' : 'sync_') + spec.module,
      status: 'success', recordsSynced: count, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;

    if (err instanceof ZohoRateLimited) {
      // Zoho asked to slow down (per-minute or daily limit). The cursor stays where it was, so the next run
      // reads this module from the same point; the rest of this run is skipped (syncZohoForUser).
      if (flags.indexOf('rate_limited') === -1) flags.push('rate_limited');
      errors.push(`${spec.module}: rate_limited`);
      await setSyncCursor(org.id, spec.module, cursor, 'rate_limited');
      return;
    }

    if (err instanceof ZohoModuleUnavailable) {
      // Free/Standard plan without bank feeds, or a module not enabled.
      // Expected condition, not an error — never blocks other vitals.
      if (spec.unavailableFlag && flags.indexOf(spec.unavailableFlag) === -1) {
        flags.push(spec.unavailableFlag);
      }
      results[spec.module] = 0;
      await setSyncCursor(org.id, spec.module, new Date().toISOString(), 'skipped');
      await logConnectorEvent({
        userId, connectorType: 'zoho_books',
        operation: 'sync_' + spec.module, status: 'success',
        recordsSynced: 0, errorMessage: 'module_unavailable_on_plan',
        syncDurationMs: Date.now() - opStart
      });
      return;
    }

    errors.push(`${spec.module}: ${err.message}`);
    await setSyncCursor(org.id, spec.module, cursor, 'error');
    await logConnectorEvent({
      userId, connectorType: 'zoho_books',
      operation: 'sync_' + spec.module, status: 'error', errorMessage: err.message
    });
  }
}

/**
 * Map one P&L account's postings to zoho_journal_entries rows.
 *
 * Postings without a transaction_id fall back to an account:date:side:amount
 * key. Two genuine same-day postings of the same amount share that key and
 * used to collapse into one row on upsert, understating the P&L. The 2nd, 3rd
 * ... repeat of a key in one fetch now gets a #2, #3 suffix. The first keeps
 * the bare key, so rows already stored are matched, not duplicated. A fetch
 * always covers whole days (date_start..today), so the count is stable from
 * run to run.
 */
function journalRows(txns, acct, orgRef) {
  const seen = new Map();
  const rows = [];
  for (const t of txns) {
    const date = toDateOnly(t.transaction_date || t.date);
    if (!date) continue;
    // Zoho returns debit_amount / credit_amount, with "" on the unused side.
    // amount + debit_or_credit is the older shape, kept as a fallback.
    const debit = t.debit_amount !== undefined ? toNumber(t.debit_amount)
      : toNumber(t.debit_or_credit === 'debit' ? (t.amount || t.debit) : t.debit);
    const credit = t.credit_amount !== undefined ? toNumber(t.credit_amount)
      : toNumber(t.debit_or_credit === 'credit' ? (t.amount || t.credit) : t.credit);
    // categorized_transaction_id is per posting; transaction_id is the source
    // document (an invoice, a credit note), which can post to one account more
    // than once. Keep both, document first: "<doc>:<posting>". The books layer
    // reads the document id back to put each sale against its customer.
    let id = t.transaction_id && t.categorized_transaction_id
      ? `${t.transaction_id}:${t.categorized_transaction_id}`
      : (t.categorized_transaction_id || t.transaction_id);
    if (!id) {
      const base = `${acct.account_id}:${date}:${t.debit_or_credit || ''}:${debit || credit}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      id = n === 1 ? base : `${base}#${n}`;
    }
    const party = t.customer_id || t.vendor_id || t.contact_id;
    rows.push({
      org_ref: orgRef,
      account_ref: acct.id,
      transaction_id: String(id),
      entry_date: date,
      debit,
      credit,
      // The customer or vendor on the posting, so a credit note or a bill lands against its party, as in Tally.
      party_ref: party ? String(party) : null,
      entry_number: t.entry_number || null,   // Zoho's own number for the document (journal, expense, invoice)
      synced_at: new Date().toISOString()
    });
  }
  return rows;
}

/**
 * Account ids worth reading: a non-zero balance in Zoho (chartofaccounts?showbalance=true), or postings
 * already stored (so an account that has gone back to zero is still re-read and its old rows replaced).
 * null when Zoho won't say, and then every account is read.
 */
async function usedAccountIds(session, orgRef, accounts) {
  try {
    const all = await session.apiGetAll('books/v3/chartofaccounts', 'chartofaccounts', { showbalance: 'true' });
    const used = new Set(all.filter((a) => Number(a.current_balance) !== 0 && a.current_balance != null).map((a) => String(a.account_id)));
    if (!all.some((a) => a.current_balance !== undefined)) return null;
    const stored = await selectRows('zoho_journal_entries', `select=account_ref&org_ref=eq.${orgRef}&order=id.asc&limit=100000`);
    const refs = new Set(stored.map((r) => String(r.account_ref)));
    for (const a of accounts) if (refs.has(String(a.id))) used.add(String(a.account_id));
    return used;
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;
    return null;
  }
}

/** Remove this account's stored postings in the window that Zoho no longer returns. */
async function dropStalePostings(orgRef, accountRef, dateStart, rows) {
  const keep = new Set(rows.map((r) => r.transaction_id));
  const stored = await selectRows(
    'zoho_journal_entries',
    `select=id,transaction_id&org_ref=eq.${orgRef}&account_ref=eq.${accountRef}&entry_date=gte.${dateStart}&order=id.asc&limit=100000`
  );
  const stale = stored.filter((r) => !keep.has(String(r.transaction_id))).map((r) => r.id);
  for (let i = 0; i < stale.length; i += 100) {
    await deleteRows('zoho_journal_entries', `org_ref=eq.${orgRef}&id=in.(${stale.slice(i, i + 100).join(',')})`);
  }
  return stale.length;
}

/**
 * Journal entries for P&L accounts only (income / COGS / opex) — the
 * accounts net margin and burn rate actually read. Zoho exposes postings per
 * account via /chartofaccounts/{id}/transactions, so this costs one call per
 * P&L account; capped and paced to stay inside 100 req/min.
 *
 * NOTE: this endpoint's response shape is the least-documented part of the
 * Books API. Validate field names against a sandbox org before pilot use
 * (flagged in DEPLOY.md).
 */
async function syncJournalEntries(session, org, userId, mode, results, errors, flags) {
  const opStart = Date.now();
  // Always the full 12 months, not a delta. Postings carry no modified time,
  // so a delta by date misses an invoice edited, backdated or deleted after
  // its date had passed, and the P&L drifts from Zoho's. Each account's
  // window is replaced: what Zoho no longer returns is removed. About one
  // call per P&L account (more for busy ones), well inside the daily cap.
  const since = monthsAgoIso(BACKFILL_MONTHS);

  try {
    let accounts = await selectRows(
      'zoho_chart_of_accounts',
      `select=id,account_id,account_type&org_ref=eq.${org.id}` +
      `&account_type=in.(${JOURNAL_ACCOUNT_TYPES.join(',')})&limit=${MAX_JOURNAL_ACCOUNTS}`
    );

    // Skip accounts never used: zero balance in Zoho and nothing stored. A default Zoho org has ~40 P&L
    // accounts, most of them empty, and each read is a call against the per-minute and daily limits.
    const used = await usedAccountIds(session, org.id, accounts);
    if (used) accounts = accounts.filter((a) => used.has(String(a.account_id)));

    if (accounts.length === 0) {
      results.journals = 0;
      await setSyncCursor(org.id, 'journals', new Date().toISOString(), 'success');
      return;
    }

    const dateStart = toDateOnly(since);
    const dateEnd = toDateOnly(new Date().toISOString());
    let total = 0;
    let unavailable = 0;

    for (const acct of accounts) {
      let txns = [];
      try {
        // The account id is a query param. The path form
        // chartofaccounts/{id}/transactions 404s ("Invalid URL Passed"), and
        // a 404 reads as "module unavailable", so every account was skipped
        // silently and net margin came out as 0 (found live, 29 Oct 2026).
        // chartofaccounts/transactions reproduced Zoho's own P&L to the rupee
        // on a live org. Zoho's docs name chartofaccounts/accounttransactions,
        // so that is the fallback if the first form 404s.
        const q = { account_id: acct.account_id, date_start: dateStart, date_end: dateEnd };
        try {
          txns = await session.apiGetAll('books/v3/chartofaccounts/transactions', 'transactions', q);
        } catch (e) {
          if (!(e instanceof ZohoModuleUnavailable)) throw e;
          txns = await session.apiGetAll('books/v3/chartofaccounts/accounttransactions', 'transactions', q);
        }
      } catch (err) {
        if (err instanceof ZohoAuthError || err instanceof ZohoRateLimited) throw err;
        if (err instanceof ZohoModuleUnavailable) { unavailable++; continue; }
        errors.push(`journals(${acct.account_id}): ${err.message}`);
        continue;
      }

      const rows = journalRows(txns, acct, org.id);
      await dropStalePostings(org.id, acct.id, dateStart, rows);

      total += await upsert('zoho_journal_entries', rows, 'org_ref,account_ref,transaction_id');
      await sleep(ACCOUNT_CALL_DELAY_MS);
    }

    // Every account unavailable means the endpoint itself is wrong or
    // blocked, not a plan limit on one account. Say so instead of reporting
    // a clean run with no P&L.
    if (unavailable === accounts.length) {
      throw new Error(`transactions unavailable for all ${accounts.length} P&L accounts`);
    }

    results.journals = total;
    await setSyncCursor(org.id, 'journals', new Date().toISOString(), 'success');
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'sync_journals',
      status: 'success', recordsSynced: total, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;
    // Zoho asked to slow down: stop reading accounts (each would wait out the same limit) and carry on next run.
    if (err instanceof ZohoRateLimited && flags && flags.indexOf('rate_limited') === -1) flags.push('rate_limited');
    errors.push(`journals: ${err instanceof ZohoRateLimited ? 'rate_limited' : err.message}`);
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'sync_journals',
      status: 'error', errorMessage: err.message
    });
  }
}

// ----------------------------------------------------------- module specs

const COLLECTION_SPECS = [
  {
    module: 'chartofaccounts', path: 'books/v3/chartofaccounts',
    collectionKey: 'chartofaccounts', table: 'zoho_chart_of_accounts',
    conflict: 'org_ref,account_id', map: mapAccount, supportsLastModified: false, query: { showbalance: 'true' }
  },
  {
    module: 'invoices', path: 'books/v3/invoices',
    collectionKey: 'invoices', table: 'zoho_invoices',
    conflict: 'org_ref,invoice_id', map: mapInvoice,
    supportsLastModified: true, checksCurrency: true
  },
  {
    module: 'bills', path: 'books/v3/bills',
    collectionKey: 'bills', table: 'zoho_bills',
    conflict: 'org_ref,bill_id', map: mapBill,
    supportsLastModified: true, checksCurrency: true
  },
  {
    module: 'customerpayments', path: 'books/v3/customerpayments',
    collectionKey: 'customerpayments', table: 'zoho_customer_payments',
    conflict: 'org_ref,payment_id', map: mapCustomerPayment, supportsLastModified: true, keepIfMissing: ['invoice_ref', 'applied_numbers', 'applied_to', 'tax_withheld', 'links_read_at']
  },
  {
    module: 'vendorpayments', path: 'books/v3/vendorpayments',
    collectionKey: 'vendorpayments', table: 'zoho_vendor_payments',
    conflict: 'org_ref,payment_id', map: mapVendorPayment, supportsLastModified: true, keepIfMissing: ['bill_ref', 'applied_numbers']
  },
  {
    module: 'bankaccounts', path: 'books/v3/bankaccounts',
    collectionKey: 'bankaccounts', table: 'zoho_bank_accounts',
    conflict: 'org_ref,account_id', map: mapBankAccount,
    supportsLastModified: false,           // single lightweight call, cheap daily
    unavailableFlag: 'bank_data_unavailable'
  }
];

// ------------------------------------------------- deleted-at-source sweep

/**
 * Delta sync only sees records whose last_modified_time moved — a record
 * DELETED in Zoho never shows up again, so an open invoice/bill deleted there
 * kept its balance here forever and inflated aging (2026-09-23 audit).
 *
 * Weekly, for invoices and bills: list every id Zoho still has (unfiltered
 * list = all statuses, so voided/paid ones are present and handled by delta),
 * and any row we still hold as OPEN (balance > 0) that Zoho no longer has at
 * all is marked balance 0 / status 'deleted_at_source'. `total` is kept, so
 * the original amount stays auditable. Every open-items reader filters on
 * balance > 0, so no reader needs to change.
 *
 * Fails safe: a truncated listing, an API error, or a sweep that would close
 * most of the open book (a Zoho-side glitch, wrong org) all skip the sweep.
 */
const SWEEP_EVERY_MS = 6.5 * 24 * 3600 * 1000;
const SWEEP_MAX_PAGES = 150;   // 30,000 records; beyond that we skip, never guess
const SWEEP_SPECS = [
  { module: 'invoices', path: 'books/v3/invoices', key: 'invoices', idField: 'invoice_id', table: 'zoho_invoices', map: (r, o) => mapInvoice(r, o) },
  { module: 'bills', path: 'books/v3/bills', key: 'bills', idField: 'bill_id', table: 'zoho_bills', map: (r, o) => mapBill(r, o) }
];

/**
 * Both directions, weekly and right after the first sync:
 *  - deleted at source: an open row here that Zoho no longer has is closed (balance 0, 'deleted_at_source');
 *  - missing here: an open document Zoho has that was never synced is added. The backfill reads 12 months
 *    by last modified time, so an invoice raised 14 months ago, still unpaid and untouched since, never
 *    arrived and receivables read short of Zoho's own aging.
 * Zoho's own count of each module is kept (zoho_sync_state.remote_count) for the "Is all your data in?" check.
 */
async function sweepDeletedAtSource(session, org, userId, results) {
  const last = await getSyncCursor(org.id, 'deleted_sweep');
  if (last && Date.now() - new Date(last).getTime() < SWEEP_EVERY_MS) return;

  for (const s of SWEEP_SPECS) {
    const opStart = Date.now();
    try {
      const remote = new Map();   // id -> list row
      let complete = false;
      for (let page = 1; page <= SWEEP_MAX_PAGES; page++) {
        const data = await session.apiGet(s.path, { page: String(page), per_page: '200' });
        const batch = data[s.key] || [];
        for (const r of batch) if (r[s.idField]) remote.set(String(r[s.idField]), r);
        const ctx = data.page_context || {};
        if (!ctx.has_more_page) { complete = true; break; }
        if (batch.length === 0) break; // "more pages" but an empty page: don't trust it
        await sleep(700);
      }
      if (!complete) throw new Error('listing exceeded sweep cap; skipped');

      const stored = await selectRows(s.table, `select=${s.idField},balance&org_ref=eq.${org.id}&order=${s.idField}.asc&limit=100000`);
      const storedIds = new Set(stored.map((r) => String(r[s.idField])));

      // Missing here: open in Zoho (balance > 0, not draft or void), never stored.
      const add = [];
      for (const [id, r] of remote) {
        if (storedIds.has(id) || !(Number(r.balance) > 0) || /^(draft|void)$/i.test(String(r.status || ''))) continue;
        const row = s.map(r, org.id);
        if (row) add.push(row);
      }
      if (add.length) {
        await upsert(s.table, add, `org_ref,${s.idField}`);
        results[s.module + '_added_from_sweep'] = add.length;
      }

      // Deleted at source: open here, gone from Zoho.
      const open = stored.filter((r) => Number(r.balance) > 0);
      const missing = open.map((r) => String(r[s.idField])).filter((id) => !remote.has(id));
      if (missing.length && open.length >= 10 && missing.length > open.length * 0.5) {
        throw new Error(`would close ${missing.length}/${open.length} open ${s.module}; skipped as a likely Zoho-side glitch`);
      }
      for (let i = 0; i < missing.length; i += 100) {
        const ids = missing.slice(i, i + 100).join(',');
        const filter = `org_ref=eq.${org.id}&${s.idField}=in.(${ids})`;
        await updateRows(s.table, filter, { balance: 0, synced_at: new Date().toISOString() });
        // Status label is best-effort: if a CHECK constraint rejects it, the
        // balance-0 patch above has already done the part that matters.
        await updateRows(s.table, filter, { status: 'deleted_at_source' }).catch(() => {});
      }
      if (missing.length) results[s.module + '_deleted_at_source'] = missing.length;

      await setRemoteCount(org.id, s.module, remote.size);
      await logConnectorEvent({
        userId, connectorType: 'zoho_books', operation: 'sweep_' + s.module,
        status: 'success', recordsSynced: missing.length + add.length, syncDurationMs: Date.now() - opStart
      });
    } catch (err) {
      if (err instanceof ZohoAuthError) throw err;
      await logConnectorEvent({
        userId, connectorType: 'zoho_books', operation: 'sweep_' + s.module,
        status: 'error', errorMessage: err.message
      });
      // Record the attempt so a persistent failure retries weekly, not on
      // every nightly run (each attempt can cost up to SWEEP_MAX_PAGES calls).
      await setSyncCursor(org.id, 'deleted_sweep', new Date().toISOString(), 'error');
      return;
    }
  }
  await setSyncCursor(org.id, 'deleted_sweep', new Date().toISOString(), 'success');
}

/** Zoho's own count of a module, from the sweep's full listing (2026-10-29-zoho-journal-party.sql adds the column). */
async function setRemoteCount(orgRef, moduleName, count) {
  try {
    await insertRows('zoho_sync_state', [{
      org_ref: orgRef, module: 'count:' + moduleName, last_synced_at: new Date().toISOString(),
      last_run_at: new Date().toISOString(), last_run_status: 'success', remote_count: count
    }], { onConflict: 'org_ref,module', merge: true });
  } catch (err) {
    console.error(`Could not record Zoho's count for ${moduleName}`);
  }
}

// -------------------------------------------------------------- core sync

async function syncZohoForUser(userId, mode, opts) {
  const startedAt = Date.now();
  const syncMode = mode === 'backfill' ? 'backfill' : 'delta';

  const orgs = await selectRows(
    'zoho_organizations',
    `select=*&user_id=eq.${userId}&status=eq.active&order=connected_at.desc&limit=1`
  );
  const org = orgs[0];

  if (!org) {
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'sync_all',
      status: 'error', errorMessage: 'Zoho Books not connected or org not selected'
    });
    await syncEvent(userId, { ok: false, status: 'error', error_code: 'not_connected', mode: syncMode, rows_synced: 0, modules_failed: 0, duration_s: 0 });
    return { status: 'error', message: 'Zoho Books not connected' };
  }

  const session = createSession(org);
  const results = {};
  const errors = [];
  const flags = [];

  const limited = () => flags.indexOf('rate_limited') !== -1;
  for (const spec of COLLECTION_SPECS) {
    if (limited()) break;
    await syncCollection(session, org, userId, spec, syncMode, results, errors, flags);
  }

  if (!limited()) await syncJournalEntries(session, org, userId, syncMode, results, errors, flags);

  // Zoho said "too many calls": everything after this would wait out the same limit. Stop here; every module
  // keeps its cursor, so the next run (a daytime refresh or tonight's) carries on from the same point.
  if (limited()) return finishRateLimited(session, org, userId, syncMode, startedAt, results, errors);

  // Sweep both ways (deleted at source, open but never synced). Weekly; also right after the first sync,
  // which is when anything open but untouched for over 12 months would otherwise be missed.
  await sweepDeletedAtSource(session, org, userId, results);

  // Customer and vendor phones/emails into the party master, where Payment Chase looks up numbers (zohoParties.js).
  // Best-effort: a failed read is logged there and never makes the books sync partial.
  const contacts = await require('../_lib/zohoParties').syncZohoPartyContacts(session, userId);
  if (!contacts.error && (contacts.inserted || contacts.updated)) results.contacts_to_parties = contacts.inserted + contacts.updated;
  if (!contacts.error && contacts.read != null) await setRemoteCount(org.id, 'contacts', contacts.read);
  if (!contacts.error && contacts.with_details != null) await setRemoteCount(org.id, 'contacts_with_details', contacts.with_details);

  // Item lines (items.js): read invoice, bill, credit note and vendor credit details inside today's call budget,
  // newest first, keeping 200 calls spare. Resumes where it stopped on the next run.
  const itemStep = require('./items');
  const usedBefore = await itemStep.callsUsedToday(org.id, startedAt);

  // Which invoice each payment cleared (and the TDS withheld): one detail read per new or changed payment,
  // inside the same allowance, before the item lines take the rest.
  const runDeadline = (opts && opts.deadline) || startedAt + itemStep.TIME_LIMIT_MS;
  const links = await linkPayments(session, org, userId, {
    max: Math.min(LINK_MAX_NIGHTLY, await callsLeft(session, org, usedBefore)),
    deadline: runDeadline - 60 * 1000
  });
  if (links.read) results.payment_links = links.read;
  const itemLines = await itemStep.syncItemLines(session, org, userId, { usedBefore, deadline: runDeadline });
  if (itemLines.error) errors.push(`item_lines: ${itemLines.error}`);
  else if (itemLines.documents_read) results.item_documents = itemLines.documents_read;
  if (itemLines.items) await setRemoteCount(org.id, 'items', itemLines.items);
  // One call, weekly until it answers: may an OAuth token read Zoho's Sales by Item report? (items.js)
  if (itemLines.items) { const probe = await itemStep.probeItemReports(session, org); if (probe) results.salesbyitem_report = probe.status; }

  // Persist plan-level flags discovered during the run.
  const orgPatch = {};
  if (flags.indexOf('bank_data_unavailable') !== -1 && !org.bank_data_unavailable) {
    orgPatch.bank_data_unavailable = true;
  }
  if (flags.indexOf('multi_currency_detected') !== -1 && !org.multi_currency_detected) {
    orgPatch.multi_currency_detected = true;
  }
  // "Backfill done" really means "do we have real data yet" for the UI's
  // sync-in-progress banner. Gating this strictly on a clean *backfill-mode*
  // run is fragile: the initial backfill is kicked off fire-and-forget from
  // zoho-select-org.js and can get cut off by a serverless timeout before it
  // ever reaches here, permanently wedging the banner even after weeks of
  // successful nightly delta syncs.
  //
  // It's also fragile to require zero errors across every module: one
  // under-scoped or flaky module (e.g. chartofaccounts 401ing because the
  // connected token predates a scope being added — see zoho-books-auth-flow)
  // pushes an entry into `errors` every single run and would permanently
  // wedge this flag even though the org is clearly live and other modules
  // are pulling real records. A hard auth failure already takes a different
  // path entirely — it throws ZohoAuthError up to handleAuthFailure() and
  // never reaches this line — so simply getting here means the session
  // itself authenticated fine. That's enough to call the org "synced" the
  // first time it hasn't been set yet; a handful of clean nightly runs will
  // have already surfaced any real per-module problem in connector_logs
  // long before this banner matters to anyone.
  if (!org.backfill_completed_at) {
    orgPatch.backfill_completed_at = new Date().toISOString();
  }
  if (Object.keys(orgPatch).length > 0) {
    try {
      await updateRows('zoho_organizations', `id=eq.${org.id}`, orgPatch);
    } catch (err) {
      console.error('Failed to persist org flags');
    }
  }

  // Rate-limit budget warning at 80% of the plan's daily cap.
  const cap = dailyCapFor(org.plan_type);
  const used = session.callCount();
  await itemStep.addCallsToday(org.id, used, startedAt);
  if (used >= cap * 0.8) {
    errors.push(`rate_budget_warning: used ${used} of ~${cap} daily calls`);
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'rate_budget',
      status: 'error', errorMessage: `Used ${used}/${cap} daily API calls`
    });
  }

  const totalSynced = Object.keys(results).reduce((sum, k) => sum + (results[k] || 0), 0);
  const durationMs = Date.now() - startedAt;
  const runStatus = errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error');

  await logConnectorEvent({
    userId, connectorType: 'zoho_books',
    operation: syncMode === 'backfill' ? 'backfill_all' : 'sync_all',
    status: runStatus,
    errorMessage: errors.length ? errors.join('; ') : null,
    recordsSynced: totalSynced,
    syncDurationMs: durationMs
  });

  const moduleErrors = errors.filter((e) => !/^rate_budget_warning/.test(e)).length;
  await syncEvent(userId, {
    ok: runStatus !== 'error',
    status: runStatus,
    error_code: moduleErrors ? 'module_errors' : (errors.length ? 'rate_limited' : 'none'),
    mode: syncMode,
    rows_synced: totalSynced,
    modules_failed: moduleErrors,
    duration_s: Math.round(durationMs / 1000)
  });

  // Stamp a run timestamp on the org row so the freshness line (Ops Console,
  // the app's "last synced" text) reflects reality. Reaching here means the
  // session authenticated — a ZohoAuthError would have thrown long before.
  // 2026-09-10-zoho-last-synced.sql adds this column.
  if (runStatus !== 'error') {
    try {
      await updateRows('zoho_organizations', `id=eq.${org.id}`, {
        last_synced_at: new Date().toISOString()
      });
    } catch (err) {
      console.error('Failed to stamp zoho_organizations.last_synced_at');
    }
  }

  return {
    status: errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error'),
    mode: syncMode,
    org_ref: org.id,
    records_synced: totalSynced,
    breakdown: results,
    flags,
    api_calls_used: used,
    item_lines: itemLines,
    errors: errors.length ? errors : undefined,
    duration_ms: durationMs
  };
}

/** Calls left today after the nightly reserve: Zoho's own count when its answers carry one, else Margyn's ledger. */
async function callsLeft(session, org, usedBefore) {
  const itemStep = require('./items');
  const rl = typeof session.rateLimit === 'function' ? session.rateLimit() : null;
  if (rl) return rl.remaining - itemStep.RESERVE_CALLS;
  return (await itemStep.dailyCap(org)) - usedBefore - session.callCount() - itemStep.RESERVE_CALLS;
}

/** A run Zoho rate-limited: count the calls, say so in connector_logs, and leave every cursor for the next run. */
async function finishRateLimited(session, org, userId, syncMode, startedAt, results, errors) {
  const itemStep = require('./items');
  const used = session.callCount();
  await itemStep.addCallsToday(org.id, used, startedAt);
  const totalSynced = Object.keys(results).reduce((sum, k) => sum + (results[k] || 0), 0);
  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: syncMode === 'backfill' ? 'backfill_all' : 'sync_all',
    status: totalSynced > 0 ? 'partial' : 'error',
    errorMessage: 'rate_limited: Zoho asked Margyn to slow down; the rest is read on the next run. ' + errors.join('; '),
    recordsSynced: totalSynced, syncDurationMs: Date.now() - startedAt
  });
  await syncEvent(userId, { ok: totalSynced > 0, status: totalSynced > 0 ? 'partial' : 'error', error_code: 'rate_limited', mode: syncMode,
    rows_synced: totalSynced, modules_failed: 0, duration_s: Math.round((Date.now() - startedAt) / 1000) });
  return { status: totalSynced > 0 ? 'partial' : 'error', mode: syncMode, org_ref: org.id, records_synced: totalSynced, breakdown: results,
    rate_limited: true, message: 'Zoho asked Margyn to slow down. The rest is read on the next run.', api_calls_used: used, errors, duration_ms: Date.now() - startedAt };
}

/* ------------------------------------------------- daytime money refresh */

const REFRESH_MIN_AGE_MS = 20 * 60 * 1000;   // synced this recently (Sync now, the last update): nothing to do
const REFRESH_SPARE_CALLS = 250;              // never dips into the nightly sync's 200-call reserve

/**
 * Before each WhatsApp update (margynWatch.runWatchAll): a quick delta of the money only, so a Zoho account's
 * 10:30 / 12:30 / 15:00 / 17:00 update isn't the 02:30 figures again. Invoices, bills, payments, bank accounts
 * and the chart of accounts with balances (about 6–8 calls), plus a few payment links. No P&L postings re-read,
 * no item lines, no sweep: those stay nightly. Inside today's allowance and the caller's deadline; Zoho's first
 * 429 stops it (the cursors stay, the next run carries on). → { refreshed, reason?, calls?, breakdown? }
 */
async function refreshZohoMoney(userId, opts) {
  const o = opts || {};
  const started = Date.now();
  const deadline = o.deadline || started + 30 * 1000;
  let org;
  try {
    const orgs = await selectRows('zoho_organizations', `select=*&user_id=eq.${userId}&status=eq.active&order=connected_at.desc&limit=1`);
    org = orgs[0];
  } catch (e) { return { refreshed: false, reason: 'lookup_failed' }; }
  if (!org) return { refreshed: false, reason: 'not_connected' };
  if (!org.backfill_completed_at) return { refreshed: false, reason: 'first_sync_running' };
  const minAge = o.minAgeMs != null ? o.minAgeMs : REFRESH_MIN_AGE_MS;
  if (org.last_synced_at && started - Date.parse(org.last_synced_at) < minAge) return { refreshed: false, reason: 'fresh' };

  const itemStep = require('./items');
  const usedBefore = await itemStep.callsUsedToday(org.id, started);
  if ((await itemStep.dailyCap(org)) - usedBefore < REFRESH_SPARE_CALLS) {
    await logConnectorEvent({ userId, connectorType: 'zoho_books', operation: 'refresh_money', status: 'success', recordsSynced: 0,
      errorMessage: 'skipped: today\'s Zoho allowance is nearly used; tonight\'s sync reads the day' });
    return { refreshed: false, reason: 'allowance' };
  }

  const session = createSession(org);
  const results = {}, errors = [], flags = [];
  let complete = true;
  try {
    for (const spec of COLLECTION_SPECS) {
      if (flags.indexOf('rate_limited') !== -1 || Date.now() > deadline) { complete = false; break; }
      await syncCollection(session, org, userId, spec, 'delta', results, errors, flags, { failFast429: true, quiet: true });
    }
    if (complete && flags.indexOf('rate_limited') === -1 && Date.now() < deadline) {
      const left = Math.min(LINK_MAX_DAYTIME, (await callsLeft(session, org, usedBefore)) - (REFRESH_SPARE_CALLS - itemStep.RESERVE_CALLS));
      const links = await linkPayments(session, org, userId, { max: left, deadline });
      if (links.read) results.payment_links = links.read;
    }
  } catch (err) {
    if (err instanceof ZohoAuthError) {
      await handleAuthFailure(userId, err.message);
      return { refreshed: false, reason: 'needs_reauth' };
    }
    errors.push(err.message);
  } finally {
    await itemStep.addCallsToday(org.id, session.callCount(), started);
  }

  const ok = complete && errors.length === 0;
  // Stamped only when every money module came in: the books' freshness (and the Margin page's saved answer) follow it.
  if (ok) {
    try { await updateRows('zoho_organizations', `id=eq.${org.id}`, { last_synced_at: new Date().toISOString() }); }
    catch (e) { console.error('Failed to stamp zoho_organizations.last_synced_at'); }
  }
  const total = Object.keys(results).reduce((t, k) => t + (results[k] || 0), 0);
  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: 'refresh_money',
    status: ok ? 'success' : (total > 0 ? 'partial' : 'error'),
    errorMessage: ok ? null : (flags.indexOf('rate_limited') !== -1 ? 'rate_limited: carries on next run' : (errors.join('; ') || 'out of time this run')),
    recordsSynced: total, syncDurationMs: Date.now() - started
  });
  return { refreshed: ok, reason: ok ? undefined : (flags.indexOf('rate_limited') !== -1 ? 'rate_limited' : 'partial'), calls: session.callCount(), breakdown: results };
}

async function handleAuthFailure(userId, detail) {
  const orgs = await selectRows(
    'zoho_organizations',
    `select=id&user_id=eq.${userId}&status=in.(active,needs_reauth)&limit=1`
  );
  if (orgs[0]) await markNeedsReauth(orgs[0].id);
  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: 'sync_all',
    status: 'error',
    // Keep the actual failure (which endpoint / what Zoho said) so the Ops
    // Console and connector_logs show more than a bare 'needs_reauth'.
    errorMessage: detail ? `needs_reauth: ${String(detail).slice(0, 240)}` : 'needs_reauth'
  });
  await syncEvent(userId, { ok: false, status: 'error', error_code: 'needs_reauth', rows_synced: 0, modules_failed: 0 });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await getUserFromRequest(req);
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

  try {
    const result = await syncZohoForUser(user.id, body.mode);
    res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) {
    if (err instanceof ZohoAuthError) {
      await handleAuthFailure(user.id, err.message);
      res.status(401).json({ status: 'error', message: 'Zoho Books connection needs to be re-authorized' });
      return;
    }
    res.status(500).json({ status: 'error', message: 'Sync failed unexpectedly' });
  }
};

module.exports = {
  handler, syncZohoForUser, refreshZohoMoney, handleAuthFailure, journalRows, linkPayments, appliedFrom, paymentsToLink, paymentNumbers,
  // mappers, for tests that build stored rows exactly as a sync would
  _mapInvoice: mapInvoice, _mapBill: mapBill, _mapCustomerPayment: mapCustomerPayment,
  _mapVendorPayment: mapVendorPayment, _mapBankAccount: mapBankAccount, _mapAccount: mapAccount
};
