/**
 * _lib/margynWatch.js
 * Margyn Watch: Margyn reads the books on its own a few times a day and
 * texts the owner on WhatsApp when something deserves attention, the way a
 * finance person who reads the books every morning would.
 *
 * What it says comes from booksEngine.insights(): deterministic, worked out
 * in plain JS, biggest and most urgent first. Watch only decides WHETHER to
 * say it, to WHOM, and HOW:
 *
 *  - WHETHER: each finding has a stable key. It's sent once, then not again
 *    until its cooldown passes (a week for overdue money, two months for
 *    concentration) or its size moves by more than a quarter. One-off news
 *    (a big receipt, a bill that just went overdue) is sent once only. At
 *    most MAX_PER_RUN points per message, and the midday run only sends
 *    high-priority points or fresh news. The owner can mute one finding or a
 *    whole kind from the app, or reply STOP ALERTS on WhatsApp.
 *  - TO WHOM (profiles.preferences.margyn_watch.mode, chosen in the app):
 *      off     (default) nothing is sent; findings still show in the app.
 *      preview sent to MARGYN_WATCH_PREVIEW_PHONE (the Margyn team's test
 *              number) instead of the business, so a new account can be
 *              checked before it goes live. Shown to the owner in the app.
 *      on      sent to the account's own WhatsApp number (profiles.whatsapp_phone,
 *              only with whatsapp_opt_in).
 *  - HOW: WhatsApp lets a business send free text only within 24 hours of
 *    the person's last message. Inside that window it's a normal message;
 *    outside it, the approved WHATSAPP_TEMPLATE_ALERT carries it. With
 *    neither, nothing is sent and the app says why.
 *
 * Every finding seen is kept in margyn_signals (status open / sent / muted /
 * resolved) so the Conversations hub can show what Margyn noticed, what was
 * sent, and when. A message sent to the owner is also written into their
 * WhatsApp thread, so "1" or "why?" as a reply has the context.
 *
 * CommonJS, zero-npm.
 */

const { selectRows, insertRows, updateRows } = require('./supabaseRest');
const bsp = require('./whatsappBsp');
const booksTools = require('./booksTools');
const E = require('./booksEngine');
const { track } = require('./track');

const DAY = 86400000;
const MAX_PER_RUN = 3;
// How long before the same finding may be sent again (days). News kinds are once only.
const COOLDOWN_DAYS = {
  stale: 2, overdue_total: 7, old_debts: 30, late: 14, quiet: 21, concentration: 60, funding_gap: 30,
  commission: 60, expense_jump: 365, unbooked: 365, sales_trend: 365, below_cost: 30, unit_mismatch: 60,
  gst_due: 365, receipt: 3650, newly_overdue: 3650, duplicate: 3650
};
const MODES = ['off', 'preview', 'on'];

const digits = (p) => String(p || '').replace(/[^\d]/g, '');

async function prefsOf(userId) {
  try {
    const r = await selectRows('profiles', `select=preferences,whatsapp_phone,whatsapp_opt_in,company_name&id=eq.${userId}&limit=1`);
    return r[0] || {};
  } catch (e) {
    const r = await selectRows('profiles', `select=whatsapp_phone,whatsapp_opt_in,company_name&id=eq.${userId}&limit=1`).catch(() => []);
    return r[0] || {};
  }
}
function modeOf(profile) {
  const w = profile && profile.preferences && profile.preferences.margyn_watch;
  const m = w && typeof w === 'object' ? w.mode : null;
  return MODES.includes(m) ? m : 'off';
}

/** The findings this run should send, given what was sent before. */
function choose(list, state, slot, now) {
  const byKey = new Map(state.map((s) => [s.key, s]));
  const mutedKinds = new Set(state.filter((s) => s.key.startsWith('mute:') && s.status === 'muted').map((s) => s.kind));
  const t = now ? new Date(now).getTime() : Date.now();
  const due = list.filter((x) => {
    if (mutedKinds.has(x.kind)) return false;
    const s = byKey.get(x.key);
    if (s && s.status === 'muted') return false;
    if (slot === 'midday' && x.severity !== 'high' && !x.news) return false;
    if (!s || !s.last_sent_at) return true;
    const days = (t - Date.parse(s.last_sent_at)) / DAY;
    if (days >= (COOLDOWN_DAYS[x.kind] || 14)) return true;
    // A finding that grew or shrank by more than a quarter is news again (but never twice in a day).
    const was = Number(s.impact) || 0;
    return days >= 1 && was > 0 && Math.abs((x.impact || 0) - was) / was > 0.25;
  });
  return due.slice(0, MAX_PER_RUN);
}

