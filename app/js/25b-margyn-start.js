/* ============================================================
   MARGYN STARTS HELPING THE MOMENT YOU SIGN IN (2026-10-31)

   1. A new account's first ten minutes. While the first read of the books
      runs, the Margyn panel says what it is reading ("Reading your invoices…
      1,000 so far", from /api/zoho?action=first-read). As soon as figures
      exist it gives a first read (cash, who owes most, what's late, bills due
      this week; the opening_read books tool) and then asks, one at a time and
      each skippable: the cash floor (prefs.forecast.floor, the forecast's own
      setting), WhatsApp numbers for the top five debtors (ledger_parties) and
      who gets the daily update (Margyn Watch to the owner's number; others on
      People). Works on an empty book, a slow first read, and books without
      phone numbers.
   2. Every later sign-in: what changed in the books since the last visit
      (money in and from whom, what went overdue, bills due this week) with
      two or three actions finished in one tap: "Remind <customer>" (the
      reminder is shown first and goes only on Send, through the Chase
      template and sendGuard: /api/whatsapp?action=remind-now), "Send this
      week's payables to my accountant" (WhatsApp opens with the list; the
      owner presses send), and "Show me".

   Who sees it: only accounts that started here (profiles.preferences
   .margyn_onboard, set when Margyn first leads the setup), and the opening
   read on Zoho Books / Odoo books. Existing Tally accounts see exactly what
   they saw before. Figures come only from the books tools; nothing is
   estimated here.
   ============================================================ */
const MGO_PREF = 'margyn_onboard';
const MGO_STEPS = ['floor', 'phones', 'updates'];
const MGO_READ_LABEL = { chartofaccounts:'your accounts', invoices:'invoices', bills:'bills', customerpayments:'customer payments',
  vendorpayments:'supplier payments', bankaccounts:'bank accounts', journals:'profit and loss entries', contacts:'customer and supplier contacts' };
let mgoPoll = null, mgoRead = null, mgoRetries = 0, mgoBusy = false;

