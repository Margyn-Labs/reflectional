/**
 * tallyClient.js — talk to Tally's HTTP/XML server.
 *
 * Supports BOTH TallyPrime (Release 2.1+) and Tally.ERP 9. They expose the same
 * XML/HTTP interface (port 9000, same ENVELOPE/HEADER/BODY, same TDL collections);
 * differences are limited to a few field names and date formats, absorbed by the
 * tolerant parsers below. The agent detects which product it's talking to on
 * pairing (buildInfoRequest / parseInfo) and records it — not to fork logic, but
 * so a broken sync can be triaged against a known product+version.
 *
 * Tally acts as an HTTP server. We POST an XML "Export Data" request to
 * http://<host>:<port> with Content-Type: text/xml and parse the XML back.
 *
 * Zero dependencies: request via the built-in `http` module, parsing via a
 * small tag walker (Tally's export XML is shallow and regular — a full XML
 * parser is overkill and would add a packaging dependency).
 *
 * PHASE 1 implemented: product/version detection + ledger masters + balances.
 * PHASE 2/3 (vouchers, bills) have request builders ready; parsers pending a
 * real capture from each product.
 *
 * References:
 *   https://help.tallysolutions.com/xml-integration/
 *   https://help.tallysolutions.com/case-study-1/
 *   real captured v6 fixtures: github.com/Accounting-Companion/TallyConnector
 */

const http = require('http');
const net = require('net');

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ------------------------------------------------------------------ */
/* Request builders                                                   */
/* ------------------------------------------------------------------ */

/**
 * Product + version + edition + open-company probe. Works on both TallyPrime and
 * Tally.ERP 9 because it only uses TDL functions that exist in both:
 *   $$ProductName            -> "TallyPrime" | "Tally.ERP 9"
 *   $$Version                -> full version string ("Release 6.6.3" / "5.1" etc.)
 *   $$LicenseInfo:...         -> serial, educational flag, silver/gold
 *   ##SVCurrentCompany       -> the loaded company (nothing resolves without one)
 *
 * Returned via the COLLECTION+OBJECT+LOCALFORMULA pattern (proven portable — this
 * is what the TallyConnector library uses for its own version check).
 */
function buildInfoRequest() {
  const formulas = [
    'PRODUCTNAME:$$ProductName',
    'PRODUCTVERSION:$$Version',
    'SERIALNUMBER:$$LicenseInfo:SerialNumber',
    'ISEDUCATIONAL:if $$LicenseInfo:IsEducationalMode then "Yes" else "No"',
    'ISGOLD:if $$LicenseInfo:IsGold then "Yes" else "No"',
    'CURRENTCOMPANY:##SVCurrentCompany',
    'PERIODFROM:$$FromDate',
    'PERIODTO:$$ToDate'
  ];
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE>',
    '<ID>MargynTallyInfo</ID>',
    '</HEADER>',
    '<BODY>',
    '<DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    '</STATICVARIABLES>',
    '<TDL>',
    '<TDLMESSAGE>',
    '<COLLECTION NAME="MargynTallyInfo" ISMODIFY="No"><OBJECTS>MargynTallyInfoObj</OBJECTS></COLLECTION>',
    '<OBJECT NAME="MargynTallyInfoObj">',
    formulas.map((f) => `<LOCALFORMULA>${xmlEscape(f)}</LOCALFORMULA>`).join(''),
    '</OBJECT>',
    '</TDLMESSAGE>',
    '</TDL>',
    '</DESC>',
    '</BODY>',
    '</ENVELOPE>'
  ].join('');
}

/**
 * Ledger masters + opening/closing balances, scoped to one company.
 *
 * CONFIRMED WORKING on a real TallyPrime (Educational) install, 2026-09-05.
 * This took several real-machine rounds to land on — the shape matters a lot:
 *
 *   - Defining a brand-new collection from scratch (<TYPE>Ledger</TYPE> +
 *     NATIVEMETHOD fields, what this function used to do) made real Tally
 *     HANG indefinitely ("not responding") rather than answer or error.
 *   - Asking for Tally's own BUILT-IN collection "List of Ledgers" directly
 *     answers fine and fast — but only returns names, nothing else.
 *   - The fix: build on top of that working built-in collection instead of
 *     defining a new one — <SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>
 *     plus <COMPUTE> fields for everything else we need. This answers fine,
 *     fast, with real data, on the same install that hung on the first form.
 *
 * Response shape (verified against a real response, not assumed):
 *   <LEDGER> blocks (no NAME attribute — unlike "List of Ledgers" alone) with
 *   flat child tags: MARGYNNAME, MARGYNPARENT, MARGYNOPENING, MARGYNCLOSING,
 *   MARGYNGUID, MARGYNMASTERID — each a plain value, not nested AMOUNT/ISDEBIT
 *   blocks. MARGYNCLOSING comes back EMPTY for most ledgers on this install
 *   (Tally only resolved it for one out of eight test ledgers) — parseLedgers
 *   treats that as null, not an error; a ledger still syncs on name+parent+
 *   opening alone. Sign convention for MARGYNOPENING/MARGYNCLOSING not yet
 *   confirmed against a real non-zero credit balance — every test ledger so
 *   far had a zero balance. Revisit if synced numbers look inverted.
 */
