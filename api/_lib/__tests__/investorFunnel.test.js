/**
 * Investor tenants funnel + ops.js gates — zero-dep. Run: node api/_lib/__tests__/investorFunnel.test.js
 * supabaseRest is faked; no network.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.OPS_ADMIN_SECRET = 'ops-secret';
delete process.env.OPS_ADMIN_USER_IDS;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const DB = {
  ops_investor_tenants: [
    { ref: 'avijeet-shastra', user_id: U1, invited_at: '2026-10-16T05:00:00Z' },
    { ref: 'grit-yash', user_id: U2, invited_at: '2026-10-20T05:00:00Z' }
  ],
  preview_views: [
    { ref: 'avijeet-shastra', event: 'open', country: 'IN', city: 'Mumbai', user_agent: 'UA', created_at: '2026-10-16T06:00:00Z' },
    { ref: 'avijeet-shastra', event: 'play', country: 'IN', city: 'Mumbai', user_agent: 'UA', created_at: '2026-10-16T06:01:00Z' },
    { ref: 'avijeet-shastra', event: 'end', country: 'IN', city: 'Mumbai', user_agent: 'UA', created_at: '2026-10-16T06:04:00Z' },
    { ref: 'grit-yash', event: 'open', country: 'IN', created_at: '2026-10-21T06:00:00Z' },
    { ref: 'cold-lead', event: 'open', country: 'SG', created_at: '2026-10-22T06:00:00Z' },
    { ref: 'direct', event: 'open', created_at: '2026-10-22T07:00:00Z' }
  ],
  product_events: [
    { user_id: U1, name: 'app_open', props: {}, at: '2026-10-17T05:00:00Z' },
    { user_id: U1, name: 'zoho_connect_started', props: { region: 'in' }, at: '2026-10-17T05:05:00Z' },
    { user_id: U1, name: 'zoho_callback', props: { ok: true, error_code: 'none', org_count: 2 }, at: '2026-10-17T05:06:00Z' },
    { user_id: U1, name: 'zoho_org_selected', props: { ok: false, error_code: 'org_not_on_account' }, at: '2026-10-17T05:07:00Z' },
    { user_id: U1, name: 'zoho_org_selected', props: { ok: true, error_code: 'none', backfill_ok: true }, at: '2026-10-17T05:08:00Z' },
    { user_id: U1, name: 'zoho_sync', props: { ok: true, status: 'success', error_code: 'none', mode: 'backfill', rows_synced: 1830 }, at: '2026-10-17T05:12:00Z' },
    // An old row written before eventSchema.js, carrying keys that must never be shown.
    { user_id: U1, name: 'ask_message_sent', props: { msg_len: 30, text: 'how much does Acme owe', email: 'x@y.in' }, at: '2026-10-18T05:00:00Z' },
    { user_id: U2, name: 'app_open', props: {}, at: '2026-10-21T08:00:00Z' }
  ],
  connector_logs: [
    { user_id: U2, connector_type: 'zoho_books', operation: 'oauth_start', status: 'success', error_message: null, records_synced: 0, created_at: '2026-10-21T08:05:00Z' },
    { user_id: U2, connector_type: 'zoho_books', operation: 'oauth_callback', status: 'error', error_message: 'Token exchange failed for Grit Ventures LLP 27AAPFU0939F1ZV', records_synced: 0, created_at: '2026-10-21T08:06:00Z' }
  ]
};

function rowsFor(table, qs) {
  let rows = DB[table] || [];
  const p = new URLSearchParams(qs);
  for (const [k, v] of p) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
    if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(','); rows = rows.filter((r) => set.includes(String(r[k]))); }
  }
  return rows;
}
const writes = [];
require.cache[require.resolve('../supabaseRest')] = {
  id: 's', filename: 's', loaded: true,
  exports: {
    SUPABASE_URL: process.env.SUPABASE_URL,
    async selectRows(table, qs) { if (!DB[table]) throw new Error('404 ' + table); return rowsFor(table, qs); },
    async insertRows(table, rows) { writes.push({ table, rows }); return rows; },
    async updateRows() { return []; },
    async restRequest() { return { ok: true }; },
    async getUserFromRequest() { return null; },
    async logConnectorEvent() {}
  }
};
// GoTrue admin: signup + last sign-in only.
global.fetch = async (url) => {
  const id = String(url).split('/').pop();
  const u = { [U1]: { id: U1, email: 'investor@fund.vc', phone: '919800000001', created_at: '2026-10-17T04:59:00Z', last_sign_in_at: '2026-10-18T04:00:00Z' },
              [U2]: { id: U2, email: 'yash@grit.vc', created_at: '2026-10-21T07:59:00Z', last_sign_in_at: '2026-10-21T08:00:00Z' } }[id];
  return { ok: !!u, json: async () => u };
};

const F = require('../investorFunnel');
const ops = require('../../ops');

function fakeRes() {
  return { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(action, { admin = true, method = 'GET', query = {}, body } = {}) {
  const res = fakeRes();
  await ops({ method, query: Object.assign({ action }, query), headers: admin ? { 'x-ops-secret': 'ops-secret' } : {}, body }, res);
  return res;
}
const DISALLOWED = /amount|name|gstin|text|email|phone|user_agent|city|error_message/i;
function deepKeys(o, out = []) {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); deepKeys(v, out); }
  return out;
}

(async () => {
  console.log('founder gate + impersonation refusal');
  for (const a of ['investor-tenants', 'investor-timeline', 'event-schema', 'partners']) {
    const r = await call(a, { admin: false, query: { ref: 'avijeet-shastra' } });
    check(`${a} without the admin gate -> 404`, r.code === 404, r.code);
  }
  const put = await call('investor-tenant', { admin: false, method: 'PUT', body: { ref: 'x' } });
  check('investor-tenant PUT without the admin gate -> 404, nothing written', put.code === 404 && writes.length === 0);
  for (const a of ['impersonate', 'support-mode', 'snapshot']) {
    const r = await call(a, { admin: true, query: { userId: U1 } });
    check(`${a} is refused even for the founder (404)`, r.code === 404, r.code);
  }

  console.log('investor-tenants');
  const r = await call('investor-tenants');
  check('200', r.code === 200, r.body);
  const d = r.body;
  check('funnel steps in order', d.steps.join() === 'invite,first_login,preview_watched,connect_started,org_picked,first_sync');
  const a = d.tenants.find((x) => x.ref === 'avijeet-shastra');
  check('A: all six steps reached', a && a.reached === 'first_sync' && a.reached_count === 6 && a.stuck_at === null, a);
  check('A: first login = signup time (before first app_open)', a.steps.first_login === '2026-10-17T04:59:00.000Z', a.steps);
  check('A: org picked uses the successful select, not the failed one', a.steps.org_picked === '2026-10-17T05:08:00.000Z');
  check('A: preview furthest = end', a.preview.furthest === 'end' && a.preview.opens === 1);
  check('A: last sync ok with row count', a.last_sync && a.last_sync.ok && a.last_sync.rows_synced === 1830);
  const g = d.tenants.find((x) => x.ref === 'grit-yash');
  check('G: connect started via connector_logs fallback', g && !!g.steps.connect_started && g.steps.connect_started === '2026-10-21T08:05:00.000Z', g && g.steps);
  check('G: opened preview but did not play -> preview not watched', g.steps.preview_watched === null);
  check('G: stuck at the step after the furthest reached', g.stuck_at === 'org_picked', g.stuck_at);
  check('G: skipped steps listed', g.skipped.join() === 'preview_watched', g.skipped);
  const c = d.tenants.find((x) => x.ref === 'cold-lead');
  check('a preview-only ref shows unregistered, unlinked', c && c.registered === false && c.linked === false && c.steps.invite === null);
  check('"direct" preview traffic is not a tenant', !d.tenants.some((x) => x.ref === 'direct'));
  check('totals count tenants per step', d.totals.invite === 2 && d.totals.first_sync === 1 && d.totals.connect_started === 2, d.totals);
  check('tenants table detected', d.tenants_table === true);
  const leaked = deepKeys(d).filter((k) => DISALLOWED.test(k));
  check('list carries no names / emails / phones / amounts / free text keys', leaked.length === 0, leaked);
  check('list carries no email or GSTIN values', !/@|27AAPFU0939F1ZV|Grit Ventures/.test(JSON.stringify(d)));

  console.log('investor-timeline');
  const t = await call('investor-timeline', { query: { ref: 'avijeet-shastra' } });
  check('200', t.code === 200, t.body);
  check('timeline newest first', t.body.timeline.length > 5 && t.body.timeline[0].at >= t.body.timeline[t.body.timeline.length - 1].at);
  check('timeline has funnel, preview and event items', ['funnel', 'preview', 'event'].every((k) => t.body.timeline.some((x) => x.kind === k)));
  const ask = t.body.timeline.find((x) => x.label === 'ask_message_sent');
  check('old row re-filtered on read: text/email dropped, msg_len kept', ask && JSON.stringify(ask.detail) === JSON.stringify({ msg_len: 30 }), ask);
  check('preview items carry country only (no city / user agent)', t.body.timeline.filter((x) => x.kind === 'preview').every((x) => Object.keys(x.detail).every((k) => k === 'country')));
  const t2 = await call('investor-timeline', { query: { ref: 'grit-yash' } });
  const cb = t2.body.timeline.find((x) => x.label === 'zoho_oauth_callback');
  check('connector error mapped to a code, raw message never sent', cb && cb.detail.status === 'error' && cb.detail.error_code === 'unexpected' && !/Grit|27AAP/.test(JSON.stringify(t2.body)), cb);
  check('timeline carries no disallowed keys', deepKeys(t.body).concat(deepKeys(t2.body)).filter((k) => DISALLOWED.test(k)).length === 0);
  check('missing ref -> 400', (await call('investor-timeline', { query: {} })).code === 400);

  console.log('investor-tenant PUT');
  let p = await call('investor-tenant', { method: 'PUT', body: { ref: 'New Fund!', user_id: U2 } });
  check('ref is slugged, saved with upsert on ref', p.code === 200 && writes.length === 1 && writes[0].table === 'ops_investor_tenants' && writes[0].rows[0].ref === 'newfund', writes);
  p = await call('investor-tenant', { method: 'PUT', body: { ref: 'x', user_id: 'not-a-uuid' } });
  check('bad user id -> 400', p.code === 400);
  p = await call('investor-tenant', { method: 'PUT', body: { ref: 'direct' } });
  check('"direct" cannot be registered', p.code === 400);

  console.log('item-line fill runs on the timeline, counts only');
  {
    const tl = F.buildInvestorTimeline({ ref: 'x', user_id: U1 }, { logs: [
      { user_id: U1, connector_type: 'zoho_books', operation: 'sync_item_lines', status: 'success', records_synced: 812, error_message: 'stopped: time; 400 documents left', created_at: '2026-11-02T05:00:00Z' },
      { user_id: U1, connector_type: 'zoho_books', operation: 'import_export_lines', status: 'success', records_synced: 2104, error_message: null, created_at: '2026-11-02T05:10:00Z' }] });
    const fill = tl.timeline.find((x) => x.label === 'zoho_sync_item_lines'), imp = tl.timeline.find((x) => x.label === 'zoho_import_export_lines');
    check('fill and export-import runs shown with their line counts', fill && fill.detail.rows_synced === 812 && imp && imp.detail.rows_synced === 2104, tl.timeline);
    check('no message text from them', !deepKeys(tl.timeline).some((k) => DISALLOWED.test(k)) && !JSON.stringify(tl.timeline).includes('documents left'), tl.timeline);
  }

  console.log('event-schema');
  const s = await call('event-schema');
  check('schema exposed to the founder', s.code === 200 && s.body.events && s.body.events.zoho_sync);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
