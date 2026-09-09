/**
 * _lib/chaseEngine.js
 * Deterministic cadence + escalation logic for the WhatsApp Chase Agent, plus
 * inbound-reply intent classification.
 *
 * Design rules (see WHATSAPP-CHASE-AGENT-PLAN.md):
 *   - Cadence and escalation are RULE-BASED, not agent-reasoned — the founder
 *     can see exactly why chase N fired. Claude is used only to classify an
 *     ambiguous reply (and only when CHASE_AGENT_CLASSIFIER=on).
 *   - The opening message of every chase is outside a 24h session window, so it
 *     MUST be a pre-approved Utility template. Tone presets map to template
 *     variants, never to free text.
 *
 * Zero-npm: plain Date math + fetch() only. CommonJS to match _lib/supabaseRest.js.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const DEFAULT_CONFIG = {
  enabled: false,
  tone_preset: 'friendly',          // friendly | neutral | firm | formal (v1 ships friendly + firm)
  escalation_steepness: 'standard', // gentle | standard | firm
  days_before_due: [3],
  days_after_due: [3, 7, 14],
  max_chases: 4,
  send_window_ist: [10, 18],        // [startHour, endHour] local IST
  min_spacing_days: 3,
  auto_include: 'overdue_only',     // overdue_only | all_open
  min_amount: 0,
  opt_out: [],                      // customer phone numbers (digits) to never contact
  per_segment: null                 // v2 hook — always null in v1
};

function mergeConfig(raw) {
  const c = Object.assign({}, DEFAULT_CONFIG, raw || {});
  if (!Array.isArray(c.days_before_due)) c.days_before_due = DEFAULT_CONFIG.days_before_due.slice();
  if (!Array.isArray(c.days_after_due)) c.days_after_due = DEFAULT_CONFIG.days_after_due.slice();
  if (!Array.isArray(c.send_window_ist) || c.send_window_ist.length !== 2) c.send_window_ist = [10, 18];
  if (!Array.isArray(c.opt_out)) c.opt_out = [];
  c.max_chases = Math.max(1, Math.min(8, Number(c.max_chases) || 4));
  c.min_spacing_days = Math.max(1, Number(c.min_spacing_days) || 3);
  c.min_amount = Math.max(0, Number(c.min_amount) || 0);
  return c;
}

/* ------------------------------------------------------------------ */
/* Cadence                                                             */
/* ------------------------------------------------------------------ */
/**
 * Day offsets, relative to the due date, at which each successive chase fires.
 * Negative = before due. Sorted ascending, capped at max_chases.
 */
function chaseOffsets(config) {
  const c = mergeConfig(config);
  const before = c.days_before_due.map((d) => -Math.abs(Number(d) || 0));
  const after = c.days_after_due.map((d) => Math.abs(Number(d) || 0));
  const all = before.concat(after).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  return all.slice(0, c.max_chases);
}

function atSendWindowStart(dateMs, config) {
  const c = mergeConfig(config);
  // Convert to IST, set to the window's start hour, convert back to UTC ms.
  const ist = new Date(dateMs + IST_OFFSET_MS);
  ist.setUTCHours(c.send_window_ist[0], 0, 0, 0);
  return ist.getTime() - IST_OFFSET_MS;
}

/**
 * When should chase #(chaseIndex) go out? chaseIndex is 0-based
 * (0 = the first chase). Returns a Date, or null if the sequence is exhausted.
 *
 * @param {string|Date|null} dueDate
 * @param {number} chaseIndex        how many chases have already been sent
 * @param {object} config
 * @param {Date|number} [lastChaseAt] enforces min_spacing_days
 */
function nextChaseAt(dueDate, chaseIndex, config, lastChaseAt) {
  const c = mergeConfig(config);
  if (chaseIndex >= c.max_chases) return null;

  const offsets = chaseOffsets(c);
  const now = Date.now();
  let targetMs;

  const due = dueDate ? Date.parse(String(dueDate).slice(0, 10) + 'T00:00:00Z') : NaN;

  if (!Number.isNaN(due)) {
    if (chaseIndex >= offsets.length) return null;
    targetMs = due + offsets[chaseIndex] * DAY_MS;
  } else {
    // No due date — space chases evenly from now/last chase.
    const base = lastChaseAt ? +new Date(lastChaseAt) : now;
    targetMs = chaseIndex === 0 ? now : base + c.min_spacing_days * DAY_MS;
  }

  targetMs = atSendWindowStart(targetMs, c);

  // Never schedule inside the min-spacing shadow of the previous chase.
  if (lastChaseAt) {
    const floor = +new Date(lastChaseAt) + c.min_spacing_days * DAY_MS;
    if (targetMs < floor) targetMs = atSendWindowStart(floor, c);
  }
  return new Date(targetMs);
}

