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

const { callClaude, systemBlocks, effortFor, escalate, textOf } = require('./claude');

const IMPORT_MODEL = process.env.IMPORT_MODEL || 'claude-sonnet-5-5';
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
- For "receivable" / "payable" entries, "party" is the other side's name exactly as printed (legal name, not an abbreviation). Also fill "party_details" with that party's GSTIN, phone, email, billing address and state ONLY where the document prints them for that party (never the user's own business details, never guessed); use null for anything not printed. For every other target, "party_details" is null.
- The GST/CGST/SGST/IGST on a SINGLE sales or purchase invoice is NOT gst_payable and NOT gst_leak — it is one line of a period total that Margyn computes elsewhere. Put it in "anomalies" (severity "low"), never in "entries".
- Put anything ambiguous, contradictory, negative, a projection/forecast rather than actuals, a fully-settled item (net zero), or clearly not the user's own finance figure into "anomalies" with a one-line reason — do NOT force it into an entry.
- List sheet columns / document sections you saw but did not map in "unmapped".
- Never invent a figure. Never compute a total from line items unless the source prints that total.
- Keep every "reasoning" and "issue" string under 15 words.

Output ONLY valid JSON, no prose before or after:
{"entries":[{"target":"","label":"","amount":0,"party":null,"party_details":null,"due_date":null,"confidence":0.0,"reasoning":""}],"anomalies":[{"issue":"","severity":"low"}],"unmapped":[""]}`;

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

  // An "extract" job (see _lib/claude.js): medium reasoning, the mapping
  // instructions cached (a bulk upload re-sends them file after file), and
  // one retry a level up only when the output can't be read as JSON or
  // came back with nothing at all from a real document.
  let effort = effortFor('extract');
  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let data;
    try {
      data = await callClaude({
        label: 'import-mapper', job: 'extract', effort, apiKey,
        model: IMPORT_MODEL, max_tokens: 6000, system: systemBlocks(IMPORT_SYSTEM), messages: [{ role: 'user', content }]
      });
    } catch (err) {
      if (!err.status) throw err;
      console.error('Anthropic import error:', err.status, err.body);
      // Surface the real status/message (not the raw body — that can carry
      // request internals) so a failure is diagnosable from the caller's UI
      // alone, instead of needing to dig through Vercel's function logs.
      let reason = 'HTTP ' + err.status;
      try { const parsedErr = JSON.parse(err.body); if (parsedErr && parsedErr.error && parsedErr.error.message) reason = parsedErr.error.message.slice(0, 140); } catch (e) { /* keep the status-only reason */ }
      throw new ImportMapperError(502, 'Could not read the file just now (' + reason + ').');
    }
    text = textOf(data);
    const parsed = looseJsonParse(text);
    const empty = !parsed || (!(parsed.entries || []).length && !(parsed.anomalies || []).length);
    if (!empty) break;
    const up = escalate(effort);
    if (!up || up === effort) break;
    console.log('[importMapper] nothing readable at effort', effort, '- retrying at', up);
    effort = up;
  }
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
      party_details: (target === 'receivable' || target === 'payable') ? cleanPartyDetails(e.party_details) : null,
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

// What a document prints about the other party, for the customer/vendor
// master (app/js/19f-parties.js). Only well-formed values survive: a GSTIN
// that fails the pattern is dropped rather than stored wrong.
function cleanPartyDetails(d) {
  if (!d || typeof d !== 'object') return null;
  const str = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n) || null;
  const gstin = (str(d.gstin, 20) || '').toUpperCase().replace(/\s/g, '');
  const email = str(d.email, 120);
  const phone = (str(d.phone, 24) || '').replace(/[^\d+ -]/g, '').trim();
  const out = {
    gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : null,
    phone: phone.replace(/\D/g, '').length >= 8 ? phone : null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    address: str(d.address, 300),
    state: str(d.state, 60)
  };
  return Object.values(out).some(Boolean) ? out : null;
}

function normImportDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}

/* ============================================================================
   ZOHO EXPORT SHAPE (2026-10-31, ZOHO-AUDIT-2026-10-31.md "fix a")
   ----------------------------------------------------------------------------
   Zoho Books' own export (Sales → Invoices → ⋯ → Export; Bills, Credit Notes,
   Vendor Credits the same) is one row per line item. A file with that header
   skips the AI mapping entirely: its rows become zoho_document_lines for the
   documents Margyn already holds (api/_zoho/exportImport.js), so a year of item
   figures arrives in minutes on any Zoho plan instead of one API call per
   document. Columns follow Zoho's documented export/import field names;
   matching is by normalised header (case, spaces and punctuation ignored, "%"
   read as "percent"), so "Item Price" and "item_price" are the same column.
   ============================================================================ */
const normHeader = (h) => String(h == null ? '' : h).toLowerCase().replace(/%/g, 'percent').replace(/[^a-z0-9]/g, '');

// Returns first: a credit note export can also carry the invoice it was applied to ("Invoice Number"), and a vendor
// credit export the bill.
const ZOHO_EXPORT_DOCS = {
  creditnote: { number: ['creditnotenumber', 'creditnoteno'], id: ['creditnoteid', 'creditnotesid'], date: ['creditnotedate'], status: ['creditnotestatus'] },
  vendorcredit: { number: ['vendorcreditnumber', 'vendorcreditno', 'debitnotenumber'], id: ['vendorcreditid', 'debitnoteid'], date: ['vendorcreditdate', 'debitnotedate'], status: ['vendorcreditstatus', 'debitnotestatus'] },
  bill: { number: ['billnumber', 'billno'], id: ['billid'], date: ['billdate'], status: ['billstatus'] },
  invoice: { number: ['invoicenumber', 'invoiceno'], id: ['invoiceid'], date: ['invoicedate'], status: ['invoicestatus'] }
};
const ZOHO_EXPORT_LINE = {
  item_name: ['itemname', 'item', 'productname'],
  item_id: ['productid', 'itemid'],
  sku: ['sku', 'itemsku'],
  line_item_id: ['lineitemid'],
  qty: ['quantity', 'qty', 'itemquantity'],
  rate: ['itemprice', 'rate', 'itemrate', 'price', 'unitprice'],
  item_total: ['itemtotal', 'lineitemtotal', 'itemamount'],
  tax_pct: ['itemtaxpercent', 'taxpercent', 'taxpercentage', 'itemtaxpercentage'],
  inclusive: ['isinclusivetax', 'istaxinclusive', 'taxinclusive'],
  exchange_rate: ['exchangerate'],
  unit: ['usageunit', 'unit'],
  location: ['locationname', 'warehousename', 'branchname'],
  date: ['date'],
  status: ['status'],
  discount_type: ['discounttype'],
  discount_before_tax: ['isdiscountbeforetax'],
  entity_discount_amount: ['entitydiscountamount'],
  entity_discount_percent: ['entitydiscountpercent']
};

function headerIndex(header) {
  const idx = {};
  (header || []).forEach((h, i) => { const k = normHeader(h); if (k && idx[k] == null) idx[k] = i; });
  const pick = (names) => { for (const n of names) if (idx[n] != null) return idx[n]; return null; };
  return { idx, pick };
}

/**
 * Is this header row Zoho Books' own export? Returns { doc_type, columns } or null. Needs the document number,
 * an item (name or Zoho's item id), the quantity and the line amount (or the price).
 */
function detectZohoExport(header) {
  const { pick } = headerIndex(header);
  for (const [type, d] of Object.entries(ZOHO_EXPORT_DOCS)) {
    const number = pick(d.number);
    if (number == null) continue;
    const cols = { number, id: pick(d.id), doc_date: pick(d.date), doc_status: pick(d.status) };
    for (const [k, names] of Object.entries(ZOHO_EXPORT_LINE)) cols[k] = pick(names);
    if (cols.doc_date == null) cols.doc_date = cols.date;
    if (cols.doc_status == null) cols.doc_status = cols.status;
    if ((cols.item_name == null && cols.item_id == null) || cols.qty == null || (cols.item_total == null && cols.rate == null)) continue;
    return { doc_type: type, columns: cols };
  }
  return null;
}

const xNum = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const t = String(v).replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/%$/, '');
  const n = Number(t);
  return isFinite(n) ? n : null;
};
const xBool = (v) => /^(true|yes|y|1)$/i.test(String(v == null ? '' : v).trim());
function xDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);   // Zoho India exports dd/MM/yyyy
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -,]*(\d{4})$/);          // 05 Oct 2026
  if (m && MON[m[2].toLowerCase()]) return m[3] + '-' + String(MON[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}

/**
 * Rows of a Zoho export (arrays, header first) → documents with their lines, grouped by document number, in file
 * order. Pure. Rows without an item (free-text lines) are dropped, as the API path drops them.
 * → { doc_type, documents: [{ number, id, date, status, exchange_rate, is_inclusive_tax, discount, lines: [...] }], rows, skipped, free }
 * (free = lines with no item, booked straight to an account)
 */
function parseZohoExport(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const hdrAt = all.findIndex((r) => Array.isArray(r) && detectZohoExport(r));
  if (hdrAt < 0) return null;
  const { doc_type, columns: c } = detectZohoExport(all[hdrAt]);
  const get = (r, k) => (c[k] == null ? null : r[c[k]]);
  const str = (v) => (v == null ? '' : String(v).trim());
  const byNum = new Map();
  let used = 0, skipped = 0, free = 0;
  for (const r of all.slice(hdrAt + 1)) {
    if (!Array.isArray(r)) continue;
    const number = str(get(r, 'number'));
    if (!number) { skipped++; continue; }
    let d = byNum.get(number);
    if (!d) {
      const discAmt = xNum(get(r, 'entity_discount_amount'));
      const discPct = xNum(get(r, 'entity_discount_percent'));
      d = {
        number, id: str(get(r, 'id')) || null, date: xDate(get(r, 'doc_date')), status: str(get(r, 'doc_status')).toLowerCase() || null,
        exchange_rate: xNum(get(r, 'exchange_rate')) || 1, is_inclusive_tax: xBool(get(r, 'inclusive')),
        discount: (discAmt || discPct) ? { amount: discAmt, percent: discPct, type: str(get(r, 'discount_type')).toLowerCase() || null,
          before_tax: c.discount_before_tax == null ? true : xBool(get(r, 'discount_before_tax')) } : null,
        lines: [], free_total: 0
      };
      byNum.set(number, d);
    }
    const name = str(get(r, 'item_name')), itemId = str(get(r, 'item_id'));
    const qty = xNum(get(r, 'qty'));
    // A line booked straight to an account (rent, freight, "Return / discount") has text in Item Name but no
    // Product ID. When the file has that column, such a line is not an item: drop it, as the API path does, but keep
    // its amount, which shares a document discount with the item lines (items.documentLines).
    if (c.item_id != null && !itemId) { d.free_total = (d.free_total || 0) + (xNum(get(r, 'item_total')) || 0); free++; continue; }
    if ((!name && !itemId) || qty == null) { skipped++; continue; }
    const rate = xNum(get(r, 'rate'));
    let total = xNum(get(r, 'item_total'));
    if (total == null && rate != null) total = Math.round(rate * qty * 100) / 100;
    if (total == null) { skipped++; continue; }
    d.lines.push({ item_name: name || null, item_id: itemId || null, sku: str(get(r, 'sku')) || null, line_item_id: str(get(r, 'line_item_id')) || null,
      qty, rate, item_total: total, tax_pct: xNum(get(r, 'tax_pct')), unit: str(get(r, 'unit')) || null, location: str(get(r, 'location')) || null });
    used++;
  }
  return { doc_type, documents: [...byNum.values()], rows: used, skipped, free };
}

module.exports = {
  detectZohoExport,
  parseZohoExport,
  normHeader,
  runImportMapper,
  sanitizeProposal,
  normImportDate,
  cleanPartyDetails,
  ImportMapperError,
  IMPORT_TARGETS,
  IMPORT_MODEL
};
