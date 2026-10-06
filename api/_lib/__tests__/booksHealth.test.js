/**
 * The books health check (api/_lib/booksHealth.js) and the tie-out guard in tallyAnalytics.asOfToday.
 * Fixtures are the shapes found by hand in the Care Hygiene audit (4 Oct 2026).
 * Zero-dep. Run: node api/_lib/__tests__/booksHealth.test.js
 */
const E = require('../booksEngine');
const A = require('../tallyAnalytics');
const H = require('../booksHealth');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''))); };
const { NOW } = require('./booksHealthFixture');

/* ---------------- a Care Hygiene-shaped book (booksHealthFixture.js) ---------------- */
const { book, L, V, pay } = require('./booksHealthFixture');
const ctx = E.prepare(book, { now: NOW });
const res = H.check(ctx);
const kind = (k) => res.items.filter((x) => x.kind === k);
const one = (k, pred) => kind(k).find(pred || (() => true));

// 1. Overdraft interest filed as income
const int = one('interest_under_income');
check('1. INTEREST ON OD under Indirect Incomes is flagged with ₹5.43 L paid', kind('interest_under_income').length === 1 && int.ledger === 'INTEREST ON OD' && int.amount === 543000, kind('interest_under_income'));
check('1. interest actually earned (INTEREST ON FD) is left alone', !res.items.some((x) => x.ledger === 'INTEREST ON FD'));
check('1. the fix names the ledger and the right group', /Move the ledger “INTEREST ON OD” from Indirect Incomes to Indirect Expenses/.test(int.fix), int.fix);

// 2. A month's running costs not booked
const cost = kind('costs_not_booked');
check('2. September flagged: ₹2.66 L against a usual ₹41.8 L', cost.length === 1 && cost[0].month === '2026-09' && cost[0].amount === 4180000 - 266000 && /September 2026/.test(cost[0].title), cost);
check('2. the current (unfinished) month is never flagged', !cost.some((x) => x.month === '2026-10'));

// 3. Ledger name contradicts its group
const nm = kind('name_vs_group');
check('3. TRANSPORT/COURIER EXPENSES under Sales Accounts is flagged', nm.length === 1 && nm[0].ledger === 'TRANSPORT/COURIER EXPENSES' && nm[0].amount === 120000 && /Sales Accounts/.test(nm[0].title), nm);
check('3. FREIGHT COLLECTED (charged to customers, money in) is not', !nm.some((x) => /FREIGHT COLLECTED/.test(x.ledger)));

// 4. Cash in hand negative
const cash = one('cash_negative');
check('4. Cash in hand −₹41,091 is flagged, high', cash && cash.amount === 41091 && cash.severity === 'high' && /−?-?₹41,091/.test(cash.title), cash);
check('4. it points at the journal that took cash below zero', cash && cash.data && cash.data.examples[0].amount === 51091 && cash.data.examples[0].to === 'PARTNER REMUNERATION', cash && cash.data);

// 5. Supplier bills open but settled in the ledger
const sp = one('supplier_bills_settled', (x) => x.party === 'Sanjay Plastics');
check('5. Sanjay Plastics: 7 bills ₹14 L vs ledger ₹11.5k', sp && sp.amount === 1400000 - 11500 && sp.data.bills === 7 && sp.data.ledger === 11500 && sp.data.oldest_days === 432, sp);
const ri = one('supplier_bills_settled', (x) => x.party === 'Royal International');
check('5. Royal International: ₹9.1 L of bills vs ledger 0', ri && ri.amount === 910000 && /nothing owed/.test(ri.detail), ri);

// 6. Customer bills paid in the ledger, and ledger amounts with no bill
const ssd = one('customer_bills_paid');
check('6. S.S.D Surgical: ₹9.79 L of bills vs ledger ₹12', ssd && ssd.party === 'S.S.D SURGICAL' && ssd.amount === 979000 - 12, ssd);
const ag = one('customer_unbilled');
check('6. Agastya owes ₹13.55 L with no open bill', ag && ag.party === 'Agastya Corporation' && ag.amount === 1355000 && /no open bills/.test(ag.title), ag);
check('6. a customer whose bills tie (Glenmark) raises no bill item', !res.items.some((x) => /customer_(bills_paid|unbilled)/.test(x.kind) && /GLENMARK/.test(x.party)));

