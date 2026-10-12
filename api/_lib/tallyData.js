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

/** A gzipped JSON file from the private bucket, or null (missing, unreadable, Storage down). */
async function readSaved(path) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const r = await withTimeout(fetch(storageUrl(`object/${SNAP_BUCKET}/${path}`), { headers: storageHeaders() }), 8000);
    if (!r.ok) return null;
    return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
  } catch (e) { return null; }
}
async function readSnap(path, snapKey) {
  const snap = await readSaved(path);
  if (!snap || snap.key !== snapKey || !Array.isArray(snap.vouchers) || Date.now() - Date.parse(snap.at) > SNAP_MAX_AGE_MS) return null;
  return snap;
}
async function ensureBucket() {
  if (_bucketReady) return;
  const r = await fetch(storageUrl('bucket'), { method: 'POST', headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: SNAP_BUCKET, name: SNAP_BUCKET, public: false }) });
  if (!r.ok) { const t = await r.text(); if (!/exist|duplicate/i.test(t)) throw new Error('bucket ' + r.status + ' ' + t.slice(0, 120)); }
  _bucketReady = true;
}
async function writeSaved(path, snap) {
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

// Rows are read oldest first, so a cap cuts off the NEWEST entries. Care Hygiene (two years in one Tally company)
// stood at 19,450 of the old 20,000 on 11 Oct 2026; 60,000 is about five years of a company that size.
const VOUCHER_CAP = 60000;
// Ledgers are read in name order across every company file on the install, so a cap cuts off the END OF THE
// ALPHABET. Care Hygiene (two files: 2,882 + 3,017 ledgers) passed the old 5,000 on 12 Oct 2026 and lost every
// ledger from "S" on: Stock-in-hand, transport costs, 29 customers' balances.
const LEDGER_CAP = 30000, BILL_CAP = 30000;

/**
 * A business that keeps one Tally company file per financial year has several files on one install. Entries
 * from every file are history and are all read. Balances and open bills are a picture of now, so they come
 * from the CURRENT file only: the one whose entries run latest (up to today). When that file's ledgers are not
 * held (they were replaced by an older file's before files were kept apart), the ledgers that are held are
 * used and tallyAnalytics carries their balances forward from the entries.
 */
/**
 * The current file's ledgers, plus the ledgers that exist only in an older file: name and group with NO balance.
 * An expense ledger used last year and dropped from this year's file still has last year's entries against it,
 * and without its group those entries fall out of last year's costs (Care Hygiene: "PACKING MATERIAL & CHARGES",
 * 93.9 L, lifted last year's margin from 21.8% to 25.2%). Balances come from the current file only.
 */
function withHistoryLedgers(current, others) {
  const key = (n) => String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const have = new Set(current.map((l) => key(l && l.name)));
  const out = current.slice();
  for (const l of others || []) {
    if (!l || !l.name) continue;
    const k = key(l.name);
    if (have.has(k)) continue;
    have.add(k);
    out.push(Object.assign({}, l, { opening_balance: null, closing_balance: null, history_only: true }));
  }
  return out;
}

function companyFiles(ledgers, bills, vouchers) {
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const by = new Map();
  for (const v of vouchers) {
    const c = v && v.company_name; if (!c || !v.date) continue;
    const d = String(v.date).slice(0, 10);
    let o = by.get(c); if (!o) { o = { name: c, vouchers: 0, from: d, to: d, last: '' }; by.set(c, o); }
    o.vouchers++; if (d < o.from) o.from = d; if (d > o.to) o.to = d; if (d <= today && d > o.last) o.last = d;
  }
  const list = [...by.values()].sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0));
  if (list.length < 2) return { ledgers, bills, priorLedgers: [], summary: list.length ? { current: list[0].name, files: list, ledgers_from: list[0].name, bills_from: list[0].name } : null };
  const current = list[list.length - 1].name;
  const mine = (rows) => rows.filter((r) => r && r.company_name === current);
  const L = mine(ledgers), B = mine(bills);
  return {
    ledgers: L.length ? withHistoryLedgers(L, ledgers) : ledgers, bills: B.length ? B : bills,
    // The older files' own ledgers (their groups and year-end balances): each year's entries are classified by
    // that year's file, and last year's closing is checked against this year's opening.
    priorLedgers: L.length ? ledgers.filter((r) => r && r.company_name && r.company_name !== current) : [],
    summary: { current, files: list, ledgers_from: L.length ? current : [...new Set(ledgers.map((r) => r && r.company_name).filter(Boolean))].join(' + ') || null,
      bills_from: B.length ? current : 'all files', bills_set_aside: B.length ? bills.length - B.length : 0 }
  };
}