function buildLedgerRequest({ company }) {
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE>',
    '<ID>MargynLedgers</ID>',
    '</HEADER>',
    '<BODY>',
    '<DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>`,
    '</STATICVARIABLES>',
    '<TDL>',
    '<TDLMESSAGE>',
    '<COLLECTION NAME="MargynLedgers"><SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>',
    '<COMPUTE>MARGYNNAME:$Name</COMPUTE>',
    '<COMPUTE>MARGYNPARENT:$Parent</COMPUTE>',
    '<COMPUTE>MARGYNPRIMARY:$_PrimaryGroup</COMPUTE>',
    '<COMPUTE>MARGYNOPENING:$OpeningBalance</COMPUTE>',
    '<COMPUTE>MARGYNCLOSING:$ClosingBalance</COMPUTE>',
    '<COMPUTE>MARGYNGUID:$Guid</COMPUTE>',
    '<COMPUTE>MARGYNMASTERID:$MasterId</COMPUTE>',
    '</COLLECTION>',
    '</TDLMESSAGE>',
    '</TDL>',
    '</DESC>',
    '</BODY>',
    '</ENVELOPE>'
  ].join('');
}

/**
 * Voucher types and the base type each one rolls up to. Companies rename them ("KANDIVALI SALE",
 * "VASAI SALES"); the base type ($Parent: Sales, Purchase, Receipt, ...) is what Tally treats them as.
 *
 * Shape copied from tally-database-loader's "vouchertype" collection (TYPE VoucherType + FETCH).
 * NOT <SOURCECOLLECTION>Voucher Types</SOURCECOLLECTION>: that name doesn't exist, and on real
 * TallyPrime an unknown name raises an "Error in TDL" box that CLOSES Tally when OK is clicked
 * (VP's test machine, 2026-10-01). Every request must be a shape proven elsewhere; see SAFETY below.
 */
function buildVoucherTypesRequest({ company }) {
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MargynVoucherTypes</ID></HEADER>',
    '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES>`,
    '<TDL><TDLMESSAGE><COLLECTION NAME="MargynVoucherTypes"><TYPE>VoucherType</TYPE><FETCH>Guid,Name,Parent</FETCH></COLLECTION>',
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  ].join('');
}

/** { 'KANDIVALI SALE': 'Sales', ... } — name from the NAME attribute (or <NAME>), base from <PARENT>. */
function parseVoucherTypes(xml) {
  const out = {};
  const re = /<VOUCHERTYPE\b([^>]*)>([\s\S]*?)<\/VOUCHERTYPE>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attr = (/\bNAME="([^"]*)"/i.exec(m[1]) || [])[1];
    const name = attr ? decodeEntities(attr).trim() : (tagText(m[2], 'NAME') || tagText(m[2], 'MARGYNNAME'));
    const parent = tagText(m[2], 'PARENT') || tagText(m[2], 'MARGYNPARENT');
    if (name && parent) out[name] = parent;
  }
  return out;
}

/**
 * PHASE 2 — voucher-level transactions for a date range.
 *
 * CONFIRMED WORKING on a real TallyPrime (Educational) install, 2026-09-06.
 * Same lesson as ledgers: a custom `<SOURCECOLLECTION>Vouchers</SOURCECOLLECTION>`
 * request failed fast with "Error in TDL: 'Collection:Vouchers' Could not find
 * description!" — "Vouchers" is not a real built-in collection. What works is
 * asking for Tally's own built-in **"Day Book"** report as a plain
 * `TYPE=Data` export with a date range. It returns every voucher in the
 * window in Tally's full verbose voucher format (~50KB of mostly-empty
 * fields per voucher — that's normal, parseVouchers ignores the noise).
 *
 * Response shape (verified against a real 5-voucher response):
 *   <ENVELOPE>...<DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ...>
 *     <DATE>20260402</DATE>                     (YYYYMMDD)
 *     <GUID>...</GUID>
 *     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
 *     <VOUCHERNUMBER>1</VOUCHERNUMBER>
 *     <PARTYLEDGERNAME>Test Customer</PARTYLEDGERNAME>
 *     <NARRATION/>
 *     <LEDGERENTRIES.LIST> (or <ALLLEDGERENTRIES.LIST> for some voucher types)
 *       <LEDGERNAME>Test Customer</LEDGERNAME>
 *       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
 *       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
 *       <AMOUNT>-50000.00</AMOUNT>              (signed: -ve = debit, +ve = credit)
 *     </LEDGERENTRIES.LIST>
 *     ... one .LIST block per ledger line ...
 *   </VOUCHER>
 */
function buildVoucherRequest({ company, fromDate, toDate }) {
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Data</TYPE>',
    '<ID>Day Book</ID>',
    '</HEADER>',
    '<BODY>',
    '<DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>`,
    `<SVFROMDATE>${xmlEscape(fromDate)}</SVFROMDATE>`,
    `<SVTODATE>${xmlEscape(toDate)}</SVTODATE>`,
    '</STATICVARIABLES>',
    '</DESC>',
    '</BODY>',
    '</ENVELOPE>'
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Full-period vouchers (agent 0.2.0)                                  */
/* ------------------------------------------------------------------ */
//
// Why not the Day Book: on real client books (Care Hygiene, 2026-10-01) the Day Book report
// ignored SVFROMDATE/SVTODATE and returned only the current day (19 vouchers per sync), so a
// month of 15-minute syncs accumulated just 31 days of history while Tally held the whole FY.
// Several independent integrators hit the same thing (tally-database-loader, tallytoerpnext,
// puneetkeshav/tally-integration quirks #6). What does honour a period is the Voucher
// *collection* with an explicit $Date filter formula. We still filter dates again in code,
// because some builds honour the formula loosely.
//
// Every request here is one rung of a ladder (VOUCHER_STRATEGIES). The agent tries them in
// order on a small window, keeps the first that returns dated vouchers, and remembers it in
// config, so each client's Tally settles on whatever its build supports without anyone visiting.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '20260401' | '2026-04-01' -> '1-Apr-2026' (static variables). */
function toTallyDate(d) {
  const s = String(d).replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) throw new Error(`bad date ${d}`);
  return `${parseInt(s.slice(6, 8), 10)}-${MONTH_ABBR[parseInt(s.slice(4, 6), 10) - 1]}-${s.slice(0, 4)}`;
}
const compactDate = (d) => { const s = String(d).replace(/-/g, ''); if (!/^\d{8}$/.test(s)) throw new Error(`bad date ${d}`); return s; };

