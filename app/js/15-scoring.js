/* ============================================================
   SCORING ENGINE — deterministic, hardcoded. AI narrates, never calculates.
   ============================================================ */
const BENCH = { runwayMin:3, runwayMax:6, recvBad:0.3, paySafe:0.5, gstBad:0.15, marginGood:15, marginOk:5, payCoverFull:1.5, payCoverNone:0.5, keepOfGross:0.3 };
/* ---- What the vitals measure against (2026-10-12) ----
   The first version measured everything against total monthly spend and the bank balance alone. That fits a
   business whose spend is all running cost. It misreads one that buys and sells goods: purchases come back as
   sales within weeks, so "6 months of total spend sitting in the bank" is not a meaningful target (₹14 Cr for
   Care Hygiene, a profitable distributor that scored 24). The optional `x` on each function carries what the
   books say about the shape of the business; without it every formula is exactly what it was.
     x.runningCosts  monthly running costs (rent, salaries, interest...), not cost of goods
     x.grossProfit   monthly gross profit (sales less cost of goods)
     x.odHeadroom    overdraft limit the owner entered, less what is drawn today
     x.odDrawn       overdraft drawn today (short-term borrowing, taken off working capital)
     x.recvTotal, x.recv90, x.revenue   the reading's own figures, for the payables cover */
function spendBasis(burn, x){ const rc = Number(x && x.runningCosts); return rc > 0 ? rc : burn; }
function scoreCash(cash, burn, x){
  // Months of running costs covered by money you can draw on today: the bank and cash, plus any undrawn
  // overdraft when the limit is known.
  const spend = spendBasis(burn, x), od = Math.max(0, Number(x && x.odHeadroom) || 0);
  const months = spend > 0 ? (cash + od) / spend : 0;
  let score;
  if(months >= BENCH.runwayMax) score = 100;
  else if(months <= 0) score = 0;
  else score = clamp((months / BENCH.runwayMax) * 100);
  return { value: months.toFixed(1) + ' months', score };
}
function scoreReceivables(recvTotal, recv90){
  const ratio = recvTotal > 0 ? recv90 / recvTotal : 0;
  const score = clamp(100 - (ratio / BENCH.recvBad) * 100);
  return { value: inr(recv90) + ' over 90d', score };
}
function payablesCover(paySoon, cash, x){
  // Money on hand in the next 30 days against bills due in them: the bank and cash, undrawn overdraft, and
  // collections, taken as what customers owe that isn't over 90 days late, capped at one month of sales.
  const fresh = Math.max(0, (Number(x.recvTotal) || 0) - (Number(x.recv90) || 0));
  const collect = Math.min(fresh, Math.max(0, Number(x.revenue) || 0));
  const avail = Math.max(0, cash) + Math.max(0, Number(x.odHeadroom) || 0) + collect;
  return { avail, collect, cover: paySoon > 0 ? avail / paySoon : null };
}
function scorePayables(paySoon, cash, x){
  if(x && x.recvTotal != null){
    const c = payablesCover(paySoon, cash, x);
    const score = c.cover === null ? 100 : clamp(((c.cover - BENCH.payCoverNone) / (BENCH.payCoverFull - BENCH.payCoverNone)) * 100);
    return { value: inr(paySoon), score };
  }
  const ratio = cash > 0 ? paySoon / cash : (paySoon > 0 ? 1 : 0);
  const score = clamp(100 - (ratio / BENCH.paySafe) * 100);
  return { value: inr(paySoon), score };
}
function scoreGst(gstLeak, gstPayable){
  const ratio = gstPayable > 0 ? gstLeak / gstPayable : (gstLeak > 0 ? 1 : 0);
  const score = clamp(100 - (ratio / BENCH.gstBad) * 100);
  return { value: inr(gstLeak), score };
}
/* The net margin that scores 100: 15%, or 30% of the gross margin when the gross margin can't carry 15%
   (a distributor on a 21% gross margin is doing well at 6% net; nobody in that trade nets 15%). */
