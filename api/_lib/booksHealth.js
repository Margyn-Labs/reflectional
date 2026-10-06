/**
 * _lib/booksHealth.js
 * The books health check (2026-10-07): what's wrong in the books that the accountant should fix, every day, for
 * every account with books (Tally, Zoho Books, Odoo: it reads the booksEngine ctx, which every source is shaped into).
 *
 * Why: the Care Hygiene audit (4 Oct) found these by hand and sent them to Mihir's accountant once. VP: "We can't
 * clean up once. It should be a recurring workflow within the app itself." So each finding is a rule here, runs
 * with the morning Margyn Watch (margynWatch.watchAccount), and lives in books_health with a stable key:
 *   open    -> found on the latest run;
 *   fixed   -> a later run no longer finds it (closed by itself, never by hand);
 *   ignored -> the owner said leave it; never raised again unless its amount moves more than 25%.
 *
 * The checks (all rules; a classifier only behind JEV_MODE_BOOKS_HEALTH = off | shadow | live, default off):
 *   interest_under_income   interest on an overdraft/loan filed under an income group (INTEREST ON OD ₹5.43 L)
 *   costs_not_booked        a closed month's running costs far below the usual (Sep ₹2.66 L vs usual ₹41.8 L)
 *   name_vs_group           an expense-named ledger in an income/sales group with money going out (TRANSPORT/COURIER
 *                           EXPENSES under Sales Accounts), or the other way round
 *   cash_negative           cash in hand below zero (−₹41,091)
 *   supplier_bills_settled  supplier bills open bill-wise but settled in the ledger (Sanjay Plastics ₹14 L vs ₹11.5k)
 *   customer_bills_paid     customer bills open bill-wise but paid in the ledger (₹47.2 L, 45 customers)
 *   customer_unbilled       a customer ledger balance with no bill behind it (₹21.6 L, 21 customers)
 *   suppliers_not_billwise  most suppliers kept as a running balance, not bill by bill (56 of 61)
 *   old_debt                customer money owed for over a year: settle, chase or write off (Glenmark 1,327 days)
 *   entered_ahead           entries dated after today (EMIs entered in advance)
 *   later_entries_balance   Tally's closing balances already stop at today (asOfToday's tie-out guard kept them)
 *
 * Amounts are worked out here in plain JS; nothing is sent anywhere without a person's yes (the app's
 * "Send to my accountant" opens WhatsApp or copies the list; the person presses send).
 * CommonJS, zero-npm.
 */

const A = require('./tallyAnalytics');
const E = require('./booksEngine');
const T = require('./billTieOut');
const CF = require('./cashFlowModel');

const DAY = 86400000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(num(n));
const inr = E.inr;
const nice = (s) => E.niceName(s);
const keyOf = (s) => A.nameKey(s);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const REOPEN_MOVE = 0.25;   // an ignored item comes back only when its amount moves more than this

// Which part of the books each kind belongs to: a team member sees only the parts their access allows.
const AREA = {
  interest_under_income: 'books', costs_not_booked: 'books', name_vs_group: 'books', cash_negative: 'cash',
  supplier_bills_settled: 'suppliers', suppliers_not_billwise: 'suppliers',
  customer_bills_paid: 'customers', customer_unbilled: 'customers', old_debt: 'customers',
  entered_ahead: 'cash', later_entries_balance: 'cash'
};
// Order in the app and in the accountant's list.
const ORDER = ['cash_negative', 'interest_under_income', 'name_vs_group', 'costs_not_booked', 'supplier_bills_settled', 'customer_bills_paid',
  'customer_unbilled', 'suppliers_not_billwise', 'old_debt', 'entered_ahead', 'later_entries_balance'];
// Section names when several items of one kind are listed together.
const GROUP_TITLE = {
  cash_negative: 'Cash below zero',
  interest_under_income: 'Interest you paid, filed as income',
  name_vs_group: 'Ledgers filed under the wrong group',
  costs_not_booked: 'Months with running costs missing',
  supplier_bills_settled: 'Supplier bills still open but already paid',
  customer_bills_paid: 'Customer bills still open but already paid',
  customer_unbilled: 'Customer balances with no bill behind them',
  suppliers_not_billwise: 'Suppliers not kept bill by bill',
  old_debt: 'Money owed for over a year',
  entered_ahead: 'Entries dated after today',
  later_entries_balance: 'Balances already as of today'
};

/* ---------------- reading the books ---------------- */

