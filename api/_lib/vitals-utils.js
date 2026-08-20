// api/_lib/vitals-utils.js
// Pure math, ported 1:1 from app.html's client-side versions, so the
// server-side Findings pipeline computes deltas identically to what the
// UI itself would show. No npm, no side effects, no Supabase/Anthropic
// calls in this file — just numbers in, numbers out.
//
// Underscore-prefixed folder: Vercel does not turn files under api/_lib
// into routes, so this is safe to import from other api/*.js files.

export function splitValue(raw) {
  const i = String(raw).indexOf(' over ');
  return i === -1 ? { main: String(raw), suffix: '' } : { main: String(raw).slice(0, i), suffix: String(raw).slice(i + 1) };
}

export function numericFromVitalValue(raw) {
  const { main } = splitValue(raw);
  const cleaned = String(main).replace(/[₹,%\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function numDelta(cur, prev) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return { delta: null, pctChange: null };
  const delta = cur - prev;
  const pctChange = prev !== 0 ? (delta / Math.abs(prev)) * 100 : null;
  return { delta, pctChange };
}

export function computePaymentsMetrics(d) {
  const gross = Number(d.gross) || 0;
  const mdr = Number(d.mdr) || 0;
  const failed = Number(d.failed) || 0;
  const total = Number(d.total) || 0;
  const lag = Number(d.lag) || 0;
  const upiPct = Math.max(0, Math.min(100, Number(d.upiPct) || 0));
  const mdrPct = gross > 0 ? (mdr / gross) * 100 : 0;
  const failRate = total > 0 ? (failed / total) * 100 : 0;
  const netSettled = gross - mdr;
  const avgTxn = total > 0 ? gross / total : 0;
  return { gross, netSettled, avgTxn, mdrPct, failRate, lag, upiPct };
}
