// api/briefing.js
// Serverless function (Vercel Node runtime). Keeps the Anthropic API key
// server-side — the browser never sees it.
//
// Expects POST body: { vitals: {...}, pulseScore: number, companyName?: string }
// Returns: { briefing: string }

module.exports = async function handler(req, res) {
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { vitals, pulseScore, companyName } = body || {};

  if (!vitals) {
    res.status(400).json({ error: 'Missing "vitals" in request body.' });
    return;
  }

  const prompt = `You are a CFO advisor writing a short executive briefing for the CEO of an Indian SME.
Company: ${companyName || 'the company'}
Overall Pulse Score (0-100): ${pulseScore}

Financial vitals (computed from live data):
${JSON.stringify(vitals, null, 2)}

Write a plain-English executive briefing, 4-6 short paragraphs or tight bullet points, in the voice of a sharp
CFO advisor talking to a busy founder who is not a finance person. Rules:
- Lead with the single most urgent issue, if any.
- Call out specific numbers from the vitals above, not generic advice.
- Flag cash risk, receivables risk, or GST/ITC leakage explicitly if the numbers warrant it.
- End with 2-3 concrete, specific actions for this week — not generic "monitor your cash flow" advice.
- No preamble like "Here is your briefing." Start directly with the content.
- Keep total length under 220 words.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: `Anthropic API error: ${errText}` });
      return;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const briefing = textBlock ? textBlock.text : 'No briefing text returned.';

    res.status(200).json({ briefing });
  } catch (err) {
    res.status(500).json({ error: `Failed to reach Anthropic API: ${err.message}` });
  }
};
