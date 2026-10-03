/**
 * _lib/booksEngine.js
 * Answers questions from a business's Tally books: every sale, purchase,
 * receipt, payment, expense line and stock line the agent has synced.
 *
 * Why this exists (2026-10-02): Margyn used to see a ten-line summary of the
 * books and was told never to recompute. So "what were my sales this year"
 * came back as the last-30-days figure (₹1.18 Cr instead of ₹14.5 Cr),
 * "top margin products" came back as "not available", and a ₹1.32 Cr
 * receivable was read out as ₹1.3 L. This engine gives the model questions
 * it can ask instead: totals for any period, breakdowns by month, customer,
 * vendor, ledger, item or branch, one customer's whole story, product
 * margins, who owes what, cash and loans, and what deserves attention.
 *
 * Rules that keep it honest:
 *  - All arithmetic is here, in plain JS. The model only picks the question
 *    and narrates the answer.
 *  - Counting matches the Margin page exactly: the same ledger classification,
 *    the same implied sales line for item invoices, the same non-accounting
 *    exclusions, the same bill calibration (it reuses tallyAnalytics).
 *  - Money leaves here already written the Indian way ("₹1.32 Cr",
 *    "₹41.2 L", "₹45,300"), so the model never converts units.
 *  - Every answer says what period it covers and what the books don't have
 *    (only the synced financial year, an unfinished month).
 *
 * Pure: takes the rows _lib/tallyData.js loads, returns plain objects.
 * CommonJS, zero-npm.
 */

const A = require('./tallyAnalytics');
const { calibrateBills } = require('./tallyBills');

const DAY = 86400000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nameKey = A.nameKey;

/* ---------------- words for money, dates, shares ---------------- */

function trimZeros(s) { return s.includes('.') ? s.replace(/\.?0+$/, '') : s; }
/** ₹14.52 Cr, ₹41.2 L, ₹4.12 L, ₹45,300. Never a bare digit string the model could misread. */
function inr(n) {
  const v = Math.round(num(n));
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + trimZeros((a / 1e7).toFixed(2)) + ' Cr';
  if (a >= 1e5) return sign + '₹' + trimZeros((a / 1e5).toFixed(a >= 1e6 ? 1 : 2)) + ' L';
  return sign + '₹' + a.toLocaleString('en-IN');
}
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const pctStr = (p) => (p == null ? 'n/a' : (Math.round(p * 10) / 10) + '%');
function dayStr(d, withYear) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()] + (withYear ? ' ' + dt.getUTCFullYear() : '');
}
const monthLabel = (k) => { const [y, m] = String(k).split('-'); return MON[(+m || 1) - 1] + ' ' + y; };
const isoDay = (dt) => dt.toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * How a person says a party's name: "SUN PHARMA LABORATORIES LTD" -> "Sun Pharma Laboratories".
 * Only for sentences Margyn writes; tables and lookups keep Tally's exact name.
 */
function niceName(s) {
  // Tally names can carry a line break inside them, which arrives as "&#13;&#10;" or a real CR/LF.
  let t = String(s || '').replace(/&#(1[03]|x0?[ad]);/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  t = t.replace(/[\s,.]+((pvt|private)\.?\s*)?(ltd|limited|llp)\.?(?=\s|$)/i, '').trim();
  if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) {
    t = t.toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(Llp|Pvt|Gst|Hdfc|Icici|Sbi|Idfc|Ipca|Usv|Mp|Up)\b/g, (w) => w.toUpperCase())
      .replace(/\b([a-z])(?=\.)/gi, (c) => c.toUpperCase())    // M.p. -> M.P.
      .replace(/\b((?:[A-Z]\.)+)([a-z])\b/g, (m, a, c) => a + c.toUpperCase());   // S.S.d -> S.S.D
  }
  return t;
}

/** "alkem" matches "ALKEM LABORATORIES LIMITED"; every word of the query must appear. */
function matcher(q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return () => true;
  return (name) => { const n = ' ' + norm(name) + ' '; return words.every((w) => n.includes(w)); };
}

/* ---------------- periods ---------------- */

