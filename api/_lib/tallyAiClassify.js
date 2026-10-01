'use strict';
/**
 * AI placement of ledgers Tally's own structure could not settle.
 *
 * Order of trust: the user's confirmation, then Tally's group chain (parent and primary group), then this, then
 * keyword guesses. The model only PLACES a ledger in a bucket; every rupee is still added up by tallyAnalytics.js.
 * Sure answers are saved (tally_ledger_classes, set_by null = AI) so they cost nothing next time and the user can
 * overrule any of them with "Confirm".
 */
const MODEL = process.env.TALLY_CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const BUCKETS = ['sales', 'purchases', 'direct_expense', 'direct_income', 'opex', 'other_income', 'tax',
  'debtor', 'creditor', 'bank', 'cash', 'stock', 'balance_sheet'];
const MIN_CONFIDENCE = 0.8;

const SYSTEM = `You place accounting ledgers from an Indian company's TallyPrime books into one bucket each.

Buckets:
- sales: revenue from selling goods or services (Sales Accounts)
- purchases: goods bought for resale or production
- direct_expense: freight in, wages, manufacturing, job work, packing material
- direct_income: direct income other than sales
- opex: rent, salary, remuneration, travel, commission, marketing, professional fees, interest, depreciation, other running costs
- other_income: interest received, discount received, misc income
- tax: GST, TDS, TCS, duties
- debtor: a customer or any party who owes the company
- creditor: a supplier, vendor, or person the company owes (including unpaid expenses, directors' payables)
- bank, cash, stock
- balance_sheet: assets, liabilities, capital, loans, deposits, provisions, anything not in the profit and loss

Use each ledger's parent group, primary group, name and how much it moved. Company names and personal names under a customer-like group are debtors; under a payable group they are creditors. When you are not sure, say so with a low confidence instead of guessing.

Output ONLY JSON: {"ledgers":[{"ledger":"<exact name>","bucket":"<one bucket>","confidence":0.0-1.0}]}`;

function parse(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const o = JSON.parse(cleaned);
  return Array.isArray(o.ledgers) ? o.ledgers : [];
}

/**
 * items: [{ ledger, parent, primary_group, vouchers, volume }]. Returns [{ ledger, bucket, confidence }] for the
 * answers that are valid and sure enough. Never throws; no key or any failure returns [].
 */
async function classifyLedgersWithAI(items, { apiKey, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!apiKey || !items || !items.length) return [];
  const names = new Set(items.map((i) => i.ledger));
  const user = 'Ledgers:\n' + items.map((i) => JSON.stringify({
    ledger: i.ledger, parent: i.parent || null, primary_group: i.primary_group || null, vouchers: i.vouchers, volume: Math.round(i.volume || 0)
  })).join('\n');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: SYSTEM, messages: [{ role: 'user', content: user }] })
    });
    if (!r.ok) { console.error('[tally] ai classify HTTP', r.status); return []; }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return parse(text)
      .filter((x) => x && names.has(x.ledger) && BUCKETS.includes(x.bucket) && Number(x.confidence) >= MIN_CONFIDENCE)
      .map((x) => ({ ledger: x.ledger, bucket: x.bucket, confidence: Number(x.confidence) }));
  } catch (e) {
    console.error('[tally] ai classify failed:', e && e.message);
    return [];
  } finally { clearTimeout(timer); }
}

module.exports = { classifyLedgersWithAI, BUCKETS, MIN_CONFIDENCE };
