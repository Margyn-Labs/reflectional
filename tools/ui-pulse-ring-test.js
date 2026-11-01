// Home's Pulse ring sweeps in once, however many times Home is redrawn while a fresh load lands (1 Nov 2026: it
// replayed from zero 3–5 times). A redraw mid-sweep carries on; a new score after it glides, never restarts.
// Usage: node tools/serve-static.js &   then   node tools/ui-pulse-ring-test.js [baseUrl]
const { chromium } = require('playwright');
const { seedApp } = require('./ui-seed');
const B = process.argv[2] || 'http://localhost:5188/app.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if(!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{ width:1440, height:900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B); await p.waitForTimeout(600);
  await p.evaluate(seedApp); await p.waitForTimeout(300);
  // Sample how much of the ring is drawn every 30 ms while Home is redrawn five times in its first second.
  const r = await p.evaluate(async () => {
    mghRing = null; showView('home');
    const len = () => { const c = document.querySelector('#view-home .mgh-ring-v'); if(!c) return null; const d = c.getBoundingClientRect(); return Math.round(c.getTotalLength ? (getComputedStyle(c).strokeDasharray.split(/[ ,]+/)[0].replace('px','') * 1) : 0); };
    const seen = []; const t = setInterval(() => seen.push(len()), 30);
    for(let i = 0; i < 5; i++){ await new Promise(x => setTimeout(x, 180)); mgRenderHome(); }
    await new Promise(x => setTimeout(x, 900)); clearInterval(t);
    return seen.filter(x => x !== null);
  });
  let drops = 0; for(let i = 1; i < r.length; i++) if(r[i] < r[i - 1] - 3) drops++;
  ok(r.length > 10 && drops === 0, 'five redraws in the first second: the ring only ever grows (' + drops + ' restarts) ' + JSON.stringify(r.slice(0, 40)));
  const final = r[r.length - 1], want = await p.evaluate(() => Math.round(Number(document.querySelector('#view-home .mgh-ring-v').getAttribute('stroke-dasharray').split(' ')[0])));
  ok(Math.abs(final - want) <= 1, 'it ends at the score: ' + final + ' / ' + want);
  // Later: a redraw with the same score does nothing; a new score glides from the old value.
  const later = await p.evaluate(async () => {
    mgRenderHome(); await new Promise(x => setTimeout(x, 60));
    const c1 = document.querySelector('#view-home .mgh-ring-v'), same = c1.classList.contains('settled') && getComputedStyle(c1).animationName === 'none';
    const s = snapshots[0], was = s.pulse_score; s.pulse_score = Math.max(5, was - 30); mgRenderHome();
    const c2 = document.querySelector('#view-home .mgh-ring-v'); const a = Number(getComputedStyle(c2).strokeDasharray.split(/[ ,]+/)[0].replace('px',''));
    await new Promise(x => setTimeout(x, 800)); const z = Number(getComputedStyle(c2).strokeDasharray.split(/[ ,]+/)[0].replace('px',''));
    s.pulse_score = was; return { same, a:Math.round(a), z:Math.round(z), want:Math.round(Math.max(5, was - 30) / 100 * 257.6), from:Math.round(was / 100 * 257.6) };
  });
  ok(later.same, 'a later redraw with the same score does not replay the sweep');
  ok(later.a >= later.from - 20 && Math.abs(later.z - later.want) <= 1, 'a new score glides from the old value, not from zero: ' + JSON.stringify(later));
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
