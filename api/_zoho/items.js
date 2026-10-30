/**
 * Zoho Books item lines (2026-10-30, ZOHO-ITEM-LEVEL-PLAN.md).
 *
 * Zoho's list endpoints never return line items, so every invoice, bill, credit note and vendor credit is read
 * once on its own (GET /invoices/{id} ...), and again only when Zoho says it changed. On the Free plan that's
 * 1,000 calls a day for everything, so the reads are a queue worked inside a budget:
 *   budget = plan daily cap − calls already spent today − 200 kept for the nightly money sync,
 *   newest first (this financial year first), at most 240 s of the function's 300 s, READERS at a time with call
 *   starts at least 650 ms apart (~90 a minute, under Zoho's 100 a minute and 5 at once on Free).
 * A 429 stops the queue for the run; what's left is read next run. Void, draft and deleted documents lose their
 * lines. The item master (GET /items, 1 call per 200 items) gives names, units and a fallback purchase rate.
 *
 * Two entry points: syncItemLines (end of the nightly / Sync now run, after the money modules) and the owner's
 * "Fill now" (handleFillNow, POST /api/zoho?action=fill-items), which spends the rest of the day's budget and
 * keeps the same 200-call reserve.
 *
 * Line value, as Tally's stock line carries it: before tax, base currency (item_total × bcy_rate / rate),
 * inclusive tax backed out at tax_percentage, a document discount before tax spread over the lines pro rata.
 * Quantity and value are stored positive; the books layer takes the sign from the voucher type.
 */

const { selectRows, insertRows, updateRows, deleteRows, getUserFromRequest, logConnectorEvent } = require('../_lib/supabaseRest');
const {
  createSession, getSyncCursor, setSyncCursor, dailyCapFor, toDateOnly, toNumber, sleep,
  ZohoAuthError, ZohoModuleUnavailable, ZohoRateLimited
} = require('../_lib/zohoClient');

const RESERVE_CALLS = 200;          // kept for the nightly money sync
const TIME_LIMIT_MS = 240 * 1000;   // of the 300 s function limit
const DETAIL_GAP_MS = 650;          // between call starts across all readers: ~90 a minute
const READERS = 3;                  // documents read at once (Zoho allows 5 concurrent on Free, 10 on paid)
const BACKFILL_MONTHS = 12;
const DEAD = /^(draft|void|deleted_at_source|deleted)$/i;

const DOCS = {
  invoice: { path: 'books/v3/invoices/', key: 'invoice' },
  bill: { path: 'books/v3/bills/', key: 'bill' },
  creditnote: { path: 'books/v3/creditnotes/', key: 'creditnote', list: 'books/v3/creditnotes', listKey: 'creditnotes', idField: 'creditnote_id', numField: 'creditnote_number', cursor: 'creditnotes' },
  vendorcredit: { path: 'books/v3/vendorcredits/', key: 'vendor_credit', list: 'books/v3/vendorcredits', listKey: 'vendorcredits', idField: 'vendor_credit_id', numField: 'vendor_credit_number', cursor: 'vendorcredits' }
};

const r2 = (n) => Math.round(toNumber(n) * 100) / 100;
const iso = (v) => (v ? new Date(v).toISOString() : null);

/* ------------------------------------------------------------- pure mappers */

function mapItem(i, orgRef) {
  if (!i || !i.item_id) return null;
  return {
    org_ref: orgRef, item_id: String(i.item_id), name: i.name || i.item_name || null, sku: i.sku || null, unit: i.unit || null,
    rate: i.rate != null ? toNumber(i.rate) : null, purchase_rate: i.purchase_rate != null ? toNumber(i.purchase_rate) : null,
    product_type: i.product_type || null, item_type: i.item_type || null, status: i.status || null,
    stock_on_hand: i.stock_on_hand != null && i.stock_on_hand !== '' ? toNumber(i.stock_on_hand) : null,
    last_modified_time: iso(i.last_modified_time), synced_at: new Date().toISOString()
  };
}

