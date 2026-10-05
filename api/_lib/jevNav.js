/**
 * api/_lib/jevNav.js
 * The navigator: typed words ("who owes me", "GST kholo", "take me to vendors")
 * -> a place in the app, by Jev, in ~0.3 s, with no Claude call. Added
 * 2026-10-03 (HANDOFF-JEV-2026-10-03.md section 5).
 *
 * The list of places lives here, on the server, so the only thing the browser
 * sends is the typed text. Every option is a fixed app label; no customer data
 * is ever part of the question. The text itself is capped and redacted
 * (jev.redact) before it leaves, and the browser has already swapped known
 * customer and vendor names for a placeholder.
 *
 * Two questions in one call (output is free):
 *   place  - which place fits best (pages + a few quick actions)
 *   intent - is this "take me somewhere" or "answer me something"?
 * The ⌘K palette only needs `place` (the user still presses Enter). The Margyn
 * panel needs both: it opens a page itself only when Jev is sure it's a
 * request to go somewhere, so a question never navigates away.
 *
 * Mode: JEV_MODE_NAV = off | shadow | live (off by default, needs JEV_API_KEY).
 * The panel shortcut has its own switch, JEV_MODE_NAV_PANEL (default shadow).
 */
const jev = require('./jev');

// Page keys match MG_PAGES in app/js/20-frame.js (a test checks this).
const NAV_PAGES = {
  home: 'Home: today\'s overview, the daily briefing, a summary of the business',
  inbox: 'Inbox: decisions waiting for approval, proposals to approve, payments to confirm, forwarded documents',
  cash: 'Cash: bank balances, cash position, 13-week cash forecast, runway, overdraft',
  payments: 'Payment gateways: Razorpay and Cashfree settlements, gateway fees, failed payments, UPI, refunds',
  receivables: 'Receivables: money customers owe the business, overdue invoices, debtors, dues to collect, ageing',
  payables: 'Payables: money the business owes vendors and suppliers, bills due to pay, creditors',
  gst: 'GST and tax: GST returns, input tax credit (ITC), GSTR-2B, TDS, tax due and filing',
  books: 'Ledger: the accounting books and entries from Zoho, Tally or Odoo, journals, ledger accounts, sources compared',
  invoicing: 'Invoicing: invoices and quotes already made, khata',
  calculate: 'Import: upload an Excel, CSV, PDF or a photo of a document',
  customers: 'Customers: the list of customers, clients and buyers with their details',
  vendors: 'Vendors: the list of vendors and suppliers with their details',
  margin: 'Margin: gross margin, profit on each product, what slow payers cost',
  cfopack: 'CFO pack: the monthly MIS report for the board or investors, as a PDF',
  analytics: 'Reports: charts, graphs and trends built from the data',
  scores: 'Pulse Score: the financial health score and the vitals behind it',
  history: 'Conversations: past chats with Margyn, calls and WhatsApp chats, and what Margyn noticed',
  agents: 'Margyn’s agents: each agent and its switches, automations, payment reminders, chasing customers for collections, month-end close, morning and evening WhatsApp updates',
  connectors: 'Organisations and sources: connect, sync or reconnect Zoho, Tally, Odoo, Razorpay, Cashfree, Shopify',
  people: 'People and roles: team members, their WhatsApp numbers, who can see what',
  settings: 'Settings: notifications, preferences, account controls',
  audit: 'Audit log: a history of who changed what and when',
  channels: 'Channel health: whether WhatsApp and email reminders are actually delivered, money paid after a reminder',
  financing: 'Capital readiness: business loans, working capital credit, readiness for a lender',
  profile: 'Profile: the company name, GST number, city and business details',
  work: 'All work: every task and proposal across the business, who owns it, what is waiting',
  live: 'Margyn live: what Margyn and its agents are doing right now, running jobs',
  collect: 'Collect: overview of getting paid by customers, what is due this week, who to chase',
  chasing: 'Chasing: reminders sent to customers, follow-ups, promises to pay',
  payover: 'Pay: overview of paying suppliers, bills due this week, what to pay first',
  closeover: 'Close: month-end close checklist, what is done and what is left',
  entries: 'Ledger entries: receivable, payable and cash entries kept by hand, settled not deleted',
  plan: 'Plan: forecast, scenarios, targets and where the business is heading',
  transactions: 'Transactions: every invoice, bill, payment and settlement across all apps in one list',
  tallydata: 'Tally vouchers: ledger balances, bills and vouchers exactly as Tally holds them',
  documents: 'Documents: uploaded and forwarded invoices, bills, receipts and files',
  rules: 'Rules: what Margyn may do on its own, what needs approval, limits',
  howitworks: 'How Margyn works: how the agents work, where numbers come from, the formulas'
};
// Quick actions the palette already offers (mgSearch); ids match MG_NAV_ACTIONS in app/js/02-shell.js.
const NAV_ACTIONS = {
  'act:new_invoice': 'Make a new invoice, raise a bill to a customer',
  'act:new_customer': 'Add a new customer',
  'act:new_vendor': 'Add a new vendor or supplier',
  'act:add_receivable': 'Write down money a customer owes (add a receivable entry by hand)',
  'act:add_payable': 'Write down a bill the business owes (add a payable entry by hand)',
  'act:voice': 'Start a voice call with Margyn, talk instead of typing',
  'act:whats_new': 'What\'s new in Margyn, release notes',
  'act:new_chart': 'Build a new chart or report'
};
const NAV_OPTIONS = Object.assign({}, NAV_PAGES, NAV_ACTIONS);

