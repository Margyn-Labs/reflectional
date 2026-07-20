// api/financing-lead.js
// Serverless function (Vercel Node runtime). Stores consented financing-
// interest leads via Supabase's REST API using the service role key, which
// bypasses RLS — financing_leads has no public policies, so this is the
// only write path. Matches the no-dependency style of api/briefing.js
// (plain fetch, no @supabase/supabase-js import needed).
//
// Referral-only, pre-LSP-agreement: this does NOT forward data to any
// lender. It just records consented interest for Margyn to follow up on
// manually until a lending partner is signed.
//
// Expects POST body:
// { user_id, company_name, email, phone, purpose, pulse_score, vitals,
//   eligibility_low, eligibility_high, consent, consent_text }
// Returns: { ok: true }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({
      error: 'Server is missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them in Vercel → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  const {
    user_id, company_name, email, phone, purpose,
    pulse_score, vitals, eligibility_low, eligibility_high,
    consent, consent_text
  } = req.body || {};

  if (!user_id || !email || consent !== true) {
    res.status(400).json({ error: 'Missing required fields or consent not given.' });
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/financing_leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        user_id,
        company_name: company_name || null,
        email,
        phone: phone || null,
        purpose: purpose || null,
        pulse_score: pulse_score ?? null,
        vitals: vitals || null,
        eligibility_low: eligibility_low ?? null,
        eligibility_high: eligibility_high ?? null,
        consent: true,
        consent_text: consent_text || null
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase insert failed (${response.status}): ${text}`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[margyn] financing-lead error:', err);
    res.status(500).json({ error: 'Could not save your interest. Try again.' });
  }
};