// 7. Suppliers not tracked bill-wise
const nb = one('suppliers_not_billwise');
check('7. suppliers not kept bill by bill: 2 of 3 owed to', ctx.analytics.working_capital.suppliers_tracked_billwise === false && nb && nb.count === 2 && /2 of 3 suppliers/.test(nb.title) && nb.amount === 700000, nb || ctx.analytics.working_capital);

// 8. Very old debts
const gl = one('old_debt');
check('8. Glenmark 1,327 days: a settle / chase / write-off decision', gl && /Glenmark/.test(gl.title) && /1,327 days/.test(gl.detail) && gl.decision === true && kind('old_debt').length === 1, kind('old_debt'));

// 9. Future-dated entries
const ah = one('entered_ahead');
check('9. two EMIs dated after today are listed, ₹3.15 L, informational', ah && ah.count === 2 && ah.amount === 315146 && ah.for_accountant === false && /loan EMIs/.test(ah.detail), ah);
check('9. no guard item when the opening + entries can\'t be checked (no closing balance)', !one('later_entries_balance'));

// Every item: stable key, area, plain words (no internal jargon)
check('every item has a stable key, an area and an amount', res.items.every((x) => x.key && x.key.startsWith(x.kind) && x.area && Number.isFinite(x.amount)), res.items.map((x) => x.key));
check('no internal words in what the owner reads', res.items.every((x) => !/\b(bucket|ctx|debtor|creditor|tally_|asOfToday|voucher_|null|undefined|NaN)\b/i.test(x.title + ' ' + x.detail + ' ' + x.fix)),
  res.items.filter((x) => /\b(bucket|ctx|debtor|creditor|tally_|asOfToday|voucher_|null|undefined|NaN)\b/i.test(x.title + ' ' + x.detail + ' ' + x.fix)).map((x) => x.title + ' | ' + x.detail));
check('same books, same keys (stable across runs)', JSON.stringify(H.check(E.prepare(book, { now: NOW })).items.map((x) => x.key)) === JSON.stringify(res.items.map((x) => x.key)));

