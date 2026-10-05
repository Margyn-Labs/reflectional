// Margyn OS (27-os.js, 28-os-live.js, 29-os-pages.js, 30-os-records.js):
// every space and tab opens without errors or overflow, old links land on
// their new home, tabs show only their part of a page, live work shows in the
// top bar / Desk / Live, an honest error when a call fails, role access on the
// rail and Desk, voice scroll finds a section on another tab, the party
// timeline and thread (before and after the record_notes SQL), and phone.
// Usage: node tools/serve-static.js &   then   node tools/ui-os-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B);
  await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });

  // 0. A call the app makes shows as work while it runs, then honestly as failed (static server: 404).
  await p.evaluate(() => { fetch('/api/reconcile?action=summary').catch(() => {}); });
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => osRunning('payments').some(a => /Reconciling payments against invoices/.test(a.text))), 'a reconcile call shows as running for the Payments agent');
  await p.waitForTimeout(1800);
  ok(await p.evaluate(() => osAct.some(a => a.agent === 'payments' && a.state === 'error' && /didn’t answer \(404\)/.test(a.text))), 'when it fails, the record says so (404), not "done"');

  await p.evaluate(seedApp); await p.waitForTimeout(1500);

  // 1. Rail: grouped spaces, no old buttons visible.
  const spaces = await p.$$eval('.os-rail-b', x => x.map(b => b.dataset.osSpace));
  ok(spaces.join() === 'desk,work,cash,collect,pay,tax,close,plan,parties,transactions,documents,reports,margyn,apps,rules,team,audit,settings', 'rail: ' + spaces.join(' '));
  ok(await p.evaluate(() => [...document.querySelectorAll('.sidebar .pagenav > button')].every(b => !b.offsetParent)), 'old rail buttons are kept for code but hidden');
  ok(await p.evaluate(() => [...document.querySelectorAll('.os-rail-g')].map(g => g.textContent).join()) === 'You,Workflows,Records,System', 'rail groups: You, Workflows, Records, System');

  // 2. Every space and tab: opens, URL is space/tab, the right view, no overflow, no errors.
  const tabs = await p.evaluate(() => OS_SPACES.flatMap(s => osTabsFor(s).map(t => [s.key, t.k, t.page])));
  const bad = [];
  for(const [s, k, page] of tabs){
    const before = errs.length;
    await p.evaluate(([s, k]) => osGo(s, k), [s, k]); await p.waitForTimeout(250);
    const r = await p.evaluate(() => ({ view:mgCurrentView, hash:location.hash, tab:osCur && osCur.space.key + '/' + osCur.tab.k, ov:(() => { const w = document.querySelector('.app-body .wrap'); return Math.max(document.documentElement.scrollWidth - innerWidth, w.scrollWidth - w.clientWidth); })(),
      title:(document.querySelector('.os-tab.on') || {}).textContent || '', active:(document.querySelector('.os-rail-b.active') || {}).dataset ? document.querySelector('.os-rail-b.active').dataset.osSpace : '' }));
    const want = '#/' + s + (await p.evaluate(s => OS_BY_KEY[s].tabs.length > 1, s) ? '/' + k : '');
    if(r.view !== page || !r.hash.startsWith(want) || r.tab !== s + '/' + k || r.ov > 0 || r.active !== s || errs.length > before) bad.push(s + '/' + k + ' ' + JSON.stringify(r) + (errs.length > before ? ' ERR ' + errs.slice(before).join(';') : ''));
  }
  ok(!bad.length, 'all ' + tabs.length + ' tabs open cleanly' + (bad.length ? ': ' + bad.join(' | ') : ''));

  // 3. Old links land on their new home and the address moves to it.
  const OLD = { '#/receivables':'#/collect/receivables', '#/ledger':'#/close/books', '#/channel-health':'#/margyn/delivery', '#/settings':'#/settings/preferences', '#/people':'#/team/whatsapp',
    '#/inbox':'#/work/needs-me', '#/pulse':'#/plan/pulse', '#/cfo-pack':'#/reports/cfo-pack', '#/payment-gateways':'#/cash/gateways', '#/home':'#/desk', '#/agents':'#/margyn/agents', '#/financing':'#/plan/capital', '#/import':'#/documents/import' };
  const wrong = [];
  for(const [o, n] of Object.entries(OLD)){ await p.evaluate(h => { location.hash = h; }, o); await p.waitForTimeout(350); const h = await p.evaluate(() => location.hash); if(h !== n) wrong.push(o + ' -> ' + h); }
  ok(!wrong.length, 'old links move to their new address' + (wrong.length ? ': ' + wrong.join(', ') : ''));

  // 4. A tab shows its part of a page; the page's tiles show on every tab.
  await p.evaluate(() => osGo('cash', 'forecast')); await p.waitForTimeout(300);
  const fc = await p.evaluate(() => ({ fc:!!document.querySelector('#view-cash #mgFcTable') && !!document.querySelector('#view-cash #mgFcTable').offsetParent, where:!!(document.getElementById('mgCashWhere') || {}).offsetParent, tiles:!!document.querySelector('#view-cash .mg-tiles').offsetParent, title:document.querySelector('#view-cash .mg-title').textContent.trim() }));
  ok(fc.fc && !fc.where && fc.tiles && fc.title === 'Forecast', 'Cash › Forecast: forecast shown, Where the cash is hidden, tiles kept, titled Forecast: ' + JSON.stringify(fc));
  await p.evaluate(() => osGo('cash', 'overview')); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !!document.getElementById('mgCashWhere').offsetParent && !document.querySelector('#view-cash #mgFcTable').offsetParent), 'Cash › Overview: the reverse');
  await p.evaluate(() => osGo('settings', 'notifications')); await p.waitForTimeout(300);
  const st = await p.evaluate(() => [...document.querySelectorAll('#settingsMount .set-block')].filter(b => b.offsetParent).map(b => b.querySelector('h3').textContent));
  ok(st.join() === 'Notifications', 'Settings › Notifications shows only Notifications: ' + st);
  await p.evaluate(() => osGo('settings', 'preferences')); await p.waitForTimeout(300);
  const pr = await p.evaluate(() => [...document.querySelectorAll('#settingsMount .set-block')].filter(b => b.offsetParent).map(b => b.querySelector('h3').textContent));
  ok(!pr.some(h => /App logins|People on WhatsApp|Notifications|Scoring|Connected sources|Consent|^Account$/.test(h)), 'Settings › Preferences keeps only what no other tab claims: ' + pr);
  await p.evaluate(() => osGo('collect', 'matching')); await p.waitForTimeout(300);
  ok(await p.evaluate(() => /Matching/.test(document.querySelector('#view-agents .rd-head h1').textContent) && !!document.getElementById('reconReviewCard').offsetParent && !(document.getElementById('agentSuggestCard') || {}).offsetParent), 'Collect › Matching: the reconciliation cards, titled Matching');

  // 5. Live work: top bar, Desk, Live; idle afterwards says what happened last.
  await p.evaluate(() => { osActAdd({ agent:'payments', text:'Reconciling payments against invoices…', state:'running', at:new Date().toISOString(), from:'app', key:'t1' });
    osActAdd({ agent:'books', text:'Syncing Tally vouchers…', state:'running', at:new Date().toISOString(), from:'server', key:'t2' }); osGo('desk'); });
  await p.waitForTimeout(500);
  ok(/Payments/.test(await p.textContent('#osLive')) && await p.evaluate(() => document.getElementById('osLive').classList.contains('on')), 'top bar: what is running right now');
  ok(await p.evaluate(() => document.querySelector('#view-home .os-now').classList.contains('on')) && (await p.$$('#view-home .os-ag.working')).length === 2, 'Desk: Margyn is working, two agents working');
  await p.evaluate(() => osGo('margyn', 'live')); await p.waitForTimeout(500);
  ok(/2 things running/.test(await p.textContent('#view-live')) && (await p.$$('#view-live .os-agc')).length === 8 && (await p.$$('#view-live .os-sys-svg circle animateMotion, #view-live .os-sys-svg animateMotion')).length > 0, 'Live: running count, 8 agent cards, data moving in the system view');
  await p.evaluate(() => { osActAdd({ key:'t1', state:'done', text:'Reconciliation checked', end:new Date().toISOString() }); osActAdd({ key:'t2', state:'done', text:'Synced Tally vouchers', end:new Date().toISOString() }); });
  await p.waitForTimeout(400);
  ok(!(await p.evaluate(() => document.getElementById('osLive').classList.contains('on'))) && /just now/.test(await p.textContent('#osLive')), 'idle: top bar says what happened last: ' + await p.textContent('#osLive'));
  ok(/Nothing running this second/.test(await p.textContent('#view-live')), 'Live: nothing running');

  // 6. Voice: "scroll to week by week" on Cash › Overview opens Cash › Forecast first.
  await p.evaluate(() => osGo('cash', 'overview')); await p.waitForTimeout(300);
  const sc = await p.evaluate(() => VX_TOOLS.scroll({ to:'week by week' }));
  ok(sc.ok && await p.evaluate(() => osCur.tab.k === 'forecast'), 'voice scroll to a section on another tab switches tab: ' + JSON.stringify(sc).slice(0, 80));

  // 7. Party page: timeline across apps + thread; comment posts; @Margyn hands the question to Margyn.
  await p.evaluate(() => osGo('parties', 'customers')); await p.waitForTimeout(300);
  await p.click('#view-customers tr[data-open-party="kaveristores"] td'); await p.waitForTimeout(300);
  const dtabs = await p.$$eval('.mg-drawer [data-dtab]', x => x.map(e => e.textContent));
  ok(dtabs.join() === 'Details,Sources,Timeline,Thread', 'party drawer tabs: ' + dtabs);
  await p.click('.mg-drawer [data-dtab="activity"]'); await p.waitForTimeout(150);
  const tl = await p.textContent('.mg-drawer [data-dpanel="activity"]');
  ok(/Invoice INV-00258/.test(tl) && /(Zoho Books|Tally)/.test(tl), 'timeline lists what each app says: ' + tl.slice(0, 90));
  await p.click('.mg-drawer [data-dtab="thread"]'); await p.waitForTimeout(150);
  await p.fill('.mg-drawer [data-os-thread-form] textarea', 'Called them, cheque on Friday');
  await p.click('.mg-drawer [data-os-thread-form] button'); await p.waitForTimeout(400);
  ok(/Called them, cheque on Friday/.test(await p.textContent('.mg-drawer [data-dpanel="thread"]')), 'a comment posts to the thread');
  ok(await p.evaluate(() => osAct.some(a => a.agent === 'team' && /commented on Kaveri Stores/.test(a.text))), 'and shows in the activity feed');
  await p.evaluate(() => { window.__asked = []; const base = mgrAsk; mgrAsk = t => { window.__asked.push(t); }; });
  await p.fill('.mg-drawer [data-os-thread-form] textarea', '@Margyn when did they last pay?');
  await p.click('.mg-drawer [data-os-thread-form] button'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => window.__asked.length === 1 && /^About Kaveri Stores: when did they last pay\?$/.test(window.__asked[0])), '@Margyn hands the question, about this customer, to Margyn');
  await p.keyboard.press('Escape');

  // 8. Before the SQL: comments and assigning say they are off; nothing breaks.
  await p.evaluate(() => { const base = sbClient.from; sbClient.from = t => t === 'record_notes'
      ? new Proxy({}, { get(_, k){ if(k === 'then') return (res) => Promise.resolve({ data:null, error:{ code:'PGRST205', message:"Could not find the table 'public.record_notes' in the schema cache" } }).then(res); return () => sbClient.from('record_notes'); } })
      : base(t); osNotesAt = 0; return osLoadNotes(true); });
  await p.waitForTimeout(300);
  await p.evaluate(() => osGo('work', 'all')); await p.click('[data-os-worktab="waiting"]'); await p.waitForTimeout(300);
  ok(/switches on after a one-time setup step/.test(await p.textContent('#view-work')) && !(await p.$('#view-work [data-os-assign]')), 'pre-SQL: Work says assigning switches on after setup, no Assign menu');
  await p.evaluate(() => osGo('parties', 'customers')); await p.waitForTimeout(200);
  await p.click('#view-customers tr[data-open-party="kaveristores"] td'); await p.waitForTimeout(300);
  await p.click('.mg-drawer [data-dtab="thread"]'); await p.waitForTimeout(150);
  ok(/Comments switch on after a one-time setup step/.test(await p.textContent('.mg-drawer [data-dpanel="thread"]')), 'pre-SQL: the thread says comments are off');
  await p.keyboard.press('Escape');

  // 9. Roles: an approver sees no cash anywhere new; Transactions only shows what they may see.
  await p.evaluate(() => {
    mgMe = { accounts:[{ account_id:'demo', company_name:'Anvaya Home Goods Pvt Ltd', role:'approver', role_label:'Approver', name:'Priya Mehta', permissions:{ view_receivables:true, view_payables:true, approve:true } }] };
    mgActor = { authId:'u2', email:'priya@anvaya.in', accountId:'demo', isOwner:false, role:'approver', roleLabel:'Approver', name:'Priya Mehta', perms:{ view:true, view_receivables:true, view_payables:true, approve:true } };
    mgApplyActor(); osGo('desk');
  });
  await p.waitForTimeout(400);
  const roleRail = await p.$$eval('.os-rail-b', x => x.map(b => b.dataset.osSpace));
  ok(!roleRail.includes('cash') && roleRail.includes('collect') && !roleRail.includes('apps'), 'approver rail: no Cash, no Apps; Collect kept (' + roleRail.join(' ') + ')');
  ok(!(await p.$('#view-home [data-os-ticker="forecast"]')) && !/Cash/.test(await p.$$eval('#view-home .os-wft-k b', x => x.map(e => e.textContent).join())), 'approver Desk: no Cash tile, no Forecast agent');
  await p.evaluate(() => osGo('transactions', 'all')); await p.waitForTimeout(300);
  ok(!(await p.$$eval('#view-transactions tbody td:first-child', x => x.some(e => e.textContent === 'Settlement'))), 'approver Transactions: no settlements (cash)');
  await p.evaluate(() => { mgMe = null; mgActor = null; mgApplyActor(); osGo('desk'); });

  // 10. Phone: bottom bar, no overflow, Margyn sheet.
  const m = await b.newPage({ viewport:{ width:390, height:844 } });
  m.on('pageerror', e => errs.push('phone: ' + e.message));
  await m.goto(B); await m.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });
  await m.evaluate(seedApp); await m.waitForTimeout(1200);
  const bar = await m.evaluate(() => { const r = document.getElementById('osBar').getBoundingClientRect(); return { bottom:Math.round(r.bottom), h:Math.round(r.height), vh:innerHeight }; });
  ok(bar.bottom === bar.vh && bar.h > 40, 'phone: bar sits at the bottom: ' + JSON.stringify(bar));
  const phoneBad = [];
  for(const [s, k] of [['desk', 'desk'], ['work', 'all'], ['collect', 'overview'], ['close', 'overview'], ['plan', 'overview'], ['margyn', 'live'], ['transactions', 'all'], ['rules', 'autonomy']]){
    await m.evaluate(([s, k]) => osGo(s, k), [s, k]); await m.waitForTimeout(250);
    const ov = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if(ov > 0) phoneBad.push(s + '/' + k + ' +' + ov);
  }
  ok(!phoneBad.length, 'phone: no sideways scroll' + (phoneBad.length ? ': ' + phoneBad.join(', ') : ''));
  await m.click('#osBar [data-os-space="work"]'); await m.waitForTimeout(250);
  ok(await m.evaluate(() => osCur.space.key === 'work') && await m.evaluate(() => document.querySelector('#osBar [data-os-space="work"]').classList.contains('on')), 'phone: bar opens Work and lights it');

  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
