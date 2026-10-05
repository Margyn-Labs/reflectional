/**
 * Write-back plan + queue. Zero-dep. Run: node api/_lib/__tests__/writeBack.test.js
 */
const wb = require('../writeBack');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/* An in-memory stand-in for supabaseRest: select / insert / update on PostgREST-ish filters. */
function memDb({ missing = [] } = {}) {
  const t = { app_writes: [], app_write_access: [] };
  let n = 0;
  const parse = (q) => Object.fromEntries(String(q).split('&').filter((x) => /=/.test(x) && !/^(select|order|limit)=/.test(x)).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const hit = (row, f) => Object.entries(f).every(([k, v]) => {
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    return true;
  });
  const gone = (table) => { if (missing.includes(table)) throw new Error(`Select on ${table} failed: 404 {"code":"PGRST205","message":"Could not find the table 'public.${table}' in the schema cache"}`); };
  return {
    t,
    select: async (table, q) => { gone(table); return (t[table] || []).filter((r) => hit(r, parse(q))).map((r) => ({ ...r })); },
    insert: async (table, rows) => { gone(table); const out = rows.map((r) => ({ id: 'w' + (++n), attempts: 0, ...r })); t[table].push(...out); return out; },
    update: async (table, f, patch) => { gone(table); const rows = t[table].filter((r) => hit(r, parse(f))); rows.forEach((r) => Object.assign(r, patch)); return rows; }
  };
}

(async () => {
  // ---- the plan: what each kind of approval writes, and where
  const match = wb.planWrites('agent_action', { id: 'a1', kind: 'split', org_ref: 'org1', amount: 1185000, proposal: { allocations: [{ invoiceRef: 'INV-00266', amount: 592500 }, { invoiceRef: 'INV-00267', amount: 592500 }] } }, ['zoho']);
  check('a split payment records one payment per invoice, in Zoho (org_ref)', match.length === 2 && match.every((w) => w.app === 'zoho' && w.action === 'record_payment') && match[0].ref === 'INV-00266', match);
  const tally = wb.planWrites('agent_action', { id: 'a2', kind: 'journal', proposal: { source: 'tally', journal: [{ account: 'TDS receivable', debit: 4080 }, { account: 'Sundry debtors', credit: 4080 }] }, title: 'Book TDS short-payment on INV-00288' }, ['zoho', 'tally']);
  check('a Tally journal proposal posts a journal to Tally', tally.length === 1 && tally[0].app === 'tally' && tally[0].action === 'post_journal' && tally[0].payload.lines.length === 2, tally);
  check('a GST hold is decided in Margyn: nothing to write', wb.planWrites('agent_action', { id: 'a3', kind: 'itc_risk', org_ref: 'o' }, ['zoho']).length === 0);
  check('no books app connected: nothing to write', wb.planWrites('agent_action', { id: 'a4', kind: 'journal', proposal: { journal: [{ account: 'x', debit: 1 }] } }, []).length === 0);
  const rm = wb.planWrites('recon_match', { invoice_ref: 'Z123', invoice_number: 'INV-00284', matched_amount: 320000, razorpay_payment_id: 'pay_1' }, ['zoho']);
  check('a confirmed payment match records the payment in Zoho', rm.length === 1 && rm[0].payload.paymentRef === 'pay_1' && /INV-00284/.test(rm[0].summary), rm);
  const doc = wb.planWrites('suggestion', { id: 's1', entries: [{ target: 'payable', party: 'Shree Ganesh Packaging', amount: 68400, _i: 2 }, { target: 'cash', amount: 5 }, { target: 'receivable', party: 'Kaveri Stores', amount: 19600, _i: 4 }] }, ['tally']);
  check('a forwarded bill and invoice become a bill and an invoice in the books app; other figures write nothing', doc.length === 2 && doc[0].action === 'create_bill' && doc[0].app === 'tally' && doc[0].ref === 's1:2' && doc[1].action === 'create_invoice' && doc[1].ref === 's1:4', doc);

  // ---- today: no app is writable, so writes wait, honestly
  const db = memDb();
  const r1 = await wb.enqueueWrites(db, { accountId: 'acct', source: 'agent_action', sourceId: 'a1', writes: match, approvedByName: 'Aditi' });
  check('approving queues the writes', r1.queued === 2 && db.t.app_writes.length === 2);
  check('with no writer they wait for access, and say why', db.t.app_writes.every((w) => w.status === 'waiting_access' && /can’t write to Zoho Books yet/.test(w.status_note)), db.t.app_writes);
  check('the approval result lists them', r1.writes.length === 2 && r1.writes.every((w) => w.status === 'waiting_access'));
  const caps = wb.capabilities([], ['zoho', 'razorpay']);
  check('Apps matrix: every app, what it would write, all off today', caps.length === 6 && caps.find((c) => c.app === 'zoho').writes.length === 4 && caps.every((c) => !c.any_on) && caps.find((c) => c.app === 'zoho').connected, caps.map((c) => c.app));

  // ---- later: a connector gets a writer and the customer grants access
  const sent = [];
  const writers = { ...wb.WRITERS, zoho: { ...wb.WRITERS.zoho, execute: async (w) => { sent.push(w.ref); return { externalRef: 'zp_' + w.ref }; } } };
  let r2 = await wb.runWrites(db, 'acct', { writers });
  check('a writer without the customer’s grant still does not send', sent.length === 0 && r2.writes.every((w) => w.status === 'waiting_access' && /read-only/.test(w.status_note)), r2.writes);
  db.t.app_write_access.push({ user_id: 'acct', app: 'zoho', enabled: true });
  r2 = await wb.runWrites(db, 'acct', { writers });
  check('with the writer and the grant, waiting writes go out', sent.join() === 'INV-00266,INV-00267' && db.t.app_writes.every((w) => w.status === 'writing' && w.external_ref === 'zp_' + w.ref), db.t.app_writes);
  const n = await wb.confirmWrites(db, 'acct', 'zoho', ['zp_INV-00266']);
  check('the next sync confirms what it sees, only that', n === 1 && db.t.app_writes.find((w) => w.ref === 'INV-00266').status === 'confirmed' && db.t.app_writes.find((w) => w.ref === 'INV-00267').status === 'writing');
  const boom = { ...wb.WRITERS, zoho: { ...wb.WRITERS.zoho, execute: async () => { throw new Error('Zoho said 400: invoice is void'); } } };
  db.t.app_writes.push({ id: 'wx', user_id: 'acct', app: 'zoho', action: 'record_payment', ref: 'INV-9', status: 'queued', attempts: 0 });
  await wb.runWrites(db, 'acct', { writers: boom, ids: ['wx'] });
  check('a write the app refuses is failed, with the app’s reason', db.t.app_writes.find((w) => w.id === 'wx').status === 'failed' && /invoice is void/.test(db.t.app_writes.find((w) => w.id === 'wx').status_note));

  // ---- before the SQL runs: the approval still works
  const off = await wb.enqueueWrites(memDb({ missing: ['app_writes'] }), { accountId: 'acct', source: 'agent_action', sourceId: 'a1', writes: match });
  check('no app_writes table yet: nothing thrown, says it is not set up', off.queued === 0 && off.off === true && /not set up/.test(off.note), off);
  check('nothing planned: nothing queued, no calls', (await wb.enqueueWrites(memDb({ missing: ['app_writes'] }), { accountId: 'a', source: 'agent_action', sourceId: 'x', writes: [] })).queued === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
