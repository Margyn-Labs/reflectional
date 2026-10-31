/**
 * Shared fakes for the Zoho test suite (zohoClient / zohoOauthCallback / zohoSync).
 * Not a test file itself. Zero-dep, no network: every fetch() is answered by
 * an in-memory PostgREST, an in-memory Zoho accounts server, or an in-memory
 * Zoho Books API built from the recorded-style fixtures in test-fixtures/zoho/.
 * Any URL none of them owns throws, so a test can never reach the internet.
 *
 * Call setEnv() BEFORE requiring zohoClient / supabaseRest: both read env at load.
 */
const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'test-fixtures', 'zoho');
const SUPABASE_URL = 'https://test.supabase.co';

function setEnv() {
  Object.assign(process.env, {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_ANON_KEY: 'anon',
    ZOHO_CLIENT_ID: '1000.TESTCLIENT',
    ZOHO_CLIENT_SECRET: 'test-client-secret',
    ZOHO_REDIRECT_URI: 'https://app.test/api/zoho-oauth-callback',
    ZOHO_STATE_SECRET: 'test-state-secret-0123456789abcdef0123456789'
  });
}

function fixture(name) {
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  delete data._note;
  return data;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// ------------------------------------------------------------ check helper

function makeChecker() {
  const t = { pass: 0, fail: 0 };
  t.check = (name, cond, detail) => {
    if (cond) { t.pass++; console.log('  ok  - ' + name); }
    else { t.fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
  };
  t.done = () => { console.log('\n' + t.pass + ' passed, ' + t.fail + ' failed'); process.exit(t.fail ? 1 : 0); };
  return t;
}

// ------------------------------------------------------------- fast timers

/** Make every setTimeout fire on the next tick, recording the requested delays. */
function fastTimers() {
  const real = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms || 0); return real(fn, 0, ...args); };
  return { delays, restore() { global.setTimeout = real; } };
}

/** Shift Date.now() (what zohoClient's token clock reads). */
function fakeClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  return { advance(ms) { offset += ms; }, restore() { Date.now = realNow; } };
}

// ------------------------------------------------------- fake PostgREST

class FakeDb {
  constructor() { this.tables = {}; this.vault = {}; this.seq = 0; this.users = {}; this.log = []; }

  t(name) { return (this.tables[name] = this.tables[name] || []); }

