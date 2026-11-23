/** Run: node api/_lib/__tests__/opsTeam.test.js — Ops Console team-logins analysis, pure, no network. */
const T = require('../opsTeam');

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const NOW = Date.parse('2026-11-21T12:00:00Z');
const H = 3600000, D = 24 * H;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const DEMO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VT = '11111111-1111-4111-8111-111111111111', YK = '22222222-2222-4222-8222-222222222222', GONE = '33333333-3333-4333-8333-333333333333', CA = '44444444-4444-4444-8444-444444444444';
const M1 = '0000000a-0000-4000-8000-000000000001', M2 = '0000000a-0000-4000-8000-000000000002', M3 = '0000000a-0000-4000-8000-000000000003';

const d = {
  members: [
    { id: M1, account_id: DEMO, user_id: VT, email: 'v@test.in', name: 'Varad (test)', role: 'finance', status: 'active', created_at: at(44 * H), last_seen_at: at(2 * H) },
    { id: M2, account_id: DEMO, user_id: YK, email: 'yash@vc.com', name: 'Yash Kumar', role: 'finance', status: 'active', created_at: at(5 * H), last_seen_at: at(5 * H) },
    { id: M3, account_id: OTHER, user_id: CA, email: 'ca@firm.in', name: 'Rao CA', role: 'advisor', status: 'active', created_at: at(20 * D), last_seen_at: at(12 * D) }
  ],
  invites: [
    { id: 'i1', account_id: DEMO, email: 'v@test.in', name: 'Varad (test)', role: 'finance', created_at: at(45 * H), expires_at: at(-5 * D), used_at: at(44 * H), used_by: VT },
    { id: 'i2', account_id: DEMO, email: 'yash@vc.com', name: 'Yash Kumar', role: 'finance', created_at: at(20 * H), expires_at: at(-6 * D), used_at: at(5 * H), used_by: YK },
    { id: 'i3', account_id: DEMO, email: 'soon@x.com', name: 'Soon', role: 'viewer', created_at: at(6 * D), expires_at: at(-20 * H), used_at: null },
    { id: 'i3old', account_id: DEMO, email: 'soon@x.com', name: 'Soon', role: 'viewer', created_at: at(6.5 * D), expires_at: at(-12 * H), used_at: null, revoked_at: at(6 * D) },
    { id: 'i4', account_id: DEMO, email: 'late@x.com', name: null, role: 'viewer', created_at: at(10 * D), expires_at: at(3 * D), used_at: null },
    { id: 'i5', account_id: DEMO, email: 'gone@x.com', name: 'Gone', role: 'viewer', created_at: at(9 * D), expires_at: at(2 * D), used_at: at(8 * D), used_by: GONE },
    { id: 'i6', account_id: OTHER, email: 'ca@firm.in', name: 'Rao CA', role: 'advisor', created_at: at(21 * D), expires_at: at(14 * D), used_at: at(20 * D), used_by: CA }
  ],
  personEvents: [
    { user_id: DEMO, event: 'invited', party_name: 'Varad (test)', note: 'v@test.in as Finance', actor_name: 'Varad', created_at: at(45 * H) },
    { user_id: DEMO, event: 'whatsapp_linked', party_name: 'Varad (test)', note: '+919800001510 (by themselves)', actor_id: VT, created_at: at(40 * H) },
    { user_id: DEMO, event: 'removed', party_name: 'Gone', note: null, created_at: at(3 * D) }
  ],
  links: [
    { member_id: M1, business_id: DEMO, phone: '919800001510', whatsapp_access: true, created_at: at(40 * H) },
    { member_id: M3, business_id: OTHER, phone: '919800007777', whatsapp_access: true, created_at: at(19 * D) }
  ],
  welcomes: [
    { user_id: DEMO, to_phone: '919800001510', status: 'read', sent_at: at(40 * H), delivered_at: at(40 * H - 5000), read_at: at(39 * H) },
    { user_id: OTHER, to_phone: '919800007777', status: 'failed', sent_at: at(19 * D), failed_at: at(19 * D), error_code: '131026' }
  ],
  profiles: [{ id: DEMO, company_name: 'MARGYN DEMO' }, { id: OTHER, company_name: 'Rao Traders' }, { id: YK, company_name: 'Yash Co' }],
  chats: [
    { author_id: VT, user_id: DEMO, role: 'user', created_at: at(30 * H) },
    { author_id: VT, user_id: OTHER, role: 'user', created_at: at(30 * H) }   // another business: not counted for DEMO
  ],
  events: [
    { user_id: DEMO, name: 'app_open', at: at(43 * H), props: { by: VT } },
    { user_id: DEMO, name: 'page_view', at: at(43 * H - 60000), props: { by: VT, page: 'receivables', prev_page: 'home', prev_secs: 60 } },
    { user_id: DEMO, name: 'page_view', at: at(43 * H - 300000), props: { by: VT, page: 'cash', prev_page: 'receivables', prev_secs: 240 } },
    { user_id: DEMO, name: 'page_view', at: at(2 * H), props: { by: VT, page: 'left_app', prev_page: 'cash', prev_secs: 99999 } },
    { user_id: DEMO, name: 'page_view', at: at(4 * H), props: { by: YK, page: 'home' } }
  ],
  convo: [
    { from_phone: '919800001510', role: 'assistant', profile_id: DEMO, created_at: at(40 * H) },
    { from_phone: '919800001510', role: 'user', profile_id: DEMO, created_at: at(38 * H) },
    { from_phone: '919800001510', role: 'user', profile_id: DEMO, created_at: at(3 * H) }
  ],
  emails: { [DEMO]: 'margynlabs@gmail.com', [OTHER]: 'owner@rao.in' },
  books: { [DEMO]: ['zoho'], [OTHER]: [], [YK]: [] },
  ownZoho: [{ user_id: YK, status: 'pending_org_selection' }],
  ownEvents: [{ user_id: YK, name: 'zoho_callback', at: at(22 * H), props: { ok: false, error_code: 'no_books_organization' } }]
};