function periodVars(company, from, to) {
  return [
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    company ? `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` : '',
    from ? `<SVFROMDATE>${toTallyDate(from)}</SVFROMDATE>` : '',
    to ? `<SVTODATE>${toTallyDate(to)}</SVTODATE>` : ''
  ].join('');
}

/*
 * SAFETY: an "Error in TDL" on the client's Tally opens a box, and clicking OK CLOSES TALLY.
 * So there is no trial and error here. Every request below copies a shape that
 * tally-database-loader (github.com/dhananjay1405/tally-database-loader, run on thousands of
 * TallyPrime installs) sends: the same collection TYPEs, the same FETCH method names, the same
 * built-in filter IsNonOptionalCancelledVchs, the same period formula. Nothing is added that the
 * loader doesn't already use. voucherSync.js also blocks, per machine, any request that was in
 * flight when Tally went away.
 */
const VOUCHER_FETCH = [
  'guid', 'date', 'vouchertypename', 'vouchernumber', 'narration', 'partyledgername', 'isinvoice',
  'allledgerentries.ledgername', 'allledgerentries.amount',
  'allinventoryentries.itemname', 'allinventoryentries.billedqty', 'allinventoryentries.rate',
  'allinventoryentries.amount', 'allinventoryentries.godownname'
].join(',');

/**
 * Vouchers in [from, to] (YYYYMMDD), not optional, not cancelled. `alterIdAfter` narrows to vouchers
 * created/edited since a known AlterID (the loader's incremental filter, `$AlterID > n`).
 */
function buildVoucherCollectionRequest({ company, from, to, alterIdAfter, dateFormula = true }) {
  const conds = [];
  if (from && to && dateFormula) conds.push(`$Date &gt;= $$Date:"${compactDate(from)}" and $Date &lt;= $$Date:"${compactDate(to)}"`);
  if (alterIdAfter != null) conds.push(`$AlterID &gt; ${parseInt(alterIdAfter, 10) || 0}`);
  const names = ['IsNonOptionalCancelledVchs'].concat(conds.map((_, i) => `MargynFltr${i + 1}`));
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MargynVouchers</ID></HEADER>',
    `<BODY><DESC><STATICVARIABLES>${periodVars(company, from, to)}</STATICVARIABLES>`,
    '<TDL><TDLMESSAGE><COLLECTION NAME="MargynVouchers"><TYPE>Voucher</TYPE>',
    `<FETCH>${VOUCHER_FETCH}</FETCH><FILTER>${names.join(',')}</FILTER></COLLECTION>`,
    conds.map((c, i) => `<SYSTEM TYPE="Formulae" NAME="MargynFltr${i + 1}">${c}</SYSTEM>`).join(''),
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  ].join('');
}