  match(row, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      const val = row[k];
      if (v.startsWith('eq.')) { if (String(val) !== v.slice(3)) return false; }
      else if (v.startsWith('in.(')) { if (!v.slice(4, -1).split(',').includes(String(val))) return false; }
      else if (v.startsWith('gt.')) { if (!(Number(val) > Number(v.slice(3)))) return false; }
      else if (v.startsWith('gte.')) { if (!(String(val) >= v.slice(4))) return false; }
      else if (v.startsWith('lte.')) { if (!(String(val) <= v.slice(4))) return false; }
      else if (v.startsWith('lt.')) { if (!(String(val) < decodeURIComponent(v.slice(3)))) return false; }
      else if (v === 'is.null') { if (val != null) return false; }
      else throw new Error('FakeDb: unsupported filter ' + k + '=' + v);
    }
    return true;
  }

  async handle(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : undefined;

    if (u.pathname === '/auth/v1/user') {
      const tok = String(init.headers.Authorization || '').replace(/^Bearer /, '');
      return this.users[tok] ? json(200, this.users[tok]) : json(401, { msg: 'bad jwt' });
    }

    const rest = u.pathname.replace(/^\/rest\/v1\//, '');
    this.log.push(method + ' ' + rest + (u.search || ''));

    if (rest.startsWith('rpc/')) {
      const fn = rest.slice(4);
      if (fn === 'zoho_vault_store') { this.vault[body.p_org_ref] = body.p_token; return json(200, null); }
      if (fn === 'zoho_vault_get') { return json(200, this.vault[body.p_org_ref] || null); }
      if (fn === 'zoho_vault_purge') { delete this.vault[body.p_org_ref]; return json(200, null); }
      return json(404, { message: 'no rpc ' + fn });
    }

    const table = rest;
    const params = u.searchParams;
    const rows = this.t(table);

    if (method === 'GET') {
      let out = rows.filter((r) => this.match(r, params));
      const order = params.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = out.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      const off = +(params.get('offset') || 0);
      const lim = Math.min(1000, params.get('limit') ? +params.get('limit') : 1000);
      return json(200, out.slice(off, off + lim).map((r) => ({ ...r })));
    }

    if (method === 'POST') {
      const conflict = params.get('on_conflict');
      const merge = /merge-duplicates/.test((init.headers && init.headers.Prefer) || '');
      const out = [];
      for (const incoming of body) {
        let existing = null;
        if (conflict) {
          const cols = conflict.split(',');
          existing = rows.find((r) => cols.every((c) => String(r[c]) === String(incoming[c])));
        }
        if (existing) {
          if (merge) Object.assign(existing, incoming);
          out.push({ ...existing });
        } else {
          const row = { id: incoming.id || `${table}-${++this.seq}`, ...incoming };
          rows.push(row);
          out.push({ ...row });
        }
      }
      return json(201, out);
    }

    if (method === 'PATCH') {
      const hit = rows.filter((r) => this.match(r, params));
      hit.forEach((r) => Object.assign(r, body));
      return json(200, hit.map((r) => ({ ...r })));
    }
    if (method === 'DELETE') {
      const keep = rows.filter((r) => !this.match(r, params));
      const removed = rows.length - keep.length;
      this.tables[table] = keep;
      // Prefer: count=exact answers with how many rows went, as PostgREST does.
      const counted = /count=exact/.test((init.headers && init.headers.Prefer) || '');
      return new Response(null, { status: 204, headers: counted ? { 'Content-Range': '*/' + removed } : {} });
    }
    throw new Error('FakeDb: unsupported ' + method);
  }
}

// ------------------------------------------------------------ fake Zoho

/** Clone a recorded list row N times with unique ids and spaced modification times. */
function makeRecords(fixtureName, idField, n, { startIso = '2026-08-01T00:00:00Z', stepMin = 10, prefix = '9', extra } = {}) {
  const tpl = fixture(fixtureName);
  const start = new Date(startIso).getTime();
  return Array.from({ length: n }, (_, i) => {
    const r = JSON.parse(JSON.stringify(tpl));
    r[idField] = prefix + String(i + 1).padStart(11, '0');
    if ('invoice_number' in r) r.invoice_number = 'INV-' + String(i + 1).padStart(6, '0');
    if ('bill_number' in r) r.bill_number = 'B-' + String(i + 1).padStart(6, '0');
    // Zoho's own format: local offset, no colon.
    r.last_modified_time = new Date(start + i * stepMin * 60000).toISOString().replace(/\.\d{3}Z$/, '+0000');
    return extra ? Object.assign(r, extra(i)) : r;
  });
}

class FakeZoho {
  constructor({ apiDomain = 'https://www.zohoapis.in', accountsDomain = 'https://accounts.zoho.in' } = {}) {
    this.apiDomain = apiDomain;
    this.accountsDomain = accountsDomain;
    this.validTokens = new Set();
    this.refreshTokens = new Set(['1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr']);
    this.exchangeFixture = 'token-exchange.in.json';
    this.tokenSeq = 0;
    this.refreshCount = 0;
    this.calls = [];          // every Books API request: { path, params, auth }
    this.tokenCalls = [];     // every accounts-server request
    this.collections = {};    // path -> { key, rows }
    this.routes = {};         // path -> (params, call) => Response
    this.faults = [];         // { match(call) -> bool, respond(call) -> Response, times }
    this.onCall = null;       // hook(call) before routing
    this.unauthorized = 0;    // 401s served for a dead access token
  }

  issueToken() { const t = `1000.acc${++this.tokenSeq}.zzzz`; this.validTokens.add(t); return t; }
  expireAllAccessTokens() { this.validTokens.clear(); }