function withinSendWindow(config, when) {
  const c = mergeConfig(config);
  const hourIst = new Date((+ (when || new Date())) + IST_OFFSET_MS).getUTCHours();
  return hourIst >= c.send_window_ist[0] && hourIst < c.send_window_ist[1];
}

/* ------------------------------------------------------------------ */
/* Escalation tier + template selection                               */
/* ------------------------------------------------------------------ */
const TIERS = ['pre_due', 'due', 'overdue_1', 'overdue_2', 'final'];

// chase # (0-based) -> tier, by steepness. Layered on top of the tone preset:
// a firmer steepness climbs the urgency ladder faster, it does not change the
// wording tone.
const STEEPNESS_SEQ = {
  gentle:   ['pre_due', 'due', 'overdue_1', 'overdue_2', 'final'],
  standard: ['pre_due', 'overdue_1', 'overdue_2', 'final', 'final'],
  firm:     ['due', 'overdue_1', 'overdue_2', 'final', 'final']
};

function daysOverdue(dueDate, when) {
  const due = dueDate ? Date.parse(String(dueDate).slice(0, 10) + 'T00:00:00Z') : NaN;
  if (Number.isNaN(due)) return null;
  return Math.floor(((+ (when || new Date())) - due) / DAY_MS);
}

/**
 * @param {number} chaseIndex   0-based
 * @param {string|null} dueDate
 * @param {object} config
 * @param {number} [bumps]      broken-promise escalations to add on top
 */
function resolveTier(chaseIndex, dueDate, config, bumps) {
  const c = mergeConfig(config);
  const seq = STEEPNESS_SEQ[c.escalation_steepness] || STEEPNESS_SEQ.standard;
  let tier = seq[Math.min(chaseIndex, seq.length - 1)];

  const od = daysOverdue(dueDate, new Date());
  const overdue = od === null ? true : od > 0;
  if (!overdue) return 'pre_due';
  if (tier === 'pre_due') tier = 'due';

  let idx = TIERS.indexOf(tier);
  idx = Math.min(TIERS.length - 1, idx + (Number(bumps) || 0));
  return TIERS[idx];
}

function bumpTier(tier) {
  const idx = TIERS.indexOf(tier);
  if (idx < 0) return 'overdue_1';
  return TIERS[Math.min(TIERS.length - 1, idx + 1)];
}

/**
 * tone preset + tier -> approved template NAME. v1 ships two tone variants
 * (friendly, firm); pre_due and final are shared / tone-independent.
 * Total: 8 templates.
 */
function templateName(tier, tonePreset) {
  if (tier === 'pre_due') return 'chase_pre_due';
  if (tier === 'final') return 'chase_final';
  const tone = (tonePreset === 'firm' || tonePreset === 'formal') ? 'firm' : 'friendly';
  return `chase_${tier}_${tone}`;
}

/** Resolve a template NAME to its Gupshup template id from the environment. */
function templateIdFor(name) {
  return process.env['WHATSAPP_TEMPLATE_' + String(name).toUpperCase()] || null;
}

/* ------------------------------------------------------------------ */
/* Template body params + local render (for the timeline UI)          */
/* ------------------------------------------------------------------ */
// Every chase template takes the same 4 body variables, in this order.
//   {{1}} business name   {{2}} invoice ref   {{3}} amount   {{4}} timing phrase
const TEMPLATE_BODIES = {
  chase_pre_due:
    'Hi, this is a reminder on behalf of {{1}}. Invoice {{2}} for {{3}} is due {{4}}. ' +
    'Please arrange payment by the due date. Reply here if you have any questions.',
  chase_due_friendly:
    'Hi, a gentle nudge from {{1}} — invoice {{2}} for {{3}} is due {{4}}. ' +
    'Do let us know once it’s been processed. Thank you!',
  chase_due_firm:
    'This is a payment reminder on behalf of {{1}}. Invoice {{2}} for {{3}} is due {{4}}. ' +
    'Kindly ensure payment is made on time and confirm here once done.',
  chase_overdue_1_friendly:
    'Hi, following up for {{1}} on invoice {{2}} ({{3}}), now {{4}}. ' +
    'If it’s already paid, let us know the payment reference. Otherwise, please arrange it this week.',
  chase_overdue_1_firm:
    'On behalf of {{1}}: invoice {{2}} for {{3}} is {{4}}. ' +
    'Please clear this at the earliest and confirm the payment reference here.',
  chase_overdue_2_friendly:
    'Hi, invoice {{2}} for {{3}} from {{1}} is {{4}} and still showing unpaid. ' +
    'Can you share when it will be settled? Happy to sort out any issue holding it up.',
  chase_overdue_2_firm:
    'Second reminder on behalf of {{1}}: invoice {{2}} for {{3}} is {{4}}. ' +
    'Please make payment now and reply with the reference, or tell us the reason for the delay.',
  chase_final:
    'Final reminder on behalf of {{1}} regarding invoice {{2}} for {{3}}, {{4}}. ' +
    'If payment or a response isn’t received, this will be escalated to {{1}} directly. ' +
    'Please reply here to resolve it.'
};