function todayIST(now) {
  const t = (now ? new Date(now) : new Date()).getTime() + 5.5 * 3600000;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function fyStart(d) { const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return new Date(Date.UTC(y, 3, 1)); }
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

const PERIODS = ['this_fy', 'last_fy', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'last_7_days', 'last_30_days', 'last_90_days', 'today', 'yesterday', 'this_week', 'last_week', 'all'];

/**
 * A period the model can name ("this_fy", "last_month", "2026-08", "2026-08-14")
 * or give as { from, to } in YYYY-MM-DD. Defaults to this financial year.
 */
function resolvePeriod(p, now) {
  const today = todayIST(now);
  let from, to, label;
  const spec = p && typeof p === 'object' ? p : String(p || 'this_fy').trim().toLowerCase();
  if (spec && typeof spec === 'object') {
    from = spec.from ? new Date(String(spec.from).slice(0, 10) + 'T00:00:00Z') : fyStart(today);
    to = spec.to ? new Date(String(spec.to).slice(0, 10) + 'T00:00:00Z') : today;
    if (Number.isNaN(from.getTime())) from = fyStart(today);
    if (Number.isNaN(to.getTime())) to = today;
    label = dayStr(from, true) + ' to ' + dayStr(to, true);
  } else if (/^\d{4}-\d{2}$/.test(spec)) {
    from = new Date(spec + '-01T00:00:00Z'); to = monthEnd(from); label = monthLabel(spec);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    from = new Date(spec + 'T00:00:00Z'); to = from; label = dayStr(from, true);
  } else {
    const fy = fyStart(today);
    const q0 = new Date(Date.UTC(fy.getUTCFullYear(), 3 + 3 * Math.floor(((today.getUTCMonth() + 9) % 12) / 3), 1));
    const dow = (today.getUTCDay() + 6) % 7;   // Monday = 0
    switch (spec) {
      case 'last_fy': from = new Date(Date.UTC(fy.getUTCFullYear() - 1, 3, 1)); to = addDays(fy, -1); label = 'last financial year (' + (fy.getUTCFullYear() - 1) + '-' + String(fy.getUTCFullYear()).slice(2) + ')'; break;
      case 'this_month': from = monthStart(today); to = today; label = 'this month so far (' + MON[today.getUTCMonth()] + ')'; break;
      case 'last_month': { const s = monthStart(addDays(monthStart(today), -1)); from = s; to = monthEnd(s); label = monthLabel(isoDay(s).slice(0, 7)); break; }
      case 'this_quarter': from = q0; to = today; label = 'this quarter so far'; break;
      case 'last_quarter': { const s = new Date(Date.UTC(q0.getUTCFullYear(), q0.getUTCMonth() - 3, 1)); from = s; to = addDays(q0, -1); label = 'last quarter (' + MON[s.getUTCMonth()] + '-' + MON[to.getUTCMonth()] + ')'; break; }
      case 'last_7_days': from = addDays(today, -6); to = today; label = 'the last 7 days'; break;
      case 'last_30_days': from = addDays(today, -29); to = today; label = 'the last 30 days'; break;
      case 'last_90_days': from = addDays(today, -89); to = today; label = 'the last 90 days'; break;
      case 'today': from = today; to = today; label = 'today'; break;
      case 'yesterday': from = addDays(today, -1); to = from; label = 'yesterday (' + dayStr(from) + ')'; break;
      case 'this_week': from = addDays(today, -dow); to = today; label = 'this week so far'; break;
      case 'last_week': from = addDays(today, -dow - 7); to = addDays(from, 6); label = 'last week'; break;
      case 'all': from = new Date(Date.UTC(2000, 0, 1)); to = today; label = 'everything synced'; break;
      default: from = fy; to = today; label = 'this financial year so far (' + fy.getUTCFullYear() + '-' + String(fy.getUTCFullYear() + 1).slice(2) + ')';
    }
  }
  if (to < from) { const t = from; from = to; to = t; }
  return { from, to, label, fromISO: isoDay(from), toISO: isoDay(to) };
}

/* ---------------- preparing the books ---------------- */

function kindOf(t) {
  if (A.isCreditNote(t)) return 'credit_note';
  if (A.isDebitNote(t)) return 'debit_note';
  if (A.isSalesType(t)) return 'sales';
  if (A.isPurchaseType(t)) return 'purchase';
  if (/receipt/i.test(t || '')) return 'receipt';
  if (/payment/i.test(t || '')) return 'payment';
  if (/contra/i.test(t || '')) return 'contra';
  if (/journal/i.test(t || '')) return 'journal';
  return 'other';
}
/* "VASAI SALES" / "KANDIVALI SALE": a renamed sales type is usually a branch or godown. */
function branchOf(typeName, kind) {
  if (!['sales', 'credit_note', 'purchase', 'debit_note'].includes(kind)) return null;
  const rest = String(typeName || '').replace(/\b(sales?|purchases?|invoices?|bills?|gst|tax|credit\s*notes?|debit\s*notes?|returns?|vouchers?)\b/gi, ' ').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!rest) return null;
  return rest.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Normalise the synced rows once. `book` is what tallyData.loadTallyBook returns;
 * `analytics` (optional) is computeAnalytics' output if the caller already has it.
 */
function prepare(book, opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const ledgers = A.dedupe(book.ledgers || [], (l) => (l && l.name ? nameKey(l.name) : null),
    (a, b) => a.closing_balance != null && b.closing_balance == null);
  const all = A.dedupe(book.vouchers || [], (v) => (v && v.tally_guid ? 'g:' + v.tally_guid : null))
    .map((v) => (v && v.voucher_base ? Object.assign({}, v, { voucher_type_name: v.voucher_type, voucher_type: v.voucher_base }) : v));
  const analytics = o.analytics || A.computeAnalytics({
    ledgers: book.ledgers, vouchers: book.vouchers, bills: book.bills, overrides: book.overrides || {},
    syncRuns: book.syncRuns || [], diagnostics: book.diagnostics || null, edition: book.edition || null, now
  });
  const classes = A.classifyLedgers(ledgers, book.overrides || {}, A.partyRolesFromVouchers(all));
  classes.set(nameKey(A.IMPLIED_SALES), { bucket: 'sales' });
  classes.set(nameKey(A.IMPLIED_PURCHASES), { bucket: 'purchases' });
  const cls = (name) => (classes.get(name) || classes.get(nameKey(name)) || { bucket: 'unknown' }).bucket;
  const bills = A.dedupe(calibrateBills(book.bills || [], all, { now }).bills,
    (b) => (b ? (b.direction || '') + '|' + nameKey(b.party_name) + '|' + nameKey(b.bill_ref) : null));

  const rows = [];
  for (const v of all) {
    if (!v || v.is_cancelled === true || A.isNonAccounting(v.voucher_type)) continue;
    const dt = A.parseDate(v.date);
    if (!dt) continue;
    const kind = kindOf(v.voucher_type);
    const typeName = v.voucher_type_name || v.voucher_type || '';
    const entries = Array.isArray(v.entries) ? v.entries : [];
    const partyEntry = entries.find((e) => e && e.is_party);
    const party = v.party_name || (partyEntry && partyEntry.ledger) || null;
    const imp = A.impliedEntry(v, entries);
    const r = {
      guid: v.tally_guid || null, dt, day: isoDay(dt), mk: isoDay(dt).slice(0, 7), kind, type: typeName,
      branch: branchOf(typeName, kind), party, partyBucket: party ? cls(party) : null, number: v.voucher_number || null,
      narration: v.narration ? String(v.narration).replace(/\s+/g, ' ').trim() : null,
      total: Math.abs(num(partyEntry ? partyEntry.amount : v.amount)) || Math.abs(num(v.amount)),
      sales: 0, returns: 0, purchases: 0, direct: 0, opex: 0, direct_income: 0, other_income: 0, tax_out: 0, tax_in: 0,
      lines: [], items: Array.isArray(v.items) ? v.items.filter((it) => it && it.item) : []
    };
    for (const e of imp ? entries.concat([imp]) : entries) {
      if (!e || !e.ledger) continue;
      const a = num(e.amount);
      let bucket = cls(e.ledger);
      if (e.is_party && A.PL_BUCKETS.includes(bucket)) bucket = 'balance_sheet';
      r.lines.push({ ledger: e.ledger, bucket, amount: a, party: !!e.is_party });
      switch (bucket) {
        case 'sales': if (a >= 0) r.sales += a; else r.returns += -a; break;
        case 'purchases': r.purchases += -a; break;
        case 'direct_expense': r.direct += -a; break;
        case 'opex': r.opex += -a; break;
        case 'direct_income': r.direct_income += a; break;
        case 'other_income': r.other_income += a; break;
        case 'tax': if (/\b(tds|tcs)\b/i.test(e.ledger)) break; if (/input/i.test(e.ledger)) r.tax_in += -a; else if (/output/i.test(e.ledger)) r.tax_out += a; else if (a >= 0) r.tax_out += a; else r.tax_in += -a; break;
        default: break;
      }
    }
    rows.push(r);
  }
  rows.sort((a, b) => a.dt - b.dt);

  // Cost per unit for every item: average purchase price over everything synced, else what it cost to assemble.
  const assembled = A.assemblyCosts(all);
  const bought = {};
  for (const r of rows) {
    if (r.kind !== 'purchase' && r.kind !== 'debit_note') continue;
    const s = r.kind === 'debit_note' ? -1 : 1;
    for (const it of r.items) {
      const b = bought[it.item] || (bought[it.item] = { qty: 0, value: 0, vendors: {} });
      const val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
      b.qty += s * num(it.qty); b.value += s * val;
      if (r.party) { const vv = b.vendors[r.party] || (b.vendors[r.party] = { qty: 0, value: 0 }); vv.qty += s * num(it.qty); vv.value += s * val; }
    }
  }
  const unitCost = (item) => {
    const b = bought[item];
    if (b && b.qty > 0 && b.value > 0) return { cost: b.value / b.qty, basis: 'purchases' };
    const k = assembled[item];
    if (k && k.qty > 0 && k.value > 0) return { cost: k.value / k.qty, basis: 'assembly' };
    return { cost: null, basis: 'unknown' };
  };

  const first = rows.length ? rows[0].dt : null, last = rows.length ? rows[rows.length - 1].dt : null;
  const closedMonths = (analytics.pnl || []).filter((m) => !m.provisional && !m.partial_start);
  const monthsNet = closedMonths.map((m) => m.net_sales).filter((x) => x > 0);
  const avgMonthlySales = monthsNet.length ? monthsNet.reduce((a, b) => a + b, 0) / monthsNet.length : 0;
  return {
    now, today: todayIST(now), book, analytics, ledgers, rows, bills, cls, assembled, bought, unitCost,
    coverage: { from: first, to: last },
    company: book.company || null, lastSync: book.lastSync || null,
    avgMonthlySales,
    // What counts as "worth mentioning" scales with the business: 0.5% of a month's sales, at least ₹50,000.
    material: Math.max(50000, 0.005 * avgMonthlySales)
  };
}

function inPeriod(r, per) { return r.dt >= per.from && r.dt <= per.to; }

/** What the books can't tell about this period, said once. */
function periodNotes(ctx, per) {
  const notes = [];
  const c = ctx.coverage;
  if (!c.from) { notes.push('No Tally entries have synced yet.'); return notes; }
  if (per.from < c.from) notes.push(`Margyn has your Tally entries only from ${dayStr(c.from, true)} (this financial year). Anything earlier isn't synced yet, so it can't be counted.`);
  const unfinished = (ctx.analytics.pnl || []).filter((m) => m.costs_incomplete && m.month >= per.fromISO.slice(0, 7) && m.month <= per.toISO.slice(0, 7));
  for (const m of unfinished) notes.push(`${monthLabel(m.month)} looks unfinished in Tally: running costs are ${inr(m.opex)} against a usual ${inr(m.typical_opex)}, so its profit is overstated until salaries and other costs are booked.`);
  const cur = isoDay(ctx.today).slice(0, 7);
  if (per.toISO.slice(0, 7) >= cur && per.fromISO.slice(0, 7) <= cur) notes.push(`${MON[ctx.today.getUTCMonth()]} is still in progress.`);
  return notes;
}

function sourceLine(ctx) {
  const when = ctx.lastSync ? new Date(new Date(ctx.lastSync).getTime() + 5.5 * 3600000) : null;
  const hrs = ctx.lastSync ? Math.round((ctx.now - new Date(ctx.lastSync)) / 3600000) : null;
  return `From your Tally books${ctx.company ? ' (' + ctx.company + ')' : ''}${when ? ', last synced ' + dayStr(when) + ' ' + String(when.getUTCHours()).padStart(2, '0') + ':' + String(when.getUTCMinutes()).padStart(2, '0') + ' IST' : ''}${hrs != null && hrs > 26 ? ' (' + hrs + ' hours ago: the Tally PC may be off, so the latest entries may be missing)' : ''}.`;
}

/* ---------------- 1. totals for a period ---------------- */

function sumRows(rows) {
  const t = { sales: 0, returns: 0, sales_incl_gst: 0, purchases: 0, direct: 0, opex: 0, direct_income: 0, other_income: 0, receipts: 0, other_receipts: 0, payments: 0, vendor_payments: 0, tax_out: 0, tax_in: 0, invoices: 0, customers: new Set() };
  for (const r of rows) {
    t.sales += r.sales; t.returns += r.returns; t.purchases += r.purchases; t.direct += r.direct; t.opex += r.opex;
    t.direct_income += r.direct_income; t.other_income += r.other_income; t.tax_out += r.tax_out; t.tax_in += r.tax_in;
    if (r.kind === 'sales') { t.sales_incl_gst += r.total; t.invoices++; if (r.party) t.customers.add(norm(r.party)); }
    if (r.kind === 'credit_note') t.sales_incl_gst -= r.total;
    // Money from customers only: loan drawdowns, transfers and capital also arrive as Receipt vouchers.
    if (r.kind === 'receipt') { if (r.partyBucket === 'debtor') t.receipts += r.total; else t.other_receipts += r.total; }
    if (r.kind === 'payment') { t.payments += r.total; if (r.partyBucket === 'creditor') t.vendor_payments += r.total; }
  }
  t.net_sales = t.sales - t.returns;
  t.gross = t.net_sales + t.direct_income - t.purchases - t.direct;
  t.net = t.gross + t.other_income - t.opex;
  return t;
}

function summary(ctx, args) {
  const a = args || {};
  const per = resolvePeriod(a.period || (a.from || a.to ? { from: a.from, to: a.to } : 'this_fy'), ctx.now);
  const rows = ctx.rows.filter((r) => inPeriod(r, per));
  const t = sumRows(rows);
  const out = {
    source: sourceLine(ctx),
    period: per.label, from: per.fromISO, to: per.toISO,
    sales_before_gst: inr(t.net_sales),
    sales_including_gst: inr(t.sales_incl_gst),
    returns_and_credit_notes: inr(t.returns),
    purchases: inr(t.purchases),
    direct_costs: inr(t.direct),
    gross_profit: inr(t.gross) + ' (' + pctStr(pctOf(t.gross, t.net_sales)) + ' of sales, before stock change)',
    running_costs: inr(t.opex),
    profit: inr(t.net) + ' (' + pctStr(pctOf(t.net, t.net_sales)) + ' of sales, before stock change)',
    money_received_from_customers: inr(t.receipts),
    other_money_in: inr(t.other_receipts) + ' (loans, transfers, capital and other receipts not from a customer)',
    money_paid_out: inr(t.payments) + ' (of which ' + inr(t.vendor_payments) + ' to suppliers)',
    sales_invoices: t.invoices,
    customers_billed: t.customers.size,
    average_invoice: t.invoices ? inr(t.sales / t.invoices) : null,
    gst_on_sales_less_gst_on_purchases: inr(t.tax_out - t.tax_in)
  };
  // The whole synced year: Tally's stock change is known, so give the profit after it too.
  const P = ctx.analytics.period || {};
  if (P.from && per.fromISO <= P.from && per.toISO >= P.to && P.net_profit_after_stock != null) {
    out.profit_after_stock_change = inr(P.net_profit_after_stock) + ' (' + pctStr(P.net_margin_pct_after_stock) + '), gross margin ' + pctStr(P.gross_margin_pct_after_stock) + '. Indicative: uses the stock value Tally holds.';
  }
  const months = [...new Set(rows.map((r) => r.mk))].sort();
  if (months.length > 1) {
    out.by_month = months.map((mk) => {
      const m = sumRows(rows.filter((r) => r.mk === mk));
      const pm = (ctx.analytics.pnl || []).find((x) => x.month === mk) || {};
      return { month: monthLabel(mk), sales: inr(m.net_sales), gross_margin: pctStr(pctOf(m.gross, m.net_sales)), profit: inr(m.net), note: pm.costs_incomplete ? 'costs not fully booked' : pm.provisional ? 'in progress' : undefined };
    });
  }
  // Same length of time just before, when the books cover it.
  const len = Math.round((per.to - per.from) / DAY) + 1;
  const prevTo = addDays(per.from, -1), prevFrom = addDays(per.from, -len);
  if (ctx.coverage.from && prevFrom >= ctx.coverage.from && len <= 120) {
    const p = sumRows(ctx.rows.filter((r) => r.dt >= prevFrom && r.dt <= prevTo));
    if (p.net_sales > 0) out.compared_with_the_period_before = { period: dayStr(prevFrom) + ' to ' + dayStr(prevTo), sales: inr(p.net_sales), change: (t.net_sales >= p.net_sales ? '+' : '') + pctStr(pctOf(t.net_sales - p.net_sales, p.net_sales)) };
  }
  const notes = periodNotes(ctx, per);
  notes.push('Sales before GST are what the business earned; including GST is what customers were billed.');
  out.notes = notes;
  return out;
}

/* ---------------- 2. break a figure down ---------------- */

const MEASURES = ['sales', 'sales_including_gst', 'returns', 'purchases', 'expenses', 'running_costs', 'direct_costs', 'receipts', 'payments', 'gst', 'ledger', 'quantity_sold', 'margin'];
const GROUPS = ['month', 'day', 'customer', 'vendor', 'party', 'ledger', 'item', 'branch', 'voucher_type'];

function breakdown(ctx, args) {
  const a = args || {};
  let measure = MEASURES.includes(a.measure) ? a.measure : 'sales';
  let by = GROUPS.includes(a.by) ? a.by : 'month';
  if (by === 'vendor' || by === 'customer') by = 'party';
  const per = resolvePeriod(a.period || (a.from || a.to ? { from: a.from, to: a.to } : 'this_fy'), ctx.now);
  const top = Math.max(1, Math.min(50, parseInt(a.top, 10) || 10));
  const fParty = a.party ? matcher(a.party) : null;
  const fLedger = a.ledger ? matcher(a.ledger) : null;
  const fItem = a.item ? matcher(a.item) : null;
  const fBranch = a.branch ? matcher(a.branch) : null;
  if (measure === 'ledger' && !fLedger) return { error: 'Say which ledger: measure "ledger" needs ledger, e.g. "commission", "freight", "salary".' };
  const itemLevel = by === 'item' || measure === 'quantity_sold' || measure === 'margin' || !!fItem;

  const groups = new Map();
  const add = (key, amount, count) => {
    const k = key == null || key === '' ? '(none)' : key;
    const g = groups.get(k) || { name: k, value: 0, count: 0 };
    g.value += amount; g.count += count || 0; groups.set(k, g);
  };
  const keyOf = (r, extra) => {
    switch (by) {
      case 'month': return r.mk;
      case 'day': return r.day;
      case 'party': return r.party || '(no party)';
      case 'branch': return r.branch || 'Main';
      case 'voucher_type': return r.type;
      case 'item': return extra;
      case 'ledger': return extra;
      default: return r.mk;
    }
  };
  let costMissing = 0;
  for (const r of ctx.rows) {
    if (!inPeriod(r, per)) continue;
    if (fParty && !fParty(r.party)) continue;
    if (fBranch && !fBranch(r.branch || 'Main')) continue;
    if (itemLevel) {
      const sign = r.kind === 'credit_note' ? -1 : r.kind === 'sales' ? 1 : 0;
      if (!sign) continue;
      for (const it of r.items) {
        if (fItem && !fItem(it.item)) continue;
        const val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
        const qty = num(it.qty);
        let v;
        if (measure === 'quantity_sold') v = sign * qty;
        else if (measure === 'margin') {
          const c = ctx.unitCost(it.item);
          if (c.cost == null) { costMissing += sign * val; continue; }
          v = sign * (val - qty * c.cost);
        } else v = sign * val;
        add(keyOf(r, it.item), v, 1);
      }
      continue;
    }
    const lineMeasure = by === 'ledger' || measure === 'ledger';
    if (lineMeasure) {
      for (const l of r.lines) {
        if (l.party) continue;
        let v = null;
        if (measure === 'ledger') { if (fLedger(l.ledger) && (l.bucket !== 'tax' || /\b(tds|tcs|gst|tax)\b/i.test(a.ledger))) v = -l.amount; }
        else if (fLedger && !fLedger(l.ledger)) continue;
        else if (measure === 'expenses' && (l.bucket === 'opex' || l.bucket === 'direct_expense')) v = -l.amount;
        else if (measure === 'running_costs' && l.bucket === 'opex') v = -l.amount;
        else if (measure === 'direct_costs' && l.bucket === 'direct_expense') v = -l.amount;
        else if (measure === 'purchases' && l.bucket === 'purchases') v = -l.amount;
        else if ((measure === 'sales' || measure === 'returns') && l.bucket === 'sales') v = measure === 'sales' ? l.amount : (l.amount < 0 ? -l.amount : 0);
        else if (measure === 'gst' && l.bucket === 'tax' && !/\b(tds|tcs)\b/i.test(l.ledger)) v = l.amount;
        if (v == null) continue;
        add(keyOf(r, l.ledger), v, 1);
      }
      continue;
    }
    let v = 0;
    switch (measure) {
      case 'sales': v = r.sales - r.returns; if (r.kind !== 'sales' && r.kind !== 'credit_note' && !v) continue; break;
      case 'sales_including_gst': if (r.kind === 'sales') v = r.total; else if (r.kind === 'credit_note') v = -r.total; else continue; break;
      case 'returns': v = r.returns; if (!v) continue; break;
      case 'purchases': v = r.purchases; if (!v) continue; break;
      case 'expenses': v = r.opex + r.direct; if (!v) continue; break;
      case 'running_costs': v = r.opex; if (!v) continue; break;
      case 'direct_costs': v = r.direct; if (!v) continue; break;
      case 'receipts': if (r.kind !== 'receipt' || (r.partyBucket !== 'debtor' && !fParty)) continue; v = r.total; break;
      case 'payments': if (r.kind !== 'payment') continue; v = r.total; break;
      case 'gst': v = r.tax_out - r.tax_in; if (!v) continue; break;
      default: continue;
    }
    add(keyOf(r), v, 1);
  }

  let list = [...groups.values()];
  const total = list.reduce((s, g) => s + g.value, 0);
  if (by === 'month' || by === 'day') list.sort((x, y) => (x.name < y.name ? -1 : 1));
  else list.sort((x, y) => (a.order === 'asc' ? x.value - y.value : y.value - x.value));
  const shown = (by === 'month' || by === 'day') ? list.slice(-Math.max(top, by === 'month' ? 12 : top)) : list.slice(0, top);
  const rest = list.filter((g) => !shown.includes(g));
  const unit = measure === 'quantity_sold' ? (v) => Math.round(v).toLocaleString('en-IN') + ' units' : inr;
  const out = {
    source: sourceLine(ctx),
    measure, by: a.by || by, period: per.label,
    filters: [a.party && 'party ~ "' + a.party + '"', a.ledger && 'ledger ~ "' + a.ledger + '"', a.item && 'item ~ "' + a.item + '"', a.branch && 'branch ~ "' + a.branch + '"'].filter(Boolean).join(', ') || 'none',
    total: unit(total),
    rows: shown.map((g) => ({
      name: by === 'month' ? monthLabel(g.name) : by === 'day' ? dayStr(new Date(g.name + 'T00:00:00Z')) : g.name,
      amount: unit(g.value),
      share: measure === 'quantity_sold' || !total ? undefined : pctStr(pctOf(g.value, total)),
      entries: g.count,
      rupees: measure === 'quantity_sold' ? undefined : Math.round(g.value)
    })),
    groups_found: list.length
  };
  if (rest.length) out.everything_else = { groups: rest.length, amount: unit(rest.reduce((s, g) => s + g.value, 0)) };
  if (!list.length) out.note = 'Nothing matched in ' + per.label + '. Check the spelling of the name, or try a longer period.';
  if (measure === 'ledger') {
    const names = [...new Set(ctx.rows.flatMap((r) => r.lines.filter((l) => fLedger(l.ledger) && (l.bucket !== 'tax' || /\b(tds|tcs|gst|tax)\b/i.test(a.ledger))).map((l) => l.ledger)))].slice(0, 8);
    out.ledgers_matched = names;
    out.sign_note = 'Positive = money spent / debited to the ledger; negative = credited (income).';
  }
  if (measure === 'margin') out.margin_note = 'Margin = sales value less quantity x average cost (purchase price, or for kits you assemble, the cost of the parts).' + (costMissing ? ' ' + inr(costMissing) + ' of sales had no known cost and is left out.' : '');
  if (itemLevel && !ctx.rows.some((r) => r.items.length)) out.note = 'Item lines haven\'t synced from Tally for these vouchers, so item-level figures aren\'t available.';
  out.notes = periodNotes(ctx, per);
  out.rupees_note = '"rupees" is for charts only; say the "amount" text.';
  return out;
}

/* ---------------- 3. find entries ---------------- */

function findEntries(ctx, args) {
  const a = args || {};
  const per = resolvePeriod(a.period || (a.from || a.to ? { from: a.from, to: a.to } : 'all'), ctx.now);
  const fParty = a.party ? matcher(a.party) : null, fLedger = a.ledger ? matcher(a.ledger) : null, fItem = a.item ? matcher(a.item) : null;
  const fText = a.text ? matcher(a.text) : null;
  const kinds = { sales: ['sales'], sale: ['sales'], invoice: ['sales'], purchase: ['purchase'], purchases: ['purchase'], bill: ['purchase'], receipt: ['receipt'], receipts: ['receipt'], payment: ['payment'], payments: ['payment'], credit_note: ['credit_note'], return: ['credit_note'], debit_note: ['debit_note'], journal: ['journal'], contra: ['contra'] };
  const kset = a.kind ? kinds[String(a.kind).toLowerCase()] : null;
  const min = a.min_amount != null ? num(a.min_amount) : null, max = a.max_amount != null ? num(a.max_amount) : null;
  const numQ = a.number ? norm(a.number) : null;
  let hits = ctx.rows.filter((r) => inPeriod(r, per)
    && (!kset || kset.includes(r.kind))
    && (!fParty || fParty(r.party))
    && (!fLedger || r.lines.some((l) => fLedger(l.ledger)))
    && (!fItem || r.items.some((it) => fItem(it.item)))
    && (!fText || fText((r.narration || '') + ' ' + (r.party || '') + ' ' + (r.number || '')))
    && (!numQ || norm(r.number) === numQ || norm(r.number).endsWith(numQ))
    && (min == null || r.total >= min) && (max == null || r.total <= max));
  const count = hits.length, total = hits.reduce((s, r) => s + r.total, 0);
  hits = a.sort === 'largest' ? hits.sort((x, y) => y.total - x.total) : hits.sort((x, y) => y.dt - x.dt);
  const limit = Math.max(1, Math.min(30, parseInt(a.limit, 10) || 12));
  return {
    source: sourceLine(ctx), period: per.label,
    found: count, total_of_found: inr(total),
    entries: hits.slice(0, limit).map((r) => ({
      date: dayStr(r.dt, true), type: r.type, number: r.number, party: r.party, amount: inr(r.total),
      narration: r.narration ? r.narration.slice(0, 90) : undefined,
      items: r.items.length ? r.items.slice(0, 3).map((it) => it.item + (it.qty ? ' x' + num(it.qty) : '')).join('; ') + (r.items.length > 3 ? ' +' + (r.items.length - 3) + ' more' : '') : undefined
    })),
    showing: count > limit ? `${a.sort === 'largest' ? 'largest' : 'latest'} ${limit} of ${count}` : 'all'
  };
}

/* ---------------- bills: who owes what ---------------- */

const AGE_BUCKETS = [['not yet due', -Infinity, 0], ['1-30 days late', 1, 30], ['31-60 days late', 31, 60], ['61-90 days late', 61, 90], ['91-180 days late', 91, 180], ['181-365 days late', 181, 365], ['over a year late', 366, Infinity]];
function billRows(ctx, direction) {
  return ctx.bills.filter((b) => !b.advance && (direction === 'payable' ? b.direction === 'payable' : b.direction !== 'payable'))
    .map((b) => ({ party: b.party_name || 'Unknown', ref: b.bill_ref || null, date: A.parseDate(b.bill_date), due: A.parseDate(b.due_date), amount: Math.abs(num(b.closing_balance)), late: b.overdue_days == null ? 0 : num(b.overdue_days) }))
    .filter((b) => b.amount >= 1);
}
function ageing(bills) {
  return Object.fromEntries(AGE_BUCKETS.map(([label, lo, hi]) => [label, inr(bills.filter((b) => b.late >= lo && b.late <= hi).reduce((s, b) => s + b.amount, 0))]));
}
function byParty(bills) {
  const m = new Map();
  for (const b of bills) {
    const k = norm(b.party);
    const g = m.get(k) || { party: b.party, total: 0, overdue: 0, oldest: 0, bills: 0 };
    g.total += b.amount; g.bills++;
    if (b.late > 0) g.overdue += b.amount;
    if (b.late > g.oldest) g.oldest = b.late;
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => y.total - x.total);
}
function dailySales90(ctx) {
  const from = addDays(ctx.today, -89);
  const t = sumRows(ctx.rows.filter((r) => r.dt >= from));
  return t.net_sales > 0 ? t.net_sales / 90 : ctx.avgMonthlySales / 30;
}

function moneyOwed(ctx, args) {
  const a = args || {};
  const dir = /pay|owe them|vendor|supplier/i.test(a.direction || '') ? 'payable' : 'receivable';
  let bills = billRows(ctx, dir);
  if (a.party) { const f = matcher(a.party); bills = bills.filter((b) => f(b.party)); }
  const total = bills.reduce((s, b) => s + b.amount, 0), overdue = bills.filter((b) => b.late > 0).reduce((s, b) => s + b.amount, 0);
  const parties = byParty(bills);
  const top = Math.max(1, Math.min(25, parseInt(a.top, 10) || 10));
  const wc = ctx.analytics.working_capital || {};
  const out = {
    source: sourceLine(ctx) + ' Bill-wise outstanding as of the last sync.',
    direction: dir === 'payable' ? 'what you owe vendors' : 'what customers owe you',
    total: inr(total), overdue: inr(overdue) + (total ? ' (' + pctStr(pctOf(overdue, total)) + ')' : ''),
    parties: parties.length,
    ageing: ageing(bills),
    largest: parties.slice(0, top).map((g) => ({ [dir === 'payable' ? 'vendor' : 'customer']: g.party, owed: inr(g.total), overdue: inr(g.overdue), oldest_bill_days_late: g.oldest, bills: g.bills })),
    most_overdue: parties.filter((g) => g.overdue > 0).sort((x, y) => y.overdue - x.overdue).slice(0, 5).map((g) => ({ name: g.party, overdue: inr(g.overdue), oldest_days_late: g.oldest }))
  };
  const veryOld = parties.filter((g) => g.oldest > 365);
  if (veryOld.length) out.over_a_year_old = { amount: inr(bills.filter((b) => b.late > 365).reduce((s, b) => s + b.amount, 0)), names: veryOld.slice(0, 6).map((g) => g.party + ' (' + g.oldest + ' days)'), note: 'Bills this old are usually disputed, short-paid or already settled but not knocked off in Tally. Worth a review: chase, settle, or write off.' };
  if (dir === 'receivable') {
    if (wc.dso_days != null) out.days_to_get_paid = Math.round(wc.dso_days) + ' days on average (last 90 days of sales)';
    const d = dailySales90(ctx);
    if (d > 0) out.what_faster_collection_frees = 'Every 10 days faster that customers pay frees about ' + inr(d * 10) + ' of cash (based on ' + inr(d) + ' of sales a day over the last 90 days).';
  } else if (wc.dpo_days != null) out.days_you_take_to_pay = Math.round(wc.dpo_days) + ' days on average';
  return out;
}

/* ---------------- 4. one customer or vendor ---------------- */

function resolveParty(ctx, q) {
  const names = new Map();
  const bump = (n, v) => { if (!n) return; const k = norm(n); const e = names.get(k) || { name: n, vol: 0 }; e.vol += v; names.set(k, e); };
  for (const r of ctx.rows) bump(r.party, r.total);
  for (const b of ctx.bills) bump(b.party_name, Math.abs(num(b.closing_balance)));
  const qn = norm(q);
  const all = [...names.values()];
  const exact = all.find((e) => norm(e.name) === qn);
  if (exact) return { match: exact.name, others: [] };
  const f = matcher(q);
  let hits = all.filter((e) => f(e.name));
  if (!hits.length) {
    // Loose: any word of 3+ letters.
    const words = qn.split(' ').filter((w) => w.length >= 3);
    hits = all.filter((e) => words.some((w) => (' ' + norm(e.name) + ' ').includes(' ' + w)));
  }
  hits.sort((x, y) => y.vol - x.vol);
  if (!hits.length) return { match: null, others: [] };
  return { match: hits[0].name, others: hits.slice(1, 6).map((e) => e.name) };
}

function partyProfile(ctx, args) {
  const q = String((args && (args.name || args.party)) || '').trim();
  if (!q) return { error: 'Say whose story you want: a customer or vendor name.' };
  const res = resolveParty(ctx, q);
  if (!res.match) return { found: false, note: `No customer or vendor in your Tally books matches "${q}". Check the spelling or try part of the name.` };
  const key = norm(res.match);
  const mine = ctx.rows.filter((r) => norm(r.party) === key);
  const fy = resolvePeriod('this_fy', ctx.now);
  const out = { source: sourceLine(ctx), name: res.match };
  if (res.others.length) out.also_matched = res.others;

  const sales = mine.filter((r) => r.kind === 'sales' || r.kind === 'credit_note');
  const purchases = mine.filter((r) => r.kind === 'purchase' || r.kind === 'debit_note');
  out.role = sales.length && purchases.length ? 'customer and vendor' : purchases.length ? 'vendor' : 'customer';

  if (sales.length || ctx.bills.some((b) => b.direction !== 'payable' && norm(b.party_name) === key)) {
    const t = sumRows(sales.filter((r) => inPeriod(r, fy)));
    const allT = sumRows(ctx.rows.filter((r) => inPeriod(r, fy)));
    const ranks = byNet(ctx.rows.filter((r) => inPeriod(r, fy)));
    const rank = ranks.findIndex((x) => norm(x.party) === key);
    const inv = sales.filter((r) => r.kind === 'sales');
    const days = [...new Set(inv.map((r) => r.day))].sort();
    const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / DAY);
    const med = gaps.length ? gaps.slice().sort((x, y) => x - y)[Math.floor(gaps.length / 2)] : null;
    const lastInv = inv[inv.length - 1];
    const items = new Map();
    let margin = 0, marginKnown = 0;
    for (const r of sales) for (const it of r.items) {
      const s = r.kind === 'credit_note' ? -1 : 1, val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount)), qty = num(it.qty);
      const g = items.get(it.item) || { item: it.item, qty: 0, value: 0 };
      g.qty += s * qty; g.value += s * val; items.set(it.item, g);
      const c = ctx.unitCost(it.item);
      if (c.cost != null) { margin += s * (val - qty * c.cost); marginKnown += s * val; }
    }
    const months = [...new Set(sales.map((r) => r.mk))].sort();
    out.as_customer = {
      sales_this_fy_before_gst: inr(t.net_sales),
      share_of_your_sales: pctStr(pctOf(t.net_sales, allT.net_sales)),
      rank_among_customers: rank >= 0 ? rank + 1 : null,
      invoices: inv.length,
      last_invoice: lastInv ? { date: dayStr(lastInv.dt, true), amount: inr(lastInv.total), number: lastInv.number } : null,
      days_since_last_invoice: lastInv ? Math.round((ctx.today - lastInv.dt) / DAY) : null,
      usually_orders_every: med != null ? Math.round(med) + ' days' : null,
      returns: inr(t.returns),
      by_month: months.map((mk) => ({ month: monthLabel(mk), sales: inr(sumRows(sales.filter((r) => r.mk === mk)).net_sales) })),
      top_items: [...items.values()].sort((x, y) => y.value - x.value).slice(0, 6).map((g) => ({ item: g.item, qty: Math.round(g.qty), sales: inr(g.value), avg_price: g.qty > 0 ? inr(g.value / g.qty) : null })),
      estimated_margin_on_items: marginKnown > 0 ? inr(margin) + ' (' + pctStr(pctOf(margin, marginKnown)) + ')' : null
    };
    const bills = billRows(ctx, 'receivable').filter((b) => norm(b.party) === key);
    const owed = bills.reduce((s, b) => s + b.amount, 0);
    const receipts = mine.filter((r) => r.kind === 'receipt');
    const lastRec = receipts[receipts.length - 1];
    const cust = (ctx.analytics.customers || []).find((c) => norm(c.party) === key);
    out.owes_you = {
      total: inr(owed), overdue: inr(bills.filter((b) => b.late > 0).reduce((s, b) => s + b.amount, 0)),
      oldest_bill_days_late: bills.reduce((m, b) => Math.max(m, b.late), 0),
      ageing: ageing(bills),
      open_bills: bills.sort((x, y) => y.late - x.late).slice(0, 8).map((b) => ({ bill: b.ref, dated: dayStr(b.date, true), amount: inr(b.amount), days_late: b.late > 0 ? b.late : 0 })),
      paid_you_this_fy: inr(receipts.filter((r) => inPeriod(r, fy)).reduce((s, r) => s + r.total, 0)),
      last_payment: lastRec ? { date: dayStr(lastRec.dt, true), amount: inr(lastRec.total) } : null,
      days_to_pay: cust && cust.dso_days != null ? Math.round(cust.dso_days) + ' days (last 90 days)' : null
    };
  }
  if (purchases.length || ctx.bills.some((b) => b.direction === 'payable' && norm(b.party_name) === key)) {
    const t = sumRows(purchases.filter((r) => inPeriod(r, fy)));
    const last = purchases[purchases.length - 1];
    const items = new Map();
    for (const r of purchases) for (const it of r.items) {
      const s = r.kind === 'debit_note' ? -1 : 1, val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
      const g = items.get(it.item) || { item: it.item, qty: 0, value: 0 };
      g.qty += s * num(it.qty); g.value += s * val; items.set(it.item, g);
    }
    const bills = billRows(ctx, 'payable').filter((b) => norm(b.party) === key);
    const paid = mine.filter((r) => r.kind === 'payment');
    const lastPaid = paid[paid.length - 1];
    out.as_vendor = {
      bought_this_fy: inr(t.purchases + t.direct + t.opex),
      bills: purchases.filter((r) => r.kind === 'purchase').length,
      last_bill: last ? { date: dayStr(last.dt, true), amount: inr(last.total) } : null,
      top_items: [...items.values()].sort((x, y) => y.value - x.value).slice(0, 6).map((g) => ({ item: g.item, qty: Math.round(g.qty), value: inr(g.value), avg_cost: g.qty > 0 ? inr(g.value / g.qty) : null })),
      you_owe: inr(bills.reduce((s, b) => s + b.amount, 0)),
      overdue: inr(bills.filter((b) => b.late > 0).reduce((s, b) => s + b.amount, 0)),
      paid_them_this_fy: inr(paid.filter((r) => inPeriod(r, fy)).reduce((s, r) => s + r.total, 0)),
      last_paid: lastPaid ? { date: dayStr(lastPaid.dt, true), amount: inr(lastPaid.total) } : null
    };
  }
  // Payments to someone who isn't a vendor on a bill (salary, commission agents, rent).
  if (!out.as_customer && !out.as_vendor) {
    const paid = mine.filter((r) => r.kind === 'payment' || r.kind === 'journal');
    out.payments = { this_fy: inr(paid.filter((r) => inPeriod(r, fy)).reduce((s, r) => s + r.total, 0)), entries: paid.length, last: paid.length ? { date: dayStr(paid[paid.length - 1].dt, true), amount: inr(paid[paid.length - 1].total) } : null };
  }
  return out;
}

