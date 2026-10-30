/**
 * Item lines from Zoho Books' own export (ZOHO-AUDIT-2026-10-31.md "fix a"). No Zoho API calls, any plan.
 *
 * The owner exports Invoices, Bills, Credit Notes and Vendor Credits from Zoho once and drops each file into
 * Margyn's Import. The app spots the export's header (importMapper.detectZohoExport), skips the AI mapping and
 * sends the rows here: POST /api/zoho?action=import-export { rows: [[header...], [...], ...] } (a big file in
 * several posts, each holding whole documents).
 *
 * Each document is matched to one Margyn already holds, on the active Zoho connection only, by Zoho's document id
 * when the file has it, else by its number. Its lines are written to zoho_document_lines exactly as the API path
 * would write them (items.documentLines does the arithmetic), and zoho_line_state marks it read at the version
 * Margyn knows, so the API queue only reads documents edited after the export. Documents the API has already read
 * at that version are left alone (the API copy is the original). Void and draft documents carry no lines.
 * Nothing is written to Zoho.
 */

const { selectRows, insertRows, deleteRows, getUserFromRequest, logConnectorEvent } = require('../_lib/supabaseRest');
const { parseZohoExport } = require('../_lib/importMapper');
const { documentLines, needsRead } = require('./items');

const DEAD = /^(draft|void|deleted_at_source|deleted)$/i;
const MAX_ROWS = 60000;   // per post; the app splits bigger files on document boundaries
const ID_FIELD = { invoice: 'invoice_id', bill: 'bill_id', creditnote: 'creditnote_id', vendorcredit: 'vendor_credit_id' };
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const iso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * One exported document as the API's document shape, so items.documentLines values its lines the same way:
 * base currency, inclusive tax backed out, a document discount before tax spread pro rata.
 * itemIdFor(line) → Zoho item_id or null (unknown item: line dropped, counted).
 */
function exportDocToApi(doc, docType, docId, itemIdFor) {
  const lineItems = [];
  let unknown = 0;
  doc.lines.forEach((l, i) => {
    const itemId = itemIdFor(l);
    if (!itemId) { unknown++; return; }
    lineItems.push({
      line_item_id: l.line_item_id || `x-${docId}-${i + 1}`, item_id: itemId, name: l.item_name, sku: l.sku, quantity: l.qty, unit: l.unit,
      rate: l.rate, item_total: l.item_total, tax_percentage: l.tax_pct, location_name: l.location
    });
  });
  // Lines with no item (account lines): no row of their own, but their amount shares a document discount.
  if (doc.free_total) lineItems.push({ line_item_id: `x-${docId}-free`, item_id: '', item_total: doc.free_total });
  const api = { [ID_FIELD[docType]]: docId, date: doc.date, status: doc.status, exchange_rate: doc.exchange_rate || 1, is_inclusive_tax: !!doc.is_inclusive_tax, line_items: lineItems };
  const d = doc.discount;
  if (d && d.before_tax !== false && (!d.type || /entity|transaction/.test(d.type))) {
    api.discount_type = 'entity_level';
    api.is_discount_before_tax = true;
    if (d.amount) api.discount_amount = d.amount; else if (d.percent) api.discount = d.percent + '%';
  }
  return { api, unknown };
}

/** Item lookup on the active org: Zoho item id, else SKU, else exact name (case and spacing ignored). */
function itemMatcher(items) {
  const ids = new Set(items.map((i) => String(i.item_id)));
  const bySku = new Map(), byName = new Map();
  for (const i of items) {
    if (i.sku) bySku.set(norm(i.sku), String(i.item_id));
    if (i.name) byName.set(norm(i.name), String(i.item_id));
  }
  return (l) => (l.item_id && ids.has(String(l.item_id)) ? String(l.item_id)
    : (l.sku && bySku.get(norm(l.sku))) || (l.item_name && byName.get(norm(l.item_name))) || null);
}

/**
 * Write one export's lines. Exported for tests.
 * → { doc_type, documents, matched, written, lines, already_read, not_found, dead, unknown_items, left_for_api, not_found_numbers }
 */