const r = T.analyze(d, NOW);
const P = (email) => r.people.find((p) => p.email === email);
const vt = P('v@test.in'), yk = P('yash@vc.com'), soon = P('soon@x.com'), late = P('late@x.com'), gone = P('gone@x.com'), ca = P('ca@firm.in');

console.log('people');
check('one row per person per business; the superseded invite is folded in', r.people.length === 6 && r.people.filter((p) => p.email === 'soon@x.com').length === 1, r.people.map((p) => p.email + ':' + p.status));
check('statuses: member / invited / expired / removed', vt.status === 'member' && yk.status === 'member' && soon.status === 'invited' && late.status === 'expired' && gone.status === 'removed');
check('the used invite gives time to join', vt.hours_to_join === 1 && yk.hours_to_join === 15, [vt.hours_to_join, yk.hours_to_join]);
check('invited by, from the audit log', vt.invited_by === 'Varad');
check('business name and owner email', vt.business === 'MARGYN DEMO' && vt.owner_email === 'margynlabs@gmail.com' && ca.business === 'Rao Traders');

console.log('WhatsApp');
check('linked number shown as last four only, linked by themselves', vt.whatsapp.linked && vt.whatsapp.last4 === '1510' && vt.whatsapp.linked_by === 'themselves' && !JSON.stringify(r).includes('919800001510'));
check('first message: read, from WhatsApp\'s own receipt', vt.whatsapp.welcome.status === 'read');
check('replied after the first message', vt.activity.replied_after_welcome === true);
check('failed first message is red with the code', ca.whatsapp.welcome.status === 'failed' && ca.health === 'red' && /131026/.test(ca.next), ca.next);

console.log('activity');
check('questions per channel, only in that business', vt.activity.questions_app_total === 1 && vt.activity.whatsapp_in_30d === 2, vt.activity);
check('pages: time on each, a left-open tab capped at 30 min', vt.pages.find((x) => x.page === 'receivables').secs === 240 && vt.pages.find((x) => x.page === 'cash').secs === 1800 && vt.pages.find((x) => x.page === 'home').secs === 60, vt.pages);
check('left_app is not a page', !vt.pages.some((x) => x.page === 'left_app'));
check('minutes in app add up (1 + 4 + 30 capped)', vt.activity.minutes_in_app_30d === 35, vt.activity.minutes_in_app_30d);
check('another person\'s page views don\'t mix in', yk.pages.length === 1 && yk.pages[0].page === 'home' && !vt.pages.some((x) => x.views && x.page === 'home'));
check('a 30-day activity strip', vt.activity.strip.length === 30 && vt.activity.strip.some((x) => x.n > 0));
check('active days counted', vt.activity.active_days_30d >= 2, vt.activity.active_days_30d);

