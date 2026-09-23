/* ============================================================
   PEOPLE ON THIS ACCOUNT (2026-09-23)
   One list, two mounts (Settings > People and the Profile page), backed by
   business_stakeholders — the same rows as the Bell's AR/AP routing list,
   so a person is added once and shows up everywhere.

   Per-number access lives in business_stakeholders.permissions and is
   enforced server-side by api/_lib/memberAccess.js:
     ask / act / forward / opening_bell / closing_bell
   whatsapp_access is kept = ask || forward ("can send things in"); the
   webhook's one-account-per-number index keys on it.

   The primary number (profiles.whatsapp_phone) always has ask/act/forward.
   Its Bell chips read and write the Bell agent's config.frequency, so the
   Agents tab and this list can never disagree.
   ============================================================ */
const PEOPLE_ROLE_LABEL = { owner:'Owner', AR:'Receivables (AR)', AP:'Payables (AP)', finance:'Finance', other:'Other' };
const PEOPLE_PERMS = [
  { key:'ask',          label:'Ask',           desc:'Ask Margyn about the numbers' },
  { key:'act',          label:'Act',           desc:'Confirm changes Margyn proposes (mark paid, approve). Needs Ask' },
  { key:'forward',      label:'Forward',       desc:'Forward invoices and bills to import' },
  { key:'opening_bell', label:'Opening Bell',  desc:'Morning briefing', bell:true },
  { key:'closing_bell', label:'Closing Bell',  desc:'Evening briefing', bell:true }
];
/* What a new person starts with, by role. Bells always start off: they need
   the person's consent first. */
const PEOPLE_ROLE_DEFAULTS = {
  owner:   { ask:true, act:true,  forward:true },
  AR:      { ask:true, act:false, forward:true },
  AP:      { ask:true, act:false, forward:true },
  finance: { ask:true, act:false, forward:true },
  other:   {}
};
let peopleEditingId = null;

function lsGetStr(k){ try { return localStorage.getItem(k) || ''; } catch(e){ return ''; } }

/* Mirrors api/_lib/memberAccess.js memberPerms(). */
function peoplePerms(p){
  if(!p) return {};
  if(p.is_primary){
    const f = peopleBellFrequency();
    return { ask:true, act:true, forward:true, opening_bell: f === 'both' || f === 'opening', closing_bell: f === 'both' || f === 'closing' };
  }
  const raw = (p.permissions && typeof p.permissions === 'object') ? p.permissions : {};
  if(!PEOPLE_PERMS.some(x => x.key in raw)) return p.whatsapp_access ? { ask:true, act:true, forward:true } : {};
  return { ask:!!raw.ask, act:!!raw.ask && !!raw.act, forward:!!raw.forward, opening_bell:!!raw.opening_bell, closing_bell:!!raw.closing_bell };
}
function peopleBellDeployed(){
  const d = agentDeployments && agentDeployments['whatsapp_bell'];
  return !!(d && d.status === 'active');
}
/* The primary number's Bells = the Bell agent's frequency. No deployment
   means no Bells to anyone yet. */
