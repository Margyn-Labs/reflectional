/**
 * _lib/watchBrief.js
 * The shape of the day's WhatsApp updates (2026-10-05). Margyn Watch (margynWatch.js) decides whether to send
 * and to whom; this file decides what each update says. Pure: takes a booksEngine ctx, the forecast
 * (cashFlowModel.build) and the snapshot kept from the last update; no I/O.
 *
 * The cadence, the way a finance person who reads the books would run a day:
 *
 *  MORNING (07:30 IST), the detailed one.
 *    Where you stand: cash and overdraft (and how that moved since yesterday morning), what customers owe and
 *    how much is more than a month late, what you owe suppliers, the month's sales so far against the usual.
 *    Yesterday: money in by customer, money out by what it was for, new sales.
 *    This week: customer bills falling due, supplier bills due, payments that go out every month around now
 *    (salaries, rent, EMIs), GST, and where cash is likely to be in 7 days (from the learned forecast).
 *    Up to three points, mixed: at most two about money owed, the rest about everything else (costs, sales,
 *    customers going quiet, GST, margin). Each point says what, WHY NOW (why Margyn is raising it today),
 *    the BACKING (the bills, dates and habits it rests on) and what to do.
 *    Worth knowing: one thing the owner would not see on their own (a customer paying slower than THEIR
 *    usual, a small customer carrying a big share of the late money, a big customer quietly buying less,
 *    late money set against what the business is borrowing). Rotated, never the same one for three weeks.
 *
 *  MIDDAY / AFTERNOON, changes only. Compared with the last update: a customer paid (and whether that was one
 *    of this morning's points), a big payment went out, a deadline came close, Tally stopped syncing.
 *    Nothing changed means nothing is sent.
 *
 *  EVENING (19:00 IST), follow-ups. Today's money in and out and how cash moved since the morning; then each of
 *    this morning's points, checked again (paid / part paid / nothing yet / sorted); then what's due tomorrow;
 *    then at most one new urgent thing.
 *
 * Every figure is worked out in plain JS from the books. Nothing here is written by a language model.
 * CommonJS, zero-npm.
 */

const E = require('./booksEngine');
const cashFlow = require('./cashFlowModel');

const DAY = 86400000;
const MAX_POINTS = 3;
const MAX_RECEIVABLE_POINTS = 2;
const MAX_TEXT = 3900;   // WhatsApp allows 4096 characters in one message
const RECEIVABLE_KINDS = new Set(['overdue_total', 'late', 'short_paid', 'slipping', 'old_debts', 'newly_overdue']);
const INSIGHT_KINDS = new Set(['insight_slow', 'insight_late_share', 'insight_shrinking', 'insight_growing', 'insight_late_vs_borrowed']);
// Kinds the evening checks again: the owner can do something about them today.
const FOLLOW_UP_KINDS = new Set(['overdue_total', 'late', 'short_paid', 'slipping', 'newly_overdue', 'quiet', 'gst_due', 'stale', 'unbooked', 'duplicate', 'below_cost', 'unit_mismatch', 'expense_jump']);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isoDay = (dt) => dt.toISOString().slice(0, 10);
const nice = (s) => E.niceName(s);
const inr = (n) => E.inr(n);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const list2 = (arr) => arr.length > 2 ? arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1] : arr.join(' and ');

