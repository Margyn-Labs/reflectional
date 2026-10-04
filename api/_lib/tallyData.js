/**
 * _lib/tallyData.js
 * One way to read a business's Tally books out of Supabase: the active
 * installs, every ledger, every voucher (with stock lines and narration),
 * every open bill, the ledger placements the owner (or Margyn) confirmed,
 * and the agent's last sync outcomes.
 *
 * api/tally.js?action=analytics (the Margin page), the books tools Margyn
 * answers questions with (chat, voice, WhatsApp) and Margyn Watch all read
 * through here, so a question answered on WhatsApp counts exactly the rows
 * the Margin page counts.
 *
 * A warm function instance keeps the last read per account for a few
 * minutes, keyed on the last sync time, so a conversation that asks five
 * questions in a row reads the books once. A new sync changes the key.
 *
 * CommonJS, zero-npm.
 */

const { selectRows } = require('./supabaseRest');

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 20;
const _cache = new Map();   // key -> { at, book }

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

/** The active installs for an account, newest sync first, with the chosen company. */
async function installsFor(userId, wantCompany) {
  const installs = await selectRows(
    'tally_installs',
    `select=id,company_name,last_sync_at,tally_edition,agent_version&user_id=eq.${userId}&status=eq.active&order=last_sync_at.desc.nullslast`
  );
  try {
    const D = await selectRows('tally_installs', `select=id,diagnostics&user_id=eq.${userId}&status=eq.active`);
    const byId = Object.fromEntries(D.map((d) => [d.id, d.diagnostics]));
    installs.forEach((i) => { i.diagnostics = byId[i.id] || null; });
  } catch (e) { /* diagnostics column not migrated yet */ }
  const companies = [...new Set(installs.map((i) => i.company_name).filter(Boolean))];
  const want = String(wantCompany || '').trim();
  const company = installs.length ? (want && companies.includes(want) ? want : (installs[0].company_name || null)) : null;
  const chosen = installs.filter((i) => (company ? i.company_name === company : true));
  const lastSync = chosen.map((i) => i.last_sync_at).filter(Boolean).sort().pop() || null;
  return { installs, companies, company, chosen, lastSync };
}

/**
 * Everything Margyn knows from Tally for one account.
 * @returns {{ connected:boolean, company, companies, chosen, lastSync, edition, diagnostics,
 *   ledgers, bills, vouchers, truncated, overrides, aiPlaced:Set, syncRuns }}
 */
async function loadTallyBook(userId, opts) {
  const o = opts || {};
  const inst = await installsFor(userId, o.company);
  if (!inst.installs.length) return { connected: false, companies: [] };
  const key = `${userId}|${inst.company || ''}|${inst.lastSync || ''}`;
  const hit = _cache.get(key);
  if (!o.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.book;

  const inList = `(${inst.chosen.map((i) => i.id).join(',')})`;
  const base = 'voucher_type,voucher_number,tally_guid,date,party_name,amount,is_cancelled,entries,narration';
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

  const overrides = {}, aiPlaced = new Set();
  try {
    const O = await selectRows('tally_ledger_classes', `select=ledger_name,bucket,set_by&user_id=eq.${userId}${inst.company ? '&company_name=eq.' + encodeURIComponent(inst.company) : ''}`);
    for (const x of O) { overrides[x.ledger_name] = x.bucket; if (!x.set_by) aiPlaced.add(x.ledger_name); }
  } catch (e) { /* table not created yet: no overrides */ }
  let syncRuns = [];
  try {
    syncRuns = await selectRows('tally_sync_runs', `select=kind,status,error_message,rows_received,started_at&user_id=eq.${userId}&install_id=in.${inList}&order=started_at.desc&limit=40`);
  } catch (e) { /* older deployments */ }

  const book = {
    connected: true,
    company: inst.company, companies: inst.companies, chosen: inst.chosen, lastSync: inst.lastSync,
    edition: (inst.chosen.find((i) => i.tally_edition) || {}).tally_edition || null,
    agentVersion: (inst.chosen.find((i) => i.agent_version) || {}).agent_version || null,
    diagnostics: (inst.chosen.find((i) => i.diagnostics) || {}).diagnostics || null,
    ledgers: L.rows, bills: B.rows, vouchers: V.rows, truncated: V.truncated,
    // Read caps (5,000 ledgers, 10,000 bills, 20,000 vouchers): the completeness check says when one is hit.
    caps: { ledgers: { cap: 5000, truncated: L.truncated }, bills: { cap: 10000, truncated: B.truncated }, vouchers: { cap: 20000, truncated: V.truncated } },
    overrides, aiPlaced, syncRuns
  };
  _cache.set(key, { at: Date.now(), book });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  return book;
}

/** Drop what this instance remembers for an account (after a ledger is re-classified). */
function forgetTallyBook(userId) {
  for (const k of [..._cache.keys()]) if (k.startsWith(userId + '|')) _cache.delete(k);
}

module.exports = { loadTallyBook, forgetTallyBook, installsFor, pagedAll };
