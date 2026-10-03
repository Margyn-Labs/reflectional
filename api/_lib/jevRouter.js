/**
 * api/_lib/jevRouter.js
 * The front door: before a typed chat, panel or WhatsApp message reaches
 * Claude, Jev (one call, ~0.3 s, ~$0) decides three things with no Claude call
 * (HANDOFF-JEV-2026-10-03.md section 6, job #2):
 *   depth  quick / balanced / deep (only ever used to LOWER Balanced to Quick)
 *   groups which tool groups Claude needs (about 5 to 15 tools instead of 22 to 37)
 *   talk   a bare greeting / thanks / goodbye that a short fixed reply answers
 *
 * Same pattern as the navigator (jevNav.js): the questions and options are
 * fixed on the server, all questions go in one call, every answer is gated,
 * and the message is redacted before it leaves (identifiers, known customer
 * and vendor names -> PARTY, amounts and long numbers -> NUM).
 *
 * FAIL SAFE. Groups are added by a free keyword rule OR by Jev (sure or
 * unsure); a group is left out only when neither the rule nor Jev wants it.
 * Any doubt -> the full tool set at the depth the user picked (today's turn):
 * Jev down or slow, the customer list unreadable, a short "yes / haan / ok"
 * (it answers something Margyn asked), or nothing matched at all. The change
 * group (propose_action) has the lowest bar of all. Tools that belong to no
 * group are always sent, so a new tool can never be dropped by accident.
 * Jev never decides a write, never sees amounts or dates, and is never the
 * confirm gate: propose_action still only draws a card a person must tap.
 *
 * Mode: JEV_MODE_ROUTER = off | shadow | live (off by default, needs JEV_API_KEY).
 *   shadow: Jev runs beside today's turn; one log line compares its pick with
 *           what Claude actually used. Nothing changes for the user.
 *   live:   the pick is applied.
 * Log line (never any message text):
 *   [jev-router] <surface> <mode> pick=... used=... miss=... retry=...
 */
const jev = require('./jev');

/* ---------- tool groups (by tool name; a tool may sit in two groups) ---------- */
const GROUPS = {
  books: {
    q: 'Answering it needs figures or records from the business\'s accounts, or how a figure is calculated: sales, purchases, profit, costs, expenses, a customer or vendor, products or stock, who owes money or is owed, cash, bank, loans, GST or tax, health score, a formula or where a number comes from.',
    tools: ['books_summary', 'books_breakdown', 'customer_or_vendor', 'products', 'money_owed', 'find_entries', 'cash_and_loans', 'what_needs_attention',
      // panel: live figures the app has loaded; WhatsApp: its own read tools
      'get_overview', 'query_parties', 'get_cash', 'get_gst', 'get_margin',
      'get_vitals', 'list_receivables', 'list_payables', 'get_tally_data', 'get_findings', 'get_invoice_status',
      // how a figure is worked out, and how Margyn works (2026-10-03)
      'explain', 'how_margyn_works', 'how_its_calculated']
  },
  screen: {
    surfaces: ['panel'],
    q: 'They want something in the app opened, shown, scrolled, filtered, closed or refreshed, a source synced or checked, or they point at what is on screen ("this", "here").',
    tools: ['navigate', 'search_app', 'get_screen', 'open_party', 'filter_list', 'get_inbox', 'get_sources', 'sync_source', 'scroll', 'close', 'press']
  },
  show: {
    surfaces: ['panel'],
    q: 'They want a table, a chart, a graph, a summary or a written note made.',
    tools: ['show_view', 'show_note', 'show_table', 'show_chart', 'clear_workspace']
  },
  change: {
    q: 'They ask for something to be done or changed: record, log, add, mark paid, approve, reject, send, remind, save, pause, start or stop something, or make a new customer, vendor, invoice or entry.',
    tools: ['propose_action', 'list_open_ledger_items', 'list_pending_import_suggestions', 'list_pending_agent_actions', 'list_chase_targets',
      'run_command', 'fill_form', 'save_form', 'get_screen']
  },
  chase: {
    q: 'It is about payment reminders or chasing customers to collect money: who is being reminded, the reminder settings or schedule.',
    tools: ['list_chase_targets', 'get_chase_agent_config', 'get_inbox']
  },
  imports: {
    q: 'It is about documents, bills or receipts that were forwarded or uploaded, things waiting for approval, or reconciliation proposals.',
    tools: ['list_pending_import_suggestions', 'list_pending_agent_actions', 'list_open_ledger_items', 'get_inbox']
  },
  relay: {
    surfaces: ['whatsapp'],
    q: 'They want a message passed on to someone in their team, or ask who in the team handles something.',
    tools: ['get_stakeholder', 'route_message']
  }
};
const GROUP_IDS = Object.keys(GROUPS);
// Sent on every panel turn whatever the pick: the panel's default way to show
// and to look at the screen are cheap and nearly always useful there.
const CORE = { panel: ['get_screen', 'show_view', 'navigate'], chat: [], whatsapp: [] };