function timingPhrase(tier, dueDate) {
  const od = daysOverdue(dueDate, new Date());
  if (tier === 'pre_due') {
    if (od === null) return 'shortly';
    return od >= 0 ? 'today' : `in ${-od} day${od === -1 ? '' : 's'}`;
  }
  if (od === null || od <= 0) return 'now due';
  return `${od} day${od === 1 ? '' : 's'} overdue`;
}

function inr(n) {
  const v = Math.round(Number(n) || 0);
  return '₹' + v.toLocaleString('en-IN');
}

/**
 * Build the ordered template params + a locally rendered body for a chase.
 * @returns {{ templateName, templateId, params: string[], body: string, tier }}
 */
function buildChaseMessage({ tier, tonePreset, businessName, invoiceRef, amount, dueDate }) {
  const name = templateName(tier, tonePreset);
  const params = [
    String(businessName || 'your supplier'),
    String(invoiceRef || 'the outstanding invoice'),
    inr(amount),
    timingPhrase(tier, dueDate)
  ];
  const tpl = TEMPLATE_BODIES[name] || TEMPLATE_BODIES.chase_due_friendly;
  const body = tpl.replace(/\{\{(\d)\}\}/g, (_, d) => params[Number(d) - 1] || '');
  return { templateName: name, templateId: templateIdFor(name), params, body, tier };
}

/* ------------------------------------------------------------------ */
/* Inbound reply — rule-based intent classification                   */
/* ------------------------------------------------------------------ */
const RE = {
  opt_out: /\b(stop|unsubscribe|do not (?:message|contact|text)|don'?t (?:message|contact|text) me|opt ?out|remove me)\b/i,
  disputed: /\b(not received|haven'?t received|did ?n'?t (?:order|receive|get)|wrong amount|incorrect amount|already paid this|double ?charged|dispute|short (?:supply|paid|shipped)|quality (?:issue|problem)|defect|return(?:ed)?|credit note)\b/i,
  wrong_contact: /\b(wrong (?:number|person|contact)|not (?:my|our) (?:account|bill|invoice|company)|who is this|who'?s this|don'?t know (?:this|you|them)|no such (?:account|company)|you have the wrong)\b/i,
  out_of_office: /\b(out of (?:the )?office|on leave|o\.?o\.?o\.?|away (?:from|until)|will be back|annual leave|auto[- ]?reply|currently unavailable)\b/i,
  paid_claim: /\b(paid|payment (?:made|done|sent|released|processed)|have paid|已付|transfer(?:red|ed)?(?: it| the amount)?|remitted|cleared (?:it|this|the (?:amount|invoice|bill))|settled (?:it|this)|neft|imps|rtgs|upi|utr|payment ref)\b/i,
  promise_to_pay: /\b(will (?:pay|clear|settle|process|release|transfer)|going to pay|shall pay|pay(?:ing)? (?:it|this|you)?(?: by| on| tomorrow| next| soon| shortly)|process(?:ing)? (?:it|the payment|payment)|clear(?:ing)? (?:it|this) (?:by|on|soon|shortly)|by (?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|next month|end of|eom|eow|\d)|in (?:a|the next) (?:day|week|couple)|give me (?:a|some) (?:day|time)|early next week|by month ?end)\b/i
};

function classifyReplyIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'unclear', promise_date: null, promise_amount: null, classified_by: 'rule' };

  let intent = 'unclear';
  if (RE.opt_out.test(t)) intent = 'opt_out';
  else if (RE.disputed.test(t)) intent = 'disputed';
  else if (RE.wrong_contact.test(t)) intent = 'wrong_contact';
  else if (RE.out_of_office.test(t)) intent = 'out_of_office';
  else if (RE.paid_claim.test(t)) intent = 'paid_claim';
  else if (RE.promise_to_pay.test(t)) intent = 'promise_to_pay';

  const promise_date = (intent === 'promise_to_pay' || intent === 'paid_claim') ? parsePromiseDate(t) : null;
  const promise_amount = parseAmount(t);
  return { intent, promise_date, promise_amount, classified_by: 'rule' };
}

