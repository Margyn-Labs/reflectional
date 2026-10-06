/**
 * _lib/cashFlowStatement.js
 * The cash flow statement, and how every overdraft and loan moved day by day (2026-10-06).
 *
 * Margyn showed cash today, cash by week and a forecast, but never the statement an accountant or a bank
 * asks for: where the period's cash came from and went. And the Borrowing list showed what was owed today
 * only, though the books hold every entry on those accounts for the year.
 *
 * 1. Cash flow statement, two views of the same money:
 *    - Owner view (direct method): every entry that moved cash, filed by what it was for: customers,
 *      suppliers, running costs, tax, assets, loans, owner's money.
 *    - Accountant view (indirect method, AS-3 / Ind AS 7): net profit, plus what wasn't cash (depreciation),
 *      plus the change in each balance-sheet account.
 *    Both are built line by line from the entries. Every entry balances (debits = credits), so the cash an
 *    entry moved equals the sum of its other lines; summing those lines by what they are gives the statement,
 *    with nothing estimated. Overdraft and cash credit count as cash (negative cash, as AS-3 allows when the
 *    overdraft is how the business runs day to day): money paid in or out through the overdraft then shows
 *    as what it was for, not as "borrowing".
 *    Checks, returned with it: opening cash + the period's flows = closing cash; entries that don't balance;
 *    and each cash and overdraft ledger walked back to the start of the year against Tally's own opening
 *    balance (a gap there means entries are missing from the sync).
 * 2. Borrowing history: each overdraft, cash credit and loan account walked back from today's balance through
 *    every entry: owed at the end of every day this year, peak, average, days used, paid in and out, interest
 *    the bank charged to it, the cost of borrowing as a yearly rate, EMIs already entered for later dates, and
 *    use of the limit when the business has told Margyn its limit (profiles.preferences.borrow_limits).
 *
 * Pure: takes a booksEngine ctx (prepare()). No I/O. Conventions: entry amounts are debit-negative.
 * CommonJS, zero-npm.
 */

const A = require('./tallyAnalytics');
const E = require('./booksEngine');

