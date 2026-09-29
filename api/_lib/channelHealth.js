/**
 * api/_lib/channelHealth.js
 * Which outbound channels are actually delivering, and how much Margyn
 * recovered. Added 2026-09-30.
 *
 * Why: Bells, chases and the CFO pack email fail silently when a template is
 * not approved or a key is missing. Nothing on screen said so. This turns
 * the send records that already exist into one plain answer per channel.
 *
 *   buildChannelHealth(input)      pure, no network (tested)
 *   channelHealthForAccount(id)    reads the records, then calls the above
 *
 * "Recovered" counts a chased invoice that later closed as paid, and only
 * when a chase actually went out before it closed. It says "paid after
 * Margyn chased", not "because of": we can't know a customer wouldn't have
 * paid anyway, so the screen says the same.
 */

const { selectRows } = require('./supabaseRest');

const DAY = 86400000;
const WINDOW_DAYS = 30;

const CHANNELS = [
  { key: 'opening_bell', label: 'Opening Bell', via: 'WhatsApp', env: 'WHATSAPP_TEMPLATE_OPENING' },
  { key: 'closing_bell', label: 'Closing Bell', via: 'WhatsApp', env: 'WHATSAPP_TEMPLATE_CLOSING' },
  { key: 'chases', label: 'Payment chases', via: 'WhatsApp' },
  { key: 'cfo_pack', label: 'CFO pack', via: 'Email' }
];

const ts = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const latest = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

/** A raw provider error, made readable. Unknown errors are passed through, trimmed. */
function plainError(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/not configured|has no configured id/i.test(s)) return 'The message template isn’t set up on the server yet.';
  if (/template/i.test(s) && /(reject|not approved|pending|disabled|paused|does not exist|not found)/i.test(s)) return 'WhatsApp hasn’t approved this message template.';
  if (/131026|not.*(whatsapp|opted)|undeliverable/i.test(s)) return 'That number can’t receive WhatsApp messages.';
  if (/131047|24.?hour|re-?engage/i.test(s)) return 'Outside WhatsApp’s 24-hour window, and no approved template to open the chat.';
  if (/401|403|unauthori[sz]ed|forbidden|invalid.*(key|token)/i.test(s)) return 'The messaging provider rejected our credentials.';
  if (/RESEND|resend/.test(s) && /(key|domain|verify)/i.test(s)) return 'The email provider isn’t set up or the sending domain isn’t verified.';
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

/** One channel, from a list of { at, ok, error } attempts within the window. */
function judge(meta, attempts, { configured, now }) {
  const rows = attempts.filter((a) => a.at != null && a.at >= now - WINDOW_DAYS * DAY).sort((x, y) => y.at - x.at);
  const sent = rows.filter((r) => r.ok).length;
  const failed = rows.length - sent;
  const lastOk = rows.find((r) => r.ok);
  const lastBad = rows.find((r) => !r.ok);
  const out = {
    key: meta.key, label: meta.label, via: meta.via,
    sent_30d: sent, failed_30d: failed,
    last_success_at: iso(lastOk && lastOk.at), last_failure_at: iso(lastBad && lastBad.at),
    last_error: lastBad ? plainError(lastBad.error) : null
  };
  if (configured === false && !rows.length) {
    return { ...out, status: 'not_set_up', headline: 'Not set up', detail: 'Nothing has been sent, and the message template isn’t configured on the server.' };
  }
  if (!rows.length) {
    return { ...out, status: 'quiet', headline: 'Nothing sent yet', detail: `No sends in the last ${WINDOW_DAYS} days. That’s normal if nobody is set to receive it.` };
  }
  // Failing = the latest attempt failed, or most of the recent ones did.
  const recent = rows.slice(0, 5);
  const recentFailed = recent.filter((r) => !r.ok).length;
  if (!rows[0].ok || recentFailed * 2 > recent.length) {
    return {
      ...out, status: 'failing', headline: 'Not delivering',
      detail: (out.last_error || 'Recent sends failed.') + (lastOk ? '' : ' None have gone through in the last ' + WINDOW_DAYS + ' days.')
    };
  }
  return { ...out, status: 'working', headline: 'Delivering', detail: `${sent} sent in the last ${WINDOW_DAYS} days` + (failed ? `, ${failed} failed.` : '.') };
}

/**
 * @param {object} i
 * @param {object[]} i.chases       whatsapp_chases rows
 * @param {object[]} i.targets      whatsapp_chase_targets rows
 * @param {object[]} i.bellLogs     connector_logs rows (whatsapp, send_opening / send_closing)
 * @param {object[]} i.deliveries   report_deliveries rows, or null when the table isn't there
 * @param {object}   i.configured   { opening_bell, closing_bell } booleans, from the server's settings
 * @param {number}   [i.now]
 */