function mgoOwner(){ return !(typeof mgActor !== 'undefined' && mgActor && !mgActor.isOwner); }
function mgoState(){ const v = typeof mgPrefGet === 'function' ? mgPrefGet(MGO_PREF, null) : null; return v && typeof v === 'object' ? v : null; }
function mgoSet(patch){ if(typeof mgPrefSet === 'function') mgPrefSet(MGO_PREF, Object.assign({}, mgoState() || {}, patch, { at:new Date().toISOString() })); }
function mgoActive(){ const s = mgoState(); return !!s && s.state !== 'done'; }
async function mgoBooks(tool, input){ try { return await vxBooks(tool, input); } catch(e){ return { error:'Couldn’t read the books just now.' }; } }
function mgoN(n){ return Number(n || 0).toLocaleString('en-IN'); }
function mgoInr(n){ return fmtINR(Number(n) || 0, 'tile'); }
function mgoName(s){ return typeof mgCleanName === 'function' ? mgCleanName(s) : String(s || ''); }
function mgoDay(isoDay){ try { return new Date(isoDay + 'T00:00:00+05:30').toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', weekday:'short', day:'numeric', month:'short' }); } catch(e){ return isoDay; } }
/* "5 L", "2.5 cr", "50k", "₹5,00,000" -> rupees. null when it isn't a number. */
function mgoParseInr(s){
  const t = String(s || '').toLowerCase().replace(/[₹,\s]/g, '').replace(/rs\.?|inr/g, '');
  const m = /^(\d+(?:\.\d+)?)(cr|crore|crores|l|lakh|lakhs|lac|lacs|k|thousand)?$/.exec(t);
  if(!m) return null;
  const x = Number(m[1]), u = m[2] || '';
  const mult = /^c/.test(u) ? 1e7 : /^l/.test(u) ? 1e5 : /^(k|t)/.test(u) ? 1e3 : 1;
  const v = Math.round(x * mult);
  return isFinite(v) && v >= 0 ? v : null;
}

/* ---------- 1a. the first read, narrated ---------- */
/* Called by the Zoho connect (11-connectors.js confirmZohoOrg) as the first read starts. Only a new account. */
function mgoReading(kind){
  const s = mgoState();
  if(!s || !/^(awaiting_books|reading)$/.test(s.state) || !mgoOwner()) return;
  mgoSet({ state:'reading', books:kind });
  mgrOpen();
  mgrHtmlLine('<p><b>I’m reading your books from Zoho now.</b> On most books this first read takes a minute or two; on a big one, a few more. I’ll tell you what I find as soon as the figures are in. You don’t need to stay on this screen.</p>' +
    '<div class="mgo-prog" data-mgo-prog><span class="mgo-dot"></span><span data-mgo-now>Connecting to Zoho…</span><div class="mgo-done" data-mgo-done></div></div>', 'greet mgo-reading');
  mgoWatchRead();
}
function mgoWatchRead(){
  clearInterval(mgoPoll);
  const started = Date.now();
  let last = '', lastChange = Date.now(), slowSaid = false;
  const tick = async () => {
    let d = null;
    try { d = await zohoApi('/api/zoho?action=first-read'); } catch(e){ return; }
    const host = document.querySelector('[data-mgo-prog]');
    if(!d || !host) return;
    const steps = d.steps || [], cur = steps.find(x => !x.done);
    const done = steps.filter(x => x.done && x.read > 0 && x.module !== 'chartofaccounts');
    const now = d.done ? 'Done reading. Working out your figures…'
      : cur ? 'Reading your ' + MGO_READ_LABEL[cur.module] + '… ' + (cur.read ? mgoN(cur.read) + ' so far' : '')
      : steps.length ? 'Reading…' : 'Connecting to Zoho…';
    const key = now + '|' + done.length;
    if(key !== last){ last = key; lastChange = Date.now(); }
    host.querySelector('[data-mgo-now]').textContent = now;
    host.querySelector('[data-mgo-done]').textContent = done.map(x => '✓ ' + mgoN(x.read) + ' ' + MGO_READ_LABEL[x.module]).join(' · ');
    if(!slowSaid && Date.now() - lastChange > 75000){
      slowSaid = true;
      mgrLine('margyn', 'Zoho is answering slowly right now, so this is taking longer. I’m still reading; nothing is lost if you close this.');
    }
    if(d.done || Date.now() - started > 25 * 60000){ clearInterval(mgoPoll); mgoPoll = null; host.classList.add('finished'); }
  };
  tick();
  mgoPoll = setInterval(() => { if(!document.hidden) tick(); }, 3000);
}
/* The connect call itself ran out of time (a big book, Zoho slow): the read carries on on the server. */
async function mgoConnectSlow(err){
  if(!mgoActive()) return false;
  let d = null;
  try { d = await zohoApi('/api/zoho?action=first-read'); } catch(e){ return false; }
  if(!d || !d.connected) return false;
  document.getElementById('zohoOverlay').classList.add('hidden');
  mgrLine('margyn', 'Zoho is connected; the first read is still going. I’ll carry on and tell you when your figures are in.');
  // Wait for the read to finish, then take it from there as if the connect had answered.
  const wait = setInterval(async () => {
    let x = null; try { x = await zohoApi('/api/zoho?action=first-read'); } catch(e){ return; }
    if(!x || !x.done) return;
    clearInterval(wait);
    await loadZohoVitals();
    if(typeof mgrSetupConnected === 'function') mgrSetupConnected('zoho');
    if(typeof mgAfterBooksSync === 'function') mgAfterBooksSync();
  }, 10000);
  return true;
}

/* ---------- 1b. connected: the first read, then the questions ---------- */
/* Called by mgrSetupConnected (any books system) and on sign-in while a new account's setup isn't finished. */
async function mgoConnected(){
  const s = mgoState();
  if(!s || s.state === 'done' || !mgoOwner() || mgoBusy) return;
  clearInterval(mgoPoll); mgoPoll = null;
  const p = document.querySelector('[data-mgo-prog]');
  if(p && !p.classList.contains('finished')){ p.classList.add('finished'); const t = p.querySelector('[data-mgo-now]'); if(t) t.textContent = 'Done: your books are in.'; }
  mgoBusy = true;
  try {
    if(s.state !== 'asking') mgoSet({ state:'asking', step:0 });
    // The first read brought customers' numbers in with the contacts: the questions see them.
    try { if(typeof mgReloadParties === 'function') await mgReloadParties(); } catch(e){}
    const ok = await mgoFirstRead();
    if(ok) mgoAskNext();
  } finally { mgoBusy = false; }
}
async function mgoFirstRead(){
  const r = await mgoBooks('opening_read', {});
  if(r && r.numbers){ mgoRead = r; mgoRetries = 0; mgoFirstReadCard(r); return true; }
  // Nothing in yet (a slow first read, or a brand-new books file): say so, check again, and still set up.
  mgoRetries++;
  const empty = r && r.connected && r.note;
  if(mgoRetries <= 6 && !(empty && mgoRetries > 3)){
    if(mgoRetries === 1) mgrLine('margyn', empty ? 'Your books are connected, but no entries have come through yet. I’ll look again in a minute.' : 'I can’t read the figures just yet. I’ll try again in a minute.');
    setTimeout(() => { if(mgoActive()) mgoConnected(); }, 60000);
    return false;
  }
  mgoRead = { numbers:{ top:[], late:[], due7_list:[] } };
  mgrHtmlLine('<p><b>Your books are connected, but they’re empty so far:</b> no invoices, bills or payments have come through. As soon as there are some, I’ll pick them up (every night, or press <b>Sync now</b> on Organisations and sources). Meanwhile, two quick things so I’m ready.</p>', 'greet');
  return true;
}
function mgoFirstReadCard(r){
  const n = r.numbers, lines = [];
  if(n.cash != null) lines.push('<li><b>Cash:</b> ' + escapeHtml(mgoInr(n.cash)) + ' across your bank and cash accounts.</li>');
  if(n.recv_total > 0){
    lines.push('<li><b>Customers owe you</b> ' + escapeHtml(mgoInr(n.recv_total)) + (n.recv_overdue > 0 ? ', and ' + escapeHtml(mgoInr(n.recv_overdue)) + ' of it is overdue.' : ', none of it overdue yet.') + '</li>');
    if(n.top.length) lines.push('<li><b>Who owes most:</b> ' + n.top.slice(0, 3).map(g => escapeHtml(mgoName(g.party)) + ' ' + escapeHtml(mgoInr(g.owed))).join(', ') + '.</li>');
    if(n.late.length) lines.push('<li><b>Most late:</b> ' + escapeHtml(mgoName(n.late[0].party)) + ', ' + escapeHtml(mgoInr(n.late[0].overdue)) + (n.late[0].late > 0 ? ', ' + n.late[0].late + ' days past due' : '') + '.</li>');
  } else lines.push('<li>No customer owes you anything right now.</li>');
  lines.push(n.due7 > 0
    ? '<li><b>Bills due this week:</b> ' + escapeHtml(mgoInr(n.due7)) + ' across ' + n.due7_list.length + ' bill' + (n.due7_list.length === 1 ? '' : 's') + (n.pay_overdue > 0 ? ', plus ' + escapeHtml(mgoInr(n.pay_overdue)) + ' already overdue' : '') + '.</li>'
    : '<li>No supplier bills fall due this week' + (n.pay_overdue > 0 ? ', but ' + escapeHtml(mgoInr(n.pay_overdue)) + ' is already overdue' : '') + '.</li>');
  const acts = ['<button type="button" class="mgr-chip on" data-mgo-show="overview">Show me</button>'];
  if(n.late.length) acts.push('<button type="button" class="mgr-chip" data-mgr-ask="Who should I chase first, and why?">Who should I chase first?</button>');
  mgrHtmlLine('<p><b>Here’s your first read</b> (straight from your books):</p><ul class="mgo-ul">' + lines.join('') + '</ul><div class="mgr-acts">' + acts.join('') + '</div>', 'greet mgo-first');
  mgStatus('Margyn read your books', true);
}

/* One question at a time; Skip moves on. Answers go where the app already keeps them. */
function mgoAskNext(){
  const s = mgoState() || {};
  let i = Math.max(0, Number(s.step) || 0);
  while(i < MGO_STEPS.length){
    const html = mgoQuestion(MGO_STEPS[i]);
    if(html){ mgrHtmlLine(html, 'mgo-q').dataset.mgoStep = MGO_STEPS[i]; mgoSet({ step:i }); return; }
    i++;
  }
  mgoSet({ state:'done', step:MGO_STEPS.length });
  mgrHtmlLine('<p><b>That’s you set up.</b> From now on, each time you open Margyn I’ll start with what changed in your books and what’s worth doing about it. Ask me anything here, or press Talk.</p>' +
    '<div class="mgr-acts"><button type="button" class="mgr-chip on" data-go-page="home">Show me my business</button></div>', 'greet');
}
function mgoSkipHtml(){ return '<button type="button" class="mgr-chip ghost" data-mgo-skip>Skip</button>'; }
function mgoQuestion(step){
  const n = (mgoRead && mgoRead.numbers) || { top:[] };
  if(step === 'floor'){
    let hint = '';
    try { const f = mgForecast(); if(f && f.floor > 0) hint = ' Your cash has usually stayed above ' + mgoInr(f.floor) + ', if that helps.'; } catch(e){}
    return '<p><b>One question at a time, and you can skip any.</b></p><p>What’s the least cash you never want to go below? I’ll warn you before your forecast gets there.' + escapeHtml(hint) + '</p>' +
      '<form class="mgr-name mgo-form" data-mgo-form="floor"><div><input type="text" inputmode="decimal" maxlength="20" placeholder="e.g. 5 L or 500000" aria-label="Cash floor"><button type="submit" class="mgr-chip on">Save</button>' + mgoSkipHtml() + '</div><div class="mgo-err" data-mgo-err></div></form>';
  }
  if(step === 'phones'){
    const top = (n.top || []).slice(0, 5);
    if(!top.length) return '';
    const rows = top.map((g, i) => {
      const party = typeof mgMasterFor === 'function' ? mgMasterFor(g.party, 'recv') : null;
      const have = party && party.phone;
      return '<label class="mgo-ph"><span>' + escapeHtml(mgoName(g.party)) + ' <i>' + escapeHtml(mgoInr(g.owed)) + '</i></span>' +
        (have ? '<em>' + escapeHtml(typeof waPrettyPhone === 'function' ? waPrettyPhone(String(party.phone).replace(/\D/g, '')) : party.phone) + '</em>'
              : '<input type="tel" inputmode="tel" maxlength="20" placeholder="WhatsApp number" data-mgo-ph="' + i + '">') + '</label>';
    }).join('');
    const missing = top.filter(g => { const p = typeof mgMasterFor === 'function' ? mgMasterFor(g.party, 'recv') : null; return !(p && p.phone); }).length;
    if(!missing) return '<p>Your books already have WhatsApp numbers for your ' + (top.length === 1 ? 'biggest customer' : top.length + ' biggest customers') + ', so I can remind them when they’re late (only when you say so).</p>' + mgoNextChip();
    return '<p>When a customer is late, I can remind them on WhatsApp for you, never without your OK. Your books don’t have numbers for ' + (missing === top.length ? 'these' : missing + ' of these') + '. Add any you have:</p>' +
      '<form class="mgo-form" data-mgo-form="phones">' + rows + '<div class="mgr-acts"><button type="submit" class="mgr-chip on">Save numbers</button>' + mgoSkipHtml() + '</div><div class="mgo-err" data-mgo-err></div></form>';
  }
  if(step === 'updates'){
    const ph = currentProfile && currentProfile.whatsapp_phone;
    return '<p>Every morning I can send a short WhatsApp update: cash, who paid, what went late, bills due. Who should get it?</p>' +
      '<form class="mgr-name mgo-form" data-mgo-form="updates">' +
      (ph ? '<div class="mgr-acts"><button type="submit" class="mgr-chip on">Me, on ' + escapeHtml(typeof waPrettyPhone === 'function' ? waPrettyPhone(ph) : ph) + '</button>'
          : '<label>Your WhatsApp number</label><div><input type="tel" inputmode="tel" maxlength="20" placeholder="10-digit mobile" aria-label="Your WhatsApp number"><button type="submit" class="mgr-chip on">Send it to me</button></div><div class="mgr-acts">') +
      '<button type="button" class="mgr-chip" data-mgo-people>Add someone else</button>' + mgoSkipHtml() + '</div><div class="mgo-err" data-mgo-err></div></form>';
  }
  return '';
}
function mgoNextChip(){ return '<div class="mgr-acts"><button type="button" class="mgr-chip on" data-mgo-skip>Next</button></div>'; }
function mgoDone(row, text){
  if(row){ row.classList.add('answered'); row.querySelectorAll('button,input').forEach(x => { x.disabled = true; }); }
  if(text) mgrLine('margyn', text);
  const s = mgoState() || {};
  mgoSet({ step:(Number(s.step) || 0) + 1 });
  mgoAskNext();
}
async function mgoAnswer(form){
  const row = form.closest('.mgr-msg'), err = form.querySelector('[data-mgo-err]');
  const say = t => { if(err) err.textContent = t || ''; };
  const step = form.dataset.mgoForm;
  if(step === 'floor'){
    const v = mgoParseInr(form.querySelector('input').value);
    if(v == null){ say('Type an amount, like 5 L or 500000.'); return; }
    if(typeof mgFcSave === 'function') mgFcSave({ floor:v });
    if(typeof mgFcRerender === 'function') try { mgFcRerender(); } catch(e){}
    return mgoDone(row, 'Saved. I’ll warn you if cash looks set to drop below ' + mgoInr(v) + '. You can change it any time under Cash → Adjust.');
  }
  if(step === 'phones'){
    const top = ((mgoRead && mgoRead.numbers && mgoRead.numbers.top) || []).slice(0, 5);
    const want = [...form.querySelectorAll('[data-mgo-ph]')].map(i => ({ g:top[Number(i.dataset.mgoPh)], raw:i.value.trim() })).filter(x => x.g && x.raw);
    if(!want.length){ say('Add at least one number, or press Skip.'); return; }
    const bad = want.find(x => waNormalizeMobile(x.raw).error);
    if(bad){ say('Check the number for ' + mgoName(bad.g.party) + '.'); return; }
    form.querySelector('[type=submit]').disabled = true;
    let saved = 0;
    for(const x of want){
      try {
        const { party } = await mgEnsureParty({ name:x.g.party, dir:'recv', create:true, source:'margyn' });
        if(party){ await mgUpdateParty(party.id, Object.assign({}, party, { phone:'+' + waNormalizeMobile(x.raw).digits })); saved++; }
      } catch(e){ console.warn('[margyn] saving a number', e.message); }
    }
    if(!saved){ form.querySelector('[type=submit]').disabled = false; say('I couldn’t save those just now. Try again, or Skip.'); return; }
    return mgoDone(row, 'Saved ' + saved + ' number' + (saved === 1 ? '' : 's') + ' to your customers. Nothing goes to them unless you tap Send.');
  }
  if(step === 'updates'){
    let ph = currentProfile && currentProfile.whatsapp_phone;
    const input = form.querySelector('input');
    if(!ph){
      const { digits, error } = waNormalizeMobile(input ? input.value : '');
      if(error){ say(error); return; }
      try { await savePrimaryPerson(mgrName || 'Owner', digits); ph = digits; }
      catch(e){ say(typeof peopleErr === 'function' ? peopleErr(e) : 'Couldn’t save the number.'); return; }
    }
    try { await mgHubWatchPost({ op:'mode', mode:'on' }); }
    catch(e){ say('Saved your number, but I couldn’t switch the update on just now. It’s under Conversations → Margyn Watch.'); return; }
    return mgoDone(row, 'Done. Your morning update goes to ' + (typeof waPrettyPhone === 'function' ? waPrettyPhone(ph) : ph) + ' on WhatsApp. Reply to it any time to ask me something.');
  }
}

/* ---------- 2. every later sign-in: what changed, and what to do about it ---------- */
function mgoOpeningFor(){
  if(typeof mgBooksConnected === 'function' && !mgBooksConnected()) return false;
  const s = mgoState();
  if(s && s.state !== 'done') return false;
  // Accounts that started with this flow, on any books; others on Zoho Books / Odoo. Tally accounts as before.
  const tallyBooks = typeof tallyConnected !== 'undefined' && tallyConnected && !(typeof zohoConnected !== 'undefined' && zohoConnected) && !(typeof odooConnected !== 'undefined' && odooConnected);
  return !!s || !tallyBooks;
}
async function mgoOpening(since){
  const r = await mgoBooks('opening_read', { since });
  if(!r || !r.numbers || !r.numbers.since) return;
  mgoRead = r;
  const n = r.numbers, x = n.since, bits = [];
  bits.push(x.money_in > 0
    ? '<li><b>' + escapeHtml(mgoInr(x.money_in)) + ' came in:</b> ' + x.paid.slice(0, 3).map(p => escapeHtml(mgoName(p.party)) + ' ' + escapeHtml(mgoInr(p.amount)) + ' (' + escapeHtml(mgoDay(p.on)) + ')').join(', ') + (x.paid.length > 3 ? ' and ' + (x.paid.length - 3) + ' more' : '') + '.</li>'
    : '<li>No payments from customers came in.</li>');
  if(x.went_overdue > 0) bits.push('<li><b>' + escapeHtml(mgoInr(x.went_overdue)) + ' went overdue:</b> ' + x.late.slice(0, 3).map(p => escapeHtml(mgoName(p.party))).join(', ') + (x.late.length > 3 ? ' and ' + (x.late.length - 3) + ' more' : '') + '.</li>');
  if(n.due7 > 0) bits.push('<li><b>' + escapeHtml(mgoInr(n.due7)) + ' of bills</b> fall due this week (' + n.due7_list.length + ').</li>');
  else if(n.pay_overdue > 0) bits.push('<li>No bills fall due this week; ' + escapeHtml(mgoInr(n.pay_overdue)) + ' is already overdue to suppliers.</li>');
  if(n.cash != null) bits.push('<li>Cash now: ' + escapeHtml(mgoInr(n.cash)) + '.</li>');
  const acts = [];
  const late = (x.late[0] && n.late.find(g => g.party === x.late[0].party)) || n.late[0];
  if(late) acts.push('<button type="button" class="mgr-chip on" data-mgo-remind="' + escapeHtml(late.party) + '">Remind ' + escapeHtml(mgoName(late.party)) + '</button>');
  if(n.due7 > 0) acts.push('<button type="button" class="mgr-chip' + (acts.length ? '' : ' on') + '" data-mgo-pay>Send this week’s payables to my accountant</button>');
  acts.push('<button type="button" class="mgr-chip" data-mgo-show="' + (late ? 'receivables' : n.due7 > 0 ? 'payables' : 'overview') + '">Show me</button>');
  mgrHtmlLine('<p><b>In your books since ' + escapeHtml(mgoDay(x.from)) + ':</b></p><ul class="mgo-ul">' + bits.join('') + '</ul><div class="mgr-acts">' + acts.join('') + '</div>', 'greet mgo-opening');
}

/* "Remind <customer>": the reminder first, exactly as it would go. Send is the owner's tap. */
async function mgoRemindApi(party, send){
  const { data:{ session } } = await sbClient.auth.getSession();
  const r = await fetch('/api/whatsapp?action=remind-now', { method:'POST',
    headers:{ 'Content-Type':'application/json', ...(session ? { 'Authorization':'Bearer ' + session.access_token } : {}) },
    body:JSON.stringify({ party, send:!!send }) });
  const out = await r.json().catch(() => ({}));
  out._status = r.status;
  return out;
}
async function mgoRemind(party){
  mgrOpen();
  const d = await mgoRemindApi(party, false);
  if(d._status === 404 || d.error === 'not_found'){ mgrLine('margyn', d.message || ('I couldn’t find anything ' + mgoName(party) + ' owes in your books.')); return; }
  if(d._status >= 400 || !d.text){ mgrLine('margyn', d.error || 'I couldn’t prepare the reminder just now.'); return; }
  const who = mgoName(d.party);
  let html = '<p><b>Reminder to ' + escapeHtml(who) + '</b> for ' + escapeHtml(mgoInr(d.amount)) + (d.invoice_ref ? ' (' + escapeHtml(d.invoice_ref) + ')' : '') + '. This is exactly what goes on WhatsApp:</p>' +
    '<blockquote class="mgo-wa">' + escapeHtml(d.text) + '</blockquote>';
  if(d.stopped) html += '<p class="mgo-note">' + escapeHtml(d.stopped === 'stopped' ? 'You switched reminders off for ' + who + ', so I won’t send this. Turn them back on under Automations → Chasing.' : who + ' asked not to be messaged, or the number is wrong.') + '</p>';
  else if(!d.template_ready) html += '<p class="mgo-note">The WhatsApp reminder template isn’t set up on Margyn’s side yet, so I can’t send this one.</p>';
  else if(!d.has_phone) html += '<form class="mgr-name mgo-form" data-mgo-remindphone="' + escapeHtml(d.party) + '"><label>' + escapeHtml(who) + '’s WhatsApp number isn’t in your books. Add it and I’ll show the reminder again:</label><div><input type="tel" inputmode="tel" maxlength="20" placeholder="10-digit mobile"><button type="submit" class="mgr-chip on">Save number</button></div><div class="mgo-err" data-mgo-err></div></form>';
  else html += (d.sends_off ? '<p class="mgo-note">This account is in demo mode: it will be logged as “Preview: not sent” and won’t reach ' + escapeHtml(who) + '.</p>' : '') +
    '<div class="mgr-acts"><button type="button" class="mgr-chip on" data-mgo-send="' + escapeHtml(d.party) + '">Send to …' + escapeHtml(d.phone_end || '') + '</button><button type="button" class="mgr-chip ghost" data-mgo-cancel>Not now</button></div>';
  mgrHtmlLine(html, 'mgo-remind');
}
async function mgoRemindSend(btn){
  const row = btn.closest('.mgr-msg');
  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
  btn.textContent = 'Sending…';
  const d = await mgoRemindApi(btn.dataset.mgoSend, true);
  const who = mgoName(d.party || btn.dataset.mgoSend);
  if(d.sent){ btn.textContent = 'Sent'; mgrLine('margyn', 'Sent to ' + who + ' on WhatsApp. I’ll tell you here when they reply or pay.'); mgStatus('Margyn reminded ' + who, true); }
  else if(d.preview){ btn.textContent = 'Logged'; mgrLine('margyn', 'Logged as “Preview: not sent”: this account doesn’t send to customers. Nothing reached ' + who + '.'); }
  else { btn.textContent = 'Not sent'; mgrLine('margyn', 'Not sent. ' + (d.error === 'need_phone' ? 'I need ' + who + '’s WhatsApp number first.' : (d.error || 'Something went wrong.'))); }
  if(typeof loadChaseTargets === 'function') try { await loadChaseTargets(); } catch(e){}
}
/* "Send this week's payables to my accountant": the list first; WhatsApp opens with it and the owner presses send. */
function mgoPayText(){
  const n = (mgoRead && mgoRead.numbers) || {}, list = n.due7_list || [];
  const co = (currentProfile && currentProfile.company_name) || 'our business';
  return 'Bills due this week for ' + co + ' (' + list.length + ', ' + fmtINR(n.due7 || 0) + '):\n' +
    list.map((b, i) => (i + 1) + '. ' + mgoName(b.party) + (b.ref ? ' ' + b.ref : '') + ': ' + fmtINR(b.amount) + ', due ' + mgoDay(b.due)).join('\n') +
    ((n.due7_list || []).length < 10 ? '' : '\n(the 10 nearest; the full list is in Margyn under Payables)') + '\nFrom Margyn.';
}
function mgoPaySend(){
  const text = mgoPayText();
  const prevFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'mg-dialog-scrim';
  scrim.innerHTML = '<div class="mg-dialog" role="dialog" aria-modal="true" aria-labelledby="mgoPayTitle" style="width:min(560px,100%);">' +
    '<h3 id="mgoPayTitle">This week’s payables, for your accountant</h3>' +
    '<p>Margyn won’t send it by itself: open it in WhatsApp, pick your accountant and press send there, or copy it into an email.</p>' +
    '<textarea readonly class="mono" style="width:100%;height:220px;margin-top:12px;font-size:12px;line-height:1.45;padding:10px;border:1px solid var(--g200);border-radius:var(--r-ctl);background:var(--g25);resize:vertical;">' + escapeHtml(text) + '</textarea>' +
    '<div class="mg-foot"><button class="mg-btn mg-dlg-cancel" type="button">Close</button><button class="mg-btn" type="button" data-mgo-copy>Copy</button>' +
    '<button class="mg-btn primary" type="button" data-mgo-wa>Open in WhatsApp</button></div></div>';
  document.body.appendChild(scrim);
  const done = () => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if(prevFocus && prevFocus.focus) prevFocus.focus(); };
  const onKey = e => { if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); done(); } };
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', e => {
    if(e.target === scrim || e.target.closest('.mg-dlg-cancel')) return done();
    if(e.target.closest('[data-mgo-copy]')){ try { navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch(err){ scrim.querySelector('textarea').select(); } return; }
    if(e.target.closest('[data-mgo-wa]')){ window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); done(); }
  });
  scrim.querySelector('[data-mgo-wa]').focus();
}

