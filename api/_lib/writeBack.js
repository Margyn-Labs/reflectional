/**
 * Write-back: what an approval in Margyn should change in the customer's own
 * apps, and the queue that carries it there, connector by connector.
 *
 * Every approval (app, chat, voice, WhatsApp) plans its writes here and queues
 * them in public.app_writes (2026-10-05-margyn-os.sql). The runner then sends
 * each one to its app's writer.
 *
 * Today every connector is read-only, so no writer can send: a queued write
 * becomes 'waiting_access' and the app says so plainly ("saved in Margyn;
 * Zoho write-back isn't switched on yet"). Switching a connector on later is
 * two steps, nothing else changes:
 *   1. give its WRITERS entry an execute(write, ctx) that calls the app and
 *      returns { externalRef }, and
 *   2. record the customer's grant in public.app_write_access (enabled=true,
 *      after they reconnect with write permission).
 * The next sync confirms a write when it sees the change in the app
 * (confirmWrites below), and only then is it 'confirmed'.
 *
 * Statuses: queued -> writing -> confirmed | failed;  queued -> waiting_access
 * (re-queued automatically once that app's writer and the grant are on).
 */

const APPS = ['zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify'];

/* What each app will be able to write, in words the owner reads on the Apps page. */
const WRITERS = {
  zoho: { label: 'Zoho Books', actions: {
    record_payment: 'Record a customer payment against its invoice',
    post_journal: 'Post an approved journal entry',
    create_invoice: 'Create an invoice from a forwarded document',
    create_bill: 'Create a bill from a forwarded document'
  }, execute: null },
  tally: { label: 'Tally', actions: {
    record_payment: 'Post a receipt voucher against the bill',
    post_journal: 'Post an approved journal voucher',
    create_invoice: 'Post a sales voucher from a forwarded document',
    create_bill: 'Post a purchase voucher from a forwarded document'
  }, execute: null },
  odoo: { label: 'Odoo', actions: {
    record_payment: 'Register a payment on the invoice',
    post_journal: 'Post an approved journal entry',
    create_invoice: 'Create a customer invoice',
    create_bill: 'Create a vendor bill'
  }, execute: null },
  razorpay: { label: 'Razorpay', actions: {
    payment_link: 'Send a payment link for an overdue invoice'
  }, execute: null },
  cashfree: { label: 'Cashfree', actions: {
    payment_link: 'Send a payment link for an overdue invoice'
  }, execute: null },
  shopify: { label: 'Shopify', actions: {}, execute: null }
};

const NOT_YET = (app) => `Margyn can’t write to ${WRITERS[app] ? WRITERS[app].label : app} yet. It’s saved in Margyn; write-back is being switched on app by app.`;
const NO_GRANT = (app) => `${WRITERS[app] ? WRITERS[app].label : app} is connected read-only. Reconnect it with write permission to let Margyn write approved changes.`;

/** Can Margyn write this action to this app for this account right now? */
function writeAccess(app, action, grants) {
  const w = WRITERS[app];
  if (!w || !w.actions[action]) return { on: false, reason: `${w ? w.label : app} has nothing Margyn writes for this.` };
  if (typeof w.execute !== 'function') return { on: false, reason: NOT_YET(app) };
  const g = (grants || []).find((x) => x.app === app && x.enabled);
  if (!g) return { on: false, reason: NO_GRANT(app) };
  return { on: true, reason: null };
}

/** The Apps page matrix: per app, what it can write and whether it is on. */
function capabilities(grants, connected) {
  return APPS.map((app) => {
    const w = WRITERS[app];
    const acts = Object.keys(w.actions).map((k) => ({ action: k, label: w.actions[k], ...writeAccess(app, k, grants) }));
    return { app, label: w.label, connected: !!(connected || []).includes(app), writes: acts, any_on: acts.some((a) => a.on) };
  });
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n) => '₹' + money(n).toLocaleString('en-IN');

/**
 * Pure — no I/O. The writes an approval should make.
 * source: 'agent_action' | 'recon_match' | 'suggestion'
 * books:  the account's connected books apps, best first (['zoho', 'tally', ...])
 */