/** "5 Oct, 7:12 am" in India time. */
function istStamp(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 5.5 * 3600000);
  let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, '0'), ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${h}:${m} ${ap}`;
}
const istDay = (now) => new Date((now ? new Date(now).getTime() : Date.now()) + 5.5 * 3600000).toISOString().slice(0, 10);
/** Smallest change worth a line: a quarter of the business's "material" amount, at least ₹25,000. */
const threshold = (ctx) => Math.max(25000, num(ctx.material) / 4);

/* ------------------------------------------------------------------ the numbers */

/** What customers owe, per customer (all of them, not just the top). */
function owedByParty(ctx) {
  const m = new Map();
  for (const b of E.billRows(ctx, 'receivable')) {
    const k = norm(b.party);
    const g = m.get(k) || { name: b.party, owed: 0, late30: 0, maxLate: 0 };
    g.owed += b.amount; if (b.late > 30) g.late30 += b.amount;
    if (b.late > g.maxLate) g.maxLate = b.late;
    m.set(k, g);
  }
  return m;
}

/**
 * The position now, kept with each update so the next one can say what moved.
 * parties: the 80 biggest customer balances as [name, owed, more-than-a-month-late].
 */
function snapshot(ctx, fc, now) {
  let cash = null, borrowed = null;
  try { const cd = E.cashAndDebt(ctx); cash = cd.raw ? Math.round(cd.raw.cash) : null; borrowed = cd.raw ? Math.round(cd.raw.borrowed) : null; } catch (e) { /* leave null */ }
  if (cash == null && fc) cash = fc.opening;
  const owed = owedByParty(ctx);
  const pay = E.billRows(ctx, 'payable');
  const parties = {};
  for (const [k, g] of [...owed.entries()].sort((a, b) => b[1].owed - a[1].owed).slice(0, 80)) parties[k] = [g.name, Math.round(g.owed), Math.round(g.late30)];
  return {
    v: 1, at: new Date(now || Date.now()).toISOString(), day: istDay(now), last_sync: ctx.lastSync || null,
    cash, borrowed,
    recv_total: Math.round([...owed.values()].reduce((s, g) => s + g.owed, 0)),
    recv_late30: Math.round([...owed.values()].reduce((s, g) => s + g.late30, 0)),
    pay_total: Math.round(pay.reduce((s, b) => s + b.amount, 0)),
    parties, points: [],
    // Entries dated today or yesterday that were already in the books, so the next update can tell what's new.
    seen: ctx.rows.filter((r) => r.guid && r.dt.getTime() >= ctx.today.getTime() - DAY).map((r) => r.guid)
  };
}

/** The average working day over the last four weeks (days with any entry): money in from customers, sales, money out. */
function usualDay(ctx) {
  const from = ctx.today.getTime() - 28 * DAY, to = ctx.today.getTime();
  const rows = ctx.rows.filter((r) => r.dt.getTime() >= from && r.dt.getTime() < to);
  const days = new Set(rows.map((r) => r.day));
  if (days.size < 5) return null;
  let collected = 0, out = 0, sales = 0;
  for (const e of cashFlow.cashEvents(ctx, rows)) {
    if (e.category === 'transfers_loans') continue;
    if (e.amount > 0 && e.category === 'customers') collected += e.amount; else if (e.amount < 0) out += -e.amount;
  }
  for (const r of rows) if (r.kind === 'sales' || r.kind === 'credit_note') sales += r.sales - r.returns;
  return { collected: collected / days.size, out: out / days.size, sales: sales / days.size, days: days.size };
}
const arrow = (now, usual) => (usual > 0 && now >= usual * 1.1 ? '↑' : usual > 0 && now <= usual * 0.9 ? '↓' : '·');
function timeIST(iso) { const s = istStamp(iso); return s ? s.split(', ')[1] : null; }

/** Money in and out on the given India days ('2026-10-04'), or in just the given entries, by who and what for, and new sales. */
function movement(ctx, days, only) {
  const set = new Set(days || []);
  const rows = only || ctx.rows.filter((r) => set.has(r.day));
  const ev = cashFlow.cashEvents(ctx, rows);
  const inBy = new Map(), outBy = new Map();
  let inTot = 0, outTot = 0;
  for (const e of ev) {
    if (e.category === 'transfers_loans') continue;   // overdraft and loan movements aren't money earned or spent
    if (e.amount > 0) {
      inTot += e.amount;
      const k = e.category === 'customers' && e.party ? nice(e.party) : (e.category === 'customers' ? 'customers' : 'other');
      inBy.set(k, (inBy.get(k) || 0) + e.amount);
    } else {
      outTot += -e.amount;
      const cat = e.category === 'suppliers' ? 'suppliers' : e.category === 'tax' ? 'GST and taxes' : 'running costs';
      const g = outBy.get(cat) || { amount: 0, top: new Map() };
      g.amount += -e.amount;
      const who = e.party ? nice(e.party) : e.ledger;
      if (who) g.top.set(who, (g.top.get(who) || 0) + -e.amount);
      outBy.set(cat, g);
    }
  }
  let sales = 0, invoices = 0;
  for (const r of rows) if (r.kind === 'sales') { sales += r.sales - r.returns; invoices++; }
  return {
    in_total: inTot, out_total: outTot, sales, invoices,
    in_by: [...inBy.entries()].sort((a, b) => b[1] - a[1]),
    out_by: [...outBy.entries()].map(([cat, g]) => ({ cat, amount: g.amount, top: [...g.top.entries()].sort((a, b) => b[1] - a[1]) })).sort((a, b) => b.amount - a.amount),
    big_out: ev.filter((e) => e.amount < 0 && e.category !== 'transfers_loans' && -e.amount >= 2 * threshold(ctx))
      .map((e) => ({ who: e.party ? nice(e.party) : e.ledger, amount: -e.amount, category: e.category })).sort((a, b) => b.amount - a.amount)
  };
}

function inLine(m) {
  if (!m.in_total) return null;
  const top = m.in_by.slice(0, 3).map(([k, v]) => `${k} ${inr(v)}`);
  return `In: ${inr(m.in_total)}` + (top.length ? ` (${top.join(', ')}${m.in_by.length > 3 ? ` and ${m.in_by.length - 3} more` : ''})` : '') + '.';
}
function outLine(m) {
  if (!m.out_total) return null;
  const parts = m.out_by.slice(0, 3).map((g) => `${g.cat} ${inr(g.amount)}`);
  return `Out: ${inr(m.out_total)}` + (parts.length ? ` (${parts.join(', ')})` : '') + '.';
}
function salesLine(m) {
  return m.invoices ? `New sales: ${inr(m.sales)} across ${m.invoices} invoice${m.invoices === 1 ? '' : 's'}.` : null;
}

/** "up ₹2.1 L since yesterday morning" or null when it barely moved. */
function moved(now, before, since, ctx) {
  if (now == null || before == null) return null;
  const d = now - before;
  if (Math.abs(d) < threshold(ctx)) return `about the same as ${since}`;
  return `${d > 0 ? 'up' : 'down'} ${inr(Math.abs(d))} since ${since}`;
}

/** Bills falling due between today+from and today+to (inclusive), customers or suppliers. */
function dueBetween(ctx, direction, from, to) {
  const t0 = ctx.today.getTime() + from * DAY, t1 = ctx.today.getTime() + to * DAY;
  const bills = E.billRows(ctx, direction).filter((b) => b.due && b.due.getTime() >= t0 && b.due.getTime() <= t1);
  const by = new Map();
  for (const b of bills) by.set(nice(b.party), (by.get(nice(b.party)) || 0) + b.amount);
  return { total: bills.reduce((s, b) => s + b.amount, 0), count: bills.length, top: [...by.entries()].sort((a, b) => b[1] - a[1]) };
}
function dueLine(label, d) {
  if (!d.total) return null;
  return `${label}: ${inr(d.total)}` + (d.count > 1 ? ` on ${d.count} bills` : '') + (d.top.length ? ` (${d.top.slice(0, 2).map(([k, v]) => `${k} ${inr(v)}`).join(', ')})` : '') + '.';
}

/** Payments that go out every month around now (from the forecast's learned pattern) and entries already made for these dates. */
function regularOut(ctx, fc, from, to) {
  const out = [];
  if (!fc || !fc.drivers) return out;
  const today = ctx.today;
  for (let i = from; i <= to; i++) {
    const d = new Date(today.getTime() + i * DAY);
    for (const r of fc.drivers.recurring || []) {
      if (r.day_of_month !== d.getUTCDate()) continue;
      // Already paid this month (the forecast tracks that) means it isn't coming again.
      if (d.getUTCMonth() === today.getUTCMonth() && num(r.paid_this_month) >= 0.5 * num(r.amount)) continue;
      out.push({ what: r.ledger, amount: r.amount, when: d, kind: 'usual' });
    }
    for (const k of fc.drivers.known_ahead || []) {
      if (k.date !== isoDay(d) || num(k.amount) >= 0) continue;
      out.push({ what: k.party ? nice(k.party) : k.ledger, amount: -num(k.amount), when: d, kind: 'entered' });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/* ------------------------------------------------------------------ why now */

/**
 * The reason Margyn is raising this today, in one sentence. The finding's own detail is the backing; this is
 * the judgement: why this, why now, why ahead of everything else.
 */
function whyNow(x, slot) {
  if (x.was) return `It's grown from ${inr(x.was.impact)} to ${inr(x.impact)} since I last raised it, so it's back on the list.`;
  switch (x.kind) {
    case 'stale': return 'Every figure here is only as fresh as the last sync, so this comes first.';
    case 'overdue_total': return 'Late money is cash you\'ve already earned and are funding yourself in the meantime; the longer it sits, the harder it is to collect.';
    case 'late': return 'Of everyone who is late, they come first when amount and days late are weighed together, and nothing has come in from them this week.';
    case 'short_paid': return 'They are paying, so this isn\'t a chase: an open bill after a recent payment is usually a deduction or a receipt set against the wrong bill.';
    case 'slipping': return 'Nothing is badly late yet; a reminder in the first month works far more often than a chase after three.';
    case 'newly_overdue': return 'It went past due this week. A reminder now is routine; the same call in two months is a dispute.';
    case 'old_debts': return 'Bills this old rarely get paid without a decision; until then they make what customers owe look bigger than it is.';
    case 'quiet': return 'A regular customer going quiet shows up in sales a month later; a call now finds out why while it\'s still fixable.';
    case 'concentration': return 'One buyer this big means their payment delays and order changes move your whole month.';
    case 'collection_days': return 'Days to collect is the single biggest lever on how much cash the business needs.';
    case 'commission': return 'It\'s one of your largest costs after purchases, and it\'s set by agreement, so it can be renegotiated.';
    case 'expense_jump': return 'It\'s at least one and a half times its usual month, which is either a one-off or a new cost to know about.';
    case 'unbooked': return 'Until the month is fully booked, its profit looks better than it is and any decision on it is off.';
    case 'sales_trend': return 'It\'s a clear move away from your usual month, more than 15%.';
    case 'below_cost': return 'Every one of these sales loses money, and it repeats with each order until the price changes.';
    case 'unit_mismatch': return 'A gap this big is almost always a unit set up wrong in Tally, which throws off cost and margin for the item.';
    case 'gst_due': return slot === 'evening' ? 'It comes out of the same cash as supplier payments, so it\'s worth keeping aside now.' : 'It\'s a fixed date with a late fee, and it comes out of the same cash as supplier payments.';
    case 'duplicate': return 'Same party, same day, same amount: a ten-second check now saves a messy correction later.';
    default: return null;
  }
}

/** One point, in four short lines: what, why now, the backing, what to do. */
function pointBlock(x, i, slot, opts) {
  const o = opts || {};
  const lines = [`${i + 1}. ${x.title}`];
  const why = whyNow(x, slot);
  if (why) lines.push(`Why now: ${why}`);
  if (x.detail && !o.short) lines.push(`Backing: ${x.detail}`);
  if (x.action) lines.push(`Next: ${x.action}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ worth knowing */