function groupsFor(surface) { return GROUP_IDS.filter(g => !GROUPS[g].surfaces || GROUPS[g].surfaces.includes(surface)); }
function surfaceOf(s) { return s === 'panel' || s === 'whatsapp' ? s : 'chat'; }

/* ---------- free rules first: keywords that put a group in for sure ---------- */
const MONTHS = 'jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?';
const RULES = {
  books: new RegExp('\\b(sales?|sold|bikri|becha|revenue|turnover|profit|loss|munafa|margin|costs?|expenses?|kharch\\w*|purchases?|kharid\\w*|owe[sd]?|owing|dues?|overdue|outstanding|udh?aa?r|baa?ki|lena|dena|receivables?|payables?|debtors?|creditors?|cash|bank|balance|loans?|overdraft|od|interest|byaj|gst|tax|tds|itc|invoices?|bills?|customers?|clients?|vendors?|suppliers?|party|parties|items?|products?|stock|inventory|salary|salaries|rent|freight|commission|runway|burn|score|pulse|vitals?|health|risks?|worr\\w*|problems?|issues?|attention|flag\\w*|explain|numbers?|figures?|calculat\\w*|formula|logic|worked out|nikal\\w*|doing|kaisa|kaisi|kaise|haal|ledgers?|entries|vouchers?|tally|zoho|month|year|quarter|week|today|yesterday|' + MONTHS + '|kitna|kitne|kitni|how much|how many|total|top|biggest|largest|highest|lowest|best|worst|NUM|PARTY)\\b', 'i'),
  screen: /\b(open|kholo|khol|go to|goto|take me|jao|show|dikhao|dikha|dekh\w*|close|band|hatao|scroll|filter|this|here|yeh|ye|screen|page|tab|sync|refresh|connected|connector|sources?|click|press|tap|button)\b/i,
  show: /\b(table|chart|graph|plot|summary|summari[sz]e|note|notes|write|likh\w*|workspace|breakdown)\b/i,
  change: /\b(mark(ed)?|approve|reject|dismiss|add|log|record|enter|create|make|raise|issue|send|bhej\w*|remind|chase|pause|resume|stop|start|cancel|delete|remove|update|change|edit|set|save|settle|write ?off|paid|received|clear|aa ?gaya|aaya|mil ?gaya|jama|kar ?do|karo|kardo|daal\w*|dalo|likh\w*|bana\w*|rok\w*|chalu)\b/i,
  chase: /\b(remind\w*|chase|chasing|follow ?up|collections?|collect|tagada|nudge|reminders?)\b/i,
  imports: /\b(forward\w*|upload\w*|import\w*|documents?|receipts?|photo|pdf|excel|csv|pending|approv\w*|waiting|inbox|proposals?|reconcil\w*|suggestions?)\b/i,
  relay: /\b(tell|ask|let \w+ know|pass (it |this )?(on|along)|loop in|notify|who handles|accountant|my (ar|ap) person|team)\b/i
};
// A short reply to something Margyn asked: only Claude, with the thread, can read it.
const CONFIRM_WORD = '(y(es|ep|eah|a)?|ok(ay)?|k|sure|haa?n?|ji|theek( hai)?|thik( hai)?|done|go ahead|do it|kar ?do|confirm|no|nahi?|nope|cancel|mat karo|rehne do|please|pls|[1-5])';
const CONFIRM_RE = new RegExp('^\\s*' + CONFIRM_WORD + '([\\s,.!]+' + CONFIRM_WORD + '){0,2}[\\s.!]*$', 'i');
const TALK_WORDS_RE = /^[\s\p{L}!.,?']*$/u;   // a bare greeting has no digits or symbols

/* ---------- what leaves us ---------- */
const MAX_TEXT = 500;
const STATE_NOTE = 'A message from the owner or staff of an Indian small business to Margyn, their finance assistant. It can be English, Hindi or Hinglish, with typos. PARTY stands for a customer or vendor name and NUM for an amount or number.';
// Words that can start a company name but are too common to treat as one on their own.
const COMMON = new Set(('sales sale total india indian trading traders enterprises enterprise industries industry services service solutions global international general national ' +
  'marketing healthcare health pharma pharmaceuticals medical medicals supply supplies store stores bank cash account accounts payment payments ledger vendor vendors customer ' +
  'customers super royal shree shri sri new first best great good margyn tally zoho profit credit debit capital finance money office expense expenses purchase purchases month ' +
  'sundry state goods products product packaging logistics transport agency agencies associates group home care star city metro prime united modern classic standard').split(' '));

function partyVariants(names) {
  const out = new Set();
  for (const raw of names || []) {
    const n = String(raw || '').replace(/\s+/g, ' ').trim();
    if (n.length < 3) continue;
    out.add(n);
    const core = n.replace(/[().,&/]/g, ' ').replace(/\b(private|pvt|limited|ltd|llp|inc|co|company|corporation|corp|and|m\/s|ms)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
    if (core.length >= 4 && !COMMON.has(core.toLowerCase())) out.add(core);
    const words = core.split(' ').filter(w => w.length >= 2);
    if (words.length >= 2 && (words[0] + ' ' + words[1]).length >= 6) out.add(words[0] + ' ' + words[1]);
    if (words[0] && words[0].length >= 4 && !COMMON.has(words[0].toLowerCase())) out.add(words[0]);
  }
  return [...out];
}
function partyRegex(names) {
  const v = partyVariants(names).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return v.length ? new RegExp('(?<![\\p{L}\\p{N}])(?:' + v.join('|') + ')(?![\\p{L}\\p{N}])', 'giu') : null;
}

/**
 * Redact a message for Jev: GSTIN / phone / email / account numbers (jev.redact),
 * then known customer and vendor names -> PARTY, then amounts and any number of
 * 3+ digits -> NUM. `partyRe` comes from partyRegex(ledger_parties names).
 */
function redactMessage(text, partyRe) {
  let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  s = jev.redact(s).text.replace(/\b(GSTIN|PHONE|EMAIL|ACCT)_\d+\b/g, '$1');
  if (partyRe) s = s.replace(partyRe, 'PARTY');
  s = s.replace(/(₹|\brs\.?|\binr)\s*\d[\d,]*(\.\d+)?(\s*(k|l|lakhs?|lacs?|cr|crores?)\b)?/gi, 'NUM')
    .replace(/(?<![\p{L}_])\d[\d,]*(\.\d+)?\s*(k|lakhs?|lacs?|cr|crores?|hazaa?r|thousand|million)\b/giu, 'NUM')
    .replace(/(?<![\p{L}_])\d[\d,]*(\.\d+)?/gu, m => m.replace(/\D/g, '').length >= 3 ? 'NUM' : m);
  return s;
}

/* ---------- the call ---------- */
/** What Jev sees: the redacted message, the redacted previous message if any, where it was typed, a fixed note. */
function buildState(o, surface, partyRe) {
  const state = { message: redactMessage(o.text, partyRe), where: surfaceOf(surface) === 'whatsapp' ? 'WhatsApp' : 'the Margyn app', note: STATE_NOTE };
  if (o.earlier) state.earlier_message = redactMessage(String(o.earlier).slice(0, 200), partyRe);
  return state;
}
function questions(surface) {
  const qs = {
    depth: jev.Choice('How much thinking does a good reply need?', {
      quick: 'Little: one fact, one figure, a yes or no, or opening one thing (for example "cash balance?", "how much does PARTY owe", "open GST").',
      balanced: 'Normal: a question needing a few lookups or a short explanation, or a request to get something done.',
      deep: 'A lot: why something happened, a diagnosis, a trade-off, a plan or forecast, a comparison across several things, or several questions in one message.'
    }),
    talk: jev.Choice('What kind of message is this?', {
      greeting: 'Only a greeting (hi, hello, good morning, namaste), with nothing asked.',
      thanks: 'Only thanks or praise (thanks, great job, shukriya), with nothing asked.',
      bye: 'Only a goodbye (bye, see you, good night).',
      work: 'Anything else: a question, a request, a reply to something Margyn asked, or a greeting together with a question.'
    })
  };
  for (const g of groupsFor(surface)) qs['g_' + g] = jev.Noul(GROUPS[g].q);
  return qs;
}

// Gates. Inclusion bars are low on purpose: leaving out a needed tool is the
// costly mistake, sending a few extra tools costs a few hundred tokens.
const INCLUDE_MIN = 0.4;     // Jev's probability that a group is needed (eval: every needed group the rules miss scores >= 0.73)
const CHANGE_MIN = 0.15;     // lower still for the write path
const DEPTH_MIN = 0.85;      // Balanced -> Quick only when this sure
const TALK_MIN = 0.9;        // fixed reply only when this sure

/**
 * Turn Jev's answers (or null) into a pick. Pure: the eval runs exactly this.
 * @returns { full, why, groups[], depth, depthConf, talk, talkConf, nouls{} }
 */
function decide(res, { text, surface, redacted }) {
  surface = surfaceOf(surface);
  const avail = groupsFor(surface);
  const raw = String(text || '');
  const base = { full: true, groups: avail.slice(), depth: null, depthConf: 0, talk: null, talkConf: 0, nouls: {} };
  if (CONFIRM_RE.test(raw)) return Object.assign(base, { why: 'confirm' });
  // Rules read the raw text here on the server, and the redacted copy (PARTY / NUM count as figures).
  const ruled = avail.filter(g => RULES[g].test(raw) || (redacted ? RULES[g].test(redacted) : false));
  if (!res || !res.answers) return Object.assign(base, { why: 'nojev', ruled });
  const a = res.answers;
  const nouls = {};
  for (const g of avail) { const n = a['g_' + g]; nouls[g] = n && n.type === 'noul' && typeof n.noul === 'number' ? n.noul : null; }
  const groups = avail.filter(g => ruled.includes(g) || nouls[g] === null || nouls[g] >= (g === 'change' ? CHANGE_MIN : INCLUDE_MIN));
  const d = a.depth && a.depth.type === 'choice' ? a.depth : null;
  const t = a.talk && a.talk.type === 'choice' ? a.talk : null;
  const out = Object.assign(base, {
    full: false, why: 'pick', groups, ruled, nouls,
    depth: d ? d.choice : null, depthConf: d && typeof d.confidence === 'number' ? d.confidence : 0,
    talk: t ? t.choice : null, talkConf: t && typeof t.confidence === 'number' ? t.confidence : 0
  });
  if (smallTalk(out, raw)) return Object.assign(out, { groups: [], why: 'talk' });
  if (!groups.length) return Object.assign(out, { full: true, groups: avail.slice(), why: 'empty' });
  if (groups.length === avail.length) out.full = true, out.why = 'all';
  return out;
}

function smallTalk(p, raw) {
  if (!p || !['greeting', 'thanks', 'bye'].includes(p.talk) || p.talkConf < TALK_MIN) return null;
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6 || !TALK_WORDS_RE.test(raw) || /\?/.test(raw)) return null;
  if ((p.ruled || []).length) return null;
  if (Object.values(p.nouls || {}).some(n => n === null || n >= 0.5)) return null;
  return p.talk;
}

/** Live depth: only Balanced (the default) may drop to Quick, never with a change or a table on the way. */
function liveDepth(p, asked) {
  if (!p || p.full || asked !== 'balanced') return asked;
  if (p.depth === 'quick' && p.depthConf >= DEPTH_MIN && !p.groups.includes('change') && !p.groups.includes('show') && p.groups.length <= 2) return 'quick';
  return asked;
}

const REPLIES = {
  greeting: (name) => `Hi${name ? ' ' + name : ''}! What would you like to look at? I can check your numbers, who owes you, cash and GST, or get something done for you.`,
  thanks: () => 'Anytime. Tell me whenever you need something else.',
  bye: () => 'Bye for now. I\'m here whenever you need me.'
};

/** The tools to send: core for this surface, every tool in a picked group, and any tool in no group at all. */
function selectTools(allTools, groups, surface) {
  surface = surfaceOf(surface);
  const keep = new Set(CORE[surface] || []);
  const known = new Set();
  for (const g of GROUP_IDS) for (const n of GROUPS[g].tools) known.add(n);
  for (const g of groups || []) for (const n of (GROUPS[g] ? GROUPS[g].tools : [])) keep.add(n);
  return allTools.filter(t => keep.has(t.name) || !known.has(t.name));
}
/** Which groups a tool belongs to (for the shadow comparison). */
function groupsOfTool(name) { return GROUP_IDS.filter(g => GROUPS[g].tools.includes(name)); }

/* ---------- customer / vendor names for redaction (cached per instance) ---------- */
const partyCache = new Map();
const PARTY_TTL_MS = 10 * 60 * 1000;
async function partyRegexFor(userId, loadNames) {
  const hit = partyCache.get(userId);
  if (hit && Date.now() - hit.at < PARTY_TTL_MS) return hit.re;
  const names = await loadNames(userId);   // throws -> caller skips Jev
  const re = partyRegex(names);
  if (partyCache.size > 500) partyCache.clear();
  partyCache.set(userId, { at: Date.now(), re });
  return re;
}
async function loadPartyNames(userId) {
  const { selectRows } = require('./supabaseRest');
  const rows = await selectRows('ledger_parties', `select=name&user_id=eq.${encodeURIComponent(userId)}&limit=5000`);
  return (rows || []).map(r => r.name);
}

/**
 * The front door for one message.
 * @param o.surface 'panel' | 'chat' | 'whatsapp'
 * @param o.text    the message; o.earlier the previous user message (optional)
 * @param o.userId  account whose ledger_parties names are redacted
 * @param o.depth   the depth the user picked (chat/panel)
 * @returns null when off; otherwise { mode, pick, apply: { groups|null, depth, reply|null }, ms }
 *   apply is what the caller should do: in shadow it is always today's turn.
 */
async function route(o, deps = {}) {
  const mode = deps.mode || jev.modeFor('router');
  if (mode === 'off') return null;
  const surface = surfaceOf(o.surface);
  const t0 = Date.now();
  let res = null, why = null, redacted = null;
  if (!CONFIRM_RE.test(String(o.text || ''))) {
    try {
      const re = await partyRegexFor(o.userId, deps.loadNames || loadPartyNames);
      const state = buildState(o, surface, re);
      redacted = state.message;
      res = await jev.systemOne(state, questions(surface), { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    } catch (e) { why = 'noparties'; console.error('[jev-router] party names unavailable, skipping Jev:', e.message); }
  }
  const pick = decide(res, { text: o.text, surface, redacted });
  if (why) pick.why = why;
  const apply = { groups: null, depth: o.depth || null, reply: null };
  if (mode === 'live') {
    if (pick.why === 'talk') apply.reply = REPLIES[pick.talk](o.name ? String(o.name).split(' ')[0].slice(0, 30) : '');
    else if (!pick.full) apply.groups = pick.groups;
    if (o.depth) apply.depth = liveDepth(pick, o.depth);
  }
  return { mode, surface, pick, apply, ms: Date.now() - t0, jevMs: res ? res.ms : null };
}

function mode() { return jev.modeFor('router'); }
/** The pick, small enough to ride in the panel's signed resume state (labels and numbers only). */
function slimPick(p) {
  return p ? { why: p.why, full: !!p.full, groups: p.groups || [], depth: p.depth || null, depthConf: r2(p.depthConf), talk: p.talk || null, talkConf: r2(p.talkConf) } : null;
}

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : '-');
/** One log line, labels and numbers only. `used` = tool names Claude called; `sent` = how many tools went. */
function logLine(r, { used = [], depthUsed, sent, full, retry, round } = {}) {
  if (!r) return '';
  const p = r.pick;
  const usedGroups = [...new Set(used.flatMap(groupsOfTool))];
  const covered = new Set([...(CORE[r.surface] || [])]);
  if (!p.full && p.why !== 'talk') for (const g of p.groups) for (const n of GROUPS[g].tools) covered.add(n);
  const known = (n) => groupsOfTool(n).length > 0;
  const missed = p.full ? [] : [...new Set(used.filter(n => known(n) && !covered.has(n)).flatMap(groupsOfTool))];
  const line = `[jev-router] ${r.surface} ${r.mode} pick=${p.why}${p.full ? ':full' : ''} d=${p.depth || '-'}/${r2(p.depthConf)} talk=${p.talk || '-'}/${r2(p.talkConf)} g=${p.full ? 'all' : p.groups.join('+') || 'none'}` +
    ` used=d:${depthUsed || '-'} g:${usedGroups.join('+') || 'none'} n=${used.length} miss=${missed.length ? missed.join('+') : 0}` +
    ` sent=${sent == null ? '-' : sent}/${full == null ? '-' : full} retry=${retry ? 1 : 0}${round ? ' round=' + round : ''} ms=${r.jevMs == null ? '-' : r.jevMs}`;
  console.log(line);
  return line;
}

module.exports = {
  GROUPS, GROUP_IDS, CORE, RULES, CONFIRM_RE, INCLUDE_MIN, CHANGE_MIN, DEPTH_MIN, TALK_MIN, REPLIES, MAX_TEXT,
  groupsFor, partyVariants, partyRegex, redactMessage, buildState, questions, decide, smallTalk, liveDepth, selectTools, groupsOfTool, route, logLine, mode, slimPick,
  _partyCache: partyCache
};
