/* ============================================================
   TEAM LOGINS (2026-09-29; SPEC-IDENTITY-AND-SINGLE-TRUTH-2026-09-29.md)
   Several people on one account, each signing in with their own email.

   - Getting in: an owner or admin invites by email and role (Settings >
     People > App logins). The person gets a link (app.html#/join?code=...)
     or a 12-character code, signs in with that email, and is in. The link
     is remembered through sign-up and Google sign-in.
   - Recognised on every sign-in: mgResolveAccount() (called by routeFor)
     asks the server who this is (team-whoami) and picks the account they
     work in. currentUser.id becomes that ACCOUNT, so every existing query
     reads the right business; mgActor is the PERSON: name, role, what
     they may see and do.
   - Every /api call carries X-Margyn-Account; the server checks the
     membership and the role on each call (supabaseRest.accountFor), and
     the database's own row rules do the same for direct reads and writes.
     Hiding pages and buttons here is for clarity, not the protection.
   - Tailored to the person: their name and role in the top bar, only the
     pages their role allows, no edit buttons for read-only roles, their
     own Ask Margyn threads, and a switcher if they work in several
     businesses (an outside CA).
   ============================================================ */
const MG_JOIN_LS = 'margyn_join_code', MG_ACCT_LS = 'margyn_active_account';
const MG_ALL_PERMS = ['view_cash', 'view_receivables', 'view_payables', 'view_gst', 'edit', 'approve', 'manage_people', 'manage_connections'];
const MG_ROLE_INFO = {
  owner:    ['Owner', 'Everything. The account is theirs.'],
  admin:    ['Admin', 'Everything, including people and connected sources.'],
  finance:  ['Finance', 'Sees everything, adds and edits entries, approves.'],
  approver: ['Approver', 'Sees receivables and payables, approves what waits in the Inbox.'],
  viewer:   ['Viewer', 'Sees everything, changes nothing.'],
  advisor:  ['Advisor (CA)', 'An outside accountant: sees everything, changes nothing.']
};
const MG_PERM_LABEL = {
  view_cash:'See cash and payment gateways', view_receivables:'See receivables and customers', view_payables:'See payables and vendors',
  view_gst:'See GST and tax', edit:'Add and edit entries', approve:'Approve proposals', manage_people:'Manage people', manage_connections:'Connect sources'
};
// What each page needs. Pages not listed are open to everyone on the account.
const MG_PAGE_PERM = {
  cash:'view_cash', payments:'view_cash', receivables:'view_receivables', customers:'view_receivables',
  payables:'view_payables', vendors:'view_payables', gst:'view_gst', margin:'view_cash', cashflow:'view_cash', calculate:'edit', invoicing:'edit',
  connectors:'manage_connections', people:'manage_people', settings:'manage_people', channels:'view_receivables'
};

let mgMe = null;       // the team-whoami answer
let mgActor = null;    // the person signed in, in the account they're working in
let mgJoinNotice = null;

/* ---------- an invite link: keep the code before the router rewrites the URL ---------- */
function mgPendingJoin(){
  try { const v = JSON.parse(localStorage.getItem(MG_JOIN_LS) || 'null'); return v && Date.now() - v.at < 7 * 864e5 ? v.code : null; } catch(e){ return null; }
}
function mgClearJoin(){ try { localStorage.removeItem(MG_JOIN_LS); } catch(e){} }
(function(){
  const m = /[#/]join\?code=([A-Za-z0-9-]+)/.exec(location.hash || '');
  if(m){
    try { localStorage.setItem(MG_JOIN_LS, JSON.stringify({ code:decodeURIComponent(m[1]), at:Date.now() })); } catch(e){}
    try { history.replaceState(null, '', location.pathname + location.search + '#/home'); } catch(e){}
  }
  if(mgPendingJoin()){ const n = document.getElementById('authInviteNote'); if(n) n.classList.remove('hidden'); }
})();

/* ---------- every /api call says which account the person is working in ---------- */
/* The account to send with a request, or null: only our own /api, only when
   working in someone else's account, never on whoami/join (those are about
   the person, not the account). */
function mgAccountHeaderFor(url){
  const path = String(url || '').indexOf(location.origin) === 0 ? String(url).slice(location.origin.length) : String(url || '');
  if(!mgActor || mgActor.isOwner || path.indexOf('/api/') !== 0 || /action=team-(whoami|join)\b/.test(path)) return null;
  return mgActor.accountId;
}
(function(){
  const base = window.fetch.bind(window);
  window.fetch = function(input, init){
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if(mgAccountHeaderFor(url)){
        init = Object.assign({}, init || {});
        const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
        h.set('X-Margyn-Account', mgActor.accountId);
        init.headers = h;
      }
    } catch(e){}
    return base(input, init);
  };
})();

