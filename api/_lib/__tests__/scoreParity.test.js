/**
 * One scoring rule whatever the books system. Run: node api/_lib/__tests__/scoreParity.test.js
 *
 * 1 Nov 2026: the same books scored differently by source. Zoho took sales/profit from one month, Odoo had none and
 * counted every bill as due soon. Loads app/js/15-scoring.js as the browser does and feeds Tally, Zoho Books and Odoo
 * the same monthly P&L and the same open invoices and bills.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

const code = fs.readFileSync(path.join(__dirname, '../../../app/js/15-scoring.js'), 'utf8');
function load(g) {
  const ctx = vm.createContext(Object.assign({ console, Math, Number, isFinite, Date, JSON, Object, Array, String,
    daysFromToday: () => 0, mgMarCompany: '', snapshots: [], receivables: [], payables: [] }, g));
  vm.runInContext(code + '\n;this.__f = { tallyInputCandidates, zohoInputCandidates, odooInputCandidates, resolveSnapshotInputs };', ctx);
  return ctx.__f;
}

const pnl = [
  { month: '2026-04', net_sales: 400000, cogs_pre_stock: 100000, opex: 80000, net_profit_pre_stock: 220000 },
  { month: '2026-05', net_sales: 500000, cogs_pre_stock: 120000, opex: 0, net_profit_pre_stock: 380000, costs_incomplete: true },
  { month: '2026-06', net_sales: 600000, cogs_pre_stock: 150000, opex: 90000, net_profit_pre_stock: 360000 },
  { month: '2026-07', net_sales: 0, cogs_pre_stock: 0, opex: 50000, net_profit_pre_stock: -50000 },
  { month: '2026-08', net_sales: 800000, cogs_pre_stock: 200000, opex: 100000, net_profit_pre_stock: 500000 },
  { month: '2026-09', net_sales: 300000, cogs_pre_stock: 50000, opex: 40000, net_profit_pre_stock: 210000, provisional: true }
];
const gst = [{ month: '2026-08', net_payable_estimate: 12000 }];
const mar = (src) => ({ books_source: src, pnl, gst_estimate: gst });
const rowsRecv = [{ amount: 100000, days: 5 }, { amount: 50000, days: -40 }, { amount: 70000, days: -120 }];
const rowsPay = [{ amount: 30000, days: 10 }, { amount: 20000, days: -200 }, { amount: 90000, days: 45 }, { amount: 5000, days: null }];
const pos = (src) => ({
  receivables: { coverage: { [src]: { rows: 3, truncated: false } }, groups: [{ primary: src, by: { [src]: { rows: rowsRecv } } }] },
  payables: { coverage: { [src]: { rows: 4, truncated: false } }, groups: [{ primary: src, by: { [src]: { rows: rowsPay } } }] }
});

// Tally: bills tied to ledgers / supplier ledgers is when Tally reads the position list
const posT = pos('tally');
posT.receivables.coverage.tally.basis = 'bills_tied_to_ledgers';
posT.payables.coverage.tally.basis = 'supplier_ledgers';
const T = load({ tallyData: { connected: true, bills: { receivable_total: 1, receivable_over_90: 1, payable_due_30d: 1 }, vouchers: { sales_30d: 1 }, ledgers: { items: [] } },
  mgMar: mar('tally'), mgPos: posT, zohoConnected: false, zohoVitals: null, odooConnected: false, odooStatus: null }).tallyInputCandidates();
// Zoho: the vitals say something else (one month, every bill); the shared answers must win
const Z = load({ tallyData: null, zohoConnected: true,
  zohoVitals: { receivables: { total: 9, days_90_plus: 9 }, working_capital_runway: { payables_due_30d: 145000 }, net_margin: { income: 800000, cogs: 200000, opex: 100000 }, cash_position: {} },
  mgMar: mar('zoho'), mgPos: pos('zoho'), odooConnected: false, odooStatus: null }).zohoInputCandidates();
const O = load({ tallyData: null, zohoConnected: false, zohoVitals: null, odooConnected: true,
  odooStatus: { receivables: { total: 9 }, payables: { total: 145000 }, cash_position: {} }, mgMar: mar('odoo'), mgPos: pos('odoo') }).odooInputCandidates();

// Expected by hand: closed months with sales = Apr, May, Jun, Aug (Jul no sales, Sep provisional); May costs incomplete → Apr, Jun, Aug
const exp = { revenue: 600000, burn: 240000, netProfit: 360000, gstPayable: 12000, recvTotal: 220000, recv90: 70000, paySoon: 55000 };
for (const k of Object.keys(exp)) {
  check(k + ': Tally = hand-worked figure', Math.round(T[k]) === exp[k], { k, T: T[k] });
  check(k + ': Zoho Books = Tally', Math.round(Z[k]) === Math.round(T[k]), { k, Z: Z[k], T: T[k] });
  check(k + ': Odoo = Tally', Math.round(O[k]) === Math.round(T[k]), { k, O: O[k], T: T[k] });
}

// The Margin answer belongs to one books system: Zoho never scores on Tally's P&L
const Zx = load({ tallyData: null, zohoConnected: true, zohoVitals: { net_margin: { income: 800000, cogs: 200000, opex: 100000 } },
  mgMar: mar('tally'), mgPos: null, odooConnected: false, odooStatus: null }).zohoInputCandidates();
check("Zoho keeps its own figure when the Margin answer is another source's", Zx.revenue === 800000, Zx);
// A list cut off at the cap is not used
const cut = pos('zoho'); cut.payables.coverage.zoho.truncated = true;
const Zc = load({ tallyData: null, zohoConnected: true, zohoVitals: { working_capital_runway: { payables_due_30d: 145000 } },
  mgMar: null, mgPos: cut, odooConnected: false, odooStatus: null }).zohoInputCandidates();
check('a cut-off list falls back to the vitals figure', Zc.paySoon === 145000 && Zc.recvTotal === 220000, Zc);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
