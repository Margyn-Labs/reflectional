/* ============================================================
   WHAT'S NEW — a card that floats over the app after each release and
   says what shipped and exactly how to use it.

   EVERY RELEASE THAT CHANGES SOMETHING A USER CAN SEE ADDS AN ENTRY AT THE
   TOP OF MG_RELEASES (newest first). The id must be new; that is what makes
   the card appear once for everyone. Write for the business owner, not for
   us: what it does for them, then how to use it (the exact words to say,
   the key to press, the page to open).

   Seen-state is saved on the account (profiles.preferences.whats_new_seen)
   so it doesn't come back on another device, with a localStorage copy for
   accounts without the preferences column. A first-time account sees only
   the newest release; after that, everything released since their last
   visit (up to three). Reopen any time from the search palette: "What's new".
   ============================================================ */
const MG_RELEASES = [
  {
    id:'2026-09-30-one-margyn', date:'30 Sept 2026', title:'One Margyn, in one place',
    items:[
      { t:'The Margyn panel', what:'Margyn now sits on the right of every page. Type or talk in the same conversation, and whatever Margyn shows you (your P&L, who owes you, cash, a customer) appears right there, without leaving your page.',
        how:'Press <kbd>⌘</kbd> <kbd>J</kbd> (or <kbd>Ctrl</kbd> <kbd>J</kbd>), or choose <b>Margyn</b> in the top bar. Press <b>Talk</b> to speak instead of typing.', act:'panel' },
      { t:'Margyn can do more when you type', what:'Typed questions now get everything a call could do: open a page, draw a view, filter a list, open a customer, fill in and save a form, sync a source. You see each step as Margyn does it.',
        how:'Type “show me who owes us more than 60 days” or “add a vendor called Gupta Packaging”.' },
      { t:'Margyn says hello, and speaks up', what:'When you come back, Margyn tells you what happened while you were away and what needs you. If something goes wrong (a source stops syncing, cash is heading below your floor, a customer passes 60 days), Margyn tells you, at most a few times a day.',
        how:'Nothing to do. Choose <b>Later</b> on a note and Margyn won’t repeat it for a day. Set what Margyn calls you under <b>Profile</b>.' },
      { t:'Home is Margyn’s desk', what:'Home opens with Margyn’s read of the business, what it runs on its own, what needs your OK and what it’s working on. Your figures follow below.',
        how:'Open <b>Home</b>. Tap anything under “What I’m working on” to ask about it.' },
      { t:'One Margyn, not several bots', what:'Payment reminders, reconciliation and reading forwarded documents are all Margyn’s work now, with one voice. The old agent threads are under <b>Conversations</b>, and the background work is under <b>Automations</b>.',
        how:'Open <b>Conversations</b> to reread anything, then choose <b>Continue in Margyn</b>.' }
    ]
  },
  {
    id:'2026-09-30-channel-health', date:'30 Sept 2026', title:'See which messages are actually reaching people',
    items:[
      { t:'Channel health', what:'A new page shows whether your Opening and Closing Bell, payment chases and the CFO pack email are delivering. A message template WhatsApp hasn’t approved used to fail without a word; now it shows as not delivering, with the reason, and appears in your notifications.',
        how:'Open Channel health under Admin in the left menu, or press ⌘K and type “channel health”.' },
      { t:'Paid after Margyn chased', what:'The same page adds up the invoices that closed as paid after Margyn had chased them, and shows what is still being chased and what customers have promised.',
        how:'Open Channel health. It counts payments that followed a chase; it can’t prove the customer wouldn’t have paid anyway.' }
    ]
  },
  {
    id:'2026-09-30-open-items', date:'30 Sept 2026', title:'Receivables and payables count only what’s really open',
    items:[
      { t:'Drafts, voided and cancelled invoices no longer count', what:'A Zoho draft or voided invoice, or an Odoo draft or cancelled one, isn’t money anyone owes. They’re now left out of Receivables, Payables, the forecast, Ask Margyn and WhatsApp.',
        how:'Nothing to do. If a total went down today, this is why. They still show in Zoho or Odoo themselves.' },
      { t:'Deleted in Odoo, closed in Margyn', what:'An invoice or bill deleted in Odoo is now closed in Margyn on the next sync, the way Zoho and Tally already work. Its original amount stays on record.',
        how:'Nothing to do. It happens with the nightly Odoo sync.' }
    ]
  },
  {
    id:'2026-09-30-team-who', date:'30 Sept 2026', title:'See who did what, on every channel',
    items:[
      { t:'The Audit log names the person', what:'Every entry that’s added, settled or imported, and every change to your team, now shows who did it and whether it was in the app, by voice or on WhatsApp.',
        how:'Open <b>Audit log</b> under Admin. Search a name to see everything that person changed.' },
      { t:'One person, app and WhatsApp', what:'Link someone’s WhatsApp number to their login and Margyn treats them the same on both: a Viewer can ask on WhatsApp but not change anything, an Approver can approve.',
        how:'<b>Settings</b>, then <b>App logins</b>. Choose <b>Access</b> next to the person and enter their WhatsApp number.', act:'team' },
      { t:'Your own view', what:'People on your team can adjust their own forecast and metric choices without changing yours.',
        how:'Nothing to do. Your settings stay the business’s defaults.' }
    ]
  },
  {
    id:'2026-09-29-team-logins', date:'29 Sept 2026', title:'Your team can now sign in as themselves',
    items:[
      { t:'Invite your team', what:'Your finance lead, an approver or your CA can each have their own login. Margyn knows who is signed in and shows each person only what their role allows.',
        how:'Open <b>Settings</b>, then <b>App logins</b>. Enter their email, pick a role and choose <b>Create invite</b>. Send them the link or the code.', act:'team' },
      { t:'Joining with a code', what:'The person signs in with the email the invite was sent to and goes straight into your business.',
        how:'Open the link, or after signing in choose your initials at the top right, then <b>Join a team with a code</b>.' },
      { t:'Roles you can fine-tune', what:'Admin, Finance, Approver, Viewer and Advisor (CA). Turn any single permission on or off for one person, or suspend them in a click.',
        how:'In <b>App logins</b>, choose <b>Access</b> next to the person.' },
      { t:'Every open invoice, counted', what:'Receivables, Payables, Customers and Vendors now count every open invoice from Zoho, Tally and Odoo, not the first few hundred. Ask Margyn and WhatsApp use the same figures as the screen.',
        how:'Nothing to do. If a source is ever too large or can’t be read, the page says so in a line above the list.' }
    ]
  },
  {
    id:'2026-09-27-voice-keys', date:'27 Sept 2026', title:'Talking to Margyn got faster and more hands-free',
    items:[
      { t:'Start and end a call from the keyboard', what:'Talk to Margyn from anywhere in the app without reaching for the mouse.',
        how:'Press <kbd>⌥</kbd> <kbd>M</kbd> (or <kbd>Ctrl</kbd> <kbd>M</kbd>) to start. Press it again, or <kbd>Esc</kbd>, to end the call.', act:'talk' },
      { t:'Say goodbye and the call ends', what:'No need to find the End button.',
        how:'Say “Thank you, that’s all”, “Okay, that was it” or “End the conversation”.' },
      { t:'Margyn fills in and saves forms for you', what:'New customers, new vendors and ledger entries can be done start to finish by voice.',
        how:'Say “Add a vendor called Sanjay Pandey, phone 98565 25560”, then “Save it”.' },
      { t:'Connector status in a second', what:'Ask whether a source is working and hear when it last synced. When a sync finishes, Margyn tells you without being asked.',
        how:'Say “Is my Zoho connector working?” or “Sync Zoho”.' },
      { t:'A tidier workspace', what:'The floating workspace clears when you move to another page, and a change you’ve approved leaves after a few seconds.',
        how:'Nothing to do. Say “Clear the workspace” to empty it any time.' },
      { t:'CFO pack summaries match the pack', what:'A summary of the CFO pack now uses the month on screen, so every figure matches the pack.',
        how:'Open the CFO pack and say “Summarise this”.' }
    ]
  }
];
const MG_WN_KEY = 'whats_new_seen', MG_WN_LS = 'margyn_whats_new_seen';
const MG_WN_ACTS = {
  panel:{ label:'Open Margyn', run:() => { if(typeof mgrOpen === 'function') mgrOpen(true); } },
  talk:{ label:'Try it now', run:() => { if(typeof openRealtimeOverlay === 'function') openRealtimeOverlay(); } },
  team:{ label:'Invite someone', run:() => { if(typeof showView === 'function') showView('settings'); setTimeout(() => { const m = document.getElementById('setTeamMount'); if(m) m.scrollIntoView({ block:'start' }); }, 120); } }
};

