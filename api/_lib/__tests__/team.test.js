/**
 * Team logins — zero-dep. Run: node api/_lib/__tests__/team.test.js
 * In-memory fakes for the database and Supabase Auth; no network.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';

const T = require('../teamAccess');
const team = require('../team');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const FIN = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const USERS = { 'tok-owner': { id: OWNER, email: 'owner@acme.in' }, 'tok-fin': { id: FIN, email: 'fin@acme.in' }, 'tok-admin': { id: ADMIN, email: 'admin@acme.in' }, 'tok-stranger': { id: STRANGER, email: 'x@else.in' } };

/* ---------- fake PostgREST over an in-memory store ---------- */
const DB = { profiles: [{ id: OWNER, company_name: 'Margyn Demo', whatsapp_phone: '919800000001' }, { id: STRANGER, company_name: 'Else Co' }], account_members: [], account_invites: [], business_stakeholders: [{ id: 'bs-owner', business_id: OWNER, name: 'Arjun Kapoor', phone: '919800000001', role: 'owner', is_primary: true, whatsapp_access: false }, { id: 'bs-else', business_id: STRANGER, name: 'Else', phone: '919800000009', role: 'owner', whatsapp_access: true }], ledger_events: [] };
let seq = 0;
function filterRows(rows, qs) {
  const p = new URLSearchParams(qs);
  let out = rows;
  for (const [k, v] of p) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
    else if (v.startsWith('neq.')) out = out.filter((r) => String(r[k]) !== decodeURIComponent(v.slice(4)));
    else if (v === 'not.is.null') out = out.filter((r) => r[k] != null);
    else if (v === 'is.null') out = out.filter((r) => r[k] == null);
    else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(','); out = out.filter((r) => set.includes(String(r[k]))); }
  }
  return p.get('limit') ? out.slice(0, Number(p.get('limit'))) : out;
}
const deps = {
  now: () => Date.parse('2026-09-29T06:00:00Z'),
  ownerEmail: async () => 'owner@acme.in',
  async selectRows(table, qs) { if (!DB[table]) throw new Error(`Select on ${table} failed: 404 PGRST205 does not exist`); return filterRows(DB[table], qs).map((r) => ({ ...r })); },
  async insertRows(table, rows, opts = {}) {
    const out = [];
    for (const r of rows) {
      if (opts.onConflict) {
        const keys = opts.onConflict.split(',');
        const hit = DB[table].find((x) => keys.every((k) => x[k] === r[k]));
        if (hit) { Object.assign(hit, r); out.push({ ...hit }); continue; }
      }
      const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, created_at: new Date(deps.now()).toISOString(), ...r };
      DB[table].push(row); out.push({ ...row });
    }
    return out;
  },
  async updateRows(table, filter, patch) { const rows = filterRows(DB[table], filter); rows.forEach((r) => Object.assign(r, patch)); return rows.map((r) => ({ ...r })); },
  async restRequest(path, { method }) {
    const [table, qs] = path.split('?');
    if (method === 'DELETE') { const kill = new Set(filterRows(DB[table], qs)); DB[table] = DB[table].filter((r) => !kill.has(r)); return { ok: true }; }
    return { ok: false };
  },
  sent: [],
  async sendEmail(m) { deps.sent.push(m); }
};
/* getUserFromRequest: the real accountFor over the fake store */
const sbr = require('../supabaseRest');
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') {
    const user = USERS[(opts.headers.Authorization || '').replace('Bearer ', '')];
    return user ? { ok: true, json: async () => ({ ...user }) } : { ok: false, json: async () => ({}) };
  }
  const table = u.pathname.replace('/rest/v1/', '');
  if (!DB[table]) return { ok: false, status: 404, text: async () => 'PGRST205', json: async () => ({}) };
  return { ok: true, json: async () => filterRows(DB[table], u.search.slice(1)).map((r) => ({ ...r })) };
};
deps.getUserFromRequest = sbr.getUserFromRequest;