function byNet(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.kind !== 'sales' && r.kind !== 'credit_note') continue;
    const k = norm(r.party || '(no party)');
    const g = m.get(k) || { party: r.party || '(no party)', net: 0, last: null, days: new Set(), months: new Set() };
    g.net += r.sales - r.returns;
    if (r.kind === 'sales') { g.days.add(r.day); g.months.add(r.mk); if (!g.last || r.dt > g.last) g.last = r.dt; }
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => y.net - x.net);
}

/* ---------------- 5. products ---------------- */

function productStats(ctx, per) {
  const m = new Map();
  for (const r of ctx.rows) {
    if (!inPeriod(r, per) || (r.kind !== 'sales' && r.kind !== 'credit_note')) continue;
    const s = r.kind === 'credit_note' ? -1 : 1;
    for (const it of r.items) {
      const g = m.get(it.item) || { item: it.item, unit: it.unit || null, qty: 0, value: 0, zeroQty: 0, customers: new Map() };
      const val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
      g.qty += s * num(it.qty); g.value += s * val;
      if (s > 0 && val === 0 && num(it.qty) > 0) g.zeroQty += num(it.qty);
      if (r.party) { const c = g.customers.get(r.party) || { qty: 0, value: 0 }; c.qty += s * num(it.qty); c.value += s * val; g.customers.set(r.party, c); }
      m.set(it.item, g);
    }
  }
  return [...m.values()].map((g) => {
    const c = ctx.unitCost(g.item);
    const price = g.qty > 0 ? g.value / g.qty : null;
    const margin = c.cost != null ? g.value - g.qty * c.cost : null;
    const flags = [];
    if (c.cost != null && price != null && price < c.cost) flags.push(price < 0.25 * c.cost ? 'price far below cost: check the unit (pack vs piece) or a free scheme' : 'sold below cost');
    if (g.zeroQty > 0) flags.push(Math.round(g.zeroQty) + ' given free (zero price)');
    if (c.basis === 'assembly') flags.push('kit you assemble: cost = its parts');
    if (margin != null && g.value > 0 && margin / g.value > 0.9) flags.push('margin looks too high: the purchase unit may differ from the selling unit');
    if (c.cost == null) flags.push('no cost known (never purchased or assembled in the synced period)');
    return { g, price, cost: c.cost, basis: c.basis, margin, marginPct: margin != null ? pctOf(margin, g.value) : null, flags };
  });
}

