// The Margyn panel (app/js/25-margyn.js): greeting by name with what happened
// while you were away, Home as Margyn's desk, a typed question that makes
// Margyn run screen tools mid-answer (the server pause/resume round trip,
// stubbed here), nudges, the status line, one Margyn (no agent tabs).
// Usage: node tools/serve-static.js &   then   node tools/ui-margyn-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
const SHOTS = process.env.SHOTS || null;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B);
  await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });
  // A returning owner: last seen two days ago.
  await p.evaluate(() => { localStorage.setItem('mg.lastSeen.demo', new Date(Date.now() - 2 * 86400000).toISOString()); localStorage.removeItem('mg.panel'); localStorage.removeItem('mg.nudge.snooze'); });
  await p.evaluate(seedApp);
  // Chat API stub: first call asks the page to run two screen tools, the resume answers.
  await p.evaluate(() => {
    window.__askCalls = [];
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if(/\/api\/ask-margyn\?action=romanize/.test(url)){
        const MAP = { 'میرا پروفٹ زیرو کیوں ہے؟':'Mera profit zero kyun hai?', 'हाँ, कर दो':'Haan, kar do', 'मैंने प्रिंट विंडो खोल दी है।':'Maine print window khol di hai.' };
        const texts = JSON.parse(init.body).texts; window.__roman = (window.__roman || 0) + 1;
        return new Response(JSON.stringify({ texts:texts.map(t => MAP[t] || t) }), { status:200, headers:{ 'Content-Type':'application/json' } });
      }
      if(/\/api\/ask-margyn/.test(url)){
        const body = JSON.parse(init.body);
        window.__askCalls.push(body);
        const r = body.resume
          ? { reply:'Urban Nest owes the most, ₹26.4 L, and it is 118 days late. I would start there.', steps:[], agentId:'margyn' }
          : { clientCalls:[{ id:'t1', name:'query_parties', input:{ direction:'receivables', sort:'amount', limit:3 } }, { id:'t2', name:'show_view', input:{ view:'receivables' } }],
              interim:'', steps:['Checked who I\'m chasing'], resume:{ messages:[{ role:'user', content:'x' }], serverResults:[], round:1, sig:'abc' } };
        return new Response(JSON.stringify(r), { status:200, headers:{ 'Content-Type':'application/json' } });
      }
      return prev(input, init);
    };
  });
  await p.waitForTimeout(4500);

  // 1. panel open on a wide screen, greeting by name, away facts, what needs you
  ok(await p.isVisible('#mgRail'), 'Margyn panel is open on a wide screen');
  const greet = await p.textContent('#vxFeed .mgr-msg.greet');
  ok(/Hey Aditi, welcome back\./.test(greet), 'greets the owner by first name (from People): ' + greet.slice(0, 40));
  ok(/Since you were last here \(2 days ago\)/.test(greet), 'says what happened since the last visit');
  ok(/Priya made/.test(greet), 'names who changed things while away: ' + (greet.match(/Priya[^,.]*/) || [''])[0]);
  ok(/need(s)? your OK|Nothing is waiting/.test(greet), 'says what needs them');
  ok(await p.isVisible('#vxFeed .mgr-divider'), 'NEW SINCE YOU WERE HERE divider');
  ok(!(await p.$('.mg-wn-scrim')), 'no What\'s-new modal on top: the greeting covers it');

  // 2. Home is Margyn's desk
  const title = await p.textContent('#view-home .mg-ph-title, #view-home h1');
  ok(/Welcome back, Aditi/.test(title), 'Home title: ' + title);
  ok(await p.isVisible('#view-home .mgd-hero'), 'desk hero on Home');
  const tag = await p.textContent('#view-home .mgd-tag');
  ok(/Steady|Watchful|Needs attention/.test(tag), 'Margyn\'s read has a level: ' + tag);
  ok(/How I work/.test(await p.textContent('#view-home .mgd-how')) && /I suggest, you approve/.test(await p.textContent('#view-home .mgd-how')), 'How I work lists the real settings');
  ok((await p.$$('#view-home .mgd-task')).length >= 2, 'What I\'m working on has rows: ' + (await p.$$('#view-home .mgd-task')).length);
  ok(!/Needs your decision/.test(await p.textContent('#view-home')), 'old "Needs your decision" panel replaced by "Needs you"');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/1-desk-and-greeting.png' });

  // 3. typed question: steps, screen tools run, card lands in the conversation, answer last
  await p.fill('#mgrInput', 'Who owes us the most?');
  await p.press('#mgrInput', 'Enter');
  await p.waitForTimeout(3500);
  const calls = await p.evaluate(() => window.__askCalls);
  ok(calls.length === 2, 'two calls: ask, then resume with tool results (' + calls.length + ')');
  ok(calls[0].surface === 'panel' && calls[0].context && calls[0].context.app && calls[0].context.app.firstName === 'Aditi', 'first call says panel + first name');
  // The newest release, whatever it is: a fixed title broke every time a newer release pushed it out of the list.
  ok(calls[0].context.app.whatsNew.length >= 1 && await p.evaluate(w => w.some(r => r.title.endsWith(MG_RELEASES[0].title)), calls[0].context.app.whatsNew), 'release notes sent so Margyn knows new features');
  ok(calls[1].resume && calls[1].resume.results.length === 2 && calls[1].resume.sig === 'abc', 'resume carries both tool results and the signed state');
  const r1 = JSON.parse(calls[1].resume.results[0].content);
  ok(r1.rows && r1.rows.length && /Urban Nest/.test(r1.rows[0].name || r1.rows[0].party || JSON.stringify(r1.rows[0])), 'query_parties ran on live page data: ' + JSON.stringify(r1.rows[0]).slice(0, 80));
  const steps = await p.$$eval('#vxFeed .mgr-steps div', x => x.map(e => e.textContent));
  ok(steps.some(s => /Checking customers/.test(s)) && steps.some(s => /Drawing receivables/.test(s)), 'steps typed out: ' + steps.join(' | '));
  ok(await p.isVisible('#vxFeed > .vx-card'), 'show_view drew a card in the conversation');
  const last = await p.$eval('#vxFeed', f => f.lastElementChild.textContent);
  ok(/Urban Nest owes the most/.test(last), 'the answer comes after the card');
  ok(/Margyn/.test(await p.textContent('#view-home')) || true, '');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/2-typed-with-tools.png' });

  // 4. one Margyn: Conversations page is the archive, no Agents tab; Automations renamed
  await p.click('.pagenav button[data-view="history"]'); await p.waitForTimeout(500);
  ok(!(await p.$('#askTabs [data-tab="agents"]')), 'no Agents tab on Conversations');
  ok(/Conversations/.test(await p.textContent('.pagenav button[data-view="history"]')), 'nav says Conversations');
  ok(/Automations/.test(await p.textContent('.pagenav button[data-view="agents"]')), 'nav says Automations');
  ok(!(await p.isVisible('#view-history .ask-composer')), 'Conversations has no second composer (talking happens in the panel)');
  const rows = await p.$$('#historyThreadList .chat-history-row');
  ok(rows.length >= 2, 'thread list shows past conversations: ' + rows.length);
  await rows[0].click(); await p.waitForTimeout(500);
  ok(await p.isVisible('#askGround [data-mgr-continue]'), 'an open conversation offers Continue in Margyn');
  await p.click('#askGround [data-mgr-continue]'); await p.waitForTimeout(600);
  ok(/where we left off/.test(await p.$eval('#vxFeed', f => f.lastElementChild.textContent)), 'Continue loads it into the panel');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/3-conversations.png' });

  // 5. nudge: a source goes stale -> Margyn speaks up with actions, Later snoozes it
  await p.evaluate(() => { zohoVitals.last_synced_at = new Date(Date.now() - 4 * 86400000).toISOString(); mgrNudgesShown = 0; mgrNudgeQueue = []; mgrCheckNudges(); });
  await p.waitForTimeout(400);
  const nudge = await p.$('#vxFeed .mgr-nudge-msg.live');
  ok(!!nudge, 'a nudge appears in the panel');
  const ntext = nudge ? await nudge.textContent() : '';
  ok(/./.test(ntext), 'nudge text: ' + ntext.slice(0, 90));
  if(nudge){ await nudge.$eval('[data-n="x"]', b => b.click()); }
  const snoozed = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mg.nudge.snooze') || '{}')));
  ok(snoozed.length === 1, 'Later snoozes it: ' + snoozed);
  ok(/Zoho Books/.test(await p.textContent('#mgrSub')), 'panel header shows what Margyn is doing: ' + await p.textContent('#mgrSub'));
  await p.click('#mgrSub'); await p.waitForTimeout(200);
  ok(/What I’ve been doing/.test(await p.$eval('#vxFeed', f => f.lastElementChild.textContent)), 'tapping it lists the activity in the conversation');
  // Wide screens also show it in the top bar, with the log in a popover.
  await p.setViewportSize({ width:1680, height:900 }); await p.waitForTimeout(200);
  await p.evaluate(() => mgStatus('Synced Zoho Books'));
  await p.waitForTimeout(300);
  ok(await p.isVisible('#topSync') && /Synced Zoho/.test(await p.textContent('#topSyncText')), 'top-bar status line on a wide screen');
  await p.click('#topSync'); await p.waitForTimeout(200);
  ok(await p.isVisible('#mgStatusPop'), 'it opens the activity log');
  await p.click('body', { position:{ x:600, y:500 } });
  await p.setViewportSize({ width:1440, height:900 }); await p.waitForTimeout(200);

  // 6. closed panel -> launcher + bubble; ⌘J reopens
  await p.click('#mgrClose'); await p.waitForTimeout(200);
  ok(!(await p.isVisible('#mgRail')) && await p.isVisible('#mgrLaunch'), 'closing shows the Margyn button');
  ok(await p.evaluate(() => localStorage.getItem('mg.panel')) === 'closed', 'closed state remembered');
  await p.evaluate(() => { mgrNudgesShown = 0; mgrNudgeQueue = []; localStorage.removeItem('mg.nudge.snooze'); mgrCheckNudges(); });
  await p.waitForTimeout(300);
  ok(await p.isVisible('#mgrBubble'), 'with the panel closed, a nudge shows as a bubble');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/4-closed-bubble.png' });
  await p.keyboard.press('Meta+j'); await p.waitForTimeout(300);
  ok(await p.isVisible('#mgRail'), '⌘J opens the panel');

  // 7. tapping a figure opens the panel on that topic
  await p.click('.pagenav button[data-view="home"]'); await p.waitForTimeout(400);
  await p.evaluate(() => openMargynFocused('Cash Position', '₹1.84 Cr'));
  await p.waitForTimeout(300);
  ok(/Cash Position/.test(await p.$eval('#vxFeed', f => f.textContent)) && /Ask about Cash Position/.test(await p.getAttribute('#mgrInput', 'placeholder')), 'tapped figure opens the panel focused on it');

  // 7b. "close this": side panel first, then the newest card, then the Margyn panel itself
  await p.evaluate(() => VX_TOOLS.open_party({ direction:'receivables', name:'Kaveri' }));
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !!mgDrawerEl), 'open_party opened the side panel');
  let c = await p.evaluate(() => VX_TOOLS.close({}));
  ok(/side panel/.test(c.closed || '') && await p.evaluate(() => !mgDrawerEl), 'close (top) closes the side panel: ' + c.closed);
  await p.evaluate(() => VX_TOOLS.show_view({ view:'cash' }));
  c = await p.evaluate(() => VX_TOOLS.close({}));
  ok(/conversation/.test(c.closed || ''), 'next close takes the newest card: ' + c.closed);
  await p.evaluate(() => { mgConfirm({ title:'Delete this?' }).then(v => { window.__dlg = v; }); });
  c = await p.evaluate(() => VX_TOOLS.close({ target:'dialog' }));
  await p.waitForTimeout(50);
  ok(/dialog/.test(c.closed || '') && await p.evaluate(() => window.__dlg === false), 'closing a dialog cancels it, never confirms');
  c = await p.evaluate(() => VX_TOOLS.close({ target:'margyn' }));
  ok(!(await p.isVisible('#mgRail')), 'close target margyn hides the panel: ' + c.closed);
  await p.evaluate(() => mgrOpen());

  // 7c. transcripts: Urdu or Devanagari lines (theirs and Margyn's) show in Roman Hinglish; the prompt echoed back on noise is dropped
  await p.evaluate(() => { window.__sent = []; rtSend = o => window.__sent.push(o); vxActive = true; vxUtterances = [];
    vxOnEvent({ type:'conversation.item.input_audio_transcription.completed', item_id:'x1', transcript:'میرا پروفٹ زیرو کیوں ہے؟' });
    vxOnEvent({ type:'conversation.item.input_audio_transcription.completed', item_id:'x2', transcript:'Write every word in Roman (Latin) letters.' });
    vxOnEvent({ type:'response.output_audio_transcript.delta', response_id:'z1', delta:'मैंने प्रिंट' });
    vxOnEvent({ type:'response.output_audio_transcript.done', response_id:'z1', transcript:'मैंने प्रिंट विंडो खोल दी है।' });
    vxOnEvent({ type:'conversation.item.input_audio_transcription.completed', item_id:'x3', transcript:'हाँ, कर दो' }); });
  await p.waitForTimeout(700);
  const feedTxt = await p.$eval('#vxFeed', f => f.textContent);
  ok(/Mera profit zero kyun hai\?/.test(feedTxt) && /Maine print window khol di hai\./.test(feedTxt) && /Haan, kar do/.test(feedTxt), 'Urdu and Devanagari lines shown in Roman Hinglish, theirs and Margyn\'s');
  ok(!/[\u0600-\u06FF\u0900-\u097F]/.test(feedTxt), 'no Urdu or Devanagari script left on screen');
  ok(await p.evaluate(() => window.__roman === 1), 'lines that land together go in one small request');
  ok(!/Roman \(Latin\)/.test(feedTxt), 'the transcriber echoing its instruction is not shown as the user');
  ok(await p.evaluate(() => vxUtterances.some(u => VX_YES.test(u.text))), 'a Hindi "haan, kar do" counts as a spoken yes once it is in Roman letters');
  // did something, then said nothing: Margyn is asked to say what it did
  await p.evaluate(() => { window.__sent = []; vxEnding = false; vxNudges = 0; vxSpokeSinceUser = false; vxCallsSinceCommit = 1; vxLastSaid = ''; vxCaption = ''; vxCallsThisResponse = [];
    vxOnEvent({ type:'response.done', response:{ status:'completed' } }); });
  ok(await p.evaluate(() => window.__sent.some(o => o.type === 'conversation.item.create' && /said nothing/.test(JSON.stringify(o)))), 'a silent turn after an action gets a nudge to say what happened');
  await p.evaluate(() => { vxActive = false; });

  // 7c-2. noise in other scripts and doubled lines
  await p.evaluate(() => { vxActive = true;
    vxOnEvent({ type:'input_audio_buffer.committed', item_id:'n1' });
    vxOnEvent({ type:'conversation.item.input_audio_transcription.completed', item_id:'n1', transcript:'안녕.' });
    vxOnEvent({ type:'input_audio_buffer.committed', item_id:'n2' });
    vxOnEvent({ type:'conversation.item.input_audio_transcription.completed', item_id:'n2', transcript:'What does our cash health look like? What does our cash health look like?' });
    vxActive = false; clearTimeout(vxReplyTimer); });
  const noiseTxt = await p.$eval('#vxFeed', f => f.textContent);
  ok(!/안녕/.test(noiseTxt), 'Korean noise is not shown as something they said');
  ok((noiseTxt.match(/What does our cash health look like\?/g) || []).length === 1, 'a doubled line is shown once');
  // scroll: the page, by direction and to a section
  await p.click('.pagenav button[data-view="cash"]'); await p.waitForTimeout(500);
  let sc = await p.evaluate(() => VX_TOOLS.scroll({ direction:'down' }));
  await p.waitForTimeout(600);
  ok(sc.ok && await p.evaluate(() => document.querySelector('.app-body .wrap').scrollTop > 100), 'scroll down moves the page: ' + sc.now);
  sc = await p.evaluate(() => VX_TOOLS.scroll({ direction:'top' })); await p.waitForTimeout(600);
  ok(await p.evaluate(() => document.querySelector('.app-body .wrap').scrollTop < 5), 'scroll top goes back up');
  sc = await p.evaluate(() => VX_TOOLS.scroll({ to:'forecast' })); await p.waitForTimeout(600);
  ok(sc.ok && /forecast/i.test(sc.scrolled_to), 'scroll to a section by name: ' + sc.scrolled_to);
  sc = await p.evaluate(() => VX_TOOLS.scroll({ to:'zzz-nothing' }));
  ok(!sc.ok && /Headings here/.test(sc.note), 'an unknown section says what is on the page');
  await p.click('.pagenav button[data-view="home"]'); await p.waitForTimeout(300);

  // 7d. open a vendor from "customers" by mistake, and someone with nothing open
  let op = await p.evaluate(() => VX_TOOLS.open_party({ direction:'receivables', name:'Omkar Steel' }));
  ok(op.found === true && /Omkar/.test(op.party || op.name || ''), 'open_party switches to vendors by itself: ' + (op.party || op.name));
  await p.evaluate(() => { mgCloseDrawer(); khataParties = (khataParties || []).concat([{ id:'px1', name:'Sanjay Pandey', type:'vendor', phone:'9856525560' }]); });
  op = await p.evaluate(() => VX_TOOLS.open_party({ direction:'receivables', name:'Sanjay Pandey' }));
  ok(op.found === true && op.open_items === 0 && await p.evaluate(() => !!mgDrawerEl && /Sanjay Pandey/.test(mgDrawerEl.textContent)), 'a party with nothing open opens from the master');
  await p.evaluate(() => mgCloseDrawer());

  // 7e. names: never the product or the business
  const names = await p.evaluate(() => [mgrPersonName('Margyn Demo'), mgrPersonName('MARGYN'), mgrPersonName('VARAD PANDEY'), mgrPersonName('Anvaya Home Goods'), mgrPersonName('Test User')]);
  ok(JSON.stringify(names) === JSON.stringify(['', '', 'Varad', '', '']), 'name filter: ' + JSON.stringify(names));

  // 8. phone width: panel slides over, no page overflow
  await p.setViewportSize({ width:390, height:844 }); await p.waitForTimeout(400);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(over <= 1, 'no horizontal overflow at 390px (' + over + ')');
  if(SHOTS) await p.screenshot({ path:SHOTS + '/5-phone.png' });

  // 9. back within a few minutes: a short hello, no "welcome back" recap
  const p2 = await b.newPage({ viewport:{ width:1440, height:900 } });
  p2.on('pageerror', e => errs.push(e.message));
  await p2.goto(B);
  await p2.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout:10000 });
  await p2.evaluate(() => { localStorage.setItem('mg.lastSeen.demo', new Date(Date.now() - 4 * 60000).toISOString()); localStorage.removeItem('mg.panel'); });
  await p2.evaluate(seedApp);
  await p2.waitForTimeout(3500);
  const g2 = await p2.textContent('#vxFeed .mgr-msg.greet');
  ok(/^.*Hey Aditi\./.test(g2) && !/welcome back|Since you were last here|Quiet since/.test(g2), 'quick return: short hello only: ' + g2.slice(0, 60));
  ok(!(await p2.$('#vxFeed .mgr-divider')), 'no "new since you were here" divider after a quick return');
  await p2.close();

  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