function isoDate(d) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Best-effort natural-language date parse. Returns 'YYYY-MM-DD' or null. */
function parsePromiseDate(text, now) {
  const t = String(text || '').toLowerCase();
  const base = now ? new Date(now) : new Date();
  const today = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));

  const add = (days) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + days); return isoDate(d); };

  if (/\btoday\b|\btonight\b|\bright now\b|\bwithin the hour\b/.test(t)) return add(0);
  if (/\btomorrow\b|\btmrw\b|\bnext day\b/.test(t)) return add(1);
  if (/\bday after tomorrow\b/.test(t)) return add(2);

  let m = t.match(/\bin (\d{1,2}) (day|days|week|weeks)\b/);
  if (m) return add(Number(m[1]) * (/week/.test(m[2]) ? 7 : 1));

  if (/\bend of (?:the )?week\b|\beow\b|\bby friday\b/.test(t)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    return isoDate(d);
  }
  if (/\bend of (?:the )?month\b|\beom\b|\bmonth ?end\b/.test(t)) {
    return isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)));
  }
  if (/\bnext week\b|\bearly next week\b/.test(t)) return add(7);
  if (/\bnext month\b/.test(t)) return isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)));

  m = t.match(/\b(?:by|on|this|next|coming) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) {
    const target = WEEKDAYS.indexOf(m[1]);
    const d = new Date(today);
    let delta = (target - d.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (/next/.test(m[0]) && delta < 7) delta += 7;
    d.setUTCDate(d.getUTCDate() + delta);
    return isoDate(d);
  }

  // "2 Sep", "Sep 2", "2 September 2026", "2nd sept"
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/) ||
      t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    let day, mon;
    if (/^\d/.test(m[1])) { day = Number(m[1]); mon = MONTHS.indexOf(m[2].slice(0, 3)); }
    else { mon = MONTHS.indexOf(m[1].slice(0, 3)); day = Number(m[2]); }
    if (mon >= 0 && day >= 1 && day <= 31) {
      let year = today.getUTCFullYear();
      let d = new Date(Date.UTC(year, mon, day));
      if (d < today) d = new Date(Date.UTC(year + 1, mon, day));
      return isoDate(d);
    }
  }

  // "15/09", "15-09-2026", "15.09"
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (m) {
    const day = Number(m[1]), mon = Number(m[2]) - 1;
    let year = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : today.getUTCFullYear();
    if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(year, mon, day));
      if (!m[3] && d < today) d = new Date(Date.UTC(year + 1, mon, day));
      return isoDate(d);
    }
  }

  // "by the 15th", "on 15" (day-of-month only)
  m = t.match(/\b(?:by|on|before) (?:the )?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
      if (d < today) d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day));
      return isoDate(d);
    }
  }
  return null;
}

/** Pull a rupee amount out of "paid 45,000" / "₹45000" / "Rs. 45k". */
function parseAmount(text) {
  const t = String(text || '');
  let m = t.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lac|l|cr|crore)?/i) ||
          t.match(/\b([\d,]{4,}(?:\.\d+)?)\s*(k|lakh|lac|l|cr|crore)?\b/i);
  if (!m) return null;
  let n = Number(String(m[1]).replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1e3;
  else if (unit === 'l' || unit === 'lakh' || unit === 'lac') n *= 1e5;
  else if (unit === 'cr' || unit === 'crore') n *= 1e7;
  return Math.round(n);
}

/* ------------------------------------------------------------------ */
/* Optional Claude classifier — only for rule='unclear'              */
/* ------------------------------------------------------------------ */
async function classifyWithClaude(text, recentContext) {
  if ((process.env.CHASE_AGENT_CLASSIFIER || '').toLowerCase() !== 'on') return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.WHATSAPP_AGENT_MODEL || 'claude-sonnet-5';
  const system =
    'You classify a single inbound WhatsApp reply from a customer who was sent a payment reminder. ' +
    'Reply with ONLY a compact JSON object, no prose: ' +
    '{"intent": one of ["paid_claim","promise_to_pay","disputed","wrong_contact","out_of_office","unclear"], ' +
    '"promise_date": "YYYY-MM-DD" or null, "promise_amount": number or null}. ' +
    'promise_date only when they commit to a specific pay date. Today is ' + isoDate(new Date()) + '.';
  const user = (recentContext ? 'Earlier: ' + recentContext + '\n\n' : '') + 'Reply: ' + String(text || '').slice(0, 600);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 120, system, messages: [{ role: 'user', content: user }] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = (Array.isArray(data.content) ? data.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const jm = txt.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    const parsed = JSON.parse(jm[0]);
    const allowed = ['paid_claim', 'promise_to_pay', 'disputed', 'wrong_contact', 'out_of_office', 'unclear'];
    if (!allowed.includes(parsed.intent)) return null;
    return {
      intent: parsed.intent,
      promise_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.promise_date || '') ? parsed.promise_date : null,
      promise_amount: Number.isFinite(parsed.promise_amount) ? parsed.promise_amount : null,
      classified_by: 'agent'
    };
  } catch (e) {
    return null;
  }
}