/** A document's document-level discount before tax, in its own currency (0 when none or after tax). */
function docDiscount(doc, linesTotal) {
  if (String(doc.discount_type || '') !== 'entity_level' || doc.is_discount_before_tax === false) return 0;
  if (doc.discount_amount != null && toNumber(doc.discount_amount) > 0) return toNumber(doc.discount_amount);
  const d = String(doc.discount == null ? '' : doc.discount).trim();
  if (/%$/.test(d)) return linesTotal * toNumber(d.slice(0, -1)) / 100;
  return toNumber(d);
}

/**
 * One document's item lines as zoho_document_lines rows. Lines without an item (free text) are left out: Tally
 * lines are stock items only. Exported for tests.
 */
function documentLines(doc, docType, orgRef) {
  const lines = Array.isArray(doc && doc.line_items) ? doc.line_items : [];
  const docId = String(doc[docType === 'invoice' ? 'invoice_id' : docType === 'bill' ? 'bill_id' : DOCS[docType].idField] || '');
  const xr = toNumber(doc.exchange_rate) || 1;
  const total = lines.reduce((t, l) => t + toNumber(l.item_total), 0);
  const disc = docDiscount(doc, total);
  const keep = total > 0 && disc > 0 ? Math.max(0, 1 - disc / total) : 1;   // pro rata share of the discount
  const out = [];
  for (const l of lines) {
    if (!l || !l.item_id || !l.line_item_id) continue;
    const rate = toNumber(l.rate), bcy = toNumber(l.bcy_rate);
    let v = toNumber(l.item_total) * keep;
    v = rate && l.bcy_rate != null ? v * (bcy / rate) : v * xr;   // base currency
    // Inclusive tax: item_total carries the tax unless Zoho also sent the inclusive figure separately (bills).
    const taxPct = toNumber(l.tax_percentage);
    const alreadyNet = l.item_total_inclusive_of_tax != null && Math.abs(toNumber(l.item_total_inclusive_of_tax) - toNumber(l.item_total)) > 0.005;
    if (doc.is_inclusive_tax && taxPct > 0 && !alreadyNet) v = v / (1 + taxPct / 100);
    out.push({
      org_ref: orgRef, doc_type: docType, doc_id: docId, line_item_id: String(l.line_item_id),
      item_id: String(l.item_id), item_name: l.name || l.item_name || null, sku: l.sku || null,
      qty: Math.abs(toNumber(l.quantity)), unit: l.unit || null,
      rate: l.rate != null ? rate : null, bcy_rate: l.bcy_rate != null ? bcy : null,
      discount_amount: l.discount_amount != null ? toNumber(l.discount_amount) : null,
      item_total: l.item_total != null ? toNumber(l.item_total) : null,
      tax_pct: l.tax_percentage != null ? taxPct : null, is_inclusive_tax: !!doc.is_inclusive_tax,
      value: r2(Math.abs(v)), location_name: l.location_name || doc.location_name || null,
      account_id: l.account_id ? String(l.account_id) : null, doc_date: toDateOnly(doc.date),
      synced_at: new Date().toISOString()
    });
  }
  return out;
}

/** Queue order: this financial year (from 1 April, IST) first, then newest document, then most recently changed. */
function queueOrder(rows, nowMs) {
  const ist = new Date(nowMs + 5.5 * 3600 * 1000);
  const fyYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const fyStart = fyYear + '-04-01';
  const inFy = (r) => (r.doc_date && r.doc_date >= fyStart ? 1 : 0);
  return rows.slice().sort((a, b) => inFy(b) - inFy(a)
    || String(b.doc_date || '').localeCompare(String(a.doc_date || ''))
    || String(b.doc_last_modified || '').localeCompare(String(a.doc_last_modified || '')));
}

/** Lines still to read: never read, or changed in Zoho since they were. */
function needsRead(s) {
  if (DEAD.test(String(s.status || ''))) return false;
  if (!s.lines_read_at || !s.read_modified) return true;
  return !!s.doc_last_modified && new Date(s.doc_last_modified).getTime() > new Date(s.read_modified).getTime();
}

