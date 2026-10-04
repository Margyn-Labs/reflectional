/**
 * Accuracy of the learned forecast (api/_lib/cashFlowModel.js) on a realistic book: 250 customers trading since
 * Oct 2025, so the year's book opens with last year's balances (no dates), like Tally. Two ways of paying:
 * anything from 15 to 135 days ('uniform': invoices are often paid out of order, which oldest-first matching
 * can't see), and each customer around their own habit with a late tail ('habit').
 * The self-check runs the model as of every past week and scores 4 weeks of customer money in and cash.
 * Zero-dep, seeded (same numbers every run). Run: node api/_lib/__tests__/cashFlowAccuracy.test.js
 */
const E = require('../booksEngine');
const CF = require('../cashFlowModel');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };
const DAY = 86400000, D = (s) => Date.parse(s + 'T00:00:00Z'), iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function business(mode) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const FY = D('2026-04-01'), today = D('2026-10-04');
  const all = []; let g = 0;
  const v = (type, t, party, entries) => all.push({ t, tally_guid: 'g' + (++g), voucher_type: type, date: iso(t), party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries });
  const cust = Array.from({ length: 250 }, (_, i) => ({ n: 'C' + i, base: 20 + Math.floor(rnd() * 80) }));
  const lagOf = (c) => (mode === 'uniform' ? Math.round(15 + rnd() * 120) : Math.max(5, Math.round(c.base * (0.6 + rnd() * 0.8) + (rnd() < 0.1 ? 60 : 0))));
  for (let t = D('2025-10-01'); t < today; t += DAY) {
    for (let k = 0; k < 40; k++) {
      const c = cust[Math.floor(rnd() * 250)], a = Math.round(10000 + rnd() * 90000), lag = lagOf(c);
      v('Sales', t, c.n, [{ ledger: c.n, amount: -a, is_party: true }, { ledger: 'Sales', amount: a }]);
      if (t + lag * DAY < today) v('Receipt', t + lag * DAY, c.n, [{ ledger: c.n, amount: a, is_party: true }, { ledger: 'Bank', amount: -a }]);
    }
    for (let k = 0; k < 12; k++) {
      const a = Math.round(10000 + rnd() * 80000);
      v('Purchase', t, 'S', [{ ledger: 'S', amount: a, is_party: true }, { ledger: 'Purchases', amount: -a }]);
      v('Payment', t + 7 * DAY, 'S', [{ ledger: 'S', amount: -a, is_party: true }, { ledger: 'Bank', amount: a }]);
    }
  }
  all.sort((a, b) => a.t - b.t);
  const OPEN = { Bank: -50000000 }, MOVE = {}, PL = new Set(['Sales', 'Purchases']);
  for (const x of all) for (const e of x.entries) {
    if (x.t < FY) { if (!PL.has(e.ledger)) OPEN[e.ledger] = (OPEN[e.ledger] || 0) + e.amount; } else MOVE[e.ledger] = (MOVE[e.ledger] || 0) + e.amount;
  }
  const vouchers = all.filter((x) => x.t >= FY && x.t < today).map(({ t, ...r }) => r);
  const ledgers = [['Bank', 'Bank Accounts'], ['Sales', 'Sales Accounts'], ['Purchases', 'Purchase Accounts'], ['S', 'Sundry Creditors'], ...cust.map((c) => [c.n, 'Sundry Debtors'])]
    .map(([name, parent]) => ({ name, parent, opening_balance: OPEN[name] || 0, closing_balance: (OPEN[name] || 0) + (MOVE[name] || 0) }));
  return { connected: true, ledgers, vouchers, bills: [], overrides: {}, syncRuns: [] };
}

for (const mode of ['uniform', 'habit']) {
  const t0 = Date.now();
  const ctx = E.prepare(business(mode), { now: new Date('2026-10-04T06:00:00Z') });
  const out = CF.build(ctx, {});
  const ms = Date.now() - t0, sc = out.self_check;
  const errs = sc.checks.map((c) => (c.predicted_customer_in - c.actual_customer_in) / c.actual_customer_in);
  const miss = errs.reduce((t, e) => t + Math.abs(e), 0) / errs.length, lean = errs.reduce((t, e) => t + e, 0) / errs.length;
  const flow = sc.checks.reduce((t, c) => t + c.actual_customer_in, 0) / sc.checks.length;
  const cashMiss = sc.checks.reduce((t, c) => t + Math.abs(c.cash_error), 0) / sc.checks.length / flow;
  console.log(`  ${mode}: ${ctx.rows.length} entries, ${ms} ms, ${sc.runs} runs, customer money in: miss ${(miss * 100).toFixed(1)}% lean ${(lean * 100).toFixed(1)}%, cash miss ${(cashMiss * 100).toFixed(1)}% of a month's collections, factor ${sc.collection_factor}, suppliers by ${sc.supplier_method} ${JSON.stringify(sc.supplier_miss)}`);
  check(`${mode}: balances read the right way round`, ctx.analytics.quality.balance_sign.effective === 'same');
  check(`${mode}: self-check ran on 8+ past weeks`, sc.runs >= 8);
  check(`${mode}: 4-week customer money in, avg miss under 6%`, miss < 0.06, errs);
  check(`${mode}: no lean over 5% either way`, Math.abs(lean) < 0.05, lean);
  check(`${mode}: 4-week cash miss under 8% of a month's collections`, cashMiss < 0.08, cashMiss);
  check(`${mode}: no big correction needed (factor 0.9–1.1)`, sc.collection_factor >= 0.9 && sc.collection_factor <= 1.1, sc.collection_factor);
  check(`${mode}: builds in under 5 s`, ms < 5000, ms);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