/**
 * Things the owner wouldn't see on their own, as findings (kind insight_*), so Watch keeps track of which
 * were said and rotates them. Biggest first.
 */
function deepInsights(ctx, fc) {
  const out = [];
  const M = num(ctx.material) || 50000;
  const recv = E.billRows(ctx, 'receivable');
  const owed = owedByParty(ctx);
  const today = ctx.today.getTime();

  // 1. Slower than THEIR usual. The forecast learned how many days each customer takes from invoice to money
  // in; a bill well past that, still not overdue on paper (or barely), is the earliest sign of trouble.
  for (const c of ((fc && fc.drivers && fc.drivers.customers) || [])) {
    if (!c.own_history || !(c.habit_days > 0)) continue;
    const bills = recv.filter((b) => norm(b.party) === norm(c.party) && b.date && b.late <= 30);
    const oldest = bills.sort((a, b) => a.date - b.date)[0];
    if (!oldest || oldest.amount < M / 2) continue;
    const age = Math.round((today - oldest.date.getTime()) / DAY);
    if (age < c.habit_days * 1.4 || age - c.habit_days < 10) continue;
    out.push({ key: 'insight:slow:' + norm(c.party), kind: 'insight_slow', party: c.party, severity: 'low', impact: oldest.amount,
      title: `${nice(c.party)} usually pays in about ${Math.round(c.habit_days)} days, but their ${inr(oldest.amount)} bill${oldest.ref ? ' ' + oldest.ref : ''} from ${E.dayStr(oldest.date)} is ${age} days old. ` +
        (oldest.late > 0 ? `It's only ${oldest.late} day${oldest.late === 1 ? '' : 's'} past due on paper, ` : 'It isn\'t overdue on paper yet, ') +
        'but for them this is slow. A check-in now is easier than a chase later.' });
  }

  // 2. A small customer carrying a big share of the late money.
  const late30Tot = [...owed.values()].reduce((s, g) => s + g.late30, 0);
  const sales = (ctx.analytics && ctx.analytics.customers) || [];
  const salesTot = sales.reduce((s, c) => s + Math.max(0, num(c.net_sales)), 0);
  if (late30Tot >= M && salesTot > 0) {
    for (const [k, g] of owed) {
      if (g.late30 < M) continue;
      const lateShare = g.late30 / late30Tot;
      const c = sales.find((x) => norm(x.party) === k);
      const salesShare = c ? Math.max(0, num(c.net_sales)) / salesTot : 0;
      if (lateShare < 0.2 || lateShare < 3 * salesShare) continue;
      out.push({ key: 'insight:late_share:' + k, kind: 'insight_late_share', party: g.name, severity: 'low', impact: g.late30,
        title: `${nice(g.name)} is ${salesShare < 0.01 ? 'under 1%' : Math.round(salesShare * 100) + '%'} of your sales this year but ${Math.round(lateShare * 100)}% of the money that's more than a month late (${inr(g.late30)} of ${inr(late30Tot)}). ` +
          'Getting them current matters more than their size suggests, and it\'s worth asking whether their credit limit should stay where it is.' });
    }
  }

  // 3 and 4. Big customers quietly buying less (or a lot more): last 90 days against the 90 before. They're still
  // ordering, so they never show up as "gone quiet".
  const a90 = today - 90 * DAY, a180 = today - 180 * DAY;
  const per = new Map();
  for (const r of ctx.rows) {
    if (r.kind !== 'sales' && r.kind !== 'credit_note') continue;
    if (!r.party || r.dt.getTime() < a180 || r.dt.getTime() > today) continue;
    const k = norm(r.party), g = per.get(k) || { name: r.party, last: 0, prev: 0 };
    if (r.dt.getTime() >= a90) g.last += r.sales - r.returns; else g.prev += r.sales - r.returns;
    per.set(k, g);
  }
  const first = ctx.coverage && ctx.coverage.from ? ctx.coverage.from.getTime() : today;
  if (first <= a180) {
    for (const [k, g] of per) {
      if (g.prev >= 3 * M && g.last > 0 && g.last <= 0.6 * g.prev) {
        out.push({ key: 'insight:shrinking:' + k, kind: 'insight_shrinking', party: g.name, severity: 'low', impact: g.prev - g.last,
          title: `${nice(g.name)} bought ${inr(g.last)} in the last 90 days, down ${Math.round((1 - g.last / g.prev) * 100)}% from ${inr(g.prev)} in the 90 before. ` +
            'They\'re still ordering, so it doesn\'t look like a lost customer, but it\'s ' + inr(g.prev - g.last) + ' less a quarter. Worth asking if someone else is getting that business.' });
      } else if (g.prev >= M / 2 && g.last >= 2 * M && g.last >= 1.5 * g.prev) {
        const o = owed.get(k);
        out.push({ key: 'insight:growing:' + k, kind: 'insight_growing', party: g.name, severity: 'low', impact: (g.last - g.prev) / 2,
          title: `${nice(g.name)} bought ${inr(g.last)} in the last 90 days, up ${Math.round((g.last / g.prev - 1) * 100)}% on the 90 before, one of your fastest-growing customers.` +
            (o && o.owed >= M ? ` They owe you ${inr(o.owed)}; make sure their credit grows with care, not by default.` : '') });
      }
    }
  }

  // 5. Late money against what the business borrows.
  try {
    const cd = E.cashAndDebt(ctx);
    const borrowed = cd.raw ? cd.raw.borrowed : 0;
    if (borrowed >= M && late30Tot >= M) {
      const half = late30Tot / 2;
      const cut = Math.min(100, Math.round(half / borrowed * 100));
      out.push({ key: 'insight:late_vs_borrowed', kind: 'insight_late_vs_borrowed', severity: 'low', impact: Math.min(half, borrowed),
        title: `You're borrowing ${inr(borrowed)} while customers hold ${inr(late30Tot)} that's more than a month late. ` +
          `Collecting half of it would ${cut >= 100 ? 'clear the borrowing entirely' : `cut the borrowing by about ${cut}%`}` +
          (cd.interest_paid_this_fy && cd.interest_paid_this_fy !== '₹0' ? `; you've paid ${cd.interest_paid_this_fy} in interest this year.` : '.') +
          ' In effect you\'re paying interest to fund your customers.' });
    }
  } catch (e) { /* skip */ }

  return out.sort((a, b) => b.impact - a.impact);
}

