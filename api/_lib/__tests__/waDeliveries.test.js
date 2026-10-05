/** Run: node api/_lib/__tests__/waDeliveries.test.js — delivery reports, fake Supabase. */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.MARGYN_WATCH_PREVIEW_PHONE = '919999900000';
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : ''))); };

const DB = { wa_deliveries: [], margyn_signals: [{ user_id: 'u1', key: 'overdue_total', status: 'sent', last_sent_at: '2026-10-04T02:01:00Z', sent_to: 'owner', sent_via: 'template' }], product_events: [] };
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const table = u.pathname.replace('/rest/v1/', '');
  const method = opts.method || 'GET';
  const val = (k) => u.searchParams.get(k);
  const match = (r) => {
    for (const [k, v] of u.searchParams) {
      if (['select', 'limit', 'order', 'offset', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.') && String(r[k]) !== decodeURIComponent(v.slice(3))) return false;
      if (v.startsWith('in.(')) { const list = decodeURIComponent(v.slice(4, -1)).split(',').map((x) => x.replace(/"/g, '')); if (!list.includes(String(r[k]))) return false; }
    }
    return true;
  };
  if (method === 'GET') return ok((DB[table] || []).filter(match).map((r) => Object.assign({}, r)));
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === 'POST') { const rows = Array.isArray(body) ? body : [body]; (DB[table] = DB[table] || []).push(...rows); return ok(rows); }
  if (method === 'PATCH') { for (const r of DB[table] || []) if (match(r)) Object.assign(r, body); return ok([]); }
  return ok([]);
};
const D = require('../waDeliveries');
const texts = [];
(async () => {
  console.log('reading reports');
  const v2 = D.parseStatusEvents({ app: 'margyn', type: 'message-event', payload: { id: 'gs-1', type: 'enqueued', destination: '919324000000', payload: { whatsappMessageId: 'wamid.A', type: 'template' } } });
  check('Gupshup v2 enqueued', v2.length === 1 && v2[0].status === 'accepted' && v2[0].waId === 'wamid.A' && v2[0].ids.includes('gs-1'), v2);
  const v2f = D.parseStatusEvents({ type: 'message-event', payload: { id: 'gs-2', type: 'failed', payload: { code: 131049, reason: 'healthy ecosystem' } } });
  check('v2 failed carries the code', v2f[0].status === 'failed' && v2f[0].code === '131049', v2f);
  const meta = D.parseStatusEvents({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.A', gs_id: 'gs-1', status: 'read', timestamp: '1759550000' }] } }] }] });
  check('Meta shape', meta[0].status === 'read' && meta[0].ids.includes('gs-1'), meta);
  check('a user message is not a report', D.parseStatusEvents({ type: 'message', payload: { type: 'text' } }).length === 0);
  check('marketing limit explained', /marketing/.test(D.explain('131049')));

  console.log('tracking one update');
  await D.record({ messageId: 'gs-1', userId: 'u1', kind: 'watch', to: '+91 93240 00000', sentTo: 'owner', keys: ['overdue_total'] });
  check('recorded as queued', DB.wa_deliveries[0].status === 'queued' && DB.wa_deliveries[0].to_phone === '919324000000');
  await D.apply(v2);
  check('accepted, learns WhatsApp id', DB.wa_deliveries[0].status === 'accepted' && DB.wa_deliveries[0].wa_id === 'wamid.A', DB.wa_deliveries[0]);
  await D.apply(D.parseStatusEvents({ type: 'message-event', payload: { id: 'wamid.A', gsId: 'gs-1', type: 'delivered' } }));
  check('delivered', DB.wa_deliveries[0].status === 'delivered' && DB.wa_deliveries[0].delivered_at, DB.wa_deliveries[0]);
  await D.apply(D.parseStatusEvents({ type: 'message-event', payload: { id: 'wamid.A', gsId: 'gs-1', type: 'sent' } }));
  check('a late "sent" does not go backwards', DB.wa_deliveries[0].status === 'delivered');
  await D.apply(meta);
  check('read (matched by WhatsApp id)', DB.wa_deliveries[0].status === 'read' && DB.wa_deliveries[0].read_at);

  console.log('an update that never arrives');
  await D.record({ messageId: 'gs-2', userId: 'u1', kind: 'watch', to: '919324000000', sentTo: 'owner', keys: ['overdue_total'] });
  await D.apply(v2f, { sendText: async (m) => { texts.push(m); return { ok: true }; } });
  const row = DB.wa_deliveries.find((r) => r.message_id === 'gs-2');
  check('failed with a reason in words', row.status === 'failed' && /marketing/.test(row.error), row);
  check('its points go back to not sent, so the next run tries again', DB.margyn_signals[0].status === 'open' && DB.margyn_signals[0].last_sent_at === null, DB.margyn_signals[0]);
  check('the Margyn team hears about it', texts.length === 1 && texts[0].to === '919999900000' && /didn't arrive/.test(texts[0].text), texts);

  console.log('a report that arrives before the send is recorded (5 Oct, 7:19 pm)');
  await D.apply(D.parseStatusEvents({ type: 'message-event', payload: { id: 'wamid.E', gsId: 'gs-early', type: 'delivered' } }));
  let er = DB.wa_deliveries.find((r) => r.message_id === 'gs-early');
  check('the early report is kept, not dropped', er && er.status === 'delivered' && er.delivered_at && er.wa_id === 'wamid.E', er);
  await D.record({ messageId: 'gs-early', userId: 'u1', kind: 'watch', to: '919324000000', sentTo: 'owner', keys: ['overdue_total'] });
  er = DB.wa_deliveries.filter((r) => r.message_id === 'gs-early');
  check('recording it afterwards fills in whose it is and keeps "delivered"', er.length === 1 && er[0].status === 'delivered' && er[0].user_id === 'u1' && er[0].kind === 'watch' && er[0].sent_to === 'owner', er);
  await D.apply(D.parseStatusEvents({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.E', status: 'read', timestamp: '1759680000' }] } }] }] }));
  check('later reports find it by WhatsApp id', DB.wa_deliveries.find((r) => r.message_id === 'gs-early').status === 'read');
  Object.assign(DB.margyn_signals[0], { status: 'sent', last_sent_at: '2026-10-05T13:49:00Z', sent_to: 'owner', sent_via: 'session' });
  await D.apply(D.parseStatusEvents({ type: 'message-event', payload: { id: 'gs-early-f', type: 'failed', payload: { code: 131026 } } }));
  await D.record({ messageId: 'gs-early-f', userId: 'u1', kind: 'watch', to: '919324000000', sentTo: 'owner', keys: ['overdue_total'] });
  check('an early failure still puts the points back to not sent', DB.wa_deliveries.find((r) => r.message_id === 'gs-early-f').status === 'failed' && DB.margyn_signals[0].status === 'open', DB.margyn_signals[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