async function importExportRows(org, rows) {
  const parsed = parseZohoExport(rows);
  if (!parsed) return { error: 'not_zoho_export' };
  const type = parsed.doc_type;
  const o = org.id;
  const [state, items, money] = await Promise.all([
    selectRows('zoho_line_state', `select=doc_type,doc_id,doc_number,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${o}&doc_type=eq.${type}&order=id.asc&limit=200000`),
    selectRows('zoho_items', `select=item_id,name,sku&org_ref=eq.${o}&order=item_id.asc&limit=200000`),
    type === 'invoice' ? selectRows('zoho_invoices', `select=invoice_id,invoice_number,invoice_date,status,last_modified_time&org_ref=eq.${o}&order=invoice_id.asc&limit=200000`)
      : type === 'bill' ? selectRows('zoho_bills', `select=bill_id,bill_number,bill_date,status,last_modified_time&org_ref=eq.${o}&order=bill_id.asc&limit=200000`)
        : Promise.resolve([])
  ]);
  // Every document of this type Margyn knows: the line queue's own record first, then the money sync's table
  // (a document the queue hasn't listed yet).
  const known = new Map();   // doc_id → state-shaped row
  for (const s of state) known.set(String(s.doc_id), s);
  for (const m of money) {
    const id = String(type === 'invoice' ? m.invoice_id : m.bill_id);
    if (known.has(id)) continue;
    known.set(id, { doc_type: type, doc_id: id, doc_number: type === 'invoice' ? m.invoice_number : m.bill_number, doc_date: type === 'invoice' ? m.invoice_date : m.bill_date,
      status: m.status || null, doc_last_modified: iso(m.last_modified_time), lines_read_at: null, read_modified: null });
  }
  const byNumber = new Map();
  for (const k of known.values()) if (k.doc_number) byNumber.set(norm(k.doc_number), k);
  const itemIdFor = itemMatcher(items);

  const out = { doc_type: type, documents: parsed.documents.length, matched: 0, written: 0, lines: 0, already_read: 0, not_found: 0, dead: 0, unknown_items: 0, left_for_api: 0, not_found_numbers: [] };
  const now = new Date().toISOString();
  const done = [];   // { s, lines }: written below in a few batched calls, not three calls per document
  for (const doc of parsed.documents) {
    const s = (doc.id && known.get(String(doc.id))) || byNumber.get(norm(doc.number));
    if (!s) { out.not_found++; if (out.not_found_numbers.length < 10) out.not_found_numbers.push(doc.number); continue; }
    out.matched++;
    if (DEAD.test(String(s.status || '')) || DEAD.test(String(doc.status || ''))) { out.dead++; continue; }
    if (!needsRead(s)) { out.already_read++; continue; }
    const { api, unknown } = exportDocToApi(doc, type, s.doc_id, itemIdFor);
    // A line naming an item Margyn doesn't have from Zoho yet (item master not synced, or the item was renamed
    // since): the document stays with the API queue rather than being marked read with lines missing.
    if (unknown) { out.unknown_items += unknown; out.left_for_api++; continue; }
    // The date Margyn already holds for the document wins: an export's date text depends on the org's date format
    // (05/10/2026 is 5 Oct in India, 10 May in the US), Margyn's comes from the API.
    api.date = s.doc_date || doc.date;
    const lines = documentLines(api, type, o).map((l) => Object.assign(l, { doc_date: l.doc_date || s.doc_date || null }));
    done.push({ s, lines });
    out.written++;
    out.lines += lines.length;
  }
  // A year of invoices is hundreds of documents: one call each would outrun the function's time limit (seen live,
  // 30 Oct: ~85 documents a minute). Old lines go first, then the new lines, then the queue marks, each batched.
  for (let i = 0; i < done.length; i += 100) {
    const ids = done.slice(i, i + 100).map((d) => encodeURIComponent(d.s.doc_id)).join(',');
    await deleteRows('zoho_document_lines', `org_ref=eq.${o}&doc_type=eq.${type}&doc_id=in.(${ids})`);
  }
  const allLines = done.flatMap((d) => d.lines);
  for (let i = 0; i < allLines.length; i += 500) await insertRows('zoho_document_lines', allLines.slice(i, i + 500), { onConflict: 'org_ref,doc_type,line_item_id', merge: true });
  // Read at the version Margyn knows: a later edit in Zoho moves doc_last_modified and the queue reads it again.
  const marks = done.map(({ s, lines }) => ({ org_ref: o, doc_type: type, doc_id: s.doc_id, doc_number: s.doc_number || null, doc_date: s.doc_date || null,
    status: s.status || null, doc_last_modified: s.doc_last_modified || null, lines_read_at: now, read_modified: s.doc_last_modified || now, line_count: lines.length }));
  for (let i = 0; i < marks.length; i += 500) await insertRows('zoho_line_state', marks.slice(i, i + 500), { onConflict: 'org_ref,doc_type,doc_id', merge: true });
  return out;
}

/** POST /api/zoho?action=import-export — the owner's signed-in Import page. */
async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length < 2) { res.status(400).json({ error: 'No rows' }); return; }
  if (rows.length > MAX_ROWS) { res.status(413).json({ error: 'Too many rows in one go' }); return; }
  const orgs = await selectRows('zoho_organizations', `select=id,organization_id,organization_name&user_id=eq.${user.id}&status=eq.active&order=connected_at.desc&limit=1`);
  const org = orgs[0];
  if (!org) { res.status(404).json({ error: 'Zoho Books is not connected' }); return; }
  try {
    const known = await selectRows('zoho_items', `select=item_id&org_ref=eq.${org.id}&limit=1`);
    if (!known.length) { res.status(409).json({ error: 'Margyn hasn’t read your Zoho item list yet. Press Sync now on Zoho Books, wait for it to finish, then drop the file again.' }); return; }
    const out = await importExportRows(org, rows);
    if (out.error) { res.status(400).json({ error: 'This file is not a Zoho Books export' }); return; }
    await logConnectorEvent({ userId: user.id, connectorType: 'zoho_books', operation: 'import_export_lines', status: 'success', recordsSynced: out.lines,
      errorMessage: out.not_found ? `${out.not_found} ${out.doc_type} numbers not in Margyn` : null });
    res.status(200).json(Object.assign({ status: 'ok' }, out));
  } catch (err) {
    if (/zoho_(items|document_lines|line_state)/.test(String(err.message)) && /does not exist|schema cache|42P01|PGRST205/i.test(String(err.message))) {
      res.status(409).json({ error: 'Item lines are not switched on yet' }); return;
    }
    console.error('Zoho export import failed');
    res.status(500).json({ error: 'Could not import the file' });
  }
}

module.exports = { handler, importExportRows, exportDocToApi, itemMatcher };
