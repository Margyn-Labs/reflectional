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
  ZohoModuleUnavailable
} = require('../_lib/zohoClient');

const BACKFILL_MONTHS = 12;
const JOURNAL_ACCOUNT_TYPES = ['income', 'cost_of_goods_sold', 'expense', 'other_expense'];
const MAX_JOURNAL_ACCOUNTS = 60;   // rate-limit guard: 1 call per P&L account
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
    invoice_ref: firstInvoice ? String(firstInvoice) : (p.invoice_id ? String(p.invoice_id) : null),
    customer_ref: p.customer_id ? String(p.customer_id) : null,
    amount: toNumber(p.amount),
    payment_date: toDateOnly(p.date) || toDateOnly(p.payment_date),
    payment_mode: p.payment_mode || null,
    last_modified_time: p.last_modified_time ? new Date(p.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

function mapVendorPayment(p, orgRef) {
  if (!p.payment_id) return null;
  const firstBill = Array.isArray(p.bills) && p.bills.length ? p.bills[0].bill_id : null;
  return {
    org_ref: orgRef,
    payment_id: String(p.payment_id),
    bill_ref: firstBill ? String(firstBill) : (p.bill_id ? String(p.bill_id) : null),
    vendor_ref: p.vendor_id ? String(p.vendor_id) : null,
    amount: toNumber(p.amount),
    payment_date: toDateOnly(p.date) || toDateOnly(p.payment_date),
    payment_mode: p.payment_mode || null,
    last_modified_time: p.last_modified_time ? new Date(p.last_modified_time).toISOString() : null,
    synced_at: new Date().toISOString()
  };
}

function mapBankAccount(a, orgRef) {
  if (!a.account_id) return null;
  return {
    org_ref: orgRef,
    account_id: String(a.account_id),
    bank_name: a.bank_name || a.account_name || null,
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
    synced_at: new Date().toISOString()
  };
}

// ----------------------------------------------------------------- upsert

async function upsert(table, rows, conflictColumns) {
  if (!rows.length) return 0;
  // Chunk so a very large backfill batch doesn't blow the PostgREST payload limit.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await insertRows(table, rows.slice(i, i + CHUNK), { onConflict: conflictColumns, merge: true });
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
async function syncCollection(session, org, userId, spec, mode, results, errors, flags) {
  const opStart = Date.now();
  const cursor = await getSyncCursor(org.id, spec.module);
  const { since, isBackfill } = windowFor(mode, cursor);

  const query = {};
  if (spec.supportsLastModified) {
    // Delta sync. This is the whole point — never a full-table pull.
    query.last_modified_time = toZohoFilterTime(since);
    query.sort_column = 'last_modified_time';
  } else if (spec.dateField) {
    query[spec.dateField] = toDateOnly(since);
  }

  try {
    const raw = await session.apiGetAll(spec.path, spec.collectionKey, query);
    const rows = raw.map((r) => spec.map(r, org.id)).filter(Boolean);

    // Multi-currency detection: excluded from vitals until conversion exists.
    if (spec.checksCurrency && rows.some((r) => r.currency_code && r.currency_code !== 'INR')) {
      if (flags.indexOf('multi_currency_detected') === -1) flags.push('multi_currency_detected');
    }

    const count = await upsert(spec.table, rows, spec.conflict);
    results[spec.module] = count;

    const watermark = maxWatermark(rows, 'last_modified_time') || new Date().toISOString();
    await setSyncCursor(org.id, spec.module, watermark, 'success');

    await logConnectorEvent({
      userId, connectorType: 'zoho_books',
      operation: (isBackfill ? 'backfill_' : 'sync_') + spec.module,
      status: 'success', recordsSynced: count, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;

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
 * Journal entries for P&L accounts only (income / COGS / opex) — the
 * accounts net margin and burn rate actually read. Zoho exposes postings per
 * account via /chartofaccounts/{id}/transactions, so this costs one call per
 * P&L account; capped and paced to stay inside 100 req/min.
 *
 * NOTE: this endpoint's response shape is the least-documented part of the
 * Books API. Validate field names against a sandbox org before pilot use
 * (flagged in DEPLOY.md).
 */
async function syncJournalEntries(session, org, userId, mode, results, errors) {
  const opStart = Date.now();
  const cursor = await getSyncCursor(org.id, 'journals');
  const { since } = windowFor(mode, cursor);

  try {
    const accounts = await selectRows(
      'zoho_chart_of_accounts',
      `select=id,account_id,account_type&org_ref=eq.${org.id}` +
      `&account_type=in.(${JOURNAL_ACCOUNT_TYPES.join(',')})&limit=${MAX_JOURNAL_ACCOUNTS}`
    );

    if (accounts.length === 0) {
      results.journals = 0;
      await setSyncCursor(org.id, 'journals', new Date().toISOString(), 'success');
      return;
    }

    const dateStart = toDateOnly(since);
    const dateEnd = toDateOnly(new Date().toISOString());
    let total = 0;

    for (const acct of accounts) {
      let txns = [];
      try {
        txns = await session.apiGetAll(
          `books/v3/chartofaccounts/${acct.account_id}/transactions`,
          'transactions',
          { date_start: dateStart, date_end: dateEnd }
        );
      } catch (err) {
        if (err instanceof ZohoAuthError) throw err;
        if (err instanceof ZohoModuleUnavailable) continue;
        errors.push(`journals(${acct.account_id}): ${err.message}`);
        continue;
      }

      const rows = txns.map((t) => {
        const date = toDateOnly(t.date || t.transaction_date);
        if (!date) return null;
        return {
          org_ref: org.id,
          account_ref: acct.id,
          transaction_id: String(t.transaction_id || t.categorized_transaction_id || `${acct.account_id}:${date}:${t.debit_or_credit || ''}:${t.amount || 0}`),
          entry_date: date,
          debit: toNumber(t.debit_or_credit === 'debit' ? (t.amount || t.debit) : t.debit),
          credit: toNumber(t.debit_or_credit === 'credit' ? (t.amount || t.credit) : t.credit),
          synced_at: new Date().toISOString()
        };
      }).filter(Boolean);

      total += await upsert('zoho_journal_entries', rows, 'org_ref,account_ref,transaction_id');
      await sleep(ACCOUNT_CALL_DELAY_MS);
    }

    results.journals = total;
    await setSyncCursor(org.id, 'journals', new Date().toISOString(), 'success');
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'sync_journals',
      status: 'success', recordsSynced: total, syncDurationMs: Date.now() - opStart
    });
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;
    errors.push(`journals: ${err.message}`);
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
    conflict: 'org_ref,account_id', map: mapAccount, supportsLastModified: false
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
    conflict: 'org_ref,payment_id', map: mapCustomerPayment, supportsLastModified: true
  },
  {
    module: 'vendorpayments', path: 'books/v3/vendorpayments',
    collectionKey: 'vendorpayments', table: 'zoho_vendor_payments',
    conflict: 'org_ref,payment_id', map: mapVendorPayment, supportsLastModified: true
  },
  {
    module: 'bankaccounts', path: 'books/v3/bankaccounts',
    collectionKey: 'bankaccounts', table: 'zoho_bank_accounts',
    conflict: 'org_ref,account_id', map: mapBankAccount,
    supportsLastModified: false,           // single lightweight call, cheap daily
    unavailableFlag: 'bank_data_unavailable'
  }
];

// -------------------------------------------------------------- core sync

async function syncZohoForUser(userId, mode) {
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
    return { status: 'error', message: 'Zoho Books not connected' };
  }

  const session = createSession(org);
  const results = {};
  const errors = [];
  const flags = [];

  for (const spec of COLLECTION_SPECS) {
    await syncCollection(session, org, userId, spec, syncMode, results, errors, flags);
  }

  await syncJournalEntries(session, org, userId, syncMode, results, errors);

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
  // successful nightly delta syncs. So any error-free run — backfill or
  // delta — sets this the first time it hasn't been set yet, letting a
  // stuck backfill self-heal on the very next cron pass.
  if (errors.length === 0 && !org.backfill_completed_at) {
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
  if (used >= cap * 0.8) {
    errors.push(`rate_budget_warning: used ${used} of ~${cap} daily calls`);
    await logConnectorEvent({
      userId, connectorType: 'zoho_books', operation: 'rate_budget',
      status: 'error', errorMessage: `Used ${used}/${cap} daily API calls`
    });
  }

  const totalSynced = Object.keys(results).reduce((sum, k) => sum + (results[k] || 0), 0);
  const durationMs = Date.now() - startedAt;

  await logConnectorEvent({
    userId, connectorType: 'zoho_books',
    operation: syncMode === 'backfill' ? 'backfill_all' : 'sync_all',
    status: errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error'),
    errorMessage: errors.length ? errors.join('; ') : null,
    recordsSynced: totalSynced,
    syncDurationMs: durationMs
  });

  return {
    status: errors.length === 0 ? 'success' : (totalSynced > 0 ? 'partial' : 'error'),
    mode: syncMode,
    org_ref: org.id,
    records_synced: totalSynced,
    breakdown: results,
    flags,
    api_calls_used: used,
    errors: errors.length ? errors : undefined,
    duration_ms: durationMs
  };
}

async function handleAuthFailure(userId) {
  const orgs = await selectRows(
    'zoho_organizations',
    `select=id&user_id=eq.${userId}&status=eq.active&limit=1`
  );
  if (orgs[0]) await markNeedsReauth(orgs[0].id);
  await logConnectorEvent({
    userId, connectorType: 'zoho_books', operation: 'sync_all',
    status: 'error', errorMessage: 'needs_reauth'
  });
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
      await handleAuthFailure(user.id);
      res.status(401).json({ status: 'error', message: 'Zoho Books connection needs to be re-authorized' });
      return;
    }
    res.status(500).json({ status: 'error', message: 'Sync failed unexpectedly' });
  }
};

module.exports = { handler, syncZohoForUser, handleAuthFailure };
