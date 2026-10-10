/**
 * _lib/tallyParties.js
 * Tally customer/supplier contact details -> the party master (ledger_parties).
 * Added 2026-10-08.
 *
 * Agent 0.2.5+ sends each ledger's phone, mobile, email, contact person, GSTIN, state,
 * pincode, PAN and address (whatever the Tally user filled in). For ledgers under
 * Sundry Debtors / Sundry Creditors this fills the party master, which is where
 * Payment Chase looks up a customer's WhatsApp number.
 *
 * Rules:
 *   - Only fills BLANK fields. A number the owner typed in Margyn is never overwritten by Tally.
 *   - Match order: same Tally GUID (external_refs.tally_guid) > same GSTIN > same name (normalised).
 *   - A new party is created only when Tally has a phone or email for it (that's what makes
 *     the record useful); source = 'tally'.
 *   - Mobile beats landline for `phone` (WhatsApp needs a mobile).
 *
 * Pure planning first (tested without a network), the write at the bottom. CommonJS, zero-npm.
 */

const { selectRows, insertRows, updateRows } = require('./supabaseRest');

const FIELDS = ['phone', 'email', 'gstin', 'address', 'state', 'pincode', 'pan'];

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Indian mobile out of whatever Tally holds ("98200 12345", "+91-98200-12345", "09820012345"). */
function indianMobile(s) {
  const d = String(s || '').replace(/[^\d]/g, '');
  const m = /^(?:91|0)?([6-9]\d{9})$/.exec(d);
  return m ? '+91' + m[1] : null;
}

/** The phone to store: the first Indian mobile found in mobile, then phone; else the raw mobile/phone. */
function bestPhone(c) {
  for (const v of [c.mobile, c.phone]) {
    for (const part of String(v || '').split(/[,;/]|\s{2,}/)) {
      const m = indianMobile(part);
      if (m) return m;
    }
  }
  const raw = String(c.mobile || c.phone || '').trim();
  return raw || null;
}

function cleanContact(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of ['phone', 'mobile', 'email', 'contact_person', 'gstin', 'state', 'pincode', 'pan', 'address']) {
    const v = raw[k] == null ? '' : String(raw[k]).replace(/\s+/g, ' ').trim();
    if (v) out[k] = v.slice(0, k === 'address' ? 400 : 120);
  }
  if (out.gstin) { out.gstin = out.gstin.toUpperCase(); if (!/^[0-9A-Z]{15}$/.test(out.gstin)) delete out.gstin; }
  if (out.pan) { out.pan = out.pan.toUpperCase(); if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(out.pan)) delete out.pan; }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) delete out.email;
  return Object.keys(out).length ? out : null;
}

function partyType(primaryGroup, parent) {
  const g = String(primaryGroup || parent || '').toLowerCase();
  if (g.includes('sundry debtor')) return 'customer';
  if (g.includes('sundry creditor')) return 'vendor';
  return null;
}

/**
 * Plan the writes.
 * @param ledgers  [{ tally_guid, name, primary_group, parent, contact }]
 * @param parties  existing ledger_parties rows for the account
 * @returns {{ inserts: object[], updates: {id, patch}[] }}
 */
function planPartyWrites(ledgers, parties, userId) {
  const byGuid = new Map(), byGstin = new Map(), byName = new Map();
  for (const p of parties || []) {
    const refs = p.external_refs || {};
    if (refs.tally_guid) byGuid.set(refs.tally_guid, p);
    if (p.gstin) byGstin.set(String(p.gstin).toUpperCase(), p);
    const k = normName(p.name);
    if (k && !byName.has(k)) byName.set(k, p);
  }

  const inserts = [], updates = [], touched = new Set();
  for (const l of ledgers || []) {
    const type = partyType(l.primary_group, l.parent);
    const c = cleanContact(l.contact);
    if (!type || !c || !l.name) continue;
    const want = {
      phone: bestPhone(c), email: c.email || null, gstin: c.gstin || null, address: c.address || null,
      state: c.state || null, pincode: c.pincode || null, pan: c.pan || (c.gstin ? c.gstin.slice(2, 12) : null)
    };
    const found = (l.tally_guid && byGuid.get(l.tally_guid)) || (want.gstin && byGstin.get(want.gstin)) || byName.get(normName(l.name));

    if (found) {
      if (touched.has(found.id)) continue;
      touched.add(found.id);
      const patch = {};
      for (const f of FIELDS) if (want[f] && !String(found[f] || '').trim()) patch[f] = want[f];
      const refs = Object.assign({}, found.external_refs || {});
      if (l.tally_guid && refs.tally_guid !== l.tally_guid) { refs.tally_guid = l.tally_guid; patch.external_refs = refs; }
      if (found.type && found.type !== type && found.type !== 'both') patch.type = 'both';
      if (Object.keys(patch).length) updates.push({ id: found.id, patch });
      continue;
    }

    if (!want.phone && !want.email) continue;
    const row = { user_id: userId, name: String(l.name).slice(0, 160), type, opening_balance: 0, source: 'tally',
      external_refs: l.tally_guid ? { tally_guid: l.tally_guid } : {} };
    for (const f of FIELDS) row[f] = want[f];
    inserts.push(row);
    // a second ledger with the same name in this batch updates, never duplicates
    byName.set(normName(l.name), Object.assign({ id: 'pending:' + inserts.length }, row));
    touched.add('pending:' + inserts.length);
  }
  return { inserts, updates };
}

/**
 * Apply contacts from one ingested ledger batch. Never throws: a failure here must not fail
 * the Tally sync. Returns { inserted, updated } or { error }.
 */
async function syncTallyPartyContacts(userId, ledgers) {
  try {
    const withContact = (ledgers || []).filter((l) => l.contact && partyType(l.primary_group, l.parent));
    if (!withContact.length) return { inserted: 0, updated: 0 };
    const parties = await selectRows('ledger_parties',
      `select=id,name,type,phone,email,gstin,address,state,pincode,pan,external_refs&user_id=eq.${userId}&limit=5000`);
    const { inserts, updates } = planPartyWrites(withContact, parties, userId);
    let inserted = 0, updated = 0;
    for (let i = 0; i < inserts.length; i += 500) {
      await insertRows('ledger_parties', inserts.slice(i, i + 500));
      inserted += Math.min(500, inserts.length - i);
    }
    for (const u of updates) {
      await updateRows('ledger_parties', `id=eq.${u.id}&user_id=eq.${userId}`, Object.assign({ updated_at: new Date().toISOString() }, u.patch));
      updated++;
    }
    return { inserted, updated };
  } catch (e) {
    console.error('[tallyParties] contact sync failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { planPartyWrites, syncTallyPartyContacts, cleanContact, bestPhone, indianMobile, partyType, normName };
