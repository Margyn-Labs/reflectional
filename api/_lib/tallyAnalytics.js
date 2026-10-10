/**
 * Tally analytics — P&L, margin, customer economics, working capital, GST
 * estimate and data-quality checks, computed ONLY from what the Tally agent
 * already syncs (ledgers + vouchers + bills). No agent change needed.
 *
 * Pure: takes rows, returns one object. api/tally.js?action=analytics loads the
 * rows and calls computeAnalytics(); the app page, Margyn's context block and
 * the voice tools all read that one payload so they can never disagree.
 *
 * Everything here is provenance 'signal' (one ERP, no bank / GST corroboration
 * yet). Figures are labelled with how they were derived and how confident we
 * are; we never recompute Tally's own stock valuation.
 *
 * Sign conventions (see tallyClient.parseVouchers): voucher ledger entries are
 * negative = debit, positive = credit. Ledger closing balances arrive with an
 * uncertain sign, so balance-sheet figures use magnitudes.
 *
 * Stock lines (voucher.items) only exist once the agent is updated; every item
 * level output degrades to `items_available: false` until then.
 *
 * Lessons from building the connector (TALLY-CONNECTOR-HANDOFF.md) that shape
 * this file:
 *  - Real Tally returns an EMPTY closing balance for most balance-sheet ledgers
 *    (only P&L ledgers resolved), so stock and cash are never assumed present;
 *    cash is derived from vouchers when Tally gave no balance, stock is marked
 *    unavailable, and both are said out loud.
 *  - The Day Book also lists non-accounting vouchers (orders, delivery notes,
 *    memoranda, stock journals). Counting them would double-count sales.
 *  - The sign convention of ledger balances vs voucher amounts was never
 *    confirmed on a real credit balance. We infer it from the data and report
 *    how sure we are instead of assuming.
 *  - Names arrive with stray control characters and leading spaces; ledger
 *    matching ignores case, spacing and control characters.
 *  - Vouchers are never swept when deleted or edited in Tally (ledgers and bills
 *    are snapshots), so ledger tie-out is the drift detector.
 *  - Two active installs on one company would double every voucher: rows are
 *    de-duplicated on Tally's own GUID.
 *  - Phases 2 and 3 soft-fail in the agent, so the last sync outcome per kind is
 *    part of the confidence story.
 */

const { calibrateBills, todayIstMs } = require('./tallyBills');

/* ---------------- classification ---------------- */

// Ledger names arrive with control characters / stray spaces and Tally treats
// names case-insensitively, so compare on this key.
const nameKey = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Tally's standard primary groups and their common spellings.
const PARENT_RULES = [
  [/^salesaccounts?$/, 'sales'],
  [/^purchaseaccounts?$/, 'purchases'],
  [/^(directexpenses?|expensesdirect|directexpensescr)$/, 'direct_expense'],
  [/^(indirectexpenses?|expensesindirect|indirectexpensescr)$/, 'opex'],
  [/^(directincomes?|incomedirect|directincomesdr)$/, 'direct_income'],
  [/^(indirectincomes?|incomeindirect)$/, 'other_income'],
  [/^dutiesandtaxes$|^dutiestaxes$|^dutiestax$/, 'tax'],
  [/^sundrydebtors?$/, 'debtor'],
  [/^sundrycreditors?$/, 'creditor'],
  [/^bank(occ|od)/, 'bank_od'],
  [/^bankaccounts?$|^bank$/, 'bank'],
  [/^cashinhand$/, 'cash'],
  [/^stockinhand$/, 'stock'],
  [/^(fixedassets?|investments?|loansliability|loansandadvancesasset|loansadvancesasset|currentassets?|currentliabilities|currentliability|capitalaccount|reservessurplus|reservesandsurplus|suspenseac|suspenseaccount|securedloans?|unsecuredloans?|depositsasset|provisions?|miscexpensesasset|branchdivisions|retainedearnings|primary)$/, 'balance_sheet']
];

const PL_BUCKETS = ['sales', 'purchases', 'direct_expense', 'direct_income', 'opex', 'other_income'];

function bucketFromParent(parent) {
  const n = norm(parent);
  if (!n) return null;
  for (const [re, b] of PARENT_RULES) if (re.test(n)) return b;
  return null;
}

// Fallback for custom sub-groups / odd names. Always flagged "guessed".
function guessBucket(name, parent) {
  const p = String(parent || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  // People we owe or are owed by come first: "Sundry Creditors for Expenses" is a creditor group,
  // not an expense, and counting payments to them as running cost inflates opex.
  if (/creditor|\bpayables?\b/.test(p)) return 'creditor';
  if (/debtor|receivable/.test(p)) return 'debtor';
  if (/remuneration|salary|salaries|wages/.test(p)) return 'opex';
  if (/indirect\s*exp/.test(p)) return 'opex';
  if (/indirect\s*inc/.test(p)) return 'other_income';
  // (?<!in): "Indirect Expenses - Admin" contains "direct exp" but is a running cost, not a direct one.
  if (/(?<!in)direct\s*exp|expenses?\s*\(?direct/.test(p)) return 'direct_expense';
  if (/(?<!in)direct\s*inc|income\s*\(?direct/.test(p)) return 'direct_income';
  if (/expense|overhead|admin|\bcosts?\b/.test(p)) return 'opex';
  if (/income|revenue/.test(p)) return 'other_income';
  if (/sales/.test(p)) return 'sales';
  if (/purchase/.test(p)) return 'purchases';
  if (/debtor/.test(p)) return 'debtor';
  if (/creditor/.test(p)) return 'creditor';
  if (/bank/.test(p)) return 'bank';
  if (/tax|duties|gst/.test(p)) return 'tax';
  if (/\b(cgst|sgst|igst|utgst|gst|tds|tcs)\b/.test(n)) return 'tax';
  if (/\bsales?\b|\brevenue\b/.test(n)) return 'sales';
  if (/\bpurchases?\b/.test(n)) return 'purchases';
  if (/freight|carriage|cartage|packing|wages|manufactur|job\s*work|loading|unloading/.test(n)) return 'direct_expense';
  if (/salary|salaries|rent|electricity|travel|telephone|interest|depreciation|insurance|printing|stationery|repair|audit|legal|professional|commission|advertis|marketing|bank\s*charges|office|conveyance|overhead|admin|expense/.test(n)) return 'opex';
  return null;
}

/**
 * ledgers: [{name,parent}], overrides: { ledgerName: bucket }.
 * Returns Map name -> { bucket, confidence: 'confirmed'|'group'|'guessed'|'unknown' }.
 */
function classifyLedgers(ledgers, overrides, partyRoles) {
  const out = new Map();
  const ov = {};
  for (const k of Object.keys(overrides || {})) ov[nameKey(k)] = overrides[k];
  for (const l of ledgers || []) {
    if (!l || !l.name) continue;
    const key = nameKey(l.name);
    let c;
    if (ov[key]) c = { bucket: ov[key], confidence: 'confirmed' };
    else {
      // Tally's own answer first: the immediate group, then the primary group it rolls up to.
      const direct = bucketFromParent(l.parent) || bucketFromParent(l.primary_group);
      if (direct) c = { bucket: direct, confidence: 'group' };
      else {
        // Tally gives only the immediate parent, so a customer under a custom group ("PHARMA GIFTING")
        // looks unplaced. How the ledger is USED settles it: a party on a sale is a customer, on a purchase a vendor.
        const role = partyRoles && partyRoles.get(key);
        if (role) c = { bucket: role, confidence: 'inferred' };
        else {
          const g = guessBucket(l.name, l.parent);
          c = g ? { bucket: g, confidence: 'guessed' } : { bucket: 'unknown', confidence: 'unknown' };
        }
      }
    }
    out.set(key, c);
    out.set(l.name, c);
  }
  return out;
}

/* ---------------- small helpers ---------------- */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (k) => { const [y, m] = String(k).split('-'); return `${MON[(+m || 1) - 1]} ${y}`; };
const p1 = (n) => (Math.round(Number(n) * 10) / 10);
const pct = (a, b) => (b ? r2((a / b) * 100) : null);

function parseDate(d) {
  if (!d) return null;
  const s = String(d);
  const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t);
}
const monthKey = (dt) => dt.toISOString().slice(0, 7);
const DAY = 86400000;

// Day Book also lists vouchers with no accounting effect. Never count these.
const NON_ACCOUNTING = /\b(sales|purchase)\s*orders?\b|delivery\s*note|receipt\s*note|rejections?\s*(in|out)|memorandum|stock\s*journal|physical\s*stock|job\s*work|material\s*(in|out)|reversing\s*journal|manufacturing\s*journal|stock\s*transfer|attendance/i;
// Payroll is NOT here: Tally payroll vouchers post salaries to the books (2026-10-04). Attendance doesn't.
const isNonAccounting = (t) => NON_ACCOUNTING.test(t || '');
const isCreditNote = (t) => /credit\s*note|sales?\s*returns?/i.test(t || '');
const isDebitNote = (t) => /debit\s*note|purchases?\s*returns?/i.test(t || '');
// Voucher types are often renamed ("KANDIVALI SALE", "VASAI SALES"), so match sale or sales.
const isSalesType = (t) => /\bsales?\b/i.test(t || '') && !isCreditNote(t);
const isPurchaseType = (t) => /purchase/i.test(t || '') && !isDebitNote(t);
const normParty = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------------- de-duplication ---------------- */

// Two active installs on one company (two PCs, a re-pair that wasn't revoked)
// carry the same Tally GUIDs. Keep one row per real record.
function dedupe(rows, keyOf, prefer) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const k = keyOf(r);
    if (k == null) { seen.set(Symbol('nokey'), r); continue; }
    const cur = seen.get(k);
    if (!cur || (prefer && prefer(r, cur))) seen.set(k, r);
  }
  return [...seen.values()];
}

/* Which ledgers are customers and which are vendors, judged from how vouchers use them. */
function partyRolesFromVouchers(vouchers) {
  const tally = new Map();
  for (const v of vouchers || []) {
    if (!v || isNonAccounting(v.voucher_type)) continue;
    const t = v.voucher_type || '';
    const role = isSalesType(t) || isCreditNote(t) || /receipt/i.test(t) ? 'debtor'
      : isPurchaseType(t) || isDebitNote(t) || /payment/i.test(t) ? 'creditor' : null;
    if (!role) continue;
    const names = new Set();
    if (v.party_name) names.add(nameKey(v.party_name));
    for (const e of Array.isArray(v.entries) ? v.entries : []) if (e && e.is_party && e.ledger) names.add(nameKey(e.ledger));
    for (const k of names) {
      const r = tally.get(k) || { debtor: 0, creditor: 0 };
      r[role]++; tally.set(k, r);
    }
  }
  const out = new Map();
  for (const [k, r] of tally) if (r.debtor !== r.creditor) out.set(k, r.debtor > r.creditor ? 'debtor' : 'creditor');
  return out;
}