const DAY = 86400000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(num(n));
const nk = A.nameKey;
const dk = (d) => new Date(d).toISOString().slice(0, 10);
const dms = (k) => Date.parse(String(k).slice(0, 10) + 'T00:00:00Z');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (k) => MON[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(0, 4);
const fyStartOf = (d) => { const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return new Date(Date.UTC(y, 3, 1)); };

const DEP = /depreciation|amorti[sz]/i;
/** Interest the business pays. "Interest on OD" filed under income is still a cost; interest earned on deposits isn't. */
function isInterestCost(name) {
  const n = String(name || '');
  return /\binterest\b/i.test(n) && !/(received|receivable|earned|income|\bon\s*(f\.?\s?d|fixed|deposit|sweep|saving|investment))|\bf\.?d\b/i.test(n);
}
const isSweep = (l) => /sweep/i.test(String(l.name || '')) && /deposit/i.test(String(l.parent || ''));
const isOdName = (s) => /\b(o\.?\s?d|o\.?c\.?c|overdraft|cash\s*credit|c\.?c\.?\s*a\/?c)\b/i.test(String(s || ''));

/* ------------------------------------------------------------------ setup */

/** Which ledgers are cash, which are overdrafts and loans, and each one's balance today (debit-positive). */
function setup(ctx) {
  const bs = ((ctx.analytics || {}).quality || {}).balance_sign || {};
  const eff = bs.effective || (!bs.convention || bs.convention === 'unknown' ? 'opposite' : bs.convention);
  const debitPos = (b) => (eff === 'same' ? -num(b) : num(b));
  const move = new Map();
  for (const r of ctx.rows) for (const l of r.lines) { const k = nk(l.ledger); move.set(k, (move.get(k) || 0) + l.amount); }
  const balanceOf = (l) => {
    if (l.closing_balance != null) return { v: debitPos(l.closing_balance), how: 'tally' };
    if (l.opening_balance != null) return { v: debitPos(l.opening_balance) - (move.get(nk(l.name)) || 0), how: 'derived' };
    return null;
  };
  const led = new Map();
  const cash = [], od = [], loans = [];
  for (const l of ctx.ledgers || []) {
    if (!l || !l.name) continue;
    led.set(nk(l.name), l);
    const b = ctx.cls(l.name);
    const borrow = E.isBorrowing(ctx, l) && !isSweep(l);
    if (borrow) {
      const isOd = b === 'bank_od' || b === 'bank' || isOdName(l.name) || isOdName(l.parent);
      (isOd ? od : loans).push(l);
    } else if (b === 'bank' || b === 'cash' || isSweep(l)) cash.push(l);
  }
  return { debitPos, balanceOf, led, cash, od, loans, move };
}

/** What a non-cash line of an entry is, in the statement's terms. */
function lineKey(S, ctx, l, loanKind) {
  const k = nk(l.ledger);
  if (loanKind.has(k)) return loanKind.get(k);
  const b = l.bucket;
  if (A.PL_BUCKETS.includes(b)) {
    if (DEP.test(l.ledger)) return 'depreciation';
    if (isInterestCost(l.ledger)) return 'interest';
    if (b === 'sales' || b === 'direct_income') return 'pl_sales';
    if (b === 'purchases') return 'pl_purchases';
    if (b === 'other_income') return 'pl_other_income';
    return 'pl_costs';
  }
  if (b === 'debtor' || b === 'creditor' || b === 'tax' || b === 'stock') return b;
  if (b === 'bank_od') return 'od';
  const L = S.led.get(k);
  const t = (((L && L.parent) || '') + ' | ' + ((L && L.primary_group) || '')).toLowerCase();
  if (/suspense/.test(t)) return 'suspense';
  if (/fixed\s*assets?|capital\s*work/.test(t)) return 'fixed_assets';
  if (/investments?/.test(t) || /deposits?\s*\(?\s*asset/.test(t)) return 'investments';
  if (/advances?/.test(t)) return 'advances';
  if (/secured\s*loans?|unsecured\s*loans?|loans?\s*\(?\s*liabilit|borrowings?/.test(t)) return 'loans';
  if (/capital|reserves?|surplus|drawings?|partners?|proprietor|retained|profit\s*&?\s*loss/.test(t)) return 'capital';
  if (/current\s*liabilit|provisions?|duties|payable|outstanding/.test(t)) return 'other_payables';
  if (/current\s*assets?|prepaid|receivable/.test(t)) return 'other_assets';
  return 'unsorted';
}

/** Owner view: the same line, filed by what the money was for. GST on an invoice paid in cash belongs to the sale. */
function ownerKey(key, kind) {
  if (key === 'tax') return kind === 'sales' || kind === 'credit_note' ? 'customers' : kind === 'purchase' || kind === 'debit_note' ? 'suppliers' : 'tax';
  if (key === 'debtor' || key === 'pl_sales') return 'customers';
  if (key === 'creditor' || key === 'pl_purchases' || key === 'stock') return 'suppliers';
  if (key === 'pl_costs' || key === 'depreciation') return 'running_costs';
  if (key === 'pl_other_income') return 'other_income';
  return key;
}

const OWNER = [
  { key: 'operating', label: 'From running the business', lines: [
    ['customers', 'Money from customers'], ['suppliers', 'Paid to suppliers'], ['running_costs', 'Salaries, rent and other running costs'],
    ['tax', 'GST and other taxes'], ['other_income', 'Other income'], ['advances', 'Advances given or got back'],
    ['other_payables', 'Other dues and provisions'], ['other_assets', 'Other current assets'], ['suspense', 'Suspense entries'], ['unsorted', 'Not yet sorted']] },
  { key: 'investing', label: 'Assets and investments', lines: [
    ['fixed_assets', 'Equipment, vehicles and other assets'], ['investments', 'Investments and deposits']] },
  { key: 'financing', label: 'Loans and owner’s money', lines: [
    ['od', 'Overdraft and cash credit'], ['loans', 'Loans taken or repaid'], ['capital', 'Owner’s money in or out'], ['interest', 'Interest paid']] }
];
const ACCOUNTANT = [
  { key: 'operating', label: 'Cash from operating activities', lines: [
    ['net_profit', 'Net profit (before the stock adjustment)'], ['add_depreciation', 'Add: depreciation (not cash)'], ['add_interest', 'Add: interest (shown under financing)'],
    ['debtor', '(Increase) / decrease in what customers owe'], ['stock', '(Increase) / decrease in stock'], ['advances', '(Increase) / decrease in advances given'],
    ['other_assets', '(Increase) / decrease in other current assets'], ['creditor', 'Increase / (decrease) in what you owe suppliers'],
    ['tax', 'Increase / (decrease) in GST and taxes owed'], ['other_payables', 'Increase / (decrease) in other dues and provisions'],
    ['suspense', 'Suspense entries'], ['unsorted', 'Not yet sorted']] },
  { key: 'investing', label: 'Cash from investing activities', lines: [
    ['fixed_assets', 'Assets bought (−) or sold (+)'], ['investments', 'Investments and deposits']] },
  { key: 'financing', label: 'Cash from financing activities', lines: [
    ['od', 'Overdraft and cash credit'], ['loans', 'Loans taken (+) or repaid (−)'], ['capital', 'Capital introduced (+) or withdrawn (−)'], ['interest', 'Interest paid']] }
];
const PL_KEYS = new Set(['pl_sales', 'pl_purchases', 'pl_costs', 'pl_other_income', 'interest', 'depreciation']);

/* ------------------------------------------------------------------ daily balances */

/**
 * End-of-day balance (debit-positive) of a set of ledgers for every day from `startKey` to today,
 * walked back from today's balance. Returns { start, values[], at(dayKey) }.
 */
function dailySeries(ctx, S, ledgers, startKey) {
  const keys = new Set(ledgers.map((l) => nk(l.name)));
  let today = 0;
  for (const l of ledgers) { const b = S.balanceOf(l); if (b) today += b.v; }
  const dayMove = new Map();
  for (const r of ctx.rows) {
    let m = 0;
    for (const l of r.lines) if (keys.has(nk(l.ledger))) m += -l.amount;
    if (m) dayMove.set(r.day, (dayMove.get(r.day) || 0) + m);
  }
  const t0 = dms(startKey), t1 = ctx.today.getTime();
  const n = Math.max(1, Math.round((t1 - t0) / DAY) + 1);
  const values = new Array(n);
  let bal = today;
  for (let i = n - 1; i >= 0; i--) {
    values[i] = bal;
    bal -= dayMove.get(dk(t0 + i * DAY)) || 0;
  }
  const at = (key) => { const i = Math.round((dms(key) - t0) / DAY); return values[Math.max(0, Math.min(n - 1, i))]; };
  return { start: startKey, values, at, today };
}

function seriesStart(ctx) {
  const fy = fyStartOf(ctx.today).getTime();
  const first = ctx.coverage && ctx.coverage.from ? ctx.coverage.from.getTime() : fy;
  return dk(Math.min(fy, first) - DAY);
}

/* ------------------------------------------------------------------ 1. the statement */

/**
 * Columns: [{ key, label, from (YYYY-MM-DD), to }]. Returns the statement per column plus a total column
 * (first column's start to the last column's end).
 */
function statement(ctx, columns, opts) {
  const o = opts || {};
  const S = setup(ctx);
  const odAsCash = o.overdraftAsCash !== false && S.od.length > 0;
  const eqLedgers = S.cash.concat(odAsCash ? S.od : []);
  const eqKeys = new Set(eqLedgers.map((l) => nk(l.name)));
  const loanKind = new Map();
  if (!odAsCash) for (const l of S.od) loanKind.set(nk(l.name), 'od');
  for (const l of S.loans) loanKind.set(nk(l.name), 'loans');

  const start = seriesStart(ctx);
  const eq = dailySeries(ctx, S, eqLedgers, start);
  const bank = dailySeries(ctx, S, S.cash, start);
  const odS = odAsCash ? dailySeries(ctx, S, S.od, start) : null;

  const todayKey = dk(ctx.today);
  const cols = columns.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.to > todayKey ? todayKey : c.to, partial: c.to > todayKey || !!c.partial }));
  const total = cols.length ? { key: 'total', label: o.totalLabel || 'Total', from: cols[0].from, to: cols[cols.length - 1].to } : null;
  const all = total ? cols.concat([total]) : cols;
  const blank = () => ({ owner: {}, acct: {}, unbalanced: 0, unbalancedCount: 0, nonCashGap: 0 });
  const acc = all.map(blank);
  const unsortedLedgers = new Map();
  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };

  for (const r of ctx.rows) {
    const idx = [];
    for (let i = 0; i < all.length; i++) if (r.day >= all[i].from && r.day <= all[i].to) idx.push(i);
    if (!idx.length) continue;
    let eqSum = 0, other = 0;
    const parts = [];
    for (const l of r.lines) {
      if (eqKeys.has(nk(l.ledger))) { eqSum += l.amount; continue; }
      const key = lineKey(S, ctx, l, loanKind);
      parts.push([key, l.amount]);
      other += l.amount;
      if ((key === 'unsorted' || key === 'suspense') && Math.abs(l.amount) >= 1) {
        const u = unsortedLedgers.get(l.ledger) || { ledger: l.ledger, amount: 0, entries: 0 };
        u.amount += l.amount; u.entries++; unsortedLedgers.set(l.ledger, u);
      }
    }
    const touchesCash = Math.abs(eqSum) >= 0.5;
    const imbalance = eqSum + other;
    for (const i of idx) {
      const a = acc[i];
      // Accountant view: every entry, cash or not (an invoice moves profit and receivables, and nets to nothing).
      for (const [key, amt] of parts) {
        if (PL_KEYS.has(key)) add(a.acct, 'net_profit', amt);
        if (key === 'depreciation') { add(a.acct, 'add_depreciation', -amt); add(a.acct, 'fixed_assets', amt); }
        else if (key === 'interest') { add(a.acct, 'add_interest', -amt); add(a.acct, 'interest', amt); }
        else if (!PL_KEYS.has(key)) add(a.acct, key, amt);
      }
      if (!touchesCash) { if (Math.abs(imbalance) >= 1) a.nonCashGap += imbalance; continue; }
      // Owner view: entries that moved cash only, each line filed by what it was for.
      for (const [key, amt] of parts) add(a.owner, ownerKey(key, r.kind), amt);
      if (Math.abs(imbalance) >= 1) { a.unbalanced += imbalance; a.unbalancedCount++; }
    }
  }

  const prevDay = (k) => dk(dms(k) - DAY);
  const shape = (defs, i, m) => defs.map((s) => {
    // Every line, in the statement's order (zeros included, so months line up); pages and Margyn skip the empty ones.
    const lines = s.lines.map(([key, label]) => ({ key, label, amount: r0(m[key] || 0) }));
    return { key: s.key, label: s.label, lines, total: r0(lines.reduce((t, x) => t + x.amount, 0)) };
  });
  const out = all.map((c, i) => {
    const opening = eq.at(prevDay(c.from)), closing = eq.at(c.to);
    const owner = shape(OWNER, i, acc[i].owner), accountant = shape(ACCOUNTANT, i, acc[i].acct);
    const ownerNet = owner.reduce((t, s) => t + s.total, 0), acctNet = accountant.reduce((t, s) => t + s.total, 0);
    return {
      key: c.key, label: c.label, from: c.from, to: c.to, partial: !!c.partial,
      opening: r0(opening), closing: r0(closing), change: r0(closing - opening),
      owner, accountant, owner_net: r0(ownerNet), accountant_net: r0(acctNet),
      // What the walk says moved minus what the lines explain: entries whose debits and credits don't agree.
      unexplained: r0(closing - opening - ownerNet),
      unbalanced_entries: acc[i].unbalancedCount,
      made_up_of: odAsCash ? { bank_and_cash: r0(bank.at(c.to)), overdraft_owed: r0(-odS.at(c.to)) } : null
    };
  });

  // Each cash and overdraft ledger walked back to the start of the year, against the opening balance Tally sent.
  const fyKey = dk(fyStartOf(ctx.today));
  const fyMove = new Map();
  for (const r of ctx.rows) if (r.day >= fyKey) for (const l of r.lines) { const k = nk(l.ledger); if (eqKeys.has(k)) fyMove.set(k, (fyMove.get(k) || 0) + l.amount); }
  const gaps = [];
  let checked = 0;
  for (const l of eqLedgers) {
    if (l.closing_balance == null || l.opening_balance == null) continue;
    checked++;
    const walked = S.debitPos(l.closing_balance) + (fyMove.get(nk(l.name)) || 0);
    const gap = walked - S.debitPos(l.opening_balance);
    if (Math.abs(gap) >= Math.max(1, 0.001 * Math.abs(S.debitPos(l.opening_balance)))) gaps.push({ ledger: l.name, tally_opening: r0(S.debitPos(l.opening_balance)), walked_back: r0(walked), gap: r0(gap) });
  }
  const tot = out[out.length - 1] || null;
  const notes = [];
  if (odAsCash) notes.push('Overdraft and cash credit count as cash here (negative cash), as AS-3 allows when the overdraft is how the business runs day to day. Money paid in or out through the overdraft shows as what it was for. Term loans stay under loans.');
  notes.push('Net profit is before the stock adjustment: purchases count when they are bought, so a change in stock is not in it. The cash figures are exact either way.');
  if (unsortedLedgers.size) notes.push('Some ledgers aren\'t in a group Margyn can place (or sit in Suspense), so their money is under “Not yet sorted”. Placing them in Tally or on the Margin page moves them to the right line.');
  if (gaps.length) notes.push(gaps.length + ' cash or overdraft ledger(s) don\'t walk back to the opening balance Tally has for them. Some entries are probably missing from the sync; the statement is short by that much.');
  return {
    as_of: todayKey, basis: 'From every entry in your books that moved cash or an overdraft, worked line by line.',
    overdraft_as_cash: odAsCash,
    cash_ledgers: S.cash.map((l) => l.name), overdraft_ledgers: odAsCash ? S.od.map((l) => l.name) : [],
    columns: out.slice(0, cols.length), total: total ? tot : null,
    checks: {
      ties: !!tot && Math.abs(tot.unexplained) < 1,
      unexplained: tot ? tot.unexplained : 0,
      unbalanced_entries: tot ? tot.unbalanced_entries : 0,
      opening_balances: { checked, gaps },
      views_differ_by: tot ? r0(tot.accountant_net - tot.owner_net) : 0
    },
    unsorted: [...unsortedLedgers.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 8).map((u) => ({ ledger: u.ledger, amount: r0(u.amount), entries: u.entries })),
    notes
  };
}

