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
const COLLECTION_STRATEGIES = new Set(['collection-period', 'collection']);
const CALIBRATION = 2; // bump when the ladder changes

/* ---------------------------- crash guard ----------------------------
 * On real TallyPrime a request it can't parse opens an "Error in TDL" box, and clicking OK closes
 * Tally. Requests here are copied from proven integrations, but a client's build could still
 * differ. So the first time each request shape is sent on a machine, the agent writes a note to
 * disk first. If that request kills or stalls Tally (connection lost, timeout) — or the agent itself
 * dies mid-request and finds the note on restart — the shape is blocked on that machine for good.
 * Tally can be upset by a given request at most once per PC. Shapes 0.1 already ran everywhere
 * (ledgers, Day Book, bills) are trusted from the start.
 */
const TRUSTED = new Set(['day-book']);
function guard(cfg) {
  const st = () => Object.assign({}, config.load().syncState || {}, cfg.__stateOverride || {});
  const write = (patch) => { if (!cfg.__dryRun) config.save({ syncState: Object.assign(st(), patch) }); };
  return {
    blocked: (key) => (st().blockedRequests || []).includes(key),
    /** Called once at start: a note left over from last run means that request took Tally (or us) down. */
    settle(log) {
      const s0 = st();
      if (s0.inflight) {
        log(`Last time, Tally stopped responding during "${s0.inflight}". That request is now switched off on this PC.`);
        write({ inflight: null, blockedRequests: [...new Set((s0.blockedRequests || []).concat([s0.inflight]))] });
      }
    },
    async run(key, fn) {
      const s0 = st();
      if ((s0.blockedRequests || []).includes(key)) { const e = new Error(`"${key}" is switched off on this PC`); e.code = 'blocked'; throw e; }
      const fresh = !TRUSTED.has(key) && !(s0.provenRequests || []).includes(key);
      if (fresh) {
        // Only blame a request for Tally going away if Tally was there when we sent it.
        const up = await tally.testConnection({ host: cfg.tallyHost, port: cfg.tallyPort, timeoutMs: 3000 });
        if (!up.reachable) { const e = new Error('Tally is not running or not reachable right now.'); e.code = 'tally_down'; throw e; }
        write({ inflight: key });
      }
      try {
        const out = await fn();
        if (fresh) write({ inflight: null, provenRequests: [...new Set((st().provenRequests || []).concat([key]))] });
        return out;
      } catch (e) {
        const lost = e && (e.code === 'TALLY_TIMEOUT' || /Could not reach|ECONNRESET|socket hang up|failed \(/i.test(e.message || ''));
        if (fresh && lost) {
          write({ inflight: null, blockedRequests: [...new Set((st().blockedRequests || []).concat([key]))] });
          e.message = `${e.message} — "${key}" is now switched off on this PC so Tally is never upset by it again.`;
          e.code = 'tally_down'; // stop this sync: send nothing more until Tally is reopened
        } else if (fresh) write({ inflight: null });
        throw e;
      }
    }
  };
}

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
  const g = guard(cfg);
  g.settle(log);
  try {
    const xml = await g.run('company-facts', () => tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml: tally.buildCompanyFactsRequest(), timeoutMs: 30000 }));
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
/**
 * Which dates to read. Always this financial year, plus last year when the books began before this year.
 *
 * It used to follow Tally's "last voucher date" into the past: if that date fell before this financial year
 * the agent read only that earlier year. Care Hygiene keeps 2025-26 and 2026-27 in one company; on 9 Oct 2026
 * Tally reported 31 Mar 2026 as the last voucher date (its screen was on last year for the audit), so the agent
 * re-read all of 2025-26 and stopped reading 2026-27: new entries no longer reached Margyn. Tally's facts
 * describe what is on its screen, so they must never decide whether this year is read.
 * Only the dates change here. The requests are the same proven ones, sent month by month.
 */
function choosePeriod(cfg, fact, today) {
  if (cfg.fromDateExplicit) return { from: compact(cfg.fromDate), to: compact(cfg.toDate), source: 'config' };
  const t = ymd(today);
  const cur = fyOf(t);
  const prev = fyOf(`${+cur.from.slice(0, 4) - 1}0401`);
  const booksFrom = fact && compact(fact.books_from);
  let from = cur.from;
  if (booksFrom && booksFrom > cur.from && booksFrom <= cur.to) from = booksFrom;           // books began this year
  else if (booksFrom && booksFrom < cur.from) from = booksFrom > prev.from ? booksFrom : prev.from;   // began earlier: last year too
  return { from, to: cur.to, source: fact ? 'tally' : 'default' };
}