function greeting(slot) {
  return slot === 'morning' ? 'Good morning' : slot === 'evening' ? 'Evening update' : 'Quick update';
}
function shortCompany(name) { return String(name || 'your business').replace(/\s*\(\d{4}-\d{2,4}\)\s*$/, '').replace(/\s+((pvt|private)\.?\s+)?(ltd|limited|llp)\.?$/i, '').trim(); }

/** The WhatsApp text: plain, numbered, one line each, and how to reply. */
function compose(items, { company, slot, preview, firstName }) {
  const head = (preview ? `[Preview for ${shortCompany(company)}. They have not been sent this.]\n\n` : '') +
    `${greeting(slot)}${firstName ? ' ' + firstName : ''}. Here's what I noticed in your books today:`;
  const body = items.map((x, i) => `${i + 1}. ${x.title}${x.action ? ' ' + x.action : ''}`).join('\n\n');
  return `${head}\n\n${body}\n\nReply with a number to know more, or ask me anything about your books. Reply STOP ALERTS to pause these.`;
}
/** Template parameters can't hold new lines, so the points are run together. */
function templateParams(items, { company, firstName }) {
  const points = items.map((x, i) => `(${i + 1}) ${x.title}`).join(' ').replace(/\s+/g, ' ');
  return [String(firstName || shortCompany(company)).slice(0, 60), points.slice(0, 900)];
}

async function sessionOpen(phone, now) {
  const d = digits(phone);
  if (!d) return false;
  try {
    const r = await selectRows('whatsapp_conversations', `select=created_at&from_phone=eq.${d}&role=eq.user&order=created_at.desc&limit=1`);
    const t = now ? new Date(now).getTime() : Date.now();
    return !!(r[0] && t - Date.parse(r[0].created_at) < 23 * 3600000);
  } catch (e) { return false; }
}

async function saveState(userId, list, chosen, sentInfo, state) {
  const nowIso = new Date().toISOString();
  const prev = new Map(state.map((s) => [s.key, s]));
  const rows = list.map((x) => {
    const p = prev.get(x.key) || {};
    const sent = sentInfo && chosen.includes(x);
    return {
      user_id: userId, key: x.key, kind: x.kind, severity: x.severity, impact: Math.round(x.impact || 0),
      title: x.title, detail: x.detail || null, action: x.action || null, ask: x.ask || null,
      status: p.status === 'muted' ? 'muted' : sent ? 'sent' : (p.status === 'sent' ? 'sent' : 'open'),
      last_seen: nowIso,
      last_sent_at: sent ? nowIso : (p.last_sent_at || null),
      sent_count: (Number(p.sent_count) || 0) + (sent ? 1 : 0),
      sent_via: sent ? sentInfo.via : (p.sent_via || null),
      sent_to: sent ? sentInfo.to : (p.sent_to || null)
    };
  });
  if (rows.length) await insertRows('margyn_signals', rows, { onConflict: 'user_id,key', merge: true });
  // Findings that are no longer true are marked resolved, so they can come back later as new.
  const live = new Set(list.map((x) => x.key));
  const gone = state.filter((s) => !s.key.startsWith('mute:') && !live.has(s.key) && (s.status === 'open' || s.status === 'sent'));
  for (const s of gone.slice(0, 50)) {
    await updateRows('margyn_signals', `user_id=eq.${userId}&key=eq.${encodeURIComponent(s.key)}`, { status: 'resolved' }).catch(() => {});
  }
}

/**
 * One account. slot: 'morning' | 'midday' | 'evening' | 'manual'.
 * opts.force sends the top findings even if they were sent recently (the app's "send me today's update").
 */
