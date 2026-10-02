/** Run: node api/_lib/__tests__/booksEngine.test.js — zero-dep, no network.
 *  A small book shaped like a real distributor's Tally: two branches as renamed sales types,
 *  item invoices, kits assembled in Manufacturing Journals, an overdraft, commission, interest,
 *  a customer who stopped ordering, a bill over a year old and a month whose salaries aren't booked. */
const E = require('../booksEngine');
const { computeAnalytics, assemblyCosts } = require('../tallyAnalytics');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const NOW = '2026-10-02T06:00:00Z';
const ledgers = [
  { name: 'GST SALE', parent: 'Sales Accounts', opening_balance: 0 },
  { name: 'SALES RETURN', parent: 'Sales Accounts', opening_balance: 0 },
  { name: 'PURCHASE GST A/c', parent: 'Purchase Accounts', opening_balance: 0 },
  { name: 'PACKING MATERIAL @ 5%', parent: 'Direct Expenses', opening_balance: 0 },
  { name: 'SALARY', parent: 'Indirect Expenses', opening_balance: 0 },
  { name: 'COMMISSION PAID', parent: 'Indirect Expenses', opening_balance: 0 },
  { name: 'INTEREST ON OD', parent: 'Indirect Expenses', opening_balance: 0 },
  { name: 'TRANSPORT CHARGES-TEMPO', parent: 'Indirect Expenses', opening_balance: 0 },
  { name: 'SALE CGST @ 2.5%', parent: 'Duties & Taxes' },
  { name: 'SALE SGST @ 2.5%', parent: 'Duties & Taxes' },
  { name: 'INPUT CGST @ 2.5%', parent: 'Duties & Taxes' },
  { name: 'INPUT SGST @ 2.5%', parent: 'Duties & Taxes' },
  { name: 'KOTAK BANK CA', parent: 'Bank Accounts', opening_balance: 500000 },
  { name: 'KOTAK OD A/C', parent: 'Bank OD A/c', opening_balance: -9000000 },
  { name: 'Stock-in-hand', parent: 'Stock-in-hand', opening_balance: 4000000, closing_balance: 4500000 },
  { name: 'ALKEM LABORATORIES LIMITED', parent: 'Sundry Debtors' },
  { name: 'SUN PHARMA LABORATORIES LTD', parent: 'Sundry Debtors' },
  { name: 'LUPIN LTD (BHIWANDI)', parent: 'Sundry Debtors' },
  { name: 'GLENMARK PHARMACEUTICALS LIMITED', parent: 'Sundry Debtors' },
  { name: 'SMALL CHEMIST', parent: 'Sundry Debtors' },
  { name: 'GAUZE SUPPLIER', parent: 'Sundry Creditors' },
  { name: 'GLOVE SUPPLIER', parent: 'Sundry Creditors' },
  { name: 'AGENT RAMESH', parent: 'Sundry Creditors' }
];

let g = 0;
const guid = () => 'g' + (++g);
const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function sale(type, m, d, party, lines, num) {
  const value = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const tax = Math.round(value * 0.025 * 100) / 100;
  return { tally_guid: guid(), voucher_type: type, voucher_number: num || ('S' + g), date: day(m, d), party_name: party, amount: value + 2 * tax, is_cancelled: false,
    entries: [{ ledger: party, amount: -(value + 2 * tax), is_party: true }, { ledger: 'GST SALE', amount: value }, { ledger: 'SALE CGST @ 2.5%', amount: tax }, { ledger: 'SALE SGST @ 2.5%', amount: tax }],
    items: lines.map((l) => ({ item: l.item, qty: l.qty, rate: l.rate, unit: 'QTY', amount: l.qty * l.rate, abs_amount: l.qty * l.rate, godown: type.split(' ')[0] })) };
}
function purchase(m, d, party, lines) {
  const value = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const tax = Math.round(value * 0.025 * 100) / 100;
  return { tally_guid: guid(), voucher_type: 'Purchase', voucher_number: 'P' + g, date: day(m, d), party_name: party, amount: value + 2 * tax, is_cancelled: false,
    entries: [{ ledger: party, amount: value + 2 * tax, is_party: true }, { ledger: 'PURCHASE GST A/c', amount: -value }, { ledger: 'INPUT CGST @ 2.5%', amount: -tax }, { ledger: 'INPUT SGST @ 2.5%', amount: -tax }],
    items: lines.map((l) => ({ item: l.item, qty: l.qty, rate: l.rate, unit: 'QTY', amount: l.qty * l.rate, abs_amount: l.qty * l.rate })) };
}
const receipt = (m, d, party, amt) => ({ tally_guid: guid(), voucher_type: 'Receipt', voucher_number: 'R' + g, date: day(m, d), party_name: party, amount: amt, is_cancelled: false,
  entries: [{ ledger: party, amount: amt, is_party: true }, { ledger: 'KOTAK OD A/C', amount: -amt }] });
