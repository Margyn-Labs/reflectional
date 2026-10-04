# Handoff: forecast v2 (learned 13-week forecast) + learning store, 2026-10-04

**Status: SHIPPED and live** (PRs #65, #66, #67, #68, #69, #70, all merged into main; checked live on Care Hygiene, read-only, as mihir@carehygiene.in).
Work happens in `~/Downloads/Full repo`; `~/Downloads/margyn-forecast-v2` is the git clone used only to ship.
Plan for how Margyn keeps learning: vault `Margyn/Handoffs & Plans/PLAN-HOW-MARGYN-LEARNS-2026-10-04.md` (also published as a claude.ai artifact).

## Why
VP: the forecast must learn from how cash, receivables, payables and each bank account actually moved day by day, find patterns, suggest and act, and store what's needed so it improves on its own. VP, mid-task: "the main part is the logic and the accuracy… without accuracy it is garbage."

## What's live
- `api/_lib/cashFlowModel.js` (pure):
  - **Customers**: each open invoice's arrival from Kaplan-Meier over that customer's history (else everyone's), amount-weighted; open invoices censored at yesterday's age (`openAges` floor); paid samples count from the invoice's own age (`>=`); recent payments weigh more (`HALF_LIFE` 60 days). Expected money spread by day (mid); cautious/hopeful at the 75th/25th percentile day. New sales at the 8-week median pace on the same curve from day 0. Doubtful: older than min(365, max(180, 2×p75)).
  - **Suppliers**: two methods computed every run, (a) open bills per supplier on its learned curve + purchases pace on that curve + direct (non-creditor) pace, (b) weekly pace on its weekdays. Self-check picks per business on 4+8-week error; a supplier level factor (0.7–1.3, shrunk) is learned like the customer one.
  - Recurring payments (≥3 of last 4 months, ±35%, day spread ≤8; not suppliers; not anyone paid >2×/month), entries made ahead (EMIs) on their dates, promises (whatsapp_chase_targets paused_promise) on their dates.
  - **GST** on the 20th: books' estimate × (paid ÷ estimated over the last 3 months). If months with GST due show no tax out of cash (Care Hygiene Jul–Sep), `paid_from_elsewhere` and not taken from cash (still listed).
  - **Self-check**: re-made as of each of the last 12 weeks (needs 10 weeks of history), scored at 1/2/4/8 weeks; cash compared before loans/overdraft/transfers; `by_kind` per check; `collection_factor` (0.6–1.3, shrunk n/(n+4)); `error_by_week`; range = likely ± 1.28 × typical miss (√time beyond measured weeks), `band_basis: 'past_misses'`.
  - Running costs at weekday-shaped pace. Notes in plain words.
- `api/_lib/forecastStore.js`: `forecast_runs` + `daily_positions` per IST day (needs SQL; fails open); `accuracyFromRuns` grades saved runs at 7 and 28 days.
- Wired: `/api/tally?action=analytics` returns `forecast_v2` (+ records daily); `margynWatch.watchAccount` records daily for every account with books.
- Books declare `balance_convention` ('opposite' for Zoho/Odoo adapters); `tallyAnalytics.asOfToday(…, conv)` adds entries made ahead back for those; sign inference falls back to the declaration.
- App: `app/js/19a-forecast.js` `mgForecast()` uses `forecast_v2` by default (adds `learned`, `v`, `low`, `high`); "My own assumptions" (old arithmetic) under Adjust (`preferences.forecast.mode`). Band + hover on the chart, Cautious/Hopeful columns, Cash page "How Margyn built this" (`mgForecastHowPanel`) and "Week by week this year" (`mgPositionHistoryPanel`, four small charts). Voice/explain tools, formula catalogue, What's new entry updated.

## Accuracy (live self-check, Care Hygiene, after #70)
- Customer money in, 4 weeks: 5.9% average miss, lean −2.1% (first version: +19% to +60%).
- Cash before loans/overdraft: 4 weeks typical miss ₹25.6 L (lean −₹2.4 L); 8 weeks ₹28 L (lean +₹5.5 L). Care Hygiene collects ~₹2.4 Cr/month.
- Suppliers: weekly pace chosen (bill-by-bill missed more over 4+8 weeks).
- Tests: `cashFlowModel.test.js` 44/44, `cashFlowAccuracy.test.js` 14/14 (250-customer books with opening balances: habit book 1.5% miss, random-lag book 5.0%), `tools/ui-forecast-test.js` 26/26, all other api + UI tests pass.

## How accuracy was worked (keep doing it this way)
1. Every change is scored by the self-check on the business's own past weeks; live numbers decide, synthetic tests guard regressions.
2. A version that wins tests but loses live is reverted (happened: stricter counting alone made Care Hygiene lean +5%; the real cause was customers slowing, fixed by recency).
3. Never tune thresholds to make a test pass; when a fixture hits a known limit (out-of-order payers vs oldest-first matching), say so in the test and fix the fixture's purpose.
4. Real-data backtests run server-side through the self-check. Pulling a customer's books into a browser to backtest was blocked by auto mode: don't do that.

## Known issues / watch
- `/api/tally?action=analytics` now ~12 s on Care Hygiene (was ~8 s before the forecast); the app aborts at 20 s. If it grows: cache the self-check per sync, or move it to the daily Watch run and store it in `forecast_runs`.
- Floor (two weeks of spend, ₹1.2 Cr for Care Hygiene) flags every week for an overdraft business: needs the overdraft limit (see "store next").
- Forecast is cash **before** loans/overdraft: for Care Hygiene it climbs to ~₹90 L+ by January because surplus usually goes to the overdraft. The page says so; a headroom view needs the OD limit.
- GST "paid from elsewhere" is inferred from three months of no tax out of cash; if a business pays GST through a ledger Margyn files elsewhere, it would wrongly drop GST (the note says what it did).

## VP still owes (SQL)
- `2026-10-04-forecast-learning.sql` (forecast_runs, daily_positions). Without it the forecast works but has no saved track record.
- `2026-10-04-books-layer.sql` if not yet run.

## What to store next (from the plan, in order)
1. Overdraft limit + loan terms per account (floor/headroom).
2. Promise outcomes per customer (kept/late/broken → weight promises, chase order).
3. Weekly per-customer habit snapshot (who's slowing down alert).
4. Tally bill allocations (agent reads BILLALLOCATIONS → exact invoice matching).
5. Last FY sync (seasonality). 6. Suggestion outcomes. 7. User corrections to recurring items. 8. Bank feed (AA).

## Run the tests
```
for f in api/_lib/__tests__/*.test.js; do node "$f" | tail -1; done
node tools/serve-static.js "$PWD" 5188 &   # first: lsof -nP -iTCP:5188 -sTCP:LISTEN (stale servers)
node tools/ui-forecast-test.js && node tools/ui-frame-test.js
```
