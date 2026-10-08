/**
 * api/_lib/team.js
 * Team logins: invite by code, join, list, change, remove, and "who am I".
 * Added 2026-09-29. Routed from api/ops.js (?action=team-*); tables in
 * 2026-09-29-team-logins.sql; roles in teamAccess.js.
 *
 *   GET  team-whoami   the signed-in person: their own business (if any) and
 *                      every account they're a member of, with permissions
 *   GET  team-list     the account's owner, members, and open invites
 *   POST team-invite   { email, name, role, permissions } -> a one-time code
 *   POST team-revoke   { invite_id }
 *   POST team-update   { member_id, role?, permissions?, status?, name? }
 *   POST team-remove   { member_id }
 *   POST team-join     { code }  the signed-in person joins with their code
 *   POST team-prefs    { prefs }  a member's own settings (merged; null = default)
 *
 * team-update also takes { phone }: link that person's WhatsApp number to
 * their login, so WhatsApp follows the same role ('' unlinks).
 * Every team change is written to the Audit log (ledger_events, entity
 * 'person') with who made it.
 *
 * The code is shown once to whoever created it (and emailed when Resend is
 * set up). Only its SHA-256 is stored. It works once, for 7 days, and only
 * for the email it was made for.
 *
 * deps = { getUserFromRequest, selectRows, insertRows, updateRows,
 *          restRequest, sendEmail?, now? } so the tests run without a network.
 */

const crypto = require('crypto');
const { ROLES, ROLE_LABEL, PERMISSIONS, effectivePermissions, cleanOverrides } = require('./teamAccess');

const INVITE_DAYS = 7;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function hashCode(c) { return crypto.createHash('sha256').update(normCode(c)).digest('hex'); }
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  return u && d ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}` : 'another email';
}
function appUrl() { return (process.env.APP_URL || 'https://www.margynlabs.com').replace(/\/$/, ''); }
function joinLink(code) { return `${appUrl()}/app.html#/join?code=${encodeURIComponent(code)}`; }

function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } }
  return req.body || {};
}
const send = (res, status, obj) => { res.setHeader && res.setHeader('Cache-Control', 'no-store'); res.status(status).json(obj); };

/* The caller, resolved against the account in X-Margyn-Account (if any). */
function callerOf(user) {
  const isOwner = !user.member;
  return {
    authId: user.auth_id || user.id,
    email: user.email || null,
    accountId: user.id,
    isOwner,
    role: isOwner ? 'owner' : user.member.role,
    permissions: isOwner ? effectivePermissions('owner') : user.member.permissions
  };
}
const canManage = (c) => c.isOwner || c.permissions.includes('manage_people');

async function companyNames(deps, ids) {
  if (!ids.length) return {};
  const rows = await deps.selectRows('profiles', `select=id,company_name&id=in.(${ids.join(',')})`).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.id, r.company_name || null]));
}

/* ---------- whoami ---------- */
async function whoami(deps, user) {
  const authId = user.auth_id || user.id;
  // Both reads at once: the app waits on this before anything else loads.
  const ownP = deps.selectRows('profiles', `select=id,company_name&id=eq.${authId}&limit=1`).catch(() => []);
  const memP = deps.selectRows('account_members',
    `select=id,account_id,role,permissions,name,status,preferences&user_id=eq.${authId}&status=eq.active&order=created_at.asc`);
  memP.catch(() => {});
  const own = await ownP;
  let rows = [], ready = true, followups = true;
  try {
    rows = await memP;
  } catch (e) {
    followups = false;   // before 2026-09-30-team-followups.sql: no preferences column
    try {
      rows = await deps.selectRows('account_members',
        `select=id,account_id,role,permissions,name,status&user_id=eq.${authId}&status=eq.active&order=created_at.asc`);
    } catch (e2) { ready = false; }
  }
  const names = await companyNames(deps, rows.map((r) => r.account_id));
  if (rows.length) {
    deps.updateRows('account_members', `user_id=eq.${authId}&status=eq.active`, { last_seen_at: new Date(deps.now ? deps.now() : Date.now()).toISOString() }).catch(() => {});
  }
  return {
    ready,
    // what the database can hold yet: the app only sends new fields once they exist
    features: { audit_actor: ready && followups, member_prefs: ready && followups, phone_link: ready && followups },
    me: { id: authId, email: user.email || null },
    own_account: own[0] ? { account_id: authId, company_name: own[0].company_name || null } : null,
    memberships: rows.map((r) => ({
      member_id: r.id, account_id: r.account_id, company_name: names[r.account_id] || null,
      role: r.role, role_label: ROLE_LABEL[r.role] || r.role, name: r.name || null,
      permissions: effectivePermissions(r.role, r.permissions),
      preferences: r.preferences && typeof r.preferences === 'object' ? r.preferences : {}
    })),
    roles: ROLES.map((k) => ({ key: k, label: ROLE_LABEL[k] })),
    permissions: PERMISSIONS
  };
}