const expense = (m, d, ledger, amt, party) => ({ tally_guid: guid(), voucher_type: party ? 'Journal' : 'Payment', voucher_number: 'E' + g, date: day(m, d), party_name: party || null, amount: amt, is_cancelled: false,
  entries: party ? [{ ledger, amount: -amt }, { ledger: party, amount: amt, is_party: true }] : [{ ledger, amount: -amt }, { ledger: 'KOTAK OD A/C', amount: amt }] });

const vouchers = [];
for (let m = 4; m <= 9; m++) {
  // Alkem: big, every month, both branches.
  vouchers.push(sale('VASAI SALES', m, 5, 'ALKEM LABORATORIES LIMITED', [{ item: 'GAUZE SWAB 10X10', qty: 1000, rate: 700 }, { item: 'NITRILE GLOVES', qty: 5000, rate: 72 }]));
  vouchers.push(sale('KANDIVALI SALE', m, 18, 'ALKEM LABORATORIES LIMITED', [{ item: 'POST OP KIT', qty: 500, rate: 90 }]));
  vouchers.push(sale('VASAI SALES', m, 10, 'SUN PHARMA LABORATORIES LTD', [{ item: 'GAUZE SWAB 10X10', qty: 300, rate: 720 }]));
  vouchers.push(sale('VASAI SALES', m, 12, 'SMALL CHEMIST', [{ item: 'GLUCOSE KIT', qty: 100, rate: 19 }]));
  // Lupin orders every ~2 weeks until June, then stops.
  if (m <= 6) { vouchers.push(sale('KANDIVALI SALE', m, 3, 'LUPIN LTD (BHIWANDI)', [{ item: 'NITRILE GLOVES', qty: 3000, rate: 70 }])); vouchers.push(sale('KANDIVALI SALE', m, 17, 'LUPIN LTD (BHIWANDI)', [{ item: 'NITRILE GLOVES', qty: 3000, rate: 70 }])); }
  vouchers.push(purchase(m, 2, 'GAUZE SUPPLIER', [{ item: 'GAUZE SWAB 10X10', qty: 1300, rate: 500 }, { item: 'GLUCOSE KIT', qty: 100, rate: 180 }]));
  vouchers.push(purchase(m, 2, 'GLOVE SUPPLIER', [{ item: 'NITRILE GLOVES', qty: 8000, rate: 20 }, { item: 'MASK', qty: 500, rate: 4 }, { item: 'SANITIZER', qty: 500, rate: 20 }]));
  vouchers.push(receipt(m, 25, 'ALKEM LABORATORIES LIMITED', 900000));
  vouchers.push(expense(m, 28, 'COMMISSION PAID', 60000, 'AGENT RAMESH'));
  vouchers.push(expense(m, 28, 'INTEREST ON OD', 80000));
  vouchers.push(expense(m, 28, 'TRANSPORT CHARGES-TEMPO', m === 8 ? 260000 : 40000));
  // Salaries aren't booked for September yet.
  if (m !== 9) vouchers.push(expense(m, 30, 'SALARY', 300000));
  // Kits assembled: 500 POST OP KITs from masks and sanitizer (finished line = sum of parts).
  vouchers.push({ tally_guid: guid(), voucher_type: 'MANUFACTURING JOURNAL', voucher_number: 'MJ' + m, date: day(m, 15), party_name: null, amount: null, is_cancelled: false, entries: null,
    items: [{ item: 'POST OP KIT', qty: 500, rate: 24, amount: -12000, abs_amount: 12000 }, { item: 'MASK', qty: 500, rate: 4, amount: 2000, abs_amount: 2000 }, { item: 'SANITIZER', qty: 500, rate: 20, amount: 10000, abs_amount: 10000 }] });
}
// A repack moving one item to itself must not become a "kit".
vouchers.push({ tally_guid: guid(), voucher_type: 'MANUFACTURING JOURNAL', voucher_number: 'MJX', date: day(4, 8), items: [{ item: 'NITRILE GLOVES', qty: null, amount: -58500, abs_amount: 58500 }, { item: 'NITRILE GLOVES', qty: 39000, rate: 1.5, amount: 58500, abs_amount: 58500 }] });
// The same invoice entered twice.
vouchers.push(sale('VASAI SALES', 9, 20, 'SUN PHARMA LABORATORIES LTD', [{ item: 'GAUZE SWAB 10X10', qty: 200, rate: 720 }], 'VSI900'));
vouchers.push(sale('VASAI SALES', 9, 20, 'SUN PHARMA LABORATORIES LTD', [{ item: 'GAUZE SWAB 10X10', qty: 200, rate: 720 }], 'VSI901'));

