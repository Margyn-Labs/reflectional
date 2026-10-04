/* ============================================================
   HOW EVERY NUMBER IS WORKED OUT, and how Margyn itself works.
   Shared by the browser (the explain tool on a call and in the Margyn
   panel, which adds the live inputs: 23-voice-tools.js) and the server
   (the how_its_calculated tool on WhatsApp and typed chat:
   api/_lib/booksTools.js). One text, so Margyn explains a figure the same
   way everywhere, the way an accountant would: what it is, the formula,
   which inputs and where each comes from, the bands, and what can make it
   look off.

   THIS FILE MUST MATCH THE CODE. Each entry names the function it
   describes (`code`). Change the maths there, change the words here, in
   the same PR. api/_lib/__tests__/formulas.test.js checks the constants
   that both sides quote (weights, bands, tolerances).
   ============================================================ */
(function (root) {
  // The scoring constants, as written in app/js/15-scoring.js (BENCH, VITAL_WEIGHTS, CONFLICT_TOLERANCE).
  const BANDS = { runwayMax: 6, recvBad: 0.3, paySafe: 0.5, gstBad: 0.15, marginGood: 15 };
  const WEIGHTS = { 'Cash Position': 0.20, 'Receivables Aging': 0.15, 'Payables Due (30d)': 0.15, 'GST/ITC Leakage': 0.15, 'Net Margin': 0.20, 'Working Capital Runway': 0.15 };
  const TOLERANCE = 0.02;

  const SRC = 'Each input comes from the most trusted source that has it: Zoho Books, then Tally, then Odoo, then what was typed in by hand. When two connected sources agree within 2% (or ₹1) the input is "verified"; one source is a "signal"; typed in is "self-reported". When sources disagree, the higher one in that order is used and the gap is flagged. Margyn never averages two sources.';

  const F = {
    pulse_score: {
      label: 'Pulse Score', aliases: ['pulse', 'health score', 'score', 'overall score'],
      what: 'A 0 to 100 reading of financial health, made of six vitals. Not a credit score.',
      formula: 'Pulse Score = round( 20% × Cash Position + 15% × Receivables Aging + 15% × Payables Due + 15% × GST/ITC Leakage + 20% × Net Margin + 15% × Working Capital Runway ), each vital scored 0 to 100.',
      inputs: ['the six vital scores (ask about any one for its own formula)'],
      notes: ['Pure arithmetic in the browser (computePulseScore). The AI writes the briefing, it never sets the score.', 'By default 70 and above is Healthy and below 40 is at risk; the cut-offs can be changed in Settings.', SRC],
      code: '15-scoring.js computePulseScore, VITAL_WEIGHTS', page: 'scores'
    },
    cash_vital: {
      label: 'Cash Position (vital)', aliases: ['cash position score', 'cash vital', 'months of cash'],
      what: 'How many months of spending your cash covers.',
      formula: 'Months = cash ÷ monthly spend. Score = 100 at 6 months or more, 0 at zero or less, and in between (months ÷ 6) × 100.',
      inputs: ['cash', 'burn'], weight: 'Cash Position',
      notes: ['If monthly spend is zero or unknown, months is shown as 0.'],
      code: '15-scoring.js scoreCash', page: 'cash'
    },
    receivables_vital: {
      label: 'Receivables Aging (vital)', aliases: ['receivables score', 'receivables aging', 'ageing score'],
      what: 'How much of what customers owe has gone stale (over 90 days past due).',
      formula: 'Share = receivables over 90 days ÷ total receivables. Score = 100 − (share ÷ 30%) × 100, kept between 0 and 100. So 0% stale scores 100, 15% scores 50, 30% or more scores 0.',
      inputs: ['recvTotal', 'recv90'], weight: 'Receivables Aging',
      code: '15-scoring.js scoreReceivables', page: 'receivables'
    },
    payables_vital: {
      label: 'Payables Due (vital)', aliases: ['payables score', 'payables due score'],
      what: 'Bills due in the next 30 days against the cash you have.',
      formula: 'Ratio = payables due in 30 days ÷ cash. Score = 100 − (ratio ÷ 50%) × 100, kept between 0 and 100. Bills worth half your cash or more scores 0. With no cash and bills due, the score is 0.',
      inputs: ['paySoon', 'cash'], weight: 'Payables Due (30d)',
      code: '15-scoring.js scorePayables', page: 'payables'
    },
    gst_vital: {
      label: 'GST/ITC Leakage (vital)', aliases: ['gst score', 'itc leakage', 'gst leakage'],
      what: 'Input tax credit you claimed that your vendors have not confirmed (not in GSTR-2B), against the GST you owe.',
      formula: 'Ratio = ITC at risk ÷ GST payable. Score = 100 − (ratio ÷ 15%) × 100, kept between 0 and 100. Leakage of 15% of GST payable or more scores 0.',
      inputs: ['gstLeak', 'gstPayable'], weight: 'GST/ITC Leakage',
      notes: ['Leakage comes from Zoho Books\' GSTR-2B match today. Until the GST portal connection is live, GST payable is Tally\'s estimate or what you typed in.'],
      code: '15-scoring.js scoreGst', page: 'gst'
    },
    margin_vital: {
      label: 'Net Margin (vital)', aliases: ['margin score', 'net margin vital'],
      what: 'Net profit as a share of revenue, per month.',
      formula: 'Margin % = net profit ÷ revenue × 100. Score = 100 at 15% or more; between 0% and 15% it is (margin ÷ 15) × 100; at a loss it is 50 + margin %, kept at 0 or more (so −10% scores 40).',
      inputs: ['netProfit', 'revenue'], weight: 'Net Margin',
      notes: ['Known quirk: just above zero scores lower than just below zero (+1% scores about 7, −1% scores 49). That is how the score is built today; flag it if they ask why.'],
      code: '15-scoring.js scoreMargin', page: 'margin'
    },
    runway: {
      label: 'Working Capital Runway', aliases: ['runway', 'working capital runway', 'how long will cash last', 'months of runway'],
      what: 'How many months your working capital covers your monthly spend. Shown on Cash as "Runway" and is the sixth vital.',
      formula: 'Runway (months) = (cash + money customers owe − bills due in 30 days) ÷ monthly spend. Score = 100 at 6 months or more, 0 at zero or less, else (months ÷ 6) × 100.',
      inputs: ['cash', 'recvTotal', 'paySoon', 'burn'], weight: 'Working Capital Runway',
      notes: ['It counts all receivables as if collected, so slow payers make it look better than it feels. The 13-week forecast is the week-by-week view.', 'Gross runway (cash ÷ spend) and net runway (cash ÷ (spend − revenue)) are on Reports.'],
      code: '15-scoring.js scoreRunway; 19d-cash.js Runway tile', page: 'cash'
    },
    cash: {
      label: 'Cash position', aliases: ['cash', 'bank balance', 'cash balance', 'how much cash'],
      what: 'Money you can spend today: bank and cash-in-hand, not borrowed money.',
      formula: 'Tally: the closing balances of every ledger under Bank Accounts or Cash-in-Hand (and sweep deposits), added up. Overdraft, cash credit and loan ledgers are left out: that is borrowed money. Zoho Books: the bank balance Zoho reports (only when your plan has bank feeds). Odoo: its liquidity accounts.',
      inputs: ['cash'],
      notes: ['Tally exports sometimes flip the sign of bank balances. Margyn takes the sign most of your bank ledgers carry as "in credit" and treats the rest as overdrawn.', 'Negative or implausible cash is usually a sync or sign issue, not reality: check the ledgers on the Cash page.', SRC],
      code: '15-scoring.js tallyCashBalance, tallyLiquidLedgers, zohoInputCandidates', page: 'cash'
    },
    burn: {
      label: 'Monthly spend', aliases: ['burn', 'spend', 'monthly spend', 'expenses', 'monthly costs'],
      what: 'What the business spends in a typical month.',
      formula: 'Tally: the average over up to six closed months of (purchases + direct expenses + running costs). A month whose running costs are under 40% of the usual is left out because its costs are not booked yet. Zoho Books: cost of goods + operating expenses.',
      inputs: ['burn'],
      code: '15-scoring.js tallyInputCandidates; tallyAnalytics.js costs_incomplete', page: 'margin'
    },
    revenue: {
      label: 'Monthly revenue', aliases: ['revenue', 'sales', 'monthly sales', 'turnover'],
      what: 'Sales in a typical month, before GST.',
      formula: 'Tally: the average over up to six closed months of net sales (sales − sales returns), before GST. If there is no monthly P&L yet, sales in the last 30 days. Zoho Books: income.',
      inputs: ['revenue'],
      notes: ['For any exact period ("sales in August", "this year") the books tools add up every Tally entry instead.'],
      code: '15-scoring.js tallyInputCandidates; tallyAnalytics.js net_sales', page: 'margin'
    },
    net_profit: {
      label: 'Net profit', aliases: ['profit', 'net profit', 'monthly profit'],
      what: 'What is left after every cost, per month.',
      formula: 'Tally: net sales + direct income − (purchases + direct expenses) + other income − running costs, averaged over up to six closed months. This is before the stock adjustment, so a month you bought ahead for stock looks worse than it is. Zoho Books: income − (cost of goods + operating expenses).',
      inputs: ['netProfit'],
      code: 'tallyAnalytics.js net_profit_pre_stock; 15-scoring.js zohoInputCandidates', page: 'margin'
    },
    gross_margin: {
      label: 'Gross margin', aliases: ['gross margin', 'gross profit', 'margin %'],
      what: 'What you keep from sales after the direct cost of what you sold.',
      formula: 'Gross profit = net sales + direct income − (purchases + direct expenses). Gross margin % = gross profit ÷ net sales × 100. "Before stock" ignores the change in stock; "after stock" adds (closing − opening stock) when Tally sends stock values.',
      inputs: [],
      notes: ['Which ledger counts as purchases, direct expense or running cost follows its Tally group, with Margyn\'s classification for unclear ones (shown, and correctable, on Margin).', 'One source (Tally), so it is a signal until bank or GST data corroborates it.'],
      code: 'tallyAnalytics.js gross_profit_pre_stock, gross_margin_pct_after_stock', page: 'margin'
    },
    product_margin: {
      label: 'Product margin', aliases: ['product margin', 'item margin', 'sku margin'],
      what: 'What you make on each item.',
      formula: 'Margin per unit = average selling price − average purchase cost. Margin % = margin ÷ selling price. For kits you assemble, cost = the cost of their parts from Manufacturing Journals.',
      inputs: [],
      notes: ['A unit mix-up (bought by the box, sold by the piece) shows as a huge or negative margin; Margyn flags those.'],
      code: 'booksEngine.js products', page: 'margin'
    },
    receivables: {
      label: 'Receivables', aliases: ['receivables', 'who owes me', 'money owed to me', 'debtors', 'outstanding'],
      what: 'Everything customers still owe you, one line per customer.',
      formula: 'Each customer appears once. Their amount comes from the most trusted source that has them (Zoho Books, then Tally, then Odoo, then manual entries). Other sources are compared with it and never added. Total = the sum of those amounts. Ageing buckets go by days past the due date: current and 0–30, 31–60, 61–90, 90+.',
      inputs: ['recvTotal', 'recv90'],
      notes: ['Sources "agree" for a customer when they differ by at most ₹1 or 2%. Otherwise the line is marked as a conflict with each source\'s amount.', 'Tally bills come from its bill-wise outstanding. A bill with no due date is treated as due now.', 'Days late are counted from the due date to today (India date), not frozen at the last Tally sync.', 'A customer\'s on-account money or credit balance in Tally is not counted as something you owe a vendor, and not as a bill they owe you.', 'Each source\'s own total is shown side by side on the page (switch the view); they are never summed together.'],
      code: '19-pages.js mgMoneyGroups; api/_lib/moneyModel.js', page: 'receivables'
    },
    payables: {
      label: 'Payables', aliases: ['payables', 'what i owe', 'bills due', 'creditors'],
      what: 'What you owe vendors, one line per vendor, same rules as receivables.',
      formula: 'One line per vendor from the most trusted source, others compared not added. "Due in 30 days" (the vital) = bills whose due date is within 30 days, plus bills with no due date.',
      notes: ['When Tally doesn\'t keep supplier bills one by one (most suppliers bought from last month have no open bill), Tally\'s few stray bills are not used. Each supplier\'s open bills are rebuilt from the entries: opening balance first, then purchases; payments, returns and debit notes settle the oldest first. Due date = bill date + how many days you usually take to pay that supplier (else everyone\'s usual); a balance carried from last year is dated 1 April. Money paid ahead to a supplier is shown apart, never netted against what you owe others.'],
      inputs: ['paySoon'],
      code: '19-pages.js mgMoneyGroups; 15-scoring.js tallyInputCandidates; api/_lib/moneyModel.js loadTally; cashFlowModel.js supplierOpenItems', page: 'payables'
    },
    gst_payable: {
      label: 'GST payable', aliases: ['gst payable', 'gst due', 'how much gst'],
      what: 'GST due for the month.',
      formula: 'From Tally: last closed month\'s output tax (GST on sales) − input tax credit (GST on purchases), from the duty ledgers, never below zero (a credit carries forward). Due around the 20th.',
      inputs: ['gstPayable'],
      notes: ['An estimate from your books until the GST portal connection lands; the filed return is the real number.'],
      code: '15-scoring.js tallyInputCandidates; tallyAnalytics.js gst_estimate', page: 'gst'
    },
    forecast: {
      label: '13-week cash forecast', aliases: ['forecast', 'cash forecast', '13 week', 'cash dip', 'when will cash run out'],
      what: 'Your cash at the end of each of the next 13 weeks, learned from how money has actually moved in your books, with a range.',
      formula: 'Learned from every entry this year: each customer\'s open invoices arrive the way that customer has actually paid (Kaplan-Meier on their history, counting invoices still open as not paid yet), new sales at your recent weekly pace collected on the same curve, suppliers either on their open bills or at your recent weekly pace (whichever predicted your past weeks better), payments made every month on their usual day, entries already made for later dates on their dates, GST on the 20th sized by what you have actually paid against the books\' estimate. Cash is before loans, overdraft and transfers. The forecast is re-made as of each of your past 12 weeks with only what was known then and checked against what happened; if customers kept paying less than it expected, money in is scaled to match, and the range shown is ± 1.28 × how far off it has typically been at that distance (about 8 in 10).',
      inputs: ['cash', 'revenue', 'burn', 'gstPayable'],
      notes: ['Floor = the low end of your cash over the last 90 days from the books (the lowest tenth of days), or two weeks of spend (monthly spend ÷ 2) without that history. You can set your own. The forecast flags the first week below it.',
        'Choose "My own assumptions" on Home → Adjust to set the figures yourself: each customer invoice on its due date + 15 days, ones over 90 days late left out as doubtful, new sales from when today\'s open invoices would be collected, vendor bills on their due date, spend not in bills spread weekly, new bills from week 5, GST on the 20th.',
        'Pure arithmetic; the AI never touches it.'],
      code: '19a-forecast.js mgForecast, mgFcData; cashFlowModel.js build, forecast, selfCheck', page: 'cash'
    },
    dso: {
      label: 'Days sales outstanding (DSO)', aliases: ['dso', 'days to get paid', 'collection days'],
      what: 'How many days of sales are sitting with customers.',
      formula: 'DSO = receivables ÷ monthly revenue × 30. DPO = payables due ÷ monthly spend × 30. Cash conversion cycle = DSO − DPO.',
      inputs: ['recvTotal', 'revenue', 'paySoon', 'burn'],
      notes: ['The books tool money_owed also gives "days to get paid" from actual payment dates in Tally, which is the truer number per customer.'],
      code: '04-metrics.js METRICS.dso, dpo, ccc', page: 'analytics'
    },
    working_capital: {
      label: 'Working capital', aliases: ['working capital', 'quick ratio', 'cash cover'],
      what: 'Short-term money in hand and coming in, less what is going out soon.',
      formula: 'Working capital = cash + receivables − payables due in 30 days. Quick ratio = (cash + receivables) ÷ payables due. Cash cover = cash ÷ payables due.',
      inputs: ['cash', 'recvTotal', 'paySoon'],
      code: '04-metrics.js METRICS.workingCapital, quickRatio, cashCover', page: 'analytics'
    },
    payments: {
      label: 'Payment gateway figures', aliases: ['mdr', 'gateway fees', 'failed payments', 'settlement lag', 'net settled'],
      what: 'What your payment gateways processed, charged and paid out.',
      formula: 'Net settled = gross − processing fees (MDR). MDR burden = fees ÷ gross. Failed rate = failed ÷ attempted transactions. Settlement lag = days from capture to bank credit. Average transaction = gross ÷ count.',
      inputs: [],
      notes: ['Read from each gateway\'s own transactions and settlements (Razorpay, Cashfree), never typed by hand.'],
      code: '04-metrics.js METRICS (Payments group)', page: 'payments'
    },
    recovered: {
      label: 'Paid after Margyn chased', aliases: ['recovered', 'paid after chase', 'how much did you recover'],
      what: 'Invoices Margyn sent reminders on that were then paid, in the last 30 days.',
      formula: 'Counts an invoice when it closed as paid in the last 30 days and at least one reminder had actually gone out (sent, delivered or read) before it closed. Promised and still-being-chased amounts are shown separately.',
      inputs: [],
      notes: ['It says "paid after we chased", not "because of": a customer might have paid anyway.'],
      code: 'api/_lib/channelHealth.js recovered', page: 'channels'
    },
    capital_readiness: {
      label: 'Capital readiness range', aliases: ['capital readiness', 'loan estimate', 'how much can i borrow', 'financing'],
      what: 'A rough working-capital range from your own figures. Margyn is not a lender and this is not a credit decision.',
      formula: 'Middle = monthly revenue × 3 if the Pulse Score is 70 or more, × 2 if 40 to 69, × 1 below 40. Range = 80% to 120% of the middle.',
      inputs: ['revenue'],
      code: '08-khata.js computeFinancingEligibility', page: 'financing'
    },
    cfo_pack: {
      label: 'CFO pack figures', aliases: ['cfo pack', 'monthly pack', 'mis'],
      what: 'One month\'s figures for the board, a CA or a lender.',
      formula: 'The month\'s figures are the last reading taken in that month (India time), compared with the month before. Balances, receivables and payables detail, GST vendors and the forecast are live and say "as of" today.',
      inputs: [],
      notes: ['So the CFO pack can differ from today\'s Home: it is a month-end picture.'],
      code: '19e-cfopack.js', page: 'cfopack'
    }
  };

  /* How Margyn works, for "how did you build this", "why does this differ", "where does it come from". */
  const HOW = {
    pipeline: 'Margyn connects to the systems you already use (Tally through a small agent on the Tally PC, Zoho Books, Odoo, Razorpay, Cashfree, Shopify, WhatsApp), reads them, matches them against each other, works out the figures with fixed arithmetic, and then the AI explains them and proposes actions. It reads; it does not change your books.',
    sources: SRC,
    single_truth: 'Every customer and vendor appears once. Their amount comes from the most trusted source; the others are shown next to it to compare, never added. That is why a total can be lower than adding up every source, and why the page lets you switch to one source\'s own view.',
    readings: 'A reading (snapshot) is the set of nine inputs behind the vitals: cash, revenue, net profit, monthly spend, GST leakage, GST payable, receivables, receivables over 90 days and payables due in 30 days. A new one is saved when any input moves by more than 0.5%, so the Pulse Score trend compares readings, not days.',
    ai_role: 'All figures are computed by code from your data. The AI (Claude for chat, WhatsApp and the briefing; a voice model on calls) never calculates a figure; it reads what the code worked out and explains it. If a figure isn\'t available, it says so rather than estimating.',
    approvals: 'Margyn proposes; you approve. Anything that changes data or messages a customer shows a confirm card first. It acts on its own only where two independent sources agree on the fact.',
    freshness: 'Figures are as fresh as the last sync. Tally syncs while the Tally PC and the Margyn agent are on; Zoho, Odoo and the gateways sync on a schedule or when you press sync. The "As of" date on each page tells you which reading you are seeing.',
    differences: 'Why two screens can show different numbers: the CFO pack is a month-end reading while Home is today; the reconciled view takes one source per party while a source view shows that source\'s own total; the vitals use six-month averages while the books tools add up an exact period; and a source that hasn\'t synced lags the others.',
    privacy: 'Your data is read only to run Margyn for you. Only the account owner and people they add (with the access they set) can see it. Margyn never sells data or shares a score with lenders without you asking.'
  };

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  /** The best entry for a free-text figure name ("runway", "how is my score worked out"), or null. */
  function find(q) {
    const t = norm(q); if (!t) return null;
    if (F[t]) return t;
    let best = null, bestLen = 0;
    Object.keys(F).forEach((k) => {
      [k.replace(/_/g, ' '), norm(F[k].label)].concat(F[k].aliases).forEach((a) => {
        const n = norm(a);
        if (n && t.includes(n) && n.length > bestLen) { best = k; bestLen = n.length; }
      });
    });
    return best;
  }
  /** Plain entry (no live numbers): for WhatsApp/typed chat and as the base of the live explain. */
  function describe(key) {
    const k = F[key] ? key : find(key);
    if (!k) return null;
    const e = F[k];
    return { figure: k, label: e.label, what: e.what, formula: e.formula, notes: e.notes || [], weight_in_pulse: e.weight ? Math.round(WEIGHTS[e.weight] * 100) + '%' : null, page: e.page };
  }
  function howTopic(q) {
    const t = norm(q);
    const key = Object.keys(HOW).find((k) => t.includes(k.replace(/_/g, ' '))) ||
      (/differ|different|mismatch|not match|why .* (two|both)/.test(t) ? 'differences' :
        /source|trust|verified|signal|priority|average/.test(t) ? 'sources' :
        /ai|claude|model|calculat|compute/.test(t) ? 'ai_role' :
        /fresh|sync|update|old|stale|as of/.test(t) ? 'freshness' :
        /snapshot|reading/.test(t) ? 'readings' :
        /approv|confirm|act|automat/.test(t) ? 'approvals' :
        /privacy|data|secure|safe|who can see/.test(t) ? 'privacy' :
        /once|twice|double|reconcil/.test(t) ? 'single_truth' : 'pipeline');
    return { topic: key, text: HOW[key] };
  }

  const api = { FIGURES: F, HOW, BANDS, WEIGHTS, TOLERANCE, find, describe, howTopic, KEYS: Object.keys(F) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MG_FORMULAS = api;
})(this);