/* ---------------------------- Tally calls ---------------------------- */
function makeCtx(cfg, company, log) {
  return {
    cfg, company, log, guard: guard(cfg),
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
    // A bare TCP connect: never send Tally another request while it may be showing a dialog.
    const r = await tally.testConnection({ host: ctx.cfg.tallyHost, port: ctx.cfg.tallyPort, timeoutMs: 3000 });
    if (r.reachable) return true;
  }
  const err = new Error('Tally stayed busy for 5 minutes after a large request. The agent will resume from where it stopped on the next sync.');
  err.code = 'tally_busy';
  throw err;
}

async function fetchCounts(ctx) {
  try {
    const xml = await ctx.guard.run('voucher-count', () => ctx.post(tally.buildVoucherCountRequest({ company: ctx.company }), 120000));
    return tally.parseVoucherCounts(xml);
  } catch (e) {
    if (e.code === 'tally_down') throw e;
    ctx.log(`Tally's voucher count was not available (${e.message}); syncing without the completeness check.`);
    if (isTimeout(e)) await waitForTally(ctx);
    return null;
  }
}

async function fetchRaw(ctx, strategy, w, extra, timeoutMs) {
  const xml = tally.VOUCHER_STRATEGIES[strategy](Object.assign({ company: ctx.company, from: w.from, to: w.to }, extra || {}));
  const raw = await ctx.guard.run(strategy === 'collection' ? 'vouchers' : strategy, () => ctx.post(xml, timeoutMs));
  ctx.lastRaw = raw;
  return tally.parseVouchers(raw);
}