/** Built-in report with the period typed as Date (no TDL definitions at all). Fallback only. */
function buildReportPeriodRequest({ company, from, to, report }) {
  return [
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${xmlEscape(report)}</ID></HEADER>`,
    `<BODY><DESC><STATICVARIABLES>${periodVars(company, from, to)}</STATICVARIABLES></DESC></BODY></ENVELOPE>`
  ].join('');
}

// 'collection' is the real path. 'day-book' (what agent 0.1 used, proven not to crash anything but
// it returns only the current day) is kept only as the fallback if the collection can't be used.
// 'collection-period' = tally-database-loader's default (YAML) mode: the period is given only as
// SVFROMDATE/SVTODATE, which the Voucher collection honours (the Day Book report doesn't). The agent
// re-checks every date anyway. 'collection' adds the loader's JSON-mode date formula on top.
const VOUCHER_STRATEGIES = {
  'collection-period': (a) => buildVoucherCollectionRequest(Object.assign({}, a, { dateFormula: false })),
  collection: (a) => buildVoucherCollectionRequest(a),
  'day-book': (a) => buildReportPeriodRequest(Object.assign({}, a, { report: 'Day Book' }))
};
const VOUCHER_STRATEGY_ORDER = Object.keys(VOUCHER_STRATEGIES);

/**
 * The open company's own facts: books-from date, last voucher date, and the AlterID counters
 * that move whenever any voucher (AltVchId) or master (AltMstId) is created, edited or deleted.
 * Same request shape tally-database-loader uses to list companies on every sync.
 */
function buildCompanyFactsRequest() {
  // tally-database-loader's fetchTallyCompanyList, verbatim apart from the collection name, plus
  // LastVoucherDate (a Company method the loader reads in its company report).
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MargynCompanies</ID></HEADER>',
    '<BODY><DESC><TDL><TDLMESSAGE><COLLECTION NAME="MargynCompanies"><TYPE>Company</TYPE>',
    '<COMPUTE>IsActiveCompany : $$IsEqual:$Name:##SVCurrentCompany</COMPUTE>',
    '<FETCH>BooksFrom,LastVoucherDate,AltMstId,AltVchId</FETCH>',
    '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  ].join('');
}

/** [{ name, books_from, starting_from, last_voucher_date, alt_vch_id, alt_mst_id, active }] */
function parseCompanyFacts(xml) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);
  const out = [];
  const blockRe = /<COMPANY\b([^>]*)>([\s\S]*?)<\/COMPANY>/gi;
  let bm;
  while ((bm = blockRe.exec(xml)) !== null) {
    const b = bm[2];
    const attrName = (/\bNAME="([^"]*)"/i.exec(bm[1]) || [])[1];
    const tagName = (/<NAME(?:\s[^>]*)?>([\s\S]*?)<\/NAME>/i.exec(b) || [])[1];
    const name = attrName || tagName || null;
    if (!name) continue;
    const int = (t) => { const v = tagText(b, t); return v && /-?\d+/.test(v) ? parseInt(v.replace(/[^\d-]/g, ''), 10) : null; };
    out.push({
      name: decodeEntities(name).trim(),
      books_from: normaliseDate(tagText(b, 'BOOKSFROM')),
      last_voucher_date: normaliseDate(tagText(b, 'LASTVOUCHERDATE')),
      alt_vch_id: int('ALTVCHID'),
      alt_mst_id: int('ALTMSTID'),
      active: /^(yes|true|1)$/i.test(tagText(b, 'ISACTIVECOMPANY') || '')
    });
  }
  // A self-closing / attribute-only company (<COMPANY NAME="X" .../>) has no block body.
  if (!out.length) {
    const re = /<COMPANY\b[^>]*NAME="([^"]+)"/gi;
    let m;
    while ((m = re.exec(xml)) !== null) out.push({ name: decodeEntities(m[1]).trim(), books_from: null, last_voucher_date: null, alt_vch_id: null, alt_mst_id: null, active: false });
  }
  return out;
}

/**
 * Tally's own voucher count per date for a period: the completeness check. If the synced count
 * for a month equals Tally's, nothing was dropped. Aggregate collection (BY + AGGRCOMPUTE), the
 * same request tally-database-loader uses to plan its batches.
 */
function buildVoucherCountRequest({ company }) {
  // tally-database-loader's generateVoucherDatewiseCount, verbatim apart from names: whole company,
  // counted per date by Tally itself.
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MargynVchCount</ID></HEADER>',
    `<BODY><DESC><STATICVARIABLES>${periodVars(company)}</STATICVARIABLES><TDL><TDLMESSAGE>`,
    '<COLLECTION NAME="MargynVchCountEx"><TYPE>Voucher</TYPE><FILTER>IsNonOptionalCancelledVchs</FILTER></COLLECTION>',
    '<COLLECTION NAME="MargynVchCount"><SOURCECOLLECTION>MargynVchCountEx</SOURCECOLLECTION>',
    '<BY>Date : $Date</BY><AGGRCOMPUTE>Count : SUM : $$Number:1</AGGRCOMPUTE></COLLECTION>',
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  ].join('');
}

/** { 'YYYY-MM': count } from the aggregate response; blocks are named after the object type. */
function parseVoucherCounts(xml) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);
  const out = {};
  const re = /<DATE\b[^>]*>([\s\S]*?)<\/DATE>[\s\S]*?<COUNT\b[^>]*>([\s\S]*?)<\/COUNT>/gi;
  let m, seen = 0;
  while ((m = re.exec(xml)) !== null) {
    const d = normaliseDate(decodeEntities(m[1]).trim());
    const n = parseFloat(String(m[2]).replace(/[^\d.-]/g, ''));
    if (!d || !/^\d{4}-\d{2}/.test(d) || !Number.isFinite(n)) continue;
    const k = d.slice(0, 7);
    out[k] = (out[k] || 0) + n;
    seen++;
  }
  return seen ? out : null;
}

/**
 * PHASE 3 — bill-wise outstanding.
 *
 * CONFIRMED WORKING on a real TallyPrime (Educational) install, 2026-09-06.
 * Tally's built-in **"Bills Receivable"** report, exported as TYPE=Data,
 * returns outstanding bills in a compact format:
 *
 *   <ENVELOPE>
 *     <BILLFIXED>
 *       <BILLDATE>2-Apr-26</BILLDATE>
 *       <BILLREF>1</BILLREF>
 *       <BILLPARTY>Test Supplier</BILLPARTY>
 *     </BILLFIXED>
 *     <BILLCL>-500.00</BILLCL>        (signed: -ve = payable, +ve = receivable)
 *     <BILLDUE>2-Apr-26</BILLDUE>
 *     <BILLOVERDUE>363</BILLOVERDUE>  (days overdue)
 *     ... repeats per bill ...
 *   </ENVELOPE>
 *
 * On the test install this one report returned bills of BOTH directions (the
 * lone outstanding bill was a payable and it showed here); "Bills Payable" as
 * a separate ID returned an empty envelope. So parseBills derives the actual
 * direction from the sign of BILLCL, not from which report it came from — and
 * the agent still fires both requests (receivable + payable) in case a real,
 * fuller company splits them differently. Dedup is on (party, ref, direction).
 */
function buildBillsRequest({ company, toDate, direction, legacy = false }) {
  // legacy = the exact request that has run in production since 2026-09 (compact, untyped date).
  const d = legacy || !/^\d{8}$/.test(String(toDate)) ? xmlEscape(toDate) : toTallyDate(toDate);
  const typed = '';
  const reportId = direction === 'payable' ? 'Bills Payable' : 'Bills Receivable';
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Data</TYPE>',
    `<ID>${xmlEscape(reportId)}</ID>`,
    '</HEADER>',
    '<BODY>',
    '<DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>`,
    // As-of date: TODAY (the agent passes it), typed so Tally reads it. Overdue days count to this date;
    // the old FY-end default (31 Mar next year) inflated every bill's overdue days by months.
    `<SVFROMDATE${typed}>${d}</SVFROMDATE>`,
    `<SVTODATE${typed}>${d}</SVTODATE>`,
    '</STATICVARIABLES>',
    '</DESC>',
    '</BODY>',
    '</ENVELOPE>'
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* ------------------------------------------------------------------ */

function postXml({ host, port, xml, timeoutMs = 30000, onSlow }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(xml, 'utf8');
    // Real TallyPrime can pop up an error dialog on its own screen for a
    // request it doesn't like, and just sits there — the HTTP response never
    // comes until a human clicks it. Surface that possibility well before the
    // hard timeout instead of leaving the caller staring at a silent hang.
    const slowWarnAt = Math.min(8000, Math.max(3000, Math.floor(timeoutMs / 4)));
    const slowTimer = setTimeout(() => {
      (onSlow || (() => console.log(
        '\n⚠ Still waiting on Tally after ' + Math.round(slowWarnAt / 1000) + 's. ' +
        'Check the Tally window on that PC — it may be showing a dialog box waiting for you to click OK.\n'
      )))();
    }, slowWarnAt);
    const clearSlow = () => clearTimeout(slowTimer);

    const req = http.request(
      {
        host,
        port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': payload.length
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearSlow();
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`Tally responded ${res.statusCode}: ${text.slice(0, 300)}`));
          } else {
            resolve(text);
          }
        });
      }
    );
    req.on('error', (err) => {
      clearSlow();
      if (err.code === 'TALLY_TIMEOUT') {
        reject(err);
      } else if (err.code === 'ECONNREFUSED') {
        reject(new Error(
          `Could not reach TallyPrime at ${host}:${port}. Is Tally running with the HTTP server enabled ` +
          `(F1 Help > Settings > Advanced Configuration > HTTP Server), and a company loaded?`
        ));
      } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        reject(new Error(
          `Could not resolve host "${host}". Check the Tally host address in Settings — it should ` +
          `normally be 127.0.0.1 unless Tally is running on a different machine on the network.`
        ));
      } else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
        reject(new Error(
          `Could not reach ${host}:${port} — network unreachable (${err.code}). This usually means a ` +
          `firewall or antivirus is blocking the connection, or Tally is on a different machine/network ` +
          `than expected.`
        ));
      } else {
        reject(new Error(
          `Connection to Tally at ${host}:${port} failed (${err.code || err.message}). Check that Tally ` +
          `is running and that the host/port in Settings match Tally's HTTP server configuration.`
        ));
      }
    });
    req.setTimeout(timeoutMs, () => {
      clearSlow();
      const err = new Error(
        `Tally request timed out after ${Math.round(timeoutMs / 1000)}s. Tally is either busy with a large ` +
        `request or showing a dialog on its screen.`
      );
      err.code = 'TALLY_TIMEOUT';
      req.destroy(err);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Fast raw-TCP reachability probe — deliberately separate from postXml.
 *
 * postXml's failure timeout is 30s (Tally can legitimately take that long on
 * a slow real request) which makes "change a Tally setting, retry, wait to
 * see if it worked" painfully slow when troubleshooting on-site. This does
 * a bare socket connect with a short timeout (default 3s) and resolves
 * (never rejects) with a plain reachable/not-reachable verdict, so the UI
 * can give an answer in ~3s instead of ~30s per iteration.
 *
 * A successful connect here only proves "something is listening on this
 * port" — it does NOT confirm that thing is actually Tally's HTTP/XML
 * server, or that a company is loaded. Use postXml (buildInfoRequest) for
 * that confirmation once this says reachable.
 */
function testConnection({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, reason: 'timeout', code: 'ETIMEDOUT' }));
    socket.once('error', (err) => finish({ reachable: false, reason: err.message, code: err.code || null }));
    socket.connect(port, host);
  });
}