function marginTarget(revenue, x){
  const gp = Number(x && x.grossProfit);
  if(!(gp > 0) || !(revenue > 0)) return BENCH.marginGood;
  return Math.max(1, Math.min(BENCH.marginGood, (gp / revenue) * 100 * BENCH.keepOfGross));
}
function scoreMargin(netProfit, revenue, x){
  const pct = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const good = marginTarget(revenue, x);
  let score;
  if(pct >= good) score = 100;
  else if(pct <= 0) score = clamp(50 + pct);
  else score = clamp((pct / good) * 100);
  return { value: pct.toFixed(1) + '%', score };
}
function scoreRunway(cash, recvTotal, paySoon, burn, x){
  // Working capital (cash + owed to you − bills due in 30 days − overdraft drawn) in months of running costs.
  const spend = spendBasis(burn, x);
  const wc = cash + recvTotal - paySoon - Math.max(0, Number(x && x.odDrawn) || 0);
  const months = spend > 0 ? wc / spend : 0;
  let score;
  if(months >= BENCH.runwayMax) score = 100;
  else if(months <= 0) score = 0;
  else score = clamp((months / BENCH.runwayMax) * 100);
  return { value: months.toFixed(1) + ' months', score };
}
function computeVitals({ cash, revenue, netProfit, burn, gstLeak, gstPayable, recvTotal, recv90, paySoon, scoringBasis }){
  // `basis` is saved on the reading's vitals so the same reading can be re-scored and explained later.
  const basis = Object.assign({ v:2 }, scoringBasis || {});
  const x = Object.assign({ recvTotal, recv90, revenue }, basis);
  const cashV = scoreCash(cash, burn, x);
  const recvV = scoreReceivables(recvTotal, recv90);
  const payV = scorePayables(paySoon, cash, x);
  const gstV = scoreGst(gstLeak, gstPayable);
  const marginV = scoreMargin(netProfit, revenue, x);
  const runwayV = scoreRunway(cash, recvTotal, paySoon, burn, x);
  return [
    { label:'Cash Position', value: cashV.value, score: cashV.score, basis },
    { label:'Receivables Aging', value: recvV.value, score: recvV.score },
    { label:'Payables Due (30d)', value: payV.value, score: payV.score },
    { label:'GST/ITC Leakage', value: gstV.value, score: gstV.score },
    { label:'Net Margin', value: marginV.value, score: marginV.score },
    { label:'Working Capital Runway', value: runwayV.value, score: runwayV.score }
  ];
}
/* The basis a saved reading was scored on, with the reading's own figures the payables cover needs.
   Undefined for readings saved before 2026-10-12: they keep the formulas they were scored with. */
function vitalBasisOf(s){
  const v = s && Array.isArray(s.vitals) ? s.vitals.find(z => z && z.basis && z.basis.v >= 2) : null;
  return v ? Object.assign({ recvTotal:Number(s.recv_total) || 0, recv90:Number(s.recv_90) || 0, revenue:Number(s.revenue) || 0 }, v.basis) : undefined;
}
/* What the connected books say about the shape of the business, for the reading being saved now. */
function scoringBasisLive(){
  const out = {};
  const put = (k, v) => { const n = Number(v); if(isFinite(n) && n > 0) out[k] = Math.round(n); };
  const mar = typeof mgMar !== 'undefined' && mgMar && !(typeof mgMarCompany !== 'undefined' && mgMarCompany) ? mgMar : null;
  const pnl = ((mar && mar.pnl) || []).filter(r => !r.provisional && !r.partial_start && Number(r.net_sales) > 0).slice(-6);
  if(pnl.length){
    // The same months revenue, spend and profit are averaged over (tallyInputCandidates).
    const whole = pnl.filter(r => !r.costs_incomplete), use = whole.length ? whole : pnl;
    const avg = f => use.reduce((t, r) => t + (Number(f(r)) || 0), 0) / use.length;
    put('runningCosts', avg(r => r.opex));
    put('grossProfit', avg(r => r.gross_profit_pre_stock != null ? r.gross_profit_pre_stock : (Number(r.net_sales) || 0) - (Number(r.cogs_pre_stock) || 0)));
    const od = (((mar.borrowing || {}).accounts) || []).filter(a => a && a.kind === 'overdraft');
    put('odDrawn', od.reduce((t, a) => t + Math.max(0, Number(a.owed_today) || 0), 0));
    const limits = typeof mgBorrowLimits === 'function' ? mgBorrowLimits() : {};
    put('odHeadroom', od.reduce((t, a) => { const lim = Number(limits[a.name]); return t + (lim > 0 ? Math.max(0, lim - Math.max(0, Number(a.owed_today) || 0)) : 0); }, 0));
  } else if(typeof zohoConnected !== 'undefined' && zohoConnected && typeof zohoVitals !== 'undefined' && zohoVitals && zohoVitals.net_margin){
    const m = zohoVitals.net_margin;
    put('runningCosts', m.opex);
    if(isFinite(Number(m.income)) && isFinite(Number(m.cogs))) put('grossProfit', Number(m.income) - Number(m.cogs));
  }
  return out;
}
function basisDiffers(a, b){
  if(!b) return true;
  return ['runningCosts', 'grossProfit', 'odHeadroom', 'odDrawn'].some(k => {
    const p = Number(b[k]) || 0, n = Number(a[k]) || 0, scale = Math.max(Math.abs(p), Math.abs(n), 1);
    return Math.abs(n - p) > scale * 0.005;
  });
}
const VITAL_WEIGHTS = { 'Cash Position':0.20, 'Receivables Aging':0.15, 'Payables Due (30d)':0.15, 'GST/ITC Leakage':0.15, 'Net Margin':0.20, 'Working Capital Runway':0.15 };
/* A vital's weight among the vitals actually measured. With all six present this is VITAL_WEIGHTS as written.
   When one is left out because nothing measures it (GST input credit with no GST data: see gstNotMeasured),
   the others share its weight in proportion, so an unmeasured vital neither helps nor hurts the score. */