// The group Tally files a ledger under (not Margyn's own placement): that's what the accountant changes.
function groupBucket(l) {
  return A.bucketFromParent(l.primary_group) || A.bucketFromParent(l.parent) || A.guessBucket('', l.parent);
}
function groupName(l) { return String(l.parent || l.primary_group || 'its group').trim(); }
function fyStartOf(today) { const y = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1; return new Date(Date.UTC(y, 3, 1)); }
function monthWord(k) { const [y, m] = String(k).split('-').map(Number); return MONTH_FULL[(m || 1) - 1] + ' ' + y; }
function dayWord(ms) { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function debitPosOf(ctx) {
  const bs = ((ctx.analytics || {}).quality || {}).balance_sign || {};
  const eff = bs.effective || (!bs.convention || bs.convention === 'unknown' ? 'opposite' : bs.convention);
  return (b) => (eff === 'same' ? -num(b) : num(b));
}
// Net money through each ledger this financial year, debit (money spent / owed to you) positive.
function fyDebits(ctx) {
  const from = fyStartOf(ctx.today).getTime(), out = new Map();
  for (const r of ctx.rows || []) {
    if (r.dt.getTime() < from) continue;
    for (const l of r.lines) { const k = keyOf(l.ledger); out.set(k, (out.get(k) || 0) - num(l.amount)); }
  }
  return out;
}
function severityFor(ctx, amount, floor) {
  const m = ctx.material || 50000;
  if (amount >= 10 * m) return 'high';
  if (amount >= m) return 'medium';
  return floor || 'low';
}

/* ---------------- the checks ---------------- */

const INTEREST = /\binterest\b/i;
const NOT_PAID_INTEREST = /\b(tds|receivable|accrued|subsidy|subvention)\b/i;
const LOANISH = /\b(o\.?\s?d|overdraft|cash\s*credit|c\.?c|loans?|emi|bank)\b/i;
const EXPENSE_WORDS = /\b(expenses?|exp|charges?|freight|transport(ation)?|courier|cartage|carriage|salary|salaries|wages|rent|electricity|telephone|travell?ing|conveyance|repairs?|maintenance|printing|stationery|advertis\w*|insurance|fees|petrol|diesel|fuel|packing|loading|unloading|postage|remuneration|bonus)\b/i;
const INCOME_EXCEPTIONS = /\b(received|recd|income|recover(ed|y)?|reimburs\w*|collected|written\s*back|refunds?|interest)\b/i;
const INCOME_WORDS = /\b(income|received|recd)\b/i;
const INCOME_BUCKETS = new Set(['sales', 'direct_income', 'other_income']);
const EXPENSE_BUCKETS = new Set(['opex', 'direct_expense', 'purchases']);

function checkInterest(ctx, debits, found) {
  for (const l of ctx.ledgers || []) {
    if (!INTEREST.test(l.name) || NOT_PAID_INTEREST.test(l.name)) continue;
    const g = groupBucket(l);
    if (!INCOME_BUCKETS.has(g)) continue;
    const paid = debits.get(keyOf(l.name)) || 0;
    if (paid < 1000) continue;   // interest actually earned (a sweep deposit) is income and stays
    const what = LOANISH.test(l.name) ? 'Interest on your overdraft or loan' : 'Interest you paid';
    found.push({
      key: 'interest_under_income:' + keyOf(l.name), kind: 'interest_under_income', ledger: l.name, amount: r0(paid),
      severity: severityFor(ctx, paid, 'medium'),
      title: `${what} is filed as income`,
      detail: `“${l.name}” is under ${groupName(l)} in your books, but ${inr(paid)} went out on it this year: it’s interest you paid. Margyn already counts it as a cost; your books’ own profit and loss show it as income.`,
      fix: `Move the ledger “${l.name}” from ${groupName(l)} to Indirect Expenses (an interest or finance cost group).`
    });
  }
}

function checkCosts(ctx, found, scope) {
  const pnl = ((ctx.analytics || {}).pnl || []);
  const months = new Set();
  for (const m of pnl) {
    if (m.provisional || m.partial_start) continue;
    months.add(m.month);
    if (!m.costs_incomplete || !(m.typical_opex > 0)) continue;
    const gap = num(m.typical_opex) - num(m.opex);
    if (gap < Math.max(10000, 0.1 * (ctx.material || 0))) continue;
    found.push({
      key: 'costs_not_booked:' + m.month, kind: 'costs_not_booked', month: m.month, amount: r0(gap),
      severity: severityFor(ctx, gap, 'medium'),
      title: `${monthWord(m.month)}’s running costs look unbooked`,
      detail: `Running costs for ${monthWord(m.month)} are ${inr(m.opex)}, against a usual ${inr(m.typical_opex)} a month. Salaries, rent or other bills for the month are probably not entered yet, so that month’s profit reads too high.`,
      fix: `Enter ${monthWord(m.month)}’s expenses (salaries, rent, power, other bills) in the books, dated in ${MONTH_FULL[+m.month.slice(5) - 1]}.`
    });
  }
  scope.set('costs_not_booked', months);
}

function checkNames(ctx, debits, found) {
  for (const l of ctx.ledgers || []) {
    const g = groupBucket(l);
    const net = debits.get(keyOf(l.name)) || 0;
    if (INCOME_BUCKETS.has(g) && EXPENSE_WORDS.test(l.name) && !INCOME_EXCEPTIONS.test(l.name) && net >= 1000) {
      found.push({
        key: 'name_vs_group:' + keyOf(l.name), kind: 'name_vs_group', ledger: l.name, amount: r0(net),
        severity: severityFor(ctx, net, 'medium'),
        title: `“${l.name}” is filed under ${groupName(l)}`,
        detail: `Its name says it’s an expense and ${inr(net)} went out on it this year, but it sits under ${groupName(l)}, so your ${g === 'sales' ? 'sales are' : 'income is'} understated by that much in your books’ own reports.`,
        fix: `Move the ledger “${l.name}” to Direct Expenses or Indirect Expenses, whichever fits.`
      });
    } else if (EXPENSE_BUCKETS.has(g) && INCOME_WORDS.test(l.name) && !EXPENSE_WORDS.test(l.name) && -net >= 1000) {
      found.push({
        key: 'name_vs_group:' + keyOf(l.name), kind: 'name_vs_group', ledger: l.name, amount: r0(-net),
        severity: 'low',
        title: `“${l.name}” is filed under ${groupName(l)}`,
        detail: `Its name says it’s income and ${inr(-net)} came in on it this year, but it sits under ${groupName(l)}, so it reduces your costs instead of showing as income.`,
        fix: `Move the ledger “${l.name}” to Indirect Incomes (or Direct Incomes).`
      });
    }
  }
}

function checkCash(ctx, found) {
  const debitPos = debitPosOf(ctx);
  const move = new Map();
  for (const r of ctx.rows || []) for (const l of r.lines) { const k = keyOf(l.ledger); move.set(k, (move.get(k) || 0) + num(l.amount)); }
  for (const l of ctx.ledgers || []) {
    if (ctx.cls(l.name) !== 'cash') continue;
    let bal = null;
    if (l.closing_balance != null) bal = debitPos(l.closing_balance);
    else if (l.opening_balance != null) bal = debitPos(l.opening_balance) - (move.get(keyOf(l.name)) || 0);
    if (bal == null || bal > -100) continue;
    // The entries that most likely did it: the biggest journal entries taking money out of cash this year.
    const from = fyStartOf(ctx.today).getTime(), k = keyOf(l.name);
    const outs = [];
    for (const r of ctx.rows || []) {
      if (r.dt.getTime() < from || r.kind !== 'journal') continue;
      const amt = r.lines.filter((x) => keyOf(x.ledger) === k).reduce((t, x) => t + num(x.amount), 0);
      if (amt > 0) outs.push({ day: r.day, amount: r0(amt), to: (r.lines.find((x) => keyOf(x.ledger) !== k && num(x.amount) < 0) || {}).ledger || null });
    }
    outs.sort((a, b) => b.amount - a.amount);
    const eg = outs.slice(0, 3);
    found.push({
      key: 'cash_negative:' + k, kind: 'cash_negative', ledger: l.name, amount: r0(-bal), severity: 'high',
      title: `Cash in hand shows ${inr(bal).replace(/^-/, '−')}`,
      detail: `“${l.name}” is below zero, which can’t happen with real cash. Usually a payment was entered from Cash that was really paid from the bank or by a partner, or cash that came in wasn’t entered.` +
        (eg.length ? ` Biggest journal entries out of Cash this year: ${eg.map((x) => `${inr(x.amount)}${x.to ? ' to ' + x.to : ''} on ${dayWord(Date.parse(x.day + 'T00:00:00Z'))}`).join('; ')}.` : ''),
      fix: `Find the entries that took “${l.name}” below zero${eg.length ? ' (start with the journal entries listed)' : ''} and post them to the right ledger, or enter the cash that came in.`,
      data: eg.length ? { examples: eg } : undefined
    });
  }
}

function checkBills(ctx, found, scope) {
  const hasBills = (ctx.billsAsInTally || ctx.bills || []).length > 0;
  const hasParties = (ctx.ledgers || []).some((l) => { const b = ctx.cls(l.name); return b === 'debtor' || b === 'creditor'; });
  if (!hasBills || !hasParties) return;   // nothing to compare: these kinds aren't judged this run
  for (const k of ['supplier_bills_settled', 'customer_bills_paid', 'customer_unbilled']) scope.set(k, null);
  const MIN = 500;
  const sup = T.partyGaps(ctx, 'payable');
  for (const g of sup.gaps) {
    if (g.diff < MIN || !g.bills) continue;
    found.push({
      key: 'supplier_bills_settled:' + g.key, kind: 'supplier_bills_settled', party: g.party, amount: g.diff, severity: severityFor(ctx, g.diff),
      title: `${nice(g.party)}: ${plural(g.bills, 'bill')} still open, already paid`,
      detail: `Your books list ${plural(g.bills, 'open bill')} for ${nice(g.party)} (${inr(g.billed)}${g.oldest_days != null ? ', oldest ' + g.oldest_days.toLocaleString('en-IN') + ' days' : ''}), but their ledger shows ${g.ledger >= 1 ? 'only ' + inr(g.ledger) : 'nothing'} owed. The payments were made without being set against the bills.`,
      fix: `Knock off ${nice(g.party)}’s paid bills against the payments (bill-wise “Agst Ref”) so only ${g.ledger >= 1 ? inr(g.ledger) : 'nothing'} stays open.`,
      data: { billed: g.billed, ledger: g.ledger, bills: g.bills, oldest_days: g.oldest_days }
    });
  }
  const cus = T.partyGaps(ctx, 'receivable');
  for (const g of cus.gaps) {
    if (Math.abs(g.diff) < MIN) continue;
    if (g.diff > 0) {
      found.push({
        key: 'customer_bills_paid:' + g.key, kind: 'customer_bills_paid', party: g.party, amount: g.diff, severity: severityFor(ctx, g.diff),
        title: `${nice(g.party)}: bills still open that the ledger shows as paid`,
        detail: `Your books list ${inr(g.billed)} of open bills for ${nice(g.party)}, but their ledger shows ${g.ledger >= 1 ? 'only ' + inr(g.ledger) : 'nothing'} owed. Margyn goes by the ledger and won’t chase the paid bills, but they still show as owed in your books’ bill list.`,
        fix: `Set ${nice(g.party)}’s receipts against their oldest bills (bill-wise “Agst Ref”) so the open bills add up to ${g.ledger >= 1 ? inr(g.ledger) : 'zero'}.`,
        data: { billed: g.billed, ledger: g.ledger, bills: g.bills, oldest_days: g.oldest_days }
      });
    } else {
      found.push({
        key: 'customer_unbilled:' + g.key, kind: 'customer_unbilled', party: g.party, amount: -g.diff, severity: severityFor(ctx, -g.diff),
        title: `${nice(g.party)} owes ${inr(g.ledger)} with ${g.billed >= 1 ? 'only ' + inr(g.billed) + ' in' : 'no'} open bills`,
        detail: `The ledger says ${nice(g.party)} owes ${inr(g.ledger)}, but ${g.billed >= 1 ? 'the open bills add up to ' + inr(g.billed) : 'there’s no open bill behind it'}. Margyn adds the difference from their entries, but without bill references it can’t be aged or chased properly.`,
        fix: `Split ${nice(g.party)}’s balance into bills (bill-wise “New Ref” / “Agst Ref” on the invoices and receipts).`,
        data: { billed: g.billed, ledger: g.ledger, bills: g.bills }
      });
    }
  }
}

function checkSuppliersBillwise(ctx, found, scope) {
  const wc = (ctx.analytics || {}).working_capital || {};
  if (wc.suppliers_tracked_billwise == null) return;   // no recent purchases: can't judge
  scope.set('suppliers_not_billwise', null);
  if (wc.suppliers_tracked_billwise !== false) return;
  const bal = CF.partyBalancesToday(ctx);
  const withBills = new Set((ctx.billsAsInTally || ctx.bills || []).filter((b) => b.direction === 'payable' && !b.advance && Math.abs(num(b.closing_balance)) >= 1).map((b) => keyOf(b.party_name)));
  let owing = 0, untracked = 0, amount = 0;
  for (const [k, p] of bal) {
    if (p.bucket !== 'creditor' || p.balance == null) continue;
    const owed = -p.balance;
    if (owed < 1) continue;
    owing++;
    if (!withBills.has(k)) { untracked++; amount += owed; }
  }
  if (!untracked) return;
  found.push({
    key: 'suppliers_not_billwise', kind: 'suppliers_not_billwise', amount: r0(amount), severity: 'medium', count: untracked,
    title: `${untracked} of ${plural(owing, 'supplier')} aren’t kept bill by bill`,
    detail: `Your books keep only a running balance for ${untracked} suppliers (${inr(amount)} owed between them), so which bills are due when is Margyn’s estimate from their purchases and payments, not your books’ own.`,
    fix: 'Turn on “Maintain balances bill-by-bill” for supplier ledgers (Sundry Creditors) and enter the bill number on every purchase and the bill it settles on every payment.'
  });
}

function checkOldDebts(ctx, found, scope) {
  const bills = (ctx.bills || []).filter((b) => b.direction !== 'payable' && !b.advance && Math.abs(num(b.closing_balance)) >= 1);
  if (!bills.length && !(ctx.billsAsInTally || []).length) return;
  scope.set('old_debt', null);
  const by = new Map();
  for (const b of bills) {
    const late = num(b.overdue_days);
    if (late <= 365) continue;
    const k = keyOf(b.party_name);
    const g = by.get(k) || { party: b.party_name, amount: 0, bills: 0, oldest: 0 };
    g.amount += Math.abs(num(b.closing_balance)); g.bills++; g.oldest = Math.max(g.oldest, late);
    by.set(k, g);
  }
  for (const [k, g] of by) {
    if (g.amount < 1000) continue;
    found.push({
      key: 'old_debt:' + k, kind: 'old_debt', party: g.party, amount: r0(g.amount), severity: severityFor(ctx, g.amount),
      title: `${nice(g.party)}: ${inr(g.amount)} owed for over a year`,
      detail: `${plural(g.bills, 'bill')} from ${nice(g.party)}, the oldest ${g.oldest.toLocaleString('en-IN')} days late. Money this old is rarely collected by reminders alone.`,
      fix: `Decide for ${nice(g.party)}: settle (agree an amount), chase once more, or write it off as a bad debt in the books so receivables stay true.`,
      decision: true
    });
  }
}

function checkAhead(ctx, found, scope) {
  scope.set('entered_ahead', null);
  scope.set('later_entries_balance', null);
  const later = (ctx.future || []).filter((v) => v && v.is_cancelled !== true);
  if (later.length) {
    const tot = later.reduce((t, v) => t + Math.abs(num(v.amount)), 0);
    const days = later.map((v) => A.parseDate(v.date)).filter(Boolean).map((d) => d.getTime()).sort((a, b) => a - b);
    const emi = later.filter((v) => /emi|loan|instal/i.test(String(v.narration || '') + ' ' + (v.entries || []).map((e) => e && e.ledger).join(' '))).length;
    found.push({
      key: 'entered_ahead', kind: 'entered_ahead', amount: r0(tot), severity: 'low', count: later.length,
      title: `${plural(later.length, 'entry', 'entries')} dated after today (${inr(tot)})`,
      detail: `${emi ? 'Mostly loan EMIs entered in advance' : 'Entered ahead of their dates'}${days.length ? ', from ' + dayWord(days[0]) + (days.length > 1 ? ' to ' + dayWord(days[days.length - 1]) : '') : ''}. Margyn counts each one on its date, so today’s cash and loans aren’t reduced by them yet.`,
      fix: 'Nothing to do if they’re planned (EMIs, post-dated cheques). If a date was typed wrong, correct it.',
      info: true
    });
  }
  const g = ctx.asOfGuard;
  if (g && (g.decision === 'kept' || (g.to_today > 0 && g.with_future > 0))) {
    const names = (g.ledgers || []).filter((x) => x.fit === 'to_today').map((x) => x.name);
    const mixed = g.decision !== 'kept';
    found.push({
      key: 'later_entries_balance', kind: 'later_entries_balance', amount: r0((g.ledgers || []).reduce((t, x) => t + Math.abs(num(x.later_entries)), 0)),
      severity: mixed ? 'medium' : 'low',
      title: mixed ? 'Some bank and loan balances don’t add up the same way' : 'Your books’ balances already stop at today',
      detail: mixed
        ? `For ${names.join(', ')}, the closing balance matches the entries up to today, while other accounts include the later-dated entries. Margyn kept its usual reading (later entries taken out); check these accounts’ figures against the bank.`
        : `For ${names.join(', ')}, the closing balance matches your entries up to today without the later-dated ones, so Margyn did not take them out a second time.`,
      fix: mixed ? `Check ${names.join(', ')} against the bank statement; an entry may be missing or dated wrong.` : 'Nothing to fix. Margyn noted it so your cash isn’t counted twice.',
      info: !mixed,
      data: { decision: g.decision, ledgers: (g.ledgers || []).slice(0, 8) }
    });
  }
}

/**
 * Every check on one account's books. ctx: booksEngine.prepare(). Pure.
 * Returns { items, scope } where scope says which kinds were judged this run (kind -> null for all its keys, or a
 * Set of the months it covered): only items of a judged kind can close themselves.
 */
function check(ctx) {
  const found = [], scope = new Map();
  if (!ctx || !(ctx.rows || []).length) return { items: [], scope };
  const debits = fyDebits(ctx);
  scope.set('interest_under_income', null); checkInterest(ctx, debits, found);
  checkCosts(ctx, found, scope);
  scope.set('name_vs_group', null); checkNames(ctx, debits, found);
  scope.set('cash_negative', null); checkCash(ctx, found);
  checkBills(ctx, found, scope);
  checkSuppliersBillwise(ctx, found, scope);
  checkOldDebts(ctx, found, scope);
  checkAhead(ctx, found, scope);
  for (const x of found) { x.area = AREA[x.kind]; x.source = ctx.source || 'tally'; x.for_accountant = !x.info; }
  found.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.amount - a.amount);
  return { items: found, scope };
}