/* ------------------------------------------------------- daily call ledger */

// zoho_sync_state row module 'api_calls': remote_count = calls spent on the IST day of last_synced_at.
const istDay = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function callsUsedToday(orgRef, nowMs) {
  try {
    const rows = await selectRows('zoho_sync_state', `select=last_synced_at,remote_count&org_ref=eq.${orgRef}&module=eq.api_calls&limit=1`);
    const r = rows[0];
    if (!r || !r.last_synced_at || istDay(new Date(r.last_synced_at).getTime()) !== istDay(nowMs)) return 0;
    return toNumber(r.remote_count);
  } catch (e) { return 0; }
}

async function addCallsToday(orgRef, n, nowMs) {
  if (!n) return;
  try {
    const used = await callsUsedToday(orgRef, nowMs);
    const at = new Date(nowMs).toISOString();
    await insertRows('zoho_sync_state', [{ org_ref: orgRef, module: 'api_calls', last_synced_at: at, last_run_at: at, last_run_status: 'success', remote_count: used + n }],
      { onConflict: 'org_ref,module', merge: true });
  } catch (e) { console.error('Could not record Zoho calls used today'); }
}

// zoho_sync_state row module 'api_limit': remote_count = the daily allowance Zoho itself last reported.
async function learnedLimit(orgRef) {
  try {
    const rows = await selectRows('zoho_sync_state', `select=remote_count&org_ref=eq.${orgRef}&module=eq.api_limit&limit=1`);
    const n = rows[0] ? toNumber(rows[0].remote_count) : 0;
    return n > 0 ? n : null;
  } catch (e) { return null; }
}

/** Today's allowance: what Zoho last said it is, else the plan's published figure. */
async function dailyCap(org) {
  return (await learnedLimit(org.id)) || dailyCapFor(org.plan_type);
}

async function rememberLimit(orgRef, session) {
  const rl = session && typeof session.rateLimit === 'function' ? session.rateLimit() : null;
  if (!rl) return;
  try {
    const at = new Date().toISOString();
    await insertRows('zoho_sync_state', [{ org_ref: orgRef, module: 'api_limit', last_synced_at: at, last_run_at: at, last_run_status: 'success', remote_count: rl.limit }],
      { onConflict: 'org_ref,module', merge: true });
  } catch (e) { /* only a hint for the next run */ }
}

/* -------------------------------------------------------------------- ETA */

const DOCS_PER_MINUTE = 85;        // READERS at DETAIL_GAP_MS, less list calls
const NIGHTLY_MONEY_CALLS = 60;    // a typical delta money sync; the 200 reserve covers bigger nights

/**
 * When will the item lines be complete? Pure; the Zoho card shows it.
 *   pending   documents still to read
 *   cap       daily allowance; usedToday calls spent today (IST)
 * → { when: 'done' } | { when: 'today', minutes } (fits in today's allowance: the follow-on fill runs it now)
 *   | { when: 'tomorrow_morning' } (fits in tonight's 2:30 am run plus its follow-ons) | { when: 'days', days }
 */
function fillEta({ pending, cap, usedToday }) {
  const n = toNumber(pending);
  if (!(n > 0)) return { when: 'done' };
  const perDay = Math.max(1, toNumber(cap) - RESERVE_CALLS - NIGHTLY_MONEY_CALLS);
  const today = Math.max(0, toNumber(cap) - toNumber(usedToday) - RESERVE_CALLS);
  if (n <= today) return { when: 'today', minutes: Math.max(1, Math.ceil(n / DOCS_PER_MINUTE)) };
  const rest = n - today;
  if (rest <= perDay) return { when: 'tomorrow_morning' };
  return { when: 'days', days: 1 + Math.ceil((rest - perDay) / perDay) };
}

/* ------------------------------------------------------------------- queue */

async function upsertChunks(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) await insertRows(table, rows.slice(i, i + 500), { onConflict: conflict, merge: true });
}