/* Item invoices hold the Sales / Purchase ledger line inside the stock lines, which older agents never sent.
   Every voucher balances to zero, so the missing line is exactly what is needed to balance it. */
const IMPLIED_SALES = '(Sales from item lines)';
const IMPLIED_PURCHASES = '(Purchases from item lines)';
function impliedEntry(v, entries) {
  const t = v.voucher_type || '';
  const sales = isSalesType(t) || isCreditNote(t), purch = isPurchaseType(t) || isDebitNote(t);
  if (!sales && !purch) return null;
  const sum = entries.reduce((a, e) => a + num(e.amount), 0);
  // Only a missing line (most of the invoice), never a rounding or stray few rupees.
  if (Math.abs(sum) <= Math.max(1, 0.05 * Math.abs(num(v.amount)))) return null;
  return { ledger: sales ? IMPLIED_SALES : IMPLIED_PURCHASES, amount: -sum, is_party: false, implied: true };
}

/* ---------------- the engine ---------------- */

/* ---------------- which period do Tally's balances cover? (2026-10-11) ---------------- */

/**
 * The agent asks Tally for ledger balances without dates, so Tally answers for whatever period is set on its
 * screen. Care Hygiene keeps two financial years in one company; with the screen on 2025-26 the "closing"
 * balances stopped at 31 Mar 2026 while the vouchers ran to October, and Margyn showed March's cash, loans and
 * customer balances as today's and failed 10 of 12 ledger tie-outs. Nobody has to tell us the period: every
 * ledger's closing less opening equals its entries over exactly that period, so the window (whole months, from
 * the first synced month or any 1 April) that the most ledgers tie to is the one Tally used.
 * Returns null when there are too few ledgers to be sure (then nothing changes), else
 * { from, to (UTC ms), from_idx, covers_all, sign ('same' | 'opposite'), tied, tested, tie:[per ledger] }.
 */
const _periodCache = new WeakMap();   // vouchers array -> { ledgers, out }
const monthIdx = (dt) => dt.getUTCFullYear() * 12 + dt.getUTCMonth();
const fyStartMs = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 3, 1); };
const dayIso = (ms) => new Date(ms).toISOString().slice(0, 10);
function countedOnce(vouchers) {
  const seen = new Set(), out = [];
  for (const v of vouchers || []) {
    if (!v || v.is_cancelled === true || isNonAccounting(v.voucher_base || v.voucher_type)) continue;
    if (v.tally_guid) { if (seen.has(v.tally_guid)) continue; seen.add(v.tally_guid); }
    const dt = parseDate(v.date);
    if (dt) out.push([v, dt]);
  }
  return out;
}
function balancePeriod(ledgers, vouchers) {
  if (!Array.isArray(vouchers) || !vouchers.length || !Array.isArray(ledgers)) return null;
  const hit = _periodCache.get(vouchers);
  if (hit && hit.ledgers === ledgers) return hit.out;
  const out = findBalancePeriod(ledgers, vouchers);
  _periodCache.set(vouchers, { ledgers, out });
  return out;
}
function findBalancePeriod(ledgers, vouchers) {
  const rows = countedOnce(vouchers);
  let lo = null, hi = null;
  for (const [, dt] of rows) { const i = monthIdx(dt); if (lo == null || i < lo) lo = i; if (hi == null || i > hi) hi = i; }
  if (lo == null) return null;
  const n = hi - lo + 1;
  if (n > 120) return null;
  const byLedger = new Map();   // nameKey -> movement per month
  for (const [v, dt] of rows) {
    const i = monthIdx(dt) - lo;
    for (const e of Array.isArray(v.entries) ? v.entries : []) {
      if (!e || !e.ledger) continue;
      const k = nameKey(e.ledger);
      let a = byLedger.get(k);
      if (!a) { a = new Float64Array(n); byLedger.set(k, a); }
      a[i] += num(e.amount);
    }
  }
  const seenL = new Set(), cand = [];
  for (const l of ledgers) {
    if (!l || !l.name || l.opening_balance == null || l.closing_balance == null) continue;
    const k = nameKey(l.name);
    if (seenL.has(k) || !byLedger.has(k)) continue;
    seenL.add(k);
    const m = byLedger.get(k), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + m[i];
    cand.push({ l, pre, delta: num(l.closing_balance) - num(l.opening_balance) });
  }
  if (cand.length < 5) return null;
  const starts = [0];
  for (let i = 1; i < n; i++) if ((lo + i) % 12 === 3) starts.push(i);
  const fits = (delta, mv) => Math.abs(delta - mv) <= Math.max(1, 0.0002 * Math.max(Math.abs(delta), Math.abs(mv)));
  let best = null, anyTie = 0;
  const scores = [];
  const tiedSomewhere = new Uint8Array(cand.length);
  for (const s of starts) {
    for (let e = s; e < n; e++) {
      let same = 0, opp = 0;
      for (let c = 0; c < cand.length; c++) {
        const mv = cand[c].pre[e + 1] - cand[c].pre[s];
        const a = fits(cand[c].delta, mv), b = fits(cand[c].delta, -mv);
        if (a) same++;
        if (b) opp++;
        if (a || b) tiedSomewhere[c] = 1;
      }
      const w = { s, e, score: Math.max(same, opp), sign: same >= opp ? 'same' : 'opposite' };
      scores.push(w);
      // Equal scores: the later end (nothing was entered in between), then the earlier start.
      if (!best || w.score > best.score || (w.score === best.score && (w.e > best.e || (w.e === best.e && w.s < best.s)))) best = w;
    }
  }
  for (let c = 0; c < cand.length; c++) anyTie += tiedSomewhere[c];
  const runner = scores.reduce((m, w) => (w.score < best.score && w.score > m ? w.score : m), 0);
  // Only on clear evidence: most of the ledgers that tie to any period tie to this one, well ahead of the next.
  if (best.score < 5 || best.score < 0.5 * anyTie || best.score - runner < Math.max(2, 0.1 * best.score)) return null;
  const sg = best.sign === 'same' ? 1 : -1;
  const tie = cand.map((c) => {
    const mv = c.pre[best.e + 1] - c.pre[best.s];
    return { ledger: c.l.name, vouchers_movement: r2(Math.abs(mv)), tally_movement: r2(Math.abs(c.delta)), ok: fits(c.delta, sg * mv) };
  });
  const y = (i) => Math.floor((lo + i) / 12), m = (i) => (lo + i) % 12;
  return {
    from: Date.UTC(y(best.s), m(best.s), 1), to: Date.UTC(y(best.e), m(best.e) + 1, 0),
    from_idx: best.s, covers_all: best.s === 0 && best.e === n - 1,
    sign: best.sign, tied: best.score, tested: cand.length, tie
  };
}

/**
 * Balances brought to today when Tally's period is not "first synced entry to today or later". Opening balances
 * move back to the first synced entry and closing balances forward to today (or back to today when the period
 * runs past it), using the synced entries, so every reader's "opening plus the entries is the closing" holds
 * again. Returns null when the period is unknown or already fits (the reading below, with its guard, is kept).
 */
function alignToToday(ledgers, vouchers, now) {
  const bp = balancePeriod(ledgers, vouchers);
  if (!bp) return null;
  const today = todayIstMs(now);
  if (bp.from_idx === 0 && bp.to >= today) return null;
  const sg = bp.sign === 'same' ? 1 : -1;
  const before = new Map(), after = new Map(), beyond = new Map();
  let carried = 0;
  for (const [v, dt] of countedOnce(vouchers)) {
    const t = dt.getTime();
    const into = t < bp.from ? before : t > bp.to && t <= today ? after : t > today && t <= bp.to ? beyond : null;
    if (!into) continue;
    if (into === after) carried++;
    for (const e of Array.isArray(v.entries) ? v.entries : []) {
      if (!e || !e.ledger) continue;
      const k = nameKey(e.ledger);
      into.set(k, (into.get(k) || 0) + num(e.amount));
    }
  }
  const past = [], future = [];
  for (const v of vouchers || []) {
    const d = v && parseDate(v.date);
    if (d && d.getTime() > today) future.push(v); else past.push(v);
  }
  // Balances that start at the first synced entry with nothing entered after them need nothing done.
  if (bp.from_idx === 0 && !carried && !future.length) return null;
  const adj = (ledgers || []).map((l) => {
    if (!l || !l.name) return l;
    const k = nameKey(l.name);
    const b = before.get(k) || 0, a = after.get(k) || 0, y = beyond.get(k) || 0;
    if (!b && !a && !y) return l;
    const o = Object.assign({}, l, { tally_opening_balance: l.opening_balance, tally_closing_balance: l.closing_balance });
    if (l.opening_balance != null && b) o.opening_balance = r2(num(l.opening_balance) - sg * b);
    if (l.closing_balance != null && (a || y)) o.closing_balance = r2(num(l.closing_balance) + sg * (a - y));
    if (y) o.future_entries_backed_out = r2(y);
    return o;
  });
  const rolled = bp.to < today && carried > 0;
  return {
    ledgers: adj, vouchers: past, future,
    guard: { decision: rolled ? 'rolled_forward' : 'backed_out', checked: 0, with_future: 0, to_today: 0, unclear: 0, ledgers: [] },
    balances: { from: dayIso(bp.from), to: dayIso(bp.to), sign: bp.sign, tied: bp.tied, tested: bp.tested, rolled_forward: rolled, carried_vouchers: carried, aligned: true, tie: bp.tie }
  };
}

/**
 * The books as of today (India date). Tally's closing balances take in every entry in the financial year,
 * including ones dated in the future: on 3 Oct Care Hygiene's accountant entered the Kotak loan EMIs for
 * Oct-Mar in advance, and Tally's bank balance dropped by all six (₹9.45 L) at once, so Margyn showed ₹4.38 L
 * of cash when the bank had about ₹13.8 L. Entries dated after today are taken out of the vouchers and backed
 * out of each ledger's closing balance. Tally's balances share the entries' sign ('same', the default); books whose
 * balances carry debit as positive while entries carry it as negative (Zoho, Odoo adapters: `balance_convention:
 * 'opposite'`) add the entries back instead.
 *
 * The tie-out guard (2026-10-07). Backing out assumes Tally's closing balances run to the end of the year. The
 * agent's ledger request sends no SVTODATE, so Tally uses the company's current period; if that period ends today,
 * the closing balances already leave the later entries out and backing them out again would overstate cash. So
 * for cash, bank, overdraft and loan ledgers that later entries touch, the opening balance plus the synced entries
 * up to today is compared with Tally's closing balance both ways. When the closing only ties WITHOUT the later
 * entries (and no ledger ties with them), nothing is backed out (`guard.decision: 'kept'`), and the books health
 * check raises it. opts.decision ('kept' | 'backed_out') applies a decision made earlier on the full books (the
 * Cash page summary reads only the later entries, so it can't run the guard itself).
 * Returns { ledgers, vouchers, future, guard } where future lists the entries waiting for their date.
 * When Tally's balances cover some other period than the synced entries, alignToToday (above) brings them to
 * today from the entries instead and `balances` says which period Tally used.
 */
