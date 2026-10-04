/**
 * The learned 13-week forecast (api/_lib/cashFlowModel.js) on a made-up business whose habits we know:
 * customer Alpha pays in ~30 days, Beta in ~60, salary on the 1st, rent on the 5th, loan EMIs entered ahead.
 * Zero-dep. Run: node api/_lib/__tests__/cashFlowModel.test.js
 */
const E = require('../booksEngine');
const CF = require('../cashFlowModel');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };
const DAY = 86400000;
const NOW = new Date('2026-10-04T06:00:00Z');   // 11:30 IST, 4 Oct
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const D = (s) => Date.parse(s + 'T00:00:00Z');

// ---------- a business, Apr 1 – Oct 3 ----------
const V = []; let g = 0;
const bal = { Bank: 2000000, Alpha: 0, Beta: 0, Supplier: 0 };
const v = (type, date, party, entries, extra) => { V.push(Object.assign({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries }, extra || {})); };
const sale = (date, party, amt) => { const tax = Math.round(amt * 0.18); v('Sales', date, party, [{ ledger: party, amount: -(amt + tax), is_party: true }, { ledger: 'Sales', amount: amt }, { ledger: 'Output GST', amount: tax }]); bal[party] += amt + tax; return amt + tax; };
const receipt = (date, party, amt) => { v('Receipt', date, party, [{ ledger: party, amount: amt, is_party: true }, { ledger: 'Bank', amount: -amt }]); bal[party] -= amt; bal.Bank += amt; };
const pay = (date, ledger, amt, party) => { v('Payment', date, party || null, [{ ledger, amount: -amt, is_party: !!party }, { ledger: 'Bank', amount: amt }]); bal.Bank -= amt; if (party) bal[party] += amt; };
const today = D('2026-10-04');
for (let t = D('2026-04-01'); t < today; t += DAY) {
  const d = new Date(t), dow = d.getUTCDay(), dom = d.getUTCDate(), ds = iso(t);
  if (dow === 1) { const a = sale(ds, 'Alpha', 300000); if (t + 30 * DAY < today) receipt(iso(t + 30 * DAY), 'Alpha', a); }
  if (dow === 3) { const b = sale(ds, 'Beta', 200000); if (t + 60 * DAY < today) receipt(iso(t + 60 * DAY), 'Beta', b); }
  if (dow === 2) { v('Purchase', ds, 'Supplier', [{ ledger: 'Supplier', amount: 250000, is_party: true }, { ledger: 'Purchases', amount: -250000 }]); bal.Supplier -= 250000; }
  if (dow === 5) pay(ds, 'Supplier', 240000, 'Supplier');
  if (dom === 1) pay(ds, 'Salary', 400000);
  if (dom === 5) pay(ds, 'Rent', 100000);
  if (dom === 20) pay(ds, 'GST Payable', 150000);
}
V.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
// Loan EMIs entered ahead (future-dated), like Care Hygiene's.
for (const m of ['2026-10-10', '2026-11-10', '2026-12-10']) V.push({ tally_guid: 'emi' + m, voucher_type: 'Payment', voucher_number: 'E', date: m, party_name: null, amount: 50000, is_cancelled: false, entries: [{ ledger: 'Kotak Loan', amount: -50000 }, { ledger: 'Bank', amount: 50000 }] });
// Balances as Tally gives them ('same' convention: debit negative, like the entries) for the whole year,
// including the EMIs entered ahead. P&L ledgers carry closings too, so the engine can see which way they run.
const GROUP = { Bank: 'Bank Accounts', Alpha: 'Sundry Debtors', Beta: 'Sundry Debtors', Supplier: 'Sundry Creditors', Sales: 'Sales Accounts',
  Purchases: 'Purchase Accounts', 'Output GST': 'Duties & Taxes', 'GST Payable': 'Duties & Taxes', Salary: 'Indirect Expenses',
  Rent: 'Indirect Expenses', 'Kotak Loan': 'Secured Loans' };
const OPEN = { Bank: -2000000, 'Kotak Loan': 1000000 };
const MOVE = {};
for (const x of V) for (const e of x.entries) MOVE[e.ledger] = (MOVE[e.ledger] || 0) + e.amount;
const L = Object.keys(GROUP).map((name) => ({ name, parent: GROUP[name], opening_balance: OPEN[name] || 0, closing_balance: (OPEN[name] || 0) + (MOVE[name] || 0) }));
const book = { connected: true, company: 'Test Co', ledgers: L, vouchers: V, bills: [], overrides: {}, syncRuns: [] };
const ctx = E.prepare(book, { now: NOW });

// ---------- 1. movements ----------
const ev = CF.cashEvents(ctx);
const bankVouchers = V.filter((x) => x.date < '2026-10-04' && x.entries.some((e) => e.ledger === 'Bank')).length;
check('every bank movement is filed', ev.length === bankVouchers && ev.every((e) => e.category && e.category !== 'other'), [ev.length, bankVouchers]);
check('receipts from customers are "customers"', ev.filter((e) => e.amount > 0).every((e) => e.category === 'customers'));
check('salary is a running cost', ev.some((e) => e.ledger === 'Salary' && e.category === 'running_costs'));
const fut = CF.futureEvents(ctx);
check('EMIs entered ahead are known future outflows', fut.length === 3 && fut[0].amount === -50000 && fut[0].day === '2026-10-10', fut);
check('cash today backs out the EMIs', Math.round(ctx.analytics.cash.total) === Math.round(bal.Bank), [ctx.analytics.cash.total, bal.Bank]);

