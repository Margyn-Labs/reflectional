// api/waitlist.js
// Serverless function (Vercel Node runtime). Writes landing-page waitlist
// signups into Supabase using the SERVICE ROLE key, which never reaches the
// browser. Talks to Supabase's REST API directly — no npm dependency needed.
//
// Expects POST body:
//   { name, email, business_name, revenue_range, marketing_opt_in }
// Returns: { ok: true }
//
// Required env vars (Vercel → Settings → Environment Variables):
//   SUPABASE_URL           e.g. https://lmegnxrixlrvyodqfthn.supabase.co
//   SUPABASE_SERVICE_KEY   (or SUPABASE_SERVICE_ROLE_KEY — either is accepted)
//                          Supabase → Settings → API Keys → the sb_secret_... key
//
// NOTE: the service_role key bypasses Row Level Security. It must only ever
// live in server-side env vars. Never put it in any .html file.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  // Accept either name — some projects use SUPABASE_SERVICE_KEY, others
  // SUPABASE_SERVICE_ROLE_KEY. Whichever exists in Vercel is used.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
                  || process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    console.error('[waitlist] missing SUPABASE_URL or service key env var');
    res.status(500).json({
      error: 'Server is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) in Vercel → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const name = (body?.name || '').trim();
  const email = (body?.email || '').trim().toLowerCase();
  const business_name = (body?.business_name || '').trim();
  const revenue_range = (body?.revenue_range || '').trim();
  const marketing_opt_in = Boolean(body?.marketing_opt_in);

  if (!name || !email || !business_name) {
    res.status(400).json({ error: 'name, email and business_name are required.' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'That email address does not look valid.' });
    return;
  }

  try {
    // on_conflict + merge-duplicates => re-submitting the same email updates
    // the row instead of erroring on the unique index.
    const r = await fetch(`${url}/rest/v1/waitlist?on_conflict=email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ name, email, business_name, revenue_range, marketing_opt_in })
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error('[waitlist] supabase rejected insert:', r.status, detail);
      res.status(502).json({ error: 'Could not save your details. Please try again.' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[waitlist] request failed:', err);
    res.status(500).json({ error: 'Could not reach the database. Please try again.' });
  }
};
