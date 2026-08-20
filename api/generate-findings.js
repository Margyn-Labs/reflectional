// api/generate-findings.js
// The "next level" Findings pipeline — replaces the old client-side,
// hardcoded-corroborator-map version. Runs server-side, triggered right
// after a snapshot is saved (fire-and-forget from app.html), so findings
// are already sitting in the `findings` table by the time anyone opens
// the panel — no click-triggered API call, no wait.
//
// Division of labor, kept strict on purpose:
//   - JS builds the evidence sheet (multi-snapshot deltas across vitals,
//     Razorpay, Shopify, and the ledger) — all arithmetic happens here.
//   - Claude looks at the WHOLE evidence sheet at once and proposes
//     candidate findings + which other metrics corroborate each one, in
//     structured JSON. This is real correlation discovery, not a lookup
//     table of 3 hardcoded pairs.
//   - JS then validates every single claim against the evidence sheet
//     before it's ever allowed to be labeled "verified": the cited
//     corroborator must actually exist, must come from an independently
//     operated source (Razorpay or Shopify, never another vital derived
//     from the same underlying inputs), and must show a real, non-null
//     move. Anything that fails this check is downgraded to "signal" or
//     dropped — the model's self-reported confidence is never trusted
//     on its own.
//
// Zero-npm: plain fetch() to both Supabase's REST API and Anthropic's.

import { splitValue, numericFromVitalValue, numDelta, computePaymentsMetrics } from './_lib/vitals-utils.js';

const SUPABASE_URL = 'https://lmegnxrixlrvyodqfthn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TcTCDSECsRxbDVXAnI893w_3BJC0Kgh';
const SNAPSHOT_WINDOW = 5;          // how many past snapshots feed the evidence sheet
const VITAL_MATERIALITY_PTS = 8;    // min |score delta| (out of 100) for a vital to become a candidate finding
const CORROBORATOR_MATERIALITY_PCT = 10; // min |% change| for a Razorpay/Shopify metric to count as real movement
const INDEPENDENT_SOURCES = ['razorpay', 'shopify', 'razorpay_live']; // razorpay_live is real per-transaction data — the only one of these that's never self-reported
// Separate from ASK_MARGYN_MODEL on purpose — this endpoint does harder
// work (scanning the whole evidence menu, discovering real correlations,
// producing valid structured JSON), so it's worth being able to keep
// this one on a stronger model even if the chat narration is switched
// to something cheaper. Set FINDINGS_MODEL in Vercel to override.
const FINDINGS_MODEL = process.env.FINDINGS_MODEL || 'claude-sonnet-5';

// These are the only three `snapshots.source` values that exist in the
// schema today — every one of them is a human typing or uploading a
// number, never a live API sync. A future connector-sync path would
// write some other value here; until one exists, EVERY snapshot is
// self-reported, and no finding should ever be allowed to claim
// "Verified" on the strength of two numbers the same person typed into
// the same form in the same sitting. This is a real, load-bearing
// distinction, not a cosmetic label — see the deploy notes.
const SELF_REPORTED_SOURCES = ['manual', 'upload', 'ledger'];
function isSelfReported(source) { return SELF_REPORTED_SOURCES.includes(source); }

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!accessToken) { res.status(401).json({ error: 'Missing access token' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); res.status(500).json({ error: 'Server not configured' }); return; }

  try {
    const user = await sbAuthGet('/auth/v1/user', accessToken);
    if (!user || !user.id) { res.status(401).json({ error: 'Invalid session' }); return; }
    const userId = user.id;

    const snapshots = await sbGet(`/rest/v1/snapshots?select=*&order=created_at.desc&limit=${SNAPSHOT_WINDOW}`, accessToken);
    if (!snapshots.length) { res.status(200).json({ findings: [] }); return; }

    const [receivables, payables] = await Promise.all([
      sbGet(`/rest/v1/receivables?select=*&status=eq.open`, accessToken),
      sbGet(`/rest/v1/payables?select=*&status=eq.open`, accessToken)
    ]);

    // Real, itemized Razorpay data — a genuinely independent source, not a
    // self-reported rollup. Capped at the last 1000 transactions / 300
    // settlements / 300 refunds so this stays a bounded read even on an
    // account with real volume; empty on a sandbox with no transactions
    // yet, which the aggregator below handles without erroring.
    const [rpTransactions, rpSettlements, rpRefunds] = await Promise.all([
      sbGet(`/rest/v1/razorpay_transactions?select=*&order=created_at.desc&limit=1000`, accessToken).catch(() => []),
      sbGet(`/rest/v1/razorpay_settlements?select=*&order=created_at.desc&limit=300`, accessToken).catch(() => []),
      sbGet(`/rest/v1/razorpay_refunds?select=*&order=created_at.desc&limit=300`, accessToken).catch(() => [])
    ]);
    const razorpayLive = aggregateRazorpayLive(rpTransactions, rpSettlements, rpRefunds);

    const evidence = buildEvidenceSheet(snapshots, receivables, payables, razorpayLive);
    if (!evidence.metrics.some(m => m.material)) {
      // Nothing moved enough to be worth asking the model at all — save the round trip.
      await insertFindings(userId, snapshots[0].id, accessToken, []);
      res.status(200).json({ findings: [] });
      return;
    }

    const claims = await askClaudeForFindings(evidence, apiKey);
    const validated = claims.map(c => validateFinding(c, evidence)).filter(Boolean).slice(0, 3);
    const rows = await insertFindings(userId, snapshots[0].id, accessToken, validated);
    res.status(200).json({ findings: rows });
  } catch (err) {
    console.error('generate-findings error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
}

/* ---------- Supabase REST helpers (plain fetch, RLS-scoped via the user's own token) ---------- */

async function sbGet(path, accessToken) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!r.ok) throw new Error('Supabase GET ' + path + ' failed: ' + r.status);
  return r.json();
}