/* ---------------- the tie-out guard (tallyAnalytics.asOfToday) ---------------- */
{
  // Tally's own sign: entries and balances negative = debit ('same'). Bank opens with ₹10 L, ₹2 L went out to today.
  const past = [{ tally_guid: 'p1', date: '20260901', voucher_type: 'Payment', entries: [{ ledger: 'Kotak Bank', amount: 200000 }, { ledger: 'Rent', amount: -200000 }] }];
  const fut = [1, 2].map((i) => ({ tally_guid: 'f' + i, date: '2026120' + i, voucher_type: 'Payment', amount: 157573, entries: [{ ledger: 'Kotak Loan', amount: -67000 }, { ledger: 'Interest on Loan', amount: -90573 }, { ledger: 'Kotak Bank', amount: 157573 }] }));
  const led = (closing, loanClosing) => [
    { name: 'Kotak Bank', parent: 'Bank Accounts', opening_balance: -1000000, closing_balance: closing },
    { name: 'Kotak Loan', parent: 'Secured Loans', opening_balance: 5000000, closing_balance: loanClosing },
    { name: 'Interest on Loan', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: -181146 }
  ];
  // Year-end balances (what Tally sends with no SVTODATE today): they include the EMIs.
  const yearEnd = A.asOfToday(led(-1000000 + 200000 + 2 * 157573, 5000000 - 2 * 67000), past.concat(fut), NOW, 'same');
  check('guard: year-end balances tie only WITH the later entries, so they are backed out', yearEnd.guard.decision === 'backed_out' && yearEnd.guard.with_future === 2 && yearEnd.guard.to_today === 0, yearEnd.guard);
  check('guard: ...and the bank is back to opening + entries to today (₹8 L)', yearEnd.ledgers[0].closing_balance === -800000 && yearEnd.ledgers[1].closing_balance === 5000000, yearEnd.ledgers);
  // A Tally whose period ends today: the closing balances already leave the EMIs out.
  const toToday = A.asOfToday(led(-800000, 5000000), past.concat(fut), NOW, 'same');
  check('guard: balances that already stop at today are NOT backed out a second time', toToday.guard.decision === 'kept' && toToday.guard.to_today === 2 && toToday.ledgers[0].closing_balance === -800000 && toToday.ledgers[1].closing_balance === 5000000, { g: toToday.guard, l: toToday.ledgers });
  check('guard: the later entries still wait for their date', toToday.vouchers.length === 1 && toToday.future.length === 2);
  check('guard: without that check the cash would have been overstated by both EMIs', A.asOfToday(led(-800000, 5000000), past.concat(fut), NOW, 'same', { decision: 'backed_out' }).ledgers[0].closing_balance === -800000 - 2 * 157573);
  const forced = A.asOfToday(led(-1000000 + 200000 + 2 * 157573, 5000000 - 2 * 67000), past.concat(fut), NOW, 'same', { decision: 'kept' });
  check('guard: a decision made earlier on the full books can be applied (Cash page summary)', forced.guard.decision === 'kept' && forced.guard.forced && forced.ledgers[0].closing_balance === -1000000 + 200000 + 2 * 157573);
  const dupes = A.asOfToday(led(-800000, 5000000), past.concat(past, fut), NOW, 'same');
  check('guard: the same voucher synced twice is counted once', dupes.guard.decision === 'kept', dupes.guard);
  const missing = A.asOfToday(led(-700000, 5000000), past.concat(fut), NOW, 'same');
  check('guard: entries missing from the sync (ties neither way) keep the usual reading', missing.guard.decision === 'backed_out' && missing.guard.unclear >= 1, missing.guard);

  // The health item, through the whole engine.
  const gbook = { connected: true, company: 'Guard Co', balance_convention: 'same', overrides: {}, syncRuns: [], bills: [],
    ledgers: led(-800000, 5000000).concat([{ name: 'Rent', parent: 'Indirect Expenses', opening_balance: 0, closing_balance: -200000 }]),
    vouchers: past.concat(fut) };
  const gctx = E.prepare(gbook, { now: NOW });
  const gi = H.check(gctx).items.find((x) => x.kind === 'later_entries_balance');
  check('guard: a health item says the balances already stop at today', gctx.asOfGuard.decision === 'kept' && gi && /already stop at today/.test(gi.title) && /Kotak Bank/.test(gi.detail) && gi.for_accountant === false, gi || gctx.asOfGuard);
  const an = A.computeAnalytics({ ledgers: gbook.ledgers, vouchers: gbook.vouchers, bills: [], now: NOW, balance_convention: 'same' });
  check('guard: computeAnalytics carries the decision with the later entries', an.entered_ahead && an.entered_ahead.guard.decision === 'kept', an.entered_ahead);
}