/** Credit notes and vendor credits: their own lists (delta by last_modified_time). null when Zoho won't let us read them. */
async function listReturns(session, orgRef, type) {
  const d = DOCS[type];
  const cursor = await getSyncCursor(orgRef, d.cursor);
  const since = cursor ? new Date(new Date(cursor).getTime() - 3600 * 1000) : new Date(Date.now() - BACKFILL_MONTHS * 30.5 * 24 * 3600 * 1000);
  let raw;
  try {
    raw = await session.apiGetAll(d.list, d.listKey, { last_modified_time: since.toISOString().replace(/\.\d{3}Z$/, '+0000'), sort_column: 'last_modified_time' });
  } catch (e) {
    // The connection predates creditnotes.READ / debitnotes.READ: Zoho refuses this one module (code 57, or a
    // 401 on a token that just worked for every other module). Skip it until the owner reconnects.
    if (e instanceof ZohoModuleUnavailable || e instanceof ZohoAuthError) return null;
    throw e;
  }
  const rows = raw.filter((r) => r[d.idField]).map((r) => ({
    org_ref: orgRef, doc_type: type, doc_id: String(r[d.idField]), doc_number: r[d.numField] || null,
    doc_date: toDateOnly(r.date), status: r.status || null, doc_last_modified: iso(r.last_modified_time)
  }));
  const wm = rows.reduce((m, r) => (r.doc_last_modified && (!m || r.doc_last_modified > m) ? r.doc_last_modified : m), null);
  await setSyncCursor(orgRef, d.cursor, wm || cursor || new Date().toISOString(), 'success');
  return rows;
}

/** Bring zoho_line_state up to date with every document we know of. Returns the state rows (all of them). */
async function refreshState(session, orgRef, out) {
  const [state, inv, bil] = await Promise.all([
    selectRows('zoho_line_state', `select=doc_type,doc_id,doc_date,status,doc_last_modified,read_modified,lines_read_at,line_count&org_ref=eq.${orgRef}&order=id.asc&limit=200000`),
    selectRows('zoho_invoices', `select=invoice_id,invoice_number,invoice_date,status,last_modified_time&org_ref=eq.${orgRef}&order=invoice_id.asc&limit=200000`),
    selectRows('zoho_bills', `select=bill_id,bill_number,bill_date,status,last_modified_time&org_ref=eq.${orgRef}&order=bill_id.asc&limit=200000`)
  ]);
  const docs = [
    ...inv.map((i) => ({ org_ref: orgRef, doc_type: 'invoice', doc_id: String(i.invoice_id), doc_number: i.invoice_number || null, doc_date: i.invoice_date || null, status: i.status || null, doc_last_modified: iso(i.last_modified_time) })),
    ...bil.map((b) => ({ org_ref: orgRef, doc_type: 'bill', doc_id: String(b.bill_id), doc_number: b.bill_number || null, doc_date: b.bill_date || null, status: b.status || null, doc_last_modified: iso(b.last_modified_time) }))
  ];
  for (const t of ['creditnote', 'vendorcredit']) {
    const rows = await listReturns(session, orgRef, t);
    if (rows == null) out.unavailable.push(t); else docs.push(...rows);
  }
  const key = (r) => r.doc_type + ':' + r.doc_id;
  const byKey = new Map(state.map((s) => [key(s), s]));
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));
  const sameTime = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
  const changed = docs.filter((d) => {
    const s = byKey.get(key(d));
    return !s || !same(s.status, d.status) || !same(s.doc_date, d.doc_date) || !sameTime(s.doc_last_modified, d.doc_last_modified);
  });
  if (changed.length) await upsertChunks('zoho_line_state', changed, 'org_ref,doc_type,doc_id');
  for (const d of changed) byKey.set(key(d), Object.assign({}, byKey.get(key(d)) || {}, d));
  return [...byKey.values()];
}

