/**
 * Close & Collections Agent — pure decision logic (heuristic tier).
 *
 * Mirrors how api/reconcile.js delegates to api/_lib/reconcilerV2.js: no I/O
 * here. api/reconcile.js normalizes rows out of Supabase, calls runAgent(),
 * and upserts the returned proposals into public.agent_actions. Every proposal
 * is staged for a human — nothing is ever applied here.
 *
 * The comprehensive, benchmarked version of these rules lives in
 * tools/scenario-gen/closeAgent.js (18 layers, 5 sources). This is the subset
 * that runs on what the live product actually has connected: books payments +
 * invoices + bills (Zoho/Tally), payment-gateway captures/refunds (Razorpay/
 * Cashfree), Shopify orders, and GSTR-2B lines. No bank-statement axis yet
 * (Account Aggregator not built), so on-account / marketplace / FX-inward /
 * settlement-batch layers are intentionally absent.
 *
 * Input bundle (all arrays may be empty):
 *   booksPayments  { ref, amount, date, currency, invoiceRef, mode, reference, fetchedAt }
 *   invoices       { ref, number, amount, date, dueDate, currency, party }
 *   gateway        { id, amount, currency, date, status, method, fee, description, fetchedAt }
 *   gatewayRefunds { id, captureId, amount, date }
 *   bills          { ref, vendor, vendorGstin, amount, taxableValue, tax, taxRate, date }
 *   gstr2b         { gstin, vendorName, invoiceNo, invoiceDate, taxableValue, filingStatus }
 *   reconFindings  recon_findings rows for this user (what reconcilerV2 already decided)
 *   asOf           ISO date string, defaults to today
 *
 * Output: [{ kind, confidence, proposalKey, title, rationale, amount, currency,
 *            evidence, proposal, sourceFindingKey }]
 */

const KNOWN_TDS_RATES = [
  { rate: 0.10, section: '194J' }, { rate: 0.05, section: '194H' },
  { rate: 0.02, section: '194J' }, { rate: 0.01, section: '194C' },
  { rate: 0.001, section: '194Q' }
];

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const daysBetween = (a, b) => (a && b) ? Math.abs((new Date(a) - new Date(b)) / 86400000) : 1e9;
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol != null ? tol : 0.5);
const gapRatio = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);