function planWrites(source, item, books) {
  const out = [];
  const firstBooks = (books || []).find((b) => ['zoho', 'tally', 'odoo'].includes(b)) || null;
  if (!item) return out;

  if (source === 'agent_action') {
    const p = item.proposal || {};
    const app = item.org_ref ? 'zoho' : (p.source === 'tally' || p.books === 'tally') ? 'tally' : firstBooks;
    if (!app) return out;
    const kind = item.kind;
    if (kind === 'reconcile_match' || kind === 'split') {
      const allocs = (p.allocations || []).filter((a) => a && (a.invoiceRef || a.booksRef));
      if (allocs.length) {
        allocs.forEach((a) => out.push({ app, action: 'record_payment', ref: String(a.invoiceRef || a.booksRef),
          summary: `Record ${inr(a.amount)} against ${a.invoiceRef || a.booksRef}`, payload: { invoiceRef: a.invoiceRef || null, booksRef: a.booksRef || null, amount: money(a.amount), paymentRef: a.paymentRef || (p.match && p.match.paymentRef) || null } }));
      } else if (p.match && (p.match.invoiceRef || p.match.booksRef)) {
        const ref = p.match.invoiceRef || p.match.booksRef;
        out.push({ app, action: 'record_payment', ref: String(ref), summary: `Record ${inr(item.amount)} against ${ref}`,
          payload: { invoiceRef: p.match.invoiceRef || null, booksRef: p.match.booksRef || null, amount: money(item.amount), paymentRef: p.match.paymentRef || null } });
      }
    } else if (kind === 'journal' || kind === 'bad_debt') {
      const lines = (p.journal || []).filter((l) => l && l.account);
      if (lines.length) out.push({ app, action: 'post_journal', ref: String(item.id), summary: item.title || 'Post the approved journal entry', payload: { lines, narration: item.title || null } });
    }
    // itc_risk (hold a payment), flag, needs_human: decided in Margyn, nothing to write to an app.
    return out;
  }

  if (source === 'recon_match') {
    if (!item.invoice_ref) return out;
    out.push({ app: 'zoho', action: 'record_payment', ref: String(item.invoice_ref), summary: `Record ${inr(item.matched_amount)} against ${item.invoice_number || item.invoice_ref}`,
      payload: { invoiceRef: item.invoice_ref, amount: money(item.matched_amount), paymentRef: item.razorpay_payment_id || null } });
    return out;
  }

  if (source === 'suggestion') {
    if (!firstBooks) return out;
    (item.entries || []).forEach((e, n) => {
      if (!e || !(Number(e.amount) > 0)) return;
      const i = e._i != null ? e._i : n;   // the entry's place in the original proposal
      if (e.target === 'receivable') out.push({ app: firstBooks, action: 'create_invoice', ref: `${item.id}:${i}`, summary: `Invoice to ${e.party || 'a customer'} for ${inr(e.amount)}`,
        payload: { party: e.party || null, amount: money(e.amount), due_date: e.due_date || null, party_details: e.party_details || null } });
      if (e.target === 'payable') out.push({ app: firstBooks, action: 'create_bill', ref: `${item.id}:${i}`, summary: `Bill from ${e.party || 'a supplier'} for ${inr(e.amount)}`,
        payload: { party: e.party || null, amount: money(e.amount), due_date: e.due_date || null, party_details: e.party_details || null } });
    });
    return out;
  }
  return out;
}

/**
 * Queue an approval's writes and try to send them. db = { select, insert, update } (supabaseRest-shaped).
 * Never throws: an approval must not fail because write-back is unavailable (the table may not exist yet).
 */