/** What Tally actually answered, compact, for the activity log when a method comes back short. */
function rawSnippet(raw) {
  const body = String(raw || '').replace(/\s+/g, ' ');
  const i = body.search(/<(DATA|COLLECTION|TALLYMESSAGE|LINEERROR)\b/i);
  return body.slice(i >= 0 ? i : 0, (i >= 0 ? i : 0) + 160) + (body.length > 160 ? '…' : '') + ` [${body.length} chars]`;
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
      ctx.log(`Test "${name}": ${all.length} vouchers back, ${live} in ${window.key}${expected != null ? ` (Tally has ${expected})` : ''}.` +
        (live < (expected || 1) ? ` Tally answered: ${rawSnippet(ctx.lastRaw)}` : ''));
      const complete = expected != null ? live >= expected : inW.length > 0;
      if (complete && (expected == null || expected > 0 || COLLECTION_STRATEGIES.has(name))) {
        // Answered with far more than the month asked for: this Tally ignores the period on this
        // request. Then one request for the whole year beats twelve that each return the year.
        const ignoresPeriod = all.length - inW.length > 50 && all.length > 1.5 * inW.length;
        best = { strategy: name, verified: expected != null, ignoresPeriod };
        break;
      }
      if (inW.length && (!best || inW.length > best.n)) best = { strategy: name, verified: false, n: inW.length, degraded: true };
    } catch (e) {
      trials.push({ strategy: name, error: String(e.message).slice(0, 160) });
      ctx.log(`Test "${name}": ${String(e.message).slice(0, 160)}`);
      if (e.code === 'blocked') continue;
      if (e.code === 'tally_down') throw e;
      // Tally went away (closed after an error box, or busy): wait for it; if it doesn't come back,
      // stop here instead of sending anything else at it.
      if (isTimeout(e) || /Could not reach/i.test(e.message || '')) await waitForTally(ctx);
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
  // Merge with what's on disk: the crash guard writes its notes there between our saves.
  const save = (patch) => { Object.assign(state, patch); if (!dryRun) config.save({ syncState: Object.assign({}, config.load().syncState || {}, state, { blockedRequests: (config.load().syncState || {}).blockedRequests || state.blockedRequests, provenRequests: (config.load().syncState || {}).provenRequests || state.provenRequests, inflight: (config.load().syncState || {}).inflight || null }) }); };

  const period = choosePeriod(cfg, fact, now);
  const periodKey = `${ctx.company}|${period.from}|${period.to}`;
  const diag = { company: ctx.company, period: { from: isoOf(period.from), to: isoOf(period.to), source: period.source }, months: {} };

  // Voucher types (renamed types roll up to a base: "KANDIVALI SALE" -> Sales). Small, every time.
  let voucherTypes = {};
  try { voucherTypes = tally.parseVoucherTypes(await ctx.guard.run('voucher-types', () => ctx.post(tally.buildVoucherTypesRequest({ company: ctx.company }), 30000))); }
  catch (e) { log(`Voucher types not read (${e.message}).`); }

  const nowMs = now.getTime();
  const altVch = fact && fact.alt_vch_id != null ? fact.alt_vch_id : null;
  const companyChanged = state.periodKey !== periodKey;
  // Day Book never honours dates, so it is only ever a stopgap: re-test daily. A new way of reading
  // (CALIBRATION) re-tests once on upgrade, so a fix reaches PCs that settled on a fallback. Checked
  // BEFORE the "nothing changed in Tally" shortcut, or a PC on a fallback would never re-test.
  const degraded = state.strategyDegraded || state.strategy === 'day-book';
  const recheckDegraded = degraded && (!state.strategyAt || nowMs - state.strategyAt > 24 * 3600 * 1000);
  const needCalibrate = !state.strategy || companyChanged || recheckDegraded || state.calibration !== CALIBRATION;
  const fullDue = needCalibrate || !state.lastFullAt || nowMs - state.lastFullAt > FULL_PASS_EVERY_MS || !!state.fullRun;

  if (!fullDue && altVch != null && state.altVchId === altVch) {
    log('No voucher changes in Tally since the last sync.');
    return { upserted: 0, received: 0, mode: 'unchanged', diag: Object.assign(diag, { strategy: state.strategy, months: state.months || {} }) };
  }

  const counts = fullDue ? await fetchCounts(ctx) : null;
  if (counts) diag.tally_counts = counts;

  // 1) Which request shape does this Tally answer? (once per company/period, or after a degraded pick)
  if (needCalibrate) {
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
    save({ ignoresPeriod: !!choice.ignoresPeriod, strategy: choice.strategy, strategyDegraded: !!choice.degraded || choice.strategy === 'day-book', strategyAt: nowMs, calibration: CALIBRATION, periodKey, fullRun: null, lastFullAt: null });
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

  // One read for the whole period when this Tally ignores per-month periods anyway.
  let wholePeriod = null;
  if (state.ignoresPeriod && months.some((m) => !run.done.includes(m.key))) {
    log('This Tally sends the whole year for any period, so reading it once and splitting by month.');
    wholePeriod = await fetchWindow(ctx, state.strategy, { from: period.from, to: horizon < period.to ? horizon : period.to, key: 'period' });
  }

  // Tally counts vouchers for the period on its screen. A month it didn't count is unknown, not zero.
  const countKeys = counts ? Object.keys(counts).sort() : [];
  const counted = (key) => countKeys.length > 0 && key >= countKeys[0] && key <= countKeys[countKeys.length - 1];
  const curFyFrom = fyOf(today).from;
  const before = state.months || {};
  for (const m of months) {
    if (run.done.includes(m.key)) continue;
    let expected = counts ? (counts[m.key] || 0) : null;
    // A month of an earlier year that Tally still counts the same as when it was last read in full is not
    // read again (a whole extra year every day would freeze the client's Tally for nothing). An entry
    // edited there still arrives: edits come through the change counter between full reads.
    const was = before[m.key];
    if (m.to < curFyFrom && expected != null && counted(m.key) && was && was.complete === true && was.tally === expected && was.synced >= expected && canVerifyDeletes) {
      monthStats[m.key] = was;
      log(`${m.key}: unchanged in Tally (${expected} vouchers), not read again.`);
      run.done.push(m.key);
      save({ fullRun: run, months: monthStats });
      continue;
    }
    const parts = expected && expected > MONTH_SPLIT_AT ? Math.ceil(expected / 2000) : 1;
    const rows = [];
    if (wholePeriod) rows.push(...wholePeriod.filter((r) => inWindow(r, m)));
    else for (const w of splitWindow(m, parts)) rows.push(...await fetchWindow(ctx, state.strategy, w));
    const seen = new Set();
    const uniq = rows.filter((r) => { const k = r.guid || `${r.voucher_type}|${r.voucher_number}|${r.date}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const live = uniq.filter((r) => !r.is_cancelled).length;
    if (counts && !counted(m.key) && live > 0) expected = null;   // vouchers in a month Tally didn't count: no count to check against
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