/** Month by month for this financial year (as far as the books go), with the year so far as the total. */
function yearStatement(ctx, opts) {
  const todayKey = dk(ctx.today);
  let from = fyStartOf(ctx.today);
  if (ctx.coverage && ctx.coverage.from && ctx.coverage.from > from) from = new Date(Date.UTC(ctx.coverage.from.getUTCFullYear(), ctx.coverage.from.getUTCMonth(), 1));
  const cols = [];
  for (let d = from; dk(d) <= todayKey; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const k = dk(d).slice(0, 7);
    cols.push({ key: k, label: monthLabel(k), from: dk(d), to: dk(end) });
  }
  if (!cols.length) return null;
  return statement(ctx, cols, Object.assign({ totalLabel: 'Year so far' }, opts));
}

/* ------------------------------------------------------------------ 2. borrowing history */

/**
 * Every overdraft, cash credit and loan, day by day. limits: { ledgerName: limit ₹ } (optional).
 */
function borrowing(ctx, opts) {
  const o = opts || {};
  const S = setup(ctx);
  const limits = {};
  for (const [k, v] of Object.entries(o.limits || {})) if (num(v) > 0) limits[nk(k)] = num(v);
  const start = seriesStart(ctx);
  const todayKey = dk(ctx.today);
  const fyKey = dk(fyStartOf(ctx.today));
  const accounts = [];
  const rowsByLedger = new Map();
  for (const r of ctx.rows) for (const l of r.lines) {
    const k = nk(l.ledger);
    if (!rowsByLedger.has(k)) rowsByLedger.set(k, []);
    rowsByLedger.get(k).push([r, l]);
  }
  const monthEnds = [];
  for (let d = new Date(dms(fyKey)); dk(d) <= todayKey; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const end = dk(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    monthEnds.push({ month: dk(d).slice(0, 7), day: end > todayKey ? todayKey : end, partial: end > todayKey });
  }
  const shape = (name, group, kind, s, flows, limit) => {
    // owed = minus the debit-positive balance; only this financial year's days count for peak, average and days used
    const i0 = Math.max(0, Math.round((dms(fyKey) - dms(s.start)) / DAY));
    const owed = s.values.map((v) => -v);
    const win = owed.slice(i0);
    let peak = -Infinity, peakAt = 0, low = Infinity, lowAt = 0, used = 0, sum = 0;
    win.forEach((v, j) => { if (v > peak) { peak = v; peakAt = j; } if (v < low) { low = v; lowAt = j; } if (v > 0.5) used++; sum += v; });
    const avg = win.length ? sum / win.length : 0;
    const dayAt = (j) => dk(dms(s.start) + (i0 + j) * DAY);
    const at = (k) => -s.at(k);
    const me = monthEnds.map((m) => ({ month: m.month, owed: r0(at(m.day)), partial: m.partial }));
    let up = 0;
    const done = me.filter((m) => !m.partial);
    for (let j = done.length - 1; j > 0 && done[j].owed > done[j - 1].owed + 1; j--) up++;
    const ch = (days) => r0(at(todayKey) - at(dk(ctx.today.getTime() - days * DAY)));
    const daysCovered = win.length;
    const rate = flows && flows.interest > 0 && avg > 1 ? (flows.interest * 365 / Math.max(30, daysCovered)) / avg : null;
    const out = {
      name, group: group || null, kind, owed_today: r0(at(todayKey)),
      change_30d: ch(30), change_90d: ch(90),
      peak: { owed: r0(peak), date: dayAt(peakAt) }, low: { owed: r0(low), date: dayAt(lowAt) },
      average: r0(avg), days_used: used, days: daysCovered,
      month_end: me, months_up_in_a_row: up,
      series: { start: dayAt(0), owed: win.map(r0) }
    };
    if (flows) Object.assign(out, { paid_out: r0(flows.out), paid_in: r0(flows.in), interest_charged: r0(flows.interest), interest_rate_pct: rate != null && rate < 1 ? Math.round(rate * 1000) / 10 : null });
    if (kind === 'loan') out.trend = out.change_90d < -1 ? 'reducing' : out.change_90d > 1 ? 'growing' : 'flat';
    if (limit) Object.assign(out, { limit: r0(limit), used_pct: Math.round(out.owed_today / limit * 1000) / 10, headroom: r0(limit - out.owed_today), peak_used_pct: Math.round(out.peak.owed / limit * 1000) / 10 });
    return out;
  };

  const all = S.od.map((l) => [l, 'overdraft']).concat(S.loans.map((l) => [l, 'loan']));
  for (const [l, kind] of all) {
    if (!S.balanceOf(l)) continue;
    const s = dailySeries(ctx, S, [l], start);
    // Paid out of / into the account this year, and interest the bank charged straight to it.
    const flows = { out: 0, in: 0, interest: 0 };
    for (const [r, line] of rowsByLedger.get(nk(l.name)) || []) {
      if (r.day < fyKey) continue;
      if (line.amount > 0) {
        if (r.lines.some((x) => x !== line && A.PL_BUCKETS.includes(x.bucket) && isInterestCost(x.ledger))) flows.interest += line.amount;
        else flows.out += line.amount;
      } else flows.in += -line.amount;
    }
    const a = shape(l.name, l.parent, kind, s, flows, limits[nk(l.name)]);
    if (Math.abs(a.owed_today) < 1 && Math.abs(a.peak.owed) < 1 && !a.paid_in && !a.paid_out) continue;
    // EMIs and other repayments already entered for later dates.
    a.upcoming = (ctx.future || []).filter((v) => v && !v.is_cancelled).map((v) => {
      const e = (Array.isArray(v.entries) ? v.entries : []).find((x) => x && x.ledger && nk(x.ledger) === nk(l.name));
      if (!e) return null;
      const d = A.parseDate(v.date);
      return d ? { date: dk(d), amount: r0(-num(e.amount)), what: v.narration ? String(v.narration).replace(/\s+/g, ' ').trim().slice(0, 60) : (v.voucher_type || null) } : null;
    }).filter(Boolean).sort((x, y) => (x.date < y.date ? -1 : 1)).slice(0, 12);
    accounts.push(a);
  }
  accounts.sort((x, y) => y.owed_today - x.owed_today);

  // All borrowing together, and what interest costs as a yearly rate on the average borrowed.
  let interestFy = 0;
  for (const r of ctx.rows) if (r.day >= fyKey) for (const l of r.lines) if (A.PL_BUCKETS.includes(l.bucket) && isInterestCost(l.ledger)) interestFy += -l.amount;
  let total = null;
  if (accounts.length) {
    const n = accounts[0].series.owed.length;
    const owed = new Array(n).fill(0);
    for (const a of accounts) a.series.owed.forEach((v, i) => { owed[i] += v; });
    let peak = -Infinity, peakAt = 0;
    owed.forEach((v, i) => { if (v > peak) { peak = v; peakAt = i; } });
    const avg = owed.reduce((t, v) => t + v, 0) / n;
    const rate = interestFy > 0 && avg > 1 ? (interestFy * 365 / Math.max(30, n)) / avg : null;
    const sumLim = accounts.every((a) => a.limit) ? accounts.reduce((t, a) => t + a.limit, 0) : null;
    total = {
      owed_today: r0(owed[n - 1]), change_30d: r0(accounts.reduce((t, a) => t + a.change_30d, 0)), change_90d: r0(accounts.reduce((t, a) => t + a.change_90d, 0)),
      peak: { owed: r0(peak), date: dk(dms(accounts[0].series.start) + peakAt * DAY) }, average: r0(avg),
      interest_this_fy: r0(interestFy), interest_rate_pct: rate != null && rate < 1 ? Math.round(rate * 1000) / 10 : null,
      month_end: accounts[0].month_end.map((m, i) => ({ month: m.month, owed: accounts.reduce((t, a) => t + a.month_end[i].owed, 0), partial: m.partial })),
      series: { start: accounts[0].series.start, owed: owed.map(r0) },
      limit: sumLim, used_pct: sumLim ? Math.round(owed[n - 1] / sumLim * 1000) / 10 : null, headroom: sumLim ? r0(sumLim - owed[n - 1]) : null
    };
  }
  const notes = [];
  if (accounts.length) notes.push('Each account is today\'s balance walked back through every entry on it, so the history covers the whole year, not just since you started using Margyn.');
  if (total && total.interest_rate_pct != null) notes.push('Cost of borrowing = interest booked this year, turned into a yearly rate, ÷ the average amount borrowed. It includes all interest in your books, so interest on anything else (a supplier\'s late fee, say) makes it look higher.');
  if (accounts.some((a) => a.kind === 'overdraft' && !a.limit)) notes.push('Margyn doesn\'t know your overdraft limit yet. Enter it once and it shows how much of the limit you use and how much is left.');
  return { as_of: todayKey, accounts, total, notes };
}

/* ------------------------------------------------------------------ for Margyn (chat, voice, WhatsApp) */

const inr = (n) => E.inr(n);
function flatSections(sections) {
  const o = {};
  for (const s of sections) {
    o[s.label] = { total: inr(s.total) };
    for (const l of s.lines) if (l.amount || l.key === 'net_profit' || l.key === 'customers') o[s.label][l.label] = inr(l.amount);
  }
  return o;
}

/** cash_flow_statement tool: any period, both views, and month by month when it spans months. */
function cashFlowTool(ctx, args) {
  const a = args || {};
  const per = E.resolvePeriod(a.period || (a.from || a.to ? { from: a.from, to: a.to } : 'this_fy'), ctx.now);
  const st = statement(ctx, [{ key: 'p', label: per.label, from: per.fromISO, to: per.toISO }]);
  const c = st.columns[0];
  const out = {
    period: per.label, source: 'From your books, every entry that moved cash or an overdraft.',
    opening_cash: inr(c.opening), closing_cash: inr(c.closing), change: inr(c.change),
    owner_view: flatSections(c.owner),
    accountant_view: flatSections(c.accountant),
    ties_out: Math.abs(c.unexplained) < 1 ? 'yes' : 'no: ' + inr(c.unexplained) + ' isn\'t explained by the entries (' + c.unbalanced_entries + ' entries don\'t balance)',
    notes: st.notes
  };
  if (c.made_up_of) out.closing_made_up_of = { bank_and_cash: inr(c.made_up_of.bank_and_cash), overdraft_owed: inr(c.made_up_of.overdraft_owed) };
  if (per.fromISO.slice(0, 7) !== per.toISO.slice(0, 7)) {
    const y = yearStatement(ctx);
    if (y) out.by_month = y.columns.filter((m) => m.to >= per.fromISO && m.from <= per.toISO).map((m) => ({
      month: m.label + (m.partial ? ' (so far)' : ''), operating: inr(m.owner[0].total), investing: inr(m.owner[1].total), financing: inr(m.owner[2].total), net: inr(m.change), closing_cash: inr(m.closing)
    }));
  }
  if (st.unsorted.length) out.not_yet_sorted = st.unsorted.slice(0, 5).map((u) => ({ ledger: u.ledger, amount: inr(u.amount) }));
  if (st.checks.opening_balances.gaps.length) out.missing_entries_warning = st.checks.opening_balances.gaps.map((g) => g.ledger + ': ' + inr(g.gap)).join('; ');
  return out;
}

/** borrowing_history tool: each overdraft and loan over the year. */
function borrowingTool(ctx, args, limits) {
  const b = borrowing(ctx, { limits });
  if (!b.accounts.length) return { note: 'No overdraft, cash credit or loan accounts with a balance in the books.' };
  const q = String((args && args.account) || '').toLowerCase();
  const pick = q ? b.accounts.filter((a) => a.name.toLowerCase().includes(q)) : b.accounts;
  const day = (k) => E.dayStr(new Date(dms(k)), true);
  return {
    source: 'Each account walked back from today\'s balance through every entry this year.',
    total: b.total ? {
      owed_today: inr(b.total.owed_today), change_last_30_days: inr(b.total.change_30d), change_last_90_days: inr(b.total.change_90d),
      peak_this_year: inr(b.total.peak.owed) + ' on ' + day(b.total.peak.date), average_this_year: inr(b.total.average),
      interest_this_year: inr(b.total.interest_this_fy), cost_of_borrowing_yearly: b.total.interest_rate_pct != null ? b.total.interest_rate_pct + '%' : 'not enough interest booked to say',
      limit_used: b.total.used_pct != null ? b.total.used_pct + '% of ' + inr(b.total.limit) + ', ' + inr(b.total.headroom) + ' left' : undefined
    } : undefined,
    accounts: (pick.length ? pick : b.accounts).slice(0, 6).map((a) => ({
      account: a.name, type: a.kind === 'overdraft' ? 'overdraft / cash credit' : 'loan', owed_today: inr(a.owed_today),
      change_last_30_days: inr(a.change_30d), change_last_90_days: inr(a.change_90d),
      peak_this_year: inr(a.peak.owed) + ' on ' + day(a.peak.date), lowest_this_year: inr(a.low.owed) + ' on ' + day(a.low.date), average_this_year: inr(a.average),
      days_used: a.kind === 'overdraft' ? a.days_used + ' of ' + a.days + ' days' : undefined,
      paid_out_of_it_this_year: inr(a.paid_out), paid_into_it_this_year: inr(a.paid_in),
      interest_charged_to_it: a.interest_charged ? inr(a.interest_charged) : undefined,
      cost_yearly: a.interest_rate_pct != null ? a.interest_rate_pct + '%' : undefined,
      trend: a.trend, month_end: a.month_end.map((m) => monthLabel(m.month) + (m.partial ? ' (today)' : '') + ': ' + inr(m.owed)),
      higher_each_month_for: a.months_up_in_a_row >= 2 ? a.months_up_in_a_row + ' months' : undefined,
      limit: a.limit ? inr(a.limit) + ' (' + a.used_pct + '% used, ' + inr(a.headroom) + ' left; peak ' + a.peak_used_pct + '%)' : undefined,
      already_entered_for_later: a.upcoming.length ? a.upcoming.slice(0, 6).map((u) => day(u.date) + ' ' + inr(u.amount)) : undefined
    })),
    notes: b.notes
  };
}

module.exports = { statement, yearStatement, borrowing, cashFlowTool, borrowingTool, lineKey, ownerKey, isInterestCost, OWNER, ACCOUNTANT };