async function enqueueWrites(db, { accountId, source, sourceId, writes, approvedBy, approvedByName }) {
  if (!writes || !writes.length) return { queued: 0, writes: [] };
  const now = new Date().toISOString();
  const rows = writes.map((w) => ({
    user_id: accountId, app: w.app, action: w.action, source_type: source, source_id: String(sourceId), ref: w.ref || '',
    summary: w.summary || null, payload: w.payload || {}, status: 'queued', approved_by: approvedBy || null, approved_by_name: approvedByName || null,
    created_at: now, updated_at: now
  }));
  try {
    const saved = await db.insert('app_writes', rows, { onConflict: 'user_id,app,action,source_type,source_id,ref' });
    const run = await runWrites(db, accountId, { ids: (saved || []).map((r) => r.id) });
    return { queued: rows.length, writes: run.writes };
  } catch (e) {
    return { queued: 0, writes: [], off: true, note: /app_writes|42P01|PGRST205|does not exist|schema cache/i.test(String(e.message)) ? 'write-back table not set up yet' : e.message };
  }
}

/** Send queued (and re-check waiting) writes. Each app's writer decides; no writer, no send. */
async function runWrites(db, accountId, { ids, writers = WRITERS } = {}) {
  const filter = ids && ids.length ? `&id=in.(${ids.join(',')})` : '&status=in.(queued,waiting_access)';
  const rows = await db.select('app_writes', `select=*&user_id=eq.${accountId}${filter}&order=created_at.asc&limit=200`);
  const grants = await db.select('app_write_access', `select=app,enabled,scopes&user_id=eq.${accountId}`).catch(() => []);
  const out = [];
  for (const w of rows || []) {
    const acc = writeAccessWith(writers, w.app, w.action, grants);
    const now = new Date().toISOString();
    if (!acc.on) {
      if (w.status !== 'waiting_access' || w.status_note !== acc.reason) await db.update('app_writes', `id=eq.${w.id}`, { status: 'waiting_access', status_note: acc.reason, updated_at: now });
      out.push({ ...w, status: 'waiting_access', status_note: acc.reason });
      continue;
    }
    try {
      await db.update('app_writes', `id=eq.${w.id}`, { status: 'writing', status_note: null, attempts: (w.attempts || 0) + 1, updated_at: now });
      const r = await writers[w.app].execute(w, { accountId, db });
      const ext = (r && r.externalRef) || null;
      await db.update('app_writes', `id=eq.${w.id}`, { status: 'writing', external_ref: ext, status_note: 'Sent. Confirmed when the next sync sees it.', updated_at: new Date().toISOString() });
      out.push({ ...w, status: 'writing', external_ref: ext });
    } catch (e) {
      await db.update('app_writes', `id=eq.${w.id}`, { status: 'failed', status_note: String(e.message || e).slice(0, 300), updated_at: new Date().toISOString() });
      out.push({ ...w, status: 'failed', status_note: String(e.message || e).slice(0, 300) });
    }
  }
  return { writes: out };
}
function writeAccessWith(writers, app, action, grants) {
  const w = writers[app];
  if (!w || !w.actions[action]) return { on: false, reason: `${w ? w.label : app} has nothing Margyn writes for this.` };
  if (typeof w.execute !== 'function') return { on: false, reason: NOT_YET(app) };
  if (!(grants || []).some((g) => g.app === app && g.enabled)) return { on: false, reason: NO_GRANT(app) };
  return { on: true, reason: null };
}

/** Called by a sync with the refs it now sees in the app: 'writing' rows with those refs become 'confirmed'. */
async function confirmWrites(db, accountId, app, seenRefs) {
  if (!seenRefs || !seenRefs.length) return 0;
  const rows = await db.select('app_writes', `select=id,ref,external_ref&user_id=eq.${accountId}&app=eq.${app}&status=eq.writing`).catch(() => []);
  const seen = new Set(seenRefs.map(String));
  let n = 0;
  for (const r of rows || []) {
    if (seen.has(String(r.external_ref)) || seen.has(String(r.ref))) {
      await db.update('app_writes', `id=eq.${r.id}`, { status: 'confirmed', status_note: null, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      n++;
    }
  }
  return n;
}

module.exports = { APPS, WRITERS, writeAccess, capabilities, planWrites, enqueueWrites, runWrites, confirmWrites };
