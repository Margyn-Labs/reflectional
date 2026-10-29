/**
 * Zoho Books client: region / accounts-server resolution, signed state, token
 * exchange (api_domain), session (proactive 50-min refresh, Zoho-oauthtoken
 * header, organization_id), 429/5xx backoff, code 57, 401 -> refresh -> auth error.
 * Zero-dep, no network. Run: node api/_lib/__tests__/zohoClient.test.js
 * Fixtures: test-fixtures/zoho/*.json (via ./zohoHarness.js).
 */
const H = require('./zohoHarness');
H.setEnv();
const Z = require('../zohoClient');

const T = H.makeChecker();
const { check } = T;
const MIN = 60 * 1000;

function freshWorld(opts = {}) {
  const db = new H.FakeDb();
  const zoho = new H.FakeZoho(opts);
  const strays = H.installFetch(db, zoho);
  const org = {
    id: 'org-1', organization_id: '60012345678',
    api_domain: zoho.apiDomain, accounts_domain: zoho.accountsDomain, status: 'active'
  };
  db.t('zoho_organizations').push({ ...org });
  db.vault[org.id] = '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
  zoho.collection('books/v3/invoices', 'invoices', H.makeRecords('invoice.record.json', 'invoice_id', 3));
  return { db, zoho, org, strays, session: Z.createSession(org) };
}