function vitalWeight(label, vitals){
  const w = VITAL_WEIGHTS[label] || 0;
  const tot = (Array.isArray(vitals) ? vitals : []).reduce((s, v) => s + (VITAL_WEIGHTS[v.label] || 0), 0);
  return tot > 0 && tot < 0.999 ? w / tot : w;
}
function computePulseScore(vitals){
  return Math.round(vitals.reduce((s,v) => s + (v.score * vitalWeight(v.label, vitals)), 0));
}
/* GST input credit at risk needs GSTR-2B matching, which only a connected source supplies. On a reading built
   from connected sources where none of them reports it and nobody typed a figure, the old score was 100 of 100
   for "no leakage" (Care Hygiene, 12 Oct 2026: +15 points of a 35 Pulse from data Margyn doesn't have).
   Hand-entered readings are left as they are: the person typed that figure. */
function gstNotMeasured(inputs, provenance){
  if(!provenance) return false;
  const p = provenance.gst_leak || provenance.gstLeak;
  return !(Number(inputs && inputs.gstLeak) > 0) && (!p || !p.tier || p.tier === 'self');
}
const GST_VITAL = 'GST/ITC Leakage';

/* ============================================================
   SOURCE RESOLUTION — which number actually feeds the Pulse Score.

   The old rule was "only self-entered figures move the score", which meant a
   number typed into a form outranked the same number pulled straight out of
   the customer's TallyPrime or Zoho Books. That inverts the whole premise of
   the connectors, so the rule is now:

       verified (2+ sources agree)  >  connector (one source)  >  self-reported

   Tiering governs how confident Margyn SAYS it is, not whether a figure is
   allowed to count. The vitals arithmetic in computeVitals() is untouched —
   this only decides which nine numbers go into it.

   Disagreements are never averaged. When two sources differ by more than
   CONFLICT_TOLERANCE the higher-tier one is used and the disagreement is
   recorded on the snapshot for the Books conflict view and the AI context.
   ============================================================ */
const SOURCE_TIER = { verified:'verified', connector:'connector', self:'self' };
const TIER_RANK  = { verified:3, connector:2, self:1 };
const TIER_CONFIDENCE = { verified:1.0, connector:0.75, self:0.5 };
const CONFLICT_TOLERANCE = 0.02;  // 2%, same tolerance crossLedgerGroups() uses

/* Which snapshot inputs each vital reads. A vital is only as trustworthy as
   its weakest input, so this drives the per-vital confidence badge. */
const VITAL_INPUTS = {
  'Cash Position':            ['cash', 'burn'],
  'Receivables Aging':        ['recvTotal', 'recv90'],
  'Payables Due (30d)':       ['paySoon', 'cash'],
  'GST/ITC Leakage':          ['gstLeak', 'gstPayable'],
  'Net Margin':               ['netProfit', 'revenue'],
  'Working Capital Runway':   ['cash', 'recvTotal', 'paySoon', 'burn']
};
const SNAPSHOT_INPUT_FIELDS = ['cash','revenue','netProfit','burn','gstLeak','gstPayable','recvTotal','recv90','paySoon'];
/* snapshot column name per input key, for reading the previous row back */
const INPUT_COLUMN = {
  cash:'cash', revenue:'revenue', netProfit:'net_profit', burn:'burn', gstLeak:'gst_leak',
  gstPayable:'gst_payable', recvTotal:'recv_total', recv90:'recv_90', paySoon:'pay_soon'
};

/* ---------- what each connector can honestly supply ---------- */
function zohoInputCandidates(){
  if(!zohoConnected || !zohoVitals) return {};
  const v = zohoVitals;
  const r = v.receivables || {}, p = v.payables || {}, g = v.gst_leakage || {};
  const m = v.net_margin || {}, w = v.working_capital_runway || {}, c = v.cash_position || {};
  const out = {};
  const put = (k, val) => { const n = Number(val); if(isFinite(n)) out[k] = n; };

  // Cash only when Zoho actually has bank data — on plans without it the
  // field comes back as a placeholder, not a balance.
  if(c.bank_data_available !== false) put('cash', c.zoho_reported_balance);
  put('recvTotal', r.total);
  put('recv90', r.days_90_plus);
  // payables_due_30d is the 30-day window the Payables Due vital wants;
  // payables.total is all ages and would overstate it.
  put('paySoon', w.payables_due_30d);
  put('gstLeak', g.total_leakage);
  put('revenue', m.income);
  if(isFinite(Number(m.cogs)) || isFinite(Number(m.opex))){
    const burn = (Number(m.cogs) || 0) + (Number(m.opex) || 0);
    if(burn > 0) put('burn', burn);
    if(isFinite(Number(m.income))) put('netProfit', Number(m.income) - burn);
  }
  // gst_payable is deliberately absent: Zoho reports leakage_pct against
  // claimed ITC, not against GST payable, so deriving the denominator from it
  // would be a guess. It stays self-reported until the GSTN channel lands.
  return out;
}

