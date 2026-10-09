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
/** 131049 in words the owner can act on (the fix on our side is a Utility template, which is not theirs to know). */
const WA_PAUSED = 'WhatsApp paused it: it limits how many business template messages one number gets. Send Margyn any message on WhatsApp and the update comes straight through.';
const clean = (a) => [...new Set(a.filter(Boolean).map(String))];

/** After a send Gupshup accepted. kind: 'watch' | 'chase'. keys: the Margyn points it carried. */
async function record({ messageId, userId, kind, to, sentTo, keys, ref }) {
  if (!messageId) return false;
  try {
    // WhatsApp's report can beat us here: a chat message to a phone that's online is delivered in about a
    // second, sometimes before Gupshup has even answered our send. apply() keeps such a report in an 'early'
    // row; fill in whose message it is and keep the status it already has (5 Oct 2026: the 7:19 pm update
    // to Mihir showed "WhatsApp hasn't confirmed delivery" all night while his phone was on).
    const early = await selectRows('wa_deliveries', `select=*&message_id=eq.${encodeURIComponent(String(messageId))}&limit=1`).catch(() => []);
    if (early[0]) {
      const fill = { user_id: userId || null, kind: kind || 'watch', to_phone: digits(to), sent_to: sentTo || null, signal_keys: keys && keys.length ? keys : null, ref: ref || null };
      await updateRows('wa_deliveries', `message_id=eq.${encodeURIComponent(String(messageId))}`, fill);
      const row = Object.assign({}, early[0], fill);
      if (row.status === 'failed' && row.kind === 'watch') await onWatchFailed(row, {}).catch(() => {});
      return true;
    }
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
    // Meta's cap on marketing-category templates per person. Chat messages aren't capped, so a reply from them
    // brings it through (onWatchFailed parks it in watch_pending).
    '131049': WA_PAUSED,
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

/** The statuses a report may overwrite: anything lower; a failure only before delivery; delivery also over a failure. */
function lowerThan(status) {
  if (status === 'failed') return ['queued', 'accepted', 'sent'];
  const out = Object.keys(RANK).filter((k) => RANK[k] < RANK[status]);
  if (RANK[status] >= RANK.delivered) out.push('failed');
  return out;
}
/** A row's status as its timestamps prove it (rows a race left on "sent" with a delivery time on them). */
function settled(row) {
  if (!row) return row;
  if (row.read_at && row.status !== 'read') return Object.assign({}, row, { status: 'read' });
  if (row.delivered_at && !['delivered', 'read'].includes(row.status)) return Object.assign({}, row, { status: 'delivered' });
  return row;
}

/** Apply status reports. Never goes backwards (a late "sent" doesn't undo "read"). */
async function apply(events, deps) {
  const d = deps || {};
  let changed = 0;
  for (const ev of events || []) {
    let rows = await rowsFor(ev.ids);
    if (!rows.length && ev.ids[0]) {
      // Not recorded yet (the report beat the send's own bookkeeping, see record()): keep it under Gupshup's id
      // so it isn't lost, then apply it to that row like any other.
      const seed = { message_id: String(ev.ids[0]), wa_id: ev.waId ? String(ev.waId) : null, kind: 'early', status: 'queued', sent_at: new Date().toISOString() };
      try { await insertRows('wa_deliveries', [seed]); rows = [seed]; }
      catch (e) { rows = await rowsFor(ev.ids); }   // recorded in the meantime: use that row
    }
    for (const row0 of rows) {
      const row = settled(row0);
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
      // Only over a lower status, checked by the database itself: Gupshup sends "sent" and "delivered" a second
      // apart and two webhook calls can run at once; both read "accepted", and a late "sent" write used to land
      // on top of "delivered" (9 Oct 2026: Mihir's 8:12 am update showed "sent" with a delivery time on it).
      const guard = patch.status ? `&status=in.(${lowerThan(patch.status).join(',')})` : '';
      await updateRows('wa_deliveries', `message_id=eq.${encodeURIComponent(row.message_id)}${guard}`, patch).catch(() => {});
      changed++;
      if (patch.status === 'failed' && row.kind === 'watch') await onWatchFailed(Object.assign({}, row, patch), d).catch(() => {});
    }
  }
  return changed;
}

/**
 * A Margyn update didn't arrive. If WhatsApp paused a Marketing template (131049) and the Utility numbers template
 * is set, the same update goes again as that one, at once: Utility isn't capped (8 Oct 2026, the long-term fix after
 * Mihir's morning update was paused). Otherwise its points go back to "not sent", the update waits for their next
 * message, and the team hears about it.
 */
async function onWatchFailed(row, deps) {
  const run = await findRun(row).catch(() => null);
  if (await retryAsUtility(row, run, deps).catch(() => false)) return;
  for (const key of row.signal_keys || []) {
    await updateRows('margyn_signals', `user_id=eq.${row.user_id}&key=eq.${encodeURIComponent(key)}&sent_to=eq.${row.sent_to || 'owner'}`,
      { status: 'open', last_sent_at: null, sent_via: null, sent_to: null }).catch(() => {});
  }
  // Park the update so it goes out as a chat message (not capped, no template) the moment they message Margyn.
  await parkText(row, run).catch(() => {});
  const team = process.env.MARGYN_WATCH_PREVIEW_PHONE;
  const send = deps.sendText || require('./whatsappBsp').sendText;
  if (team && digits(team) !== digits(row.to_phone)) {
    const ours = String(row.error_code) === '131049' && !process.env.WHATSAPP_TEMPLATE_UPDATE ? ' (131049: only Marketing templates are set; approve the Utility one and set WHATSAPP_TEMPLATE_UPDATE, see WHATSAPP-TEMPLATES-MASTER.md §E.)' : '';
    await send({ to: team, text: `Margyn's update to …${String(row.to_phone || '').slice(-4)} didn't arrive. ${row.error}${ours}` }).catch(() => {});
  }
  try { await require('./track').track(row.user_id, 'watch_failed', { code: row.error_code || null, to: row.sent_to }); } catch (e) { /* counters only */ }
}

/** The run-log entry (margyn_signals watch_run, see margynWatch.logRun) that sent this message, or null. */
async function findRun(row) {
  if (!row.user_id || !row.message_id) return null;
  const runs = await selectRows('margyn_signals', `select=detail&user_id=eq.${row.user_id}&kind=eq.watch_run&order=last_seen.desc&limit=12`).catch(() => []);
  for (const r of runs) { try { const d = JSON.parse(r.detail); if (d && d.message_id && String(d.message_id) === String(row.message_id)) return d; } catch (e) { /* skip */ } }
  return null;
}

/** 131049 on a Marketing template → the same update as the Utility numbers template. Once per update. */
async function retryAsUtility(row, run, deps) {
  const tplId = process.env.WHATSAPP_TEMPLATE_UPDATE;
  if (!tplId || String(row.error_code) !== '131049' || !run || !run.text || run.tpl === 'update' || run.retried_from) return false;
  const d = deps || {};
  const params = require('./margynWatch').updateParams({ text: run.text }, { company: run.name, firstName: run.name, slot: run.slot, now: run.at });
  const sent = await (d.sendTemplate || require('./whatsappBsp').sendTemplate)({ to: row.to_phone, templateId: tplId, params });
  if (!sent || !sent.ok) return false;
  await record({ messageId: sent.messageId, userId: row.user_id, kind: 'watch', to: row.to_phone, sentTo: row.sent_to, keys: row.signal_keys || [] });
  // The day's log now points at the message that went, so the app shows its delivery.
  const entry = Object.assign({}, run, { message_id: sent.messageId || null, tpl: 'update', retried_from: row.message_id });
  await updateRows('margyn_signals', `user_id=eq.${row.user_id}&key=eq.${encodeURIComponent(`run:${run.day}:${run.slot}`)}`, { detail: JSON.stringify(entry) }).catch(() => {});
  await parkText(row, run).catch(() => {});   // the full update still follows any reply
  try { await require('./track').track(row.user_id, 'watch_retried', { code: '131049' }); } catch (e) { /* counters only */ }
  return true;
}

/** The update's full text into watch_pending for that phone. Never replaces a newer update already waiting. */
async function parkText(row, run) {
  if (!run || !run.text || !row.to_phone) return false;
  const phone = digits(row.to_phone);
  const cur = await selectRows('watch_pending', `select=text,created_at&phone=eq.${phone}&limit=1`).catch(() => []);
  if (cur[0] && cur[0].text && Date.parse(cur[0].created_at) > Date.parse(run.at || 0)) return false;
  await insertRows('watch_pending', [{ phone, user_id: row.user_id, text: run.text, created_at: run.at || new Date().toISOString() }], { onConflict: 'phone', merge: true });
  return true;
}
async function parkFailed(row) { return parkText(row, await findRun(row)); }

/** Latest deliveries for an account (the hub shows these). */
async function recent(userId, limit) {
  try { return (await selectRows('wa_deliveries', `select=message_id,kind,sent_to,signal_keys,status,error,error_code,sent_at,delivered_at,read_at,failed_at&user_id=eq.${userId}&kind=eq.watch&order=sent_at.desc&limit=${limit || 20}`)).map(settled); }
  catch (e) { return null; }
}

module.exports = { record, parseStatusEvents, apply, explain, recent, parkFailed, settled, RANK, WA_PAUSED };
