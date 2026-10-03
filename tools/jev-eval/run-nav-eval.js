/**
 * Navigator eval: scores api/_lib/jevNav.js on nav-cases.json against the live
 * Jev API. Synthetic queries only; no customer data. ~$0.003 a run.
 *   set -a; . ~/.jev.env; set +a; node tools/jev-eval/run-nav-eval.js
 * Go-live bar: >= 95% right when the palette is sure, and no "ask" case ever
 * passes the panel gate (it would navigate away from a question).
 */
const path = require('path');
const nav = require(path.join(__dirname, '../../api/_lib/jevNav'));
const { cases } = require('./nav-cases.json');

(async () => {
  if (!process.env.JEV_API_KEY) { console.error('JEV_API_KEY not set. Load ~/.jev.env first.'); process.exit(1); }
  let placed = 0, sure = 0, sureRight = 0, goCases = 0, panelHits = 0, askLeaks = 0, failed = 0;
  const rows = [];
  for (const c of cases) {
    const r = await nav.navPick(c.q);
    if (!r) { failed++; rows.push([c.q, 'CALL FAILED']); continue; }
    const ok = c.place && (r.place === c.place || (c.any || []).includes(r.place));
    const best = nav.paletteBest(r), go = nav.panelGo(r);
    let mark = '';
    if (c.place) { placed++; if (best) { sure++; if (ok) sureRight++; else mark += ' SURE-WRONG'; } }
    if (c.intent === 'go') { goCases++; if (go && ok) panelHits++; if (go && !ok) mark += ' PANEL-WRONG-PAGE'; }
    if (c.intent === 'ask' && go) { askLeaks++; mark += ' ASK-NAVIGATED'; }
    rows.push([c.q, `${r.place} ${r.placeConfidence} | ${r.intent} ${r.intentConfidence} | ${r.ms}ms${mark}`]);
  }
  for (const [q, s] of rows) console.log(q.padEnd(48), s);
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
  console.log('\nPalette: sure on ' + sure + '/' + placed + ' (' + pct(sure, placed) + '), right when sure ' + pct(sureRight, sure));
  console.log('Panel:   opens itself on ' + panelHits + '/' + goCases + ' "go" cases (' + pct(panelHits, goCases) + '), the rest go to Claude as today');
  console.log('Safety:  "ask" messages that would navigate away: ' + askLeaks + (failed ? '   calls failed: ' + failed : ''));
  const pass = sure && sureRight / sure >= 0.95 && askLeaks === 0;
  console.log(pass ? '\nPASS go-live bar' : '\nFAIL go-live bar');
  process.exit(pass ? 0 : 1);
})();