/* ---------- hooks from the greeting (25-margyn.js mgrGreet) ---------- */
/* setup: no books yet (Margyn is leading the connect). since/quick: the last visit. */
function mgoAfterGreet(o){
  const s = mgoState();
  if(o.setup){
    // A new account: Margyn takes it from the connect onwards. An account that already has a state keeps it.
    // New means signed up in the last 30 days: an older account without books is never pulled into it.
    const age = currentUser && currentUser.created_at ? Date.now() - new Date(currentUser.created_at).getTime() : Infinity;
    if(!s && mgoOwner() && age < 30 * 86400000) mgoSet({ state:'awaiting_books', started_at:new Date().toISOString() });
    return;
  }
  if(s && s.state !== 'done'){ if(mgoOwner()) setTimeout(mgoConnected, 1500); return; }
  if(o.since && !o.quick && mgoOpeningFor()) setTimeout(() => mgoOpening(o.since), 1200);
}

document.addEventListener('click', e => {
  const sh = e.target.closest('[data-mgo-show]');
  if(sh){ e.preventDefault(); if(typeof mgrShowView === 'function') mgrShowView(sh.dataset.mgoShow); return; }
  const rm = e.target.closest('[data-mgo-remind]'); if(rm){ e.preventDefault(); mgoRemind(rm.dataset.mgoRemind); return; }
  const sd = e.target.closest('[data-mgo-send]'); if(sd){ e.preventDefault(); mgoRemindSend(sd); return; }
  if(e.target.closest('[data-mgo-cancel]')){ const row = e.target.closest('.mgr-msg'); if(row) row.querySelectorAll('button').forEach(b => { b.disabled = true; }); mgrLine('margyn', 'OK, not sent.'); return; }
  if(e.target.closest('[data-mgo-pay]')){ e.preventDefault(); mgoPaySend(); return; }
  if(e.target.closest('[data-mgo-people]')){ e.preventDefault(); if(typeof showView === 'function') showView('people'); mgrLine('margyn', 'Add them on People with the Opening Bell ticked, and they’ll get the morning briefing too.'); return; }
  const sk = e.target.closest('[data-mgo-skip]');
  if(sk){ e.preventDefault(); mgoDone(sk.closest('.mgr-msg'), sk.textContent === 'Skip' ? 'Skipped. You can set it later.' : ''); }
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-mgo-form]');
  if(f){ e.preventDefault(); await mgoAnswer(f); return; }
  const rp = e.target.closest('[data-mgo-remindphone]');
  if(rp){
    e.preventDefault();
    const err = rp.querySelector('[data-mgo-err]');
    const { digits, error } = waNormalizeMobile(rp.querySelector('input').value);
    if(error){ err.textContent = error; return; }
    try {
      const { party } = await mgEnsureParty({ name:rp.dataset.mgoRemindphone, dir:'recv', create:true, source:'margyn' });
      if(party) await mgUpdateParty(party.id, Object.assign({}, party, { phone:'+' + digits }));
    } catch(x){ err.textContent = 'Couldn’t save the number just now.'; return; }
    rp.querySelectorAll('button,input').forEach(x => { x.disabled = true; });
    mgoRemind(rp.dataset.mgoRemindphone);
  }
});
