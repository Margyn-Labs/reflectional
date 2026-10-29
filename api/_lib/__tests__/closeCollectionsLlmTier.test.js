/**
 * Close & Collections Agent — Tier 2 (LLM), live-product version.
 *   node api/_lib/__tests__/closeCollectionsLlmTier.test.js
 *
 * Zero API cost: every Claude call is mocked via a stubbed global.fetch, so
 * this suite runs entirely offline and stays that way forever. It locks the
 * wiring (grouping, the checker, the merge-ready proposal shape) — it does
 * NOT tell you anything about real model quality, which is what the paid
 * runs against tools/scenario-gen/ are for.
 */

const { runAgent } = require('../closeCollectionsAgent');
const { runLlmTier } = require('../closeCollectionsLlmTier');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail) : '')); }
};

const realFetch = global.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
function mockFetch(toolUseInput) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', input: toolUseInput }] })
  });
}
function restoreFetch() {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
}

const bundle = {
  booksPayments: [
    { ref: 'bp_1', amount: 82000, date: '2026-05-04', currency: 'INR', invoiceRef: 'INV-1', mode: 'upi', reference: null },
    { ref: 'bp_2', amount: 500000, date: '2026-04-05', currency: 'INR', invoiceRef: null, mode: 'upi', reference: null }
  ],
  invoices: [
    { ref: 'INV-1', number: 'INV-1', amount: 82000, date: '2026-04-20', dueDate: '2026-05-20', currency: 'INR', party: 'Test Client Pvt Ltd' },
    { ref: 'INV-2', number: 'INV-2', amount: 56000, date: '2026-04-01', dueDate: '2026-05-01', currency: 'INR', party: 'Northstar Digital' },
    { ref: 'INV-3', number: 'INV-3', amount: 44000, date: '2026-03-15', dueDate: '2026-04-15', currency: 'INR', party: 'Northstar Digital' },
    { ref: 'INV-FUTURE', number: 'INV-FUTURE', amount: 999999, date: '2026-06-01', dueDate: '2026-07-01', currency: 'INR', party: 'Northstar Digital' }
  ],
  gateway: [
    { id: 'pay_1', amount: 82000, currency: 'INR', date: '2026-05-05', status: 'captured', method: 'upi', fee: 0, description: 'Payment' },
    { id: 'pay_2', amount: 500000, currency: 'INR', date: '2026-04-04', status: 'captured', method: 'upi', fee: 0, description: 'Northstar ON ACCOUNT' }
  ],
  gatewayRefunds: [], bills: [], gstr2b: [],
  reconFindings: [
    { pair: 'books_razorpay', status: 'unmatched_a', source_a_ref: 'bp_1', match_key: 'k1' },
    { pair: 'books_razorpay', status: 'unmatched_a', source_a_ref: 'bp_2', match_key: 'k2' },
    { pair: 'books_razorpay', status: 'unmatched_b', source_b_ref: 'pay_1', match_key: 'k3' },
    { pair: 'books_razorpay', status: 'unmatched_b', source_b_ref: 'pay_2', match_key: 'k4' }
  ],
  asOf: '2026-09-11'
};

