// Live work, team and app writes (27-live-work.js, 28-live-team.js, 29-live-writes.js),
// added to the live pages: Home's "What I'm working on" shows running work and
// what was just done; who is online, who has a customer open and who is typing;
// a Timeline and Comments on every customer and supplier; an owner on every
// Inbox item; handoff cards; approvals queued for the apps they belong in;
// and everything quiet before 2026-10-06-team-and-app-writes.sql has run.
// Usage: node tools/serve-static.js &   then   node tools/ui-live-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  // 1. A call to /api is shown, named by its job, while it runs (before the seed replaces fetch).
  await p.route('**/api/zoho?action=sync*', async r => { await new Promise(x => setTimeout(x, 400)); r.fulfill({ status:200, contentType:'application/json', body:'{}' }); });
  await p.goto(B); await p.waitForTimeout(600);
  const run = await p.evaluate(async () => { const f = fetch('/api/zoho?action=sync'); const during = lwAct.filter(a => a.state === 'running').map(a => a.text); await f; await new Promise(r => setTimeout(r, 1700)); return { during, after:lwAct[0] && lwAct[0].text, state:lwAct[0] && lwAct[0].state }; });
  ok(run.during.includes('Syncing Zoho Books…') && run.after === 'Synced Zoho Books' && run.state === 'done', 'an /api call shows while it runs, then as done: ' + JSON.stringify(run));

  await p.evaluate(seedApp); await p.waitForTimeout(900);

  // 2. Home: running now, then just done; Margyn's panel header says what is running.
  await p.evaluate(() => showView('home')); await p.waitForTimeout(300);
  ok(!!(await p.$('#view-home #lwWorking .mgd-task')), 'Home keeps its "What I’m working on" rows');
  await p.evaluate(() => { if(!mgrIsOpen()) mgrOpen(); lwAdd({ key:'t1', job:'books', text:'Syncing Tally vouchers…', state:'running', at:new Date().toISOString() }); });
  await p.waitForTimeout(300);
  ok(/Syncing Tally vouchers/.test(await p.textContent('#lwWorking .lw-now')) && /1 running now/.test(await p.evaluate(() => document.getElementById('lwWorking').closest('.mg-panel').querySelector('.mg-aside').textContent)), 'Home: running work leads the panel, the panel says 1 running now');
  ok(/Syncing Tally vouchers/.test(await p.textContent('#mgrSub')), 'Margyn’s panel header says what is running: ' + await p.textContent('#mgrSub'));
  await p.evaluate(() => lwAdd({ key:'t1', state:'done', text:'Synced Tally vouchers · 1,240 rows', end:new Date().toISOString() })); await p.waitForTimeout(300);
  ok(!(await p.$('#lwWorking .lw-now')) && /Synced Tally vouchers · 1,240 rows/.test(await p.textContent('#lwWorking .lw-done')) && /just now/.test(await p.textContent('#lwWorking .lw-done')), 'done: it moves to Just done, with the time');
  ok(await p.textContent('#mgrSub') === 'Your finance operator', 'the panel header goes back to normal');
  await p.screenshot({ path:'/tmp/live-home.png' }).catch(() => {});

  // 3. Presence: faces in the top bar; the drawer says who is here and who is typing.
  const party = await p.evaluate(() => { const g = mgMoneyGroups('recv')[0]; return { key:g.key, name:g.party }; });
  await p.evaluate(pt => { window.__presence = { 'u-priya':[{ id:'u-priya', name:'Priya Mehta', where:'Receivables', rec:'party|' + pt.key, typing:'party|' + pt.key, at:new Date().toISOString() }] }; window.__channel.handlers['presence:sync'](); }, party);
  await p.waitForTimeout(200);
  ok(await p.isVisible('#ltFaces') && /PM/.test(await p.textContent('#ltFaces')) && /Priya Mehta · Receivables/.test(await p.getAttribute('#ltFaces', 'title')), 'top bar: who else is in the app, and where');
  ok(await p.evaluate(() => window.__tracked && window.__tracked.where === 'Home'), 'you are announced with the page you are on');
  ok(await p.evaluate(() => /^team-/.test(window.__channel.name) && window.__channel.opts.config.private === true), 'presence is a private channel per account (only its people may join)');
  await p.evaluate(pt => mgOpenParty('recv', pt.key), party); await p.waitForTimeout(300);
  const tabs = await p.$$eval('.mg-drawer [data-dtab]', x => x.map(e => e.textContent));
  ok(tabs.join() === 'Details,Sources,Timeline,Comments', 'customer drawer: Details, Sources, Timeline, Comments: ' + tabs);
  ok((await p.$$('.mg-drawer [data-dpanel="activity"] .lt-tl li')).length > 0, 'Timeline lists what happened across apps');
  ok(/Priya is here too/.test(await p.textContent('.mg-drawer .lt-here')), 'the drawer says who else has it open');
  ok(await p.evaluate(pt => window.__tracked && window.__tracked.rec === 'party|' + pt.key && window.__tracked.where === pt.name, party), 'opening it tells the team you are on ' + party.name);
  await p.click('.mg-drawer [data-dtab="comments"]'); await p.waitForTimeout(100);
  ok(/Priya is typing/.test(await p.textContent('.mg-drawer .lt-typing')) && await p.isVisible('.mg-drawer .lt-typing'), 'the thread says who is typing');

  // 4. Comments: post one; it shows, the team is told at once, typing clears.
  await p.fill('.mg-drawer .lt-thread-f textarea', 'Called them, cheque on Friday');
  await p.waitForTimeout(1700);
  ok(await p.evaluate(pt => window.__tracked.typing === 'party|' + pt.key, party), 'typing is announced to the team');
  await p.click('.mg-drawer .lt-thread-f button'); await p.waitForTimeout(400);
  ok(/Called them, cheque on Friday/.test(await p.textContent('.mg-drawer [data-dpanel="comments"]')), 'your comment shows in the thread');
  ok(await p.evaluate(() => window.__sent.some(m => m.event === 'note')), 'teammates are told at once (broadcast)');
  ok(await p.evaluate(() => !window.__tracked.typing), 'posting clears your typing');
  await p.evaluate(() => mgCloseDrawer());

  // 5. Inbox: an owner on every item (you have a team); handing one over.
  await p.evaluate(() => showView('inbox')); await p.waitForTimeout(600);
  const owners = await p.$$eval('#agentPanel-queue .lt-owner select', x => x.length);
  const items = await p.evaluate(() => ltInboxItems().length);
  ok(owners === items && owners > 0, 'Inbox: every item has an owner menu (' + owners + ' of ' + items + ')');
  const key = await p.getAttribute('#agentPanel-queue .lt-owner select', 'data-lt-assign');
  await p.selectOption('[data-lt-assign="' + key + '"]', 'Priya Mehta'); await p.waitForTimeout(400);
  ok(await p.evaluate(k => ltOwnerOf(k), key) === 'Priya Mehta' && /Priya Mehta/.test(await p.textContent('[data-lt-assign="' + key + '"] option')), 'handing it to Priya sets the owner');
  ok(await p.evaluate(() => [...document.querySelectorAll('#toastHost .toast')].some(t => /Handed to Priya/.test(t.textContent))), 'a message says it was handed over');

  // 6. Handoffs: a new item lands in the Inbox; a teammate hands you something; a teammate comments.
  await p.evaluate(() => { ltArmAt = Date.now() - 1; reconSummary.review_queue.push({ id:'rq-new', customer_name:'Kaveri Stores', reason:'Paid ₹19.6 L in two parts', invoice_number:'INV-00301', amount:1960000, candidates:[] }); renderReconLedger(); });
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => [...document.querySelectorAll('#toastHost .lt-hand')].some(t => /Margyn handed you a decision/.test(t.textContent) && /Kaveri Stores/.test(t.textContent))), 'new Inbox item: "Margyn handed you a decision"');
  ok(await p.evaluate(() => !!document.querySelector('[data-work-key="rq:rq-new"].lt-fresh')), 'the new item is highlighted in the Inbox');
  await p.evaluate(pt => { ltNotes.unshift({ id:'n-a', record_type:'work', record_key:'act:x', kind:'assign', assignee:ltMyName(), body:'Book TDS short-payment on INV-00288', author_id:'u-priya', author_name:'Priya Mehta', created_at:new Date().toISOString() },
    { id:'n-c', record_type:'party', record_key:pt.key, kind:'comment', body:'They want a statement first', author_id:'u-priya', author_name:'Priya Mehta', created_at:new Date().toISOString() }); ltNotesChanged(); }, party);
  await p.waitForTimeout(200);
  const hands = await p.$$eval('#toastHost .lt-hand', x => x.map(e => e.textContent).join(' | '));
  ok(/Priya handed you something/.test(hands) && /Priya commented on/.test(hands), 'teammate handoffs and comments show as cards: ' + hands.slice(0, 160));

  // 7. Approvals to apps: the message after approving, Sent to your apps, reads and writes per app.
  const line = await p.evaluate(() => [lxApprovalLine({ writes:{ writes:[{ app:'zoho', status:'waiting_access' }] } }, 'x'), lxApprovalLine({ writes:{ off:true, writes:[] } }, 'Approved — recorded for your books.'), lxApprovalLine({ writes:{ writes:[{ app:'tally', status:'writing' }] } }, 'x')]);
  ok(/saved in Margyn.*Zoho Books isn’t switched on yet/.test(line[0]) && line[1] === 'Approved — recorded for your books.' && /Writing it to Tally/.test(line[2]), 'approval message says what happened in each app, and nothing new before the setup step: ' + line[0]);
  await p.evaluate(() => { lxWB = { setup:true, writes:[{ id:'w1', app:'zoho', action:'record_payment', summary:'Record ₹11,85,000 against INV-00266', status:'waiting_access', status_note:'Zoho Books write access is not switched on', approved_by_name:'Arjun Kapoor', created_at:new Date().toISOString() }],
    caps:[{ app:'zoho', writes:[{ action:'record_payment', label:'Record a customer payment', on:false }] }] }; lxPaintInbox(); });
  ok(await p.isVisible('#lxSentCard') && /Saved in Margyn/.test(await p.textContent('#lxSentCard')) && /Approved by Arjun Kapoor/.test(await p.textContent('#lxSentCard')), 'Inbox: Sent to your apps shows each change and its state');
  await p.evaluate(() => showView('connectors')); await p.waitForTimeout(500);
  ok(/Writes back/.test(await p.textContent('#connFeedTable')) && /Not yet/.test(await p.textContent('#connFeedTable')) && /Record a customer payment/.test(await p.textContent('#connFeedTable')), 'Sources: what Margyn reads and writes back, per app');

  // 8. Before the SQL: comments say they are off; no owner menus; nothing sent shows.
  await p.evaluate(() => { const base = sbClient.from; sbClient.from = t => t === 'record_notes' ? { select(){ return this; }, eq(){ return this; }, order(){ return this; }, limit(){ return Promise.resolve({ data:null, error:{ code:'PGRST205', message:"Could not find the table 'public.record_notes' in the schema cache" } }); } } : base(t); });
  await p.evaluate(() => ltLoadNotes(true)); await p.waitForTimeout(200);
  await p.evaluate(pt => mgOpenParty('recv', pt.key), party); await p.waitForTimeout(200);
  ok(/Comments switch on after a one-time setup step/.test(await p.textContent('.mg-drawer [data-dpanel="comments"]')), 'pre-SQL: Comments say they switch on after setup');
  await p.evaluate(() => { mgCloseDrawer(); lxWB = { setup:false, writes:[], caps:[] }; showView('inbox'); }); await p.waitForTimeout(400);
  ok(!(await p.$('#agentPanel-queue .lt-owner')) && !(await p.isVisible('#lxSentCard')), 'pre-SQL: no owner menus, no Sent to your apps');

  // 9. Just you (no team): nobody to hand things to.
  await p.evaluate(() => { ltNotesOff = false; ltTeamNames = ['Arjun Kapoor']; document.querySelectorAll('.lt-owner').forEach(x => x.remove()); ltDecorateInbox(); });
  ok(!(await p.$('#agentPanel-queue .lt-owner')), 'without a team, no owner menus');

  // 10. Nobody else online: no faces.
  await p.evaluate(() => { window.__presence = {}; window.__channel.handlers['presence:sync'](); }); await p.waitForTimeout(100);
  ok(!(await p.isVisible('#ltFaces')), 'nobody else online: no faces in the top bar');

  // 11. Phone: no sideways scroll on Home with the new pieces.
  const m = await b.newPage({ viewport:{ width:390, height:844 } }); m.on('pageerror', e => errs.push('mobile: ' + e.message));
  await m.goto(B); await m.waitForTimeout(600); await m.evaluate(seedApp); await m.waitForTimeout(600);
  await m.evaluate(() => { showView('home'); lwAdd({ job:'books', text:'Syncing Tally vouchers…', state:'running', at:new Date().toISOString() }); }); await m.waitForTimeout(300);
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no sideways scroll');

  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
