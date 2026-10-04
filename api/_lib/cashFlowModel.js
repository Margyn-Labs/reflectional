/**
 * _lib/cashFlowModel.js
 * How money actually moves through the business, and a 13-week cash forecast learned from it (2026-10-04).
 *
 * The first forecast (app/js/19a-forecast.js) assumed: every customer pays 15 days late, one flat monthly
 * sales figure from week 9, costs spread evenly, GST on the 20th. This one learns from the books instead:
 *
 *  1. Movements: every entry that touches a bank or cash account, filed by what it was for (customers,
 *     suppliers, running costs, tax, loans and transfers), and the balance of cash, receivables and payables
 *     at the end of every day this year.
 *  2. How each customer really pays: their receipts are matched to their invoices oldest-first (FIFO), giving
 *     days from invoice to money in, weighted by amount: the middle (p50) and the spread (p25, p75).
 *     Customers with too little history use everyone's pattern.
 *  3. Recurring payments: the same account paid in at least 3 of the last 4 months, similar amounts, around
 *     the same day (salaries, rent, EMIs, partner pay), forecast on that day.
 *  4. Known items: entries already in the books for later dates (EMIs entered ahead), GST from the books on
 *     the 20th, and customers' promises to pay (from payment chases) on the promised date.
 *  5. Pace: recent weekly sales (collected the way customers actually pay), supplier payments and other
 *     running costs, from the last 8 complete weeks (median, so one odd week doesn't swing it).
 *  6. A range: likely / cautious / hopeful, from each customer's own spread.
 *  7. It checks itself: the same model run as of 4, 8 and 12 weeks ago, using only what was known then,
 *     against what actually happened. If customers paid less than it expected, it scales collections by the
 *     ratio it saw (bounded), and says so.
 *
 * Pure: takes a booksEngine ctx (prepare()) and plain inputs, returns plain data. No I/O.
 * Conventions: entry amounts are debit-negative; money into the bank = -amount on a bank/cash line.
 * CommonJS, zero-npm.
 */

const DAY = 86400000;
const HORIZON_DAYS = 91;
const WEEKS = 13;
const CASH = new Set(['bank', 'cash']);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(num(n));
const keyOf = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/&#(1[03]|x0?[ad]);/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (k) => Date.parse(String(k).slice(0, 10) + 'T00:00:00Z');
const median = (a) => { const s = a.slice().sort((x, y) => x - y); if (!s.length) return 0; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Weighted percentile of [{v, w}]. */
function wPct(samples, p) {
  const s = samples.filter((x) => x.w > 0).sort((a, b) => a.v - b.v);
  const tot = s.reduce((t, x) => t + x.w, 0);
  if (!tot) return null;
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= p * tot) return x.v; }
  return s[s.length - 1].v;
}

const CATEGORY_OF = {
  debtor: 'customers', sales: 'customers', creditor: 'suppliers', purchases: 'suppliers', tax: 'tax',
  opex: 'running_costs', direct_expense: 'running_costs', direct_income: 'other_income', other_income: 'other_income',
  bank_od: 'transfers_loans', balance_sheet: 'transfers_loans', stock: 'transfers_loans'
};
const CATEGORY_LABEL = {
  customers: 'From customers', suppliers: 'To suppliers', running_costs: 'Running costs', tax: 'GST and taxes',
  transfers_loans: 'Loans, overdraft and transfers', other_income: 'Other income', other: 'Other'
};

/* ------------------------------------------------------------------ 1. movements */

/** One event per entry that moved money in or out of the bank: { ms, day, amount (+in/−out), category, ledger, party }. */
function cashEvents(ctx, rows) {
  const out = [];
  for (const r of rows || ctx.rows) {
    let move = 0;
    const others = [];
    for (const l of r.lines) { if (CASH.has(l.bucket)) move += -l.amount; else others.push(l); }
    if (Math.abs(move) < 0.5) continue;   // a transfer between two bank accounts nets to nothing
    const top = others.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    out.push({ ms: r.dt.getTime(), day: r.day, amount: move, category: (top && CATEGORY_OF[top.bucket]) || 'other', ledger: top ? top.ledger : null, party: r.party || null, kind: r.kind });
  }
  return out;
}

