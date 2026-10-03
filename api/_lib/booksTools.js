/**
 * _lib/booksTools.js
 * The questions Margyn can ask of the Tally books, as Claude tools. The same
 * definitions serve the Margyn panel (api/ask-margyn.js), the live voice call
 * (run through ?action=books from the browser) and WhatsApp
 * (_lib/whatsappAgent.js), so the three can never answer differently.
 *
 * Every tool is read-only. The account id always comes from the signed-in
 * user or the WhatsApp sender, never from tool input.
 *
 * CommonJS, zero-npm.
 */

const E = require('./booksEngine');
const FORMULAS = require('../../app/js/margyn-formulas.js');
// The books from whichever system keeps them (Tally, Zoho Books, Odoo): the one place for the Books category.
const { loadBooks } = require('./dataLayer/books');

const PERIOD = {
  description: 'Which dates. One of: this_fy (default: this Indian financial year, April to today), last_fy, this_month, last_month, this_quarter, last_quarter, last_7_days, last_30_days, last_90_days, today, yesterday, this_week, last_week, all; or a month "2026-08"; or a day "2026-08-14". For a custom range use from/to instead.',
  type: 'string'
};
const FROM = { type: 'string', description: 'Custom range start, YYYY-MM-DD. Use with to.' };
const TO = { type: 'string', description: 'Custom range end, YYYY-MM-DD.' };