const MAX_Q = 200;
const STATE_NOTE = 'Typed by the owner of an Indian small business into their finance app. It can be English, Hindi or Hinglish, and can have typos. "PARTY" stands for a customer or vendor name.';

function questions() {
  return {
    place: jev.Choice('Which place in the app best fits what they typed?', NAV_OPTIONS),
    intent: jev.Choice('Do they want to be taken to a place in the app, or do they want an answer?', {
      go: 'They want to open or go to a page, list or form (for example "open cash", "vendors", "GST kholo", "take me to the ledger", "new invoice").',
      ask: 'They want an answer, a number, an explanation or a comparison (for example "why did profit drop", "how much GST do I owe", "compare May and June"), or they are chatting.'
    })
  };
}

function cleanQuery(q) {
  const s = String(q == null ? '' : q).replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
  return jev.redact(s).text;
}

/** One Jev call. Returns { place, placeConfidence, intent, intentConfidence, ms } or null (off, error, timeout). */
async function navPick(q, { fetchImpl, timeoutMs } = {}) {
  const text = cleanQuery(q);
  if (!text) return null;
  const res = await jev.systemOne({ typed: text, note: STATE_NOTE }, questions(), { fetchImpl, timeoutMs });
  if (!res) return null;
  const p = res.answers.place, it = res.answers.intent;
  if (!p || p.type !== 'choice' || !NAV_OPTIONS[p.choice] || typeof p.confidence !== 'number') return null;
  return {
    place: p.choice, placeConfidence: round(p.confidence),
    intent: it && it.type === 'choice' ? it.choice : null, intentConfidence: it && typeof it.confidence === 'number' ? round(it.confidence) : 0,
    ms: res.ms
  };
}
const round = (x) => Math.round(x * 1000) / 1000;

/* Gates, shared by the browser rules and the eval script. */
const PALETTE_MIN = 0.75;   // ⌘K: show a "Best match" row (the user still presses Enter)
const PANEL_MIN = 0.85;     // panel: open it ourselves, only when it's also clearly "go"
function paletteBest(r) { return r && r.placeConfidence >= PALETTE_MIN ? r.place : null; }
function panelGo(r) { return r && r.intent === 'go' && r.intentConfidence >= PANEL_MIN && r.placeConfidence >= PANEL_MIN ? r.place : null; }

function modes() {
  const nav = jev.modeFor('nav');
  const raw = String(process.env.JEV_MODE_NAV_PANEL || 'shadow').toLowerCase();
  const panel = nav === 'off' ? 'off' : (raw === 'live' || raw === 'off' ? raw : 'shadow');
  return { nav, panel };
}

module.exports = { NAV_PAGES, NAV_ACTIONS, NAV_OPTIONS, MAX_Q, PALETTE_MIN, PANEL_MIN, cleanQuery, questions, navPick, paletteBest, panelGo, modes };
