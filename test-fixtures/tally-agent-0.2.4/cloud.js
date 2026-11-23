/**
 * cloud.js — talk to Margyn's cloud API (api/tally.js router).
 *
 * Uses the global fetch() available in Node 18+. Zero dependencies.
 */

// Margyn's replies carry `agent` directives (minimum version, one-off commands). Whoever runs the
// agent (the desktop app) subscribes here; the CLI ignores them.
let directiveListener = null;
function onDirective(fn) { directiveListener = typeof fn === 'function' ? fn : null; }

async function apiFetch(base, action, { method = 'POST', body, bearer } = {}) {
  const url = `${base}/api/tally?action=${encodeURIComponent(action)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(`Could not reach Margyn cloud at ${base} (${e.message})`);
  }

  let data = {};
  try { data = await res.json(); } catch (e) { /* leave {} */ }

  if (!res.ok) {
    const msg = data.message || data.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  if (data && data.agent && directiveListener) { try { directiveListener(data.agent); } catch (e) { /* never break a sync */ } }
  return data;
}

/** Retry transient cloud failures (network blips, 5xx, Vercel cold starts); never retry a 4xx. */
async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = !e.status || e.status >= 500;
      if (!transient || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(3, i)));
    }
  }
}

module.exports = {
  onDirective,
  pairComplete: (base, payload) => apiFetch(base, 'pair-complete', { body: payload }),
  ingest: (base, bearer, payload) => withRetry(() => apiFetch(base, 'ingest', { bearer, body: payload })),
  health: (base, bearer, payload) => apiFetch(base, 'health', { bearer, body: payload })
};
