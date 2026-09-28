/**
 * api/_lib/moneyModel.js
 * The reconciled receivables / payables position, computed once on the
 * server. Added 2026-09-29.
 *
 * Until now the reconciled model lived only in the browser
 * (mgMoneyRows / mgMoneyGroups in app/js/19-pages.js), fed by capped
 * slices: Zoho 250 open invoices, Tally 100 of 500 bills, Odoo 100.
 * Chat, WhatsApp and the CFO pack each had their own version. This module
 * is the one version everything will read (GET /api/reconcile?action=position).
 *
 * Rules (unchanged from the browser, see the parity test):
 *   - One row per counterparty, keyed by normalised name.
 *   - The party's amount comes from its most trusted source,
 *     Zoho > Tally > Odoo > manual. Other sources are compared, never added.
 *   - Sources agree when max - min <= max(Rs 1, 2% of max).
 *   - Per-source totals are reported side by side, never summed together.
 *
 * Two deliberate differences from the browser:
 *   - Every open row is read (paged), not a capped slice. If a source still
 *     has more than MAX_ROWS, coverage.<src>.truncated says so.
 *   - A connector row with a zero balance is dropped. The Tally list used to
 *     include settled bills (closing balance 0), which could mark a party
 *     "conflict" against a source that still showed it open.
 *
 * Pure functions first (tested without a network), loaders at the bottom.
 */

const { selectRows, selectAllRows, rpc } = require('./supabaseRest');

const SRC_ORDER = ['zoho', 'tally', 'odoo', 'manual'];
const SRC_NAME = { zoho: 'Zoho Books', tally: 'Tally', odoo: 'Odoo', manual: 'Manual entries' };
const BUCKETS = [['b0', 'Current and 0–30 days'], ['b1', '31–60 days'], ['b2', '61–90 days'], ['b3', '90+ days']];
const MAX_ROWS = 20000;

/* ---------- pure ---------- */

