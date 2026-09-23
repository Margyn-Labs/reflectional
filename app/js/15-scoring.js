/* ============================================================
   SCORING ENGINE — deterministic, hardcoded. AI narrates, never calculates.
   ============================================================ */
const BENCH = { runwayMin:3, runwayMax:6, recvBad:0.3, paySafe:0.5, gstBad:0.15, marginGood:15, marginOk:5 };
function scoreCash(cash, burn){
  const months = burn > 0 ? cash / burn : 0;
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
function scorePayables(paySoon, cash){
  const ratio = cash > 0 ? paySoon / cash : (paySoon > 0 ? 1 : 0);
  const score = clamp(100 - (ratio / BENCH.paySafe) * 100);
  return { value: inr(paySoon), score };
}
function scoreGst(gstLeak, gstPayable){
  const ratio = gstPayable > 0 ? gstLeak / gstPayable : (gstLeak > 0 ? 1 : 0);
  const score = clamp(100 - (ratio / BENCH.gstBad) * 100);
  return { value: inr(gstLeak), score };
}
function scoreMargin(netProfit, revenue){
  const pct = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  let score;
  if(pct >= BENCH.marginGood) score = 100;
  else if(pct <= 0) score = clamp(50 + pct);
  else score = clamp((pct / BENCH.marginGood) * 100);
  return { value: pct.toFixed(1) + '%', score };
}
function scoreRunway(cash, recvTotal, paySoon, burn){
  const wc = cash + recvTotal - paySoon;
  const months = burn > 0 ? wc / burn : 0;
  let score;
  if(months >= BENCH.runwayMax) score = 100;
  else if(months <= 0) score = 0;
  else score = clamp((months / BENCH.runwayMax) * 100);
  return { value: months.toFixed(1) + ' months', score };
}
function computeVitals({ cash, revenue, netProfit, burn, gstLeak, gstPayable, recvTotal, recv90, paySoon }){
  const cashV = scoreCash(cash, burn);
  const recvV = scoreReceivables(recvTotal, recv90);
  const payV = scorePayables(paySoon, cash);
  const gstV = scoreGst(gstLeak, gstPayable);
  const marginV = scoreMargin(netProfit, revenue);
  const runwayV = scoreRunway(cash, recvTotal, paySoon, burn);
  return [
    { label:'Cash Position', value: cashV.value, score: cashV.score },
    { label:'Receivables Aging', value: recvV.value, score: recvV.score },
    { label:'Payables Due (30d)', value: payV.value, score: payV.score },
    { label:'GST/ITC Leakage', value: gstV.value, score: gstV.score },
    { label:'Net Margin', value: marginV.value, score: marginV.score },
    { label:'Working Capital Runway', value: runwayV.value, score: runwayV.score }
  ];
}
const VITAL_WEIGHTS = { 'Cash Position':0.20, 'Receivables Aging':0.15, 'Payables Due (30d)':0.15, 'GST/ITC Leakage':0.15, 'Net Margin':0.20, 'Working Capital Runway':0.15 };
function computePulseScore(vitals){
  return Math.round(vitals.reduce((s,v) => s + (v.score * (VITAL_WEIGHTS[v.label] || 0)), 0));
}

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
    TALLY_LIQUID_GROUP.test(String(x.parent || '')) &&
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
  if(Array.isArray(b.items)){
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
  put('revenue', v.sales_30d);
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
function snapshotConfidence(provenance){
  if(!provenance) return TIER_CONFIDENCE.self;
  let total = 0;
  Object.keys(VITAL_WEIGHTS).forEach(label => {
    total += (VITAL_WEIGHTS[label] || 0) * TIER_CONFIDENCE[vitalTier(label, provenance)];
  });
  return Math.round(total * 100) / 100;
}

/* Human summary for the confidence line under the score. */
function confidenceSummary(provenance){
  const labels = Object.keys(VITAL_WEIGHTS);
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
  return { pct, tier, text: 'Of six vitals: ' + parts.join(', ') + '.' };
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
  const latest = snapshots[0];
  // A resolved snapshot still needs a baseline for the fields no connector
  // supplies (GST payable, and cash/P&L when only Tally or Odoo is on).
  if(!latest) return false;

  const { inputs, provenance, conflicts, hasConnectorInput } = resolveSnapshotInputs();
  if(!hasConnectorInput) return false;          // nothing connected: manual flow is unchanged
  if(!inputsMateriallyDiffer(inputs, latest)) return false;

  // Burn drives three divisions in computeVitals; never let a connector hand
  // it a zero and turn runway into 0 months.
  if(!(Number(inputs.burn) > 0)) inputs.burn = Number(latest.burn) || 1;

  const carryPayments = latest.payments_data ? {
    paymentsData: latest.payments_data, paymentsSource: latest.payments_source || 'manual',
    settlementRows: latest.settlement_rows, settlementDailyTrend: latest.settlement_daily_trend
  } : {};

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
  const vitals = computeVitals(inputs);
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