/* ------------------------------------------------------------------ choosing the mix */

/**
 * From candidates already filtered for cooldowns (margynWatch.choose), the morning's points: at most two about
 * money owed, the rest about everything else, then topped up with money owed if there's nothing else.
 */
function mix(candidates, max) {
  const n = max || MAX_POINTS;
  const recv = candidates.filter((x) => RECEIVABLE_KINDS.has(x.kind));
  const other = candidates.filter((x) => !RECEIVABLE_KINDS.has(x.kind));
  // Sync problems always lead: the rest depends on them.
  const pick = candidates.filter((x) => x.kind === 'stale').slice(0, 1);
  const taken = new Set(pick.map((x) => x.key));
  for (const x of recv) { if (pick.length >= n || pick.filter((p) => RECEIVABLE_KINDS.has(p.kind)).length >= MAX_RECEIVABLE_POINTS) break; if (!taken.has(x.key)) { pick.push(x); taken.add(x.key); } }
  for (const x of other) { if (pick.length >= n) break; if (!taken.has(x.key)) { pick.push(x); taken.add(x.key); } }
  for (const x of recv) { if (pick.length >= n) break; if (!taken.has(x.key)) { pick.push(x); taken.add(x.key); } }
  // Back in the engine's order (severity, then size), so the most urgent is point 1.
  const rank = new Map(candidates.map((x, i) => [x.key, i]));
  return pick.sort((a, b) => rank.get(a.key) - rank.get(b.key));
}

/* ------------------------------------------------------------------ the three messages */

function greetingName(firstName) { return firstName ? ' ' + firstName : ''; }
function asOfLine(ctx) {
  const s = istStamp(ctx.lastSync);
  return s ? `Your ${ctx.source_name || 'Tally'} books as of ${s}.` : `From your ${ctx.source_name || 'Tally'} books.`;
}
function previewTag(o) { return o.preview ? `[Preview for ${o.company || 'this account'}. They have not been sent this.]\n\n` : ''; }
function fit(sections, foot) {
  // Longest-first trimming if WhatsApp would cut it: drop backing lines, then whole optional sections.
  let text = sections.filter(Boolean).join('\n\n') + '\n\n' + foot;
  if (text.length <= MAX_TEXT) return text;
  text = text.replace(/\nBacking: [^\n]*/g, '');
  if (text.length <= MAX_TEXT) return text;
  return text.slice(0, MAX_TEXT - 40).replace(/\n[^\n]*$/, '') + '\n\n(Shortened. Ask me for the rest.)';
}

/**
 * MORNING. prev: yesterday's morning snapshot (or null). points: the mixed findings. insight: one deep insight or null.
 */