/* Tally's bank and cash-in-hand ledgers, summed into one liquidity figure.

   The sign convention is the hard part: different TallyPrime exports return a
   debit bank balance as positive in one setup and negative in another, so a
   naive sum can come out inverted. Rather than assume, take the dominant sign
   across the liquidity ledgers as "money you have" and treat the minority
   sign as overdrawn — most businesses have more accounts in credit than
   overdrawn, so this self-calibrates to whichever convention the export uses.

   Overdraft and cash-credit groups are excluded outright: an OD balance is
   borrowed money, not cash, and counting it would inflate both Cash Position
   and Working Capital Runway. This is an interim signal until the Account
   Aggregator bank feed replaces it. */
const TALLY_LIQUID_GROUP = /(bank account|cash-?in-?hand|cash in hand)/i;
const TALLY_BORROW_GROUP = /(\bo\/?d\b|overdraft|occ|cash credit|loan)/i;
// A sweep account parks idle current-account money in a deposit that the bank pulls
// back automatically, so it is cash even though Tally files it under Deposits (Asset).
const TALLY_SWEEP = (x) => /sweep/i.test(String(x.name || '')) && /deposit/i.test(String(x.parent || ''));
function tallyCashBalance(){
  const t = tallyLiquidLedgers();
  if(!t.liquid.length) return null;
  const total = t.liquid.reduce((sum, x) => sum + x.balance, 0);
  return { total, count: t.liquid.length, inverted: t.inverted };
}
/* The ledgers behind tallyCashBalance(), one by one, with the same sign
   correction, plus borrowing ledgers (OD / cash credit / loans), which are
   never cash. The Cash page lists these, so it can't disagree with the score. */
function tallyLiquidLedgers(){
  const items = (tallyData && tallyData.ledgers && tallyData.ledgers.items) || [];
  const liquid = items.filter(x =>
    x.closing_balance != null &&
    (TALLY_LIQUID_GROUP.test(String(x.parent || '')) || TALLY_SWEEP(x)) &&
    !TALLY_BORROW_GROUP.test(String(x.parent || '')) &&
    !TALLY_BORROW_GROUP.test(String(x.name || ''))
  );
  let pos = 0, neg = 0;
  liquid.forEach(x => { const n = Number(x.closing_balance) || 0; if(n > 0) pos++; else if(n < 0) neg++; });
  // whichever sign most liquidity ledgers carry is the "in credit" direction
  const sign = neg > pos ? -1 : 1;
  const borrow = items.filter(x =>
    x.closing_balance != null && !/asset/i.test(String(x.parent || '')) &&
    (TALLY_BORROW_GROUP.test(String(x.parent || '')) || (TALLY_LIQUID_GROUP.test(String(x.parent || '')) && TALLY_BORROW_GROUP.test(String(x.name || ''))))
  );
  return {
    liquid: liquid.map(x => ({ name: x.name, parent: x.parent, balance: (Number(x.closing_balance) || 0) * sign })),
    // shown as an amount owed: positive = owed to the bank
    borrow: borrow.map(x => ({ name: x.name, parent: x.parent, balance: Math.abs(Number(x.closing_balance) || 0) })),
    inverted: sign === -1
  };
}

