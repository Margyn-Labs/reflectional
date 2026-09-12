// api/_lib/importMapper.js
// Shared core of the AI file-import parser — "where does each figure go".
// Used by BOTH producers:
//   - api/generate-findings.js  (browser upload: Excel/CSV/PDF/image, sync)
//   - api/whatsapp.js           (a registered number forwards a photo/PDF,
//                                 async — lands in import_suggestions)
//
// Division of labour is strict and identical for both callers: Claude only
// proposes a destination + confidence for each figure. It NEVER computes a
// total, and this file NEVER writes to any table — both callers own their
// own write path (the browser writes straight to receivables/payables/
// snapshots; WhatsApp writes one row to import_suggestions and waits for a
// human to approve it in the app).
//
// Written as CommonJS (module.exports / require) to match api/whatsapp.js
// and the rest of api/_lib/*.js. api/generate-findings.js is ESM, but Node's
// ESM loader can `import` a CJS module's module.exports as a default export
// — see the destructure at the top of that file.

const IMPORT_MODEL = process.env.IMPORT_MODEL || 'claude-sonnet-5';
const IMPORT_TARGETS = ['cash', 'revenue', 'net_profit', 'burn', 'gst_payable', 'gst_leak', 'receivable', 'payable', 'payments'];
const MAX_BASE64_LEN = 3_200_000; // ~2.3 MB raw — keep both producers' size caps consistent with this

const IMPORT_SYSTEM = `You are Margyn's import mapper. You receive EITHER a spreadsheet dump (first rows of each sheet) OR a single business document (invoice, bill, receipt, bank/GST statement). Identify the financial figures and map each to exactly one Margyn destination.

Everything is from the point of view of ONE business — "the user's business", named in the first user message. Every mapping decision depends on whose money it is.

Destinations (use the exact token in "target"):
- "cash"        the user's business's point-in-time bank / cash closing balance
- "revenue"     the user's business's period revenue / total sales / income
- "net_profit"  the user's business's period net profit / profit after tax
- "burn"        the user's business's period operating expenses / total costs
- "gst_payable" the user's business's NET GST payable for a whole tax period (from a GST return / GSTR-3B / P&L line — NOT the tax on one invoice)
- "gst_leak"    the user's business's input tax credit available but NOT yet claimed, for a period
- "receivable"  money owed TO the user's business — one entry per customer invoice the user ISSUED. "party" = the customer (the other side), never the user's business.
- "payable"     money the user's business OWES — one entry per vendor bill the user RECEIVED. "party" = the vendor (the other side), never the user's business.
- "payments"    gross amount processed via a payment gateway (Razorpay/Cashfree/Shopify) in the period

Direction test for a single invoice/bill — decide FIRST who owes whom:
- If the user's business is the SELLER / "from" / the one to be paid → it's a "receivable", party = the buyer ("bill to" / customer).
- If the user's business is the BUYER / "bill to" / the one who must pay → it's a "payable", party = the seller / vendor.
- If you cannot tell which side the user's business is on, put it in "anomalies", do not guess.

Rules:
- One entry per figure. "amount" is a positive number of rupees, digits only (no symbols, no commas).
- "due_date" only if the document states one, formatted YYYY-MM-DD, else null.
- The GST/CGST/SGST/IGST on a SINGLE sales or purchase invoice is NOT gst_payable and NOT gst_leak — it is one line of a period total that Margyn computes elsewhere. Put it in "anomalies" (severity "low"), never in "entries".
- Put anything ambiguous, contradictory, negative, a projection/forecast rather than actuals, a fully-settled item (net zero), or clearly not the user's own finance figure into "anomalies" with a one-line reason — do NOT force it into an entry.
- List sheet columns / document sections you saw but did not map in "unmapped".
- Never invent a figure. Never compute a total from line items unless the source prints that total.
- Keep every "reasoning" and "issue" string under 15 words.

Output ONLY valid JSON, no prose before or after:
{"entries":[{"target":"","label":"","amount":0,"party":null,"due_date":null,"confidence":0.0,"reasoning":""}],"anomalies":[{"issue":"","severity":"low"}],"unmapped":[""]}`;

class ImportMapperError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{kind:'workbook'|'document', skeleton?:string, mime?:string, base64?:string, business?:string, gstin?:string}} input
 * @param {string} apiKey - ANTHROPIC_API_KEY
 * @returns {Promise<{proposal:{entries:object[],anomalies:object[],unmapped:string[]}}>}
 * @throws {ImportMapperError} with .status set — callers map this to their own transport (HTTP status vs a WhatsApp text reply)
 */
