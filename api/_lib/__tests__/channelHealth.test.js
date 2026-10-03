/**
 * Channel health + recovered ₹. Zero-dep. Run: node api/_lib/__tests__/channelHealth.test.js
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';
const { buildChannelHealth, plainError } = require('../channelHealth');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const NOW = Date.parse('2026-09-30T10:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const by = (r, k) => r.channels.find((c) => c.key === k);

// 1. Nothing configured, nothing sent: "not set up", not a silent green.
let r = buildChannelHealth({ configured: { opening_bell: false, closing_bell: false }, now: NOW });
check('unconfigured Bell says not set up', by(r, 'opening_bell').status === 'not_set_up');
check('no chases yet is quiet, not failing', by(r, 'chases').status === 'quiet');
check('no delivery table means CFO pack not set up', by(r, 'cfo_pack').status === 'not_set_up');

// 2. A Bell whose template was never approved: fails every day.
r = buildChannelHealth({
  configured: { opening_bell: true, closing_bell: true }, now: NOW,
  bellLogs: [1, 2, 3].map((d) => ({ operation: 'send_closing', status: 'error', error_message: 'Gupshup send failed: 400 template not approved', created_at: ago(d) }))
});
check('failing Bell is flagged failing', by(r, 'closing_bell').status === 'failing');
check('template error is made readable', /hasn’t approved/.test(by(r, 'closing_bell').last_error), by(r, 'closing_bell').last_error);
check('other Bell is unaffected', by(r, 'opening_bell').status === 'quiet');

// 3. Working, with one old failure, is still working.
r = buildChannelHealth({
  configured: { opening_bell: true, closing_bell: true }, now: NOW,
  bellLogs: [
    { operation: 'send_opening', status: 'success', created_at: ago(1) }, { operation: 'send_opening', status: 'success', created_at: ago(2) },
    { operation: 'send_opening', status: 'success', created_at: ago(3) }, { operation: 'send_opening', status: 'error', error_message: 'x', created_at: ago(20) }
  ]
});
check('mostly-fine Bell is working', by(r, 'opening_bell').status === 'working' && by(r, 'opening_bell').failed_30d === 1);

// 4. Sends older than the window don't count.
r = buildChannelHealth({ configured: { opening_bell: true }, now: NOW, bellLogs: [{ operation: 'send_opening', status: 'error', error_message: 'x', created_at: ago(45) }] });
check('old failures fall out of the window', by(r, 'opening_bell').status === 'quiet');

// 5. Latest attempt failing wins over an older success.
r = buildChannelHealth({ configured: { opening_bell: true }, now: NOW, bellLogs: [
  { operation: 'send_opening', status: 'success', created_at: ago(5) }, { operation: 'send_opening', status: 'success', created_at: ago(4) },
  { operation: 'send_opening', status: 'success', created_at: ago(3) }, { operation: 'send_opening', status: 'error', error_message: '401 unauthorized', created_at: ago(0.1) }] });
check('a fresh failure after successes is flagged', by(r, 'opening_bell').status === 'failing' && /credentials/.test(by(r, 'opening_bell').detail));

// 6. Chases: queued / skipped / manual links are not send attempts.
r = buildChannelHealth({ now: NOW, deliveries: [], chases: [
  { id: 'c1', chase_target_id: 't1', chase_number: 1, status: 'queued', channel: 'whatsapp_template', created_at: ago(1) },
  { id: 'c2', chase_target_id: 't1', chase_number: 1, status: 'skipped', channel: 'whatsapp_template', created_at: ago(1) },
  { id: 'c3', chase_target_id: 't1', chase_number: 1, status: 'failed', channel: 'manual_deeplink', error: 'x', created_at: ago(1) }] });
check('non-sends are ignored', by(r, 'chases').status === 'quiet', by(r, 'chases'));

// 7. Email deliveries: test sends ignored, real failures flagged.
r = buildChannelHealth({ now: NOW, deliveries: [{ kind: 'test', status: 'sent', created_at: ago(1) }, { kind: 'scheduled', status: 'failed', error: 'Resend domain not verified', created_at: ago(2) }] });
check('CFO pack failure flagged, test send not counted', by(r, 'cfo_pack').status === 'failing' && by(r, 'cfo_pack').sent_30d === 0, by(r, 'cfo_pack'));

// 8. Recovered ₹.
const T = (id, o) => ({ id, party_name: id, amount: 1000, state: 'active', ...o });
const C = (t, n, d, status = 'sent') => ({ id: t + n, chase_target_id: t, chase_number: n, status, channel: 'whatsapp_template', sent_at: ago(d), created_at: ago(d) });
r = buildChannelHealth({
  now: NOW, deliveries: [],
  targets: [
    T('paidAfter', { state: 'resolved_paid', amount: 50000, resolved_at: ago(2) }),
    T('paidNeverChased', { state: 'resolved_paid', amount: 99999, resolved_at: ago(2) }),
    T('paidBeforeChase', { state: 'resolved_paid', amount: 7777, resolved_at: ago(9) }),
    T('chaseFailedOnly', { state: 'resolved_paid', amount: 4444, resolved_at: ago(2) }),
    T('paidOld', { state: 'resolved_paid', amount: 12345, resolved_at: ago(60) }),
    T('promise', { state: 'paused_promise', amount: 2000 }),
    T('inflight', { state: 'active', amount: 3000 }),
    T('activeNeverSent', { state: 'active', amount: 9000 })
  ],
  chases: [C('paidAfter', 1, 10), C('paidAfter', 2, 5), C('paidBeforeChase', 1, 3), C('chaseFailedOnly', 1, 5, 'failed'), C('paidOld', 1, 70), C('inflight', 1, 2), C('promise', 1, 4)]
});
check('only invoices paid after a chase count', r.recovered.amount === 50000 && r.recovered.invoices === 1, r.recovered);
check('counts the chases before payment and days from the last one', r.recovered.items[0].chases_before_payment === 2 && r.recovered.items[0].days_to_pay === 3, r.recovered.items[0]);
check('still-chasing only counts invoices actually chased', r.recovered.still_chasing.amount === 3000 && r.recovered.still_chasing.invoices === 1, r.recovered.still_chasing);
check('promises tracked separately', r.recovered.promised.amount === 2000 && r.recovered.promised.invoices === 1);

// 9. Errors stay readable.
check('unknown errors pass through, trimmed', plainError('x'.repeat(300)).length <= 140);
check('empty error is null', plainError('') === null);


// Margyn updates (Watch): delivered counts, pending is neither, mode is said plainly; Bells not live without templates.
r = buildChannelHealth({ configured: { opening_bell: false, closing_bell: false }, now: NOW,
  watch: { mode: 'on', deliveries: [{ status: 'delivered', sent_at: ago(1), delivered_at: ago(1) }, { status: 'accepted', sent_at: ago(0) }] } });
check('watch delivered → working', by(r, 'margyn_updates').status === 'working' && by(r, 'margyn_updates').sent_30d === 1, by(r, 'margyn_updates'));
check('bells_live false without templates', r.bells_live === false);
r = buildChannelHealth({ now: NOW, watch: { mode: 'off', deliveries: [] } });
check('watch off says Off', by(r, 'margyn_updates').headline === 'Off');
r = buildChannelHealth({ now: NOW, watch: { mode: 'on', deliveries: [{ status: 'sent', sent_at: ago(0) }] } });
check('watch awaiting receipt is quiet, not failing', by(r, 'margyn_updates').status === 'quiet' && /waiting/.test(by(r, 'margyn_updates').detail));
r = buildChannelHealth({ now: NOW });
check('no watch input → no watch row', !by(r, 'margyn_updates'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