async function sbAuthGet(path, accessToken) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!r.ok) return null;
  return r.json();
}

async function insertFindings(userId, snapshotId, accessToken, findings) {
  // Append-only: past findings stay in the table, tagged by the snapshot
  // that produced them. The live cards UI filters to the latest
  // snapshot's batch; the History tab and Margyn's own historical
  // context both read the full table. Nothing is ever deleted here.
  if (!findings.length) return [];
  const rows = findings.map(f => ({
    user_id: userId, snapshot_id: snapshotId, vital: f.vital, tier: f.tier, self_reported: !!f.selfReported,
    headline: f.headline, summary: f.summary, narration: f.narration,
    suggested_action: f.suggestedAction || null, evidence: f.evidenceUsed || null
  }));
  const r = await fetch(SUPABASE_URL + '/rest/v1/findings', {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) { console.error('findings insert failed:', await r.text()); return []; }
  return r.json();
}

/* ---------- evidence sheet: every number the model is allowed to reference, tagged with its source ---------- */

/* ---------- real Razorpay data, from razorpay_transactions/settlements/refunds ----------
   Unlike the snapshot-derived "razorpay" rollup (which can be typed by
   hand in the manual entry form — see SELF_REPORTED_SOURCES above), this
   comes exclusively from sync-razorpay.js's actual calls to the Razorpay
   API. It is never self-reported, by construction — so once an account
   has real transaction volume, this is a genuine second source and can
   support a real "Verified" tier on its own, independent of whatever the
   snapshot's own provenance says. Empty on an account with no synced
   transactions yet (a fresh connection, or a sandbox key with no
   activity) — every reducer below is written to produce nothing rather
   than throw when the arrays are empty. */
function aggregateRazorpayLive(transactions, settlements, refunds) {
  const captured = transactions.filter(t => t.status === 'captured');
  if (transactions.length < 4) return null; // too little real volume to say anything meaningful yet

  const mid = Math.floor(transactions.length / 2);
  // transactions are already ordered newest-first from the query
  const newerHalf = transactions.slice(0, mid);
  const olderHalf = transactions.slice(mid);

  function statsFor(txns) {
    const cap = txns.filter(t => t.status === 'captured');
    const avgTicket = cap.length ? cap.reduce((s, t) => s + Number(t.amount || 0), 0) / cap.length / 100 : null;
    const failRate = txns.length ? (txns.filter(t => t.status === 'failed').length / txns.length) * 100 : null;
    return { avgTicket, failRate, count: txns.length };
  }
  const newer = statsFor(newerHalf), older = statsFor(olderHalf);

  const methodCounts = {};
  transactions.forEach(t => { const m = t.method || 'unknown'; methodCounts[m] = (methodCounts[m] || 0) + 1; });
  const topMethod = Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0];

  const refundRate = captured.length ? (refunds.length / captured.length) * 100 : null;

  const lagDays = settlements
    .filter(s => s.created_at && s.processed_at)
    .map(s => (new Date(s.processed_at) - new Date(s.created_at)) / (1000 * 60 * 60 * 24));
  const avgLag = lagDays.length ? lagDays.reduce((a, b) => a + b, 0) / lagDays.length : null;

  return {
    txnCount: transactions.length,
    avgTicket: newer.avgTicket,
    avgTicketTrend: (newer.avgTicket !== null && older.avgTicket !== null) ? numDelta(newer.avgTicket, older.avgTicket) : null,
    failRate: newer.failRate,
    failRateTrend: (newer.failRate !== null && older.failRate !== null) ? numDelta(newer.failRate, older.failRate) : null,
    refundRate,
    topMethod: topMethod ? topMethod[0] + ' ' + Math.round((topMethod[1] / transactions.length) * 100) + '%' : null,
    avgSettlementLagDays: avgLag
  };
}

