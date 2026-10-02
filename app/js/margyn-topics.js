/* ============================================================
   What a question is about, and whether Margyn managed to answer it.
   Shared by the browser (Conversations: the question index) and the
   server (api/ask-margyn.js and _lib/whatsappAgent.js send a topic and an
   answered flag to the ops counters, never the words). Plain keyword
   rules in English and Hinglish: no model call, same answer everywhere.
   ============================================================ */
(function (root) {
  const TOPICS = [
    ['attention', 'What needs attention', /\b(worry|action items?|attention|anything (i|we) should know|what changed|how('?s| is| are) (the )?(business|we|things)|kaisa chal|update me|what'?s new|alerts?|risks?)\b/i],
    ['receivables', 'Who owes me', /\b(owes?|owed|receivables?|outstanding|overdue|chase|collect(ion|ed)?|due from|pending payments?|udhaar|udhar|baaki|reminders?|days to (get )?pa(y|id))\b/i],
    ['payables', 'What I owe', /\b(payables?|i owe|we owe|suppliers?|vendors?|bills? (due|to pay)|creditors?|can (we|i) (afford to )?pay|pay (them|him|her|the bill))\b/i],
    ['sales', 'Sales', /\b(sales?|sold|revenue|turnover|bikri|becha|invoic(e|es|ed|ing)|billing)\b/i],
    ['profit', 'Profit and margin', /\b(profit|margins?|loss|munafa|kamai|p ?& ?l|pnl|gross|net income|earning)\b/i],
    ['products', 'Products and stock', /\b(products?|(?<!action )items?|skus?|stock|inventory|kits?|best.?sell|price list|pricing)\b/i],
    ['expenses', 'Costs and expenses', /\b(expenses?|costs?|spend|spent|salar(y|ies)|commission|freight|transport|rent|kharcha|overheads?)\b/i],
    ['cash', 'Cash, loans and interest', /\b(cash|bank|balance|runway|o\.?d\b|overdraft|loans?|interest|paisa|funds?|forecast|floor)\b/i],
    ['gst', 'GST and tax', /\b(gst|itc|tds|tcs|gstr|tax(es)?)\b/i],
    ['customers', 'A customer or vendor', /\b(customers?|clients?|buyers?|part(y|ies)|tell me about|how is .+ doing)\b/i],
    ['score', 'Pulse Score', /\b(pulse|score|vitals?)\b/i],
    ['app', 'Using the app', /\b(open|show|scroll|close|table|chart|page|website|connect|sync|log ?in|password|how do i)\b/i]
  ];
  const LABEL = Object.fromEntries(TOPICS.map((t) => [t[0], t[1]]));
  LABEL.other = 'Other';

  /** Up to two topic keys for a question, most specific first. */
  function topicsOf(text) {
    const s = String(text || '');
    const out = [];
    for (const [key, , re] of TOPICS) if (re.test(s) && !out.includes(key)) out.push(key);
    return out.length ? out.slice(0, 2) : ['other'];
  }

  /** Greetings and stray voice fragments ("Hello", "Madam", "Nahi bola") aren't questions. */
  function isQuestion(text) {
    const s = String(text || '').trim();
    if (s.length < 8) return false;
    if (/^(hi|hello|hey|ok(ay)?|yes|no|thanks?|thank you|bye|haan|nahi|acha|theek hai)[.!? ]*$/i.test(s)) return false;
    return s.split(/\s+/).length >= 3 || /\?\s*$/.test(s);
  }

  /** A reply that admits it couldn't answer (the thing worth fixing). */
  const MISS = /\b(i (don'?t|do not) have|i can'?t (see|get|pull|find|tell)|couldn'?t (work|find|get|pull)|isn'?t (available|connected)|not (yet )?available|not connected|no (data|figures)|unable to|i'?m only seeing|don'?t see|try rephrasing|no .{0,20} synced yet)\b/i;
  function looksUnanswered(reply) { return MISS.test(String(reply || '').replace(/[\u2018\u2019]/g, "'")); }

  const api = { TOPICS: TOPICS.map((t) => ({ key: t[0], label: t[1] })), LABEL, topicsOf, isQuestion, looksUnanswered };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MG_TOPICS = api;
})(this);