async function runImportMapper(input, apiKey) {
  const body = input || {};
  const bizName = String(body.business || '').trim().slice(0, 120) || 'the user\'s business';
  const bizGst = String(body.gstin || '').trim().slice(0, 20);
  const whoLine = `The user's business is: "${bizName}"${bizGst ? ` (GSTIN ${bizGst})` : ''}. Map every figure from this business's point of view.\n\n`;

  let content;
  if (body.kind === 'workbook') {
    const skel = typeof body.skeleton === 'string' ? body.skeleton : JSON.stringify(body.skeleton || {});
    if (!skel || skel.length < 3) throw new ImportMapperError(400, 'Empty spreadsheet');
    content = [{ type: 'text', text: whoLine + 'Spreadsheet contents (first rows of each sheet, raw arrays):\n\n' + skel.slice(0, 60000) }];
  } else {
    const mime = String(body.mime || '');
    const data = String(body.base64 || '');
    if (!data) throw new ImportMapperError(400, 'No file data');
    if (data.length > MAX_BASE64_LEN) throw new ImportMapperError(413, 'File is too large — keep it under ~2 MB for now.');
    if (mime === 'application/pdf') {
      content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }];
    } else if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
      content = [{ type: 'image', source: { type: 'base64', media_type: mime, data } }];
    } else {
      throw new ImportMapperError(400, 'Unsupported file type');
    }
    content.push({ type: 'text', text: whoLine + 'This is a business document. Extract its financial figures per the schema, from this business\'s point of view.' });
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: IMPORT_MODEL, max_tokens: 4096, system: IMPORT_SYSTEM, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    const errBody = await r.text();
    console.error('Anthropic import error:', r.status, errBody);
    // Surface the real status/message (not the raw body — that can carry
    // request internals) so a failure is diagnosable from the caller's UI
    // alone, instead of needing to dig through Vercel's function logs.
    let reason = 'HTTP ' + r.status;
    try { const parsedErr = JSON.parse(errBody); if (parsedErr && parsedErr.error && parsedErr.error.message) reason = parsedErr.error.message.slice(0, 140); } catch (e) { /* keep the status-only reason */ }
    throw new ImportMapperError(502, 'Could not read the file just now (' + reason + ').');
  }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { proposal: sanitizeProposal(text) };
}

// The model occasionally returns JSON that is truncated (hit max_tokens) or
// fenced. Try a plain parse, then a salvage that closes any open string /
// brackets so a cut-off response still yields the entries it did produce.
function looseJsonParse(text) {
  let t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  if (start > 0) t = t.slice(start);
  try { return JSON.parse(t); } catch (e) { /* fall through to salvage */ }

  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let fixed = t;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*"[A-Za-z_]*"?\s*:?\s*"?[^"{}\[\]]*$/, ''); // drop a trailing half-written field
  fixed = fixed.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) fixed += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(fixed); } catch (e) { return null; }
}

function sanitizeProposal(text) {
  const parsed = looseJsonParse(text);
  if (!parsed || typeof parsed !== 'object') {
    return { entries: [], anomalies: [{ issue: 'Could not read structured data from this file.', severity: 'high' }], unmapped: [] };
  }

  const anomalies = [];
  const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map(e => {
    const target = e && IMPORT_TARGETS.includes(e.target) ? e.target : null;
    if (!target) return null;
    const amount = Number(e.amount);
    if (!isFinite(amount) || amount <= 0) {
      anomalies.push({ issue: 'Skipped "' + String(e.label || target).slice(0, 80) + '" — amount missing or not a positive number.', severity: 'med' });
      return null;
    }
    let conf = Number(e.confidence);
    if (!isFinite(conf)) conf = 0.5;
    return {
      target,
      label: String(e.label || target).slice(0, 120),
      amount: Math.round(amount * 100) / 100,
      party: e.party ? String(e.party).slice(0, 120) : null,
      due_date: normImportDate(e.due_date),
      confidence: Math.max(0, Math.min(1, conf)),
      reasoning: e.reasoning ? String(e.reasoning).slice(0, 300) : ''
    };
  }).filter(Boolean).slice(0, 40);

  (Array.isArray(parsed.anomalies) ? parsed.anomalies : []).forEach(a => {
    if (!a) return;
    anomalies.push({
      issue: String(a.issue || a).slice(0, 300),
      severity: ['low', 'med', 'high'].includes(a.severity) ? a.severity : 'low'
    });
  });

  const unmapped = (Array.isArray(parsed.unmapped) ? parsed.unmapped : [])
    .map(u => String(u).slice(0, 200)).filter(Boolean).slice(0, 20);

  return { entries, anomalies: anomalies.slice(0, 20), unmapped };
}

function normImportDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}

module.exports = {
  runImportMapper,
  sanitizeProposal,
  normImportDate,
  ImportMapperError,
  IMPORT_TARGETS,
  IMPORT_MODEL
};