// Books whose balances are debit-positive (Zoho, Odoo adapters) add entries made ahead back instead.
const A = require('../tallyAnalytics');
const emi = [{ date: '2026-10-10', is_cancelled: false, entries: [{ ledger: 'Bank', amount: 50000 }, { ledger: 'Kotak Loan', amount: -50000 }] }];
const opp = A.asOfToday([{ name: 'Bank', closing_balance: 950000 }], emi, NOW, 'opposite').ledgers[0].closing_balance;
const same = A.asOfToday([{ name: 'Bank', closing_balance: -950000 }], emi, NOW).ledgers[0].closing_balance;
check('entries made ahead backed out for both balance directions', opp === 1000000 && same === -1000000, [opp, same]);
const zb = E.prepare(Object.assign({}, book, { balance_convention: 'opposite', ledgers: [] }), { now: NOW });
check('declared direction used when the books can\'t show it', zb.analytics.quality.balance_sign.effective === 'opposite' && zb.analytics.quality.balance_sign.declared === 'opposite', zb.analytics.quality.balance_sign);

// ---------- 2. habits ----------
const H = CF.customerHabits(ctx, today - 1);
const hA = CF.habitOf(H.parties.get('alpha'), H.pool), hB = CF.habitOf(H.parties.get('beta'), H.pool);
check('Alpha pays in ~30 days (learned)', hA.own && hA.p50 === 30, hA);
check('Beta pays in ~60 days (learned)', hB.own && hB.p50 === 60, hB);
check('open invoices rebuilt = what they owe', Math.round([...H.parties.values()].reduce((t, p) => t + p.open.reduce((s, x) => s + x.amt, 0), 0)) === Math.round(bal.Alpha + bal.Beta));

// ---------- 3. recurring ----------
const rec = CF.recurringPayments(ev, today - 1, new Set(['kotak loan']));
const sal = rec.find((r) => r.ledger === 'Salary'), rent = rec.find((r) => r.ledger === 'Rent');
check('salary found as recurring on the 1st', sal && sal.day_of_month === 1 && sal.amount === 400000, rec);
check('rent found as recurring on the 5th', rent && rent.day_of_month === 5 && rent.amount === 100000);
check('supplier payments are not "recurring" (weekly pace instead)', !rec.some((r) => r.ledger === 'Supplier'));

// ---------- 4–6. forecast ----------
const promises = [{ party: 'Beta', amount: 236000, date: '2026-10-08' }];
const out = CF.build(ctx, { promises });
check('13 weeks, from today', out.weeks.length === 13 && out.weeks[0].from === '2026-10-04', out.weeks[0]);
check('opens on today\'s cash', out.opening === Math.round(bal.Bank));
check('EMIs on their dates', out.drivers.known_ahead.length === 3 && out.parts.known_ahead === -150000, out.parts);
check('salary and rent scheduled (recurring)', out.drivers.recurring.some((r) => r.ledger === 'Salary') && out.parts.recurring < -1000000, out.parts);
check('GST from the books on the 20th', out.drivers.gst_next && out.parts.gst < 0, out.drivers.gst_next);
check('promise counted on its date', out.parts.promised === 236000, out.parts);
check('sales pace learned (Alpha ₹3.54 L + Beta ₹2.36 L a week)', out.drivers.pace.sales_weekly === 590000, out.drivers.pace);
check('supplier pace learned (₹2.4 L a week)', out.drivers.pace.suppliers_weekly === 240000, out.drivers.pace);
check('range: cautious ≤ likely ≤ hopeful at week 13', out.weeks[12].low <= out.weeks[12].close && out.weeks[12].close <= out.weeks[12].high, out.weeks[12]);
check('daily path has 91 days', out.daily.close.length === 91);
// A steady business: weekly net ≈ sales 5.9 L − suppliers 2.4 L − salary/rent ~1.15 L/wk − GST ~0.35 L/wk ≈ +2 L/wk.
const drift = (out.weeks[12].close - out.opening) / 13;
check('steady business drifts the way its books do (+₹1.5–2.6 L a week)', drift > 150000 && drift < 260000, drift);

// ---------- 7. self-check ----------
check('self-check ran 3 times on the past', out.self_check.checks.length === 3, out.self_check);
const worst = Math.max(...out.self_check.checks.map((c) => Math.abs(c.actual_customer_in - c.predicted_customer_in) / c.actual_customer_in));
check('it predicted its own past within 25% on customer money in', worst < 0.25, out.self_check.checks);
check('learned factor stays in bounds', out.self_check.collection_factor >= 0.6 && out.self_check.collection_factor <= 1.3);

// ---------- history ----------
check('weekly history of cash, receivables, payables', out.history.length > 20 && out.history.every((w) => w.cash != null && w.receivables != null));
check('receivables today = what customers owe', out.receivables_today === Math.round(bal.Alpha + bal.Beta), [out.receivables_today, bal.Alpha + bal.Beta]);
const lastW = out.history[out.history.length - 1];
check('days to collect ≈ 45 (mix of 30 and 60)', lastW.days_to_collect >= 38 && lastW.days_to_collect <= 52, lastW);

// ---------- doubtful + accuracy ----------
const old = CF.forecast(ctx, { asOfMs: today, opening: 0, openItems: [{ party: 'Alpha', amt: 100000, ageDays: 500 }] });
check('a 500-day-old invoice is left out as doubtful', old.drivers.doubtful.amount === 100000);
const acc = CF.accuracyFromRuns([{ run_date: '2026-09-01', daily_close: Array.from({ length: 91 }, () => 3000000) }], ctx.analytics.cash_history.points);
check('stored runs are graded at 7 and 28 days', acc.length === 2 && acc[0].horizon_days === 7 && acc[0].error === acc[0].predicted - acc[0].actual, acc);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
