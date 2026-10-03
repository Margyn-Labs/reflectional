// The navigator in the browser (app/js/02-shell.js cmdkNav, 25-margyn.js
// mgrNavCommand): ⌘K gets a Jev "Best match" row when keywords are weak, a clear
// question keeps "Ask" on top, customer names never leave the page, and the
// panel opens a page itself only in live mode (shadow logs beside Claude).
// /api/ask-margyn is stubbed with canned Jev answers.
// Usage: node tools/serve-static.js &   then   node tools/ui-nav-test.js [baseUrl]
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
  await p.evaluate(seedApp);
  await p.evaluate(() => {
    window.__nav = []; window.__chat = []; window.__panelMode = 'shadow';
    const JEV = {
      'who owes me money':{ place:'receivables', placeConfidence:0.99, intent:'ask', intentConfidence:0.76 },
      'why did my profit drop in august':{ place:'analytics', placeConfidence:0.84, intent:'ask', intentConfidence:1 },
      'bills i have to pay':{ place:'payables', placeConfidence:0.96, intent:'go', intentConfidence:0.5 },
      'gst kholo':{ place:'gst', placeConfidence:0.95, intent:'go', intentConfidence:1 },
      'open cash':{ place:'cash', placeConfidence:0.93, intent:'go', intentConfidence:1 },
      'mystery words':{ place:'home', placeConfidence:0.4, intent:'ask', intentConfidence:0.9 }
    };
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const J = (o) => new Response(JSON.stringify(o), { status:200, headers:{ 'Content-Type':'application/json' } });
      if(/\/api\/ask-margyn\?action=nav/.test(url)){
        const modes = { nav:'live', panel:window.__panelMode };
        if(!init || !init.body) return J(modes);
        const body = JSON.parse(init.body); window.__nav.push(body);
        const r = JEV[body.q.toLowerCase()] || (/PARTY/.test(body.q) ? { place:'customers', placeConfidence:0.9, intent:'go', intentConfidence:0.9 } : null);
        if(!r) return J({ ...modes, place:null });
        const best = r.placeConfidence >= 0.75 ? r.place : null;
        const go = modes.panel === 'live' && r.intent === 'go' && r.intentConfidence >= 0.85 && r.placeConfidence >= 0.85 ? r.place : null;
        return J({ ...modes, ...r, best, go });
      }
      if(/\/api\/ask-margyn/.test(url)){
        window.__chat.push(JSON.parse(init.body));
        return J({ reply:'Here is your cash.', steps:[] });
      }
      return prev(input, init);
    };
  });
  await p.waitForTimeout(4500);

  const typeK = async (text) => {
    await p.keyboard.press('Meta+k'); await p.waitForTimeout(150);
    await p.fill('#cmdkInput', text); await p.waitForTimeout(900);
    return p.$$eval('#cmdkList .cmdk-item', x => x.map(e => e.textContent.trim()));
  };
  // 1. a weak keyword match gets a Best match row on top; Enter opens it
  let rows = await typeK('who owes me money');
  ok(/^.*Receivables/.test(rows[0]) && await p.textContent('#cmdkList .cmdk-sec') === 'Best match', 'who owes me money: first row is Best match Receivables (' + rows.slice(0, 2).join(' | ') + ')');
  ok(rows.some(r => /^Ask: who owes me money/.test(r)), 'Ask row still there');
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  ok(await p.isVisible('#view-receivables'), 'Enter opened Receivables');

  // 2. a clear question keeps Ask on top, Best match second
  rows = await typeK('why did my profit drop in august');
  ok(/^Ask: why did my profit/.test(rows[0]) && /Reports/.test(rows[1]), 'question: Ask first, Best match second (' + rows.slice(0, 2).join(' | ') + ')');
  await p.keyboard.press('Escape');

  // 3. strong keyword matches never call Jev; unsure Jev adds nothing
  const before = await p.evaluate(() => window.__nav.length);
  rows = await typeK('vendors');
  ok(await p.evaluate(() => window.__nav.length) === before, 'a strong keyword hit ("vendors") never calls Jev');
  await p.keyboard.press('Escape');
  rows = await typeK('mystery words');
  ok(!(await p.$$eval('#cmdkList .cmdk-sec', x => x.map(e => e.textContent))).includes('Best match'), 'unsure Jev adds no row');
  await p.keyboard.press('Escape');

  // 4. customer names are masked before sending
  const party = await p.evaluate(() => mgMoneyGroups('recv')[0].party);
  await typeK('ledger stuff for ' + party);
  await p.keyboard.press('Escape');
  const sent = await p.evaluate(() => window.__nav.map(n => n.q));
  ok(sent.length && !sent.some(q => q.toLowerCase().includes(party.toLowerCase())), 'customer name "' + party + '" never sent: ' + sent[sent.length - 1]);

  // 5. panel, shadow: Claude answers, Jev's pick is logged with what Claude did
  if(!(await p.isVisible('#mgRail'))) await p.evaluate(() => mgrOpen());
  const chat0 = await p.evaluate(() => window.__chat.length);
  await p.fill('#mgrInput', 'open cash'); await p.press('#mgrInput', 'Enter'); await p.waitForTimeout(1500);
  let chats = await p.evaluate(() => window.__chat.length);
  let navs = await p.evaluate(() => window.__nav.filter(n => n.surface === 'panel'));
  ok(chats === chat0 + 1, 'shadow: the message still went to Claude');
  ok(navs.length === 1 && navs[0].claude === 'none', 'shadow: Jev logged beside Claude (' + JSON.stringify(navs[0]) + ')');

  // 6. panel, live: "GST kholo" opens GST with no Claude call; a question still goes to Claude
  await p.evaluate(() => { window.__panelMode = 'live'; mgNavModesP = null; });
  await p.fill('#mgrInput', 'GST kholo'); await p.press('#mgrInput', 'Enter'); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => window.__chat.length) === chats, 'live: no Claude call for "GST kholo"');
  ok(await p.isVisible('#view-gst'), 'live: GST page opened');
  const last = await p.$$eval('#vxFeed .mgr-msg', x => x.slice(-1)[0].textContent);
  ok(/Opening GST and tax\./.test(last), 'live: Margyn says what it opened: ' + last.slice(-40));
  await p.fill('#mgrInput', 'why did my profit drop in august'); await p.press('#mgrInput', 'Enter'); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => window.__chat.length) === chats + 1, 'live: a question still goes to Claude');

  ok(!errs.length, 'no page errors: ' + errs.join(' | '));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