function peopleBellFrequency(){
  const d = agentDeployments && agentDeployments['whatsapp_bell'];
  if(!d || d.status !== 'active') return 'none';
  return (d.config && d.config.frequency) || 'both';
}
function peopleInitials(name){
  const parts = String(name || '?').replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length-1][0] : '')).toUpperCase();
}
function peopleAgo(iso){
  if(!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  const h = Math.round(mins / 60); if(h < 24) return h + 'h ago';
  const d = Math.round(h / 24); if(d < 30) return d + 'd ago';
  return fmtDay(iso);
}
/* Supabase errors -> something a founder can act on. */
function peopleErr(e){
  const code = e && e.code, msg = (e && e.message) || '';
  if(code === '23505' && /access_phone/.test(msg)) return 'That number can already send things to Margyn on another account. It can still get the Bells here.';
  if(code === '23505' && /one_primary/.test(msg)) return 'This account already has a primary number.';
  if(code === '42703' || code === 'PGRST204' || /column .* does not exist|schema cache/i.test(msg)) return 'People settings are still being switched on for your account. Try again in a few minutes.';
  return msg || 'Could not save.';
}

async function loadPeople(){
  if(!currentUser) return agentStakeholders;
  const [ppl, dep] = await Promise.all([
    sbClient.from('business_stakeholders').select('*').eq('business_id', currentUser.id).order('created_at', { ascending:true }),
    sbClient.from('agent_deployments').select('*').eq('user_id', currentUser.id).eq('agent_id', 'whatsapp_bell').maybeSingle()
  ]);
  if(ppl.error) console.error('[margyn] loadPeople:', ppl.error);
  else agentStakeholders = ppl.data || [];
  if(!dep.error && dep.data) agentDeployments['whatsapp_bell'] = dep.data;
  return agentStakeholders;
}

/* The account's primary WhatsApp number + the name behind it. Keeps
   profiles.whatsapp_phone (what the webhook and the Bell crons key on) and
   the primary people row in step. Throws on failure; callers decide. */
async function savePrimaryPerson(name, digits){
  if(!currentUser) return;
  if(!agentStakeholders.length) await loadPeople();
  if(currentProfile && currentProfile.whatsapp_phone !== digits){
    const { error: pErr } = await sbClient.from('profiles').update({ whatsapp_phone: digits }).eq('id', currentUser.id);
    if(pErr) throw pErr;
    currentProfile.whatsapp_phone = digits;
  }
  const prim = agentStakeholders.find(p => p.is_primary);
  // Someone already on the list with this number becomes the primary row
  // rather than a second row for the same person.
  const same = !prim && agentStakeholders.find(p => p.phone === digits);
  const target = prim || same;
  const patch = { name: name || (target && target.name) || 'Owner', phone: digits, is_primary: true };
  if(target){
    if(same){ patch.whatsapp_access = false; if(same.role !== 'owner') patch.role = 'owner'; }
    const { data, error } = await sbClient.from('business_stakeholders').update(patch).eq('id', target.id).select().single();
    if(error) throw error;
    agentStakeholders = agentStakeholders.map(p => p.id === target.id ? data : p);
  } else {
    const { data, error } = await sbClient.from('business_stakeholders')
      .insert({ business_id: currentUser.id, role: 'owner', whatsapp_access: false, ...patch }).select().single();
    if(error) throw error;
    agentStakeholders.push(data);
  }
  renderPeopleMounts();
}

/* Chip row. `perms` = current access; `lockCore` greys out ask/act/forward
   (the primary number always has them). */
function peopleChipsHtml(perms, opts){
  opts = opts || {};
  return '<div class="ppl-perms">' + PEOPLE_PERMS.map(x => {
    const on = !!perms[x.key];
    const locked = opts.lockCore && !x.bell;
    const dim = x.key === 'act' && !perms.ask;
    return '<button type="button" class="ppl-chip' + (on ? ' on' : '') + (x.bell ? ' bell' : '') + (dim ? ' dim' : '') + '"' +
      ' data-perm="' + x.key + '" aria-pressed="' + on + '"' + (locked ? ' disabled' : '') +
      ' title="' + escapeHtml(locked ? 'The primary number always has this' : x.desc) + '">' +
      (x.bell ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>' : '') +
      escapeHtml(x.label) + '</button>';
  }).join('') + '</div>';
}

function peopleRowHtml(p){
  const perms = peoplePerms(p);
  const any = PEOPLE_PERMS.some(x => perms[x.key]);
  if(peopleEditingId === p.id){
    const roleOpts = Object.keys(PEOPLE_ROLE_LABEL).map(r =>
      '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' + PEOPLE_ROLE_LABEL[r] + '</option>').join('');
    return '<div class="ppl-row" data-pid="' + p.id + '">' +
      '<div class="ppl-av' + (any ? ' on' : '') + '">' + escapeHtml(peopleInitials(p.name)) + '</div>' +
      '<div class="ppl-edit" style="grid-column:2 / 5;">' +
        '<input class="ppl-in" data-f="name" value="' + escapeHtml(p.name === 'Owner' && p.is_primary ? '' : p.name) + '" placeholder="Full name">' +
        '<input class="ppl-in mono" data-f="phone" inputmode="numeric" value="' + escapeHtml(waPrettyPhone(p.phone)) + '"' + (p.is_primary ? ' disabled title="Change the primary number from the WhatsApp Bell agent"' : '') + '>' +
        '<select class="ppl-in" data-f="role">' + roleOpts + '</select>' +
      '</div>' +
      '<div class="ppl-ctl"><button class="ppl-link" data-act="cancel">Cancel</button><button class="btn-primary" data-act="save" style="padding:8px 14px; font-size:12.5px;">Save</button></div>' +
    '</div>';
  }
  const tag = p.is_primary ? '<span class="rd-tag ok">Primary</span>' : (any ? '' : '<span class="rd-tag">Routing only</span>');
  const n = Number(p.message_count) || 0;
  const act = p.last_message_at
    ? '<b>' + n + '</b> message' + (n === 1 ? '' : 's') + '<br>Last ' + escapeHtml(peopleAgo(p.last_message_at))
    : ((perms.ask || perms.forward) ? 'No messages yet' : (any ? 'Bells only' : 'Gets routed messages only'));
  const needsName = p.is_primary && (!p.name || p.name === 'Owner');
  return '<div class="ppl-row" data-pid="' + p.id + '">' +
    '<div class="ppl-av' + (any ? ' on' : '') + '">' + escapeHtml(peopleInitials(needsName ? '?' : p.name)) + '</div>' +
    '<div><div class="ppl-name"><span class="nm">' + (needsName ? '<button class="ppl-link" data-act="edit" style="font-size:13.5px; color:var(--emerald);">Add your name</button>' : escapeHtml(p.name)) + '</span>' + tag + '</div>' +
      '<span class="ppl-role">' + escapeHtml(PEOPLE_ROLE_LABEL[p.role] || p.role) + '</span></div>' +
    '<div class="ppl-phone">' + escapeHtml(waPrettyPhone(p.phone)) + '</div>' +
    '<div class="ppl-act">' + act + '</div>' +
    '<div class="ppl-ctl">' +
      '<button class="ppl-link" data-act="edit">Edit</button>' +
      (p.is_primary ? '' : '<button class="ppl-link bad" data-act="remove">Remove</button>') +
    '</div>' +
    '<div class="ppl-perm-line">' + peopleChipsHtml(perms, { lockCore: p.is_primary }) + '</div>' +
  '</div>';
}

function peopleBlockHtml(){
  const list = agentStakeholders.slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
  const permsOf = list.map(peoplePerms);
  const canAsk = permsOf.filter(x => x.ask).length;
  const onBells = permsOf.filter(x => x.opening_bell || x.closing_bell).length;
  const weekAgo = Date.now() - 7 * 86400000;
  const activeWeek = list.filter(p => p.last_message_at && new Date(p.last_message_at).getTime() >= weekAgo).length;
  const msgs = list.reduce((t, p) => t + (Number(p.message_count) || 0), 0);
  const hasPrimary = list.some(p => p.is_primary);
  const primPhone = currentProfile && currentProfile.whatsapp_phone;

  let html = '<div class="ppl-summary">' +
    '<div><b>' + canAsk + '</b>Can ask Margyn</div>' +
    '<div><b>' + onBells + '</b>Get a Bell</div>' +
    '<div><b>' + activeWeek + '</b>Active this week</div>' +
    '<div><b>' + msgs + '</b>Messages to Margyn</div>' +
  '</div>';

  if(!peopleBellDeployed() && list.length){
    html += '<div class="ppl-banner">Bells go out once the WhatsApp Bell agent is deployed. You can set who gets them now. <button class="ppl-link" data-act="go-bell" style="color:var(--emerald);">Deploy the Bell</button></div>';
  }

  if(!hasPrimary){
    html += '<div class="ppl-note">' + (primPhone
      ? 'Your primary WhatsApp number <span class="mono">' + escapeHtml(waPrettyPhone(primPhone)) + '</span> has no name on it yet, so Margyn doesn\'t know who is texting.'
      : 'No primary WhatsApp number yet. Add yours so Margyn recognises you when you message it.') + '</div>' +
      '<div class="ppl-add-grid" style="padding-bottom:14px;">' +
        '<input class="ppl-in" data-prim="name" placeholder="Your name" value="' + escapeHtml(lsGetStr('margyn_owner_name')) + '">' +
        '<input class="ppl-in mono" data-prim="phone" inputmode="numeric" placeholder="98765 43210" value="' + escapeHtml(primPhone ? waPrettyPhone(primPhone) : '') + '">' +
        '<span></span>' +
        '<button class="btn-primary" data-act="save-primary" style="padding:9px 16px; font-size:12.5px;">Save</button>' +
      '</div><div class="note bad" data-err="prim" style="padding-bottom:10px;"></div>';
  }

  html += list.map(peopleRowHtml).join('');
  if(!list.length) html += '<div class="ppl-note">Nobody added yet.</div>';

  html += '<div class="ppl-add">' +
    '<div class="ppl-add-h">Add a person</div>' +
    '<div class="ppl-add-grid">' +
      '<input class="ppl-in" data-new="name" placeholder="Full name">' +
      '<input class="ppl-in mono" data-new="phone" inputmode="numeric" placeholder="WhatsApp number">' +
      '<select class="ppl-in" data-new="role">' + Object.keys(PEOPLE_ROLE_LABEL).map(r => '<option value="' + r + '">' + PEOPLE_ROLE_LABEL[r] + '</option>').join('') + '</select>' +
      '<button class="btn-primary" data-act="add" style="padding:9px 16px; font-size:12.5px;">Add</button>' +
    '</div>' +
    '<div class="ppl-add-perms"><span class="ppl-add-lbl">Access</span>' + peopleChipsHtml(PEOPLE_ROLE_DEFAULTS.owner) + '</div>' +
    '<label class="ppl-check hidden" data-new-consent><input type="checkbox" data-new="consent"> They\'ve agreed to get WhatsApp briefings from Margyn on this number</label>' +
    '<span class="note bad" data-err="add"></span>' +
    '<div class="ppl-note"><b>Ask</b> lets them see this business\'s numbers on WhatsApp. <b>Act</b> lets them confirm changes like marking a bill paid. <b>Forward</b> lets them send in invoices and bills. The Bells go to anyone you tick. 10-digit Indian mobiles get +91 automatically.</div>' +
  '</div>';
  return html;
}

function renderPeopleMounts(reload){
  const hosts = ['setPeopleMount', 'pfPeopleMount'].map(id => document.getElementById(id)).filter(Boolean);
  if(!hosts.length) return;
  if(reload){
    hosts.forEach(h => { if(!h.innerHTML) h.innerHTML = '<div class="ppl-note">Loading people…</div>'; });
    loadPeople().then(() => renderPeopleMounts());
    return;
  }
  hosts.forEach(h => {
    h.innerHTML = peopleBlockHtml();
    if(!h.dataset.pplBound){
      h.addEventListener('click', peopleOnClick);
      h.addEventListener('change', peopleOnAddRoleChange);
      h.dataset.pplBound = '1';
    }
  });
  if(document.getElementById('waStkList')) renderStakeholderList();
}

/* Role picked in the add form -> reset the access chips to that role's defaults. */
function peopleOnAddRoleChange(e){
  if(e.target.getAttribute('data-new') !== 'role') return;
  const host = e.currentTarget;
  const wrap = host.querySelector('.ppl-add-perms .ppl-perms');
  if(wrap) wrap.outerHTML = peopleChipsHtml(PEOPLE_ROLE_DEFAULTS[e.target.value] || {});
  peopleSyncAddConsent(host);
}
function peopleAddPerms(host){
  const perms = {};
  host.querySelectorAll('.ppl-add-perms [data-perm]').forEach(b => { perms[b.getAttribute('data-perm')] = b.classList.contains('on'); });
  if(!perms.ask) perms.act = false;
  return perms;
}
function peopleSyncAddConsent(host){
  const p = peopleAddPerms(host);
  const c = host.querySelector('[data-new-consent]');
  if(c) c.classList.toggle('hidden', !(p.opening_bell || p.closing_bell));
}

/* One chip on an existing person. */
async function peopleTogglePerm(id, key){
  const cur = agentStakeholders.find(p => p.id === id); if(!cur) return;
  const perms = peoplePerms(cur);
  const next = !perms[key];

  // Primary number: only the Bells are editable, and they ARE the Bell
  // agent's frequency.
  if(cur.is_primary){
    if(!peopleBellDeployed()){ startWhatsappDeploy(); return; }
    const want = { ...perms, [key]: next };
    const freq = want.opening_bell && want.closing_bell ? 'both' : want.opening_bell ? 'opening' : want.closing_bell ? 'closing' : 'none';
    const dep = agentDeployments['whatsapp_bell'];
    const config = { ...(dep.config || {}), frequency: freq, updated_from: 'people' };
    const { error } = await sbClient.from('agent_deployments').update({ config: config, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id).eq('agent_id', 'whatsapp_bell');
    if(error){ toast('Could not change the Bell', { kind:'bad', sub: peopleErr(error) }); return; }
    dep.config = config;
    renderPeopleMounts();
    return;
  }

  const def = PEOPLE_PERMS.find(x => x.key === key);
  const patch = {};
  if(def.bell && next && !cur.bell_consent_at){
    if(!confirm('Has ' + cur.name + ' agreed to get WhatsApp briefings from Margyn on ' + waPrettyPhone(cur.phone) + '? WhatsApp requires their opt-in before we send.')) return;
    patch.bell_consent_at = new Date().toISOString();
  }
  const perms2 = { ...perms, [key]: next };
  if(key === 'ask' && !next) perms2.act = false;     // Act needs Ask
  if(key === 'act' && next) perms2.ask = true;
  patch.permissions = { ask:!!perms2.ask, act:!!perms2.act, forward:!!perms2.forward, opening_bell:!!perms2.opening_bell, closing_bell:!!perms2.closing_bell };
  patch.whatsapp_access = !!(perms2.ask || perms2.forward);
  const { data, error } = await sbClient.from('business_stakeholders').update(patch).eq('id', id).select().single();
  if(error){ toast('Could not change access', { kind:'bad', sub: peopleErr(error) }); return; }
  agentStakeholders = agentStakeholders.map(p => p.id === id ? data : p);
  renderPeopleMounts();
}

async function peopleOnClick(e){
  const host = e.currentTarget;
  const chip = e.target.closest('[data-perm]');
  if(chip && !chip.disabled){
    const row = chip.closest('[data-pid]');
    if(row){ await peopleTogglePerm(row.getAttribute('data-pid'), chip.getAttribute('data-perm')); return; }
    // add form: local toggle only, saved with Add
    chip.classList.toggle('on');
    const k = chip.getAttribute('data-perm');
    const wrap = chip.parentElement;
    if(k === 'ask' && !chip.classList.contains('on')) wrap.querySelector('[data-perm="act"]').classList.remove('on');
    if(k === 'act' && chip.classList.contains('on')) wrap.querySelector('[data-perm="ask"]').classList.add('on');
    wrap.querySelector('[data-perm="act"]').classList.toggle('dim', !wrap.querySelector('[data-perm="ask"]').classList.contains('on'));
    wrap.querySelectorAll('[data-perm]').forEach(b => b.setAttribute('aria-pressed', b.classList.contains('on')));
    peopleSyncAddConsent(host);
    return;
  }

  const btn = e.target.closest('[data-act]'); if(!btn) return;
  const act = btn.getAttribute('data-act');
  const row = btn.closest('[data-pid]');
  const id = row && row.getAttribute('data-pid');

  if(act === 'go-bell'){ showView('agents'); return; }
  if(act === 'edit'){ peopleEditingId = id; renderPeopleMounts(); return; }
  if(act === 'cancel'){ peopleEditingId = null; renderPeopleMounts(); return; }

  if(act === 'save'){
    const cur = agentStakeholders.find(p => p.id === id); if(!cur) return;
    const name = row.querySelector('[data-f="name"]').value.trim();
    const role = row.querySelector('[data-f="role"]').value;
    if(!name){ toast('Name is required', { kind:'bad' }); return; }
    const patch = { name: name, role: role };
    if(!cur.is_primary){
      const { digits, error: phErr } = waNormalizeMobile(row.querySelector('[data-f="phone"]').value);
      if(phErr){ toast('Check the number', { kind:'bad', sub: phErr }); return; }
      patch.phone = digits;
      // A new number is a new person as far as WhatsApp opt-in goes.
      if(digits !== cur.phone) patch.bell_consent_at = null;
    }
    btn.disabled = true;
    const { data, error } = await sbClient.from('business_stakeholders').update(patch).eq('id', id).select().single();
    btn.disabled = false;
    if(error){ toast('Could not save', { kind:'bad', sub: peopleErr(error) }); return; }
    agentStakeholders = agentStakeholders.map(p => p.id === id ? data : p);
    if(cur.is_primary) lsSet('margyn_owner_name', name);
    peopleEditingId = null; renderPeopleMounts();
    return;
  }

  if(act === 'remove'){
    const cur = agentStakeholders.find(p => p.id === id); if(!cur) return;
    if(!confirm('Remove ' + cur.name + ' from this account? They will no longer be able to message Margyn, get the Bells, or receive routed messages.')) return;
    const { error } = await sbClient.from('business_stakeholders').delete().eq('id', id);
    if(error){ toast('Could not remove', { kind:'bad', sub: peopleErr(error) }); return; }
    agentStakeholders = agentStakeholders.filter(p => p.id !== id);
    renderPeopleMounts();
    return;
  }

  if(act === 'save-primary'){
    const err = host.querySelector('[data-err="prim"]'); err.textContent = '';
    const name = host.querySelector('[data-prim="name"]').value.trim();
    const { digits, error: phErr } = waNormalizeMobile(host.querySelector('[data-prim="phone"]').value);
    if(!name){ err.textContent = 'Add your name.'; return; }
    if(phErr){ err.textContent = phErr; return; }
    btn.disabled = true;
    try { await savePrimaryPerson(name, digits); lsSet('margyn_owner_name', name); toast('Saved', { sub: 'Margyn will know it\'s you on WhatsApp.' }); }
    catch(pe){ err.textContent = peopleErr(pe); btn.disabled = false; }
    return;
  }

  if(act === 'add'){
    const err = host.querySelector('[data-err="add"]'); err.textContent = '';
    const name = host.querySelector('[data-new="name"]').value.trim();
    const role = host.querySelector('[data-new="role"]').value;
    const perms = peopleAddPerms(host);
    const wantsBell = perms.opening_bell || perms.closing_bell;
    const { digits, error: phErr } = waNormalizeMobile(host.querySelector('[data-new="phone"]').value);
    if(!name){ err.textContent = 'Name is required.'; return; }
    if(phErr){ err.textContent = phErr; return; }
    if(currentProfile && currentProfile.whatsapp_phone === digits){ err.textContent = 'That is already the primary number.'; return; }
    if(agentStakeholders.some(p => p.phone === digits)){ err.textContent = 'That number is already on the list. Edit it instead.'; return; }
    if(wantsBell && !host.querySelector('[data-new="consent"]').checked){ err.textContent = 'Tick the consent box to send them the Bells, or untick the Bells.'; return; }
    btn.disabled = true;
    const { data, error } = await sbClient.from('business_stakeholders')
      .insert({ business_id: currentUser.id, name: name, phone: digits, role: role,
        permissions: perms, whatsapp_access: !!(perms.ask || perms.forward),
        bell_consent_at: wantsBell ? new Date().toISOString() : null }).select().single();
    btn.disabled = false;
    if(error){ err.textContent = peopleErr(error); return; }
    agentStakeholders.push(data);
    const can = PEOPLE_PERMS.filter(x => perms[x.key]).map(x => x.label);
    toast(name + ' added', { sub: can.length ? 'Access: ' + can.join(', ') + '.' : 'Routing only. Tap a chip to give them access.' });
    renderPeopleMounts();
  }
}

async function renderAgentRoster(){
  const host = document.getElementById('agentCards');
  if(!host || !currentUser) return;
  host.innerHTML = '<div class="loading">Loading agents…</div>';
  await loadAgentData();
  const wa = agentDeployments['whatsapp_bell'];
  const waStatus = (wa && wa.status) || 'not_deployed';

  let actions;
  if(waStatus === 'active'){
    actions = '<button class="btn-ghost" id="waPauseBtn">Pause</button>' +
              '<span class="agent-configure-link" id="waConfigureLink">Configure</span>';
  } else if(waStatus === 'paused'){
    actions = '<button class="btn-primary" id="waResumeBtn">Resume</button>' +
              '<span class="agent-configure-link" id="waConfigureLink">Configure</span>';
  } else {
    actions = '<button class="btn-primary" id="waDeployBtn">Deploy</button>';
  }

  const chaseDep = agentDeployments['chase_agent'];
  const chaseStatus = (chaseDep && chaseDep.status) || 'not_deployed';
  let chaseActions;
  if(chaseStatus === 'active'){
    chaseActions = '<button class="btn-ghost" id="chasePauseBtn">Pause</button>' +
                   '<span class="agent-configure-link" id="chaseConfigureLink">Configure</span>';
  } else if(chaseStatus === 'paused'){
    chaseActions = '<button class="btn-primary" id="chaseResumeBtn">Resume</button>' +
                   '<span class="agent-configure-link" id="chaseConfigureLink">Configure</span>';
  } else {
    chaseActions = '<button class="btn-primary" id="chaseDeployBtn">Deploy</button>';
  }

  host.innerHTML =
    '<div class="agent-card">' +
      '<div class="agent-card-head">' +
        '<div style="flex:1; min-width:0;">' +
          '<h3>WhatsApp Bell</h3>' +
          '<div class="agent-desc">Pushes your Opening and Closing Bell briefing to WhatsApp, and lets you ask about your numbers by replying.</div>' +
        '</div>' +
        agentBadge(waStatus) +
      '</div>' +
      '<div class="agent-card-actions">' + actions + '</div>' +
    '</div>' +
    '<div class="agent-card">' +
      '<div class="agent-card-head">' +
        '<div style="flex:1; min-width:0;">' +
          '<h3>Payment Chase</h3>' +
          '<div class="agent-desc">Chases overdue receivables on WhatsApp on a set cadence and tone, reads the replies, pauses on a promise to pay, and hands the ones that go cold back to you.</div>' +
        '</div>' +
        agentBadge(chaseStatus) +
      '</div>' +
      '<div class="agent-card-actions">' + chaseActions + '</div>' +
    '</div>' +
    '<div class="agent-card is-disabled">' +
      '<div class="agent-card-head">' +
        '<div style="flex:1; min-width:0;">' +
          '<h3>Auto-Reconciliation</h3>' +
          '<div class="agent-desc">Automatically matches incoming payments against open invoices and flags mismatches for review.</div>' +
        '</div>' +
        '<span class="agent-badge soon">Coming soon</span>' +
      '</div>' +
      '<div class="agent-card-actions"><button class="btn-primary" disabled>Deploy</button></div>' +
    '</div>';

  const dep = document.getElementById('waDeployBtn');
  if(dep) dep.addEventListener('click', startWhatsappDeploy);
  const pause = document.getElementById('waPauseBtn');
  if(pause) pause.addEventListener('click', () => setAgentStatus('whatsapp_bell', 'paused'));
  const resume = document.getElementById('waResumeBtn');
  if(resume) resume.addEventListener('click', () => setAgentStatus('whatsapp_bell', 'active'));
  const cfg = document.getElementById('waConfigureLink');
  if(cfg) cfg.addEventListener('click', openWhatsappConfigure);

  const cDep = document.getElementById('chaseDeployBtn');
  if(cDep) cDep.addEventListener('click', startChaseDeploy);
  const cPause = document.getElementById('chasePauseBtn');
  if(cPause) cPause.addEventListener('click', () => setAgentStatus('chase_agent', 'paused'));
  const cResume = document.getElementById('chaseResumeBtn');
  if(cResume) cResume.addEventListener('click', () => setAgentStatus('chase_agent', 'active'));
  const cCfg = document.getElementById('chaseConfigureLink');
  if(cCfg) cCfg.addEventListener('click', openChaseConfigure);
}

/* ---------- modal plumbing ---------- */
function openAgentModal(html){
  document.getElementById('agentContent').innerHTML = html;
  document.getElementById('agentOverlay').classList.remove('hidden');
}
function closeAgentModal(){ document.getElementById('agentOverlay').classList.add('hidden'); }
document.getElementById('agentClose').addEventListener('click', closeAgentModal);
document.getElementById('agentOverlay').addEventListener('click', (e) => { if(e.target.id === 'agentOverlay') closeAgentModal(); });

/* ---------- deploy flow (no OTP: number is stored, verification happens
   the first time the user replies to a bell, matched on whatsapp_phone) ---------- */
function stepDots(n){
  return '<div class="agent-step-dots">' +
    '<span class="' + (n>=1?'on':'') + '"></span>' +
    '<span class="' + (n>=2?'on':'') + '"></span></div>';
}

/* Canonical WhatsApp-number normalizer, used by BOTH the Bell deploy step and
   the stakeholder-routing add form so every number in Supabase is stored the
   same way: country code, digits only, no +, no separators. A bare 10-digit
   number is assumed India (+91). Returns { digits, error }. */
function waNormalizeMobile(raw){
  let digits = String(raw || '').replace(/[^\d]/g, '').replace(/^0+/, '');
  if(digits.length === 10) digits = '91' + digits;
  if(digits.length < 11 || digits.length > 15){
    return { digits: null, error: 'Enter a 10-digit mobile (country code is added automatically) or a full number with country code.' };
  }
  return { digits: digits, error: null };
}
/* Pretty-print a stored digits-only number for display: +91 98765 43210 */
function waPrettyPhone(digits){
  const d = String(digits || '').replace(/[^\d]/g, '');
  if(d.length === 12 && d.startsWith('91')) return '+91 ' + d.slice(2,7) + ' ' + d.slice(7);
  if(d.length > 10) return '+' + d.slice(0, d.length-10) + ' ' + d.slice(-10, -5) + ' ' + d.slice(-5);
  return d;
}

async function startWhatsappDeploy(){
  const existing = (currentProfile && currentProfile.whatsapp_phone) || '';
  if(!agentStakeholders.length){ try { await loadPeople(); } catch(e){} }
  const prim = agentStakeholders.find(p => p.is_primary);
  const nameGuess = (prim && prim.name !== 'Owner' ? prim.name : '') || lsGetStr('margyn_owner_name');
  openAgentModal(
    stepDots(1) +
    '<div class="agent-modal-title">Deploy WhatsApp Bell</div>' +
    '<div class="hint">Step 1 of 2 — the number your briefing goes to. This is also the number Margyn will answer when you reply, and it will know it\'s you.</div>' +
    '<label>Your name</label>' +
    '<input type="text" id="waNameInput" autocomplete="name" placeholder="Kavya Shah" value="' + escapeHtml(nameGuess || '') + '">' +
    '<label>WhatsApp mobile number</label>' +
    '<input type="tel" id="waPhoneInput" inputmode="numeric" placeholder="98765 43210" value="' + escapeHtml(existing ? waPrettyPhone(existing) : '') + '">' +
    '<div class="hint" style="margin-top:6px;">10-digit Indian mobile — we add +91 for you. For any other country, type the full number with its country code.</div>' +
    '<div class="btn-row"><button class="primary" id="waPhoneNext">Continue</button>' +
    '<span class="note bad" id="waPhoneErr"></span></div>'
  );
  document.getElementById('waPhoneNext').addEventListener('click', () => {
    const name = document.getElementById('waNameInput').value.trim();
    if(!name){ document.getElementById('waPhoneErr').textContent = 'Add your name so Margyn knows who it is talking to.'; return; }
    const { digits, error } = waNormalizeMobile(document.getElementById('waPhoneInput').value);
    if(error){ document.getElementById('waPhoneErr').textContent = error; return; }
    waDeployConfirm(digits, name);
  });
}

function waDeployConfirm(digits, name){
  openAgentModal(
    stepDots(2) +
    '<div class="agent-modal-title">Confirm opt-in</div>' +
    '<div class="hint">Step 2 of 2 — Margyn will send your Opening and Closing Bell to <strong>+' + escapeHtml(digits) + '</strong> as a WhatsApp utility message. You can pause or change this any time from the Agents tab.</div>' +
    '<label style="display:flex; gap:9px; align-items:flex-start; text-transform:none; letter-spacing:0; font-family:\'Manrope\',sans-serif; font-size:13px; color:var(--text-1);">' +
      '<input type="checkbox" id="waOptIn" style="width:auto; margin:2px 0 0;">' +
      '<span>I agree to receive automated WhatsApp briefings from Margyn on this number.</span></label>' +
    '<div class="btn-row"><button class="primary" id="waConfirmBtn">Deploy agent</button>' +
    '<button class="ghost" id="waBackBtn" style="padding:13px 20px;">Back</button>' +
    '<span class="note" id="waConfirmNote"></span></div>'
  );
  document.getElementById('waBackBtn').addEventListener('click', startWhatsappDeploy);
  document.getElementById('waConfirmBtn').addEventListener('click', async () => {
    const note = document.getElementById('waConfirmNote');
    if(!document.getElementById('waOptIn').checked){ note.className = 'note bad'; note.textContent = 'Tick the box to continue.'; return; }
    note.className = 'note'; note.textContent = 'Deploying…';
    try {
      const { error: pErr } = await withTimeout(
        sbClient.from('profiles').update({ whatsapp_phone: digits, whatsapp_verified: true, whatsapp_opt_in: true }).eq('id', currentUser.id),
        20000, 'Saving number');
      if(pErr) throw pErr;
      currentProfile.whatsapp_phone = digits; currentProfile.whatsapp_verified = true; currentProfile.whatsapp_opt_in = true;
      try { await savePrimaryPerson(name, digits); }
      catch(pe){ console.error('[margyn] Bell deploy primary person:', pe); }
      const nowIso = new Date().toISOString();
      const { error: dErr } = await withTimeout(
        sbClient.from('agent_deployments').upsert(
          { user_id: currentUser.id, agent_id: 'whatsapp_bell', status: 'active', deployed_at: nowIso, updated_at: nowIso },
          { onConflict: 'user_id,agent_id' }),
        20000, 'Deploying agent');
      if(dErr) throw dErr;
      closeAgentModal();
      renderAgents();
    } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not deploy.'; }
  });
}

async function setAgentStatus(agentId, status){
  try {
    const { error } = await withTimeout(
      sbClient.from('agent_deployments').update({ status: status, updated_at: new Date().toISOString() })
        .eq('user_id', currentUser.id).eq('agent_id', agentId),
      20000, 'Updating agent');
    if(error) throw error;
    renderAgents();
  } catch(err){ toast('Could not update the agent', { kind:'bad', sub: err.message || '' }); }
}

/* ---------- configure flow ---------- */
function openWhatsappConfigure(){
  const dep = agentDeployments['whatsapp_bell'] || {};
  const cfg = dep.config || {};
  const pv = cfg.priority_vitals || {};
  const freq = cfg.frequency || 'both';

  const freqOpts = Object.keys(WA_FREQ_LABELS).map(k =>
    '<option value="' + k + '"' + (freq === k ? ' selected' : '') + '>' + WA_FREQ_LABELS[k] + '</option>').join('');

  const timeOpts = [];
  for(let h = 0; h < 24; h++){
    for(const m of ['00','30']){
      const v = String(h).padStart(2,'0') + ':' + m;
      timeOpts.push('<option value="' + v + '"' + ((cfg.send_time_ist || '08:00') === v ? ' selected' : '') + '>' + v + '</option>');
    }
  }

  const vitalRows = AGENT_VITALS.map(label => {
    const mode = pv[label] === 'always' ? 'always' : 'flagged';
    return '<div class="agent-vital-row"><span>' + escapeHtml(label) + '</span>' +
      '<span class="agent-seg" data-vital="' + escapeHtml(label) + '">' +
        '<button data-mode="always" class="' + (mode === 'always' ? 'on' : '') + '">Always</button>' +
        '<button data-mode="flagged" class="' + (mode === 'flagged' ? 'on' : '') + '">When flagged</button>' +
      '</span></div>';
  }).join('');

  openAgentModal(
    '<div class="agent-modal-title">Configure WhatsApp Bell</div>' +
    '<div class="hint">Editable any time. Frequency, send time and priority vitals save together in one step. Stakeholder contacts save as you add or remove them.</div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Briefing goes to</span>' +
      '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
        '<span style="font-family:\'IBM Plex Mono\',monospace; font-size:14px; color:var(--text-0);">' +
          ((currentProfile && currentProfile.whatsapp_phone) ? escapeHtml(waPrettyPhone(currentProfile.whatsapp_phone)) : 'Not set') + '</span>' +
        '<span class="agent-configure-link" id="waChangeNumLink">Change number</span>' +
      '</div></div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Frequency</span>' +
      '<select id="waFreq">' + freqOpts + '</select></div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Send time (IST)</span>' +
      '<select id="waSendTime">' + timeOpts.join('') + '</select></div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Priority vitals</span>' +
      '<div class="hint" style="margin-bottom:8px;">Which vitals always appear in the briefing, versus only when they cross a threshold.</div>' +
      vitalRows + '</div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Stakeholder routing</span>' +
      '<div class="hint" style="margin-bottom:10px;">People Margyn can forward a message to when you reply asking it to. Used by the WhatsApp agent\'s routing.</div>' +
      '<div id="waStkList"></div>' +
      '<div class="agent-stk-row">' +
        '<input type="text" id="waStkName" placeholder="Name" style="margin-bottom:0;">' +
        '<input type="tel" id="waStkPhone" inputmode="numeric" placeholder="10-digit mobile" style="margin-bottom:0;">' +
        '<select id="waStkRole" style="margin-bottom:0;"><option value="AR">AR</option><option value="AP">AP</option><option value="owner">owner</option><option value="finance">finance</option><option value="other">other</option></select>' +
        '<button class="stk-del" id="waStkAdd" title="Add" style="color:var(--emerald); font-size:22px;">+</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:6px;">10-digit Indian mobile — +91 is added automatically. This person must send one message to Margyn’s WhatsApp (or the relay template must be approved) before routing can reach them.</div>' +
      '<span class="note bad" id="waStkErr"></span></div>' +

    '<div class="agent-fieldset"><span class="agent-fs-label">Threshold sensitivity</span>' +
      '<div class="agent-ref-note">Bell thresholds follow your scoring sensitivity in Settings. A dedicated control for this is coming with the Settings build. There is no separate threshold system here.</div></div>' +

    '<div class="btn-row"><button class="primary" id="waCfgSave">Save configuration</button>' +
    '<span class="note" id="waCfgNote"></span></div>'
  );

  renderStakeholderList();
  document.getElementById('waStkAdd').addEventListener('click', addStakeholder);
  const chg = document.getElementById('waChangeNumLink');
  if(chg) chg.addEventListener('click', startWhatsappDeploy);

  document.querySelectorAll('#agentContent .agent-seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      });
    });
  });

  document.getElementById('waCfgSave').addEventListener('click', saveWhatsappConfig);
}

