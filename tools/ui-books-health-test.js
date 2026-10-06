// Books health check (19k-books-health.js): the panel on Organisations and sources, Ignore / Bring back,
// "Send to my accountant" (shows the list, opens WhatsApp only on a press, never sends), and Home's "Needs you".
// The payload is what GET /api/tally?action=books-check returns (api/tally.js handleBooksCheck), built from
// the real booksHealth.check() on the Care Hygiene-shaped test book.
// Usage: node tools/serve-static.js . 5199 &   then   node tools/ui-books-health-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5199/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };

// The real findings, through the real code (no hand-written items).
function payload() {
  const { book, NOW } = require('../api/_lib/__tests__/booksHealthFixture');
  const E = require('../api/_lib/booksEngine'), H = require('../api/_lib/booksHealth');
  const items = H.merge([], H.check(E.prepare(book, { now: NOW }))).map((x) => Object.assign({}, x, { first_seen: '2026-10-05T02:00:00Z' }));
  return { connected: true, ready: true, checked_at: '2026-10-07T02:00:00Z', company: 'Care Hygiene Products', source: 'Tally',
    counts: { open: items.length }, groups: H.GROUP_TITLE, items,
    accountant_text: H.accountantText(items, { company: 'Care Hygiene Products', max: 3000, now: NOW }), accountant_text_full: H.accountantText(items, { company: 'Care Hygiene Products', perKind: 100, now: NOW }) };
}