/* ---------- list ---------- */
async function ownerEmail(accountId) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${accountId}`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u.email || null;
  } catch (e) { return null; }
}
async function list(deps, c) {
  // Every read at once (was five in a row, ~6 s on open).
  const [members, invites, primary, phones, ownerMail] = await Promise.all([
    deps.selectRows('account_members',
      `select=id,user_id,email,name,role,permissions,status,created_at,last_seen_at&account_id=eq.${c.accountId}&order=created_at.asc`),
    canManage(c)
      ? deps.selectRows('account_invites',
        `select=id,email,name,role,expires_at,created_at&account_id=eq.${c.accountId}&used_at=is.null&revoked_at=is.null&order=created_at.desc`)
      : [],
    deps.selectRows('business_stakeholders', `select=name&business_id=eq.${c.accountId}&is_primary=eq.true&limit=1`).catch(() => []),
    deps.selectRows('business_stakeholders', `select=member_id,phone&business_id=eq.${c.accountId}&member_id=not.is.null`).catch(() => []),
    (deps.ownerEmail || ownerEmail)(c.accountId)
  ]);
  const nowMs = deps.now ? deps.now() : Date.now();
  const phoneOf = Object.fromEntries(phones.map((r) => [r.member_id, r.phone]));
  return {
    you: { user_id: c.authId, role: c.role, can_manage: canManage(c), is_owner: c.isOwner },
    owner: { user_id: c.accountId, email: ownerMail, name: (primary[0] && primary[0].name) || null, role: 'owner', role_label: ROLE_LABEL.owner },
    members: members.map((m) => ({
      id: m.id, user_id: m.user_id, email: m.email, name: m.name, role: m.role, role_label: ROLE_LABEL[m.role] || m.role,
      overrides: cleanOverrides(m.permissions), permissions: effectivePermissions(m.role, m.permissions),
      status: m.status, joined_at: m.created_at, last_seen_at: m.last_seen_at, whatsapp: phoneOf[m.id] || null
    })),
    invites: invites.filter((i) => Date.parse(i.expires_at) > nowMs).map((i) => ({
      id: i.id, email: i.email, name: i.name, role: i.role, role_label: ROLE_LABEL[i.role] || i.role, expires_at: i.expires_at
    }))
  };
}

/* ---------- the Audit log: who changed the team ---------- */
async function actorName(deps, c) {
  if (!c.isOwner) {
    const r = await deps.selectRows('account_members', `select=name,email&account_id=eq.${c.accountId}&user_id=eq.${c.authId}&limit=1`).catch(() => []);
    if (r[0]) return r[0].name || r[0].email;
  }
  const s = await deps.selectRows('business_stakeholders', `select=name&business_id=eq.${c.accountId}&is_primary=eq.true&limit=1`).catch(() => []);
  return (s[0] && s[0].name) || c.email || null;
}
async function audit(deps, c, event, party, note) {
  const row = { user_id: c.accountId, entity_type: 'person', event, party_name: party || null, note: note || null };
  try { await deps.insertRows('ledger_events', [{ ...row, actor_id: c.authId, actor_name: await actorName(deps, c), channel: 'app' }]); }
  catch (e) { await deps.insertRows('ledger_events', [row]).catch(() => {}); }   // before the 09-30 columns
}

/* ---------- a login's WhatsApp number ---------- */
function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '').replace(/^0+/, '');
  if (d.length === 10) d = '91' + d;
  return d;
}
/* WhatsApp switches that follow the person's role (see memberAccess.js). */
function waPermsFor(member, bells) {
  const eff = effectivePermissions(member.role, member.permissions);
  return { ask: true, act: eff.includes('approve') || eff.includes('edit'), forward: eff.includes('edit'),
    opening_bell: !!(bells && bells.opening_bell), closing_bell: !!(bells && bells.closing_bell) };
}
async function linkPhone(deps, c, m, raw) {
  const acct = c.accountId;
  const digits = normPhone(raw);
  const mine = (await deps.selectRows('business_stakeholders', `select=id,phone,permissions&business_id=eq.${acct}&member_id=eq.${m.id}&limit=1`))[0] || null;
  const unlink = (row) => deps.updateRows('business_stakeholders', `id=eq.${row.id}`, { member_id: null, whatsapp_access: false,
    permissions: { ...(row.permissions || {}), ask: false, act: false, forward: false } });
  if (!digits) { if (mine) await unlink(mine); return null; }
  if (digits.length < 11 || digits.length > 15) return [400, { error: 'Enter a 10-digit mobile, or a full number with country code.' }];
  const owner = await deps.selectRows('profiles', `select=whatsapp_phone&id=eq.${acct}&limit=1`).catch(() => []);
  if (owner[0] && normPhone(owner[0].whatsapp_phone) === digits) return [409, { error: 'That’s the account’s own WhatsApp number.' }];
  const elsewhere = await deps.selectRows('business_stakeholders', `select=id&phone=eq.${digits}&whatsapp_access=eq.true&business_id=neq.${acct}&limit=1`);
  if (elsewhere.length) return [409, { error: 'That number already talks to Margyn for another business. A number can do that for one business only.' }];
  const same = (await deps.selectRows('business_stakeholders', `select=id,name,member_id,permissions&business_id=eq.${acct}&phone=eq.${digits}&limit=1`))[0] || null;
  if (same && same.member_id && same.member_id !== m.id) return [409, { error: 'That number is already linked to someone else on this account.' }];
  if (mine && (!same || mine.id !== same.id)) await unlink(mine);
  const permissions = waPermsFor(m, same ? same.permissions : null);
  if (same) {
    await deps.updateRows('business_stakeholders', `id=eq.${same.id}`, { member_id: m.id, whatsapp_access: true, permissions });
  } else {
    await deps.insertRows('business_stakeholders', [{ business_id: acct, name: m.name || String(m.email || '').split('@')[0] || 'Team member',
      phone: digits, role: m.role === 'finance' ? 'finance' : 'other', whatsapp_access: true, member_id: m.id, permissions }]);
  }
  return null;
}

/* ---------- a member's own settings ---------- */
async function prefs(deps, c, b) {
  if (c.isOwner) return [400, { error: 'The owner’s settings are the business’s settings.' }];
  const patch = b.prefs && typeof b.prefs === 'object' && !Array.isArray(b.prefs) ? b.prefs : null;
  if (!patch || JSON.stringify(patch).length > 20000) return [400, { error: 'prefs must be a small object' }];
  const rows = await deps.selectRows('account_members', `select=id,preferences&account_id=eq.${c.accountId}&user_id=eq.${c.authId}&limit=1`);
  if (!rows.length) return [404, { error: 'Membership not found' }];
  const merged = { ...(rows[0].preferences || {}) };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete merged[k]; else merged[k] = v; }
  await deps.updateRows('account_members', `id=eq.${rows[0].id}`, { preferences: merged });
  return [200, { ok: true, preferences: merged }];
}

/* ---------- invite ---------- */
async function invite(deps, c, b) {
  if (!canManage(c)) return [403, { error: 'Only the owner or an admin can invite people.' }];
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80) || null;
  const role = String(b.role || '');
  if (!EMAIL_RE.test(email)) return [400, { error: 'Enter a valid email address.' }];
  if (!ROLES.includes(role)) return [400, { error: 'Pick a role.' }];
  if (role === 'admin' && !c.isOwner) return [403, { error: 'Only the owner can make someone an admin.' }];
  if (c.email && email === String(c.email).toLowerCase() && c.isOwner) return [400, { error: 'That is your own email.' }];
  const existing = await deps.selectRows('account_members', `select=id,status&account_id=eq.${c.accountId}&email=eq.${encodeURIComponent(email)}&limit=1`);
  if (existing.length && existing[0].status === 'active') return [409, { error: 'This person is already on the account.' }];

  // One open invite per email: an older unused code stops working.
  await deps.updateRows('account_invites',
    `account_id=eq.${c.accountId}&email=eq.${encodeURIComponent(email)}&used_at=is.null&revoked_at=is.null`,
    { revoked_at: new Date(deps.now ? deps.now() : Date.now()).toISOString() }).catch(() => {});

  const code = newCode();
  const expires = new Date((deps.now ? deps.now() : Date.now()) + INVITE_DAYS * 86400000).toISOString();
  const [row] = await deps.insertRows('account_invites', [{
    account_id: c.accountId, email, name, role, permissions: cleanOverrides(b.permissions),
    code_hash: hashCode(code), expires_at: expires, created_by: c.authId
  }]);

  const names = await companyNames(deps, [c.accountId]);
  const company = names[c.accountId] || 'a business';
  let emailed = false;
  if (deps.sendEmail && process.env.RESEND_API_KEY) {
    try {
      await deps.sendEmail({
        to: email,
        subject: `You're invited to ${company} on Margyn`,
        text: `${name ? name + ', you' : 'You'}'ve been invited to ${company} on Margyn as ${ROLE_LABEL[role]}.\n\nOpen this link and sign in with ${email}:\n${joinLink(code)}\n\nOr enter this code after signing in: ${code}\n\nThe code works once and expires in ${INVITE_DAYS} days.`,
        html: `<p>${name ? escapeHtml(name) + ', you' : 'You'}'ve been invited to <b>${escapeHtml(company)}</b> on Margyn as ${ROLE_LABEL[role]}.</p><p><a href="${joinLink(code)}">Join ${escapeHtml(company)}</a> and sign in with ${escapeHtml(email)}.</p><p>Or enter this code after signing in: <b style="font-family:monospace">${code}</b></p><p style="color:#666">The code works once and expires in ${INVITE_DAYS} days.</p>`
      });
      emailed = true;
    } catch (e) { console.error('[team] invite email failed:', e.message); }
  }
  await audit(deps, c, 'invited', name || email, `${email} as ${ROLE_LABEL[role]}`);
  return [200, { invite_id: row && row.id, email, role, role_label: ROLE_LABEL[role], code, link: joinLink(code), expires_at: expires, emailed }];
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