function tallyInputCandidates(){
  if(!tallyData || !tallyData.connected) return {};
  const b = tallyData.bills || {}, v = tallyData.vouchers || {};
  const out = {};
  const put = (k, val) => { const n = Number(val); if(isFinite(n)) out[k] = n; };
  const cash = tallyCashBalance();
  if(cash && cash.total > 0) put('cash', cash.total);
  put('recvTotal', b.receivable_total);
  // 90+ has to be derived — Tally gives per-bill overdue_days, not buckets.
  // Server-side totals cover every bill; b.items is only the first 100 rows.
  if(b.receivable_over_90 != null){
    put('recv90', b.receivable_over_90);
    put('paySoon', b.payable_due_30d);
  } else if(Array.isArray(b.items)){
    const over90 = b.items
      .filter(x => x.direction === 'receivable' && Number(x.overdue_days) > 90)
      .reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    put('recv90', over90);
    const soon = b.items
      .filter(x => x.direction === 'payable' && (x.due_date == null || daysFromToday(x.due_date) <= 30))
      .reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    put('paySoon', soon);
  } else {
    put('paySoon', b.payable_total);
  }
  // Suppliers Tally doesn't keep bill by bill: its bill list is a few stray bills (₹25 L at Care Hygiene against
  // ₹1.6 Cr owed), so Payables due, runway and days payable were built on them. The server position rebuilds each
  // supplier's bills from the entries (moneyModel.js); use what it says is due within 30 days, overdue included.
  try {
    const P = typeof mgPos !== 'undefined' && mgPos && mgPos.payables;
    if(P && P.coverage && P.coverage.tally && P.coverage.tally.basis === 'supplier_ledgers'){
      const soon = P.groups.filter(g => g.primary === 'tally').reduce((t, g) => t + ((g.by.tally && g.by.tally.rows) || []).filter(r => r.days === null || r.days <= 30).reduce((a, r) => a + (Number(r.amount) || 0), 0), 0);
      put('paySoon', soon);
    }
  } catch(e){ /* keep the bill figures */ }
  // Customers: when their bills were lined up with ledger balances (moneyModel / billTieOut.js), receivables and
  // the 90+ share come from that same list.
  try {
    const R = typeof mgPos !== 'undefined' && mgPos && mgPos.receivables;
    if(R && R.coverage && R.coverage.tally && R.coverage.tally.basis === 'bills_tied_to_ledgers'){
      const rows = R.groups.filter(g => g.primary === 'tally').flatMap(g => (g.by.tally && g.by.tally.rows) || []);
      put('recvTotal', rows.reduce((a, r) => a + (Number(r.amount) || 0), 0));
      put('recv90', rows.filter(r => r.days !== null && r.days < -90).reduce((a, r) => a + (Number(r.amount) || 0), 0));
    }
  } catch(e){ /* keep the bill figures */ }
  put('revenue', v.sales_30d);
  // Revenue, burn and profit from Tally's own monthly P&L, averaged over up to six
  // closed months: the latest month is often missing late-booked expenses (salaries, rent).
  // Without this, burn and profit stayed frozen at whatever the first snapshot saw.
  const pnl = ((typeof mgMar !== 'undefined' && mgMar && mgMar.pnl) || [])
    .filter(r => !r.provisional && !r.partial_start && Number(r.net_sales) > 0).slice(-6);
  // Leave out months whose running costs aren't booked yet (analytics flags them).
  const whole = pnl.filter(r => !r.costs_incomplete);
  const use = whole.length ? whole : pnl;
  if(pnl.length){
    const avg = (f) => use.reduce((sum, r) => sum + (Number(f(r)) || 0), 0) / use.length;
    put('revenue', avg(r => r.net_sales));
    const burn = avg(r => (Number(r.cogs_pre_stock) || 0) + (Number(r.opex) || 0));
    if(burn > 0) put('burn', burn);
    put('netProfit', avg(r => r.net_profit_pre_stock));
    // GST due this month is last month's output tax less input credit, from Tally's duty
    // ledgers. An estimate until the GSTN channel lands; never below zero (a credit carries).
    const last = pnl[pnl.length - 1].month;
    const g = ((mgMar && mgMar.gst_estimate) || []).find(x => x.month === last);
    if(g && isFinite(Number(g.net_payable_estimate))) put('gstPayable', Math.max(0, Number(g.net_payable_estimate)));
  }
  return out;
}

function odooInputCandidates(){
  if(typeof odooConnected === 'undefined' || !odooConnected || !odooStatus) return {};
  const rec = odooStatus.receivables || {}, pay = odooStatus.payables || {};
  const out = {};
  const put = (k, val) => { const n = Number(val); if(isFinite(n)) out[k] = n; };
  put('recvTotal', rec.total != null ? rec.total : rec.amount);
  put('paySoon', pay.total != null ? pay.total : pay.amount);
  // Aggregate balance of Odoo's liquidity accounts, computed server-side in
  // api/_odoo/odoo.js. Absent on a connection that hasn't re-synced since the
  // cash aggregation shipped, so guard on bank_data_available.
  const c = odooStatus.cash_position || {};
  if(c.bank_data_available !== false && Number(c.balance) > 0) put('cash', c.balance);
  return out;
}

/* Self-reported baseline: the latest snapshot's own figures, with the quick
   ledger's live aggregates overriding receivables/payables (that is what
   saveLedgerSnapshot already did, kept so manual entry still works exactly as
   before when nothing is connected). */
