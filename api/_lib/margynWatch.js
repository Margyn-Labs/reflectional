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
 *  - SHAPE (2026-10-05, watchBrief.js): a cadence, not three copies of one
 *    message. Morning (07:30) is the detailed one: where you stand, yesterday,
 *    this week, up to three points (at most two about money owed) each with
 *    why now / backing / next, and one "worth knowing" the owner wouldn't see
 *    alone. Midday (10:30) and afternoon (15:00) send only what changed since
 *    the last update, or nothing. Evening (19:00) follows up on each of the
 *    morning's points, wraps the day's money, and says what's due tomorrow.
 *    Each update keeps a snapshot (margyn_signals rows snap:morning / snap:last)
 *    so the next one can say what moved. Names the way a person says them.
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
 *    the older WHATSAPP_TEMPLATE_ALERT (points run together on one line). Tried first:
 *    WHATSAPP_TEMPLATE_UPDATE (the update's figures, a section per line; see updateParams).
 *    With neither, nothing is sent and the app says why.
 *
 * Every finding seen is kept in margyn_signals (status open / sent / muted /
 * resolved) so the Conversations hub can show what Margyn noticed, what was
 * sent, and when. A message sent to the owner is also written into their
 * WhatsApp thread, so "1" or "why?" as a reply has the context.
 *
 * CommonJS, zero-npm.
 */

const { selectRows, insertRows, updateRows, restRequest } = require('./supabaseRest');
const bsp = require('./whatsappBsp');
const booksTools = require('./booksTools');
const E = require('./booksEngine');
const { track } = require('./track');
const deliveries = require('./waDeliveries');
const cashFlow = require('./cashFlowModel');
const forecastStore = require('./forecastStore');
const brief = require('./watchBrief');
const booksHealth = require('./booksHealth');

const DAY = 86400000;
const MAX_PER_RUN = 3;
// How long before the same finding may be sent again (days). News kinds are once only.
const COOLDOWN_DAYS = {
  stale: 2, overdue_total: 7, slipping: 7, old_debts: 30, late: 14, short_paid: 30, quiet: 21, concentration: 60, collection_days: 30,
  commission: 60, expense_jump: 365, unbooked: 365, sales_trend: 365, below_cost: 30, unit_mismatch: 60,
  gst_due: 365, receipt: 3650, newly_overdue: 3650, duplicate: 3650,
  // "Worth knowing" (watchBrief.deepInsights): one a morning, never the same one for three weeks.
  insight_slow: 21, insight_late_share: 30, insight_shrinking: 45, insight_growing: 60, insight_late_vs_borrowed: 30
};
// Never a point of their own: good news goes in the "money in" line instead.
const NOT_A_POINT = new Set(['receipt']);
const MODES = ['off', 'preview', 'on'];
// The day's money pulses between the morning and evening updates (IST): 10:30, 12:30, 15:00, 17:00.
const INTRADAY = new Set(['midday', 'noon', 'afternoon', 'late']);
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
function choose(list, state, slot, now, mode, opts) {
  const max = (opts && opts.max) || MAX_PER_RUN;
  const byKey = new Map(state.map((s) => [s.key, s]));
  const mutedKinds = new Set(state.filter((s) => s.key.startsWith('mute:') && s.status === 'muted').map((s) => s.kind));
  const t = now ? new Date(now).getTime() : Date.now();
  const out = [], parties = new Set();
  for (const x of list) {
    if (out.length >= max) break;
    if (NOT_A_POINT.has(x.kind) || mutedKinds.has(x.kind)) continue;
    const s = byKey.get(x.key);
    if (s && s.status === 'muted') continue;
    if (INTRADAY.has(slot) && !isDeadline(x)) continue;
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
    } else lines.push(`No money from customers entered in ${ctx.source_name || 'Tally'} since yesterday.`);
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
function compose(items, { company, slot, preview, firstName, lastSync, ctxLines, sourceName }) {
  const asOf = istStamp(lastSync);
  const head = (preview ? `[Preview for ${shortCompany(company)}. They have not been sent this.]\n\n` : '') +
    `${greeting(slot)}${firstName ? ' ' + firstName : ''}.` + (asOf ? ` Your ${sourceName || 'Tally'} books as of ${asOf}:` : ` From your ${sourceName || 'Tally'} books:`);
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
/** Template parameters from a message's one-line headline (no new lines allowed in parameters). */
function headlineParams(headline, { company, firstName }, max) {
  return [String(firstName || shortCompany(company)).slice(0, 60), String(headline || '').replace(/\s+/g, ' ').slice(0, max || 300)];
}
/**
 * The numbers in one template (WHATSAPP_TEMPLATE_UPDATE, Utility, 8 Oct 2026), so a closed chat still gets the
 * figures in one message. Meta keeps a template Utility when it reads as an account alert (balance updates are its
 * own example) and every value sits behind fixed words saying what it is; a body that is mostly bare {{n}} reads as
 * an "empty container" and gets rejected or filed as Marketing. So four fixed labels, each filled from the update's
 * own sections. WhatsApp: no new lines inside a value, whole body at most 1024 characters. Body
 * (WHATSAPP-TEMPLATES-MASTER.md §E):
 *   Hi {{1}}, this is your scheduled Margyn account update ({{2}}), worked out from the books you connected.
 *   Balances: {{3}} / Money in and out: {{4}} / Coming up: {{5}} / Needs your attention: {{6}}
 *   Reply to this message for the full update or to ask about any figure. (STOP line left out at submission, 8 Oct)
 * Points go by title only; Why now / Backing / Next come with the full update on any reply.
 */
const UPDATE_SLOT_NAMES = { morning: 'morning', evening: 'evening wrap', midday: '10:30', noon: '12:30', afternoon: '3 pm', late: '5 pm' };
const UPDATE_BUCKETS = [
  { re: /where you stand/i, empty: 'same as the last update' },
  { re: /^(yesterday|today|since|last week|getting better)/i, empty: 'nothing new entered in your books yet' },
  { re: /^(this week|tomorrow)/i, empty: 'in the full update' },
  { re: /need|new thing|points|not moving/i, empty: 'nothing new since the last update' }
];
function updateParams(msg, { company, firstName, slot, now }) {
  const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length <= n ? x : x.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, '') + '…'; };
  const secs = [];
  for (const p of String(msg.text || '').split(/\n{2,}/)) {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || /STOP ALERTS/.test(p) || /^Preview for/i.test(lines[0])) continue;
    const h = /^\*(.+?):?\*$/.exec(lines[0]);
    if (h) secs.push({ name: h[1], lines: lines.slice(1) });
    else if (secs.length) secs[secs.length - 1].lines.push(...lines);   // a point block under its header
  }
  const joined = (lines) => lines.filter((l) => !/^(Why now|Backing|Next):/i.test(l)).map((l) => l.replace(/[.\s]+$/, '')).join('; ');
  const day = new Date(new Date(now || Date.now()).getTime() + 5.5 * 3600000);
  const when = `${UPDATE_SLOT_NAMES[slot] || 'update'}, ${day.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getUTCMonth()]}`;
  const out = [clip(firstName || shortCompany(company), 30), when];
  for (const b of UPDATE_BUCKETS) {
    const mine = secs.filter((x) => b.re.test(x.name) && x.lines.length);
    // One section fills the label as is; several say which is which ("Yesterday: …; Today: …").
    const body = mine.length === 1 && !/^(yesterday|today|since|last week|getting better|tomorrow)/i.test(mine[0].name) ? joined(mine[0].lines)
      : mine.map((x) => x.name + ': ' + joined(x.lines)).join('; ');
    out.push(body ? clip(body + '.', 165) : b.empty);
  }
  return out;
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
      status: p.status === 'muted' ? 'muted' : sent ? 'sent' : (p.status === 'sent' && !p.unconfirmed ? 'sent' : 'open'),
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

/** The snapshots kept with the updates (watchBrief.snapshot): this morning's and the last one sent. */
const SNAP_KEYS = ['snap:morning', 'snap:last'];
/**
 * Every scheduled run, one row per account per slot per India day (margyn_signals key run:<day>:<slot>, kind
 * watch_run): whether an update went out, stayed quiet or couldn't go, why, and the message. The app's
 * "Today's updates" and the Ops Console read these; delivery comes from wa_deliveries by message id.
 * Kept 8 days.
 */
async function logRun(userId, slot, entry, now) {
  const at = new Date(now || Date.now()).toISOString();
  const day = brief.istDay(now);
  const row = { user_id: userId, key: `run:${day}:${slot}`, kind: 'watch_run', status: 'resolved', title: 'Update: ' + slot,
    detail: JSON.stringify(Object.assign({ slot, day, at }, entry)), last_seen: at };
  await insertRows('margyn_signals', [row], { onConflict: 'user_id,key', merge: true }).catch(() => {});
  if (slot === 'morning') {
    const cutoff = new Date(Date.parse(at) - 8 * DAY).toISOString();
    await restRequest(`margyn_signals?user_id=eq.${userId}&kind=eq.watch_run&last_seen=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' }).catch(() => {});
  }
}
/** The last 8 days of runs for one account, newest first. [] without the table. */
async function runs(userId) {
  try {
    const rows = await selectRows('margyn_signals', `select=key,detail&user_id=eq.${userId}&kind=eq.watch_run&order=last_seen.desc&limit=60`);
    return rows.map((r) => { try { return JSON.parse(r.detail); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
const BACKGROUND = new Set(['concentration', 'sales_trend', 'commission', 'collection_days']);
async function loadSnaps(userId) {
  const out = {};
  try {
    const rows = await selectRows('margyn_signals', `select=key,detail&user_id=eq.${userId}&key=in.(${SNAP_KEYS.map(encodeURIComponent).join(',')})`);
    for (const r of rows) if (SNAP_KEYS.includes(r.key)) { try { out[r.key.slice(5)] = JSON.parse(r.detail); } catch (e) { /* ignore */ } }
  } catch (e) { /* none yet */ }
  return out;
}
async function saveSnap(userId, name, snap) {
  // Kept as a resolved row in margyn_signals so no new table is needed; the hub never shows resolved rows.
  await insertRows('margyn_signals', [{ user_id: userId, key: 'snap:' + name, kind: 'snapshot', status: 'resolved', title: 'Snapshot', detail: JSON.stringify(snap), last_seen: new Date().toISOString() }], { onConflict: 'user_id,key', merge: true }).catch(() => {});
}

/**
 * What this slot says (watchBrief): the morning's detail, the midday and afternoon changes, the evening's
 * follow-ups. Returns { msg, sentItems } where sentItems are the findings the message raises (for cooldowns).
 */
function buildMessage(slot, ctx, fc, list, deep, state, snaps, snap, mode, o, extra) {
  const chooseMode = mode === 'preview' ? 'preview' : 'on';
  const words = { firstName: extra.firstName, preview: extra.preview, company: shortCompany(extra.company) };
  // A customer's actionable point (late, short paid, gone quiet) wins over a background fact about them
  // (concentration): one point per customer, so the background one would otherwise take the slot.
  const acting = new Set(list.filter((x) => x.party && !BACKGROUND.has(x.kind)).map((x) => E.niceName(x.party).toLowerCase()));
  const points = list.filter((x) => !brief.INSIGHT_KINDS.has(x.kind) && !(BACKGROUND.has(x.kind) && x.party && acting.has(E.niceName(x.party).toLowerCase())));
  if (INTRADAY.has(slot)) {
    const deadlines = choose(points, state, slot, o.now, chooseMode);
    const msg = brief.pulse(ctx, fc, snap, snaps.last, snaps.morning, deadlines, Object.assign({ slot }, words));
    return { msg, sentItems: msg.send ? deadlines.filter((d) => (msg.said || []).includes('deadline:' + d.key)) : [] };
  }
  if (slot === 'evening') {
    const morningKeys = new Set(((snaps.morning && snaps.morning.day === snap.day && snaps.morning.points) || []).map((p) => p.key));
    const fresh = choose(points.filter((x) => x.severity === 'high' && !morningKeys.has(x.key)), state, 'evening', o.now, chooseMode, { max: 1 });
    return { msg: brief.evening(ctx, fc, snap, snaps.morning, list, fresh, extra.promises, words), sentItems: fresh };
  }
  // Morning (and the app's preview): the detailed one.
  const picked = brief.mix(choose(points, state, 'morning', o.now, chooseMode, { max: 12 }));
  const insight = choose(deep, state, 'morning', o.now, chooseMode, { max: 1 })[0] || null;
  const prev = snaps.morning && snaps.morning.day !== snap.day ? snaps.morning : (snaps.morning && snaps.morning.prev) || null;
  return { msg: brief.morning(ctx, fc, snap, prev, picked, insight, words), sentItems: picked.concat(insight ? [insight] : []), points: picked };
}

/**
 * One account. slot: 'morning' | 'midday' | 'noon' | 'afternoon' | 'late' | 'evening' | 'manual' (manual = the morning update).
 * opts.previewOnly: the app's "Preview today's update". Works out the message the owner would get next, sends
 * it only to the preview phone (and only in preview mode), and records nothing, so it never repeats or uses up
 * a point.
 */
async function watchAccount(userId, opts) {
  const o = opts || {};
  const slot = o.slot === 'manual' || !o.slot || !(INTRADAY.has(o.slot) || o.slot === 'evening' || o.slot === 'morning') ? 'morning' : o.slot;
  const { ctx } = await booksTools.contextFor(userId);
  if (!ctx || !ctx.rows.length) {
    if (!o.previewOnly && !o.dryRun) await logRun(userId, slot, { outcome: 'skipped', reason: 'No books to read yet.' }, o.now);
    return { user: userId, skipped: 'no books' };
  }
  // Every day, for every account with books, keep the forecast and the position (forecastStore.js), so the
  // forecast's track record builds even on days nobody opens the app. The same forecast feeds the update.
  let fc = null;
  try { fc = cashFlow.build(ctx, { promises: await forecastStore.promises(userId) }); if (fc && !o.previewOnly) await forecastStore.recordDaily(userId, fc); } catch (e) { /* never blocks an update */ }
  // The daily books health check (booksHealth.js): what the accountant should fix, kept open / fixed / ignored.
  // Once a day, with the morning run, for every account with books; never blocks the update.
  let health = null;
  if (slot === 'morning' && !o.previewOnly && !o.dryRun) {
    try { health = await booksHealth.runForAccount(userId, ctx, { now: o.now }); } catch (e) { health = { ran: false, reason: String(e.message || e).slice(0, 120) }; }
  }
  const list = E.insights(ctx);
  let deep = [];
  try { deep = brief.deepInsights(ctx, fc); } catch (e) { /* the update goes out without it */ }
  let state;
  try { state = await selectRows('margyn_signals', `select=key,kind,status,impact,last_sent_at,sent_count,sent_via,sent_to&user_id=eq.${userId}&limit=1000`); }
  catch (e) { return { user: userId, skipped: 'margyn_signals table missing (run the SQL)' }; }
  state = state.filter((s) => !/^(snap|run):/.test(String(s.key)));
  state = await onlyDelivered(userId, state);

  const profile = await prefsOf(userId);
  const mode = o.mode || modeOf(profile);
  const company = ctx.company || profile.company_name;
  const snaps = await loadSnaps(userId);
  const snap = brief.snapshot(ctx, fc, o.now);
  const promises = slot === 'evening' ? await forecastStore.promises(userId) : [];
  const build = (preview) => buildMessage(slot, ctx, fc, list, deep, state, snaps, snap, mode, o, { firstName: preview ? null : firstNameOf(profile), preview, company, promises });
  const { msg, sentItems, points } = build(false);
  const all = list.concat(deep);

  if (o.previewOnly) {
    const res = { user: userId, mode, slot, found: all.length, chosen: sentItems.map((x) => x.kind), text: msg.send ? msg.text : null, note: msg.send ? undefined : 'Nothing has changed enough to send an update right now.' };
    if (msg.send && mode === 'preview' && process.env.MARGYN_WATCH_PREVIEW_PHONE) {
      const to = process.env.MARGYN_WATCH_PREVIEW_PHONE;
      const s = (await sessionOpen(to, o.now)) ? await bsp.sendText({ to, text: build(true).msg.text }) : null;
      res.sent_to_preview_phone = !!(s && s.ok);
      if (s && s.ok) await deliveries.record({ messageId: s.messageId, userId, kind: 'watch', to, sentTo: 'preview_copy', keys: [] });
    }
    return res;
  }

  let sentInfo = null, result = { user: userId, mode, slot, found: all.length, chosen: sentItems.map((x) => x.kind) };
  if (health) result.books_health = { open: health.open, opened: health.opened, closed: health.closed, stored: health.stored };
  if (!msg.send) result.quiet = 'nothing changed enough to send';
  if (msg.send) result.headline = msg.headline;
  if (msg.send && mode !== 'off') {
    const preview = mode === 'preview';
    const to = preview ? process.env.MARGYN_WATCH_PREVIEW_PHONE : (profile.whatsapp_opt_in !== false ? profile.whatsapp_phone : null);
    if (!to) {
      result.not_sent = preview ? 'MARGYN_WATCH_PREVIEW_PHONE is not set in Vercel' : 'no WhatsApp number on the account (Settings > Profile)';
    } else {
      const firstName = preview ? null : firstNameOf(profile);
      const text = preview ? build(true).msg.text : msg.text;
      // Changes in the middle of the day go out in an open chat; outside one, only when they matter (a customer
      // on this morning's list paid, a big receipt, a deadline). A template costs money and a ping.
      const templateOk = slot === 'morning' || slot === 'evening' || msg.important;
      // The Utility numbers template (WHATSAPP_TEMPLATE_UPDATE) isn't capped like the Marketing ones and costs about
      // a seventh, so with it every update goes out, the 10:30-5 pm changes too (8 Oct 2026: they were held for the
      // evening because the only templates were Marketing). Pulses still go only when something moved, four at most.
      const utilityOk = templateOk || INTRADAY.has(slot);
      let sent = null;
      if (await sessionOpen(to, o.now)) {
        sent = await bsp.sendText({ to, text });
        if (sent && sent.ok) sentInfo = { via: 'session', to: preview ? 'preview' : 'owner' };
      }
      if (!sentInfo && utilityOk && process.env.WHATSAPP_TEMPLATE_UPDATE) {
        // The figures themselves, in one message; the full update (Why now, Backing) follows any reply.
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_UPDATE, params: updateParams({ text }, { company, firstName, slot, now: o.now }) });
        if (sent && sent.ok) {
          sentInfo = { via: 'template', tpl: 'update', to: preview ? 'preview' : 'owner' };
          await savePending(to, userId, text);
        }
      }
      if (!sentInfo && templateOk && process.env.WHATSAPP_TEMPLATE_ALERT_V2) {
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_ALERT_V2, params: headlineParams(msg.headline, { company, firstName }) });
        if (sent && sent.ok) {
          sentInfo = { via: 'template', tpl: 'v2', to: preview ? 'preview' : 'owner' };
          // The full update goes out when they tap See details (or reply anything) within a day.
          await savePending(to, userId, text);
        }
      }
      if (!sentInfo && templateOk && process.env.WHATSAPP_TEMPLATE_ALERT) {
        sent = await bsp.sendTemplate({ to, templateId: process.env.WHATSAPP_TEMPLATE_ALERT, params: headlineParams(msg.headline, { company, firstName }, 900) });
        if (sent && sent.ok) sentInfo = { via: 'template', tpl: 'alert', to: preview ? 'preview' : 'owner' };
      }
      if (sentInfo) {
        result.sent = sentInfo;
        result.message_id = (sent && sent.messageId) || null;
        // Gupshup taking it is not WhatsApp delivering it: keep the id so the delivery report can be matched.
        await deliveries.record({ messageId: sent && sent.messageId, userId, kind: 'watch', to, sentTo: sentInfo.to, keys: sentItems.map((x) => x.key) });
        if (!preview) {
          // In the owner's thread, so a reply of "2" or "why?" has the context.
          await insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text, tool_calls: null, wa_message_id: (sent && sent.messageId) || null, from_phone: digits(to) }])
            .catch(() => insertRows('whatsapp_conversations', [{ profile_id: userId, role: 'assistant', content: text }]).catch(() => {}));
        }
        await track(userId, 'watch_sent', { kind: (sentItems[0] && sentItems[0].kind) || slot, points: sentItems.length, mode, via: sentInfo.via });
      } else if (!templateOk) {
        result.held = true;
        result.not_sent = 'No open WhatsApp chat, and this change isn\'t urgent enough to send a template for; it will be in the evening wrap.';
      } else {
        result.not_sent = (sent && sent.error) ? String(sent.error).slice(0, 160)
          : 'No open WhatsApp chat in the last 24 hours and no alert template is set, so WhatsApp won\'t accept a message from us yet.';
      }
    }
  }
  if (!o.dryRun) {
    // The day's log: what this run did and why.
    const outcome = sentInfo ? 'sent' : !msg.send ? 'quiet' : mode === 'off' ? 'off' : result.held ? 'held' : 'not_sent';
    await logRun(userId, slot, {
      outcome, mode,
      reason: outcome === 'quiet' ? (msg.reason || 'Nothing worth a message.') : outcome === 'off' ? 'Updates are switched off for this account.' : (outcome === 'not_sent' || outcome === 'held') ? result.not_sent : null,
      via: sentInfo ? sentInfo.via : null, to: sentInfo ? sentInfo.to : null, message_id: result.message_id || null,
      // Which template, and the name it greets: a Marketing one WhatsApp pauses is re-sent as the Utility one (waDeliveries).
      tpl: sentInfo && sentInfo.tpl || null, name: msg.send ? (mode === 'preview' ? shortCompany(company) : (firstNameOf(profile) || shortCompany(company))) : null,
      headline: msg.send ? msg.headline : null, text: msg.send ? msg.text : null, points: sentItems.length
    }, o.now);
    await saveState(userId, all, sentItems, sentInfo, state);
    // What the next update compares against. The morning's is kept all day (the evening follows up on its
    // points); "last" moves only when something went out, so small changes add up until they're worth a line.
    if (slot === 'morning') {
      snap.points = sentInfo ? (points || []).map((x) => ({ key: x.key, kind: x.kind, party: x.party || null, title: x.title })) : [];
      const prev = snaps.morning && snaps.morning.day !== snap.day ? snaps.morning : (snaps.morning && snaps.morning.prev) || null;
      if (prev) snap.prev = { day: prev.day, cash: prev.cash, recv_total: prev.recv_total };
      // Customers flagged as gone quiet or buying less: an order from them during the day is good news.
      snap.watchlist = all.filter((x) => x.party && (x.kind === 'quiet' || x.kind === 'insight_shrinking')).slice(0, 20).map((x) => ({ party: x.party, kind: x.kind }));
      // Two weeks of mornings, for Monday's "late money against a week ago".
      snap.hist = [{ day: snap.day, cash: snap.cash, recv_total: snap.recv_total, recv_late30: snap.recv_late30 }]
        .concat(((snaps.morning && snaps.morning.hist) || []).filter((h) => h.day !== snap.day)).slice(0, 14);
      await saveSnap(userId, 'morning', snap);
      await saveSnap(userId, 'last', snap);
    } else if (sentInfo || slot === 'evening' || !(snaps.last && snaps.last.day === snap.day)) {
      // What's been said today (each pulse line once a day) and how many pulses went out (at most four).
      const keep = sentInfo ? { said: msg.said, pulses: msg.pulses } : { said: snaps.last && snaps.last.day === snap.day ? snaps.last.said : [], pulses: snaps.last && snaps.last.day === snap.day ? snaps.last.pulses : 0 };
      await saveSnap(userId, 'last', Object.assign({}, snap, { points: undefined }, keep));
    }
  }
  return result;
}
/**
 * A point only counts as sent if WhatsApp delivered it (or the send is under a day old and still waiting).
 * On 3 Oct three updates were logged as sent to the owner and none arrived; without this, the owner's first
 * real update would skip those points for weeks. Only applied once delivery reports are actually coming in
 * for this account, so a missing webhook setting can never make Margyn repeat itself every run.
 */
async function onlyDelivered(userId, state) {
  const dl = await deliveries.recent(userId, 60);
  if (!dl || !dl.some((d) => ['delivered', 'read', 'failed'].includes(d.status))) return state;
  const ok = new Set();
  for (const d of dl) {
    const fresh = Date.now() - Date.parse(d.sent_at) < DAY;
    if (d.status === 'delivered' || d.status === 'read' || (d.status !== 'failed' && fresh)) for (const k of d.signal_keys || []) ok.add(d.sent_to + '|' + k);
  }
  return state.map((s) => (s.last_sent_at && (s.sent_to === 'owner' || s.sent_to === 'preview') && !ok.has(s.sent_to + '|' + s.key))
    ? Object.assign({}, s, { last_sent_at: null, sent_to: null, unconfirmed: true }) : s);
}

function firstNameOf(profile) {
  return String(((profile && profile.preferences) || {}).display_name || '').trim().split(/\s+/)[0] || null;
}

/** Every account with books connected (Tally, Zoho Books or Odoo: dataLayer/books.js). Bounded so one cron run can't overrun. */
async function runWatchAll(slot, opts) {
  const o = opts || {};
  const started = Date.now(), budgetMs = o.budgetMs || 45000;
  let users = [];
  try {
    const rows = await selectRows('tally_installs', 'select=user_id&status=eq.active&limit=500');
    const more = await Promise.all([
      selectRows('zoho_organizations', 'select=user_id&status=eq.active&limit=500').catch(() => []),
      selectRows('connector_credentials', 'select=user_id&connector_type=eq.odoo&disconnected_at=is.null&limit=500').catch(() => [])
    ]);
    users = [...new Set(rows.concat(...more).map((r) => r.user_id).filter(Boolean))];
  } catch (e) { return { slot, error: 'could not list accounts with books' }; }
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
    template_ready: !!(process.env.WHATSAPP_TEMPLATE_UPDATE || process.env.WHATSAPP_TEMPLATE_ALERT || process.env.WHATSAPP_TEMPLATE_ALERT_V2),
    // Whether each update actually arrived (null = delivery tracking not set up yet).
    deliveries: await deliveries.recent(userId, 60),
    // Every scheduled run in the last 8 days: sent, stayed quiet (and why), or couldn't go.
    runs: await runs(userId),
    signals: rows.filter((r) => !/^(snap|run):/.test(String(r.key)))
  };
}

module.exports = { runs, logRun, headlineParams, updateParams, watchAccount, runWatchAll, setMode, mute, signals, choose, compose, templateParams, teaserParams, takePending, modeOf, isDeadline, MODES, COOLDOWN_DAYS };