/* ---------------- the workflow: open / fixed / ignored ---------------- */

function moved(a, b) {
  const base = Math.abs(num(b));
  if (base < 1) return Math.abs(num(a)) >= 1;
  return Math.abs(num(a) - num(b)) / base > REOPEN_MOVE;
}
function covered(scope, row) {
  if (!scope.has(row.kind)) return false;
  const s = scope.get(row.kind);
  if (s == null) return true;
  return s.has(String(row.key).split(':').slice(1).join(':'));
}

/**
 * What to write, given the stored rows and today's findings. Pure.
 * rows: books_health rows for the account; result: check(); now: Date or ISO.
 * Returns { upserts: [row patches with key], opened, closed, reopened, still_ignored }.
 */
function reconcile(rows, result, now) {
  const at = (now ? new Date(now) : new Date()).toISOString();
  const byKey = new Map((rows || []).filter((r) => r && r.kind !== 'run').map((r) => [r.key, r]));
  const upserts = [];
  const out = { upserts, opened: [], closed: [], reopened: [], still_ignored: [] };
  // Every row carries every column (one bulk upsert needs the same keys on each row).
  const row = (f, r, patch) => Object.assign({
    key: f.key, kind: f.kind, area: f.area || AREA[f.kind] || null, source: f.source || null, severity: f.severity || null, title: f.title || null, detail: f.detail || null, fix: f.fix || null,
    party: f.party || null, ledger: f.ledger || null, amount: f.amount != null ? f.amount : null, for_accountant: f.for_accountant !== false, data: f.data || null,
    status: r ? r.status : 'open', first_seen: r && r.first_seen ? r.first_seen : at, last_seen: at, fixed_at: r ? r.fixed_at || null : null,
    ignored_at: r ? r.ignored_at || null : null, ignored_amount: r && r.ignored_amount != null ? r.ignored_amount : null, ignored_by: r ? r.ignored_by || null : null,
    reopened_at: r ? r.reopened_at || null : null
  }, patch || {});
  const seen = new Set();
  for (const f of result.items) {
    seen.add(f.key);
    const r = byKey.get(f.key);
    if (!r) { upserts.push(row(f, null)); out.opened.push(f.key); continue; }
    if (r.status === 'ignored') {
      if (moved(f.amount, r.ignored_amount != null ? r.ignored_amount : r.amount)) {
        upserts.push(row(f, r, { status: 'open', ignored_at: null, ignored_amount: null, ignored_by: null, reopened_at: at }));
        out.reopened.push(f.key);
      } else { upserts.push(row(f, r)); out.still_ignored.push(f.key); }
      continue;
    }
    if (r.status === 'fixed') { upserts.push(row(f, r, { status: 'open', fixed_at: null, reopened_at: at })); out.reopened.push(f.key); continue; }
    upserts.push(row(f, r, { status: 'open' }));
  }
  for (const r of byKey.values()) {
    if (seen.has(r.key) || r.status !== 'open' || !covered(result.scope, r)) continue;
    upserts.push(row(r, r, { status: 'fixed', fixed_at: at, last_seen: r.last_seen || at }));
    out.closed.push(r.key);
  }
  return out;
}