function products(ctx, args) {
  const a = args || {};
  const per = resolvePeriod(a.period || 'this_fy', ctx.now);
  const stats = productStats(ctx, per);
  if (!stats.length) return { source: sourceLine(ctx), note: ctx.rows.some((r) => r.items.length) ? 'No items sold in ' + per.label + '.' : 'Tally hasn\'t sent item lines yet, so product figures aren\'t available.' };
  const fmt = (s) => ({ item: s.g.item, sold: Math.round(s.g.qty).toLocaleString('en-IN') + (s.g.unit ? ' ' + s.g.unit.toLowerCase() : ''), sales: inr(s.g.value), avg_price: s.price != null ? inr(s.price) : null, avg_cost: s.cost != null ? inr(s.cost) : null, margin: s.margin != null ? inr(s.margin) : null, margin_pct: s.marginPct != null ? pctStr(s.marginPct) : null, flags: s.flags.length ? s.flags : undefined });

  if (a.name) {
    const f = matcher(a.name);
    const hit = stats.filter((s) => f(s.g.item)).sort((x, y) => y.g.value - x.g.value);
    if (!hit.length) return { found: false, note: `No item sold in ${per.label} matches "${a.name}".` };
    const s = hit[0];
    const cust = [...s.g.customers.entries()].map(([party, c]) => ({ customer: party, qty: Math.round(c.qty), sales: inr(c.value), avg_price: c.qty > 0 ? inr(c.value / c.qty) : null, _p: c.qty > 0 ? c.value / c.qty : null, _v: c.value }))
      .sort((x, y) => y._v - x._v);
    const prices = cust.map((c) => c._p).filter((p) => p != null && p > 0);
    const b = ctx.bought[s.g.item];
    const k = ctx.assembled[s.g.item];
    const months = new Map();
    for (const r of ctx.rows) {
      if (!inPeriod(r, per) || (r.kind !== 'sales' && r.kind !== 'credit_note')) continue;
      for (const it of r.items) if (it.item === s.g.item) { const mm = months.get(r.mk) || { qty: 0, value: 0 }; const sg = r.kind === 'credit_note' ? -1 : 1; mm.qty += sg * num(it.qty); mm.value += sg * (it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount))); months.set(r.mk, mm); }
    }
    return {
      source: sourceLine(ctx), period: per.label, ...fmt(s),
      also_matched: hit.slice(1, 5).map((x) => x.g.item),
      by_month: [...months.entries()].sort().map(([mk, mm]) => ({ month: monthLabel(mk), qty: Math.round(mm.qty), sales: inr(mm.value) })),
      customers: cust.slice(0, 8).map((c) => ({ customer: c.customer, qty: c.qty, sales: c.sales, avg_price: c.avg_price })),
      price_range: prices.length > 1 ? inr(Math.min(...prices)) + ' to ' + inr(Math.max(...prices)) + ' per unit across customers' : undefined,
      bought_from: b ? Object.entries(b.vendors).sort((x, y) => y[1].value - x[1].value).slice(0, 4).map(([v, x]) => ({ vendor: v, qty: Math.round(x.qty), avg_cost: x.qty > 0 ? inr(x.value / x.qty) : null })) : undefined,
      made_from: k ? Object.values(k.components).sort((x, y) => y.value - x.value).slice(0, 8).map((c) => ({ part: c.item, qty: Math.round(c.qty), value: inr(c.value) })) : undefined,
      cost_basis: s.basis === 'purchases' ? 'average purchase price over the synced year' : s.basis === 'assembly' ? 'cost of the parts in your Manufacturing Journals' : 'unknown'
    };
  }

  const sort = String(a.sort || 'sales');
  const top = Math.max(1, Math.min(30, parseInt(a.top, 10) || 10));
  const total = stats.reduce((t, s) => t + s.g.value, 0);
  // Margin rankings ignore tiny items, or a ₹2,000 one-off tops the list.
  const big = (s) => s.g.value >= Math.max(25000, 0.003 * total);
  let list;
  switch (sort) {
    case 'margin_pct': list = stats.filter((s) => s.marginPct != null && big(s)).sort((x, y) => y.marginPct - x.marginPct); break;
    case 'lowest_margin_pct': list = stats.filter((s) => s.marginPct != null && big(s)).sort((x, y) => x.marginPct - y.marginPct); break;
    case 'margin': list = stats.filter((s) => s.margin != null).sort((x, y) => y.margin - x.margin); break;
    case 'below_cost': list = stats.filter((s) => s.margin != null && s.margin < 0).sort((x, y) => x.margin - y.margin); break;
    case 'no_cost': list = stats.filter((s) => s.cost == null).sort((x, y) => y.g.value - x.g.value); break;
    case 'qty': list = stats.slice().sort((x, y) => y.g.qty - x.g.qty); break;
    default: list = stats.slice().sort((x, y) => y.g.value - x.g.value);
  }
  const known = stats.filter((s) => s.margin != null);
  const mk = known.reduce((t, s) => t + s.margin, 0), mv = known.reduce((t, s) => t + s.g.value, 0);
  return {
    source: sourceLine(ctx), period: per.label, sorted_by: sort,
    items_sold: stats.length, total_item_sales: inr(total),
    overall_item_margin: mv ? inr(mk) + ' (' + pctStr(pctOf(mk, mv)) + ') on ' + inr(mv) + ' of sales with a known cost' : null,
    items: list.slice(0, top).map(fmt),
    cost_note: 'Cost per unit = average purchase price over the synced year; for kits you assemble, the cost of the parts from Manufacturing Journals. Stock bought before the synced year isn\'t costed.'
  };
}