/* ---------- revoke / update / remove ---------- */
async function revoke(deps, c, b) {
  if (!canManage(c)) return [403, { error: 'Only the owner or an admin can do that.' }];
  if (!UUID_RE.test(String(b.invite_id || ''))) return [400, { error: 'invite_id is required' }];
  const rows = await deps.updateRows('account_invites', `id=eq.${b.invite_id}&account_id=eq.${c.accountId}&used_at=is.null`,
    { revoked_at: new Date(deps.now ? deps.now() : Date.now()).toISOString() });
  if (!rows.length) return [404, { error: 'Invite not found' }];
  await audit(deps, c, 'invite_cancelled', rows[0].name || rows[0].email, rows[0].email);
  return [200, { ok: true }];
}
async function memberRow(deps, c, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const rows = await deps.selectRows('account_members', `select=id,user_id,role,permissions,name,email,status&id=eq.${id}&account_id=eq.${c.accountId}&limit=1`);
  return rows[0] || null;
}
async function update(deps, c, b) {
  if (!canManage(c)) return [403, { error: 'Only the owner or an admin can do that.' }];
  const m = await memberRow(deps, c, b.member_id);
  if (!m) return [404, { error: 'Person not found' }];
  if ((m.role === 'admin' || b.role === 'admin') && !c.isOwner) return [403, { error: 'Only the owner can change an admin.' }];
  if (m.user_id === c.authId) return [400, { error: 'Ask the owner or another admin to change your own access.' }];
  const patch = {};
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) return [400, { error: 'Unknown role' }]; patch.role = b.role; }
  if (b.permissions !== undefined) patch.permissions = cleanOverrides(b.permissions);
  if (b.status !== undefined) { if (!['active', 'suspended'].includes(b.status)) return [400, { error: 'Unknown status' }]; patch.status = b.status; }
  if (b.name !== undefined) patch.name = String(b.name || '').trim().slice(0, 80) || null;
  if (!Object.keys(patch).length && b.phone === undefined) return [400, { error: 'Nothing to change' }];
  let row = m;
  if (Object.keys(patch).length) [row] = await deps.updateRows('account_members', `id=eq.${m.id}&account_id=eq.${c.accountId}`, patch);
  row = row || m;
  const who = m.name || m.email;
  // A linked WhatsApp number follows the new role / switches.
  if (b.phone !== undefined) {
    const err = await linkPhone(deps, c, row, b.phone);
    if (err) return err;
    await audit(deps, c, 'whatsapp_linked', who, normPhone(b.phone) ? '+' + normPhone(b.phone) : 'unlinked');
  } else if (patch.role || patch.permissions) {
    const linked = await deps.selectRows('business_stakeholders', `select=id,permissions&business_id=eq.${c.accountId}&member_id=eq.${m.id}&limit=1`).catch(() => []);
    if (linked[0]) await deps.updateRows('business_stakeholders', `id=eq.${linked[0].id}`, { permissions: waPermsFor(row, linked[0].permissions) }).catch(() => {});
  }
  if (patch.role) await audit(deps, c, 'role_changed', who, `${ROLE_LABEL[m.role] || m.role} to ${ROLE_LABEL[patch.role]}`);
  if (patch.permissions) await audit(deps, c, 'access_changed', who, Object.entries(patch.permissions).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ') || 'back to role defaults');
  if (patch.status) await audit(deps, c, patch.status === 'suspended' ? 'suspended' : 'restored', who);
  return [200, { ok: true, member: { id: row.id, role: row.role, status: row.status, permissions: effectivePermissions(row.role, row.permissions) } }];
}
async function remove(deps, c, b) {
  if (!canManage(c)) return [403, { error: 'Only the owner or an admin can do that.' }];
  const m = await memberRow(deps, c, b.member_id);
  if (!m) return [404, { error: 'Person not found' }];
  if (m.role === 'admin' && !c.isOwner) return [403, { error: 'Only the owner can remove an admin.' }];
  if (m.user_id === c.authId) return [400, { error: 'You can’t remove yourself. Ask the owner or another admin.' }];
  const res = await deps.restRequest(`account_members?id=eq.${m.id}&account_id=eq.${c.accountId}`, { method: 'DELETE' });
  if (!res.ok) return [500, { error: 'Could not remove' }];
  await audit(deps, c, 'removed', m.name || m.email, m.email);
  return [200, { ok: true }];
}

