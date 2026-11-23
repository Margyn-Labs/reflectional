/**
 * api/_lib/opsTeam.js — Ops Console: team logins, analysed (21 Nov 2026).
 *
 * Who was invited into which business, whether they joined, how fast, whether their WhatsApp is linked and
 * Margyn's first message reached them, whether they actually used Margyn (questions in the app or on
 * WhatsApp), whether they came back, what they looked at, and what to do next for each person.
 *
 * Sources (all read with the service role, founder-gated in api/ops.js):
 *   account_invites, account_members        the invite and the membership
 *   ledger_events (entity_type 'person')    who invited, linked, changed, removed (the audit log)
 *   business_stakeholders (member_id)       the linked WhatsApp number
 *   wa_deliveries (kind 'welcome')          WhatsApp's own delivered / read / failed for the first message
 *   wa_deliveries (to their number)         every message Margyn sent them since, with WhatsApp's receipts (23 Nov)
 *   whatsapp_conversations                  counts and times per linked number (never the text)
 *   chat_messages (author_id)               Ask Margyn questions per person (never the text)
 *   product_events (props.by = person)      app opens and page views per person (by: track.js, 21 Nov)
 *   profiles, zoho_organizations, product_events on the person's own login: their own business and books
 *
 * What never leaves here: message text, figures, party names. Phones as the last four digits only.
 * analyze() is pure (tests: api/_lib/__tests__/opsTeam.test.js); load() does the reads.
 */

const DAY = 86400000;
const IST = 5.5 * 3600000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABEL = { admin: 'Admin', finance: 'Finance', approver: 'Approver', viewer: 'Viewer', advisor: 'Advisor (CA)' };
const STAGES = ['invited', 'joined', 'whatsapp_linked', 'welcome_delivered', 'first_question', 'came_back'];
const STAGE_LABELS = {
  invited: 'Invited', joined: 'Joined', whatsapp_linked: 'WhatsApp linked', welcome_delivered: 'First message reached them',
  first_question: 'Asked something', came_back: 'Came back another day'
};
const PAGE_SECS_CAP = 1800;   // one page left open over lunch shouldn't count as half an hour of reading

