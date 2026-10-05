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
  ok(spaces.join() === 'margyn,desk,work,cash,collect,pay,tax,close,plan,parties,transactions,documents,reports,apps,rules,team,audit,settings', 'rail: ' + spaces.join(' '));
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
    '#/inbox':'#/work', '#/pulse':'#/plan/pulse', '#/cfo-pack':'#/reports/cfo-pack', '#/payment-gateways':'#/cash/gateways', '#/home':'#/desk', '#/agents':'#/margyn/agents', '#/financing':'#/plan/capital', '#/import':'#/documents/import' };
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
  ok(pr.join() === 'Preferences', 'Settings › Preferences shows its own block, nothing another tab claims: ' + pr);
  ok(await p.evaluate(async () => {
    mgPrefSet('forecast', { collectDelay:25 }); renderSettingsView();
    const had = !!document.getElementById('setPrefFcReset');
    document.getElementById('setPrefFcReset').click();
    return !document.getElementById('setPrefName') && had && !document.getElementById('setPrefFcReset') && !Object.keys(mgPrefGet('forecast', {}) || {}).length;
  }), 'Preferences: no second name field (it is on Business); forecast reset shows only when you set your own, and resets');
  await p.evaluate(() => osGo('collect', 'matching')); await p.waitForTimeout(300);
  ok(await p.evaluate(() => /Matching/.test(document.querySelector('#view-agents .rd-head h1').textContent) && !!document.getElementById('reconReviewCard').offsetParent && !(document.getElementById('agentSuggestCard') || {}).offsetParent), 'Collect › Matching: the reconciliation cards, titled Matching');

  // 5. Live work: top bar, Desk, Live; idle afterwards says what happened last.
  await p.evaluate(() => { osActAdd({ agent:'payments', text:'Reconciling payments against invoices…', state:'running', at:new Date().toISOString(), from:'app', key:'t1' });
    osActAdd({ agent:'books', text:'Syncing Tally vouchers…', state:'running', at:new Date().toISOString(), from:'server', key:'t2' }); osGo('desk'); });
  await p.waitForTimeout(500);
  ok(/Payments/.test(await p.textContent('#osLive')) && await p.evaluate(() => document.getElementById('osLive').classList.contains('on')), 'top bar: what is running right now');
  ok(await p.evaluate(() => document.querySelector('.os-rail-mg').classList.contains('on') && /working/.test(document.querySelector('[data-os-railnow]').textContent)) && (await p.$$('#view-home .os-ag.working')).length === 2, 'rail: Margyn says it is working; Desk: two agents working');
  await p.evaluate(() => osGo('margyn', 'live')); await p.waitForTimeout(500);
  ok(/2 things running/.test(await p.textContent('#view-live')) && (await p.$$('#view-live .os-agc')).length === 0 && (await p.$$('#view-live .os-sys-svg circle animateMotion, #view-live .os-sys-svg animateMotion')).length > 0, 'Live: running count, data moving in the system view, no second list of agents');
  await p.evaluate(() => { osActAdd({ key:'t1', state:'done', text:'Reconciliation checked', end:new Date().toISOString() }); osActAdd({ key:'t2', state:'done', text:'Synced Tally vouchers', end:new Date().toISOString() }); });
  await p.waitForTimeout(400);
  ok(!(await p.evaluate(() => document.getElementById('osLive').classList.contains('on'))) && /just now/.test(await p.textContent('#osLive')), 'idle: top bar says what happened last: ' + await p.textContent('#osLive'));
  ok(/Nothing running this second/.test(await p.textContent('#view-live')), 'Live: nothing running');
  await p.evaluate(() => osGo('margyn', 'agents')); await p.waitForTimeout(900);
  const ag = await p.evaluate(() => ({ cards:document.querySelectorAll('#osAgentGrid .os-agc').length,
    watch:[...document.querySelectorAll('[data-os-ctl="watch"] .agent-card h3')].map(h => h.textContent),
    coll:[...document.querySelectorAll('[data-os-ctl="collections"] .agent-card h3')].map(h => h.textContent),
    pay:[...document.querySelectorAll('[data-os-ctl="payments"] .agent-card h3')].map(h => h.textContent),
    left:document.querySelectorAll('#agentCards > .agent-card').length }));
  ok(ag.cards === 8 && ag.watch.join() === 'WhatsApp Bell,Margyn updates' && ag.coll.join() === 'Payment Chase' && ag.pay.join() === 'Auto-Reconciliation' && ag.left === 0, 'Agents: one list of 8 agents, each with its own switches inside: ' + JSON.stringify(ag));
  await p.evaluate(() => { osActAdd({ agent:'collections', text:'Drafting reminders…', state:'running', at:new Date().toISOString(), from:'app', key:'t3' }); }); await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.querySelectorAll('#osAgentGrid .os-agc').length === 8 && !!document.querySelector('[data-os-ctl="collections"] .agent-card h3')), 'Agents: a live update redraws the cards and keeps the switches');
  await p.evaluate(() => osActAdd({ key:'t3', state:'done', text:'Reminders drafted', end:new Date().toISOString() }));

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

  // 7b. People: a teammate on this customer and typing; my typing goes out on presence; a comment is announced; handoffs.
  await p.evaluate(() => { window.__tracked = []; window.__sent = [];
    osPresence = { track(x){ window.__tracked.push(x); }, send(m){ window.__sent.push(m); } };
    osPresenceState = { 'u-r':[{ id:'u-r', name:'Ravi Shah', where:'Kaveri Stores', rec:'party|kaveristores', typing:'party|kaveristores', at:new Date().toISOString() }] }; });
  await p.click('#view-customers tr[data-open-party="kaveristores"] td'); await p.waitForTimeout(300);
  await p.click('.mg-drawer [data-dtab="thread"]'); await p.waitForTimeout(200);
  await p.evaluate(() => osPaintPresence());
  ok(/Ravi is typing…/.test(await p.textContent('.mg-drawer .os-typing')) && /Ravi is here/.test(await p.textContent('.mg-drawer .os-here')), 'thread: "Ravi is typing…"; header: "Ravi is here"');
  ok(await p.evaluate(() => window.__tracked.some(t => t.rec === 'party|kaveristores' && t.where === 'Kaveri Stores')), 'opening a record tells the team where I am');
  await p.type('.mg-drawer [data-os-thread-form] textarea', 'Checking', { delay:20 }); await p.waitForTimeout(1700);
  ok(await p.evaluate(() => window.__tracked.some(t => t.typing === 'party|kaveristores')), 'my typing goes out on presence');
  await p.click('.mg-drawer [data-os-thread-form] button'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => window.__sent.some(m => m.event === 'note' && m.payload.ref === 'party|kaveristores')), 'a comment is announced to the team at once');
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  await p.evaluate(() => osGo('collect', 'overview')); await p.waitForTimeout(400); await p.evaluate(() => osPaintPresence());
  ok(await p.evaluate(() => !!document.querySelector('[data-os-party$="|kaveristores"] .os-rowhere.typing')), 'Collect: Kaveri Stores row shows Ravi there, typing');
  await p.evaluate(() => { osHandArmAt = 1; osCheckWorkHandoffs();
    agentActions.actions.push({ id:'new1', title:'Book bank charges for September', kind:'journal_entry', amount:1180, confidence:0.9, created_at:new Date().toISOString() });
    osRefreshLive(); });
  await p.waitForTimeout(500);
  const hand = await p.evaluate(() => [...document.querySelectorAll('#toastHost .os-hand')].map(e => e.textContent));
  ok(hand.some(t => /Close agent handed you a decision/.test(t) && /Book bank charges/.test(t)), 'a new decision arrives as a handoff from its agent: ' + hand.join(' / ').slice(0, 120));
  ok(await p.evaluate(() => osAct.some(a => /Handed to you: Book bank charges/.test(a.text))), 'and the handoff is in the activity feed');
  await p.click('#toastHost .os-hand [data-os-go]'); await p.waitForTimeout(400);
  ok(p.url().endsWith('#/close/proposals'), 'Review opens where it is decided: ' + p.url().split('#')[1]);
  await p.evaluate(() => { osNotes.unshift({ id:'n-x', record_type:'work', record_key:'act:new1', kind:'assign', assignee:osMyName(), author_id:'u-r', author_name:'Ravi Shah', body:'Book bank charges for September', created_at:new Date().toISOString() }); osNotesChanged(); });
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => [...document.querySelectorAll('#toastHost .os-hand')].some(e => /Ravi handed you work/.test(e.textContent))), 'a teammate assigning me work arrives as a handoff from them');
  await p.evaluate(() => { agentActions.actions = agentActions.actions.filter(a => a.id !== 'new1'); osNotes = osNotes.filter(n => n.id !== 'n-x'); osPresenceState = {}; osPresence = null;
    document.querySelectorAll('#toastHost .os-hand').forEach(e => e.remove()); });

  // 7c. Write-back: approving queues the change for its app; today it is saved in Margyn and says why; Work › Sent to apps; Apps; Rules.
  await p.evaluate(() => osGo('close', 'proposals')); await p.waitForTimeout(500);
  await p.click('#agentQueueList [data-agent-do="approve"]'); await p.waitForTimeout(1200);
  const tst = await p.evaluate(() => [...document.querySelectorAll('#toastHost .toast')].map(e => e.textContent).join(' / '));
  ok(/Approved and saved in Margyn\. Zoho Books write-back isn’t switched on yet, so make the same change in Zoho Books for now\./.test(tst), 'approve: says plainly it is saved in Margyn, Zoho write-back not on yet: ' + tst.slice(0, 140));
  ok(await p.evaluate(() => osAct.some(a => /Saved for Zoho Books: Record ₹5,92,500 against INV-00266/.test(a.text))), 'and the activity feed records the write for Zoho');
  await p.evaluate(() => { osWorkTab = 'apps'; osGo('work', 'all'); }); await p.waitForTimeout(700);
  const sent = await p.evaluate(() => ({ n:document.querySelectorAll('#view-work table.os-work tbody tr').length, pills:[...document.querySelectorAll('#view-work .mg-pill')].map(e => e.textContent), tab:document.querySelector('[data-os-worktab="apps"]').textContent }));
  ok(sent.n === 3 && sent.pills.every(t => t === 'Saved in Margyn') && /Sent to apps3/.test(sent.tab), 'Work › Sent to apps lists each change with its status: ' + JSON.stringify(sent));
  await p.evaluate(() => { osWB.writes = [{ app:'zoho', action:'record_payment', summary:'x', status:'writing' }, { app:'tally', action:'post_journal', summary:'y', status:'confirmed' }, { app:'odoo', action:'create_bill', summary:'z', status:'failed', status_note:'invoice is void' }]; osRenderWork(); });
  ok(await p.evaluate(() => [...document.querySelectorAll('#view-work .mg-pill')].map(e => e.textContent).join('|')) === 'Writing to Zoho Books|Confirmed in Tally|Odoo refused it', 'the same list shows writing, confirmed and refused once apps are writable');
  await p.evaluate(() => osLoadWrites()); await p.waitForTimeout(400);
  await p.evaluate(() => osGo('apps', 'connected')); await p.waitForTimeout(700);
  const appsW = await p.evaluate(() => ({ head:[...document.querySelectorAll('#connFeedTable th')].map(e => e.textContent).join('|'), zoho:[...document.querySelectorAll('#connFeedTable tr')].find(r => /Zoho Books/.test(r.textContent)).textContent, label:document.getElementById('connFeedTable').closest('.rd-section').querySelector('.rd-section-label').textContent }));
  ok(appsW.head === 'App|Margyn reads|Margyn writes back|Tier' && /Not yet Record a customer payment against its invoice/.test(appsW.zoho) && /reads and writes/.test(appsW.label), 'Apps: what each app feeds Margyn and what Margyn will write back, all "Not yet": ' + appsW.zoho.slice(0, 90));
  await p.evaluate(() => osGo('rules', 'autonomy')); await p.waitForTimeout(400);
  ok(/Every approval is queued for its app/.test(await p.textContent('#view-rules')) && await p.isVisible('#view-rules [data-os-worktab-go="apps"]'), 'Rules: Books says approvals are queued for their app, with a link to what was sent');

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
    const perms = ['view_receivables', 'view_payables', 'approve'];
    mgMe = { ready:true, features:{ audit_actor:true, member_prefs:true, phone_link:true }, me:{ id:'u2' }, own_account:null, memberships:[{ account_id:'demo', company_name:'Anvaya Home Goods Pvt Ltd', role:'approver', role_label:'Approver', name:'Priya Mehta', permissions:perms }] };
    mgActor = { authId:'u2', email:'priya@anvaya.in', accountId:'demo', isOwner:false, role:'approver', roleLabel:'Approver', name:'Priya Mehta', permissions:perms };
    mgApplyActor(); osGo('desk');
  });
  await p.waitForTimeout(400);
  const roleRail = await p.$$eval('.os-rail-b', x => x.map(b => b.dataset.osSpace));
  ok(!roleRail.includes('cash') && roleRail.includes('collect') && !roleRail.includes('apps'), 'approver rail: no Cash, no Apps; Collect kept (' + roleRail.join(' ') + ')');
  ok(!(await p.$('#view-home [data-os-ticker="forecast"]')) && !/Cash/.test(await p.$$eval('#view-home .os-wft-k b', x => x.map(e => e.textContent).join())), 'approver Desk: no Cash tile, no Forecast agent');
  await p.evaluate(() => osGo('transactions', 'all')); await p.waitForTimeout(300);
  ok(!(await p.$$eval('#view-transactions tbody td:first-child', x => x.some(e => e.textContent === 'Settlement'))), 'approver Transactions: no settlements (cash)');
  await p.evaluate(() => { mgMe = null; mgActor = null; mgApplyActor(); osGo('desk'); });

  // 9b. No page repeats another: every section heading is on one tab only, and no tab is blank.
  //     (Allowed: "Margyn on it", the workflow's own agents on each overview, and "Customers", a chase list vs the customer master.)
  const seen = {}, blank = [];
  for(const [s, k] of await p.evaluate(() => OS_SPACES.flatMap(sp => osTabsFor(sp).map(t => [sp.key, t.k])))){
    await p.evaluate(([s, k]) => osGo(s, k), [s, k]); await p.waitForTimeout(350);
    const r = await p.evaluate(() => { const v = [...document.querySelectorAll('[id^=view-]')].find(x => !x.classList.contains('hidden') && x.offsetParent);
      return { text:v ? v.innerText.replace(/\s+/g, ' ').trim().length : 0, heads:v ? [...v.querySelectorAll('h2, h3, .rd-section-label, .ledger-list-title')].filter(h => h.offsetParent).map(h => h.textContent.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\d₹,.()]+/g, '#').slice(0, 40)) : [] }; });
    if(r.text < 60) blank.push(s + '/' + k);
    new Set(r.heads).forEach(h => { (seen[h] = seen[h] || new Set()).add(s + '/' + k); });
  }
  const dup = Object.entries(seen).filter(([h, v]) => v.size > 1 && !['margyn on it', 'customers'].includes(h)).map(([h, v]) => h + ' @ ' + [...v].join(', '));
  ok(!dup.length, 'no section shows on two tabs' + (dup.length ? ': ' + dup.join(' | ') : ''));
  ok(!blank.length, 'no tab is blank' + (blank.length ? ': ' + blank.join(', ') : ''));
  await p.evaluate(() => osGo('desk'));

  // 10. Phone: bottom bar, no overflow, Margyn sheet.
  const m = await b.newPage({ viewport:{ width:390, height:844 } });
  m.on('pageerror', e => errs.push('phone: ' + e.message));
  await m.goto(B); await m.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });
  await m.evaluate(seedApp); await m.waitForTimeout(1200);
  const bar = await m.evaluate(() => { const r = document.getElementById('osBar').getBoundingClientRect(); return { bottom:Math.round(r.bottom), h:Math.round(r.height), vh:innerHeight }; });
  ok(bar.bottom === bar.vh && bar.h > 40, 'phone: bar sits at the bottom: ' + JSON.stringify(bar));
  const phoneBad = [];
  for(const [s, k] of await m.evaluate(() => OS_SPACES.flatMap(sp => osTabsFor(sp).map(t => [sp.key, t.k])))){   // every tab
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