async function replaceLines(orgRef, type, docId, rows, readModified) {
  await deleteRows('zoho_document_lines', `org_ref=eq.${orgRef}&doc_type=eq.${type}&doc_id=eq.${encodeURIComponent(docId)}`);
  if (rows.length) await insertRows('zoho_document_lines', rows, { onConflict: 'org_ref,doc_type,line_item_id', merge: true });
  await updateRows('zoho_line_state', `org_ref=eq.${orgRef}&doc_type=eq.${type}&doc_id=eq.${encodeURIComponent(docId)}`,
    { lines_read_at: new Date().toISOString(), read_modified: readModified || new Date().toISOString(), line_count: rows.length });
}

/**
 * The whole item step. `session` is the run's Zoho session (its call count is part of today's spend).
 * opts: { deadline (ms epoch), usedBefore (calls spent today before this run) }.
 */
async function syncItemLines(session, org, userId, opts) {
  const o = opts || {};
  const startedAt = Date.now();
  const deadline = o.deadline || startedAt + TIME_LIMIT_MS;
  const cap = await dailyCap(org);
  const usedBefore = o.usedBefore != null ? o.usedBefore : await callsUsedToday(org.id, startedAt);
  let inflight = 0;   // reads started but not yet counted by the session
  // Our own ledger, or Zoho's count when its answers carry one (X-Rate-Limit-Remaining is the truth: it includes
  // calls made outside Margyn, trials and any raise Zoho support granted).
  const left = () => {
    const rl = typeof session.rateLimit === 'function' ? session.rateLimit() : null;
    if (rl) return rl.remaining - inflight - RESERVE_CALLS;
    return cap - usedBefore - session.callCount() - inflight - RESERVE_CALLS;
  };
  const out = { items: 0, documents_read: 0, lines: 0, dropped: 0, pending: 0, stopped: null, unavailable: [], budget_at_start: left() };

  if (left() <= 0) { out.stopped = 'budget'; return out; }
  try {
    // Item master. No items at all means no item lines to read either (free-text invoices only).
    let items;
    try { items = await session.apiGetAll('books/v3/items', 'items', {}); }
    catch (e) {
      if (e instanceof ZohoModuleUnavailable) { out.stopped = 'items_unavailable'; return out; }
      throw e;
    }
    const itemRows = items.map((i) => mapItem(i, org.id)).filter(Boolean);
    if (itemRows.length) await upsertChunks('zoho_items', itemRows, 'org_ref,item_id');
    out.items = itemRows.length;
    if (!itemRows.length) { out.stopped = 'no_items'; return out; }

    const state = await refreshState(session, org.id, out);

    // Void, draft and deleted documents: drop their lines, nothing to read.
    for (const s of state) {
      if (!DEAD.test(String(s.status || '')) || (s.lines_read_at && !s.line_count)) continue;
      await replaceLines(org.id, s.doc_type, s.doc_id, [], s.doc_last_modified);
      out.dropped++;
    }

    const skip = new Set(out.unavailable);
    const queue = queueOrder(state.filter((s) => needsRead(s) && !skip.has(s.doc_type)), startedAt);
    // READERS documents at once, call starts spaced DETAIL_GAP_MS apart. A stop (budget, time, 429) lets the
    // reads already in flight finish; whatever wasn't taken stays queued for the next run.
    let next = 0, nextStart = 0, fatal = null;
    const taken = new Set();
    const reader = async () => {
      while (!out.stopped && !fatal && next < queue.length) {
        const s = queue[next++];
        if (skip.has(s.doc_type)) continue;
        if (left() <= 0) { out.stopped = 'budget'; break; }
        if (Date.now() >= deadline) { out.stopped = 'time'; break; }
        inflight++;
        const wait = nextStart - Date.now();
        nextStart = Math.max(Date.now(), nextStart) + DETAIL_GAP_MS;
        if (wait > 0) await sleep(wait);
        taken.add(s);
        const d = DOCS[s.doc_type];
        let doc = null;
        try {
          const data = await session.apiGet(d.path + encodeURIComponent(s.doc_id), {}, { failFast429: true }).finally(() => { inflight--; });
          doc = data && data[d.key];
        } catch (e) {
          if (e instanceof ZohoRateLimited) { out.stopped = 'rate_limited'; taken.delete(s); break; }
          if (e instanceof ZohoModuleUnavailable && /code 57/.test(e.message)) { if (!skip.has(s.doc_type)) { skip.add(s.doc_type); out.unavailable.push(s.doc_type); } continue; }
          if (e instanceof ZohoAuthError && (s.doc_type === 'creditnote' || s.doc_type === 'vendorcredit')) { if (!skip.has(s.doc_type)) { skip.add(s.doc_type); out.unavailable.push(s.doc_type); } continue; }
          if (!(e instanceof ZohoModuleUnavailable)) { fatal = e; taken.delete(s); break; }
          doc = null;   // 404: gone from Zoho, so its lines go too
        }
        const rows = doc && !DEAD.test(String(doc.status || '')) ? documentLines(doc, s.doc_type, org.id) : [];
        await replaceLines(org.id, s.doc_type, s.doc_id, rows, s.doc_last_modified);
        out.documents_read++;
        out.lines += rows.length;
        if (!doc) out.dropped++;
      }
    };
    await Promise.all(Array.from({ length: READERS }, reader));
    await rememberLimit(org.id, session);
    if (fatal) throw fatal;
    out.pending = queue.filter((s) => !taken.has(s) && !skip.has(s.doc_type)).length;
    if (!out.stopped && out.pending === 0) out.stopped = 'done';
    await logConnectorEvent({ userId, connectorType: 'zoho_books', operation: 'sync_item_lines', status: 'success',
      recordsSynced: out.lines, syncDurationMs: Date.now() - startedAt,
      errorMessage: out.stopped && out.stopped !== 'done' ? `stopped: ${out.stopped}; ${out.pending} documents left` : null });
  } catch (err) {
    if (err instanceof ZohoAuthError) throw err;
    // Deployed before sql/2026-10-30-zoho-items.sql ran: skip quietly, so the nightly sync isn't marked partial.
    if (/zoho_(items|document_lines|line_state)/.test(String(err.message)) && /does not exist|schema cache|42P01|PGRST205/i.test(String(err.message))) { out.stopped = 'not_migrated'; return out; }
    out.error = err.message;
    await logConnectorEvent({ userId, connectorType: 'zoho_books', operation: 'sync_item_lines', status: 'error', errorMessage: err.message });
  }
  return out;
}

