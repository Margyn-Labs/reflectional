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
 *    concentration) or it gets worse by more than a quarter (then the line
 *    says by how much). One-off news (a bill that just went past due) is sent
 *    once only. At most MAX_PER_RUN points, one per customer. The midday run
 *    is for deadlines only (GST due in a few days, Tally gone quiet). The
 *    owner can mute one finding or a whole kind from the app, or reply STOP
 *    ALERTS on WhatsApp.
 *  - SHAPE (2026-10-04): when the books are from, money that came in, cash
 *    and overdraft, then the points with amounts, then how to reply. Names
 *    the way a person says them, not "SUN PHARMA LABORATORIES LTD".
 *  - TO WHOM (profiles.preferences.margyn_watch.mode, chosen in the app):
 *      off     (default) nothing is sent; findings still show in the app.
 *      preview sent to MARGYN_WATCH_PREVIEW_PHONE (the Margyn team's test
 *              number) instead of the business, so a new account can be
 *              checked before it goes live. A preview never counts as sent
 *              to the owner, so switching to On later still sends it.
 *      on      sent to the account's own WhatsApp number (profiles.whatsapp_phone,
 *              only with whatsapp_opt_in).
 *  - HOW: WhatsApp lets a business send free text only within 24 hours of
 *    the person's last message. Inside that window it's a normal message;
 *    outside it, an approved template carries it: WHATSAPP_TEMPLATE_ALERT_V2
 *    (a short "your update is ready" with a See details button; the full
 *    update waits in watch_pending and goes out the moment they reply) or
 *    the older WHATSAPP_TEMPLATE_ALERT (points run together on one line).
 *    With neither, nothing is sent and the app says why.
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
const deliveries = require('./waDeliveries');

const DAY = 86400000;
const MAX_PER_RUN = 3;
// How long before the same finding may be sent again (days). News kinds are once only.
const COOLDOWN_DAYS = {
  stale: 2, overdue_total: 7, slipping: 7, old_debts: 30, late: 14, short_paid: 30, quiet: 21, concentration: 60, collection_days: 30,
  commission: 60, expense_jump: 365, unbooked: 365, sales_trend: 365, below_cost: 30, unit_mismatch: 60,
  gst_due: 365, receipt: 3650, newly_overdue: 3650, duplicate: 3650
};
// Never a point of their own: good news goes in the "money in" line instead.
const NOT_A_POINT = new Set(['receipt']);
const MODES = ['off', 'preview', 'on'];
const PENDING_HOURS = 24;

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

/** Midday is for things with a clock on them, not another round of the morning's points. */
function isDeadline(x) {
  return x.kind === 'stale' || (x.kind === 'gst_due' && x.severity === 'high');
}

/**
 * The findings this run should send, given what was sent before.
 * mode 'on' ignores sends that only went to the preview phone (they never reached the owner).
 * Returns the chosen findings, each with `was` (the earlier figure) when it's back because it got worse.
 */
function choose(list, state, slot, now, mode) {
  const byKey = new Map(state.map((s) => [s.key, s]));
  const mutedKinds = new Set(state.filter((s) => s.key.startsWith('mute:') && s.status === 'muted').map((s) => s.kind));
  const t = now ? new Date(now).getTime() : Date.now();
  const out = [], parties = new Set();
  for (const x of list) {
    if (out.length >= MAX_PER_RUN) break;
    if (NOT_A_POINT.has(x.kind) || mutedKinds.has(x.kind)) continue;
    const s = byKey.get(x.key);
    if (s && s.status === 'muted') continue;
    if (slot === 'midday' && !isDeadline(x)) continue;
    // One point per customer: their overdue bills, "short paid" and "gone quiet" are one conversation.
    const pk = x.party ? E.niceName(x.party).toLowerCase() : null;
    if (pk && parties.has(pk)) continue;
    const sentAt = s && s.last_sent_at && !(mode === 'on' && s.sent_to === 'preview') ? Date.parse(s.last_sent_at) : null;
    let ok = false, was = null;
    if (!sentAt) ok = true;
    else {
      const days = (t - sentAt) / DAY;
      if (days >= (COOLDOWN_DAYS[x.kind] || 14)) ok = true;
      else {
        // Back sooner only if it got worse by more than a quarter (never twice in a day). Smaller is not news.
        const prev = Number(s.impact) || 0;
        if (days >= 1 && prev > 0 && (x.impact || 0) > prev * 1.25) { ok = true; was = { impact: prev, at: s.last_sent_at }; }
      }
    }
    if (!ok) continue;
    if (pk) parties.add(pk);
    out.push(was ? Object.assign({}, x, { was }) : x);
  }
  return out;
}