function asOfToday(ledgers, vouchers, now, convention, opts) {
  const aligned = alignToToday(ledgers, vouchers, now);
  if (aligned) return aligned;
  const dir = convention === 'opposite' ? 1 : -1;
  const today = todayIstMs(now);
  const past = [], future = [];
  for (const v of vouchers || []) {
    const d = v && parseDate(v.date);
    if (d && d.getTime() > today) future.push(v); else past.push(v);
  }
  if (!future.length) return { ledgers: ledgers || [], vouchers: vouchers || [], future, guard: { decision: 'not_needed', checked: 0, ledgers: [] } };
  const move = new Map();
  for (const v of future) {
    if (v.is_cancelled === true) continue;
    for (const e of Array.isArray(v.entries) ? v.entries : []) {
      if (!e || !e.ledger) continue;
      const k = nameKey(e.ledger);
      move.set(k, (move.get(k) || 0) + num(e.amount));
    }
  }
  const guard = tieOutGuard(ledgers, past, move, convention);
  const forced = opts && (opts.decision === 'kept' || opts.decision === 'backed_out') ? opts.decision : null;
  if (forced) { guard.decision = forced; guard.forced = true; }
  if (guard.decision === 'kept') return { ledgers: ledgers || [], vouchers: past, future, guard };
  const adj = (ledgers || []).map((l) => {
    const m = l && l.closing_balance != null ? move.get(nameKey(l.name)) : null;
    return m ? Object.assign({}, l, { closing_balance: Math.round((num(l.closing_balance) + dir * m) * 100) / 100, future_entries_backed_out: Math.round(m * 100) / 100 }) : l;
  });
  return { ledgers: adj, vouchers: past, future, guard };
}

/* Cash, bank, overdraft and loan ledgers: the ones whose balances the later entries (EMIs) move. */
function guardLedger(l) {
  const b = bucketFromParent(l.primary_group) || bucketFromParent(l.parent);
  if (b === 'cash' || b === 'bank' || b === 'bank_od') return true;
  if (b && b !== 'balance_sheet') return false;
  const g = String(l.parent || '') + ' ' + String(l.primary_group || '');
  return /\b(loans?|o\.?\s?d|overdraft|cash\s*credit)\b/i.test(g) && !/advance|asset/i.test(g);
}

/**
 * Does each such ledger's closing balance include the later entries? opening + entries to today (+ later ones)
 * against Tally's closing, in the balances' own sign convention. Per ledger: 'with_future' (only ties with
 * them), 'to_today' (only ties without), 'either' (too small to tell), 'neither' (entries missing from the sync).
 * decision 'kept' only when none ties with the later entries and more tie to today than tie neither way.
 */
function tieOutGuard(ledgers, past, futureMove, convention) {
  const s = convention === 'opposite' ? -1 : 1;
  const cand = (ledgers || []).filter((l) => l && l.name && l.opening_balance != null && l.closing_balance != null && guardLedger(l) && Math.abs(futureMove.get(nameKey(l.name)) || 0) >= 1);
  const out = { decision: 'backed_out', checked: cand.length, with_future: 0, to_today: 0, unclear: 0, ledgers: [] };
  if (!cand.length) return out;
  const want = new Set(cand.map((l) => nameKey(l.name)));
  const pastMove = new Map(), seen = new Set();
  for (const v of past || []) {
    if (!v || v.is_cancelled === true || isNonAccounting(v.voucher_base || v.voucher_type)) continue;
    if (v.tally_guid) { if (seen.has(v.tally_guid)) continue; seen.add(v.tally_guid); }
    for (const e of Array.isArray(v.entries) ? v.entries : []) {
      if (!e || !e.ledger) continue;
      const k = nameKey(e.ledger);
      if (want.has(k)) pastMove.set(k, (pastMove.get(k) || 0) + num(e.amount));
    }
  }
  for (const l of cand) {
    const k = nameKey(l.name);
    const O = num(l.opening_balance), C = num(l.closing_balance), P = pastMove.get(k) || 0, F = futureMove.get(k) || 0;
    const tol = Math.max(2, 0.0005 * (Math.abs(O) + Math.abs(C)));
    const offWith = Math.abs(C - O - s * (P + F)), offToday = Math.abs(C - O - s * P);
    const fit = offWith <= tol && offToday > tol ? 'with_future' : offToday <= tol && offWith > tol ? 'to_today' : offWith <= tol ? 'either' : 'neither';
    if (fit === 'with_future') out.with_future++; else if (fit === 'to_today') out.to_today++; else if (fit === 'neither') out.unclear++;
    out.ledgers.push({ name: l.name, fit, later_entries: Math.round(F * 100) / 100, off_with_later: Math.round((C - O - s * (P + F)) * 100) / 100 });
  }
  // Only on clear evidence: no ledger ties with the later entries, and more tie to today than don't tie at all.
  if (out.to_today > 0 && out.with_future === 0 && out.to_today > out.unclear) out.decision = 'kept';
  return out;
}

