# Books health check: a recurring clean-up inside the app (7 Oct 2026)

VP: "We can't clean up once. It should be a recurring workflow within the app itself." The 4 Oct Care Hygiene audit found problems in the books by hand and sent one list to Mihir's accountant. Those problems are now rules that run every morning for every account with books (Tally, Zoho Books, Odoo).

## What it checks (api/_lib/booksHealth.js)
| Kind | Finds | Care Hygiene shape (tested) |
|---|---|---|
| interest_under_income | interest on an overdraft or loan filed under an income group, with money going out on it | INTEREST ON OD ₹5.43 L |
| costs_not_booked | a closed month whose running costs are under 40% of the usual (analytics `costs_incomplete`) | Sep ₹2.66 L vs ₹41.8 L |
| name_vs_group | an expense-named ledger in a Sales/Income group with net money out (or named "…EXPENSES" and unused: a low tidy-up), or the other way round. The rules come first. The Jev classifier runs only behind `JEV_MODE_BOOKS_HEALTH` = off/shadow/live, default off | "TRANSPORT/ COURIER EXPENSES" under Sales Accounts (no entries this year → low) |
| cash_negative | cash in hand below zero, plus the biggest journal entries out of Cash | −₹41,091 (partner remuneration) |
| supplier_bills_settled | supplier bills still open bill-wise while the ledger shows them settled (`billTieOut.partyGaps`) | Sanjay Plastics 7 bills ₹14 L vs ₹11.5k; Royal International ₹9.1 L vs 0 |
| customer_bills_paid / customer_unbilled | customer bills still open but paid in the ledger / a ledger balance with no bill behind it | ₹47.2 L across 45 / ₹21.6 L across 21 |
| suppliers_not_billwise | `suppliers_tracked_billwise === false` | 56 of 61 |
| old_debt | customer bills more than 365 days late, for a settle / chase / write-off decision | Glenmark 1,327 days |
| entered_ahead | entries dated after today (for information only) | 6 EMIs Oct–Mar |
| later_entries_balance | the tie-out guard found that Tally's balances already stop at today | none (see below) |

## Tie-out guard (tallyAnalytics.asOfToday)
`asOfToday` backs later-dated entries out of the closing balances on the assumption that Tally's closings run to year-end. The agent's ledger request sends no SVTODATE, and the agent request is unchanged. The guard checks each cash, bank, overdraft or loan ledger that a later entry touches: opening + entries up to today, against Tally's closing, both with and without the later entries. If no ledger ties *with* them and more ledgers tie *without* them than tie neither way, nothing is backed out (`guard.decision = 'kept'`) and a health item is raised. The Cash page summary can't run the guard because it reads only the later entries, so it follows the last check's decision (`books_health` run row `data.as_of_decision`). Live pre-check on Care Hygiene: 7 cash/OD ledgers walk back to Tally's opening with 0 gaps (convention "same"). The balances include the EMIs, so the guard backs them out as before and cash is unchanged.

## Workflow
- Runs in `margynWatch.watchAccount` on the morning slot (07:30 IST cron), for every account with books, whatever the WhatsApp mode. No new function, so the count stays at 12.
- The app's GET runs it again when the last check is more than 20 hours old, or when someone presses "Check again".
- Table `books_health` (SQL `2026-10-07-books-health.sql`): one row per stable key with status open / fixed / ignored, first_seen, last_seen, fixed_at, amount and ignored_amount. Only the server writes; owners read their own rows.
- A finding missing on a later run is marked fixed, but only if its kind was actually judged on that run (for example, no bills synced means no bill items close). A fixed finding that comes back reopens. An ignored finding comes back only when its amount moves by more than 25%.
- Before the SQL runs, the panel shows today's findings without history.

## Where people see it
- **Organisations and sources → Books health check** (above "Is all your data in?"). Findings are grouped by kind, each with what the accountant should do, plus Ignore / Bring back and sections for Ignored and Fixed in the last 30 days.
- **Send to my accountant** shows the list first. "Open in WhatsApp" opens a share link and the person picks the chat and presses send; "Copy" copies the list. Margyn never sends it by itself.
- **Home → Needs you**: "N things in your books need your accountant", with Show them / Send to accountant.
- **Margyn** (chat, voice, WhatsApp): the `books_health_check` tool answers "what's wrong in my books?". There are now 12 books tools and 18 tools in total. It respects ignored items and each team member's access by area.
- What's new: `2026-10-07-books-health`.

## Endpoints
- `GET /api/tally?action=books-check[&refresh=1]`
- `POST /api/tally?action=books-check-set` `{ key, status: 'ignored'|'open' }`. Team members need edit; the change goes to the Audit log.

## Tests
- `api/_lib/__tests__/booksHealth.test.js`: 58 checks covering every check with the Care Hygiene shapes, the guard both ways, lifecycle, the accountant list, access and the classifier switch. The fixture is in `booksHealthFixture.js`.
- `tools/ui-books-health-test.js`: the panel, Ignore/Bring back, the send dialog (nothing sent before a press), Home and What's new.
- jevRouterHandler counts are now 12 of 18.

## Live on Care Hygiene (7 Oct, read-only, before the SQL; as mihir@carehygiene.in via the API)
78 open, 77 for the accountant, 4 high. Read in 8.7 s (cold).
- Cash in hand −₹41,091 · INTEREST ON OD ₹5.43 L · September costs short by ₹39.1 L (₹2.66 L vs ₹41.8 L) · Sanjay Plastics 7 bills (₹13.9 L more than the ledger) · Royal International ₹9.1 L · 6 EMIs dated ahead ₹9.45 L. All match the 4 Oct audit.
- Customers: 44 with paid bills still open (₹53.1 L) and 21 unbilled (₹21.5 L). Today's receivables tie-out gives 46 / ₹53.1 L and 22 / ₹21.5 L. The difference is three gaps under the ₹500 minimum (₹782 in all). The audit's ₹47.2 L was the books on 4 Oct.
- 61 of 63 suppliers aren't kept bill-wise (₹1.72 Cr). 3 debts over a year, Manek Surgicorp ₹2.12 L the biggest.
- Name vs group: "DISCOUNT RECEIVED" under Purchase Accounts (₹1.9 L credit). "TRANSPORT/ COURIER EXPENSES" sits under Sales Accounts with no entries this year. The first PR missed it because it only looked for money going out; PR #87 adds it as a low tidy-up. The courier ledgers that are actually used sit in the TRANSPORT CHARGES group, which is under Direct Expenses, so they're right.
- Tie-out guard: 7 cash/OD ledgers walk back to Tally's opening with 0 gaps, so the EMIs are included in the balances. They're backed out as before, and cash is unchanged.

## Open
- Watch WhatsApp messages don't mention new health items yet; the check is in the app only.
- Turning on the Jev name classifier needs `JEV_MODE_BOOKS_HEALTH=shadow`, reading the `[booksHealth] classifier shadow` logs, then `live`.
