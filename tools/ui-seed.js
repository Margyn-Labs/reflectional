// Seeded (fake) state for tools/ui-shots.js. Runs INSIDE the page via
// page.evaluate(seedApp). Every name, number and GSTIN here is fictional.
//
// How it works: instead of overwriting each global by hand, it replaces
// sbClient.from() with a table-aware stub that returns the rows below, and
// window.fetch for /api/* with canned connector payloads (same shapes as
// api/_zoho/vitals.js, api/tally.js, api/reconcile.js, api/shopify.js). Then it
// calls the app's own refreshAll(), so the real loaders + renderers run and the
// screenshots reflect what production code does with realistic data.
//
// Scale: ~₹30 cr/yr revenue (≈ ₹2.5 cr/month), matching the first design partner.
// Connected: Razorpay, Zoho Books, Tally (2 companies), Shopify.
// Not connected (so the connect states still get screenshotted): Cashfree, Odoo.

async function seedApp() {
  const DAY = 86400000;
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const dayISO = (dOffset) => new Date(now + dOffset * DAY).toISOString().slice(0, 10);
  const minsAgo = (m) => iso(m * 60000);
  const UID = 'demo';

  // ---------- identity ----------
  currentUser = { id: UID, email: 'finance@anvaya.test', created_at: iso(120 * DAY) };
  currentProfile = { id: UID, company_name: 'Anvaya Home Goods Pvt Ltd', revenue_range: '25_50cr',
    industry: 'D2C / Home & kitchen', city: 'Pune', gst_number: '27AAKCA1234F1Z5', whatsapp_phone: '919876543210',
    preferences: Object.assign({}, window.__seedPrefs || {}) };
  if (window.__seedNoPrefsColumn) delete currentProfile.preferences;   // code deployed before the SQL

  // ---------- snapshots: 8 monthly readings, latest first ----------
  // Pulse trends up; latest month has a receivables stretch the findings talk about.
  const months = [
    // cash,     revenue,   netProfit, gstLeak, gstPayable, recvTotal, recv90,  paySoon
    // burn (monthly total spend) = revenue - net profit, so the seed is internally consistent.
    [18400000, 25600000, 1820000, 142000, 3100000, 31200000, 4600000, 8900000],
    [16900000, 24100000, 1640000, 118000, 2950000, 29400000, 3900000, 8200000],
    [15200000, 23800000, 1510000, 131000, 2880000, 28100000, 4100000, 7900000],
    [13900000, 22300000, 1270000, 164000, 2710000, 27900000, 4800000, 8400000],
    [12600000, 21900000, 1090000, 188000, 2690000, 26500000, 5200000, 8100000],
    [11800000, 20400000,  940000, 176000, 2500000, 25800000, 5600000, 7700000],
    [11100000, 19800000,  810000, 205000, 2440000, 24900000, 5900000, 7600000],
    [10400000, 18900000,  690000, 221000, 2320000, 24200000, 6300000, 7300000]
  ].map(r => [r[0], r[1], r[2], r[1] - r[2], ...r.slice(3)]);
  const settlementRowsSeed = [
    { id: 'setl_P9x2Lq81', date: dayISO(-1), gross: 1284500, net: 1259810, settled: false },
    { id: 'setl_P9vA0kR3', date: dayISO(-2), gross: 1172300, net: 1149760, settled: true },
    { id: 'setl_P9t7mWd0', date: dayISO(-3), gross: 1390800, net: 1364090, settled: true },
    { id: 'setl_P9rQ4nZ6', date: dayISO(-4), gross: 968400, net: 949770, settled: true },
    { id: 'setl_P9pH2cE9', date: dayISO(-5), gross: 1051200, net: 1031000, settled: true }
  ];
  const snaps = months.map((m, i) => {
    const inputs = { cash: m[0], revenue: m[1], netProfit: m[2], burn: m[3], gstLeak: m[4], gstPayable: m[5], recvTotal: m[6], recv90: m[7], paySoon: m[8] };
    const vitals = computeVitals(inputs);
    return {
      id: 'snap-' + i, user_id: UID, created_at: iso(i * 30 * DAY + 2 * 3600000),
      cash: m[0], revenue: m[1], net_profit: m[2], burn: m[3], gst_leak: m[4], gst_payable: m[5],
      recv_total: m[6], recv_90: m[7], pay_soon: m[8],
      vitals, pulse_score: computePulseScore(vitals), source: i === 0 ? 'resolved' : 'manual',
      confidence: i === 0 ? 0.75 : 0.5, input_provenance: null, source_conflicts: null,
      briefing: i === 1 ? 'A steadier month. Revenue rose 1% to ₹2.41 Cr and net profit to ₹16.4 L, a 6.8% margin. Receivables grew faster than sales, to ₹2.94 Cr, and ₹39 L of it is past 90 days; Urban Nest Retail is the largest overdue account. Cash ended at ₹1.69 Cr, up ₹17 L. GST payable was ₹29.5 L, with ₹1.18 L of input credit at risk from vendors who had not filed.' : i === 0 ? 'Collections are the story this month. Receivables rose to ₹3.12 Cr, and ₹46 L of it is past 90 days, mostly Urban Nest Retail and Kaveri Stores. Cash is up ₹15 L on last month, so there is no pressure yet, but three distributors now pay 20+ days later than their terms. GST: two vendors have not filed GSTR-1 for August, which puts ₹1.4 L of input credit at risk.' : null,
      briefing_generated_at: i === 0 ? minsAgo(95) : i === 1 ? iso(30 * DAY) : null,
      payments_data: i === 0 ? { gross: 5867200, mdr: 1.86, failed: 3.4, total: 6412, lag: 1.6, upiPct: 71 } : null,
      payments_source: i === 0 ? 'razorpay' : null,
      settlement_rows: i === 0 ? settlementRowsSeed : null,
      settlement_daily_trend: i === 0 ? [968400, 1051200, 1390800, 1172300, 1284500, 1412000, 1106300] : null,
      shopify_orders_data: null
    };
  });

  // ---------- manual ledger (receivables / payables) ----------
  const R = (id, party, amt, due, src) => ({ id, user_id: UID, party_name: party, amount: amt, due_date: dayISO(due), status: 'open', source: src || 'manual', created_at: iso(40 * DAY) });
  const receivablesSeed = [
    R('r1', 'Urban Nest Retail LLP', 2640000, -104), R('r2', 'Kaveri Stores', 1960000, -93),
    R('r3', 'Blue Door Interiors', 1185000, -47), R('r4', 'Hearth & Co. (Bengaluru)', 842500, -18),
    R('r5', 'Sahyadri Distributors', 2210000, -6), R('r6', 'Casa Loma Trading', 615400, 9),
    R('r7', 'Greenleaf Hospitality', 1378000, 21), R('r8', 'Modak Home Retail', 498000, 34)
  ];
  const payablesSeed = [
    R('p1', 'Shree Ganesh Packaging', 684000, -3), R('p2', 'Delhivery Ltd (freight)', 1126500, 4),
    R('p3', 'Omkar Steel Fabricators', 2390000, 7), R('p4', 'Meta Platforms (ads)', 1850000, 12),
    R('p5', 'Rathi Textiles', 972000, 19), R('p6', 'Warehouse rent, Chakan', 640000, 28)
  ];

  // ---------- findings (latest snapshot) ----------
  const F = (id, tier, vital, summary, narration, action, self) => ({ id, user_id: UID, snapshot_id: 'snap-0', tier, confidence_tier: tier, vital, summary, narration, suggested_action: action, self_reported: !!self, evidence: null, generated_at: minsAgo(100), created_at: minsAgo(100) });
  const findingsSeed = [
    F('f1', 'verified', 'Receivables Aging', '₹46 L of receivables is past 90 days, up from ₹39 L.', 'Urban Nest Retail (₹26.4 L, 104 days) and Kaveri Stores (₹19.6 L, 93 days) account for all of it. Zoho Books and the Razorpay feed agree that neither has paid since July.', 'Call Urban Nest this week and put new orders on advance payment until the July invoices clear.'),
    F('f2', 'signal', 'GST/ITC Leakage', '₹1.42 L of input credit is at risk from 2 vendors.', 'Rathi Textiles and Shree Ganesh Packaging have not filed GSTR-1 for August, so their invoices are missing from your GSTR-2B.', 'Ask both vendors to file before the 11th, or hold ₹1.42 L from their next payment.'),
    F('f3', 'verified', 'Cash Position', 'Cash is ₹1.84 Cr, up ₹15 L on last month.', 'Razorpay settlements averaged ₹12.1 L a day, and settlement lag held at 1.6 days.', null),
    F('f4', 'signal', 'Payables Due (30d)', '₹89 L of bills fall due in the next 30 days, ₹42 L of it in the next 7.', 'Omkar Steel (₹23.9 L) is the largest. Paying it on the 7th still leaves ₹1.4 Cr of cash.', 'Schedule Omkar Steel for the 7th.', true)
  ];

  // ---------- Khata (parties / entries / invoices) ----------
  const khataPartiesSeed = [
    { id: 'kp1', user_id: UID, name: 'Urban Nest Retail LLP', type: 'customer', phone: '919822000111', gstin: '27AABFU2231K1Z2', opening_balance: 0 },
    { id: 'kp2', user_id: UID, name: 'Kaveri Stores', type: 'customer', phone: '919845000222', gstin: '29AAKFK7781M1Z9', opening_balance: 250000 },
    { id: 'kp3', user_id: UID, name: 'Shree Ganesh Packaging', type: 'vendor', phone: '919890000333', gstin: '27AAGFS4410P1Z1', opening_balance: 0 },
    { id: 'kp4', user_id: UID, name: 'Hearth & Co. (Bengaluru)', type: 'both', phone: '919900000444', gstin: '29AAHFH9901Q1Z4', opening_balance: 0 },
    { id: 'kp5', user_id: UID, name: 'Rathi Textiles', type: 'vendor', phone: '919811000555', gstin: '07AABFR5520L1Z7', opening_balance: 120000 }
  ];
  const E = (id, party, type, amt, d, note) => ({ id, user_id: UID, party_id: party, entry_type: type, amount: amt, entry_date: dayISO(d), note: note || null, created_at: iso(-d * DAY) });
  const khataEntriesSeed = [
    E('ke1', 'kp1', 'sale', 1640000, -118, 'INV-2407-031'), E('ke2', 'kp1', 'sale', 1000000, -104, 'INV-2407-044'),
    E('ke3', 'kp2', 'sale', 1710000, -93, 'INV-2407-058'), E('ke4', 'kp2', 'receipt', 0, -60),
    E('ke5', 'kp3', 'purchase', 684000, -27, 'SGP/1182'), E('ke6', 'kp3', 'payment', 400000, -12),
    E('ke7', 'kp4', 'sale', 842500, -48, 'INV-2408-012'), E('ke8', 'kp4', 'purchase', 210000, -30, 'Samples'),
    E('ke9', 'kp5', 'purchase', 852000, -22, 'RT-0921'), E('ke10', 'kp4', 'receipt', 300000, -8)
  ];
  const INV = (id, party, cust, num, issue, due, sub, status, lines) => ({ id, user_id: UID, party_id: party, customer_name: cust, invoice_number: num, issue_date: dayISO(issue), due_date: dayISO(due), subtotal: sub, total: Math.round(sub * 1.18), gst_breakup: { cgst: Math.round(sub * 0.09), sgst: Math.round(sub * 0.09), igst: 0 }, status, notes: null, invoice_line_items: lines });
  const khataInvoicesSeed = [
    INV('ki1', 'kp4', 'Hearth & Co. (Bengaluru)', 'INV-2409-007', -6, 24, 714000, 'sent', [{ id: 'li1', description: 'Stoneware dinner set, 24 pc', quantity: 120, unit_price: 4200, gst_rate: 18 }, { id: 'li2', description: 'Linen table runner', quantity: 300, unit_price: 700, gst_rate: 18 }]),
    INV('ki2', 'kp1', 'Urban Nest Retail LLP', 'INV-2407-044', -104, -74, 847458, 'overdue', [{ id: 'li3', description: 'Brass serveware, assorted', quantity: 400, unit_price: 2118.6, gst_rate: 18 }]),
    INV('ki3', 'kp2', 'Kaveri Stores', 'INV-2407-058', -93, -63, 1449153, 'overdue', [{ id: 'li4', description: 'Cast-iron cookware kit', quantity: 520, unit_price: 2786.8, gst_rate: 18 }]),
    INV('ki4', 'kp4', 'Hearth & Co. (Bengaluru)', 'INV-2408-012', -48, -18, 713983, 'paid', [{ id: 'li5', description: 'Stoneware mugs, set of 6', quantity: 900, unit_price: 793.3, gst_rate: 18 }])
  ];

  // ---------- activity log + chat ----------
  const ledgerEventsSeed = [
    { id: 'le0', user_id: UID, entity_type: 'person', event: 'role_changed', party_name: 'Priya Mehta', amount: null, source: null, note: 'Viewer to Finance', actor_name: 'Arjun Kapoor', channel: 'app', created_at: minsAgo(60 * 2) },
    { id: 'le00', user_id: UID, entity_type: 'receivable', entity_id: 'r8', event: 'settled', party_name: 'Casa Loma Trading', amount: 431000, source: 'manual', note: 'marked received via WhatsApp', actor_name: 'Priya Mehta', channel: 'whatsapp', created_at: minsAgo(60 * 5) },
    { id: 'le1', user_id: UID, entity_type: 'receivable', entity_id: 'r9', event: 'settled', party_name: 'Hearth & Co. (Bengaluru)', amount: 300000, source: 'manual', note: 'marked received', created_at: minsAgo(60 * 8 * 24) },
    { id: 'le2', user_id: UID, entity_type: 'payable', entity_id: 'p9', event: 'settled', party_name: 'Shree Ganesh Packaging', amount: 400000, source: 'manual', note: 'marked paid', created_at: minsAgo(60 * 12 * 24) },
    { id: 'le3', user_id: UID, entity_type: 'receivable', entity_id: 'r5', event: 'created', party_name: 'Sahyadri Distributors', amount: 2210000, source: 'manual', note: null, created_at: minsAgo(60 * 36 * 24) }
  ];
  const chatSeed = [
    { id: 'c1', user_id: UID, thread_key: 'global', vital: null, role: 'user', content: 'Who owes us the most right now?', agent_id: 'margyn', created_at: minsAgo(180) },
    { id: 'c2', user_id: UID, thread_key: 'global', vital: null, role: 'assistant', content: 'Urban Nest Retail LLP, at ₹26.4 L across two July invoices, now 104 days past due. Kaveri Stores is next at ₹19.6 L.', agent_id: 'margyn', created_at: minsAgo(179) },
    { id: 'c3', user_id: UID, thread_key: 'vital:Cash Position', vital: 'Cash Position', role: 'user', content: 'Can we pay Omkar Steel on the 7th?', agent_id: 'margyn', created_at: minsAgo(60 * 26) },
    { id: 'c4', user_id: UID, thread_key: 'vital:Cash Position', vital: 'Cash Position', role: 'assistant', content: 'Yes. After ₹23.9 L to Omkar and the other bills due that week, cash would be about ₹1.41 Cr.', agent_id: 'margyn', created_at: minsAgo(60 * 26 - 1) }
  ];

  // ---------- Razorpay raw feed (for razorpayLiveSummary) ----------
  const methods = ['upi', 'upi', 'upi', 'card', 'netbanking', 'upi', 'wallet', 'upi', 'card', 'upi'];
  const txns = Array.from({ length: 60 }, (_, i) => ({ id: 'pay_' + i, user_id: UID, status: i % 29 === 7 ? 'failed' : 'captured', amount: (1800 + (i * 373) % 4200) * 100, method: methods[i % methods.length], created_at: minsAgo(i * 95) }));
  // Newest settlement is still on its way to the bank (status 'created'); the rest have reached it.
  const settles = Array.from({ length: 12 }, (_, i) => ({ id: 'setl_' + i, settlement_id: 'setl_' + i, user_id: UID, amount: 110000000, fee_deducted: 2090000, utr: i ? 'HDFCN2026' + (4410 + i) : null,
    status: i ? 'processed' : 'created', created_at: iso((i + 1) * DAY), processed_at: i ? iso((i - 0.4) * DAY) : null }));
  const refunds = [{ id: 'rfnd_1', user_id: UID, amount: 249900, created_at: minsAgo(400) }];

  // ---------- People / agents ----------
  const P = (ask, act, fwd, ob, cb) => ({ ask, act, forward: fwd, opening_bell: ob, closing_bell: cb });
  const stakeholdersSeed = [
    { id: 'a', business_id: UID, name: 'Aditi Kulkarni', phone: '919876543210', role: 'owner', is_primary: true, permissions: {}, message_count: 42, last_message_at: minsAgo(3), created_at: iso(90 * DAY) },
    { id: 'b', business_id: UID, name: 'Rohan Mehta', phone: '919820011223', role: 'owner', is_primary: false, whatsapp_access: true, permissions: P(true, true, true, true, false), message_count: 17, last_message_at: minsAgo(60 * 26), created_at: iso(60 * DAY) },
    { id: 'c', business_id: UID, name: 'Priya Nair', phone: '919930044556', role: 'AR', is_primary: false, whatsapp_access: true, permissions: P(true, false, true, false, false), message_count: 5, last_message_at: minsAgo(300), created_at: iso(30 * DAY) },
    { id: 'd', business_id: UID, name: 'Suresh Iyer', phone: '919811077889', role: 'AP', is_primary: false, permissions: {}, message_count: 0, created_at: iso(10 * DAY) }
  ];
  const deploymentsSeed = [
    { id: 'dep1', user_id: UID, agent_id: 'whatsapp_bell', status: 'active', config: { frequency: 'both' }, created_at: iso(80 * DAY) },
    { id: 'dep2', user_id: UID, agent_id: 'close_collections', status: 'active', config: {}, created_at: iso(40 * DAY) }
  ];

  const TABLES = {
    profiles: [currentProfile], snapshots: snaps, receivables: receivablesSeed, payables: payablesSeed,
    findings: findingsSeed, import_suggestions: [], ledger_parties: khataPartiesSeed, ledger_entries: khataEntriesSeed,
    invoices: khataInvoicesSeed, ledger_events: ledgerEventsSeed, chat_messages: chatSeed,
    connector_credentials: [{ id: 'cc1', user_id: UID, connector_type: 'razorpay', needs_reauth: false, last_success_at: minsAgo(60 * 7) }],
    connector_logs: [{ id: 'cl1', user_id: UID, connector_type: 'razorpay', created_at: minsAgo(60 * 7) }],
    razorpay_transactions: txns, razorpay_settlements: settles, razorpay_refunds: refunds,
    business_stakeholders: stakeholdersSeed, agent_deployments: deploymentsSeed
  };
  window.__seedTables = TABLES;

  // Table-aware query stub: any chained filter method returns the builder;
  // .eq() filters on fields the seeded row actually has (user/business ids are
  // ignored). Writes resolve OK and change nothing, except profiles.update(),
  // which applies to the seeded row and is logged in window.__profileUpdates
  // (so preference saves can be asserted). No network.
  window.__profileUpdates = [];
  const IGNORE = { user_id: 1, business_id: 1 };
  sbClient.from = (table) => {
    let rows = (TABLES[table] || []).slice(), err = null;
    const b = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve({ data: err ? null : rows, error: err }).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: rows[0] || null, error: null });
        if (prop === 'eq') return (k, v) => { if (!IGNORE[k]) rows = rows.filter(r => r[k] === undefined || r[k] === v); return b; };
        if (prop === 'update' && table === 'profiles') return (payload) => {
          if (window.__seedNoPrefsColumn && payload && 'preferences' in payload) { rows = []; err = { code: 'PGRST204', message: "Could not find the 'preferences' column of 'profiles' in the schema cache" }; return b; }
          window.__profileUpdates.push(JSON.parse(JSON.stringify(payload))); Object.assign(TABLES.profiles[0], payload); rows = []; return b;
        };
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') return () => { rows = []; return b; };
        return () => b;
      }
    });
    return b;
  };

  // ---------- /api/* connector payloads ----------
  const zohoRecv = [
    ['Urban Nest Retail LLP', 1640000, -118, 'INV-00231'], ['Urban Nest Retail LLP', 1000000, -104, 'INV-00244'],
    ['Kaveri Stores', 1960000, -93, 'INV-00258'], ['Blue Door Interiors', 1185000, -47, 'INV-00266'],
    ['Hearth & Co. (Bengaluru)', 842500, -18, 'INV-00281'], ['Sahyadri Distributors', 2210000, -6, 'INV-00290'],
    ['Casa Loma Trading', 615400, 9, 'INV-00297'], ['Greenleaf Hospitality', 1378000, 21, 'INV-00302']
  ].map(([p, a, d, ref]) => ({ party_name: p, amount: a, due_date: dayISO(d), doc_date: dayISO(d - 30), ref, status: d < 0 ? 'overdue' : 'sent', source: 'zoho_books' }));
  const zohoPay = [
    ['Shree Ganesh Packaging', 684000, -3, 'BILL-1182'], ['Delhivery Ltd', 1126500, 4, 'BILL-1190'],
    ['Omkar Steel Fabricators', 2390000, 7, 'BILL-1196'], ['Rathi Textiles', 972000, 19, 'BILL-1204']
  ].map(([p, a, d, ref]) => ({ party_name: p, amount: a, due_date: dayISO(d), doc_date: dayISO(d - 30), ref, status: d < 0 ? 'overdue' : 'open', source: 'zoho_books' }));
  const API = {
    'sync-razorpay?action=cashfree-status': { connected: false },
    'zoho?action=vitals': {
      connected: true, org_ref: 'zo1', organization_id: '60012345678', organization_name: 'Anvaya Home Goods Pvt Ltd', status: 'active',
      last_synced_at: minsAgo(60 * 5), backfill_completed_at: iso(35 * DAY),
      cash_position: { zoho_reported_balance: 18650000, gateway_settled_90d: 104200000, divergence_pct: 1.4, bank_data_available: false },
      receivables: { current: 1993400, days_1_30: 3052500, days_31_60: 1185000, days_61_90: 0, days_90_plus: 4600000, total: 31240000 },
      top_overdue_customers: [
        { customer_name: 'Urban Nest Retail LLP', invoice_number: 'INV-00231', balance: 1640000, days_overdue: 118 },
        { customer_name: 'Kaveri Stores', invoice_number: 'INV-00258', balance: 1960000, days_overdue: 93 },
        { customer_name: 'Blue Door Interiors', invoice_number: 'INV-00266', balance: 1185000, days_overdue: 47 }
      ],
      payables: { current: 4492500, due_this_week: 4200500, overdue: 684000, total: 8910000, projected_cash_after_this_weeks_payables: 14449500 },
      gst_leakage: { filing_period: '2026-08', total_leakage: 142000, vendors_not_filed: 2, leakage_pct: 4.6 },
      gst_top_at_risk_vendors: [
        { vendor_gstin: '07AABFR5520L1Z7', vendor_name: 'Rathi Textiles', at_risk: 104600 },
        { vendor_gstin: '27AAGFS4410P1Z1', vendor_name: 'Shree Ganesh Packaging', at_risk: 37400 }
      ],
      net_margin: { period: '2026-08', income: 25600000, cogs: 15100000, opex: 8680000, net_margin_pct: 7.1 },
      working_capital_runway: { adjusted_cash_position: 18650000, receivables_due_30d: 5200000, payables_due_30d: 8910000, avg_daily_burn: 130000, runway_days: 115 },
      flags: ['receivables_90_plus_rising'],
      receivables_list: zohoRecv, payables_list: zohoPay, briefing_hints: {}
    },
    'zoho?action=odoo-status': { connected: false },
    'reconcile?action=summary': {
      connected: true,
      counts: { verified: 38, signal: 6, needs_review: 3, unmatched: 2, pending_review: 3 },
      provenance: { source_a: 'zoho_books', source_b: 'razorpay', last_verified_at: minsAgo(60 * 6) },
      invoices: [
        { invoice_id: 'zi1', invoice_number: 'INV-00281', customer_name: 'Hearth & Co. (Bengaluru)', total: 842500, balance: 0, reconciliation_status: 'verified', verified_paid_amount: 842500 },
        { invoice_id: 'zi2', invoice_number: 'INV-00275', customer_name: 'Modak Home Retail', total: 612000, balance: 0, reconciliation_status: 'verified', verified_paid_amount: 612000 },
        { invoice_id: 'zi3', invoice_number: 'INV-00266', customer_name: 'Blue Door Interiors', total: 1185000, balance: 1185000, reconciliation_status: 'review', verified_paid_amount: null },
        { invoice_id: 'zi4', invoice_number: 'INV-00270', customer_name: 'Casa Loma Trading', total: 431000, balance: 0, reconciliation_status: 'verified', verified_paid_amount: 431000 }
      ],
      review_queue: [
        { id: 'rq1', invoice_ref: 'zi3', invoice_number: 'INV-00266', customer_name: 'Blue Door Interiors', amount: 1185000, reason: 'Two Razorpay payments of ₹5.9 L each, 3 days apart', same_source: false, date_diff_days: 3, candidates: [{ id:'pay_Q1a', amount:59250000, created_at: iso(12 * DAY), method:'upi' }, { id:'pay_Q1b', amount:59250000, created_at: iso(9 * DAY), method:'upi' }] },
        { id: 'rq2', invoice_ref: 'zi5', invoice_number: 'INV-00284', customer_name: 'Greenleaf Hospitality', amount: 318000, reason: 'Amount matches but payer name differs', same_source: false, date_diff_days: 1, candidates: [{ id:'pay_Q2a', amount:31800000, created_at: iso(3 * DAY), method:'netbanking' }] },
        { id: 'rq3', invoice_ref: 'zi6', invoice_number: 'INV-00288', customer_name: 'Sahyadri Distributors', amount: 204000, reason: 'Short-paid by ₹4,080 (likely TDS)', same_source: false, date_diff_days: 0, candidates: [{ id:'pay_Q3a', amount:19992000, created_at: iso(1 * DAY), method:'upi' }] }
      ]
    },
    'reconcile?action=agent-actions': {
      count: 3, by_kind: { split: 1, itc_risk: 1, journal: 1 },
      actions: [
        { id: 'aa1', kind: 'split', status: 'proposed', confidence: 0.92, title: 'Apply Blue Door Interiors’ two payments to INV-00266', rationale: 'Two UPI payments of ₹5,92,500 from the same VPA, 3 days apart, sum exactly to the invoice.', amount: 1185000, currency: 'INR', proposal: { allocations: [{ invoiceRef: 'INV-00266', amount: 592500 }, { invoiceRef: 'INV-00266', amount: 592500 }] }, created_at: minsAgo(60 * 6) },
        { id: 'aa2', kind: 'itc_risk', status: 'proposed', confidence: 0.81, title: 'Hold ₹1.05 L from Rathi Textiles until they file GSTR-1', rationale: 'Rathi Textiles’ August invoices are missing from your GSTR-2B.', amount: 104600, currency: 'INR', proposal: { vendorQueryDraft: 'Hi, our GSTR-2B for August does not show your invoices RT-0917 to RT-0921. Could you confirm when your GSTR-1 for August will be filed? We will release the held amount as soon as it reflects.' }, created_at: minsAgo(60 * 6) },
        { id: 'aa3', kind: 'journal', status: 'proposed', confidence: 0.88, title: 'Book TDS short-payment on INV-00288', rationale: 'Sahyadri Distributors paid ₹4,080 less than the invoice, which matches 2% TDS under 194Q.', amount: 4080, currency: 'INR', proposal: { journal: [{ account: 'TDS receivable', debit: 4080 }, { account: 'Sahyadri Distributors', credit: 4080 }] }, created_at: minsAgo(60 * 6) }
      ]
    },
    'shopify?action=status': { stores: [{ id: 'st1', shop_domain: 'anvaya-home.myshopify.com', status: 'active', backfill_complete: true, last_synced_at: minsAgo(60 * 3), counts: { orders: 18432, refunds: 611, variants: 942, payouts: 88 } }] },
    'tally?action=status': {
      connected: true,
      installs: [
        { id: 'ti1', status: 'active', tally_product: 'tallyprime', tally_version: '5.1', company_name: 'Anvaya Home Goods Pvt Ltd', machine_name: 'ACCTS-PC-01', last_sync_at: minsAgo(60 * 2), counts: { ledgers: 412, vouchers: 18650, bills: 236 }, last_run: { kind: 'incremental', status: 'success', rows_upserted: 214, started_at: minsAgo(60 * 2) } },
        { id: 'ti2', status: 'active', tally_product: 'tallyprime', tally_version: '5.1', company_name: 'Anvaya Exports LLP', machine_name: 'ACCTS-PC-01', last_sync_at: minsAgo(60 * 2), counts: { ledgers: 96, vouchers: 2140, bills: 31 }, last_run: { kind: 'incremental', status: 'success', rows_upserted: 18, started_at: minsAgo(60 * 2) } }
      ]
    },
    // Margin analytics (api/_lib/tallyAnalytics.js): generated from a small Anvaya-shaped book.
    'tally?action=analytics': {"provenance":"signal","basis":"Tally ledgers, vouchers and bills. One source; not yet corroborated by bank or GST. Sales figures exclude GST.","as_of":"2026-09-24T05:00:00.000Z","items_available":false,"period":{"from":"2026-04-05","to":"2026-09-28","gross_sales":16900000,"sales_returns":435200,"net_sales":16464800,"cogs_pre_stock":9887110,"gross_profit_pre_stock":6577690,"gross_margin_pct_pre_stock":39.95,"gross_profit_after_stock":null,"gross_margin_pct_after_stock":null,"opex":3446000,"other_income":0,"net_profit_after_stock":null,"net_profit_pre_stock":3131690,"net_margin_pct_after_stock":null},"pnl":[{"month":"2026-04","provisional":false,"gross_sales":2600000,"sales_returns":88400,"net_sales":2511600,"purchases":1474980,"direct_expense":65000,"direct_income":0,"cogs_pre_stock":1539980,"gross_profit_pre_stock":971620,"gross_margin_pct_pre_stock":38.69,"opex":544000,"other_income":0,"net_profit_pre_stock":427620,"net_margin_pct_pre_stock":17.03,"vouchers":12},{"month":"2026-05","provisional":false,"gross_sales":2900000,"sales_returns":98600,"net_sales":2801400,"purchases":1618200,"direct_expense":72500,"direct_income":0,"cogs_pre_stock":1690700,"gross_profit_pre_stock":1110700,"gross_margin_pct_pre_stock":39.65,"opex":586000,"other_income":0,"net_profit_pre_stock":524700,"net_margin_pct_pre_stock":18.73,"vouchers":12},{"month":"2026-06","provisional":false,"gross_sales":3100000,"sales_returns":105400,"net_sales":2994600,"purchases":1700970,"direct_expense":77500,"direct_income":0,"cogs_pre_stock":1778470,"gross_profit_pre_stock":1216130,"gross_margin_pct_pre_stock":40.61,"opex":614000,"other_income":0,"net_profit_pre_stock":602130,"net_margin_pct_pre_stock":20.11,"vouchers":12},{"month":"2026-07","provisional":false,"gross_sales":3000000,"sales_returns":102000,"net_sales":2898000,"purchases":1618200,"direct_expense":75000,"direct_income":0,"cogs_pre_stock":1693200,"gross_profit_pre_stock":1204800,"gross_margin_pct_pre_stock":41.57,"opex":600000,"other_income":0,"net_profit_pre_stock":604800,"net_margin_pct_pre_stock":20.87,"vouchers":12},{"month":"2026-08","provisional":false,"gross_sales":3400000,"sales_returns":40800,"net_sales":3359200,"purchases":1992060,"direct_expense":85000,"direct_income":0,"cogs_pre_stock":2077060,"gross_profit_pre_stock":1282140,"gross_margin_pct_pre_stock":38.17,"opex":656000,"other_income":0,"net_profit_pre_stock":626140,"net_margin_pct_pre_stock":18.64,"vouchers":12},{"month":"2026-09","provisional":true,"gross_sales":1900000,"sales_returns":0,"net_sales":1900000,"purchases":1060200,"direct_expense":47500,"direct_income":0,"cogs_pre_stock":1107700,"gross_profit_pre_stock":792300,"gross_margin_pct_pre_stock":41.7,"opex":446000,"other_income":0,"net_profit_pre_stock":346300,"net_margin_pct_pre_stock":18.23,"vouchers":11}],"stock":{"available":false,"reason":"balance_not_returned"},"cash":null,"cost_structure":[{"ledger":"Purchase - Raw Material","bucket":"purchases","amount":9464610,"pct_of_net_sales":57.48},{"ledger":"Salaries","bucket":"opex","amount":1859000,"pct_of_net_sales":11.29},{"ledger":"Office Rent","bucket":"opex","amount":1080000,"pct_of_net_sales":6.56},{"ledger":"Digital Marketing","bucket":"opex","amount":507000,"pct_of_net_sales":3.08},{"ledger":"Freight Inward","bucket":"direct_expense","amount":422500,"pct_of_net_sales":2.57}],"working_capital":{"receivables":10987500,"receivables_overdue":7837500,"payables":2390000,"stock_value":null,"cash":null,"dso_days":121.23,"dpo_days":46.06,"dio_days":null,"cash_conversion_days":null,"window_days":90,"note":"DSO/DPO/DIO use the last 90 days of vouchers."},"customers":[{"party":"Urban Nest Retail LLP","gross_sales":3718000,"returns":0,"net_sales":3718000,"returns_pct":0,"sales_90d":1826000,"outstanding":1640000,"overdue":1640000,"max_overdue_days":118,"dso_days":80.83,"credit_cost_pct_of_sales":2.66,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":37.29,"flags":["over_90_days"]},{"party":"Reliance Retail (AJIO Home)","gross_sales":3380000,"returns":0,"net_sales":3380000,"returns_pct":0,"sales_90d":1660000,"outstanding":3150000,"overdue":0,"max_overdue_days":0,"dso_days":170.78,"credit_cost_pct_of_sales":5.61,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":34.34,"flags":[]},{"party":"Sahyadri Distributors","gross_sales":3042000,"returns":0,"net_sales":3042000,"returns_pct":0,"sales_90d":1494000,"outstanding":2210000,"overdue":2210000,"max_overdue_days":6,"dso_days":133.13,"credit_cost_pct_of_sales":4.38,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":35.57,"flags":[]},{"party":"Blue Door Interiors","gross_sales":2366000,"returns":0,"net_sales":2366000,"returns_pct":0,"sales_90d":1162000,"outstanding":1185000,"overdue":1185000,"max_overdue_days":47,"dso_days":91.78,"credit_cost_pct_of_sales":3.02,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":36.93,"flags":[]},{"party":"Kaveri Stores","gross_sales":2704000,"returns":435200,"net_sales":2268800,"returns_pct":16.09,"sales_90d":1185200,"outstanding":1960000,"overdue":1960000,"max_overdue_days":93,"dso_days":148.84,"credit_cost_pct_of_sales":4.89,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":35.06,"flags":["over_90_days","high_returns"]},{"party":"Hearth & Co.","gross_sales":1690000,"returns":0,"net_sales":1690000,"returns_pct":0,"sales_90d":830000,"outstanding":842500,"overdue":842500,"max_overdue_days":18,"dso_days":91.36,"credit_cost_pct_of_sales":3,"margin_basis":"company_average_pre_stock","est_margin_pct":39.95,"est_margin_after_credit_pct":36.95,"flags":[]}],"items":[],"margin_bridge":null,"leaks":{"returns":{"value":435200,"pct_of_gross_sales":2.58},"discounts_booked":{"value":0,"pct_of_net_sales":0},"freight_and_carriage":{"value":422500,"pct_of_net_sales":2.57},"cancelled_vouchers":{"count":0,"value":0},"overdue_receivables":{"value":7837500,"pct_of_receivables":71.33},"carrying_cost_of_receivables_annual":{"value":1318500,"rate_assumed":0.12},"items_sold_below_cost":[],"items_without_cost":[]},"gst_estimate":[{"month":"2026-04","output_tax":468000,"input_tax":265496,"net_payable_estimate":202504,"tds_tcs_net":0},{"month":"2026-05","output_tax":522000,"input_tax":291276,"net_payable_estimate":230724,"tds_tcs_net":0},{"month":"2026-06","output_tax":558000,"input_tax":306175,"net_payable_estimate":251825,"tds_tcs_net":0},{"month":"2026-07","output_tax":540000,"input_tax":291276,"net_payable_estimate":248724,"tds_tcs_net":0},{"month":"2026-08","output_tax":612000,"input_tax":358571,"net_payable_estimate":253429,"tds_tcs_net":0},{"month":"2026-09","output_tax":342000,"input_tax":190836,"net_payable_estimate":151164,"tds_tcs_net":0}],"quality":{"confidence":"medium","reasons":["Tally returned no balance for 13 of 13 balance-sheet ledgers.","1 ledger(s) classified by guess, not by Tally group.","No stock balance: margin is before stock movement.","Stock lines not synced yet, so item-level margin is unavailable (agent update pending).","Single source (Tally). Not yet corroborated by bank or GST."],"coverage":{"from":"2026-04-05","to":"2026-09-28","vouchers":71,"cancelled":0,"months":6},"unclassified_ledgers":[],"guessed_ledgers":[{"ledger":"Digital Marketing","parent":"Marketing Spend","guessed_as":"opex","vouchers":6,"volume":507000}],"tie_out":[{"ledger":"Sales - Domestic","vouchers_movement":16464800,"tally_movement":16464800,"ok":true},{"ledger":"Purchase - Raw Material","vouchers_movement":9464610,"tally_movement":9464610,"ok":true},{"ledger":"Salaries","vouchers_movement":1859000,"tally_movement":1859000,"ok":true},{"ledger":"Office Rent","vouchers_movement":1080000,"tally_movement":1080000,"ok":true},{"ledger":"Digital Marketing","vouchers_movement":507000,"tally_movement":507000,"ok":true},{"ledger":"Freight Inward","vouchers_movement":422500,"tally_movement":422500,"ok":true}],"balance_sign":{"convention":"same","assumed":false,"evidence_ledgers":6},"balance_sheet_balances":{"missing":13,"total":13},"excluded_non_accounting_vouchers":{"count":1,"by_type":{"Sales Order":1}},"sync":[{"kind":"ledgers","status":"ok","error":null,"at":"2026-09-24T03:00:00Z","received":null},{"kind":"vouchers","status":"ok","error":null,"at":"2026-09-24T03:00:00Z","received":null},{"kind":"bills","status":"ok","error":null,"at":"2026-09-24T03:00:00Z","received":null}],"sales_vouchers_without_party":0,"sales_vouchers_without_items":null,"current_month_provisional":"2026-09"},"questions":[{"kind":"classify_ledger","ledger":"Digital Marketing","suggested":"opex","why":"Group “Marketing Spend” is custom. I guessed opex. Confirm so the margin is right."},{"kind":"stock_missing","why":"Tally sent the Stock-in-hand ledger but no balance for it (it often leaves balance-sheet ledgers empty), so gross margin is before stock movement. If you hold inventory, margin is overstated or understated by the change in stock."}],"headlines":["Gross margin (before stock movement) was 38.2% in Aug 2026, down 3.4 points from 41.6% in Jul 2026.","Net sales rose 15.9% from Jul 2026 to Aug 2026.","Returns and credit notes are 2.6% of gross sales.","Customers take about 121 days to pay on the last 90 days of sales. Carrying ₹1,09,87,500 owed to you at 12% costs about ₹13,18,500 a year."],"assumptions":{"credit_rate_annual":0.12,"margin_window":"period","dso_window_days":90},"connected":true,"company_name":"Anvaya Home Goods Pvt Ltd","companies":["Anvaya Home Goods Pvt Ltd"],"last_sync_at":"2026-09-24T03:00:00Z"},
    'tally?action=classify': () => { (window.__tallyCalls = window.__tallyCalls || []).push('classify'); return { ok: true }; },
    'tally?action=summary': {
      connected: true, company_name: 'Anvaya Home Goods Pvt Ltd', as_of: minsAgo(60 * 2),
      bills: {
        receivable_total: 30480000, payable_total: 9120000, overdue_total: 8210000, count: 267,
        items: [
          { direction: 'receivable', party_name: 'Urban Nest Retail LLP', bill_ref: 'AHG/24-25/231', bill_date: dayISO(-148), due_date: dayISO(-118), amount: 1640000, overdue_days: 118 },
          { direction: 'receivable', party_name: 'Kaveri Stores', bill_ref: 'AHG/24-25/258', bill_date: dayISO(-123), due_date: dayISO(-93), amount: 1960000, overdue_days: 93 },
          { direction: 'receivable', party_name: 'Blue Door Interiors', bill_ref: 'AHG/24-25/266', bill_date: dayISO(-77), due_date: dayISO(-47), amount: 1185000, overdue_days: 47 },
          { direction: 'payable', party_name: 'Omkar Steel Fabricators', bill_ref: 'OSF/0911', bill_date: dayISO(-23), due_date: dayISO(7), amount: 2390000, overdue_days: null },
          { direction: 'payable', party_name: 'Shree Ganesh Packaging', bill_ref: 'SGP/1182', bill_date: dayISO(-33), due_date: dayISO(-3), amount: 684000, overdue_days: 3 }
        ]
      },
      vouchers: { count: 20790, by_type: { Sales: 14210, Receipt: 3120, Purchase: 1840, Payment: 1290, Journal: 330 }, sales_30d: 25120000, receipts_30d: 22840000, recent: [] },
      ledgers: { count: 508, items: [
        { name: 'HDFC Bank CA 0021', parent: 'Bank Accounts', closing_balance: 15230000 },
        { name: 'ICICI Bank CA 7780', parent: 'Bank Accounts', closing_balance: 3190000 },
        { name: 'Cash', parent: 'Cash-in-Hand', closing_balance: 84000 },
        { name: 'HDFC OD A/c 5512', parent: 'Bank OD A/c', closing_balance: -2500000 },
        { name: 'Sundry Debtors', parent: 'Current Assets', closing_balance: 30480000 },
        { name: 'Sundry Creditors', parent: 'Current Liabilities', closing_balance: -9120000 }
      ] },
      provenance: 'signal'
    }
  };
  // The server position (api/_lib/moneyModel.js), built here from the same
  // seeded rows through the app's local model, so every page renders through
  // the server path (mgGroupsFromPos) exactly as it does in production.
  API['reconcile?action=position'] = () => {
    const dirOut = dir => {
      const groups = mgMoneyGroupsLocal(dir).map(g => ({
        key: g.key, party: g.party, amount: g.amount, primary: g.primary, sources: g.sources, status: g.status, diff: g.diff,
        oldest_days: g.oldestDays, open_items: g.invoices, overdue: g.overdue, due_7d: g.due7,
        by: Object.fromEntries(g.sources.map(s => [s, { amount: g.by[s].amount, rows: g.by[s].rows.map(r => Object.assign({ party: r.party, ref: r.ref, amount: r.amount, due: r.due, days: r.days }, r.raw && r.raw.id != null ? { id: r.raw.id } : {})) }]))
      }));
      const coverage = {};
      groups.forEach(g => g.sources.forEach(s => { coverage[s] = coverage[s] || { rows: 0, truncated: false, cap: 20000 }; coverage[s].rows += g.by[s].rows.length; }));
      return { groups, totals: { parties: groups.length, total: groups.reduce((t, g) => t + g.amount, 0) }, coverage, errors: {} };
    };
    return { as_of: dayISO(0), receivables: dirOut('recv'), payables: dirOut('pay') };
  };
  // Team logins (19g-team.js): the owner, two people and an open invite.
  window.__teamCalls = [];
  API['ops?action=team-whoami'] = { ready: true, features: { audit_actor: true, member_prefs: true, phone_link: true }, me: { id: UID, email: 'owner@anvaya.in' }, own_account: { account_id: UID, company_name: 'Anvaya Home Goods Pvt Ltd' }, memberships: [] };
  API['ops?action=team-list'] = {
    you: { user_id: UID, role: 'owner', can_manage: true, is_owner: true },
    owner: { user_id: UID, email: 'owner@anvaya.in', name: 'Arjun Kapoor', role: 'owner', role_label: 'Owner' },
    members: [
      { id: 'tm1', user_id: 'u-priya', email: 'priya@anvaya.in', name: 'Priya Mehta', role: 'finance', role_label: 'Finance', overrides: {}, permissions: ['view_cash', 'view_receivables', 'view_payables', 'view_gst', 'edit', 'approve'], status: 'active', joined_at: iso(12 * DAY), last_seen_at: minsAgo(90), whatsapp: '919876543210' },
      { id: 'tm2', user_id: 'u-ca', email: 'rao@raoandco.in', name: 'S. Rao (CA)', role: 'advisor', role_label: 'Advisor (CA)', overrides: {}, permissions: ['view_cash', 'view_receivables', 'view_payables', 'view_gst'], status: 'active', joined_at: iso(5 * DAY), last_seen_at: null }
    ],
    invites: [{ id: 'ti1', email: 'ravi@anvaya.in', name: 'Ravi', role: 'approver', role_label: 'Approver', expires_at: iso(-5 * DAY) }]
  };
  API['ops?action=team-update'] = () => { window.__teamCalls.push('update'); return { ok: true }; };
  API['ops?action=team-prefs'] = () => { window.__teamCalls.push('prefs'); return { ok: true }; };
  API['ops?action=team-invite'] = () => { window.__teamCalls.push('invite'); return { invite_id: 'ti2', email: 'new@anvaya.in', role: 'viewer', role_label: 'Viewer', code: 'K7QM-4XPA-9TRW', link: 'https://www.margynlabs.com/app.html#/join?code=K7QM-4XPA-9TRW', expires_at: iso(-7 * DAY), emailed: false }; };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const m = url.match(/\/api\/(.+)$/);
    if (!m) return realFetch(input, init);
    const key = Object.keys(API).find(k => m[1].startsWith(k));
    const body = key ? (typeof API[key] === 'function' ? API[key]() : API[key]) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // ---------- globals the loaders don't set ----------
  agentStakeholders = stakeholdersSeed;
  agentDeployments = { whatsapp_bell: deploymentsSeed[0], close_collections: deploymentsSeed[1] };
  ledgerEvents = ledgerEventsSeed;

  document.querySelectorAll('.gate').forEach(g => g.classList.add('hidden'));
  document.getElementById('appShell').classList.remove('hidden');
  // A signed-in session, so calls that need a token (the position) are made.
  try { sbClient.auth.getSession = async () => ({ data: { session: { access_token: 'seed-token', user: { id: UID } } } }); } catch (e) {}
  // The What's new card opens over the app after a release; the harness is
  // an account that has already seen it (it would block every click).
  try { if(typeof MG_RELEASES !== 'undefined' && MG_RELEASES.length) localStorage.setItem('margyn_whats_new_seen', MG_RELEASES[0].id); } catch (e) {}
  // Who is signed in (19g-team.js), through the real whoami path: the owner.
  if (typeof mgResolveAccount === 'function') { await mgResolveAccount({ id: UID, email: 'owner@anvaya.in' }); }
  await refreshAll();
  if (typeof mgApplyActor === 'function') mgApplyActor();
  // refreshAll's resolve step may write a fresh snapshot (stubbed to no-op);
  // make sure the seeded history is what every view renders.
  snapshots = snaps;
  try { renderHeader(); renderScores(); renderSummary(); } catch (e) { console.error('[seed] rerender', e); }
}

module.exports = { seedApp };
