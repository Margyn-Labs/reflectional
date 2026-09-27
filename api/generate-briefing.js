// api/generate-briefing.js
// Backs the Executive Briefing card (Scores tab) — the app's one
// AI-generated narrative surface, orange-coded in the UI to mark it as
// AI-written rather than a deterministic vital.
//
// Replaces api/briefing.js, which the client never actually called (it
// POSTed to /api/generate-briefing, a route that didn't exist — a 404 the
// client's catch block silently turned into "Couldn't generate a briefing
// just now"). briefing.js was also on an older { vitals, pulseScore,
// companyName } request contract; the client has sent the full
// buildMargynContext() object (via runBriefingGeneration() in app.html)
// for a while now, wrapped as { context }, which only api/ask-margyn.js
// had been updated to actually read.
//
// AI narrates, never calculates: this receives numbers already computed
// elsewhere (computeVitals() client-side / zoho_vitals() SQL server-side)
// and writes about them — it never recomputes a vital or the Pulse Score.
// Zero-npm: plain fetch() only, matching the rest of /api.

import { formatMargynContext } from './_lib/formatMargynContext.js';
import { getUserFromRequest } from './_lib/supabaseRest.js';
import { callClaude, textOf } from './_lib/claude.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  // Signed-in users only: this endpoint spends Claude credit on every call,
  // and until now anyone with the URL could call it.
  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (e) {
    console.error('[generate-briefing] auth check failed:', e.message);
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  if (!user || !user.id) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { context } = body || {};
  if (!context) {
    res.status(400).json({ error: 'Missing "context" in request body.' });
    return;
  }

  // Model is configurable via Vercel env var so it can be changed without
  // touching code — same pattern as ASK_MARGYN_MODEL in api/ask-margyn.js.
  const model = process.env.BRIEFING_MODEL || 'claude-sonnet-5';

  const {
    companyName, pulseScore, pulseTrend, vitalsLines, pnlBlock,
    paymentsHeader, paymentsBlock, shopifyBlock, razorpayLiveBlock,
    booksBlock, tallyBlock, ledgerBlock, crossLedgerBlock, reconLine, connectorFreshnessBlock,
    historyBlock, provenanceLine, sourceDivergenceLine, connectors
  } = formatMargynContext(context);

  const prompt = `You are Margyn, an AI financial co-pilot, writing the Executive Briefing for ${companyName}, a digital-native Indian business. This briefing is the one AI-generated narrative surface in the product — everything else is a deterministic vital or score. Write like a sharp CFO advisor talking to a busy founder who is not a finance person, not a report generator.

Current Pulse Score (0-100 operating/financial health score): ${pulseScore}${pulseTrend}

Current financial vitals (each with trend vs the prior snapshot where available):
${vitalsLines}
${provenanceLine}${sourceDivergenceLine}

Top-line P&L figures (the actual rupee numbers behind the vitals above — e.g. Net Margin is netProfit ÷ revenue from these):
${pnlBlock}
Note: this is top-line only — no cost-of-goods-sold vs operating-expense split, no per-line-item or per-category breakdown.

${paymentsHeader}:
${paymentsBlock}

Real per-transaction Razorpay data (independent of the summary above):
${razorpayLiveBlock}

Shopify data (connected: ${!!connectors.shopify}):
${shopifyBlock}

Zoho Books — CONNECTOR-SYNCED, from the live books (invoice/bill level):
${booksBlock}

Tally — CONNECTOR-SYNCED via the desktop agent, SIGNAL-tier (one source, never Verified alone). Never merge Tally figures with Zoho's or with the Quick Ledger:
${tallyBlock}

Quick Ledger — SELF-ENTERED (typed in the app or uploaded via the CSV template; NOT from any connector):
${ledgerBlock}

CROSS-SOURCE LEDGER — the three receivables/payables sources compared counterparty-by-counterparty. Where sources agree, state it plainly; where they conflict, name both numbers and the gap; never blend or average; single-source items are Signal; only the self-entered ledger moves the Pulse Score:
${crossLedgerBlock}${reconLine}

Connector sync status (data freshness / re-auth — provenance, not a vital):
${connectorFreshnessBlock}

Past findings, most recent first (up to the last 10, across all snapshots):
${historyBlock}

Rules:
1. Only reason about the numbers given above. Never invent a figure, percentage, or trend that wasn't provided to you.
2. Every trend and delta figure above is pre-computed in plain JS before it reaches you — never recompute or contradict them.
2b. Zoho Books and the Quick Ledger are SEPARATE sources of receivables/payables. Never add or blend them into one number. If they disagree, report both and name the gap. Self-entered data never corroborates a connector or itself — only a second independently-operated source makes something "Verified".
2c. If a connector is marked NEEDS RE-AUTH above, treat every figure that depends on it as stale/unverified, say so plainly, and make reconnecting it one of this week's actions.
3. Lead with the single most urgent issue, if any real risk shows up in the data above — otherwise say plainly that nothing is flagged this period rather than manufacturing urgency.
4. Call out specific numbers from the data above, not generic advice.
5. Flag cash risk, receivables risk, or GST/ITC leakage explicitly if the numbers warrant it.
6. Never call the Pulse Score a "credit score" — it's an operating/financial health score, not a lending decision.
7. End with 2-3 concrete, specific actions for this week — not generic "monitor your cash flow" advice; name the actual invoice, metric, or figure to act on where the data makes that obvious.
8. No preamble like "Here is your briefing." Start directly with the content. Plain language, no markdown headers, no bullet walls unless the content genuinely calls for a short list.
9. Keep total length under 220 words.`;

  // A "judge" job (medium reasoning): once a day at most, and it has to pick
  // the single most urgent thing out of every source — worth thinking about,
  // cheap because it's rare. max_tokens leaves room for that reasoning on
  // top of the ~220-word briefing; only tokens actually used are billed.
  try {
    const data = await callClaude({
      label: 'briefing', job: 'judge', apiKey,
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    const briefing = textOf(data) || 'No briefing text returned.';

    res.status(200).json({ briefing });
  } catch (err) {
    if (err && err.status) {
      console.error('Anthropic API error:', err.status, err.body);
      res.status(502).json({ error: 'AI service error' });
      return;
    }
    console.error('generate-briefing error:', err);
    res.status(500).json({ error: `Failed to reach Anthropic API: ${err.message}` });
  }
}
