/**
 * Pure matching logic for payments-to-invoices auto-reconciliation.
 * No I/O here on purpose — takes plain arrays in, returns plain match
 * rows out, so it can be unit-tested without a live Supabase connection.
 * api/reconcile.js wraps this with the actual Supabase reads/writes.
 *
 * The core question this answers: does an independent source (a captured
 * Razorpay payment) corroborate a payment Zoho Books already recorded
 * against an invoice? Two sources agreeing -> verified. One source, or a
 * suspiciously identical amount+date collision -> flagged for review, not
 * auto-trusted. Never invents a match it isn't confident in.
 */

const DATE_WINDOW_DAYS = 3; // Razorpay settlement lag is typically T+2/T+3

/** Zoho amounts are decimal rupees; Razorpay amounts are integer paise. */
function rupeesToPaise(amount) {
  return Math.round(Number(amount) * 100);
}

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

/**
 * If Zoho's own payment_mode/description already says "Razorpay", the
 * Zoho record may itself have come from Zoho's native Razorpay integration
 * rather than from the merchant's books independently. Matching Margyn's
 * separately-synced Razorpay data against that isn't two independent
 * sources agreeing — it's the same transaction counted twice. Detected
 * here so it can never silently produce a false "verified".
 */
function looksSameSourced(zohoPayment) {
  const haystack = `${zohoPayment.payment_mode || ''} ${zohoPayment.reference_number || ''}`.toLowerCase();
  return haystack.includes('razorpay');
}

/**
 * @param {Array} zohoPayments - rows from zoho_customer_payments, each with
 *   { payment_id, invoice_ref, amount, payment_date, payment_mode }
 * @param {Array} razorpayPayments - rows from razorpay_transactions, each
 *   with { payment_id, amount (paise), status, created_at }
 * @param {Set<string>} alreadyResolved - zoho payment_ids already in
 *   reconciliation_matches, to skip on reruns
 * @returns {Array} match rows ready to insert into reconciliation_matches
 */
function matchPayments(zohoPayments, razorpayPayments, alreadyResolved = new Set()) {
  const captured = razorpayPayments.filter((r) => r.status === 'captured');

  const rows = [];

  for (const zp of zohoPayments) {
    if (alreadyResolved.has(zp.payment_id)) continue;
    if (!zp.amount || !zp.payment_date) continue;

    const targetPaise = rupeesToPaise(zp.amount);
    const sameSource = looksSameSourced(zp);

    const candidates = captured.filter(
      (r) => r.amount === targetPaise && daysBetween(r.created_at, zp.payment_date) <= DATE_WINDOW_DAYS
    );

    const base = {
      invoice_ref: zp.invoice_ref || null,
      zoho_payment_id: zp.payment_id,
      invoice_amount: zp.amount,
      same_source_flag: sameSource
    };

    if (candidates.length === 1) {
      const match = candidates[0];
      rows.push({
        ...base,
        razorpay_payment_id: match.payment_id,
        matched_amount: zp.amount,
        date_diff_days: Math.round(daysBetween(match.created_at, zp.payment_date)),
        match_status: 'auto_matched',
        match_confidence: sameSource ? 'signal' : 'verified',
        match_reason: sameSource
          ? 'Amount and date match a captured Razorpay payment, but Zoho\u2019s payment mode suggests it may already be Razorpay-sourced \u2014 not counted as independent corroboration.'
          : `Amount (\u20b9${zp.amount}) and date matched a single captured Razorpay payment within ${DATE_WINDOW_DAYS} days.`
      });
    } else if (candidates.length > 1) {
      rows.push({
        ...base,
        razorpay_payment_id: null,
        matched_amount: null,
        date_diff_days: null,
        match_status: 'pending_review',
        match_confidence: null,
        match_reason: `${candidates.length} captured Razorpay payments match this amount within the date window \u2014 needs a manual pick.`
      });
    } else {
      rows.push({
        ...base,
        razorpay_payment_id: null,
        matched_amount: null,
        date_diff_days: null,
        match_status: 'no_match',
        match_confidence: null,
        match_reason: `No captured Razorpay payment found matching \u20b9${zp.amount} within ${DATE_WINDOW_DAYS} days.`
      });
    }
  }

  return rows;
}

module.exports = { matchPayments, rupeesToPaise, daysBetween, looksSameSourced, DATE_WINDOW_DAYS };
