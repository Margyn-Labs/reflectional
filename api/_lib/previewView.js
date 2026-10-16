// api/_lib/previewView.js — public view log for margynlabs.com/preview
// (the investor film page). Dispatched from api/ops.js?action=preview-view
// because there is no free function slot (12/12).
//
// Each investor gets their own link, e.g. /preview?ref=avijeet-shastra, and
// the page posts one row per milestone: open, play, half, end. Rows land in
// public.preview_views (sql/2026-10-16-preview-views.sql). Read them in
// Supabase → Table Editor → preview_views.
//
// Fail-open: tracking must never break the page, so every path answers 202.

const EVENTS = new Set(['open', 'play', 'half', 'end']);

function cleanRef(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60) || 'direct';
}

module.exports = async function previewView(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST.' }); return; }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const event = String((body && body.event) || '');
  if (!url || !key || !EVENTS.has(event)) { res.status(202).json({ ok: true }); return; }

  const h = req.headers || {};
  const row = {
    ref: cleanRef(body.ref),
    event,
    city: String(h['x-vercel-ip-city'] ? decodeURIComponent(h['x-vercel-ip-city']) : '').slice(0, 80) || null,
    country: String(h['x-vercel-ip-country'] || '').slice(0, 4) || null,
    user_agent: String(h['user-agent'] || '').slice(0, 300) || null
  };
  try {
    const r = await fetch(`${url}/rest/v1/preview_views`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) console.error('[preview-view] insert failed', r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error('[preview-view] insert error', err && err.message);
  }
  res.status(202).json({ ok: true });
};