/* ---------------- 6. cash, loans, interest, GST ---------------- */

function cashAndDebt(ctx) {
  const an = ctx.analytics;
  const conv = ((an.quality || {}).balance_sign || {}).convention;
  const eff = !conv || conv === 'unknown' ? 'opposite' : conv;
  const debitPos = (b) => (eff === 'same' ? -num(b) : num(b));
  const move = new Map();
  for (const r of ctx.rows) for (const l of r.lines) { const k = nameKey(l.ledger); move.set(k, (move.get(k) || 0) + l.amount); }
  const balanceOf = (l) => {
    if (l.closing_balance != null) return { v: debitPos(l.closing_balance), how: 'Tally' };
    if (l.opening_balance != null) return { v: debitPos(l.opening_balance) - (move.get(nameKey(l.name)) || 0), how: 'opening + entries' };
    return null;
  };
  // Judged by the ledger's group (and only for balance-sheet ledgers), so "INTEREST ON OD" is never a loan.
  const isLoan = (l) => {
    const b = ctx.cls(l.name);
    if (b === 'bank_od') return true;
    if (A.PL_BUCKETS.includes(b) || b === 'debtor' || b === 'creditor' || b === 'tax') return false;
    return /\b(o\.?\s?d|overdraft|cash\s*credit|loans?)\b/i.test(l.parent || '') || (b === 'bank' && /\b(o\.?\s?d|overdraft|cash\s*credit)\b/i.test(l.name));
  };
  const cashL = [], loans = [];
  for (const l of ctx.ledgers) {
    const b = ctx.cls(l.name);
    const sweep = /sweep/i.test(l.name) && /deposit/i.test(l.parent || '');
    if (isLoan(l) && !sweep) { const bal = balanceOf(l); if (bal && Math.abs(bal.v) >= 1) loans.push({ name: l.name, group: l.parent, owed: -bal.v, how: bal.how }); continue; }
    if (b === 'bank' || b === 'cash' || sweep) { const bal = balanceOf(l); if (bal && Math.abs(bal.v) >= 1) cashL.push({ name: l.name, balance: bal.v, how: bal.how }); }
  }
  cashL.sort((x, y) => y.balance - x.balance);
  loans.sort((x, y) => y.owed - x.owed);
  const fy = resolvePeriod('this_fy', ctx.now);
  const interest = new Map();
  for (const r of ctx.rows) {
    if (!inPeriod(r, fy)) continue;
    for (const l of r.lines) if (/interest/i.test(l.ledger) && (l.bucket === 'opex' || l.bucket === 'direct_expense' || l.bucket === 'other_income')) { if (l.bucket === 'other_income') continue; interest.set(l.ledger, (interest.get(l.ledger) || 0) - l.amount); }
  }
  const interestTotal = [...interest.values()].reduce((a, b) => a + b, 0);
  const cur = isoDay(ctx.today).slice(0, 7);
  const lastGst = (an.gst_estimate || []).filter((g) => g.month < cur).slice(-1)[0];
  const out = {
    source: sourceLine(ctx),
    cash_and_bank_total: an.cash ? inr(an.cash.total) : inr(cashL.reduce((s, c) => s + c.balance, 0)),
    accounts: cashL.slice(0, 10).map((c) => ({ account: c.name, balance: inr(c.balance) })),
    loans_and_overdraft: loans.slice(0, 8).map((x) => ({ account: x.name, owed: inr(x.owed), group: x.group || undefined, worked_out_as: x.how === 'Tally' ? undefined : 'opening balance + this year\'s entries' })),
    total_borrowed: loans.length ? inr(loans.reduce((s, x) => s + Math.max(0, x.owed), 0)) : inr(0),
    interest_paid_this_fy: inr(interestTotal),
    interest_by_ledger: [...interest.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => ({ ledger: k, amount: inr(v) }))
  };
  if (lastGst) {
    const [y, m] = lastGst.month.split('-').map(Number);
    const due = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20));
    out.gst_estimate = { month: monthLabel(lastGst.month), output_tax: inr(lastGst.output_tax), input_tax: inr(lastGst.input_tax), net_payable: inr(lastGst.net_payable_estimate), usual_due_date: dayStr(due, true), note: 'Estimate from the tax ledgers in Tally, not the GST portal. Your CA files the actual return.' };
  }
  out.notes = [
    'Balances use Tally\'s figure where it sent one; otherwise the opening balance plus this year\'s entries.',
    loans.some((x) => /o\.?\s?d|overdraft|cash credit/i.test(x.name + ' ' + (x.group || ''))) ? 'The business runs on an overdraft. Margyn doesn\'t know the overdraft limit, so it can\'t say how much headroom is left; cash alone understates what you can draw.' : null
  ].filter(Boolean);
  return out;
}

