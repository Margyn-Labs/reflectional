// Margyn starts helping the moment someone signs in (app/js/25b-margyn-start.js), on a brand-new account.
// 1. New account, no books: Margyn leads the setup. Connect Zoho Books: the panel narrates the first read
//    ("Reading your invoices… 1,000 so far"), gives a first read from the books tool, then asks three
//    skippable questions whose answers land in prefs.forecast.floor, ledger_parties and Margyn Watch.
//    An empty book still gets set up.
// 2. A later sign-in: what changed since the last visit, Remind <customer> (shown first, sent only on Send),
//    this week's payables for the accountant, Show me.
// 3. An existing Tally account: nothing new appears (same greeting as before).
// Usage: node tools/serve-static.js &   then   node tools/ui-first-run-test.js [baseUrl]
const { chromium } = require('playwright');
const B = process.argv[2] || 'http://localhost:5188/app.html';
const SHOTS = process.env.SHOTS || null;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };

/* A fresh account in the page: empty tables, no books until the connect, every /api call stubbed. */
async function freshSeed(opts){
  const o = opts || {};
  const DAY = 86400000, now = Date.now(), iso = ms => new Date(now - ms).toISOString();
  const UID = o.uid || 'fresh';
  currentUser = { id:UID, email:'investor@example.in', created_at:iso(o.ageMs != null ? o.ageMs : 3600000), user_metadata:{ full_name:'Asha Rao' } };
  currentProfile = { id:UID, company_name:'Rao Traders', preferences:Object.assign({}, o.prefs || {}), whatsapp_phone:o.phone || null };
  const T = { profiles:[currentProfile], snapshots:[], receivables:[], payables:[], findings:[], import_suggestions:[], ledger_parties:[], ledger_entries:[],
    invoices:[], ledger_events:[], chat_messages:[], connector_credentials:[], connector_logs:[], business_stakeholders:[], agent_deployments:[], whatsapp_chase_targets:[] };
  window.__T = T; window.__writes = [];
  sbClient.from = (table) => {
    let rows = (T[table] || []).slice(), pending = null;
    const b = new Proxy({}, { get(_, prop){
      if(prop === 'then') return (res, rej) => Promise.resolve({ data:pending || rows, error:null }).then(res, rej);
      if(prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data:(pending || rows)[0] || null, error:null });
      if(prop === 'eq') return (k, v) => { if(k !== 'user_id' && k !== 'business_id') rows = rows.filter(r => r[k] === undefined || r[k] === v); return b; };
      if(prop === 'insert' || prop === 'upsert') return (payload) => { const list = (Array.isArray(payload) ? payload : [payload]).map((r, i) => Object.assign({ id:table + '-' + (T[table] || []).length + '-' + i, created_at:new Date().toISOString() }, r)); (T[table] = T[table] || []).push(...list); window.__writes.push({ table, op:'insert', rows:JSON.parse(JSON.stringify(list)) }); pending = list; return b; };
      if(prop === 'update') return (payload) => { window.__writes.push({ table, op:'update', payload:JSON.parse(JSON.stringify(payload)) }); rows.forEach(r => Object.assign(r, payload)); pending = rows.slice(); return b; };
      if(prop === 'delete') return () => { rows = []; return b; };
      return () => b;
    } });
    return b;
  };
  window.__z = Object.assign({ connected:!!o.zoho, reads:0, steps:[] }, window.__z || {});
  window.__api = [];
  const vitals = () => window.__z.connected ? { connected:true, org_ref:'zo1', organization_id:'600', organization_name:'Rao Traders', status:'active', last_synced_at:iso(60000), backfill_completed_at:iso(30000),
    receivables:{ total:330000 }, payables:{ total:150000 }, receivables_list:[], payables_list:[], item_lines:{ documents:0 }, flags:[] } : { connected:false };
  const reply = (body, status) => new Response(JSON.stringify(body), { status:status || 200, headers:{ 'Content-Type':'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const m = url.match(/\/api\/(.+)$/);
    if(!m) return realFetch(input, init);
    const path = m[1], body = init && init.body ? JSON.parse(init.body) : null;
    window.__api.push({ path, body });
    if(path.startsWith('zoho?action=vitals')) return reply(vitals());
    if(path.startsWith('zoho?action=first-read')){
      // Each poll moves the first read on: invoices page by page, then the rest.
      const z = window.__z; z.reads++;
      const P = [[], [['chartofaccounts', 120, true]], [['chartofaccounts', 120, true], ['invoices', 200, false]], [['chartofaccounts', 120, true], ['invoices', 1000, false]],
        [['chartofaccounts', 120, true], ['invoices', 1204, true], ['bills', 200, false]], [['chartofaccounts', 120, true], ['invoices', 1204, true], ['bills', 312, true], ['customerpayments', 0, false]]];
      const st = P[Math.min(z.reads, P.length - 1)].map(([module, read, done]) => ({ module, read, done }));
      return reply({ connected:true, status:'active', organization_name:'Rao Traders', done:!!z.connected, steps:st, current:(st.find(x => !x.done) || {}).module || null });
    }
    if(path.startsWith('zoho?action=select-org') && init && init.method === 'POST'){
      await new Promise(r => setTimeout(r, window.__selectMs || 9000));
      window.__z.connected = true;
      return reply({ status:'active', org_ref:'zo1', organization_id:'600', organization_name:'Rao Traders', backfill:'completed' });
    }
    if(path.startsWith('ask-margyn?action=books')){
      if(body.tool === 'opening_read') return reply(typeof window.__openingRead === 'function' ? window.__openingRead(body.input) : window.__openingRead || { connected:false });
      return reply({ connected:true, note:'stub' });
    }
    if(path.startsWith('ask-margyn?action=watch')) return reply(init && init.method === 'POST' ? { mode:body.mode } : { mode:'off', ready:true, signals:[], runs:[], deliveries:[] });
    if(path.startsWith('whatsapp?action=remind-now')){
      const d = { party:body.party, amount:200000, invoice_ref:'INV-0042 + 1 more', has_phone:true, phone_end:'2345', template_ready:true, sends_off:false, chase_number:1, stopped:null,
        text:'Hi, a gentle nudge from Rao Traders — invoice INV-0042 + 1 more for ₹2,00,000 is due and now 45 days overdue. Do let us know once it’s been processed. Thank you!' };
      return reply(body.send ? Object.assign(d, { sent:true, preview:false }) : d);
    }
    if(path.startsWith('tally?action=status')) return reply(o.tally ? { connected:true, installs:[{ id:'ti1', status:'active', company_name:'Care Co', last_sync_at:iso(3600000), counts:{ vouchers:100 } }] } : { connected:false, installs:[] });
    if(path.startsWith('ops?action=team-whoami')) return reply({ ready:true, features:{}, me:{ id:UID, email:'investor@example.in' }, own_account:{ account_id:UID, company_name:'Rao Traders' }, memberships:[] });
    if(path.startsWith('reconcile?action=position')) return reply({ as_of:new Date().toISOString().slice(0, 10), receivables:{ groups:[], totals:{ parties:0, total:0 }, coverage:{}, errors:{} }, payables:{ groups:[], totals:{ parties:0, total:0 }, coverage:{}, errors:{} } });
    return reply({ connected:false });
  };
  agentStakeholders = []; agentDeployments = {};
  document.querySelectorAll('.gate').forEach(g => g.classList.add('hidden'));
  document.getElementById('appShell').classList.remove('hidden');
  try { sbClient.auth.getSession = async () => ({ data:{ session:{ access_token:'fresh-token', user:{ id:UID } } } }); } catch(e){}
  try { if(typeof MG_RELEASES !== 'undefined' && MG_RELEASES.length) localStorage.setItem('margyn_whats_new_seen', MG_RELEASES[0].id); } catch(e){}
  try { sbClient.channel = () => ({ on(){ return this; }, subscribe(cb){ setTimeout(() => cb && cb('SUBSCRIBED'), 0); return this; }, track(){ return Promise.resolve(); }, send(){ return Promise.resolve(); }, presenceState(){ return {}; }, unsubscribe(){} }); } catch(e){}
  if(typeof mgResolveAccount === 'function') await mgResolveAccount({ id:UID, email:'investor@example.in' });
  await refreshAll();
}
const FIRST = { source:'Zoho Books', numbers:{ cash:1850000, recv_total:330000, recv_overdue:200000, due7:150000, pay_overdue:0,
  top:[{ party:'Gupta Traders', owed:240000, overdue:200000, late:45 }, { party:'Iyer Retail', owed:90000, overdue:0, late:0 }],
  late:[{ party:'Gupta Traders', overdue:200000, late:45 }], due7_list:[{ party:'Apex Supplies', ref:'B-12', due:'2026-11-03', amount:150000 }] } };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport:{ width:1440, height:900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const boot = async (opts, prep) => {
    await p.goto(B);
    await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:15000 });
    await p.evaluate(prep || (() => { localStorage.removeItem('mg.lastSeen.fresh'); localStorage.removeItem('mg.panel'); }));
    await p.evaluate(freshSeed, opts);
  };
  const feed = () => p.textContent('#vxFeed');

  /* ---------- 1. a brand-new account ---------- */
  await boot({});
  await p.evaluate(() => { window.__openingRead = null; });
  await p.waitForTimeout(3000);
  ok(/Let’s get your books in/.test(await feed()), 'new account: Margyn leads the setup');
  ok(await p.evaluate(() => (mgPrefGet('margyn_onboard', {}) || {}).state === 'awaiting_books'), 'new account is marked for the guided start');
  await p.evaluate((f) => { window.__openingRead = f; window.__selectMs = 9000; zohoPendingOrgRef = 'ref1'; renderZohoOrgPicker([{ organization_id:'600', name:'Rao Traders', plan_type:'free', currency_code:'INR' }]); }, FIRST);
  await p.click('#zohoOrgList input[type=radio]');
  await p.click('#zohoOrgConfirm');
  await p.waitForTimeout(400);
  ok(/I’m reading your books from Zoho now/.test(await feed()), 'connect: Margyn says it is reading');
  let sawCount = false, sawDone = false;
  for(let i = 0; i < 14; i++){
    const t = (await p.textContent('[data-mgo-prog]').catch(() => '')) || '';
    if(/Reading your invoices… 1,000 so far/.test(t)) sawCount = true;
    if(/✓ 1,204 invoices/.test(t)) sawDone = true;
    await p.waitForTimeout(700);
  }
  ok(sawCount, 'narrates the running count: "Reading your invoices… 1,000 so far"');
  ok(sawDone, 'ticks finished parts: "✓ 1,204 invoices"');
  await p.waitForSelector('.mgo-first', { timeout:15000 }).catch(() => {});
  const first = await p.textContent('.mgo-first').catch(() => '');
  ok(/Here’s your first read/.test(first) && /₹18\.5 L/.test(first) && /Gupta Traders ₹2(\.4)? L/.test(first) && /Bills due this week/.test(first), 'first read: cash, who owes most, bills due this week: ' + first.slice(0, 160));
  if(SHOTS) await p.screenshot({ path:SHOTS + '/first-read.png' });
  // Q1 cash floor
  await p.waitForSelector('[data-mgo-form="floor"] input');
  await p.fill('[data-mgo-form="floor"] input', 'abc');
  await p.click('[data-mgo-form="floor"] [type=submit]');
  ok(/Type an amount/.test(await p.textContent('[data-mgo-form="floor"] [data-mgo-err]')), 'floor: a non-number is asked again');
  await p.fill('[data-mgo-form="floor"] input', '5 L');
  await p.click('[data-mgo-form="floor"] [type=submit]');
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => (mgPrefGet('forecast', {}) || {}).floor === 500000), 'floor saved to the forecast setting (₹5 L)');
  // Q2 debtor numbers: neither has one in the books
  await p.waitForSelector('[data-mgo-form="phones"]');
  ok((await p.$$('[data-mgo-form="phones"] [data-mgo-ph]')).length === 2, 'phones: asks for the two debtors without a number');
  await p.fill('[data-mgo-form="phones"] [data-mgo-ph="0"]', '98200 12345');
  await p.click('[data-mgo-form="phones"] [type=submit]');
  await p.waitForSelector('[data-mgo-form="updates"]', { timeout:5000 }).catch(() => {});
  ok(await p.evaluate(() => window.__T.ledger_parties.some(r => r.name === 'Gupta Traders' && r.phone === '+919820012345')), 'phones: Gupta Traders saved to the party master with its number');
  // Q3 daily update: no number on the account yet
  await p.fill('[data-mgo-form="updates"] input', '9876543210');
  await p.click('[data-mgo-form="updates"] [type=submit]');
  await p.waitForTimeout(800);
  const api = await p.evaluate(() => window.__api);
  ok(api.some(x => /ask-margyn\?action=watch/.test(x.path) && x.body && x.body.op === 'mode' && x.body.mode === 'on'), 'updates: Margyn Watch switched on for the owner');
  ok(await p.evaluate(() => currentProfile.whatsapp_phone === '919876543210'), 'updates: the owner’s WhatsApp number saved');
  ok(/That’s you set up/.test(await feed()) && await p.evaluate(() => mgPrefGet('margyn_onboard', {}).state === 'done'), 'setup finished and remembered');
  ok(!api.some(x => /remind-now/.test(x.path)), 'nothing was sent to any customer during setup');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/setup-done.png' });

  // An empty book (zero history): still set up, no debtor question.
  const empty = await p.evaluate(async () => {
    window.__openingRead = { connected:true, note:'Zoho Books is connected but no entries have synced yet.' };
    mgoRetries = 6; const r = await mgoFirstRead();
    return { r, text:document.getElementById('vxFeed').textContent, phones:mgoQuestion('phones'), floor:!!mgoQuestion('floor') };
  });
  ok(empty.r === true && /they’re empty so far/.test(empty.text) && empty.phones === '' && empty.floor, 'empty book: says so, still asks the floor, skips debtor numbers');

  /* ---------- 2. a later sign-in ---------- */
  await boot({ zoho:true, phone:'919876543210', prefs:{ margyn_onboard:{ state:'done' } } },
    () => { localStorage.setItem('mg.lastSeen.fresh', new Date(Date.now() - 2 * 86400000).toISOString()); localStorage.removeItem('mg.panel'); window.__z = { connected:true }; });
  await p.evaluate((f) => { window.__openingRead = (input) => Object.assign({}, f, { numbers:Object.assign({}, f.numbers, input.since ? { since:{ from:'2026-10-29', money_in:200000, paid:[{ party:'Iyer Retail', amount:200000, on:'2026-10-30' }], went_overdue:200000, late:[{ party:'Gupta Traders', amount:200000 }], new_sales:3 } } : {}) }); }, FIRST);
  await p.click('#mgrLaunch').catch(() => {});
  await p.waitForSelector('.mgo-opening', { timeout:8000 }).catch(() => {});
  const open = await p.textContent('.mgo-opening').catch(() => '');
  ok(/In your books since/.test(open) && /₹2 L came in/.test(open) && /Iyer Retail ₹2 L/.test(open) && /went overdue/.test(open) && /of bills/.test(open), 'later sign-in: what changed: ' + open.slice(0, 200));
  const labels = await p.$$eval('.mgo-opening .mgr-acts button', bs => bs.map(x => x.textContent));
  ok(labels.includes('Remind Gupta Traders') && labels.some(l => /payables to my accountant/.test(l)) && labels.includes('Show me'), 'three ready actions: ' + labels.join(' | '));
  await p.click('.mgo-opening [data-mgo-remind]');
  await p.waitForSelector('.mgo-remind .mgo-wa', { timeout:5000 }).catch(() => {});
  ok(/gentle nudge from Rao Traders/.test(await p.textContent('.mgo-remind').catch(() => '')), 'Remind: shows the exact WhatsApp text first');
  ok(!(await p.evaluate(() => window.__api.some(x => /remind-now/.test(x.path) && x.body.send))), 'Remind: nothing sent before Send');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/remind.png' });
  await p.click('.mgo-remind [data-mgo-send]');
  await p.waitForTimeout(600);
  ok(await p.evaluate(() => window.__api.some(x => /remind-now/.test(x.path) && x.body.send === true && x.body.party === 'Gupta Traders')) && /Sent to Gupta Traders/.test(await feed()), 'Send: one reminder, then says it went');
  await p.click('.mgo-opening [data-mgo-pay]');
  const pay = await p.inputValue('.mg-dialog textarea').catch(() => '');
  ok(/Apex Supplies B-12: ₹1,50,000/.test(pay) && await p.isVisible('[data-mgo-wa]'), 'payables for the accountant: the list, opened in WhatsApp by the owner');
  await p.click('.mg-dialog .mg-dlg-cancel');

  /* ---------- 3. an existing Tally account: nothing new ---------- */
  await boot({ uid:'tallyowner', tally:true, ageMs:300 * 86400000, phone:'919000000001' },
    () => { localStorage.setItem('mg.lastSeen.tallyowner', new Date(Date.now() - 2 * 86400000).toISOString()); window.__z = { connected:false }; });
  await p.evaluate(() => { window.__openingRead = () => { window.__openingCalled = true; return { numbers:{ since:{} } }; }; });
  await p.waitForTimeout(4000);
  ok(!(await p.evaluate(() => window.__openingCalled)) && !(await p.$('.mgo-opening')) && !(await p.$('.mgo-q')), 'Tally account: no opening read, no setup questions');
  ok(await p.evaluate(() => mgPrefGet('margyn_onboard', null) === null), 'Tally account: nothing written to its settings');

  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