function buildChannelHealth({ chases = [], targets = [], bellLogs = [], deliveries = null, configured = {}, now = Date.now() }) {
  const channels = [];

  for (const key of ['opening_bell', 'closing_bell']) {
    const meta = CHANNELS.find((c) => c.key === key);
    const op = key === 'opening_bell' ? 'send_opening' : 'send_closing';
    const attempts = bellLogs.filter((l) => l.operation === op)
      .map((l) => ({ at: ts(l.created_at), ok: l.status === 'success', error: l.error_message }));
    channels.push(judge(meta, attempts, { configured: configured[key], now }));
  }

  const chaseAttempts = chases.filter((c) => c.status !== 'queued' && c.status !== 'skipped' && c.channel !== 'manual_deeplink')
    .map((c) => ({ at: ts(c.sent_at || c.created_at), ok: ['sent', 'delivered', 'read'].includes(c.status), error: c.error }));
  channels.push(judge(CHANNELS[2], chaseAttempts, { configured: undefined, now }));

  if (deliveries) {
    const attempts = deliveries.filter((d) => d.kind !== 'test')
      .map((d) => ({ at: ts(d.created_at), ok: d.status === 'sent', error: d.error }));
    channels.push(judge(CHANNELS[3], attempts, { configured: undefined, now }));
  } else {
    channels.push({ key: 'cfo_pack', label: 'CFO pack', via: 'Email', status: 'not_set_up', headline: 'Not set up', detail: 'Scheduled sends aren’t switched on for this account yet.', sent_30d: 0, failed_30d: 0, last_success_at: null, last_failure_at: null, last_error: null });
  }

  return { generated_at: iso(now), window_days: WINDOW_DAYS, channels, recovered: recovered(chases, targets, now) };
}

/** Paid-after-a-chase, per invoice, from the chase records. */
function recovered(chases, targets, now) {
  const wentOut = new Map();   // target id -> latest chase that actually left, at or before it closed
  for (const c of chases) {
    if (!['sent', 'delivered', 'read'].includes(c.status)) continue;
    const at = ts(c.sent_at || c.created_at);
    if (at == null) continue;
    const list = wentOut.get(c.chase_target_id) || [];
    list.push({ at, n: c.chase_number });
    wentOut.set(c.chase_target_id, list);
  }
  const from = now - WINDOW_DAYS * DAY;
  const items = [];
  let inFlight = 0, inFlightCount = 0, promised = 0, promisedCount = 0;
  for (const t of targets) {
    const amt = Number(t.amount) || 0;
    const sends = (wentOut.get(t.id) || []).sort((a, b) => a.at - b.at);
    if (t.state === 'resolved_paid') {
      const closed = ts(t.resolved_at);
      if (closed == null || closed < from) continue;
      const before = sends.filter((s) => s.at <= closed);
      if (!before.length) continue;   // paid, but we never chased it: not ours to claim
      const last = before[before.length - 1];
      items.push({
        party_name: t.party_name, invoice_ref: t.invoice_ref || null, amount: amt,
        chased_at: iso(last.at), paid_at: iso(closed), chases_before_payment: before.length,
        days_to_pay: Math.max(0, Math.round((closed - last.at) / DAY))
      });
    } else if (t.state === 'paused_promise') {
      promised += amt; promisedCount++;
    } else if (t.state === 'active' && sends.length) {
      inFlight += amt; inFlightCount++;
    }
  }
  items.sort((a, b) => (ts(b.paid_at) || 0) - (ts(a.paid_at) || 0));
  return {
    window_days: WINDOW_DAYS,
    amount: items.reduce((s, x) => s + x.amount, 0),
    invoices: items.length,
    items: items.slice(0, 10),
    still_chasing: { amount: inFlight, invoices: inFlightCount },
    promised: { amount: promised, invoices: promisedCount }
  };
}

async function channelHealthForAccount(accountId) {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY).toISOString();
  const uid = encodeURIComponent(accountId);
  const [chases, targets, bellLogs, deliveries] = await Promise.all([
    selectRows('whatsapp_chases', `user_id=eq.${uid}&created_at=gte.${since}&select=id,chase_target_id,chase_number,channel,status,error,sent_at,created_at&order=created_at.desc&limit=1000`).catch(() => []),
    selectRows('whatsapp_chase_targets', `user_id=eq.${uid}&select=id,party_name,invoice_ref,amount,state,resolved_at,last_chase_at&limit=2000`).catch(() => []),
    selectRows('connector_logs', `user_id=eq.${uid}&connector_type=eq.whatsapp&operation=in.(send_opening,send_closing)&created_at=gte.${since}&select=operation,status,error_message,created_at&order=created_at.desc&limit=200`).catch(() => []),
    selectRows('report_deliveries', `user_id=eq.${uid}&created_at=gte.${since}&select=kind,status,error,created_at&order=created_at.desc&limit=100`).catch(() => null)
  ]);
  return buildChannelHealth({
    chases, targets, bellLogs, deliveries,
    configured: { opening_bell: !!process.env.WHATSAPP_TEMPLATE_OPENING, closing_bell: !!process.env.WHATSAPP_TEMPLATE_CLOSING }
  });
}

module.exports = { buildChannelHealth, channelHealthForAccount, plainError, WINDOW_DAYS };