/**
 * Can this connection read Zoho's Sales by Item report? (HANDOFF-ZOHO-DEMO-READY-2026-10-30.md, Task 1 fix 0.)
 * The report answers on /api/v3 in the web session but has no public spec, so whether an OAuth token may call it,
 * and on which scope, is unknown. One call for this month, at most weekly until it works, never again after:
 * zoho_sync_state 'probe:salesbyitem' = success (with the number of items it returned) or error. Nothing reads the
 * figures yet; if it works, a year of item totals is about 24 calls instead of one per document. Never throws, and a
 * refusal here never marks the connection for reconnect.
 */
const PROBE_MODULE = 'probe:salesbyitem';
const PROBE_EVERY_MS = 7 * 24 * 3600 * 1000;
async function probeItemReports(session, org, nowMs) {
  const now = nowMs || Date.now();
  try {
    const rows = await selectRows('zoho_sync_state', `select=last_run_at,last_run_status&org_ref=eq.${org.id}&module=eq.${encodeURIComponent(PROBE_MODULE)}&limit=1`);
    const r = rows[0];
    if (r && (r.last_run_status === 'success' || now - new Date(r.last_run_at).getTime() < PROBE_EVERY_MS)) return null;
  } catch (e) { return null; }
  const ist = new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  let status = 'error', count = null, note = null;
  try {
    const data = await session.apiGet('books/v3/reports/salesbyitem', { from_date: ist.slice(0, 8) + '01', to_date: ist }, { failFast429: true });
    const list = data && (data.sales || data.salesbyitem || data.items || (Array.isArray(data.reports) ? data.reports : null));
    status = 'success';
    count = Array.isArray(list) ? list.length : 0;
    note = Object.keys(data || {}).filter((k) => k !== 'code' && k !== 'message').slice(0, 6).join(',');   // response shape, for the follow-up build
  } catch (e) {
    note = String(e.message || e).slice(0, 120);
  }
  try {
    const at = new Date(now).toISOString();
    await insertRows('zoho_sync_state', [{ org_ref: org.id, module: PROBE_MODULE, last_synced_at: at, last_run_at: at, last_run_status: status, remote_count: count }],
      { onConflict: 'org_ref,module', merge: true });
  } catch (e) { /* the probe is only information */ }
  console.log(`[zoho] Sales by Item report via OAuth: ${status}${note ? ' (' + note + ')' : ''}`);
  return { status, count, note };
}