const t = (x) => (x ? Date.parse(x) : NaN);
const ok = (x) => Number.isFinite(x);
const iso = (ms) => (ok(ms) ? new Date(ms).toISOString() : null);
const digits = (p) => String(p || '').replace(/[^\d]/g, '');
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const minOf = (arr) => { const v = arr.filter(ok); return v.length ? Math.min(...v) : NaN; };
const maxOf = (arr) => { const v = arr.filter(ok); return v.length ? Math.max(...v) : NaN; };
const hours = (a, b) => (ok(a) && ok(b) ? Math.round(((b - a) / 3600000) * 10) / 10 : null);
function median(xs) {
  const v = xs.filter((x) => x != null && ok(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const lc = (s) => String(s || '').trim().toLowerCase();

/**
 * @param d    { members, invites, personEvents, links, welcomes, profiles, chats, events, convo, emails, books, ownZoho, ownEvents }
 *             any of them may be null (table missing / read failed): the view says so instead of guessing.
 * @param now  ms
 */
function analyze(d, now) {
  now = now || Date.now();
  const members = d.members || [];
  const invites = d.invites || [];
  const pev = d.personEvents || [];
  const links = d.links || [];
  const welcomes = d.welcomes || [];
  const companyOf = Object.fromEntries((d.profiles || []).map((p) => [p.id, p.company_name || null]));
  const hasOwn = new Set((d.profiles || []).map((p) => p.id));
  const phoneOnFile = new Set((d.profiles || []).filter((p) => p.whatsapp_phone).map((p) => p.id));   // yes/no only, never the number
  const emails = d.emails || {};
  const books = d.books || {};

  // ---------- one row per person per business ----------
  const people = [];
  const byMember = new Map();
  for (const m of members) {
    const p = {
      key: 'm:' + m.id, member_id: m.id, user_id: m.user_id, account_id: m.account_id,
      name: m.name || null, email: m.email || null, role: m.role, status: m.status === 'suspended' ? 'suspended' : 'member',
      joined_at: m.created_at || null, last_seen_at: m.last_seen_at || null, invite: null
    };
    people.push(p); byMember.set(m.id, p);
  }
  // Invites: the one that was used belongs to its member; of the unused ones, only the newest per email
  // (an older code is retired when a new one is made), and none for someone already in.
  const used = invites.filter((i) => i.used_at);
  for (const i of used) {
    const p = people.find((x) => x.member_id && x.account_id === i.account_id && (x.user_id === i.used_by || lc(x.email) === lc(i.email)));
    if (p) { if (!p.invite || t(i.created_at) < t(p.invite.created_at)) p.invite = i; }
    else {
      // Joined, then removed: the membership row is gone, the invite and the audit log remain.
      people.push({ key: 'i:' + i.id, member_id: null, user_id: i.used_by || null, account_id: i.account_id, name: i.name || null, email: i.email,
        role: i.role, status: 'removed', joined_at: i.used_at, last_seen_at: null, invite: i });
    }
  }
  const openGroups = new Map();
  for (const i of invites.filter((x) => !x.used_at)) {
    const k = i.account_id + '|' + lc(i.email);
    if (people.some((p) => p.account_id === i.account_id && lc(p.email) === lc(i.email))) continue;
    const prev = openGroups.get(k);
    if (!prev || t(i.created_at) > t(prev.created_at)) openGroups.set(k, i);
  }
  for (const i of openGroups.values()) {
    const status = i.revoked_at ? 'cancelled' : t(i.expires_at) < now ? 'expired' : 'invited';
    people.push({ key: 'i:' + i.id, member_id: null, user_id: null, account_id: i.account_id, name: i.name || null, email: i.email,
      role: i.role, status, joined_at: null, last_seen_at: null, invite: i });
  }

  // ---------- the audit log, per person ----------
  const auditFor = (p) => pev.filter((e) => e.user_id === p.account_id && (
    (p.name && e.party_name === p.name) || (p.email && (e.party_name === p.email || lc(e.note).startsWith(lc(p.email) + ' ')))
    || (p.user_id && e.actor_id === p.user_id && e.event === 'joined')));

  const totalsPages = {};
  for (const p of people) {
    const audit = auditFor(p);
    const inv = p.invite;
    const invitedEv = audit.find((e) => e.event === 'invited');
    p.role_label = ROLE_LABEL[p.role] || p.role;
    p.business = companyOf[p.account_id] || null;
    p.owner_email = emails[p.account_id] || null;
    p.invited_at = (inv && inv.created_at) || (invitedEv && invitedEv.created_at) || null;
    p.invited_by = (invitedEv && invitedEv.actor_name) || null;
    p.expires_at = inv && !inv.used_at ? inv.expires_at : null;
    p.removed_at = (audit.filter((e) => e.event === 'removed').pop() || {}).created_at || null;
    p.hours_to_join = hours(t(p.invited_at), t(p.joined_at));

    // WhatsApp link + Margyn's first message
    const link = p.member_id ? links.find((l) => l.member_id === p.member_id && l.whatsapp_access) : null;
    const phone = link ? digits(link.phone) : null;
    const linkedEv = phone ? audit.filter((e) => e.event === 'whatsapp_linked' && digits(e.note).includes(phone)).pop() : null;
    const linkedAt = linkedEv ? t(linkedEv.created_at) : link ? t(link.created_at) : NaN;
    const wel = phone ? welcomes.filter((w) => digits(w.to_phone) === phone && w.user_id === p.account_id).sort((a, b) => t(a.sent_at) - t(b.sent_at)) : [];
    const w = wel[wel.length - 1] || null;
    p.whatsapp = {
      linked: !!link, last4: phone ? phone.slice(-4) : null, linked_at: iso(linkedAt), stakeholder_id: link ? link.id || null : null,
      linked_by: linkedEv ? (/automatically/.test(linkedEv.note || '') ? 'automatically, from their sign-up' : /by themselves/.test(linkedEv.note || '') ? 'themselves' : (linkedEv.actor_name || 'the owner')) : null,
      welcome: w ? {
        status: w.read_at ? 'read' : w.delivered_at ? 'delivered' : w.failed_at || w.status === 'failed' ? 'failed' : 'sent',
        sent_at: w.sent_at || null, delivered_at: w.delivered_at || null, read_at: w.read_at || null,
        error_code: w.error_code || null, sends: wel.length
      } : null
    };
    // Every message Margyn sent this number for this business (welcome, daily updates, hand-written ones), newest first.
    const KIND_LABEL = { welcome: 'First message', watch: 'Daily update', note: 'Hand-written update', chase: 'Payment reminder' };
    const msgs = phone ? (d.sends || []).filter((x) => digits(x.to_phone) === phone && x.user_id === p.account_id)
      .sort((a, b) => t(b.sent_at) - t(a.sent_at)) : [];
    p.whatsapp.messages = msgs.slice(0, 20).map((x) => ({
      kind: x.kind || 'watch', label: KIND_LABEL[x.kind] || 'Message', sent_at: x.sent_at || null,
      status: x.read_at || x.status === 'read' ? 'read' : x.delivered_at || x.status === 'delivered' ? 'delivered' : x.failed_at || x.status === 'failed' ? 'failed' : 'sent',
      delivered_at: x.delivered_at || null, read_at: x.read_at || null, error_code: x.error_code || null
    }));
    p.whatsapp.sent_30d = msgs.filter((x) => now - t(x.sent_at) < 30 * DAY).length;
    const lastDel = msgs.find((x) => x.delivered_at || x.read_at);
    p.whatsapp.last_delivered_at = lastDel ? (lastDel.read_at && !lastDel.delivered_at ? lastDel.read_at : lastDel.delivered_at) : null;

    // Activity: app (props.by), Ask Margyn (author_id), WhatsApp (their number)
    const evs = p.user_id ? (d.events || []).filter((e) => e.props && e.props.by === p.user_id && e.user_id === p.account_id) : [];
    const chats = p.user_id ? (d.chats || []).filter((c) => c.author_id === p.user_id && c.user_id === p.account_id) : [];
    const waIn = phone ? (d.convo || []).filter((c) => digits(c.from_phone) === phone && c.role === 'user' && c.profile_id === p.account_id) : [];
    const waOut = phone ? (d.convo || []).filter((c) => digits(c.from_phone) === phone && c.role === 'assistant' && c.profile_id === p.account_id) : [];
    const opens = evs.filter((e) => e.name === 'app_open');
    const views = evs.filter((e) => e.name === 'page_view');
    const since7 = now - 7 * DAY, since30 = now - 30 * DAY;
    const in7 = (x) => t(x) >= since7, in30 = (x) => t(x) >= since30;

    const pages = {};
    for (const v of views) {
      const pg = v.props && v.props.page;
      if (pg && pg !== 'left_app') { pages[pg] = pages[pg] || { page: pg, views: 0, secs: 0, last_at: null }; pages[pg].views++; if (!pages[pg].last_at || t(v.at) > t(pages[pg].last_at)) pages[pg].last_at = v.at; }
      const prev = v.props && v.props.prev_page, secs = v.props && v.props.prev_secs;
      if (prev && prev !== 'left_app' && Number.isFinite(secs)) { pages[prev] = pages[prev] || { page: prev, views: 0, secs: 0, last_at: null }; pages[prev].secs += Math.min(PAGE_SECS_CAP, secs); }
    }
    p.pages = Object.values(pages).sort((a, b) => b.secs - a.secs || b.views - a.views);
    for (const x of p.pages) { totalsPages[x.page] = totalsPages[x.page] || { page: x.page, views: 0, secs: 0, people: 0 }; totalsPages[x.page].views += x.views; totalsPages[x.page].secs += x.secs; totalsPages[x.page].people++; }

    const acts = [].concat(evs.map((e) => t(e.at)), chats.map((c) => t(c.created_at)), waIn.map((c) => t(c.created_at)),
      [t(p.last_seen_at)], [t(p.joined_at)]).filter(ok);
    const days = new Set(acts.filter((x) => x >= since30).map(istDay));
    const strip = [];
    for (let i = 29; i >= 0; i--) {
      const day = istDay(now - i * DAY);
      strip.push({ day, n: acts.filter((x) => istDay(x) === day).length });
    }
    const joinDay = ok(t(p.joined_at)) ? istDay(t(p.joined_at)) : null;
    const laterActs = joinDay ? acts.filter((x) => istDay(x) > joinDay) : [];
    const qTimes = [].concat(chats.map((c) => t(c.created_at)), waIn.map((c) => t(c.created_at))).filter((x) => !ok(t(p.joined_at)) || x >= t(p.joined_at));

    p.activity = {
      last_active_at: iso(maxOf(acts)),
      // Using it, not just having joined: anything they did, or the app open last_seen_at records.
      last_used_at: iso(maxOf([].concat(evs.map((e) => t(e.at)), chats.map((c) => t(c.created_at)), waIn.map((c) => t(c.created_at)), [t(p.last_seen_at)]))),
      active_days_30d: days.size,
      app_opens_7d: opens.filter((e) => in7(e.at)).length, app_opens_30d: opens.filter((e) => in30(e.at)).length,
      page_views_30d: views.filter((e) => in30(e.at) && e.props && e.props.page !== 'left_app').length,
      minutes_in_app_30d: Math.round(views.filter((e) => in30(e.at)).reduce((s, e) => s + (Number.isFinite(e.props && e.props.prev_secs) ? Math.min(PAGE_SECS_CAP, e.props.prev_secs) : 0), 0) / 60),
      questions_app_30d: chats.filter((c) => in30(c.created_at)).length, questions_app_total: chats.length,
      whatsapp_in_30d: waIn.filter((c) => in30(c.created_at)).length, whatsapp_in_total: waIn.length,
      whatsapp_out_30d: waOut.filter((c) => in30(c.created_at)).length,
      replied_after_welcome: !!(p.whatsapp.welcome && waIn.some((c) => t(c.created_at) > t(p.whatsapp.welcome.sent_at))),
      strip,
      tracked_since: views.length || opens.length ? iso(minOf(evs.map((e) => t(e.at)))) : null
    };

    // Their own business (an investor with their own empty login, a CA with their own firm)
    const ownZ = p.user_id ? (d.ownZoho || []).filter((z) => z.user_id === p.user_id) : [];
    const ownCb = p.user_id ? (d.ownEvents || []).filter((e) => e.user_id === p.user_id && e.name === 'zoho_callback') : [];
    p.own_account = p.user_id && hasOwn.has(p.user_id) ? {
      company: companyOf[p.user_id] || null,
      books: books[p.user_id] || null,
      whatsapp_on_file: phoneOnFile.has(p.user_id),
      zoho: ownZ.length ? ownZ.map((z) => z.status).join(', ') : null,
      zoho_failures: ownCb.filter((e) => e.props && e.props.ok === false).map((e) => ({ at: e.at, code: e.props.error_code || 'unexpected' })).slice(-5)
    } : null;
    p.business_books = books[p.account_id] || null;

    // Stages
    const st = {
      invited: p.invited_at,
      joined: p.joined_at,
      whatsapp_linked: p.whatsapp.linked_at,
      welcome_delivered: p.whatsapp.welcome && (p.whatsapp.welcome.delivered_at || p.whatsapp.welcome.read_at) || null,
      first_question: iso(minOf(qTimes)),
      came_back: iso(minOf(laterActs))
    };
    p.stages = st;
    p.stuck_at = ['cancelled', 'removed'].includes(p.status) ? null : STAGES.find((s) => !st[s]) || null;
    Object.assign(p, judge(p, now));
  }

  // ---------- totals ----------
  const invited = people.filter((p) => p.invited_at || p.status !== 'member');
  const joinedPeople = people.filter((p) => p.joined_at);
  const current = people.filter((p) => p.status === 'member' || p.status === 'suspended');
  const active7 = current.filter((p) => t(p.activity.last_used_at) >= now - 7 * DAY);
  const linked = current.filter((p) => p.whatsapp.linked);
  const wel = people.filter((p) => p.whatsapp.welcome);
  const asked30 = current.filter((p) => p.activity.questions_app_30d + p.activity.whatsapp_in_30d > 0);
  const funnel = STAGES.map((s, i) => {
    const pool = people.filter((p) => !['cancelled'].includes(p.status));
    const n = pool.filter((p) => p.stages[s]).length;
    const prevN = i ? pool.filter((p) => p.stages[STAGES[i - 1]]).length : n;
    return { stage: s, label: STAGE_LABELS[s], count: n, from_previous_pct: i ? pct(n, prevN) : null,
      median_hours_from_previous: i ? median(pool.filter((p) => p.stages[s] && p.stages[STAGES[i - 1]]).map((p) => hours(t(p.stages[STAGES[i - 1]]), t(p.stages[s])))) : null };
  });
  const totals = {
    people: people.length,
    invites_sent: invited.length,
    joined: joinedPeople.length,
    join_rate_pct: pct(joinedPeople.filter((p) => p.invited_at).length, people.filter((p) => p.invited_at && p.status !== 'cancelled').length),
    median_hours_to_join: median(joinedPeople.map((p) => p.hours_to_join)),
    open_invites: people.filter((p) => p.status === 'invited').length,
    expiring_48h: people.filter((p) => p.status === 'invited' && t(p.expires_at) - now < 2 * DAY).length,
    expired_unused: people.filter((p) => p.status === 'expired').length,
    cancelled: people.filter((p) => p.status === 'cancelled').length,
    removed: people.filter((p) => p.status === 'removed').length,
    members: current.length,
    active_7d: active7.length,
    whatsapp_linked: linked.length, whatsapp_linked_pct: pct(linked.length, current.length),
    welcome_sent: wel.length,
    welcome_delivered: wel.filter((p) => ['delivered', 'read'].includes(p.whatsapp.welcome.status)).length,
    welcome_read: wel.filter((p) => p.whatsapp.welcome.status === 'read').length,
    welcome_failed: wel.filter((p) => p.whatsapp.welcome.status === 'failed').length,
    asked_30d: asked30.length,
    questions_30d: current.reduce((s, p) => s + p.activity.questions_app_30d + p.activity.whatsapp_in_30d, 0),
    questions_whatsapp_share_pct: (() => { const a = current.reduce((s, p) => s + p.activity.questions_app_30d, 0), w = current.reduce((s, p) => s + p.activity.whatsapp_in_30d, 0); return pct(w, a + w); })(),
    avg_active_days_30d: current.length ? Math.round((current.reduce((s, p) => s + p.activity.active_days_30d, 0) / current.length) * 10) / 10 : null,
    needs_attention: people.filter((p) => p.health === 'red').length
  };

  // ---------- per business ----------
  const accounts = [...new Set(people.map((p) => p.account_id))];
  const businesses = accounts.map((a) => {
    const ps = people.filter((p) => p.account_id === a);
    const cur = ps.filter((p) => p.status === 'member' || p.status === 'suspended');
    return { account_id: a, business: companyOf[a] || null, owner_email: emails[a] || null, books: books[a] || null,
      members: cur.length, open_invites: ps.filter((p) => p.status === 'invited').length,
      active_7d: cur.filter((p) => active7.includes(p)).length, whatsapp_linked: cur.filter((p) => p.whatsapp.linked).length,
      roles: cur.reduce((o, p) => { o[p.role_label] = (o[p.role_label] || 0) + 1; return o; }, {}) };
  }).sort((x, y) => y.members - x.members);

  const RANKH = { red: 0, yellow: 1, green: 2, grey: 3 };
  people.sort((a, b) => RANKH[a.health] - RANKH[b.health] || (t(b.activity.last_active_at) || t(b.invited_at) || 0) - (t(a.activity.last_active_at) || t(a.invited_at) || 0));

  const missing = Object.entries({ members: d.members, invites: d.invites, audit: d.personEvents, whatsapp_links: d.links, welcome_receipts: d.welcomes, app_events: d.events, questions: d.chats, whatsapp_messages: d.convo })
    .filter(([, v]) => v == null).map(([k]) => k);
  return {
    stages: STAGES, stage_labels: STAGE_LABELS, totals, funnel, businesses, people,
    pages: Object.values(totalsPages).sort((a, b) => b.secs - a.secs || b.views - a.views),
    missing, generated_at: new Date(now).toISOString()
  };
}

/** Health + the one next step for this person. Rules, top to bottom; the first that fits wins. */
function judge(p, now) {
  const h = (ms) => Math.round(ms / 3600000);
  const dd = (ms) => Math.round(ms / DAY);
  const a = p.activity, w = p.whatsapp;
  const quietFor = ok(t(a.last_active_at)) ? now - t(a.last_active_at) : null;
  if (p.status === 'cancelled') return { health: 'grey', next: 'Invite cancelled. Nothing to do.' };
  if (p.status === 'removed') return { health: 'grey', next: 'Removed from the business' + (p.removed_at ? ' ' + dd(now - t(p.removed_at)) + 'd ago' : '') + '.' };
  if (p.status === 'expired') return { health: 'red', next: 'Invite expired unused ' + dd(now - t(p.expires_at)) + 'd ago. Make a new one if they still want in.' };
  if (p.status === 'invited') {
    const left = t(p.expires_at) - now;
    if (left < 2 * DAY) return { health: 'red', next: 'Not joined, and the invite expires in ' + Math.max(0, h(left)) + 'h. Nudge them now or it needs a new one.' };
    return { health: 'yellow', next: 'Invited ' + dd(now - t(p.invited_at)) + 'd ago, not joined yet. The link works until ' + new Date(t(p.expires_at) + IST).toISOString().slice(5, 10) + '.' };
  }
  if (p.status === 'suspended') return { health: 'grey', next: 'Suspended by the owner.' };
  if (w.welcome && w.welcome.status === 'failed') return { health: 'red', next: 'Margyn’s first WhatsApp to …' + w.last4 + ' failed' + (w.welcome.error_code ? ' (' + w.welcome.error_code + ')' : '') + '. Check the number with them.' };
  if (!w.linked) {
    if (p.business_books && !p.business_books.length) return { health: 'yellow', next: 'Joined, no WhatsApp linked. Margyn won’t ask yet: this business has no books connected.' };
    return { health: 'yellow', next: 'Joined, no WhatsApp linked yet. Margyn asks at their next sign-in; or link it for them under App logins.' };
  }
  if (w.welcome && w.welcome.status === 'sent' && now - t(w.welcome.sent_at) > 3600000) return { health: 'yellow', next: 'First WhatsApp sent ' + h(now - t(w.welcome.sent_at)) + 'h ago, WhatsApp hasn’t confirmed delivery. Their phone may be off, or the number isn’t on WhatsApp.' };
  if (!p.stages.first_question) {
    const since = now - (t(w.linked_at) || t(p.joined_at));
    return { health: since > 2 * DAY ? 'red' : 'yellow', next: 'Hasn’t asked Margyn anything yet' + (since > DAY ? ' in ' + dd(since) + 'd' : '') + '. Send them one question to try, e.g. “who owes us the most?”.' };
  }
  if (quietFor != null && quietFor > 7 * DAY) return { health: 'red', next: 'Quiet for ' + dd(quietFor) + 'd after using it. Worth a personal check-in.' };
  if (!p.stages.came_back && now - t(p.joined_at) > 2 * DAY) return { health: 'yellow', next: 'Used it on day one, hasn’t come back since. Ask what they were looking for.' };
  const q = a.questions_app_30d + a.whatsapp_in_30d;
  return { health: 'green', next: 'Active: ' + q + ' question' + (q === 1 ? '' : 's') + ' and ' + a.active_days_30d + ' active day' + (a.active_days_30d === 1 ? '' : 's') + ' in 30d. Ask for feedback.' };
}

/** Every read, in two rounds. A missing table or a failed read comes back as null, never as zero. */
async function load(deps, now) {
  now = now || Date.now();
  const S = (tbl, q) => deps.selectRows(tbl, q).catch(() => null);
  const since30 = new Date(now - 30 * DAY).toISOString();
  const [members, invites, personEvents, links, welcomes] = await Promise.all([
    S('account_members', 'select=id,account_id,user_id,email,name,role,status,created_at,last_seen_at&limit=5000'),
    S('account_invites', 'select=id,account_id,email,name,role,created_at,expires_at,used_at,used_by,revoked_at,created_by&limit=5000'),
    S('ledger_events', 'select=*&entity_type=eq.person&order=created_at.asc&limit=5000'),
    S('business_stakeholders', 'select=*&member_id=not.is.null&limit=5000'),
    S('wa_deliveries', 'select=message_id,user_id,to_phone,status,sent_at,delivered_at,read_at,failed_at,error_code&kind=eq.welcome&limit=5000')
  ]);
  const personIds = [...new Set([].concat((members || []).map((m) => m.user_id), (invites || []).map((i) => i.used_by)).filter((x) => UUID_RE.test(String(x || ''))))];
  const accountIds = [...new Set([].concat((members || []).map((m) => m.account_id), (invites || []).map((i) => i.account_id)).filter((x) => UUID_RE.test(String(x || ''))))];
  const phones = [...new Set((links || []).map((l) => digits(l.phone)).filter((x) => x.length >= 10))];
  const inList = (xs) => xs.map(encodeURIComponent).join(',');
  const none = Promise.resolve([]);
  const allIds = [...new Set(accountIds.concat(personIds))];
  const booksOf = deps.connectedBooks || require('./booksSource').connectedBooks;
  const [profiles, chats, events, convo, emails, ownZoho, ownEvents, booksList, sends] = await Promise.all([
    allIds.length ? S('profiles', `select=id,company_name,whatsapp_phone&id=in.(${inList(allIds)})`) : none,
    personIds.length ? S('chat_messages', `select=author_id,user_id,role,created_at&author_id=in.(${inList(personIds)})&role=eq.user&order=created_at.asc&limit=20000`) : none,
    personIds.length ? S('product_events', `select=user_id,name,at,props&props->>by=in.(${inList(personIds)})&at=gte.${since30}&order=at.asc&limit=20000`) : none,
    phones.length ? S('whatsapp_conversations', `select=from_phone,role,created_at,profile_id&from_phone=in.(${inList(phones)})&order=created_at.asc&limit=20000`) : none,
    deps.loadUserEmails && accountIds.length ? deps.loadUserEmails(accountIds).catch(() => ({})) : Promise.resolve({}),
    personIds.length ? S('zoho_organizations', `select=user_id,status&user_id=in.(${inList(personIds)})`) : none,
    personIds.length ? S('product_events', `select=user_id,name,at,props&user_id=in.(${inList(personIds)})&name=eq.zoho_callback&order=at.asc&limit=2000`) : none,
    Promise.all(allIds.slice(0, 60).map((id) => booksOf(id).then((b) => [id, b]).catch(() => [id, null]))),
    phones.length ? S('wa_deliveries', `select=message_id,user_id,kind,sent_to,to_phone,status,sent_at,delivered_at,read_at,failed_at,error_code&to_phone=in.(${inList(phones)})&order=sent_at.desc&limit=2000`) : none
  ]);
  return analyze({ members, invites, personEvents, links, welcomes, sends, profiles, chats, events, convo, emails, ownZoho, ownEvents,
    books: Object.fromEntries(booksList.filter(([, b]) => Array.isArray(b))) }, now);
}

module.exports = { analyze, load, judge, STAGES, STAGE_LABELS };