function computeAnalytics(input) {
  const hint = input.balance_convention === 'same' || input.balance_convention === 'opposite' ? input.balance_convention : null;
  const today = asOfToday(input.ledgers, input.vouchers, input.now, hint);
  input = Object.assign({}, input, { ledgers: today.ledgers, vouchers: today.vouchers });
  const B = today.balances || null;   // the period Tally's balances covered, when it had to be worked out
  const ledgers = dedupe(input.ledgers || [], (l) => (l && l.name ? nameKey(l.name) : null),
    (a, b) => a.closing_balance != null && b.closing_balance == null);
  // A renamed voucher type ("KANDIVALI SALE") is judged by the base type Tally rolls it up to, when we have it.
  const allVouchers = dedupe(input.vouchers || [], (v) => (v && v.tally_guid ? 'g:' + v.tally_guid : null))
    .map((v) => (v && v.voucher_base ? Object.assign({}, v, { voucher_type_name: v.voucher_type, voucher_type: v.voucher_base }) : v));
  const calibrated = calibrateBills(input.bills || [], allVouchers, { now: input.now });
  const bills = dedupe(calibrated.bills, (b) => (b ? (b.direction || '') + '|' + nameKey(b.party_name) + '|' + nameKey(b.bill_ref) : null));
  const syncRuns = input.syncRuns || [];
  const diagnostics = input.diagnostics && typeof input.diagnostics === 'object' ? input.diagnostics : null;
  const edition = input.edition || null;
  const overrides = input.overrides || {};
  const now = input.now ? new Date(input.now) : new Date();
  const creditRate = input.creditRate != null ? input.creditRate : 0.12;

  const classes = classifyLedgers(ledgers, overrides, partyRolesFromVouchers(allVouchers));
  classes.set(nameKey(IMPLIED_SALES), { bucket: 'sales', confidence: 'group' });
  classes.set(nameKey(IMPLIED_PURCHASES), { bucket: 'purchases', confidence: 'group' });
  let impliedVouchers = 0;
  const cls = (name) => classes.get(name) || classes.get(nameKey(name)) || { bucket: 'unknown', confidence: 'unknown' };
  const display = new Map();   // nameKey -> first spelling seen, for output
  const nonParty = new Set();  // ledgers that appear as something other than a voucher's party

  // ----- walk vouchers once -----
  const accounting = allVouchers.filter((v) => v && !isNonAccounting(v.voucher_type));
  const excludedTypes = {};
  allVouchers.forEach((v) => { if (v && isNonAccounting(v.voucher_type)) excludedTypes[v.voucher_type] = (excludedTypes[v.voucher_type] || 0) + 1; });
  const vouchers = accounting;
  const live = accounting.filter((v) => v.is_cancelled !== true);
  const cancelled = accounting.filter((v) => v.is_cancelled === true);

  const months = {};       // 'YYYY-MM' -> bucket sums (signed so +ve = good for profit? no: raw P&L amounts)
  const M = (k) => months[k] || (months[k] = {
    sales: 0, sales_returns: 0, purchases: 0, direct_expense: 0, direct_income: 0, opex: 0, other_income: 0,
    discounts: 0, freight: 0, tax_out: 0, tax_in: 0, tds_tcs: 0, vouchers: 0
  });
  const ledgerMove = new Map();              // ledger -> signed movement (tie-out)
  const ledgerMoveFy = new Map();            // the same, this financial year only (where the money goes)
  const ledgerActivity = new Map();          // ledger -> { n, abs }
  const customers = new Map();               // norm -> row
  const C = (name) => {
    const k = normParty(name) || '(no party)';
    if (!customers.has(k)) customers.set(k, { party: name || '(no party)', sales: 0, returns: 0, sales_90d: 0, billed_90d: 0, cost: 0, cost_known: 0, vouchers: 0 });
    return customers.get(k);
  };
  let minD = null, maxD = null;
  const asOf = now;
  // Totals are for one financial year (April to March), the year of the latest entry: books that carry two
  // years in one Tally company used to be added together (Care Hygiene: 18 months shown as one figure).
  let lastMs = null;
  for (const v of live) { const d = parseDate(v.date); if (d && (lastMs == null || d.getTime() > lastMs)) lastMs = d.getTime(); }
  const fyFrom = lastMs == null ? null : fyStartMs(lastMs);
  let minFy = null;
  const cut90 = new Date(asOf.getTime() - 90 * DAY);
  const win = { sales: 0, purchases: 0, direct_expense: 0, direct_income: 0, returns: 0, billed: 0 };   // last 90d
  const bought30 = new Map();   // vendor -> purchases in the last 30 days (are suppliers tracked bill by bill?)
  const cut30 = new Date(asOf.getTime() - 30 * DAY);
  let salesNoParty = 0;

  const items = {};        // item -> agg
  const itemMonth = {};    // 'item|month' -> { sq, sv, pq, pv }
  let itemsAvailable = false;
  let salesVouchersTotal = 0, salesVouchersWithItems = 0;

  for (const v of live) {
    const dt = parseDate(v.date);
    if (!dt) continue;
    if (!minD || dt < minD) minD = dt;
    if (!maxD || dt > maxD) maxD = dt;
    const mk = monthKey(dt);
    const m = M(mk); m.vouchers++;
    const in90 = dt >= cut90;
    const inFy = fyFrom == null || dt.getTime() >= fyFrom;
    if (inFy && (!minFy || dt < minFy)) minFy = dt;
    const entries = Array.isArray(v.entries) ? v.entries : [];
    const partyName = v.party_name || (entries.find((e) => e.is_party) || {}).ledger || null;
    let voucherSales = 0, voucherReturns = 0, voucherTax = 0;

    const imp = impliedEntry(v, entries);
    if (imp) impliedVouchers++;
    for (const e of imp ? entries.concat([imp]) : entries) {
      const a = num(e.amount);
      const lk = nameKey(e.ledger);
      if (!e.implied) {
        if (!display.has(lk)) display.set(lk, e.ledger);
        if (!e.is_party) nonParty.add(lk);
        ledgerMove.set(lk, (ledgerMove.get(lk) || 0) + a);
        if (inFy) ledgerMoveFy.set(lk, (ledgerMoveFy.get(lk) || 0) + a);
        const act = ledgerActivity.get(lk) || { n: 0, abs: 0 };
        act.n++; act.abs += Math.abs(a); ledgerActivity.set(lk, act);
      }
      let { bucket } = cls(e.ledger);
      // A customer or vendor is never a P&L line, whatever its group name suggests.
      if (e.is_party && PL_BUCKETS.includes(bucket)) bucket = 'balance_sheet';
      const lname = String(e.ledger || '');
      switch (bucket) {
        case 'sales':
          if (a >= 0) { m.sales += a; voucherSales += a; if (in90) win.sales += a; }
          else { m.sales_returns += -a; voucherReturns += -a; if (in90) { win.returns += -a; } }
          break;
        case 'purchases': m.purchases += -a; if (in90) win.purchases += -a; if (dt >= cut30 && partyName && -a > 0) bought30.set(nameKey(partyName), (bought30.get(nameKey(partyName)) || 0) - a); break;
        case 'direct_expense': m.direct_expense += -a; if (in90) win.direct_expense += -a; break;
        case 'direct_income': m.direct_income += a; if (in90) win.direct_income += a; break;
        case 'opex': m.opex += -a; break;
        case 'other_income': m.other_income += a; break;
        case 'tax':
          if (/\b(tds|tcs)\b/i.test(lname)) m.tds_tcs += a;
          else voucherTax += a;
          if (/\b(tds|tcs)\b/i.test(lname)) { /* counted above */ }
          else if (/input/i.test(lname)) m.tax_in += -a;
          else if (/output/i.test(lname)) m.tax_out += a;
          else if (a >= 0) m.tax_out += a; else m.tax_in += -a;
          break;
        default: break;
      }
      if (PL_BUCKETS.includes(bucket)) {
        if (/discount/i.test(lname)) m.discounts += -a;
        if (/freight|carriage|cartage|transport|logistic|courier|delivery/i.test(lname) && (bucket === 'direct_expense' || bucket === 'opex' || bucket === 'purchases')) m.freight += -a;
      }
    }

    if (isSalesType(v.voucher_type) || isCreditNote(v.voucher_type)) {
      if (inFy || in90) {
        const c = C(partyName);
        if (inFy) { if (!partyName) salesNoParty++; c.sales += voucherSales; c.returns += voucherReturns; c.vouchers++; }
        // What the customer was billed, GST included: what they owe includes GST, so days-to-pay must too.
        if (in90) { c.sales_90d += voucherSales - voucherReturns; c.billed_90d += voucherSales - voucherReturns + voucherTax; win.billed += voucherSales - voucherReturns + voucherTax; }
      }
      if (isSalesType(v.voucher_type)) salesVouchersTotal++;
    }

    // ----- stock lines (only after the agent update) -----
    if (Array.isArray(v.items) && v.items.length) {
      itemsAvailable = true;
      const sign = isCreditNote(v.voucher_type) ? -1 : isDebitNote(v.voucher_type) ? -1 : 1;
      const isS = isSalesType(v.voucher_type) || isCreditNote(v.voucher_type);
      const isP = isPurchaseType(v.voucher_type) || isDebitNote(v.voucher_type);
      if (isSalesType(v.voucher_type)) salesVouchersWithItems++;
      if (isS || isP) {
        for (const it of v.items) {
          if (!it || !it.item) continue;
          const val = it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount));
          const qty = num(it.qty);
          const a = items[it.item] || (items[it.item] = { item: it.item, unit: it.unit || null, sold_qty: 0, sold_value: 0, purchased_qty: 0, purchased_value: 0, cost_qty: 0, cost_value: 0 });
          const im = itemMonth[it.item + '|' + mk] || (itemMonth[it.item + '|' + mk] = { item: it.item, month: mk, sq: 0, sv: 0, pq: 0, pv: 0 });
          if (isS) { if (inFy) { a.sold_qty += sign * qty; a.sold_value += sign * val; } im.sq += sign * qty; im.sv += sign * val; }
          else { if (inFy) { a.purchased_qty += sign * qty; a.purchased_value += sign * val; } a.cost_qty += sign * qty; a.cost_value += sign * val; im.pq += sign * qty; im.pv += sign * val; }
        }
      }
    }
  }

  // ----- monthly P&L rows -----
  const monthKeys = Object.keys(months).sort();
  const currentMonth = monthKey(asOf);
  const pnl = monthKeys.map((k) => {
    const m = months[k];
    const net_sales = m.sales - m.sales_returns;
    const cogs_pre_stock = m.purchases + m.direct_expense;
    const gross_pre = net_sales + m.direct_income - cogs_pre_stock;
    const net_pre = gross_pre + m.other_income - m.opex;
    return {
      month: k,
      provisional: k >= currentMonth,
      partial_start: k === monthKeys[0] && !!minD && minD.getUTCDate() > 7,
      gross_sales: r2(m.sales), sales_returns: r2(m.sales_returns), net_sales: r2(net_sales),
      purchases: r2(m.purchases), direct_expense: r2(m.direct_expense), direct_income: r2(m.direct_income),
      cogs_pre_stock: r2(cogs_pre_stock),
      gross_profit_pre_stock: r2(gross_pre), gross_margin_pct_pre_stock: pct(gross_pre, net_sales),
      opex: r2(m.opex), other_income: r2(m.other_income),
      net_profit_pre_stock: r2(net_pre), net_margin_pct_pre_stock: pct(net_pre, net_sales),
      vouchers: m.vouchers
    };
  });
  // A closed month whose running costs are far below the other months usually has salaries,
  // rent and the like not booked yet. Flag it so its profit isn't read as final.
  {
    const closedRows = pnl.filter((r) => !r.provisional && !r.partial_start && r.net_sales > 0);
    for (const r of closedRows) {
      const others = closedRows.filter((o) => o !== r).map((o) => o.opex).sort((a, b) => a - b);
      if (others.length < 2) continue;
      const median = others[Math.floor(others.length / 2)];
      if (median > 0 && r.opex < 0.4 * median) { r.costs_incomplete = true; r.typical_opex = r2(median); }
    }
  }

  // ----- balance sign convention (inferred, never assumed silently) -----
  // Voucher amounts: negative = debit. Ledger balances: Tally's own flat value,
  // whose sign was never confirmed on a real credit balance. Compare a P&L
  // ledger's voucher movement with its opening->closing change to see which way
  // the data actually runs.
  let sameW = 0, oppW = 0, samples = 0;
  for (const l of ledgers) {
    if (!PL_BUCKETS.includes(cls(l.name).bucket)) continue;
    if (l.closing_balance == null) continue;
    const mv = ledgerMove.get(nameKey(l.name));
    if (mv == null || Math.abs(mv) < 1) continue;
    const delta = num(l.closing_balance) - num(l.opening_balance);
    if (Math.abs(Math.abs(delta) - Math.abs(mv)) > Math.max(1, 0.005 * Math.abs(mv))) continue;
    samples++;
    if (Math.sign(delta) === Math.sign(mv)) sameW += Math.abs(mv); else oppW += Math.abs(mv);
  }
  let signConv = 'unknown';
  if (samples >= 2 && sameW >= 0.8 * (sameW + oppW)) signConv = 'same';
  else if (samples >= 2 && oppW >= 0.8 * (sameW + oppW)) signConv = 'opposite';
  // Not enough evidence: the books' own declaration (balance_convention), else the connector docs' prior
  // (balances carry debit as positive, vouchers debit as negative).
  const effConv = signConv === 'unknown' ? (hint || 'opposite') : signConv;
  const balance_sign = { convention: signConv, effective: effConv, assumed: signConv === 'unknown', declared: hint, evidence_ledgers: samples };
  const debitPositive = (bal) => (effConv === 'same' ? -num(bal) : num(bal));

  // ----- stock adjustment (period level) -----
  const stockLedgers = ledgers.filter((l) => cls(l.name).bucket === 'stock');
  const stockWithBalance = stockLedgers.filter((l) => l.closing_balance != null);
  let stock = { available: false, reason: stockLedgers.length ? 'balance_not_returned' : 'no_stock_ledger' };
  if (stockWithBalance.length) {
    const closing = stockWithBalance.reduce((s, l) => s + Math.abs(num(l.closing_balance)), 0);
    const opening = stockWithBalance.reduce((s, l) => s + Math.abs(num(l.opening_balance)), 0);
    stock = {
      available: closing > 0 || opening > 0,
      opening: r2(opening), closing: r2(closing), change: r2(closing - opening),
      confidence: 'low',
      note: 'Stock-in-hand ledger as held in Tally. If stock is not auto-valued in Tally this can lag real stock; treat margin after stock adjustment as indicative.'
    };
    if (!stock.available) stock.reason = 'zero_balance';
  }
  // Tally's stock value is as at the end of the period its balances cover; no entry moves it, so it can't be
  // carried forward. Its movement belongs to that period's margin and to no other.
  const stockStale = !!(B && B.rolled_forward);
  const fyFromIso = fyFrom == null ? null : dayIso(fyFrom);
  const stockInFy = stock.available && (!B || (!stockStale && B.from >= fyFromIso));
  if (stock.available && B) Object.assign(stock, { as_at: stockStale ? B.to : null, period_from: B.from, period_to: B.to, applies_to_period: stockInFy });

  // ----- cash: Tally's balance when it gave one, otherwise derived from vouchers -----
  // Sweep deposits count: the bank moves that money back into the current account on its own.
  const isSweep = (l) => /sweep/i.test(String(l.name || '')) && /deposit/i.test(String(l.parent || ''));
  const cashLedgers = ledgers.filter((l) => ['bank', 'cash'].includes(cls(l.name).bucket) || isSweep(l));
  // A derived balance needs a known opening balance. With neither a closing nor an
  // opening balance from Tally there is nothing honest to show, so cash is unavailable.
  let cashTotal = 0, cashDerived = 0, cashUnresolved = 0;
  for (const l of cashLedgers) {
    if (l.closing_balance != null) cashTotal += debitPositive(l.closing_balance);
    else if (l.opening_balance != null) {
      cashTotal += debitPositive(l.opening_balance) + (-(ledgerMove.get(nameKey(l.name)) || 0));
      cashDerived++;
    } else cashUnresolved++;
  }
  const cash = cashLedgers.length && !cashUnresolved ? { total: r2(cashTotal), ledgers: cashLedgers.length, derived_from_vouchers: cashDerived,
    note: cashDerived ? 'Tally returned no closing balance for ' + cashDerived + ' of these ledgers, so their balance is opening plus voucher movement.' : 'Closing balances as returned by Tally. Overdraft accounts excluded.' } : null;

  // ----- cash, day by day (2026-10-04) -----
  // Margyn's own saved readings only start when an account starts using Margyn, and a reading saved from wrong
  // data stays wrong (Care Hygiene's 3 Oct readings said ₹4.38 L). The books have the whole year, so walk back
  // from today's balance through every entry on the cash ledgers: the balance at the end of each day.
  let cash_history = null;
  if (cash) {
    const cashKeys = new Set(cashLedgers.map((l) => nameKey(l.name)));
    const dayMove = new Map();
    for (const v of accounting) {
      if (!v || v.is_cancelled === true) continue;
      const dt = parseDate(v.date);
      if (!dt) continue;
      let m = 0;
      // Voucher amounts are always debit-negative, whichever way ledger balances run: money in = -amount.
      for (const e of Array.isArray(v.entries) ? v.entries : []) if (e && e.ledger && cashKeys.has(nameKey(e.ledger))) m += -num(e.amount);
      if (m) { const k = dt.toISOString().slice(0, 10); dayMove.set(k, (dayMove.get(k) || 0) + m); }
    }
    const days = [...dayMove.keys()].sort();
    if (days.length) {
      const todayKey = new Date(todayIstMs(now)).toISOString().slice(0, 10);
      const pts = [];
      let bal = cashTotal, d = new Date(todayIstMs(now));
      const first = Date.parse(days[0] + 'T00:00:00Z') - DAY;
      // End-of-day balance for every day from the day before the first entry to today.
      while (d.getTime() >= first) {
        const k = d.toISOString().slice(0, 10);
        pts.push({ date: k, cash: r2(bal) });
        bal -= dayMove.get(k) || 0;
        d = new Date(d.getTime() - DAY);
      }
      pts.reverse();
      cash_history = { as_of: todayKey, basis: 'Today\'s cash in Tally, worked back through every entry on the bank and cash ledgers (end of each day).', points: pts };
    }
  }

  // How many balance-sheet ledgers came back with no balance at all (connector lesson).
  const BS = ['debtor', 'creditor', 'bank', 'bank_od', 'cash', 'stock', 'balance_sheet', 'tax'];
  const bsLedgers = ledgers.filter((l) => BS.includes(cls(l.name).bucket));
  const bsMissing = bsLedgers.filter((l) => l.closing_balance == null).length;

  const fyMonth = fyFromIso ? fyFromIso.slice(0, 7) : '';
  const inFyMonth = (k) => k >= fyMonth;
  const sumRows = (rows) => rows.reduce((a, r) => {
    a.net_sales += r.net_sales; a.gross_sales += r.gross_sales; a.returns += r.sales_returns;
    a.cogs += r.cogs_pre_stock; a.direct_income += r.direct_income; a.opex += r.opex; a.other_income += r.other_income;
    return a;
  }, { net_sales: 0, gross_sales: 0, returns: 0, cogs: 0, direct_income: 0, opex: 0, other_income: 0 });
  const tot = sumRows(pnl.filter((r) => inFyMonth(r.month)));
  const gross_pre_total = tot.net_sales + tot.direct_income - tot.cogs;
  const stockAdj = stockInFy ? stock.change : 0;
  const gross_adj_total = gross_pre_total + stockAdj;
  const period = {
    from: (minFy || minD) ? (minFy || minD).toISOString().slice(0, 10) : null,
    to: maxD ? maxD.toISOString().slice(0, 10) : null,
    gross_sales: r2(tot.gross_sales), sales_returns: r2(tot.returns), net_sales: r2(tot.net_sales),
    cogs_pre_stock: r2(tot.cogs),
    gross_profit_pre_stock: r2(gross_pre_total), gross_margin_pct_pre_stock: pct(gross_pre_total, tot.net_sales),
    gross_profit_after_stock: stockInFy ? r2(gross_adj_total) : null,
    gross_margin_pct_after_stock: stockInFy ? pct(gross_adj_total, tot.net_sales) : null,
    opex: r2(tot.opex), other_income: r2(tot.other_income),
    net_profit_after_stock: stockInFy ? r2(gross_adj_total + tot.other_income - tot.opex) : null,
    net_profit_pre_stock: r2(gross_pre_total + tot.other_income - tot.opex),
    net_margin_pct_after_stock: stockInFy ? pct(gross_adj_total + tot.other_income - tot.opex, tot.net_sales) : null
  };
  // Each financial year on its own (the page shows last year beside this one). Stock movement goes to the year
  // Tally's balances cover.
  const years = [];
  {
    const by = new Map();
    for (const r of pnl) { const k = dayIso(fyStartMs(Date.parse(r.month + '-01T00:00:00Z'))); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    for (const [k, rows] of [...by.entries()].sort()) {
      const t = sumRows(rows), y = +k.slice(0, 4);
      const gp = t.net_sales + t.direct_income - t.cogs;
      const hasStock = stock.available && (B ? B.from === k && B.to === (y + 1) + '-03-31' : k === fyFromIso);
      years.push({
        fy: y + '-' + String((y + 1) % 100).padStart(2, '0'), from: k, months: rows.length, current: k === fyFromIso,
        net_sales: r2(t.net_sales), cogs_pre_stock: r2(t.cogs), gross_profit_pre_stock: r2(gp), gross_margin_pct_pre_stock: pct(gp, t.net_sales),
        stock_change: hasStock ? stock.change : null,
        gross_margin_pct_after_stock: hasStock ? pct(gp + stock.change, t.net_sales) : null,
        opex: r2(t.opex), net_profit_pre_stock: r2(gp + t.other_income - t.opex),
        net_profit_after_stock: hasStock ? r2(gp + stock.change + t.other_income - t.opex) : null
      });
    }
  }

  // ----- cost structure (where the money goes) -----
  const expenseByLedger = new Map();
  for (const [lk, mv] of ledgerMoveFy) {
    const name = display.get(lk) || lk;
    const b = cls(name).bucket;
    if (b === 'opex' || b === 'direct_expense' || b === 'purchases') {
      const cur = expenseByLedger.get(lk) || { ledger: name, bucket: b, amount: 0 };
      cur.amount += -mv; expenseByLedger.set(lk, cur);
    }
  }
  const cost_structure = [...expenseByLedger.values()]
    .map((x) => ({ ledger: x.ledger, bucket: x.bucket, amount: r2(x.amount), pct_of_net_sales: pct(x.amount, tot.net_sales) }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount).slice(0, 15);

  // ----- receivables / payables from bills -----
  let recv = 0, pay = 0, recvOverdue = 0, custAdvances = 0, vendorAdvances = 0;
  const recvBy = new Map();
  for (const b of bills) {
    const bal = Math.abs(num(b.closing_balance));
    // A customer's on-account money (or a vendor paid ahead) is not a bill anyone owes: counting it as a
    // payable made supplier days look like 5 when the suppliers simply aren't tracked bill by bill.
    if (b.advance) { if (b.direction === 'payable') custAdvances += bal; else vendorAdvances += bal; continue; }
    if (b.direction === 'payable') { pay += bal; continue; }
    recv += bal;
    const od = num(b.overdue_days);
    if (od > 0) recvOverdue += bal;
    const k = normParty(b.party_name) || '(no party)';
    const r = recvBy.get(k) || { party: b.party_name, outstanding: 0, overdue: 0, max_overdue_days: 0, bills: 0 };
    r.outstanding += bal; r.bills++;
    if (od > 0) r.overdue += bal;
    if (od > r.max_overdue_days) r.max_overdue_days = od;
    recvBy.set(k, r);
  }

  // A margin of 175,000% means the sales side is missing (vouchers failed to sync), not that the business is
  // brilliant. Show nothing rather than nonsense, and say why.
  let implausible = false;
  for (const k of ['gross_margin_pct_pre_stock', 'gross_margin_pct_after_stock', 'net_margin_pct_after_stock']) {
    if (period[k] != null && Math.abs(period[k]) > 500) { period[k] = null; implausible = true; }
  }
  // ----- working capital -----
  const sales90 = win.sales - win.returns;
  const cogs90 = win.purchases + win.direct_expense;
  const stockVal = stock.available ? stock.closing : null;
  // Receivables and payables carry the whole history; sales and purchases only what was synced. With less than
  // about three months of vouchers the ratios compare unlike things, so say nothing rather than 768 days.
  const spanDays = minD && maxD ? Math.round((maxD - minD) / DAY) + 1 : 0;
  const shortHistory = spanDays < 80;
  // Days to get paid: what customers owe (GST included) against what they were billed (GST included) in 90 days.
  const billed90 = win.billed > 0 ? win.billed : sales90;
  let dso = billed90 > 0 && !shortHistory ? r2((recv / billed90) * 90) : null;
  if (dso != null && dso > 1825) { dso = null; implausible = true; }
  // Supplier days only mean something when supplier bills are kept bill by bill in Tally. A supplier bought from
  // in the last month almost always still has an open bill; if most of last month's purchases are from
  // suppliers with no open bill at all, Tally isn't tracking them and "you pay in 5 days" would be invented.
  const payParties = new Set(bills.filter((b) => b.direction === 'payable' && !b.advance && Math.abs(num(b.closing_balance)) > 0).map((b) => nameKey(b.party_name)));
  const b30 = [...bought30.values()].reduce((x, y) => x + y, 0);
  const covered30 = [...bought30.entries()].filter(([k]) => payParties.has(k)).reduce((x, [, v]) => x + v, 0);
  const suppliersTracked = b30 <= 0 ? null : covered30 / b30 >= 0.4;
  const dpo = win.purchases > 0 && !shortHistory && suppliersTracked !== false ? r2((pay / win.purchases) * 90) : null;
  // A stock value from the end of an earlier period says nothing about how many days of stock are held now.
  const dio = stockVal != null && cogs90 > 0 && !shortHistory && !stockStale ? r2((stockVal / cogs90) * 90) : null;
  const working_capital = {
    receivables: r2(recv), receivables_overdue: r2(recvOverdue), payables: r2(pay),
    customer_advances: r2(custAdvances), vendor_advances: r2(vendorAdvances),
    suppliers_tracked_billwise: suppliersTracked,
    stock_value: stockVal, stock_as_at: stock.as_at || null,
    billed_90d: r2(billed90),
    cash: cash ? cash.total : null,
    dso_days: dso, dpo_days: dpo, dio_days: dio,
    cash_conversion_days: dso != null && dio != null && dpo != null ? r2(dso + dio - dpo) : null,
    window_days: 90,
    note: 'DSO/DPO/DIO use the last 90 days of vouchers.'
  };

  // ----- gross margin proxy for party rows -----
  const coGm = period.gross_margin_pct_pre_stock;
  const carryPctOfSales = (dsoDays) => (dsoDays == null ? null : r2((dsoDays / 365) * creditRate * 100));

  // item-level economics
  // Kits and packs the business puts together itself are never purchased, so their cost lives in
  // Manufacturing Journals: one finished line worth exactly the components that went into it.
  const assembled = assemblyCosts(allVouchers);
  const itemRows = [];
  if (itemsAvailable) {
    for (const a of Object.values(items)) {
      if (!a.sold_qty && !a.sold_value && !a.purchased_qty && !a.purchased_value) continue;   // last year only
      const avg_price = a.sold_qty > 0 ? a.sold_value / a.sold_qty : null;
      const asm = assembled[a.item];
      const fromAssembly = !(a.cost_qty > 0) && asm && asm.qty > 0;
      // Cost per unit is the average over everything synced (last year's purchases still say what an item costs).
      const avg_cost = a.cost_qty > 0 ? a.cost_value / a.cost_qty : fromAssembly ? asm.value / asm.qty : null;
      const cogs = avg_cost != null ? a.sold_qty * avg_cost : null;
      const margin = cogs != null ? a.sold_value - cogs : null;
      const flags = [];
      if (fromAssembly) flags.push('cost_from_assembly');
      if (a.sold_qty > 0 && avg_cost == null) flags.push('no_purchase_cost_in_period');
      if (avg_price != null && avg_cost != null && avg_price < avg_cost) flags.push('sold_below_cost');
      if (a.sold_qty > a.purchased_qty && avg_cost != null) flags.push('sold_more_than_bought_in_period');
      itemRows.push({
        item: a.item, unit: a.unit,
        sold_qty: r2(a.sold_qty), sold_value: r2(a.sold_value), avg_price: avg_price != null ? r2(avg_price) : null,
        purchased_qty: r2(a.purchased_qty), purchased_value: r2(a.purchased_value), avg_cost: avg_cost != null ? r2(avg_cost) : null,
        est_margin: margin != null ? r2(margin) : null, est_margin_pct: margin != null ? pct(margin, a.sold_value) : null,
        net_qty_movement: r2(a.purchased_qty - a.sold_qty), flags
      });
    }
    itemRows.sort((x, y) => y.sold_value - x.sold_value);
  }

  // margin bridge between the two latest complete months that have item sales
  let margin_bridge = null;
  if (itemsAvailable) {
    const mset = [...new Set(Object.values(itemMonth).map((x) => x.month))].filter((k) => k < currentMonth).sort();
    if (mset.length >= 2) {
      const m0 = mset[mset.length - 2], m1 = mset[mset.length - 1];
      const overallCost = {};
      for (const a of Object.values(items)) overallCost[a.item] = a.cost_qty > 0 ? a.cost_value / a.cost_qty : null;
      const at = (item, mk) => itemMonth[item + '|' + mk] || { sq: 0, sv: 0, pq: 0, pv: 0 };
      let price = 0, cost = 0, volume = 0, m0tot = 0, m1tot = 0;
      for (const item of Object.keys(items)) {
        const a0 = at(item, m0), a1 = at(item, m1);
        if (a0.sq <= 0 && a1.sq <= 0) continue;
        const c0 = a0.pq > 0 ? a0.pv / a0.pq : overallCost[item];
        const c1 = a1.pq > 0 ? a1.pv / a1.pq : overallCost[item];
        if (c0 == null || c1 == null) continue;
        const p0 = a0.sq > 0 ? a0.sv / a0.sq : (a1.sq > 0 ? a1.sv / a1.sq : 0);
        const p1 = a1.sq > 0 ? a1.sv / a1.sq : p0;
        const q0 = a0.sq, q1 = a1.sq;
        price += q1 * (p1 - p0); cost += -q1 * (c1 - c0); volume += (q1 - q0) * (p0 - c0);
        m0tot += q0 * (p0 - c0); m1tot += q1 * (p1 - c1);
      }
      margin_bridge = { from_month: m0, to_month: m1, margin_from: r2(m0tot), margin_to: r2(m1tot), price_effect: r2(price), cost_effect: r2(cost), volume_mix_effect: r2(volume) };
    }
  }

  // customers table
  const customerRows = [];
  const keys = new Set([...customers.keys(), ...recvBy.keys()]);
  for (const k of keys) {
    const c = customers.get(k) || { party: (recvBy.get(k) || {}).party, sales: 0, returns: 0, sales_90d: 0, billed_90d: 0, vouchers: 0 };
    const r = recvBy.get(k) || { outstanding: 0, overdue: 0, max_overdue_days: 0 };
    const net = c.sales - c.returns;
    const b90 = c.billed_90d > 0 ? c.billed_90d : c.sales_90d;
    const dsoP = b90 > 0 ? r2((r.outstanding / b90) * 90) : null;
    const carry = carryPctOfSales(dsoP);
    const flags = [];
    if (r.outstanding > 0 && c.sales_90d <= 0) flags.push('owes_with_no_sales_in_90d');
    if (r.max_overdue_days > 90) flags.push('over_90_days');
    if (c.sales > 0 && c.returns / c.sales > 0.1) flags.push('high_returns');
    customerRows.push({
      party: c.party, gross_sales: r2(c.sales), returns: r2(c.returns), net_sales: r2(net),
      returns_pct: pct(c.returns, c.sales), sales_90d: r2(c.sales_90d), billed_90d: r2(c.billed_90d || 0),
      outstanding: r2(r.outstanding), overdue: r2(r.overdue), max_overdue_days: r.max_overdue_days,
      dso_days: dsoP, credit_cost_pct_of_sales: carry,
      margin_basis: 'company_average_pre_stock',
      est_margin_pct: coGm,
      est_margin_after_credit_pct: coGm != null && carry != null ? r2(coGm - carry) : null,
      flags
    });
  }
  customerRows.sort((a, b) => b.net_sales - a.net_sales);
  const customerTop = customerRows.slice(0, 50);
  const annualCarry = r2(recv * creditRate);

  // ----- leaks -----
  const sumMonths = (f) => pnl.reduce((s, r) => s + f(r), 0);
  const discounts = monthKeys.filter(inFyMonth).reduce((s, k) => s + months[k].discounts, 0);
  const freight = monthKeys.filter(inFyMonth).reduce((s, k) => s + months[k].freight, 0);
  const leaks = {
    returns: { value: r2(tot.returns), pct_of_gross_sales: pct(tot.returns, tot.gross_sales) },
    discounts_booked: { value: r2(discounts), pct_of_net_sales: pct(discounts, tot.net_sales) },
    freight_and_carriage: { value: r2(freight), pct_of_net_sales: pct(freight, tot.net_sales) },
    cancelled_vouchers: { count: cancelled.length, value: r2(cancelled.reduce((s, v) => s + Math.abs(num(v.amount)), 0)) },
    overdue_receivables: { value: r2(recvOverdue), pct_of_receivables: pct(recvOverdue, recv) },
    carrying_cost_of_receivables_annual: { value: annualCarry, rate_assumed: creditRate },
    items_sold_below_cost: itemRows.filter((i) => i.flags.includes('sold_below_cost')).map((i) => ({ item: i.item, avg_price: i.avg_price, avg_cost: i.avg_cost, sold_qty: i.sold_qty })).slice(0, 15),
    items_without_cost: itemRows.filter((i) => i.flags.includes('no_purchase_cost_in_period')).map((i) => ({ item: i.item, sold_value: i.sold_value })).slice(0, 15)
  };

  // ----- GST estimate from booked tax ledgers -----
  const gst = pnl.length ? monthKeys.map((k) => ({
    month: k, output_tax: r2(months[k].tax_out), input_tax: r2(months[k].tax_in), net_payable_estimate: r2(months[k].tax_out - months[k].tax_in), tds_tcs_net: r2(months[k].tds_tcs)
  })) : [];

  // ----- data quality + questions -----
  const questions = [];
  const unclassified = [];
  const guessed = [];
  for (const l of ledgers) {
    const c = cls(l.name);
    const act = ledgerActivity.get(nameKey(l.name));
    if (!act) continue;
    if (c.confidence === 'unknown') {
      unclassified.push({ ledger: l.name, parent: l.parent || null, vouchers: act.n, volume: r2(act.abs) });
    } else if (c.confidence === 'guessed') {
      guessed.push({ ledger: l.name, parent: l.parent || null, guessed_as: c.bucket, vouchers: act.n, volume: r2(act.abs) });
    }
  }
  const known = new Set(ledgers.map((l) => nameKey(l.name)));
  for (const [lk, act] of ledgerActivity) {
    if (!known.has(lk) && nonParty.has(lk)) unclassified.push({ ledger: display.get(lk) || lk, parent: null, vouchers: act.n, volume: r2(act.abs), not_in_ledger_list: true });
  }
  unclassified.sort((a, b) => b.volume - a.volume);
  guessed.sort((a, b) => b.volume - a.volume);
  for (const u of unclassified.slice(0, 10)) questions.push({ kind: 'classify_ledger', ledger: u.ledger, suggested: null, why: `Has ${u.vouchers} voucher lines (₹${Math.round(u.volume).toLocaleString('en-IN')}) but sits under “${u.parent || 'no group'}”, which I can't place in the P&L.` });
  for (const g of guessed.slice(0, 10)) questions.push({ kind: 'classify_ledger', ledger: g.ledger, suggested: g.guessed_as, why: `Group “${g.parent || 'none'}” is custom. I guessed ${g.guessed_as.replace('_', ' ')}. Confirm so the margin is right.` });
  if (!stock.available) questions.push({ kind: 'stock_missing', why: stock.reason === 'balance_not_returned' ? 'Tally sent the Stock-in-hand ledger but no balance for it (it often leaves balance-sheet ledgers empty), so gross margin is before stock movement. If you hold inventory, margin is overstated or understated by the change in stock.' : 'No stock balance is available, so gross margin is before stock movement. If you hold inventory, margin is overstated or understated by the change in stock.' });

  // tie-out: does the vouchers' movement on a P&L ledger match Tally's own opening→closing?
  // When the period of Tally's balances was worked out, the entries of that same period are what must match.
  const tie = B ? B.tie.filter((t) => PL_BUCKETS.includes(cls(t.ledger).bucket) && (t.vouchers_movement >= 1 || t.tally_movement >= 1)) : [];
  for (const l of B ? [] : ledgers) {
    const b = cls(l.name).bucket;
    if (!PL_BUCKETS.includes(b)) continue;
    if (!ledgerMove.has(nameKey(l.name))) continue;
    if (l.closing_balance == null) continue;
    const mv = Math.abs(ledgerMove.get(nameKey(l.name)));
    const d1 = Math.abs(num(l.closing_balance) - num(l.opening_balance));
    const d2 = Math.abs(num(l.closing_balance) + num(l.opening_balance));
    const tol = Math.max(1, 0.005 * Math.max(mv, d1));
    tie.push({ ledger: l.name, vouchers_movement: r2(mv), tally_movement: r2(d1), ok: Math.abs(mv - d1) <= tol || Math.abs(mv - d2) <= tol });
  }
  tie.sort((a, b) => b.vouchers_movement - a.vouchers_movement);
  const tieTop = tie.slice(0, 12);
  const tieBad = tieTop.filter((t) => !t.ok);
  for (const t of tieBad.slice(0, 3)) questions.push({ kind: 'tie_out_mismatch', ledger: t.ledger, why: `Vouchers add up to ₹${Math.round(t.vouchers_movement).toLocaleString('en-IN')} on “${t.ledger}” but Tally's own balance moved ₹${Math.round(t.tally_movement).toLocaleString('en-IN')}. Some vouchers may be missing from the synced range. Vouchers deleted or edited in Tally are not removed from Margyn\'s copy, which is the usual cause.` });
  for (const i of itemRows.filter((x) => x.flags.includes('no_purchase_cost_in_period')).slice(0, 5)) questions.push({ kind: 'item_no_cost', item: i.item, why: `“${i.item}” sold ₹${Math.round(i.sold_value).toLocaleString('en-IN')} but has no purchase in the period, so its margin can't be computed.` });

  // last sync outcome per kind (agent phases 2 and 3 soft-fail, so this matters)
  const lastRun = {};
  for (const r of syncRuns) {
    if (!r || !r.kind || r.kind === 'pair') continue;
    const t = Date.parse(r.started_at || r.finished_at || '') || 0;
    if (!lastRun[r.kind] || t > lastRun[r.kind]._t) lastRun[r.kind] = { kind: r.kind, status: r.status, error: r.error_message || null, at: r.started_at || r.finished_at || null, received: r.rows_received != null ? r.rows_received : null, _t: t };
  }
  const syncHealth = Object.values(lastRun).map(({ _t, ...x }) => x);
  const failedKinds = syncHealth.filter((x) => x.status === 'error');

  const reasons = [];
  const longDay = (iso) => { const [y, m, d] = String(iso).split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };
  // Connector plumbing (how Tally's export behaved) is for Margyn's team, not the owner's screen (2026-10-04).
  const internal = [];
  let level = 'medium';
  for (const f of failedKinds) reasons.push(`The last ${f.kind} sync from Tally failed${f.error ? ' (' + String(f.error).slice(0, 120) + ')' : ''}, so ${f.kind} may be behind.`);
  if (edition === 'educational') reasons.push('This Tally is in Educational mode, which limits voucher dates. Figures may not reflect a live business.');
  const excludedCount = Object.values(excludedTypes).reduce((a, b) => a + b, 0);
  if (balance_sign.assumed && !hint && ledgers.length) internal.push('The sign convention of Tally balances could not be confirmed from your data, so cash and stock use the documented default.');
  if (bsLedgers.length && bsMissing) internal.push(`Tally returned no balance for ${bsMissing} of ${bsLedgers.length} balance-sheet ledgers.`);
  if (!vouchers.length) { level = 'low'; reasons.push('No vouchers synced yet.'); }
  for (const r of pnl.filter((x) => x.costs_incomplete)) {
    reasons.push(`Running costs in ${r.month} (₹${Math.round(r.opex).toLocaleString('en-IN')}) are far below a usual month (about ₹${Math.round(r.typical_opex).toLocaleString('en-IN')}), so some expenses may not be booked yet. That month's profit will drop when they are.`);
  }
  if (calibrated.inverted) internal.push('Tally\'s bill signs ran the other way round for this company, so receivables and payables were swapped to match how your customers and vendors appear on vouchers.');
  // Completeness against Tally's OWN voucher count per month (agent 0.2.0+ reports it). This is the
  // proof the figures are whole: if every month matches, nothing was dropped between Tally and Margyn.
  const dm = diagnostics && diagnostics.vouchers && diagnostics.vouchers.months && typeof diagnostics.vouchers.months === 'object' ? diagnostics.vouchers.months : null;
  let completeness = null;
  if (dm) {
    const ks = Object.keys(dm).filter((k) => dm[k] && dm[k].tally != null).sort();
    const short = ks.filter((k) => dm[k].complete === false);
    const tallyTotal = ks.reduce((a, k) => a + (+dm[k].tally || 0), 0);
    const syncedTotal = ks.reduce((a, k) => a + (+dm[k].synced || 0), 0);
    completeness = { months: ks.length, tally_vouchers: tallyTotal, synced_vouchers: syncedTotal, short_months: short, strategy: diagnostics.vouchers.strategy || null };
    if (short.length) { level = 'low'; reasons.push(`Tally holds more vouchers than arrived in ${short.join(', ')} (${syncedTotal} of ${tallyTotal}). Margyn kept everything it has and will retry on the next sync.`); }
    const shown = ks.filter((k) => k <= currentMonth);
    if (!short.length && shown.length) reasons.push(`Every month from ${shown[0]} to ${shown[shown.length - 1]} matches Tally's own voucher count (${tallyTotal.toLocaleString('en-IN')} vouchers).`);
  }
  const agentOld = !diagnostics || !diagnostics.agent_version;
  // The agent reads one financial year, chosen from what Tally reports as its last voucher date. When Tally
  // reports a date in an earlier year (its screen left on last year), the agent reads that year and this
  // year's new entries stop arriving. The figures can't show what never arrived, so say it first.
  const agentPeriod = diagnostics && diagnostics.vouchers && diagnostics.vouchers.period && diagnostics.vouchers.period.to ? diagnostics.vouchers.period : null;
  const todayIso = dayIso(todayIstMs(now));
  const readingPastYear = !!(agentPeriod && String(agentPeriod.to).slice(0, 10) < todayIso && maxD && dayIso(maxD.getTime()) > String(agentPeriod.to).slice(0, 10));
  if (readingPastYear) {
    reasons.unshift(`Tally is sending Margyn last year's entries at the moment (${longDay(String(agentPeriod.from).slice(0, 10))} to ${longDay(String(agentPeriod.to).slice(0, 10))}). Entries made after ${longDay(dayIso(maxD.getTime()))} may not have arrived yet.`);
    internal.push(`Agent period ${agentPeriod.from} to ${agentPeriod.to} (source ${agentPeriod.source || '?'}) does not include today: new current-year vouchers are not syncing. Needs the agent's period fix (voucherSync.choosePeriod).`);
  }
  if (shortHistory && vouchers.length) reasons.push(`Only ${spanDays} days of vouchers are synced (${period.from} to ${period.to}), so days-to-pay and other ratios are hidden. ` +
    (agentOld ? 'The installed Margyn Tally agent reads only the current day from Tally; installing the latest agent sends the full financial year.' : 'The agent is fetching the rest of the year; this clears after the next sync.'));
  if (impliedVouchers) reasons.push(`${impliedVouchers} sales or purchase vouchers came without their Sales/Purchase ledger line (item invoices). Their amounts are the invoice total less tax. Updating the Margyn Tally agent sends the exact ledgers.`);
  if (implausible) { level = 'low'; reasons.push('Sales look far too small next to costs and receivables, so margin and days-to-pay are hidden. The voucher sync is probably incomplete.'); }
  if (unclassified.length) reasons.push(`${unclassified.length} ledger(s) with activity are unclassified.`);
  if (guessed.length) reasons.push(`${guessed.length} ledger(s) classified by guess, not by Tally group.`);
  if (tieBad.length) reasons.push(`${tieBad.length} of ${tieTop.length} largest P&L ledgers don't tie to Tally's own balance.`);
  if (!stock.available) reasons.push('No stock balance: margin is before stock movement.');
  if (B && B.rolled_forward) {
    reasons.push(`Tally's balances stop at ${longDay(B.to)}, so Margyn carried cash, bank, loans, customers and suppliers forward to today from the ${B.carried_vouchers.toLocaleString('en-IN')} entries made since.`);
    if (stock.available) reasons.push(`Tally's stock value is as at ${longDay(B.to)}, so this year's margin is before stock movement.`);
  }
  if (B) internal.push(`Tally's balances cover ${B.from} to ${B.to}: ${B.tied} of ${B.tested} ledgers with entries tie to that period (signs ${B.sign}).` + (B.rolled_forward ? ` Carried forward through ${B.carried_vouchers} vouchers.` : ''));
  if (years.length > 1) reasons.push(`Totals are for ${years[years.length - 1].fy} (from ${longDay(period.from)}). Earlier years are shown separately.`);
  {
    const counted = completeness ? Object.keys(dm).filter((k) => dm[k] && dm[k].tally != null) : [];
    const unchecked = counted.length ? monthKeys.filter((k) => k <= currentMonth && !counted.includes(k)) : [];
    if (unchecked.length) internal.push(`Tally's own voucher count has not been checked for ${unchecked[0]} to ${unchecked[unchecked.length - 1]} (its count follows the period on the Tally screen).`);
  }
  if (tieBad.length && agentOld) reasons.push('Vouchers deleted or edited in Tally stay in Margyn until the latest Margyn Tally agent is installed (it removes them automatically), which is the usual reason ledgers stop tying out.');
  if (!itemsAvailable) reasons.push('Stock lines not synced yet, so item-level margin is unavailable (agent update pending).');
  reasons.push('Single source (Tally). Not yet corroborated by bank or GST.');
  if (vouchers.length && !unclassified.length && !guessed.length && !tieBad.length && !failedKinds.length && !(completeness && completeness.short_months.length) && stock.available && tie.length >= 3 && tieTop.every((t) => t.ok)) level = 'high-for-a-single-source';
  else if (unclassified.length > 3 || tieBad.length > 2 || !vouchers.length || failedKinds.some((f) => f.kind === 'vouchers')) level = 'low';

  const quality = {
    confidence: level,
    reasons, internal,
    coverage: { from: period.from, to: period.to, vouchers: live.length, cancelled: cancelled.length, months: monthKeys.length },
    tally_completeness: completeness,
    agent_reading_past_year: readingPastYear ? { from: agentPeriod.from, to: agentPeriod.to } : null,
    unclassified_ledgers: unclassified.slice(0, 20),
    guessed_ledgers: guessed.slice(0, 20),
    tie_out: tieTop,
    balances_period: B ? { from: B.from, to: B.to, tied: B.tied, tested: B.tested, rolled_forward: B.rolled_forward, carried_vouchers: B.carried_vouchers } : null,
    balance_sign,
    balance_sheet_balances: { missing: bsMissing, total: bsLedgers.length },
    excluded_non_accounting_vouchers: { count: excludedCount, by_type: excludedTypes },
    sync: syncHealth,
    sales_vouchers_without_party: salesNoParty,
    sales_vouchers_without_items: itemsAvailable ? Math.max(0, salesVouchersTotal - salesVouchersWithItems) : null,
    current_month_provisional: currentMonth
  };

  // ----- deterministic headlines (the model only narrates these) -----
  const headlines = [];
  // A month whose running costs aren't booked yet would read as a jump in margin, so compare only complete months.
  const closed = pnl.filter((r) => !r.provisional && !r.partial_start && !r.costs_incomplete && r.net_sales > 0);
  const unbooked = pnl.filter((r) => r.costs_incomplete).slice(-1)[0];
  if (unbooked) headlines.push(`${monthLabel(unbooked.month)} looks unfinished in Tally: running costs are ₹${Math.round(unbooked.opex).toLocaleString('en-IN')} against a usual ₹${Math.round(unbooked.typical_opex).toLocaleString('en-IN')}, so its profit will fall once salaries and other costs are booked.`);
  if (closed.length >= 2) {
    const a = closed[closed.length - 2], b = closed[closed.length - 1];
    if (a.gross_margin_pct_pre_stock != null && b.gross_margin_pct_pre_stock != null) {
      const d = p1(b.gross_margin_pct_pre_stock - a.gross_margin_pct_pre_stock);
      headlines.push(`Gross margin (before stock movement) was ${p1(b.gross_margin_pct_pre_stock)}% in ${monthLabel(b.month)}, ${d >= 0 ? 'up' : 'down'} ${Math.abs(d)} points from ${p1(a.gross_margin_pct_pre_stock)}% in ${monthLabel(a.month)}.`);
    }
    const sd = pct(b.net_sales - a.net_sales, a.net_sales);
    if (sd != null) headlines.push(`Net sales ${b.net_sales >= a.net_sales ? 'rose' : 'fell'} ${p1(Math.abs(sd))}% from ${monthLabel(a.month)} to ${monthLabel(b.month)}.`);
  }
  if (period.gross_margin_pct_after_stock != null) headlines.push(`Gross margin for ${years.length > 1 ? 'this financial year' : 'the whole period'}, after stock movement, is ${p1(period.gross_margin_pct_after_stock)}% (indicative).`);
  if (leaks.returns.pct_of_gross_sales > 2) headlines.push(`Returns and credit notes are ${p1(leaks.returns.pct_of_gross_sales)}% of gross sales.`);
  if (dso != null) headlines.push(`Customers take about ${Math.round(dso)} days to pay on the last 90 days of sales. Carrying ₹${Math.round(recv).toLocaleString('en-IN')} owed to you at ${Math.round(creditRate * 100)}% costs about ₹${Math.round(annualCarry).toLocaleString('en-IN')} a year.`);
  if (margin_bridge) headlines.push(`Item margin moved ₹${Math.round(margin_bridge.margin_to - margin_bridge.margin_from).toLocaleString('en-IN')} from ${monthLabel(margin_bridge.from_month)} to ${monthLabel(margin_bridge.to_month)}: selling price ${Math.round(margin_bridge.price_effect).toLocaleString('en-IN')}, purchase cost ${Math.round(margin_bridge.cost_effect).toLocaleString('en-IN')}, volume and mix ${Math.round(margin_bridge.volume_mix_effect).toLocaleString('en-IN')}.`);
  if (leaks.items_sold_below_cost.length) headlines.push(`${leaks.items_sold_below_cost.length} item(s) sold below their average purchase cost.`);

  return {
    provenance: 'signal',
    basis: 'Tally ledgers, vouchers and bills. One source; not yet corroborated by bank or GST. Sales figures exclude GST.',
    as_of: asOf.toISOString(),
    items_available: itemsAvailable,
    period, years, pnl, stock, cash, cost_structure,
    working_capital, customers: customerTop, cash_history,
    // Entries already in Tally for a later date (EMIs, post-dated cheques): not in today's figures.
    entered_ahead: today.future.length ? {
      count: today.future.length,
      first: today.future.map((v) => v.date).sort()[0], last: today.future.map((v) => v.date).sort().slice(-1)[0],
      items: today.future.slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).slice(0, 24)
        .map((v) => ({ date: v.date, type: v.voucher_type, number: v.voucher_number || null, party: v.party_name || null, amount: r2(Math.abs(num(v.amount))), narration: v.narration ? String(v.narration).slice(0, 80) : null })),
      // Whether Tally's balances already left them out (asOfToday's tie-out guard): 'kept' = not backed out again.
      guard: { decision: today.guard.decision, checked: today.guard.checked, with_future: today.guard.with_future || 0, to_today: today.guard.to_today || 0 }
    } : null,
    items: itemRows.slice(0, 100), margin_bridge,
    leaks, gst_estimate: gst, quality, questions, headlines,
    assumptions: { credit_rate_annual: creditRate, margin_window: 'period', dso_window_days: 90 }
  };
}

