/**
 * WhatsApp-confirmed actions name who confirmed them in the Audit log.
 * Zero-dep. Run: node api/_lib/__tests__/auditActor.test.js
 * supabaseRest is replaced with an in-memory fake before marginActions loads.
 */
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

const DB = { receivables: [{ id: 'r1', user_id: 'acct', party_name: 'Kaveri Stores', amount: 196000, status: 'open', source: 'manual' }], payables: [], ledger_events: [] };
let refuseActorColumns = false;
const fake = {
  async selectRows(table, qs) {
    const p = new URLSearchParams(qs);
    return (DB[table] || []).filter((r) => [...p].every(([k, v]) => !v.startsWith('eq.') || String(r[k]) === v.slice(3)));
  },
  async insertRows(table, rows) {
    if (table === 'ledger_events' && refuseActorColumns && rows.some((r) => 'actor_name' in r)) throw new Error('column "actor_name" does not exist');
    DB[table].push(...rows); return rows;
  },
  async updateRows(table, filter, patch) {
    const id = /id=eq\.([^&]+)/.exec(filter)[1];
    const r = (DB[table] || []).find((x) => x.id === id); if (r) Object.assign(r, patch); return r ? [r] : [];
  },
  rpc: async () => null, getUserFromRequest: async () => null, restRequest: async () => ({ ok: true })
};
require.cache[require.resolve('../supabaseRest')] = { id: 'x', filename: 'x', loaded: true, exports: fake };
// marginActions pulls in reconcile.js (agent review); keep that out of this test.
const recon = path.join(__dirname, '../../reconcile.js');
require.cache[require.resolve(recon)] = { id: 'r', filename: 'r', loaded: true, exports: { reviewAgentAction: async () => {} } };
const MA = require('../marginActions');

(async () => {
  const actor = { id: 'u-priya', name: 'Priya Mehta', channel: 'whatsapp' };
  await MA.resolvePendingAction({ id: 'p1', user_id: 'acct', action_type: 'mark_ledger_item_paid', target_id: 'r1', target_kind: 'receivable', payload: {} }, true, actor);
  const e = DB.ledger_events[0];
  check('confirmed on WhatsApp: settled, and the log names Priya on WhatsApp', DB.receivables[0].status === 'settled' && e && e.event === 'settled' && e.actor_name === 'Priya Mehta' && e.actor_id === 'u-priya' && e.channel === 'whatsapp', e);

  DB.receivables.push({ id: 'r2', user_id: 'acct', party_name: 'Blue Door', amount: 1000, status: 'open', source: 'manual' });
  refuseActorColumns = true;   // before 2026-09-30-team-followups.sql
  await MA.resolvePendingAction({ id: 'p2', user_id: 'acct', action_type: 'mark_ledger_item_paid', target_id: 'r2', target_kind: 'receivable', payload: {} }, true, actor);
  const e2 = DB.ledger_events[1];
  check('before the new columns: the action still happens and is still logged, unsigned', DB.receivables[1].status === 'settled' && e2 && e2.event === 'settled' && !('actor_name' in e2), e2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
