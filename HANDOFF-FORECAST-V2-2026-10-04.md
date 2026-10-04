# Handoff: forecast v2 (learned 13-week forecast) + learning store, 2026-10-04

Working copy: `~/Downloads/margyn-forecast-v2` (git clone of Margyn-Labs/reflectional), branch `forecast-v2` (pushed, WIP, NO PR).
VP approved: build, and ship (PR + merge) once tested and checked live on Care Hygiene (read-only, VP's Chrome, mihir@carehygiene.in).
Read first: memory `margyn-one-place-per-category`, `margyn-books-as-of-today`, `margyn-how-to-ship`, `margyn-vp-simple-steps`.

## Why
VP: the forecast must be smarter: learn from how cash, receivables, payables and each bank account actually moved day by day, find patterns, suggest and act; store what's needed so it improves on its own.

## Data sweep (what we capture)
- Tally vouchers (every entry, every ledger line, dated) for THIS FY only: the gold. Rebuilds every account's balance per day.
- Tally open bills: today only, no history. Ledger balances: today only.
- Entries made ahead (EMIs, PDCs) up to Mar 2027: certain future outflows (old forecast ignored them).
- Razorpay/Cashfree payments+settlements, Shopify orders/payouts, Zoho/Odoo invoices/bills/payments/bank (via Books layer).
- Payment chases: whatsapp_chase_targets state 'paused_promise' with promise_to_pay_date / promise_to_pay_amount (unused before).
- NOT captured: Tally bill allocations (which invoice a receipt paid; agent doesn't read BILLALLOCATIONS), last FY (no seasonality), overdraft limit, bank feed (AA).

## Built so far (on the branch)
- `api/_lib/cashFlowModel.js` (pure): cashEvents (bank movements by category), futureEvents (entered ahead), positionHistory (weekly cash/receivables/payables + days to collect), customerHabits (FIFO receipts→invoices: per-customer p25/p50/p75 days to pay, pool for thin history), recurringPayments (≥3 of last 4 months, ±35%, day spread ≤8), weeklyPace (median of 8 weeks), forecast (open invoices on each customer's habit, late ones spread wk1–4, doubtful >min(365,max(180,2×p75)); promises on date; new sales collected via learned lag quantiles; EMIs ahead; recurring on their day; supplier + other running-cost pace; GST on 20th from gst_estimate; mid/low/high), selfCheck (re-runs model as of 4/8/12 weeks ago, compares 4-week customer money in + cash; collection_factor bounded 0.6–1.3), accuracyFromRuns, build().
- `api/_lib/forecastStore.js`: recordDaily (forecast_runs + daily_positions upsert per IST day), pastRuns, promises. Fails open.
- SQL `2026-10-04-forecast-learning.sql` (forecast_runs, daily_positions; RLS on, service role only).
- Wired: `api/tally.js` analytics returns `forecast_v2` (+ records daily); `margynWatch.watchAccount` records daily for every account with books.
- Test `api/_lib/__tests__/cashFlowModel.test.js`: synthetic business (Alpha ~30 days, Beta ~60, salary 1st, rent 5th, EMIs ahead). 25/30 pass.

## Open failures → fixes to make next
1. recurringPayments: skip category 'suppliers' and payees paid >2×/month (weekly supplier payments were flagged as monthly recurring, which also zeroed supplier pace).
2. Balance direction: `tallyAnalytics.asOfToday` subtracts future entries assuming balances share the entries' sign ('same', true for Tally/Care Hygiene). For books with debit-positive balances ('opposite' — Zoho/Odoo adapters in dataLayer/books.js) it must ADD. Plan: books declare `balance_convention` ('opposite' for zoho/odoo adapters); computeAnalytics input + booksEngine.prepare pass it; asOfToday(ledgers, vouchers, now, conv) flips; sign inference falls back to the hint when 'unknown'. Callers: booksEngine.js:171, tallyAnalytics.js:258, tally.js:196.
3. Test fixture: make the synthetic book Tally-like ('same' convention: balances debit-negative, with P&L closings so inference finds 'same'); then 'cash today', 'opens on today's cash', 'every bank movement is filed' (check count) should pass.

## Then
- Run all `api/_lib/__tests__` + UI tests (`node tools/serve-static.js` — first check nothing stale holds port 5188 — then tools/ui-frame/margyn/nav/explain-test.js; symlink node_modules from ~/Downloads/Full repo).
- Ship server part first (PR: forecast_v2 in payload, not shown) → check live numbers on Care Hygiene (self_check errors, habits for big customers like GLENMARK/ALKEM, recurring list, EMIs, GST ₹8.93 L on 20 Oct).
- Then app: `app/js/19a-forecast.js` mgForecast() uses mgMar.forecast_v2 by default (same return shape + low/high, drivers); keep v1 as "set my own assumptions" toggle in Adjust; chart band; Cash page "How Margyn built this" (customers, recurring, entered ahead, pace, doubtful, self-check/track record) + weekly history chart (cash, receivables, payables, days to collect). Nudge/CFO pack/Cash tile follow mgForecast automatically. MG_RELEASES entry.
- VP steps: run `2026-10-04-forecast-learning.sql` (and `2026-10-04-books-layer.sql` if not yet), click-by-click with ✅.

## What else to store so it learns (proposal, not built)
promise outcomes per customer (kept / late / broken → promise reliability), suggestion outcomes (accepted/ignored + did cash improve), user corrections to recurring items (confirm/reject), overdraft limit + loan terms as account facts, Tally bill allocations (agent change), last-FY sync (seasonality), weekly per-customer habit snapshots (to see who's slowing down).