/* ------------------------------------------------------------------ */
/* Minimal XML helpers                                                */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#4;/g, '');
}

/** All inner blocks named <tag ...> ... </tag>. Case-insensitive. */
function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** First inner text of <tag>..</tag> within a block. */
function tagText(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** Check for a Tally <LINEERROR> in the response envelope. */
function responseError(xml) {
  const err = tagText(xml, 'LINEERROR') || tagText(xml, 'DESC');
  if (err && /error|could not|unknown|invalid/i.test(err)) return err;
  return null;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read a balance field that may arrive in any of three real-world shapes:
 *
 *   1. Nested block (how OPENINGBALANCE always comes, and CLOSINGBALANCE on some builds):
 *        <CLOSINGBALANCE><AMOUNT>1000</AMOUNT><ISDEBIT>true</ISDEBIT></CLOSINGBALANCE>
 *      -> unsigned magnitude + separate sign flag.
 *   2. Flat signed number (common for computed $ClosingBalance):
 *        <MARGYNCLOSING>-1000.00</MARGYNCLOSING>       (negative = credit, Tally convention)
 *   3. Flat number with a Dr/Cr suffix (older report exports):
 *        <CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE>
 *
 * Output convention (Margyn's): DEBIT positive, CREDIT negative. `raw` keeps the
 * original text/структура for audit.
 */
function readBalance(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return { value: null, raw: null };
  const inner = m[1];

  // Shape 1: nested <AMOUNT> (+ optional <ISDEBIT>)
  const amtM = /<AMOUNT\b[^>]*>([\s\S]*?)<\/AMOUNT>/i.exec(inner);
  if (amtM) {
    const mag = parseFloat(String(amtM[1]).replace(/,/g, '').trim());
    if (!Number.isFinite(mag)) return { value: null, raw: inner.trim() };
    const isDebitM = /<ISDEBIT\b[^>]*>([\s\S]*?)<\/ISDEBIT>/i.exec(inner);
    const isDebit = isDebitM ? /true|yes|1/i.test(isDebitM[1].trim()) : (mag >= 0);
    return { value: (isDebit ? 1 : -1) * Math.abs(mag), raw: inner.replace(/\s+/g, ' ').trim() };
  }

  // Shapes 2 & 3: flat text
  let s = decodeEntities(inner).trim();
  if (s === '') return { value: null, raw: null };
  let drCrSign = null;
  if (/cr\.?$/i.test(s)) drCrSign = -1;
  else if (/dr\.?$/i.test(s)) drCrSign = 1;
  const numStr = s.replace(/(dr|cr)\.?$/i, '').replace(/,/g, '').trim();
  const n = parseFloat(numStr);
  if (!Number.isFinite(n)) return { value: null, raw: s };
  // Tally's flat computed balance is already signed with negative = credit.
  // If a Dr/Cr suffix is present it wins; otherwise respect the sign as given.
  const value = drCrSign !== null ? drCrSign * Math.abs(n) : n;
  return { value, raw: s };
}

/**
 * Parse the product/version probe. The object comes back named after the OBJECT
 * (uppercased), e.g. <MARGYNTALLYINFOOBJ>, or sometimes wrapped differently by
 * version — so we just scan the whole envelope for the alias tags.
 */
function parseInfo(xml) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);

  const productRaw = tagText(xml, 'PRODUCTNAME') || '';
  const version = tagText(xml, 'PRODUCTVERSION') || null;
  const serial = tagText(xml, 'SERIALNUMBER') || null;
  const isEducational = /^(yes|true|1)$/i.test(tagText(xml, 'ISEDUCATIONAL') || '');
  const isGold = /^(yes|true|1)$/i.test(tagText(xml, 'ISGOLD') || '');
  const company = tagText(xml, 'CURRENTCOMPANY') || null;

  // Normalise product to a stable key.
  let product = 'unknown';
  if (/tallyprime/i.test(productRaw)) product = 'tallyprime';
  else if (/erp\s*9|tally\.erp/i.test(productRaw)) product = 'erp9';
  // Fallback: TallyPrime version strings are like "2.1"/"5.1"; ERP 9 like "Release 6.6.x".
  else if (version && /^release\s*6/i.test(version)) product = 'erp9';
  else if (version && /^\d\.\d/.test(version)) product = 'tallyprime';

  return {
    product,                       // 'tallyprime' | 'erp9' | 'unknown'
    product_name: productRaw || null,
    version,
    edition: isEducational ? 'educational' : (isGold ? 'gold' : 'silver'),
    serial_last4: serial ? String(serial).replace(/\s/g, '').slice(-4) : null,
    company,
    reachable: !!(productRaw || version)
  };
}

/**
 * Parse the response to buildLedgerRequest — the SOURCECOLLECTION/COMPUTE
 * request, confirmed against a real TallyPrime response 2026-09-05. Field
 * names are the MARGYN* aliases defined in that request, flat (not nested
 * AMOUNT/ISDEBIT blocks) — see buildLedgerRequest's comment for why.
 */
function parseLedgers(xml) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);

  const blocks = extractBlocks(xml, 'LEDGER');
  const rows = [];
  for (const b of blocks) {
    const name = tagText(b, 'MARGYNNAME');
    if (!name) continue;

    const ob = readBalance(b, 'MARGYNOPENING');
    const cb = readBalance(b, 'MARGYNCLOSING');

    rows.push({
      guid: tagText(b, 'MARGYNGUID') || null,
      master_id: tagText(b, 'MARGYNMASTERID') || null,
      name,
      parent: tagText(b, 'MARGYNPARENT') || null,
      // The reserved group at the top of this ledger's chain (Sundry Debtors, Sales Accounts, ...).
      // Tally's own answer to "what is this ledger", whatever the custom sub-groups are called.
      primary_group: tagText(b, 'MARGYNPRIMARY') || null,
      opening_balance: ob.value,
      closing_balance: cb.value,
      closing_balance_raw: cb.raw != null ? cb.raw : (ob.raw != null ? ('opening:' + ob.raw) : null),
      currency: 'INR'
    });
  }
  return rows;
}