async function rejects(p) { try { await p; return null; } catch (e) { return e; } }
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const timers = H.fastTimers();
  try {
    // ------------------------------------------------ region resolution
    console.log('# region / accounts-server resolution');
    const R = Z.resolveAccountsDomain;
    check('accounts-server from the redirect wins over location and dropdown',
      R({ accountsServer: 'https://accounts.zoho.eu', location: 'in', fallbackRegion: 'in' }) === 'https://accounts.zoho.eu');
    check('accounts-server is normalised (trailing slash, case)',
      R({ accountsServer: 'HTTPS://Accounts.Zoho.com/', fallbackRegion: 'in' }) === 'https://accounts.zoho.com');
    check('unknown accounts-server host is discarded, never followed',
      R({ accountsServer: 'https://accounts.zoho.in.evil.example', fallbackRegion: 'in' }) === 'https://accounts.zoho.in');
    check('unknown accounts-server falls through to location',
      R({ accountsServer: 'https://evil.example', location: 'au', fallbackRegion: 'in' }) === 'https://accounts.zoho.com.au');
    check('location=us maps to the .com DC (Zoho does not send "com")',
      R({ location: 'us', fallbackRegion: 'in' }) === 'https://accounts.zoho.com');
    check('location=ca maps to zohocloud.ca', R({ location: 'CA' }) === 'https://accounts.zohocloud.ca');
    const origErr = console.error; console.error = () => {};
    check('unrecognised location falls back to the dropdown region',
      R({ location: 'mars', fallbackRegion: 'eu' }) === 'https://accounts.zoho.eu');
    console.error = origErr;
    check('nothing at all -> India default', R({}) === 'https://accounts.zoho.in');
    check('accountsDomainForRegion: unknown region -> India, not a guess',
      Z.accountsDomainForRegion('zz') === 'https://accounts.zoho.in' && Z.accountsDomainForRegion('JP') === 'https://accounts.zoho.jp');

    // ------------------------------------------------ authorize URL + scopes
    console.log('# authorize URL');
    const { url, accountsDomain } = Z.buildAuthorizeUrl({ userId: 'user-1', region: 'COM' });
    const au = new URL(url);
    check('consent goes to the chosen DC', accountsDomain === 'https://accounts.zoho.com' && au.origin === 'https://accounts.zoho.com' && au.pathname === '/oauth/v2/auth');
    check('offline access + forced consent (refresh token every time)', au.searchParams.get('access_type') === 'offline' && au.searchParams.get('prompt') === 'consent');
    const scopes = au.searchParams.get('scope').split(',');
    check('every scope is READ-only; no CREATE/UPDATE/DELETE/ALL',
      scopes.length > 0 && scopes.every((s) => /^ZohoBooks\.[a-z]+\.READ$/.test(s)), scopes);
    const claims = Z.verifyState(au.searchParams.get('state'));
    check('state carries uid + lower-cased region', claims && claims.uid === 'user-1' && claims.region === 'com', claims);

    // ------------------------------------------------ state HMAC
    console.log('# state HMAC');
    const st = Z.signState({ uid: 'u-9', region: 'in' });
    check('fresh state verifies', Z.verifyState(st) && Z.verifyState(st).uid === 'u-9');
    const [body, sig] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'attacker', region: 'in', ts: Date.now() })).toString('base64url');
    check('payload swapped, signature kept -> rejected', Z.verifyState(forged + '.' + sig) === null);
    check('signature flipped -> rejected', Z.verifyState(body + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)) === null);
    check('truncated signature -> rejected (no timingSafeEqual throw)', Z.verifyState(body + '.' + sig.slice(0, 10)) === null);
    check('no dot / non-string -> rejected', Z.verifyState('abc') === null && Z.verifyState(undefined) === null && Z.verifyState({}) === null);
    const clock = H.fakeClock();
    console.error = () => {};
    clock.advance(29 * MIN);
    check('state still valid at 29 minutes', !!Z.verifyState(st));
    clock.advance(2 * MIN);
    check('state expired at 31 minutes (30-min TTL)', Z.verifyState(st) === null);
    console.error = origErr;
    clock.restore();

    // ------------------------------------------------ token exchange
    console.log('# token exchange + api_domain');
    {
      const { zoho } = freshWorld();
      const tok = await Z.exchangeCodeForTokens('good-code', 'https://accounts.zoho.in');
      check('api_domain comes from the token response, trailing slash stripped', tok.apiDomain === 'https://www.zohoapis.in', tok.apiDomain);
      check('refresh + access token returned', !!tok.refreshToken && !!tok.accessToken && tok.expiresIn === 3600);
      const tc = zoho.tokenCalls[0];
      check('exchange is a POST to <accounts>/oauth/v2/token with grant_type=authorization_code',
        tc.method === 'POST' && tc.path === '/oauth/v2/token' && tc.grant_type === 'authorization_code' && tc.redirect_uri === process.env.ZOHO_REDIRECT_URI);
      const e = await rejects(Z.exchangeCodeForTokens('reused-code', 'https://accounts.zoho.in'));
      check('HTTP 200 {error:"invalid_code"} -> ZohoAuthError', e instanceof Z.ZohoAuthError && /invalid_code/.test(e.message), e && e.message);
    }
    {
      const db = new H.FakeDb();
      H.installFetch(db, null, async () => H.json(200, { access_token: 'a', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }));
      const e = await rejects(Z.exchangeCodeForTokens('x', 'https://accounts.zoho.in'));
      check('no refresh_token in the response -> ZohoAuthError', e instanceof Z.ZohoAuthError && /refresh_token/.test(e.message));
      H.installFetch(db, null, async () => H.json(200, { access_token: 'a', refresh_token: 'r' }));
      const e2 = await rejects(Z.exchangeCodeForTokens('x', 'https://accounts.zoho.in'));
      check('no api_domain -> ZohoAuthError (no hardcoded fallback)', e2 instanceof Z.ZohoAuthError && /api_domain/.test(e2.message));
    }

    // ------------------------------------------------ session basics
    console.log('# session: header, organization_id, api_domain per org');
    {
      const { zoho, db, session, strays } = freshWorld({ apiDomain: 'https://www.zohoapis.com', accountsDomain: 'https://accounts.zoho.com' });
      const data = await session.apiGet('/books/v3/invoices', { page: '1' });
      await tick();
      check('call reaches the org\'s persisted api_domain (.com here)', zoho.calls[0] && zoho.calls[0].url.startsWith('https://www.zohoapis.com/books/v3/invoices?'));
      check('refresh hits the org\'s accounts_domain', zoho.tokenCalls.length === 1 && zoho.tokenCalls[0].grant_type === 'refresh_token');
      check('Authorization is "Zoho-oauthtoken <token>", never Bearer', /^Zoho-oauthtoken 1000\.acc1\./.test(zoho.calls[0].auth), zoho.calls[0].auth);
      check('organization_id injected on every call', zoho.calls[0].params.organization_id === '60012345678');
      check('response parsed', Array.isArray(data.invoices) && data.invoices.length === 3);
      check('refresh read from vault via rpc, last_token_refresh stamped',
        db.log.some((l) => l.startsWith('POST rpc/zoho_vault_get')) && !!db.t('zoho_organizations')[0].last_token_refresh);
      check('no stray network', strays.length === 0, strays);
    }

    // ------------------------------------------------ proactive refresh
    console.log('# proactive refresh at 50 minutes');
    {
      const { zoho, session } = freshWorld();
      const clock = H.fakeClock();
      try {
        await session.apiGet('books/v3/invoices');
        clock.advance(49 * MIN);
        await session.apiGet('books/v3/invoices');
        check('token reused at 49 minutes (1 refresh total)', zoho.refreshCount === 1, zoho.refreshCount);
        clock.advance(1 * MIN + 1000);
        await session.apiGet('books/v3/invoices');
        check('token refreshed proactively past 50 minutes', zoho.refreshCount === 2, zoho.refreshCount);
        check('no 401 was needed to trigger it', zoho.calls.every((c) => zoho.validTokens.has(c.auth.replace('Zoho-oauthtoken ', ''))));
        check('the newer token is the one used', zoho.calls[2].auth !== zoho.calls[1].auth && zoho.calls[0].auth === zoho.calls[1].auth);
      } finally { clock.restore(); }
    }
    {
      const { zoho, session } = freshWorld();
      session.seed('1000.seeded.tok', '1000.exch0refresh0in.rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr');
      zoho.validTokens.add('1000.seeded.tok');
      await session.apiGet('books/v3/invoices');
      check('seeded token used without a refresh (activation path)', zoho.refreshCount === 0 && zoho.calls[0].auth === 'Zoho-oauthtoken 1000.seeded.tok');
    }

    // ------------------------------------------------ 429 backoff
    console.log('# 429 / 5xx backoff');
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(429, H.fixture('error-429.json')), 2);
      timers.delays.length = 0;
      const data = await session.apiGet('books/v3/invoices');
      check('two 429s then success: data returned', data.invoices.length === 3);
      check('backoff waits 2s then 4s (BACKOFF x2)', JSON.stringify(timers.delays) === '[2000,4000]', timers.delays);
      check('3 HTTP attempts, counted', zoho.calls.length === 3 && session.callCount() === 3);
    }
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(429, H.fixture('error-429.json')), 10);
      timers.delays.length = 0;
      const e = await rejects(session.apiGet('books/v3/invoices'));
      check('persistent 429 gives up after 4 attempts', e && /rate limit exceeded after retries/.test(e.message) && zoho.calls.length === 4, [e && e.message, zoho.calls.length]);
      check('backoff 2s, 4s, 8s', JSON.stringify(timers.delays) === '[2000,4000,8000]', timers.delays);
      check('429 is not an auth failure', !(e instanceof Z.ZohoAuthError));
    }
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(503, { code: 1, message: 'busy' }), 2);
      timers.delays.length = 0;
      await session.apiGet('books/v3/invoices');
      check('5xx retried with 1s, 2s backoff', JSON.stringify(timers.delays) === '[1000,2000]', timers.delays);
    }

    // ------------------------------------------------ code 57 / module unavailable
    console.log('# code 57 + module unavailable');
    for (const status of [403, 401]) {
      const { zoho, session } = freshWorld();
      zoho.fault((c) => c.path === 'books/v3/chartofaccounts', () => H.json(status, H.fixture('error-403-code57.json')));
      const e = await rejects(session.apiGet('books/v3/chartofaccounts'));
      check(`HTTP ${status} code 57 -> ZohoModuleUnavailable (connection kept)`, e instanceof Z.ZohoModuleUnavailable && !(e instanceof Z.ZohoAuthError), e && e.message);
      check(`HTTP ${status} code 57 does not burn a token refresh`, zoho.refreshCount === 1 && zoho.calls.length === 1, [zoho.refreshCount, zoho.calls.length]);
    }
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(400, H.fixture('error-400-plan.json')));
      const e = await rejects(session.apiGet('books/v3/bankaccounts'));
      check('400 "not available in your plan" -> ZohoModuleUnavailable', e instanceof Z.ZohoModuleUnavailable);
      const e2 = await rejects(session.apiGet('books/v3/nope'));
      check('404 -> ZohoModuleUnavailable', e2 instanceof Z.ZohoModuleUnavailable);
      zoho.fault(() => true, () => H.json(400, { code: 2, message: 'Invalid value passed for page' }));
      const e3 = await rejects(session.apiGet('books/v3/invoices'));
      check('other 400 -> plain Error with Zoho\'s message', e3 && !(e3 instanceof Z.ZohoModuleUnavailable) && !(e3 instanceof Z.ZohoAuthError) && /Invalid value passed/.test(e3.message));
    }

    // ------------------------------------------------ 401 -> refresh -> needs_reauth
    console.log('# 401 handling');
    {
      const { zoho, session } = freshWorld();
      await session.apiGet('books/v3/invoices');
      zoho.expireAllAccessTokens();                 // Zoho-side expiry before our 50-min clock
      const data = await session.apiGet('books/v3/invoices');
      check('401 invalid token -> one refresh, request retried, data returned', data.invoices.length === 3 && zoho.refreshCount === 2);
      check('retry carries the new token', zoho.calls[2].auth !== zoho.calls[1].auth && zoho.calls[2].auth.startsWith('Zoho-oauthtoken '));
    }
    {
      const { zoho, session } = freshWorld();
      await session.apiGet('books/v3/invoices');
      zoho.expireAllAccessTokens();
      zoho.refreshTokens.clear();                   // owner revoked in Zoho
      const e = await rejects(session.apiGet('books/v3/invoices'));
      check('401 + revoked refresh token -> ZohoAuthError (needs_reauth)', e instanceof Z.ZohoAuthError && e.message === 'invalid_grant', e && e.message);
    }
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(401, H.fixture('error-401-invalid-token.json')), 2);
      const e = await rejects(session.apiGet('books/v3/invoices'));
      check('401 again right after a fresh refresh -> ZohoAuthError, no loop', e instanceof Z.ZohoAuthError && zoho.calls.length === 2 && zoho.refreshCount === 2, [e && e.message, zoho.calls.length]);
    }
    {
      const { zoho, session } = freshWorld();
      zoho.fault(() => true, () => H.json(403, { code: 14, message: 'Invalid OAuth access token.' }));
      const e = await rejects(session.apiGet('books/v3/invoices'));
      check('403 that is not code 57 -> ZohoAuthError', e instanceof Z.ZohoAuthError);
    }
    {
      const { db, session } = freshWorld();
      delete db.vault['org-1'];
      const e = await rejects(session.apiGet('books/v3/invoices'));
      check('no refresh token in vault -> ZohoAuthError', e instanceof Z.ZohoAuthError);
    }
    {
      const { zoho, session } = freshWorld();
      await session.apiGet('books/v3/invoices');
      zoho.expireAllAccessTokens();
      zoho.fault(() => zoho.calls.length === 3, () => H.json(429, H.fixture('error-429.json')));
      timers.delays.length = 0;
      const data = await session.apiGet('books/v3/invoices');
      check('429 on the post-refresh retry is backed off, then data returned', data && data.invoices.length === 3 && zoho.refreshCount === 2 && timers.delays.length === 1, [zoho.refreshCount, timers.delays]);
    }
    {
      const { zoho, session } = freshWorld();
      await session.apiGet('books/v3/invoices');
      zoho.expireAllAccessTokens();
      zoho.fault(() => zoho.calls.length === 3, () => H.json(503, { message: 'unavailable' }));
      const data = await session.apiGet('books/v3/invoices');
      check('5xx on the post-refresh retry is retried', data && data.invoices.length === 3 && zoho.refreshCount === 2);
    }

    // ------------------------------------------------ pagination
    console.log('# pagination');
    {
      const { zoho, session } = freshWorld();
      zoho.collection('books/v3/invoices', 'invoices', H.makeRecords('invoice.record.json', 'invoice_id', 450));
      timers.delays.length = 0;
      const all = await session.apiGetAll('books/v3/invoices', 'invoices', { sort_column: 'last_modified_time' });
      check('450 rows -> 3 pages of per_page=200', zoho.calls.length === 3 && zoho.calls.every((c) => c.params.per_page === '200') && zoho.calls.map((c) => c.params.page).join() === '1,2,3');
      check('all 450 rows, no duplicates', all.length === 450 && new Set(all.map((r) => r.invoice_id)).size === 450);
      check('700ms pause between pages only', JSON.stringify(timers.delays) === '[700,700]', timers.delays);
      check('caller query preserved on every page', zoho.calls.every((c) => c.params.sort_column === 'last_modified_time'));
    }
    {
      const { zoho, session } = freshWorld();
      zoho.collection('books/v3/invoices', 'invoices', H.makeRecords('invoice.record.json', 'invoice_id', 400));
      const all = await session.apiGetAll('books/v3/invoices', 'invoices');
      check('exactly 400 rows -> 2 calls (has_more_page=false stops it)', all.length === 400 && zoho.calls.length === 2);
      zoho.calls.length = 0;
      zoho.collection('books/v3/invoices', 'invoices', []);
      const none = await session.apiGetAll('books/v3/invoices', 'invoices');
      check('empty collection -> 1 call, []', none.length === 0 && zoho.calls.length === 1);
    }

    // ------------------------------------------------ org list + helpers
    console.log('# organizations + helpers');
    {
      const { zoho } = freshWorld();
      zoho.validTokens.add('t1');
      zoho.route('books/v3/organizations', () => H.json(200, H.fixture('organizations.usd.json')));
      const orgs = await Z.listOrganizations(zoho.apiDomain, 't1');
      check('listOrganizations uses Zoho-oauthtoken', zoho.calls[0].auth === 'Zoho-oauthtoken t1');
      check('non-INR org keeps its currency + plan lower-cased', orgs[0].currency_code === 'USD' && orgs[0].plan_type === 'professional' && orgs[0].is_default === true, orgs);
      zoho.route('books/v3/organizations', () => H.json(500, {}));
      const e = await rejects(Z.listOrganizations(zoho.apiDomain, 't1'));
      check('org list failure -> ZohoAuthError', e instanceof Z.ZohoAuthError);
    }
    {
      const { db } = freshWorld();
      await Z.markNeedsReauth('org-1');
      check('markNeedsReauth flips status', db.t('zoho_organizations')[0].status === 'needs_reauth');
    }
    check('dailyCapFor: plan caps, unknown -> 1000', Z.dailyCapFor('Standard') === 2000 && Z.dailyCapFor(null) === 1000);
    check('toDateOnly / toNumber', Z.toDateOnly('2026-09-01T10:00:00+0530') === '2026-09-01' && Z.toDateOnly('soon') === null && Z.toNumber('12.5') === 12.5 && Z.toNumber('x') === 0);
  } catch (err) {
    console.error(err);
    T.fail++;
  } finally {
    timers.restore();
  }
  T.done();
})();
