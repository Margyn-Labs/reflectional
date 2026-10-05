// The learned 13-week forecast on screen (19a-forecast.js on forecast_v2 from api/_lib/cashFlowModel.js):
// range band, "How Margyn built this", week-by-week history, the Adjust switch to "My own assumptions",
// and Margyn's explain tool. The forecast is built by the real model from a made-up business.
// Usage: node tools/serve-static.js &   then   node tools/ui-forecast-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const E = require('../api/_lib/booksEngine');
const CF = require('../api/_lib/cashFlowModel');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };

// A made-up business: Alpha pays in ~30 days, Beta ~60, salary on the 1st, rent on the 5th, EMIs entered ahead.
function learned() {
  const DAY = 86400000, D = (s) => Date.parse(s + 'T00:00:00Z'), iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const V = []; let g = 0; const MOVE = {};
  const v = (type, date, party, entries) => { V.push({ tally_guid: 'g' + (++g), voucher_type: type, date, party_name: party, amount: Math.abs(entries[0].amount), is_cancelled: false, entries }); for (const e of entries) MOVE[e.ledger] = (MOVE[e.ledger] || 0) + e.amount; };
  const today = D('2026-10-04');
  for (let t = D('2026-04-01'); t < today; t += DAY) {
    const d = new Date(t), dow = d.getUTCDay(), dom = d.getUTCDate(), ds = iso(t);
    if (dow === 1) { v('Sales', ds, 'Alpha Traders', [{ ledger: 'Alpha Traders', amount: -354000, is_party: true }, { ledger: 'Sales', amount: 354000 }]); if (t + 30 * DAY < today) v('Receipt', iso(t + 30 * DAY), 'Alpha Traders', [{ ledger: 'Alpha Traders', amount: 354000, is_party: true }, { ledger: 'Bank', amount: -354000 }]); }
    if (dow === 3) { v('Sales', ds, 'Beta Stores', [{ ledger: 'Beta Stores', amount: -236000, is_party: true }, { ledger: 'Sales', amount: 236000 }]); if (t + 60 * DAY < today) v('Receipt', iso(t + 60 * DAY), 'Beta Stores', [{ ledger: 'Beta Stores', amount: 236000, is_party: true }, { ledger: 'Bank', amount: -236000 }]); }
    if (dow === 2) v('Purchase', ds, 'Supplier', [{ ledger: 'Supplier', amount: 250000, is_party: true }, { ledger: 'Purchases', amount: -250000 }]);
    if (dow === 5) v('Payment', ds, 'Supplier', [{ ledger: 'Supplier', amount: -240000, is_party: true }, { ledger: 'Bank', amount: 240000 }]);
    if (dom === 1) v('Payment', ds, null, [{ ledger: 'Salary', amount: -400000 }, { ledger: 'Bank', amount: 400000 }]);
    if (dom === 5) v('Payment', ds, null, [{ ledger: 'Rent', amount: -100000 }, { ledger: 'Bank', amount: 100000 }]);
  }
  for (const m of ['2026-10-10', '2026-11-10', '2026-12-10']) v('Payment', m, null, [{ ledger: 'Kotak Loan', amount: -50000 }, { ledger: 'Bank', amount: 50000 }]);
  V.sort((a, b) => (a.date < b.date ? -1 : 1));
  const G = { Bank: 'Bank Accounts', 'Alpha Traders': 'Sundry Debtors', 'Beta Stores': 'Sundry Debtors', Supplier: 'Sundry Creditors', Sales: 'Sales Accounts', Purchases: 'Purchase Accounts', Salary: 'Indirect Expenses', Rent: 'Indirect Expenses', 'Kotak Loan': 'Secured Loans' };
  const OPEN = { Bank: -2000000, 'Kotak Loan': 1000000 };
  const ledgers = Object.keys(G).map((name) => ({ name, parent: G[name], opening_balance: OPEN[name] || 0, closing_balance: (OPEN[name] || 0) + (MOVE[name] || 0) }));
  const ctx = E.prepare({ connected: true, ledgers, vouchers: V, bills: [], overrides: {}, syncRuns: [] }, { now: new Date('2026-10-04T06:00:00Z') });
  return CF.build(ctx, { promises: [] });
}