function runAgent(bundle) {
  const B = bundle || {};
  const asOf = B.asOf || new Date().toISOString().slice(0, 10);
  const booksPayments = B.booksPayments || [];
  const invoices = B.invoices || [];
  const gateway = (B.gateway || []).filter((g) => norm(g.status) === 'captured' || !g.status);
  const gatewayRefunds = B.gatewayRefunds || [];
  const bills = B.bills || [];
  const gstr2b = B.gstr2b || [];
  const findings = B.reconFindings || [];

  const invByRef = new Map(invoices.map((i) => [String(i.ref), i]));
  const invByNumber = new Map(invoices.filter((i) => i.number).map((i) => [norm(i.number), i]));
  const partyStrings = invoices.map((i) => ({ party: i.party, n: norm(i.party) })).filter((x) => x.n.length > 3);

  const partyOfBooks = (bp) => {
    const inv = invByRef.get(String(bp.invoiceRef));
    return inv ? (inv.party || null) : null;
  };
  const partyOfGateway = (g) => {
    const h = norm(g.description) + ' ' + norm(g.email);
    for (const p of partyStrings) if (h.includes(p.n)) return p.party;
    return null;
  };
  const sameParty = (a, b) => !a || !b || norm(a) === norm(b);

  const bpByRef = new Map(booksPayments.map((b) => [String(b.ref), b]));
  const gById = new Map(gateway.map((g) => [String(g.id), g]));

  // rows reconcilerV2 already settled — the agent must never re-claim these
  const verifiedBp = new Set();
  const verifiedG = new Set();
  for (const f of findings) {
    if (f.status !== 'verified') continue;
    if (f.source_a_ref) verifiedBp.add(String(f.source_a_ref));
    if (f.source_b_ref) verifiedG.add(String(f.source_b_ref));
  }

  const out = [];
  const claimedBp = new Set();
  const claimedG = new Set();
  const push = (o) => { out.push(o); (o._bp || []).forEach((r) => claimedBp.add(r)); (o._g || []).forEach((r) => claimedG.add(r)); };

  const freeGateway = () => gateway.filter((g) => !claimedG.has(String(g.id)) && !verifiedG.has(String(g.id)));

  /* ---- 0. consolidated UTR first — claim these books rows before the per-row
     promote/gap layers can grab one of them for the wrong reason ---- */
  const notCleanlyMatched = (ref) => findings.some((f) =>
    String(f.source_a_ref) === String(ref) && (f.status === 'unmatched_a' || (f.status === 'mismatch' && f.match_basis === 'amount_only')));
  const openBooks = () => booksPayments.filter((b) => b.amount > 0 && !claimedBp.has(String(b.ref)) && !verifiedBp.has(String(b.ref)) && notCleanlyMatched(b.ref));

  for (const g of freeGateway()) {
    const isLoose = findings.some((f) => String(f.source_b_ref) === String(g.id) && ['unmatched_b', 'awaiting_books'].includes(f.status));
    if (!isLoose) continue;
    const pg = partyOfGateway(g);
    let combo = null;

    const hay = ' ' + norm(g.description) + ' ' + norm(g.notesInvoice) + ' ';
    const named = openBooks().filter((b) => {
      const inv = invByRef.get(String(b.invoiceRef));
      const keys = [b.invoiceRef, inv && inv.number, inv && inv.ref].filter(Boolean).map(norm);
      return keys.some((k) => k.length >= 3 && hay.includes(k));
    });
    if (named.length >= 2 && near(named.reduce((s, b) => s + b.amount, 0), g.amount, Math.max(2, g.amount * 0.005))) {
      combo = dedupeByInvoice(named);
    }
    if (!combo) {
      const pool = openBooks().filter((b) => {
        const pb = partyOfBooks(b);
        return (pg && pb) ? sameParty(pg, pb) : (pb && daysBetween(b.date, g.date) <= 12);
      });
      const combos = subsetSums(dedupeByInvoice(pool), g.amount, 2, 4, 1);
      if (combos.length === 1) combo = combos[0];
    }
    if (!combo || combo.length < 2) continue;

    push({
      kind: 'split', confidence: 0.8,
      proposalKey: `split:${g.id}`,
      sourceFindingKey: null,
      title: `Split ₹${money(g.amount)} across ${combo.length} invoices`,
      rationale: `One gateway payment (${g.id}) equals the sum of ${combo.length} open invoices for ${pg || 'this customer'}. Allocate it across them.`,
      amount: money(g.amount), currency: g.currency || 'INR',
      evidence: { gateway: { id: g.id, amount: g.amount, date: g.date }, booksRefs: combo.map((b) => b.ref) },
      proposal: {
        match: { gatewayId: g.id },
        allocations: combo.map((b) => ({ invoiceRef: b.invoiceRef, booksRef: b.ref, amount: money(b.amount) }))
      },
      _bp: combo.map((b) => String(b.ref)), _g: [String(g.id)]
    });
  }

  /* ---- 1. Promote reconcilerV2's "amount matches, dates outside window" ---- */
  for (const f of findings) {
    if (f.pair !== 'books_razorpay' || f.status !== 'mismatch' || f.match_basis !== 'amount_only') continue;
    if (!f.source_a_ref || !f.source_b_ref) continue;
    if (claimedBp.has(String(f.source_a_ref)) || claimedG.has(String(f.source_b_ref))) continue;
    if (verifiedBp.has(String(f.source_a_ref)) || verifiedG.has(String(f.source_b_ref))) continue;
    const bp = bpByRef.get(String(f.source_a_ref));
    const g = gById.get(String(f.source_b_ref));
    if (!bp || !g || !near(bp.amount, g.amount, Math.max(1, bp.amount * 0.001))) continue;
    const inv = invByRef.get(String(bp.invoiceRef));
    const pb = partyOfBooks(bp), pg = partyOfGateway(g);
    if (pb && pg && !sameParty(pb, pg)) continue;               // parties disagree -> leave it
    const advance = inv && new Date(g.date) < new Date(inv.date);
    const dd = Math.round(daysBetween(g.date, bp.date));
    push({
      kind: 'reconcile_match', confidence: 0.72,
      proposalKey: `promote:${f.match_key}`,
      sourceFindingKey: f.match_key,
      title: `Match ${money(bp.amount)} ${bp.currency || 'INR'} — ${advance ? 'customer advance' : `books posted ${dd}d late`}`,
      rationale: advance
        ? `Gateway capture ${g.id} is dated before invoice ${bp.invoiceRef} — this is a prepayment. Same amount, same party; reconcilerV2 only flagged the date gap.`
        : `Books receipt ${bp.ref} and gateway capture ${g.id} agree on amount and party; the books entry was just posted ${dd} days after the payment (outside the ±3d auto-match window).`,
      amount: money(bp.amount), currency: bp.currency || 'INR',
      evidence: { books: { ref: bp.ref, amount: bp.amount, date: bp.date, invoiceRef: bp.invoiceRef }, gateway: { id: g.id, amount: g.amount, date: g.date }, dateDiffDays: dd, advance },
      proposal: { match: { booksRef: bp.ref, gatewayId: g.id, invoiceRef: bp.invoiceRef || null }, markVerified: f.match_key },
      _bp: [String(bp.ref)], _g: [String(g.id)]
    });
  }

  /* ---- 2. Typed money gap on an unmatched books payment ---- */
  for (const f of findings) {
    if (f.pair !== 'books_razorpay' || f.status !== 'unmatched_a' || !f.source_a_ref) continue;
    if (claimedBp.has(String(f.source_a_ref)) || verifiedBp.has(String(f.source_a_ref))) continue;
    const bp = bpByRef.get(String(f.source_a_ref));
    if (!bp || bp.amount <= 0) continue;
    if (['neft', 'cheque', 'rtgs', 'imps', 'credit_note'].includes(norm(bp.mode))) continue;
    const inv = invByRef.get(String(bp.invoiceRef));
    const pb = partyOfBooks(bp);

    const cands = freeGateway().filter((g) => {
      const pg = partyOfGateway(g);
      const r = gapRatio(g.amount, bp.amount);
      return r > 0 && r <= 0.13 && daysBetween(g.date, bp.date) <= 12 &&
        (pb && pg ? sameParty(pb, pg) : true);
    });
    const classified = cands
      .map((g) => ({ g, adj: classifyGap(bp, g, money(bp.amount - g.amount), gapRatio(bp.amount, g.amount), inv, pb) }))
      .filter((x) => x.adj && x.adj.confidence >= 0.7);
    if (classified.length !== 1) continue;
    const { g, adj } = classified[0];

    push({
      kind: adj.journal ? 'journal' : 'reconcile_match',
      confidence: adj.confidence,
      proposalKey: `gap:${f.match_key}`,
      sourceFindingKey: f.match_key,
      title: adj.title,
      rationale: adj.rationale,
      amount: money(Math.abs(bp.amount - g.amount)), currency: bp.currency || 'INR',
      evidence: {
        books: { ref: bp.ref, amount: bp.amount, date: bp.date, invoiceRef: bp.invoiceRef },
        gateway: { id: g.id, amount: g.amount, date: g.date, reportedFee: g.fee },
        gapType: adj.type
      },
      proposal: {
        match: { booksRef: bp.ref, gatewayId: g.id, invoiceRef: bp.invoiceRef || null },
        markVerified: f.match_key,
        journal: adj.journal || null
      },
      _bp: [String(bp.ref)], _g: [String(g.id)]
    });
  }

  /* ---- 3. fee_unallocated -> gateway-fee journal ---- */
  for (const f of findings) {
    if (f.status !== 'fee_unallocated' || !f.source_b_ref) continue;
    if (claimedG.has(String(f.source_b_ref))) continue;
    const g = gById.get(String(f.source_b_ref));
    const feeGross = g ? money(g.fee) : money((f.evidence && f.evidence.gross_gap) || 0);
    if (feeGross <= 0) continue;
    const gst = money(feeGross - feeGross / 1.18);
    push({
      kind: 'journal', confidence: 0.78,
      proposalKey: `fee:${f.match_key}`,
      sourceFindingKey: f.match_key,
      title: `Book gateway fee ₹${money(feeGross - gst)} + GST ₹${gst}`,
      rationale: `Payment ${f.source_b_ref} settled ₹${money(feeGross)} short of the order value; that equals the gateway's reported fee. Book it as a payment-gateway charge (with 18% input GST) rather than lost revenue.`,
      amount: feeGross, currency: f.currency || 'INR',
      evidence: { gateway: { id: f.source_b_ref, reportedFee: g ? g.fee : null }, reason: f.reason },
      proposal: {
        journal: [
          { account: 'Payment Gateway Charges', debit: money(feeGross - gst), credit: 0, narration: `Gateway fee on ${f.source_b_ref}` },
          { account: 'Input GST', debit: gst, credit: 0, narration: `GST on gateway fee ${f.source_b_ref}` },
          { account: 'Bank', debit: 0, credit: feeGross, narration: `Net of fee — ${f.source_b_ref}` }
        ]
      },
      _g: [String(f.source_b_ref)]
    });
  }

  /* ---- 4. partial payment ---- */
  for (const f of findings) {
    if (f.status !== 'partial' || !f.source_a_ref) continue;
    if (claimedBp.has(String(f.source_a_ref))) continue;
    const bp = bpByRef.get(String(f.source_a_ref));
    const disputed = /dispute|short|shortpaid|qty|damage/i.test(f.reason || '') || (bp && /dispute|short|qty|damage/i.test(bp.reference || ''));
    push({
      kind: disputed ? 'flag' : 'reconcile_match',
      confidence: 0.7,
      proposalKey: `partial:${f.match_key}`,
      sourceFindingKey: f.match_key,
      title: disputed
        ? `Short payment on ${f.source_a_ref} — likely a dispute`
        : `Partial payment recorded on ${f.source_a_ref}`,
      rationale: disputed
        ? `The payment is materially below the invoice and the note mentions a dispute/short supply. Confirm whether a credit note is due before treating the invoice as settled.`
        : `Books shows a payment smaller than the linked invoice. If this is a milestone/instalment, mark it partial; if the balance is written off, raise a journal.`,
      amount: f.amount_a != null ? money(f.amount_a) : null, currency: f.currency || 'INR',
      evidence: { finding: { a_ref: f.source_a_ref, b_ref: f.source_b_ref, amount_a: f.amount_a, amount_b: f.amount_b }, reason: f.reason },
      proposal: { flag: disputed ? 'dispute' : 'partial_payment', match: { booksRef: f.source_a_ref, gatewayId: f.source_b_ref || null } },
      _bp: [String(f.source_a_ref)]
    });
  }

  /* ---- 6. duplicate capture ---- */
  for (const f of findings) {
    if (!['unmatched_b'].includes(f.status) || !f.source_b_ref) continue;
    if (claimedG.has(String(f.source_b_ref))) continue;
    const g = gById.get(String(f.source_b_ref));
    if (!g) continue;
    const pg = partyOfGateway(g);
    const twin = gateway.find((x) => String(x.id) !== String(g.id) && near(x.amount, g.amount, 1) &&
      daysBetween(x.date, g.date) <= 3 &&
      (findings.some((ff) => String(ff.source_b_ref) === String(x.id) && ff.status === 'verified')) &&
      (pg ? sameParty(pg, partyOfGateway(x)) : true));
    if (!twin) continue;
    push({
      kind: 'flag', confidence: 0.7,
      proposalKey: `dup:${g.id}`,
      sourceFindingKey: f.match_key,
      title: `Possible duplicate charge — ₹${money(g.amount)}`,
      rationale: `Gateway capture ${g.id} has the same amount and party as the already-matched capture ${twin.id}, ${Math.round(daysBetween(g.date, twin.date))}d apart, with no books counterpart. Customer was likely charged twice — check for a refund owed.`,
      amount: money(g.amount), currency: g.currency || 'INR',
      evidence: { gateway: { id: g.id, amount: g.amount, date: g.date }, twin: { id: twin.id, date: twin.date } },
      proposal: { flag: 'duplicate_charge', gatewayId: g.id, twinGatewayId: twin.id },
      _g: [String(g.id)]
    });
  }

  /* ---- 7. GSTR-2B / ITC ---- */
  // Preferred: the books tool already reconciled 2B and told us the at-risk rows.
  if ((B.itcRisks || []).length) {
    for (const r of B.itcRisks) {
      const missing = /missing/i.test(r.matchStatus || '');
      push({
        kind: 'itc_risk', confidence: missing ? 0.85 : 0.78,
        proposalKey: `itc:${r.matchStatus || 'risk'}:${r.billRef}`,
        title: missing
          ? `ITC at risk — ${r.vendor || 'vendor'} bill ${r.billNumber || r.billRef} not in GSTR-2B`
          : `ITC mismatch — ${r.billNumber || r.billRef} differs from GSTR-2B`,
        rationale: missing
          ? `₹${money(r.atRiskAmount)} of input credit is booked on this bill but the vendor hasn't reported it in GSTR-2B. Chase the vendor before claiming it, or reverse it this period.`
          : `The bill and its GSTR-2B line don't agree (${r.matchStatus}). Reconcile ₹${money(r.atRiskAmount)} before claiming the full credit.`,
        amount: money(r.atRiskAmount), currency: 'INR',
        evidence: { bill: { ref: r.billRef, number: r.billNumber, vendor: r.vendor, date: r.billDate }, matchStatus: r.matchStatus, vendorGstin: r.vendorGstin },
        proposal: {
          flag: missing ? 'itc_at_risk' : 'itc_value_gap', billRef: r.billRef,
          vendorQueryDraft: `Hi ${r.vendor || 'team'}, our purchase invoice ${r.billNumber || ''} dated ${r.billDate || ''} isn't matching our GSTR-2B for the period. Could you confirm it's reported correctly in your GSTR-1? We can't claim the input credit until it reconciles.`
        }
      });
    }
  } else {
    // Fallback (tests / no books-tool 2B feed): derive from raw bills + 2B lines.
    for (const bill of bills) {
      const line = gstr2b.find((l) => l.gstin === bill.vendorGstin && norm(l.invoiceNo) === norm(bill.ref))
        || gstr2b.find((l) => l.gstin === bill.vendorGstin && daysBetween(l.invoiceDate, bill.date) <= 2);
      if (!line) {
        push({
          kind: 'itc_risk', confidence: 0.85, proposalKey: `itc:missing:${bill.ref}`,
          title: `ITC at risk — ${bill.vendor} bill ${bill.ref} not in GSTR-2B`,
          rationale: `Input GST of ₹${money(bill.tax)} is booked but the vendor hasn't reported this bill in GSTR-2B. Follow up before claiming, or reverse it this period.`,
          amount: money(bill.tax), currency: 'INR',
          evidence: { bill: { ref: bill.ref, vendor: bill.vendor, taxableValue: bill.taxableValue, tax: bill.tax } },
          proposal: { flag: 'itc_at_risk', billRef: bill.ref, vendorQueryDraft: `Hi ${bill.vendor}, our purchase invoice ${bill.ref} dated ${bill.date} (taxable ₹${money(bill.taxableValue)}) isn't showing in our GSTR-2B. Could you confirm it's reported in your GSTR-1?` }
        });
        continue;
      }
      if (line.filingStatus === 'filed_next_period') continue;
      if (gapRatio(line.taxableValue, bill.taxableValue) > 0.02) {
        push({
          kind: 'itc_risk', confidence: 0.8, proposalKey: `itc:gap:${bill.ref}`,
          title: `ITC mismatch — ${bill.ref} value differs from GSTR-2B`,
          rationale: `Booked taxable value ₹${money(bill.taxableValue)}; GSTR-2B shows ₹${money(line.taxableValue)}. Reconcile before claiming the full credit.`,
          amount: money(Math.abs(bill.taxableValue - line.taxableValue) * (bill.taxRate || 0.18)), currency: 'INR',
          evidence: { bill: { ref: bill.ref, taxableValue: bill.taxableValue }, gstr2b: { taxableValue: line.taxableValue } },
          proposal: { flag: 'itc_value_gap', billRef: bill.ref }
        });
      }
    }
  }

  /* ---- 8. bad-debt aging ---- */
  for (const inv of invoices) {
    if (inv.balance != null && inv.balance <= 0.5) continue;           // books says settled
    if (/paid|void|written_off/i.test(inv.status || '')) continue;
    const paid = booksPayments.some((b) => String(b.invoiceRef) === String(inv.ref) && b.amount > 0) ||
      out.some((o) => (o.proposal.allocations || []).some((a) => String(a.invoiceRef) === String(inv.ref)));
    if (paid && inv.balance == null) continue;
    const due = inv.dueDate || inv.date;
    const overdue = daysBetween(asOf, due);
    // 120d if the books tool confirms an open balance; 150d when we're inferring
    // "unpaid" only from the absence of a payment row (noisier).
    const threshold = inv.balance != null ? 120 : 150;
    if (due && new Date(due) < new Date(asOf) && overdue > threshold && overdue < 730) {
      const outstanding = inv.balance != null ? inv.balance : inv.amount;
      push({
        kind: 'bad_debt', confidence: 0.7,
        proposalKey: `baddebt:${inv.ref}`,
        title: `${inv.party || 'Customer'} invoice ${inv.number || inv.ref} — ${Math.round(overdue)}d overdue, ₹${money(outstanding)} unpaid`,
        rationale: `₹${money(outstanding)} outstanding and ${Math.round(overdue)} days past due with no payment recorded. Review for a provision / write-off, or escalate collection.`,
        amount: money(outstanding), currency: inv.currency || 'INR',
        evidence: { invoice: { ref: inv.ref, number: inv.number, amount: inv.amount, balance: inv.balance, dueDate: due, party: inv.party } },
        proposal: { flag: 'bad_debt_candidate', invoiceRef: inv.ref }
      });
    }
  }

  /* ---- 9. refund annotation on verified matches ---- */
  for (const f of findings) {
    if (f.status !== 'verified' || !f.source_b_ref) continue;
    const rf = gatewayRefunds.find((r) => String(r.captureId) === String(f.source_b_ref));
    if (!rf) continue;
    push({
      kind: 'flag', confidence: 0.8,
      proposalKey: `refund:${rf.id}`,
      sourceFindingKey: f.match_key,
      title: `Refund of ₹${money(rf.amount)} issued against ${f.source_b_ref}`,
      rationale: `A refund was processed after this payment was reconciled. Make sure the revenue reversal / credit note is booked.`,
      amount: money(rf.amount), currency: f.currency || 'INR',
      evidence: { gateway: { id: f.source_b_ref }, refund: { id: rf.id, amount: rf.amount, date: rf.date } },
      proposal: { flag: 'refund_booked_check', gatewayId: f.source_b_ref, refundId: rf.id }
    });
  }

  /* ---- 10. netting: a verified match that's actually a vendor contra ----
     reconcilerV2 already matches this pair cleanly (books and gateway agree
     exactly, so it comes back 'verified' with a bland "amounts match" reason)
     — the counterparty paid invoice-minus-bill, not the full invoice, and
     both the books row and the gateway capture already reflect the NET
     amount. This layer doesn't re-match anything (it's already matched); it
     annotates the verified pair with the reconciling item so it doesn't read
     as a short payment. Keyed off an explicit bill reference in the payment
     narration — a same-amount coincidence to an unrelated bill is not
     evidence, an explicit reference is. */
  for (const f of findings) {
    if (f.status !== 'verified' || f.pair !== 'books_razorpay' || !f.source_a_ref || !f.source_b_ref) continue;
    const bp = bpByRef.get(String(f.source_a_ref));
    const g = gById.get(String(f.source_b_ref));
    if (!bp || !g || !bp.invoiceRef) continue;
    const inv = invByRef.get(String(bp.invoiceRef));
    if (!inv) continue;
    const hay = norm(g.description) + ' ' + norm(g.notesInvoice) + ' ' + norm(bp.reference);
    const bill = bills.find((b) => b.ref && hay.includes(norm(b.ref)));
    if (!bill) continue;
    const shortfall = money(inv.amount - bp.amount);
    if (shortfall <= 0 || !near(shortfall, Number(bill.amount), Math.max(2, bill.amount * 0.02))) continue;

    push({
      kind: 'journal', confidence: 0.74,
      proposalKey: `netting:${f.match_key}`,
      sourceFindingKey: f.match_key,
      title: `Netted against bill ${bill.ref}`,
      rationale: `Invoice ${inv.number || inv.ref} is ₹${money(shortfall)} short of what was received, and the payment narration cites ${bill.ref}. The counterparty looks like a vendor too, and appears to have deducted that bill from this payment rather than paying it separately.`,
      amount: money(bill.amount), currency: bp.currency || 'INR',
      evidence: {
        books: { ref: bp.ref, amount: bp.amount, invoiceRef: bp.invoiceRef },
        invoice: { ref: inv.ref, number: inv.number, amount: inv.amount },
        bill: { ref: bill.ref, amount: bill.amount }
      },
      proposal: {
        match: { invoiceRef: bp.invoiceRef || null },
        journal: [
          { account: 'Accounts Payable', debit: money(bill.amount), credit: 0, narration: `Contra vs ${bill.ref}` },
          { account: 'Accounts Receivable', debit: 0, credit: money(bill.amount), narration: `Contra vs ${bp.invoiceRef || bp.ref}` }
        ],
        billRef: bill.ref
      }
    });
  }

  return out.map((o) => { delete o._bp; delete o._g; return o; });
}

