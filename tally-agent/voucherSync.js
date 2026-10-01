/**
 * voucherSync.js — get EVERY voucher in the company's financial year out of Tally, on any
 * client's Tally, without anyone touching that machine.
 *
 * What it does on each sync tick:
 *   1. Reads the company's own facts (books-from, last voucher date, AltVchId change counter).
 *   2. Works out the period from those facts (current FY of the books, never before books-from).
 *   3. Asks Tally how many vouchers it holds per month in that period (completeness check).
 *   4. Once per company, finds which voucher request shape this Tally answers correctly (a ladder,
 *      see tallyClient VOUCHER_STRATEGIES) and remembers it.
 *   5. Full pass (first run, then at most every 20h): month by month, splitting a month that is
 *      too big or times out, verifying each month's count against Tally's, uploading in small
 *      batches, and telling the cloud to drop vouchers deleted in Tally for verified months.
 *      Progress is saved per month, so a pass interrupted by a busy Tally resumes next tick.
 *   6. Between full passes: nothing at all if AltVchId hasn't moved (no load on the client's
 *      Tally); otherwise only vouchers created/edited since the last AltVchId.
 *
 * Tally's HTTP gateway is single-threaded: a heavy read freezes the Tally screen the client is
 * typing in. So requests are sequential, months are small, and after a timeout we wait for
 * Tally to come back instead of piling more requests on its queue.
 */

const tally = require('./tallyClient');
const cloud = require('./cloud');
const config = require('./config');

const UPLOAD_BATCH = 250;                 // vouchers per cloud request (entries make each ~2-4KB; Vercel caps bodies at 4.5MB)
const MONTH_SPLIT_AT = 2500;              // split a month into smaller windows above this many vouchers
const REQUEST_TIMEOUT_MS = 180000;        // a big month on a slow PC legitimately takes minutes
const FULL_PASS_EVERY_MS = 20 * 3600 * 1000;
const COLLECTION_STRATEGIES = new Set(['collection-date', 'collection-lite', 'collection-datevalue']);

/* ---------------------------- dates ---------------------------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const isoOf = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const compact = (s) => (s ? String(s).replace(/-/g, '').slice(0, 8) : null);
const toDate = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

function fyOf(s) {
  const y = +s.slice(0, 4), m = +s.slice(4, 6);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}0401`, to: `${start + 1}0331` };
}

function monthWindows(from, to) {
  const out = [];
  let d = toDate(from);
  const end = toDate(to);
  while (d <= end) {
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const wTo = monthEnd < end ? monthEnd : end;
    out.push({ from: ymd(d), to: ymd(wTo), key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` });
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return out;
}

function splitWindow(w, parts) {
  const a = toDate(w.from), b = toDate(w.to);
  const days = Math.round((b - a) / 86400000) + 1;
  if (days <= 1) return [w];
  const n = Math.min(parts, days);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = new Date(a.getFullYear(), a.getMonth(), a.getDate() + Math.floor((i * days) / n));
    const e = new Date(a.getFullYear(), a.getMonth(), a.getDate() + Math.floor(((i + 1) * days) / n) - 1);
    out.push({ from: ymd(s), to: ymd(e), key: w.key });
  }
  return out;
}

const inWindow = (r, w) => { const d = compact(r.date); return !!d && d >= w.from && d <= w.to; };
const isTimeout = (e) => e && (e.code === 'TALLY_TIMEOUT' || /timed out/i.test(e.message || ''));

/* ---------------------------- company ---------------------------- */
/** "CARE HYGIENE PVT LTD (2026-27)" and "... - 2027-28" share a base name: Tally users split companies per FY. */
function baseCompanyName(n) {
  return String(n || '')
    .replace(/\s*[([]?\s*(?:fy\s*)?\d{4}\s*[-–/]\s*\d{2,4}\s*[)\]]?\s*$/i, '')
    .replace(/[\s\-–]+$/, '')
    .trim().toLowerCase();
}

