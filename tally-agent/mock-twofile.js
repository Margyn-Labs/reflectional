/**
 * mock-twofile.js — a fake TallyPrime holding TWO company files of one business, one per financial year, the
 * way the Care customer keeps his books:
 *
 *   "CARE HYGIENE PVT LTD (2025-26)"  books from 2025-04-01, last voucher 2026-03-31
 *   "CARE HYGIENE PVT LTD (2026-27)"  books from 2026-04-01, entries up to yesterday + one dated 2027-03-10
 *
 * The 2026-27 file was made by copying the 2025-26 one, so both files carry the SAME ledger GUIDs, and the
 * three audit entries the accountant added to 2025-26 after the copy carry the very GUIDs of the first three
 * 2026-27 vouchers (Tally keeps counting from where the copy left off).
 *
 * Opt-in only: mock-tally.js hands requests here when MOCK_BOOK=care2. Nothing else in mock-tally.js changes.
 * The book is deterministic (seeded), so a test can require this file and work out every expected figure from
 * the same book the mock serves: buildBooks({ today }).
 *
 * Test hooks (HTTP, mock only):
 *   POST /__control  {"open":[names in Tally's order], "contacts":"ok"|"error"|"reset", "rename":{"from","to","file"}}
 *                    (a rename is made in one file, this year's by default; last year's file keeps the old name)
 *   GET  /__log      every distinct request shape since the last reset (company names and dates stripped),
 *                    and how many requests named each company file
 *   GET  /__log?reset=1
 */

const OLD = 'CARE HYGIENE PVT LTD (2025-26)';
const NEW = 'CARE HYGIENE PVT LTD (2026-27)';
const CO_GUID = '5e7c1b2a-9f3d-4c61-8e2b-7d4a0c9b1f30';
const guidOf = (n) => `${CO_GUID}-${n.toString(16).padStart(8, '0')}`;
const LEDGERS_PER_FILE = 3040;
const FUTURE_DATE = '20270310';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const fromYmd = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const addDays = (s, n) => ymd(new Date(fromYmd(s).getTime() + n * 86400000));
const daysBetween = (a, b) => Math.round((fromYmd(b) - fromYmd(a)) / 86400000);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const billDate = (s) => `${+s.slice(6, 8)}-${MON[+s.slice(4, 6) - 1]}-${s.slice(2, 4)}`;

/* Customers whose Tally contact details exercise the edge cases (scenario 5). Index = customer number. */
const SPECIAL_CUSTOMERS = [
  { name: 'ACME RETAIL PVT LTD', parent: 'SALESMAN NORTH', contact: { MARGYNMOBILE: '98200 12345', MARGYNEMAIL: 'accounts@acme.example', MARGYNCONTACT: 'R. Shah', MARGYNGSTIN: '27AABCA1234A1Z5', MARGYNSTATE: 'Maharashtra', MARGYNPIN: '400001', MARGYNADDRESS: '12 MG Road Fort Mumbai' } },
  { name: 'BLANK PHONE TRADERS', contact: { MARGYNPHONE: '', MARGYNMOBILE: '', MARGYNEMAIL: '' } },
  { name: 'LANDLINE MEDICALS', contact: { MARGYNPHONE: '022-2650 1100' } },
  { name: 'PLUS NINETY ONE PHARMA', contact: { MARGYNMOBILE: '+91 98765 43210' } },
  { name: 'TWO NUMBER CLINIC', contact: { MARGYNPHONE: '022 2650 1100, 99300 54321' } },
  { name: 'EMAIL ONLY HOSPITAL', contact: { MARGYNEMAIL: 'ap@emailonly.example' } },
  { name: 'OLD NAME TRADERS', contact: { MARGYNMOBILE: '98111 22233' } },
  { name: 'OWNER TYPED DISTRIBUTORS', contact: { MARGYNMOBILE: '98123 45678', MARGYNEMAIL: 'tally@ownertyped.example' } }
];
const SPECIAL_SUPPLIERS = [
  { name: 'VERMA SUPPLIES', contact: { MARGYNMOBILE: '99300 11111' } },
  { name: 'NO CONTACT SUPPLIER', contact: {} }
];
const N_CUSTOMERS = 180, N_SUPPLIERS = 40;

