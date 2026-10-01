/**
 * mock-tally.js — a stand-in for TallyPrime's HTTP/XML server, for testing the
 * agent without a Windows machine.
 *
 *   node mock-tally.js            # listens on 9000
 *   PORT=9500 node mock-tally.js
 *
 * The ledger response shape here is copied VERBATIM (field names, nesting,
 * quirks included) from a REAL TallyPrime response captured on a real
 * install 2026-09-05 — not invented, not a community example. See
 * tallyClient.js's buildLedgerRequest comment for the full story of how we
 * got here (a custom-collection-from-scratch request hung real Tally;
 * building on top of Tally's own built-in "List of Ledgers" collection via
 * SOURCECOLLECTION + COMPUTE fields is what actually works).
 *
 * Known real quirks reproduced here:
 *   - MARGYNCLOSING comes back EMPTY for most ledgers on a real install
 *     (only resolved for one ledger out of eight in the real test — the
 *     P&L account). CLOSING_BALANCE_MODE below controls how many mock
 *     ledgers get a closing figure, to keep exercising the "null closing
 *     balance, sync anyway" path.
 *   - MARGYNPARENT can carry a leading Tally control character (real
 *     example: "&#4; Primary" for the P&L account's parent) — decodeEntities
 *     in tallyClient.js already strips it.
 *   - MARGYNMASTERID has a leading space in the real response.
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '9000', 10);

// PRODUCT=tallyprime (default) | erp9 — switches the info-probe response only.
// The ledger response shape itself is the same across both (SOURCECOLLECTION
// is a Tally-engine-level feature, not TallyPrime-vs-ERP9 specific — untested
// on real ERP 9 yet, flagged in README).
const PRODUCT = (process.env.PRODUCT || 'tallyprime').toLowerCase();
const IS_ERP9 = PRODUCT === 'erp9';
const PRODUCT_NAME = IS_ERP9 ? 'Tally.ERP 9' : 'TallyPrime';
const PRODUCT_VERSION = IS_ERP9 ? 'Release 6.6.3' : '5.1';

// CLOSING_BALANCE_MODE=sparse (default, matches the real test — only one
// ledger gets a closing figure) | full (every ledger gets one, for testing
// the happy path) | none (no ledger gets one, tests full graceful-null path)
const CLOSING_BALANCE_MODE = (process.env.CB_MODE || 'sparse').toLowerCase();

const LEDGERS = [
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-0000001f', masterId: '31',  name: 'Cash',                 parent: 'Cash-in-Hand',   open: 15000,  openDr: true,  close: 8200,    closeDr: true },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000d0', masterId: '208', name: 'Acme Retail Pvt Ltd',   parent: 'Sundry Debtors', open: 120000, openDr: true,  close: 250000,  closeDr: true },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000cf', masterId: '207', name: 'Bharat Distributors',   parent: 'Sundry Debtors', open: 0,      openDr: true,  close: 82000,   closeDr: true },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000d4', masterId: '212', name: 'Verma Supplies',        parent: 'Sundry Creditors', open: 30000, openDr: false, close: 45000, closeDr: false },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000ce', masterId: '206', name: 'HDFC Bank CA',          parent: 'Bank Accounts',  open: 500000, openDr: true,  close: 613400,  closeDr: true },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000d2', masterId: '210', name: 'Sales - Local',         parent: 'Sales Accounts', open: 0,      openDr: false, close: 4200000, closeDr: false },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-0000001e', masterId: '30',  name: 'Profit & Loss A/c',     parent: ' Primary', open: 0,      openDr: true,  close: 0,       closeDr: true },
  { guid: '207515c3-4e7e-45fa-af33-eb0a0d483865-000000d1', masterId: '209', name: 'GST Payable',           parent: 'Duties & Taxes', open: 0,      openDr: false, close: 210000,  closeDr: false }
];

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function infoXml() {
  return `<ENVELOPE>
 <MARGYNTALLYINFOOBJ>
  <PRODUCTNAME>${PRODUCT_NAME}</PRODUCTNAME>
  <PRODUCTVERSION>${PRODUCT_VERSION}</PRODUCTVERSION>
  <SERIALNUMBER>724900081234</SERIALNUMBER>
  <ISEDUCATIONAL>No</ISEDUCATIONAL>
  <ISGOLD>Yes</ISGOLD>
  <CURRENTCOMPANY>Margyn Labs</CURRENTCOMPANY>
  <PERIODFROM>1-Apr-2026</PERIODFROM>
  <PERIODTO>31-Mar-2027</PERIODTO>
 </MARGYNTALLYINFOOBJ>
</ENVELOPE>`;
}

/** Reproduces the exact real response shape from the SOURCECOLLECTION/COMPUTE request. */
function ledgerXml() {
  const body = LEDGERS.map((l, i) => {
    const includeClosing =
      CLOSING_BALANCE_MODE === 'full' ? true :
      CLOSING_BALANCE_MODE === 'none' ? false :
      /* sparse: only the P&L account, matching the real capture */ l.name === 'Profit & Loss A/c';

    const closingTag = includeClosing
      ? `<MARGYNCLOSING TYPE="Amount">${(l.closeDr ? l.close : -l.close).toFixed(2)}</MARGYNCLOSING>`
      : '<MARGYNCLOSING TYPE="Amount"></MARGYNCLOSING>';

    return `
    <LEDGER>
     <MARGYNPARENT TYPE="String">${xmlEscape(l.parent)}</MARGYNPARENT>
     <MARGYNOPENING TYPE="Amount">${(l.openDr ? l.open : -l.open).toFixed(2)}</MARGYNOPENING>
     ${closingTag}
     <MARGYNNAME TYPE="String">${xmlEscape(l.name)}</MARGYNNAME>
     <MARGYNGUID TYPE="String">${l.guid}</MARGYNGUID>
     <MARGYNMASTERID TYPE="Number"> ${l.masterId}</MARGYNMASTERID>
     <LANGUAGENAME.LIST>     </LANGUAGENAME.LIST>
    </LEDGER>`;
  }).join('');

  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <STATUS>1</STATUS>
 </HEADER>
 <BODY>
  <DATA>
   <COLLECTION ISMSTDEPTYPE="Yes" MSTDEPTYPE="8">${body}
   </COLLECTION>
  </DATA>
 </BODY>
</ENVELOPE>`;
}

/**
 * Vouchers mock — reproduces the real "Day Book" report response shape
 * captured from a real TallyPrime install 2026-09-06 (verbose <VOUCHER> with
 * nested <LEDGERENTRIES.LIST>, signed amounts, YYYYMMDD dates). Trimmed of
 * the ~200 empty fields Tally pads each voucher with — parseVouchers ignores
 * those anyway.
 *
 * Bills mock (billsXml) reproduces the real "Bills Receivable" report shape
 * captured 2026-09-06: <BILLFIXED> block + sibling <BILLCL>/<BILLDUE>/
 * <BILLOVERDUE> tags, d-mmm-yy dates, signed BILLCL.
 */
const VOUCHERS = [
  { guid: 'mockvch-0001', type: 'Sales',    number: '1', date: '20260402', party: 'Test Customer', entries: [['Test Customer', -50000, true], ['Sales Account', 50000, false]], items: [['Widget A', 100, 'Nos', 300, 30000, 'Main Location'], ['Widget B', 20, 'Nos', 1000, 20000, 'Main Location']] },
  { guid: 'mockvch-0002', type: 'Purchase', number: '1', date: '20260402', party: 'Test Supplier', entries: [['Test Supplier', 30000, true], ['Purchase Account', -30000, false]], items: [['Widget A', 150, 'Nos', 200, -30000, 'Main Location']] },
  { guid: 'mockvch-0003', type: 'Receipt',  number: '1', date: '20260402', party: 'Test Customer', entries: [['Test Customer', 50000, true], ['Cash', -50000, false]] },
  { guid: 'mockvch-0004', type: 'Payment',  number: '1', date: '20260402', party: 'Test Supplier', entries: [['Test Supplier', -30000, true], ['Cash', 30000, false]] },
  { guid: 'mockvch-0005', type: 'Journal',  number: '1', date: '20260430', party: 'Test Supplier', entries: [['Purchase Account', -500, false], ['Test Supplier', 500, true]] }
];

function vouchersXml() {
  const body = VOUCHERS.map((v) => {
    const ledgerLists = v.entries.map(([name, amt, isParty]) => `
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(name)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>
      <AMOUNT>${amt.toFixed(2)}</AMOUNT>
     </LEDGERENTRIES.LIST>`).join('');
    const invLists = (v.items || []).map(([item, qty, unit, rate, amt, godown]) => `
     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xmlEscape(item)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
      <RATE>${rate.toFixed(2)}/${xmlEscape(unit)}</RATE>
      <AMOUNT>${amt.toFixed(2)}</AMOUNT>
      <ACTUALQTY> ${qty} ${xmlEscape(unit)}</ACTUALQTY>
      <BILLEDQTY> ${qty} ${xmlEscape(unit)}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>${xmlEscape(godown)}</GODOWNNAME></BATCHALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`).join('');
    return `
   <VOUCHER REMOTEID="${v.guid}" VCHTYPE="${xmlEscape(v.type)}" ACTION="Create">
    <DATE>${v.date}</DATE>
    <GUID>${v.guid}</GUID>
    <NARRATION/>
    <VOUCHERTYPENAME>${xmlEscape(v.type)}</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>
    <PARTYNAME>${xmlEscape(v.party)}</PARTYNAME>
    <PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME>
    <ISCANCELLED>No</ISCANCELLED>${invLists}${ledgerLists}
   </VOUCHER>`;
  }).join('');
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>
 <BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>Margyn Labs</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
  <DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}
  </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`;
}