function renderStakeholderList(){
  const host = document.getElementById('waStkList');
  if(!host) return;
  if(!agentStakeholders.length){ host.innerHTML = '<div class="hint" style="margin-bottom:10px;">No contacts yet.</div>'; return; }
  host.innerHTML = agentStakeholders.map(s =>
    '<div class="agent-stk-row" data-id="' + s.id + '">' +
      '<span style="font-size:13px; color:var(--text-1);">' + escapeHtml(s.name) + '</span>' +
      '<span style="font-size:13px; color:var(--text-2); font-family:\'IBM Plex Mono\',monospace;">' + escapeHtml(waPrettyPhone(s.phone)) + '</span>' +
      '<span class="agent-badge notdeployed">' + escapeHtml(s.role) + '</span>' +
      '<button class="stk-del" data-del="' + s.id + '" title="Remove">&times;</button>' +
    '</div>').join('');
  host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteStakeholder(b.getAttribute('data-del'))));
}

async function addStakeholder(){
  const name = document.getElementById('waStkName').value.trim();
  const role = document.getElementById('waStkRole').value;
  const err = document.getElementById('waStkErr');
  err.textContent = '';
  const { digits: phone, error: phoneErr } = waNormalizeMobile(document.getElementById('waStkPhone').value);
  if(!name){ err.textContent = 'Name is required.'; return; }
  if(phoneErr){ err.textContent = phoneErr; return; }
  try {
    const { data, error } = await sbClient.from('business_stakeholders')
      .insert({ business_id: currentUser.id, name: name, phone: phone, role: role }).select().single();
    if(error) throw error;
    agentStakeholders.push(data);
    document.getElementById('waStkName').value = '';
    document.getElementById('waStkPhone').value = '';
    renderStakeholderList();
    renderPeopleMounts();
  } catch(e){ err.textContent = e.message || 'Could not add contact.'; }
}