const TOOLS = [
  {
    name: 'books_summary',
    description: 'Totals from the Tally books for any period: sales (before and including GST), returns, purchases, gross profit, running costs, profit, money received from customers, money paid out, invoices and customers billed, and a month-by-month table. Use for "what were my sales this year / last month / yesterday", "how much profit", "how did we do in August", "how much came in this week". Covers every synced entry, not a sample.',
    input_schema: { type: 'object', properties: { period: PERIOD, from: FROM, to: TO }, additionalProperties: false }
  },
  {
    name: 'books_breakdown',
    description: 'Break one figure down by month, day, customer, vendor, ledger, item or branch, with filters. Use for "sales by month", "top customers", "biggest vendors", "where is my money going" (expenses by ledger), "commission / freight / salary by month" (measure ledger + ledger name), "sales by branch", "best-selling items", "margin by customer", "which customers bought less in September". Measures: sales (before GST, after returns), sales_including_gst, returns, purchases, expenses (running + direct costs), running_costs, direct_costs, receipts (money in from customers), payments (money paid out), gst (output less input), ledger (any one ledger, needs ledger), quantity_sold, margin (item margin, needs item lines).',
    input_schema: {
      type: 'object',
      properties: {
        measure: { type: 'string', enum: E.MEASURES },
        by: { type: 'string', enum: E.GROUPS, description: 'month (default), day, customer, vendor, ledger, item, branch, voucher_type' },
        period: PERIOD, from: FROM, to: TO,
        party: { type: 'string', description: 'Only this customer/vendor (part of the name is fine).' },
        ledger: { type: 'string', description: 'Only ledgers whose name contains this, e.g. "commission", "freight", "interest", "salary".' },
        item: { type: 'string', description: 'Only items whose name contains this.' },
        branch: { type: 'string', description: 'Only this branch (renamed sales types such as "Vasai", "Kandivali").' },
        top: { type: 'integer', description: 'How many rows (default 10, max 50).' },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'asc for the smallest first.' }
      },
      required: ['measure'],
      additionalProperties: false
    }
  },
  {
    name: 'customer_or_vendor',
    description: 'One customer\'s or vendor\'s whole story from the books: what they bought or sold this year and by month, their share of your sales, how often they order and when they last did, what they owe you bill by bill with how late each is, what they paid and when, how long they take to pay, their top items and the margin on them; for vendors what you bought, owe and paid. Use for "tell me about Alkem", "how is Sun Pharma doing", "what does X owe", "when did X last order / pay". Part of a name is fine.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Customer or vendor name, or part of it.' } }, required: ['name'], additionalProperties: false }
  },
  {
    name: 'products',
    description: 'Product (stock item) economics: what sold, price, cost, margin and margin %. sort: sales (default), qty, margin (₹), margin_pct (best margin %), lowest_margin_pct, below_cost, no_cost. With name: one item in detail (by month, which customers buy it at what price, who you buy it from, and for kits you assemble, the parts). Use for "top margin products", "best sellers", "what am I selling at a loss", "how is the gauze swab doing". Cost = average purchase price; for kits, the cost of their parts from Manufacturing Journals.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['sales', 'qty', 'margin', 'margin_pct', 'lowest_margin_pct', 'below_cost', 'no_cost'] },
        name: { type: 'string', description: 'One item (part of the name is fine).' },
        period: PERIOD, top: { type: 'integer' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'money_owed',
    description: 'Who owes the business money (direction receivable, default) or whom the business owes (payable), from Tally\'s bill-wise outstanding: total, overdue, ageing buckets (not yet due, 1-30, 31-60, 61-90, 91-180, 181-365, over a year late), the largest and most overdue names, bills over a year old, days to get paid, and how much cash 10 days faster collection frees. Use for "who owes me", "who should I chase first", "how much is overdue", "what do I owe suppliers". Optional party narrows to one name.',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['receivable', 'payable'] }, party: { type: 'string' }, top: { type: 'integer' } },
      additionalProperties: false
    }
  },
  {
    name: 'find_entries',
    description: 'Find individual Tally entries (vouchers): by customer/vendor, ledger, item, type (sales, purchase, receipt, payment, credit_note, debit_note, journal, contra), words in the narration, amount range, voucher number or dates. Returns date, type, number, party, amount, narration and items. Use for "show me payments to X last week", "find the invoice for ₹1,24,500", "what was bill VSI1046", "entries with freight in September", "largest receipts this month" (sort largest).',
    input_schema: {
      type: 'object',
      properties: {
        party: { type: 'string' }, ledger: { type: 'string' }, item: { type: 'string' },
        kind: { type: 'string', enum: ['sales', 'purchase', 'receipt', 'payment', 'credit_note', 'debit_note', 'journal', 'contra'] },
        text: { type: 'string', description: 'Words to look for in the narration, party or number.' },
        number: { type: 'string', description: 'Voucher / invoice number.' },
        min_amount: { type: 'number' }, max_amount: { type: 'number' },
        period: PERIOD, from: FROM, to: TO,
        sort: { type: 'string', enum: ['latest', 'largest'] }, limit: { type: 'integer' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'cash_and_loans',
    description: 'Cash and bank balances by account, loans and overdraft owed, interest paid this year by ledger, and the GST estimate for the last month with its usual due date. Use for "how much cash do I have", "what is my OD / loan", "how much interest am I paying", "how much GST is due". Balances are Tally\'s where it sent one, otherwise opening balance plus this year\'s entries.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'what_needs_attention',
    description: 'What deserves the owner\'s attention in the books right now, biggest and most urgent first: overdue money, bills over a year old, customers late against their own habit, regular customers who stopped ordering, customer concentration, the gap between getting paid and paying suppliers, commission share, expense jumps, an unfinished month, sales against the average, items sold below cost or with a likely unit mix-up, GST due, big receipts, possible duplicate entries, and whether Tally has stopped syncing. Use for "what should I worry about", "top 3 action items", "how is the business doing", "anything I should know", "what changed".',
    input_schema: { type: 'object', properties: { top: { type: 'integer', description: 'How many (default 6).' } }, additionalProperties: false }
  },
  {
    name: 'how_its_calculated',
    description: 'How a Margyn figure is worked out, the way an accountant explains it: what it is, the formula, which inputs and where they come from, its weight in the Pulse Score, and what can make it look off. Use for "how is my runway / Pulse Score / cash / margin / DSO calculated", "what is the formula", "where does this number come from", "why is the score low". figure in their words. With a how-Margyn-works question ("which source do you trust", "why do two screens differ", "do you use AI to calculate", "how fresh is this"), pass it as topic instead. Formulas only: get the live amounts from the other tools or the data you have, then work the sum through for them. (In the Margyn panel, explain does both at once.)',
    input_schema: { type: 'object', properties: { figure: { type: 'string' }, topic: { type: 'string' } }, additionalProperties: false }
  }
];

const NAMES = new Set(TOOLS.map((t) => t.name));
const RUN = {
  books_summary: E.summary,
  books_breakdown: E.breakdown,
  customer_or_vendor: E.partyProfile,
  products: E.products,
  money_owed: E.moneyOwed,
  find_entries: E.findEntries,
  cash_and_loans: E.cashAndDebt,
  what_needs_attention: E.attention
};

// A conversation asks several questions of the same books; prepare them once per sync.
const _prepared = new WeakMap();

async function contextFor(userId) {
  const book = await loadBooks(userId);
  if (!book.connected) return { ctx: null };
  // The book is cached until the next sync, which can be days if the Tally PC is off. "Today" (days late,
  // this week, this month) must still move on, so a context from an earlier India date is worked out again.
  let ctx = _prepared.get(book);
  const day = require('./tallyBills').todayIstMs();
  if (!ctx || ctx._day !== day) {
    ctx = E.prepare(book); ctx._day = day;
    ctx.source = book.source || 'tally'; ctx.source_name = book.source_name || 'Tally'; ctx.book_notes = book.notes || []; ctx.compare = book.compare || [];
    _prepared.set(book, ctx);
  }
  return { ctx };
}

function has(name) { return NAMES.has(name); }

/* Formulas aren't account data: no Tally needed, nobody's access limits them. */
function howItsCalculated(input) {
  const i = input || {};
  if (i.figure) {
    const d = FORMULAS.describe(i.figure);
    if (d) return d;
  }
  if (i.topic || i.figure) { const h = FORMULAS.howTopic(i.topic || i.figure); return { topic: h.topic, answer: h.text }; }
  return { figures: FORMULAS.KEYS.map((k) => FORMULAS.FIGURES[k].label), topics: Object.keys(FORMULAS.HOW) };
}

/* A team member's view permissions (teamAccess.js) apply to the books too: someone who can't see
   cash on the Cash page can't ask for it either. The owner (no member record) sees everything. */
function allowed(name, input, perms) {
  if (!Array.isArray(perms)) return true;
  const can = (p) => perms.includes(p);
  if (name === 'cash_and_loans') return can('view_cash');
  if (name === 'money_owed') return /pay/i.test((input && input.direction) || '') ? can('view_payables') : can('view_receivables');
  if (name === 'customer_or_vendor') return can('view_receivables') || can('view_payables');
  return can('view_cash') && can('view_receivables') && can('view_payables');
}

/**
 * Run one books tool for an account. Never throws: errors come back as { error }.
 * perms: the team member's permissions, or null for the owner.
 */
async function exec(name, input, userId, perms) {
  if (!NAMES.has(name)) return { error: 'Unknown tool ' + name };
  if (name === 'how_its_calculated') return howItsCalculated(input);
  if (!allowed(name, input, perms)) return { error: 'Your access to this account doesn\'t include that part of the books. The account owner can change it under Settings > People.' };
  try {
    const { ctx } = await contextFor(userId);
    if (!ctx) return { connected: false, note: 'No books are connected for this business (Tally, Zoho Books or Odoo), so there are no books to read. Connect one under Organisations and sources.' };
    if (!ctx.rows.length) return { connected: true, note: ctx.source === 'tally' ? 'Tally is connected but no entries have synced yet. Is the Tally PC on with the Margyn agent running?' : ctx.source_name + ' is connected but no entries have synced yet.' };
    return RUN[name](ctx, input || {});
  } catch (e) {
    console.error('[booksTools] ' + name + ' failed:', e.message);
    return { error: 'I couldn\'t read the books just now. Try again in a moment.' };
  }
}

/** The same tools in OpenAI Realtime's shape (voice). */
function realtimeDefs() {
  // Voice has explain (the formula plus the live figures on screen) instead of how_its_calculated.
  return TOOLS.filter((t) => t.name !== 'how_its_calculated').map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema }));
}

const STEP_LABELS = {
  books_summary: 'Added up your Tally books',
  books_breakdown: 'Broke it down from your Tally entries',
  customer_or_vendor: 'Pulled their history from Tally',
  products: 'Worked out product margins',
  money_owed: 'Read who owes what in Tally',
  find_entries: 'Searched your Tally entries',
  cash_and_loans: 'Read cash, loans and interest',
  what_needs_attention: 'Checked what needs your attention',
  how_its_calculated: 'Looked up how that is worked out'
};

module.exports = { TOOLS, has, exec, allowed, realtimeDefs, STEP_LABELS, contextFor };