/* ---- gap classification (ported from tools/scenario-gen/closeAgent.js) ---- */
function classifyGap(bp, g, gap, r, inv, party) {
  const flat = Math.abs(gap);
  if (flat <= 15 && r < 0.0015) {
    return { type: 'rounding', confidence: 0.78, title: `Match ${money(bp.amount)} — ₹${money(gap)} rounding`, rationale: `Customer rounded the payment; write off the ₹${money(gap)} difference.`, journal: [{ account: 'Rounding Off', debit: money(gap), credit: 0, narration: `Rounding on ${bp.invoiceRef || bp.ref}` }] };
  }
  if (gap > 0) {                                            // books higher -> customer withheld
    const paidFast = inv && daysBetween(g.date, inv.date) <= 12;
    if ((/discount|2\/10/i.test(bp.reference || '') || paidFast) && r >= 0.017 && r <= 0.023) {
      return { type: 'early_pay_discount', confidence: 0.72, title: `Match ${money(bp.amount)} — 2% early-payment discount`, rationale: `Customer took an early-payment (2/10) discount of ₹${money(gap)}.`, journal: [{ account: 'Discount Allowed', debit: money(gap), credit: 0, narration: `Early-payment discount ${bp.invoiceRef || bp.ref}` }] };
    }
    for (const k of KNOWN_TDS_RATES) {
      if (Math.abs(r - k.rate) / k.rate <= 0.06) {
        return {
          type: 'tds', confidence: 0.82,
          title: `Match ${money(bp.amount)} — ${(k.rate * 100).toFixed(k.rate < 0.01 ? 1 : 0)}% TDS withheld (${k.section})`,
          rationale: `Customer paid ₹${money(g.amount)} against a ₹${money(bp.amount)} liability — a ${(k.rate * 100).toFixed(k.rate < 0.01 ? 1 : 0)}% deduction under section ${k.section}. Book a TDS receivable; chase the Form 16A certificate at quarter-end.`,
          journal: [
            { account: 'TDS Receivable', debit: money(gap), credit: 0, narration: `TDS ${k.section} on ${bp.invoiceRef || bp.ref}` },
            { account: 'Bank', debit: money(g.amount), credit: 0, narration: `Net received ${bp.invoiceRef || bp.ref}` },
            { account: 'Accounts Receivable', debit: 0, credit: money(bp.amount), narration: `Settle ${bp.invoiceRef || bp.ref}` }
          ]
        };
      }
    }
    if (flat >= 20 && flat <= 65 && r < 0.0035 && /netbank|rtgs|neft/i.test(g.method || '')) {
      return { type: 'bank_charge', confidence: 0.72, title: `Match ${money(bp.amount)} — ₹${money(flat)} bank charge`, rationale: `A flat ₹${money(flat)} NEFT/RTGS charge was deducted by the customer's bank.`, journal: [{ account: 'Bank Charges', debit: money(flat), credit: 0, narration: `Inbound transfer charge ${bp.invoiceRef || bp.ref}` }] };
    }
  } else {                                                  // gateway higher -> extra added
    const abs = -gap;
    if (Math.abs(r - 0.001) / 0.001 <= 0.2) {
      return { type: 'tcs', confidence: 0.75, title: `Match ${money(bp.amount)} — ₹${money(abs)} TCS added`, rationale: `Customer added 0.1% TCS under 206C(1H); ₹${money(abs)} more than the invoice.`, journal: [{ account: 'TCS Payable', debit: 0, credit: money(abs), narration: `TCS 206C on ${bp.invoiceRef || bp.ref}` }] };
    }
    if (r >= 0.012 && r <= 0.05 && g.fee > 0) {
      const withGst = g.fee * 1.18;
      if (Math.abs(abs - withGst) / withGst <= 0.15 || Math.abs(abs - g.fee) / g.fee <= 0.1) {
        const gst = money(abs - abs / 1.18);
        const fee = money(abs - gst);
        return { type: 'gateway_fee', confidence: 0.8, title: `Match ${money(bp.amount)} — books is net of gateway fee`, rationale: `Books recorded the net settled amount; the ₹${money(abs)} gap is the gateway fee (₹${fee}) plus 18% GST (₹${gst}), which matches the gateway's reported fee.`, journal: [{ account: 'Payment Gateway Charges', debit: fee, credit: 0, narration: `Fee ${bp.invoiceRef || bp.ref}` }, { account: 'Input GST', debit: gst, credit: 0, narration: `GST on fee ${bp.invoiceRef || bp.ref}` }] };
      }
    }
  }
  return null;
}

function dedupeByInvoice(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) { const k = String(r.invoiceRef || r.ref); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}
function subsetSums(items, target, lo, hi, tol) {
  const arr = items.slice().sort((a, b) => b.amount - a.amount);
  const n = Math.min(arr.length, 16);
  const found = [];
  const rec = (start, acc, picked) => {
    if (picked.length >= lo && Math.abs(acc - target) <= tol) { found.push(picked.slice()); return; }
    if (picked.length >= hi || start >= n || found.length > 3) return;
    for (let i = start; i < n; i++) rec(i + 1, acc + arr[i].amount, picked.concat(arr[i]));
  };
  rec(0, 0, []);
  return found;
}

module.exports = { runAgent, classifyGap };