(async () => {
  const P = payload();
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B); await p.waitForTimeout(600);
  await p.evaluate(seedApp); await p.waitForTimeout(900);
  // The books check endpoint, on top of the seed's canned API.
  await p.evaluate((P) => {
    window.__bh = { P, calls: [] };
    const seedFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if(/action=books-check-set/.test(url)){
        const body = JSON.parse(init.body); window.__bh.calls.push(body);
        const x = window.__bh.P.items.find(i => i.key === body.key); if(x) x.status = body.status;
        return new Response(JSON.stringify(body), { status:200, headers:{ 'Content-Type':'application/json' } });
      }
      if(/action=books-check/.test(url)){ window.__bh.calls.push(url); return new Response(JSON.stringify(window.__bh.P), { status:200, headers:{ 'Content-Type':'application/json' } }); }
      return seedFetch(input, init);
    };
    window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };
    tallyConnected = true;
  }, P);

  // 1. Organisations and sources: the panel, above "Is all your data in?"
  await p.evaluate(() => { mgBH = null; showView('connectors'); }); await p.waitForTimeout(700);
  const order = await p.evaluate(() => { const a = document.getElementById('mgBooksHealth'), c = document.getElementById('mgDataCheck'); return !!(a && c && (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)); });
  ok(order, 'the books check sits on Organisations and sources, above “Is all your data in?”');
  const txt = await p.textContent('#mgBooksHealth');
  ok(/Books health check/.test(txt) && /Checked every morning/.test(txt), 'it says it is checked every morning');
  ok(/Cash in hand shows/.test(txt) && /Interest on your overdraft or loan is filed as income/.test(txt) && /September 2026’s running costs look unbooked/.test(txt), 'the single findings show with their titles: ' + txt.slice(0, 200));
  ok(/Customer bills still open but already paid/.test(txt) || /S\.S\.D Surgical/.test(txt), 'customer findings are listed');
  ok(/For your accountant:/.test(txt) && /Move the ledger “INTEREST ON OD”/.test(txt), 'each shows what the accountant should do');
  const badges = await p.$$eval('#mgBooksHealth .mg-bdg', els => els.map(e => e.textContent));
  ok(badges[0] === 'Fix first', 'cash below zero leads, marked Fix first: ' + badges.slice(0, 4).join(','));
  ok(!/\b(bucket|ctx|tally_|asOfToday|undefined|NaN|null)\b/.test(txt), 'no internal words or blanks on the panel');

  // 2. Ignore: one press, it moves to Ignored and the server is told; Bring back reverses it.
  await p.click('#mgBooksHealth [data-bh-set][data-to="ignored"]'); await p.waitForTimeout(500);
  const ign = await p.evaluate(() => window.__bh.calls.find(c => c && c.status === 'ignored'));
  ok(ign && ign.key, 'Ignore tells the server which item (POST books-check-set): ' + JSON.stringify(ign));
  ok(/Ignored \(1\)/.test(await p.textContent('#mgBooksHealth')), 'the item moves under Ignored (1)');
  await p.waitForTimeout(800);   // the panel re-reads after a change
  await p.evaluate(() => document.querySelector('#mgBooksHealth details[data-bh-sec="ignored"] > summary').click()); await p.waitForTimeout(200);
  ok(await p.evaluate(() => mgBHOpenSecs.has('ignored') && document.querySelector('#mgBooksHealth details[data-bh-sec="ignored"]').open), 'an opened section stays open when the panel redraws');
  await p.click('#mgBooksHealth [data-bh-set][data-to="open"]', { timeout:5000 }); await p.waitForTimeout(500);
  ok(await p.evaluate(() => window.__bh.calls.some(c => c && c.status === 'open')) && !/Ignored \(/.test(await p.textContent('#mgBooksHealth')), 'Bring back puts it on the list again');

  // 3. Send to my accountant: shows the list; nothing goes out until "Open in WhatsApp" is pressed.
  await p.click('#mgBooksHealth [data-bh-send]'); await p.waitForTimeout(300);
  const dlg = await p.evaluate(() => { const d = document.querySelector('.mg-dialog-scrim .mg-dialog'); return d && { title:d.querySelector('h3').textContent, text:d.querySelector('textarea').value, note:d.querySelector('p').textContent }; });
  ok(dlg && dlg.title === 'Send to my accountant' && /won’t send it by itself/.test(dlg.note), 'the dialog says Margyn won’t send it by itself');
  ok(dlg && /^Books check for Care Hygiene Products/.test(dlg.text) && /Sanjay Plastics/.test(dlg.text) && /To decide with the owner/.test(dlg.text), 'it shows the clean list, grouped');
  ok(await p.evaluate(() => window.__opened.length === 0), 'nothing opened or sent yet');
  await p.screenshot({ path:'/tmp/books-health-send.png' }).catch(() => {});
  await p.click('.mg-dialog [data-bh-wa]'); await p.waitForTimeout(200);
  const opened = await p.evaluate(() => window.__opened[0] || '');
  ok(/^https:\/\/wa\.me\/\?text=/.test(opened) && decodeURIComponent(opened.split('text=')[1]).startsWith('Books check for Care Hygiene Products') && opened.length < 12000, 'Open in WhatsApp opens a share link with the list (the person picks the chat and presses send)');
  ok(!(await p.$('.mg-dialog-scrim')), 'and the dialog closes');

  // 4. Home: "Needs you" says how many things need the accountant, with Show them / Send to accountant.
  // A Tally-only account (Care Hygiene) has no approvals, so "Needs you" has room for six lines to look at.
  await p.evaluate(() => { window.mgDecisions = () => []; showView('home'); }); await p.waitForTimeout(500);
  const need = await p.evaluate(() => [...document.querySelectorAll('.mgd-look')].map(e => e.textContent).find(t => /need your accountant/.test(t)) || '');
  ok(/things in your books need your accountant, starting with: Cash in hand shows/.test(need) && /Show them/.test(need) && /Send to accountant/.test(need), 'Home “Needs you” lists the books check: ' + need.slice(0, 160));
  await p.evaluate(() => { const i = mgdLook.findIndex(n => /^bh:/.test(n.key)); document.querySelector('[data-mgd-look="' + i + ':0"]').click(); }); await p.waitForTimeout(500);
  ok(await p.evaluate(() => mgCurrentView === 'connectors'), 'Show them opens the books check');
  await p.screenshot({ path:'/tmp/books-health-panel.png', fullPage:false }).catch(() => {});

  // 5. Nothing open: says so, no send button.
  await p.evaluate(() => { window.__bh.P = Object.assign({}, window.__bh.P, { items:window.__bh.P.items.map(x => Object.assign({}, x, { status:'fixed', fixed_at:'2026-10-07T02:00:00Z' })), accountant_text:null, accountant_text_full:null }); mgBH = null; mgRenderBooksHealth(); });
  await p.waitForTimeout(500);
  const clean = await p.textContent('#mgBooksHealth');
  ok(/Nothing to fix in your books right now/.test(clean) && !(await p.$('#mgBooksHealth [data-bh-send]')) && /Fixed in the last 30 days/.test(clean), 'all fixed: says nothing to fix, lists what was fixed, no send button');

  // 6. What's new has the release, with a button to the check.
  ok(await p.evaluate(() => MG_RELEASES[0].id === '2026-10-07-books-health' && MG_RELEASES[0].items.every(i => i.act === 'bookshealth') && !!MG_WN_ACTS.bookshealth), 'What’s new: the release is first and opens the books check');

  ok(!errs.length, 'no page errors: ' + errs.join(' | '));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