/** How far the item lines have got, for the app and the books layer. */
function progressFrom(state) {
  const live = state.filter((s) => !DEAD.test(String(s.status || '')));
  const pending = live.filter(needsRead);
  const latestPending = pending.reduce((m, s) => (s.doc_date && (!m || s.doc_date > m) ? s.doc_date : m), null);
  return { documents: live.length, read: live.length - pending.length, pending: pending.length, complete_after: latestPending };
}

/** POST /api/zoho?action=fill-items — the owner's "Fill now": spend the rest of today's budget, keep 200 calls. */
async function handleFillNow(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const orgs = await selectRows('zoho_organizations', `select=*&user_id=eq.${user.id}&status=eq.active&order=connected_at.desc&limit=1`);
  const org = orgs[0];
  if (!org) { res.status(404).json({ status: 'error', message: 'Zoho Books not connected' }); return; }
  const session = createSession(org);
  const startedAt = Date.now();
  const usedBefore = await callsUsedToday(org.id, startedAt);
  try {
    const out = await syncItemLines(session, org, user.id, { usedBefore, deadline: startedAt + TIME_LIMIT_MS });
    await addCallsToday(org.id, session.callCount(), startedAt);
    const state = await selectRows('zoho_line_state', `select=doc_type,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${org.id}&order=id.asc&limit=200000`).catch(() => []);
    res.status(out.error ? 502 : 200).json(Object.assign({ status: out.error ? 'error' : 'ok', api_calls_used: session.callCount() }, out, { progress: progressFrom(state) }));
  } catch (err) {
    await addCallsToday(org.id, session.callCount(), startedAt);
    if (err instanceof ZohoAuthError) { res.status(401).json({ status: 'error', message: 'Zoho Books connection needs to be re-authorized' }); return; }
    res.status(500).json({ status: 'error', message: 'Fill failed unexpectedly' });
  }
}

/* ------------------------------------------------------- follow-on fill
 * One function run reads about 370 documents (240 s at ~90 calls a minute: Zoho's per-minute limit, the same on
 * every plan). A paid plan's day holds far more (Professional 5,000, Premium 10,000), and Vercel Hobby runs each
 * cron once a day. So after the first sync at connect, after the nightly 2:30 am run, and after each of its own
 * runs while documents and allowance are left, the fill calls itself again (GET /api/zoho?action=fill-chain,
 * CRON_SECRET), at most CHAIN_MAX_HOPS times a night. The caller waits only for the request to be accepted. If a
 * hop is ever lost, nothing breaks: the next night's run carries on. Every hop keeps the 200-call reserve.
 */
const CHAIN_MAX_HOPS = 48;           // 48 × ~370 ≈ 17,000 documents, more than Premium's 10,000 a day
const CHAIN_HANDOFF_MS = 4000;       // how long a caller waits for the next hop to be accepted