/** Stored rows with today's live findings laid over them (for an answer before or without the table). */
function merge(rows, result) {
  const byKey = new Map((rows || []).filter((r) => r && r.kind !== 'run').map((r) => [r.key, r]));
  const live = result.items.map((f) => {
    const r = byKey.get(f.key);
    let status = 'open';
    if (r && r.status === 'ignored' && !moved(f.amount, r.ignored_amount != null ? r.ignored_amount : r.amount)) status = 'ignored';
    return Object.assign({}, f, { status, first_seen: r ? r.first_seen : null, ignored_by: status === 'ignored' ? r.ignored_by || null : null });
  });
  const liveKeys = new Set(live.map((x) => x.key));
  const fixed = [...byKey.values()].filter((r) => !liveKeys.has(r.key) && (r.status === 'fixed' || (r.status === 'open' && covered(result.scope, r))))
    .map((r) => Object.assign({}, r, { status: 'fixed' }));
  return live.concat(fixed);
}

/* ---------------- the list for the accountant ---------------- */

/**
 * A clean list to send the accountant (WhatsApp or copy): open items they can fix, grouped by kind, biggest first.
 * Decisions for the owner (old debts) go in their own section. max caps the characters (a WhatsApp link).
 */
function accountantText(items, o) {
  const opts = o || {};
  const open = (items || []).filter((x) => x.status === 'open' && x.for_accountant !== false);
  if (!open.length) return null;
  const by = new Map();
  for (const x of open) { if (!by.has(x.kind)) by.set(x.kind, []); by.get(x.kind).push(x); }
  const kinds = ORDER.filter((k) => by.has(k));
  const fixKinds = kinds.filter((k) => k !== 'old_debt'), decide = by.get('old_debt') || [];
  const day = opts.now ? dayWord(new Date(opts.now).getTime() + 5.5 * 3600000) : dayWord(Date.now() + 5.5 * 3600000);
  const lines = [`Books check${opts.company ? ' for ' + opts.company : ''}, ${day}`, 'Please fix these in the books:', ''];
  let n = 0;
  const perKind = opts.perKind || 8;
  for (const k of fixKinds) {
    const list = by.get(k).sort((a, b) => b.amount - a.amount);
    if (list.length === 1) {
      const x = list[0];
      lines.push(`${++n}. ${x.title}`, `   ${x.fix}`, '');
      continue;
    }
    const tot = list.reduce((t, x) => t + num(x.amount), 0);
    lines.push(`${++n}. ${GROUP_TITLE[k]} (${list.length}, ${inr(tot)})`);
    lines.push('   ' + groupFix(k));
    for (const x of list.slice(0, perKind)) lines.push('   - ' + shortLine(x));
    if (list.length > perKind) lines.push(`   - and ${list.length - perKind} more`);
    lines.push('');
  }
  if (decide.length) {
    lines.push('To decide with the owner (settle, chase or write off):');
    for (const x of decide.sort((a, b) => b.amount - a.amount).slice(0, perKind)) lines.push('   - ' + x.title);
    if (decide.length > perKind) lines.push(`   - and ${decide.length - perKind} more`);
    lines.push('');
  }
  lines.push('Sent from Margyn’s daily books check.');
  let text = lines.join('\n');
  // A WhatsApp link has a length limit: fewer names per section first, then cut with a pointer to the app.
  if (opts.max && text.length > opts.max && perKind > 3) return accountantText(items, Object.assign({}, opts, { perKind: 3 }));
  if (opts.max && text.length > opts.max) text = text.slice(0, opts.max - 30).replace(/\n[^\n]*$/, '') + '\n…the full list is in Margyn.';
  return text;
}
function groupFix(kind) {
  switch (kind) {
    case 'customer_bills_paid': return 'Set the receipts against these customers’ oldest bills (bill-wise “Agst Ref”):';
    case 'supplier_bills_settled': return 'Knock these suppliers’ paid bills off against the payments (bill-wise “Agst Ref”):';
    case 'customer_unbilled': return 'Split these balances into bills (bill-wise “New Ref”) so they can be aged:';
    case 'costs_not_booked': return 'Enter the missing expenses for these months:';
    case 'name_vs_group': return 'Move these ledgers to the right group:';
    case 'interest_under_income': return 'Move these interest ledgers under Indirect Expenses:';
    case 'cash_negative': return 'Correct the entries that took these cash ledgers below zero:';
    default: return '';
  }
}
function shortLine(x) {
  const d = x.data || {};
  switch (x.kind) {
    case 'customer_bills_paid': case 'supplier_bills_settled': return `${nice(x.party)}: bills ${inr(d.billed)}, ledger ${inr(d.ledger)}`;
    case 'customer_unbilled': return `${nice(x.party)}: ledger ${inr(d.ledger)}, bills ${inr(d.billed)}`;
    case 'costs_not_booked': return x.title.replace(/ look unbooked$/, '') + ` (short by about ${inr(x.amount)})`;
    case 'name_vs_group': case 'interest_under_income': return `“${x.ledger}” (${inr(x.amount)} this year)`;
    default: return x.title;
  }
}

