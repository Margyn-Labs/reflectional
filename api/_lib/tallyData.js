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
 * The synced rows are read once per sync: a warm instance keeps them, and a
 * gzipped copy in Storage (bucket margyn-cache) serves every other instance,
 * keyed on the installs and their last sync time. A new sync changes the key.
 *
 * CommonJS, zero-npm.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const { selectRows } = require('./supabaseRest');

const CACHE_MS = 30 * 60 * 1000;      // a warm instance's copy; the key changes with every sync anyway
const CACHE_MAX = 20;
const _cache = new Map();             // userId|snapKey -> { at, snap }   (the synced rows)
const _inflight = new Map();          // userId|snapKey -> Promise<snap>  (two requests at once read once)
const _books = new Map();             // userId|snapKey|overrides -> book (same object while nothing changed)

/* The synced rows are kept as one gzipped file per account in a private Storage bucket, keyed on the
 * installs and their last sync (2026-10-09). Reading 19k vouchers 1,000 rows at a time took Care Hygiene
 * ~10-20 s on every Margin, Cash flow, books check and completeness load, each in its own function instance.
 * A sync changes last_sync_at, which changes the key, so a stale file is never used. Service role only. */
const SNAP_BUCKET = 'margyn-cache';
const SNAP_MAX_AGE_MS = 12 * 3600000; // belt and braces: re-read the books at least twice a day
let _bucketReady = false;