/* ---------------- 7. what deserves attention ---------------- */

const SEV = { high: 3, medium: 2, low: 1 };

/** Customers who paid in the last `days` days: nameKey -> their latest receipt. */
function recentReceipts(ctx, days) {
  const from = addDays(ctx.today, -days), out = new Map();
  for (const r of ctx.rows) {
    if (r.kind !== 'receipt' || !r.party || r.dt < from) continue;
    const k = norm(r.party), p = out.get(k);
    if (!p || r.dt > p.dt) out.set(k, { dt: r.dt, amount: r.total });
  }
  return out;
}
/**
 * Customers with money more than a month late, most urgent first. Score = each late bill's amount weighted by
 * how late it is (capped at six months), so age counts as much as size.
 */
function lateRanking(recvBills, recentPay) {
  const m = new Map();
  for (const b of recvBills) {
    if (b.late <= 0) continue;
    const k = norm(b.party);
    const g = m.get(k) || { party: b.party, late30: 0, slipping: 0, score: 0, oldest: null };
    if (b.late > 30) { g.late30 += b.amount; g.score += b.amount * Math.min(b.late, 180) / 30; } else g.slipping += b.amount;
    if (!g.oldest || b.late > g.oldest.late) g.oldest = b;
    m.set(k, g);
  }
  return [...m.values()].filter((g) => g.late30 > 0)
    .map((g) => Object.assign(g, { paidRecently: recentPay.get(norm(g.party)) || null }))
    .sort((x, y) => y.score - x.score);
}