/** The same for entries dated after today (already in the books: EMIs, post-dated cheques). */
function futureEvents(ctx) {
  const out = [];
  for (const v of ctx.future || []) {
    if (!v || v.is_cancelled === true) continue;
    const ms = dayMs(String(v.date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
    if (!Number.isFinite(ms)) continue;
    let move = 0; const others = [];
    for (const e of Array.isArray(v.entries) ? v.entries : []) {
      if (!e || !e.ledger) continue;
      const b = ctx.cls(e.ledger);
      if (CASH.has(b)) move += -num(e.amount); else others.push({ ledger: e.ledger, bucket: b, amount: num(e.amount) });
    }
    if (Math.abs(move) < 0.5) continue;
    const top = others.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    out.push({ ms, day: dayKey(ms), amount: move, category: (top && CATEGORY_OF[top.bucket]) || 'other', ledger: top ? top.ledger : null, party: v.party_name || null, narration: v.narration || null });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function balanceSign(ctx) {
  const conv = (((ctx.analytics || {}).quality || {}).balance_sign || {}).convention;
  const eff = !conv || conv === 'unknown' ? 'opposite' : conv;
  return (b) => (eff === 'same' ? -num(b) : num(b));
}

/** Today's balance of every customer and supplier account (debit-positive), from the ledgers. */
function partyBalancesToday(ctx) {
  const debitPos = balanceSign(ctx);
  const move = new Map();
  for (const r of ctx.rows) for (const l of r.lines) { const k = keyOf(l.ledger); move.set(k, (move.get(k) || 0) + l.amount); }
  const out = new Map();   // key -> { name, bucket, balance, opening }
  for (const l of ctx.ledgers || []) {
    const b = ctx.cls(l.name);
    if (b !== 'debtor' && b !== 'creditor') continue;
    let bal = null;
    if (l.closing_balance != null) bal = debitPos(l.closing_balance);
    else if (l.opening_balance != null) bal = debitPos(l.opening_balance) - (move.get(keyOf(l.name)) || 0);
    out.set(keyOf(l.name), { name: l.name, bucket: b, balance: bal, opening: l.opening_balance != null ? debitPos(l.opening_balance) : null });
  }
  return out;
}

/**
 * End-of-week cash, receivables and payables for the year, and days to collect.
 * Cash from analytics.cash_history; receivables/payables walked back from today's ledger balances.
 */
function positionHistory(ctx) {
  const pts = (((ctx.analytics || {}).cash_history) || {}).points || [];
  if (!pts.length) return null;
  const bal = partyBalancesToday(ctx);
  let recvToday = 0, payToday = 0;
  for (const x of bal.values()) { if (x.balance == null) continue; if (x.bucket === 'debtor') recvToday += x.balance; else payToday += -x.balance; }
  const recvMove = new Map(), payMove = new Map(), salesDay = new Map();
  for (const r of ctx.rows) {
    for (const l of r.lines) {
      if (l.bucket === 'debtor') recvMove.set(r.day, (recvMove.get(r.day) || 0) - l.amount);
      if (l.bucket === 'creditor') payMove.set(r.day, (payMove.get(r.day) || 0) + l.amount);
    }
    if (r.kind === 'sales') salesDay.set(r.day, (salesDay.get(r.day) || 0) + r.total);
    if (r.kind === 'credit_note') salesDay.set(r.day, (salesDay.get(r.day) || 0) - r.total);
  }
  const days = pts.map((p) => p.date);
  let recv = recvToday, pay = payToday;
  const byDay = new Map();
  for (let i = days.length - 1; i >= 0; i--) {
    byDay.set(days[i], { recv, pay });
    recv -= recvMove.get(days[i]) || 0;
    pay -= payMove.get(days[i]) || 0;
  }
  const salesCum = []; let acc = 0;
  for (const d of days) { acc += salesDay.get(d) || 0; salesCum.push(acc); }
  const weekly = [];
  for (let i = days.length - 1; i >= 0; i -= 7) {
    const d = days[i], b = byDay.get(d);
    const from = Math.max(0, i - 90);
    const sales90 = salesCum[i] - (from > 0 ? salesCum[from - 1] : 0);
    const spanDays = i - from + 1;
    weekly.push({ date: d, cash: r0(pts[i].cash), receivables: r0(b.recv), payables: r0(b.pay),
      // Days to collect: what customers owe over the last 90 days' sales per day (needs 60+ days of history).
      days_to_collect: spanDays >= 60 && sales90 > 0 ? Math.round(b.recv / (sales90 / spanDays)) : null });
  }
  return { weeks: weekly.reverse(), receivables_today: r0(recvToday), payables_today: r0(payToday) };
}

/* ------------------------------------------------------------------ 2. how customers pay */

/**
 * FIFO: each customer's receipts and credits settle their oldest open invoices first.
 * Only entries on or before `cutMs` are used, so the same function rebuilds the past (for self-checks).
 * Returns { parties: Map key -> { name, open:[{ms|null, amt}], samples:[{v:days, w:amt}], lastReceiptMs }, pool:[{v,w}] }.
 */
function customerHabits(ctx, cutMs) {
  const debitPos = balanceSign(ctx);
  const parties = new Map();
  const P = (name) => {
    const k = keyOf(name);
    if (!parties.has(k)) parties.set(k, { name, open: [], advance: 0, samples: [], lastReceiptMs: null });
    return parties.get(k);
  };
  for (const l of ctx.ledgers || []) {
    if (ctx.cls(l.name) !== 'debtor' || l.opening_balance == null) continue;
    const ob = debitPos(l.opening_balance);
    if (ob > 0.5) P(l.name).open.push({ ms: null, amt: ob });   // carried from last year: date unknown
    else if (ob < -0.5) P(l.name).advance += -ob;
  }
  for (const r of ctx.rows) {
    const ms = r.dt.getTime();
    if (ms > cutMs) break;   // rows are in date order
    const cashIn = r.lines.some((l) => CASH.has(l.bucket));
    for (const l of r.lines) {
      if (l.bucket !== 'debtor') continue;
      const p = P(l.ledger);
      if (l.amount < 0) {   // debit: they owe more (an invoice)
        let amt = -l.amount;
        if (p.advance > 0) { const use = Math.min(p.advance, amt); p.advance -= use; amt -= use; if (cashIn === false && use > 0) p.samples.push({ v: 0, w: use }); }
        if (amt > 0.5) p.open.push({ ms, amt });
      } else if (l.amount > 0) {   // credit: paid (or a credit note / write-off)
        let amt = l.amount;
        if (cashIn) p.lastReceiptMs = ms;
        while (amt > 0.5 && p.open.length) {
          const inv = p.open[0], use = Math.min(inv.amt, amt);
          if (cashIn && inv.ms != null) p.samples.push({ v: Math.max(0, Math.round((ms - inv.ms) / DAY)), w: use });
          inv.amt -= use; amt -= use;
          if (inv.amt <= 0.5) p.open.shift();
        }
        if (amt > 0.5) p.advance += amt;
      }
    }
  }
  const pool = [];
  for (const p of parties.values()) pool.push(...p.samples);
  return { parties, pool };
}

function habitOf(p, pool) {
  const own = p && p.samples.length >= 3 && p.samples.reduce((t, s) => t + s.w, 0) > 0;
  const s = own ? p.samples : pool;
  if (!s.length) return { p25: 30, p50: 45, p75: 75, own: false, n: 0 };
  return { p25: wPct(s, 0.25), p50: wPct(s, 0.5), p75: wPct(s, 0.75), own, n: own ? p.samples.length : 0 };
}

/* ------------------------------------------------------------------ 3. recurring payments */

function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }
function addMonths(k, n) { const [y, m] = k.split('-').map(Number); const t = y * 12 + m - 1 + n; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); }

/** Accounts paid in at least 3 of the last 4 complete months, similar amounts, around the same day. */
function recurringPayments(events, todayMs, exclude) {
  const thisMonth = monthKey(todayMs);
  const months = [1, 2, 3, 4].map((n) => addMonths(thisMonth, -n));
  const by = new Map();
  for (const e of events) {
    if (e.amount >= 0 || !e.ledger || e.ms > todayMs) continue;
    if (!['running_costs', 'transfers_loans', 'other', 'suppliers'].includes(e.category)) continue;
    const k = keyOf(e.ledger);
    if (exclude && exclude.has(k)) continue;
    const mk = monthKey(e.ms);
    if (!months.includes(mk) && mk !== thisMonth) continue;
    if (!by.has(k)) by.set(k, { ledger: e.ledger, category: e.category, months: new Map() });
    const m = by.get(k).months;
    if (!m.has(mk)) m.set(mk, { total: 0, days: [] });
    const x = m.get(mk); x.total += -e.amount; x.days.push({ d: new Date(e.ms).getUTCDate(), a: -e.amount });
  }
  const out = [];
  for (const x of by.values()) {
    const seen = months.filter((m) => x.months.has(m));
    if (seen.length < 3) continue;
    const totals = seen.map((m) => x.months.get(m).total);
    const med = median(totals);
    if (med < 1000) continue;
    const spread = Math.max(...totals.map((t) => Math.abs(t - med))) / med;
    if (spread > 0.35) continue;
    const mainDays = seen.map((m) => x.months.get(m).days.sort((a, b) => b.a - a.a)[0].d);
    const day = Math.round(median(mainDays));
    if (Math.max(...mainDays) - Math.min(...mainDays) > 8) continue;
    const paidThisMonth = x.months.has(thisMonth) ? x.months.get(thisMonth).total : 0;
    out.push({ ledger: x.ledger, category: x.category, amount: r0(med), day_of_month: day, months_seen: seen.length, paid_this_month: r0(paidThisMonth) });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/* ------------------------------------------------------------------ 5. pace */

/** Median of the last 8 complete weeks (Mon–Sun) of a daily amount map, before `todayMs`. */
function weeklyPace(amountByMs, todayMs) {
  const dow = (new Date(todayMs).getUTCDay() + 6) % 7;
  const weekStart = todayMs - dow * DAY;
  const weeks = [];
  for (let w = 1; w <= 8; w++) {
    const from = weekStart - w * 7 * DAY, to = from + 7 * DAY;
    let t = 0;
    for (const [ms, a] of amountByMs) if (ms >= from && ms < to) t += a;
    weeks.push(t);
  }
  return { median: median(weeks), weeks };
}

/* ------------------------------------------------------------------ 4–6. the forecast */

const SCEN = ['mid', 'low', 'high'];

/**
 * @param {object} ctx           booksEngine.prepare() context
 * @param {object} o
 * @param {number} o.asOfMs      forecast from this day (UTC midnight of the India date). Default: ctx.today.
 * @param {number} o.opening     cash at the end of the day before asOf (default: books cash today / history)
 * @param {Array}  [o.openItems] [{party, amt, ageDays}] open invoices; default: Tally bills (live) or FIFO (past)
 * @param {Array}  [o.promises]  [{party, amount, date}] promises to pay
 * @param {number} [o.collectionFactor] learned scale on customer money in (self-check)
 * @param {boolean}[o.useFuture] include entries already in the books for later dates (live only)
 */
function forecast(ctx, o) {
  const asOfMs = o.asOfMs;
  const cut = asOfMs - 1;
  const rows = ctx.rows.filter((r) => r.dt.getTime() <= cut);
  const events = cashEvents(ctx, rows);
  const habits = customerHabits(ctx, cut);
  const f = o.collectionFactor || 1;
  const days = SCEN.reduce((m, s) => { m[s] = { in: new Array(HORIZON_DAYS).fill(0), out: new Array(HORIZON_DAYS).fill(0) }; return m; }, {});
  const parts = {};   // part -> mid total
  const custIn = new Array(HORIZON_DAYS).fill(0);   // money in from customers (mid), for the self-check
  const put = (scen, dir, d, amt, part) => {
    const i = Math.round(d);
    if (i < 0 || i >= HORIZON_DAYS || !amt) return;
    days[scen][dir][i] += amt;
    if (scen === 'mid') {
      parts[part] = (parts[part] || 0) + (dir === 'in' ? amt : -amt);
      if (dir === 'in' && (part === 'customers_open' || part === 'customers_new' || part === 'promised')) custIn[i] += amt;
    }
  };
  const spread = (scen, dir, from, to, amt, part) => { const n = Math.max(1, to - from + 1); for (let d = from; d <= to; d++) put(scen, dir, d, amt / n, part); };

  // --- money in: open invoices, on each customer's own habit ---
  let open = o.openItems;
  if (!open) {
    open = [];
    for (const p of habits.parties.values()) for (const inv of p.open) open.push({ party: p.name, amt: inv.amt, ageDays: inv.ms == null ? 400 : Math.round((asOfMs - inv.ms) / DAY) });
  }
  // Promises first: they take the customer's oldest open amount.
  const promisedBy = new Map();
  for (const pr of o.promises || []) {
    const due = Math.max(0, Math.round((dayMs(pr.date) - asOfMs) / DAY));
    if (!Number.isFinite(due) || due > HORIZON_DAYS) continue;
    const amt = num(pr.amount);
    if (amt <= 0) continue;
    promisedBy.set(keyOf(pr.party), (promisedBy.get(keyOf(pr.party)) || 0) + amt);
    put('mid', 'in', due, amt, 'promised'); put('high', 'in', due, amt, 'promised'); put('low', 'in', due + 7, amt, 'promised');
  }
  const doubtful = { amount: 0, parties: new Map() };
  const customerRows = new Map();
  for (const it of open.slice().sort((a, b) => b.ageDays - a.ageDays)) {
    const k = keyOf(it.party);
    let amt = num(it.amt);
    const pr = promisedBy.get(k) || 0;
    if (pr > 0) { const use = Math.min(pr, amt); promisedBy.set(k, pr - use); amt -= use; }
    if (amt <= 0.5) continue;
    const h = habitOf(habits.parties.get(k), habits.pool);
    const cutoff = Math.max(180, 2 * (h.p75 || 0));
    if (it.ageDays > Math.min(365, cutoff)) { doubtful.amount += amt; doubtful.parties.set(it.party, (doubtful.parties.get(it.party) || 0) + amt); continue; }
    const a = amt * f;
    const c = customerRows.get(k) || { party: it.party, open: 0, expected_13w: 0, habit_days: h.p50, own_history: h.own, invoices: 0 };
    c.open += amt; c.invoices++;
    const plan = { mid: h.p50 - it.ageDays, low: h.p75 - it.ageDays, high: h.p25 - it.ageDays };
    for (const s of SCEN) {
      const rem = plan[s];
      if (rem >= 0) { put(s, 'in', rem, a, 'customers_open'); if (s === 'mid' && rem < HORIZON_DAYS) c.expected_13w += a; }
      else if (s === 'mid') { spread(s, 'in', 0, 27, a, 'customers_open'); c.expected_13w += a; }
      else if (s === 'low') spread(s, 'in', 14, 55, a, 'customers_open');
      else spread(s, 'in', 0, 13, a, 'customers_open');
    }
    customerRows.set(k, c);
  }

  // --- money in: new sales, collected the way customers actually pay ---
  const salesByMs = new Map();
  for (const r of rows) {
    if (r.kind !== 'sales' && r.kind !== 'credit_note') continue;
    const ms = r.dt.getTime();
    salesByMs.set(ms, (salesByMs.get(ms) || 0) + (r.kind === 'sales' ? r.total : -r.total));
  }
  const salesPace = weeklyPace(salesByMs, asOfMs);
  const q = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => wPct(habits.pool, p));
  const lags = q.every((x) => x != null) ? q : [20, 35, 45, 60, 90];
  const lagScale = { mid: 1, low: 1.25, high: 0.85 }, salesScale = { mid: 1, low: 0.9, high: 1 };
  for (const s of SCEN) {
    const perDay = salesPace.median / 7 * salesScale[s] * f;
    for (let d = 0; d < HORIZON_DAYS; d++) for (const L of lags) put(s, 'in', d + Math.round(L * lagScale[s]), perDay / lags.length, 'customers_new');
  }

  // --- money out: entries already in the books for later dates (EMIs entered ahead) ---
  const known = o.useFuture ? futureEvents(ctx).filter((e) => e.ms >= asOfMs) : [];
  const knownLedgers = new Set(known.map((e) => keyOf(e.ledger)));
  for (const e of known) for (const s of SCEN) put(s, e.amount > 0 ? 'in' : 'out', Math.round((e.ms - asOfMs) / DAY), Math.abs(e.amount), 'known_ahead');

  // --- money out: recurring payments on their day ---
  const recurring = recurringPayments(events, cut, knownLedgers);
  const recurringKeys = new Set(recurring.map((x) => keyOf(x.ledger)));
  const asOfDate = new Date(asOfMs);
  for (const rc of recurring) {
    for (let m = 0; m < 4; m++) {
      const y = asOfDate.getUTCFullYear(), mo = asOfDate.getUTCMonth() + m;
      const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const when = Date.UTC(y, mo, Math.min(rc.day_of_month, last));
      let amt = rc.amount;
      if (m === 0) { amt = Math.max(0, rc.amount - rc.paid_this_month); if (when < asOfMs) { if (amt < 0.5 * rc.amount) continue; } }
      const d = Math.max(0, Math.round((when - asOfMs) / DAY));
      for (const s of SCEN) put(s, 'out', d, amt * (s === 'low' ? 1.05 : 1), 'recurring');
    }
  }

  // --- money out: suppliers and other running costs, at their recent pace ---
  const supByMs = new Map(), otherByMs = new Map();
  for (const e of events) {
    if (e.amount >= 0) continue;
    if (e.category === 'suppliers' && !recurringKeys.has(keyOf(e.ledger))) supByMs.set(e.ms, (supByMs.get(e.ms) || 0) - e.amount);
    if (e.category === 'running_costs' && !recurringKeys.has(keyOf(e.ledger))) otherByMs.set(e.ms, (otherByMs.get(e.ms) || 0) - e.amount);
  }
  const supPace = weeklyPace(supByMs, asOfMs), otherPace = weeklyPace(otherByMs, asOfMs);
  for (const s of SCEN) for (let d = 0; d < HORIZON_DAYS; d++) {
    put(s, 'out', d, supPace.median / 7 * (s === 'low' ? 1.1 : s === 'high' ? 0.95 : 1), 'suppliers');
    put(s, 'out', d, otherPace.median / 7, 'running_costs');
  }

  // --- money out: GST on the 20th, from the books ---
  const gstRows = ((ctx.analytics || {}).gst_estimate || []).filter((g) => g.month < monthKey(asOfMs));
  const lastGst = gstRows.slice(-1)[0];
  const gstTypical = median(gstRows.slice(-3).map((g) => Math.max(0, num(g.net_payable_estimate))));
  const taxPaidThisMonth = events.filter((e) => e.category === 'tax' && e.amount < 0 && monthKey(e.ms) === monthKey(asOfMs)).reduce((t, e) => t - e.amount, 0);
  for (let m = 0; m < 4; m++) {
    const when = Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + m, 20);
    if (when < asOfMs) continue;
    let amt = m === 0 && lastGst ? Math.max(0, num(lastGst.net_payable_estimate)) : gstTypical;
    if (m === 0) amt = Math.max(0, amt - taxPaidThisMonth);
    for (const s of SCEN) put(s, 'out', Math.round((when - asOfMs) / DAY), amt, 'gst');
  }

  // --- roll up ---
  const opening = num(o.opening);
  const close = {};
  for (const s of SCEN) { let c = opening; close[s] = days[s].in.map((x, i) => (c += x - days[s].out[i])); }
  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const a = w * 7, b = a + 7;
    const sum = (arr) => arr.slice(a, b).reduce((t, x) => t + x, 0);
    weeks.push({ n: w + 1, from: dayKey(asOfMs + a * DAY), to: dayKey(asOfMs + (b - 1) * DAY),
      in: r0(sum(days.mid.in)), out: r0(sum(days.mid.out)), close: r0(close.mid[b - 1]), low: r0(close.low[b - 1]), high: r0(close.high[b - 1]) });
  }
  return {
    as_of: dayKey(asOfMs), opening: r0(opening), weeks,
    daily: { close: close.mid.map(r0), low: close.low.map(r0), high: close.high.map(r0) },
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r0(v)])),
    customer_in_weeks: weeks.map((w, i) => r0(custIn.slice(i * 7, i * 7 + 7).reduce((t, x) => t + x, 0))),
    drivers: {
      customers: [...customerRows.values()].sort((a, b) => b.expected_13w - a.expected_13w).slice(0, 12)
        .map((c) => ({ party: c.party, open: r0(c.open), expected_13w: r0(c.expected_13w), habit_days: c.habit_days, own_history: c.own_history })),
      doubtful: { amount: r0(doubtful.amount), parties: [...doubtful.parties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([party, amt]) => ({ party, amount: r0(amt) })) },
      recurring: recurring.slice(0, 12),
      known_ahead: known.slice(0, 12).map((e) => ({ date: e.day, amount: r0(e.amount), ledger: e.ledger, party: e.party })),
      pace: { sales_weekly: r0(salesPace.median), suppliers_weekly: r0(supPace.median), running_costs_weekly: r0(otherPace.median) },
      collection_days: { p25: q[0] != null ? wPct(habits.pool, 0.25) : null, p50: q[2], p75: q[0] != null ? wPct(habits.pool, 0.75) : null },
      gst_next: lastGst ? { month: lastGst.month, amount: r0(Math.max(0, num(lastGst.net_payable_estimate) - taxPaidThisMonth)) } : null
    }
  };
}