/* ---------------- an answer for Margyn (books tools) ---------------- */

function answer(ctx, rows, perms) {
  const res = check(ctx);
  const all = filterFor(merge(rows || [], res), perms);
  const open = all.filter((x) => x.status === 'open');
  const show = (x) => ({ what: x.title, detail: x.detail, fix: x.fix, amount: inr(x.amount), since: x.first_seen ? String(x.first_seen).slice(0, 10) : 'today' });
  const groups = ORDER.filter((k) => open.some((x) => x.kind === k)).map((k) => {
    const list = open.filter((x) => x.kind === k).sort((a, b) => b.amount - a.amount);
    return { problem: GROUP_TITLE[k], count: list.length, total: inr(list.reduce((t, x) => t + num(x.amount), 0)), items: list.slice(0, 6).map(show), more: Math.max(0, list.length - 6) };
  });
  return {
    as_of: ctx.today.toISOString().slice(0, 10), source: ctx.source_name || 'Tally',
    open: open.length, for_the_accountant: open.filter((x) => x.for_accountant !== false).length,
    ignored: all.filter((x) => x.status === 'ignored').length,
    fixed_recently: all.filter((x) => x.status === 'fixed' && x.fixed_at && Date.now() - Date.parse(x.fixed_at) < 14 * DAY).map((x) => x.title).slice(0, 5),
    problems: groups,
    how_to_send: 'On Organisations and sources, under “Books health check”, tap “Send to my accountant”: it opens WhatsApp with the list (you press send) or copies it.',
    note: 'Checked every day with the morning update. An item closes by itself once a later sync shows it fixed; one the owner ignored comes back only if its amount moves more than 25%.'
  };
}