/**
 * Stock lines on a voucher (Sales / Purchase / Delivery Note / ...). Tally
 * nests these as <ALLINVENTORYENTRIES.LIST> (older builds: <INVENTORYENTRIES.LIST>)
 * inside the same verbose Day Book response the ledger entries come from, so
 * no extra request is needed. Quantities and rates arrive as strings with a
 * unit suffix, e.g. " 100 Nos" / "500.00/Nos" — split them. Amount keeps
 * Tally's sign convention (sales lines are positive, purchase lines negative
 * in the raw XML), so we also emit abs_amount for easy math.
 * NOT yet confirmed against a real company file — run `probe-inventory`.
 */
function parseQtyUnit(raw) {
  if (raw == null) return { qty: null, unit: null };
  const m = /^\s*(-?[\d,]*\.?\d+)\s*(.*)$/.exec(String(raw));
  if (!m) return { qty: null, unit: null };
  const qty = parseFloat(m[1].replace(/,/g, ''));
  return { qty: Number.isFinite(qty) ? qty : null, unit: m[2].trim() || null };
}

function parseInventoryEntries(voucherBlock) {
  const blocks = [
    ...extractBlocks(voucherBlock, 'ALLINVENTORYENTRIES\\.LIST'),
    ...extractBlocks(voucherBlock, 'INVENTORYENTRIES\\.LIST')
  ];
  const items = [];
  for (const e of blocks) {
    const item = tagText(e, 'STOCKITEMNAME') || tagText(e, 'ITEMNAME');
    if (!item) continue;
    const billed = parseQtyUnit(tagText(e, 'BILLEDQTY'));
    const actual = parseQtyUnit(tagText(e, 'ACTUALQTY'));
    const qty = billed.qty != null ? billed.qty : actual.qty;
    const unit = billed.unit || actual.unit;
    const rateM = /^\s*(-?[\d,]*\.?\d+)/.exec(tagText(e, 'RATE') || '');
    const rate = rateM ? parseFloat(rateM[1].replace(/,/g, '')) : null;
    const amtM = /<AMOUNT\b[^>]*>([\s\S]*?)<\/AMOUNT>/i.exec(e);
    const amount = amtM ? parseFloat(String(amtM[1]).replace(/,/g, '').trim()) : null;
    items.push({
      item,
      qty,
      unit,
      rate: Number.isFinite(rate) ? rate : null,
      amount: Number.isFinite(amount) ? amount : null,
      abs_amount: Number.isFinite(amount) ? Math.abs(amount) : null,
      godown: tagText(e, 'GODOWNNAME') || null
    });
  }
  return items;
}

