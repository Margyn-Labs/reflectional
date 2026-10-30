/**
 * _lib/zohoParties.js
 * Zoho Books contacts (customers and vendors) -> the party master (ledger_parties). Added 2026-10-29.
 *
 * Payment Chase finds a customer's WhatsApp number in ledger_parties, by name. Tally fills it from
 * agent 0.2.5+ (tallyParties.js); this is the same for Zoho Books, read from GET /contacts (scope
 * ZohoBooks.contacts.READ, already granted). The list returns contact_name (the same name the
 * invoices carry as customer_name), contact_type, email, phone and mobile (Zoho's contacts.yml,
 * list-contacts-response). Read only: nothing is written to Zoho.
 *
 * Same rules as Tally: only BLANK fields are filled (a number the owner typed is never overwritten),
 * match by zoho_contact_id > GSTIN > name, a new party only when Zoho has a phone or email for it,
 * mobile beats landline. source = 'zoho', external_refs.zoho_contact_id.
 *
 * Never throws: a failure here must not fail the Zoho sync.
 */

const { selectRows } = require('./supabaseRest');
const { planPartyWrites, writePartyPlan } = require('./tallyParties');

const MAX_PAGES = 10;          // 2,000 contacts; ~1 API call per 200 on the plan's daily budget
const PAGE_PAUSE_MS = 700;     // the pacing the rest of the Zoho sync uses
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Zoho contact (list row) -> the ledger shape planPartyWrites takes, or null. */
function contactToLedger(c) {
  if (!c || !c.contact_id || !(c.contact_name || c.company_name)) return null;
  const t = String(c.contact_type || '').toLowerCase();
  const type = t === 'customer' ? 'customer' : t === 'vendor' ? 'vendor' : null;
  if (!type) return null;
  const contact = {};
  if (c.mobile) contact.mobile = c.mobile;
  if (c.phone) contact.phone = c.phone;
  if (c.email) contact.email = c.email;
  if (c.gst_no) contact.gstin = c.gst_no;
  if (!Object.keys(contact).length) return null;
  return { zoho_contact_id: String(c.contact_id), name: c.contact_name || c.company_name, type, contact };
}

/**
 * Read every contact (paged, capped) and fill the party master.
 * session = zohoClient.createSession(org). Returns { read, with_details, inserted, updated } or { error }.
 */
async function syncZohoPartyContacts(session, userId, deps) {
  const d = Object.assign({ selectRows, writePartyPlan, pause: PAGE_PAUSE_MS }, deps || {});
  try {
    const ledgers = [];
    let read = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await session.apiGet('books/v3/contacts', { page: String(page), per_page: '200' });
      const batch = (data && data.contacts) || [];
      read += batch.length;
      for (const c of batch) { const l = contactToLedger(c); if (l) ledgers.push(l); }
      if (!(data && data.page_context && data.page_context.has_more_page) || !batch.length) break;
      if (d.pause) await sleep(d.pause);
    }
    // with_details: contacts Zoho has a phone, email or GSTIN for, the only ones the party master can save.
    if (!ledgers.length) return { read, with_details: 0, inserted: 0, updated: 0 };
    const parties = await d.selectRows('ledger_parties',
      `select=id,name,type,phone,email,gstin,address,state,pincode,pan,external_refs&user_id=eq.${userId}&limit=5000`);
    const plan = planPartyWrites(ledgers, parties, userId, { source: 'zoho', refKey: 'zoho_contact_id' });
    return Object.assign({ read, with_details: ledgers.length }, await d.writePartyPlan(userId, plan));
  } catch (e) {
    console.error('[zohoParties] contact sync failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { contactToLedger, syncZohoPartyContacts, MAX_PAGES };