/* Team members see only the parts of the books their access allows (teamAccess.js). perms null = the owner. */
function filterFor(items, perms) {
  if (!Array.isArray(perms)) return items;
  const can = (p) => perms.includes(p);
  return items.filter((x) => {
    const area = x.area || AREA[x.kind];
    if (area === 'customers') return can('view_receivables');
    if (area === 'suppliers') return can('view_payables');
    if (area === 'cash') return can('view_cash');
    return can('view_cash') || can('view_receivables') || can('view_payables');
  });
}

/* ---------------- storage (books_health, 2026-10-07-books-health.sql) ---------------- */

const COLS = 'key,kind,area,source,status,severity,title,detail,fix,party,ledger,amount,ignored_amount,for_accountant,data,first_seen,last_seen,fixed_at,ignored_at,ignored_by,reopened_at';

async function load(userId) {
  const { selectRows } = require('./supabaseRest');
  try { return { ready: true, rows: await selectRows('books_health', `select=${COLS}&user_id=eq.${encodeURIComponent(userId)}&limit=5000`) }; }
  catch (e) { return { ready: false, rows: [] }; }
}

/* Optional classifier (Jev) for expense ledgers the name rules miss. Labels only; amounts come from the books. */
async function classifierPass(ctx, result, opts) {
  const jev = require('./jev');
  const mode = jev.modeFor('BOOKS_HEALTH');
  if (mode === 'off') return { mode };
  const debits = fyDebits(ctx);
  const flagged = new Set(result.items.filter((x) => x.kind === 'name_vs_group' || x.kind === 'interest_under_income').map((x) => keyOf(x.ledger)));
  const cand = (ctx.ledgers || []).filter((l) => INCOME_BUCKETS.has(groupBucket(l)) && !flagged.has(keyOf(l.name)) && (debits.get(keyOf(l.name)) || 0) >= 1000).slice(0, 20);
  if (!cand.length) return { mode, asked: 0 };
  const parties = (ctx.ledgers || []).filter((l) => ['debtor', 'creditor'].includes(ctx.cls(l.name))).map((l) => l.name);
  const questions = {};
  cand.forEach((l, i) => {
    questions['l' + i] = jev.Choice(`Ledger "${jev.redact(l.name, { parties }).text}" in an accounting book. By its name, is it an expense the business pays, or income it earns?`,
      { expense: 'An expense the business pays (freight, transport, salaries, rent, charges...)', income: 'Income or sales the business earns', unsure: 'Can\'t tell from the name' });
  });
  const res = await jev.systemOne({ note: 'Classify ledger names from an Indian SME\'s books. Names only, no amounts.' }, questions, { fetchImpl: opts && opts.fetchImpl, timeoutMs: 4000 });
  if (!res) return { mode, asked: cand.length, answered: 0 };
  let sure = 0;
  cand.forEach((l, i) => {
    if (jev.pick(res, 'l' + i, 0.9) !== 'expense') return;
    sure++;
    if (mode !== 'live') return;
    const net = debits.get(keyOf(l.name)) || 0;
    result.items.push({
      key: 'name_vs_group:' + keyOf(l.name), kind: 'name_vs_group', ledger: l.name, amount: r0(net), severity: 'low', area: 'books', source: ctx.source || 'tally', for_accountant: true, by: 'classifier',
      title: `“${l.name}” may be filed under the wrong group`,
      detail: `It sits under ${groupName(l)}, but ${inr(net)} went out on it this year and its name reads like an expense. Worth a look.`,
      fix: `If “${l.name}” is an expense, move it to Direct Expenses or Indirect Expenses.`
    });
  });
  if (mode === 'shadow') console.log(`[booksHealth] classifier shadow asked=${cand.length} expense_sure=${sure}`);
  return { mode, asked: cand.length, sure };
}

