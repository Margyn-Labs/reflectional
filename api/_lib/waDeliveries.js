/**
 * _lib/waDeliveries.js
 * Did a WhatsApp message actually arrive? (2026-10-04)
 *
 * Gupshup accepting a message ("submitted") is not WhatsApp delivering it. On 3 Oct three Margyn updates were
 * logged as sent and none arrived. Gupshup reports each message's fate to our webhook (enqueued, sent,
 * delivered, read, failed + reason); this keeps that per message in wa_deliveries, so the app can say
 * "Delivered to Mihir 7:31 am" or "Didn't arrive: <reason>".
 *
 * On a failed Margyn update the points it carried go back to "not sent", so the next run tries again instead
 * of sitting out a week's cooldown, and the Margyn team's test phone gets a note when a chat is open.
 *
 * Fails open: without the wa_deliveries table nothing is recorded and sending works exactly as before.
 * CommonJS, zero-npm.
 */
const { selectRows, insertRows, updateRows } = require('./supabaseRest');

const RANK = { queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
const MAP = { enqueued: 'accepted', submitted: 'accepted', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };
const digits = (p) => String(p || '').replace(/[^\d]/g, '');
const clean = (a) => [...new Set(a.filter(Boolean).map(String))];

/** After a send Gupshup accepted. kind: 'watch' | 'chase'. keys: the Margyn points it carried. */
async function record({ messageId, userId, kind, to, sentTo, keys, ref }) {
  if (!messageId) return false;
  try {
    await insertRows('wa_deliveries', [{
      message_id: String(messageId), user_id: userId || null, kind: kind || 'watch', to_phone: digits(to),
      sent_to: sentTo || null, signal_keys: keys && keys.length ? keys : null, ref: ref || null,
      status: 'queued', sent_at: new Date().toISOString()
    }], { onConflict: 'message_id', merge: true });
    return true;
  } catch (e) { return false; }
}

/**
 * Status reports out of a webhook body, in either shape Gupshup sends:
 *  v2: { type: 'message-event', payload: { id, gsId, type: 'delivered'|..., payload: { whatsappMessageId, code, reason } } }
 *  v3 / Meta: { entry: [{ changes: [{ value: { statuses: [{ id, gs_id, status, errors: [{ code, title }] }] } }] }] }
 * Returns [] for anything else (messages, replies), so the caller carries on as before.
 */
function parseStatusEvents(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  if (body.type === 'message-event' && body.payload) {
    const p = body.payload, inner = p.payload || {};
    const status = MAP[String(p.type || '').toLowerCase()];
    if (status) out.push({
      ids: clean([p.gsId, p.id, inner.whatsappMessageId]),
      waId: inner.whatsappMessageId || (p.gsId ? p.id : null) || null,
      status, code: inner.code != null ? String(inner.code) : null,
      reason: inner.reason || inner.message || null,
      at: p.timestamp || body.timestamp || Date.now()
    });
    return out;
  }
  for (const e of Array.isArray(body.entry) ? body.entry : []) {
    for (const c of Array.isArray(e.changes) ? e.changes : []) {
      for (const s of (c.value && Array.isArray(c.value.statuses)) ? c.value.statuses : []) {
        const status = MAP[String(s.status || '').toLowerCase()];
        if (!status) continue;
        const err = Array.isArray(s.errors) && s.errors[0] ? s.errors[0] : null;
        out.push({
          ids: clean([s.gs_id, s.id, s.meta_msg_id]), waId: s.id || null, status,
          code: err && err.code != null ? String(err.code) : null,
          reason: err ? (err.title || err.message || (err.error_data && err.error_data.details) || null) : null,
          at: s.timestamp ? Number(s.timestamp) * 1000 : Date.now()
        });
      }
    }
  }
  return out;
}

/** WhatsApp's failure codes in words a business owner can act on. */
function explain(code, reason) {
  const c = String(code || '');
  const known = {
    '131049': 'WhatsApp held it back: this number has had a lot of business marketing messages recently. A Utility template avoids this.',
    '131026': 'This number can’t receive it (not on WhatsApp, or an old WhatsApp version).',
    '131047': 'More than 24 hours since they last messaged, and it wasn’t sent as an approved template.',
    '132001': 'The template doesn’t exist or isn’t approved yet in this language.',
    '132000': 'The template’s fields didn’t match what was approved.',
    '131051': 'Message type not supported.',
    '470': 'More than 24 hours since they last messaged, and it wasn’t sent as an approved template.',
    '1002': 'Number isn’t on WhatsApp.'
  };
  return known[c] || (reason ? String(reason).slice(0, 200) : 'WhatsApp didn’t say why.');
}

async function rowsFor(ids) {
  if (!ids.length) return [];
  const list = ids.map((x) => '"' + x.replace(/"/g, '') + '"').join(',');
  const a = await selectRows('wa_deliveries', `select=*&message_id=in.(${encodeURIComponent(list)})&limit=5`).catch(() => []);
  if (a.length) return a;
  return selectRows('wa_deliveries', `select=*&wa_id=in.(${encodeURIComponent(list)})&limit=5`).catch(() => []);
}

/** Apply status reports. Never goes backwards (a late "sent" doesn't undo "read"). */
async function apply(events, deps) {
  const d = deps || {};
  let changed = 0;
  for (const ev of events || []) {
    const rows = await rowsFor(ev.ids);
    for (const row of rows) {
      const cur = row.status || 'queued';
      const at = new Date(typeof ev.at === 'number' ? ev.at : Date.parse(ev.at) || Date.now()).toISOString();
      const patch = {};
      if (ev.waId && !row.wa_id) patch.wa_id = String(ev.waId);
      if (ev.status === 'failed') {
        if ((RANK[cur] || 0) < RANK.delivered && cur !== 'failed') Object.assign(patch, { status: 'failed', failed_at: at, error_code: ev.code, error: explain(ev.code, ev.reason) });
      } else if (cur === 'failed' ? RANK[ev.status] >= RANK.delivered : (RANK[ev.status] || 0) > (RANK[cur] || 0)) {
        patch.status = ev.status;
        if (ev.status === 'delivered') patch.delivered_at = at;
        if (ev.status === 'read') { patch.read_at = at; if (!row.delivered_at) patch.delivered_at = at; }
      }
      if (!Object.keys(patch).length) continue;
      await updateRows('wa_deliveries', `message_id=eq.${encodeURIComponent(row.message_id)}`, patch).catch(() => {});
      changed++;
      if (patch.status === 'failed' && row.kind === 'watch') await onWatchFailed(Object.assign({}, row, patch), d).catch(() => {});
    }
  }
  return changed;
}

/** A Margyn update didn't arrive: its points go back to "not sent", and the team hears about it. */
async function onWatchFailed(row, deps) {
  for (const key of row.signal_keys || []) {
    await updateRows('margyn_signals', `user_id=eq.${row.user_id}&key=eq.${encodeURIComponent(key)}&sent_to=eq.${row.sent_to || 'owner'}`,
      { status: 'open', last_sent_at: null, sent_via: null, sent_to: null }).catch(() => {});
  }
  const team = process.env.MARGYN_WATCH_PREVIEW_PHONE;
  const send = deps.sendText || require('./whatsappBsp').sendText;
  if (team && digits(team) !== digits(row.to_phone)) {
    await send({ to: team, text: `Margyn's update to …${String(row.to_phone || '').slice(-4)} didn't arrive. ${row.error}` }).catch(() => {});
  }
  try { await require('./track').track(row.user_id, 'watch_failed', { code: row.error_code || null, to: row.sent_to }); } catch (e) { /* counters only */ }
}

/** Latest deliveries for an account (the hub shows these). */
async function recent(userId, limit) {
  try { return await selectRows('wa_deliveries', `select=message_id,kind,sent_to,signal_keys,status,error,sent_at,delivered_at,read_at,failed_at&user_id=eq.${userId}&kind=eq.watch&order=sent_at.desc&limit=${limit || 20}`); }
  catch (e) { return null; }
}

module.exports = { record, parseStatusEvents, apply, explain, recent, RANK };