/**
 * What customers owe, once their bills are lined up with their ledger balances (billTieOut.js): the same
 * figure the Receivables page shows. Days to get paid, the cost of waiting and each customer's row used to
 * stay on Tally's raw bill list (Care Hygiene: ₹9.95 Cr and 122 days beside a card saying ₹5.66 Cr).
 * `tiedBills` are the receivable bills after the tie. Changes `out` in place.
 */
function applyTiedReceivables(out, tiedBills) {
  const wc = out.working_capital || {}, rate = (out.assumptions || {}).credit_rate_annual || 0.12;
  const by = new Map();
  let recv = 0, overdue = 0;
  for (const b of tiedBills || []) {
    if (!b || b.direction === 'payable' || b.advance) continue;
    const bal = Math.abs(num(b.closing_balance)), od = num(b.overdue_days);
    recv += bal; if (od > 0) overdue += bal;
    const k = normParty(b.party_name) || '(no party)';
    const r = by.get(k) || { party: b.party_name, outstanding: 0, overdue: 0, max_overdue_days: 0 };
    r.outstanding += bal; if (od > 0) r.overdue += bal; if (od > r.max_overdue_days) r.max_overdue_days = od;
    by.set(k, r);
  }
  const hadDso = wc.dso_days != null;
  if (hadDso && wc.billed_90d > 0) {
    wc.dso_days = r2((recv / wc.billed_90d) * 90);
    wc.cash_conversion_days = wc.dio_days != null && wc.dpo_days != null ? r2(wc.dso_days + wc.dio_days - wc.dpo_days) : null;
  }
  const carry = r2(recv * rate);
  if (out.leaks) {
    out.leaks.overdue_receivables = { value: r2(overdue), pct_of_receivables: pct(overdue, recv) };
    out.leaks.carrying_cost_of_receivables_annual = { value: carry, rate_assumed: rate };
  }
  const seen = new Set();
  for (const c of out.customers || []) {
    const k = normParty(c.party) || '(no party)';
    seen.add(k);
    const r = by.get(k) || { outstanding: 0, overdue: 0, max_overdue_days: 0 };
    const b90 = c.billed_90d > 0 ? c.billed_90d : c.sales_90d;
    c.outstanding = r2(r.outstanding); c.overdue = r2(r.overdue); c.max_overdue_days = r.max_overdue_days;
    c.dso_days = b90 > 0 ? r2((r.outstanding / b90) * 90) : null;
    c.credit_cost_pct_of_sales = c.dso_days == null ? null : r2((c.dso_days / 365) * rate * 100);
    c.est_margin_after_credit_pct = c.est_margin_pct != null && c.credit_cost_pct_of_sales != null ? r2(c.est_margin_pct - c.credit_cost_pct_of_sales) : null;
    c.flags = (c.flags || []).filter((f) => f !== 'owes_with_no_sales_in_90d' && f !== 'over_90_days');
    if (r.outstanding > 0 && !(c.sales_90d > 0)) c.flags.push('owes_with_no_sales_in_90d');
    if (r.max_overdue_days > 90) c.flags.push('over_90_days');
  }
  if (Array.isArray(out.headlines)) {
    const i = out.headlines.findIndex((h) => /^Customers take about \d+ days to pay/.test(h));
    const line = wc.dso_days != null ? `Customers take about ${Math.round(wc.dso_days)} days to pay on the last 90 days of sales. Carrying ₹${Math.round(recv).toLocaleString('en-IN')} owed to you at ${Math.round(rate * 100)}% costs about ₹${Math.round(carry).toLocaleString('en-IN')} a year.` : null;
    if (i >= 0) { if (line) out.headlines[i] = line; else out.headlines.splice(i, 1); }
  }
  return { receivables: r2(recv), overdue: r2(overdue) };
}