/**
 * The current year's file as Margyn last saw it, from Margyn's own saved copy of the books (2026-10-11).
 *
 * When an older year's file replaced the current file's balances in the tables (before files were kept apart),
 * the tables can no longer say what the current file's balances were. But the books are saved after each sync
 * in one file per company NAME (snapPath), so the copy saved while the current file was the one being read is
 * still there under its name, untouched by the other file. From it come: every ledger balance and open bill as
 * at that file's last sync, and any of its vouchers the tables no longer hold (their GUIDs were taken by the
 * other file's rows). Nothing is written back; the moment Tally sends the current file again this is not used.
 * Returns the rows to use, or null when there is no such copy or it is not clearly better.
 */
async function recoverCurrentFile(userId, inst, rows) {
  const f = rows && rows.files;
  if (!f || !Array.isArray(f.files) || f.files.length < 2 || f.ledgers_from === f.current) return null;
  const ids = inst.chosen.map((i) => i.id).sort().join(',');
  const path = `tally/${userId}/${crypto.createHash('sha1').update(f.current + '|' + ids).digest('hex')}.json.gz`;
  const snap = await readSaved(path);
  if (!snap || !Array.isArray(snap.vouchers) || !Array.isArray(snap.ledgers) || !snap.ledgers.length) return null;
  if (!String(snap.key || '').includes(f.current)) return null;
  const cur = f.files.find((x) => x.name === f.current);
  const day = (v) => String(v.date || '').slice(0, 10);
  const savedCur = snap.vouchers.filter((v) => v && v.date && day(v) >= cur.from);
  const heldCur = rows.vouchers.filter((v) => v && v.company_name === f.current);
  if (savedCur.length < 0.9 * heldCur.length) return null;   // an older, smaller copy is not better than the tables
  const held = new Map();
  for (const v of rows.vouchers) if (v && v.tally_guid) held.set(v.tally_guid, v);
  const back = [];
  for (const v of savedCur) {
    const h = v.tally_guid ? held.get(v.tally_guid) : null;
    if (h && day(h) === day(v)) continue;                     // still held as it was
    back.push(Object.assign({}, v, { tally_guid: String(v.tally_guid || '') + '~saved', company_name: f.current, restored: true }));
  }
  if (back.length > 0.3 * savedCur.length) return null;       // far too many: this copy is not of the same books
  const vouchers = back.length ? rows.vouchers.concat(back).sort((a, b) => (day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : String(a.tally_guid || '').localeCompare(String(b.tally_guid || '')))) : rows.vouchers;
  const tag = (r) => Object.assign({}, r, { company_name: f.current });
  const asAt = String(snap.key || '').split('|').pop() || snap.at || null;
  return {
    priorLedgers: rows.ledgers.filter((r) => r && r.company_name && r.company_name !== f.current),
    ledgers: withHistoryLedgers(snap.ledgers.map(tag), rows.ledgers), bills: Array.isArray(snap.bills) && snap.bills.length ? snap.bills.map(tag) : rows.bills, vouchers,
    files: Object.assign({}, f, { ledgers_from: f.current, bills_from: f.current, bills_set_aside: 0,
      recovered: { as_at: asAt, saved_at: snap.at || null, ledgers: snap.ledgers.length, bills: Array.isArray(snap.bills) ? snap.bills.length : 0, vouchers_restored: back.length, was_ledgers_from: f.ledgers_from } })
  };
}

/** Ledgers, bills and vouchers straight from the tables (the slow path). */
async function readRows(inList) {
  const base = 'voucher_type,voucher_number,tally_guid,date,party_name,amount,is_cancelled,entries,narration,company_name,synced_at';
  // Newer columns arrive with migrations; try the richest select first and fall back column by column.
  const voucherQ = async () => {
    let last;
    for (const extra of [',items,voucher_base', ',items', ',voucher_base', '']) {
      try { return await pagedAll('tally_vouchers', `select=${base}${extra}&install_id=in.${inList}&order=date.asc,tally_guid.asc`, VOUCHER_CAP, 8); }
      catch (e) { last = e; }
    }
    throw last;
  };
  const ledgerQ = async () => {
    try { return await pagedAll('tally_ledgers', `select=name,parent,primary_group,opening_balance,closing_balance,company_name&install_id=in.${inList}&order=name.asc,tally_guid.asc`, LEDGER_CAP); }
    catch (e) { return await pagedAll('tally_ledgers', `select=name,parent,opening_balance,closing_balance,company_name&install_id=in.${inList}&order=name.asc,tally_guid.asc`, LEDGER_CAP); }
  };
  const [L, B, V] = await Promise.all([
    ledgerQ(),
    pagedAll('tally_bills', `select=direction,party_name,bill_ref,bill_date,due_date,closing_balance,overdue_days,company_name&install_id=in.${inList}&order=party_name.asc,bill_ref.asc`, BILL_CAP),
    voucherQ()
  ]);
  const files = companyFiles(L.rows, B.rows, V.rows);
  return { ledgers: files.ledgers, bills: files.bills, priorLedgers: files.priorLedgers || [], vouchers: V.rows, truncated: V.truncated, files: files.summary,
    // Read caps (30,000 ledgers, 30,000 bills, 60,000 vouchers): the completeness check says when one is hit.
    caps: { ledgers: { cap: LEDGER_CAP, truncated: L.truncated }, bills: { cap: BILL_CAP, truncated: B.truncated }, vouchers: { cap: VOUCHER_CAP, truncated: V.truncated } } };
}

