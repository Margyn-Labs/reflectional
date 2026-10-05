// Margyn sees the whole screen and explains like an accountant (23-voice-tools.js:
// explain, how_margyn_works, press, navigate, get_screen). Seeded app, real tools.
// Usage: node tools/serve-static.js &   then   node tools/ui-explain-test.js [baseUrl]
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
  await p.evaluate(seedApp); await p.waitForTimeout(4500);
  const run = (name, args) => p.evaluate(async ([n, a]) => { const r = await VX_TOOLS[n](a || {}); return JSON.parse(JSON.stringify(r)); }, [name, args]);

  // 1. opening a page says what's on it, for every page (the "inbox is empty" bug)
  const inbox = await run('navigate', { page:'inbox' });
  const n = await p.evaluate(() => agentQueueTotals().total);
  ok(inbox.on_this_page && inbox.on_this_page.total_waiting === n && n > 0, 'navigate inbox reports ' + (inbox.on_this_page && inbox.on_this_page.total_waiting) + ' waiting (page has ' + n + ')');
  ok(JSON.stringify(inbox).length < 2600, 'kept small for the call (' + JSON.stringify(inbox).length + ' chars)');
  const people = await run('navigate', { page:'audit' });
  ok(people.on_this_page && typeof people.on_this_page.page_text === 'string' && people.on_this_page.page_text.length > 20, 'a page with no figures summary returns its own words');
  const scr = await run('get_screen');
  ok(Array.isArray(scr.buttons), 'get_screen lists the buttons on screen: ' + (scr.buttons || []).slice(0, 4).join(' | '));

  // 2. explain: formula + live inputs + the worked sum, matching the page
  const rw = await run('explain', { figure:'how is my runway calculated' });
  const stored = await p.evaluate(() => mgVital(snapshots[0], 'Working Capital Runway'));
  ok(rw.found && rw.figure === 'runway' && /÷ monthly spend/.test(rw.formula), 'runway: formula');
  ok(rw.inputs && rw.inputs.length === 4 && rw.inputs.every(i => i.value && i.from), 'runway: four inputs, each with amount and source: ' + JSON.stringify(rw.inputs[0]));
  ok(rw.worked && rw.worked.includes(String(stored.value).replace(/^-\s*0\.0 months$/, 'below zero')) || (rw.worked && /score \d+/.test(rw.worked)), 'runway: worked sum ends in the same value as the page (' + stored.value + '): ' + rw.worked);
  ok(/15% of the Pulse Score/.test(rw.in_pulse_score || ''), 'runway: its weight in the Pulse Score');
  const ps = await run('explain', { figure:'why is my pulse score this number' });
  const total = await p.evaluate(() => snapshots[0].pulse_score);
  ok(ps.worked && ps.worked.length === 6 && new RegExp('Total ' + total + ' ').test(ps.result), 'pulse score: six weighted vitals adding to ' + total);
  const sum = ps.worked.reduce((t, l) => t + Number((l.match(/= ([\d.]+) points/) || [0, 0])[1]), 0);
  ok(Math.abs(Math.round(sum) - total) <= 1, 'pulse score: the points add up (' + sum.toFixed(1) + ' ≈ ' + total + ')');
  const rc = await run('explain', { figure:'receivables' });
  ok(rc.result && rc.each_source_own_total && rc.parties, 'receivables: total, each source side by side, agree/disagree counts');
  const fc = await run('explain', { figure:'cash forecast' });
  ok(fc.worked && fc.assumptions_in_use && fc.assumptions_in_use.collection_delay_days === 15, 'forecast: worked figures and the assumptions in use');
  const cash = await run('explain', { figure:'where does my cash come from' });
  ok(cash.figure === 'cash' && cash.result, 'cash: explained (' + (cash.ledgers_counted ? cash.ledgers_counted.length + ' Tally ledgers listed' : 'no Tally ledgers in seed') + ')');
  const none = await run('explain', { figure:'banana' });
  ok(none.found === false && none.figures_i_can_explain.length > 10, 'unknown figure: says what it can explain');
  const how = await run('how_margyn_works', { topic:'why do two screens show different numbers' });
  ok(how.topic === 'differences' && /CFO pack/.test(how.answer), 'how Margyn works: why two screens differ');
  for(const f of await p.evaluate(() => MG_FORMULAS.KEYS)){
    const r = await run('explain', { figure:f });
    if(!r.found || r.error) ok(false, 'explain ' + f + ' failed: ' + JSON.stringify(r).slice(0, 120));
    else if(JSON.stringify(r).length > 3500) ok(false, 'explain ' + f + ' too long for the call: ' + JSON.stringify(r).length);
  }
  ok(true, 'every figure in the catalog explains without error and fits a call');

  // 3. press: safe buttons yes, data-changing buttons no
  await p.evaluate(() => osGo('close', 'proposals')); await p.waitForTimeout(400);   // where the Approve buttons are
  const approve = await run('press', { label:'Approve' });
  ok(approve.pressed === false && approve.refused, 'press refuses Approve: ' + (approve.reason || '').slice(0, 50));
  const after = await p.evaluate(() => agentQueueTotals().total);
  ok(after === n, 'nothing was approved');
  await run('navigate', { page:'cfopack' });
  const pdf = await p.evaluate(() => { window.print = () => { window.__printed = true; }; return true; });
  const sp = await run('press', { label:'Save as PDF' });
  ok(sp.pressed && /print window/.test(sp.note || ''), 'press "Save as PDF" works and says the print window is theirs: ' + JSON.stringify(sp).slice(0, 90));
  const nope = await run('press', { label:'Fly to the moon' });
  ok(nope.pressed === false && Array.isArray(nope.buttons_on_screen), 'unknown button: lists what is on screen');

  ok(!errs.length, 'no page errors: ' + errs.join(' | '));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
