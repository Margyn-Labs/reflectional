/**
 * api/zoho-oauth-callback.js: state HMAC (expiry, tamper), DC resolution from the
 * redirect, api_domain persistence, vault write, org list, and the hand-back page
 * (popup postMessage vs. #hash fallback), executed in a vm sandbox.
 * Zero-dep, no network. Run: node api/_lib/__tests__/zohoOauthCallback.test.js
 */
const vm = require('vm');
const H = require('./zohoHarness');
H.setEnv();
const Z = require('../zohoClient');
const callback = require('../../zoho-oauth-callback');

const T = H.makeChecker();
const { check } = T;
const MIN = 60 * 1000;

function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null, jsonBody: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (n) => { r.statusCode = n; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.jsonBody = b; return r; };
  return r;
}

/** Run the page's inline script against a fake window; report what it did. */
function runPage(html, { opener = null } = {}) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const out = { posted: [], replaced: null, closed: false, scriptCount: scripts.length, error: null };
  const win = {
    opener,
    close() { out.closed = true; },
    location: { replace(u) { out.replaced = u; } }
  };
  if (opener && !opener.postMessage) opener.postMessage = (msg, origin) => out.posted.push({ msg, origin });
  const ctx = vm.createContext({ window: win, setTimeout: (fn) => fn(), encodeURIComponent });
  try { for (const s of scripts) vm.runInContext(s, ctx, { timeout: 1000 }); }
  catch (e) { out.error = e.message; }
  return out;
}