function selfInputCandidates(){
  const latest = snapshots[0];
  if(!latest) return {};
  const { recvTotal, recv90, paySoon } = ledgerAggregates();
  const hasLedgerRows = receivables.length > 0 || payables.length > 0;
  return {
    cash: Number(latest.cash) || 0,
    revenue: Number(latest.revenue) || 0,
    netProfit: Number(latest.net_profit) || 0,
    burn: Number(latest.burn) || 0,
    gstLeak: Number(latest.gst_leak) || 0,
    gstPayable: Number(latest.gst_payable) || 0,
    recvTotal: hasLedgerRows ? recvTotal : (Number(latest.recv_total) || 0),
    recv90:    hasLedgerRows ? recv90    : (Number(latest.recv_90) || 0),
    paySoon:   hasLedgerRows ? paySoon   : (Number(latest.pay_soon) || 0)
  };
}

/* Resolve one field across everything that offered a value for it. */
function resolveField(field, offers){
  // offers: [{ source, value, tier }] — connector offers first, self last
  const connectorOffers = offers.filter(o => o.tier === 'connector');
  const selfOffer = offers.find(o => o.tier === 'self');

  if(!connectorOffers.length){
    return selfOffer
      ? { value: selfOffer.value, source: selfOffer.source, tier: 'self', conflict: null }
      : null;
  }

  // Two or more connectors that agree within tolerance = Verified.
  let chosen = connectorOffers[0], tier = 'connector', agree = null, conflict = null;
  if(connectorOffers.length > 1){
    const vals = connectorOffers.map(o => o.value);
    const max = Math.max.apply(null, vals.map(Math.abs));
    const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
    if(spread <= Math.max(1, max * CONFLICT_TOLERANCE)){
      tier = 'verified';
      agree = connectorOffers.map(o => o.source);
    } else {
      // Flagged, never averaged. CONNECTOR_PRIORITY decides which one is used.
      const values = {};
      connectorOffers.forEach(o => { values[o.source] = o.value; });
      conflict = {
        field: INPUT_COLUMN[field] || field,
        values,
        chosen: chosen.source,
        spread_pct: max ? Math.round((spread / max) * 1000) / 10 : 0
      };
    }
  }
  return { value: chosen.value, source: chosen.source, tier, agree, conflict };
}

/* Books-grade sources rank above gateway/ops sources for the same figure.
   Zoho first because its vitals are computed server-side from full postings;
   Tally next (one source, no filing corroboration); Odoo last because the
   connector currently exposes totals only. */
const CONNECTOR_PRIORITY = ['zoho', 'tally', 'odoo'];

function resolveSnapshotInputs(){
  const bySource = {
    zoho:  zohoInputCandidates(),
    tally: tallyInputCandidates(),
    odoo:  odooInputCandidates()
  };
  const self = selfInputCandidates();

  const inputs = {}, provenance = {}, conflicts = [];
  let any = false;

  SNAPSHOT_INPUT_FIELDS.forEach(field => {
    const offers = [];
    CONNECTOR_PRIORITY.forEach(src => {
      const v = bySource[src] ? bySource[src][field] : undefined;
      if(v !== undefined && isFinite(v)) offers.push({ source: src, value: v, tier: 'connector' });
    });
    if(self[field] !== undefined) offers.push({ source: 'self', value: self[field], tier: 'self' });

    const r = resolveField(field, offers);
    if(!r) return;
    inputs[field] = r.value;
    provenance[INPUT_COLUMN[field] || field] = r.agree
      ? { source: r.source, tier: r.tier, agree: r.agree }
      : { source: r.source, tier: r.tier };
    if(r.conflict) conflicts.push(r.conflict);
    if(r.tier !== 'self') any = true;
  });

  return { inputs, provenance, conflicts, hasConnectorInput: any };
}

/* Paint the confidence band on Summary and Scores from the latest snapshot. */
function renderConfidence(){
  const latest = snapshots[0] || null;
  const prov = latest ? latest.input_provenance : null;
  const sum = latest ? confidenceSummary(prov) : null;
  [['sumConfBand','sumConfFill','sumConfPct','sumConfText'],
   ['scConfBand','scConfFill','scConfPct','scConfText']].forEach(([bandId, fillId, pctId, textId]) => {
    const band = document.getElementById(bandId);
    const fill = document.getElementById(fillId);
    const pct  = document.getElementById(pctId);
    const text = document.getElementById(textId);
    if(!band) return;
    if(!sum){ band.classList.add('hidden'); if(text) text.textContent = ''; return; }
    band.classList.remove('hidden');
    band.className = 'conf-band t-' + sum.tier + (bandId === 'scConfBand' ? '' : '');
    if(bandId === 'scConfBand') band.style.justifyContent = 'center';
    if(fill) fill.style.width = sum.pct + '%';
    if(pct)  pct.textContent = sum.pct + '% confidence';
    if(text) text.textContent = sum.text;
  });
}

