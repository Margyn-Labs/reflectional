/**
 * Front-door router eval: scores api/_lib/jevRouter.js on router-cases.json
 * against the live Jev API. Synthetic messages only; the party names in the
 * file are made up and are redacted to PARTY before sending, as in production.
 *   set -a; . ~/.jev.env; set +a; node tools/jev-eval/run-router-eval.js
 *   node tools/jev-eval/run-router-eval.js --preview   (prints what would be sent, sends nothing)
 * Go-live bar: >= 95% of needed tool groups present when the router is sure,
 * zero change requests routed without propose_action, and zero real questions
 * answered with a fixed small-talk reply.
 */
const path = require('path');
const router = require(path.join(__dirname, '../../api/_lib/jevRouter'));
const { cases, parties } = require('./router-cases.json');

const tok = (tools) => Math.round(tools.reduce((n, t) => n + JSON.stringify(t).length, 0) / 4);   // ~4 characters a token

(async () => {
  const preview = process.argv.includes('--preview');
  const M = await import(path.join(__dirname, '../../api/ask-margyn.js'));
  const reg = require(path.join(__dirname, '../../api/_lib/agentRegistry'));
  const wa = require(path.join(__dirname, '../../api/_lib/whatsappAgent'));
  const FULL = { chat: reg.getAgent().tools, panel: [...reg.getAgent().tools, ...M.APP_TOOLS], whatsapp: wa.ALL_TOOLS };
  const re = router.partyRegex(parties);

  if (preview) {
    for (const c of cases) console.log((c.surface + '').padEnd(9), JSON.stringify({ message: router.redactMessage(c.q, re), earlier_message: c.earlier ? router.redactMessage(c.earlier, re) : undefined }));
    console.log('\nNothing sent. Fixed questions per call:', Object.keys(router.questions('panel')).join(', '));
    return;
  }
  if (!process.env.JEV_API_KEY) { console.error('JEV_API_KEY not set. Load ~/.jev.env first.'); process.exit(1); }

  let sure = 0, needTotal = 0, needHit = 0, sureMissCases = 0, changeCases = 0, changeDropped = 0, talkCases = 0, talkHit = 0, talkFalse = 0;
  let ruleNeed = 0, ruleHit = 0, failed = 0, depthAgree = 0, depthSure = 0, lowered = 0, loweredWrong = 0, quickCases = 0;
  const sent = { chat: [], panel: [], whatsapp: [] }, full = { chat: 0, panel: 0, whatsapp: 0 };
  for (const s of Object.keys(FULL)) full[s] = tok(FULL[s]);
  const rows = [];
  for (const c of cases) {
    const r = await router.route({ surface: c.surface, text: c.q, earlier: c.earlier, userId: 'eval', depth: c.surface === 'whatsapp' ? null : 'balanced' },
      { mode: 'live', loadNames: async () => parties });
    router._partyCache.clear();
    const p = r.pick;
    if (p.why === 'nojev') failed++;
    const isTalk = p.why === 'talk';
    const groups = p.full ? router.groupsFor(c.surface) : p.groups;
    let mark = '';
    // tool groups
    const need = c.need || [];
    for (const g of need) { ruleNeed++; if ((p.ruled || []).includes(g)) ruleHit++; }
    if (!p.full && !isTalk) {
      sure++;
      const miss = need.filter(g => !groups.includes(g));
      needTotal += need.length; needHit += need.length - miss.length;
      if (miss.length) { sureMissCases++; mark += ' MISSING:' + miss.join('+'); }
    }
    if (c.change) { changeCases++; if (isTalk || !groups.includes('change')) { changeDropped++; mark += ' CHANGE-DROPPED'; } }
    if (c.talk) { talkCases++; if (isTalk) talkHit++; }
    if (isTalk && !c.talk) { talkFalse++; mark += ' WRONG-SMALLTALK'; }
    // depth
    if (c.depth === 'quick') quickCases++;
    if (p.depth && p.depthConf >= router.DEPTH_MIN) { depthSure++; if (p.depth === c.depth) depthAgree++; }
    if (r.apply.depth === 'quick' && c.surface !== 'whatsapp') { lowered++; if (c.depth !== 'quick') { loweredWrong++; mark += ' WRONG-QUICK'; } }
    // tokens
    const toolsSent = isTalk ? [] : p.full ? FULL[c.surface] : router.selectTools(FULL[c.surface], p.groups, c.surface);
    sent[c.surface].push(tok(toolsSent));
    const n = Object.entries(p.nouls || {}).map(([g, v]) => g[0] + (v == null ? '?' : Math.round(v * 100))).join(' ');
    rows.push([c.surface[0] + ' ' + c.q, `${p.full ? 'FULL(' + p.why + ')' : isTalk ? 'TALK:' + p.talk : p.groups.join('+')} | d=${p.depth}/${(p.depthConf || 0).toFixed(2)} -> ${r.apply.depth || '-'} | ${n} | ${toolsSent.length} tools${mark}`]);
  }
  for (const [q, s] of rows) console.log(q.slice(0, 56).padEnd(57), s);

  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
  const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  console.log('\nCases: ' + cases.length + (failed ? '   Jev calls failed: ' + failed : ''));
  console.log('Tool groups: sure on ' + sure + '/' + cases.length + ' (' + pct(sure, cases.length) + '); needed groups present when sure ' + needHit + '/' + needTotal + ' (' + pct(needHit, needTotal) + '), cases missing one: ' + sureMissCases);
  console.log('             keyword rules alone would have found ' + pct(ruleHit, ruleNeed) + ' of needed groups');
  console.log('Safety:      change requests without propose_action: ' + changeDropped + '/' + changeCases + ';  questions given a small-talk reply: ' + talkFalse);
  console.log('Small talk:  fixed reply on ' + talkHit + '/' + talkCases + ' greetings/thanks/byes');
  console.log('Depth:       Jev sure on ' + depthSure + ', agrees with the label on ' + pct(depthAgree, depthSure) + '; Balanced lowered to Quick on ' + lowered + ' (wrongly: ' + loweredWrong + ') of ' + quickCases + ' quick cases');
  console.log('\nTool definition tokens per message (approx., chars/4):');
  let fullAll = 0, sentAll = 0, nAll = 0;
  for (const s of Object.keys(FULL)) {
    if (!sent[s].length) continue;
    const a = avg(sent[s]);
    console.log('  ' + s.padEnd(9) + 'today ' + full[s] + ' (' + FULL[s].length + ' tools)  with router ' + a + '  saved ~' + (full[s] - a) + ' (' + pct(full[s] - a, full[s]) + ')');
    fullAll += full[s] * sent[s].length; sentAll += sent[s].reduce((x, y) => x + y, 0); nAll += sent[s].length;
  }
  console.log('  overall  saved ~' + Math.round((fullAll - sentAll) / nAll) + ' tokens a message (' + pct(fullAll - sentAll, fullAll) + ' of tool tokens), before prompt caching');
  const pass = needTotal && needHit / needTotal >= 0.95 && changeDropped === 0 && talkFalse === 0;
  console.log(pass ? '\nPASS go-live bar' : '\nFAIL go-live bar');
  process.exit(pass ? 0 : 1);
})();