/* ------------------------------------------------------------------ 7. self-check */

/**
 * Run the model as of 4, 8 and 12 weeks ago with only what was known then (open invoices rebuilt oldest-first,
 * no promises, no entries made ahead), and compare its first four weeks with what happened: cash at the end of
 * week 4, and money in from customers. If customers paid less (or more) than it expected, the live forecast
 * scales customer money in by the ratio seen (bounded 0.6–1.3).
 */
function selfCheck(ctx) {
  const pts = (((ctx.analytics || {}).cash_history) || {}).points || [];
  if (pts.length < 120) return { checks: [], collection_factor: 1 };
  const cashAt = new Map(pts.map((p) => [p.date, num(p.cash)]));
  const todayMs = ctx.today.getTime();
  const checks = [];
  for (const back of [28, 56, 84]) {
    const asOfMs = todayMs - back * DAY;
    const prev = cashAt.get(dayKey(asOfMs - DAY));
    const actualEnd = cashAt.get(dayKey(asOfMs + 27 * DAY));
    if (prev == null || actualEnd == null) continue;
    const fc = forecast(ctx, { asOfMs, opening: prev });
    let actIn = 0;
    const win = ctx.rows.filter((r) => { const ms = r.dt.getTime(); return ms >= asOfMs && ms < asOfMs + 28 * DAY; });
    for (const e of cashEvents(ctx, win)) if (e.category === 'customers' && e.amount > 0) actIn += e.amount;
    const predEnd = fc.daily.close[27];
    checks.push({ as_of: fc.as_of, horizon_days: 28, predicted_cash: r0(predEnd), actual_cash: r0(actualEnd), cash_error: r0(predEnd - actualEnd),
      predicted_customer_in: r0(fc.customer_in_weeks.slice(0, 4).reduce((t, x) => t + x, 0)), actual_customer_in: r0(actIn) });
  }
  const pred = checks.reduce((t, c) => t + c.predicted_customer_in, 0), act = checks.reduce((t, c) => t + c.actual_customer_in, 0);
  const factor = checks.length >= 2 && pred > 0 ? Math.max(0.6, Math.min(1.3, act / pred)) : 1;
  return { checks, collection_factor: Math.round(factor * 100) / 100 };
}