function morning(ctx, fc, snap, prev, points, insight, o) {
  const opt = o || {};
  const head = `${previewTag(opt)}Good morning${greetingName(opt.firstName)}. ${asOfLine(ctx)}`;

  const stand = ['*Where you stand*'];
  if (snap.cash != null) stand.push(`Bank and cash ${inr(snap.cash)}` + (prev && prev.day !== snap.day ? `, ${moved(snap.cash, prev.cash, 'yesterday morning', ctx)}` : '') +
    (snap.borrowed ? `. Overdraft and loans ${inr(snap.borrowed)}` : '') + '.');
  if (snap.recv_total) stand.push(`Customers owe you ${inr(snap.recv_total)}` + (snap.recv_late30 ? `; ${inr(snap.recv_late30)} of it is more than a month late` : '') +
    (prev && prev.recv_total ? ` (${moved(snap.recv_total, prev.recv_total, 'yesterday', ctx)})` : '') + '.');
  if (snap.pay_total) stand.push(`You owe suppliers ${inr(snap.pay_total)}.`);
  const mk = isoDay(ctx.today).slice(0, 7), dom = ctx.today.getUTCDate();
  const mtd = ctx.rows.filter((r) => r.mk === mk && r.dt <= ctx.today).reduce((s, r) => s + r.sales - r.returns, 0);
  if (mtd > 0 && ctx.avgMonthlySales > 0) {
    const dim = new Date(Date.UTC(ctx.today.getUTCFullYear(), ctx.today.getUTCMonth() + 1, 0)).getUTCDate();
    stand.push(`${MONTH_NAME[ctx.today.getUTCMonth()]} so far: sales ${inr(mtd)} in ${dom} day${dom === 1 ? '' : 's'}` +
      (dom >= 7 ? `, on pace for ${inr(mtd / dom * dim)} against your usual ${inr(ctx.avgMonthlySales)}.` : ` (your usual month is ${inr(ctx.avgMonthlySales)}).`));
  }

  const yday = isoDay(new Date(ctx.today.getTime() - DAY));
  const m = movement(ctx, [yday]);
  const ydayLines = [inLine(m), outLine(m), salesLine(m)].filter(Boolean);
  const ySec = ydayLines.length ? ['*Yesterday*'].concat(ydayLines).join('\n') : `*Yesterday*\nNothing entered in ${ctx.source_name || 'Tally'} for yesterday yet.`;

  const week = ['*This week*'];
  const dueIn = dueBetween(ctx, 'receivable', 0, 6), dueOut = dueBetween(ctx, 'payable', 0, 6);
  if (dueLine('Due from customers', dueIn)) week.push(dueLine('Due from customers', dueIn));
  if (dueLine('Due to suppliers', dueOut)) week.push(dueLine('Due to suppliers', dueOut));
  const reg = regularOut(ctx, fc, 0, 6);
  if (reg.length) week.push('Usually goes out: ' + reg.slice(0, 3).map((r) => `${r.what} ${inr(r.amount)} around the ${ordinal(r.when.getUTCDate())}`).join(', ') + '.');
  const g = fc && fc.drivers && fc.drivers.gst_next;
  if (g && g.amount > 0) {
    const left = Math.round((Date.parse(g.date) - ctx.today.getTime()) / DAY);
    if (left >= 0 && left <= 20) week.push(`GST for ${MON[+g.month.slice(5, 7) - 1]}: about ${inr(g.amount)}, due ${E.dayStr(new Date(g.date))} (${left} day${left === 1 ? '' : 's'}).`);
  }
  if (fc && fc.daily && fc.daily.close && fc.daily.close.length >= 7) {
    const c7 = fc.daily.close[6], lo = fc.daily.low[6], hi = fc.daily.high[6];
    week.push(`Cash in 7 days: likely ${inr(c7)}` + (lo != null && hi != null && hi > lo ? ` (${inr(lo)} to ${inr(hi)})` : '') + '.');
    const two = fc.daily.close.slice(0, 14);
    const minV = Math.min(...two), at = two.indexOf(minV);
    if (minV < 0 && snap.cash != null && snap.cash >= 0) week.push(`Heads up: on these patterns cash dips below zero around ${E.dayStr(new Date(ctx.today.getTime() + at * DAY))}, about ${inr(-minV)} short, so that would come from the overdraft.`);
  }

  const wk = weekReview(ctx, snap);
  const pts = points.length
    ? `*${points.length === 1 ? 'One thing that needs you' : points.length + ' things that need you'}*\n\n` + points.map((x, i) => pointBlock(x, i, 'morning')).join('\n\n')
    : '*Needs you today*\nNothing new. Everything I flagged earlier is either sorted or not due for another look yet.';
  const worth = insight ? `*Worth knowing*\n${insight.title}` : null;
  const replies = points.length > 1 ? `Reply ${points.map((_, i) => i + 1).join(', ').replace(/, (\d)$/, ' or $1')} for more on a point` : points.length ? 'Reply 1 for more' : 'Ask me anything about your books';
  const foot = `${replies}, or ask me anything. I'll check back this evening on what moved. Reply STOP ALERTS to pause these.`;
  const text = fit([head, stand.length > 1 ? stand.join('\n') : null, wk, ySec, week.length > 1 ? week.join('\n') : null, pts, worth], foot);
  const headline = points.length
    ? (points.length === 1 ? 'One thing in your books needs you today: ' : `${points.length} things in your books need you today. The biggest: `) + points[0].title
    : `Your morning update is ready: bank and cash ${snap.cash != null ? inr(snap.cash) : 'n/a'}, customers owe ${inr(snap.recv_total)}.`;
  return { text, headline, send: true };
}

/**
 * Mondays: last week (Mon-Sun) against the week before, and the biggest moves. Late money against a week ago
 * comes from the morning snapshots kept in snap.hist.
 */
function weekReview(ctx, snap) {
  if (ctx.today.getUTCDay() !== 1) return null;
  const daysOf = (from) => Array.from({ length: 7 }, (_, i) => isoDay(new Date(ctx.today.getTime() - (from - i) * DAY)));
  const last = movement(ctx, daysOf(7)), before = movement(ctx, daysOf(14));
  if (!last.in_total && !last.out_total && !last.invoices) return null;
  const cmp = (a, b) => b > 0 ? ` (week before ${inr(b)}) ${arrow(a, b)}` : '';
  const lines = ['*Last week*',
    `Collected ${inr(last.in_by.reduce((s, [, v]) => s + v, 0))}${cmp(last.in_by.reduce((s, [, v]) => s + v, 0), before.in_by.reduce((s, [, v]) => s + v, 0))}`,
    `Sales ${inr(last.sales)}${cmp(last.sales, before.sales)}`,
    `Paid out ${inr(last.out_total)}${cmp(last.out_total, before.out_total)}`];
  const wkAgo = ((snap.hist || []).find((h) => h.day === isoDay(new Date(ctx.today.getTime() - 7 * DAY))));
  if (wkAgo && wkAgo.recv_late30 != null) {
    const d = snap.recv_late30 - wkAgo.recv_late30;
    lines.push(`Late money ${inr(snap.recv_late30)}, ${Math.abs(d) < threshold(ctx) ? 'about the same as a week ago' : `${d < 0 ? 'down' : 'up'} ${inr(Math.abs(d))} on a week ago`}.`);
  }
  if (last.in_by[0]) lines.push(`Biggest in: ${last.in_by[0][0]} ${inr(last.in_by[0][1])}.` + (last.out_by[0] && last.out_by[0].top[0] ? ` Biggest out: ${last.out_by[0].top[0][0]} ${inr(last.out_by[0].top[0][1])}.` : ''));
  return lines.join('\n');
}

