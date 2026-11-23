/**
 * Margyn Watch never reads half-updated Tally books (23 Nov 2026 review of Care Hygiene's chats).
 * 16 Nov, 3 pm: "Bank and cash ₹14.8 L, up ₹25.4 L" with no money in, and in the same message "Bafna Surgical's
 * balance fell ₹19.7 L with no receipt entered, so it's likely a credit note". Tally's ledger balances already
 * had the payment; the receipt voucher hadn't reached Margyn. The agent sends balances first and entries after,
 * and its health report closes even a sync whose voucher step stopped early, so tallyData.syncState said "whole".
 * The check now compares each balance with opening + synced entries (booksEngine.ledgerTie) against the last read
 * that agreed (watchBrief.tieVerdict).
 * Zero-dep. Run: node api/_lib/__tests__/watchHalfSync.test.js
 */
const E = require('../booksEngine');
const W = require('../watchBrief');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''))); };

const AT = (hhmmIst) => { const [h, m] = hhmmIst.split(':').map(Number); return new Date(Date.UTC(2026, 10, 16, h, m) - 5.5 * 3600000); };
// Tally's sign: debit negative, on entries and balances alike.
const v = (id, date, type, party, amt, other) => ({ tally_guid: id, voucher_type: type, voucher_number: id, date, party_name: party, amount: amt, is_cancelled: false,
  entries: type === 'Sales' ? [{ ledger: party, amount: -amt, is_party: true }, { ledger: other, amount: amt }]
    : type === 'Receipt' ? [{ ledger: party, amount: amt, is_party: true }, { ledger: other, amount: -amt }]
      : [{ ledger: party, amount: -amt, is_party: true }, { ledger: other, amount: amt }] });   // Payment
const history = [];
for (const m of ['04', '05', '06', '07', '08', '09', '10']) {
  history.push(v('s' + m, `2026-${m}-10`, 'Sales', 'Bafna Surgical', 2000000, 'Sales'));
  history.push(v('r' + m, `2026-${m}-20`, 'Receipt', 'Bafna Surgical', 1800000, 'HDFC Bank'));
  history.push(v('p' + m, `2026-${m}-25`, 'Payment', 'Rent', 100000, 'HDFC Bank'));
}
const OPEN = { 'Bafna Surgical': -1000000, 'HDFC Bank': -500000, Rent: 0, Sales: 0 };
const PARENT = { 'Bafna Surgical': 'Sundry Debtors', 'HDFC Bank': 'Bank Accounts', Rent: 'Indirect Expenses', Sales: 'Sales Accounts' };
/**
 * Tally's books after `inTally` entries, as Margyn holds them with only `synced` entries arrived.
 * extraGap: a ledger that never ties by that much (history kept in another file), the same on every read.
 */
function book(inTally, synced, extraGap) {
  const closing = Object.assign({}, OPEN);
  for (const x of inTally) for (const e of x.entries) closing[e.ledger] += e.amount;
  if (extraGap) closing['HDFC Bank'] -= extraGap;
  const owed = -closing['Bafna Surgical'];
  return { connected: true, company: 'Care Hygiene (2026-27)', overrides: {}, syncRuns: [], balance_convention: 'same', source: 'tally',
    ledgers: Object.keys(OPEN).map((name) => ({ name, parent: PARENT[name], opening_balance: OPEN[name], closing_balance: closing[name] })),
    vouchers: synced.slice(),
    bills: [{ direction: 'receivable', party_name: 'Bafna Surgical', bill_ref: 'B1', bill_date: '2026-10-10', due_date: '2026-11-09', closing_balance: owed, overdue_days: 7 }] };
}
// booksTools.contextFor names the source on the context.
const read = (b, at, prior) => { const ctx = Object.assign(E.prepare(b, { now: at }), { source: b.source || 'tally', source_name: b.source === 'zoho' ? 'Zoho Books' : 'Tally' }); return { ctx, snap: W.snapshot(ctx, null, at, prior) }; };

// The day: morning read whole; at 3 pm Tally has Bafna's ₹19.7 L receipt, Margyn has the balances but not the entry.
const receipt = v('r-nov', '2026-11-16', 'Receipt', 'Bafna Surgical', 1970000, 'HDFC Bank');
const morningRead = read(book(history, history), AT('09:00'), null);
const ms = Object.assign({}, morningRead.snap, { points: [] });