/**
 * Which open company to sync. The configured name wins when it's open. If it isn't (the client
 * rolled over to next year's split company), switch to the open company with the same base name
 * and the newest books. Returns { company, fact, open } — fact/open are null if Tally can't list
 * companies (older builds); then we carry on with the configured name as before.
 */
async function resolveCompany(cfg, log) {
  let facts;
  try {
    const xml = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml: tally.buildCompanyFactsRequest(), timeoutMs: 30000 });
    facts = tally.parseCompanyFacts(xml);
  } catch (e) {
    log(`Could not list Tally's open companies (${e.message}). Using "${cfg.company}".`);
    return { company: cfg.company, fact: null, open: null };
  }
  if (!facts.length) return { company: cfg.company, fact: null, open: [] };
  const want = String(cfg.company || '').trim().toLowerCase();
  const exact = facts.find((f) => f.name.toLowerCase() === want);
  if (exact) return { company: exact.name, fact: exact, open: facts.map((f) => f.name) };

  const base = baseCompanyName(cfg.company);
  const same = base ? facts.filter((f) => baseCompanyName(f.name) === base) : [];
  if (same.length) {
    same.sort((x, y) => String(y.last_voucher_date || y.books_from || y.name).localeCompare(String(x.last_voucher_date || x.books_from || x.name)));
    const pick = same[0];
    log(`"${cfg.company}" is not open in Tally; switching to "${pick.name}" (same business, newer books).`);
    config.save({ company: pick.name });
    return { company: pick.name, fact: pick, open: facts.map((f) => f.name), switchedFrom: cfg.company };
  }
  const err = new Error(`Company "${cfg.company}" is not open in Tally. Open companies: ${facts.map((f) => f.name).join(', ')}. ` +
    'Open the company in Tally (Alt+F3 / F1 > Select Company) and the next sync picks it up.');
  err.code = 'company_not_open';
  err.open = facts.map((f) => f.name);
  throw err;
}

/* ---------------------------- period ---------------------------- */
function choosePeriod(cfg, fact, today) {
  if (cfg.fromDateExplicit) return { from: compact(cfg.fromDate), to: compact(cfg.toDate), source: 'config' };
  const t = ymd(today);
  const last = fact && compact(fact.last_voucher_date);
  // A closed past-year company (books end before today) syncs the year its vouchers are in.
  const anchor = last && last < fyOf(t).from ? last : t;
  const fy = fyOf(anchor);
  let from = fy.from;
  const booksFrom = fact && compact(fact.books_from);
  if (booksFrom && booksFrom > from && booksFrom <= fy.to) from = booksFrom;
  return { from, to: fy.to, source: fact ? 'tally' : 'default' };
}

/* ---------------------------- Tally calls ---------------------------- */
function makeCtx(cfg, company, log) {
  return {
    cfg, company, log,
    post: (xml, timeoutMs = REQUEST_TIMEOUT_MS) => tally.postXml({
      host: cfg.tallyHost, port: cfg.tallyPort, xml, timeoutMs,
      onSlow: () => log('Tally is still working on a large request. The agent waits; nothing is wrong.')
    })
  };
}

/** After a timeout Tally is usually still grinding through the request. Wait for it instead of queueing more. */
async function waitForTally(ctx, maxMs = 5 * 60 * 1000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      await ctx.post(tally.buildInfoRequest(), 10000);
      return true;
    } catch (e) { /* still busy */ }
  }
  const err = new Error('Tally stayed busy for 5 minutes after a large request. The agent will resume from where it stopped on the next sync.');
  err.code = 'tally_busy';
  throw err;
}

async function fetchCounts(ctx, period) {
  try {
    const xml = await ctx.post(tally.buildVoucherCountRequest({ company: ctx.company, from: period.from, to: period.to }), 120000);
    return tally.parseVoucherCounts(xml);
  } catch (e) {
    ctx.log(`Tally's voucher count was not available (${e.message}); syncing without the completeness check.`);
    if (isTimeout(e)) await waitForTally(ctx);
    return null;
  }
}