  collection(pathName, key, rows) { this.collections[pathName] = { key, rows }; }
  route(pathName, fn) { this.routes[pathName] = fn; }
  fault(match, respond, times = 1) { this.faults.push({ match, respond, times }); }

  owns(url) { return url.startsWith(this.apiDomain + '/') || url.startsWith(this.accountsDomain + '/'); }

  async handle(url, init) {
    const u = new URL(url);
    if (url.startsWith(this.accountsDomain + '/')) return this.handleAccounts(u, init);

    const p = u.pathname.replace(/^\/+/, '');
    const auth = (init && init.headers && init.headers.Authorization) || '';
    const call = { path: p, params: Object.fromEntries(u.searchParams), auth, url };
    this.calls.push(call);
    if (this.onCall) this.onCall(call);

    for (const f of this.faults) {
      if (f.times > 0 && f.match(call)) { f.times--; return f.respond(call); }
    }
    const tok = auth.replace(/^Zoho-oauthtoken /, '');
    if (!auth.startsWith('Zoho-oauthtoken ') || !this.validTokens.has(tok)) {
      this.unauthorized++;
      return json(401, fixture('error-401-invalid-token.json'));
    }
    if (this.routes[p]) return this.routes[p](call.params, call);

    const c = this.collections[p];
    if (!c) return json(404, { code: 5, message: 'Invalid URL Passed' });
    let rows = c.rows;
    if (call.params.last_modified_time) {
      const since = new Date(call.params.last_modified_time).getTime();
      rows = rows.filter((r) => new Date(r.last_modified_time).getTime() >= since);
    }
    if (call.params.sort_column === 'last_modified_time') {
      rows = rows.slice().sort((a, b) => new Date(a.last_modified_time) - new Date(b.last_modified_time));
    }
    const page = +(call.params.page || 1);
    const per = Math.min(200, +(call.params.per_page || 200));
    const slice = rows.slice((page - 1) * per, page * per);
    return json(200, {
      code: 0, message: 'success', [c.key]: slice,
      page_context: { page, per_page: per, has_more_page: page * per < rows.length, sort_column: call.params.sort_column || 'created_time', sort_order: 'D' }
    });
  }

  handleAccounts(u, init) {
    const q = Object.fromEntries(u.searchParams);
    this.tokenCalls.push({ path: u.pathname, ...q, method: init && init.method });
    if (u.pathname === '/oauth/v2/token/revoke') return json(200, { status: 'success' });
    if (u.pathname !== '/oauth/v2/token') return json(404, {});
    if (q.grant_type === 'authorization_code') {
      if (q.code !== 'good-code') return json(200, fixture('token-error-invalid-code.json'));
      const ex = fixture(this.exchangeFixture);
      this.validTokens.add(ex.access_token);
      this.refreshTokens.add(ex.refresh_token);
      return json(200, ex);
    }
    if (q.grant_type === 'refresh_token') {
      if (!this.refreshTokens.has(q.refresh_token)) return json(200, fixture('token-error-invalid-code.json'));
      this.refreshCount++;
      return json(200, { ...fixture('token-refresh.json'), access_token: this.issueToken() });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
}

/** Install global.fetch routing to the fakes; anything else is a hard failure. */
function installFetch(db, zohos, extra) {
  const list = Array.isArray(zohos) ? zohos : [zohos];
  const strays = [];
  global.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(SUPABASE_URL + '/')) return db.handle(url, init);
    for (const z of list) if (z && z.owns(url)) return z.handle(url, init);
    if (extra) { const r = await extra(url, init); if (r) return r; }
    strays.push(url);
    throw new Error('NETWORK BLOCKED in test: ' + url);
  };
  return strays;
}

module.exports = {
  SUPABASE_URL, FIXTURE_DIR, setEnv, fixture, json, makeChecker, fastTimers, fakeClock,
  FakeDb, FakeZoho, makeRecords, installFetch
};
