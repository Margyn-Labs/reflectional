/**
 * api/_lib/jev.js
 * Client for TypeSafe AI's Jev (a "System One" model: typed probabilities, no
 * text). Added 2026-09-30. Design and rules: SPEC-JEV-2026-09-30.md.
 *
 *   OFF BY DEFAULT. JEV_MODE_<JOB> = off | shadow | live (e.g. JEV_MODE_ROUTER).
 *   Needs JEV_API_KEY. Fail-open: any error, timeout or rate limit returns
 *   null and the caller uses its existing path, so turning this on can never
 *   make a feature worse than today.
 *
 * Jev picks from closed lists. It never returns amounts or dates, never
 * decides a write, and its answers still pass the existing checks and the
 * confirm card. See the spec for why (it can't do arithmetic, can be
 * prompt-injected, and can't write text).
 *
 * Zero-npm: plain fetch(), CommonJS.
 */

const URL_SYSTEM_ONE = process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.JEV_MODEL || 'jev-latest';
const DEFAULT_TIMEOUT_MS = 2000;

/* ---------- question builders (wire format from docs.typesafe.ai/api) ---------- */
const Choice = (instructions, criteria) => {
  const n = Object.keys(criteria || {}).length;
  if (n < 2 || n > 255) throw new Error('Choice needs 2 to 255 options, got ' + n);
  return { type: 'choice', instructions, criteria };
};
const Score = (instructions, criteria) => {
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) throw new Error('Score needs 2 to 10 levels');
  return { type: 'score', instructions, criteria };
};
const Noul = (instructions, criteria) =>
  ({ type: 'noul', instructions, criteria: criteria || { true: 'The statement is true.', false: 'The statement is false.' } });

/* ---------- switches ---------- */
function modeFor(job) {
  if (!process.env.JEV_API_KEY) return 'off';
  const m = String(process.env['JEV_MODE_' + String(job).toUpperCase()] || 'off').toLowerCase();
  return m === 'shadow' || m === 'live' ? m : 'off';
}

/* ---------- minimise what leaves us ---------- */
/**
 * Replace identifiers with stable tokens before anything is sent. The map
 * stays with the caller; nothing here is reversible by the vendor.
 * `parties` = known names to tokenise (PARTY_1...). Amounts are left as text
 * only because Jev is told never to compute on them; pass amountless state
 * where you can.
 */
function redact(text, { parties = [] } = {}) {
  const map = {};
  let n = { PARTY: 0, GSTIN: 0, PHONE: 0, EMAIL: 0, ACCT: 0 };
  const put = (kind, val) => {
    const hit = Object.keys(map).find((k) => map[k] === val && k.startsWith(kind));
    if (hit) return hit;
    const tok = kind + '_' + (++n[kind]);
    map[tok] = val;
    return tok;
  };
  let out = String(text == null ? '' : text);
  out = out.replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, (m) => put('GSTIN', m));
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => put('EMAIL', m));
  out = out.replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g, (m) => put('PHONE', m));
  out = out.replace(/(?<!\d)\d{9,18}(?!\d)/g, (m) => put('ACCT', m));
  for (const name of [...parties].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, () => put('PARTY', name));
  }
  return { text: out, map };
}

/* ---------- the call ---------- */
/**
 * @returns {Promise<null | { answers, usage, model, ms }>} null on any failure.
 */
async function systemOne(state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const key = process.env.JEV_API_KEY;
  if (!key) return null;
  const f = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await f(URL_SYSTEM_ONE, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: ctl.signal
    });
    if (!res.ok) { console.error('[jev] HTTP', res.status); return null; }
    const j = await res.json();
    if (!j || typeof j.answers !== 'object' || !j.answers) return null;
    return { answers: j.answers, usage: j.usage || {}, model: j.model || null, ms: Date.now() - t0 };
  } catch (e) {
    console.error('[jev] call failed:', e && e.name === 'AbortError' ? 'timeout' : e && e.message);
    return null;
  } finally { clearTimeout(timer); }
}

/* ---------- reading answers ---------- */
/** The winning label, only if its confidence clears `min`. Otherwise null. */
function pick(res, name, min) {
  const a = res && res.answers && res.answers[name];
  if (!a || a.type !== 'choice' || typeof a.confidence !== 'number') return null;
  return a.confidence >= min ? a.choice : null;
}
/** true / false only when the probability is decisively one way; null when unsure. */
function yesNo(res, name, { high = 0.85, low = 0.15 } = {}) {
  const a = res && res.answers && res.answers[name];
  if (!a || a.type !== 'noul' || typeof a.noul !== 'number') return null;
  return a.noul >= high ? true : a.noul <= low ? false : null;
}

/* ---------- the cascade ---------- */
/**
 * Run Jev ahead of the existing path.
 *   off    -> fallback() only.
 *   shadow -> fallback() decides; Jev runs beside it and onShadow(res, result) records both.
 *   live   -> if decide(res) returns a value (not undefined/null) use it, else fallback().
 * Returns { source: 'jev' | 'fallback', value, jev }.
 */
async function jevCascade({ job, state, questions, decide, fallback, onShadow, timeoutMs, fetchImpl }) {
  const mode = modeFor(job);
  if (mode === 'off') return { source: 'fallback', value: await fallback(), jev: null };

  if (mode === 'shadow') {
    const [res, value] = await Promise.all([systemOne(state, questions, { timeoutMs, fetchImpl }), fallback()]);
    if (onShadow) { try { await onShadow(res, value); } catch (e) { console.error('[jev] onShadow failed:', e.message); } }
    return { source: 'fallback', value, jev: res };
  }

  const res = await systemOne(state, questions, { timeoutMs, fetchImpl });
  if (res) {
    let v;
    try { v = decide(res); } catch (e) { v = undefined; }
    if (v !== undefined && v !== null) return { source: 'jev', value: v, jev: res };
  }
  return { source: 'fallback', value: await fallback(), jev: res };
}

module.exports = { Choice, Score, Noul, modeFor, redact, systemOne, pick, yesNo, jevCascade };