function mgWnSeen(){
  let v = null;
  try { v = typeof mgPrefGet === 'function' ? mgPrefGet(MG_WN_KEY, null) : null; } catch(e){}
  if(!v){ try { v = localStorage.getItem(MG_WN_LS); } catch(e){} }
  return v || null;
}
function mgWnMarkSeen(id){
  try { localStorage.setItem(MG_WN_LS, id); } catch(e){}
  try { if(typeof mgPrefOn === 'function' && mgPrefOn()) mgPrefSet(MG_WN_KEY, id); } catch(e){}
}
/* Releases the user hasn't seen, newest first. */
function mgWnUnseen(){
  const seen = mgWnSeen();
  if(!seen) return MG_RELEASES.slice(0, 1);
  const i = MG_RELEASES.findIndex(r => r.id === seen);
  return (i < 0 ? MG_RELEASES.slice(0, 1) : MG_RELEASES.slice(0, i)).slice(0, 3);
}

/* force: open from the palette even when everything has been seen. */
function mgWhatsNew(force){
  if(document.querySelector('.mg-wn-scrim')) return;
  const list = force ? MG_RELEASES.slice(0, 1) : mgWnUnseen();
  if(!list.length) return;
  const items = list.flatMap(r => r.items);
  const head = list[0];
  const prevFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'mg-wn-scrim';
  scrim.innerHTML =
    '<div class="mg-wn" role="dialog" aria-modal="true" aria-labelledby="mgWnTitle">' +
      '<div class="mg-wn-h"><div class="mg-wn-kicker">What’s new · ' + escapeHtml(head.date) + '</div>' +
        '<h3 id="mgWnTitle">' + escapeHtml(head.title) + '</h3>' +
        '<p>' + (list.length > 1 ? escapeHtml(list.length + ' updates since you were last here.') : 'Here’s what changed and how to use it.') + '</p></div>' +
      '<div class="mg-wn-list">' + items.map((it, i) =>
        '<div class="mg-wn-item"><div class="mg-wn-n">' + (i + 1) + '</div><div>' +
          '<b>' + escapeHtml(it.t) + '</b><div class="what">' + escapeHtml(it.what) + '</div>' +
          '<div class="how"><span>How</span>' + it.how + '</div>' +   // `how` is our own copy above; it carries <kbd> markup
          (it.act && MG_WN_ACTS[it.act] ? '<button type="button" class="mg-btn" data-wn-act="' + it.act + '">' + escapeHtml(MG_WN_ACTS[it.act].label) + '</button>' : '') +
        '</div></div>').join('') + '</div>' +
      '<div class="mg-wn-f"><small>Find this again: search “What’s new”.</small><button type="button" class="mg-btn primary" data-wn-ok>Got it</button></div>' +
    '</div>';
  document.body.appendChild(scrim);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    mgWnMarkSeen(MG_RELEASES[0].id);
    if(prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch(e){}
  };
  const onKey = e => { if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', e => {
    const a = e.target.closest('[data-wn-act]');
    if(a){ close(); MG_WN_ACTS[a.dataset.wnAct].run(); return; }
    if(e.target === scrim || e.target.closest('[data-wn-ok]')) close();
  });
  scrim.querySelector('[data-wn-ok]').focus();
  if(typeof mtrack === 'function') mtrack('whats_new_shown', { release:MG_RELEASES[0].id, forced:!!force });
}

/* Once the app has loaded for a signed-in user, show anything new. Waits a
   beat so it lands on a drawn page, and never on top of another dialog. */
(function(){
  let checked = false;
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    if(!checked && typeof currentUser !== 'undefined' && currentUser){
      checked = true;
      // Margyn's greeting (25-margyn.js) announces what's new in the panel
      // now, with a button for this card; it only pops up on its own without it.
      if(typeof mgrGreet !== 'function') setTimeout(() => { if(!document.querySelector('.mg-dialog-scrim') && !(typeof vxActive !== 'undefined' && vxActive)) mgWhatsNew(false); }, 1200);
    }
    return out;
  };
})();