async function fetchRaw(ctx, strategy, w, extra, timeoutMs) {
  const xml = tally.VOUCHER_STRATEGIES[strategy](Object.assign({ company: ctx.company, from: w.from, to: w.to }, extra || {}));
  return tally.parseVouchers(await ctx.post(xml, timeoutMs));
}

/** Fetch one window; on a timeout, wait for Tally and retry in halves down to single days. */
async function fetchWindow(ctx, strategy, w, depth = 0) {
  try {
    return (await fetchRaw(ctx, strategy, w)).filter((r) => inWindow(r, w));
  } catch (e) {
    if (!isTimeout(e)) throw e;
    await waitForTally(ctx);
    const halves = splitWindow(w, 2);
    if (halves.length < 2 || depth >= 5) throw e;
    ctx.log(`${w.from}–${w.to} was too big for one request; fetching it in halves.`);
    const out = [];
    for (const h of halves) out.push(...await fetchWindow(ctx, strategy, h, depth + 1));
    return out;
  }
}

/**
 * Try each request shape on one month whose true count we (may) know; keep the first that returns
 * that month completely. Report-based rungs are kept only if nothing better answers.
 */
async function calibrate(ctx, window, expected) {
  const trials = [];
  let best = null;
  for (const name of tally.VOUCHER_STRATEGY_ORDER) {
    try {
      // The test month is the smallest one, so a healthy Tally answers fast. A shape that runs past
      // 90s is treated as one this Tally can't serve, and the next rung is tried.
      const all = await fetchRaw(ctx, name, window, null, 90000);
      const inW = all.filter((r) => inWindow(r, window));
      const live = inW.filter((r) => !r.is_cancelled).length;
      trials.push({ strategy: name, returned: all.length, in_window: inW.length });
      const complete = expected != null ? live >= expected : inW.length > 0;
      if (complete && (expected == null || expected > 0 || COLLECTION_STRATEGIES.has(name))) {
        best = { strategy: name, verified: expected != null };
        break;
      }
      if (inW.length && (!best || inW.length > best.n)) best = { strategy: name, verified: false, n: inW.length, degraded: true };
    } catch (e) {
      trials.push({ strategy: name, error: String(e.message).slice(0, 160) });
      if (isTimeout(e)) await waitForTally(ctx);
    }
  }
  return { choice: best, trials };
}

/* ---------------------------- cloud upload ---------------------------- */
/**
 * Upload one window's vouchers in batches. `final` = this is the complete, verified set for the
 * window, so the cloud may drop vouchers it holds in that window that weren't re-sent (deleted in
 * Tally). The cutoff time is the SERVER's clock from the first batch, never this PC's clock.
 */
async function uploadWindow(ctx, rows, w, { final, voucherTypes, dryRun }) {
  if (dryRun) return { upserted: 0, received: rows.length, removed: 0 };
  const base = { kind: 'vouchers', company_name: ctx.company, company_guid: ctx.cfg.companyGuid || null, voucher_types: voucherTypes };
  let serverStart = null, upserted = 0, removed = 0;
  const batches = [];
  for (let i = 0; i < rows.length; i += UPLOAD_BATCH) batches.push(rows.slice(i, i + UPLOAD_BATCH));
  if (!batches.length && final) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    const last = i === batches.length - 1;
    const payload = Object.assign({}, base, { rows: batches[i], partial: true });
    if (final && last && w) {
      payload.window = { from: isoOf(w.from), to: isoOf(w.to) };
      payload.window_final = true;
      payload.window_started_at = serverStart; // null => server uses its own "now"
    }
    const r = await cloud.ingest(ctx.cfg.apiBase, ctx.cfg.installKey, payload);
    if (!serverStart && r.server_time) serverStart = r.server_time;
    upserted += r.upserted || 0;
    removed += r.removed || 0;
  }
  return { upserted, received: rows.length, removed };
}