const mkReq = (tok, action, { method = 'GET', body, account } = {}) => ({
  method, url: `/api/ops?action=${action}`, query: { action }, body,
  headers: Object.assign({ authorization: 'Bearer ' + tok }, account ? { 'x-margyn-account': account } : {})
});
const mkRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
const posReq = (tok, account) => Object.assign(mkReq(tok, 'position', { account }), { url: '/api/reconcile?action=position' });
const call = async (tok, action, o) => { const res = mkRes(); await team.handle(action, mkReq(tok, action, o), res, deps); return res; };

(async () => {
  /* ---------- roles ---------- */
  check('JS roles match the SQL role table', T.ROLES.every((r) => {
    const sql = T.SQL_ROLE_TABLE[r];
    const js = T.ROLE_DEFAULTS[r].filter((p) => p !== 'manage_people' && p !== 'manage_connections' || r === 'admin');
    return sql === 'all' ? T.ROLE_DEFAULTS[r].length === T.PERMISSIONS.length : JSON.stringify(sql.filter((p) => p !== 'view').sort()) === JSON.stringify(js.slice().sort());
  }));
  check('viewer: sees everything, changes nothing', T.effectivePermissions('viewer').includes('view_payables') && !T.effectivePermissions('viewer').includes('edit'));
  check('overrides are booleans on known keys only', JSON.stringify(T.cleanOverrides({ view_cash: false, edit: 'yes', hack: true })) === '{"view_cash":false}');

  /* ---------- the server gate ---------- */
  const may = (url, method, role) => T.memberMayCall({ url, method, query: { action: new URL(url, 'http://x').searchParams.get('action') } }, T.effectivePermissions(role));
  check('viewer: GET reads allowed', may('/api/reconcile?action=position', 'GET', 'viewer'));
  check('viewer: chat allowed', may('/api/ask-margyn', 'POST', 'viewer'));
  check('viewer: writes refused', !may('/api/generate-findings?action=parse-import', 'POST', 'viewer') && !may('/api/zoho?action=sync', 'POST', 'viewer'));
  check('finance: writes allowed, connecting sources refused', may('/api/zoho?action=sync', 'POST', 'finance') && !may('/api/zoho?action=oauth-start', 'GET', 'finance') && !may('/api/sync-razorpay?action=cashfree-connect', 'POST', 'finance') && !may('/api/tally?action=pair-init', 'POST', 'finance'));
  check('admin: can connect sources and invite', may('/api/zoho?action=odoo-connect', 'POST', 'admin') && may('/api/ops?action=team-invite', 'POST', 'admin'));
  check('approver: approves, but no general writes', may('/api/reconcile?action=agent-review', 'POST', 'approver') && !may('/api/reconcile?action=run', 'POST', 'approver'));
  check('finance cannot invite; nobody reaches founder ops through a membership', !may('/api/ops?action=team-invite', 'POST', 'finance') && !may('/api/ops?action=partners', 'GET', 'admin') && !may('/api/ops?action=impersonate', 'POST', 'admin'));

  /* ---------- codes ---------- */
  const code = team.newCode();
  check('code: 12 characters in 3 groups, no ambiguous letters', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), code);
  check('code is matched however it is typed', team.hashCode(code) === team.hashCode(code.toLowerCase().replace(/-/g, ' ')));
  check('email masked in errors', team.maskEmail('finance@acme.in') === 'fi*****@acme.in');

  /* ---------- before the migration ---------- */
  const saved = DB.account_members; delete DB.account_members;
  let r = await call('tok-owner', 'team-whoami');
  check('no team table: whoami still answers, ready=false, owner only', r.code === 200 && r.body.ready === false && r.body.own_account.account_id === OWNER);
  const u0 = await sbr.getUserFromRequest(mkReq('tok-fin', 'team-list', { account: OWNER }));
  check('no team table: a membership header is refused, not guessed', u0 === null);
  DB.account_members = saved;

  /* ---------- invite ---------- */
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'Fin@Acme.in', name: 'Priya', role: 'finance' } });
  check('owner invites Finance: code + link returned once', r.code === 200 && /^[A-Z2-9-]{14}$/.test(r.body.code) && r.body.link.endsWith('#/join?code=' + r.body.code), r.body);
  const finCode = r.body.code;
  check('only the hash is stored', DB.account_invites.length === 1 && DB.account_invites[0].code_hash === team.hashCode(finCode) && !JSON.stringify(DB.account_invites).includes(finCode));
  check('email lower-cased, 7-day expiry', DB.account_invites[0].email === 'fin@acme.in' && DB.account_invites[0].expires_at === '2026-10-06T06:00:00.000Z');
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'nope', role: 'finance' } });
  check('bad email refused', r.code === 400);
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'a@b.in', role: 'owner' } });
  check('role "owner" cannot be granted', r.code === 400);

  /* ---------- join ---------- */
  r = await call('tok-stranger', 'team-join', { method: 'POST', body: { code: finCode } });
  check('someone else\'s email cannot use the code', r.code === 403 && /fi\*+@acme\.in/.test(r.body.error), r.body);
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: 'WRONG-CODE-HERE' } });
  check('a wrong code is refused', r.code === 404 || r.code === 400);
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: finCode.toLowerCase() } });
  check('Priya joins with her own email', r.code === 200 && r.body.account_id === OWNER && r.body.role === 'finance' && r.body.company_name === 'Margyn Demo', r.body);
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: finCode } });
  check('the code works once', r.code === 410);

  /* ---------- recognised on sign-in ---------- */
  r = await call('tok-fin', 'team-whoami');
  const ms = r.body.memberships;
  check('whoami: Priya, Finance at Margyn Demo, with her permissions', ms.length === 1 && ms[0].account_id === OWNER && ms[0].name === 'Priya' && ms[0].role_label === 'Finance' && ms[0].permissions.includes('edit') && !ms[0].permissions.includes('manage_people'), ms);
  check('whoami: she has no business of her own', r.body.own_account === null);

  /* ---------- the header maps every endpoint to the account ---------- */
  let u = await sbr.getUserFromRequest(posReq('tok-fin', OWNER));
  check('header: Priya\'s calls act on the owner\'s account', u && u.id === OWNER && u.auth_id === FIN && u.member.role === 'finance');
  u = await sbr.getUserFromRequest(posReq('tok-stranger', OWNER));
  check('header: a stranger claiming the account is refused', u === null);
  u = await sbr.getUserFromRequest(posReq('tok-fin', 'not-a-uuid'));
  check('header: garbage refused', u === null);
  u = await sbr.getUserFromRequest(Object.assign(mkReq('tok-fin', 'x', { account: OWNER }), { url: '/api/zoho?action=oauth-start', query: { action: 'oauth-start' } }));
  check('header: Finance cannot connect a source', u === null);
  u = await sbr.getUserFromRequest(posReq('tok-owner'));
  check('no header: the owner is themselves, as before', u && u.id === OWNER && !u.member);
  const { resolveActor } = require('../actor');
  const a = await resolveActor(posReq('tok-fin', OWNER));
  check('actor: account is the owner\'s, person is Priya', a.accountId === OWNER && a.userId === FIN && a.role === 'finance' && a.name === 'Priya');

  /* ---------- list / manage ---------- */
  r = await call('tok-fin', 'team-list', { account: OWNER });
  check('Finance sees the team but not open invites', r.code === 200 && r.body.members.length === 1 && r.body.invites.length === 0 && r.body.you.can_manage === false);
  r = await call('tok-fin', 'team-invite', { method: 'POST', account: OWNER, body: { email: 'z@acme.in', role: 'viewer' } });
  check('Finance cannot invite (refused at the gate)', r.code === 401);
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'admin@acme.in', name: 'Ravi', role: 'admin' } });
  await call('tok-admin', 'team-join', { method: 'POST', body: { code: r.body.code } });
  r = await call('tok-admin', 'team-invite', { method: 'POST', account: OWNER, body: { email: 'v@acme.in', role: 'viewer' }, });
  check('Admin invites a Viewer', r.code === 200);
  r = await call('tok-admin', 'team-invite', { method: 'POST', account: OWNER, body: { email: 'a2@acme.in', role: 'admin' } });
  check('only the owner makes admins', r.code === 403);
  r = await call('tok-admin', 'team-list', { account: OWNER });
  check('Admin sees members and the open invite', r.body.members.length === 2 && r.body.invites.length === 1 && r.body.owner.email === 'owner@acme.in');
  const priya = r.body.members.find((m) => m.email === 'fin@acme.in');
  const ravi = r.body.members.find((m) => m.email === 'admin@acme.in');
  r = await call('tok-admin', 'team-update', { method: 'POST', account: OWNER, body: { member_id: priya.id, permissions: { view_cash: false } } });
  check('Admin turns off Cash for Priya', r.code === 200 && !r.body.member.permissions.includes('view_cash'));
  u = await sbr.getUserFromRequest(posReq('tok-fin', OWNER));
  check('...and her next call carries that', !u.member.permissions.includes('view_cash'));
  r = await call('tok-admin', 'team-update', { method: 'POST', account: OWNER, body: { member_id: ravi.id, role: 'viewer' } });
  check('an admin cannot change their own access', r.code === 403 || r.code === 400);
  r = await call('tok-admin', 'team-update', { method: 'POST', account: OWNER, body: { member_id: priya.id, status: 'suspended' } });
  u = await sbr.getUserFromRequest(posReq('tok-fin', OWNER));
  check('suspended: refused at once', r.code === 200 && u === null);
  r = await call('tok-fin', 'team-whoami');
  check('suspended: whoami lists no membership', r.body.memberships.length === 0);
  r = await call('tok-admin', 'team-remove', { method: 'POST', account: OWNER, body: { member_id: priya.id } });
  check('Admin removes Priya', r.code === 200 && !DB.account_members.some((m) => m.user_id === FIN));
  r = await call('tok-admin', 'team-remove', { method: 'POST', account: OWNER, body: { member_id: ravi.id } });
  check('an admin cannot remove themselves', (r.code === 400 || r.code === 403) && DB.account_members.some((m) => m.user_id === ADMIN));
  r = await call('tok-owner', 'team-remove', { method: 'POST', body: { member_id: ravi.id } });
  check('the owner can remove an admin', r.code === 200);

  /* ---------- 2026-09-30: who did it, WhatsApp link, personal settings ---------- */
  const ev = (event) => DB.ledger_events.filter((e) => e.event === event);
  check('audit: the invite is logged with who sent it', ev('invited').length >= 3 && ev('invited')[0].actor_name === 'Arjun Kapoor' && ev('invited')[0].actor_id === OWNER && ev('invited')[0].entity_type === 'person' && ev('invited')[0].user_id === OWNER, ev('invited')[0]);
  check('audit: joining is logged as the person who joined', ev('joined').some((e) => e.actor_id === FIN && e.user_id === OWNER));
  check('audit: access, suspend and remove are logged by whoever did them', ['access_changed', 'suspended'].every((k) => ev(k).length && ev(k).every((e) => e.actor_id === ADMIN && e.actor_name === 'Ravi'))
    && ev('removed')[0].actor_name === 'Ravi' && ev('removed')[0].party_name === 'Priya' && ev('removed')[1].actor_name === 'Arjun Kapoor' && ev('removed')[1].party_name === 'Ravi', ev('removed'));

  // Priya comes back as Finance, and her WhatsApp number is linked to her login
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'fin@acme.in', name: 'Priya', role: 'finance' } });
  await call('tok-fin', 'team-join', { method: 'POST', body: { code: r.body.code } });
  const priya2 = DB.account_members.find((m) => m.user_id === FIN);
  r = await call('tok-owner', 'team-update', { method: 'POST', body: { member_id: priya2.id, phone: '98765 43210' } });
  const waRow = DB.business_stakeholders.find((x) => x.member_id === priya2.id);
  check('link WhatsApp: a People row for Priya\'s number, tied to her login', r.code === 200 && waRow && waRow.phone === '919876543210' && waRow.whatsapp_access === true && waRow.business_id === OWNER, waRow);
  check('link WhatsApp: its switches follow Finance (ask, act, forward)', waRow.permissions.ask && waRow.permissions.act && waRow.permissions.forward);
  r = await call('tok-owner', 'team-list');
  check('App logins shows the linked number', r.body.members.find((m) => m.id === priya2.id).whatsapp === '919876543210');
  r = await call('tok-owner', 'team-update', { method: 'POST', body: { member_id: priya2.id, role: 'viewer' } });
  check('role change to Viewer: her WhatsApp can ask, not act', !waRow.permissions.act && !waRow.permissions.forward && waRow.permissions.ask);
  r = await call('tok-owner', 'team-update', { method: 'POST', body: { member_id: priya2.id, phone: '9800000001' } });
  check('the owner\'s own number cannot be linked to someone else', r.code === 409);
  r = await call('tok-owner', 'team-update', { method: 'POST', body: { member_id: priya2.id, phone: '9800000009' } });
  check('a number that talks to another business is refused', r.code === 409 && /another business/.test(r.body.error));
  r = await call('tok-owner', 'team-update', { method: 'POST', body: { member_id: priya2.id, phone: '' } });
  check('unlink: the row stays for routing but loses access', r.code === 200 && waRow.member_id === null && waRow.whatsapp_access === false);
  check('audit: linking is logged', ev('whatsapp_linked').length === 2);

  r = await call('tok-fin', 'team-prefs', { method: 'POST', account: OWNER, body: { prefs: { forecast: { collectDelay: 21 }, whats_new_seen: 'x' } } });
  check('personal settings: saved on Priya\'s membership', r.code === 200 && priya2.preferences.forecast.collectDelay === 21 && !('preferences' in DB.profiles[0]));
  r = await call('tok-fin', 'team-prefs', { method: 'POST', account: OWNER, body: { prefs: { forecast: null } } });
  check('personal settings: null goes back to the business default', !('forecast' in priya2.preferences) && priya2.preferences.whats_new_seen === 'x');
  r = await call('tok-owner', 'team-prefs', { method: 'POST', body: { prefs: { a: 1 } } });
  check('the owner has no separate personal settings', r.code === 400);
  r = await call('tok-fin', 'team-whoami');
  check('whoami: features on, and her settings come back', r.body.features.member_prefs && r.body.memberships[0].preferences.whats_new_seen === 'x');

  await call('tok-owner', 'team-remove', { method: 'POST', body: { member_id: priya2.id } });

  /* ---------- WhatsApp follows the login ---------- */
  const MA = require('../memberAccess');
  const row = { id: 'x', member_id: 'm', permissions: { opening_bell: true } };
  const viewer = MA.memberPerms(row, false, { status: 'active', role: 'viewer', permissions: {}, user_id: FIN });
  const approver = MA.memberPerms(row, false, { status: 'active', role: 'approver', permissions: {}, user_id: FIN });
  const gone = MA.memberPerms(row, false, { status: 'suspended', role: 'finance', permissions: {} });
  check('linked Viewer: may ask, may not act or forward; Bells kept', viewer.ask && !viewer.act && !viewer.forward && viewer.opening_bell);
  check('linked and suspended: nothing', !gone.ask && !gone.act && !gone.forward && !gone.opening_bell);
  check('linked Approver: may confirm approvals, not ledger changes', MA.mayConfirm(approver, 'approve_suggestion') && !MA.mayConfirm(approver, 'mark_ledger_item_paid'));
  check('an unlinked number keeps its Act switch', MA.mayConfirm(MA.memberPerms({ permissions: { ask: true, act: true } }, false), 'mark_ledger_item_paid'));

  /* ---------- expiry / revoke ---------- */
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'fin@acme.in', role: 'viewer' } });
  const c2 = r.body.code, id2 = r.body.invite_id;
  r = await call('tok-owner', 'team-invite', { method: 'POST', body: { email: 'fin@acme.in', role: 'viewer' } });
  const c3 = r.body.code;
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: c2 } });
  check('a newer invite to the same email retires the older code', r.code === 404);
  const real = deps.now; deps.now = () => Date.parse('2026-10-07T00:00:00Z');
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: c3 } });
  check('an expired code is refused', r.code === 410);
  deps.now = real;
  r = await call('tok-owner', 'team-revoke', { method: 'POST', body: { invite_id: DB.account_invites.find((i) => i.code_hash === team.hashCode(c3)).id } });
  r = await call('tok-fin', 'team-join', { method: 'POST', body: { code: c3 } });
  check('a revoked code is refused', r.code === 404);
  check('no email is sent while Resend isn\'t set up', deps.sent.length === 0 && id2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
