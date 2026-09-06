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
 * PROVENANCE DISCIPLINE (2026-09-03): the receivables/payables picture has
 * two completely separate origins and they must never be blended:
 *   - Zoho Books  → `context.booksVitals`  (connector-synced, invoice/bill level)
 *   - Quick Ledger → `context.receivablesPayables` (SELF-ENTERED — typed in the
 *     app or uploaded via the CSV template; never from a connector)
 * They are rendered as two labelled blocks below, and when they disagree the
 * caller passes `context.sourceDivergence` which is surfaced at the top.
 *
 * ESM (export, not module.exports) to match ask-margyn.js and
 * generate-briefing.js, which both use `import`/`export default`.
 */

export function formatMargynContext(context) {
  const ctx = context || {};
  const companyName = ctx.companyName || 'this business';
  const pulseScore = (ctx.pulseScore === 0 || ctx.pulseScore) ? ctx.pulseScore : 'not yet calculated';
  const pulseTrend = ctx.pulseScoreTrend ? ` (${ctx.pulseScoreTrend})` : '';
  const vitals = Array.isArray(ctx.vitals) ? ctx.vitals : [];
  const payments = ctx.payments || null;
  const paymentsSource = ctx.paymentsSource || null; // 'razorpay_live' | 'manual' | null
  const shopify = Array.isArray(ctx.shopify) ? ctx.shopify : null;
  const rp = ctx.receivablesPayables || null;        // SELF-ENTERED Quick Ledger
  const books = ctx.booksVitals || null;             // Zoho Books connector vitals
  const recon = ctx.reconciliation || null;
  const connectors = ctx.connectors || {};
  const provenance = ctx.dataProvenance || null;
  const razorpayLive = ctx.razorpayLive || null;
  const pnl = ctx.pnl || null;
  const snapshotSource = (provenance && provenance.source) || null;

  const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

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

  // ---- Payments block: label by real provenance, not by connection state ----
  let paymentsHeader = 'Payments data';
  if (paymentsSource === 'razorpay_live') {
    paymentsHeader = 'Razorpay payments (LIVE — synced from Razorpay each night, not typed by hand)';
  } else if (payments) {
    paymentsHeader = 'Payments figures (SELF-ENTERED — Quick Manual Entry or a "Razorpay Settlements" sheet uploaded by hand, NOT a live Razorpay sync)';
  } else {
    paymentsHeader = 'Payments data (none — Razorpay not connected and nothing uploaded)';
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
    const suffix = (snapshotSource === 'upload') ? ' (from a manual workbook upload, not the Shopify connector)' : '';
    shopifyBlock = shopify.map((r) => `- ${r.label}: ${r.value}${r.trend ? ' (' + r.trend + ')' : ''}`).join('\n') + (suffix ? '\n' + suffix : '');
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

  // ---- Zoho Books block (connector-synced) ----
  let booksBlock;
  if (!connectors.zoho) {
    booksBlock = 'Zoho Books is not connected. There is no connector-sourced view of receivables, payables, GST or true margin — only the self-entered figures below.';
  } else if (!books) {
    booksBlock = 'Zoho Books is connected but its first sync/backfill has not produced vitals yet.';
  } else {
    const r = books.receivables || {}, p = books.payables || {}, c = books.cash_position || {};
    const g = books.gst_leakage || {}, m = books.net_margin || {}, w = books.working_capital_runway || {};
    const lines = [];
    if (r.total != null) lines.push(`Receivables outstanding: ${inr(r.total)}${r.days_90_plus != null ? ' (' + inr(r.days_90_plus) + ' over 90 days)' : ''}`);
    if (p.total != null) lines.push(`Payables outstanding: ${inr(p.total)}${p.overdue != null ? ' (' + inr(p.overdue) + ' overdue' + (p.due_this_week != null ? ', ' + inr(p.due_this_week) + ' due this week' : '') + ')' : ''}`);
    if (c.bank_data_available === false) {
      lines.push('Cash position: not available (Zoho plan without a bank feed)');
    } else if (c.zoho_reported_balance != null) {
      lines.push(`Cash position (per books): ${inr(c.zoho_reported_balance)}${c.divergence_pct != null ? ' — ' + Number(c.divergence_pct).toFixed(0) + '% divergence vs 90d gateway settlements' : ''}`);
    }
    if (g.total_leakage != null) lines.push(`ITC at risk: ${inr(g.total_leakage)}${g.leakage_pct != null ? ' (' + Number(g.leakage_pct).toFixed(0) + '% of claimed ITC' + (g.filing_period ? ', period ' + g.filing_period : '') + ')' : ''}`);
    if (m.net_margin_pct != null) lines.push(`Net margin (from books COGS/opex): ${Number(m.net_margin_pct).toFixed(1)}%`);
    if (w.runway_days != null) lines.push(`Working capital runway: ${Math.round(w.runway_days)} days`);
    if (Array.isArray(books.top_overdue_customers) && books.top_overdue_customers.length) {
      lines.push('Top overdue customers: ' + books.top_overdue_customers.slice(0, 5).map((x) => `${x.customer_name || 'Unnamed'} ${inr(x.balance)} (${x.days_overdue}d, inv ${x.invoice_number || '—'})`).join('; '));
    }
    if (Array.isArray(books.flags) && books.flags.length) lines.push('Flags: ' + books.flags.join(', '));
    booksBlock = lines.length ? lines.join('\n') : 'Zoho Books connected but returned no material figures on the last sync.';
  }

  // ---- Tally block (connector-synced, but SIGNAL-tier — one source) ----
  // ctx.tally is the api/tally.js?action=summary payload. Tally is "Books" the
  // same way Zoho is, but it is a single independently-operated source, so its
  // figures are Signal, never Verified, and must NEVER be blended with Zoho's
  // books figures or the self-entered Quick Ledger below.
  const tally = ctx.tally || null;
  let tallyBlock;
  if (!connectors.tally) {
    tallyBlock = 'Tally is not connected. No desktop-agent view of ledgers, vouchers or bill-wise outstanding.';
  } else if (!tally) {
    tallyBlock = 'Tally is connected but the desktop agent has not synced any data yet.';
  } else {
    const tb = tally.bills || {}, tv = tally.vouchers || {};
    const lines = [];
    lines.push(`Source: TallyPrime desktop agent${tally.company_name ? ' (company ' + tally.company_name + ')' : ''}${tally.as_of ? ', last sync ' + new Date(tally.as_of).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''}. SIGNAL-tier — one source, not verified.`);
    if (tb.receivable_total != null) lines.push(`Bill-wise receivables outstanding (per Tally): ${inr(tb.receivable_total)}`);
    if (tb.payable_total != null) lines.push(`Bill-wise payables outstanding (per Tally): ${inr(tb.payable_total)}${tb.overdue_total ? ' (' + inr(tb.overdue_total) + ' overdue)' : ''}`);
    if (tv.count != null) {
      const byType = tv.by_type || {};
      const typeStr = Object.keys(byType).map((k) => `${byType[k]} ${k}`).join(', ');
      lines.push(`Vouchers synced: ${tv.count}${typeStr ? ' (' + typeStr + ')' : ''}. Sales last 30d ${inr(tv.sales_30d || 0)}, receipts last 30d ${inr(tv.receipts_30d || 0)}.`);
    }
    if (tally.ledgers && tally.ledgers.count != null) lines.push(`${tally.ledgers.count} ledger balances synced.`);
    tallyBlock = lines.join('\n');
  }

  // ---- Quick Ledger block (SELF-ENTERED) ----
  let ledgerBlock = 'No self-entered receivables/payables.';
  if (rp) {
    ledgerBlock = `Total outstanding receivables: ${inr(rp.totalOutstandingReceivables)} (${inr(rp.receivablesOver90d)} over 90 days)\nPayables due in next 30 days: ${inr(rp.payablesDueNext30d)}`;
    if (rp.topReceivables && rp.topReceivables.length) {
      ledgerBlock += `\nLargest open receivables: ${rp.topReceivables.map((r) => `${r.party} ${inr(r.amount)} (${r.overdueDays}d overdue)`).join('; ')}`;
    }
    if (rp.topPayables && rp.topPayables.length) {
      ledgerBlock += `\nLargest open payables: ${rp.topPayables.map((p) => `${p.party} ${inr(p.amount)} (due in ${p.dueInDays}d)`).join('; ')}`;
    }
  }

  // ---- Cross-source ledger (all three receivables/payables origins side by side) ----
  // ctx.crossLedger is client-computed in buildCrossLedgerSummary(): it groups
  // every open receivable/payable by counterparty across self-entered, Zoho and
  // Tally, and flags where 2+ sources agree vs conflict. This is the ONLY place
  // the three are compared — the blocks above are each source on its own.
  const xl = ctx.crossLedger || null;
  let crossLedgerBlock = 'Only one source of receivables/payables is present (or none) — nothing to cross-check yet.';
  if (xl) {
    const sp = xl.sourcesPresent || {};
    const present = [sp.self && 'your manual/CSV ledger', sp.zoho && 'Zoho Books', sp.tally && 'Tally (Signal)'].filter(Boolean);
    const dirLines = (label, d) => {
      if (!d) return null;
      const t = d.totalsBySource || {};
      const totalStr = ['self', 'zoho', 'tally'].filter((k) => t[k]).map((k) => `${k === 'self' ? 'your ledger' : k === 'zoho' ? 'Zoho' : 'Tally'} ${inr(t[k])}`).join(' · ');
      const out = [`${label} totals by source: ${totalStr || 'none'}`];
      if (d.agree && d.agree.length) {
        out.push(`  Agree across sources (${d.agree.length}): ` + d.agree.slice(0, 12).map((a) => `${a.party} ${inr(a.amount)} [${a.sources.join('+')}]`).join('; '));
      }
      if (d.conflict && d.conflict.length) {
        out.push(`  CONFLICT — same counterparty, different numbers (${d.conflict.length}) — surface these, never pick one silently:`);
        d.conflict.slice(0, 12).forEach((c) => {
          out.push('    · ' + c.party + ': ' + Object.keys(c.bySource).map((k) => `${k === 'self' ? 'your ledger' : k} ${inr(c.bySource[k])}`).join(' vs '));
        });
      }
      if (d.singleSource && d.singleSource.length) {
        out.push(`  Only one source has these (${d.singleSource.length}) — Signal, not confirmed: ` + d.singleSource.slice(0, 10).map((s) => `${s.party} ${inr(s.amount)} [${s.source === 'self' ? 'your ledger' : s.source}]`).join('; '));
      }
      return out.join('\n');
    };
    crossLedgerBlock = [
      `Sources present: ${present.join(', ') || 'none'}.`,
      dirLines('RECEIVABLES', xl.receivables),
      dirLines('PAYABLES', xl.payables),
      'How to use this: where sources AGREE, you may state the figure with confidence and say which sources back it. Where they CONFLICT, give every source\'s number and the gap — never add them, never average, never pick one. Where only ONE source has an item it is Signal. Tally is always Signal on its own. Self-entered rows are the only ones that feed the Pulse Score.'
    ].filter(Boolean).join('\n');
  }

  // ---- Reconciliation state ----
  let reconLine = '';
  if (recon && recon.connected) {
    const c = recon.counts || {};
    const p = recon.provenance || {};
    const srcPair = (p.source_a && p.source_b) ? `${p.source_a} ↔ ${p.source_b}` : 'Zoho invoices ↔ live Razorpay payments';
    const asOf = p.last_verified_at ? ` Last verified match: ${new Date(p.last_verified_at).toISOString().slice(0, 10)}.` : '';
    reconLine = `\nReconciliation (${srcPair} — two independently-operated sources): ${c.verified || 0} Verified, ${c.signal || 0} Signal (single-source / same-sourced), ${c.needs_review || 0} needing review, ${recon.reviewQueueLen || 0} ambiguous payment(s) in the pick-one queue.${asOf} "Verified" here means both sources agree; "Signal" means only one does — never state a Signal match with Verified confidence.`;
  }

  // ---- Reconciler v2 pair findings (Books x Razorpay x Shopify; no bank/GST) ----
  // ctx.reconV2 is the api/reconcile?action=summary-v2 payload. Books is Zoho OR
  // Tally, never blended. Mismatch rows are the screening case — surfaced verbatim.
  const v2 = ctx.reconV2 || null;
  if (v2 && v2.connected) {
    const cc = v2.counts || {};
    const bp = v2.by_pair || {};
    const pairLine = (key, label) => {
      const p = bp[key] || {};
      if (!p.total) return null;
      return `  - ${label}: ${p.verified || 0} verified, ${p.mismatch || 0} mismatch, ${p.partial || 0} partial, ${p.awaiting_books || 0} awaiting books, ${p.fee_unallocated || 0} fee-unallocated, ${p.unmatched || 0} unmatched (of ${p.total})`;
    };
    const lines = [
      pairLine('books_razorpay', 'Books ↔ Razorpay'),
      pairLine('books_shopify', 'Books ↔ Shopify'),
      pairLine('razorpay_shopify', 'Razorpay ↔ Shopify')
    ].filter(Boolean);
    reconLine += `\nReconciler v2 pair jobs (no bank, no GST — books = Zoho OR Tally, never merged): ${cc.verified || 0} verified, ${cc.mismatch || 0} mismatch, ${cc.awaiting_books || 0} awaiting books, ${cc.fee_unallocated || 0} fee-unallocated.`;
    if (lines.length) reconLine += '\n' + lines.join('\n');
    if (Array.isArray(v2.mismatches) && v2.mismatches.length) {
      reconLine += '\n  MISMATCHES (amounts line up, ids/dates conflict — do NOT call these verified, keep visible):';
      reconLine += '\n' + v2.mismatches.slice(0, 8).map((m) => {
        const a = m.amount_a != null ? inr(m.amount_a) : '?';
        const b = m.amount_b != null ? inr(m.amount_b) : '?';
        return `  · ${m.source_a} ${a} (${m.a_ref || '—'}) vs ${m.source_b} ${b} (${m.b_ref || '—'})${m.date_diff_days != null ? ', ' + m.date_diff_days + 'd apart' : ''} — ${m.reason || ''}`;
      }).join('\n');
    }
    if (v2.last_verified_at) reconLine += `\n  Last v2 verified match: ${new Date(v2.last_verified_at).toISOString().slice(0, 10)}.`;
  }

  // ---- Connector freshness / re-auth state (provenance, as columns) ----
  // ctx.connectorStatus: [{ type, connected, needsReauth, lastSuccessAt }]
  let connectorFreshnessBlock = 'Connector sync status not reported in this context.';
  const cs = Array.isArray(ctx.connectorStatus) ? ctx.connectorStatus : null;
  if (cs && cs.length) {
    connectorFreshnessBlock = cs.map((s) => {
      const name = s.type || 'connector';
      if (!s.connected) return `- ${name}: not connected`;
      if (s.needsReauth) return `- ${name}: CONNECTED BUT NEEDS RE-AUTH — its data is stale and must be treated as unverified until the owner reconnects.`;
      const fresh = s.lastSuccessAt ? `last successful sync ${new Date(s.lastSuccessAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no successful sync recorded yet';
      return `- ${name}: connected, ${fresh}`;
    }).join('\n');
  }

  // ---- Divergence between the two sources (passed by the caller) ----
  const sourceDivergenceLine = ctx.sourceDivergence
    ? `\n⚠ SOURCE DISAGREEMENT — LEAD WITH THIS: ${ctx.sourceDivergence}\nThese come from different systems. Report both numbers and the gap; never add them together or pick one silently.`
    : '';

  let historyBlock = 'No past findings recorded yet.';
  if (Array.isArray(ctx.findingsHistory) && ctx.findingsHistory.length) {
    historyBlock = ctx.findingsHistory.map((f) => {
      const d = new Date(f.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `- ${d} · ${f.vital} (${f.tier}): ${f.summary}`;
    }).join('\n');
  }

  const selfReportedBlocks = [];
  if (provenance && provenance.selfReported) selfReportedBlocks.push('the core P&L / cash / GST figures and the vitals computed from them');
  if (rp) selfReportedBlocks.push('the Quick Ledger receivables/payables');
  if (payments && paymentsSource !== 'razorpay_live') selfReportedBlocks.push('the payments figures');
  if (shopify && snapshotSource === 'upload') selfReportedBlocks.push('the Shopify figures');
  const provenanceLine = selfReportedBlocks.length
    ? `\nImportant: these are SELF-REPORTED (typed or uploaded by hand, not a live connector sync): ${selfReportedBlocks.join('; ')}. Say so plainly when accuracy, verification or "is this real data" comes up. Self-reported data can never corroborate itself or another self-reported figure — only an independently-operated connector can.`
    : '';

  return {
    companyName, pulseScore, pulseTrend, vitalsLines, pnlBlock,
    paymentsHeader, paymentsBlock,
    shopifyBlock, razorpayLiveBlock,
    booksBlock, tallyBlock, ledgerBlock, crossLedgerBlock, reconLine,
    connectorFreshnessBlock,
    historyBlock, provenanceLine, sourceDivergenceLine, connectors
  };
}
