/**
 * Reconciler v2 — pure multi-source pair matching.
 *
 * No I/O here on purpose. api/reconcile.js normalizes rows out of Supabase
 * into the plain shapes below, calls these, and upserts the returned rows
 * into recon_findings. That keeps the matching rules unit-testable with no
 * live connection (see api/_lib/__tests__/reconcilerV2.test.js).
 *
 * Scope (SPEC — Reconciler v2): Books x Razorpay, Books x Shopify,
 * Razorpay x Shopify, plus "gateway before first books snapshot".
 *   - Books = Zoho Books OR Tally, whichever is the org's active books
 *     source. NEVER both mashed into one "books" number.
 *   - No bank statement match. No GSTR-2B / ITC. No Zoho<->Tally merge.
 *
 * Honesty rules baked in:
 *   - A finding is 'verified' only when two independently-operated sources
 *     agree (exact ref, or amount+currency inside the date window).
 *   - Same amount + conflicting id/date  -> 'mismatch', never auto-verified.
 *   - Partial payment -> 'partial', not forced to a full match.
 *   - Gateway fee lines -> 'fee_unallocated' Signal until a fee ledger maps them.
 *   - If the books side is "same-sourced" (e.g. the books payment row itself
 *     came from a native Razorpay integration), it is not independent
 *     corroboration -> Signal, not 'verified'.
 *
 * CommonJS to match reconcileMatcher.js / reconcile.js.
 */

const DEFAULT_DATE_WINDOW_DAYS = 3;
const PARTIAL_TOLERANCE = 0.02; // 2% — treat as "same amount" for exact-ref matches

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function amountsEqual(a, b) {
  const x = Number(a), y = Number(b);
  if (!isFinite(x) || !isFinite(y)) return false;
  return Math.abs(x - y) < 0.5; // sub-rupee rounding only
}

function amountsClose(a, b, tol = PARTIAL_TOLERANCE) {
  const x = Number(a), y = Number(b);
  if (!isFinite(x) || !isFinite(y) || x === 0) return false;
  return Math.abs(x - y) / Math.abs(x) <= tol;
}

function norm(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}

/** Pull any candidate reference token out of a Razorpay payment's free-text fields. */
function rpRefTokens(rp) {
  return [rp.id, rp.orderRef, rp.description, rp.notesInvoice]
    .filter(Boolean)
    .map(norm);
}

function baseFinding(pair, sourceA, sourceB, matchKey) {
  return {
    pair,
    source_a: sourceA,
    source_b: sourceB,
    match_key: String(matchKey),
    currency: 'INR',
    date_diff_days: null,
    match_basis: 'none',
    evidence: {}
  };
}

/* ------------------------------------------------------------------ */
/* 1. Books  <->  Razorpay                                             */
/* ------------------------------------------------------------------ */
/**
 * @param {Array} booksPayments  { ref, amount, date, currency, invoiceRef,
 *                                 mode, reference, sameSourced, fetchedAt }
 * @param {Array} rpPayments     { id, amount (rupees), currency, date, status,
 *                                 method, fee, orderRef, description, fetchedAt }
 * @param {Object} opts { booksSource: 'zoho_books'|'tally', dateWindowDays,
 *                        hasBooksSnapshot: boolean }
 */