function masters() {
  let mid = 0x200;
  const L = [];
  const add = (name, parent, primary, kind, extra) => { const m = ++mid; L.push(Object.assign({ name, parent, primary, kind, masterId: m, guid: guidOf(m) }, extra || {})); return L[L.length - 1]; };
  add('CAPITAL ACCOUNT', 'Capital Account', 'Capital Account', 'bs');
  add('Profit & Loss A/c', '&#4; Primary', '', 'pl_ac');
  add('KOTAK BANK', 'Bank Accounts', 'Bank Accounts', 'cash');
  add('HDFC BANK CA', 'Bank Accounts', 'Bank Accounts', 'cash');
  add('CASH', 'Cash-in-Hand', 'Cash-in-Hand', 'cash');
  add('SALES @18%', 'Sales Accounts', 'Sales Accounts', 'pl');
  add('SALES @12%', 'Sales Accounts', 'Sales Accounts', 'pl');
  add('PURCHASE @18%', 'Purchase Accounts', 'Purchase Accounts', 'pl');
  add('OUTPUT IGST 18%', 'Duties & Taxes', 'Duties & Taxes', 'bs');
  add('OUTPUT IGST 12%', 'Duties & Taxes', 'Duties & Taxes', 'bs');
  add('INPUT IGST 18%', 'Duties & Taxes', 'Duties & Taxes', 'bs');
  for (const e of ['SALARY', 'RENT', 'ELECTRICITY', 'TRANSPORT CHARGES', 'BANK CHARGES', 'AUDIT FEES']) add(e, 'Indirect Expenses', 'Indirect Expenses', 'pl');
  add('AUDIT FEES PAYABLE', 'Provisions', 'Provisions', 'bs');
  const A = ['APEX', 'CITY', 'NOVA', 'SUNRISE', 'METRO', 'LOTUS', 'GLOBAL', 'PRIME', 'UNITY', 'SHREE', 'OM', 'LIFELINE', 'HOPE', 'SAI', 'NEWAGE', 'ZENITH'];
  const B = ['HOSPITAL', 'CLINIC', 'PHARMA', 'MEDICALS', 'DIAGNOSTICS', 'HEALTHCARE', 'NURSING HOME', 'CHEMISTS', 'SURGICALS', 'LABS', 'DENTAL CARE', 'EYE CARE'];
  const customers = [];
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const sp = SPECIAL_CUSTOMERS[i];
    const name = sp ? sp.name : `${A[i % A.length]} ${B[Math.floor(i / A.length) % B.length]}`;
    const parent = sp && sp.parent ? sp.parent : (i % 10 < 3 ? (i % 2 ? 'SALESMAN WEST' : 'SALESMAN NORTH') : 'Sundry Debtors');
    let contact;
    if (sp) contact = sp.contact;
    else if (i % 6 === 0) contact = {};
    else contact = Object.assign({ MARGYNMOBILE: `9${String(820000000 + i * 1013).slice(0, 4)} ${String(820000000 + i * 1013).slice(4, 9)}` }, i % 4 === 1 ? { MARGYNEMAIL: `ap${i}@customer.example` } : {});
    customers.push(add(name, parent, 'Sundry Debtors', 'debtor', { idx: i, contact, special: !!sp, lag: sp ? 150 : 15 + ((i * 37) % 45) }));
  }
  const S = ['ALPHA', 'BRIGHT', 'CLEAN', 'DELTA', 'EAGLE', 'FRESH', 'GREEN', 'HIGHWAY', 'INDO', 'JYOTI'];
  const T = ['PACKAGING', 'CHEMICALS', 'PLASTICS', 'LOGISTICS'];
  const suppliers = [];
  for (let j = 0; j < N_SUPPLIERS; j++) {
    const sp = SPECIAL_SUPPLIERS[j];
    const name = sp ? sp.name : `${S[j % S.length]} ${T[Math.floor(j / S.length) % T.length]}`;
    suppliers.push(add(name, 'Sundry Creditors', 'Sundry Creditors', 'creditor', { idx: j, contact: sp ? sp.contact : (j % 3 === 0 ? { MARGYNPHONE: '020-2612 0000' } : {}) }));
  }
  let f = 0;
  while (L.length < LEDGERS_PER_FILE) add(`MISC LEDGER ${pad(++f, 4)}`, 'Indirect Expenses', 'Indirect Expenses', 'pl');
  return { ledgers: L, customers, suppliers };
}