/**
 * Full classification: rule pass, then Claude only if the rule pass is unsure
 * and the classifier is enabled.
 */
async function classifyReply(text, recentContext) {
  const ruled = classifyReplyIntent(text);
  if (ruled.intent !== 'unclear') return ruled;
  const ai = await classifyWithClaude(text, recentContext);
  return ai || ruled;
}

/* ------------------------------------------------------------------ */
/* State-machine helper: given a classified reply, what changes?      */
/* ------------------------------------------------------------------ */
/**
 * Pure function — returns the patch to apply to a whatsapp_chase_targets row,
 * plus an optional short acknowledgement to text back inside the session window.
 * The caller persists the patch and sends the ack.
 */
function applyReplyToTarget(target, classified, config) {
  const c = mergeConfig(config);
  const now = new Date().toISOString();
  const patch = { last_reply_intent: classified.intent, last_reply_at: now };
  let ack = null;

  switch (classified.intent) {
    case 'opt_out':
      patch.state = 'opted_out';
      patch.resolution = 'Customer asked to stop receiving messages.';
      patch.resolved_at = now;
      patch.next_chase_at = null;
      ack = 'Understood — you won’t get any more messages from us on this. Sorry for the bother.';
      break;

    case 'paid_claim':
      patch.state = 'resolved_paid';
      patch.resolution = 'Customer says payment has been made'
        + (classified.promise_amount ? ` (${inr(classified.promise_amount)})` : '') + ' — pending confirmation.';
      patch.resolved_at = now;
      patch.next_chase_at = null;
      ack = 'Thanks for confirming — we’ll match it against the account and come back only if anything doesn’t line up.';
      break;

    case 'promise_to_pay':
      if (classified.promise_date) {
        patch.state = 'paused_promise';
        patch.promise_to_pay_date = classified.promise_date;
        if (classified.promise_amount) patch.promise_to_pay_amount = classified.promise_amount;
        // resume the day after the promised date
        const resume = new Date(Date.parse(classified.promise_date + 'T00:00:00Z') + DAY_MS);
        patch.next_chase_at = new Date(atSendWindowStart(+resume, c)).toISOString();
        ack = `Noted — we’ll expect it by ${classified.promise_date}. We’ll only follow up if it hasn’t come through by then.`;
      } else {
        patch.state = 'active';
        ack = 'Thanks — which date should we expect payment by? I’ll hold off until then.';
      }
      break;

    case 'disputed':
      patch.state = 'disputed';
      patch.resolution = 'Customer raised a dispute — needs the business to review.';
      patch.next_chase_at = null;
      ack = 'Thanks for flagging — I’ve passed this to the team to look into and they’ll be in touch.';
      break;

    case 'wrong_contact':
      patch.state = 'wrong_contact';
      patch.resolution = 'Reached the wrong number / contact.';
      patch.next_chase_at = null;
      ack = 'Apologies for the mix-up — we’ll correct our records. Please ignore the earlier message.';
      break;

    case 'out_of_office':
      // don't count it, don't change cadence
      patch.last_reply_intent = 'out_of_office';
      break;

    default: // 'unclear' / 'no_response'
      patch.state = 'active';
      ack = 'Thanks for the reply — I’ve noted it and passed it on to the team.';
      break;
  }
  return { patch, ack };
}

module.exports = {
  DEFAULT_CONFIG,
  mergeConfig,
  chaseOffsets,
  nextChaseAt,
  withinSendWindow,
  resolveTier,
  bumpTier,
  daysOverdue,
  templateName,
  templateIdFor,
  buildChaseMessage,
  classifyReplyIntent,
  parsePromiseDate,
  parseAmount,
  classifyReply,
  applyReplyToTarget,
  inr,
  TIERS
};