/** What happened to a customer's balance between two snapshots, and whether a receipt explains it. */
function partyMoves(ctx, before, now, sinceDay) {
  const cur = owedByParty(ctx);
  const t = threshold(ctx);
  const recBy = new Map();
  for (const r of ctx.rows) if (r.kind === 'receipt' && r.party && r.day >= sinceDay) recBy.set(norm(r.party), (recBy.get(norm(r.party)) || 0) + r.total);
  const out = [];
  for (const [k, p] of Object.entries((before && before.parties) || {})) {
    const nowOwed = cur.has(k) ? cur.get(k).owed : 0;
    const drop = p[1] - nowOwed;
    if (drop < t) continue;
    const paid = recBy.get(k) || 0;
    out.push({ key: k, name: p[0], before: p[1], now: nowOwed, drop, paid: paid >= drop * 0.5 ? paid : 0, late30Now: cur.has(k) ? cur.get(k).late30 : 0 });
  }
  return out.sort((a, b) => b.drop - a.drop);
}

/** "point 2 this morning" when a customer was one of the morning's points. */
function pointRef(morningSnap, partyKey) {
  const pts = (morningSnap && morningSnap.points) || [];
  const i = pts.findIndex((p) => p.party && norm(p.party) === partyKey);
  return i >= 0 ? `point ${i + 1} this morning` : null;
}

/**
 * THE DAY'S PULSES (10:30, 12:30, 15:00, 17:00): money that moved since the last update, then what got better,
 * what needs a look, and (at 15:00 only) which of the morning's points haven't moved. Each line is said once a
 * day (snap.said). Nothing worth saying means send: false, and the changes add up for the next pulse.
 * deadlines: findings with a clock on them (margynWatch.choose). watch: parties the morning flagged as quiet or
 * buying less, so an order from them is good news.
 */
