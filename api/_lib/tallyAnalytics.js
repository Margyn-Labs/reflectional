/**
 * Tally analytics — P&L, margin, customer economics, working capital, GST
 * estimate and data-quality checks, computed ONLY from what the Tally agent
 * already syncs (ledgers + vouchers + bills). No agent change needed.
 *
 * Pure: takes rows, returns one object. api/tally.js?action=analytics loads the
 * rows and calls computeAnalytics(); the app page, Margyn's context block and
 * the voice tools all read that one payload so they can never disagree.
 *
 * Everything here is provenance 'signal' (one ERP, no bank / GST corroboration
 * yet). Figures are labelled with how they were derived and how confident we
 * are; we never recompute Tally's own stock valuation.
 *
 * Sign conventions (see tallyClient.parseVouchers): voucher ledger entries are
 * negative = debit, positive = credit. Ledger closing balances arrive with an
 * uncertain sign, so balance-sheet figures use magnitudes.
 *
 * Stock lines (voucher.items) only exist once the agent is updated; every item
 * level output degrades to `items_available: false` until then.
 *
 * Lessons from building the connector (TALLY-CONNECTOR-HANDOFF.md) that shape
 * this file:
 *  - Real Tally returns an EMPTY closing balance for most balance-sheet ledgers
 *    (only P&L ledgers resolved), so stock and cash are never assumed present;
 *    cash is derived from vouchers when Tally gave no balance, stock is marked
 *    unavailable, and both are said out loud.
 *  - The Day Book also lists non-accounting vouchers (orders, delivery notes,
 *    memoranda, stock journals). Counting them would double-count sales.
 *  - The sign convention of ledger balances vs voucher amounts was never
 *    confirmed on a real credit balance. We infer it from the data and report
 *    how sure we are instead of assuming.
 *  - Names arrive with stray control characters and leading spaces; ledger
 *    matching ignores case, spacing and control characters.
 *  - Vouchers are never swept when deleted or edited in Tally (ledgers and bills
 *    are snapshots), so ledger tie-out is the drift detector.
 *  - Two active installs on one company would double every voucher: rows are
 *    de-duplicated on Tally's own GUID.
 *  - Phases 2 and 3 soft-fail in the agent, so the last sync outcome per kind is
 *    part of the confidence story.
 */

/* ---------------- classification ---------------- */

// Ledger names arrive with control characters / stray spaces and Tally treats
// names case-insensitively, so compare on this key.
const nameKey = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Tally's standard primary groups and their common spellings.
const PARENT_RULES = [
  [/^salesaccounts?$/, 'sales'],
  [/^purchaseaccounts?$/, 'purchases'],
  [/^(directexpenses?|expensesdirect|directexpensescr)$/, 'direct_expense'],
  [/^(indirectexpenses?|expensesindirect|indirectexpensescr)$/, 'opex'],
  [/^(directincomes?|incomedirect|directincomesdr)$/, 'direct_income'],
  [/^(indirectincomes?|incomeindirect)$/, 'other_income'],
  [/^dutiesandtaxes$|^dutiestaxes$|^dutiestax$/, 'tax'],
  [/^sundrydebtors?$/, 'debtor'],
  [/^sundrycreditors?$/, 'creditor'],
  [/^bank(occ|od)/, 'bank_od'],
  [/^bankaccounts?$|^bank$/, 'bank'],
  [/^cashinhand$/, 'cash'],
  [/^stockinhand$/, 'stock'],
  [/^(fixedassets?|investments?|loansliability|loansandadvancesasset|loansadvancesasset|currentassets?|currentliabilities|currentliability|capitalaccount|reservessurplus|reservesandsurplus|suspenseac|suspenseaccount|securedloans?|unsecuredloans?|depositsasset|provisions?|miscexpensesasset|branchdivisions|retainedearnings|primary)$/, 'balance_sheet']
];

const PL_BUCKETS = ['sales', 'purchases', 'direct_expense', 'direct_income', 'opex', 'other_income'];

function bucketFromParent(parent) {
  const n = norm(parent);
  if (!n) return null;
  for (const [re, b] of PARENT_RULES) if (re.test(n)) return b;
  return null;
}