/**
 * Parse the "Day Book" report response — confirmed against a real TallyPrime
 * response 2026-09-06. Each <VOUCHER> carries header fields plus one or more
 * <LEDGERENTRIES.LIST> / <ALLLEDGERENTRIES.LIST> blocks (voucher type
 * determines which tag). Amounts are signed in Tally's raw convention:
 * negative = debit, positive = credit.
 *
 * `amount` = the transaction's headline value = abs(party ledger entry
 * amount), falling back to the largest absolute entry amount if no party
 * ledger is flagged. `entries` keeps the full signed breakdown for the
 * vitals engine.
 */
function parseVouchers(xml) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);

  const blocks = extractBlocks(xml, 'VOUCHER');
  const rows = [];
  for (const b of blocks) {
    const voucherType = tagText(b, 'VOUCHERTYPENAME');
    const voucherNumber = tagText(b, 'VOUCHERNUMBER');
    if (!voucherType && !voucherNumber) continue;

    // Ledger entries — both tag variants, merged.
    // Item invoices (most sales and purchase vouchers in a stock-keeping business) keep the
    // Sales / Purchase ledger line INSIDE each stock line as an accounting allocation. Without
    // these, sales and purchases are missing from the P&L entirely.
    const allocBlocks = [];
    for (const inv of [...extractBlocks(b, 'ALLINVENTORYENTRIES\\.LIST'), ...extractBlocks(b, 'INVENTORYENTRIES\\.LIST')]) {
      allocBlocks.push(...extractBlocks(inv, 'ACCOUNTINGALLOCATIONS\\.LIST'));
    }
    // Day Book puts an item invoice's party/tax lines in LEDGERENTRIES and its sales line in the
    // allocations; the Voucher collection puts them in ALLLEDGERENTRIES, and on some builds
    // repeats lines across lists. A voucher's lines always sum to zero, so take the first
    // combination that balances rather than assuming a shape (summing everything double-counts).
    const partyName = tagText(b, 'PARTYLEDGERNAME') || tagText(b, 'PARTYNAME') || null;
    const toEntries = (blocks) => {
      const out = [];
      for (const e of blocks) {
        const ledger = tagText(e, 'LEDGERNAME');
        if (!ledger) continue;
        const amtM = /<AMOUNT\b[^>]*>([\s\S]*?)<\/AMOUNT>/i.exec(e);
        const amount = amtM ? parseFloat(String(amtM[1]).replace(/,/g, '').trim()) : null;
        out.push({
          ledger,
          amount: Number.isFinite(amount) ? amount : null,
          // The collection read doesn't fetch ISPARTYLEDGER (the loader doesn't); the voucher's party
          // ledger name identifies the party line just as well.
          is_party: /^(yes|true|1)$/i.test(tagText(e, 'ISPARTYLEDGER') || '') || (!!partyName && ledger === partyName),
          is_deemed_positive: /^(yes|true|1)$/i.test(tagText(e, 'ISDEEMEDPOSITIVE') || '')
        });
      }
      return out;
    };
    const L = toEntries(extractBlocks(b, 'LEDGERENTRIES\\.LIST'));
    const A = toEntries(extractBlocks(b, 'ALLLEDGERENTRIES\\.LIST'));
    const C = toEntries(allocBlocks);
    const sums = (xs) => Math.abs(xs.reduce((s, x) => s + (x.amount || 0), 0));
    const candidates = [A, A.concat(C), L.concat(C), L, A.concat(L).concat(C)].filter((x) => x.length);
    const entries = candidates.find((x) => sums(x) < 0.5 + 1e-6 * x.reduce((s, y) => s + Math.abs(y.amount || 0), 0)) ||
      A.concat(L).concat(C);

    // Headline amount: the party entry's magnitude; else the biggest entry.
    let headline = null;
    const partyEntry = entries.find((x) => x.is_party && x.amount != null);
    if (partyEntry) {
      headline = Math.abs(partyEntry.amount);
    } else {
      const mags = entries.map((x) => (x.amount != null ? Math.abs(x.amount) : 0));
      headline = mags.length ? Math.max(...mags) : null;
    }

    const items = parseInventoryEntries(b);
    // Optional (memorandum) vouchers never touch the books.
    if (/^(yes|true|1)$/i.test(tagText(b, 'ISOPTIONAL') || '')) continue;
    const alterId = parseInt(tagText(b, 'ALTERID') || '', 10);

    rows.push({
      alter_id: Number.isFinite(alterId) ? alterId : null,
      guid: tagText(b, 'GUID') || null,
      voucher_type: voucherType,
      voucher_number: voucherNumber,
      date: normaliseDate(tagText(b, 'DATE')),
      party_name: tagText(b, 'PARTYLEDGERNAME') || tagText(b, 'PARTYNAME') || null,
      narration: tagText(b, 'NARRATION') || null,
      amount: headline,
      is_cancelled: /^(yes|true|1)$/i.test(tagText(b, 'ISCANCELLED') || ''),
      entries: entries.length ? entries : null,
      items: items.length ? items : null
    });
  }
  return rows;
}