/**
 * Run the check for one account and store the outcome. Never throws. ctx from booksTools.contextFor.
 * Returns { ran, opened, closed, reopened, open, stored } or { ran: false, reason }.
 */
async function runForAccount(userId, ctx, opts) {
  const o = opts || {};
  if (!ctx || !(ctx.rows || []).length) return { ran: false, reason: 'no books yet' };
  const { insertRows } = require('./supabaseRest');
  const now = o.now ? new Date(o.now) : new Date();
  const result = check(ctx);
  try { await classifierPass(ctx, result, o); } catch (e) { /* rules stand on their own */ }
  const st = await load(userId);
  const plan = reconcile(st.rows, result, now);
  const summary = { ran: true, at: now.toISOString(), open: result.items.length, opened: plan.opened.length, closed: plan.closed.length, reopened: plan.reopened.length, stored: false };
  if (!st.ready) return Object.assign(summary, { note: 'books_health table missing (run 2026-10-07-books-health.sql)' });
  try {
    const rows = plan.upserts.map((u) => Object.assign({ user_id: userId }, u));
    const runRow = { user_id: userId, key: 'run:last', kind: 'run', status: 'meta', title: 'Last books check', last_seen: summary.at,
      data: { at: summary.at, source: ctx.source || 'tally', company: ctx.company || null, open: summary.open, opened: summary.opened, closed: summary.closed, reopened: summary.reopened,
        as_of_decision: ctx.asOfGuard ? ctx.asOfGuard.decision : null } };
    if (rows.length) await insertRows('books_health', rows, { onConflict: 'user_id,key', merge: true });
    await insertRows('books_health', [runRow], { onConflict: 'user_id,key', merge: true });
    summary.stored = true;
  } catch (e) { summary.error = String(e.message || e).slice(0, 160); }
  return summary;
}

module.exports = { check, reconcile, merge, accountantText, answer, filterFor, runForAccount, load, classifierPass, groupBucket, AREA, ORDER, GROUP_TITLE, REOPEN_MOVE };