function chainOrigin() {
  try { if (process.env.ZOHO_REDIRECT_URI) return new URL(process.env.ZOHO_REDIRECT_URI).origin; } catch (e) { /* fall through */ }
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? 'https://' + prod.replace(/^https?:\/\//, '') : null;
}

/** Start the next hop. Returns true when a request went out. orgRef limits the hop to one connection. */
async function triggerFillChain(hop, orgRef) {
  const origin = chainOrigin();
  const secret = process.env.CRON_SECRET;
  const n = Math.max(1, parseInt(hop, 10) || 1);
  if (!origin || !secret || n > CHAIN_MAX_HOPS) return false;
  const url = `${origin}/api/zoho?action=fill-chain&hop=${n}` + (orgRef ? `&org=${encodeURIComponent(orgRef)}` : '');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), CHAIN_HANDOFF_MS) : null;
  try {
    await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${secret}` }, signal: ctrl ? ctrl.signal : undefined });
  } catch (e) { /* aborted on purpose once handed off; the hop runs on its own */ }
  finally { if (timer) clearTimeout(timer); }
  return true;
}

/** Connections worth another hop: documents still to read and allowance above the reserve. DB only, no Zoho calls. */
async function orgsToFill(orgRef, nowMs) {
  const filter = orgRef ? `&id=eq.${encodeURIComponent(orgRef)}` : '';
  const orgs = await selectRows('zoho_organizations', `select=*&status=eq.active${filter}&order=connected_at.desc&limit=500`);
  const out = [];
  for (const org of orgs) {
    let state;
    try { state = await selectRows('zoho_line_state', `select=doc_type,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${org.id}&order=id.asc&limit=200000`); }
    catch (e) { continue; }
    const p = progressFrom(state);
    if (!(p.pending > 0)) continue;
    const cap = await dailyCap(org);
    if (cap - (await callsUsedToday(org.id, nowMs)) - RESERVE_CALLS <= 0) continue;
    out.push(org);
  }
  return out;
}

/** GET /api/zoho?action=fill-chain&hop=N[&org=<org_ref>] — one follow-on fill run (CRON_SECRET). */
async function handleFillChain(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const q = req.query || {};
  if (!expected) { res.status(500).json({ error: 'CRON_SECRET not configured' }); return; }
  if (auth !== `Bearer ${expected}` && q.cron_secret !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const hop = Math.max(1, parseInt(q.hop, 10) || 1);
  const orgRef = q.org ? String(q.org) : null;
  const startedAt = Date.now();
  const deadline = startedAt + TIME_LIMIT_MS;
  const ran = [];
  let again = false;
  let orgs = [];
  try { orgs = await orgsToFill(orgRef, startedAt); } catch (e) { res.status(500).json({ error: 'Could not list connections' }); return; }
  for (const org of orgs) {
    if (Date.now() >= deadline - 10 * 1000) { again = true; break; }
    const session = createSession(org);
    const usedBefore = await callsUsedToday(org.id, Date.now());
    let out;
    try { out = await syncItemLines(session, org, org.user_id, { usedBefore, deadline }); }
    catch (e) { out = { error: e instanceof ZohoAuthError ? 'needs_reauth' : 'failed' }; }
    await addCallsToday(org.id, session.callCount(), startedAt);
    ran.push({ org_ref: org.id, documents_read: out.documents_read || 0, pending: out.pending, stopped: out.stopped || null, error: out.error || null });
    // Only time ran out (documents and allowance left, Zoho not pushing back): worth another hop.
    if (!out.error && out.stopped === 'time' && out.pending > 0) again = true;
  }
  const next = again && hop < CHAIN_MAX_HOPS ? await triggerFillChain(hop + 1, orgRef) : false;
  res.status(200).json({ hop, orgs: ran, next_hop: next ? hop + 1 : null, duration_ms: Date.now() - startedAt });
}

module.exports = {
  handleFillChain, triggerFillChain, fillEta, dailyCap, CHAIN_MAX_HOPS,
  syncItemLines, handleFillNow, probeItemReports, documentLines, mapItem, queueOrder, needsRead, progressFrom, callsUsedToday, addCallsToday,
  RESERVE_CALLS, TIME_LIMIT_MS, READERS
};