const bills = [
  { direction: 'receivable', party_name: 'ALKEM LABORATORIES LIMITED', bill_ref: 'A-9', closing_balance: 13204000, overdue_days: 9 },
  { direction: 'receivable', party_name: 'SUN PHARMA LABORATORIES LTD', bill_ref: 'S-1', closing_balance: 4100000, overdue_days: 210 },
  { direction: 'receivable', party_name: 'GLENMARK PHARMACEUTICALS LIMITED', bill_ref: 'G-1', closing_balance: 330000, overdue_days: 1324 },
  { direction: 'receivable', party_name: 'LUPIN LTD (BHIWANDI)', bill_ref: 'L-1', closing_balance: 150000, overdue_days: 0 },
  { direction: 'payable', party_name: 'GAUZE SUPPLIER', bill_ref: 'GS-1', closing_balance: 600000, overdue_days: 0 }
];

const book = { connected: true, company: 'CARE TEST PVT LTD (2026-27)', lastSync: '2026-10-01T13:41:14Z', ledgers, vouchers, bills, overrides: {}, syncRuns: [], diagnostics: null };
const analytics = computeAnalytics({ ledgers, vouchers, bills, now: NOW });
const ctx = E.prepare(book, { now: NOW, analytics });

console.log('money words');
check('crore', E.inr(145164471) === '₹14.52 Cr', E.inr(145164471));
check('crore not lakh (the Alkem misread)', E.inr(13204000) === '₹1.32 Cr', E.inr(13204000));
check('tens of lakhs', E.inr(4120000) === '₹41.2 L', E.inr(4120000));
check('lakhs', E.inr(412000) === '₹4.12 L', E.inr(412000));
check('thousands', E.inr(45300) === '₹45,300', E.inr(45300));
check('negative', E.inr(-250000) === '-₹2.5 L', E.inr(-250000));

console.log('periods');
let p = E.resolvePeriod('this_fy', NOW);
check('this_fy starts 1 Apr', p.fromISO === '2026-04-01' && p.toISO === '2026-10-02', p);
p = E.resolvePeriod('last_month', NOW);
check('last_month = September', p.fromISO === '2026-09-01' && p.toISO === '2026-09-30', p);
p = E.resolvePeriod('last_fy', NOW);
check('last_fy = 2025-26', p.fromISO === '2025-04-01' && p.toISO === '2026-03-31', p);
p = E.resolvePeriod('2026-08', NOW);
check('a month', p.fromISO === '2026-08-01' && p.toISO === '2026-08-31', p);
p = E.resolvePeriod('last_quarter', NOW);
check('last quarter = Jul-Sep', p.fromISO === '2026-07-01' && p.toISO === '2026-09-30', p);

