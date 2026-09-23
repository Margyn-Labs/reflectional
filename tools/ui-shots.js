// Screenshot harness for app.html with seeded (fake) state — no login needed.
// Usage: node tools/serve-static.js &   then   node tools/ui-shots.js <outDir> [baseUrl]
// Uses the local playwright devDependency. Extend VIEWS for new pages.
// How it works: loads app.html, runs tools/ui-seed.js seedApp() in the page
// (table-aware sbClient.from() stub + /api/* fetch stub + the app's own
// refreshAll()), then calls showView(name) per view and screenshots.
// Every page error and console error is reported, plus horizontal overflow.
const { chromium } = require('playwright');
const OUT = process.argv[2] || 'ui-shots';
const BASE = process.argv[3] || 'http://localhost:5188/app.html';
const VIEWS = ['home','inbox','payments','receivables','payables','gst','books','invoicing','customers','vendors','analytics','scores','history','agents','connectors','people','settings','audit','financing','profile','calculate','ledger'];

const { seedApp } = require('./ui-seed');

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  for (const [label, vp] of [['desktop', { width:1440, height:900 }], ['mobile', { width:390, height:844 }]]) {
    const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2 });
    const errs = [], overflows = []; p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
    // Fixed clock (10:30 am IST) so "as of"/"synced" times don't differ between runs.
    await p.clock.setFixedTime(new Date('2026-09-24T10:30:00+05:30'));
    await p.goto(BASE); await p.waitForTimeout(800);
    // Deterministic frames: no CSS animation/transition, no Chart.js animation,
    // so before/after pixel diffs only show real changes.
    await p.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await p.evaluate(() => { if (window.Chart) Chart.defaults.animation = false; });
    await p.evaluate(seedApp); await p.waitForTimeout(600);
    for (const v of VIEWS) {
      try {
        await p.evaluate(name => showView(name), v); await p.waitForTimeout(500);
        // The app scrolls inside .wrap (body is overflow:hidden), so fullPage
        // alone stops at the viewport. Grow the viewport to .wrap's content.
        const h = await p.evaluate(() => { const w = document.querySelector('.wrap'); return w ? w.scrollHeight + (innerHeight - w.clientHeight) : innerHeight; });
        await p.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 12000) }); await p.waitForTimeout(250);
        await p.evaluate(() => document.querySelectorAll('svg').forEach(s => { if (s.pauseAnimations) { s.pauseAnimations(); s.setCurrentTime(0); } }));
        await p.screenshot({ path: `${OUT}/${label}-${v}.png`, fullPage: true });
        await p.setViewportSize(vp); await p.waitForTimeout(150);
        // Horizontal overflow per view + the widest offending element.
        const ov = await p.evaluate(() => {
          const W = document.documentElement.clientWidth; let worst = null;
          document.querySelectorAll('#appShell *').forEach(el => {
            const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).position === 'fixed') return;
            const over = Math.round(r.right - W);
            if (over > 1 && (!worst || over > worst.over)) worst = { over, el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') };
          });
          return { page: document.documentElement.scrollWidth - innerWidth, wrap: (() => { const w = document.querySelector('.wrap'); return w ? w.scrollWidth - w.clientWidth : 0; })(), worst };
        });
        if (ov.page > 0 || ov.wrap > 0 || ov.worst) overflows.push(`${v}: page ${ov.page}px, wrap ${ov.wrap}px` + (ov.worst ? `, widest ${ov.worst.el} +${ov.worst.over}px` : ''));
      } catch (e) { errs.push(v + ': ' + e.message.split('\n')[0]); }
    }
    await p.evaluate(() => showView('summary')); await p.waitForTimeout(300);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(label, 'horizontal overflow px (summary):', overflow, 'errors:', errs);
    overflows.forEach(o => console.log('  overflow', o));
    await p.close();
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
