// App frame interaction test (Phase 1): router + deep links + Back, Scope bar
// sources/period, Import/Ask/user menu, org entities, dialogs replacing
// confirm() (cancel sends nothing, confirm sends once, consent needs a tick),
// Zoho callback hash, phone drawer, no overflow, no page errors.
// Usage: node tools/serve-static.js &   then   node tools/ui-frame-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const boot = async (hash) => { await p.goto('about:blank'); await p.goto(B + (hash || '')); await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 }); await p.waitForTimeout(500); await p.evaluate(seedApp); await p.waitForTimeout(700); };
  const vis = () => p.evaluate(() => [...document.querySelectorAll('[id^="view-"]')].filter(v => !v.classList.contains('hidden') && v.parentElement.classList.contains('wrap')).map(v => v.id));

  // 1. deep link: URL opens that page with that source, after login data load
  await boot('#/ledger?src=tally');
  ok(JSON.stringify(await vis()) === '["view-books"]', 'deep link #/ledger?src=tally opens Ledger: ' + await vis());
  ok(await p.evaluate(() => booksActiveSource) === 'tally', 'deep link sets Books source to Tally');
  ok((await p.textContent('#mgSrcVal')) === 'Tally', 'Scope bar Sources shows Tally');
  ok(/Tally/.test(await p.textContent('#view-books .mg-scopeline')), 'page scope line says Tally');

  // 2. rail click updates URL, back button returns
  await p.click('.pagenav button[data-view="payments"]'); await p.waitForTimeout(300);
  ok(p.url().endsWith('#/cash'), 'rail click Cash -> #/cash (' + p.url().split('#')[1] + ')');
  await p.goBack(); await p.waitForTimeout(400);
  ok(JSON.stringify(await vis()) === '["view-books"]' && p.url().includes('#/ledger?src=tally'), 'Back returns to Ledger/Tally');

  // 3. Scope bar source switch on Payments drives the page's own tabs
  await p.click('.pagenav button[data-view="payments"]'); await p.waitForTimeout(300);
  await p.click('#mgSrcBtn'); await p.waitForTimeout(150);
  ok(await p.isVisible('#mgSrcPop'), 'Sources menu opens');
  const opts = await p.$$eval('#mgSrcPop [data-mg-src]', x => x.map(e => e.dataset.mgSrc));
  ok(opts.join() === 'all,razorpay,cashfree', 'Payments sources listed: ' + opts);
  await p.click('#mgSrcPop [data-mg-src="razorpay"]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => paymentsActiveSource) === 'razorpay', 'picking Razorpay sets paymentsActiveSource');
  ok(p.url().endsWith('#/cash?src=razorpay'), 'URL carries src=razorpay');
  ok(!(await p.isVisible('#mgSrcPop')), 'menu closes after choice');

  // 4. Home: reconciled only, Sources menu explains and lists source health
  await p.click('.pagenav button[data-view="home"]'); await p.waitForTimeout(300);
  ok((await p.textContent('#mgSrcVal')) === 'Reconciled' && p.url().endsWith('#/home'), 'Home: Reconciled, URL #/home');
  ok(JSON.stringify(await vis()) === '["view-home"]', 'Home page shown');
  ok((await p.$$('#view-home .mg-tile')).length === 5, 'Home has 5 KPI tiles');
  ok(/₹[\d.]+ (Cr|L)/.test(await p.textContent('#view-home .mg-tile-v')), 'tiles use lakh/crore: ' + await p.textContent('#view-home .mg-tile-v'));
  ok((await p.$$('#view-home .mg-row3 .mg-li')).length > 0, 'Home: Needs your decision / Sources disagree have rows');
  await p.evaluate(() => showView('summary')); await p.waitForTimeout(200);
  ok(JSON.stringify(await vis()) === '["view-home"]', 'old showView(summary) callers land on Home');

  // 4b. Receivables: modes, sources, aging, mark received, export
  await p.click('.pagenav button[data-view="receivables"]'); await p.waitForTimeout(300);
  ok(p.url().endsWith('#/receivables') && (await p.$$('#view-receivables .mg-aging button')).length === 4, 'Receivables: reconciled with 4 aging buckets');
  await p.click('#view-receivables [data-money-mode="compare"]'); await p.waitForTimeout(200);
  ok(p.url().endsWith('#/receivables?src=compare') && (await p.textContent('#mgSrcVal')) === 'Compare', 'Compare mode: URL + Scope bar');
  const heads = await p.$$eval('#view-receivables thead th', x => x.map(e => e.textContent));
  ok(heads.includes('Zoho Books (₹)') && heads.includes('Tally (₹)') && heads.includes('Difference (₹)'), 'Compare columns per source: ' + heads.join(' | '));
  ok(/Conflict/.test(await p.textContent('#view-receivables tbody')), 'Compare shows a conflict');
  await p.click('#mgSrcBtn'); await p.click('#mgSrcPop [data-mg-src="tally"]'); await p.waitForTimeout(250);
  ok(p.url().endsWith('#/receivables?src=tally') && /Tally only/.test(await p.textContent('#view-receivables tfoot')), 'Scope bar picks Tally: By source, Tally-only total');
  await p.click('#view-receivables [data-money-mode="reconciled"]'); await p.waitForTimeout(200);
  await p.click('#view-receivables [data-money-age="b3"]'); await p.waitForTimeout(200);
  ok((await p.$$('#view-receivables tbody tr')).length >= 1 && /Age 90\+ days/.test(await p.textContent('#view-receivables .mg-toolbar')), 'aging bucket filters the grid');
  await p.click('#view-receivables [data-money-age=""]'); await p.waitForTimeout(150);
  await p.click('#view-receivables [data-money-mode="bysource"]'); await p.click('#view-receivables [data-money-src="manual"]'); await p.waitForTimeout(200);
  let settleCalls = 0; await p.exposeFunction('__settle', () => { settleCalls++; });
  await p.evaluate(() => { const f = ledgerSettleReceivable; ledgerSettleReceivable = async r => { window.__settle(); }; });
  await p.evaluate(() => document.querySelector('#view-receivables [data-money-settle]').click()); await p.waitForTimeout(200);
  ok(await p.isVisible('.mg-dialog') && await p.isDisabled('.mg-dlg-ok'), 'Mark received asks first, needs the tick');
  await p.check('.mg-dlg-tick'); await p.click('.mg-dlg-ok'); await p.waitForTimeout(200);
  ok(settleCalls === 1, 'confirming marks it received once');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout:3000 }).catch(() => null), p.click('#mgExport-receivables')]);
  ok(!!dl && /receivables-.*\.csv$/.test(dl.suggestedFilename()), 'Export downloads a CSV' + (dl ? ': ' + dl.suggestedFilename() : ''));

  // 4c. Customers -> row opens Receivables filtered; GST; Audit; Inbox vs Agents
  await p.click('.pagenav button[data-view="customers"]'); await p.waitForTimeout(250);
  await p.click('#view-customers tr[data-party="Kaveri Stores"]'); await p.waitForTimeout(250);
  ok(p.url().includes('#/receivables') && (await p.inputValue('#view-receivables [data-money-q]')) === 'Kaveri Stores' && (await p.$$('#view-receivables tbody tr')).length === 1, 'customer row opens their receivables');
  await p.fill('#view-receivables [data-money-q]', ''); await p.waitForTimeout(150);
  await p.click('.pagenav button[data-view="gst"]'); await p.waitForTimeout(250);
  ok(/Rathi Textiles/.test(await p.textContent('#view-gst')), 'GST page lists at-risk vendors');
  await p.click('.pagenav button[data-view="audit"]'); await p.waitForTimeout(300);
  ok((await p.$$('#view-audit tbody tr')).length === 3, 'Audit log shows ledger events');
  await p.click('.pagenav button[data-view="inbox"]'); await p.waitForTimeout(300);
  ok(p.url().endsWith('#/inbox') && !(await p.isVisible('#agentTabs')) && await p.evaluate(() => agentsActiveTab) === 'queue', 'Inbox = the queue, no tab bar');
  await p.click('.pagenav button[data-view="agents"]'); await p.waitForTimeout(300);
  ok(p.url().endsWith('#/agents') && await p.evaluate(() => agentsActiveTab) === 'roster' && !(await p.isVisible('#agentTabs [data-atab="queue"]')), 'Agents = roster, queue tab hidden');
  ok(await p.evaluate(() => new Set([...document.querySelectorAll('.sidebar .pagenav button')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().left))).size) === 1, 'rail is a single column');

  // 5. Period on Reports
  await p.click('.pagenav button[data-view="analytics"]'); await p.waitForTimeout(300);
  ok(!(await p.isDisabled('#mgPerBtn')), 'Reports: Period enabled');
  await p.click('#mgPerBtn'); await p.click('#mgPerPop [data-mg-range="1y"]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => analyticsRange) === '1y' && p.url().endsWith('#/reports?period=1y'), 'Period Last year -> analyticsRange 1y, URL period=1y');
  ok((await p.textContent('#mgPerVal')) === 'Last year', 'Period label Last year');

  // 6. Import / Ask / user menu
  await p.click('#mgImportBtn'); await p.waitForTimeout(250);
  ok(JSON.stringify(await vis()) === '["view-calculate"]' && p.url().endsWith('#/import'), 'Import button opens the upload page');
  await p.click('#mgAskBtn'); await p.waitForTimeout(250);
  ok(JSON.stringify(await vis()) === '["view-history"]', 'Ask button opens Ask Margyn');
  await p.click('#topAvatar'); await p.waitForTimeout(150);
  ok(await p.isVisible('#mgUserPop') && await p.isVisible('#logoutBtn'), 'user menu opens with Log out');
  ok((await p.textContent('#mgUserName')) === 'Aditi Kulkarni', 'user menu names the primary person');
  await p.click('#mgUserPop [data-go="profile"]'); await p.waitForTimeout(250);
  ok(JSON.stringify(await vis()) === '["view-profile"]' && !(await p.isVisible('#mgUserPop')), 'Profile from user menu, menu closes');
  await p.keyboard.press('Escape');

  // 7. Org menu lists entities from connected books
  await p.click('#orgSwitchBtn'); await p.waitForTimeout(150);
  ok(await p.isVisible('#orgSwitchMenu'), 'org menu is visible when opened');
  const ents = await p.$$eval('#mgOrgEntities .mg-ent', x => x.map(e => e.textContent));
  ok(ents.length === 2 && /Exports/.test(ents.join('|')), 'org menu lists 2 entities: ' + ents.join(' | '));
  await p.keyboard.press('Escape');

  // 8. Dialog replaces confirm(): Zoho disconnect, cancel path makes no request
  let apiCalls = [];
  await p.evaluate(() => { window.__calls = []; const f = window.fetch; window.fetch = (u, o) => { window.__calls.push(String(u)); return f(u, o); }; });
  await p.evaluate(() => { disconnectZoho(); });
  await p.waitForTimeout(150);
  ok(await p.isVisible('.mg-dialog') && /Disconnect Zoho Books/.test(await p.textContent('.mg-dialog h3')), 'Zoho disconnect shows a dialog');
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  apiCalls = await p.evaluate(() => window.__calls.filter(u => u.includes('disconnect')));
  ok(!(await p.isVisible('.mg-dialog')) && apiCalls.length === 0, 'Escape cancels, no disconnect request sent');
  await p.evaluate(() => { disconnectZoho(); }); await p.waitForTimeout(150);
  await p.click('.mg-dlg-ok'); await p.waitForTimeout(300);
  apiCalls = await p.evaluate(() => window.__calls.filter(u => u.includes('disconnect')));
  ok(apiCalls.length === 1, 'Confirm sends exactly one disconnect request: ' + apiCalls);

  // 9. Consent dialog needs the tick
  await p.evaluate(() => { const s = agentStakeholders.find(x => x.id === 'd'); s.bell_consent_at = null; peopleTogglePerm('d', 'opening_bell'); });
  await p.waitForTimeout(200);
  const hasTick = await p.isVisible('.mg-dlg-tick');
  ok(hasTick && await p.isDisabled('.mg-dlg-ok'), 'Bell consent dialog: button disabled until ticked');
  if(hasTick){ await p.check('.mg-dlg-tick'); ok(!(await p.isDisabled('.mg-dlg-ok')), 'ticking enables the button'); await p.click('.mg-dlg-cancel'); }

  // 10. Zoho callback hash is left alone
  await boot('#zoho=select-org&org_ref=abc');
  ok(!/#\/home/.test(p.url()) || !p.url().includes('zoho='), 'Zoho callback hash not overwritten before it is handled (' + p.url().split('#')[1] + ')');

  // 11. Phone drawer
  const m = await b.newPage({ viewport:{ width:390, height:844 } });
  m.on('pageerror', e => errs.push('mobile: ' + e.message));
  await m.goto(B); await m.waitForTimeout(700); await m.evaluate(seedApp); await m.waitForTimeout(600);
  ok(!(await m.isVisible('.sidebar .pagenav button[data-view="books"]')) || (await m.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0)), 'phone: rail hidden by default');
  await m.click('#mgMenuBtn'); await m.waitForTimeout(300);
  ok(await m.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0), 'phone: menu opens the rail');
  await m.click('.sidebar .pagenav button[data-view="books"]'); await m.waitForTimeout(300);
  ok(await m.evaluate(() => !document.body.classList.contains('mg-rail-open')) && m.url().includes('#/ledger'), 'phone: picking a page closes the rail');
  await m.click('#mgScopeCompactBtn'); await m.waitForTimeout(150);
  ok(await m.isVisible('#mgScopeCompactPop') && await m.isVisible('#mgScopeCompactPop [data-mg-src="tally"]'), 'phone: scope chip menu is visible and offers Books sources');
  ok(await m.evaluate(() => document.documentElement.scrollWidth - innerWidth) === 0, 'phone: no horizontal overflow');

  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await b.close(); process.exit(fails ? 1 : 0);
})();