/**
 * Everything the app needs, live: movements history, the forecast (learned, self-checked), and what it used.
 * @param {object} ctx  booksEngine ctx
 * @param {object} [o]  { promises:[{party, amount, date}], openItems (default: Tally bills), pastRuns (stored forecasts) }
 */
function build(ctx, o) {
  const opts = o || {};
  const todayMs = ctx.today.getTime();
  const cash = (ctx.analytics || {}).cash;
  if (!cash) return null;
  const check = selfCheck(ctx);
  // Today's open invoices: Tally's bill-wise list when it has them (exact dates), else rebuilt oldest-first.
  const bills = (ctx.bills || []).filter((b) => b.direction !== 'payable' && !b.advance && Math.abs(num(b.closing_balance)) > 0.5);
  const openItems = opts.openItems || (bills.length ? bills.map((b) => {
    const d = b.bill_date ? dayMs(String(b.bill_date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) : NaN;
    return { party: b.party_name, amt: Math.abs(num(b.closing_balance)), ageDays: Number.isFinite(d) ? Math.round((todayMs - d) / DAY) : (b.overdue_days != null ? num(b.overdue_days) + 30 : 400) };
  }) : null);
  const fc = forecast(ctx, { asOfMs: todayMs, opening: num(cash.total), openItems, promises: opts.promises || [], collectionFactor: check.collection_factor, useFuture: true });
  const hist = positionHistory(ctx);
  const notes = [];
  if (check.collection_factor !== 1) notes.push(`Checked against the last ${check.checks.length * 4} weeks: customers paid ${Math.round(check.collection_factor * 100)}% of what this forecast would have expected, so money in from customers is scaled to match.`);
  if (fc.drivers.doubtful.amount) notes.push(`₹${fc.drivers.doubtful.amount.toLocaleString('en-IN')} owed for more than six months (or far longer than that customer usually takes) is left out.`);
  if (((ctx.analytics || {}).working_capital || {}).suppliers_tracked_billwise === false) notes.push('Your suppliers aren’t kept bill by bill, so supplier payments follow your recent weekly pace rather than due dates.');
  notes.push('Loan drawdowns, overdraft movements and transfers are left out unless they repeat monthly or are already entered for a later date.');
  return { version: 2, ...fc, history: hist ? hist.weeks : [], receivables_today: hist ? hist.receivables_today : null, payables_today: hist ? hist.payables_today : null,
    self_check: check, notes, accuracy: accuracyFromRuns(opts.pastRuns || [], (ctx.analytics.cash_history || {}).points || []) };
}

/**
 * How stored forecasts (forecast_runs) did once their dates passed: for each past run, predicted vs actual cash
 * 7 and 28 days on. The record the forecast earns its trust from.
 */
function accuracyFromRuns(runs, points) {
  const cashAt = new Map(points.map((p) => [p.date, num(p.cash)]));
  const out = [];
  for (const run of runs) {
    const daily = run && run.daily_close;
    if (!Array.isArray(daily) || !run.run_date) continue;
    for (const h of [7, 28]) {
      const target = dayKey(dayMs(run.run_date) + (h - 1) * DAY);
      if (!cashAt.has(target) || daily[h - 1] == null) continue;
      out.push({ run_date: run.run_date, horizon_days: h, predicted: r0(daily[h - 1]), actual: r0(cashAt.get(target)), error: r0(daily[h - 1] - cashAt.get(target)) });
    }
  }
  return out.slice(-20);
}

module.exports = { build, accuracyFromRuns, cashEvents, futureEvents, positionHistory, customerHabits, habitOf, recurringPayments, weeklyPace, forecast, selfCheck, wPct, CATEGORY_LABEL, HORIZON_DAYS };