/* Manufacturing Journals: the finished item's line is worth what its components cost (Tally values it that
   way), so cost per unit = that value / quantity made. A line moving one item to itself (a repack between
   godowns) says nothing about cost and is skipped. */
function assemblyCosts(vouchers) {
  const out = {};
  for (const v of vouchers || []) {
    if (!v || v.is_cancelled === true || !/manufactur/i.test(v.voucher_type || '') || !Array.isArray(v.items)) continue;
    const lines = v.items.filter((it) => it && it.item);
    if (lines.length < 2) continue;
    const val = (it) => (it.abs_amount != null ? num(it.abs_amount) : Math.abs(num(it.amount)));
    const total = lines.reduce((t, it) => t + val(it), 0);
    // The finished line is the one equal to the sum of all the others.
    const made = lines.find((it) => val(it) > 0 && Math.abs(val(it) - (total - val(it))) <= Math.max(1, 0.02 * val(it)));
    if (!made) continue;
    const parts = lines.filter((it) => it !== made);
    if (parts.every((it) => nameKey(it.item) === nameKey(made.item))) continue;
    const a = out[made.item] || (out[made.item] = { item: made.item, qty: 0, value: 0, value_without_qty: 0, batches: 0, components: {} });
    a.batches++;
    if (num(made.qty) > 0) { a.qty += num(made.qty); a.value += val(made); } else a.value_without_qty += val(made);
    for (const it of parts) {
      const c = a.components[it.item] || (a.components[it.item] = { item: it.item, qty: 0, value: 0 });
      c.qty += num(it.qty); c.value += val(it);
    }
  }
  return out;
}

module.exports = {
  computeAnalytics, asOfToday, balancePeriod, applyTiedReceivables, classifyLedgers, nameKey, dedupe, bucketFromParent, guessBucket, PL_BUCKETS,
  // shared with booksEngine.js so a question answered in chat counts exactly the way the Margin page does
  partyRolesFromVouchers, impliedEntry, assemblyCosts, parseDate, monthKey, normParty,
  isNonAccounting, isCreditNote, isDebitNote, isSalesType, isPurchaseType, IMPLIED_SALES, IMPLIED_PURCHASES
};