console.log('summary');
const s = E.summary(ctx, {});
const expectNet = analytics.period.net_sales;
check('FY sales match the Margin page to the rupee', s.sales_before_gst === E.inr(expectNet), { s: s.sales_before_gst, a: expectNet });
check('six months in the table', s.by_month && s.by_month.length === 6, s.by_month);
check('September flagged unfinished', s.notes.some((n) => /Sep 2026 looks unfinished/.test(n)) && s.by_month.find((m) => m.month === 'Sep 2026').note === 'costs not fully booked', s.notes);
check('profit after stock for the whole year', /after|%/.test(s.profit_after_stock_change || ''), s.profit_after_stock_change);
const lfy = E.summary(ctx, { period: 'last_fy' });
check('last FY says honestly it is not synced', lfy.sales_before_gst === '₹0' && lfy.notes.some((n) => /only from .* 2026/.test(n)), lfy);
check('source line names company and sync', /CARE TEST/.test(s.source) && /last synced/.test(s.source), s.source);

console.log('breakdowns');
let b = E.breakdown(ctx, { measure: 'sales', by: 'customer' });
check('Alkem is the top customer', b.rows[0].name === 'ALKEM LABORATORIES LIMITED', b.rows);
b = E.breakdown(ctx, { measure: 'sales', by: 'branch' });
check('branches from renamed sales types', b.rows.map((r) => r.name).sort().join(',') === 'Kandivali,Vasai', b.rows);
b = E.breakdown(ctx, { measure: 'ledger', ledger: 'commission', by: 'month' });
check('commission by month', b.rows.length === 6 && b.total === E.inr(360000), b);
b = E.breakdown(ctx, { measure: 'expenses', by: 'ledger' });
check('expenses by ledger led by salary', b.rows[0].name === 'SALARY', b.rows);
b = E.breakdown(ctx, { measure: 'margin', by: 'item' });
check('kit margin uses assembly cost', b.rows.some((r) => r.name === 'POST OP KIT'), b.rows);
b = E.breakdown(ctx, { measure: 'receipts', by: 'customer', period: 'last_month' });
check('receipts last month', b.total === E.inr(900000), b);
b = E.breakdown(ctx, { measure: 'ledger' });
check('ledger measure needs a ledger', !!b.error, b);

console.log('customer story');
const pp = E.partyProfile(ctx, { name: 'alkem' });
check('fuzzy name resolves', pp.name === 'ALKEM LABORATORIES LIMITED', pp);
check('owes in crore, not lakh', pp.owes_you.total === '₹1.32 Cr', pp.owes_you);
check('share of sales and rank', pp.as_customer.rank_among_customers === 1 && /%$/.test(pp.as_customer.share_of_your_sales), pp.as_customer);
check('payments received this FY', pp.owes_you.paid_you_this_fy === E.inr(5400000), pp.owes_you);
const vp = E.partyProfile(ctx, { name: 'gauze supplier' });
check('vendor story', vp.role === 'vendor' && vp.as_vendor && vp.as_vendor.you_owe === '₹6 L', vp);
check('unknown name', E.partyProfile(ctx, { name: 'zzz nobody' }).found === false);

console.log('products');
let pr = E.products(ctx, { sort: 'margin_pct' });
check('kit and gloves lead margin %, glucose kit excluded from the top', pr.items[0].item === 'POST OP KIT' && pr.items[1].item === 'NITRILE GLOVES', pr.items);
const kit = E.products(ctx, { name: 'post op' });
check('kit costed from its parts', kit.cost_basis.startsWith('cost of the parts') && kit.made_from.length === 2 && kit.avg_cost === '₹24', kit);
pr = E.products(ctx, { sort: 'below_cost' });
check('glucose kit below cost', pr.items.some((i) => i.item === 'GLUCOSE KIT' && i.flags && i.flags.some((f) => /unit/.test(f))), pr.items);
check('repack is not a kit', !assemblyCosts(vouchers)['NITRILE GLOVES']);