// Same as normPartyName() in app/js/07-ledger.js.
function normPartyName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Today's date in India, 'YYYY-MM-DD'. */
function todayIST(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

/** Whole days from `today` to a due date (negative = overdue), or null. */
function daysBetween(today, due) {
  if (!due) return null;
  const d = Date.parse(String(due).slice(0, 10));
  if (Number.isNaN(d)) return null;
  return Math.round((d - Date.parse(today)) / 86400000);
}

function bucketOf(days) {
  if (days === null || days >= 0) return 'b0';
  const od = -days;
  return od <= 30 ? 'b0' : od <= 60 ? 'b1' : od <= 90 ? 'b2' : 'b3';
}

/**
 * rows: [{ party, amount, due, ref, src }] in source order.
 * Returns groups shaped like mgMoneyGroups(), sorted by amount, largest first.
 */
function groupRows(rows, today) {
  const map = new Map();
  for (const r0 of rows) {
    const r = { ...r0, days: daysBetween(today, r0.due) };
    r.key = normPartyName(r.party) || ('~' + String(r.party).toLowerCase());
    if (!map.has(r.key)) map.set(r.key, { key: r.key, party: r.party, by: {} });
    const g = map.get(r.key);
    if (!g.by[r.src]) g.by[r.src] = { amount: 0, rows: [] };
    g.by[r.src].amount += r.amount;
    g.by[r.src].rows.push(r);
  }
  return [...map.values()].map((g) => {
    const srcs = SRC_ORDER.filter((s) => g.by[s]);
    const primary = srcs[0];
    const amts = srcs.map((s) => g.by[s].amount);
    const max = Math.max(...amts), min = Math.min(...amts);
    const multi = srcs.length >= 2;
    const status = !multi ? 'single' : ((max - min) <= Math.max(1, max * 0.02) ? 'agree' : 'conflict');
    const prow = g.by[primary].rows;
    const dues = prow.map((r) => r.days).filter((d) => d !== null);
    return {
      key: g.key, party: g.party, by: g.by, sources: srcs, primary, status,
      amount: g.by[primary].amount,
      diff: multi ? max - min : 0,
      oldestDays: dues.length ? Math.min(...dues) : null,
      invoices: prow.length,
      overdue: prow.filter((r) => r.days !== null && r.days < 0).reduce((s, r) => s + r.amount, 0),
      due7: prow.filter((r) => r.days !== null && r.days <= 7).reduce((s, r) => s + r.amount, 0)
    };
  }).sort((a, b) => b.amount - a.amount);
}

/** Totals, ageing and per-source figures for one direction. */
function summarise(rows, groups) {
  const ageing = { b0: 0, b1: 0, b2: 0, b3: 0 };
  for (const g of groups) for (const r of g.by[g.primary].rows) ageing[bucketOf(r.days)] += r.amount;
  const bySource = {};
  for (const r of rows) {
    if (!bySource[r.src]) bySource[r.src] = { name: SRC_NAME[r.src], total: 0, open_items: 0 };
    bySource[r.src].total += r.amount;
    bySource[r.src].open_items++;
  }
  return {
    parties: groups.length,
    total: groups.reduce((t, g) => t + g.amount, 0),
    overdue: groups.reduce((t, g) => t + g.overdue, 0),
    due_7d: groups.reduce((t, g) => t + g.due7, 0),
    agree: groups.filter((g) => g.status === 'agree').length,
    conflict: groups.filter((g) => g.status === 'conflict').length,
    single_source: groups.filter((g) => g.status === 'single').length,
    ageing,
    by_source: bySource   // side by side; never add these together
  };
}

/** One direction's full position. `withRows` = include invoice-level rows. */
function position(rows, today, { withRows = true } = {}) {
  const groups = groupRows(rows, today);
  const out = groups.map((g) => {
    const by = {};
    for (const s of g.sources) {
      by[s] = { amount: g.by[s].amount };
      if (withRows) {
        by[s].rows = g.by[s].rows.map((r) => {
          const o = { party: r.party, ref: r.ref || null, amount: r.amount, due: r.due || null, days: r.days };
          if (r.id != null) o.id = r.id;   // manual rows: lets the app act on the entry
          return o;
        });
      }
    }
    return {
      key: g.key, party: g.party, amount: g.amount, primary: g.primary, sources: g.sources,
      status: g.status, diff: g.diff, oldest_days: g.oldestDays, open_items: g.invoices,
      overdue: g.overdue, due_7d: g.due7, by
    };
  });
  return { totals: summarise(rows, groups), groups: out };
}

/* ---------- loaders (network) ---------- */

const num = (n) => Number(n) || 0;

async function loadManual(accountId, dir) {
  const table = dir === 'recv' ? 'receivables' : 'payables';
  const { rows, truncated } = await selectAllRows(table,
    `select=id,party_name,amount,due_date&user_id=eq.${accountId}&status=eq.open&order=due_date.asc.nullslast,id.asc`,
    { max: MAX_ROWS });
  return {
    rows: rows.map((r) => ({ id: r.id, party: r.party_name || 'Unnamed', amount: num(r.amount), due: r.due_date || null, ref: null, src: 'manual' })),
    truncated
  };
}

/** The Zoho org the app shows: the one zoho_vitals picks with no org_ref. */
async function zohoOrgRef(accountId) {
  const v = await rpc('zoho_vitals', { p_user_id: accountId, p_org_ref: null });
  const o = Array.isArray(v) ? v[0] : v;
  return o && o.connected === true && o.org_ref ? o.org_ref : null;
}

async function loadZoho(orgRef, dir) {
  if (!orgRef) return { rows: [], truncated: false };
  const q = dir === 'recv'
    ? ['zoho_invoices', 'invoice_number', 'customer_name', 'invoice_id']
    : ['zoho_bills', 'bill_number', 'vendor_name', 'bill_id'];
  const { rows, truncated } = await selectAllRows(q[0],
    `select=${q[1]},${q[2]},balance,due_date&org_ref=eq.${orgRef}&balance=gt.0&order=due_date.asc.nullslast,${q[3]}.asc`,
    { max: MAX_ROWS });
  return {
    rows: rows.map((r) => ({ party: r[q[2]] || (dir === 'recv' ? 'Unnamed customer' : 'Unnamed vendor'), amount: num(r.balance), due: r.due_date || null, ref: r[q[1]] || null, src: 'zoho' })),
    truncated
  };
}

async function loadTally(accountId, dir) {
  const installs = await selectRows('tally_installs', `select=id&user_id=eq.${accountId}&status=eq.active`);
  if (!installs.length) return { rows: [], truncated: false };
  const { rows, truncated } = await selectAllRows('tally_bills',
    `select=party_name,bill_ref,due_date,closing_balance&user_id=eq.${accountId}&install_id=in.(${installs.map((i) => i.id).join(',')})&direction=eq.${dir === 'recv' ? 'receivable' : 'payable'}&order=overdue_days.desc.nullslast,id.asc`,
    { max: MAX_ROWS });
  return {
    rows: rows.map((b) => ({ party: b.party_name || 'Unknown', amount: Math.abs(num(b.closing_balance)), due: b.due_date || null, ref: b.bill_ref || null, src: 'tally' }))
      .filter((r) => r.amount > 0),
    truncated
  };
}

async function loadOdoo(accountId, dir) {
  const creds = await selectRows('connector_credentials',
    `select=id&user_id=eq.${accountId}&connector_type=eq.odoo&disconnected_at=is.null&order=created_at.desc&limit=1`);
  if (!creds.length) return { rows: [], truncated: false };
  const q = dir === 'recv'
    ? ['odoo_invoices', 'invoice_number', 'customer_name']
    : ['odoo_bills', 'bill_number', 'vendor_name'];
  const { rows, truncated } = await selectAllRows(q[0],
    `select=${q[1]},${q[2]},balance,due_date&user_id=eq.${accountId}&cred_id=eq.${creds[0].id}&order=due_date.asc.nullslast,id.asc`,
    { max: MAX_ROWS });
  return {
    rows: rows.map((r) => ({ party: r[q[2]] || 'Unknown', amount: Math.round(Math.abs(num(r.balance)) * 100) / 100, due: r.due_date || null, ref: r[q[1]] || null, src: 'odoo' }))
      .filter((r) => r.amount > 0.5),
    truncated
  };
}

/**
 * Every open row for one account and direction, from every source, in the
 * browser's source order. A source that fails to load is reported in
 * `errors` and left out, never guessed at.
 */
async function loadRows(accountId, dir, ctx = {}) {
  const orgRef = ctx.zohoOrgRef !== undefined ? ctx.zohoOrgRef : await zohoOrgRef(accountId).catch(() => null);
  const loaders = {
    manual: () => loadManual(accountId, dir),
    zoho: () => loadZoho(orgRef, dir),
    tally: () => loadTally(accountId, dir),
    odoo: () => loadOdoo(accountId, dir)
  };
  const names = ['manual', 'zoho', 'tally', 'odoo'];   // row order the browser used
  const results = await Promise.allSettled(names.map((n) => loaders[n]()));
  const rows = [], coverage = {}, errors = {};
  results.forEach((r, i) => {
    const n = names[i];
    if (r.status === 'fulfilled') {
      rows.push(...r.value.rows);
      coverage[n] = { rows: r.value.rows.length, truncated: r.value.truncated, cap: MAX_ROWS };
    } else {
      errors[n] = String((r.reason && r.reason.message) || r.reason).slice(0, 200);
    }
  });
  return { rows, coverage, errors };
}

/**
 * The account's reconciled position. `dirs` limits it to what the caller may
 * see (see actor.js); a direction left out is simply not returned.
 */
async function positionForAccount(accountId, { dirs = ['recv', 'pay'], withRows = true, now = new Date() } = {}) {
  const today = todayIST(now);
  const zohoOrg = await zohoOrgRef(accountId).catch(() => null);
  const out = { as_of: today, rules: 'Zoho > Tally > Odoo > manual; agree within 2% or Rs 1; source totals never added' };
  await Promise.all(dirs.map(async (dir) => {
    const { rows, coverage, errors } = await loadRows(accountId, dir, { zohoOrgRef: zohoOrg });
    out[dir === 'recv' ? 'receivables' : 'payables'] = { ...position(rows, today, { withRows }), coverage, errors };
  }));
  return out;
}

module.exports = {
  SRC_ORDER, SRC_NAME, BUCKETS, MAX_ROWS,
  normPartyName, todayIST, daysBetween, bucketOf, groupRows, summarise, position,
  loadRows, positionForAccount
};