function greeting(slot) {
  return slot === 'morning' ? 'Good morning' : slot === 'evening' ? 'Evening update' : slot === 'midday' ? 'Heads up' : 'Your update';
}
function shortCompany(name) { return String(name || 'your business').replace(/\s*\(\d{4}-\d{2,4}\)\s*$/, '').replace(/\s+((pvt|private)\.?\s+)?(ltd|limited|llp)\.?$/i, '').trim(); }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Oct, 6:58 pm" in India time. */
function istStamp(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 5.5 * 3600000);
  let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, '0'), ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${h}:${m} ${ap}`;
}

/** Money in since yesterday, and the cash / overdraft position, as two short lines. Never throws. */
function context(ctx) {
  const lines = [];
  try {
    const from = new Date(ctx.today.getTime() - DAY);
    const recs = ctx.rows.filter((r) => r.kind === 'receipt' && r.dt >= from && r.total > 0);
    if (recs.length) {
      const by = new Map();
      for (const r of recs) { const k = r.party ? E.niceName(r.party) : 'others'; by.set(k, (by.get(k) || 0) + r.total); }
      const top = [...by.entries()].sort((a, b) => b[1] - a[1]);
      const tot = recs.reduce((s, r) => s + r.total, 0);
      lines.push(`Money in since yesterday: ${E.inr(tot)}` + (top.length ? ' (' + top.slice(0, 2).map(([k, v]) => `${k} ${E.inr(v)}`).join(', ') + (top.length > 2 ? ` and ${top.length - 2} more` : '') + ')' : '') + '.');
    } else lines.push('No money from customers entered in Tally since yesterday.');
  } catch (e) { /* skip the line */ }
  try {
    const cd = E.cashAndDebt(ctx);
    lines.push(`Bank and cash ${cd.cash_and_bank_total}` + (cd.total_borrowed && cd.total_borrowed !== '₹0' ? ` · overdraft and loans ${cd.total_borrowed}` : '') + '.');
  } catch (e) { /* skip the line */ }
  return lines;
}

/** One point: what, how much, what to do, and what changed if it's back. */
function pointLine(x) {
  const changed = x.was ? ` (up from ${E.inr(x.was.impact)} on ${istStamp(x.was.at).split(',')[0]})` : '';
  return `${x.title}${changed}${x.action ? ' ' + x.action : ''}`;
}

/** The WhatsApp text: when it's from, money in, cash, the points, how to reply. */
function compose(items, { company, slot, preview, firstName, lastSync, ctxLines }) {
  const asOf = istStamp(lastSync);
  const head = (preview ? `[Preview for ${shortCompany(company)}. They have not been sent this.]\n\n` : '') +
    `${greeting(slot)}${firstName ? ' ' + firstName : ''}.` + (asOf ? ` Your Tally books as of ${asOf}:` : ' From your Tally books:');
  const ctxBlock = (ctxLines || []).length ? '\n\n' + ctxLines.join('\n') : '';
  const body = items.length
    ? '\n\n' + (items.length === 1 ? 'One thing needs you:' : `${items.length} things need you:`) + '\n\n' + items.map((x, i) => `${i + 1}. ${pointLine(x)}`).join('\n\n')
    : '\n\nNothing new needs you today.';
  const foot = items.length > 1 ? `Reply ${items.map((_, i) => i + 1).join(', ').replace(/, (\d)$/, ' or $1')} to know more, or ask me anything.`
    : items.length ? 'Reply 1 to know more, or ask me anything.' : 'Ask me anything about your books.';
  return `${head}${ctxBlock}${body}\n\n${foot} Reply STOP ALERTS to pause these.`;
}
/** Older template: parameters can't hold new lines, so the points are run together. */
function templateParams(items, { company, firstName }) {
  const points = items.map((x, i) => `(${i + 1}) ${x.title}`).join(' ').replace(/\s+/g, ' ');
  return [String(firstName || shortCompany(company)).slice(0, 60), points.slice(0, 900)];
}
/** Short template: name and a one-line headline; the full update follows when they tap See details. */
function teaserParams(items, { company, firstName }) {
  const n = items.length;
  const head = (n === 1 ? 'One thing in your books needs you today: ' : `${n} things in your books need you today. The biggest: `) + (items[0] ? items[0].title : '');
  return [String(firstName || shortCompany(company)).slice(0, 60), head.replace(/\s+/g, ' ').slice(0, 300)];
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

/** The full update waiting for a tap on See details. Returns false when the table isn't there yet. */
async function savePending(phone, userId, text) {
  try {
    await insertRows('watch_pending', [{ phone: digits(phone), user_id: userId, text, created_at: new Date().toISOString() }], { onConflict: 'phone', merge: true });
    return true;
  } catch (e) { return false; }
}
/** Called on any WhatsApp message from `phone`: the waiting update, once, if it's under a day old. */
async function takePending(phone) {
  const d = digits(phone);
  if (!d) return null;
  try {
    const r = await selectRows('watch_pending', `select=text,user_id,created_at&phone=eq.${d}&limit=1`);
    if (!r[0] || !r[0].text) return null;
    const row = Object.assign({}, r[0]);
    await updateRows('watch_pending', `phone=eq.${d}`, { text: '', created_at: new Date(0).toISOString() }).catch(() => {});
    return Date.now() - Date.parse(row.created_at) > PENDING_HOURS * 3600000 ? null : row;
  } catch (e) { return null; }
}

async function saveState(userId, list, chosen, sentInfo, state) {
  const nowIso = new Date().toISOString();
  const prev = new Map(state.map((s) => [s.key, s]));
  const chosenKeys = new Set(chosen.map((x) => x.key));
  const rows = list.map((x) => {
    const p = prev.get(x.key) || {};
    // A preview never overwrites a real send to the owner (that would reset the owner's cooldown).
    const sent = !!(sentInfo && chosenKeys.has(x.key)) && !(sentInfo.to === 'preview' && p.sent_to === 'owner');
    return {
      user_id: userId, key: x.key, kind: x.kind, severity: x.severity, impact: Math.round(x.impact || 0),
      title: x.title, detail: x.detail || null, action: x.action || null, ask: x.ask || null,
      status: p.status === 'muted' ? 'muted' : sent ? 'sent' : (p.status === 'sent' ? 'sent' : 'open'),
      last_seen: nowIso,
      last_sent_at: sent ? nowIso : (p.last_sent_at || null),
      sent_count: (Number(p.sent_count) || 0) + (sent && sentInfo.to === 'owner' ? 1 : 0),
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
 * opts.previewOnly: the app's "Preview today's update". Works out the message the owner would get next, sends
 * it only to the preview phone (and only in preview mode), and records nothing, so it never repeats or uses up
 * a point.
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
  const chosen = choose(list, state, o.previewOnly ? 'manual' : slot, o.now, mode === 'preview' ? 'preview' : 'on');
  const company = ctx.company || profile.company_name;
  const ctxLines = context(ctx);

  if (o.previewOnly) {
    const text = compose(chosen, { company, slot, preview: false, firstName: firstNameOf(profile), lastSync: ctx.lastSync, ctxLines });
    const res = { user: userId, mode, found: list.length, chosen: chosen.map((x) => x.kind), text };
    if (mode === 'preview' && process.env.MARGYN_WATCH_PREVIEW_PHONE) {
      const to = process.env.MARGYN_WATCH_PREVIEW_PHONE;
      const ptext = compose(chosen, { company, slot, preview: true, lastSync: ctx.lastSync, ctxLines });
      const s = (await sessionOpen(to, o.now)) ? await bsp.sendText({ to, text: ptext }) : null;
      res.sent_to_preview_phone = !!(s && s.ok);
      if (s && s.ok) await deliveries.record({ messageId: s.messageId, userId, kind: 'watch', to, sentTo: 'preview_copy', keys: [] });
    }
    return res;
  }

  let sentInfo = null, result = { user: userId, mode, found: list.length, chosen: chosen.map((x) => x.kind) };
  if (chosen.length && mode !== 'off') {
    const preview = mode === 'preview';
    const to = preview ? process.env.MARGYN_WATCH_PREVIEW_PHONE : (profile.whatsapp_opt_in !== false ? profile.whatsapp_phone : null);
    if (!to) {
      result.not_sent = preview ? 'MARGYN_WATCH_PREVIEW_PHONE is not set in Vercel' : 'no WhatsApp number on the account (Settings > Profile)';
    } else {
      const firstName = preview ? null : firstNameOf(profile);
      const text = compose(chosen, { company, slot, preview, firstName, lastSync: ctx.lastSync, ctxLines });
      let sent = null;
      if (await sessionOpen(to, o.now)) {
        sent = await bsp.sendText({ to, text });
        if (sent && sent.ok) sentInfo = { via: 'session', to: preview ? 'preview' : 'owner' };
      }
      if (!sentInfo && process.env.WHATSAPP_TEMPLATE_ALERT_V2) {
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_ALERT_V2, params: teaserParams(chosen, { company, firstName }) });
        if (sent && sent.ok) {
          sentInfo = { via: 'template', to: preview ? 'preview' : 'owner' };
          // The full update goes out when they tap See details (or reply anything) within a day.
          await savePending(to, userId, text);
        }
      }
      if (!sentInfo && process.env.WHATSAPP_TEMPLATE_ALERT) {
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_ALERT, params: templateParams(chosen, { company, firstName }) });
        if (sent && sent.ok) sentInfo = { via: 'template', to: preview ? 'preview' : 'owner' };
      }
      if (sentInfo) {
        result.sent = sentInfo;
        // Gupshup taking it is not WhatsApp delivering it: keep the id so the delivery report can be matched.
        await deliveries.record({ messageId: sent && sent.messageId, userId, kind: 'watch', to, sentTo: sentInfo.to, keys: chosen.map((x) => x.key) });
        if (!preview) {
          // In the owner's thread, so a reply of "2" or "why?" has the context.
          await insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text, tool_calls: null, wa_message_id: (sent && sent.messageId) || null, from_phone: digits(to) }])
            .catch(() => insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text }]).catch(() => {}));
        }
        await track(userId, 'watch_sent', { kind: chosen[0].kind, points: chosen.length, mode, via: sentInfo.via });
      } else {
        result.not_sent = (sent && sent.error) ? String(sent.error).slice(0, 160)
          : 'No open WhatsApp chat in the last 24 hours and no alert template is set, so WhatsApp won\'t accept a message from us yet.';
      }
    }
  }
  if (!o.dryRun) await saveState(userId, list, chosen, sentInfo, state);
  return result;
}
function firstNameOf(profile) {
  return String(((profile && profile.preferences) || {}).display_name || '').trim().split(/\s+/)[0] || null;
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
    has_number: !!p.whatsapp_phone,
    // So the switch can say exactly whose phone "On" texts, e.g. "Mihir's WhatsApp (…4000)".
    owner_name: firstNameOf(p), owner_phone_end: p.whatsapp_phone ? digits(p.whatsapp_phone).slice(-4) : null,
    preview_available: !!process.env.MARGYN_WATCH_PREVIEW_PHONE,
    template_ready: !!(process.env.WHATSAPP_TEMPLATE_ALERT || process.env.WHATSAPP_TEMPLATE_ALERT_V2),
    // Whether each update actually arrived (null = delivery tracking not set up yet).
    deliveries: await deliveries.recent(userId, 20),
    signals: rows
  };
}

module.exports = { watchAccount, runWatchAll, setMode, mute, signals, choose, compose, templateParams, teaserParams, takePending, modeOf, isDeadline, MODES, COOLDOWN_DAYS };
