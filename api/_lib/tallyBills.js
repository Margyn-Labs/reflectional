'use strict';
/**
 * Bill direction, checked against how the books actually use each party.
 *
 * The agent labels a bill receivable or payable from the sign of its balance. Tally exports debits as
 * negative in some setups and positive in others, so on a given company every customer bill can land
 * on the wrong side (receivables tiny, payables huge). Rather than trust the sign, compare it with
 * evidence: a party that appears on sales vouchers is a customer, on purchase vouchers a vendor.
 * If the labels mostly disagree with that evidence, flip every direction. Same self-calibration idea as the
 * bank-balance sign in the app, and never silent: callers get `inverted` back.
 */
const nameKey = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const isCredit = (t) => /credit\s*note/i.test(t || '');
const isDebit = (t) => /debit\s*note/i.test(t || '');

function roleOf(type) {
  const t = type || '';
  if (/sales/i.test(t) && !isCredit(t)) return 'debtor';
  if (isCredit(t) || /receipt/i.test(t)) return 'debtor';
  if (/purchase/i.test(t) && !isDebit(t)) return 'creditor';
  if (isDebit(t) || /payment/i.test(t)) return 'creditor';
  return null;
}

/** vouchers: [{ voucher_type, party_name }]. Returns Map nameKey -> 'debtor' | 'creditor'. */
function partyRoles(vouchers) {
  const tally = new Map();
  for (const v of vouchers || []) {
    if (!v || !v.party_name) continue;
    const role = roleOf(v.voucher_type);
    if (!role) continue;
    const k = nameKey(v.party_name);
    const r = tally.get(k) || { debtor: 0, creditor: 0 };
    r[role]++; tally.set(k, r);
  }
  const out = new Map();
  for (const [k, r] of tally) if (r.debtor !== r.creditor) out.set(k, r.debtor > r.creditor ? 'debtor' : 'creditor');
  return out;
}

/** Returns { bills, inverted }. bills have `direction` corrected when the stored labels are inverted. */
function calibrateBills(bills, vouchers) {
  const roles = partyRoles(vouchers);
  let agree = 0, disagree = 0, evidence = 0;
  for (const b of bills || []) {
    const role = roles.get(nameKey(b.party_name));
    if (!role) continue;
    const amt = Math.abs(Number(b.closing_balance) || 0);
    if (!amt) continue;
    evidence++;
    const labelled = b.direction === 'payable' ? 'creditor' : 'debtor';
    if (labelled === role) agree += amt; else disagree += amt;
  }
  const inverted = evidence >= 3 && disagree > agree * 2;
  if (!inverted) return { bills: bills || [], inverted: false, evidence, agree, disagree };
  return {
    bills: bills.map((b) => Object.assign({}, b, { direction: b.direction === 'payable' ? 'receivable' : 'payable' })),
    inverted: true, evidence, agree, disagree
  };
}

module.exports = { calibrateBills, partyRoles, nameKey };
