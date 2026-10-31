/**
 * _lib/selfCleanup.js
 * Margyn tidies up after itself (2026-11-01), so nobody has to run SQL to clear what the app left behind.
 *
 * What it removes, and only this:
 *  1. Superseded Zoho Books copies. Each reconnect to the same Zoho organisation made a new zoho_organizations row
 *     and a new full copy of invoices, bills, payments, postings and item lines; the old row was marked disconnected
 *     but kept its copy (MARGYN DEMO had three). A DISCONNECTED row whose Zoho organisation is connected again on a
 *     NEWER row for the same user has its synced rows deleted. The row itself stays, as the record of the connection.
 *  2. Superseded Odoo copies: a disconnected Odoo credential whose same Odoo database is connected again on a newer
 *     credential for the same user (odoo_invoices, odoo_bills, odoo_cash_balances of the old one).
 *  3. Proposals still waiting on a superseded connection: marked expired (never deleted, so the history stays).
 *  4. Resolved Margyn Watch findings not seen for over 400 days, only of kinds that may be sent again within a year
 *     (once-only kinds are kept forever: their row is what stops a repeat).
 *
 * Never: anything on an account with an active Tally install; the active (or needs-reconnect) connection's rows;
 * a disconnected connection with no newer one (the owner chose at disconnect whether to keep it); snapshots (the
 * account's history of readings; which of those "conflict" is a judgement, not a tidy-up).
 * What was removed goes to connector_logs as counts only.
 *
 * Runs on reconnect (_zoho/select-org.js, after the new copy is in), in the nightly Zoho run (_zoho/cron.js), and
 * from disconnect when the owner chooses to remove the data (_zoho/disconnect.js → removeZohoData).
 * CommonJS, zero-npm.
 */

const { selectRows, updateRows, restRequest, logConnectorEvent } = require('./supabaseRest');

// Child tables first: item lines and postings point at documents and accounts.
const ZOHO_TABLES = ['zoho_document_lines', 'zoho_line_state', 'zoho_items', 'zoho_gstr2b_reconciliation', 'zoho_journal_entries',
  'zoho_customer_payments', 'zoho_vendor_payments', 'zoho_invoices', 'zoho_bills', 'zoho_bank_accounts', 'zoho_chart_of_accounts', 'zoho_sync_state'];
const ODOO_TABLES = ['odoo_invoices', 'odoo_bills', 'odoo_cash_balances'];
const LIVE = new Set(['active', 'needs_reauth', 'pending_org_selection']);
const PENDING_ORG = '__pending__';
const SIGNAL_KEEP_DAYS = 400;
const ONCE_ONLY_DAYS = 3650;   // margynWatch COOLDOWN_DAYS: these kinds are sent once, ever

