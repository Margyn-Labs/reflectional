/** Run: node api/_lib/__tests__/whatsappReplyKind.test.js — which replies open the saved full update and which get their own fresh answer. No network. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n)); };
const A = require('../whatsappAgent');

// Mihir's real replies to updates (Care Hygiene, Sep–Nov 2026).
for (const t of ['Yes', 'Yes.', 'Yes!', 'Okay.', 'ok', 'Full update!', 'See details', 'show me more', 'Haan', '👍']) {
  check(`"${t}" opens the saved update`, A.isTapOrAck(t) && !A.asksSomething(t));
}
for (const t of ['What is my total sales for this year?', 'Sales for this month?', 'For the financial year!', 'Why did the cash drop',
  'What does my projection look like?', 'Present me the chart, from March to Sept 2026', 'Pluses score?', 'kitna paisa aana hai', 'Top 3 action items']) {
  check(`"${t}" gets its own answer, not the saved update`, A.asksSomething(t) && !A.isTapOrAck(t));
}
check('the prompt says every figure is fetched fresh', /Every figure you give is fetched fresh/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'whatsappAgent.js'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