console.log('16 Nov 3 pm: balances in, receipt voucher not yet');
check('the morning read ties: nothing held', morningRead.snap.tie && morningRead.snap.tie.ok === true && morningRead.snap.cash != null, morningRead.snap.tie);
const half = read(book(history.concat([receipt]), history), AT('15:00'), ms);
check('the 3 pm read is seen as half updated', W.halfSynced(half.snap), half.snap.tie);
check('...and names what moved with no entry behind it', half.snap.tie.off.some((o) => o.name === 'HDFC Bank') && half.snap.tie.off.some((o) => /Bafna/.test(o.name)), half.snap.tie.off);
check('no cash or borrowing figure is kept from it', half.snap.cash == null && half.snap.borrowed == null, half.snap);
const p3 = W.pulse(half.ctx, null, half.snap, null, ms, [], { slot: 'afternoon' });
check('the 3 pm pulse is held', p3.send === false && p3.halfSynced === true, p3);
check('...and never says the balance fell with no receipt', !/no receipt/.test(p3.text || ''), p3.text);
check('...nor states bank and cash', !/Bank and cash ₹/.test(p3.text || ''), p3.text);
check('...and the reason says why, for the day\'s log', /didn't agree yet/.test(p3.reason || ''), p3.reason);

console.log('5 pm: the receipt arrives; the change is told against the last good read');
const whole = read(book(history.concat([receipt]), history.concat([receipt])), AT('17:00'), half.snap);
check('the books agree again', whole.snap.tie.ok === true && whole.snap.cash != null, whole.snap.tie);
const p5 = W.pulse(whole.ctx, null, whole.snap, null, ms, [], { slot: 'late' });
check('Bafna is told as paid, with the receipt', /Bafna Surgical paid ₹19\.7 L/.test(p5.text || ''), p5.text);
check('never as a balance that fell with no receipt', !/no receipt/.test(p5.text || ''), p5.text);
check('cash up ₹19.7 L since this morning, the receipt and nothing else', /Bank and cash ₹[\d.]+ (L|Cr), up ₹19\.7 L since this morning/.test(p5.text || ''), p5.text);
check('the money line shows the ₹19.7 L in', /₹19\.7 L in/.test(p5.text || ''), p5.text);

console.log('a half-updated read saved earlier never turns into "fell with no receipt" later');
// A snapshot taken mid-sync (before this fix, or a morning that had to go out) is the comparison point; the
// receipt still hasn't arrived but the gaps say the drop is the sync, not a credit note.
const stillHalf = read(book(history.concat([receipt]), history), AT('19:00'), half.snap);
check('still half updated at 7 pm (the base is the last good read, not the 3 pm one)', W.halfSynced(stillHalf.snap), stillHalf.snap.tie);
const moves = W.partyMoves(stillHalf.ctx, ms, stillHalf.snap, '2026-11-16');
check('partyMoves leaves out a fall the entries don\'t explain', !moves.some((p) => /bafna/.test(p.key)), moves);

console.log('the evening and next morning go out, without a figure they can\'t stand behind');
const ev = W.evening(stillHalf.ctx, null, stillHalf.snap, ms, [], [], [], {});
check('evening: no bank and cash figure, says why', !/Bank and cash ₹/.test(ev.text) && /don't agree yet/.test(ev.text), ev.text);
const nextAt = new Date(AT('09:00').getTime() + 86400000);
const nextHalf = read(book(history.concat([receipt]), history), nextAt, stillHalf.snap);
const mo = W.morning(nextHalf.ctx, null, nextHalf.snap, ms, [], null, {});
check('next morning: still held, no cash figure repeated', W.halfSynced(nextHalf.snap) && !/Bank and cash ₹/.test(mo.text) && /don't agree yet/.test(mo.text), mo.text);
check('...and the headline doesn\'t say "n/a"', !/n\/a/.test(mo.headline), mo.headline);

console.log('the other way round: entry in before its balance');
const early = read(book(history, history.concat([receipt])), AT('15:00'), ms);
check('a receipt synced before the balance moved is held too', W.halfSynced(early.snap) && early.snap.cash == null, early.snap.tie);

console.log('books that never tie exactly are not held for it');
const odd0 = read(book(history, history, 500000), AT('09:00'), null);
const oddMs = Object.assign({}, odd0.snap, { points: [] });
check('a bank ledger ₹5 L off its entries every day: first read fine', odd0.snap.tie.ok === true && odd0.snap.tie.gaps['$hdfc bank'] === 500000, odd0.snap.tie);
const odd1 = read(book(history.concat([receipt]), history.concat([receipt]), 500000), AT('15:00'), oddMs);
check('...and with the same ₹5 L gap later, a real receipt goes out as normal', odd1.snap.tie.ok === true && odd1.snap.cash != null, odd1.snap.tie);
const po = W.pulse(odd1.ctx, null, odd1.snap, null, oddMs, [], { slot: 'afternoon' });
check('...told as paid, cash up ₹19.7 L', /Bafna Surgical paid ₹19\.7 L/.test(po.text || '') && /up ₹19\.7 L since this morning/.test(po.text || ''), po.text);

console.log('a change that lasts is accepted after 36 hours');
const late = read(book(history.concat([receipt]), history), new Date(AT('09:00').getTime() + 2 * 86400000), nextHalf.snap);
check('two days on with no read agreeing, the books are taken as they are', late.snap.tie.ok === true && late.snap.cash != null, late.snap.tie);

console.log('other books are unchanged');
const zb = Object.assign(book(history.concat([receipt]), history), { source: 'zoho' });
const zs = read(zb, AT('15:00'), ms).snap;
check('Zoho / Odoo: no tie check, cash as before', zs.tie === undefined && zs.cash != null, zs);
check('no prior snapshot (first update ever): never held', read(book(history.concat([receipt]), history), AT('15:00'), null).snap.tie.ok === true);
check('a legacy snapshot without the check: never held', read(book(history.concat([receipt]), history), AT('15:00'), Object.assign({}, ms, { tie: undefined })).snap.tie.ok === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