/* ---------- join ---------- */
async function join(deps, user, b) {
  const authId = user.auth_id || user.id;
  const code = normCode(b.code);
  if (code.length !== 12) return [400, { error: 'That code doesn’t look right. It has 12 letters and numbers, like ABCD-EFGH-JKLM.' }];
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const rows = await deps.selectRows('account_invites',
    `select=id,account_id,email,name,role,permissions,expires_at,used_at,revoked_at&code_hash=eq.${hashCode(code)}&limit=1`);
  const inv = rows[0];
  if (!inv || inv.revoked_at) return [404, { error: 'That code isn’t valid. Ask whoever invited you for a new one.' }];
  if (inv.used_at) return [410, { error: 'That code has already been used. Ask for a new one.' }];
  if (inv.expires_at < nowIso) return [410, { error: 'That code has expired. Ask for a new one.' }];
  if (String(inv.email).toLowerCase() !== String(user.email || '').toLowerCase()) {
    return [403, { error: `This invite is for ${maskEmail(inv.email)}. Sign in with that email to use it.` }];
  }
  if (inv.account_id === authId) return [400, { error: 'This is your own account.' }];
  await deps.insertRows('account_members', [{
    account_id: inv.account_id, user_id: authId, email: String(inv.email).toLowerCase(), name: inv.name || null,
    role: inv.role, permissions: inv.permissions || {}, status: 'active', invited_by: null
  }], { onConflict: 'account_id,user_id', merge: true });
  await deps.updateRows('account_invites', `id=eq.${inv.id}`, { used_at: nowIso, used_by: authId });
  await audit(deps, { accountId: inv.account_id, authId, isOwner: false, email: user.email }, 'joined', inv.name || inv.email, `as ${ROLE_LABEL[inv.role]}`);
  const names = await companyNames(deps, [inv.account_id]);
  return [200, { ok: true, account_id: inv.account_id, company_name: names[inv.account_id] || null, role: inv.role, role_label: ROLE_LABEL[inv.role] }];
}