function matchBooksRazorpay(booksPayments, rpPayments, opts = {}) {
  const booksSource = opts.booksSource || 'zoho_books';
  const win = opts.dateWindowDays || DEFAULT_DATE_WINDOW_DAYS;
  const captured = (rpPayments || []).filter((r) => norm(r.status) === 'captured');
  const findings = [];
  const usedRpIds = new Set();

  // Pre-book-snapshot guard: gateway money exists, books do not. NOT a no-op.
  if ((!booksPayments || !booksPayments.length) && opts.hasBooksSnapshot === false) {
    for (const rp of captured) {
      const f = baseFinding('books_razorpay', booksSource, 'razorpay', 'rp:' + rp.id);
      f.status = 'awaiting_books';
      f.source_b_ref = rp.id;
      f.amount_b = Number(rp.amount);
      f.currency = rp.currency || 'INR';
      f.fetched_at_b = rp.fetchedAt || null;
      f.reason = `Captured Razorpay payment ${rp.id} (₹${rp.amount}) has no ${booksSource} record yet — books not connected / no snapshot. Parked, not dropped.`;
      f.evidence = { razorpay: { id: rp.id, amount: rp.amount, date: rp.date, method: rp.method } };
      findings.push(f);
    }
    return findings;
  }

  for (const bp of booksPayments || []) {
    if (bp.amount == null || !bp.date) continue;
    const key = 'bp:' + (bp.ref || (bp.invoiceRef + '|' + bp.amount + '|' + bp.date));
    const f = baseFinding('books_razorpay', booksSource, 'razorpay', key);
    f.source_a_ref = bp.ref || bp.invoiceRef || null;
    f.amount_a = Number(bp.amount);
    f.currency = bp.currency || 'INR';
    f.fetched_at_a = bp.fetchedAt || bp.date || null;

    // Tier 1: exact reference match (books reference_number carries the rp id)
    const bpRef = norm(bp.reference);
    let hit = bpRef
      ? captured.find((r) => !usedRpIds.has(r.id) && (norm(r.id) === bpRef || rpRefTokens(r).includes(bpRef)))
      : null;
    let basis = hit ? 'exact_ref' : 'none';

    // Tier 2: amount + currency + date window
    if (!hit) {
      const cands = captured.filter(
        (r) => !usedRpIds.has(r.id) &&
          amountsEqual(r.amount, bp.amount) &&
          norm(r.currency || 'INR') === norm(bp.currency || 'INR') &&
          (daysBetween(r.date, bp.date) ?? 999) <= win
      );
      if (cands.length === 1) { hit = cands[0]; basis = 'amount_date'; }
      else if (cands.length > 1) {
        f.status = 'mismatch';
        f.match_basis = 'amount_only';
        f.reason = `${cands.length} captured Razorpay payments match ₹${bp.amount} within ±${win}d — ambiguous, needs a manual pick.`;
        f.evidence = { candidates: cands.map((c) => ({ id: c.id, amount: c.amount, date: c.date, method: c.method })) };
        findings.push(f);
        continue;
      }
    }

    // Tier 3: amount matches somewhere but outside the window / conflicting id => mismatch
    if (!hit) {
      const loose = captured.find(
        (r) => !usedRpIds.has(r.id) && amountsEqual(r.amount, bp.amount) &&
          norm(r.currency || 'INR') === norm(bp.currency || 'INR')
      );
      if (loose) {
        f.status = 'mismatch';
        f.match_basis = 'amount_only';
        f.source_b_ref = loose.id;
        f.amount_b = Number(loose.amount);
        f.date_diff_days = Math.round(daysBetween(loose.date, bp.date) ?? 0);
        f.fetched_at_b = loose.fetchedAt || null;
        f.reason = `Amount ₹${bp.amount} matches Razorpay ${loose.id} but dates are ${f.date_diff_days}d apart (window ±${win}d) — flagged, not auto-verified.`;
        f.evidence = { books: { ref: bp.ref, date: bp.date }, razorpay: { id: loose.id, date: loose.date } };
        findings.push(f);
        continue;
      }
      f.status = 'unmatched_a';
      f.reason = `No captured Razorpay payment matches ₹${bp.amount} within ±${win}d.`;
      findings.push(f);
      continue;
    }

    // We have a hit.
    usedRpIds.add(hit.id);
    f.source_b_ref = hit.id;
    f.amount_b = Number(hit.amount);
    f.date_diff_days = Math.round(daysBetween(hit.date, bp.date) ?? 0);
    f.match_basis = basis;
    f.fetched_at_b = hit.fetchedAt || null;
    f.evidence = {
      books: { ref: bp.ref, amount: bp.amount, date: bp.date, mode: bp.mode },
      razorpay: { id: hit.id, amount: hit.amount, date: hit.date, method: hit.method, fee: hit.fee }
    };

    const partial = !amountsEqual(hit.amount, bp.amount) && amountsClose(bp.amount, hit.amount, 0.5);
    if (partial) {
      f.status = 'partial';
      f.reason = `Partial: books ₹${bp.amount} vs Razorpay ₹${hit.amount} on ref ${bp.reference || hit.id}. Not forced to a full match.`;
    } else if (bp.sameSourced) {
      f.status = 'mismatch';
      f.match_basis = basis;
      f.reason = `Books payment mode looks Razorpay-sourced — matching Margyn's own Razorpay sync against it is the same transaction twice, not two independent sources. Signal only.`;
    } else {
      f.status = 'verified';
      f.verified_at = new Date().toISOString();
      f.reason = basis === 'exact_ref'
        ? `Books reference matches Razorpay payment ${hit.id} exactly.`
        : `Books ₹${bp.amount} and Razorpay ${hit.id} agree on amount, currency and date (±${f.date_diff_days}d).`;
    }
    findings.push(f);
  }

  // Leftover captured Razorpay payments with no books counterpart.
  for (const rp of captured) {
    if (usedRpIds.has(rp.id)) continue;
    const f = baseFinding('books_razorpay', booksSource, 'razorpay', 'rp:' + rp.id);
    f.source_b_ref = rp.id;
    f.amount_b = Number(rp.amount);
    f.currency = rp.currency || 'INR';
    f.fetched_at_b = rp.fetchedAt || null;
    if (Number(rp.fee) > 0 && opts.mapFeeLedger !== true) {
      // fee lines are not "missing revenue" without a fee-ledger mapping
      f.status = 'unmatched_b';
      f.reason = `Captured Razorpay payment ${rp.id} (₹${rp.amount}, fee ₹${rp.fee}) has no ${booksSource} counterpart. Fee is not booked as lost revenue without a fee-ledger map.`;
    } else {
      f.status = 'unmatched_b';
      f.reason = `Captured Razorpay payment ${rp.id} (₹${rp.amount}) has no ${booksSource} counterpart.`;
    }
    f.evidence = { razorpay: { id: rp.id, amount: rp.amount, date: rp.date, method: rp.method } };
    findings.push(f);
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* 2. Books  <->  Shopify                                              */
/* ------------------------------------------------------------------ */
/**
 * @param {Array} booksInvoices { ref, number, amount, date, currency, party, fetchedAt }
 * @param {Array} shopifyOrders { name, amount, currency, date, financialStatus, fetchedAt }
 */
function matchBooksShopify(booksInvoices, shopifyOrders, opts = {}) {
  const booksSource = opts.booksSource || 'zoho_books';
  const win = opts.dateWindowDays || DEFAULT_DATE_WINDOW_DAYS;
  const orders = (shopifyOrders || []).slice();
  const findings = [];
  const usedOrders = new Set();

  for (const inv of booksInvoices || []) {
    if (inv.amount == null) continue;
    const f = baseFinding('books_shopify', booksSource, 'shopify', 'inv:' + (inv.ref || inv.number || inv.amount + '|' + inv.date));
    f.source_a_ref = inv.number || inv.ref || null;
    f.amount_a = Number(inv.amount);
    f.currency = inv.currency || 'INR';
    f.fetched_at_a = inv.fetchedAt || inv.date || null;

    const invNo = norm(inv.number);
    // Tier 1: order name appears in the invoice number or vice versa
    let hit = invNo
      ? orders.find((o) => !usedOrders.has(o.name) && invNo && (norm(o.name).includes(invNo) || invNo.includes(norm(o.name))))
      : null;
    let basis = hit ? 'exact_ref' : 'none';

    // Tier 2: amount + currency + date window
    if (!hit) {
      const cands = orders.filter(
        (o) => !usedOrders.has(o.name) &&
          amountsEqual(o.amount, inv.amount) &&
          norm(o.currency || 'INR') === norm(inv.currency || 'INR') &&
          (daysBetween(o.date, inv.date) ?? 999) <= win
      );
      if (cands.length === 1) { hit = cands[0]; basis = 'amount_date'; }
      else if (cands.length > 1) {
        f.status = 'mismatch';
        f.match_basis = 'amount_only';
        f.reason = `${cands.length} Shopify orders match ₹${inv.amount} within ±${win}d of invoice ${inv.number || ''} — ambiguous.`;
        f.evidence = { candidates: cands.map((c) => ({ name: c.name, amount: c.amount, date: c.date })) };
        findings.push(f);
        continue;
      }
    }

    if (!hit) {
      f.status = 'unmatched_a';
      f.reason = `Books invoice ${inv.number || inv.ref} (₹${inv.amount}) has no matching Shopify order within ±${win}d.`;
      findings.push(f);
      continue;
    }

    usedOrders.add(hit.name);
    f.source_b_ref = hit.name;
    f.amount_b = Number(hit.amount);
    f.date_diff_days = Math.round(daysBetween(hit.date, inv.date) ?? 0);
    f.match_basis = basis;
    f.fetched_at_b = hit.fetchedAt || null;
    f.evidence = {
      books: { number: inv.number, amount: inv.amount, date: inv.date },
      shopify: { name: hit.name, amount: hit.amount, date: hit.date, financial_status: hit.financialStatus }
    };

    if (!amountsEqual(hit.amount, inv.amount)) {
      f.status = 'partial';
      f.reason = `Partial: books invoice ₹${inv.amount} vs Shopify order ${hit.name} ₹${hit.amount}.`;
    } else if (norm(hit.financialStatus) === 'refunded' || norm(hit.financialStatus) === 'voided') {
      f.status = 'mismatch';
      f.reason = `Books invoice ${inv.number} matches Shopify order ${hit.name} on amount, but the order is ${hit.financialStatus}.`;
    } else {
      f.status = 'verified';
      f.verified_at = new Date().toISOString();
      f.reason = basis === 'exact_ref'
        ? `Books invoice ${inv.number} references Shopify order ${hit.name}.`
        : `Books invoice ₹${inv.amount} and Shopify order ${hit.name} agree on amount, currency and date (±${f.date_diff_days}d).`;
    }
    findings.push(f);
  }

  for (const o of orders) {
    if (usedOrders.has(o.name)) continue;
    if (norm(o.financialStatus) !== 'paid') continue; // only paid orders are expected in books
    const f = baseFinding('books_shopify', booksSource, 'shopify', 'order:' + o.name);
    f.status = opts.hasBooksSnapshot === false ? 'awaiting_books' : 'unmatched_b';
    f.source_b_ref = o.name;
    f.amount_b = Number(o.amount);
    f.currency = o.currency || 'INR';
    f.fetched_at_b = o.fetchedAt || null;
    f.reason = f.status === 'awaiting_books'
      ? `Paid Shopify order ${o.name} (₹${o.amount}) — no books source connected yet.`
      : `Paid Shopify order ${o.name} (₹${o.amount}) has no ${booksSource} sales invoice.`;
    f.evidence = { shopify: { name: o.name, amount: o.amount, date: o.date } };
    findings.push(f);
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* 3. Razorpay  <->  Shopify                                           */
/* ------------------------------------------------------------------ */
/**
 * Gateway capture vs store order marked paid. Surfaces leakage / fee /
 * missing-capture WITHOUT asserting a vendor fee percentage as fact.
 *
 * @param {Array} rpPayments   { id, amount, currency, date, status, fee, orderRef, email, fetchedAt }
 * @param {Array} shopifyOrders { name, amount, currency, date, financialStatus, gateway, fetchedAt }
 */
function matchRazorpayShopify(rpPayments, shopifyOrders, opts = {}) {
  const win = opts.dateWindowDays || DEFAULT_DATE_WINDOW_DAYS;
  const captured = (rpPayments || []).filter((r) => norm(r.status) === 'captured');
  const orders = (shopifyOrders || []).slice();
  const findings = [];
  const usedRp = new Set();

  for (const o of orders) {
    if (norm(o.financialStatus) !== 'paid') continue;
    const f = baseFinding('razorpay_shopify', 'razorpay', 'shopify', 'order:' + o.name);
    f.source_b_ref = o.name;
    f.amount_b = Number(o.amount);
    f.currency = o.currency || 'INR';
    f.fetched_at_b = o.fetchedAt || null;

    const oName = norm(o.name);
    let hit = captured.find((r) => !usedRp.has(r.id) && rpRefTokens(r).some((t) => t && (t.includes(oName) || oName.includes(t))));
    let basis = hit ? 'exact_ref' : 'none';

    if (!hit) {
      const cands = captured.filter(
        (r) => !usedRp.has(r.id) &&
          (daysBetween(r.date, o.date) ?? 999) <= win &&
          (amountsEqual(r.amount, o.amount) || amountsClose(o.amount, r.amount, 0.06)) // allow a gateway fee gap
      );
      if (cands.length === 1) { hit = cands[0]; basis = amountsEqual(cands[0].amount, o.amount) ? 'amount_date' : 'amount_only'; }
      else if (cands.length > 1) {
        f.status = 'mismatch';
        f.match_basis = 'amount_only';
        f.reason = `${cands.length} Razorpay captures near ₹${o.amount} within ±${win}d of order ${o.name} — ambiguous.`;
        f.evidence = { candidates: cands.map((c) => ({ id: c.id, amount: c.amount, date: c.date })) };
        findings.push(f);
        continue;
      }
    }

    if (!hit) {
      // Store says paid, gateway shows no capture — the beachhead case.
      f.status = 'unmatched_b';
      f.reason = `Shopify order ${o.name} is marked paid (₹${o.amount}${o.gateway ? ', ' + o.gateway : ''}) but no Razorpay capture matches within ±${win}d. Possible missing capture / different gateway.`;
      f.evidence = { shopify: { name: o.name, amount: o.amount, date: o.date, gateway: o.gateway } };
      findings.push(f);
      continue;
    }

    usedRp.add(hit.id);
    f.source_a_ref = hit.id;
    f.amount_a = Number(hit.amount);
    f.date_diff_days = Math.round(daysBetween(hit.date, o.date) ?? 0);
    f.match_basis = basis;
    f.fetched_at_a = hit.fetchedAt || null;
    const gap = Number(o.amount) - Number(hit.amount);
    f.evidence = {
      razorpay: { id: hit.id, amount: hit.amount, date: hit.date, fee: hit.fee },
      shopify: { name: o.name, amount: o.amount, date: o.date },
      gross_gap: Math.round(gap * 100) / 100
    };

    if (amountsEqual(hit.amount, o.amount)) {
      f.status = 'verified';
      f.verified_at = new Date().toISOString();
      f.reason = `Razorpay capture ${hit.id} and Shopify order ${o.name} agree on gross ₹${o.amount}.`;
    } else if (gap > 0 && Number(hit.fee) > 0 && Math.abs(gap - Number(hit.fee)) < 1) {
      f.status = 'fee_unallocated';
      f.reason = `Razorpay captured ₹${hit.amount} vs Shopify gross ₹${o.amount}; the ₹${gap.toFixed(2)} gap equals the reported gateway fee. Held as fee_unallocated until a fee ledger maps it — not counted as lost revenue.`;
    } else if (gap > 0) {
      f.status = 'fee_unallocated';
      f.reason = `Razorpay captured ₹${hit.amount} vs Shopify gross ₹${o.amount} (gap ₹${gap.toFixed(2)}). Likely gateway fee/partial; held as fee_unallocated pending a fee-ledger map, not asserted as a 2–5% fee.`;
    } else {
      f.status = 'mismatch';
      f.reason = `Razorpay captured ₹${hit.amount} which is MORE than Shopify order ${o.name} gross ₹${o.amount} — investigate.`;
    }
    findings.push(f);
  }

  return findings;
}

module.exports = {
  matchBooksRazorpay,
  matchBooksShopify,
  matchRazorpayShopify,
  daysBetween,
  amountsEqual,
  amountsClose,
  DEFAULT_DATE_WINDOW_DAYS
};