// Fallback for custom sub-groups / odd names. Always flagged "guessed".
function guessBucket(name, parent) {
  const p = String(parent || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (/direct\s*exp|expenses?\s*\(?direct/.test(p)) return 'direct_expense';
  if (/direct\s*inc|income\s*\(?direct/.test(p)) return 'direct_income';
  if (/expense|overhead|admin|\bcosts?\b/.test(p)) return 'opex';
  if (/income|revenue/.test(p)) return 'other_income';
  if (/sales/.test(p)) return 'sales';
  if (/purchase/.test(p)) return 'purchases';
  if (/debtor/.test(p)) return 'debtor';
  if (/creditor/.test(p)) return 'creditor';
  if (/bank/.test(p)) return 'bank';
  if (/tax|duties|gst/.test(p)) return 'tax';
  if (/\b(cgst|sgst|igst|utgst|gst|tds|tcs)\b/.test(n)) return 'tax';
  if (/\bsales?\b|\brevenue\b/.test(n)) return 'sales';
  if (/\bpurchases?\b/.test(n)) return 'purchases';
  if (/freight|carriage|cartage|packing|wages|manufactur|job\s*work|loading|unloading/.test(n)) return 'direct_expense';
  if (/salary|salaries|rent|electricity|travel|telephone|interest|depreciation|insurance|printing|stationery|repair|audit|legal|professional|commission|advertis|marketing|bank\s*charges|office|conveyance|overhead|admin|expense/.test(n)) return 'opex';
  return null;
}

/**
 * ledgers: [{name,parent}], overrides: { ledgerName: bucket }.
 * Returns Map name -> { bucket, confidence: 'confirmed'|'group'|'guessed'|'unknown' }.
 */
function classifyLedgers(ledgers, overrides) {
  const out = new Map();
  const ov = {};
  for (const k of Object.keys(overrides || {})) ov[nameKey(k)] = overrides[k];
  for (const l of ledgers || []) {
    if (!l || !l.name) continue;
    const key = nameKey(l.name);
    let c;
    if (ov[key]) c = { bucket: ov[key], confidence: 'confirmed' };
    else {
      const direct = bucketFromParent(l.parent);
      if (direct) c = { bucket: direct, confidence: 'group' };
      else {
        const g = guessBucket(l.name, l.parent);
        c = g ? { bucket: g, confidence: 'guessed' } : { bucket: 'unknown', confidence: 'unknown' };
      }
    }
    out.set(key, c);
    out.set(l.name, c);
  }
  return out;
}

/* ---------------- small helpers ---------------- */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (k) => { const [y, m] = String(k).split('-'); return `${MON[(+m || 1) - 1]} ${y}`; };
const p1 = (n) => (Math.round(Number(n) * 10) / 10);
const pct = (a, b) => (b ? r2((a / b) * 100) : null);

function parseDate(d) {
  if (!d) return null;
  const s = String(d);
  const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t);
}
const monthKey = (dt) => dt.toISOString().slice(0, 7);
const DAY = 86400000;

// Day Book also lists vouchers with no accounting effect. Never count these.
const NON_ACCOUNTING = /\b(sales|purchase)\s*orders?\b|delivery\s*note|receipt\s*note|rejections?\s*(in|out)|memorandum|stock\s*journal|physical\s*stock|job\s*work|material\s*(in|out)|reversing\s*journal|manufacturing\s*journal|stock\s*transfer|payroll|attendance/i;
const isNonAccounting = (t) => NON_ACCOUNTING.test(t || '');
const isCreditNote = (t) => /credit\s*note/i.test(t || '');
const isDebitNote = (t) => /debit\s*note/i.test(t || '');
const isSalesType = (t) => /sales/i.test(t || '') && !isCreditNote(t);
const isPurchaseType = (t) => /purchase/i.test(t || '') && !isDebitNote(t);
const normParty = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------------- de-duplication ---------------- */

// Two active installs on one company (two PCs, a re-pair that wasn't revoked)
// carry the same Tally GUIDs. Keep one row per real record.
function dedupe(rows, keyOf, prefer) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const k = keyOf(r);
    if (k == null) { seen.set(Symbol('nokey'), r); continue; }
    const cur = seen.get(k);
    if (!cur || (prefer && prefer(r, cur))) seen.set(k, r);
  }
  return [...seen.values()];
}

/* ---------------- the engine ---------------- */

