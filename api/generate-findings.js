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
const INDEPENDENT_SOURCES = ['razorpay', 'shopify']; // the only sources that count as a genuine second source today

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

    const evidence = buildEvidenceSheet(snapshots, receivables, payables);
    if (!evidence.metrics.some(m => m.material)) {
      // Nothing moved enough to be worth asking the model at all — save the round trip.
      await replaceFindings(userId, snapshots[0].id, accessToken, []);
      res.status(200).json({ findings: [] });
      return;
    }

    const claims = await askClaudeForFindings(evidence, apiKey);
    const validated = claims.map(c => validateFinding(c, evidence)).filter(Boolean).slice(0, 3);
    const rows = await replaceFindings(userId, snapshots[0].id, accessToken, validated);
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

async function replaceFindings(userId, snapshotId, accessToken, findings) {
  // Delete-then-insert rather than update-in-place: each generation pass
  // is a full, self-consistent batch, not a patch on top of stale rows.
  await fetch(SUPABASE_URL + '/rest/v1/findings?user_id=eq.' + userId, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!findings.length) return [];
  const rows = findings.map(f => ({
    user_id: userId, snapshot_id: snapshotId, vital: f.vital, tier: f.tier,
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

function buildEvidenceSheet(snapshots, receivables, payables) {
  // snapshots[0] is newest. Build a per-vital series across the window,
  // plus a Razorpay series (only where payments_data exists) and a
  // Shopify series (only where shopify_orders_data exists).
  const ordered = snapshots.slice().reverse(); // oldest → newest, easier to reason about as a timeline
  const metrics = [];

  const vitalLabels = (ordered[ordered.length - 1].vitals || []).map(v => v.label);
  vitalLabels.forEach(label => {
    const series = ordered.map(s => {
      const v = (s.vitals || []).find(x => x.label === label);
      return v ? { score: Math.round(v.score || 0), value: v.value, numeric: numericFromVitalValue(v.value) } : null;
    }).filter(Boolean);
    if (series.length < 2) return;
    const first = series[0], last = series[series.length - 1];
    const scoreDelta = last.score - first.score;
    const nd = numDelta(last.numeric, first.numeric);
    metrics.push({
      key: 'vital:' + label, label, source: 'vitals',
      delta: scoreDelta, pctChange: nd.pctChange,
      material: Math.abs(scoreDelta) >= VITAL_MATERIALITY_PTS,
      valueText: last.value + ' now, was ' + first.value + ' ' + (ordered.length - 1) + ' snapshot(s) ago (score ' + (scoreDelta >= 0 ? '+' : '') + scoreDelta + ' pts' + (nd.pctChange !== null ? ', ' + (nd.pctChange >= 0 ? '+' : '') + nd.pctChange.toFixed(1) + '%' : '') + ')'
    });
  });

  const paySeries = ordered.map(s => s.payments_data ? computePaymentsMetrics(s.payments_data) : null);
  const payPairs = [['failRate', 'Razorpay failed-payment rate'], ['mdrPct', 'Razorpay MDR'], ['lag', 'Razorpay settlement lag'], ['gross', 'Razorpay gross processed']];
  payPairs.forEach(([field, label]) => {
    const series = paySeries.filter(Boolean).map(m => m[field]);
    if (series.length < 2) return;
    const nd = numDelta(series[series.length - 1], series[0]);
    if (nd.pctChange === null) return;
    metrics.push({
      key: 'razorpay:' + field, label, source: 'razorpay',
      delta: nd.delta, pctChange: nd.pctChange,
      material: Math.abs(nd.pctChange) >= CORROBORATOR_MATERIALITY_PCT,
      valueText: label + ' ' + (nd.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(nd.pctChange).toFixed(1) + '% over the last ' + (ordered.length - 1) + ' snapshot(s)'
    });
  });

  const shopLabels = new Set();
  ordered.forEach(s => (s.shopify_orders_data || []).forEach(r => shopLabels.add(r.label)));
  shopLabels.forEach(label => {
    const series = ordered.map(s => {
      const row = (s.shopify_orders_data || []).find(r => r.label === label);
      return row ? Number(row.value) : null;
    }).filter(v => v !== null);
    if (series.length < 2) return;
    const nd = numDelta(series[series.length - 1], series[0]);
    if (nd.pctChange === null) return;
    metrics.push({
      key: 'shopify:' + label, label: 'Shopify — ' + label, source: 'shopify',
      delta: nd.delta, pctChange: nd.pctChange,
      material: Math.abs(nd.pctChange) >= CORROBORATOR_MATERIALITY_PCT,
      valueText: 'Shopify ' + label + ' ' + (nd.pctChange >= 0 ? 'up' : 'down') + ' ' + Math.abs(nd.pctChange).toFixed(1) + '% over the last ' + (ordered.length - 1) + ' snapshot(s)'
    });
  });

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
    .map(m => `- key: "${m.key}" | label: ${m.label} | source: ${m.source} | ${m.valueText}${m.material ? ' [MATERIAL MOVE]' : ''}`)
    .join('\n');

  const system = `You are Margyn's Findings analyst. You will be given a menu of financial metrics for one business, each tagged with a "source" (vitals, razorpay, shopify, or ledger) and marked [MATERIAL MOVE] if it changed enough to matter.

Your job: identify up to 3 findings. A finding's primaryMetric MUST be a vital (source: "vitals") marked [MATERIAL MOVE] — never propose a finding whose primary metric isn't in that list. For each finding, look across the ENTIRE menu for other metrics that plausibly explain or corroborate the move — a corroborator is only meaningful if it comes from a DIFFERENT source than "vitals" (i.e. source "razorpay" or "shopify") and is itself a real, cited entry from the menu. Never invent a metric key that isn't on the menu. If nothing on the menu plausibly corroborates a material vital move, still report the finding with an empty corroborators array — don't force a connection that isn't there.

Output ONLY valid JSON, no prose before or after, matching exactly:
{"findings":[{"primaryMetric":"<exact key from menu>","corroborators":["<exact key from menu>", ...],"summary":"<one line, under 20 words, plain language>","narration":"<2-4 sentences, plain language, explaining the likely mechanism>","suggestedAction":"<one concrete, specific next step>"}]}

If there is truly nothing worth flagging, output {"findings":[]}.`;

  const user = `Metric menu (window: last ${evidence.windowSize} snapshots):\n${menu}\n\nLargest open receivables: ${evidence.topReceivables.join('; ') || 'none'}\nLargest open payables: ${evidence.topPayables.join('; ') || 'none'}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 900, system, messages: [{ role: 'user', content: user }] })
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
    .filter(m => m && INDEPENDENT_SOURCES.includes(m.source) && m.material);

  const direction = primary.delta >= 0 ? 'up' : 'down';
  const headline = primary.label + ' ' + direction + (primary.pctChange !== null ? ' ' + Math.abs(primary.pctChange).toFixed(1) + '%' : '');

  return {
    vital: primary.label,
    tier: validCorroborators.length > 0 ? 'verified' : 'signal',
    headline,
    summary: typeof claim.summary === 'string' && claim.summary.trim() ? claim.summary.trim().slice(0, 200) : primary.valueText,
    narration: typeof claim.narration === 'string' && claim.narration.trim() ? claim.narration.trim().slice(0, 800) : primary.valueText,
    suggestedAction: typeof claim.suggestedAction === 'string' ? claim.suggestedAction.trim().slice(0, 300) : null,
    evidenceUsed: { primary: primary.key, corroborators: validCorroborators.map(m => m.key) }
  };
}
