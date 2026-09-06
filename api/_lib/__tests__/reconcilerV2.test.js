/**
 * Reconciler v2 fixtures — zero-dep. Run: node api/_lib/__tests__/reconcilerV2.test.js
 *
 * No prod credentials, no network. Each fixture is a plain object literal
 * fed straight into the pure matchers in ../reconcilerV2.js.
 *
 * Covers the six cases the SPEC requires:
 *   1. Exact id match                              -> verified
 *   2. Same amount, different ids/dates            -> mismatch
 *   3. Razorpay with empty books                   -> awaiting_books
 *   4. Tally-only books + Razorpay match (no Zoho) -> verified, source_a = 'tally'
 *   5. Zoho-only books + Razorpay match (no Tally) -> verified, source_a = 'zoho_books'
 *   6. Shopify paid vs Razorpay missing capture    -> unmatched/mismatch
 */

const {
  matchBooksRazorpay,
  matchBooksShopify,
  matchRazorpayShopify
} = require('../reconcilerV2');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + JSON.stringify(detail) : '')); }
}

/* 1. Exact id match -> verified ------------------------------------- */
(() => {
  const books = [{ ref: 'INV-001', amount: 5000, date: '2026-08-10', reference: 'pay_ABC123', invoiceRef: 'INV-001' }];
  const rp = [{ id: 'pay_ABC123', amount: 5000, currency: 'INR', date: '2026-08-11', status: 'captured', method: 'upi' }];
  const out = matchBooksRazorpay(books, rp, { booksSource: 'zoho_books', hasBooksSnapshot: true });
  const v = out.find((f) => f.source_b_ref === 'pay_ABC123');
  check('1: exact id -> verified', v && v.status === 'verified' && v.match_basis === 'exact_ref', v);
})();

/* 2. Same amount, different ids/dates -> mismatch ------------------- */
(() => {
  const books = [{ ref: 'INV-002', amount: 12000, date: '2026-08-01', reference: 'pay_ZOHO_ONLY', invoiceRef: 'INV-002' }];
  const rp = [{ id: 'pay_DIFFERENT', amount: 12000, currency: 'INR', date: '2026-08-20', status: 'captured' }];
  const out = matchBooksRazorpay(books, rp, { booksSource: 'zoho_books', hasBooksSnapshot: true, dateWindowDays: 3 });
  const m = out.find((f) => f.amount_a === 12000);
  check('2: amount match, dates 19d apart -> mismatch', m && m.status === 'mismatch', m);
  check('2: not auto-verified', m && m.status !== 'verified' && !m.verified_at, m);
})();

/* 3. Razorpay with empty books -> awaiting_books ------------------- */
(() => {
  const rp = [
    { id: 'pay_AWAIT1', amount: 999, currency: 'INR', date: '2026-08-15', status: 'captured' },
    { id: 'pay_AWAIT2', amount: 4500, currency: 'INR', date: '2026-08-16', status: 'captured' }
  ];
  const out = matchBooksRazorpay([], rp, { booksSource: 'zoho_books', hasBooksSnapshot: false });
  check('3: all rows awaiting_books', out.length === 2 && out.every((f) => f.status === 'awaiting_books'), out);
  check('3: not a silent no-op', out.length > 0);
})();

/* 4. Tally-only books + Razorpay match (no Zoho) ------------------- */
(() => {
  const tallyReceipts = [{ ref: 'RCPT-42', amount: 8000, date: '2026-08-05', reference: null, invoiceRef: 'SALE-42' }];
  const rp = [{ id: 'pay_T1', amount: 8000, currency: 'INR', date: '2026-08-06', status: 'captured', method: 'card' }];
  const out = matchBooksRazorpay(tallyReceipts, rp, { booksSource: 'tally', hasBooksSnapshot: true });
  const v = out.find((f) => f.amount_a === 8000);
  check('4: tally receipt + rp -> verified', v && v.status === 'verified' && v.match_basis === 'amount_date', v);
  check('4: source_a tagged tally (not blended)', v && v.source_a === 'tally' && v.source_b === 'razorpay', v);
})();

/* 5. Zoho-only books + Razorpay match (no Tally) ------------------- */
(() => {
  const zoho = [{ ref: 'ZPAY-9', amount: 15000, date: '2026-08-12', reference: null, invoiceRef: 'INV-9' }];
  const rp = [{ id: 'pay_Z1', amount: 15000, currency: 'INR', date: '2026-08-12', status: 'captured' }];
  const out = matchBooksRazorpay(zoho, rp, { booksSource: 'zoho_books', hasBooksSnapshot: true });
  const v = out.find((f) => f.amount_a === 15000);
  check('5: zoho + rp -> verified', v && v.status === 'verified', v);
  check('5: source_a tagged zoho_books', v && v.source_a === 'zoho_books', v);
})();

/* 6. Shopify paid vs Razorpay missing capture -> unmatched/mismatch */
(() => {
  const rp = [{ id: 'pay_OTHER', amount: 100, currency: 'INR', date: '2026-08-01', status: 'captured' }];
  const orders = [{ name: '#1005', amount: 3200, currency: 'INR', date: '2026-08-18', financialStatus: 'paid', gateway: 'razorpay' }];
  const out = matchRazorpayShopify(rp, orders, { dateWindowDays: 3 });
  const f = out.find((x) => x.source_b_ref === '#1005');
  check('6: paid order, no capture -> unmatched_b', f && (f.status === 'unmatched_b' || f.status === 'mismatch'), f);
  check('6: reason mentions missing capture', f && /missing capture|no Razorpay capture/i.test(f.reason || ''), f);
})();

/* bonus: Razorpay<->Shopify fee gap -> fee_unallocated ------------- */
(() => {
  const rp = [{ id: 'pay_FEE', amount: 2950, currency: 'INR', date: '2026-08-18', status: 'captured', fee: 50 }];
  const orders = [{ name: '#1006', amount: 3000, currency: 'INR', date: '2026-08-18', financialStatus: 'paid', gateway: 'razorpay' }];
  const out = matchRazorpayShopify(rp, orders);
  const f = out.find((x) => x.source_b_ref === '#1006');
  check('bonus: fee gap -> fee_unallocated (not lost revenue)', f && f.status === 'fee_unallocated', f);
})();

/* bonus: Books<->Shopify exact ref -> verified -------------------- */
(() => {
  const inv = [{ ref: 'INV-77', number: 'INV-77', amount: 4000, date: '2026-08-10', party: 'Acme' }];
  const orders = [{ name: 'INV-77', amount: 4000, currency: 'INR', date: '2026-08-10', financialStatus: 'paid' }];
  const out = matchBooksShopify(inv, orders, { booksSource: 'zoho_books', hasBooksSnapshot: true });
  const v = out.find((f) => f.source_a_ref === 'INV-77');
  check('bonus: books<->shopify exact ref -> verified', v && v.status === 'verified', v);
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