console.log('stages and next steps');
check('Varad (test) went all the way', Object.values(vt.stages).every(Boolean) && vt.stuck_at === null && vt.health === 'green', { st: vt.stages, next: vt.next });
check('Yash: joined, stuck at WhatsApp, told plainly', yk.stuck_at === 'whatsapp_linked' && yk.health === 'yellow' && /no WhatsApp linked/.test(yk.next), yk.next);
check('Yash\'s own business: Zoho said no Books company', yk.own_account && yk.own_account.zoho_failures[0].code === 'no_books_organization' && yk.own_account.company === 'Yash Co');
check('invite about to expire is red, with hours left', soon.health === 'red' && /expires in 20h/.test(soon.next), soon.next);
check('expired unused invite is red', late.health === 'red' && /expired unused/.test(late.next), late.next);
check('removed person is grey', gone.health === 'grey' && /Removed/.test(gone.next));
check('quiet member: the advisor last seen 12 days ago gets a check-in once WhatsApp is fixed (failure ranks first)', /failed/.test(ca.next));
check('red first in the list', r.people[0].health === 'red');

console.log('totals and funnel');
const T0 = r.totals;
check('joined 4 of 5 live invites (cancelled excluded); median hours to join', T0.joined === 4 && T0.median_hours_to_join != null, T0);
check('open / expiring / expired', T0.open_invites === 1 && T0.expiring_48h === 1 && T0.expired_unused === 1, T0);
check('members, WhatsApp linked share', T0.members === 3 && T0.whatsapp_linked === 2 && T0.whatsapp_linked_pct === 67, T0);
check('first messages: sent, delivered, read, failed', T0.welcome_sent === 2 && T0.welcome_delivered === 1 && T0.welcome_read === 1 && T0.welcome_failed === 1, T0);
check('active in 7 days excludes the quiet advisor', T0.active_7d === 2, T0.active_7d);
check('questions in 30d and the WhatsApp share', T0.questions_30d === 3 && T0.questions_whatsapp_share_pct === 67, T0);
const f = Object.fromEntries(r.funnel.map((x) => [x.stage, x]));
check('funnel counts by stage', f.invited.count === 6 && f.joined.count === 4 && f.whatsapp_linked.count === 2 && f.welcome_delivered.count === 1, r.funnel.map((x) => x.stage + ':' + x.count));
check('funnel conversion from the stage before', f.joined.from_previous_pct === 67 && f.whatsapp_linked.from_previous_pct === 50, r.funnel);
check('pages across everyone', r.pages[0].page === 'cash' && r.pages.find((x) => x.page === 'home').people === 2, r.pages);
check('per business', r.businesses.find((b) => b.account_id === DEMO).members === 2 && r.businesses.find((b) => b.account_id === DEMO).roles.Finance === 2);

console.log('honest when a source is missing');
const r2 = T.analyze(Object.assign({}, d, { welcomes: null, events: null }), NOW);
check('says which sources are missing instead of showing zeros as fact', r2.missing.includes('welcome_receipts') && r2.missing.includes('app_events'), r2.missing);
check('still works', r2.people.length === 6);
console.log('every message sent to them (23 Nov 2026)');
const rs = T.analyze(Object.assign({}, d, { sends: [
  { user_id: DEMO, kind: 'welcome', to_phone: '919800001510', status: 'read', sent_at: at(40 * H), delivered_at: at(40 * H - 5000), read_at: at(39 * H) },
  { user_id: DEMO, kind: 'note', to_phone: '919800001510', status: 'delivered', sent_at: at(2 * H), delivered_at: at(2 * H - 9000) },
  { user_id: DEMO, kind: 'watch', to_phone: '919800001510', status: 'queued', sent_at: at(1 * H) },
  { user_id: OTHER, kind: 'watch', to_phone: '919800001510', status: 'delivered', sent_at: at(1 * H), delivered_at: at(1 * H) }
] }), NOW);
const vm = rs.people.find((p) => p.email === 'v@test.in').whatsapp;
check('messages: newest first, this business only, labelled, with WhatsApp\'s status', vm.messages.length === 3 && vm.messages[0].label === 'Daily update' && vm.messages[0].status === 'sent' && vm.messages[1].label === 'Hand-written update' && vm.messages[1].status === 'delivered' && vm.messages[2].status === 'read', vm.messages);
check('messages: sent in 30 days and the last one WhatsApp delivered', vm.sent_30d === 3 && vm.last_delivered_at === at(2 * H - 9000), vm);
check('messages: no read of them = an empty list, not a crash', Array.isArray(vt.whatsapp.messages) && vt.whatsapp.messages.length === 0);

const r3 = T.analyze({}, NOW);
check('empty: no crash, nothing invented', r3.people.length === 0 && r3.totals.join_rate_pct === null && r3.totals.median_hours_to_join === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
