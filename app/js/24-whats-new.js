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
const MG_WN_ACTS = { talk:{ label:'Try it now', run:() => { if(typeof openRealtimeOverlay === 'function') openRealtimeOverlay(); } } };

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
      setTimeout(() => { if(!document.querySelector('.mg-dialog-scrim') && !(typeof vxActive !== 'undefined' && vxActive)) mgWhatsNew(false); }, 1200);
    }
    return out;
  };
})();