function pulse(ctx, fc, snap, last, morningSnap, deadlines, o) {
  const opt = o || {};
  const t = threshold(ctx);
  const today = snap.day;
  const ms = morningSnap && morningSnap.day === today ? morningSnap : null;
  const since = last && last.day === today ? last : ms;
  const fromMorning = !!(since && ms && since.at === ms.at);
  const said = new Set((last && last.day === today && last.said) || []);
  const fresh = [];
  const say = (key, line) => { if (said.has(key)) return false; said.add(key); fresh.push(key); return line; };
  const good = [], bad = [], still = [];
  let important = false;

  // Money since the last update: entries that weren't in the books then.
  const seen = new Set((since && since.seen) || []);
  const newRows = since ? ctx.rows.filter((r) => r.guid && r.dt.getTime() >= ctx.today.getTime() - DAY && !seen.has(r.guid)) : [];
  const m = since ? movement(ctx, null, newRows) : null;
  const moneyLines = [];
  if (m && (m.in_total || m.out_total || m.invoices)) {
    const label = fromMorning ? 'Since this morning' : `Since ${timeIST(since.at) || 'my last update'}`;
    const parts = [m.in_total ? `${inr(m.in_total)} in` + (m.in_by.length ? ` (${m.in_by.slice(0, 2).map(([k, v]) => `${k} ${inr(v)}`).join(', ')})` : '') : null,
      m.out_total ? `${inr(m.out_total)} out` + (m.out_by.length && m.out_by[0].top.length ? ` (${m.out_by[0].top.slice(0, 2).map(([k, v]) => `${k} ${inr(v)}`).join(', ')})` : '') : null,
      m.invoices ? `new sales ${inr(m.sales)}` : null].filter(Boolean);
    moneyLines.push(`*${label}:* ${parts.join(' · ')}.`);
  }
  if (since && snap.cash != null && since.cash != null && Math.abs(snap.cash - since.cash) >= t) moneyLines.push(`Bank and cash ${inr(snap.cash)}, ${moved(snap.cash, since.cash, fromMorning ? 'this morning' : 'my last update', ctx)}.`);
  const moneyMoved = !!(m && (m.in_total >= t || m.out_total >= t || m.sales >= t));

  // Getting better.
  if (since) {
    for (const p of partyMoves(ctx, since, snap, today).slice(0, 4)) {
      const ref = pointRef(ms, p.key);
      const left = p.now >= 1 ? ` ${inr(p.now)} still open${p.late30Now ? `, ${inr(p.late30Now)} of it more than a month late` : ''}.` : ' Nothing left open.';
      if (p.paid) {
        const l = say('paid:' + p.key + ':' + Math.round(p.now), `✅ ${nice(p.name)} paid ${inr(p.paid)}${ref ? ` (${ref})` : ''}.${left}`);
        if (l) { good.push(l); if (ref || p.paid >= 2 * t) important = true; }
      } else {
        const l = say('adjusted:' + p.key + ':' + Math.round(p.now), `${nice(p.name)}'s balance fell ${inr(p.drop)} with no receipt entered, so it's likely a credit note or a deduction${ref ? ` (${ref})` : ''}. Worth knowing why.${left}`);
        if (l) bad.push('⚠️ ' + l);
      }
    }
  }
  if (ms && ms.recv_late30 && ms.recv_late30 - snap.recv_late30 >= t) {
    const l = say('late_down:' + Math.round(snap.recv_late30 / t), `✅ Money more than a month late is down to ${inr(snap.recv_late30)}, from ${inr(ms.recv_late30)} this morning.`);
    if (l) good.push(l);
  }
  const usual = usualDay(ctx);
  const td = movement(ctx, [today]);
  const custIn = td.in_by.reduce((s, [, v]) => s + v, 0);
  if (usual && usual.collected >= t && custIn >= usual.collected) { const l = say('collect_usual', `✅ ${inr(custIn)} collected so far today, already more than a usual full day (${inr(usual.collected)}).`); if (l) good.push(l); }
  if (usual && usual.sales >= t && td.sales >= usual.sales) { const l = say('sales_usual', `✅ Sales today ${inr(td.sales)}, already past a usual full day (${inr(usual.sales)}).`); if (l) good.push(l); }
  const watch = new Map(((ms && ms.watchlist) || []).map((w) => [norm(w.party), w]));
  const owed = owedByParty(ctx);
  for (const r of newRows) {
    if (r.kind !== 'sales' || !r.party) continue;
    const k = norm(r.party), w = watch.get(k);
    if (w) { const l = say('back:' + k, `✅ New order from ${nice(r.party)}, ${inr(r.sales - r.returns)}. ${w.kind === 'quiet' ? 'They had gone quiet' : 'They\'d been buying less'}, so that's a good sign.`); if (l) good.push(l); }
    // Needs a look: more credit to someone who isn't paying.
    const g = owed.get(k);
    if (g && g.late30 >= t && g.maxLate > 60) {
      const l = say('credit_to_late:' + k, `⚠️ New ${inr(r.sales - r.returns)} invoice to ${nice(r.party)}, who already owes ${inr(g.late30)} that's more than a month late (oldest ${g.maxLate} days). That's more credit to someone who isn't paying; worth asking for part of the old money first.`);
      if (l) { bad.push(l); important = true; }
    }
    // Sold below cost today.
    let loss = 0; const items = [];
    for (const it of r.items || []) {
      const q = num(it.qty), v = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
      const c = ctx.unitCost(it.item).cost;
      if (!(q > 0) || !(c > 0)) continue;
      const price = v / q;
      if (price < c && price >= 0.25 * c) { loss += (c - price) * q; items.push(it.item); }
    }
    if (loss >= Math.max(5000, t / 5)) { const l = say('below_cost:' + r.guid, `⚠️ ${items.slice(0, 2).join(', ')} went to ${nice(r.party)} below cost today, about ${inr(loss)} under what it costs you.`); if (l) bad.push(l); }
  }

  // Needs a look.
  const pastDue = new Map();
  for (const b of E.billRows(ctx, 'receivable')) if (b.late === 1) pastDue.set(nice(b.party), (pastDue.get(nice(b.party)) || 0) + b.amount);
  for (const [name, amt] of [...pastDue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    if (amt < t) continue;
    const l = say('pastdue:' + norm(name), `⚠️ ${inr(amt)} from ${name} went past due today. A reminder now is routine.`);
    if (l) bad.push(l);
  }
  const usualLedgers = new Set(((fc && fc.drivers && fc.drivers.recurring) || []).map((x) => norm(x.ledger)));
  for (const e of cashFlow.cashEvents(ctx, newRows)) {
    if (e.amount >= 0 || e.category === 'transfers_loans' || -e.amount < 2 * t || usualLedgers.has(norm(e.ledger))) continue;
    const who = e.party ? nice(e.party) : e.ledger;
    const l = say('bigout:' + norm(who) + ':' + Math.round(-e.amount), `⚠️ ${inr(-e.amount)} went out to ${who}. It isn't one of your usual monthly payments.`);
    if (l) bad.push(l);
  }
  if (since && snap.borrowed != null && since.borrowed != null && snap.borrowed - since.borrowed >= 2 * t) {
    const l = say('od_up:' + Math.round(snap.borrowed / t), `⚠️ Overdraft and loans up ${inr(snap.borrowed - since.borrowed)} to ${inr(snap.borrowed)}.`);
    if (l) bad.push(l);
  }
  const dupSeen = new Map();
  for (const r of ctx.rows) {
    if (r.dt.getTime() < ctx.today.getTime() - DAY || !['sales', 'purchase', 'payment'].includes(r.kind) || !r.party || r.total < t) continue;
    const k = r.kind + '|' + norm(r.party) + '|' + r.day + '|' + Math.round(r.total);
    const prev = dupSeen.get(k);
    if (prev && prev.number !== r.number && (!seen.has(r.guid) || !seen.has(prev.guid))) {
      const l = say('dup:' + k, `⚠️ Two ${r.kind === 'sales' ? 'invoices' : r.kind === 'purchase' ? 'purchase bills' : 'payments'} of ${inr(r.total)} to ${nice(r.party)} on the same day${prev.number || r.number ? ' (' + [prev.number, r.number].filter(Boolean).join(' and ') + ')' : ''}. Entered twice?`);
      if (l) bad.push(l);
    } else dupSeen.set(k, r);
  }
  // Tally gone quiet during a working day: every pulse depends on it.
  const nowMs = Date.parse(snap.at), syncMs = Date.parse(ctx.lastSync || '');
  const dow = new Date(nowMs + 5.5 * 3600000).getUTCDay();
  if (!Number.isNaN(syncMs) && dow !== 0 && nowMs - syncMs > 2 * 3600000 && nowMs - syncMs < 26 * 3600000) {
    const l = say('sync_gap', `⚠️ Tally hasn't synced since ${istStamp(ctx.lastSync)}. Is the Tally PC on with Tally open? Until it syncs, today's entries don't reach me.`);
    if (l) { bad.push(l); important = true; }
  }
  for (const d of deadlines || []) { const l = say('deadline:' + d.key, `⚠️ ${d.title}${d.action ? ' ' + d.action : ''}`); if (l) { bad.push(l); important = true; } }

  // Not moving yet: the morning's points, once, in the afternoon pulse.
  if (opt.slot === 'afternoon' && ms) {
    const moves = new Map(partyMoves(ctx, ms, snap, today).map((p) => [p.key, p]));
    (ms.points || []).forEach((p, i) => {
      if (!p.party || !RECEIVABLE_KINDS.has(p.kind)) return;
      const k = norm(p.party);
      if (moves.has(k)) return;
      const bal = ms.parties[k];
      const l = say('still:' + p.key, `⏳ ${nice(p.party)} (point ${i + 1} this morning): nothing in yet` + (bal ? `, ${inr(bal[1])} open.` : '.'));
      if (l) still.push(l);
    });
  }

  const pulses = (last && last.day === today && last.pulses) || 0;
  const send = (good.length + bad.length > 0 || moneyMoved) && pulses < 4;
  if (!send) return { send: false, said: [...said] };
  const when = timeIST(snap.at);
  const head = `${previewTag(opt)}${when ? when + ' update' : 'Update'}${greetingName(opt.firstName) ? ',' + greetingName(opt.firstName) : ''}. ${asOfLine(ctx)}`;
  const sections = [head, moneyLines.join('\n') || null,
    good.length ? '*Getting better*\n' + good.join('\n') : null,
    bad.length ? '*Needs a look*\n' + bad.join('\n') : null,
    still.length ? '*Not moving yet*\n' + still.join('\n') : null];
  const text = fit(sections, 'Ask me about any of it in your own words, like "why did cash drop?" Reply STOP ALERTS to pause these.');
  const first = (good[0] || bad[0] || moneyLines[0] || '').replace(/^[✅⚠️⏳*\s]+/u, '').replace(/\*/g, '');
  return { text, headline: first, send: true, important, said: [...said], pulses: pulses + 1 };
}
/**
 * EVENING: today's money, then each of this morning's points checked again, then tomorrow, then at most one new
 * urgent thing. live: the current findings (to see which morning points are sorted). fresh: new points the
 * evening may raise (already filtered, high severity only).
 */
function evening(ctx, fc, snap, morningSnap, live, fresh, promises, o) {
  const opt = o || {};
  const head = `${previewTag(opt)}Evening wrap${greetingName(opt.firstName)}. ${asOfLine(ctx)}`;
  const today = snap.day;
  const m = movement(ctx, [today]);
  const day = ['*Today*'].concat([inLine(m), outLine(m), salesLine(m)].filter(Boolean));
  if (day.length === 1) day.push(`Nothing entered in ${ctx.source_name || 'Tally'} for today yet.`);
  const ms = morningSnap && morningSnap.day === today ? morningSnap : null;
  if (snap.cash != null) day.push(`Bank and cash ${inr(snap.cash)}` + (ms && ms.cash != null ? `, ${moved(snap.cash, ms.cash, 'this morning', ctx)}` : '') + '.');
  const usual = usualDay(ctx);
  if (usual) {
    const custIn = m.in_by.reduce((s, [, v]) => s + v, 0);
    const vs = [`Collected ${inr(custIn)} (usual ${inr(usual.collected)}) ${arrow(custIn, usual.collected)}`,
      `Sales ${inr(m.sales)} (usual ${inr(usual.sales)}) ${arrow(m.sales, usual.sales)}`,
      `Paid out ${inr(m.out_total)} (usual ${inr(usual.out)}) ${arrow(m.out_total, usual.out)}`];
    if (ms && ms.recv_late30 != null) { const d = snap.recv_late30 - ms.recv_late30; vs.push(`Late money ${inr(snap.recv_late30)}` + (Math.abs(d) >= threshold(ctx) ? `, ${d < 0 ? 'down' : 'up'} ${inr(Math.abs(d))} today ${d < 0 ? '↓' : '↑'}` : ', unchanged today')); }
    day.push('', '*Today against a usual day*', vs.join('\n'));
  }

  // This morning's points, checked again.
  const fu = [];
  let open = 0;
  const liveByKey = new Map((live || []).map((x) => [x.key, x]));
  const moves = ms ? new Map(partyMoves(ctx, ms, snap, today).map((p) => [p.key, p])) : new Map();
  const promiseFor = (party) => (promises || []).find((p) => norm(p.party) === norm(party));
  ((ms && ms.points) || []).forEach((p, i) => {
    if (!FOLLOW_UP_KINDS.has(p.kind)) return;
    const n = `${i + 1}.`;
    const now = liveByKey.get(p.key);
    const pk = p.party ? norm(p.party) : null;
    const mv = pk ? moves.get(pk) : null;
    const name = p.party ? nice(p.party) : null;
    if (mv) {
      const left = mv.now >= 1 ? ` ${inr(mv.now)} still open${mv.late30Now ? `, ${inr(mv.late30Now)} more than a month late` : ''}.` : ' Fully cleared.';
      fu.push(`${n} ✅ ${name}: ${mv.paid ? `paid ${inr(mv.paid)} today` : `balance down ${inr(mv.drop)} (credit note or adjustment, no receipt)`}.${left}`);
      if (mv.now >= 1 && now) open++;
      return;
    }
    if (!now) { fu.push(`${n} ✅ ${name ? name + ': ' : ''}sorted. ${p.kind === 'stale' ? 'Tally is syncing again.' : 'It no longer shows in the books.'}`); return; }
    open++;
    if (p.kind === 'stale') { fu.push(`${n} ⏳ Tally still hasn't synced. Everything above is from before that.`); return; }
    if (p.kind === 'gst_due') { fu.push(`${n} ⏳ ${now.title} Still to pay.`); return; }
    if (pk) {
      const pr = promiseFor(p.party);
      const bal = ms.parties[pk];
      fu.push(`${n} ⏳ ${name}: nothing in yet` + (bal ? `; ${inr(bal[1])} still open` : '') + '.' +
        (pr ? ` They promised ${inr(pr.amount)} by ${E.dayStr(new Date(pr.date))}.` : ' Did you reach them? Tell me what they said and I\'ll keep track.'));
      return;
    }
    fu.push(`${n} ⏳ Still open: ${now.title}`);
  });

  // Tomorrow.
  const tm = ['*Tomorrow*'];
  const dIn = dueBetween(ctx, 'receivable', 1, 1), dOut = dueBetween(ctx, 'payable', 1, 1);
  if (dueLine('Due from customers', dIn)) tm.push(dueLine('Due from customers', dIn));
  if (dueLine('Due to suppliers', dOut)) tm.push(dueLine('Due to suppliers', dOut));
  const reg = regularOut(ctx, fc, 1, 1);
  if (reg.length) tm.push('Usually goes out: ' + reg.slice(0, 3).map((r) => `${r.what} ${inr(r.amount)}`).join(', ') + '.');
  const g = fc && fc.drivers && fc.drivers.gst_next;
  if (g && g.amount > 0 && Math.round((Date.parse(g.date) - ctx.today.getTime()) / DAY) === 1) tm.push(`GST due: about ${inr(g.amount)}.`);

  const newOne = (fresh || []).slice(0, 1);
  const sections = [head, day.join('\n'),
    fu.length ? '*This morning\'s points*\n' + fu.join('\n') : null,
    tm.length > 1 ? tm.join('\n') : null,
    newOne.length ? '*One new thing*\n' + pointBlock(newOne[0], 0, 'evening').replace(/^1\. /, '') : null];
  const foot = (fu.length ? 'Tell me what happened on any of these, or ask me anything.' : 'Ask me anything about your books.') + ' Reply STOP ALERTS to pause these.';
  const moneyMoved = m.in_total > 0 || m.out_total > 0 || m.invoices > 0;
  const send = moneyMoved || fu.length > 0 || newOne.length > 0 || tm.length > 1;
  const headline = 'Evening wrap: ' + (m.in_total ? `${inr(m.in_total)} came in today` : 'no money in from customers today') +
    (fu.length ? `; ${open} of this morning's ${fu.length} point${fu.length === 1 ? ' is' : 's are'} still open.` : '.');
  return { text: fit(sections, foot), headline, send, open };
}

module.exports = {
  snapshot, movement, deepInsights, mix, morning, pulse, evening, usualDay, weekReview, whyNow, pointBlock, partyMoves, dueBetween, regularOut,
  istDay, istStamp, RECEIVABLE_KINDS, INSIGHT_KINDS, FOLLOW_UP_KINDS, MAX_POINTS
};