/** The JSON payload the page embeds (var payload = {...};). */
function payloadOf(html) {
  const m = /var payload = (.*);\n/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

function world({ exchange = 'token-exchange.in.json', orgsFixture = 'organizations.in.json', zohoOpts } = {}) {
  const db = new H.FakeDb();
  const zin = new H.FakeZoho(zohoOpts);
  const zcom = new H.FakeZoho({ apiDomain: 'https://www.zohoapis.com', accountsDomain: 'https://accounts.zoho.com' });
  zin.exchangeFixture = exchange;
  zcom.exchangeFixture = 'token-exchange.com.json';
  zin.route('books/v3/organizations', () => H.json(200, H.fixture(orgsFixture)));
  zcom.route('books/v3/organizations', () => H.json(200, H.fixture('organizations.usd.json')));
  const strays = H.installFetch(db, [zin, zcom]);
  return { db, zin, zcom, strays };
}

async function call(query) {
  const res = mockRes();
  await callback({ method: 'GET', query, headers: {} }, res);
  return res;
}

(async () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    console.log('# method + Zoho-reported errors');
    {
      const res = mockRes();
      await callback({ method: 'POST', query: {}, headers: {} }, res);
      check('non-GET -> 405', res.statusCode === 405);
      const { zin, strays } = world();
      const r = await call({ error: 'access_denied', state: Z.signState({ uid: 'u1', region: 'in' }) });
      check('?error=access_denied -> 400 page, no token exchange', r.statusCode === 400 && zin.tokenCalls.length === 0 && strays.length === 0);
      check('no-store, html content-type', r.headers['cache-control'] === 'no-store' && /text\/html/.test(r.headers['content-type']));
      const p = runPage(r.body);
      check('no opener -> hash fallback with the reason', p.replaced === '/app.html#zoho=error&reason=access_denied', p);
    }

    console.log('# state HMAC');
    {
      const { zin, db } = world();
      const r = await call({ code: 'good-code' });
      check('missing state -> 400 invalid_state', r.statusCode === 400 && payloadOf(r.body).reason === 'invalid_state');
      const good = Z.signState({ uid: 'u1', region: 'in' });
      const [, sig] = good.split('.');
      const forgedBody = Buffer.from(JSON.stringify({ uid: 'victim', region: 'in', ts: Date.now() })).toString('base64url');
      const r2 = await call({ code: 'good-code', state: forgedBody + '.' + sig });
      check('tampered state (uid swapped) -> 400 invalid_state', r2.statusCode === 400 && payloadOf(r2.body).reason === 'invalid_state');
      const r3 = await call({ code: 'good-code', state: good.slice(0, -2) + 'xx' });
      check('tampered signature -> 400 invalid_state', r3.statusCode === 400 && payloadOf(r3.body).reason === 'invalid_state');
      const clock = H.fakeClock();
      clock.advance(31 * MIN);
      const r4 = await call({ code: 'good-code', state: good });
      clock.restore();
      check('expired state (31 min) -> 400 invalid_state', r4.statusCode === 400 && payloadOf(r4.body).reason === 'invalid_state');
      check('...and the code is never exchanged on a bad state', zin.tokenCalls.length === 0 && db.t('zoho_organizations').length === 0);
      const p = runPage(r4.body);
      check('bad state, no opener -> #zoho=error&reason=invalid_state', p.replaced === '/app.html#zoho=error&reason=invalid_state', p);
    }

    console.log('# happy path (India)');
    {
      const { db, zin, strays } = world();
      const r = await call({ code: 'good-code', state: Z.signState({ uid: 'user-in', region: 'in' }), location: 'in', 'accounts-server': 'https://accounts.zoho.in' });
      const pl = payloadOf(r.body);
      const rows = db.t('zoho_organizations');
      check('200 + ok payload needing org selection', r.statusCode === 200 && pl.ok === true && pl.needs_org_selection === true && pl.organizations.length === 2, pl);
      check('pending row created with sentinel organization_id', rows.length === 1 && rows[0].organization_id === '__pending__' && rows[0].status === 'pending_org_selection' && rows[0].user_id === 'user-in');
      check('api_domain persisted from the token response (slash stripped)', rows[0].api_domain === 'https://www.zohoapis.in', rows[0].api_domain);
      check('accounts_domain persisted', rows[0].accounts_domain === 'https://accounts.zoho.in');
      check('refresh token in vault keyed by row id, not in the row', db.vault[rows[0].id] === H.fixture('token-exchange.in.json').refresh_token && !JSON.stringify(rows[0]).includes(H.fixture('token-exchange.in.json').refresh_token));
      check('access/refresh tokens never reach the page', !r.body.includes('1000.exch0'));
      check('org list called with Zoho-oauthtoken on the persisted api_domain', zin.calls[0].url.startsWith('https://www.zohoapis.in/books/v3/organizations') && zin.calls[0].auth === 'Zoho-oauthtoken ' + H.fixture('token-exchange.in.json').access_token);
      check('success logged to connector_logs', db.t('connector_logs').some((l) => l.status === 'success' && l.operation === 'oauth_callback' && l.records_synced === 2));
      check('no stray network', strays.length === 0, strays);

      // popup vs hash
      process.env.APP_ORIGIN = 'https://app.margynlabs.com';
      const r2 = await call({ code: 'good-code', state: Z.signState({ uid: 'user-in', region: 'in' }) });
      const popup = runPage(r2.body, { opener: {} });
      check('popup: postMessage to opener with source tag + payload', popup.posted.length === 1 && popup.posted[0].msg.source === 'margyn-zoho-oauth' && popup.posted[0].msg.payload.org_ref === rows[0].id, popup);
      check('popup: targetOrigin is APP_ORIGIN, not *', popup.posted[0].origin === 'https://app.margynlabs.com');
      check('popup: window closes, no navigation', popup.closed === true && popup.replaced === null);
      const tab = runPage(r2.body, { opener: null });
      check('no opener: same-tab hash fallback to the org picker', tab.replaced === '/app.html#zoho=select-org&org_ref=' + encodeURIComponent(rows[0].id) && tab.posted.length === 0, tab);
      const severed = runPage(r2.body, { opener: { postMessage() { throw new Error('cross-origin'); } } });
      check('opener that throws (COOP-severed) -> hash fallback', severed.replaced && severed.replaced.startsWith('/app.html#zoho=select-org'), severed);
      delete process.env.APP_ORIGIN;
      const r3 = await call({ code: 'good-code', state: Z.signState({ uid: 'user-in', region: 'in' }) });
      const star = runPage(r3.body, { opener: {} });
      check('APP_ORIGIN unset -> targetOrigin "*" (documented fallback)', star.posted[0] && star.posted[0].origin === '*');
      check('re-running reuses the pending row (PATCH, not a second insert)', db.t('zoho_organizations').length === 1);
    }

    console.log('# data-centre resolution on the callback');
    {
      const { db, zin, zcom, strays } = world();
      const r = await call({ code: 'good-code', state: Z.signState({ uid: 'user-us', region: 'in' }), location: 'us', 'accounts-server': 'https://accounts.zoho.com' });
      const row = db.t('zoho_organizations')[0];
      check('dropdown said India, Zoho said US: exchange happens at accounts.zoho.com', zcom.tokenCalls.length === 1 && zin.tokenCalls.length === 0);
      check('US api_domain + accounts_domain persisted', row.api_domain === 'https://www.zohoapis.com' && row.accounts_domain === 'https://accounts.zoho.com', row);
      check('non-INR org surfaced to the picker', payloadOf(r.body).organizations[0].currency_code === 'USD');
      check('no stray network', strays.length === 0, strays);
    }
    {
      const { zin, strays } = world();
      await call({ code: 'good-code', state: Z.signState({ uid: 'u', region: 'in' }), 'accounts-server': 'https://accounts.evil.example' });
      check('unknown accounts-server ignored: exchange at the state region, evil host never fetched', zin.tokenCalls.length === 1 && strays.length === 0, strays);
    }

    console.log('# failure paths');
    {
      const { db } = world();
      const r = await call({ code: 'stale-code', state: Z.signState({ uid: 'u2', region: 'in' }) });
      check('reused/expired code -> 400 token_exchange_failed', r.statusCode === 400 && payloadOf(r.body).reason === 'token_exchange_failed');
      check('...no org row, no vault write, error logged', db.t('zoho_organizations').length === 0 && Object.keys(db.vault).length === 0 && db.t('connector_logs').some((l) => l.status === 'error'));
      const r2 = await call({ state: Z.signState({ uid: 'u2', region: 'in' }) });
      check('missing code -> 400 missing_code', r2.statusCode === 400 && payloadOf(r2.body).reason === 'missing_code');
    }
    {
      const { db } = world({ orgsFixture: 'organizations.empty.json' });
      const r = await call({ code: 'good-code', state: Z.signState({ uid: 'u3', region: 'in' }) });
      const pl = payloadOf(r.body);
      check('login without Books -> no_books_organization (not ok), org_ref kept', pl.ok === false && pl.reason === 'no_books_organization' && pl.org_ref === db.t('zoho_organizations')[0].id);
    }
    {
      const { zin } = world();
      zin.route('books/v3/organizations', () => H.json(500, {}));
      const r = await call({ code: 'good-code', state: Z.signState({ uid: 'u4', region: 'in' }) });
      check('org list failure -> 502 org_list_failed', r.statusCode === 502 && payloadOf(r.body).reason === 'org_list_failed');
    }

    console.log('# script-context injection');
    {
      world();
      const evil = '</script><script>window.location.replace("https://evil.example")</script>';
      const r = await call({ error: evil });
      check('?error=</script>... cannot break out of the inline script', !r.body.includes('</script><script>window.location'), r.body.slice(r.body.indexOf('var payload'), r.body.indexOf('var payload') + 160));
      const p = runPage(r.body);
      check('...and the page still falls back cleanly', p.scriptCount === 1 && p.error === null && p.replaced && p.replaced.startsWith('/app.html#zoho=error&reason='), p);
    }
    {
      const { zin } = world();
      zin.route('books/v3/organizations', () => {
        const o = H.fixture('organizations.in.json');
        o.organizations[0].name = 'Acme</script><img src=x onerror=alert(1)>';
        return H.json(200, o);
      });
      const r = await call({ code: 'good-code', state: Z.signState({ uid: 'u5', region: 'in' }) });
      const p = runPage(r.body, { opener: {} });
      check('org name containing </script> survives intact via postMessage', p.error === null && p.posted[0] && p.posted[0].msg.payload.organizations[0].name.includes('</script>'), p);
    }
  } catch (err) {
    console.error = origErr;
    console.error(err);
    T.fail++;
  } finally {
    console.error = origErr;
  }
  T.done();
})();