/* ---------- router ---------- */
async function handle(action, req, res, deps) {
  let user;
  try { user = await deps.getUserFromRequest(req); }
  catch (e) { return send(res, 500, { error: 'Auth check failed' }); }
  if (!user) return send(res, 401, { error: 'Not signed in, or not allowed on this account.' });
  const c = callerOf(user);
  const isPost = req.method === 'POST';
  try {
    if (action === 'team-whoami') return send(res, 200, await whoami(deps, user));
    if (action === 'team-list') return send(res, 200, await list(deps, c));
    if (!isPost) return send(res, 405, { error: 'Method not allowed' });
    const b = body(req);
    let out;
    if (action === 'team-invite') out = await invite(deps, c, b);
    else if (action === 'team-revoke') out = await revoke(deps, c, b);
    else if (action === 'team-update') out = await update(deps, c, b);
    else if (action === 'team-remove') out = await remove(deps, c, b);
    else if (action === 'team-join') out = await join(deps, user, b);
    else if (action === 'team-prefs') out = await prefs(deps, c, b);
    else return send(res, 404, { error: 'Unknown action' });
    return send(res, out[0], out[1]);
  } catch (e) {
    console.error('[team]', action, e.message);
    const missing = /account_(members|invites)/.test(e.message) && /(does not exist|404|PGRST205)/.test(e.message);
    return send(res, missing ? 503 : 500, { error: missing ? 'Team logins aren’t switched on yet (the database update hasn’t been run).' : 'Something went wrong. Try again.' });
  }
}

module.exports = { handle, newCode, normCode, hashCode, maskEmail, joinLink };