async function deleteStakeholder(id){
  try {
    const { error } = await sbClient.from('business_stakeholders').delete().eq('id', id);
    if(error) throw error;
    agentStakeholders = agentStakeholders.filter(s => s.id !== id);
    renderStakeholderList();
    renderPeopleMounts();
  } catch(e){ toast('Could not remove contact', { kind:'bad', sub: e.message || '' }); }
}

async function saveWhatsappConfig(){
  const note = document.getElementById('waCfgNote');
  note.className = 'note'; note.textContent = 'Saving…';
  const priority = {};
  document.querySelectorAll('#agentContent .agent-seg').forEach(seg => {
    const on = seg.querySelector('button.on');
    priority[seg.getAttribute('data-vital')] = on ? on.getAttribute('data-mode') : 'flagged';
  });
  const config = {
    frequency: document.getElementById('waFreq').value,
    send_time_ist: document.getElementById('waSendTime').value,
    priority_vitals: priority,
    threshold_ref: 'settings_scoring_sensitivity',
    updated_from: 'agents_tab'
  };
  try {
    const { error } = await withTimeout(
      sbClient.from('agent_deployments').update({ config: config, updated_at: new Date().toISOString() })
        .eq('user_id', currentUser.id).eq('agent_id', 'whatsapp_bell'),
      20000, 'Saving configuration');
    if(error) throw error;
    if(agentDeployments['whatsapp_bell']) agentDeployments['whatsapp_bell'].config = config;
    note.className = 'note ok'; note.textContent = 'Saved.';
    setTimeout(closeAgentModal, 900);
  } catch(err){ note.className = 'note bad'; note.textContent = err.message || 'Could not save.'; }
}