/* Per-vital tier = the weakest tier among that vital's inputs. */
function vitalTier(label, provenance){
  const fields = VITAL_INPUTS[label] || [];
  if(!fields.length || !provenance) return 'self';
  let worst = 'verified';
  fields.forEach(f => {
    const p = provenance[INPUT_COLUMN[f] || f];
    const t = (p && p.tier) || 'self';
    if(TIER_RANK[t] < TIER_RANK[worst]) worst = t;
  });
  return worst;
}

/* Snapshot confidence: the vital weights applied to each vital's tier, so a
   single-source Cash Position costs more confidence than a single-source GST
   figure — which matches what the weights already say about the score. */
function measuredVitalLabels(provenance){
  const skip = provenance && provenance.gst_leak && provenance.gst_leak.unmeasured;
  return Object.keys(VITAL_WEIGHTS).filter(l => !(skip && l === GST_VITAL));
}
function snapshotConfidence(provenance){
  if(!provenance) return TIER_CONFIDENCE.self;
  const labels = measuredVitalLabels(provenance), list = labels.map(label => ({ label }));
  let total = 0;
  labels.forEach(label => {
    total += vitalWeight(label, list) * TIER_CONFIDENCE[vitalTier(label, provenance)];
  });
  return Math.round(total * 100) / 100;
}

/* Human summary for the confidence line under the score. */
function confidenceSummary(provenance){
  const labels = measuredVitalLabels(provenance);
  if(!provenance){
    return { pct: 50, text: 'All six vitals are self-reported. Connect a source to raise this.', tier:'self' };
  }
  const counts = { verified:0, connector:0, self:0 };
  labels.forEach(l => { counts[vitalTier(l, provenance)]++; });
  const pct = Math.round(snapshotConfidence(provenance) * 100);
  const parts = [];
  if(counts.verified) parts.push(counts.verified + ' verified across two sources');
  if(counts.connector) parts.push(counts.connector + ' from one connected source');
  if(counts.self) parts.push(counts.self + ' self-reported');
  const tier = counts.self === labels.length ? 'self' : (counts.verified ? 'verified' : 'connector');
  return { pct, tier, text: 'Of ' + (labels.length === 6 ? 'six' : labels.length) + ' vitals: ' + parts.join(', ') + '.' +
    (labels.length < 6 ? ' GST input credit isn’t measured yet, so it isn’t in the score.' : '') };
}

/* Which source each figure came from, and which sources disagree. A source disconnected (a Tally test connection,
   30 Oct 2026) barely moves the figures when another source already supplied them, so without this the last reading
   kept "Estimate from Tally books" and "Sources disagree: Tally ₹0" on Home for good. */
function provenanceDiffers(provenance, conflicts, latest){
  if(!latest) return false;
  // Entries with no source (gst_leak marked unmeasured after this check) are left out, or every load would write.
  const srcOf = p => Object.keys(p || {}).filter(k => p[k] && p[k].source).sort().map(k => k + ':' + p[k].source).join('|');
  const confOf = c => (Array.isArray(c) ? c : []).map(x => (x.field || '') + ':' + Object.keys(x.values || {}).sort().join(',')).sort().join('|');
  return srcOf(provenance) !== srcOf(latest.input_provenance) || confOf(conflicts) !== confOf(latest.source_conflicts);
}

/* ---------- write a resolved snapshot when the picture actually changes ---------- */
function inputsMateriallyDiffer(inputs, latest){
  if(!latest) return true;
  return SNAPSHOT_INPUT_FIELDS.some(f => {
    if(inputs[f] === undefined) return false;
    const prev = Number(latest[INPUT_COLUMN[f]]) || 0;
    const next = Number(inputs[f]) || 0;
    const scale = Math.max(Math.abs(prev), Math.abs(next), 1);
    return Math.abs(next - prev) > scale * 0.005;   // 0.5%
  });
}

/* Called from refreshAll once every connector global is loaded. Returns true
   when it wrote a new snapshot, so the caller can reload. */