function buildEvidenceSheet(snapshots, receivables, payables, razorpayLive) {
  // snapshots[0] is newest. Build a per-vital series across the window,
  // plus a Razorpay series (only where payments_data exists) and a
  // Shopify series (only where shopify_orders_data exists).
  const ordered = snapshots.slice().reverse(); // oldest → newest, easier to reason about as a timeline
  const metrics = [];

  const vitalLabels = (ordered[ordered.length - 1].vitals || []).map(v => v.label);
  vitalLabels.forEach(label => {
    const series = ordered.map(s => {
      const v = (s.vitals || []).find(x => x.label === label);
      return v ? { score: Math.round(v.score || 0), value: v.value, numeric: numericFromVitalValue(v.value), selfReported: isSelfReported(s.source) } : null;
    }).filter(Boolean);
    if (series.length < 2) return;
    const first = series[0], last = series[series.length - 1];
    const scoreDelta = last.score - first.score;
    const nd = numDelta(last.numeric, first.numeric);
    metrics.push({
      key: 'vital:' + label, label, source: 'vitals',
      delta: scoreDelta, pctChange: nd.pctChange,
      material: Math.abs(scoreDelta) >= VITAL_MATERIALITY_PTS,
      selfReported: first.selfReported || last.selfReported,
      valueText: last.value + ' now, was ' + first.value + ' ' + (ordered.length - 1) + ' snapshot(s) ago (score ' + (scoreDelta >= 0 ? '+' : '') + scoreDelta + ' pts' + (nd.pctChange !== null ? ', ' + (nd.pctChange >= 0 ? '+' : '') + nd.pctChange.toFixed(1) + '%' : '') + ')'
    });
  });

  const paySeries = ordered.map(s => s.payments_data ? { m: computePaymentsMetrics(s.payments_data), selfReported: isSelfReported(s.source) } : null);
  const payPairs = [['failRate', 'Razorpay failed-payment rate'], ['mdrPct', 'Razorpay MDR'], ['lag', 'Razorpay settlement lag'], ['gross', 'Razorpay gross processed']];
  payPairs.forEach(([field, label]) => {
    const points = paySeries.filter(Boolean);
    if (points.length < 2) return;
    const series = points.map(p => p.m[field]);
    const nd = numDelta(series[series.length - 1], series[0]);
    if (nd.pctChange === null) return;
    metrics.push({
      key: 'razorpay:' + field, label, source: 'razorpay',
      delta: nd.delta, pctChange: nd.pctChange,
      material: Math.abs(nd.pctChange) >= CORROBORATOR_MATERIALITY_PCT,
      selfReported: points[0].selfReported || points[points.length - 1].selfReported,
      valueText: label + ' ' + (nd.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(nd.pctChange).toFixed(1) + '% over the last ' + (ordered.length - 1) + ' snapshot(s)'
    });
  });

  const shopLabels = new Set();
  ordered.forEach(s => (s.shopify_orders_data || []).forEach(r => shopLabels.add(r.label)));
  shopLabels.forEach(label => {
    const series = ordered.map(s => {
      const row = (s.shopify_orders_data || []).find(r => r.label === label);
      return row ? { value: Number(row.value), selfReported: isSelfReported(s.source) } : null;
    }).filter(v => v !== null);
    if (series.length < 2) return;
    const nd = numDelta(series[series.length - 1].value, series[0].value);
    if (nd.pctChange === null) return;
    metrics.push({
      key: 'shopify:' + label, label: 'Shopify — ' + label, source: 'shopify',
      delta: nd.delta, pctChange: nd.pctChange,
      material: Math.abs(nd.pctChange) >= CORROBORATOR_MATERIALITY_PCT,
      selfReported: series[0].selfReported || series[series.length - 1].selfReported,
      valueText: 'Shopify ' + label + ' ' + (nd.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(nd.pctChange).toFixed(1) + '% over the last ' + (ordered.length - 1) + ' snapshot(s)'
    });
  });

  if (razorpayLive) {
    if (razorpayLive.avgTicketTrend && razorpayLive.avgTicketTrend.pctChange !== null) {
      metrics.push({
        key: 'razorpay_live:avgTicket', label: 'Razorpay avg. transaction value (real data)', source: 'razorpay_live',
        delta: razorpayLive.avgTicketTrend.delta, pctChange: razorpayLive.avgTicketTrend.pctChange,
        material: Math.abs(razorpayLive.avgTicketTrend.pctChange) >= CORROBORATOR_MATERIALITY_PCT, selfReported: false,
        valueText: 'Avg. transaction ₹' + Math.round(razorpayLive.avgTicket) + ', ' + (razorpayLive.avgTicketTrend.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(razorpayLive.avgTicketTrend.pctChange).toFixed(1) + '% vs the earlier half of the synced window (from ' + razorpayLive.txnCount + ' real transactions)'
      });
    }
    if (razorpayLive.failRateTrend && razorpayLive.failRateTrend.pctChange !== null) {
      metrics.push({
        key: 'razorpay_live:failRate', label: 'Razorpay failed-payment rate (real data)', source: 'razorpay_live',
        delta: razorpayLive.failRateTrend.delta, pctChange: razorpayLive.failRateTrend.pctChange,
        material: Math.abs(razorpayLive.failRateTrend.pctChange) >= CORROBORATOR_MATERIALITY_PCT, selfReported: false,
        valueText: 'Failed-payment rate ' + razorpayLive.failRate.toFixed(1) + '%, ' + (razorpayLive.failRateTrend.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(razorpayLive.failRateTrend.pctChange).toFixed(1) + '% vs the earlier half of the synced window (from ' + razorpayLive.txnCount + ' real transactions)'
      });
    }
  }

  const ledgerPairs = [['recv_total', 'Total receivables'], ['recv_90', 'Receivables over 90 days'], ['pay_soon', 'Payables due in 30 days']];
  ledgerPairs.forEach(([field, label]) => {
    const series = ordered.map(s => Number(s[field])).filter(v => !isNaN(v));
    if (series.length < 2) return;
    const nd = numDelta(series[series.length - 1], series[0]);
    if (nd.pctChange === null) return;
    metrics.push({
      key: 'ledger:' + field, label, source: 'ledger',
      delta: nd.delta, pctChange: nd.pctChange,
      material: Math.abs(nd.pctChange) >= CORROBORATOR_MATERIALITY_PCT,
      valueText: label + ' ' + (nd.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(nd.pctChange).toFixed(1) + '% over the last ' + (ordered.length - 1) + ' snapshot(s)'
    });
  });

  const topReceivables = receivables.slice().sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 3)
    .map(r => r.party_name + ' ₹' + Math.round(Number(r.amount)));
  const topPayables = payables.slice().sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 3)
    .map(p => p.party_name + ' ₹' + Math.round(Number(p.amount)));

  return { metrics, windowSize: ordered.length, topReceivables, topPayables };
}

/* ---------- Claude call: structured JSON, correlation discovery over the whole evidence sheet ---------- */

async function askClaudeForFindings(evidence, apiKey) {
  const menu = evidence.metrics
    .map(m => `- key: "${m.key}" | label: ${m.label} | source: ${m.source} | ${m.valueText}${m.material ? ' [MATERIAL MOVE]' : ''}${m.selfReported ? ' [SELF-REPORTED]' : ''}`)
    .join('\n');

  const system = `You are Margyn's Findings analyst. You will be given a menu of financial metrics for one business, each tagged with a "source" (vitals, razorpay, shopify, razorpay_live, or ledger), marked [MATERIAL MOVE] if it changed enough to matter, and marked [SELF-REPORTED] if the number came from someone typing or uploading it by hand rather than a live, independently-operated data sync. "razorpay_live" specifically means real per-transaction Razorpay data — always genuinely independent, never self-reported.

Your job: identify up to 3 findings. A finding's primaryMetric MUST be a vital (source: "vitals") marked [MATERIAL MOVE] — never propose a finding whose primary metric isn't in that list. For each finding, look across the ENTIRE menu for other metrics that plausibly explain or corroborate the move — a corroborator is only meaningful if it comes from a DIFFERENT source than "vitals" (i.e. source "razorpay", "shopify", or "razorpay_live") and is itself a real, cited entry from the menu. Never invent a metric key that isn't on the menu. If nothing on the menu plausibly corroborates a material vital move, still report the finding with an empty corroborators array — don't force a connection that isn't there.

Important honesty rule: if the primary metric or any corroborator you cite is marked [SELF-REPORTED], your narration must say plainly that this reading (or that part of it) comes from manually entered or uploaded data, not a live connector sync — even if you still think it's worth flagging. Never describe two self-reported numbers as independently confirming each other; a person typing two numbers into the same form isn't two sources agreeing, it's one source twice.

Output ONLY valid JSON, no prose before or after, matching exactly:
{"findings":[{"primaryMetric":"<exact key from menu>","corroborators":["<exact key from menu>", ...],"summary":"<one line, under 20 words, plain language>","narration":"<2-4 sentences, plain language, explaining the likely mechanism>","suggestedAction":"<one concrete, specific next step>"}]}

If there is truly nothing worth flagging, output {"findings":[]}.`;

  const user = `Metric menu (window: last ${evidence.windowSize} snapshots):\n${menu}\n\nLargest open receivables: ${evidence.topReceivables.join('; ') || 'none'}\nLargest open payables: ${evidence.topPayables.join('; ') || 'none'}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: FINDINGS_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: user }] })
  });
  if (!r.ok) { console.error('Anthropic error:', r.status, await r.text()); return []; }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch (e) {
    console.error('Could not parse findings JSON:', text);
    return [];
  }
}

/* ---------- deterministic validation: the model's tier claim is never trusted on its own ---------- */

function validateFinding(claim, evidence) {
  if (!claim || typeof claim.primaryMetric !== 'string') return null;
  const primary = evidence.metrics.find(m => m.key === claim.primaryMetric);
  if (!primary || primary.source !== 'vitals' || !primary.material) return null; // must be a real, material vital

  const corroboratorKeys = Array.isArray(claim.corroborators) ? claim.corroborators : [];
  const validCorroborators = corroboratorKeys
    .map(k => evidence.metrics.find(m => m.key === k))
    // The core fix: a self-reported number can never count as independent
    // corroboration, no matter how well it lines up. Someone typing two
    // figures into the same form isn't two sources agreeing — it's one
    // source, twice. Until a real connector-sync path exists, this
    // correctly means every finding lands on Signal, not Verified.
    .filter(m => m && INDEPENDENT_SOURCES.includes(m.source) && m.material && !m.selfReported);

  const direction = primary.delta >= 0 ? 'up' : 'down';
  const headline = primary.label + ' ' + direction + (primary.pctChange !== null ? ' ' + Math.abs(primary.pctChange).toFixed(1) + '%' : '');

  return {
    vital: primary.label,
    tier: validCorroborators.length > 0 ? 'verified' : 'signal',
    selfReported: primary.selfReported,
    headline,
    summary: typeof claim.summary === 'string' && claim.summary.trim() ? claim.summary.trim().slice(0, 200) : primary.valueText,
    narration: typeof claim.narration === 'string' && claim.narration.trim() ? claim.narration.trim().slice(0, 800) : primary.valueText,
    suggestedAction: typeof claim.suggestedAction === 'string' ? claim.suggestedAction.trim().slice(0, 300) : null,
    evidenceUsed: { primary: primary.key, corroborators: validCorroborators.map(m => m.key) }
  };
}
