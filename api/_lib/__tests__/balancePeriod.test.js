/** Run: node api/_lib/__tests__/balancePeriod.test.js — zero-dep, no network.
 * Tally's balances cover whatever period is on its screen (tallyAnalytics.balancePeriod / alignToToday).
 * The books here are shaped like Care Hygiene on 11 Oct 2026: one Tally company holding FY 2025-26 and
 * FY 2026-27, the screen left on 2025-26 (so every balance stops at 31 Mar 2026), loan EMIs entered ahead. */
const A = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''))); };
const NOW = '2026-10-11T06:00:00Z';

// Tally's own signs: entries and balances both negative = debit.
let g = 0;
const V = (type, date, party, entries) => ({ tally_guid: 'g' + (++g), voucher_type: type, voucher_number: String(g), date, party_name: party, amount: Math.abs(entries[0][1]), is_cancelled: false,
  entries: entries.map(([ledger, amount, is_party]) => ({ ledger, amount, is_party: !!is_party })) });
const vouchers = [];
const months = [];
for (let i = 0; i < 19; i++) { const y = 2025 + Math.floor((3 + i) / 12), m = (3 + i) % 12 + 1; months.push([y, m]); }   // Apr 2025 .. Oct 2026
const ymd = (y, m, d) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
months.forEach(([y, m], i) => {
  const last = y === 2026 && m === 10;
  const sale = 1000000 + i * 50000, buy = 700000 + i * 20000;
  vouchers.push(V('Sales', ymd(y, m, 5), 'Alkem', [['Alkem', -sale * 1.12, true], ['GST Sale', sale], ['Output GST', sale * 0.12]]));
  vouchers.push(V('Purchase', ymd(y, m, 6), 'Supplier A', [['Supplier A', buy * 1.12, true], ['Purchase GST', -buy], ['Input GST', -buy * 0.12]]));
  if (!last) vouchers.push(V('Receipt', ymd(y, m, 20), 'Alkem', [['Alkem', sale * 0.9, true], ['Kotak Bank', -sale * 0.9]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 22), 'Supplier A', [['Supplier A', -buy, true], ['Kotak Bank', buy]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 28), null, [['Salary', -100000], ['Kotak Bank', 100000]]));
  if (!last) vouchers.push(V('Payment', ymd(y, m, 10), null, [['Kotak Loan', -50000], ['Interest on Loan', -7573], ['Kotak Bank', 57573]]));
});
vouchers.push(V('Journal', '20260331', null, [['Depreciation', -500000], ['Plant', 500000]]));           // year end only
vouchers.push(V('Payment', '20260715', null, [['Packing @ 5%', -35000], ['Kotak Bank', 35000]]));         // a ledger new this year
// EMIs entered ahead for Nov 2026 to Mar 2027
const future = [11, 12, 1, 2, 3].map((m) => V('Payment', ymd(m >= 11 ? 2026 : 2027, m, 10), null, [['Kotak Loan', -50000], ['Interest on Loan', -7573], ['Kotak Bank', 57573]]));
const all = vouchers.concat(future);

const OPEN = { 'Kotak Bank': -2000000, 'Kotak Loan': 5000000, 'Alkem': -3000000, 'Supplier A': 1500000, 'Plant': -4000000, 'Stock-in-hand': -4062250 };
const GROUP = { 'Kotak Bank': 'Bank Accounts', 'Kotak Loan': 'Secured Loans', 'Alkem': 'Sundry Debtors', 'Supplier A': 'Sundry Creditors', 'Plant': 'Fixed Assets', 'Stock-in-hand': 'Stock-in-hand',
  'GST Sale': 'Sales Accounts', 'Purchase GST': 'Purchase Accounts', 'Salary': 'Indirect Expenses', 'Interest on Loan': 'Indirect Expenses', 'Depreciation': 'Indirect Expenses', 'Packing @ 5%': 'Direct Expenses',
  'Output GST': 'Duties & Taxes', 'Input GST': 'Duties & Taxes' };
