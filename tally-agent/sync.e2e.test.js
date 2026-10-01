/**
 * End-to-end: real agent code -> mock Tally (with the real-book Day Book bug) -> fake Margyn cloud.
 *   node sync.e2e.test.js
 * Proves: every voucher of the FY arrives (not just the Day Book's single day), counts match
 * Tally's, a second tick with no Tally changes sends nothing, an edit is picked up incrementally,
 * a client whose Tally rejects $$Date still syncs (ladder), and FY-rollover company switching.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'margyn-agent-'));
process.env.HOME = HOME; process.env.APPDATA = HOME; process.env.XDG_CONFIG_HOME = HOME;

function startMock(port, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mock-tally.js')], { env: Object.assign({}, process.env, { PORT: String(port) }, env || {}), stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.once('data', () => resolve(p));
    p.once('exit', (code) => { if (code) { console.error('mock failed to start'); process.exit(1); } });
  });
}

function stopMock(p) {
  return new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', () => r()); p.kill(); });
}

function startCloud(port) {
  const store = { vouchers: new Map(), ledgers: 0, bills: [], health: null, requests: 0, maxBody: 0 };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      store.requests++;
      store.maxBody = Math.max(store.maxBody, b.length);
      const action = new URL(req.url, 'http://x').searchParams.get('action');
      const body = JSON.parse(b || '{}');
      const now = new Date().toISOString();
      if (action === 'health') { store.health = body; res.end('{"ok":true}'); return; }
      if (body.kind === 'vouchers') {
        for (const r of body.rows) store.vouchers.set(r.guid, Object.assign({}, r, { synced_at: now }));
        let removed = 0;
        if (body.window_final) {
          const cut = body.window_started_at || now;
          for (const [g, r] of store.vouchers) {
            const d = r.date;
            if (d >= body.window.from && d <= body.window.to && r.synced_at < cut) { store.vouchers.delete(g); removed++; }
          }
        }
        res.end(JSON.stringify({ upserted: body.rows.length, received: body.rows.length, removed, server_time: now }));
        return;
      }
      if (body.kind === 'ledgers') store.ledgers += body.rows.length;
      if (body.kind === 'bills') store.bills.push(...body.rows);
      res.end(JSON.stringify({ upserted: body.rows.length, received: body.rows.length, server_time: now }));
    });
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, store })));
}

(async () => {
  const TALLY = 9711, CLOUD = 9712;
  let mock = await startMock(TALLY);
  const { srv, store } = await startCloud(CLOUD);
  const config = require('./config');
  config.save({ apiBase: `http://127.0.0.1:${CLOUD}`, tallyHost: '127.0.0.1', tallyPort: TALLY, company: 'CARE HYGIENE PVT LTD (2026-27)', installKey: 'mtly_test' });
  const agent = require('./agent');
  const lines = [];
  agent.setLogger((l) => lines.push(l));

  // 1) First sync: full financial year, not just the Day Book's last day.
  const r1 = await agent.runFullSync(config.load());
  const months = {};
  for (const v of store.vouchers.values()) months[v.date.slice(0, 7)] = (months[v.date.slice(0, 7)] || 0) + 1;
  assert.deepStrictEqual(Object.keys(months).sort(), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'], 'every month of the FY arrives');
  assert.strictEqual(store.vouchers.size, 4 * 183, 'all 732 vouchers');
  assert.strictEqual(r1.vouchers.mode, 'full');
  await new Promise((r) => setTimeout(r, 100));
  const h = store.health;
  assert.ok(h && h.vouchers && h.vouchers.strategy === 'collection-period', 'health report names the strategy');
  assert.ok(Object.values(h.vouchers.months).every((m) => m.complete === true), 'every month matches Tally\'s own count');
  assert.ok(store.maxBody < 4.5e6, 'no request over Vercel\'s 4.5MB cap');
  assert.ok(lines.some((l) => /reading it once and splitting by month/.test(l)), 'a Tally that ignores the period is read once, not twelve times');
  // item invoices carry the sales ledger and balance
  const inv = [...store.vouchers.values()].find((v) => v.voucher_type === 'KANDIVALI SALE');
  assert.ok(inv.entries.some((e) => e.ledger === 'SALES @18%'), 'sales line from the stock allocation');
  assert.ok(Math.abs(inv.entries.reduce((s, e) => s + e.amount, 0)) < 0.01, 'entries balance');
  assert.ok(store.bills.length > 0, 'bills still sync');

  // 2) Second tick, nothing changed in Tally: no voucher traffic.
  const before = store.requests;
  const r2 = await agent.runFullSync(config.load());
  assert.strictEqual(r2.vouchers.mode, 'unchanged');
  assert.strictEqual(store.vouchers.size, 732);
  console.log(`  unchanged tick: ${store.requests - before} cloud requests (ledgers + bills + health only)`);

  // 2b) Someone edits a voucher in Tally: only that voucher is re-read (AlterID), amount updated.
  const editedGuid = await new Promise((r) => http.get(`http://127.0.0.1:${TALLY}/__edit`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(d)); }));
  const r2b = await agent.runFullSync(config.load());
  assert.strictEqual(r2b.vouchers.mode, 'incremental');
  assert.strictEqual(r2b.vouchers.received, 1, 'only the edited voucher travels');
  const ed = store.vouchers.get(editedGuid);
  assert.ok(Math.abs(ed.entries.reduce((s2, e) => s2 + e.amount, 0)) < 0.01 && Math.abs(ed.amount) > 0, 'edited voucher stored, balanced');

  // 3) A deleted voucher disappears on the next full pass; months verified against Tally.
  store.vouchers.set('ghost-1', { guid: 'ghost-1', date: '2026-05-10', voucher_type: 'Sales', synced_at: '2000-01-01T00:00:00Z' });
  const s = config.load().syncState; s.lastFullAt = 0; config.save({ syncState: s });
  const r3 = await agent.runFullSync(config.load());
  assert.strictEqual(r3.vouchers.mode, 'full');
  assert.ok(!store.vouchers.has('ghost-1'), 'voucher deleted in Tally is removed');
  assert.strictEqual(store.vouchers.size, 732);

  // 4) A request that would close this client's Tally: it happens once, then never again on this PC.
  await stopMock(mock);
  mock = await startMock(TALLY, { CRASH_ON: 'MargynVchCount' });
  config.save({ syncState: {} });
  store.vouchers.clear();
  await agent.runFullSync(config.load()).catch(() => {});
  assert.ok((config.load().syncState.blockedRequests || []).includes('voucher-count'), 'the request that closed Tally is switched off');
  await new Promise((r) => setTimeout(r, 300));
  mock = await startMock(TALLY, { CRASH_ON: 'MargynVchCount' });   // client reopens Tally
  await agent.runFullSync(config.load());
  assert.strictEqual(store.vouchers.size, 732, 'next sync completes without the blocked request');
  assert.ok(mock.exitCode === null, 'Tally was not closed a second time');

  // 4b) Agent killed mid-request (note left on disk): that request is switched off on restart.
  const st = config.load().syncState; st.inflight = 'voucher-types'; config.save({ syncState: st });
  await agent.runFullSync(config.load());
  assert.ok(config.load().syncState.blockedRequests.includes('voucher-types'));
  await stopMock(mock);
  mock = await startMock(TALLY);
  config.save({ syncState: {} });

  // 5) FY rollover: configured "(2025-26)" isn't open, the "(2026-27)" company is -> switch.
  config.save({ company: 'CARE HYGIENE PVT LTD (2025-26)', syncState: {} });
  await agent.runFullSync(config.load());
  assert.strictEqual(config.load().company, 'CARE HYGIENE PVT LTD (2026-27)', 'switched to the open company');

  // 6) An unrelated company configured: clear error naming what IS open, nothing synced from the wrong books.
  config.save({ company: 'SOMEONE ELSE LTD' });
  await assert.rejects(() => agent.runFullSync(config.load()), /not open in Tally.*CARE HYGIENE/);

  await stopMock(mock); srv.close();
  console.log('sync e2e: all checks pass');
  console.log(lines.filter((l) => /Using|matches|switching|Finding/.test(l)).slice(0, 12).map((l) => '  ' + l).join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
