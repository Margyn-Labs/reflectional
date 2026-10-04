/**
 * "How it's calculated" (app/js/margyn-formulas.js) must match the code it
 * describes. Zero-dep. Run: node api/_lib/__tests__/formulas.test.js
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const root = path.join(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const F = require('../../../app/js/margyn-formulas.js');

(async () => {
  // the constants both sides quote
  const scoring = read('app/js/15-scoring.js');
  const bench = eval('(' + scoring.match(/const BENCH = (\{[^}]*\})/)[1] + ')');
  const weights = eval('(' + scoring.match(/const VITAL_WEIGHTS = (\{[^}]*\})/)[1] + ')');
  const tol = Number(scoring.match(/const CONFLICT_TOLERANCE = ([\d.]+)/)[1]);
  check('bands match BENCH', ['runwayMax', 'recvBad', 'paySafe', 'gstBad', 'marginGood'].every(k => F.BANDS[k] === bench[k]), { bench, mine: F.BANDS });
  check('Pulse weights match VITAL_WEIGHTS', JSON.stringify(F.WEIGHTS) === JSON.stringify(weights), { weights });
  check('tolerance matches CONFLICT_TOLERANCE', F.TOLERANCE === tol);
  check('the Pulse formula text carries every weight', Object.keys(weights).every(l => F.FIGURES.pulse_score.formula.includes(Math.round(weights[l] * 100) + '% × ' + l.replace(' (30d)', '').replace('Payables Due', 'Payables Due'))), F.FIGURES.pulse_score.formula);
  const fcOwn = F.FIGURES.forecast.notes.join(' ');
  check('the forecast text quotes its own-assumption defaults', /\+ 15 days/.test(fcOwn) && /90 days/.test(fcOwn) && /week 5/.test(fcOwn) && /20th/.test(fcOwn));
  const cfm = read('api/_lib/cashFlowModel.js');
  check('the learned forecast text matches the model (12 past weeks, ± 1.28 ×, Kaplan-Meier)', /back <= 84/.test(cfm) && /1\.28 \* s/.test(cfm) && /survivalFrom/.test(cfm) &&
    /12 weeks/.test(F.FIGURES.forecast.formula) && /1\.28/.test(F.FIGURES.forecast.formula) && /Kaplan-Meier/.test(F.FIGURES.forecast.formula));
  const fc = read('app/js/19a-forecast.js');
  check('...and the code still has them', /collectDelay:15/.test(fc) && /doubtfulAfter:90/.test(fc) && /billsStart:5/.test(fc) && /getDate\(\) === 20/.test(fc) && /floor:Math.round\(usualLow != null \? usualLow : burn \/ 2\)/.test(fc) && /pts\[Math.floor\(pts.length \* 0.1\)\]/.test(fc) && /lowest tenth/.test(fcOwn) && /two weeks of spend/.test(fcOwn));
  check('capital readiness multipliers match the code', /pulse_score >= 70 \? 3 : latest.pulse_score >= 40 \? 2 : 1/.test(read('app/js/08-khata.js')) && /mid\*0\.8/.test(read('app/js/08-khata.js')));
  check('Tally cash leaves out overdraft / cash credit / loans', /overdraft\|occ\|cash credit\|loan/.test(scoring) && /Overdraft, cash credit and loan ledgers are left out/.test(F.FIGURES.cash.formula));
  check('costs-incomplete rule is 40% of the usual', /0\.4 \* median/.test(read('api/_lib/tallyAnalytics.js')) && /under 40%/.test(F.FIGURES.burn.formula));
  check('a new reading needs a 0.5% move', /scale \* 0\.005/.test(scoring) && /0\.5%/.test(F.HOW.readings));

  // every entry is complete and points at real things
  const frame = read('app/js/20-frame.js');
  const pages = Object.keys(eval('(' + frame.match(/const MG_PAGES = (\{[\s\S]*?\n\});/)[1] + ')'));
  const bad = F.KEYS.filter(k => { const e = F.FIGURES[k]; return !e.label || !e.what || !e.formula || !pages.includes(e.page); });
  check('every figure has label, what, formula and a real page', !bad.length, bad);
  const files = F.KEYS.flatMap(k => (F.FIGURES[k].code.match(/[\w/.-]+\.js/g) || []));
  const exists = f => [f, 'app/js/' + f, 'api/_lib/' + f].some(c => fs.existsSync(path.join(root, c)));
  const missing = files.filter(f => !exists(f));
  check('every code file named exists', !missing.length, missing);
  const ins = ['cash', 'revenue', 'netProfit', 'burn', 'gstLeak', 'gstPayable', 'recvTotal', 'recv90', 'paySoon'];
  check('inputs are real reading fields', F.KEYS.every(k => (F.FIGURES[k].inputs || []).every(i => ins.includes(i) || / /.test(i))));
  check('vital weights name real vitals', F.KEYS.every(k => !F.FIGURES[k].weight || weights[F.FIGURES[k].weight] != null));

  // finding a figure from their words
  const cases = { 'how is runway calculated': 'runway', 'why is my pulse score 59': 'pulse_score', 'where does my cash figure come from': 'cash', 'what is DSO': 'dso',
    'how is gross margin worked out': 'gross_margin', 'cash forecast': 'forecast', 'how much can i borrow': 'capital_readiness', 'receivables aging score': 'receivables_vital', 'gst payable': 'gst_payable' };
  const wrong = Object.entries(cases).filter(([q, k]) => F.find(q) !== k).map(([q, k]) => q + ' -> ' + F.find(q) + ' (want ' + k + ')');
  check('figures found from plain words', !wrong.length, wrong);
  check('unknown words find nothing', F.find('banana smoothie') === null);
  check('how-it-works topics route', F.howTopic('why do two screens show different numbers').topic === 'differences' && F.howTopic('do you use AI to calculate').topic === 'ai_role' && F.howTopic('which source do you trust').topic === 'sources');

  // wired everywhere
  const books = require('../booksTools');
  const r = await books.exec('how_its_calculated', { figure: 'runway' }, 'nobody', ['view_cash']);
  check('WhatsApp/chat tool answers with no Tally and for any team member', r.figure === 'runway' && /÷ monthly spend/.test(r.formula), r);
  check('voice gets explain, not the formula-only tool', !books.realtimeDefs().some(t => t.name === 'how_its_calculated'));
  const api = read('api/ask-margyn.js');
  check('explain, how_margyn_works and press are panel tools', /'explain', 'how_margyn_works', 'press'\]/.test(api) && ['explain', 'how_margyn_works', 'press'].every(n => api.includes("name: '" + n + "'")));
  const router = read('api/_lib/jevRouter.js');
  check('the front door can offer them', ['explain', 'how_margyn_works', 'how_its_calculated', 'press'].every(n => router.includes("'" + n + "'")));
  const tools = read('app/js/23-voice-tools.js');
  check('press refuses approve/confirm/save/delete/send', /VX_PRESS_NO = .*approve\|confirm\|dismiss\|reject\|delete\|remove\|disconnect\|send\|pay\|paid\|save/.test(tools));
  check('navigate reports every page, not only money pages', !/Only money pages return figures here/.test(tools) && /vxPageSummary\(page\);\n    return sm && typeof sm.then/.test(tools));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
