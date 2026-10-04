/**
 * _lib/billTieOut.js
 * Customers' open bills, lined up with what their ledger says they owe (2026-10-04).
 *
 * Tally's bill-wise list and the customer's ledger balance should agree. On Care Hygiene they didn't for 67
 * of 194 customers (₹59 L): Agastya Corporation owes ₹13.55 L by its ledger with no open bill at all (so it
 * was missing from Receivables), while S.S.D Surgical showed ₹9.79 L of bills against a ledger of ₹12 (paid
 * bills never knocked off, which Margyn would have chased). The ledger balance is Tally's own figure for
 * what the customer owes; the bills only split it up. So, per customer:
 *   - bills and ledger agree (within ₹1 or 1%): the bills, untouched;
 *   - more billed than owed: payments settle the oldest bills first, so the oldest are set aside until the
 *     bills add up to the ledger (the last one kept may be partly paid);
 *   - more owed than billed: the difference is added from the customer's own entries, oldest-first matching
 *     (what's left is their newest invoices), marked `from_entries`; a balance older than this year's entries
 *     comes in as "Carried from last year".
 * Suppliers are left alone here (moneyModel / cashFlowModel.supplierOpenItems handle books that don't keep
 * them bill by bill). A customer whose ledger can't be read keeps its bills.
 * Pure. CommonJS, zero-npm.
 */

const CF = require('./cashFlowModel');

const DAY = 86400000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const keyOf = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/&#(1[03]|x0?[ad]);/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => { if (!d) return NaN; const s = String(d); const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10); return Date.parse(iso + 'T00:00:00Z'); };

/**
 * ctx: a booksEngine ctx (prepare()). Returns { bills, summary } where bills is ctx.bills with receivables
 * tied out, and summary says what moved: { tied, trimmed: {parties, amount}, added: {parties, amount} }.
 */
function tieReceivables(ctx) {
  const bills = ctx.bills || [];
  const todayMs = (ctx.today instanceof Date ? ctx.today : new Date(ctx.today)).getTime();
  const bal = CF.partyBalancesToday(ctx);
  const habits = CF.partyHabits(ctx, Infinity, 'debtor');
  // Typical credit period from bills that carry a due date (due − bill date), for the rows added from entries.
  const credits = bills.filter((b) => b.direction !== 'payable' && !b.advance).map((b) => (dayMs(b.due_date) - dayMs(b.bill_date)) / DAY).filter((d) => Number.isFinite(d) && d >= 0 && d < 400).sort((a, b) => a - b);
  const creditDays = credits.length ? Math.round(credits[Math.floor(credits.length / 2)]) : 0;
  const fy = new Date(todayMs); const fyStart = Date.UTC(fy.getUTCMonth() >= 3 ? fy.getUTCFullYear() : fy.getUTCFullYear() - 1, 3, 1);

  const byParty = new Map();
  for (const b of bills) {
    if (b.direction === 'payable' || b.advance) continue;
    const k = keyOf(b.party_name);
    if (!byParty.has(k)) byParty.set(k, []);
    byParty.get(k).push(b);
  }
  const drop = new Set(), changed = new Map(), extra = [];
  const summary = { tied: 0, trimmed: { parties: 0, amount: 0 }, added: { parties: 0, amount: 0 } };
  const keys = new Set([...byParty.keys(), ...[...bal.entries()].filter(([, p]) => p.bucket === 'debtor').map(([k]) => k)]);
  for (const k of keys) {
    const p = bal.get(k);
    if (!p || p.bucket !== 'debtor' || p.balance == null) continue;   // ledger unknown: keep the bills
    const owed = Math.max(0, p.balance);
    const list = byParty.get(k) || [];
    const billed = list.reduce((a, b) => a + Math.abs(num(b.closing_balance)), 0);
    if (Math.abs(billed - owed) <= Math.max(1, 0.01 * Math.max(owed, billed))) { if (owed >= 1) summary.tied++; continue; }
    if (billed > owed) {
      // Newest bills first: keep them until the ledger amount is covered; older ones were paid.
      const sorted = list.slice().sort((a, b) => (dayMs(b.bill_date) || 0) - (dayMs(a.bill_date) || 0));
      let left = owed;
      for (const b of sorted) {
        const amt = Math.abs(num(b.closing_balance));
        if (left >= amt - 0.5) { left -= amt; continue; }
        if (left >= 1) { changed.set(b, left); left = 0; }
        else drop.add(b);
      }
      summary.trimmed.parties++; summary.trimmed.amount += billed - owed;
    } else {
      // Owed but not in bills: the customer's newest open amounts from their entries, up to the gap.
      let gap = owed - billed;
      const open = ((habits.parties.get(k) || {}).open || []).slice().sort((a, b) => (b.ms == null ? -Infinity : b.ms) - (a.ms == null ? -Infinity : a.ms));
      for (const o of open) {
        if (gap < 1) break;
        const amt = Math.min(gap, o.amt);
        const billMs = o.ms == null ? fyStart : o.ms;
        extra.push({ direction: 'receivable', party_name: p.name, bill_ref: o.ms == null ? 'Carried from last year' : (o.ref ? String(o.ref) : 'From entries'), bill_date: o.ms == null ? null : isoDay(billMs),
          due_date: isoDay(billMs + creditDays * DAY), closing_balance: Math.round(amt * 100) / 100, overdue_days: Math.max(0, Math.round((todayMs - billMs - creditDays * DAY) / DAY)), advance: false, from_entries: true });
        gap -= amt;
      }
      if (gap >= 1) extra.push({ direction: 'receivable', party_name: p.name, bill_ref: 'Carried from last year', bill_date: null, due_date: isoDay(fyStart),
        closing_balance: Math.round(gap * 100) / 100, overdue_days: Math.max(0, Math.round((todayMs - fyStart) / DAY)), advance: false, from_entries: true });
      summary.added.parties++; summary.added.amount += owed - billed;
    }
  }
  const out = [];
  for (const b of bills) {
    if (drop.has(b)) continue;
    out.push(changed.has(b) ? Object.assign({}, b, { closing_balance: Math.sign(num(b.closing_balance) || 1) * changed.get(b), part_paid: true }) : b);
  }
  summary.trimmed.amount = Math.round(summary.trimmed.amount); summary.added.amount = Math.round(summary.added.amount);
  return { bills: out.concat(extra), summary };
}

module.exports = { tieReceivables };