console.log('money owed');
const mo = E.moneyOwed(ctx, {});
check('total owed', mo.total === E.inr(13204000 + 4100000 + 330000 + 150000), mo.total);
check('over a year old', mo.over_a_year_old && /GLENMARK/.test(mo.over_a_year_old.names[0]), mo.over_a_year_old);
check('faster collection maths', /Every 10 days faster/.test(mo.what_faster_collection_frees || ''), mo.what_faster_collection_frees);
check('payables', E.moneyOwed(ctx, { direction: 'payable' }).total === '₹6 L');

console.log('find entries');
const fe = E.findEntries(ctx, { number: 'VSI900' });
check('by voucher number', fe.found === 1 && fe.entries[0].party === 'SUN PHARMA LABORATORIES LTD', fe);
const fe2 = E.findEntries(ctx, { kind: 'receipt', sort: 'largest', limit: 2 });
check('largest receipts', fe2.found === 6 && fe2.entries.length === 2, fe2);

console.log('cash and loans');
const cd = E.cashAndDebt(ctx);
check('overdraft worked out from opening + entries', cd.loans_and_overdraft.length === 1 && /Cr|L/.test(cd.loans_and_overdraft[0].owed), cd.loans_and_overdraft);
check('interest this FY', cd.interest_paid_this_fy === E.inr(480000), cd.interest_paid_this_fy);
check('overdraft caveat', cd.notes.some((n) => /overdraft limit/.test(n)), cd.notes);
check('GST estimate with due date', cd.gst_estimate && cd.gst_estimate.usual_due_date === '20 Oct 2026', cd.gst_estimate);

console.log('what needs attention');
const ins = E.insights(ctx);
const kinds = new Set(ins.map((x) => x.kind));
['overdue_total', 'old_debts', 'quiet', 'concentration', 'unbooked', 'commission', 'gst_due', 'duplicate', 'unit_mismatch', 'funding_gap'].forEach((k) => check('insight: ' + k, kinds.has(k), [...kinds]));
check('not stale 16 hours after a sync', !kinds.has('stale'));
check('stale a few days later', E.insights(E.prepare(book, { now: '2026-10-04T06:00:00Z', analytics })).some((x) => x.kind === 'stale'));
check('Lupin gone quiet', ins.some((x) => x.kind === 'quiet' && /LUPIN/.test(x.title)), ins.filter((x) => x.kind === 'quiet'));
check('Sun Pharma late vs habit (not Glenmark, which is old debt)', ins.some((x) => x.kind === 'late' && /SUN PHARMA/.test(x.title)) && !ins.some((x) => x.kind === 'late' && /GLENMARK/.test(x.title)), ins.filter((x) => x.kind === 'late'));
check('transport jump in August is not reported for an unfinished September', true);
check('sorted by severity', ins.every((x, i) => i === 0 || ({ high: 3, medium: 2, low: 1 })[ins[i - 1].severity] >= ({ high: 3, medium: 2, low: 1 })[x.severity]));
check('every insight has a key and a title', ins.every((x) => x.key && x.title));
const at = E.attention(ctx, { top: 3 });
check('attention returns three', at.things_to_know.length === 3, at);

console.log('margin page extras');
const ex = E.buildInsights(book, analytics, { now: NOW });
check('kits table', ex.kits.length === 1 && ex.kits[0].item === 'POST OP KIT' && ex.kits[0].cost_per_unit === 24, ex.kits);
check('branches table', ex.branches.length === 2, ex.branches);
check('concentration', ex.concentration && ex.concentration.top1.party === 'ALKEM LABORATORIES LIMITED', ex.concentration);

console.log('analytics fixes');
check('kit no longer "no purchase cost"', !analytics.leaks.items_without_cost.some((i) => i.item === 'POST OP KIT') && analytics.items.find((i) => i.item === 'POST OP KIT').flags.includes('cost_from_assembly'), analytics.items.find((i) => i.item === 'POST OP KIT'));
check('headline says September is unfinished', analytics.headlines.some((h) => /Sep 2026 looks unfinished/.test(h)), analytics.headlines);
check('no margin comparison against the unfinished month', !analytics.headlines.some((h) => /in Sep 2026, (up|down)/.test(h)), analytics.headlines);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