/* ------------------------------------------------------------------ */
/* Real-book simulation (agent 0.2.0). MOCK_BOOK=care (default) builds a  */
/* company like the first real client: FY split company "(2026-27)",     */
/* hundreds of vouchers a month from April, renamed sale voucher types,  */
/* item invoices, and the Day Book bug seen on real books: Day Book       */
/* IGNORES SVFROMDATE/SVTODATE and returns only the last voucher date.    */
/* MOCK_BOOK=test keeps the original 5-voucher educational company.       */
/* ------------------------------------------------------------------ */
const MOCK_BOOK = (process.env.MOCK_BOOK || 'care').toLowerCase();
const COMPANY = MOCK_BOOK === 'care' ? 'CARE HYGIENE PVT LTD (2026-27)' : 'Margyn Labs';
const COLLECTION_DATEVALUE_ONLY = process.env.DATEVALUE_ONLY === '1'; // simulate a build that rejects $$Date
let BOOK = null;
function book() {
  if (BOOK) return BOOK;
  if (MOCK_BOOK !== 'care') { BOOK = VOUCHERS.map((v, i) => Object.assign({ alterId: i + 1, invoice: false }, v)); return BOOK; }
  const out = [];
  let alter = 100, n = 0;
  const parties = ['PHARMA GIFTING', 'APEX HOSPITAL', 'CITY CLINIC', 'NOVA PHARMA'];
  for (let m = 4; m <= 9; m++) {
    const days = new Date(2026, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      for (let k = 0; k < 4; k++) {
        n++;
        const date = `2026${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
        const party = parties[(n + k) % parties.length];
        const net = 1000 * ((n % 17) + 1), tax = net * 0.18;
        if (k < 2) {
          out.push({ guid: `care-${n}`, type: k ? 'VASAI SALES' : 'KANDIVALI SALE', number: String(n), date, party, alterId: ++alter, invoice: true,
            entries: [[party, -(net + tax), true], ['OUTPUT IGST 18%', tax, false]],
            items: [['HAND SANITIZER 500ML', 10, 'Nos', net / 10, net, 'Main Location', 'SALES @18%']] });
        } else if (k === 2) {
          out.push({ guid: `care-${n}`, type: 'Receipt', number: String(n), date, party, alterId: ++alter, invoice: false,
            entries: [[party, net, true], ['KOTAK BANK', -net, false]] });
        } else {
          out.push({ guid: `care-${n}`, type: 'Payment', number: String(n), date, party: 'SALARY', alterId: ++alter, invoice: false,
            entries: [['SALARY', -500, false], ['CASH', 500, false]] });
        }
      }
    }
  }
  BOOK = out;
  return BOOK;
}
const lastVoucherDate = () => book().reduce((a, v) => (v.date > a ? v.date : a), '00000000');
const MONTHS3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function tallyDateToCompact(s) {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  return m ? `${m[3]}${String(MONTHS3[m[2].toLowerCase()]).padStart(2, '0')}${m[1].padStart(2, '0')}` : null;
}

function voucherBody(list, style) {
  return list.map((v) => {
    const listTag = style === 'collection' ? 'ALLLEDGERENTRIES.LIST' : (v.invoice ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST');
    const T = (t, val) => style === 'collection' ? `<${t} TYPE="String">${val}</${t}>` : `<${t}>${val}</${t}>`;
    const ledgerLists = v.entries.map(([name, amt, isParty]) => `
     <${listTag}>
      ${T('LEDGERNAME', xmlEscape(name))}
      <ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>
      <AMOUNT${style === 'collection' ? ' TYPE="Amount"' : ''}>${amt.toFixed(2)}</AMOUNT>
     </${listTag}>`).join('');
    const invLists = (v.items || []).map(([item, qty, unit, rate, amt, godown, salesLedger]) => `
     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xmlEscape(item)}</STOCKITEMNAME>
      <RATE>${rate.toFixed(2)}/${xmlEscape(unit)}</RATE>
      <AMOUNT>${amt.toFixed(2)}</AMOUNT>
      <ACTUALQTY> ${qty} ${xmlEscape(unit)}</ACTUALQTY>
      <BILLEDQTY> ${qty} ${xmlEscape(unit)}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>${xmlEscape(godown)}</GODOWNNAME></BATCHALLOCATIONS.LIST>${salesLedger ? `
      <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xmlEscape(salesLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt.toFixed(2)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` : ''}
     </ALLINVENTORYENTRIES.LIST>`).join('');
    return `
   <VOUCHER REMOTEID="${v.guid}" VCHTYPE="${xmlEscape(v.type)}" ACTION="Create">
    <DATE${style === 'collection' ? ' TYPE="Date"' : ''}>${v.date}</DATE>
    <GUID>${v.guid}</GUID>
    <ALTERID> ${v.alterId}</ALTERID>
    <VOUCHERTYPENAME>${xmlEscape(v.type)}</VOUCHERTYPENAME>
    <VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME>
    <ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>${invLists}${ledgerLists}
   </VOUCHER>`;
  }).join('');
}

/** Voucher collection with a $Date filter: honours the window (and $AlterId > N). */
function voucherCollectionXml(reqBody) {
  if (process.env.REJECT_ALLOC === '1' && /AccountingAllocations/.test(reqBody)) {
    return '<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DESC><LINEERROR>Error in TDL: Could not find method AccountingAllocations</LINEERROR></DESC></BODY></ENVELOPE>';
  }
  if (COLLECTION_DATEVALUE_ONLY && (/\$\$Date:/.test(reqBody) || /AccountingAllocations/.test(reqBody) === false)) {
    return '<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DESC><LINEERROR>Error in TDL: Function $$Date could not be evaluated</LINEERROR></DESC></BODY></ENVELOPE>';
  }
  const ge = /\$Date &gt;= \$\$Date(?:Value)?:"([^"]+)"/.exec(reqBody);
  const le = /\$Date &lt;= \$\$Date(?:Value)?:"([^"]+)"/.exec(reqBody);
  const alt = /\$AlterId &gt; (\d+)/.exec(reqBody);
  const from = ge ? tallyDateToCompact(ge[1]) : '00000000';
  const to = le ? tallyDateToCompact(le[1]) : '99999999';
  const list = book().filter((v) => v.date >= from && v.date <= to && (!alt || v.alterId > +alt[1]));
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${voucherBody(list, 'collection')}
  </COLLECTION></DATA></BODY></ENVELOPE>`;
}

/** The real-book bug: Day Book ignores the period and answers with the last voucher date only. */
function dayBookXml() {
  const list = MOCK_BOOK === 'care' ? book().filter((v) => v.date === lastVoucherDate()) : book();
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${voucherBody(list, 'report')}
  </TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

function countXml(reqBody) {
  const ge = /\$Date &gt;= \$\$Date:"([^"]+)"/.exec(reqBody);
  const le = /\$Date &lt;= \$\$Date:"([^"]+)"/.exec(reqBody);
  const from = ge ? tallyDateToCompact(ge[1]) : '00000000', to = le ? tallyDateToCompact(le[1]) : '99999999';
  const per = {};
  for (const v of book()) if (v.date >= from && v.date <= to) per[v.date] = (per[v.date] || 0) + 1;
  const body = Object.entries(per).map(([d, n]) => {
    const dt = `${+d.slice(6)}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+d.slice(4, 6) - 1]}-${d.slice(2, 4)}`;
    return `<VOUCHER><MARGYNDAY TYPE="Date">${dt}</MARGYNDAY><MARGYNCOUNT TYPE="Number"> ${n}</MARGYNCOUNT></VOUCHER>`;
  }).join('');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function companyXml() {
  const maxAlt = book().reduce((a, v) => Math.max(a, v.alterId), 0);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>
   <COMPANY NAME="${xmlEscape(COMPANY)}" RESERVEDNAME="">
    <BOOKSFROM TYPE="Date">20260401</BOOKSFROM><STARTINGFROM TYPE="Date">20260401</STARTINGFROM>
    <LASTVOUCHERDATE TYPE="Date">${lastVoucherDate()}</LASTVOUCHERDATE>
    <ALTMSTID TYPE="Number"> 3400</ALTMSTID><ALTVCHID TYPE="Number"> ${maxAlt}</ALTVCHID>
    <MARGYNACTIVE TYPE="Logical">Yes</MARGYNACTIVE>
   </COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`;
}

function voucherTypesXml() {
  const t = [['KANDIVALI SALE', 'Sales'], ['VASAI SALES', 'Sales'], ['Sales', ''], ['Receipt', ''], ['Payment', ''], ['Purchase', ''], ['Journal', '']];
  return `<ENVELOPE><BODY><DATA><COLLECTION>${t.map(([n, p]) => `<VOUCHERTYPE><MARGYNNAME>${n}</MARGYNNAME><MARGYNPARENT>${p || n}</MARGYNPARENT></VOUCHERTYPE>`).join('')}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function billsXml(direction) {
  // "Bills Receivable" (the working report) returns bills of both signs on a
  // real install. Mock the receivable request with one of each; mock the
  // payable request empty (matches the real behavior we saw).
  if (direction === 'payable') return '<ENVELOPE></ENVELOPE>';
  const rows = [
    { party: 'Test Customer', ref: 'Inv-2', billDate: '8-Apr-26', dueDate: '8-May-26', cl: 82000, overdue: 151 },
    { party: 'Test Supplier', ref: '1', billDate: '2-Apr-26', dueDate: '2-Apr-26', cl: -500, overdue: 363 }
  ];
  const body = rows.map((r) => `
 <BILLFIXED>
  <BILLDATE>${r.billDate}</BILLDATE>
  <BILLREF>${xmlEscape(r.ref)}</BILLREF>
  <BILLPARTY>${xmlEscape(r.party)}</BILLPARTY>
 </BILLFIXED>
 <BILLCL>${r.cl.toFixed(2)}</BILLCL>
 <BILLDUE>${r.dueDate}</BILLDUE>
 <BILLOVERDUE>${r.overdue}</BILLOVERDUE>`).join('');
  return `<ENVELOPE>${body}
</ENVELOPE>`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const isInfo = /MargynTallyInfo|\$\$ProductName/i.test(body);
    let xml, kind;
    if (req.url === '/__edit') {
      // test hook: edit one voucher in "Tally" (new amount, AlterID moves on)
      const v = book()[10];
      v.alterId = book().reduce((a, x) => Math.max(a, x.alterId), 0) + 1;
      v.entries = v.entries.map(([n, a, p]) => [n, a * 2, p]);
      v.items = (v.items || []).map((it) => { const c = it.slice(); c[4] = c[4] * 2; return c; });
      res.end(v.guid); return;
    }
    if (isInfo) { xml = infoXml().replace('Margyn Labs', COMPANY); kind = 'info'; }
    else if (/MargynCompanies/.test(body)) { xml = companyXml(); kind = 'company facts'; }
    else if (/MargynVchCount/.test(body)) { xml = countXml(body); kind = 'voucher counts'; }
    else if (/MargynVoucherTypes/.test(body)) { xml = voucherTypesXml(); kind = 'voucher types'; }
    else if (/MargynVouchers/.test(body)) { xml = voucherCollectionXml(body); kind = 'voucher collection'; }
    else if (/<ID>Voucher Register<\/ID>/.test(body)) { xml = dayBookXml(); kind = 'voucher register (ignores dates)'; }
    else if (/DayBook|Day Book/i.test(body)) { xml = dayBookXml(); kind = 'day book (ignores dates)'; }
    else if (/Bills Receivable/i.test(body)) { xml = billsXml('receivable'); kind = 'bills receivable (simulated)'; }
    else if (/Bills Payable/i.test(body)) { xml = billsXml('payable'); kind = 'bills payable (simulated)'; }
    else if (/SOURCECOLLECTION|MargynLedgers|List of Ledgers/i.test(body)) { xml = ledgerXml(); kind = 'ledgers'; }
    else { xml = `<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DESC><LINEERROR>Unknown request</LINEERROR></DESC></BODY></ENVELOPE>`; kind = 'unknown'; }

    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(xml);
    console.log(`${new Date().toISOString()}  ${kind}  ${req.socket.remoteAddress}`);
  });
});

server.listen(PORT, () => {
  console.log(`mock ${PRODUCT_NAME} ${PRODUCT_VERSION} XML server on http://127.0.0.1:${PORT}`);
  console.log(`  PRODUCT=tallyprime | erp9   (currently: ${PRODUCT})`);
  console.log(`  CB_MODE=sparse | full | none   (currently: ${CLOSING_BALANCE_MODE})`);
});
