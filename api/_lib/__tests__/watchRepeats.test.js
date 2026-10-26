/**
 * The day's WhatsApp updates never say nothing (26 Oct 2026): "down to ₹1.51 Cr, from ₹1.51 Cr" (24 Oct), and the
 * same "down to ₹1.48 Cr from ₹1.75 Cr" at 12:30 and again at 3 pm (23 Oct).
 * Zero-dep. Run: node api/_lib/__tests__/watchRepeats.test.js
 */
const E = require('../booksEngine');
const W = require('../watchBrief');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''))); };

const NOW = new Date('2026-10-24T09:30:00Z');   // 3 pm IST
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
const sale = (i, date, party, v) => ({ tally_guid: 's' + i, voucher_type: 'Sales', voucher_number: 'S' + i, date, party_name: party, amount: v, is_cancelled: false,
  entries: [{ ledger: party, amount: -v, is_party: true }, { ledger: 'Sales', amount: v }] });
const book = (owed) => ({ connected: true, company: 'Acme', overrides: {}, syncRuns: [],
  ledgers: [{ name: 'Sales', parent: 'Sales Accounts' }, { name: 'Big Co', parent: 'Sundry Debtors' }],
  vouchers: [sale(1, day(150), 'Big Co', 9000000), sale(2, day(120), 'Big Co', 9000000), sale(3, day(90), 'Big Co', 9000000)],
  bills: [{ direction: 'receivable', party_name: 'Big Co', bill_ref: 'B1', bill_date: day(120), due_date: day(90), closing_balance: owed, overdue_days: 90 }] });

const ctx = E.prepare(book(15100000), { now: NOW });
const t = Math.max(25000, (ctx.material || 0) / 4);
const snap = W.snapshot(ctx, null, NOW);
const morning = (late) => Object.assign({}, snap, { recv_late30: late, points: [], at: new Date(NOW.getTime() - 7 * 3600000).toISOString() });

// 1. Down by more than the threshold but the same to the eye: nothing to say.
const sameLook = snap.recv_late30 + t + 1;
if (E.inr(sameLook) === E.inr(snap.recv_late30)) {
  const r = W.pulse(ctx, null, snap, null, morning(sameLook), [], { slot: 'afternoon' });
  check('"down to ₹1.51 Cr, from ₹1.51 Cr" is never sent', !/down to/.test(r.text || '') , r);
} else check('fixture: a fall that reads the same exists at this size', false, [E.inr(sameLook), E.inr(snap.recv_late30), t]);

// 2. A real fall is said once; the next pulse with nothing new says nothing.
const ms = morning(17500000);
const r1 = W.pulse(ctx, null, snap, null, ms, [], { slot: 'noon' });
check('a real fall is said', r1.send && /down to/.test(r1.text), r1);
const last = Object.assign({}, snap, { said: r1.said, pulses: r1.pulses, sig: r1.sig });
const r2 = W.pulse(ctx, null, snap, last, ms, [], { slot: 'afternoon' });
check('the same fall is not said again at the next pulse', !r2.send || !/down to/.test(r2.text || ''), r2);

// 3. It falls a further step: said again, with the new figure.
const ctx3 = E.prepare(book(15100000 - 3 * t - 200000), { now: NOW });
const snap3 = W.snapshot(ctx3, null, NOW);
const r3 = W.pulse(ctx3, null, snap3, last, ms, [], { slot: 'afternoon' });
check('a further fall is said, with the new figure', r3.send && r3.text.includes('down to ' + E.inr(snap3.recv_late30)), r3);

// 4. Bounces back up (a half-read sync): never "down to" a figure higher than the one already said.
const lastLow = Object.assign({}, snap3, { said: r3.said, pulses: r3.pulses, sig: r3.sig });
const r4 = W.pulse(ctx, null, snap, lastLow, ms, [], { slot: 'late' });
check('never "down to" a figure above the one already said', !/down to/.test(r4.text || ''), r4);

// 5. Cash from a sync before today says so on its own line (26 Oct 2026: Saturday's ₹13.9 L went out on Monday).
const old = E.prepare(Object.assign(book(15100000), { lastSync: new Date(NOW.getTime() - 2 * 86400000).toISOString() }), { now: NOW });
const m5 = W.morning(old, null, W.snapshot(old, null, NOW), null, [], null, {});
const fresh = E.prepare(Object.assign(book(15100000), { lastSync: new Date(NOW.getTime() - 3600000).toISOString() }), { now: NOW });
const m6 = W.morning(fresh, null, W.snapshot(fresh, null, NOW), null, [], null, {});
check('books not synced today: the cash line says when they are from', /Bank and cash [^\n]*\(books as of 22 Oct/.test(m5.text) && /books as of/.test(m5.headline), m5.text.slice(0, 300));
check('books synced today: no date on the cash line', !/Bank and cash [^\n]*books as of/.test(m6.text) && !/books as of/.test(m6.headline), m6.text.slice(0, 300));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