(async () => {
  /* 1. no API key -> no-op, $0, no fetch call attempted */
  {
    delete process.env.ANTHROPIC_API_KEY;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
    const r = await runLlmTier(bundle, [{ ref: 'bp_2', amount: 500000, date: '2026-04-05', invoiceRef: null, party: 'Northstar Digital' }]);
    check('no ANTHROPIC_API_KEY -> usedLlm false, no proposals', r.usedLlm === false && r.proposals.length === 0);
    check('no ANTHROPIC_API_KEY -> fetch never called', !fetchCalled);
    restoreFetch();
  }

  /* 2. valid proposal -> accepted, shaped for direct merge into agent_actions rows */
  {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch({ kind: 'match', confidence: 0.9, booksRefs: ['bp_1'], gatewayIds: ['pay_1'], invoiceRefs: ['INV-1'], reason: 'exact match' });
    const exceptions = [{ ref: 'bp_1', amount: 82000, date: '2026-05-04', invoiceRef: 'INV-1', party: 'Test Client Pvt Ltd' }];
    const r = await runLlmTier(bundle, exceptions);
    check('valid single proposal accepted', r.proposals.length === 1 && r.improved === 1, r);
    const p = r.proposals[0];
    check('accepted proposal has the agent_actions-ready shape', !!p.proposalKey && !!p.kind && p.evidence && p.proposal, p);
    restoreFetch();
  }

  /* 3. proposal referencing a nonexistent row -> silently dropped, not thrown */
  {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch({ kind: 'match', confidence: 0.9, booksRefs: ['bp_does_not_exist'], gatewayIds: ['pay_1'], reason: 'bad ref' });
    const r = await runLlmTier(bundle, [{ ref: 'bp_1', amount: 82000, date: '2026-05-04', invoiceRef: 'INV-1', party: 'Test Client Pvt Ltd' }]);
    check('proposal with a nonexistent row is dropped, not crashed', r.proposals.length === 0);
    restoreFetch();
  }

  /* 4. allocation to an invoice dated AFTER the payment -> rejected by the date guard */
  {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch({
      kind: 'on_account', confidence: 0.7, booksRefs: ['bp_2'], gatewayIds: ['pay_2'],
      allocations: [
        { invoiceRef: 'INV-2', amount: 56000 }, { invoiceRef: 'INV-3', amount: 44000 },
        { invoiceRef: 'INV-FUTURE', amount: 400000 }
      ],
      reason: 'FIFO across open invoices'
    });
    const r = await runLlmTier(bundle, [{ ref: 'bp_2', amount: 500000, date: '2026-04-05', invoiceRef: null, party: 'Northstar Digital' }]);
    check('allocation naming a future-dated invoice is rejected, not accepted as fact', r.proposals.length === 0, r);
    restoreFetch();
  }

  /* 5. a genuinely partial on_account allocation (real remainder, no future
        invoices) -> accepted. Must NOT require allocations to sum to the
        full payment — that's what pushed the model to pad in a future-dated
        invoice just to force an exact match (see check 4 and
        tools/scenario-gen/validate.js for the full story). */
  {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockFetch({
      kind: 'on_account', confidence: 0.75, booksRefs: ['bp_2'], gatewayIds: ['pay_2'],
      allocations: [{ invoiceRef: 'INV-2', amount: 56000 }, { invoiceRef: 'INV-3', amount: 44000 }],
      adjustments: [], reason: 'On-account, FIFO across 2 open invoices, ₹400,000 remainder is a customer advance'
    });
    const r = await runLlmTier(bundle, [{ ref: 'bp_2', amount: 500000, date: '2026-04-05', invoiceRef: null, party: 'Northstar Digital' }]);
    check('partial on_account allocation with a real remainder is accepted', r.proposals.length === 1, r);
  }

  /* 5b. but an allocation summing to MORE than was actually received must
         still be rejected — the remainder allowance must not become a
         license to overstate what was settled. */
  {
    mockFetch({
      kind: 'on_account', confidence: 0.75, booksRefs: ['bp_2'], gatewayIds: ['pay_2'],
      allocations: [{ invoiceRef: 'INV-2', amount: 56000 }, { invoiceRef: 'INV-3', amount: 44000 }, { invoiceRef: 'INV-1', amount: 500000 }],
      reason: 'over-claims the payment'
    });
    const r = await runLlmTier(bundle, [{ ref: 'bp_2', amount: 500000, date: '2026-04-05', invoiceRef: null, party: 'Northstar Digital' }]);
    check('on_account allocation summing to MORE than received is still rejected', r.proposals.length === 0, r);
    restoreFetch();
  }

  /* 6. maxCalls bounds spend — never makes more calls than the cap */
  {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { kind: 'needs_human', confidence: 0.3, reason: 'unsure' } }] }) }; };
    const exceptions = [
      { ref: 'bp_a', amount: 1000, date: '2026-01-01', invoiceRef: null, party: 'Party A' },
      { ref: 'bp_b', amount: 2000, date: '2026-01-01', invoiceRef: null, party: 'Party B' },
      { ref: 'bp_c', amount: 3000, date: '2026-01-01', invoiceRef: null, party: 'Party C' }
    ];
    await runLlmTier(bundle, exceptions, { maxCalls: 1 });
    check('maxCalls bounds the number of Claude calls made', calls === 1, calls);
    restoreFetch();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
})();
