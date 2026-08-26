/**
 * Shared formatting of the rich Margyn context object — built client-side
 * by buildMargynContext() in app.html — into plain-English text blocks for
 * an Anthropic prompt.
 *
 * Used by both api/ask-margyn.js (the chat) and api/generate-briefing.js
 * (the Executive Briefing card) so the two features describe the same
 * underlying data the same way instead of drifting apart. Before this,
 * ask-margyn.js had its own inline copy of this formatting and
 * generate-briefing.js didn't exist at all — the briefing endpoint was
 * still on an older { vitals, pulseScore, companyName } contract nothing
 * calls anymore. See the client's runBriefingGeneration()/buildMargynContext().
 *
 * ESM (export, not module.exports) to match ask-margyn.js and
 * generate-briefing.js, which both use `import`/`export default` — unlike
 * most of /api (sync-razorpay.js, supabaseRest.js, etc.), which is
 * CommonJS. Vercel's Node builder handles both per-file; match whichever
 * a file's existing siblings already use rather than mixing require()
 * into an ESM file or vice versa.
 */

export function formatMargynContext(context) {
  const ctx = context || {};
  const companyName = ctx.companyName || 'this business';
  const pulseScore = (ctx.pulseScore === 0 || ctx.pulseScore) ? ctx.pulseScore : 'not yet calculated';
  const pulseTrend = ctx.pulseScoreTrend ? ` (${ctx.pulseScoreTrend})` : '';
  const vitals = Array.isArray(ctx.vitals) ? ctx.vitals : [];
  const payments = ctx.payments || null;
  const shopify = Array.isArray(ctx.shopify) ? ctx.shopify : null;
  const rp = ctx.receivablesPayables || null;
  const connectors = ctx.connectors || {};
  const provenance = ctx.dataProvenance || null;
  const razorpayLive = ctx.razorpayLive || null;
  const pnl = ctx.pnl || null;

  const vitalsLines = vitals.length
    ? vitals.map((v) => `- ${v.label}: ${v.value} (score ${v.score}/100)${v.trend ? ' — trend: ' + v.trend : ' — no prior snapshot to compare yet'}`).join('\n')
    : 'No vitals calculated yet for this business — no data has been synced or uploaded.';

  let pnlBlock = 'No P&L figures recorded yet.';
  if (pnl) {
    pnlBlock = [
      `Revenue: ₹${pnl.revenue.toLocaleString('en-IN')}${pnl.revenueTrend ? ' (' + pnl.revenueTrend + ')' : ''}`,
      `Net profit: ₹${pnl.netProfit.toLocaleString('en-IN')}${pnl.netProfitTrend ? ' (' + pnl.netProfitTrend + ')' : ''}`,
      `Total spend/burn: ₹${pnl.burn.toLocaleString('en-IN')}`,
      `Cash on hand: ₹${pnl.cash.toLocaleString('en-IN')}`,
      `GST payable: ₹${pnl.gstPayable.toLocaleString('en-IN')}, ITC unclaimed: ₹${pnl.gstLeak.toLocaleString('en-IN')}`
    ].join('\n');
  }

  let paymentsBlock = 'Not connected / no payments data uploaded yet.';
  if (payments) {
    paymentsBlock = [
      `Gross processed: ₹${payments.grossProcessed}${payments.grossTrend ? ' (' + payments.grossTrend + ')' : ''}`,
      `Net settled: ₹${payments.netSettled}`,
      `MDR: ${payments.mdrPct}%${payments.mdrTrend ? ' (' + payments.mdrTrend + ')' : ''}`,
      `Failed transaction rate: ${payments.failRatePct}%${payments.failRateTrend ? ' (' + payments.failRateTrend + ')' : ''}`,
      `Settlement lag: ${payments.settlementLagDays} days${payments.lagTrend ? ' (' + payments.lagTrend + ')' : ''}`,
      `Top payment method: ${payments.topPaymentMethod}`
    ].join('\n');
  }

  let shopifyBlock = 'Not connected / no Shopify data uploaded yet.';
  if (shopify && shopify.length) {
    shopifyBlock = shopify.map((r) => `- ${r.label}: ${r.value}${r.trend ? ' (' + r.trend + ')' : ''}`).join('\n');
  }

  let razorpayLiveBlock = 'No real per-transaction Razorpay data yet — either Razorpay isn\'t connected, or fewer than 4 transactions have synced so far. Do not estimate an average transaction value from anything else (like Shopify order counts) — say plainly you don\'t have real transaction-level data yet.';
  if (razorpayLive) {
    razorpayLiveBlock = [
      `Real transactions synced: ${razorpayLive.txnCount}`,
      razorpayLive.avgTicket !== null ? `Average transaction value: ₹${Math.round(razorpayLive.avgTicket)}${razorpayLive.avgTicketTrendPct !== null ? ' (' + (razorpayLive.avgTicketTrendPct >= 0 ? '+' : '') + razorpayLive.avgTicketTrendPct.toFixed(1) + '% vs the earlier half of the synced window)' : ''}` : null,
      razorpayLive.failRate !== null ? `Failed-payment rate: ${razorpayLive.failRate.toFixed(1)}%${razorpayLive.failRateTrendPct !== null ? ' (' + (razorpayLive.failRateTrendPct >= 0 ? '+' : '') + razorpayLive.failRateTrendPct.toFixed(1) + '%)' : ''}` : null,
      razorpayLive.refundRate !== null ? `Refund rate: ${razorpayLive.refundRate.toFixed(1)}% of captured payments` : null,
      razorpayLive.topMethod ? `Top payment method: ${razorpayLive.topMethod}` : null,
      razorpayLive.avgSettlementLagDays !== null ? `Average settlement lag: ${razorpayLive.avgSettlementLagDays.toFixed(1)} days` : null
    ].filter(Boolean).join('\n');
  }

  let rpBlock = 'No ledger data yet.';
  if (rp) {
    rpBlock = `Total outstanding receivables: ₹${rp.totalOutstandingReceivables} (₹${rp.receivablesOver90d} over 90 days)\nPayables due in next 30 days: ₹${rp.payablesDueNext30d}`;
    if (rp.topReceivables && rp.topReceivables.length) {
      rpBlock += `\nLargest open receivables: ${rp.topReceivables.map((r) => `${r.party} ₹${r.amount} (${r.overdueDays}d overdue)`).join('; ')}`;
    }
    if (rp.topPayables && rp.topPayables.length) {
      rpBlock += `\nLargest open payables: ${rp.topPayables.map((p) => `${p.party} ₹${p.amount} (due in ${p.dueInDays}d)`).join('; ')}`;
    }
  }

  let historyBlock = 'No past findings recorded yet.';
  if (Array.isArray(ctx.findingsHistory) && ctx.findingsHistory.length) {
    historyBlock = ctx.findingsHistory.map((f) => {
      const d = new Date(f.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `- ${d} · ${f.vital} (${f.tier}): ${f.summary}`;
    }).join('\n');
  }

  const provenanceLine = (provenance && provenance.selfReported)
    ? `\nImportant: the current snapshot's core financials came from ${provenance.label.toLowerCase()} — someone typed or uploaded these numbers by hand, not a live connector sync. Say so plainly when it's relevant (accuracy, verification, "is this real data") — never let it come across as connector-verified when it isn't.`
    : '';

  return {
    companyName, pulseScore, pulseTrend, vitalsLines, pnlBlock, paymentsBlock,
    shopifyBlock, razorpayLiveBlock, rpBlock, historyBlock, provenanceLine, connectors
  };
}