function storageUrl(path) { return `${process.env.SUPABASE_URL}/storage/v1/${path}`; }
function storageHeaders(extra) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: k, Authorization: `Bearer ${k}` }, extra || {});
}
function snapPath(userId, inst) {
  const ids = inst.chosen.map((i) => i.id).sort().join(',');
  return `tally/${userId}/${crypto.createHash('sha1').update((inst.company || '') + '|' + ids).digest('hex')}.json.gz`;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function readSnap(path, snapKey) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const r = await withTimeout(fetch(storageUrl(`object/${SNAP_BUCKET}/${path}`), { headers: storageHeaders() }), 8000);
    if (!r.ok) return null;
    const snap = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
    if (!snap || snap.key !== snapKey || !Array.isArray(snap.vouchers) || Date.now() - Date.parse(snap.at) > SNAP_MAX_AGE_MS) return null;
    return snap;
  } catch (e) { return null; }
}
async function ensureBucket() {
  if (_bucketReady) return;
  const r = await fetch(storageUrl('bucket'), { method: 'POST', headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: SNAP_BUCKET, name: SNAP_BUCKET, public: false }) });
  if (!r.ok) { const t = await r.text(); if (!/exist|duplicate/i.test(t)) throw new Error('bucket ' + r.status + ' ' + t.slice(0, 120)); }
  _bucketReady = true;
}
async function writeSnap(path, snap) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(snap)), { level: 6 });
  const put = () => fetch(storageUrl(`object/${SNAP_BUCKET}/${path}`), { method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/gzip', 'x-upsert': 'true', 'cache-control': 'no-store' }), body });
  try {
    let r = await withTimeout(put(), 8000);
    if (!r.ok && !_bucketReady) { await ensureBucket(); r = await withTimeout(put(), 8000); }
    if (!r.ok) console.warn('[tallyData] snapshot not saved:', r.status, (await r.text()).slice(0, 160));
    else _bucketReady = true;
  } catch (e) { console.warn('[tallyData] snapshot not saved:', e.message); }
}

async function pagedAll(table, query, max, parallel) {
  const pageSize = 1000, rows = [], par = parallel || 4;
  for (let offset = 0; offset < max; offset += pageSize * par) {
    const pages = await Promise.all([...Array(par).keys()].map((i) =>
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

/** Ledgers, bills and vouchers straight from the tables (the slow path). */
async function readRows(inList) {
  const base = 'voucher_type,voucher_number,tally_guid,date,party_name,amount,is_cancelled,entries,narration';
  // Newer columns arrive with migrations; try the richest select first and fall back column by column.
  const voucherQ = async () => {
    let last;
    for (const extra of [',items,voucher_base', ',items', ',voucher_base', '']) {
      try { return await pagedAll('tally_vouchers', `select=${base}${extra}&install_id=in.${inList}&order=date.asc,tally_guid.asc`, 20000, 8); }
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
  return { ledgers: L.rows, bills: B.rows, vouchers: V.rows, truncated: V.truncated,
    // Read caps (5,000 ledgers, 10,000 bills, 20,000 vouchers): the completeness check says when one is hit.
    caps: { ledgers: { cap: 5000, truncated: L.truncated }, bills: { cap: 10000, truncated: B.truncated }, vouchers: { cap: 20000, truncated: V.truncated } } };
}

/** The synced rows for these installs as of their last sync: this instance's copy, else the saved file, else the tables. */
async function snapshotFor(userId, inst, fresh) {
  const snapKey = `${inst.company || ''}|${inst.chosen.map((i) => i.id).sort().join(',')}|${inst.lastSync || ''}`;
  const mk = userId + '|' + snapKey;
  const hit = _cache.get(mk);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return { snap: hit.snap, key: snapKey, from: 'memory' };
  if (_inflight.has(mk)) return _inflight.get(mk);
  const p = (async () => {
    const path = snapPath(userId, inst);
    let snap = fresh ? null : await readSnap(path, snapKey), from = 'storage';
    if (!snap) {
      from = 'tables';
      snap = Object.assign({ v: 1, key: snapKey, at: new Date().toISOString() }, await readRows(`(${inst.chosen.map((i) => i.id).join(',')})`));
      await writeSnap(path, snap);
    }
    _cache.set(mk, { at: Date.now(), snap });
    while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    return { snap, key: snapKey, from };
  })();
  _inflight.set(mk, p);
  try { return await p; } finally { _inflight.delete(mk); }
}

/**
 * Everything Margyn knows from Tally for one account.
 * The synced rows come from snapshotFor; the owner's ledger placements and the sync log are read every time
 * (small), so a placement made on one instance is seen by every other one at once.
 * @returns {{ connected:boolean, company, companies, chosen, lastSync, edition, diagnostics,
 *   ledgers, bills, vouchers, truncated, overrides, aiPlaced:Set, syncRuns, load }}
 */
async function loadTallyBook(userId, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const inst = await installsFor(userId, o.company);
  if (!inst.installs.length) return { connected: false, companies: [] };
  const inList = `(${inst.chosen.map((i) => i.id).join(',')})`;
  const t1 = Date.now();

  const side = (async () => {
    const overrides = {}, aiPlaced = new Set();
    let syncRuns = [];
    await Promise.all([
      selectRows('tally_ledger_classes', `select=ledger_name,bucket,set_by&user_id=eq.${userId}${inst.company ? '&company_name=eq.' + encodeURIComponent(inst.company) : ''}`)
        .then((O) => { for (const x of O) { overrides[x.ledger_name] = x.bucket; if (!x.set_by) aiPlaced.add(x.ledger_name); } })
        .catch(() => { /* table not created yet: no overrides */ }),
      selectRows('tally_sync_runs', `select=kind,status,error_message,rows_received,started_at&user_id=eq.${userId}&install_id=in.${inList}&order=started_at.desc&limit=40`)
        .then((r) => { syncRuns = r; }).catch(() => { /* older deployments */ })
    ]);
    return { overrides, aiPlaced, syncRuns };
  })();
  const [S, X] = await Promise.all([snapshotFor(userId, inst, !!o.fresh), side]);
  const t2 = Date.now();

  // Health reports (diagnostics), agent version and edition arrive without a sync: they're part of the key too.
  const bk = userId + '|' + S.key + '|' + JSON.stringify(inst.chosen) + '|' + JSON.stringify(X.overrides) + '|' + [...X.aiPlaced].join(',') + '|' + (X.syncRuns[0] ? X.syncRuns[0].started_at + X.syncRuns[0].status : '');
  const load = { installs_ms: t1 - t0, rows_ms: t2 - t1, rows_from: S.from };
  const same = _books.get(bk);
  if (same && same.snap === S.snap) { same.book.load = load; return same.book; }

  const snap = S.snap;
  const book = {
    connected: true,
    company: inst.company, companies: inst.companies, chosen: inst.chosen, lastSync: inst.lastSync,
    edition: (inst.chosen.find((i) => i.tally_edition) || {}).tally_edition || null,
    agentVersion: (inst.chosen.find((i) => i.agent_version) || {}).agent_version || null,
    diagnostics: (inst.chosen.find((i) => i.diagnostics) || {}).diagnostics || null,
    ledgers: snap.ledgers, bills: snap.bills, vouchers: snap.vouchers, truncated: snap.truncated, caps: snap.caps,
    overrides: X.overrides, aiPlaced: X.aiPlaced, syncRuns: X.syncRuns, load
  };
  _books.set(bk, { snap, book });
  while (_books.size > CACHE_MAX) _books.delete(_books.keys().next().value);
  return book;
}

/** Drop what this instance remembers for an account (after a ledger is re-classified). The saved file stays: it holds no placements. */
function forgetTallyBook(userId) {
  for (const k of [..._books.keys()]) if (k.startsWith(userId + '|')) _books.delete(k);
}

module.exports = { loadTallyBook, forgetTallyBook, installsFor, pagedAll };