function insights(ctx) {
  const an = ctx.analytics, M = ctx.material, out = [];
  const push = (x) => out.push(Object.assign({ severity: 'medium', impact: 0 }, x));
  const wc = an.working_capital || {};
  const recvBills = billRows(ctx, 'receivable');
  const recvParties = byParty(recvBills);
  const recvTotal = recvBills.reduce((s, b) => s + b.amount, 0);
  const recvOver = recvBills.filter((b) => b.late > 0).reduce((s, b) => s + b.amount, 0);
  const daily = dailySales90(ctx);

  // Sync freshness first: everything else depends on it.
  if (ctx.lastSync) {
    const hrs = (ctx.now - new Date(ctx.lastSync)) / 3600000;
    if (hrs > 26) push({ key: 'stale:' + String(ctx.lastSync).slice(0, 10), kind: 'stale', severity: 'high', title: `Tally hasn't synced since ${dayStr(new Date(new Date(ctx.lastSync).getTime() + 5.5 * 3600000), true)}.`, detail: 'Is the Tally PC switched on with Tally and the Margyn agent running? Until it syncs, new sales, receipts and payments are missing here.', action: 'Switch on the Tally PC and open Tally.', ask: 'When did Tally last sync?' });
  }

  // Overdue money, split the way an accountant would: "slipping" (1-30 days past due, usually a reminder) is not
  // the same as "late" (over a month). Lumping them made ₹3.73 Cr look urgent when ₹1.92 Cr was days old.
  const recentPay = recentReceipts(ctx, 7);
  const late30 = recvBills.filter((b) => b.late > 30).reduce((s, b) => s + b.amount, 0);
  const slipping = recvBills.filter((b) => b.late > 0 && b.late <= 30).reduce((s, b) => s + b.amount, 0);
  const lateParties = lateRanking(recvBills, recentPay);
  if (late30 >= M) {
    // Who to call first: late but not hopeless. A bill over a year old is old debt (its own point), not a phone call.
    const first = lateParties.find((g) => !g.paidRecently && g.oldest.late <= 365) || lateParties.find((g) => g.oldest.late <= 365);
    push({ key: 'overdue_total', kind: 'overdue_total', severity: pctOf(late30, recvTotal) > 25 ? 'high' : 'medium', impact: late30,
      title: `${inr(late30)} of the ${inr(recvTotal)} customers owe you is more than a month late.`,
      detail: (slipping >= M ? `Another ${inr(slipping)} went past due in the last 30 days; a reminder usually does it. ` : '') +
        (lateParties.length ? 'Most late: ' + lateParties.slice(0, 3).map((g) => `${niceName(g.party)} ${inr(g.late30)}`).join(', ') + '.' : '') +
        (daily > 0 ? ` Every 10 days faster collection frees about ${inr(daily * 10)}.` : ''),
      action: first ? `Start with ${niceName(first.party)}: ${inr(first.late30)}, oldest bill ${first.oldest.late} days late.` : null,
      ask: 'Who owes me the most, and how late are they?' });
  } else if (slipping >= 2 * M) {
    push({ key: 'slipping_total', kind: 'slipping', severity: 'low', impact: slipping,
      title: `${inr(slipping)} went past due in the last 30 days.`, detail: 'Nothing is badly late yet. A reminder now keeps it that way.',
      action: null, ask: 'Who owes me the most, and how late are they?' });
  }
  const veryOld = recvParties.filter((g) => g.oldest > 365);
  const veryOldAmt = recvBills.filter((b) => b.late > 365).reduce((s, b) => s + b.amount, 0);
  if (veryOldAmt >= M / 2) push({ key: 'old_debts', kind: 'old_debts', severity: 'low', impact: veryOldAmt,
    title: `${inr(veryOldAmt)} has been unpaid for over a year.`,
    detail: veryOld.slice(0, 4).map((g) => `${niceName(g.party)} (${g.oldest} days)`).join(', ') + '. Bills this old are usually disputed, short-paid, or paid but never knocked off in Tally.',
    action: 'Decide for each with your CA: chase, settle the difference, or write it off.', ask: 'Which bills are more than a year old?' });

  // Customers more than a month late, ranked by money x how late (₹2.67 L at 212 days outranks ₹53 L at 11 days).
  // A customer who paid in the last week is not "chase them": what's left is usually a short payment.
  for (const g of lateParties.filter((x) => x.late30 >= M / 2 && x.oldest.late <= 365).slice(0, 3)) {
    const o = g.oldest, name = niceName(g.party);
    const billTxt = `bill ${o.ref ? o.ref + ' ' : ''}(${inr(o.amount)}${o.date ? ', ' + dayStr(o.date) : ''})`;
    if (g.paidRecently) {
      push({ key: 'short:' + norm(g.party) + ':' + norm(o.ref), kind: 'short_paid', party: g.party, severity: 'low', impact: g.late30,
        title: `${name} paid ${inr(g.paidRecently.amount)} on ${dayStr(g.paidRecently.dt)}, but ${billTxt} is still open, ${o.late} days late.`,
        detail: 'Usually a short payment, a deduction, or a receipt not set against the right bill in Tally.',
        action: `Ask your accountant to check ${o.ref ? 'bill ' + o.ref : 'that bill'} against their payment.`, ask: `Tell me about ${g.party}` });
    } else {
      push({ key: 'late:' + norm(g.party), kind: 'late', party: g.party, severity: g.late30 >= 10 * M || o.late > 90 ? 'high' : 'medium', impact: g.late30, score: g.score,
        title: `${name} owes ${inr(g.late30)} that's more than a month late; oldest is ${billTxt}, ${o.late} days.`,
        detail: (g.slipping > 0 ? `Plus ${inr(g.slipping)} that went past due recently. ` : '') + (() => { const c = (an.customers || []).find((x) => norm(x.party) === norm(g.party)); return c && c.dso_days != null ? `They usually take about ${Math.round(c.dso_days)} days to pay.` : ''; })(),
        action: `Call ${name} about ${o.ref ? 'bill ' + o.ref : 'the oldest bill'}.`, ask: `Tell me about ${g.party}` });
    }
  }

  // Regular customers who've gone quiet.
  const fy = resolvePeriod('this_fy', ctx.now);
  for (const g of byNet(ctx.rows.filter((r) => inPeriod(r, fy))).slice(0, 60)) {
    if (g.months.size < 3 || g.net < M || !g.last) continue;
    const days = [...g.days].sort();
    const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / DAY).sort((x, y) => x - y);
    const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const since = Math.round((ctx.today - g.last) / DAY);
    if (med == null || since < Math.max(45, 3 * med)) continue;
    push({ key: 'quiet:' + norm(g.party), kind: 'quiet', party: g.party, severity: g.net >= 10 * M ? 'high' : 'medium', impact: g.net,
      title: `${niceName(g.party)} hasn't ordered for ${since} days.`,
      detail: `They bought ${inr(g.net)} this year and usually order every ${Math.max(1, Math.round(med))} days. Last order ${dayStr(g.last)}.`,
      action: `Check in with ${niceName(g.party)}: lost order, price, or a problem?`, ask: `Tell me about ${g.party}` });
  }

  // Concentration.
  const ranked = byNet(ctx.rows.filter((r) => inPeriod(r, fy)));
  const totNet = ranked.reduce((s, g) => s + g.net, 0);
  if (ranked.length && totNet > 0) {
    const s1 = pctOf(ranked[0].net, totNet), s5 = pctOf(ranked.slice(0, 5).reduce((s, g) => s + g.net, 0), totNet);
    if (s1 >= 15 || s5 >= 50) {
      const owes = recvParties.find((g) => norm(g.party) === norm(ranked[0].party));
      push({ key: 'concentration', kind: 'concentration', party: ranked[0].party, severity: s1 >= 25 ? 'high' : 'low', impact: ranked[0].net,
        title: `${niceName(ranked[0].party)} is ${pctStr(s1)} of your sales this year${owes ? ' and owes you ' + inr(owes.total) : ''}.`,
        detail: `Your top 5 customers are ${pctStr(s5)} of sales. Losing or delaying one big buyer moves the whole business.`,
        action: null, ask: 'Who are my biggest customers?' });
    }
  }

  // How long customers take to pay. (This used to compare against "you pay suppliers in 5 days", worked out
  // from supplier bills Tally doesn't track bill by bill; that half was wrong, so it's gone.)
  if (wc.dso_days != null && wc.dso_days >= 45 && daily > 0) {
    const cd = cashAndDebt(ctx);
    push({ key: 'collection_days', kind: 'collection_days', severity: 'low', impact: daily * 10,
      title: `Customers take about ${Math.round(wc.dso_days)} days to pay you.`,
      detail: `Every 10 days faster frees about ${inr(daily * 10)}${cd.interest_paid_this_fy !== '₹0' ? `; you've paid ${cd.interest_paid_this_fy} interest this year` : ''}.`,
      action: 'Agree shorter credit with new orders, or a small discount for paying early.', ask: 'How much interest am I paying, and why?' });
  }

  // Commission and other big cost lines as a share of sales.
  const commission = new Map();
  let netFy = 0;
  for (const r of ctx.rows) {
    if (!inPeriod(r, fy)) continue;
    netFy += r.sales - r.returns;
    for (const l of r.lines) if (/commission|brokerage/i.test(l.ledger) && (l.bucket === 'opex' || l.bucket === 'direct_expense')) commission.set(r.mk, (commission.get(r.mk) || 0) - l.amount);
  }
  const commTot = [...commission.values()].reduce((a, b) => a + b, 0);
  if (netFy > 0 && pctOf(commTot, netFy) >= 2) push({ key: 'commission', kind: 'commission', severity: 'low', impact: commTot,
    title: `Commission is ${inr(commTot)} this year, ${pctStr(pctOf(commTot, netFy))} of sales.`,
    detail: 'It\'s one of your biggest costs after purchases. Each 1% of sales saved here is about ' + inr(netFy / 100) + ' a year so far.',
    action: null, ask: 'Show commission by month' });

  // Expense jumps in the last complete month.
  const pnl = (an.pnl || []).filter((m) => !m.provisional && !m.partial_start && !m.costs_incomplete);
  if (pnl.length >= 3) {
    const lastM = pnl[pnl.length - 1].month, prior = pnl.slice(-4, -1).map((m) => m.month);
    const per = new Map();
    for (const r of ctx.rows) {
      if (r.mk !== lastM && !prior.includes(r.mk)) continue;
      for (const l of r.lines) if (l.bucket === 'opex' || l.bucket === 'direct_expense') {
        const e = per.get(l.ledger) || {}; e[r.mk] = (e[r.mk] || 0) - l.amount; per.set(l.ledger, e);
      }
    }
    const jumps = [];
    for (const [ledger, e] of per) {
      const cur = e[lastM] || 0, avg = prior.reduce((s, m) => s + (e[m] || 0), 0) / prior.length;
      if (cur - avg >= M / 2 && (avg <= 0 || cur / avg >= 1.5)) jumps.push({ ledger, cur, avg });
    }
    jumps.sort((x, y) => (y.cur - y.avg) - (x.cur - x.avg));
    for (const j of jumps.slice(0, 2)) push({ key: 'expense:' + norm(j.ledger) + ':' + lastM, kind: 'expense_jump', severity: 'medium', impact: j.cur - j.avg,
      title: `${j.ledger} was ${inr(j.cur)} in ${monthLabel(lastM)}, against about ${inr(j.avg)} a month before.`,
      detail: 'A one-off, or something to look at?', action: null, ask: `Show ${j.ledger} entries in ${monthLabel(lastM)}` });
  }

  // Unfinished month.
  const unb = (an.pnl || []).filter((m) => m.costs_incomplete).slice(-1)[0];
  if (unb) push({ key: 'unbooked:' + unb.month, kind: 'unbooked', severity: 'medium', impact: num(unb.typical_opex) - num(unb.opex),
    title: `${monthLabel(unb.month)}'s running costs aren't fully in Tally yet.`,
    detail: `Booked so far ${inr(unb.opex)} against a usual ${inr(unb.typical_opex)}. Salaries and bills are probably still to be entered, so that month's profit looks better than it is.`,
    action: 'Ask your accountant to finish booking the month.', ask: `What did ${monthLabel(unb.month)} look like?` });

  // Sales against the usual month.
  const closedSales = (an.pnl || []).filter((m) => !m.provisional && !m.partial_start && m.net_sales > 0);
  if (closedSales.length >= 3) {
    const last = closedSales[closedSales.length - 1], before = closedSales.slice(0, -1);
    const avg = before.reduce((s, m) => s + m.net_sales, 0) / before.length;
    const ch = pctOf(last.net_sales - avg, avg);
    if (Math.abs(ch) >= 15) push({ key: 'sales_trend:' + last.month, kind: 'sales_trend', severity: ch < 0 ? 'medium' : 'low', impact: Math.abs(last.net_sales - avg),
      title: `${monthLabel(last.month)} sales were ${inr(last.net_sales)}, ${Math.abs(ch)}% ${ch < 0 ? 'below' : 'above'} your monthly average of ${inr(avg)}.`,
      detail: ch < 0 ? 'Which customers bought less is the first thing to check.' : 'Good month. Worth knowing which customers drove it.',
      action: null, ask: `Which customers bought ${ch < 0 ? 'less' : 'more'} in ${monthLabel(last.month)}?` });
  }

  // Products: below cost, likely unit mix-ups, free goods.
  const stats = productStats(ctx, fy);
  const below = stats.filter((s) => s.margin != null && s.margin < 0 && s.price != null && s.price >= 0.25 * s.cost);
  const belowLoss = below.reduce((t, s) => t - s.margin, 0);
  if (below.length && belowLoss >= M / 4) push({ key: 'below_cost', kind: 'below_cost', severity: belowLoss >= M ? 'medium' : 'low', impact: belowLoss,
    title: `${below.length} item${below.length === 1 ? '' : 's'} sold below cost this year, losing about ${inr(belowLoss)}.`,
    detail: below.sort((x, y) => x.margin - y.margin).slice(0, 3).map((s) => `${s.g.item} (sold ${inr(s.price)}, costs ${inr(s.cost)})`).join('; ') + '.',
    action: 'Check the price list for these.', ask: 'Which items am I selling below cost?' });
  const odd = stats.filter((s) => s.cost != null && s.price != null && s.price > 0 && s.price < 0.25 * s.cost && s.g.value >= 5000);
  for (const s of odd.slice(0, 2)) push({ key: 'unit:' + norm(s.g.item), kind: 'unit_mismatch', severity: 'low', impact: s.g.qty * s.cost - s.g.value,
    title: `${s.g.item} sells at ${inr(s.price)} but costs ${inr(s.cost)} a unit.`,
    detail: 'That gap is too big to be a discount. Usually the item is bought by the pack and sold by the piece (or the other way round) under one unit in Tally. If it\'s real, it\'s a loss.',
    action: 'Check the unit on this item in Tally.', ask: `Tell me about ${s.g.item}` });

  // GST due.
  const cur = isoDay(ctx.today).slice(0, 7);
  const lastGst = (an.gst_estimate || []).filter((g) => g.month < cur).slice(-1)[0];
  if (lastGst && num(lastGst.net_payable_estimate) >= M / 2) {
    const [y, m] = lastGst.month.split('-').map(Number);
    const due = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20));
    const left = Math.round((due - ctx.today) / DAY);
    if (left >= 0 && left <= 20) push({ key: 'gst:' + lastGst.month, kind: 'gst_due', severity: left <= 7 ? 'high' : 'medium', impact: num(lastGst.net_payable_estimate),
      title: `GST for ${monthLabel(lastGst.month)} looks like about ${inr(lastGst.net_payable_estimate)}, usually due ${dayStr(due)}.`,
      detail: 'Estimate from your Tally tax ledgers (output less input). Your CA\'s return is the real figure.',
      action: 'Keep the cash ready.', ask: 'How much GST do I owe?' });
  }

  // Money that just came in, and bills that just went overdue (Watch news).
  const recent = addDays(ctx.today, -3);
  for (const r of ctx.rows) {
    if (r.kind !== 'receipt' || r.dt < recent || r.total < 2 * M) continue;
    push({ key: 'receipt:' + (r.guid || r.day + ':' + norm(r.party) + ':' + Math.round(r.total)), kind: 'receipt', party: r.party, severity: 'low', impact: r.total,
      title: `${inr(r.total)} came in from ${r.party ? niceName(r.party) : 'a customer'} on ${dayStr(r.dt)}.`, detail: null, action: null, ask: r.party ? `What does ${r.party} still owe?` : null, news: true });
  }
  // Bills that went past due this week: one line per customer, not one per bill (three Alkem bills were three points).
  const fresh = new Map();
  for (const b of recvBills) {
    if (b.late < 1 || b.late > 7) continue;
    const k = norm(b.party), g = fresh.get(k) || { party: b.party, amount: 0, refs: [] };
    g.amount += b.amount; g.refs.push(b.ref); fresh.set(k, g);
  }
  for (const g of fresh.values()) {
    if (g.amount < 2 * M || recentPay.has(norm(g.party))) continue;
    const n = g.refs.length;
    push({ key: 'newdue:' + norm(g.party) + ':' + g.refs.map(norm).sort().join(','), kind: 'newly_overdue', party: g.party, severity: 'low', impact: g.amount,
      title: `${niceName(g.party)}: ${n === 1 ? 'a ' + inr(g.amount) + ' bill' : n + ' bills, ' + inr(g.amount) + ','} went past due this week.`,
      detail: null, action: 'A polite reminder now is easier than a chase later.', ask: `Tell me about ${g.party}`, news: true });
  }

  // Possible duplicates in the last 60 days.
  const seen = new Map();
  for (const r of ctx.rows) {
    if (r.dt < addDays(ctx.today, -60) || !['sales', 'purchase', 'payment'].includes(r.kind) || !r.party || r.total < M / 2) continue;
    const k = r.kind + '|' + norm(r.party) + '|' + r.day + '|' + Math.round(r.total);
    const prev = seen.get(k);
    if (prev && prev.number !== r.number) push({ key: 'dup:' + k, kind: 'duplicate', severity: 'low', impact: r.total,
      title: `Two ${r.kind === 'sales' ? 'invoices' : r.kind === 'purchase' ? 'purchase bills' : 'payments'} of ${inr(r.total)} to ${niceName(r.party)} on ${dayStr(r.dt)}${prev.number || r.number ? ' (' + [prev.number, r.number].filter(Boolean).join(' and ') + ')' : ''}.`,
      detail: 'Could be two genuine orders. Worth a ten-second check that it wasn\'t entered twice.', action: null, ask: `Show entries for ${r.party} on ${dayStr(r.dt)}` });
    else seen.set(k, r);
  }

  out.sort((x, y) => (SEV[y.severity] - SEV[x.severity]) || (y.impact - x.impact));
  return out.map((x) => Object.assign(x, { impact_text: x.impact ? inr(x.impact) : null }));
}