/* ---------------- the workflow: open / fixed / ignored ---------------- */
{
  const T0 = '2026-10-07T02:00:00Z', T1 = '2026-10-08T02:00:00Z', T2 = '2026-10-09T02:00:00Z';
  const first = H.reconcile([], res, T0);
  check('first run: every item opens, with first and last seen', first.opened.length === res.items.length && first.upserts.every((u) => u.status === 'open' && u.first_seen === new Date(T0).toISOString()));
  const keys = Object.keys(first.upserts[0]).sort().join(',');
  check('every row written has the same columns (one bulk upsert)', first.upserts.every((u) => Object.keys(u).sort().join(',') === keys));
  const stored = first.upserts.map((u) => Object.assign({}, u));
  const again = H.reconcile(stored, res, T1);
  check('next day, same books: nothing new, first seen kept, last seen moves', again.opened.length === 0 && again.closed.length === 0 &&
    again.upserts.every((u) => u.first_seen === new Date(T0).toISOString() && u.last_seen === new Date(T1).toISOString()));

  // Sanjay Plastics' bills knocked off in Tally: it's gone from the findings, so it closes by itself.
  const without = { items: res.items.filter((x) => x.party !== 'Sanjay Plastics'), scope: res.scope };
  const fixedRun = H.reconcile(stored, without, T1);
  const sKey = sp.key;
  check('a fixed item closes by itself on the next run', fixedRun.closed.includes(sKey) && fixedRun.upserts.find((u) => u.key === sKey).status === 'fixed' && fixedRun.upserts.find((u) => u.key === sKey).fixed_at === new Date(T1).toISOString());
  check('...the closing row still carries every column', Object.keys(fixedRun.upserts.find((u) => u.key === sKey)).sort().join(',') === keys);
  // A kind that wasn't judged this run (no bills synced) never closes its items.
  const noBills = { items: res.items.filter((x) => x.area !== 'suppliers' && x.area !== 'customers'), scope: new Map([...res.scope].filter(([k]) => !/bills|unbilled|billwise|old_debt/.test(k))) };
  const nb2 = H.reconcile(stored, noBills, T1);
  check('items of a kind not judged this run stay open (a failed bills sync can\'t "fix" them)', nb2.closed.length === 0, nb2.closed);
  const monthScope = new Map(res.scope); monthScope.set('costs_not_booked', new Set(['2026-10']));
  const nb3 = H.reconcile(stored, { items: res.items.filter((x) => x.kind !== 'costs_not_booked'), scope: monthScope }, T1);
  check('a month outside this run\'s months is not closed', !nb3.closed.includes('costs_not_booked:2026-09'));
  const nb4 = H.reconcile(stored, { items: res.items.filter((x) => x.kind !== 'costs_not_booked'), scope: res.scope }, T1);
  check('...but September closes once its costs are booked', nb4.closed.includes('costs_not_booked:2026-09'));

  // Ignored by the owner: stays ignored unless the amount moves more than 25%.
  const ignoredRows = stored.map((u) => u.key === ssd.key ? Object.assign({}, u, { status: 'ignored', ignored_amount: ssd.amount, ignored_by: 'Mihir' }) : u);
  const bump = (pct) => ({ items: res.items.map((x) => x.key === ssd.key ? Object.assign({}, x, { amount: Math.round(ssd.amount * (1 + pct)) }) : x), scope: res.scope });
  const r10 = H.reconcile(ignoredRows, bump(0.10), T2);
  check('ignored + amount moved 10%: stays ignored, not raised', r10.still_ignored.includes(ssd.key) && r10.upserts.find((u) => u.key === ssd.key).status === 'ignored' && !r10.reopened.includes(ssd.key));
  const r30 = H.reconcile(ignoredRows, bump(0.30), T2);
  check('ignored + amount moved 30%: raised again', r30.reopened.includes(ssd.key) && r30.upserts.find((u) => u.key === ssd.key).status === 'open' && r30.upserts.find((u) => u.key === ssd.key).ignored_by === null);
  const rGone = H.reconcile(ignoredRows, { items: res.items.filter((x) => x.key !== ssd.key), scope: res.scope }, T2);
  check('an ignored item that disappears stays ignored (not "fixed")', !rGone.closed.includes(ssd.key));
  // Fixed, then back.
  const fixedRows = stored.map((u) => u.key === sKey ? Object.assign({}, u, { status: 'fixed', fixed_at: T1 }) : u);
  const back = H.reconcile(fixedRows, res, T2);
  check('a fixed item that comes back reopens', back.reopened.includes(sKey) && back.upserts.find((u) => u.key === sKey).status === 'open');

  // merge(): what the app and Margyn show before / without the next stored run.
  const merged = H.merge(ignoredRows, res);
  check('merge: the ignored item stays ignored in the list', merged.find((x) => x.key === ssd.key).status === 'ignored' && merged.find((x) => x.key === ssd.key).ignored_by === 'Mihir');
  const mergedFixed = H.merge(stored, without);
  check('merge: a stored open item no longer found shows as fixed', mergedFixed.find((x) => x.key === sKey).status === 'fixed');
}