/**
 * The whole business, both files. `today` = 'YYYY-MM-DD' (India date of the run): entries run up to the day before.
 * Returns { files: { [name]: { name, booksFrom, ledgers, vouchers, bills, openings, closings, facts } }, expected }.
 */
function buildBooks({ today }) {
  const end = addDays(today.replace(/-/g, ''), -1);
  if (end < '20260410' || end >= '20270310') throw new Error(`mock-twofile: run date ${today} is outside FY 2026-27 (the scenario this book models)`);
  const R = rng(20261009);
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const { ledgers, customers, suppliers } = masters();
  const byName = new Map(ledgers.map((l) => [l.name, l]));

  const files = {};
  for (const [name, from] of [[OLD, '20250401'], [NEW, '20260401']]) files[name] = { name, booksFrom: from, vouchers: [], alter: 0 };
  let counter = 0x1000;
  const num = {};
  const push = (file, v) => {
    const f = files[file];
    v.guid = v.guid || guidOf(++counter);
    v.alterId = ++f.alter;
    num[file + v.type] = (num[file + v.type] || 0) + 1;
    v.number = v.number || String(num[file + v.type]);
    f.vouchers.push(v);
    return v;
  };

  // Open bills (customers and suppliers), in date order; payments clear whole bills, oldest first.
  const openR = new Map(customers.map((c) => [c.name, []]));
  const openP = new Map(suppliers.map((s) => [s.name, []]));
  let oldOpenR = null, oldOpenP = null;
  const expected = { net_sales: { [OLD]: 0, [NEW]: 0 } };
  let invNo = 0, purNo = 0;
  const paidMonths = new Set();

  for (let d = '20250401'; d <= end; d = addDays(d, 1)) {
    const file = d < '20260401' ? OLD : NEW;
    if (d === '20260401') { oldOpenR = new Map([...openR].map(([k, v]) => [k, v.slice()])); oldOpenP = new Map([...openP].map(([k, v]) => [k, v.slice()])); }
    const dow = fromYmd(d).getUTCDay();
    if (dow === 0) continue;
    const dayIdx = daysBetween('20250401', d);
    // Sales invoices: fourteen a day, plus each edge-case customer every tenth day.
    const buyers = [];
    for (let k = 0; k < 14; k++) buyers.push(customers[ri(SPECIAL_CUSTOMERS.length, N_CUSTOMERS - 1)]);
    for (const c of customers.slice(0, SPECIAL_CUSTOMERS.length)) if ((dayIdx + c.idx) % 10 === 0) buyers.push(c);
    for (const c of buyers) {
      const net = 1000 * ri(2, 60);
      const r12 = R() < 0.2;
      const tax = Math.round(net * (r12 ? 12 : 18) / 100);
      const total = net + tax;
      const salesLedger = r12 ? 'SALES @12%' : 'SALES @18%';
      const v = push(file, { type: invNo % 2 ? 'VASAI SALES' : 'KANDIVALI SALE', date: d, party: c.name, invoice: true,
        entries: [[c.name, -total, true], [r12 ? 'OUTPUT IGST 12%' : 'OUTPUT IGST 18%', tax, false]],
        items: [[R() < 0.5 ? 'HAND SANITIZER 500ML' : 'SURFACE DISINFECTANT 5L', 10, 'Nos', net / 10, net, 'Main Location', salesLedger]],
        sales: { net, tax } });
      invNo++;
      openR.get(c.name).push({ ref: `${v.type === 'KANDIVALI SALE' ? 'KS' : 'VS'}/${v.number}`, date: d, amount: total });
      expected.net_sales[file] += net;
    }
    // Receipts: each customer pays every 8th day for the bills older than its usual wait.
    for (const c of customers) {
      if ((dayIdx + c.idx) % 8 !== 0) continue;
      const q = openR.get(c.name);
      let amt = 0;
      while (q.length && daysBetween(q[0].date, d) >= c.lag) amt += q.shift().amount;
      if (amt > 0) push(file, { type: 'Receipt', date: d, party: c.name, entries: [[c.name, amt, true], ['KOTAK BANK', -amt, false]] });
    }
    // One purchase a day; suppliers paid every 10th day for bills over 25 days old.
    {
      const s = suppliers[ri(0, N_SUPPLIERS - 1)];
      const net = 1000 * ri(5, 80), tax = Math.round(net * 18 / 100);
      push(file, { type: 'Purchase', date: d, party: s.name, entries: [[s.name, net + tax, true], ['PURCHASE @18%', -net, false], ['INPUT IGST 18%', -tax, false]] });
      openP.get(s.name).push({ ref: `P-${++purNo}`, date: d, amount: net + tax });
    }
    for (const s of suppliers) {
      if ((dayIdx + s.idx) % 10 !== 0) continue;
      const q = openP.get(s.name);
      let amt = 0;
      while (q.length && daysBetween(q[0].date, d) >= 25) amt += q.shift().amount;
      if (amt > 0) push(file, { type: 'Payment', date: d, party: s.name, entries: [[s.name, -amt, true], ['KOTAK BANK', amt, false]] });
    }
    // Running costs.
    if (!paidMonths.has(d.slice(0, 6))) {
      paidMonths.add(d.slice(0, 6));
      for (const [l, a] of [['SALARY', 650000], ['RENT', 120000], ['ELECTRICITY', 35000], ['BANK CHARGES', 590]]) push(file, { type: 'Payment', date: d, party: l, entries: [[l, -a, false], ['KOTAK BANK', a, false]] });
    }
    { const t = ri(800, 3000); push(file, { type: 'Payment', date: d, party: 'TRANSPORT CHARGES', entries: [['TRANSPORT CHARGES', -t, false], ['CASH', t, false]] }); }
    if (dow === 1) push(file, { type: 'Contra', date: d, party: 'CASH', entries: [['CASH', -30000, false], ['KOTAK BANK', 30000, false]] });
  }
  if (!oldOpenR) throw new Error('mock-twofile: no year boundary');

  // The accountant's audit entries in last year's file, made after the copy: they reuse the GUIDs of this
  // year's first three vouchers.
  const newFirst = files[NEW].vouchers.slice(0, 3).map((v) => v.guid);
  const audit = [['AUDIT FEES', 50000, 'AUDIT FEES PAYABLE'], ['AUDIT FEES', 25000, 'AUDIT FEES PAYABLE'], ['BANK CHARGES', 1180, 'KOTAK BANK']];
  const auditVouchers = audit.map(([dr, a, cr], i) => push(OLD, { guid: newFirst[i], type: 'Journal', number: `AUD-${i + 1}`, date: '20260331', party: dr, audit: true, entries: [[dr, -a, false], [cr, a, false]] }));
  // A post-dated rent cheque already entered in this year's file.
  const future = push(NEW, { type: 'Payment', number: 'PDC-1', date: FUTURE_DATE, party: 'RENT', entries: [['RENT', -75000, false], ['KOTAK BANK', 75000, false]] });

  // Balances, Tally's sign (debit negative, as on the vouchers).
  const move = (vs, upTo) => { const m = new Map(); for (const v of vs) { if (upTo && v.date > upTo) continue; for (const [l, a] of v.entries) m.set(l, (m.get(l) || 0) + a); for (const it of v.items || []) if (it[6]) m.set(it[6], (m.get(it[6]) || 0) + it[4]); } return m; };
  const openOld = new Map([['KOTAK BANK', -4000000], ['CASH', -100000], ['HDFC BANK CA', -500000], ['CAPITAL ACCOUNT', 4600000]]);
  const mvOld = move(files[OLD].vouchers);
  const mvOldPreAudit = move(files[OLD].vouchers.filter((v) => !v.audit));
  const closeOld = new Map(ledgers.map((l) => [l.name, (openOld.get(l.name) || 0) + (mvOld.get(l.name) || 0)]));
  const closeOldPre = new Map(ledgers.map((l) => [l.name, (openOld.get(l.name) || 0) + (mvOldPreAudit.get(l.name) || 0)]));
  const openNew = new Map();
  let plCarry = 0;
  for (const l of ledgers) {
    if (l.kind === 'pl') plCarry += closeOldPre.get(l.name);
    else if (l.kind !== 'pl_ac') openNew.set(l.name, closeOldPre.get(l.name));
  }
  openNew.set('Profit & Loss A/c', plCarry);
  const mvNew = move(files[NEW].vouchers);
  const closeNew = new Map(ledgers.map((l) => [l.name, (openNew.get(l.name) || 0) + (mvNew.get(l.name) || 0)]));
  const mvNewToday = move(files[NEW].vouchers, end);
  const closeNewToday = new Map(ledgers.map((l) => [l.name, (openNew.get(l.name) || 0) + (mvNewToday.get(l.name) || 0)]));
  for (const [k, m] of [['openings', openOld], ['closings', closeOld]]) files[OLD][k] = m;
  files[NEW].openings = openNew; files[NEW].closings = closeNew;

  // Open bills as each file shows them. Overdue days count from the due date (30 days after the bill).
  const todayC = today.replace(/-/g, '');
  const billRows = (rmap, pmap) => {
    const out = [];
    for (const [party, q] of rmap) for (const b of q) out.push({ party, ref: b.ref, date: b.date, due: addDays(b.date, 30), cl: Math.round(b.amount * 100) / 100, dir: 'receivable' });
    for (const [party, q] of pmap) for (const b of q) out.push({ party, ref: b.ref, date: b.date, due: addDays(b.date, 30), cl: -Math.round(b.amount * 100) / 100, dir: 'payable' });
    for (const b of out) b.overdue = Math.max(0, daysBetween(b.due, todayC));
    return out;
  };
  files[OLD].bills = billRows(oldOpenR, oldOpenP);
  files[NEW].bills = billRows(openR, openP);

  for (const f of Object.values(files)) {
    f.ledgers = ledgers;
    f.lastVoucherDate = f.vouchers.reduce((a, v) => (v.date > a ? v.date : a), '00000000');
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  const cashNames = ledgers.filter((l) => l.kind === 'cash').map((l) => l.name);
  const sumBills = (f, dir) => r2(f.bills.filter((b) => b.dir === dir).reduce((a, b) => a + Math.abs(b.cl), 0));
  expected[NEW] = {
    net_sales_fy: r2(expected.net_sales[NEW]),
    receivables: sumBills(files[NEW], 'receivable'),
    payables: sumBills(files[NEW], 'payable'),
    // Debit-positive money in the bank and cash ledgers today (the post-dated cheque left out).
    cash: r2(-cashNames.reduce((a, n) => a + closeNewToday.get(n), 0)),
    cash_with_future: r2(-cashNames.reduce((a, n) => a + closeNew.get(n), 0)),
    debtors_today: r2(-customers.reduce((a, c) => a + closeNewToday.get(c.name), 0)),
    creditors_today: r2(suppliers.reduce((a, s) => a + closeNewToday.get(s.name), 0)),
    vouchers: files[NEW].vouchers.length, ledgers: ledgers.length,
    bills_receivable: files[NEW].bills.filter((b) => b.dir === 'receivable').length,
    bills_payable: files[NEW].bills.filter((b) => b.dir === 'payable').length
  };
  expected[OLD] = { net_sales_fy: r2(expected.net_sales[OLD]), vouchers: files[OLD].vouchers.length, ledgers: ledgers.length,
    receivables: sumBills(files[OLD], 'receivable'), payables: sumBills(files[OLD], 'payable') };
  expected.shared_voucher_guids = newFirst;
  expected.audit_guids = auditVouchers.map((v) => v.guid);
  expected.future_guid = future.guid;
  expected.customers = customers.length;
  return { files, ledgers, customers, suppliers, expected, end, OLD, NEW };
}

/* ---------------------------- XML ---------------------------- */
function xmlEscape(s) { return String(s).replace(/&(?!#4;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const amt = (n) => (Math.round(n * 100) / 100).toFixed(2);

function voucherXml(list) {
  return list.map((v) => {
    const led = v.entries.map(([name, a, isParty]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME TYPE="String">${xmlEscape(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${a < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER><AMOUNT TYPE="Amount">${amt(a)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('');
    const inv = (v.items || []).map(([item, qty, unit, rate, a, godown, sl]) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${xmlEscape(item)}</STOCKITEMNAME><RATE>${amt(rate)}/${unit}</RATE><AMOUNT>${amt(a)}</AMOUNT><ACTUALQTY> ${qty} ${unit}</ACTUALQTY><BILLEDQTY> ${qty} ${unit}</BILLEDQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>${xmlEscape(godown)}</GODOWNNAME></BATCHALLOCATIONS.LIST><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xmlEscape(sl)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(a)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`).join('');
    return `<VOUCHER REMOTEID="${v.guid}" VCHTYPE="${xmlEscape(v.type)}" ACTION="Create"><DATE TYPE="Date">${v.date}</DATE><GUID>${v.guid}</GUID><ALTERID> ${v.alterId}</ALTERID><VOUCHERTYPENAME>${xmlEscape(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>${inv}${led}</VOUCHER>`;
  }).join('\n');
}
const envelope = (inner) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
const lineError = (msg) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DESC><LINEERROR>${xmlEscape(msg)}</LINEERROR></DESC></BODY></ENVELOPE>`;

const TAGS = ['MARGYNPHONE', 'MARGYNMOBILE', 'MARGYNEMAIL', 'MARGYNCONTACT', 'MARGYNGSTIN', 'MARGYNSTATE', 'MARGYNPIN', 'MARGYNPAN', 'MARGYNADDRESS'];

/** Request shape with the company names, dates and change counters taken out (scenario 7). */
function requestShape(body) {
  return String(body)
    .replace(/<SVCURRENTCOMPANY>[\s\S]*?<\/SVCURRENTCOMPANY>/g, '<SVCURRENTCOMPANY>{CO}</SVCURRENTCOMPANY>')
    .replace(/<SV(FROM|TO)DATE([^>]*)>[\s\S]*?<\/SV\1DATE>/g, '<SV$1DATE$2>{D}</SV$1DATE>')
    .replace(/\$\$Date:"[^"]*"/g, '$$$$Date:"{D}"')
    .replace(/\$AlterID &gt; \d+/g, '$AlterID &gt; {N}');
}
function shapeLabel(shape) {
  const id = (/<ID>([^<]*)<\/ID>/.exec(shape) || [])[1] || '?';
  if (id === 'MargynLedgerContacts') return id + (/PartyGSTIN/.test(shape) ? ' (full)' : ' (lean)');
  if (id === 'MargynVouchers') return id + (/MargynFltr/.test(shape) ? (/AlterID/.test(shape) ? ' (changed since AlterID)' : ' (date formula)') : ' (period only)');
  return id;
}

function createHandler(opts) {
  const today = (opts && opts.today) || new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const B = buildBooks({ today });
  const state = { open: [B.NEW], contacts: 'ok', log: new Map(), companies: new Map(), renames: new Map() };
  let cur = null;   // the company file the current request reads (renames are per file)
  const nm = (n) => (state.renames.get(cur) && state.renames.get(cur).get(n)) || n;
  const tDate = (s) => { const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s || ''); return m ? `${m[3]}${pad(MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) + 1)}${pad(+m[1])}` : (/^\d{8}$/.test(s || '') ? s : null); };

  function companyFacts() {
    return envelope(state.open.map((n, i) => {
      const f = B.files[n];
      return `<COMPANY NAME="${xmlEscape(n)}" RESERVEDNAME=""><BOOKSFROM TYPE="Date">${f.booksFrom}</BOOKSFROM><STARTINGFROM TYPE="Date">${f.booksFrom}</STARTINGFROM><LASTVOUCHERDATE TYPE="Date">${f.lastVoucherDate}</LASTVOUCHERDATE><ALTMSTID TYPE="Number"> 3400</ALTMSTID><ALTVCHID TYPE="Number"> ${f.alter}</ALTVCHID><ISACTIVECOMPANY TYPE="Logical">${i === 0 ? 'Yes' : 'No'}</ISACTIVECOMPANY></COMPANY>`;
    }).join(''));
  }
  function ledgers(f) {
    return envelope(f.ledgers.map((l) => `<LEDGER><MARGYNPARENT TYPE="String">${xmlEscape(l.parent)}</MARGYNPARENT><MARGYNPRIMARY TYPE="String">${xmlEscape(l.primary)}</MARGYNPRIMARY><MARGYNOPENING TYPE="Amount">${amt(f.openings.get(l.name) || 0)}</MARGYNOPENING><MARGYNCLOSING TYPE="Amount">${amt(f.closings.get(l.name) || 0)}</MARGYNCLOSING><MARGYNNAME TYPE="String">${xmlEscape(nm(l.name))}</MARGYNNAME><MARGYNGUID TYPE="String">${l.guid}</MARGYNGUID><MARGYNMASTERID TYPE="Number"> ${l.masterId}</MARGYNMASTERID></LEDGER>`).join(''));
  }
  function contacts(f, full) {
    return envelope(f.ledgers.map((l) => {
      const c = l.contact || {};
      const tags = TAGS.filter((t) => full || ['MARGYNPHONE', 'MARGYNMOBILE', 'MARGYNEMAIL', 'MARGYNCONTACT'].includes(t)).map((t) => `<${t} TYPE="String">${xmlEscape(c[t] || '')}</${t}>`).join('');
      return `<LEDGER><MARGYNNAME TYPE="String">${xmlEscape(nm(l.name))}</MARGYNNAME><MARGYNGUID TYPE="String">${l.guid}</MARGYNGUID>${tags}</LEDGER>`;
    }).join(''));
  }
  function counts(f) {
    const per = {};
    for (const v of f.vouchers) per[v.date] = (per[v.date] || 0) + 1;
    return envelope(Object.entries(per).map(([d, n]) => `<OBJECT><DATE TYPE="Date">${+d.slice(6)}-${MON[+d.slice(4, 6) - 1]}-${d.slice(2, 4)}</DATE><COUNT TYPE="Number"> ${n}</COUNT></OBJECT>`).join(''));
  }
  function vouchers(f, body) {
    const sf = tDate((/<SVFROMDATE[^>]*>([^<]*)</.exec(body) || [])[1]);
    const st = tDate((/<SVTODATE[^>]*>([^<]*)</.exec(body) || [])[1]);
    const ge = /\$Date &gt;= \$\$Date:"([^"]+)"/.exec(body), le = /\$Date &lt;= \$\$Date:"([^"]+)"/.exec(body);
    const alt = /\$AlterID &gt; (\d+)/.exec(body);
    const from = (ge && tDate(ge[1])) || sf || '00000000', to = (le && tDate(le[1])) || st || '99999999';
    return envelope(voucherXml(f.vouchers.filter((v) => v.date >= from && v.date <= to && (!alt || v.alterId > +alt[1])).map((v) => Object.assign({}, v, { party: nm(v.party), entries: v.entries.map(([l, a, p]) => [nm(l), a, p]) }))));
  }
  function bills(f, dir) {
    const rows = f.bills.filter((b) => b.dir === dir);
    return `<ENVELOPE>${rows.map((b) => `<BILLFIXED><BILLDATE>${billDate(b.date)}</BILLDATE><BILLREF>${xmlEscape(b.ref)}</BILLREF><BILLPARTY>${xmlEscape(nm(b.party))}</BILLPARTY></BILLFIXED><BILLCL>${amt(b.cl)}</BILLCL><BILLDUE>${billDate(b.due)}</BILLDUE><BILLOVERDUE>${b.overdue}</BILLOVERDUE>`).join('\n')}</ENVELOPE>`;
  }
  const voucherTypes = () => envelope([['KANDIVALI SALE', 'Sales'], ['VASAI SALES', 'Sales'], ['Receipt', 'Receipt'], ['Payment', 'Payment'], ['Purchase', 'Purchase'], ['Journal', 'Journal'], ['Contra', 'Contra']].map(([n, p]) => `<VOUCHERTYPE NAME="${n}" RESERVEDNAME=""><GUID>vt-${n}</GUID><PARENT TYPE="String">${p}</PARENT></VOUCHERTYPE>`).join(''));

  /** Answer one Tally request. Returns { xml } or { destroy: true }, plus a kind for the console. */
  function answer(body) {
    const shape = requestShape(body);
    state.log.set(shape, (state.log.get(shape) || 0) + 1);
    if (/MargynTallyInfo|\$\$ProductName/i.test(body)) {
      return { kind: 'info', xml: `<ENVELOPE><MARGYNTALLYINFOOBJ><PRODUCTNAME>TallyPrime</PRODUCTNAME><PRODUCTVERSION>5.1</PRODUCTVERSION><SERIALNUMBER>724900081234</SERIALNUMBER><ISEDUCATIONAL>No</ISEDUCATIONAL><ISGOLD>Yes</ISGOLD><CURRENTCOMPANY>${xmlEscape(state.open[0] || '')}</CURRENTCOMPANY></MARGYNTALLYINFOOBJ></ENVELOPE>` };
    }
    if (/MargynCompanies/.test(body)) return { kind: 'company facts', xml: companyFacts() };
    const coM = /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/.exec(body);
    const co = coM ? coM[1].replace(/&amp;/g, '&').trim() : state.open[0];
    if (coM) state.companies.set(co, (state.companies.get(co) || 0) + 1);
    if (!state.open.includes(co)) return { kind: 'company not open', xml: lineError(`Could not set 'SVCurrentCompany' to '${co}'`) };
    const f = B.files[co];
    cur = co;
    if (/MargynVchCount/.test(body)) return { kind: 'voucher counts', xml: counts(f) };
    if (/MargynVoucherTypes/.test(body)) return { kind: 'voucher types', xml: voucherTypes() };
    if (/MargynVouchers/.test(body)) return { kind: 'voucher collection', xml: vouchers(f, body) };
    if (/<ID>(Day Book|Voucher Register)<\/ID>/.test(body)) return { kind: 'day book (ignores dates)', xml: envelope(voucherXml(f.vouchers.filter((v) => v.date === f.lastVoucherDate))) };
    if (/Bills Receivable/i.test(body)) return { kind: 'bills receivable', xml: bills(f, 'receivable') };
    if (/Bills Payable/i.test(body)) return { kind: 'bills payable', xml: bills(f, 'payable') };
    if (/MargynLedgerGstin/.test(body)) return { kind: 'ledger gstin', xml: envelope('') };
    if (/MargynLedgerContacts/.test(body)) {
      if (state.contacts === 'reset') return { kind: 'ledger contacts (connection dropped)', destroy: true };
      if (state.contacts === 'error') return { kind: 'ledger contacts (Tally error)', xml: lineError("Error in TDL: 'LedgerMobile' is not a method of Ledger") };
      return { kind: 'ledger contacts', xml: contacts(f, /PartyGSTIN/.test(body)) };
    }
    if (/SOURCECOLLECTION|MargynLedgers|List of Ledgers/i.test(body)) return { kind: 'ledgers', xml: ledgers(f) };
    return { kind: 'unknown', xml: lineError('Unknown request') };
  }

  function control(o) {
    if (Array.isArray(o.open)) state.open = o.open.slice();
    if (o.contacts) state.contacts = o.contacts;
    if (o.rename && o.rename.from) { const file = o.rename.file || B.NEW; if (!state.renames.has(file)) state.renames.set(file, new Map()); state.renames.get(file).set(o.rename.from, o.rename.to); }
    return { open: state.open, contacts: state.contacts, renames: [...state.renames].map(([f, m]) => [f, [...m]]) };
  }
  /** { shapes: [{label, shape, n}], companies: {name: requests} } since the last reset. */
  function log(reset) {
    const out = { shapes: [...state.log.entries()].map(([shape, n]) => ({ label: shapeLabel(shape), shape, n })), companies: Object.fromEntries(state.companies) };
    if (reset) { state.log = new Map(); state.companies = new Map(); }
    return out;
  }
  return { books: B, answer, control, log };
}

module.exports = { buildBooks, createHandler, requestShape, shapeLabel, OLD, NEW, FUTURE_DATE };
