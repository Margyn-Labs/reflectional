/** Run: node tally-agent/inventory.test.js — zero-dep. */
const t = require('./tallyClient');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d) : ''))); };

const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
<VOUCHER VCHTYPE="Sales"><DATE>20260402</DATE><GUID>g1</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
<PARTYLEDGERNAME>Acme</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget A</STOCKITEMNAME><RATE>300.00/Nos</RATE><AMOUNT>30000.00</AMOUNT>
<ACTUALQTY> 100 Nos</ACTUALQTY><BILLEDQTY> 100 Nos</BILLEDQTY>
<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME></BATCHALLOCATIONS.LIST>
<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>30000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
</ALLINVENTORYENTRIES.LIST>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Bulk &amp; Co Sand</STOCKITEMNAME><RATE>1,200.50/Kg</RATE><AMOUNT>-1,200.50</AMOUNT><BILLEDQTY> 1,000.5 Kg</BILLEDQTY></ALLINVENTORYENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-30000.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Receipt"><DATE>20260403</DATE><GUID>g2</GUID><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
<LEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>30000.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;

const rows = t.parseVouchers(xml);
check('two vouchers parsed', rows.length === 2);
const a = rows[0].items;
check('sales voucher has 2 stock lines', a && a.length === 2, a);
check('line 1 fields', a[0].item === 'Widget A' && a[0].qty === 100 && a[0].unit === 'Nos' && a[0].rate === 300 && a[0].amount === 30000 && a[0].godown === 'Main Location', a[0]);
check('nested ledger allocation not mistaken for a stock line', a.every((x) => x.item !== 'Sales Account'));
check('entities, thousands separators, decimals', a[1].item === 'Bulk & Co Sand' && a[1].qty === 1000.5 && a[1].rate === 1200.5 && a[1].amount === -1200.5 && a[1].abs_amount === 1200.5, a[1]);
check('party entry unchanged and the nested Sales Account line is now an entry', rows[0].entries.length === 2 && rows[0].amount === 30000 && rows[0].entries.some((e) => e.ledger === 'Sales Account' && e.amount === 30000 && !e.is_party), rows[0].entries);
check('voucher without stock has items null', rows[1].items === null);
check('empty block -> []', t.parseInventoryEntries('<VOUCHER></VOUCHER>').length === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