/* ---------------- the list for the accountant ---------------- */
{
  const items = H.merge([], res);
  const text = H.accountantText(items, { company: 'Care Hygiene Products', now: NOW });
  check('accountant list: a title, numbered fixes, nothing marked informational', /^Books check for Care Hygiene Products, 7 Oct 2026/.test(text) && /\n1\. /.test(text) && !/dated after today/.test(text) && !/already stop at today/.test(text), text);
  check('accountant list: covers every kind they can fix', ['INTEREST ON OD', 'TRANSPORT/COURIER EXPENSES', 'September 2026', 'Cash in hand', 'Sanjay Plastics', 'Royal International', 'S.S.D Surgical', 'Agastya', 'bill by bill'].every((w) => text.includes(w)), text);
  check('accountant list: old debts go to "decide with the owner"', /To decide with the owner[\s\S]*Glenmark/.test(text), text);
  const ign = H.merge(res.items.filter((x) => x.party === 'Sanjay Plastics').map((x) => ({ key: x.key, kind: x.kind, status: 'ignored', ignored_amount: x.amount, amount: x.amount })), res);
  check('accountant list: leaves out what the owner ignored', !H.accountantText(ign, {}).includes('Sanjay'));
  const many = H.merge([], { items: Array.from({ length: 60 }, (_, i) => ({ key: 'customer_bills_paid:c' + i, kind: 'customer_bills_paid', party: 'Customer number ' + i, amount: 100000 + i, for_accountant: true, title: 't', fix: 'f', data: { billed: 200000, ledger: 100000 } })), scope: new Map() });
  const short = H.accountantText(many, { max: 1500 });
  check('accountant list: long lists are cut to fit a WhatsApp link, with "and N more"', short.length <= 1500 && /and \d+ more/.test(short), short.length);
  check('accountant list: nothing open, nothing to send', H.accountantText([], {}) === null);
}

/* ---------------- Margyn's answer and team access ---------------- */
{
  const ans = H.answer(ctx, [], null);
  check('Margyn\'s answer: open count, grouped problems in plain words, how to send', ans.open === res.items.length && ans.problems.length >= 9 && ans.problems[0].problem === 'Cash below zero' && /Send to my accountant/.test(ans.how_to_send), ans.problems.map((p) => p.problem));
  const viewer = H.answer(ctx, [], ['view', 'view_receivables']);
  check('a team member without cash or supplier access sees only customer items', viewer.problems.every((p) => /Customer|over a year|wrong group|running costs|Interest/.test(p.problem)) && !viewer.problems.some((p) => /Supplier|Cash/.test(p.problem)), viewer.problems.map((p) => p.problem));
}

/* ---------------- the classifier: off by default, labels only ---------------- */
(async () => {
  const save = { k: process.env.JEV_API_KEY, m: process.env.JEV_MODE_BOOKS_HEALTH };
  const book2 = Object.assign({}, book, { ledgers: L.concat([{ name: 'TEMPO HIRE', parent: 'Sales Accounts', opening_balance: 0, closing_balance: 60000 }]),
    vouchers: V.concat([pay('2026-09-14', 'TEMPO HIRE', 60000)]) });
  const c2 = E.prepare(book2, { now: NOW });
  let calls = 0;
  const fetchImpl = async (url, init) => { calls++; const body = JSON.parse(init.body); const answers = {}; for (const k of Object.keys(body.questions)) answers[k] = { type: 'choice', choice: 'expense', confidence: 0.95 }; return { ok: true, json: async () => ({ answers }) }; };
  delete process.env.JEV_MODE_BOOKS_HEALTH; process.env.JEV_API_KEY = 'test';
  const r0 = H.check(c2); await H.classifierPass(c2, r0, { fetchImpl });
  check('classifier off by default: no call, rules only', calls === 0 && !r0.items.some((x) => x.by === 'classifier'));
  check('the rules alone miss "TEMPO HIRE" (no expense word)', !r0.items.some((x) => x.ledger === 'TEMPO HIRE'));
  process.env.JEV_MODE_BOOKS_HEALTH = 'shadow';
  const r1 = H.check(c2); await H.classifierPass(c2, r1, { fetchImpl });
  check('shadow: asks, but adds nothing', calls === 1 && !r1.items.some((x) => x.by === 'classifier'));
  process.env.JEV_MODE_BOOKS_HEALTH = 'live';
  const r2 = H.check(c2); await H.classifierPass(c2, r2, { fetchImpl });
  const t = r2.items.find((x) => x.ledger === 'TEMPO HIRE');
  check('live: a sure "expense" adds a low, "may be" item; the amount comes from the books', t && t.by === 'classifier' && t.amount === 60000 && t.severity === 'low' && /may be/.test(t.title), t);
  check('live: ledgers the rules already flagged aren\'t asked again', r2.items.filter((x) => x.ledger === 'TRANSPORT/COURIER EXPENSES').length === 1);
  if (save.k === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = save.k;
  if (save.m === undefined) delete process.env.JEV_MODE_BOOKS_HEALTH; else process.env.JEV_MODE_BOOKS_HEALTH = save.m;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