const moved = (name, from, to) => all.filter((v) => v.date >= from && v.date <= to).reduce((s, v) => s + v.entries.filter((e) => e.ledger === name).reduce((a, e) => a + e.amount, 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;
// What Tally answers with the given period on its screen.
const tallyLedgers = (from, to) => Object.keys(GROUP).map((name) => {
  const pl = /Sales|Purchase|Expenses/.test(GROUP[name]);
  const opening = pl ? 0 : r2((OPEN[name] || 0) + moved(name, '20250401', String(+from - 1)));
  return { name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: opening, closing_balance: name === 'Stock-in-hand' ? -5759321 : r2(opening + moved(name, from, to)) };
});
const truth = (name) => r2((OPEN[name] || 0) + moved(name, '20250401', '20261011'));
const bal = (t, name) => t.ledgers.find((l) => l.name === name);

/* ---- the screen left on last year: balances stop at 31 Mar 2026 ---- */
{
  const led = tallyLedgers('20250401', '20260331');
  const bp = A.balancePeriod(led, all);
  check('the period Tally used is found from the entries alone', bp && new Date(bp.from).toISOString().slice(0, 10) === '2025-04-01' && new Date(bp.to).toISOString().slice(0, 10) === '2026-03-31' && bp.sign === 'same', bp && { from: new Date(bp.from), to: new Date(bp.to), tied: bp.tied, tested: bp.tested, sign: bp.sign });
  check('every ledger with entries ties to that period', bp.tied === bp.tested && bp.tie.every((t) => t.ok), bp.tie.filter((t) => !t.ok));
  const t = A.asOfToday(led, all, NOW);
  check('balances are carried forward to today', t.balances && t.balances.rolled_forward && t.guard.decision === 'rolled_forward' && t.balances.carried_vouchers > 0, t.balances && { ...t.balances, tie: undefined });
  for (const n of ['Kotak Bank', 'Kotak Loan', 'Alkem', 'Supplier A']) check(`${n}: today's balance, to the rupee`, bal(t, n).closing_balance === truth(n), { got: bal(t, n).closing_balance, want: truth(n), tally_said: bal(t, n).tally_closing_balance });
  check('March\'s bank balance was NOT today\'s (the bug this fixes)', bal(t, 'Kotak Bank').tally_closing_balance !== truth('Kotak Bank'));
  check('EMIs entered for later dates wait for their date and are not taken off a balance that never had them', t.future.length === 5 && t.vouchers.length === all.length - 5 && bal(t, 'Kotak Loan').closing_balance === truth('Kotak Loan'));
  check('opening balances are left as Tally gave them (they are as at the first entry)', bal(t, 'Kotak Bank').opening_balance === OPEN['Kotak Bank']);
  check('opening + every synced entry to today = closing, for every ledger (what every reader assumes)', t.ledgers.every((l) => l.name === 'Stock-in-hand' || Math.abs(l.opening_balance + moved(l.name, '20250401', '20261011') - l.closing_balance) < 0.01));

  const a = A.computeAnalytics({ ledgers: led, vouchers: all, bills: [{ direction: 'receivable', party_name: 'Alkem', bill_ref: 'A1', closing_balance: 3000000, overdue_days: 40 }], now: NOW });
  const fy = months.filter(([y, m]) => (y === 2026 && m >= 4)), sumSales = fy.reduce((s, [y, m]) => s + 1000000 + months.findIndex((x) => x[0] === y && x[1] === m) * 50000, 0);
  check('the totals are this financial year, not both years added', a.period.from === '2026-04-05' && a.period.net_sales === sumSales, a.period);
  check('each year is shown on its own', a.years.length === 2 && a.years[0].fy === '2025-26' && a.years[1].fy === '2026-27' && a.years[1].current && r2(a.years[0].net_sales + a.years[1].net_sales) === a.pnl.reduce((s, r) => s + r.net_sales, 0), a.years);
  check('stock movement goes to the year Tally\'s stock value belongs to', a.years[0].stock_change === 1697071 && a.years[0].gross_margin_pct_after_stock != null && a.years[1].gross_margin_pct_after_stock == null && a.period.gross_margin_pct_after_stock == null, { y: a.years, p: a.period });
  check('stock is dated, and days of stock is not claimed from March\'s value', a.stock.as_at === '2026-03-31' && a.working_capital.stock_as_at === '2026-03-31' && a.working_capital.dio_days == null, a.stock);
  check('the ledger check compares like with like: nothing fails', a.quality.tie_out.length >= 5 && a.quality.tie_out.every((x) => x.ok) && !a.quality.reasons.some((r) => /don't tie/.test(r)), a.quality.tie_out);
  check('a ledger first used this year is not called a mismatch', a.quality.tie_out.every((x) => x.ledger !== 'Packing @ 5%' || x.ok));
  check('cash is today\'s', a.cash && a.cash.total === -truth('Kotak Bank'), { cash: a.cash, want: -truth('Kotak Bank') });
  check('the owner is told, in plain words', a.quality.reasons.some((r) => /Tally's balances stop at 31 Mar 2026/.test(r)) && a.quality.balances_period.rolled_forward === true, a.quality.reasons);
  check('where the money goes is this year only', a.cost_structure.find((c) => c.ledger === 'Salary').amount === 600000, a.cost_structure);
  check('confidence is no longer dragged to Low by a false mismatch', a.quality.confidence !== 'low', a.quality.confidence);
  // days to get paid: owed (with GST) against billed (with GST)
  const billed90 = all.filter((v) => v.voucher_type === 'Sales' && v.date >= '20260713' && v.date <= '20261011').reduce((s, v) => s + -v.entries[0].amount, 0);
  check('days to get paid compares what is owed with what was billed, GST on both sides', a.working_capital.dso_days === r2(3000000 / billed90 * 90) && a.working_capital.billed_90d === r2(billed90), { dso: a.working_capital.dso_days, billed90 });
  A.applyTiedReceivables(a, [{ direction: 'receivable', party_name: 'Alkem', bill_ref: 'A1', closing_balance: 1500000, overdue_days: 40 }]);
  check('...and follows the tied "owed to you" figure, on the tile, the customer row and the headline', a.working_capital.dso_days === r2(1500000 / billed90 * 90) && a.customers.find((c) => c.party === 'Alkem').outstanding === 1500000 && a.headlines.some((h) => /Carrying ₹15,00,000 owed/.test(h)), { wc: a.working_capital.dso_days, h: a.headlines });
}

/* ---- the agent itself was told last year by Tally: this year's new entries stop arriving ---- */
{
  const led = tallyLedgers('20250401', '20260331');
  const diag = { agent_version: '0.2.4', vouchers: { period: { from: '2025-04-01', to: '2026-03-31', source: 'tally' }, months: { '2025-04': { tally: 5, synced: 5, complete: true } } } };
  const a = A.computeAnalytics({ ledgers: led, vouchers: all, bills: [], now: NOW, diagnostics: diag });
  check('when Tally is sending last year, the page says so first', /Tally is sending Margyn last year's entries/.test(a.quality.reasons[0]) && a.quality.agent_reading_past_year && a.quality.agent_reading_past_year.to === '2026-03-31', a.quality.reasons.slice(0, 2));
  const ok = A.computeAnalytics({ ledgers: led, vouchers: all, bills: [], now: NOW, diagnostics: { agent_version: '0.2.6', vouchers: { period: { from: '2025-04-01', to: '2027-03-31', source: 'tally' }, months: {} } } });
  check('...and says nothing when the agent is reading this year', !ok.quality.agent_reading_past_year && !ok.quality.reasons.some((r) => /last year's entries/.test(r)));
}

/* ---- the screen on this year (1 Apr 2026 to 31 Mar 2027), last year's entries also synced ---- */
{
  const led = tallyLedgers('20260401', '20270331');
  const t = A.asOfToday(led, all, NOW);
  check('this year on screen: the period is found and the later EMIs are backed out', t.balances && t.balances.from === '2026-04-01' && !t.balances.rolled_forward && t.guard.decision === 'backed_out' && bal(t, 'Kotak Bank').closing_balance === truth('Kotak Bank') && bal(t, 'Kotak Loan').closing_balance === truth('Kotak Loan'), t.balances && { ...t.balances, tie: undefined, bank: bal(t, 'Kotak Bank') });
  check('this year on screen: shorter periods inside it (no EMI months) are not rivals; the tie-out compares this year only', t.balances.tied === t.balances.tested && (() => { const a9 = A.computeAnalytics({ ledgers: led, vouchers: all, bills: [], now: NOW }); return a9.quality.balances_period && a9.quality.tie_out.length >= 4 && a9.quality.tie_out.every((x) => x.ok) && !a9.quality.reasons.some((r) => /don't tie/.test(r)); })(), { tied: t.balances.tied, tested: t.balances.tested });
  check('...and opening balances move back to the first synced entry', bal(t, 'Kotak Bank').opening_balance === OPEN['Kotak Bank'] && bal(t, 'Alkem').opening_balance === OPEN['Alkem'], bal(t, 'Kotak Bank'));
}

/* ---- a two-year period on screen (first entry to 31 Mar 2027): already fits, the usual reading is kept ---- */
{
  const led = Object.keys(GROUP).map((name) => ({ name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: OPEN[name] || 0, closing_balance: r2((OPEN[name] || 0) + moved(name, '20250401', '20270331')) }));
  const t = A.asOfToday(led, all, NOW, 'same');
  check('balances that already run from the first entry past today are read the usual way', !t.balances && t.guard.decision === 'backed_out' && bal(t, 'Kotak Bank').closing_balance === truth('Kotak Bank'), { b: t.balances && { ...t.balances, tie: undefined }, g: t.guard });
}

/* ---- entries missing from the sync: no clear period, nothing is changed ---- */
{
  const led = tallyLedgers('20250401', '20260331').map((l, i) => Object.assign({}, l, { closing_balance: l.closing_balance + (i + 1) * 1234.5 }));
  const bp = A.balancePeriod(led, all);
  check('when the ledgers don\'t clearly tie to one period, Margyn does not guess', bp === null, bp && { tied: bp.tied, tested: bp.tested });
}

/* ---- the other sign convention (debit positive balances) ---- */
{
  const led = tallyLedgers('20250401', '20260331').map((l) => Object.assign({}, l, { opening_balance: -l.opening_balance, closing_balance: -l.closing_balance }));
  const t = A.asOfToday(led, all, NOW);
  check('balances that carry debit as positive are carried forward the right way round', t.balances && t.balances.sign === 'opposite' && bal(t, 'Kotak Bank').closing_balance === -truth('Kotak Bank'), t.balances && { ...t.balances, tie: undefined });
}

/* ---- stock: Tally's value stops at 31 Mar 2026; carried to today from the item lines, graded on last year ---- */
{
  // Three items: A and B are bought and sold, K is a kit made from A and B in manufacturing journals and sold.
  // Tally (average cost) holds opening quantities Margyn never sees. Purchase prices drift up 0.5% a month.
  const hold = { A: { q: 9000, v: 9000 * 100 }, B: { q: 12000, v: 12000 * 40 }, K: { q: 300, v: 300 * 185 } };
  const rate = (n) => hold[n].v / hold[n].q;
  const IN = (n, q, v) => { hold[n].q += q; hold[n].v += v; };
  const OUT = (n, q) => { const v = q * rate(n); hold[n].q -= q; hold[n].v -= v; return v; };
  const value = () => Object.values(hold).reduce((t, h) => t + h.v, 0);
  const line = (item, qty, amount) => ({ item, qty, unit: 'Nos', rate: Math.abs(amount) / qty, amount, abs_amount: Math.abs(amount) });
  const sv = [];
  let k = 0, openingValue = value(), marchValue = null, septValue = null;
  const push = (type, date, entries, items) => sv.push({ tally_guid: 's' + (++k), voucher_type: type, voucher_number: String(k), date, party_name: null, amount: 1, is_cancelled: false,
    entries: entries.map(([ledger, amount]) => ({ ledger, amount, is_party: false })), items });
  months.forEach(([y, m], i) => {
    if (y === 2026 && m === 10) return;
    const pa = 100 * Math.pow(1.005, i), pb = 40 * Math.pow(1.005, i);
    const qa = 5000 + (i % 3) * 400, qb = 9000 + (i % 4) * 300;
    IN('A', qa, qa * pa); IN('B', qb, qb * pb);
    push('Purchase', ymd(y, m, 3), [['Supplier A', qa * pa + qb * pb], ['Purchase GST', -(qa * pa + qb * pb)]], [line('A', qa, -qa * pa), line('B', qb, -qb * pb)]);
    // 400 kits: each takes 1 A and 2 B. Tally values the kit at what its parts cost.
    const va = OUT('A', 400), vb = OUT('B', 800); IN('K', 400, va + vb);
    sv.push({ tally_guid: 's' + (++k), voucher_type: 'Manufacturing Journal', voucher_number: String(k), date: ymd(y, m, 8), party_name: null, amount: va + vb, is_cancelled: false, entries: [],
      items: [line('K', 400, -(va + vb)), line('A', 400, va), line('B', 800, vb)] });
    const sa = 4300 + (i % 5) * 150, sb = 8000 + (i % 2) * 500, sk = 380;
    OUT('A', sa); OUT('B', sb); OUT('K', sk);
    const bill = sa * 135 + sb * 55 + sk * 260;
    push('Sales', ymd(y, m, 18), [['Alkem', -bill], ['GST Sale', bill]], [line('A', sa, sa * 135), line('B', sb, sb * 55), line('K', sk, sk * 260)]);
    if (y === 2026 && m === 3) marchValue = value();
    if (y === 2026 && m === 9) septValue = value();
  });
  // Enough plain ledgers for the period to be found; stock ledger as Tally sends it with the screen on 2025-26.
  const withItems = all.concat(sv);
  const mv = (name, from, to) => withItems.filter((v) => v.date >= from && v.date <= to).reduce((t, v) => t + v.entries.filter((e) => e.ledger === name).reduce((x, e) => x + e.amount, 0), 0);
  const led = Object.keys(GROUP).map((name) => {
    const pl = /Sales|Purchase|Expenses/.test(GROUP[name]);
    const opening = pl ? 0 : (OPEN[name] || 0);
    if (name === 'Stock-in-hand') return { name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: -r2(openingValue), closing_balance: -r2(marchValue) };
    return { name, parent: GROUP[name], primary_group: GROUP[name], opening_balance: opening, closing_balance: r2(opening + mv(name, '20250401', '20260331')) };
  });
  const a = A.computeAnalytics({ ledgers: led, vouchers: withItems, bills: [], now: NOW });
  const roll = a.stock.roll;
  check('stock: the method is graded on the period Tally\'s own two values span, and lands close', roll && roll.ok && roll.backtest.error_pct_of_stock <= 5 && roll.journals_used, roll);   // ~3%: prices rise 6% a year here and stock already held is revalued by Tally, which the item lines can't show
  check('stock: today\'s stock is Tally\'s March value plus the change since, close to what Tally itself would say', a.stock.estimated === true && Math.abs(a.stock.value_today - septValue) / septValue <= 0.03 && a.working_capital.stock_value === a.stock.value_today && a.working_capital.stock_estimated === true, { est: a.stock.value_today, tally_would_say: r2(septValue), march: r2(marchValue) });
  check('stock: March\'s value alone would have been wrong by more than the method\'s error', Math.abs(marchValue - septValue) > Math.abs(a.stock.value_today - septValue));
  check('stock: this year\'s margin now counts stock movement, marked as worked out', a.period.gross_margin_pct_after_stock != null && a.period.stock_estimated === true && a.years[1].stock_estimated === true && a.years[0].stock_estimated === false && a.years[0].stock_change === r2(marchValue - openingValue), { p: a.period, y: a.years });
  check('stock: days of stock is back, and the owner is told how the figure was reached', a.working_capital.dio_days != null && a.quality.reasons.some((r) => /Stock today .* worked out item by item/.test(r)), a.quality.reasons);

  // Item lines missing for half of last year (an old agent): the sum can't reproduce Tally's change, so nothing is claimed.
  const holes = withItems.map((v) => (v.items && v.voucher_type === 'Purchase' && v.date < '20251001' ? Object.assign({}, v, { items: null }) : v));
  const b = A.computeAnalytics({ ledgers: led, vouchers: holes, bills: [], now: NOW });
  check('stock: when the sum does not reproduce Tally\'s own change, no figure is made up', b.stock.roll && !b.stock.roll.ok && b.stock.estimated !== true && b.working_capital.stock_as_at === '2026-03-31' && b.period.gross_margin_pct_after_stock == null && b.working_capital.dio_days == null, b.stock.roll);

  // A stock value typed by hand that has nothing to do with the item movements: same refusal.
  const typed = led.map((l) => (l.name === 'Stock-in-hand' ? Object.assign({}, l, { closing_balance: -r2(marchValue * 1.6) }) : l));
  const c = A.computeAnalytics({ ledgers: typed, vouchers: withItems, bills: [], now: NOW });
  check('stock: a typed stock value that the entries don\'t explain is left as Tally gave it, dated', c.stock.roll && !c.stock.roll.ok && c.stock.roll.why === 'backtest_off_by_more_than_10pct' && c.working_capital.stock_value === r2(marchValue * 1.6), c.stock.roll);
}

/* ---- the alarm: sales invoice numbers must run without gaps ---- */
{
  const inv = [];
  let n = 0;
  for (const [y, m] of months) { if (y < 2026 || (y === 2026 && m < 4) || (y === 2026 && m > 9)) continue; for (let i = 0; i < 60; i++) { n++; inv.push({ tally_guid: 'inv' + n, voucher_type: 'VASAI SALES', voucher_base: 'Sales', voucher_number: 'VSI' + n, date: ymd(y, m, 1 + (i % 27)), is_cancelled: false, entries: [] }); } }
  const whole = A.invoiceGaps(inv, Date.parse('2026-10-11T00:00:00Z'));
  check('invoice numbers: a complete series raises nothing', whole && whole.missing === 0 && !whole.short_months.length, whole);
  // Care Hygiene's shape: early April gone (first 16, then runs), a deleted invoice or two in other months.
  const holed = inv.filter((v) => { const k = +v.voucher_number.slice(3); return !(k <= 16 || (k >= 18 && k <= 43) || k === 130 || k === 250); });
  const g = A.invoiceGaps(holed, Date.parse('2026-10-11T00:00:00Z'));
  check('invoice numbers: a month with a run of missing numbers is named, with how many', g.short_months.join() === '2026-04' && g.months['2026-04'].missing === 42 && g.missing === 44 && g.series[0].longest_gap.n === 26, g);
  check('invoice numbers: a stray deleted invoice in another month is not an alarm', !g.short_months.includes('2026-06') && !g.short_months.includes('2026-08'));
  const a2 = A.computeAnalytics({ ledgers: tallyLedgers('20250401', '20260331'), vouchers: all.concat(holed.map((v) => Object.assign({}, v, { voucher_type: 'VASAI SALES', voucher_base: 'Sales', party_name: 'Alkem', amount: 1, entries: [{ ledger: 'Alkem', amount: -1, is_party: true }, { ledger: 'GST Sale', amount: 1 }] }))), bills: [], now: NOW });
  check('invoice numbers: the Margin page says it first and drops to Low', /About 42 sales invoices are missing from Apr 2026/.test(a2.quality.reasons[0]) && a2.quality.confidence === 'low' && a2.quality.invoice_numbers.short_months.join() === '2026-04', a2.quality.reasons.slice(0, 2));
  const dated = inv.map((v, i) => Object.assign({}, v, { voucher_number: 'CH/26-27/' + v.date.slice(4) + '/' + (i * 7) }));
  check('invoice numbers: numbering that is not a plain running number is left alone', A.invoiceGaps(dated, Date.parse('2026-10-11T00:00:00Z')) === null);
}

/* ---- entries known to be missing after the balance date: cash is not carried on them ---- */
{
  // This year's sales invoices, numbered, with a run gone from April (overwritten by last year's file).
  let n = 0; const inv = [];
  for (const [y, m] of months) { if (y < 2026 || (y === 2026 && m < 4) || (y === 2026 && m > 9)) continue; for (let i = 0; i < 40; i++) { n++; if (n >= 5 && n <= 30) continue; inv.push({ tally_guid: 'hv' + n, voucher_type: 'VASAI SALES', voucher_base: 'Sales', voucher_number: 'VSI' + n, date: ymd(y, m, 1 + (i % 27)), party_name: 'Alkem', amount: 1, is_cancelled: false, entries: [{ ledger: 'Alkem', amount: -1, is_party: true }, { ledger: 'GST Sale', amount: 1 }] }); } }
  const led = tallyLedgers('20250401', '20260331');
  const t = A.asOfToday(led, all.concat(inv), NOW);
  const march = (name) => led.find((l) => l.name === name).closing_balance;
  check('incomplete entries: cash, bank and loans stay as Tally last gave them', t.balances.entries_incomplete && t.balances.cash_held && bal(t, 'Kotak Bank').closing_balance === march('Kotak Bank') && bal(t, 'Kotak Bank').held_at === '2026-03-31' && bal(t, 'Kotak Loan').closing_balance === march('Kotak Loan'), { b: { ...t.balances, tie: undefined }, bank: bal(t, 'Kotak Bank') });
  check('incomplete entries: customer and supplier balances are still carried', bal(t, 'Supplier A').closing_balance === truth('Supplier A') && bal(t, 'Alkem').closing_balance !== march('Alkem'));
  check('incomplete entries: later-dated EMIs are still not taken off a balance that never had them', t.future.length === 5 && bal(t, 'Kotak Loan').closing_balance === march('Kotak Loan'));
  const a3 = A.computeAnalytics({ ledgers: led, vouchers: all.concat(inv), bills: [], now: NOW });
  check('incomplete entries: the page says cash is as at the balance date, and why', a3.cash.as_at === '2026-03-31' && a3.cash.total === -march('Kotak Bank') && a3.quality.reasons.some((r) => /Entries since then are incomplete, so cash, bank and loan balances are shown as Tally last gave them/.test(r)) && a3.quality.balances_period.cash_held === true, { cash: a3.cash, r: a3.quality.reasons });
  // The earlier block (complete entries) still carries cash to the rupee: covered above ("Kotak Bank: today's balance, to the rupee").
}

/* ---- the WhatsApp update never reports a change in how figures are reached as money moving ---- */
{
  const W = require('../watchBrief');
  if (W.snapshot && W.comparable) {
    const mk = (decision, files) => ({ asOfGuard: { decision }, book: { files }, bills: [], rows: [], ledgers: [], analytics: {}, now: new Date(NOW), today: new Date('2026-10-11T00:00:00Z'), cls: () => 'unknown', lastSync: null });
    let s1 = null, s2 = null, s3 = null;
    try { s1 = W.snapshot(mk('backed_out', null), { opening: 500 }, NOW); s2 = W.snapshot(mk('rolled_forward', { ledgers_from: 'A (2025-26)', bills_from: 'A (2026-27)' }), { opening: 500 }, NOW); s3 = W.snapshot(mk('backed_out', null), { opening: 700 }, NOW); } catch (e) { s1 = { err: e.message }; }
    check('watch: balances worked forward are not reported as bank and cash', s2 && s2.cash === null && s2.borrowed === null, s2 && { cash: s2.cash, basis: s2.basis, err: s1 && s1.err });
    check('watch: a snapshot reached another way is not compared with', s1 && s2 && W.comparable(s1, s2) === null && W.comparable(s1, s3) === s1 && W.comparable({ v: 1, cash: 5 }, s2) === null);
  } else check('watch: snapshot and comparable are exported for this test', false);
}

/* ---- two company files: each year by its own file; a year checked against its own opening ---- */
{
  const NEWCO = 'CARE (2026-27)', OLDCO = 'CARE (2025-26)';
  const tagged = all.map((v) => Object.assign({}, v, { company_name: v.date >= '20260401' ? NEWCO : OLDCO }));
  // This year's file: balances for 1 Apr 2026 to 31 Mar 2027. "Salary" sits under Direct Expenses in it.
  const cur = tallyLedgers('20260401', '20270331').map((l) => Object.assign({}, l, { company_name: NEWCO }, l.name === 'Salary' ? { parent: 'Direct Expenses', primary_group: 'Direct Expenses' } : {}));
  // Last year's file: Salary under Indirect Expenses; stock 40.6 L to 57.6 L; the bank closed 5,000 away from where this year opens.
  const old = tallyLedgers('20250401', '20260331').map((l) => Object.assign({}, l, { company_name: OLDCO }, l.name === 'Kotak Bank' ? { closing_balance: l.closing_balance - 5000 } : {}));
  const curStock = cur.map((l) => (l.name === 'Stock-in-hand' ? Object.assign({}, l, { opening_balance: -4359322, closing_balance: -7061518 }) : l));
  const a = A.computeAnalytics({ ledgers: curStock, priorLedgers: old, vouchers: tagged, bills: [], now: NOW, dataAsOf: '2026-10-08T14:04:53Z' });
  const ly = a.years.find((y) => y.fy === '2025-26'), ty = a.years.find((y) => y.fy === '2026-27');
  check('each year is classified by its own file: last year\'s salary is a running cost, this year\'s a direct cost', ly.opex >= 1200000 && ty.opex === 6 * 7573 /* only the loan interest is left in running costs */ && a.period.cogs_pre_stock > 0 && a.cost_structure.find((c) => c.ledger === 'Salary').bucket === 'direct_expense', { ly: [ly.cogs_pre_stock, ly.opex], ty: [ty.cogs_pre_stock, ty.opex] });
  check('last year keeps its own stock movement and margin after stock', ly.stock_change === 1697071 && ly.gross_margin_pct_after_stock != null && ty.stock_change === 7061518 - 4359322, { ly, ty: ty.stock_change });
  check('this year opening where last year did not close is said, with the margin both ways', a.stock.opening_differs === true && a.stock.last_year_closing === 5759321 && a.period.gross_margin_pct_after_stock_on_last_year_closing != null && a.period.gross_margin_pct_after_stock_on_last_year_closing < a.period.gross_margin_pct_after_stock && a.quality.reasons.some((r) => /Stock opens this year at/.test(r)), { p: a.period.gross_margin_pct_after_stock, alt: a.period.gross_margin_pct_after_stock_on_last_year_closing });
  check('ledgers whose opening differs from last year\'s closing are listed', a.year_join && a.year_join.differ >= 2 && a.year_join.top.some((x) => x.ledger === 'Kotak Bank' && x.difference === 5000) && a.quality.reasons.some((r) => /doesn't open where last year's closed/.test(r)), a.year_join);
  check('days to get paid counts 90 days back from where the data ends', (() => { const end = Date.parse('2026-10-08T00:00:00Z'); const billed = tagged.filter((v) => v.voucher_type === 'Sales' && Date.parse(v.date.slice(0, 4) + '-' + v.date.slice(4, 6) + '-' + v.date.slice(6) + 'T00:00:00Z') >= Date.parse('2026-10-08T14:04:53Z') - 90 * 86400000).reduce((s2, v) => s2 + -v.entries[0].amount, 0); return a.working_capital.billed_90d === r2(billed); })(), a.working_capital.billed_90d);
  check('cash, bank and loan ledgers are checked against their entries too, and all tie here', a.quality.cash_tie_out.length >= 2 && a.quality.cash_tie_out.every((t) => t.ok), a.quality.cash_tie_out);
  // A bank ledger whose entries don't explain its balance: never "high".
  const off = curStock.map((l) => (l.name === 'Kotak Bank' ? Object.assign({}, l, { closing_balance: l.closing_balance + 123456 }) : l));
  const b = A.computeAnalytics({ ledgers: off, priorLedgers: old, vouchers: tagged, bills: [], now: NOW });
  check('a bank ledger that does not match its entries is named and confidence is not "high"', b.quality.confidence !== 'high-for-a-single-source' && b.quality.reasons.some((r) => /cash, bank or loan ledger\(s\) don't match their entries \(largest: Kotak Bank/.test(r)), { c: b.quality.confidence, r: b.quality.reasons });

  // The cash flow statement's opening check: this year's file against this year's own opening, no false gap.
  const E = require('../booksEngine'), CF = require('../cashFlowStatement');
  const ctx = E.prepare({ ledgers: curStock, priorLedgers: old, vouchers: tagged, bills: [], overrides: {} }, { now: NOW });
  const st = CF.yearStatement(ctx);
  check('cash flow: a year is checked against its own opening (last year\'s movement is not reported as a gap)', st && st.checks.opening_balances.checked >= 1 && st.checks.opening_balances.gaps.length === 0, st && st.checks.opening_balances);
  const ctx2 = E.prepare({ ledgers: off, priorLedgers: old, vouchers: tagged, bills: [], overrides: {} }, { now: NOW });
  const st2 = CF.yearStatement(ctx2);
  check('cash flow: a real gap in this year is still caught, at its real size', st2.checks.opening_balances.gaps.length === 1 && Math.abs(Math.abs(st2.checks.opening_balances.gaps[0].gap) - 123456) < 1, st2.checks.opening_balances);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
