// The Margyn panel follows through (2026-10-03): a message sent while Margyn is
// still answering is kept and answered next (it used to be dropped with a
// "still answering" toast), a long answer checks in while it works, and when it
// lands while you're looking elsewhere a note by the Margyn button says so.
// Usage: node tools/serve-static.js &   then   node tools/ui-followthrough-test.js [baseUrl]
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
  await p.evaluate(() => { localStorage.setItem('mg.lastSeen.demo', new Date(Date.now() - 5 * 60000).toISOString()); localStorage.removeItem('mg.panel'); });
  await p.evaluate(seedApp);
  // Slow chat API: each answer takes `__delay` ms and echoes the question.
  await p.evaluate(() => {
    window.__asked = []; window.__delay = 2500;
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if(/\/api\/ask-margyn(\?|$)/.test(url) && !/action=/.test(url)){
        const body = JSON.parse(init.body);
        window.__asked.push(body.message);
        await new Promise(r => setTimeout(r, window.__delay));
        return new Response(JSON.stringify({ reply:'Answer to: ' + body.message, steps:[] }), { status:200, headers:{ 'Content-Type':'application/json' } });
      }
      return prev(input, init);
    };
  });
  await p.waitForTimeout(3000);

  // 1. two messages back to back: the second is queued, then answered, in order
  await p.evaluate(() => mgrOpen()); await p.waitForTimeout(200);   // Margyn OS: the panel opens when asked, not on load
  await p.fill('#mgrInput', 'First question'); await p.press('#mgrInput', 'Enter');
  await p.waitForTimeout(300);
  await p.fill('#mgrInput', 'Second question'); await p.press('#mgrInput', 'Enter');
  await p.waitForTimeout(300);
  ok(await p.$('#vxFeed .mgr-msg.me.queued'), 'second message shows as queued ("Next up"), not dropped');
  await p.waitForTimeout(6500);
  const asked = await p.evaluate(() => window.__asked);
  ok(asked.length === 2 && asked[0] === 'First question' && asked[1] === 'Second question', 'both asked, in order: ' + JSON.stringify(asked));
  const feed = await p.textContent('#vxFeed');
  ok(feed.indexOf('Answer to: First question') >= 0 && feed.indexOf('Answer to: Second question') > feed.indexOf('Answer to: First question'), 'both answered, in order');
  ok(!(await p.$('#vxFeed .mgr-msg.me.queued')), 'queued marker cleared once it is being answered');

  // 2. a long answer checks in while it works
  await p.evaluate(() => { window.__delay = 6000; });
  await p.fill('#mgrInput', 'Slow question'); await p.press('#mgrInput', 'Enter');
  await p.waitForTimeout(4800);
  ok(/Still on it/.test(await p.textContent('#vxFeed .mgr-msg.working')), 'says "Still on it" after a few seconds');
  // 3. look away (close the panel) before it lands: a note says it's done
  await p.evaluate(() => mgrClose(true));
  await p.waitForTimeout(2500);
  const bub = await p.isVisible('#mgrBubble') ? await p.textContent('#mgrBubble') : '';
  ok(/Done\. Answer to: Slow question/.test(bub), 'closed panel: bubble says it is done: ' + bub.slice(0, 60));
  await p.click('#mgrBubble [data-n="0"]');
  ok(await p.isVisible('#mgRail'), '"Show me" opens the panel on the answer');
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
