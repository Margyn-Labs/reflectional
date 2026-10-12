/**
 * _lib/dataCompleteness.js
 * Is everything the books system sent us in Margyn, and is it being used? (2026-10-04)
 *
 * Four stages, each checked against the stage before it:
 *   1. Sent      what the Tally agent says Tally holds (its own per-month voucher count, ledgers and bills it read)
 *   2. Stored    what is in the database
 *   3. Read      what the readers load (row caps) and what they set aside (cancelled, orders, dated later...)
 *   4. Used      what lands in the figures (ledgers placed in the P&L / balance sheet, bills that tie to balances)
 *
 * Pure: takes the book (tallyData.loadTallyBook) and its booksEngine ctx (prepare()), returns plain data.
 * Summaries only (counts, totals, names of voucher types and months): never rows of the books.
 * CommonJS, zero-npm.
 */

const A = require('./tallyAnalytics');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(num(n));
const monthOf = (d) => { const dt = A.parseDate(d); return dt ? dt.toISOString().slice(0, 7) : null; };

function check(key, label, status, detail, extra) {
  return Object.assign({ key, label, status, detail }, extra || {});
}

function tallyCompleteness(book, ctx, opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const diag = book.diagnostics || null;
  const checks = [];
  const vouchersRaw = book.vouchers || [];
  const ledgersRaw = book.ledgers || [];
  const billsRaw = book.bills || [];

  /* ---- 1 → 2: Tally's own counts against what is stored ---- */
  const dm = diag && diag.vouchers && diag.vouchers.months && typeof diag.vouchers.months === 'object' ? diag.vouchers.months : null;
  const storedByMonth = {};
  for (const v of vouchersRaw) {
    if (!v || v.is_cancelled === true) continue;
    const m = monthOf(v.date);
    if (m) storedByMonth[m] = (storedByMonth[m] || 0) + 1;
  }
  const months = [];
  if (dm) {
    for (const k of Object.keys(dm).sort()) {
      const t = dm[k] && dm[k].tally != null ? +dm[k].tally : null;
      months.push({ month: k, tally: t, stored: storedByMonth[k] || 0, agent_sent: dm[k] ? dm[k].synced : null });
    }
  }
  const shortMonths = months.filter((m) => m.tally != null && m.stored < m.tally);
  if (!diag) checks.push(check('agent_report', 'Tally’s own count', 'warn', 'The Tally agent hasn’t sent its report yet, so Margyn can’t compare with what Tally holds.'));
  else if (!dm || !months.length) checks.push(check('agent_report', 'Tally’s own count', 'warn', 'The agent’s last report had no month-by-month voucher count from Tally (it sends one on each full pass, at most every 20 hours).', { reported_at: diag.at || null }));
  else {
    const tTot = months.reduce((a, m) => a + (m.tally || 0), 0), sTot = months.reduce((a, m) => a + m.stored, 0);
    checks.push(check('vouchers_sent', 'Vouchers: Tally → Margyn', shortMonths.length ? 'warn' : 'ok',
      shortMonths.length
        ? `Tally holds more vouchers than Margyn has in ${shortMonths.map((m) => m.month).join(', ')} (${shortMonths.reduce((a, m) => a + m.tally - m.stored, 0)} missing). The next full sync retries.`
        : sTot === tTot
          ? `Every month matches Tally’s own count: ${sTot.toLocaleString('en-IN')} vouchers (${months[0].month} to ${months[months.length - 1].month}).`
          : `No month is short of Tally’s own count: ${sTot.toLocaleString('en-IN')} stored, ${tTot.toLocaleString('en-IN')} in Tally’s own count from its last full read (${months[0].month} to ${months[months.length - 1].month}).`,
      { reported_at: (diag.kept_from && diag.kept_from.vouchers) || diag.at || null }));
    if (diag.kept_from && diag.kept_from.vouchers) checks[checks.length - 1].detail += ` (Tally's count is from the last full sync, ${String(diag.kept_from.vouchers).slice(0, 10)}; the latest sync stopped early.)`;
  }
  const errs = diag && diag.errors && typeof diag.errors === 'object' ? Object.entries(diag.errors).filter(([, v]) => v) : [];
  if (errs.length) checks.push(check('agent_errors', 'Agent errors on the last sync', 'warn', errs.map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join(' · ')));

  const ledRecv = diag && diag.ledgers && diag.ledgers.received != null ? +diag.ledgers.received : null;
  checks.push(check('ledgers_sent', 'Ledgers: Tally → Margyn', ledRecv == null ? 'info' : ledgersRaw.length >= ledRecv ? 'ok' : 'warn',
    ledRecv == null ? `${ledgersRaw.length.toLocaleString('en-IN')} ledgers stored (the agent didn’t report how many it read).`
      : ledgersRaw.length >= ledRecv ? `All ${ledRecv.toLocaleString('en-IN')} ledgers Tally sent are stored.`
      : `Tally sent ${ledRecv.toLocaleString('en-IN')} ledgers; ${ledgersRaw.length.toLocaleString('en-IN')} are stored.`));

  const bd = diag && diag.bills && typeof diag.bills === 'object' ? diag.bills : null;
  const billSent = bd ? ['receivable', 'payable'].reduce((a, k) => a + (Number.isFinite(+bd[k]) ? +bd[k] : 0), 0) : null;
  const unspecified = billsRaw.filter((b) => !b.bill_ref || b.bill_ref === '(unspecified)').length;
  checks.push(check('bills_sent', 'Open bills: Tally → Margyn', billSent == null ? 'info' : 'ok',
    (billSent == null ? '' : `Tally’s two outstanding reports returned ${billSent.toLocaleString('en-IN')} lines (they overlap); `) +
    `${billsRaw.length.toLocaleString('en-IN')} open bills stored` + (unspecified ? `, ${unspecified} without a bill reference` : '') + '.'));

  /* ---- 2 → 3: read caps ---- */
  const caps = book.caps || { vouchers: { cap: 20000, truncated: !!book.truncated } };
  const hit = Object.entries(caps).filter(([, c]) => c && c.truncated);
  checks.push(check('read_caps', 'Everything stored is read', hit.length ? 'warn' : 'ok',
    hit.length ? `Readers stop at ${hit.map(([k, c]) => `${c.cap.toLocaleString('en-IN')} ${k}`).join(', ')}, and this book has more.`
      : `All ${vouchersRaw.length.toLocaleString('en-IN')} vouchers, ${ledgersRaw.length.toLocaleString('en-IN')} ledgers and ${billsRaw.length.toLocaleString('en-IN')} bills are read.`));

  /* ---- 3: what is set aside, and why ---- */
  const excluded = [];
  const add = (reason, type, n) => { const e = excluded.find((x) => x.reason === reason && x.type === type); if (e) e.count += n; else excluded.push({ reason, type, count: n }); };
  const seen = new Set();
  let dup = 0, noDate = 0, noEntries = 0;
  const todayKey = now.toISOString().slice(0, 10);
  for (const v of vouchersRaw) {
    const g = v && v.tally_guid ? 'g:' + v.tally_guid : null;
    if (g && seen.has(g)) { dup++; continue; }
    if (g) seen.add(g);
    const type = v.voucher_base || v.voucher_type || 'Unknown';
    if (v.is_cancelled === true) { add('cancelled in Tally', v.voucher_type || type, 1); continue; }
    if (A.isNonAccounting(type)) { add('not an accounting entry (orders, notes, stock)', v.voucher_type || type, 1); continue; }
    const dt = A.parseDate(v.date);
    if (!dt) { noDate++; continue; }
    if (dt.toISOString().slice(0, 10) > todayKey) { add('dated after today (waits for its date)', v.voucher_type || type, 1); continue; }
    if (!Array.isArray(v.entries) || !v.entries.length) noEntries++;
  }
  if (dup) add('the same voucher twice', '—', dup);
  if (noDate) add('no readable date', '—', noDate);
  // Anything set aside that posts real amounts (payroll posts salaries) would be a hole in the figures.
  const realMoney = excluded.filter((e) => e.reason !== 'cancelled in Tally' && /payroll/i.test(e.type));
  checks.push(check('set_aside', 'Vouchers set aside', realMoney.length ? 'warn' : 'info',
    excluded.length ? excluded.map((e) => `${e.count} ${e.type} (${e.reason})`).join(' · ') : 'None.'));
  if (noEntries) checks.push(check('no_entries', 'Vouchers without ledger lines', 'warn', `${noEntries} vouchers arrived without their ledger lines, so they can’t count in profit or balances.`));

  /* ---- 3 → 4: used in the figures ---- */
  // Ledger balances Tally left blank: a blank closing balance is a zero balance unless the ledger moved.
  // Same reading of Tally's balance direction as the forecast (cashFlowModel.balanceSign).
  const bs = ((ctx.analytics || {}).quality || {}).balance_sign || {};
  const eff = bs.effective || (!bs.convention || bs.convention === 'unknown' ? 'opposite' : bs.convention);
  const debitPos = (b) => (eff === 'same' ? -num(b) : num(b));
  const moveBy = new Map();
  // This check reads the ledgers as stored (a blank balance has opening 0), so only this balance period's entries
  // belong in it, and a ledger kept only for an older year's history has no balance by design. With every year's
  // entries it flagged 51 Care Hygiene ledgers (₹3.47 Cr) on 12 Oct 2026; none had a single entry this year
  // (checked on the rows: last year's depreciation, bonus, customers who cleared their balance last year).
  // This is ONLY for this check: the balances Margyn shows (cashFlowModel.partyBalancesToday) use every year.
  // The period start: where the current year's Tally file begins (book.files), else the balance period analytics found.
  const curFile = book.files && Array.isArray(book.files.files) && book.files.files.length > 1 ? book.files.files.find((f) => f && f.name === book.files.current) : null;
  const bpFrom = (curFile && /^\d{4}-\d{2}-\d{2}$/.test(String(curFile.from || '')) ? curFile.from : null) || (((ctx.analytics || {}).quality || {}).balances_period || {}).from || null;
  for (const r of ctx.rows || []) { if (bpFrom && r.day < bpFrom) continue; for (const l of r.lines) { const k = A.nameKey(l.ledger); moveBy.set(k, (moveBy.get(k) || 0) + l.amount); } }
  let blank = 0, blankMoved = 0, blankMovedAmt = 0;
  for (const l of ledgersRaw) {
    if (l.closing_balance != null || l.history_only) continue;
    blank++;
    const expect = debitPos(l.opening_balance || 0) - (moveBy.get(A.nameKey(l.name)) || 0);
    if (Math.abs(expect) >= 1) { blankMoved++; blankMovedAmt += Math.abs(expect); }
  }
  checks.push(check('ledger_balances', 'Ledger balances', blankMoved ? 'warn' : 'ok',
    blankMoved ? `${blankMoved} of ${blank} ledgers with no balance from Tally should have one (about ₹${r0(blankMovedAmt).toLocaleString('en-IN')} between them); Margyn works it out from the entries.`
      : `${blank.toLocaleString('en-IN')} ledgers came with no balance from Tally; their entries net to zero, so they are genuinely at zero.`));

  // Ledgers with entries that land in no bucket: their amounts are in no figure.
  let unk = 0, unkAmt = 0;
  const unkNames = new Set();
  for (const r of ctx.rows || []) for (const l of r.lines) if (l.bucket === 'unknown') { unk++; unkAmt += Math.abs(l.amount); unkNames.add(l.ledger); }
  checks.push(check('ledgers_placed', 'Every ledger counted somewhere', unkNames.size ? 'warn' : 'ok',
    unkNames.size ? `${unkNames.size} ledgers (₹${r0(unkAmt).toLocaleString('en-IN')} of entries) aren’t placed in the profit and loss or balance sheet yet: ${[...unkNames].slice(0, 5).join(', ')}${unkNames.size > 5 ? '…' : ''}.`
      : 'Every ledger with entries is placed in the profit and loss or the balance sheet.'));

  // Customers: open bills against the customer's ledger balance. A gap means bills missing, or old ones not
  // knocked off in Tally.
  const pg = require('./billTieOut').partyGaps(ctx, 'receivable');
  const tied = pg.tied, gaps = pg.gaps.length, gapAmt = pg.gaps.reduce((t, g) => t + Math.abs(g.diff), 0);
  const gapTop = pg.gaps.map((g) => ({ party: g.party, billed: g.billed, ledger: g.ledger }));
  if (tied + gaps) checks.push(check('bills_tie', 'Customer bills tie to their ledgers', gaps ? 'warn' : 'ok',
    gaps ? `${tied} of ${tied + gaps} customers tie. For ${gaps}, Tally's open bills and the ledger balance differ by ₹${r0(gapAmt).toLocaleString('en-IN')} in all: paid bills not knocked off in Tally, or money owed that isn't split into bills. Margyn goes by the ledger balance for these customers (oldest bills treated as paid; the rest added from the entries); knocking the bills off in Tally clears this.`
      : `All ${tied} customers’ open bills add up to their ledger balance.`, { gaps: gapTop.slice(0, 8) }));

  const wc = (ctx.analytics || {}).working_capital || {};
  if (wc.suppliers_tracked_billwise === false) checks.push(check('suppliers_billwise', 'Suppliers', 'info', 'Tally doesn’t keep most suppliers’ bills one by one, so what you owe each supplier is worked out from their ledger (purchases and payments).'));

  // Sales invoice numbers must run without gaps: the one check that needs nothing from Tally (tallyAnalytics.invoiceGaps).
  try {
    const g = A.invoiceGaps(vouchersRaw, Date.parse(todayKey + 'T00:00:00Z'));
    if (g) {
      const n = g.short_months.reduce((t, k) => t + g.months[k].missing, 0);
      checks.push(check('invoice_numbers', 'Sales invoice numbers', g.short_months.length ? 'warn' : 'ok',
        g.short_months.length
          ? `About ${n.toLocaleString('en-IN')} sales invoices are missing in ${g.short_months.join(', ')}: their numbers are skipped (${g.series.filter((x) => x.longest_gap).map((x) => `${x.series}: ${x.longest_gap.n} in a row${x.longest_gap.after ? ' after ' + x.longest_gap.after : ''}`).slice(0, 3).join('; ')}). A full re-read of that company file brings them back.`
          : `Invoice numbers run without large gaps across ${g.series.length} sales series (${g.missing.toLocaleString('en-IN')} single numbers skipped, usual for invoices deleted in Tally).`,
        { months: g.months, series: g.series }));
    }
  } catch (e) { /* never blocks the check */ }
  if (book.files && book.files.files && book.files.files.length > 1) {
    const f = book.files;
    checks.push(check('company_files', 'Tally company files', f.ledgers_from === f.current ? 'info' : 'warn',
      `This Tally keeps a company file per year: ${f.files.map((x) => `${x.name} (${x.from} to ${x.to}, ${x.vouchers.toLocaleString('en-IN')} entries)`).join('; ')}. Entries are read from all of them. ` +
      (f.ledgers_from === f.current ? `Balances and open bills come from ${f.current}.` : `Balances held are from ${f.ledgers_from}, not the current file (${f.current}), so Margyn carries them forward from the entries until Tally sends the current file's again.`),
      f));
  }
  const p = diag && diag.vouchers && diag.vouchers.period ? diag.vouchers.period : null;
  if (p && p.from) {
    const days = vouchersRaw.map((v) => v && A.parseDate(v.date)).filter(Boolean).map((d) => d.toISOString().slice(0, 10)).filter((d) => d <= todayKey).sort();
    const first = days[0] || null, last = days[days.length - 1] || null;
    const behind = String(p.to).slice(0, 10) < todayKey;
    checks.push(check('period', 'Years covered', behind && last && last > String(p.to).slice(0, 10) ? 'warn' : 'info',
      behind && last && last > String(p.to).slice(0, 10)
        ? `Margyn holds entries from ${first} to ${last}, but Tally is sending ${p.from} to ${p.to} at the moment, so entries made after ${last} are not arriving. This happens when Tally reports a last voucher date in an earlier year.`
        : `Margyn holds entries from ${first || p.from} to ${last || p.to}; Tally is sending ${p.from} to ${p.to}. Years before the first entry arrive as opening balances.`,
      { held_from: first, held_to: last, agent_from: p.from, agent_to: p.to }));
  }

  const worst = checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return {
    source: 'tally', company: book.company || null, agent_version: book.agentVersion || (diag && diag.agent_version) || null,
    last_sync: book.lastSync || null, reported_at: diag ? diag.at || null : null, status: worst,
    counts: { vouchers: vouchersRaw.length, ledgers: ledgersRaw.length, bills: billsRaw.length },
    checks, months, excluded
  };
}

module.exports = { tallyCompleteness };