function computeAnalytics(input) {
  const ledgers = dedupe(input.ledgers || [], (l) => (l && l.name ? nameKey(l.name) : null),
    (a, b) => a.closing_balance != null && b.closing_balance == null);
  const allVouchers = dedupe(input.vouchers || [], (v) => (v && v.tally_guid ? 'g:' + v.tally_guid : null));
  const bills = dedupe(input.bills || [], (b) => (b ? (b.direction || '') + '|' + nameKey(b.party_name) + '|' + nameKey(b.bill_ref) : null));
  const syncRuns = input.syncRuns || [];
  const edition = input.edition || null;
  const overrides = input.overrides || {};
  const now = input.now ? new Date(input.now) : new Date();
  const creditRate = input.creditRate != null ? input.creditRate : 0.12;

  const classes = classifyLedgers(ledgers, overrides);
  const cls = (name) => classes.get(name) || classes.get(nameKey(name)) || { bucket: 'unknown', confidence: 'unknown' };
  const display = new Map();   // nameKey -> first spelling seen, for output
  const nonParty = new Set();  // ledgers that appear as something other than a voucher's party

  // ----- walk vouchers once -----
  const accounting = allVouchers.filter((v) => v && !isNonAccounting(v.voucher_type));
  const excludedTypes = {};
  allVouchers.forEach((v) => { if (v && isNonAccounting(v.voucher_type)) excludedTypes[v.voucher_type] = (excludedTypes[v.voucher_type] || 0) + 1; });
  const vouchers = accounting;
  const live = accounting.filter((v) => v.is_cancelled !== true);
  const cancelled = accounting.filter((v) => v.is_cancelled === true);

  const months = {};       // 'YYYY-MM' -> bucket sums (signed so +ve = good for profit? no: raw P&L amounts)
  const M = (k) => months[k] || (months[k] = {
    sales: 0, sales_returns: 0, purchases: 0, direct_expense: 0, direct_income: 0, opex: 0, other_income: 0,
    discounts: 0, freight: 0, tax_out: 0, tax_in: 0, tds_tcs: 0, vouchers: 0
  });
  const ledgerMove = new Map();              // ledger -> signed movement (tie-out)
  const ledgerActivity = new Map();          // ledger -> { n, abs }
  const customers = new Map();               // norm -> row
  const C = (name) => {
    const k = normParty(name) || '(no party)';
    if (!customers.has(k)) customers.set(k, { party: name || '(no party)', sales: 0, returns: 0, sales_90d: 0, cost: 0, cost_known: 0, vouchers: 0 });
    return customers.get(k);
  };
  let minD = null, maxD = null;
  const asOf = now;
  const cut90 = new Date(asOf.getTime() - 90 * DAY);
  const win = { sales: 0, purchases: 0, direct_expense: 0, direct_income: 0, returns: 0 };   // last 90d
  let salesNoParty = 0;

  const items = {};        // item -> agg
  const itemMonth = {};    // 'item|month' -> { sq, sv, pq, pv }
  let itemsAvailable = false;
  let salesVouchersTotal = 0, salesVouchersWithItems = 0;

  for (const v of live) {
    const dt = parseDate(v.date);
    if (!dt) continue;
    if (!minD || dt < minD) minD = dt;
    if (!maxD || dt > maxD) maxD = dt;
    const mk = monthKey(dt);
    const m = M(mk); m.vouchers++;
    const in90 = dt >= cut90;
    const entries = Array.isArray(v.entries) ? v.entries : [];
    const partyName = v.party_name || (entries.find((e) => e.is_party) || {}).ledger || null;
    let voucherSales = 0, voucherReturns = 0;

    for (const e of entries) {
      const a = num(e.amount);
      const lk = nameKey(e.ledger);
      if (!display.has(lk)) display.set(lk, e.ledger);
      if (!e.is_party) nonParty.add(lk);
      ledgerMove.set(lk, (ledgerMove.get(lk) || 0) + a);
      const act = ledgerActivity.get(lk) || { n: 0, abs: 0 };
      act.n++; act.abs += Math.abs(a); ledgerActivity.set(lk, act);
      const { bucket } = cls(e.ledger);
      const lname = String(e.ledger || '');
      switch (bucket) {
        case 'sales':
          if (a >= 0) { m.sales += a; voucherSales += a; if (in90) win.sales += a; }
          else { m.sales_returns += -a; voucherReturns += -a; if (in90) { win.returns += -a; } }
          break;
        case 'purchases': m.purchases += -a; if (in90) win.purchases += -a; break;
        case 'direct_expense': m.direct_expense += -a; if (in90) win.direct_expense += -a; break;
        case 'direct_income': m.direct_income += a; if (in90) win.direct_income += a; break;
        case 'opex': m.opex += -a; break;
        case 'other_income': m.other_income += a; break;
        case 'tax':
          if (/\b(tds|tcs)\b/i.test(lname)) m.tds_tcs += a;
          else if (/input/i.test(lname)) m.tax_in += -a;
          else if (/output/i.test(lname)) m.tax_out += a;
          else if (a >= 0) m.tax_out += a; else m.tax_in += -a;
          break;
        default: break;
      }
      if (PL_BUCKETS.includes(bucket)) {
        if (/discount/i.test(lname)) m.discounts += -a;
        if (/freight|carriage|cartage|transport|logistic|courier|delivery/i.test(lname) && (bucket === 'direct_expense' || bucket === 'opex' || bucket === 'purchases')) m.freight += -a;
      }
    }

    if (isSalesType(v.voucher_type) || isCreditNote(v.voucher_type)) {
      const c = C(partyName);
      if (!partyName) salesNoParty++;
      c.sales += voucherSales; c.returns += voucherReturns; c.vouchers++;
      if (in90) c.sales_90d += voucherSales - voucherReturns;
      if (isSalesType(v.voucher_type)) salesVouchersTotal++;
    }

    // ----- stock lines (only after the agent update) -----
    if (Array.isArray(v.items) && v.items.length) {
      itemsAvailable = true;
      const sign = isCreditNote(v.voucher_type) ? -1 : isDebitNote(v.voucher_type) ? -1 : 1;
      const isS = isSalesType(v.voucher_type) || isCreditNote(v.voucher_type);
      const isP = isPurchaseType(v.voucher_type) || isDebitNote(v.voucher_type);
      if (isSalesType(v.voucher_type)) salesVouchersWithItems++;
      if (isS || isP) {
        for (const it of v.items) {
          if (!it || !it.item) continue;
          const val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
          const qty = num(it.qty);
          const a = items[it.item] || (items[it.item] = { item: it.item, unit: it.unit || null, sold_qty: 0, sold_value: 0, purchased_qty: 0, purchased_value: 0 });
          const im = itemMonth[it.item + '|' + mk] || (itemMonth[it.item + '|' + mk] = { item: it.item, month: mk, sq: 0, sv: 0, pq: 0, pv: 0 });
          if (isS) { a.sold_qty += sign * qty; a.sold_value += sign * val; im.sq += sign * qty; im.sv += sign * val; }
          else { a.purchased_qty += sign * qty; a.purchased_value += sign * val; im.pq += sign * qty; im.pv += sign * val; }
        }
      }
    }
  }

  // ----- monthly P&L rows -----
  const monthKeys = Object.keys(months).sort();
  const currentMonth = monthKey(asOf);
  const pnl = monthKeys.map((k) => {
    const m = months[k];
    const net_sales = m.sales - m.sales_returns;
    const cogs_pre_stock = m.purchases + m.direct_expense;
    const gross_pre = net_sales + m.direct_income - cogs_pre_stock;
    const net_pre = gross_pre + m.other_income - m.opex;
    return {
      month: k,
      provisional: k >= currentMonth,
      gross_sales: r2(m.sales), sales_returns: r2(m.sales_returns), net_sales: r2(net_sales),
      purchases: r2(m.purchases), direct_expense: r2(m.direct_expense), direct_income: r2(m.direct_income),
      cogs_pre_stock: r2(cogs_pre_stock),
      gross_profit_pre_stock: r2(gross_pre), gross_margin_pct_pre_stock: pct(gross_pre, net_sales),
      opex: r2(m.opex), other_income: r2(m.other_income),
      net_profit_pre_stock: r2(net_pre), net_margin_pct_pre_stock: pct(net_pre, net_sales),
      vouchers: m.vouchers
    };
  });

  // ----- balance sign convention (inferred, never assumed silently) -----
  // Voucher amounts: negative = debit. Ledger balances: Tally's own flat value,
  // whose sign was never confirmed on a real credit balance. Compare a P&L
  // ledger's voucher movement with its opening->closing change to see which way
  // the data actually runs.
  let sameW = 0, oppW = 0, samples = 0;
  for (const l of ledgers) {
    if (!PL_BUCKETS.includes(cls(l.name).bucket)) continue;
    if (l.closing_balance == null) continue;
    const mv = ledgerMove.get(nameKey(l.name));
    if (mv == null || Math.abs(mv) < 1) continue;
    const delta = num(l.closing_balance) - num(l.opening_balance);
    if (Math.abs(Math.abs(delta) - Math.abs(mv)) > Math.max(1, 0.005 * Math.abs(mv))) continue;
    samples++;
    if (Math.sign(delta) === Math.sign(mv)) sameW += Math.abs(mv); else oppW += Math.abs(mv);
  }
  let signConv = 'unknown';
  if (samples >= 2 && sameW >= 0.8 * (sameW + oppW)) signConv = 'same';
  else if (samples >= 2 && oppW >= 0.8 * (sameW + oppW)) signConv = 'opposite';
  // Prior from the connector docs: balances carry debit as positive, vouchers debit as negative.
  const effConv = signConv === 'unknown' ? 'opposite' : signConv;
  const balance_sign = { convention: signConv, assumed: signConv === 'unknown', evidence_ledgers: samples };
  const debitPositive = (bal) => (effConv === 'same' ? -num(bal) : num(bal));

  // ----- stock adjustment (period level) -----
  const stockLedgers = ledgers.filter((l) => cls(l.name).bucket === 'stock');
  const stockWithBalance = stockLedgers.filter((l) => l.closing_balance != null);
  let stock = { available: false, reason: stockLedgers.length ? 'balance_not_returned' : 'no_stock_ledger' };
  if (stockWithBalance.length) {
    const closing = stockWithBalance.reduce((s, l) => s + Math.abs(num(l.closing_balance)), 0);
    const opening = stockWithBalance.reduce((s, l) => s + Math.abs(num(l.opening_balance)), 0);
    stock = {
      available: closing > 0 || opening > 0,
      opening: r2(opening), closing: r2(closing), change: r2(closing - opening),
      confidence: 'low',
      note: 'Stock-in-hand ledger as held in Tally. If stock is not auto-valued in Tally this can lag real stock; treat margin after stock adjustment as indicative.'
    };
    if (!stock.available) stock.reason = 'zero_balance';
  }

  // ----- cash: Tally's balance when it gave one, otherwise derived from vouchers -----
  const cashLedgers = ledgers.filter((l) => ['bank', 'cash'].includes(cls(l.name).bucket));
  // A derived balance needs a known opening balance. With neither a closing nor an
  // opening balance from Tally there is nothing honest to show, so cash is unavailable.
  let cashTotal = 0, cashDerived = 0, cashUnresolved = 0;
  for (const l of cashLedgers) {
    if (l.closing_balance != null) cashTotal += debitPositive(l.closing_balance);
    else if (l.opening_balance != null) {
      cashTotal += debitPositive(l.opening_balance) + (-(ledgerMove.get(nameKey(l.name)) || 0));
      cashDerived++;
    } else cashUnresolved++;
  }
  const cash = cashLedgers.length && !cashUnresolved ? { total: r2(cashTotal), ledgers: cashLedgers.length, derived_from_vouchers: cashDerived,
    note: cashDerived ? 'Tally returned no closing balance for ' + cashDerived + ' of these ledgers, so their balance is opening plus voucher movement.' : 'Closing balances as returned by Tally. Overdraft accounts excluded.' } : null;

  // How many balance-sheet ledgers came back with no balance at all (connector lesson).
  const BS = ['debtor', 'creditor', 'bank', 'bank_od', 'cash', 'stock', 'balance_sheet', 'tax'];
  const bsLedgers = ledgers.filter((l) => BS.includes(cls(l.name).bucket));
  const bsMissing = bsLedgers.filter((l) => l.closing_balance == null).length;

  const tot = pnl.reduce((a, r) => {
    a.net_sales += r.net_sales; a.gross_sales += r.gross_sales; a.returns += r.sales_returns;
    a.cogs += r.cogs_pre_stock; a.direct_income += r.direct_income; a.opex += r.opex; a.other_income += r.other_income;
    return a;
  }, { net_sales: 0, gross_sales: 0, returns: 0, cogs: 0, direct_income: 0, opex: 0, other_income: 0 });
  const gross_pre_total = tot.net_sales + tot.direct_income - tot.cogs;
  const stockAdj = stock.available ? stock.change : 0;
  const gross_adj_total = gross_pre_total + stockAdj;
  const period = {
    from: minD ? minD.toISOString().slice(0, 10) : null,
    to: maxD ? maxD.toISOString().slice(0, 10) : null,
    gross_sales: r2(tot.gross_sales), sales_returns: r2(tot.returns), net_sales: r2(tot.net_sales),
    cogs_pre_stock: r2(tot.cogs),
    gross_profit_pre_stock: r2(gross_pre_total), gross_margin_pct_pre_stock: pct(gross_pre_total, tot.net_sales),
    gross_profit_after_stock: stock.available ? r2(gross_adj_total) : null,
    gross_margin_pct_after_stock: stock.available ? pct(gross_adj_total, tot.net_sales) : null,
    opex: r2(tot.opex), other_income: r2(tot.other_income),
    net_profit_after_stock: stock.available ? r2(gross_adj_total + tot.other_income - tot.opex) : null,
    net_profit_pre_stock: r2(gross_pre_total + tot.other_income - tot.opex),
    net_margin_pct_after_stock: stock.available ? pct(gross_adj_total + tot.other_income - tot.opex, tot.net_sales) : null
  };

  // ----- cost structure (where the money goes) -----
  const expenseByLedger = new Map();
  for (const [lk, mv] of ledgerMove) {
    const name = display.get(lk) || lk;
    const b = cls(name).bucket;
    if (b === 'opex' || b === 'direct_expense' || b === 'purchases') {
      const cur = expenseByLedger.get(lk) || { ledger: name, bucket: b, amount: 0 };
      cur.amount += -mv; expenseByLedger.set(lk, cur);
    }
  }
  const cost_structure = [...expenseByLedger.values()]
    .map((x) => ({ ledger: x.ledger, bucket: x.bucket, amount: r2(x.amount), pct_of_net_sales: pct(x.amount, tot.net_sales) }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount).slice(0, 15);

  // ----- receivables / payables from bills -----
  let recv = 0, pay = 0, recvOverdue = 0;
  const recvBy = new Map();
  for (const b of bills) {
    const bal = Math.abs(num(b.closing_balance));
    if (b.direction === 'payable') { pay += bal; continue; }
    recv += bal;
    const od = num(b.overdue_days);
    if (od > 0) recvOverdue += bal;
    const k = normParty(b.party_name) || '(no party)';
    const r = recvBy.get(k) || { party: b.party_name, outstanding: 0, overdue: 0, max_overdue_days: 0, bills: 0 };
    r.outstanding += bal; r.bills++;
    if (od > 0) r.overdue += bal;
    if (od > r.max_overdue_days) r.max_overdue_days = od;
    recvBy.set(k, r);
  }

  // ----- working capital -----
  const sales90 = win.sales - win.returns;
  const cogs90 = win.purchases + win.direct_expense;
  const stockVal = stock.available ? stock.closing : null;
  const dso = sales90 > 0 ? r2((recv / sales90) * 90) : null;
  const dpo = win.purchases > 0 ? r2((pay / win.purchases) * 90) : null;
  const dio = stockVal != null && cogs90 > 0 ? r2((stockVal / cogs90) * 90) : null;
  const working_capital = {
    receivables: r2(recv), receivables_overdue: r2(recvOverdue), payables: r2(pay),
    stock_value: stockVal,
    cash: cash ? cash.total : null,
    dso_days: dso, dpo_days: dpo, dio_days: dio,
    cash_conversion_days: dso != null && dio != null && dpo != null ? r2(dso + dio - dpo) : null,
    window_days: 90,
    note: 'DSO/DPO/DIO use the last 90 days of vouchers.'
  };

  // ----- gross margin proxy for party rows -----
  const coGm = period.gross_margin_pct_pre_stock;
  const carryPctOfSales = (dsoDays) => (dsoDays == null ? null : r2((dsoDays / 365) * creditRate * 100));

  // item-level economics
  const itemRows = [];
  if (itemsAvailable) {
    for (const a of Object.values(items)) {
      const avg_price = a.sold_qty > 0 ? a.sold_value / a.sold_qty : null;
      const avg_cost = a.purchased_qty > 0 ? a.purchased_value / a.purchased_qty : null;
      const cogs = avg_cost != null ? a.sold_qty * avg_cost : null;
      const margin = cogs != null ? a.sold_value - cogs : null;
      const flags = [];
      if (a.sold_qty > 0 && avg_cost == null) flags.push('no_purchase_cost_in_period');
      if (avg_price != null && avg_cost != null && avg_price < avg_cost) flags.push('sold_below_cost');
      if (a.sold_qty > a.purchased_qty && avg_cost != null) flags.push('sold_more_than_bought_in_period');
      itemRows.push({
        item: a.item, unit: a.unit,
        sold_qty: r2(a.sold_qty), sold_value: r2(a.sold_value), avg_price: avg_price != null ? r2(avg_price) : null,
        purchased_qty: r2(a.purchased_qty), purchased_value: r2(a.purchased_value), avg_cost: avg_cost != null ? r2(avg_cost) : null,
        est_margin: margin != null ? r2(margin) : null, est_margin_pct: margin != null ? pct(margin, a.sold_value) : null,
        net_qty_movement: r2(a.purchased_qty - a.sold_qty), flags
      });
    }
    itemRows.sort((x, y) => y.sold_value - x.sold_value);
  }

  // margin bridge between the two latest complete months that have item sales
  let margin_bridge = null;
  if (itemsAvailable) {
    const mset = [...new Set(Object.values(itemMonth).map((x) => x.month))].filter((k) => k < currentMonth).sort();
    if (mset.length >= 2) {
      const m0 = mset[mset.length - 2], m1 = mset[mset.length - 1];
      const overallCost = {};
      for (const a of Object.values(items)) overallCost[a.item] = a.purchased_qty > 0 ? a.purchased_value / a.purchased_qty : null;
      const at = (item, mk) => itemMonth[item + '|' + mk] || { sq: 0, sv: 0, pq: 0, pv: 0 };
      let price = 0, cost = 0, volume = 0, m0tot = 0, m1tot = 0;
      for (const item of Object.keys(items)) {
        const a0 = at(item, m0), a1 = at(item, m1);
        if (a0.sq <= 0 && a1.sq <= 0) continue;
        const c0 = a0.pq > 0 ? a0.pv / a0.pq : overallCost[item];
        const c1 = a1.pq > 0 ? a1.pv / a1.pq : overallCost[item];
        if (c0 == null || c1 == null) continue;
        const p0 = a0.sq > 0 ? a0.sv / a0.sq : (a1.sq > 0 ? a1.sv / a1.sq : 0);
        const p1 = a1.sq > 0 ? a1.sv / a1.sq : p0;
        const q0 = a0.sq, q1 = a1.sq;
        price += q1 * (p1 - p0); cost += -q1 * (c1 - c0); volume += (q1 - q0) * (p0 - c0);
        m0tot += q0 * (p0 - c0); m1tot += q1 * (p1 - c1);
      }
      margin_bridge = { from_month: m0, to_month: m1, margin_from: r2(m0tot), margin_to: r2(m1tot), price_effect: r2(price), cost_effect: r2(cost), volume_mix_effect: r2(volume) };
    }
  }

  // customers table
  const customerRows = [];
  const keys = new Set([...customers.keys(), ...recvBy.keys()]);
  for (const k of keys) {
    const c = customers.get(k) || { party: (recvBy.get(k) || {}).party, sales: 0, returns: 0, sales_90d: 0, vouchers: 0 };
    const r = recvBy.get(k) || { outstanding: 0, overdue: 0, max_overdue_days: 0 };
    const net = c.sales - c.returns;
    const dsoP = c.sales_90d > 0 ? r2((r.outstanding / c.sales_90d) * 90) : null;
    const carry = carryPctOfSales(dsoP);
    const flags = [];
    if (r.outstanding > 0 && c.sales_90d <= 0) flags.push('owes_with_no_sales_in_90d');
    if (r.max_overdue_days > 90) flags.push('over_90_days');
    if (c.sales > 0 && c.returns / c.sales > 0.1) flags.push('high_returns');
    customerRows.push({
      party: c.party, gross_sales: r2(c.sales), returns: r2(c.returns), net_sales: r2(net),
      returns_pct: pct(c.returns, c.sales), sales_90d: r2(c.sales_90d),
      outstanding: r2(r.outstanding), overdue: r2(r.overdue), max_overdue_days: r.max_overdue_days,
      dso_days: dsoP, credit_cost_pct_of_sales: carry,
      margin_basis: 'company_average_pre_stock',
      est_margin_pct: coGm,
      est_margin_after_credit_pct: coGm != null && carry != null ? r2(coGm - carry) : null,
      flags
    });
  }
  customerRows.sort((a, b) => b.net_sales - a.net_sales);
  const customerTop = customerRows.slice(0, 50);
  const annualCarry = r2(recv * creditRate);

  // ----- leaks -----
  const sumMonths = (f) => pnl.reduce((s, r) => s + f(r), 0);
  const discounts = monthKeys.reduce((s, k) => s + months[k].discounts, 0);
  const freight = monthKeys.reduce((s, k) => s + months[k].freight, 0);
  const leaks = {
    returns: { value: r2(tot.returns), pct_of_gross_sales: pct(tot.returns, tot.gross_sales) },
    discounts_booked: { value: r2(discounts), pct_of_net_sales: pct(discounts, tot.net_sales) },
    freight_and_carriage: { value: r2(freight), pct_of_net_sales: pct(freight, tot.net_sales) },
    cancelled_vouchers: { count: cancelled.length, value: r2(cancelled.reduce((s, v) => s + Math.abs(num(v.amount)), 0)) },
    overdue_receivables: { value: r2(recvOverdue), pct_of_receivables: pct(recvOverdue, recv) },
    carrying_cost_of_receivables_annual: { value: annualCarry, rate_assumed: creditRate },
    items_sold_below_cost: itemRows.filter((i) => i.flags.includes('sold_below_cost')).map((i) => ({ item: i.item, avg_price: i.avg_price, avg_cost: i.avg_cost, sold_qty: i.sold_qty })).slice(0, 15),
    items_without_cost: itemRows.filter((i) => i.flags.includes('no_purchase_cost_in_period')).map((i) => ({ item: i.item, sold_value: i.sold_value })).slice(0, 15)
  };

  // ----- GST estimate from booked tax ledgers -----
  const gst = pnl.length ? monthKeys.map((k) => ({
    month: k, output_tax: r2(months[k].tax_out), input_tax: r2(months[k].tax_in), net_payable_estimate: r2(months[k].tax_out - months[k].tax_in), tds_tcs_net: r2(months[k].tds_tcs)
  })) : [];

  // ----- data quality + questions -----
  const questions = [];
  const unclassified = [];
  const guessed = [];
  for (const l of ledgers) {
    const c = cls(l.name);
    const act = ledgerActivity.get(nameKey(l.name));
    if (!act) continue;
    if (c.confidence === 'unknown') {
      unclassified.push({ ledger: l.name, parent: l.parent || null, vouchers: act.n, volume: r2(act.abs) });
    } else if (c.confidence === 'guessed') {
      guessed.push({ ledger: l.name, parent: l.parent || null, guessed_as: c.bucket, vouchers: act.n, volume: r2(act.abs) });
    }
  }
  const known = new Set(ledgers.map((l) => nameKey(l.name)));
  for (const [lk, act] of ledgerActivity) {
    if (!known.has(lk) && nonParty.has(lk)) unclassified.push({ ledger: display.get(lk) || lk, parent: null, vouchers: act.n, volume: r2(act.abs), not_in_ledger_list: true });
  }
  unclassified.sort((a, b) => b.volume - a.volume);
  guessed.sort((a, b) => b.volume - a.volume);
  for (const u of unclassified.slice(0, 10)) questions.push({ kind: 'classify_ledger', ledger: u.ledger, suggested: null, why: `Has ${u.vouchers} voucher lines (₹${Math.round(u.volume).toLocaleString('en-IN')}) but sits under “${u.parent || 'no group'}”, which I can't place in the P&L.` });
  for (const g of guessed.slice(0, 10)) questions.push({ kind: 'classify_ledger', ledger: g.ledger, suggested: g.guessed_as, why: `Group “${g.parent || 'none'}” is custom. I guessed ${g.guessed_as.replace('_', ' ')}. Confirm so the margin is right.` });
  if (!stock.available) questions.push({ kind: 'stock_missing', why: stock.reason === 'balance_not_returned' ? 'Tally sent the Stock-in-hand ledger but no balance for it (it often leaves balance-sheet ledgers empty), so gross margin is before stock movement. If you hold inventory, margin is overstated or understated by the change in stock.' : 'No stock balance is available, so gross margin is before stock movement. If you hold inventory, margin is overstated or understated by the change in stock.' });

  // tie-out: does the vouchers' movement on a P&L ledger match Tally's own opening→closing?
  const tie = [];
  for (const l of ledgers) {
    const b = cls(l.name).bucket;
    if (!PL_BUCKETS.includes(b)) continue;
    if (!ledgerMove.has(nameKey(l.name))) continue;
    if (l.closing_balance == null) continue;
    const mv = Math.abs(ledgerMove.get(nameKey(l.name)));
    const d1 = Math.abs(num(l.closing_balance) - num(l.opening_balance));
    const d2 = Math.abs(num(l.closing_balance) + num(l.opening_balance));
    const tol = Math.max(1, 0.005 * Math.max(mv, d1));
    tie.push({ ledger: l.name, vouchers_movement: r2(mv), tally_movement: r2(d1), ok: Math.abs(mv - d1) <= tol || Math.abs(mv - d2) <= tol });
  }
  tie.sort((a, b) => b.vouchers_movement - a.vouchers_movement);
  const tieTop = tie.slice(0, 12);
  const tieBad = tieTop.filter((t) => !t.ok);
  for (const t of tieBad.slice(0, 3)) questions.push({ kind: 'tie_out_mismatch', ledger: t.ledger, why: `Vouchers add up to ₹${Math.round(t.vouchers_movement).toLocaleString('en-IN')} on “${t.ledger}” but Tally's own balance moved ₹${Math.round(t.tally_movement).toLocaleString('en-IN')}. Some vouchers may be missing from the synced range. Vouchers deleted or edited in Tally are not removed from Margyn\'s copy, which is the usual cause.` });
  for (const i of itemRows.filter((x) => x.flags.includes('no_purchase_cost_in_period')).slice(0, 5)) questions.push({ kind: 'item_no_cost', item: i.item, why: `“${i.item}” sold ₹${Math.round(i.sold_value).toLocaleString('en-IN')} but has no purchase in the period, so its margin can't be computed.` });

  // last sync outcome per kind (agent phases 2 and 3 soft-fail, so this matters)
  const lastRun = {};
  for (const r of syncRuns) {
    if (!r || !r.kind || r.kind === 'pair') continue;
    const t = Date.parse(r.started_at || r.finished_at || '') || 0;
    if (!lastRun[r.kind] || t > lastRun[r.kind]._t) lastRun[r.kind] = { kind: r.kind, status: r.status, error: r.error_message || null, at: r.started_at || r.finished_at || null, received: r.rows_received != null ? r.rows_received : null, _t: t };
  }
  const syncHealth = Object.values(lastRun).map(({ _t, ...x }) => x);
  const failedKinds = syncHealth.filter((x) => x.status === 'error');

  const reasons = [];
  let level = 'medium';
  for (const f of failedKinds) reasons.push(`The last ${f.kind} sync from Tally failed${f.error ? ' (' + String(f.error).slice(0, 120) + ')' : ''}, so ${f.kind} may be behind.`);
  if (edition === 'educational') reasons.push('This Tally is in Educational mode, which limits voucher dates. Figures may not reflect a live business.');
  const excludedCount = Object.values(excludedTypes).reduce((a, b) => a + b, 0);
  if (balance_sign.assumed && ledgers.length) reasons.push('The sign convention of Tally balances could not be confirmed from your data, so cash and stock use the documented default.');
  if (bsLedgers.length && bsMissing) reasons.push(`Tally returned no balance for ${bsMissing} of ${bsLedgers.length} balance-sheet ledgers.`);
  if (!vouchers.length) { level = 'low'; reasons.push('No vouchers synced yet.'); }
  if (unclassified.length) reasons.push(`${unclassified.length} ledger(s) with activity are unclassified.`);
  if (guessed.length) reasons.push(`${guessed.length} ledger(s) classified by guess, not by Tally group.`);
  if (tieBad.length) reasons.push(`${tieBad.length} of ${tieTop.length} largest P&L ledgers don't tie to Tally's own balance.`);
  if (!stock.available) reasons.push('No stock balance: margin is before stock movement.');
  if (tieBad.length) reasons.push('Vouchers deleted or edited in Tally stay in Margyn until the agent is reset, which is the usual reason ledgers stop tying out.');
  if (!itemsAvailable) reasons.push('Stock lines not synced yet, so item-level margin is unavailable (agent update pending).');
  reasons.push('Single source (Tally). Not yet corroborated by bank or GST.');
  if (vouchers.length && !unclassified.length && !guessed.length && !tieBad.length && !failedKinds.length && stock.available && tie.length >= 3 && tieTop.every((t) => t.ok)) level = 'high-for-a-single-source';
  else if (unclassified.length > 3 || tieBad.length > 2 || !vouchers.length || failedKinds.some((f) => f.kind === 'vouchers')) level = 'low';

  const quality = {
    confidence: level,
    reasons,
    coverage: { from: period.from, to: period.to, vouchers: live.length, cancelled: cancelled.length, months: monthKeys.length },
    unclassified_ledgers: unclassified.slice(0, 20),
    guessed_ledgers: guessed.slice(0, 20),
    tie_out: tieTop,
    balance_sign,
    balance_sheet_balances: { missing: bsMissing, total: bsLedgers.length },
    excluded_non_accounting_vouchers: { count: excludedCount, by_type: excludedTypes },
    sync: syncHealth,
    sales_vouchers_without_party: salesNoParty,
    sales_vouchers_without_items: itemsAvailable ? Math.max(0, salesVouchersTotal - salesVouchersWithItems) : null,
    current_month_provisional: currentMonth
  };

  // ----- deterministic headlines (the model only narrates these) -----
  const headlines = [];
  const closed = pnl.filter((r) => !r.provisional && r.net_sales > 0);
  if (closed.length >= 2) {
    const a = closed[closed.length - 2], b = closed[closed.length - 1];
    if (a.gross_margin_pct_pre_stock != null && b.gross_margin_pct_pre_stock != null) {
      const d = p1(b.gross_margin_pct_pre_stock - a.gross_margin_pct_pre_stock);
      headlines.push(`Gross margin (before stock movement) was ${p1(b.gross_margin_pct_pre_stock)}% in ${monthLabel(b.month)}, ${d >= 0 ? 'up' : 'down'} ${Math.abs(d)} points from ${p1(a.gross_margin_pct_pre_stock)}% in ${monthLabel(a.month)}.`);
    }
    const sd = pct(b.net_sales - a.net_sales, a.net_sales);
    if (sd != null) headlines.push(`Net sales ${b.net_sales >= a.net_sales ? 'rose' : 'fell'} ${p1(Math.abs(sd))}% from ${monthLabel(a.month)} to ${monthLabel(b.month)}.`);
  }
  if (period.gross_margin_pct_after_stock != null) headlines.push(`Gross margin for the whole period, after stock movement, is ${p1(period.gross_margin_pct_after_stock)}% (indicative).`);
  if (leaks.returns.pct_of_gross_sales > 2) headlines.push(`Returns and credit notes are ${p1(leaks.returns.pct_of_gross_sales)}% of gross sales.`);
  if (dso != null) headlines.push(`Customers take about ${Math.round(dso)} days to pay on the last 90 days of sales. Carrying ₹${Math.round(recv).toLocaleString('en-IN')} owed to you at ${Math.round(creditRate * 100)}% costs about ₹${Math.round(annualCarry).toLocaleString('en-IN')} a year.`);
  if (margin_bridge) headlines.push(`Item margin moved ₹${Math.round(margin_bridge.margin_to - margin_bridge.margin_from).toLocaleString('en-IN')} from ${monthLabel(margin_bridge.from_month)} to ${monthLabel(margin_bridge.to_month)}: selling price ${Math.round(margin_bridge.price_effect).toLocaleString('en-IN')}, purchase cost ${Math.round(margin_bridge.cost_effect).toLocaleString('en-IN')}, volume and mix ${Math.round(margin_bridge.volume_mix_effect).toLocaleString('en-IN')}.`);
  if (leaks.items_sold_below_cost.length) headlines.push(`${leaks.items_sold_below_cost.length} item(s) sold below their average purchase cost.`);

  return {
    provenance: 'signal',
    basis: 'Tally ledgers, vouchers and bills. One source; not yet corroborated by bank or GST. Sales figures exclude GST.',
    as_of: asOf.toISOString(),
    items_available: itemsAvailable,
    period, pnl, stock, cash, cost_structure,
    working_capital, customers: customerTop,
    items: itemRows.slice(0, 100), margin_bridge,
    leaks, gst_estimate: gst, quality, questions, headlines,
    assumptions: { credit_rate_annual: creditRate, margin_window: 'period', dso_window_days: 90 }
  };
}

module.exports = { computeAnalytics, classifyLedgers, nameKey, dedupe, bucketFromParent, guessBucket, PL_BUCKETS };