(async () => {
  const fv = learned();
  ok(fv && fv.weeks.length === 13 && fv.self_check.checks.length >= 8, 'model built a learned forecast to show (' + (fv && fv.self_check.checks.length) + ' self-check runs)');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B);
  await p.waitForFunction(() => sbClient && document.getElementById('authGate') && !document.getElementById('authGate').classList.contains('hidden'), null, { timeout: 10000 });
  await p.evaluate(seedApp); await p.waitForTimeout(4500);
  await p.evaluate((f) => { mgMar = Object.assign({}, mgMar || {}, { forecast_v2: f }); mgMarAt = Date.now(); mgMarCompany = ''; osGo('cash', 'forecast'); }, fv);   // the forecast lives on Cash › Forecast
  await p.waitForTimeout(600);

  // 1. Cash page: learned forecast with its range
  const cash = await p.evaluate(() => {
    const h = document.getElementById('view-cash'), f = mgForecast();
    return { learned: !!(f && f.learned), aside: (h.querySelector('.mg-panel-h .mg-aside') || {}).textContent || '', text: h.innerText,
      band: !!h.querySelector('svg[aria-label="13-week cash forecast"] path[opacity=".13"]'), tips: h.querySelectorAll('svg[aria-label="13-week cash forecast"] title').length,
      cols: [...h.querySelectorAll('#mgFcTable thead th')].map(t => t.textContent), close12: f && f.close[12], low12: f && f.low[12], high12: f && f.high[12] };
  });
  ok(cash.learned && /Learned from your books/.test(cash.text), 'Cash page forecast is learned from the books');
  ok(cash.band && cash.tips === 13, 'chart shows the range band and a hover value for each week');
  ok(cash.low12 <= cash.close12 && cash.close12 <= cash.high12, 'week 13: cautious ≤ likely ≤ hopeful');
  ok(cash.cols.includes('Cautious (₹)') && cash.cols.includes('Hopeful (₹)'), 'week-by-week table has cautious and hopeful columns');
  ok(/Checked on your last \d+ weeks: money from customers was within \d+% on average/.test(cash.text), 'the track-record line is on the forecast');
  ok(/Lowest point in 13 weeks[\s\S]*Learned from your books/.test(cash.text), 'Lowest-point tile says where it comes from');

  // 2. How Margyn built this
  const how = await p.evaluate(() => {
    const h = document.getElementById('mgFcHow'); if(!h) return null;
    const rows = id => [...h.querySelectorAll('#' + id + ' tbody tr')].map(r => r.innerText);
    return { track: rows('mgFcTrack'), cust: rows('mgFcCust'), rec: rows('mgFcRec'), ahead: rows('mgFcAhead'), pace: rows('mgFcPace'), text: h.innerText };
  });
  ok(how && how.track.length === fv.self_check.checks.length, 'track record lists every past-week check (' + (how && how.track.length) + ')');
  ok(how && how.cust.some(r => /Alpha Traders/.test(r) && /30 days/.test(r)) && how.cust.some(r => /Beta Stores/.test(r) && /60 days/.test(r)), 'customers with how they pay (Alpha 30 days, Beta 60)');
  ok(how && how.rec.some(r => /Salary/.test(r)) && how.rec.some(r => /Rent/.test(r)), 'monthly payments: salary and rent');
  ok(how && how.ahead.length === 3 && how.ahead.every(r => /Kotak Loan/.test(r)), 'EMIs entered for later dates listed');
  ok(how && how.pace.length >= 2 && /New sales/.test(how.pace[0]), 'weekly pace listed');
  ok(how && /before loans, overdraft and transfers/.test(cash.text), 'says cash is before loans and overdraft');

  // 3. Week by week this year
  const hist = await p.evaluate(() => { const h = document.getElementById('mgFcHist'); return h ? { n: h.querySelectorAll('.mg-histmini').length, text: h.innerText, paths: h.querySelectorAll('path').length } : null; });
  ok(hist && hist.n === 4 && hist.paths === 4, 'four small history charts (cash, customers owe, you owe, days to collect)');
  ok(hist && /Days to collect/.test(hist.text) && /\d+ days/.test(hist.text), 'days to collect shown');

  // 4. Margyn OS: Desk -> Cash tile -> Cash › Forecast, where "How Margyn built this" scrolls to the panel
  await p.evaluate(() => osGo('desk')); await p.waitForTimeout(400);
  await p.click('#view-home .os-wft[data-os-go="cash/overview"]'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => mgCurrentView === 'cash' && osCur.tab.k === 'overview'), 'Desk Cash tile opens Cash');
  await p.click('[data-os-tab="cash/forecast"]'); await p.waitForTimeout(400);
  const fcLink = await p.isVisible('#view-cash [data-fc-how]');
  ok(fcLink, 'Cash › Forecast offers "How Margyn built this"');
  if(fcLink){ await p.click('#view-cash [data-fc-how]'); await p.waitForTimeout(600); }
  ok(await p.evaluate(() => mgCurrentView === 'cash' && osCur.tab.k === 'forecast' && !!document.getElementById('mgFcHow') && !!document.getElementById('mgFcHow').offsetParent), 'the link shows the explanation on Cash › Forecast');

  // 5. Adjust: switch to my own assumptions and back
  await p.click('#view-cash [data-fc-adjust]'); await p.waitForTimeout(300);
  const dr = await p.evaluate(() => ({ learnedOn: !!document.querySelector('input[data-fc="mode"][value="learned"]:checked'), manualHidden: document.querySelector('[data-fc-manual]').hidden }));
  ok(dr.learnedOn && dr.manualHidden, 'Adjust opens on "Learned from your books", own figures hidden');
  await p.click('input[data-fc="mode"][value="manual"]'); await p.waitForTimeout(400);
  const man = await p.evaluate(() => ({ shown: !document.querySelector('[data-fc-manual]').hidden, learned: mgForecast().learned, band: !!document.querySelector('#view-cash svg[aria-label="13-week cash forecast"] path[opacity=".13"]'),
    text: document.getElementById('view-cash').innerText, saved: mgPrefGet('forecast', {}).mode }));
  ok(man.shown && !man.learned && man.saved === 'manual', 'switching to "My own assumptions" shows the figures and saves the choice');
  ok(!man.band && /Change the assumptions/.test(man.text) && /Assumes customers pay 15 days/.test(man.text), 'the forecast follows your own assumptions (no band)');
  await p.click('input[data-fc="mode"][value="learned"]'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => mgForecast().learned), 'and back to learned');
  await p.evaluate(() => mgCloseDrawer());

  // 6. Margyn explains it
  const ex = await p.evaluate(async () => JSON.parse(JSON.stringify(await VX_TOOLS.explain({ figure: 'cash forecast' }))));
  ok(ex.found && /Kaplan-Meier/.test(ex.formula) && /Learned from the books/.test(ex.how_it_is_made || '') && /Checked on your last/.test(ex.track_record || ''), 'explain: learned formula, how it was made, track record');
  ok(JSON.stringify(ex).length < 3500, 'explain fits a call (' + JSON.stringify(ex).length + ' chars)');
  const gc = await p.evaluate(() => JSON.parse(JSON.stringify(VX_TOOLS.get_cash())));
  ok(gc.forecast_13_weeks && gc.forecast_13_weeks.learned_from_books && gc.forecast_13_weeks.week_13_range, 'get_cash says the forecast is learned and gives the range');

  // 7. Phone width: nothing wider than the screen
  await p.setViewportSize({ width: 375, height: 812 }); await p.evaluate(() => osGo('cash', 'forecast')); await p.waitForTimeout(500);
  const over = await p.evaluate(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('#mgFcHist, #mgFcHow .mg-panel-b, .mg-histmini')].filter(e => e.getBoundingClientRect().right > w + 1).length; });
  ok(over === 0, 'phone width: history and explanation fit the screen');
  await p.screenshot({ path: process.env.SHOT || '/tmp/ui-forecast-phone.png', fullPage: false });

  ok(!errs.length, 'no page errors ' + JSON.stringify(errs.slice(0, 3)));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
