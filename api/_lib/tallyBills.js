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
const isCredit = (t) => /credit\s*note|sales?\s*returns?/i.test(t || '');
const isDebit = (t) => /debit\s*note|purchases?\s*returns?/i.test(t || '');

function roleOf(type) {
  const t = type || '';
  if (/\bsales?\b/i.test(t) && !isCredit(t)) return 'debtor';
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
    const role = roleOf(v.voucher_base || v.voucher_type);
    if (!role) continue;
    const k = nameKey(v.party_name);
    const r = tally.get(k) || { debtor: 0, creditor: 0 };
    r[role]++; tally.set(k, r);
  }
  const out = new Map();
  for (const [k, r] of tally) if (r.debtor !== r.creditor) out.set(k, r.debtor > r.creditor ? 'debtor' : 'creditor');
  return out;
}

/** A Tally date ('20260917', '2026-09-17', '17-Sep-2026') as UTC midnight ms, or NaN. */
function dayMs(d) {
  if (!d) return NaN;
  const s = String(d).trim();
  if (/^\d{8}$/.test(s)) return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}
/** Today's date in India as UTC midnight ms (the server runs in UTC; 00:00-05:30 IST is still "yesterday" there). */
function todayIstMs(now) {
  const d = new Date((now ? new Date(now).getTime() : Date.now()) + 5.5 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Days late as of today, not as of the last sync. The agent stores overdue_days the moment it syncs, so when
 * the Tally PC is off for two days every bill looked two days less late than it is ("went overdue 1 day ago"
 * when it was 3). With a due date we count from it; without one we keep what the agent said.
 */
function liveOverdueDays(b, now) {
  const due = dayMs(b && b.due_date);
  if (Number.isNaN(due)) return b && b.overdue_days != null ? b.overdue_days : null;
  return Math.max(0, Math.round((todayIstMs(now) - due) / 86400000));
}

/**
 * Returns { bills, inverted }. bills have `direction` corrected when the stored labels are inverted,
 * `overdue_days` counted to today, and `advance: true` on a bill that sits on the wrong side for its party:
 * a customer's on-account receipt or credit balance (Dr Reddy's showing as "what you owe vendors"), or money
 * paid ahead to a vendor. Those are not bills anyone has to pay; callers keep them out of receivable and
 * payable totals and net them off the party instead.
 */
function calibrateBills(bills, vouchers, opts) {
  const now = opts && opts.now;
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
  const out = (bills || []).map((b) => {
    const direction = inverted ? (b.direction === 'payable' ? 'receivable' : 'payable') : b.direction;
    const role = roles.get(nameKey(b.party_name));
    const advance = !!role && (direction === 'payable' ? role === 'debtor' : role === 'creditor');
    return Object.assign({}, b, { direction, overdue_days: liveOverdueDays(b, now), advance });
  });
  return { bills: out, inverted, evidence, agree, disagree };
}

module.exports = { calibrateBills, partyRoles, nameKey, liveOverdueDays, todayIstMs, dayMs };