/** The synced rows for these installs as of their last sync: this instance's copy, else the saved file, else the tables. */
async function snapshotFor(userId, inst, fresh) {
  // v2: rows carry their company file; a copy saved before that is read again from the tables.
  const snapKey = `v7|${inst.company || ''}|${inst.chosen.map((i) => i.id).sort().join(',')}|${inst.lastSync || ''}`;
  const mk = userId + '|' + snapKey;
  const hit = _cache.get(mk);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return { snap: hit.snap, key: snapKey, from: 'memory' };
  if (_inflight.has(mk)) return _inflight.get(mk);
  const p = (async () => {
    const path = snapPath(userId, inst);
    let snap = fresh ? null : await readSnap(path, snapKey), from = 'storage';
    if (!snap) {
      from = 'tables';
      const rows = await readRows(`(${inst.chosen.map((i) => i.id).join(',')})`);
      let rec = null;
      try { rec = await recoverCurrentFile(userId, inst, rows); } catch (e) { console.warn('[tallyData] saved copy not used:', e.message); }
      snap = Object.assign({ v: 1, key: snapKey, at: new Date().toISOString() }, rows, rec || {});
      await writeSaved(path, snap);
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
    ledgers: snap.ledgers, bills: snap.bills, vouchers: snap.vouchers, truncated: snap.truncated, caps: snap.caps, files: snap.files || null, priorLedgers: snap.priorLedgers || [],
    overrides: X.overrides, aiPlaced: X.aiPlaced, syncRuns: X.syncRuns, load
  };
  _books.set(bk, { snap, book });
  while (_books.size > CACHE_MAX) _books.delete(_books.keys().next().value);
  return book;
}

/**
 * What the books are as of now, without reading them: the installs and their last sync, the owner's ledger
 * placements and the newest sync run. Equal keys mean the same books (the Margin page's saved answer uses it).
 * Null when Tally isn't connected.
 */
async function bookKey(userId, company) {
  const inst = await installsFor(userId, company);
  if (!inst.installs.length) return null;
  const inList = `(${inst.chosen.map((i) => i.id).join(',')})`;
  const [O, R] = await Promise.all([
    selectRows('tally_ledger_classes', `select=ledger_name,bucket,set_by&user_id=eq.${userId}${inst.company ? '&company_name=eq.' + encodeURIComponent(inst.company) : ''}&order=ledger_name.asc`).catch(() => []),
    selectRows('tally_sync_runs', `select=started_at,status&user_id=eq.${userId}&install_id=in.${inList}&order=started_at.desc&limit=1`).catch(() => [])
  ]);
  const raw = JSON.stringify([inst.company, inst.chosen, O.map((x) => [x.ledger_name, x.bucket, !x.set_by]), R[0] || null]);
  return { key: crypto.createHash('sha1').update(raw).digest('hex'), company: inst.company, lastSync: inst.lastSync };
}

/** Drop what this instance remembers for an account (after a ledger is re-classified). The saved file stays: it holds no placements. */
function forgetTallyBook(userId) {
  for (const k of [..._books.keys()]) if (k.startsWith(userId + '|')) _books.delete(k);
}

/**
 * Everything the agent sends is kept exactly as it arrived, before anything is worked out from it (2026-10-11).
 * The tables hold the latest picture and are overwritten in place: when last year's company file replaced
 * April 2026 at Care Hygiene, the vouchers that had arrived the day before were simply gone. With the raw
 * batches kept, anything the tables lose can be rebuilt, and a new way of reading old data needs no re-sync.
 * One gzipped file per distinct batch in the private bucket (the name is the hash of its content, so the same
 * batch re-sent every day is stored once). Never blocks or fails a sync.
 */
async function archiveRaw(userId, installId, kind, companyName, body) {
  try {
    const rows = Array.isArray(body && body.rows) ? body.rows : null;
    const payload = rows ? { company_name: companyName || null, kind, rows } : { company_name: companyName || null, kind, report: body };
    const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
    if (rows && !rows.length) return null;
    const name = rows ? hash : new Date().toISOString().replace(/[:.]/g, '-') + '-' + hash.slice(0, 8);
    const path = `raw/${userId}/${installId}/${kind}/${name}.json.gz`;
    await writeSaved(path, Object.assign({ received_at: new Date().toISOString(), window: (body && body.window) || null, voucher_types: (body && body.voucher_types) || null, as_of_date: (body && body.as_of_date) || null }, payload));
    return path;
  } catch (e) { console.warn('[tallyData] raw batch not kept:', e.message); return null; }
}

module.exports = { archiveRaw, companyFiles, recoverCurrentFile, loadTallyBook, forgetTallyBook, installsFor, pagedAll, bookKey, readSaved, writeSaved };