async function resolveAndSaveSnapshot(){
  if(!currentUser) return false;
  let latest = snapshots[0];
  // Tally's monthly P&L feeds revenue, burn and profit (tallyInputCandidates); load it first.
  if(typeof mgLoadMargin === 'function' && (typeof mgBooksConnected === 'function' ? mgBooksConnected() : (typeof tallyConnected !== 'undefined' && tallyConnected))){
    try { await mgLoadMargin(); if(typeof mgMarginFresh === 'function') await mgMarginFresh(); } catch(e){}   // a reading is saved from this sync's figures
  }

  const { inputs, provenance, conflicts, hasConnectorInput } = resolveSnapshotInputs();
  if(!hasConnectorInput) return false;          // nothing connected: manual flow is unchanged

  if(!latest){
    // First snapshot straight from a connected source: no upload needed. Fields no connector
    // supplies start at zero; revenue/burn/profit come from Tally's last closed month when we can.
    if(typeof mgLoadMargin === 'function' && (typeof mgBooksConnected === 'function' ? mgBooksConnected() : (typeof tallyConnected !== 'undefined' && tallyConnected))){
      try { await mgLoadMargin(true); } catch(e){}
      const pnl = ((typeof mgMar !== 'undefined' && mgMar && mgMar.pnl) || []).filter(r => !r.provisional && !r.partial_start && r.net_sales > 0);
      const m = pnl[pnl.length - 1];
      if(m){
        if(!(inputs.revenue > 0)) inputs.revenue = m.net_sales;
        if(!(inputs.burn > 0)) inputs.burn = (Number(m.cogs_pre_stock) || 0) + (Number(m.opex) || 0);
        if(inputs.netProfit === undefined) inputs.netProfit = Number(m.net_profit_pre_stock) || 0;
      }
    }
    SNAPSHOT_INPUT_FIELDS.forEach(f => { if(inputs[f] === undefined || !isFinite(inputs[f])) inputs[f] = 0; });
    latest = { burn: inputs.burn };
  }
  // What the score is measured against: today's books, or the last reading's when the books didn't load this
  // time (so a failed load never writes a reading on a thinner basis).
  const liveBasis = scoringBasisLive(), prevBasis = latest && latest.vitals ? vitalBasisOf(latest) : undefined;
  const useBasis = Object.keys(liveBasis).length || !prevBasis ? liveBasis
    : ['runningCosts', 'grossProfit', 'odHeadroom', 'odDrawn'].reduce((o, k) => { if(prevBasis[k] != null) o[k] = prevBasis[k]; return o; }, {});
  if(snapshots[0] && latest === snapshots[0] && !inputsMateriallyDiffer(inputs, latest) && !basisDiffers(useBasis, prevBasis) && !provenanceDiffers(provenance, conflicts, latest)) return false;
  inputs.scoringBasis = useBasis;

  // Burn drives three divisions in computeVitals; never let a connector hand
  // it a zero and turn runway into 0 months.
  if(!(Number(inputs.burn) > 0)) inputs.burn = Number(latest.burn) || 1;

  const carryPayments = latest.payments_data ? {
    paymentsData: latest.payments_data, paymentsSource: latest.payments_source || 'manual',
    settlementRows: latest.settlement_rows, settlementDailyTrend: latest.settlement_daily_trend
  } : {};

  if(gstNotMeasured(inputs, provenance)) provenance.gst_leak = Object.assign({ tier:'self' }, provenance.gst_leak || {}, { unmeasured:true });
  try {
    await saveSnapshot(Object.assign({}, inputs, carryPayments, {
      source: 'resolved', provenance, conflicts, confidence: snapshotConfidence(provenance)
    }));
    await logLedgerEvent({
      entityType: 'snapshot', event: 'resolved', source: 'connector',
      note: 'Pulse Score recalculated from connected sources (' +
            Object.keys(provenance).filter(k => provenance[k].tier !== 'self').length +
            ' of ' + SNAPSHOT_INPUT_FIELDS.length + ' inputs)'
    });
    return true;
  } catch(e){
    console.error('[margyn] resolveAndSaveSnapshot:', e.message);
    return false;
  }
}
async function saveSnapshot(inputs){
  const unmeasuredGst = !!(inputs.provenance && inputs.provenance.gst_leak && inputs.provenance.gst_leak.unmeasured);
  const vitals = computeVitals(inputs).filter(v => !(unmeasuredGst && v.label === GST_VITAL));
  const pulseScore = computePulseScore(vitals);
  const row = {
    user_id: currentUser.id, cash: inputs.cash, revenue: inputs.revenue, net_profit: inputs.netProfit,
    burn: inputs.burn, gst_leak: inputs.gstLeak, gst_payable: inputs.gstPayable,
    recv_total: inputs.recvTotal, recv_90: inputs.recv90, pay_soon: inputs.paySoon,
    vitals, pulse_score: pulseScore, source: inputs.source || 'manual',
    input_provenance: inputs.provenance || null,
    confidence: inputs.confidence != null ? inputs.confidence : TIER_CONFIDENCE.self,
    source_conflicts: (inputs.conflicts && inputs.conflicts.length) ? inputs.conflicts : null,
    payments_data: inputs.paymentsData || null,
    payments_source: inputs.paymentsData ? (inputs.paymentsSource || 'manual') : null,
    payments_updated_at: inputs.paymentsData ? new Date().toISOString() : null,
    settlement_rows: inputs.settlementRows || null,
    settlement_daily_trend: inputs.settlementDailyTrend || null,
    shopify_orders_data: inputs.shopifyOrdersData || null
  };
  const { error } = await sbClient.from('snapshots').insert(row);
  if(error) throw error;
}