function attention(ctx, args) {
  const list = insights(ctx);
  const top = Math.max(1, Math.min(12, parseInt(args && args.top, 10) || 6));
  return {
    source: sourceLine(ctx),
    things_to_know: list.slice(0, top).map((x) => ({ what: x.title, why: x.detail || undefined, next: x.action || undefined, how_big: x.impact_text || undefined, priority: x.severity })),
    more: list.length > top ? list.length - top : 0,
    note: 'Worked out from the books in plain JS, biggest and most urgent first.'
  };
}

/* ---------------- extras for the Margin page ---------------- */

function kitsTable(ctx) {
  const fy = resolvePeriod('this_fy', ctx.now);
  const sold = new Map(productStats(ctx, fy).map((s) => [s.g.item, s]));
  return Object.values(ctx.assembled).map((k) => {
    const s = sold.get(k.item);
    const unit = k.qty > 0 ? k.value / k.qty : null;
    return {
      item: k.item, batches: k.batches, made_qty: Math.round(k.qty), cost_per_unit: unit != null ? Math.round(unit * 100) / 100 : null,
      parts: Object.keys(k.components).length,
      sold_qty: s ? Math.round(s.g.qty) : 0, sales: s ? Math.round(s.g.value) : 0,
      avg_price: s && s.price != null ? Math.round(s.price * 100) / 100 : null,
      margin_pct: s && s.marginPct != null ? s.marginPct : null
    };
  }).filter((k) => k.made_qty > 0).sort((x, y) => y.sales - x.sales).slice(0, 25);
}

function branchTable(ctx) {
  const fy = resolvePeriod('this_fy', ctx.now);
  const m = new Map();
  for (const r of ctx.rows) {
    // Credit notes usually carry no branch in their type name, so the split is on sales invoices.
    if (!inPeriod(r, fy) || r.kind !== 'sales') continue;
    const b = r.branch || 'Main';
    const g = m.get(b) || { branch: b, net_sales: 0, invoices: 0, customers: new Set(), months: {} };
    g.net_sales += r.sales - r.returns; if (r.kind === 'sales') g.invoices++;
    if (r.party) g.customers.add(norm(r.party));
    g.months[r.mk] = (g.months[r.mk] || 0) + r.sales - r.returns;
    m.set(b, g);
  }
  const tot = [...m.values()].reduce((s, g) => s + g.net_sales, 0);
  if (m.size < 2) return [];
  return [...m.values()].sort((x, y) => y.net_sales - x.net_sales).map((g) => ({
    branch: g.branch, net_sales: Math.round(g.net_sales), share_pct: pctOf(g.net_sales, tot), invoices: g.invoices, customers: g.customers.size,
    months: Object.entries(g.months).sort().map(([k, v]) => ({ month: k, net_sales: Math.round(v) }))
  }));
}

function concentration(ctx) {
  const fy = resolvePeriod('this_fy', ctx.now);
  const ranked = byNet(ctx.rows.filter((r) => inPeriod(r, fy)));
  const tot = ranked.reduce((s, g) => s + g.net, 0);
  if (!tot) return null;
  const share = (n) => pctOf(ranked.slice(0, n).reduce((s, g) => s + g.net, 0), tot);
  return { customers: ranked.length, top1: { party: ranked[0].party, share_pct: share(1) }, top5_pct: share(5), top10_pct: share(10) };
}

function quietCustomers(ctx) {
  return insights(ctx).filter((x) => x.kind === 'quiet').map((x) => ({ title: x.title, detail: x.detail }));
}

/** Everything the analytics endpoint adds to the Margin page. Never throws on missing pieces. */
function buildInsights(book, analytics, opts) {
  const ctx = prepare(book, Object.assign({}, opts || {}, { analytics }));
  const cd = cashAndDebt(ctx);
  return {
    // For the cash forecast's wording: a business on an overdraft has more headroom than its bank balance.
    funding: { overdraft: cd.notes.some((n) => /overdraft/.test(n)), total_borrowed: cd.total_borrowed, interest_this_fy: cd.interest_paid_this_fy },
    insights: insights(ctx).slice(0, 20),
    kits: kitsTable(ctx),
    branches: branchTable(ctx),
    concentration: concentration(ctx),
    receivables_ageing: ageing(billRows(ctx, 'receivable'))
  };
}

module.exports = {
  inr, pctStr, dayStr, resolvePeriod, PERIODS, MEASURES, GROUPS,
  prepare, summary, breakdown, findEntries, moneyOwed, partyProfile, products, cashAndDebt, insights, attention,
  buildInsights, kitsTable, branchTable, concentration, quietCustomers, matcher, branchOf, kindOf, niceName
};