/**
 * Parse the "Bills Receivable" report response — confirmed against a real
 * TallyPrime response 2026-09-06. Each bill is a <BILLFIXED> block followed
 * by sibling <BILLCL>/<BILLDUE>/<BILLOVERDUE> tags. Direction is derived from
 * the sign of BILLCL (-ve = payable, +ve = receivable), NOT from the
 * `direction` argument (which is only the report the request asked for).
 */
function parseBills(xml /*, requestedDirection */) {
  const err = responseError(xml);
  if (err) throw new Error(`Tally: ${err}`);

  const rows = [];
  // A bill record: <BILLFIXED>..</BILLFIXED> then the CL/DUE/OVERDUE siblings
  // that follow it, up to the next <BILLFIXED> or end.
  const re = /<BILLFIXED>([\s\S]*?)<\/BILLFIXED>([\s\S]*?)(?=<BILLFIXED>|<\/ENVELOPE>|$)/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const fixed = m[1];
    const tail = m[2];
    const party = tagText(fixed, 'BILLPARTY');
    if (!party) continue;

    const clM = /<BILLCL\b[^>]*>([\s\S]*?)<\/BILLCL>/i.exec(tail);
    const amount = clM ? parseFloat(String(clM[1]).replace(/,/g, '').trim()) : null;
    const overdueM = /<BILLOVERDUE\b[^>]*>([\s\S]*?)<\/BILLOVERDUE>/i.exec(tail);
    const dueM = /<BILLDUE\b[^>]*>([\s\S]*?)<\/BILLDUE>/i.exec(tail);

    const signed = Number.isFinite(amount) ? amount : null;
    rows.push({
      direction: signed != null && signed < 0 ? 'payable' : 'receivable',
      party_name: party,
      bill_ref: tagText(fixed, 'BILLREF') || null,
      bill_date: normaliseDate(tagText(fixed, 'BILLDATE')),
      due_date: dueM ? normaliseDate(dueM[1].trim()) : null,
      closing_balance: signed,
      overdue_days: overdueM && /^-?\d+$/.test(overdueM[1].trim()) ? parseInt(overdueM[1].trim(), 10) : null
    });
  }
  return rows;
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/**
 * Tally dates arrive in several formats depending on the export path:
 *   ISO        2026-04-01
 *   compact    20260401           (Day Book / voucher exports)
 *   d-mmm-yy   2-Apr-26           (Bills Receivable / outstandings reports)
 * Normalise all to ISO (YYYY-MM-DD).
 */
function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const dm = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/.exec(s);
  if (dm) {
    const day = dm[1].padStart(2, '0');
    const mon = MONTHS[dm[2].toLowerCase()];
    let yr = dm[3];
    if (yr.length === 2) yr = (parseInt(yr, 10) >= 70 ? '19' : '20') + yr;
    if (mon) return `${yr}-${mon}-${day}`;
  }
  return s || null;
}

module.exports = {
  buildInfoRequest,
  buildLedgerRequest,
  buildVoucherRequest,
  buildVoucherTypesRequest,
  parseVoucherTypes,
  buildBillsRequest,
  buildVoucherCollectionRequest,
  buildCompanyFactsRequest,
  parseCompanyFacts,
  buildVoucherCountRequest,
  parseVoucherCounts,
  VOUCHER_STRATEGIES,
  VOUCHER_STRATEGY_ORDER,
  toTallyDate,
  postXml,
  testConnection,
  parseInfo,
  parseLedgers,
  parseVouchers,
  parseInventoryEntries,
  parseBills,
  // exported for tests / phase 2-3 work
  _internal: { extractBlocks, tagText, readBalance, responseError, normaliseDate }
};