/* ---------------------------- main ---------------------------- */
async function syncVouchers(cfg, { company, fact, dryRun = false, log = () => {}, now = new Date() } = {}) {
  const ctx = makeCtx(cfg, company || cfg.company, log);
  const state = Object.assign({}, cfg.syncState || {});
  const save = (patch) => { Object.assign(state, patch); if (!dryRun) config.save({ syncState: state }); };

  const period = choosePeriod(cfg, fact, now);
  const periodKey = `${ctx.company}|${period.from}|${period.to}`;
  const diag = { company: ctx.company, period: { from: isoOf(period.from), to: isoOf(period.to), source: period.source }, months: {} };

  // Voucher types (renamed types roll up to a base: "KANDIVALI SALE" -> Sales). Small, every time.
  let voucherTypes = {};
  try { voucherTypes = tally.parseVoucherTypes(await ctx.post(tally.buildVoucherTypesRequest({ company: ctx.company }), 30000)); }
  catch (e) { log(`Voucher types not read (${e.message}).`); }

  const nowMs = now.getTime();
  const altVch = fact && fact.alt_vch_id != null ? fact.alt_vch_id : null;
  const companyChanged = state.periodKey !== periodKey;
  const fullDue = companyChanged || !state.strategy || !state.lastFullAt || nowMs - state.lastFullAt > FULL_PASS_EVERY_MS || !!state.fullRun;

  if (!fullDue && altVch != null && state.altVchId === altVch) {
    log('No voucher changes in Tally since the last sync.');
    return { upserted: 0, received: 0, mode: 'unchanged', diag: Object.assign(diag, { strategy: state.strategy, months: state.months || {} }) };
  }

  const counts = fullDue ? await fetchCounts(ctx, period) : null;
  if (counts) diag.tally_counts = counts;

  // 1) Which request shape does this Tally answer? (once per company/period, or after a degraded pick)
  const recheckDegraded = state.strategyDegraded && (!state.strategyAt || nowMs - state.strategyAt > 24 * 3600 * 1000);
  if (!state.strategy || companyChanged || recheckDegraded) {
    const windows = monthWindows(period.from, period.to);
    let probe = windows.find((w) => w.key === (fact && fact.last_voucher_date ? String(fact.last_voucher_date).slice(0, 7) : null));
    if (counts) {
      const busiest = Object.entries(counts).filter(([k]) => windows.some((w) => w.key === k)).sort((a, b) => a[1] - b[1]);
      // the smallest non-empty month is the cheapest honest test
      const pick = busiest.find(([, n]) => n > 0);
      if (pick) probe = windows.find((w) => w.key === pick[0]);
    }
    probe = probe || windows.filter((w) => w.from <= ymd(now)).pop() || windows[0];
    log(`Finding the right way to read vouchers from this Tally (testing ${probe.key})…`);
    const { choice, trials } = await calibrate(ctx, probe, counts ? (counts[probe.key] || 0) : null);
    diag.strategy_trials = trials;
    if (!choice) {
      save({ strategy: null });
      const err = new Error('This Tally did not return vouchers to any of the known requests. Details were sent to Margyn.');
      err.code = 'no_voucher_strategy';
      err.diag = diag;
      throw err;
    }
    log(`Using "${choice.strategy}"${choice.degraded ? ' (partial: this Tally ignores date ranges on the better requests)' : ''}.`);
    save({ strategy: choice.strategy, strategyDegraded: !!choice.degraded, strategyAt: nowMs, periodKey, fullRun: null, lastFullAt: null });
  }
  diag.strategy = state.strategy;
  const canVerifyDeletes = COLLECTION_STRATEGIES.has(state.strategy) && !state.strategyDegraded;

  let received = 0, upserted = 0, removed = 0;

  // 2) Incremental: only vouchers created/edited since the last AlterID we saw.
  if (!fullDue && altVch != null && state.altVchId != null && canVerifyDeletes) {
    const rows = await fetchRaw(ctx, state.strategy, { from: period.from, to: period.to }, { alterIdAfter: state.altVchId });
    const inP = rows.filter((r) => inWindow(r, period));
    log(`${inP.length} voucher(s) created or edited in Tally since the last sync.`);
    const r = await uploadWindow(ctx, inP, null, { final: false, voucherTypes, dryRun });
    save({ altVchId: altVch });
    return { upserted: r.upserted, received: inP.length, mode: 'incremental', diag: Object.assign(diag, { months: state.months || {} }) };
  }

  const today = ymd(now);

  // 2b) No AlterID path (older Tally or a report-based read): between full passes, refresh only
  //     this month and last month, which is where edits happen.
  if (!fullDue) {
    const recent = monthWindows(period.from, period.to).filter((w) => w.from <= today).slice(-2);
    const ms = Object.assign({}, state.months || {});
    for (const m of recent) {
      const rows = await fetchWindow(ctx, state.strategy, m);
      const r = await uploadWindow(ctx, rows, m, { final: false, voucherTypes, dryRun });
      received += rows.length; upserted += r.upserted;
      ms[m.key] = Object.assign({}, ms[m.key] || {}, { synced: Math.max((ms[m.key] || {}).synced || 0, rows.filter((x) => !x.is_cancelled).length) });
    }
    save({ altVchId: altVch, months: ms });
    return { upserted, received, mode: 'recent', diag: Object.assign(diag, { months: ms }) };
  }

  // 3) Full pass, month by month, resumable.
  const lastDate = fact && compact(fact.last_voucher_date);
  const horizon = [today, lastDate || today].sort().pop(); // post-dated vouchers up to Tally's last voucher date
  const months = monthWindows(period.from, period.to).filter((w) => w.from <= horizon);
  const run = state.fullRun && state.fullRun.periodKey === periodKey && nowMs - state.fullRun.startedAt < 24 * 3600 * 1000
    ? state.fullRun : { periodKey, startedAt: nowMs, done: [] };
  save({ fullRun: run });
  const monthStats = Object.assign({}, run.done.length ? state.months || {} : {});

  for (const m of months) {
    if (run.done.includes(m.key)) continue;
    const expected = counts ? (counts[m.key] || 0) : null;
    const parts = expected && expected > MONTH_SPLIT_AT ? Math.ceil(expected / 2000) : 1;
    const rows = [];
    for (const w of splitWindow(m, parts)) rows.push(...await fetchWindow(ctx, state.strategy, w));
    const seen = new Set();
    const uniq = rows.filter((r) => { const k = r.guid || `${r.voucher_type}|${r.voucher_number}|${r.date}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const live = uniq.filter((r) => !r.is_cancelled).length;
    const complete = expected == null ? null : live >= expected;
    const final = canVerifyDeletes && complete !== false;
    const r = await uploadWindow(ctx, uniq, m, { final, voucherTypes, dryRun });
    received += uniq.length; upserted += r.upserted; removed += r.removed;
    monthStats[m.key] = { tally: expected, synced: live, complete };
    if (complete === false) log(`⚠ ${m.key}: Tally has ${expected} vouchers, ${live} came through. Kept everything; flagged for Margyn.`);
    else log(`${m.key}: ${live} vouchers${expected != null ? ' (matches Tally)' : ''}.`);
    run.done.push(m.key);
    save({ fullRun: run, months: monthStats });
  }

  save({ fullRun: null, lastFullAt: nowMs, altVchId: altVch, months: monthStats });
  diag.months = monthStats;
  return { upserted, received, removed, mode: 'full', diag };
}

module.exports = {
  syncVouchers,
  resolveCompany,
  _internal: { baseCompanyName, choosePeriod, monthWindows, splitWindow, fyOf, calibrate, uploadWindow }
};