async function watchAccount(userId, opts) {
  const o = opts || {};
  const slot = o.slot || 'manual';
  const { ctx } = await booksTools.contextFor(userId);
  if (!ctx || !ctx.rows.length) return { user: userId, skipped: 'no Tally books' };
  const list = E.insights(ctx);
  let state;
  try { state = await selectRows('margyn_signals', `select=key,kind,status,impact,last_sent_at,sent_count,sent_via,sent_to&user_id=eq.${userId}&limit=1000`); }
  catch (e) { return { user: userId, skipped: 'margyn_signals table missing (run the SQL)' }; }

  const profile = await prefsOf(userId);
  const mode = o.mode || modeOf(profile);
  const chosen = o.force ? list.filter((x) => !state.some((s) => (s.key === x.key || (s.key === 'mute:' + x.kind)) && s.status === 'muted')).slice(0, MAX_PER_RUN) : choose(list, state, slot, o.now);

  let sentInfo = null, result = { user: userId, mode, found: list.length, chosen: chosen.map((x) => x.kind) };
  if (chosen.length && mode !== 'off') {
    const preview = mode === 'preview';
    const to = preview ? process.env.MARGYN_WATCH_PREVIEW_PHONE : (profile.whatsapp_opt_in !== false ? profile.whatsapp_phone : null);
    if (!to) {
      result.not_sent = preview ? 'MARGYN_WATCH_PREVIEW_PHONE is not set in Vercel' : 'no WhatsApp number on the account (Settings > Profile)';
    } else {
      const firstName = preview ? null : String(((profile.preferences || {}).display_name) || '').trim().split(/\s+/)[0] || null;
      const text = compose(chosen, { company: ctx.company || profile.company_name, slot, preview, firstName });
      let sent = null;
      if (await sessionOpen(to, o.now)) {
        sent = await bsp.sendText({ to, text });
        if (sent && sent.ok) sentInfo = { via: 'session', to: preview ? 'preview' : 'owner' };
      }
      if (!sentInfo && process.env.WHATSAPP_TEMPLATE_ALERT) {
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_ALERT, params: templateParams(chosen, { company: ctx.company || profile.company_name, firstName }) });
        if (sent && sent.ok) sentInfo = { via: 'template', to: preview ? 'preview' : 'owner' };
      }
      if (sentInfo) {
        result.sent = sentInfo;
        if (!preview) {
          // In the owner's thread, so a reply of "2" or "why?" has the context.
          await insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text, tool_calls: null, wa_message_id: (sent && sent.messageId) || null, from_phone: digits(to) }])
            .catch(() => insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text }]).catch(() => {}));
        }
        await track(userId, 'watch_sent', { kind: chosen[0].kind, points: chosen.length, mode, via: sentInfo.via });
      } else {
        result.not_sent = (sent && sent.error) ? String(sent.error).slice(0, 160)
          : 'No open WhatsApp chat in the last 24 hours and WHATSAPP_TEMPLATE_ALERT is not set, so WhatsApp won\'t accept a message from us yet.';
      }
    }
  }
  if (!o.dryRun) await saveState(userId, list, chosen, sentInfo, state);
  return result;
}

/** Every account with Tally connected. Bounded so one cron run can't overrun. */
async function runWatchAll(slot, opts) {
  const o = opts || {};
  const started = Date.now(), budgetMs = o.budgetMs || 45000;
  let users = [];
  try {
    const rows = await selectRows('tally_installs', 'select=user_id&status=eq.active&limit=500');
    users = [...new Set(rows.map((r) => r.user_id))];
  } catch (e) { return { slot, error: 'could not list Tally accounts' }; }
  const results = [];
  for (const u of users) {
    if (Date.now() - started > budgetMs) { results.push({ user: u, skipped: 'out of time this run' }); continue; }
    try { results.push(await watchAccount(u, { slot })); }
    catch (e) { results.push({ user: u, error: String(e.message || e).slice(0, 160) }); }
  }
  return { slot, accounts: users.length, sent: results.filter((r) => r.sent).length, results };
}

/** Owner choices from the app: mode, mute / unmute a finding or a whole kind. */
async function setMode(userId, mode) {
  if (!MODES.includes(mode)) throw new Error('mode must be one of ' + MODES.join(', '));
  const p = await prefsOf(userId);
  const prefs = Object.assign({}, (p && p.preferences) || {});
  prefs.margyn_watch = Object.assign({}, prefs.margyn_watch || {}, { mode, changed_at: new Date().toISOString() });
  await updateRows('profiles', `id=eq.${userId}`, { preferences: prefs });
  return mode;
}
async function mute(userId, { key, kind, unmute }) {
  if (kind) {
    await insertRows('margyn_signals', [{ user_id: userId, key: 'mute:' + kind, kind, status: unmute ? 'resolved' : 'muted', title: 'Muted: ' + kind, last_seen: new Date().toISOString() }], { onConflict: 'user_id,key', merge: true });
    return { kind, muted: !unmute };
  }
  if (key) {
    await updateRows('margyn_signals', `user_id=eq.${userId}&key=eq.${encodeURIComponent(key)}`, { status: unmute ? 'open' : 'muted' });
    return { key, muted: !unmute };
  }
  throw new Error('key or kind required');
}
async function signals(userId) {
  const p = await prefsOf(userId);
  let rows = [];
  try { rows = await selectRows('margyn_signals', `select=key,kind,severity,impact,title,detail,action,ask,status,first_seen,last_seen,last_sent_at,sent_count,sent_via,sent_to&user_id=eq.${userId}&order=last_seen.desc&limit=200`); }
  catch (e) { return { mode: modeOf(p), ready: false, note: 'Run the Margyn Watch SQL to keep a history of what Margyn noticed.' }; }
  return {
    mode: modeOf(p), ready: true,
    has_number: !!p.whatsapp_phone, preview_available: !!process.env.MARGYN_WATCH_PREVIEW_PHONE,
    template_ready: !!process.env.WHATSAPP_TEMPLATE_ALERT,
    signals: rows
  };
}

module.exports = { watchAccount, runWatchAll, setMode, mute, signals, choose, compose, templateParams, modeOf, MODES, COOLDOWN_DAYS };