async function mgTeamApi(action, body){
  const { data:{ session } } = await sbClient.auth.getSession();
  const res = await fetch('/api/ops?action=' + action, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'Authorization':'Bearer ' + (session && session.access_token) }, body ? { 'Content-Type':'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if(!res.ok) throw Object.assign(new Error(j.error || 'Something went wrong (' + res.status + ').'), { status:res.status });
  return j;
}

function mgCan(p){ return !mgActor || mgActor.isOwner || mgActor.permissions.includes(p); }
function mgPageAllowed(page){ const need = MG_PAGE_PERM[page]; return !need || mgCan(need); }
function mgActorName(){
  if(!mgActor || mgActor.isOwner) return '';
  return mgActor.name || String(mgActor.email || '').split('@')[0];
}

/* ---------- who is this, and which account are they in? (from routeFor) ---------- */
async function mgResolveAccount(user){
  // The saved screen (30-boot-cache.js) may be on display: keep its person and access until the answer is in.
  mgJoinNotice = null;
  const code = mgPendingJoin();
  let joined = null;
  if(code){
    try { joined = await mgTeamApi('team-join', { code }); mgJoinNotice = { ok:true, text:'You’ve joined ' + (joined.company_name || 'the business') + ' as ' + joined.role_label + '.' }; }
    catch(e){ mgJoinNotice = { ok:false, text:e.message }; }
    mgClearJoin();
  }
  let me = null;
  try { me = await mgTeamApi('team-whoami'); } catch(e){ me = null; }   // no server: the login is its own account, as before
  mgMe = me;
  const mems = (mgMe && mgMe.memberships) || [];
  const own = mgMe && mgMe.own_account;
  const saved = lsGet(MG_ACCT_LS, '');
  let pick = joined ? mems.find(m => m.account_id === joined.account_id) : null;
  if(!pick && saved && saved !== user.id) pick = mems.find(m => m.account_id === saved) || null;
  if(!pick && saved !== user.id && !own && mems.length) pick = mems[0];
  if(pick){
    lsSet(MG_ACCT_LS, pick.account_id);
    mgActor = { authId:user.id, email:user.email, accountId:pick.account_id, isOwner:false, role:pick.role, roleLabel:pick.role_label,
      name:pick.name, company:pick.company_name, permissions:pick.permissions || [], prefs:Object.assign({}, pick.preferences || {}) };
  } else {
    mgActor = { authId:user.id, email:user.email, accountId:user.id, isOwner:true, role:'owner', roleLabel:'Owner', name:null,
      company:own ? own.company_name : null, permissions:MG_ALL_PERMS.slice() };
  }
  return mgActor.accountId;
}
function mgSwitchAccount(accountId){ lsSet(MG_ACCT_LS, accountId); location.hash = '#/home'; location.reload(); }

/* ---------- tailor the app to the person ---------- */
function mgApplyActor(){
  const ro = !mgCan('edit');
  document.body.classList.toggle('mg-member', !!mgActor && !mgActor.isOwner);
  document.body.classList.toggle('mg-ro', ro);
  document.querySelectorAll('.pagenav button[data-view]').forEach(b => { b.classList.toggle('mg-hide-perm', !mgPageAllowed(b.dataset.view)); });
  const role = document.getElementById('mgUserRole');
  if(role){
    const show = !!mgActor && (!mgActor.isOwner || (mgMe && mgMe.memberships && mgMe.memberships.length));
    role.classList.toggle('hidden', !show);
    if(show) role.textContent = mgActor.roleLabel + (mgActor.company ? ' · ' + mgActor.company : '') + (ro ? ' · read-only' : '');
  }
  mgRenderAcctSwitch();
  const myPh = document.getElementById('mgMyPhoneBtn');
  if(myPh) myPh.classList.toggle('hidden', !(mgActor && !mgActor.isOwner && mgMe && mgMe.features && mgMe.features.phone_link));
  if(typeof mgRenderUser === 'function') mgRenderUser();
  if(mgJoinNotice){ mgTeamToast(mgJoinNotice.text, !mgJoinNotice.ok); mgJoinNotice = null; }
  if(typeof mgMaybeAskPhone === 'function') mgMaybeAskPhone();
  // Signed in to a page this role can't see (an old link): go Home.
  const P = typeof mgCurrentView !== 'undefined' ? mgCurrentView : null;
  if(P && !mgPageAllowed(P) && typeof showView === 'function') showView('home');
}
function mgRenderAcctSwitch(){
  const host = document.getElementById('mgAcctSwitch'); if(!host) return;
  const mems = (mgMe && mgMe.memberships) || [];
  const own = mgMe && mgMe.own_account;
  const opts = (own ? [{ id:own.account_id, label:(own.company_name || 'My business'), sub:'Owner' }] : [])
    .concat(mems.map(m => ({ id:m.account_id, label:m.company_name || 'A business', sub:m.role_label })));
  if(opts.length < 2){ host.innerHTML = ''; return; }
  host.innerHTML = '<div class="mg-sep"></div><div class="mg-acct-h">Switch business</div>' + opts.map(o =>
    '<button class="mg-opt mg-acct-opt' + (mgActor && o.id === mgActor.accountId ? ' on' : '') + '" type="button" data-acct="' + escapeHtml(o.id) + '">' +
      '<span>' + escapeHtml(o.label) + '</span><small>' + escapeHtml(o.sub) + '</small></button>').join('');
  host.querySelectorAll('[data-acct]').forEach(b => b.addEventListener('click', () => { if(b.dataset.acct !== mgActor.accountId) mgSwitchAccount(b.dataset.acct); }));
}
function mgTeamToast(text, bad){
  const t = document.createElement('div');
  t.className = 'mg-team-toast' + (bad ? ' bad' : '');
  t.setAttribute('role', 'status'); t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

/* ---------- Ask Margyn: each person keeps their own threads ----------
   Needs chat_messages.author_id (the team-logins migration; whoami says
   ready). The owner's older messages have no author and stay theirs. */
function mgChatAuthorOn(){ return !!(mgMe && mgMe.ready && mgActor); }
function mgChatScope(q){
  if(!mgChatAuthorOn()) return q;
  return mgActor.isOwner ? q.or('author_id.is.null,author_id.eq.' + mgActor.authId) : q.eq('author_id', mgActor.authId);
}
function mgChatAuthor(row){ if(mgChatAuthorOn()) row.author_id = mgActor.authId; return row; }

/* ---------- joining with a code (onboarding screen, user menu) ---------- */
async function mgJoinWithCode(code){
  const j = await mgTeamApi('team-join', { code });
  lsSet(MG_ACCT_LS, j.account_id);
  mgJoinNotice = { ok:true, text:'You’ve joined ' + (j.company_name || 'the business') + ' as ' + j.role_label + '.' };
  const notice = mgJoinNotice;
  const { data:{ session } } = await sbClient.auth.getSession();
  await routeFor(session);
  if(notice && document.querySelector('.mg-team-toast') == null) mgTeamToast(notice.text);
  return j;
}
(function(){
  const tog = document.getElementById('obJoinToggle'), form = document.getElementById('obJoinForm');
  if(tog && form) tog.addEventListener('click', () => { form.classList.toggle('hidden'); const i = document.getElementById('obJoinCode'); if(i && !form.classList.contains('hidden')) i.focus(); });
  if(form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('obJoinBtn'), err = document.getElementById('obJoinError');
    err.classList.remove('show'); btn.disabled = true; btn.textContent = 'Joining…';
    try { await mgJoinWithCode(document.getElementById('obJoinCode').value); }
    catch(x){ err.textContent = x.message; err.classList.add('show'); }
    finally { btn.disabled = false; btn.textContent = 'Join'; }
  });
  const menuBtn = document.getElementById('mgJoinTeamBtn');
  if(menuBtn) menuBtn.addEventListener('click', () => {
    if(typeof mgCloseAllPops === 'function') mgCloseAllPops();
    mgDrawer({ title:'Join a team', sub:'Enter the code from your invite. Use it while signed in with the email it was sent to.',
      body:'<form class="mg-join-df" id="mgJoinDrawerForm"><label class="mg-tf"><span>Invite code</span><input class="mono" id="mgJoinDrawerCode" placeholder="ABCD-EFGH-JKLM" maxlength="20" style="text-transform:uppercase"></label>' +
        '<div class="mg-form-err" id="mgJoinDrawerErr" hidden></div></form>',
      foot:'<button class="mg-btn primary" type="button" id="mgJoinDrawerGo">Join</button>' });
    const go = document.getElementById('mgJoinDrawerGo'), err = document.getElementById('mgJoinDrawerErr');
    const run = async () => {
      err.hidden = true; go.disabled = true; go.textContent = 'Joining…';
      try { await mgJoinWithCode(document.getElementById('mgJoinDrawerCode').value); mgCloseDrawer(); }
      catch(x){ err.textContent = x.message; err.hidden = false; }
      finally { go.disabled = false; go.textContent = 'Join'; }
    };
    go.addEventListener('click', run);
    document.getElementById('mgJoinDrawerForm').addEventListener('submit', e => { e.preventDefault(); run(); });
  });
})();

/* ---------- a member's own WhatsApp number (2026-11-21) ----------
   Any team member links their own number to a business they're in, so
   Margyn on WhatsApp knows it's them. What the number may do follows the
   role the owner gave them; the server decides that (team-my-phone).
   Two ways in: initials menu > My WhatsApp number (the business they're in
   now), and a nudge after sign-in when a business they're a member of has
   books connected and their number isn't linked there yet. */
async function mgTeamApiFor(action, body, accountId){
  const { data:{ session } } = await sbClient.auth.getSession();
  const h = { 'Authorization':'Bearer ' + (session && session.access_token), 'X-Margyn-Account':accountId };
  if(body) h['Content-Type'] = 'application/json';
  const res = await fetch('/api/ops?action=' + action, { method: body ? 'POST' : 'GET', headers:h, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if(!res.ok) throw Object.assign(new Error(j.error || 'Something went wrong (' + res.status + ').'), { status:res.status });
  return j;
}
function mgPhoneCanText(perms){
  perms = perms || [];
  return perms.includes('edit') ? 'ask about the numbers, send in bills and invoices, and confirm changes'
    : perms.includes('approve') ? 'ask about the numbers and confirm approvals' : 'ask about the numbers';
}
/* The membership the person is working in now, or null (owner). */
function mgActiveMembership(){
  if(!mgActor || mgActor.isOwner) return null;
  const m = ((mgMe && mgMe.memberships) || []).find(x => x.account_id === mgActor.accountId);
  return m || { account_id:mgActor.accountId, company_name:mgActor.company, role_label:mgActor.roleLabel, permissions:mgActor.permissions };
}
async function mgOpenMyPhone(target, nudge){
  if(!target) return;
  const company = target.company_name || 'this business';
  const elsewhere = !mgActor || mgActor.accountId !== target.account_id;
  const sub = nudge
    ? 'Add your number and Margyn will message you on WhatsApp right away with ' + company + '’s latest figures' + (elsewhere ? ' (this is for ' + company + ', not your own business)' : '') + '. Reply there any time. As ' + (target.role_label || 'a team member') + ' you can ' + mgPhoneCanText(target.permissions) + '.'
    : 'Link your number and Margyn will message you on WhatsApp with ' + company + '’s latest figures, and know it’s you whenever you write. As ' + (target.role_label || 'a team member') + ' you can ' + mgPhoneCanText(target.permissions) + '.';
  mgDrawer({ title: nudge ? 'Add your WhatsApp for ' + company : 'My WhatsApp number', sub:escapeHtml(sub),
    body:'<form id="mgMyPhoneForm"><label class="mg-tf"><span>Your WhatsApp number</span><input type="tel" class="mono" id="mgMyPhoneIn" inputmode="numeric" placeholder="98765 43210"' + (nudge ? '' : ' disabled') + '></label>' +
      '<small class="mg-sub" id="mgMyPhoneHint">' + (nudge ? 'A 10-digit Indian mobile, or a full number with country code.' : 'Loading…') + '</small><div class="mg-form-err" id="mgMyPhoneErr" hidden></div></form>',
    foot:(nudge ? '<button class="mg-btn" type="button" id="mgMyPhoneLater">Not now</button>' : '<button class="mg-btn hidden" type="button" id="mgMyPhoneOff">Unlink</button>') +
      '<button class="mg-btn primary" type="button" id="mgMyPhoneGo"' + (nudge ? '' : ' disabled') + '>Save</button>' });
  const inp = document.getElementById('mgMyPhoneIn'), hint = document.getElementById('mgMyPhoneHint'),
    err = document.getElementById('mgMyPhoneErr'), go = document.getElementById('mgMyPhoneGo'), off = document.getElementById('mgMyPhoneOff');
  const later = document.getElementById('mgMyPhoneLater');
  if(later) later.addEventListener('click', () => mgCloseDrawer());
  if(!nudge){
    let now = '';
    try {
      const t = await mgTeamApiFor('team-list', null, target.account_id);
      const me = (t.members || []).find(m => m.user_id === (mgActor && mgActor.authId));
      now = (me && me.whatsapp) || '';
    } catch(e){}
    if(!document.getElementById('mgMyPhoneIn')) return;   // drawer closed meanwhile
    inp.disabled = false; go.disabled = false;
    inp.value = now ? (typeof waPrettyPhone === 'function' ? waPrettyPhone(now) : now) : '';
    off.classList.toggle('hidden', !now);
    hint.textContent = now ? 'Linked. Message Margyn from this number any time.' : 'A 10-digit Indian mobile, or a full number with country code.';
  } else { setTimeout(() => { try { inp.focus(); } catch(e){} }, 50); }
  const save = async (val) => {
    err.hidden = true; go.disabled = true; if(off) off.disabled = true; go.textContent = 'Saving…';
    try {
      const j = await mgTeamApiFor('team-my-phone', { phone:val }, target.account_id);
      const mem = ((mgMe && mgMe.memberships) || []).find(x => x.account_id === target.account_id);
      if(mem) mem.whatsapp_linked = !!j.whatsapp;
      mgCloseDrawer();
      const w = j.welcome;
      mgTeamToast(!j.whatsapp ? 'Your number is unlinked.'
        : w && w.sent ? 'Linked. Margyn has just messaged you on WhatsApp. Reply there to see the full update.'
        : w && w.reason === 'still working' ? 'Linked. Margyn’s first WhatsApp message is on its way.'
        : 'Linked to ' + company + '. Message Margyn on WhatsApp from this number any time.');
    } catch(x){ err.textContent = x.message; err.hidden = false; go.disabled = false; go.textContent = 'Save'; if(off) off.disabled = false; }
  };
  go.addEventListener('click', () => {
    if(!inp.value.replace(/[^\d]/g, '')){ err.textContent = nudge ? 'Enter your number, or press Not now.' : 'Enter your number, or press Unlink.'; err.hidden = false; return; }
    save(inp.value);
  });
  if(off) off.addEventListener('click', () => save(''));
  document.getElementById('mgMyPhoneForm').addEventListener('submit', e => { e.preventDefault(); go.click(); });
}
(function(){
  const btn = document.getElementById('mgMyPhoneBtn');
  if(btn) btn.addEventListener('click', () => {
    if(typeof mgCloseAllPops === 'function') mgCloseAllPops();
    mgOpenMyPhone(mgActiveMembership(), false);
  });
})();
/* After each sign-in: a business this person is a member of has books
   connected and their WhatsApp isn't linked there? Ask once per sign-in
   (this browser tab). The business they're in now comes first. Only when
   the server could tell (true/false, never null). */
const MG_PHONE_ASK_SS = 'margyn_phone_asked';
function mgPhoneNudgeTarget(){
  if(!mgMe || !mgMe.features || !mgMe.features.phone_link || !mgActor) return null;
  const want = m => m && m.books_connected === true && m.whatsapp_linked === false;
  const mems = mgMe.memberships || [];
  if(!mgActor.isOwner){ const here = mems.find(m => m.account_id === mgActor.accountId); return want(here) ? here : null; }
  return mems.find(want) || null;
}
/* Their own sign-up already has their WhatsApp number (the optional field at sign-up): link it to the business
   they joined without asking, and say so (21 Nov 2026). Margyn messages them straight away. Once per account per
   browser, so a failure falls back to asking, never to a loop. Returns true when it linked. */
const MG_PHONE_AUTO_LS = 'margyn_phone_auto';
async function mgAutoLinkPhone(t){
  const key = MG_PHONE_AUTO_LS + ':' + (mgActor && mgActor.authId) + ':' + t.account_id;
  try { if(localStorage.getItem(key)) return false; localStorage.setItem(key, '1'); } catch(e){ return false; }
  let own = '';
  try {
    const { data } = await sbClient.from('profiles').select('whatsapp_phone').eq('id', mgActor.authId).maybeSingle();
    own = (data && data.whatsapp_phone) || '';
  } catch(e){}
  if(!String(own).replace(/[^\d]/g, '')) return false;
  try {
    const j = await mgTeamApiFor('team-my-phone', { phone:own, auto:true }, t.account_id);
    const mem = ((mgMe && mgMe.memberships) || []).find(x => x.account_id === t.account_id);
    if(mem) mem.whatsapp_linked = !!j.whatsapp;
    const last4 = String(j.whatsapp || own).replace(/[^\d]/g, '').slice(-4);
    mgTeamToast((j.welcome && j.welcome.sent ? 'Margyn has just messaged you on WhatsApp (…' + last4 + ') for ' : 'Your WhatsApp (…' + last4 + ') is now linked to ')
      + (t.company_name || 'this business') + '. To use another number: your initials, then My WhatsApp number.');
    return true;
  } catch(e){ return false; }
}
function mgMaybeAskPhone(){
  const t = mgPhoneNudgeTarget(); if(!t) return;
  const key = MG_PHONE_ASK_SS + ':' + (mgActor && mgActor.authId) + ':' + t.account_id;
  try { if(sessionStorage.getItem(key)) return; } catch(e){}
  setTimeout(async () => {
    const t0 = mgPhoneNudgeTarget(); if(!t0 || t0.account_id !== t.account_id) return;
    if(await mgAutoLinkPhone(t0)) return;
    if(document.querySelector('.mg-drawer-scrim, .mg-dialog-scrim')) return;   // something else is open: try next sign-in
    const t2 = mgPhoneNudgeTarget(); if(!t2 || t2.account_id !== t.account_id) return;
    try { sessionStorage.setItem(key, '1'); } catch(e){}
    mgOpenMyPhone(t2, true);
  }, 2500);
}

/* ---------- Settings > People > App logins ---------- */
let mgTeamData = null, mgTeamFresh = null;
async function mgRenderTeam(reload){
  const host = document.getElementById('setTeamMount'); if(!host) return;
  if(mgMe && mgMe.ready === false){
    host.innerHTML = '<div class="set-note">Team logins switch on once the database update for them has run. Until then, only the account’s own login can sign in.</div>';
    return;
  }
  if(reload || !mgTeamData){
    host.innerHTML = '<div class="set-note">Loading…</div>';
    try { mgTeamData = await mgTeamApi('team-list'); }
    catch(e){ host.innerHTML = '<div class="set-note">' + escapeHtml(e.status === 503 ? 'Team logins switch on once the database update for them has run.' : 'Couldn’t load the team: ' + e.message) + '</div>'; return; }
  }
  const d = mgTeamData, manage = d.you.can_manage;
  const when = iso => iso ? fmtDate(iso) : 'Not yet';
  const roleSel = (cur, id) => '<select class="mg-team-role" data-team-role="' + id + '">' + Object.keys(MG_ROLE_INFO).filter(k => k !== 'owner' && (k !== 'admin' || d.you.is_owner || cur === 'admin'))
    .map(k => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + MG_ROLE_INFO[k][0] + '</option>').join('') + '</select>';
  const row = (m, isOwnerRow) => {
    const me = m.user_id === (mgActor && mgActor.authId);
    const editable = manage && !isOwnerRow && !me && (m.role !== 'admin' || d.you.is_owner);
    const wa = isOwnerRow ? '' : '<div class="mg-sub">' + (m.whatsapp ? 'WhatsApp ' + escapeHtml(typeof waPrettyPhone === 'function' ? waPrettyPhone(m.whatsapp) : m.whatsapp) : 'No WhatsApp number linked') + '</div>';
    return '<tr' + (m.status === 'suspended' ? ' class="mg-muted"' : '') + '><td><b>' + escapeHtml(m.name || (m.email || '').split('@')[0]) + (me ? ' (you)' : '') + '</b><div class="mg-sub">' + escapeHtml(m.email || '') + '</div>' + wa + '</td>' +
      '<td>' + (editable ? roleSel(m.role, m.id) : escapeHtml(m.role_label)) + '<div class="mg-sub">' + escapeHtml((MG_ROLE_INFO[m.role] || ['', ''])[1]) + '</div></td>' +
      // The owner row said "—" with no reason: say what is known (you're here now, or when they were last seen).
      '<td>' + (isOwnerRow ? escapeHtml(me ? 'Signed in now' : m.last_seen_at ? 'Last seen ' + when(m.last_seen_at) : 'Owner') : escapeHtml(m.status === 'suspended' ? 'Suspended' : m.last_seen_at ? 'Last seen ' + when(m.last_seen_at) : 'Hasn’t signed in yet')) + '</td>' +
      '<td class="r">' + (editable ? '<button class="mg-btn" type="button" data-team-access="' + m.id + '">Access</button> ' +
        '<button class="mg-btn" type="button" data-team-status="' + m.id + '" data-to="' + (m.status === 'suspended' ? 'active' : 'suspended') + '">' + (m.status === 'suspended' ? 'Restore' : 'Suspend') + '</button> ' +
        '<button class="mg-btn danger" type="button" data-team-remove="' + m.id + '">Remove</button>' : '') + '</td></tr>';
  };
  host.innerHTML =
    '<div class="set-note">People who sign in to Margyn with their own email. Each person sees and does only what their role allows, and Margyn knows who they are. WhatsApp numbers are managed in the list below.</div>' +
    '<div class="mg-gridwrap"><table class="mg-grid mg-team"><thead><tr><th>Person</th><th>Role</th><th>Activity</th><th></th></tr></thead><tbody>' +
      row(d.owner, true) + d.members.map(m => row(m, false)).join('') +
    '</tbody></table></div>' +
    (manage && d.invites.length ? '<h4 class="mg-team-h">Waiting to join</h4><div class="mg-gridwrap"><table class="mg-grid mg-team"><tbody>' + d.invites.map(i =>
      '<tr><td>' + escapeHtml(i.name ? i.name + ' · ' : '') + escapeHtml(i.email) + '</td><td>' + escapeHtml(i.role_label) + '</td><td>Code expires ' + escapeHtml(fmtDate(i.expires_at)) + '</td>' +
      '<td class="r"><button class="mg-btn" type="button" data-team-revoke="' + i.id + '">Cancel invite</button></td></tr>').join('') + '</tbody></table></div>' : '') +
    (mgTeamFresh ? '<div class="mg-team-code" role="status"><div><b>Invite ready for ' + escapeHtml(mgTeamFresh.email) + '</b> as ' + escapeHtml(mgTeamFresh.role_label) + '. ' +
        escapeHtml(mgTeamFresh.emailed ? 'We’ve emailed it to them. ' : 'Send them this link or code. ') + 'It works once, for 7 days, and only with that email. It won’t be shown again.</div>' +
        '<div class="mg-team-code-v mono">' + escapeHtml(mgTeamFresh.code) + '</div>' +
        '<div class="mg-team-code-a"><button class="mg-btn" type="button" data-team-copy="link">Copy link</button><button class="mg-btn" type="button" data-team-copy="code">Copy code</button><button class="mg-btn" type="button" data-team-copy="done">Done</button></div></div>' : '') +
    (manage ? '<form class="mg-team-invite" id="mgTeamInvite"><h4 class="mg-team-h">Invite someone</h4>' +
      '<div class="mg-team-fields"><label class="mg-tf"><span>Email</span><input type="email" id="mgTeamEmail" required placeholder="name@company.com"></label>' +
      '<label class="mg-tf"><span>Name</span><input type="text" id="mgTeamName" placeholder="Priya Mehta"></label>' +
      '<label class="mg-tf"><span>Role</span>' + roleSel('finance', 'new').replace('data-team-role="new"', 'id="mgTeamRole"') + '</label></div>' +
      '<div class="mg-sub" id="mgTeamRoleDesc">' + escapeHtml(MG_ROLE_INFO.finance[1]) + '</div>' +
      '<div class="mg-form-err" id="mgTeamErr" hidden></div>' +
      '<button class="mg-btn primary" type="submit" id="mgTeamGo">Create invite</button></form>' : '');

  const act = async (fn, btn) => { if(btn) btn.disabled = true; try { await fn(); await mgRenderTeam(true); } catch(e){ mgTeamToast(e.message, true); if(btn) btn.disabled = false; } };
  host.querySelectorAll('select[data-team-role]').forEach(s => s.addEventListener('change', () => act(() => mgTeamApi('team-update', { member_id:s.dataset.teamRole, role:s.value }))));
  host.querySelectorAll('[data-team-status]').forEach(b => b.addEventListener('click', () => act(() => mgTeamApi('team-update', { member_id:b.dataset.teamStatus, status:b.dataset.to }), b)));
  host.querySelectorAll('[data-team-revoke]').forEach(b => b.addEventListener('click', () => act(() => mgTeamApi('team-revoke', { invite_id:b.dataset.teamRevoke }), b)));
  host.querySelectorAll('[data-team-remove]').forEach(b => b.addEventListener('click', async () => {
    const m = d.members.find(x => x.id === b.dataset.teamRemove);
    if(!(await mgConfirm({ title:'Remove ' + (m.name || m.email) + '?', body:'They lose access straight away. Their past activity stays in the audit log. You can invite them again later.', confirmLabel:'Remove', danger:true }))) return;
    act(() => mgTeamApi('team-remove', { member_id:m.id }), b);
  }));
  host.querySelectorAll('[data-team-access]').forEach(b => b.addEventListener('click', () => mgTeamAccessDrawer(d.members.find(x => x.id === b.dataset.teamAccess))));
  host.querySelectorAll('[data-team-copy]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.teamCopy;
    if(k === 'done'){ mgTeamFresh = null; mgRenderTeam(false); return; }
    try { navigator.clipboard.writeText(k === 'link' ? mgTeamFresh.link : mgTeamFresh.code); b.textContent = 'Copied'; } catch(e){}
  }));
  const f = document.getElementById('mgTeamInvite');
  if(f){
    const sel = document.getElementById('mgTeamRole');
    sel.addEventListener('change', () => { document.getElementById('mgTeamRoleDesc').textContent = MG_ROLE_INFO[sel.value][1]; });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const go = document.getElementById('mgTeamGo'), err = document.getElementById('mgTeamErr');
      err.hidden = true; go.disabled = true; go.textContent = 'Creating…';
      try {
        mgTeamFresh = await mgTeamApi('team-invite', { email:document.getElementById('mgTeamEmail').value, name:document.getElementById('mgTeamName').value, role:sel.value });
        await mgRenderTeam(true);
      } catch(x){ err.textContent = x.message; err.hidden = false; go.disabled = false; go.textContent = 'Create invite'; }
    });
  }
}
/* One person's access: their role's defaults, with switches to turn any on or off. */
function mgTeamAccessDrawer(m){
  if(!m) return;
  const def = new Set((MG_ROLE_DEFAULTS[m.role] || []));
  const canLink = !!(mgMe && mgMe.features && mgMe.features.phone_link);
  const phoneNow = m.whatsapp ? (typeof waPrettyPhone === 'function' ? waPrettyPhone(m.whatsapp) : m.whatsapp) : '';
  mgDrawer({ title:'Access for ' + (m.name || m.email), sub:escapeHtml(MG_ROLE_INFO[m.role][0] + ': ' + MG_ROLE_INFO[m.role][1] + ' Change any of these for this person only.'),
    body:(canLink ? '<label class="mg-tf mg-team-wa"><span>WhatsApp number</span><input type="tel" class="mono" id="mgTeamPhone" inputmode="numeric" placeholder="98765 43210" value="' + escapeHtml(phoneNow) + '">' +
        '<small class="mg-sub">Margyn will recognise this number as ' + escapeHtml(m.name || m.email) + ' and give it the same access on WhatsApp. Leave empty to unlink.</small></label>' : '') +
      '<div class="mg-team-perms">' + MG_ALL_PERMS.map(p => {
      const on = m.permissions.includes(p), changed = on !== def.has(p);
      return '<label class="set-row"><span>' + escapeHtml(MG_PERM_LABEL[p]) + (changed ? '<span class="set-desc">Changed from the role’s default</span>' : '') + '</span>' +
        '<label class="rd-toggle"><input type="checkbox" data-perm="' + p + '"' + (on ? ' checked' : '') + '><span class="track"></span></label></label>';
    }).join('') + '</div><div class="mg-form-err" id="mgTeamPermErr" hidden></div>',
    foot:'<button class="mg-btn" type="button" id="mgTeamPermReset">Back to role defaults</button><button class="mg-btn primary" type="button" id="mgTeamPermSave">Save</button>' });
  const save = async overrides => {
    const norm = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
    const body = { member_id:m.id };
    if(norm(overrides) !== norm(m.overrides)) body.permissions = overrides;
    const ph = document.getElementById('mgTeamPhone');
    if(ph && ph.value.replace(/[^\d]/g, '') !== String(phoneNow).replace(/[^\d]/g, '')) body.phone = ph.value;
    if(Object.keys(body).length === 1){ mgCloseDrawer(); return; }   // nothing changed
    try { await mgTeamApi('team-update', body); mgCloseDrawer(); mgRenderTeam(true); }
    catch(e){ const x = document.getElementById('mgTeamPermErr'); x.textContent = e.message; x.hidden = false; }
  };
  document.getElementById('mgTeamPermReset').addEventListener('click', () => save({}));
  document.getElementById('mgTeamPermSave').addEventListener('click', () => {
    const o = {};
    document.querySelectorAll('.mg-team-perms [data-perm]').forEach(i => { if(i.checked !== def.has(i.dataset.perm)) o[i.dataset.perm] = i.checked; });
    save(o);
  });
}
// Mirror of api/_lib/teamAccess.js ROLE_DEFAULTS, for showing what's changed.
const MG_ROLE_DEFAULTS = {
  admin: MG_ALL_PERMS, finance:['view_cash', 'view_receivables', 'view_payables', 'view_gst', 'edit', 'approve'],
  approver:['view_receivables', 'view_payables', 'approve'], viewer:['view_cash', 'view_receivables', 'view_payables', 'view_gst'],
  advisor:['view_cash', 'view_receivables', 'view_payables', 'view_gst']
};