/** DELETE and say how many rows went (PostgREST Content-Range with count=exact). A missing table counts 0. */
async function deleteCount(table, filter) {
  const res = await restRequest(`${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal,count=exact' } });
  if (res.status === 404 || res.status === 400) return 0;   // table or column not there on this database
  if (!res.ok) throw new Error(`Delete on ${table} failed: ${res.status}`);
  const range = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
  const n = range ? parseInt(String(range).split('/')[1], 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Account ids that keep Tally: everything here stays away from them. */
async function hasTally(userId) {
  const rows = await selectRows('tally_installs', `select=id&user_id=eq.${userId}&status=eq.active&limit=1`);
  return rows.length > 0;
}

/**
 * Pure: which of a user's zoho_organizations rows are superseded copies. A row qualifies when it is disconnected,
 * names a real Zoho organisation, and a newer row for that organisation is live. Never the newest live row.
 */
function supersededZohoOrgs(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.status !== 'disconnected' || !r.organization_id || r.organization_id === PENDING_ORG) continue;
    const newer = rows.find((n) => n !== r && n.id !== r.id && n.organization_id === r.organization_id && LIVE.has(n.status) &&
      Date.parse(n.connected_at || 0) >= Date.parse(r.connected_at || 0));
    if (newer) out.push(r);
  }
  return out;
}

/** Pure: disconnected Odoo credentials superseded by a newer live one for the same database. */
function supersededOdooCreds(rows) {
  const same = (a, b) => String(a.odoo_base_url || '').replace(/\/+$/, '').toLowerCase() === String(b.odoo_base_url || '').replace(/\/+$/, '').toLowerCase()
    && String(a.odoo_db || '') === String(b.odoo_db || '');
  return (rows || []).filter((r) => r && r.disconnected_at && rows.some((n) => n !== r && n.id !== r.id && !n.disconnected_at && same(n, r)
    && Date.parse(n.created_at || 0) >= Date.parse(r.created_at || 0)));
}

/** Delete one Zoho connection's synced rows. → { table: count }. Refuses a live connection. */
async function removeZohoData(org) {
  if (!org || !org.id) throw new Error('no connection given');
  if (LIVE.has(org.status)) throw new Error('refusing to remove the data of a connection that is still live');
  const o = encodeURIComponent(org.id);
  const counts = {};
  for (const t of ZOHO_TABLES) {
    if (t === 'zoho_journal_entries') {
      // One account at a time: a year of postings in one DELETE can outlast the database's statement limit.
      const accts = await selectRows('zoho_chart_of_accounts', `select=id&org_ref=eq.${o}&limit=5000`).catch(() => []);
      let n = 0;
      for (const a of accts) n += await deleteCount(t, `org_ref=eq.${o}&account_ref=eq.${encodeURIComponent(a.id)}`);
      n += await deleteCount(t, `org_ref=eq.${o}`);   // anything left (postings of accounts no longer listed)
      counts[t] = n;
      continue;
    }
    counts[t] = await deleteCount(t, `org_ref=eq.${o}`);
  }
  // Stamped so the sweep doesn't look at it again (2026-11-01-zoho-parity.sql adds the column; without it, harmless).
  await updateRows('zoho_organizations', `id=eq.${o}`, { data_removed_at: new Date().toISOString() }).catch(() => {});
  return counts;
}

async function removeOdooData(cred) {
  if (!cred || !cred.id || !cred.disconnected_at) throw new Error('refusing to remove the data of a live Odoo connection');
  const counts = {};
  for (const t of ODOO_TABLES) counts[t] = await deleteCount(t, `cred_id=eq.${encodeURIComponent(cred.id)}`);
  return counts;
}

const total = (c) => Object.values(c || {}).reduce((t, n) => t + (Number(n) || 0), 0);

/**
 * One account's tidy-up. opts.dryRun: say what would go, delete nothing. → { skipped? } | { zoho, odoo, proposals, signals }
 */
async function cleanupAccount(userId, opts) {
  const o = opts || {};
  if (await hasTally(userId)) return { user: userId, skipped: 'tally_account' };
  const out = { user: userId, zoho: [], odoo: [], proposals_expired: 0, signals_removed: 0 };

  const orgs = await selectRows('zoho_organizations', `select=id,user_id,organization_id,status,connected_at,data_removed_at&user_id=eq.${userId}&order=connected_at.asc&limit=50`).catch(() => []);
  const staleOrgs = supersededZohoOrgs(orgs).filter((r) => !r.data_removed_at);
  for (const r of staleOrgs) {
    const counts = o.dryRun ? null : await removeZohoData(r);
    out.zoho.push({ org_ref: r.id, removed: counts ? total(counts) : null });
    if (counts && total(counts)) await logConnectorEvent({ userId, connectorType: 'zoho_books', operation: 'cleanup_superseded', status: 'success', recordsSynced: total(counts),
      errorMessage: 'removed the copy of an older connection to the same Zoho organisation: ' + Object.entries(counts).filter(([, n]) => n).map(([t, n]) => t.replace(/^zoho_/, '') + ' ' + n).join(', ') });
  }

  const creds = await selectRows('connector_credentials', `select=id,odoo_base_url,odoo_db,created_at,disconnected_at&user_id=eq.${userId}&connector_type=eq.odoo&order=created_at.asc&limit=50`).catch(() => []);
  for (const c of supersededOdooCreds(creds)) {
    const left = await selectRows('odoo_invoices', `select=id&cred_id=eq.${encodeURIComponent(c.id)}&limit=1`).catch(() => []);
    const leftB = left.length ? left : await selectRows('odoo_bills', `select=id&cred_id=eq.${encodeURIComponent(c.id)}&limit=1`).catch(() => []);
    if (!leftB.length) continue;   // already tidied
    const counts = o.dryRun ? null : await removeOdooData(c);
    out.odoo.push({ cred_id: c.id, removed: counts ? total(counts) : null });
    if (counts) await logConnectorEvent({ userId, connectorType: 'odoo', operation: 'cleanup_superseded', status: 'success', recordsSynced: total(counts),
      errorMessage: 'removed the copy of an older connection to the same Odoo database' });
  }

  // Proposals still waiting on a connection that has been replaced: expired, as reconcile.js does for a gone Tally.
  const goneRefs = staleOrgs.map((r) => r.id).concat(orgs.filter((r) => r.status === 'disconnected' && r.data_removed_at).map((r) => r.id));
  if (goneRefs.length && !o.dryRun) {
    try {
      const hit = await updateRows('agent_actions', `user_id=eq.${userId}&status=eq.proposed&org_ref=in.(${goneRefs.map(encodeURIComponent).join(',')})`, { status: 'expired' });
      out.proposals_expired = Array.isArray(hit) ? hit.length : 0;
    } catch (e) { /* no org_ref column yet: nothing to expire */ }
  }

  // Resolved findings long gone, of kinds that could be sent again within a year anyway.
  const repeatable = Object.entries(require('./margynWatch').COOLDOWN_DAYS || {}).filter(([, d]) => d < ONCE_ONLY_DAYS).map(([k]) => k);
  if (repeatable.length) {
    const cutoff = new Date(Date.now() - SIGNAL_KEEP_DAYS * 86400000).toISOString();
    const filter = `user_id=eq.${userId}&status=eq.resolved&kind=in.(${repeatable.join(',')})&last_seen=lt.${encodeURIComponent(cutoff)}`;
    if (o.dryRun) out.signals_removed = (await selectRows('margyn_signals', `select=key&${filter}&limit=1000`).catch(() => [])).length;
    else { try { out.signals_removed = await deleteCount('margyn_signals', filter); } catch (e) { out.signals_removed = 0; } }
  }

  const removedSomething = out.zoho.length || out.odoo.length || out.proposals_expired || out.signals_removed;
  if (removedSomething && !o.dryRun && (out.proposals_expired || out.signals_removed)) {
    await logConnectorEvent({ userId, connectorType: 'margyn', operation: 'cleanup', status: 'success',
      recordsSynced: out.proposals_expired + out.signals_removed,
      errorMessage: `expired ${out.proposals_expired} waiting proposal(s) of a replaced connection; removed ${out.signals_removed} old resolved finding(s)` });
  }
  return out;
}

/** Every account with a Zoho Books or Odoo connection, one after another, inside `deadline` (ms). */
async function cleanupAll(opts) {
  const o = opts || {};
  const deadline = o.deadline || Date.now() + 30000;
  const [z, od] = await Promise.all([
    selectRows('zoho_organizations', 'select=user_id&limit=2000').catch(() => []),
    selectRows('connector_credentials', 'select=user_id&connector_type=eq.odoo&limit=2000').catch(() => [])
  ]);
  const users = [...new Set(z.concat(od).map((r) => r.user_id).filter(Boolean))];
  const results = [];
  for (const u of users) {
    if (Date.now() > deadline) { results.push({ user: u, skipped: 'out_of_time' }); continue; }
    try { results.push(await cleanupAccount(u, o)); }
    catch (e) { results.push({ user: u, error: String(e.message || e).slice(0, 160) }); }
  }
  return { accounts: users.length, cleaned: results.filter((r) => (r.zoho && r.zoho.length) || (r.odoo && r.odoo.length) || r.proposals_expired || r.signals_removed).length, results };
}

module.exports = { cleanupAccount, cleanupAll, removeZohoData, removeOdooData, supersededZohoOrgs, supersededOdooCreds, deleteCount, ZOHO_TABLES, ODOO_TABLES };
