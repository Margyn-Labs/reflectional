/**
 * The navigator (api/_lib/jevNav.js + the ?action=nav route + the browser
 * rules in app/js/02-shell.js and 25-margyn.js). Zero-dep, no network.
 * Run: node api/_lib/__tests__/jevNav.test.js
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const nav = require('../jevNav');
const root = path.join(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const CH = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
const fakeFetch = (answers, calls) => async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ answers, usage: {} }) }; };

(async () => {
  // the list of places matches the app
  const frame = read('app/js/20-frame.js');
  const pages = Object.keys(eval('(' + frame.match(/const MG_PAGES = (\{[\s\S]*?\n\});/)[1] + ')'));
  check('every server page is a real MG_PAGES key', Object.keys(nav.NAV_PAGES).every(k => pages.includes(k)), Object.keys(nav.NAV_PAGES).filter(k => !pages.includes(k)));
  check('every MG_PAGES page is offered', pages.every(k => nav.NAV_PAGES[k]), pages.filter(k => !nav.NAV_PAGES[k]));
  const shell = read('app/js/02-shell.js');
  check('every server action exists in MG_NAV_ACTIONS', Object.keys(nav.NAV_ACTIONS).every(id => shell.includes("'" + id + "':{")));
  check('options are fixed app text, no placeholders', Object.values(nav.NAV_OPTIONS).every(t => !/PARTY/.test(t)));
  check('Choice size is within Jev limits', Object.keys(nav.NAV_OPTIONS).length >= 2 && Object.keys(nav.NAV_OPTIONS).length <= 255);

  // what leaves us
  process.env.JEV_API_KEY = 'k';
  const calls = [];
  const long = 'open cash ' + 'x'.repeat(400) + ' 9876543210';
  await nav.navPick('call 9876543210 or a@b.co about GST 27ABCDE1234F1Z5', { fetchImpl: fakeFetch({ place: CH('gst', 0.9), intent: CH('go', 0.9) }, calls) });
  const sent = calls[0];
  check('phone, email and GSTIN are tokenised before sending', !/9876543210|a@b\.co|27ABCDE1234F1Z5/.test(JSON.stringify(sent)) && /PHONE_1/.test(sent.state.typed), sent.state);
  check('state is only the typed text and a fixed note', Object.keys(sent.state).sort().join() === 'note,typed');
  check('two questions: place and intent', sent.questions.place.type === 'choice' && sent.questions.intent.type === 'choice' && Object.keys(sent.questions.intent.criteria).join() === 'go,ask');
  await nav.navPick(long, { fetchImpl: fakeFetch({ place: CH('cash', 0.9) }, calls) });
  check('text capped at 200 characters', calls[1].state.typed.length <= nav.MAX_Q);
  check('empty text never calls Jev', (await nav.navPick('   ', { fetchImpl: fakeFetch({}, calls) })) === null && calls.length === 2);

  // reading the answer
  const r = await nav.navPick('who owes me money', { fetchImpl: fakeFetch({ place: CH('receivables', 0.99), intent: CH('ask', 0.76) }, []) });
  check('returns place, intent and confidences', r && r.place === 'receivables' && r.placeConfidence === 0.99 && r.intent === 'ask', r);
  check('a place Jev made up is dropped', (await nav.navPick('x y z w', { fetchImpl: fakeFetch({ place: CH('rm -rf', 1) }, []) })) === null);
  const bad = async () => { throw new Error('down'); };
  check('an outage is null (fail open)', (await nav.navPick('open cash', { fetchImpl: bad })) === null);

  // gates
  check('palette: sure place shows Best match even for a question', nav.paletteBest(r) === 'receivables');
  check('palette: unsure place shows nothing', nav.paletteBest({ place: 'gst', placeConfidence: 0.7 }) === null);
  check('panel: a question never navigates', nav.panelGo(r) === null);
  check('panel: sure go + sure place navigates', nav.panelGo({ place: 'cash', placeConfidence: 0.93, intent: 'go', intentConfidence: 1 }) === 'cash');
  check('panel: sure go but unsure place does not', nav.panelGo({ place: 'gst', placeConfidence: 0.79, intent: 'go', intentConfidence: 1 }) === null);

  // switches
  delete process.env.JEV_MODE_NAV; delete process.env.JEV_MODE_NAV_PANEL;
  check('off by default, panel off too', nav.modes().nav === 'off' && nav.modes().panel === 'off');
  process.env.JEV_MODE_NAV = 'live';
  check('nav live, panel starts in shadow', nav.modes().nav === 'live' && nav.modes().panel === 'shadow');
  process.env.JEV_MODE_NAV_PANEL = 'live';
  check('panel can go live', nav.modes().panel === 'live');
  delete process.env.JEV_API_KEY;
  check('no key: everything off', nav.modes().nav === 'off' && nav.modes().panel === 'off');

  // the route
  const api = read('api/ask-margyn.js');
  check('?action=nav is routed after the sign-in check', api.indexOf("voiceAction === 'nav'") > api.indexOf('getUserFromRequest(req)'));
  check('the route never logs the typed text', !/console\.log\('\[jev-nav\]'[^\n]*\bq\b/.test(api));

  // the panel's "is this a go-somewhere message" rule
  const margyn = read('app/js/25-margyn.js');
  eval(margyn.match(/function mgrNavCommand[\s\S]*?\n}\n/)[0]);
  const goes = ['open cash', 'GST kholo', 'take me to vendors', 'go to the ledger', 'please open payables', 'receivables pe le chalo'];
  const stays = ['who owes me money', 'show me cash', 'open cash?', 'open the cash page and tell me why it dropped', 'mark Acme paid', 'pause reminders',
    'go and chase Acme', 'kitna paisa aana hai kholo', 'open a b c d e f g h i', 'Explain this: GST'];
  check('commands are picked up', goes.every(mgrNavCommand), goes.filter(t => !mgrNavCommand(t)));
  check('questions, actions and "show me" are left to Claude', !stays.some(mgrNavCommand), stays.filter(mgrNavCommand));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
