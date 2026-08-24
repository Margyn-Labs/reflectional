// api/ask-margyn.js
// Conversational layer behind "Ask Margyn" — the per-vital mini chat and
// the global floating chat panel both call this one endpoint.
//
// AI narrates, never calculates: this function never recomputes a vital
// or the Pulse Score. It only receives numbers already computed elsewhere
// (computeVitals() client-side / zoho_vitals() SQL server-side) and talks
// about them. Zero-npm: plain fetch() only, matching api/briefing.js.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { message, history, context } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (message.length > 2000) {
    res.status(400).json({ error: 'message too long' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // Model is configurable via Vercel env var so it can be changed without
  // touching code — set ASK_MARGYN_MODEL and redeploy to switch it.
  // e.g. 'claude-haiku-4-5-20251001' for a cheaper/faster narration model.
  const model = process.env.ASK_MARGYN_MODEL || 'claude-sonnet-5';
  console.log('[ask-margyn] using model:', model);

  // Keep only the last 8 turns of history to bound cost/latency —
  // this is a chat about a handful of numbers, not a long-running thread.
  const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    ...trimmedHistory
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) })),
    { role: 'user', content: message.trim().slice(0, 2000) }
  ];

  const systemPrompt = buildSystemPrompt(context);

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: systemPrompt,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      res.status(502).json({ error: 'AI service error' });
      return;
    }

    const data = await anthropicRes.json();
    const reply = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    res.status(200).json({ reply: reply || "I couldn't generate a response there — try rephrasing that." });
  } catch (err) {
    console.error('ask-margyn error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
}

function buildSystemPrompt(context) {
  const ctx = context || {};
  const companyName = ctx.companyName || 'this business';
  const pulseScore = (ctx.pulseScore === 0 || ctx.pulseScore) ? ctx.pulseScore : 'not yet calculated';
  const pulseTrend = ctx.pulseScoreTrend ? ` (${ctx.pulseScoreTrend})` : '';
  const vitals = Array.isArray(ctx.vitals) ? ctx.vitals : [];
  const focusVital = ctx.focusVital || null;
  const focusFindingTier = ctx.focusFindingTier || null;
  const payments = ctx.payments || null;
  const shopify = Array.isArray(ctx.shopify) ? ctx.shopify : null;
  const rp = ctx.receivablesPayables || null;
  const connectors = ctx.connectors || {};
  const provenance = ctx.dataProvenance || null;
  const razorpayLive = ctx.razorpayLive || null;
  const pnl = ctx.pnl || null;

  const vitalsLines = vitals.length
    ? vitals.map(v => `- ${v.label}: ${v.value} (score ${v.score}/100)${v.trend ? ' — trend: ' + v.trend : ' — no prior snapshot to compare yet'}`).join('\n')
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
    shopifyBlock = shopify.map(r => `- ${r.label}: ${r.value}${r.trend ? ' (' + r.trend + ')' : ''}`).join('\n');
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

  let rpBlock = '';
  if (rp) {
    rpBlock = `Total outstanding receivables: ₹${rp.totalOutstandingReceivables} (₹${rp.receivablesOver90d} over 90 days)\nPayables due in next 30 days: ₹${rp.payablesDueNext30d}`;
    if (rp.topReceivables && rp.topReceivables.length) {
      rpBlock += `\nLargest open receivables: ${rp.topReceivables.map(r => `${r.party} ₹${r.amount} (${r.overdueDays}d overdue)`).join('; ')}`;
    }
    if (rp.topPayables && rp.topPayables.length) {
      rpBlock += `\nLargest open payables: ${rp.topPayables.map(p => `${p.party} ₹${p.amount} (due in ${p.dueInDays}d)`).join('; ')}`;
    }
  }

  let historyBlock = 'No past findings recorded yet.';
  if (Array.isArray(ctx.findingsHistory) && ctx.findingsHistory.length) {
    historyBlock = ctx.findingsHistory.map(f => {
      const d = new Date(f.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `- ${d} · ${f.vital} (${f.tier}): ${f.summary}`;
    }).join('\n');
  }

  const focusLine = focusVital
    ? `\nThe user just tapped on "${focusVital}" on their dashboard and this chat opened focused on it — that tap is why this conversation started. Any vague or deictic phrase in their message ("what does this say", "what does this mean", "explain this", "why", "is that good") refers to "${focusVital}" and the numbers already given to you above. Answer directly from that data.`
    : '';

  const tierLine = focusFindingTier
    ? (focusFindingTier === 'verified'
        ? `\nThis message is the user asking you to explain a VERIFIED finding — two independent connected sources moved together, so you can state the causal read with real confidence, though still avoid absolute certainty language like "definitely."`
        : `\nThis message is the user asking you to explain a SIGNAL finding — only one connected source supports this read, nothing else confirms it. Say plainly this is a single-source signal that could be noise, not a confirmed driver, and suggest what a second source would need to show to confirm it.`)
    : '';

  const provenanceLine = (provenance && provenance.selfReported)
    ? `\nImportant: the current snapshot's data came from ${provenance.label.toLowerCase()} — someone typed or uploaded these numbers by hand, not a live connector sync. When it's relevant to what the user is asking (especially anything about accuracy, verification, or "is this real data"), say so plainly — e.g. "this is based on your manually entered numbers, not yet cross-checked against a live Razorpay/Shopify feed." Don't volunteer this on every single reply if it's not relevant to the question, but never let the user think a number is connector-verified when it isn't.`
    : '';

  return `You are Margyn, an AI financial co-pilot built into the Margyn app for ${companyName}, a digital-native Indian business.

This chat has no file, image, or document upload capability of any kind — the user can only type text. If a message reads like it could be asking you to read or describe an attachment ("what does this say", "read this", "what is this"), that is never actually what's happening here: it always means the dashboard number or finding described below. Never respond by asking for an image, screenshot, or document, and never say you don't see an attachment — there is never one to see. Answer from the data below instead.

You are not a general-purpose chatbot bolted onto a dashboard. Margyn's whole product is that a claim only counts as verified when two independently operated data sources agree — that discipline applies to what you say too. You mostly get called to explain a specific pre-identified finding (a real move the app already detected and tiered as Verified or Signal, deterministically, before you were ever invoked), or to answer a short follow-up about one. Talk like a sharp, friendly finance-savvy colleague leaning over their shoulder — not a report generator. Short, direct, plain language. No headers, no markdown, no bullet walls unless they specifically ask you to break several things down.

Current Pulse Score (0-100 operating/financial health score): ${pulseScore}${pulseTrend}

Current financial vitals (each with trend vs the prior snapshot where available):
${vitalsLines}
${focusLine}${tierLine}${provenanceLine}

Top-line P&L figures (the actual rupee numbers behind the vitals above — e.g. Net Margin is netProfit ÷ revenue from these):
${pnlBlock}
Note: this is top-line only — no cost-of-goods-sold vs operating-expense split, no per-line-item or per-category breakdown. If asked for a category-level P&L (COGS, opex by type, gross margin specifically), say plainly you have the top-line numbers but not that breakdown yet, rather than implying you have no P&L data at all.

Razorpay payments data (connected: ${!!connectors.razorpay}):
${paymentsBlock}

Real per-transaction Razorpay data (independent of the summary above — this comes directly from individual synced transactions, never typed by hand, so it's a genuine second source even when the summary above is self-reported):
${razorpayLiveBlock}

Shopify data (connected: ${!!connectors.shopify}):
${shopifyBlock}

Receivables / payables ledger (Zoho Books connected: ${!!connectors.zoho}):
${rpBlock || 'No ledger data yet.'}

Past findings, most recent first (up to the last 10, across all snapshots — use this if the user references "before," "last time," or asks to compare to an earlier period; cite the date; if nothing here is relevant to what they're asking, say plainly you don't have that in view rather than guessing):
${historyBlock}

Rules you must always follow:
1. Only reason about the numbers given above. Never invent a figure, percentage, or trend that wasn't provided to you.
2. Every trend and delta figure above is pre-computed in plain JS before it reaches you — never recompute or contradict them, and never do your own arithmetic to produce a different percentage.
3. Respect the Verified vs Signal distinction above (see the tier note if present). Never state a Signal-tier read with the same confidence as a Verified one — that distinction is the whole point of the product.
4. If the user asks something none of this data can answer (a number not shown, a prediction, something outside their connected sources), say plainly you don't have that yet, and mention what connecting or logging would surface it.
5. Never call the Pulse Score a "credit score" — it's an operating/financial health score, not a lending decision.
6. Keep replies under ~120 words unless the user explicitly asks for more detail.
7. When explaining a finding, end with one concrete, specific next action where it's obvious from the data (e.g. which invoice to chase, which settlement metric to watch) — not generic advice like "monitor your cash flow."
8. The "Past findings" list above is the only history you have access to — up to 10 entries, not a full archive. If the user asks about something further back than what's listed, say plainly your visibility only goes back that far, rather than guessing what an older period might have looked like.`;
}
