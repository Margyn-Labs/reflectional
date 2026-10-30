# Zoho audit (30–31 Oct 2026)

Tracks `HANDOFF-ZOHO-DEMO-READY-2026-10-30.md`. **Code** means checked in the code and covered by tests. **Live** means checked against Zoho (org 60082308675, read-only through the web session) or the live app on MARGYN DEMO, which is Zoho-only since Varad disconnected Tally on 30 Oct.

Tests: `for f in api/_lib/__tests__/*.test.js; do node "$f"; done` → **56 of 56 files pass** (30 Oct, 17:00 IST, after the round-2 fixes below).

## Live results (30 Oct 2026, ~01:30–02:30 IST)

### Counts: Zoho → Margyn

| Module | In Zoho | In Margyn | Result |
|---|---|---|---|
| Invoices | 1,001 (20 void, 771 overdue) | 1,001 | ✅ Match |
| Bills | 63 | 63 | ✅ Match |
| Customer payments | 167 | 167 (501 rows across 3 org rows; 167 on the active org) | ✅ |
| Vendor payments | 24 | 24 | ✅ |
| Bank accounts | 3 | 3 | ✅ |
| Contacts | 91 (66 customers + vendors) | in party master | count now saved each sync |
| Items | 10 | 10 | ✅ |
| Credit notes | 9 | 9 (line queue) | ✅ |
| Vendor credits | 0 | 0 | ✅ |
| Expenses | 2 | through postings | ✅ covered (P&L ties) |
| Journals, sales/purchase orders, estimates, recurring, retainers, projects, inventory adjustments | 0 each | — | nothing to pull on this org |
| Item lines | 1,053 live documents | 293 read | ⏳ filling (daily allowance) |

**Old connections:** 4 `zoho_organizations` rows for the same Zoho org (3 disconnected, each keeping its own copy of 1,001 invoices). Every figure reader filters to the active org ✅, **except** WhatsApp's invoice-status lookup, which searched all of them → **fixed**.

### Tie-outs: Margyn vs Zoho's own reports

| Figure | Zoho report | Margyn | Result |
|---|---|---|---|
| Oct net sales | ₹63,43,117 (P&L) | ₹63,43,117 | ✅ exact |
| Oct cost of goods | ₹3,52,385 | ₹3,52,385 | ✅ |
| Oct running costs | ₹8,03,870 | ₹8,03,870 | ✅ |
| Oct net profit | ₹51,86,862 | ₹51,86,862 | ✅ exact |
| Cash | ₹24,67,574 (HDFC ₹25,17,574, petty cash −₹50,000) | ₹24,67,574 | ✅ |
| Receivables | ₹3,98,47,964 (AR aging) | Zoho group ₹3,98,47,964; page total ₹4,00,48,964 | ✅; the ₹2,01,000 gap is 3 entries typed into Margyn's own ledger (Bluecrate Commerce, Kirana Junction, Sanjay Pandey), shown as their own source by design |
| Overdue receivables | ₹3,45,98,018 | ₹3,47,99,018 | ✅ same ₹2,01,000 self-entered |
| Payables | ₹65,80,298 (AP aging) | Zoho group ₹65,80,298; page total ₹70,13,798 | ✅; ₹4,33,500 is 6 self-entered entries (WeWork, AWS, Meta Ads…) |
| Top 3 customers owed (Customer Balances) | Mehta Traders ₹15,48,005 · Gupta Exports ₹15,38,915 · Bluecrate Exports ₹14,91,933 | Margyn chat: ₹15.5 L · ₹15.4 L · ₹14.9 L, same order | ✅ |
| Below cost (Sales by Item) | Hand Rub 557 sold, ₹89,120 | Margyn: Hand Rub 557 at ₹160, −₹13,925; Thermometer −₹11,550 | ✅, with "complete only after 20 Aug" said |

### What a Zoho-only owner would have seen wrong (all fixed in this PR)

| Where | Problem | Fix |
|---|---|---|
| Home "Sources disagree" | `Tally ₹0`, `Tally ₹76,000` rows kept after Tally was disconnected | snapshot rewritten when the sources behind figures change (`15-scoring.js provenanceDiffers`), checked on live data |
| Home/GST card | "Estimate from Tally books, last month" | same snapshot fix |
| Inbox / Home | "Test Customer invoice 1 — ₹50000" proposal from the Tally connection | waiting proposals from a connection that's gone expire on the next agent run (`reconcile.js`, new test) |
| Home "needs your accountant" | "Test Supplier: 1 bill still open" from Tally's books check | findings from another books system close on the next check (`booksHealth.js`, test) |
| Margin / Cash flow / CFO pack | "Nov 2025 looks unfinished in Tally", "Worked out from every Tally entry", "Tally's stock value" | names the books system; an unfinished month only headlines if it's within 3 months |
| Ledger | empty "Tally books" tab saying "Tally isn't connected" | hidden while Zoho or Odoo keeps the books |
| Chat (and voice) | prompt said "YOUR BOOKS (TALLY)", "When Tally is connected…"; answer added "Tally isn't connected… earlier Tally showed ₹76,000" | prompt names the connected books system; no Tally block on a Zoho account (tests for all three cases) |
| **Watch WhatsApp updates** | every daytime pulse would say "⚠️ Tally hasn't synced since … Is the Tally PC on?" (Zoho syncs nightly, so 2–26 h gaps are normal); the stale-sync point told a Zoho owner to switch on the Tally PC | the intraday gap warning is Tally-only; the stale point names Zoho and says "press Sync now" (tests) |
| Watch / answers | "not knocked off in Tally", "opening balance Tally has" | named after the books system |

### Margyn answers on Zoho (live, app chat with the app's real context)
- "Which products am I selling below cost?" → ✅ right items and amounts, says how far item lines have got.
- "How much did I sell in October and what was my net profit?" → ✅ ₹63.4 L / ₹51.9 L.
- "Top 3 customers by what they owe" → ✅ matches Zoho's Customer Balances.
- "Cash balance" → ✅ ₹24.7 L, broken down by account (the Tally remark it added is fixed by the prompt and snapshot changes).


---

## Task 1: Completeness

### Module coverage

| Zoho module | Status | How |
|---|---|---|
| Chart of accounts + account transactions | Pulled | `sync.js` |
| Invoices, bills | Pulled; the weekly sweep checks counts against Zoho's own | `sync.js` sweep, `count:invoices` / `count:bills` |
| Customer and vendor payments | Pulled | `sync.js` |
| Bank accounts | Pulled (balances) | `sync.js` |
| Contacts | Pulled into `ledger_parties`; **Zoho's count is now saved** (`count:contacts`) | `zohoParties.js`, `sync.js` |
| Items | Pulled; **count is now saved** (`count:items`) | `items.js` |
| Item lines (invoices, bills, credit notes, vendor credits) | Pulled one document at a time, under a daily budget | `items.js` |
| Credit notes, vendor credits (as documents) | Listed for item lines. Their money arrives through postings | `items.js` listReturns |
| Expenses, manual journals | Covered by postings (account transactions) | handoff; **live check pending** |
| Opening balances, TDS/TCS | Unverified: the app doesn't claim them | **live check pending** |
| Sales/purchase orders, estimates, recurring templates, projects, timesheets, bank statement lines | Not needed: they don't change what is owed or earned until they become an invoice, bill or posting | the app says so on screen |
| Retainers / advances, multi-currency, inventory adjustments | Gap, to decide after live check | — |
| GSTR-2B | Pulled | `sync-gstr2b.js` |

### Count check per module (live): **pending**
Known figures for MARGYN DEMO: 1,001 invoices (20 void), 66 contacts, 10 items, 1,053 documents for item lines (220 read on 30 Oct).

### Limits and edge cases

| Check | Result | Notes |
|---|---|---|
| >1,000 rows | Code pass | the new queries use `selectRows` with limit 100000/200000, which auto-pages |
| Void, draft, deleted documents | Code pass (existing tests) | lines dropped; open counts leave them out |
| Edits after first sync | Code pass (existing tests) | `last_modified_time` re-read |
| 429 mid-sync | Code pass | item queue stops, reads already started finish, the rest stay queued |
| Token expiry with parallel reads | **Fixed** | token refresh is now single-flight: 3 readers never trigger 3 refreshes |
| Free-plan daily cap | Code pass | calls in flight now count against the budget, so 3 parallel readers never cross the 200-call reserve (test: "never past the reserve") |
| Several financial years | Live check pending | |

### Slow item fill

| Fix | Status |
|---|---|
| 0. Item totals from Zoho's reports | **Probe ran: error** (02:47 IST, 30 Oct, see round 2). Not possible with today's scopes → fix a. **Probe built.** Once a week until it answers, the nightly sync makes 1 call to `reports/salesbyitem` with our OAuth token and records success/error in `zoho_sync_state` `probe:salesbyitem`. A refusal never marks the connection for reconnect. The first nightly run after deploy tells us whether fix 0 is possible. |
| 0b. Temporary limit raise email | Not started |
| a. Zoho export import | **Planned (round 2)**; needs Varad to export once from the test org to confirm the columns |
| b. Use the allowance faster | **Done.** 3 reads at once, call starts 650 ms apart (~90/min, under Zoho's 100/min and 5 concurrent). About 370 documents per 240 s run, up from about 200. The daily allowance is still the real ceiling on Free. |
| c. Only read what changed | Already built (test: "unchanged documents never re-read") |
| e. Say it plainly | Already built; also now in the data check |

### Zoho "Is all your data in?"

| Check | Result | Fix |
|---|---|---|
| Account with Zoho books and a stale Tally connection (MARGYN DEMO) | **Fail → fixed.** The server checked Tally whenever any Tally install was active, and the app said "Checking your Tally data…" | Server follows the account's books system (`choosePrimary`); the app names Zoho Books |
| Per-module rows | **Added:** bank accounts, customers and suppliers (with how many have a phone, for Chase), items, item lines N of N with "complete only after <date>", credit notes and vendor credits, and "What Margyn doesn't read from Zoho" | `dataCompleteness.js`, `tally.js`, tests in `zohoParity.test.js` |

---

## Task 2: Correctness (live tie-outs): **pending**
Needs Zoho's P&L, BS, Cash Flow, AR/AP aging, Sales by Customer/Item, Purchases by Item, and Customer/Vendor balances for the same dates, read through the web session.

---

## Task 3: Connected

### Code-scan leads (verified in the code)

| Lead | Result |
|---|---|
| `whatsappAgent.js` `tally_bills` / `tally_vouchers` | Pass: only inside `get_tally_data`, a Tally-only count tool. Every figure on WhatsApp comes from `booksTools` (all books systems) |
| `margynWatch.js` runWatchAll | Pass: lists Tally **plus** `zoho_organizations` and Odoo |
| `reconcile.js` | Pass: every all-users list includes `zoho_organizations` |
| `moneyModel.js` `loadTallyBills` | Pass: the Tally loader only; Zoho has its own path |
| `booksTools.js` empty state | Pass: Tally wording only when the source is Tally; otherwise names the source |
| Data check names Tally on Zoho books | **Fixed** (above) |
| App `=== 'tally'` checks | Pass on read: each branches to a Zoho/neutral path (GST card says "From Zoho Books"; forecast opening cash falls back to the snapshot cash, which comes from Zoho bank balances) |

### Feature checklist on the Zoho-only account (live): **pending**
Chase, Watch, Close & Collections, Forecast, Cash flow, CFO pack, Pulse, Books health, Conversations, Voice incl. `show_chart`, WhatsApp, Party master, Invoicing, Channel health, Ops console, demo no-send.

### Demo-data clean-up on MARGYN DEMO (Varad's OK needed)
Disconnect the stale Tally test connection: it causes "Tally needs attention", "Sources disagree: Tally ₹0", the Test Customer ₹50000 and Test Supplier cards, and GST "from Tally".


---

## Round 2 (30 Oct 2026, 16:15–17:30 IST): probe, Tally leftovers, live feature checks

Checked live on MARGYN DEMO (www.margynlabs.com/app.html, signed in) and against Zoho's own reports (org 60082308675, read-only web session).

### 1. Nightly sync and the `reports/salesbyitem` probe

| Check | Result |
|---|---|
| Nightly sync, active org `e5a18507…` | ✅ ran 02:47 IST, 30 Oct (`last_synced_at` 2026-10-29T21:17Z). Item lines moved from 370 to **526 of 1,053**. |
| `probe:salesbyitem` | ❌ **error** (`last_run_status = error`, 21:17:05Z). The reason text is only in the function log, and Vercel Hobby keeps logs for 1 hour, so it's gone. Most likely cause: our token holds no reports scope (`SCOPES` in `zohoClient.js` has none), so Zoho refuses `/reports/*` (code 57). The probe retries weekly. |
| Decision | **Fix 0 is off** for now. Adding `ZohoBooks.reports.READ` to the scopes before Monday is too risky: it's undocumented, and if Zoho rejects the scope name at consent, every new Zoho connection fails on demo day. → **fix a**. |

**Fix a plan (Zoho's own export, no API calls):**
1. Varad exports once from the test org (Sales → Invoices → ⋯ → Export, CSV, "all invoices"; the same for Bills, Credit Notes and Vendor Credits) so the real columns are known: Invoice Number, Invoice Date, Item Name, SKU, Quantity, Item Price, Item Total, Discount, Tax.
2. `api/_lib/importMapper.js` gets a "Zoho export" shape: a file whose header matches it skips the AI mapping. Rows group by document number, match `zoho_invoices` / `zoho_bills` by number (active org only), and are written to `zoho_document_lines` with `source='zoho_export'`.
3. Each matched document gets `zoho_line_state.read_modified = doc_last_modified`, so the API queue only reads documents edited after the export.
4. Parity test: an export file plus the API lines for the same documents give the same `products` answer and Margin item table.
5. Onboarding line on the Zoho card while lines are filling: "Have a lot of history? Export invoices and bills from Zoho and drop the files into Import: item figures are complete in minutes."
6. Also send Zoho support the limit-raise email (0b) for the investor's org if their books are big. Template to write.

Not built this round: it needs the real export columns, and the demo account's item figures already say plainly which dates are complete.

### 2. Tally leftovers on Home

| Leftover | Result |
|---|---|
| "Sources disagree … Tally" | ✅ gone. Now Zoho Books against Manual entries (Acme Retail, Northwind Retail): real, from the 3 self-entered rows |
| GST "Estimate from Tally books" | ✅ gone. Now "n/a · No GST source connected" (the test org isn't GST-registered) |
| Test Customer ₹50000 proposal | ✅ `agent_actions` status `expired`; Inbox "Queue clear" |
| Test Supplier books finding | ✅ `books_health` status `fixed` (source tally); open findings are both Zoho's |
| **"Read Tally · just now"** in Home's "What I'm working on" | ❌ → **fixed.** `27-live-work.js` labelled every `/api/tally?action=status` call "Read Tally"; the app calls it on every account. Now it names the account's books system ("Read Zoho Books") |

### 3. Live feature checks on MARGYN DEMO

| Feature | Result | How checked / fix |
|---|---|---|
| **Payment Chase** (preview) | ✅ pass, with one deploy note | `chase-preview` answers: deployed, `include_books: true`, 1 preview (Chase Test Co., final reminder, word for word). Chase is **paused**, so the queue isn't refreshed from Zoho, which is by design; not resumed because **MARGYN DEMO has external sends ON** (`sends_off: false`). **The investor account must get `external_sends='off'` before it connects** (deploy step 1). Zoho-customer queueing is covered by `zohoChasePreview.test.js` |
| **CFO pack** | ✅ figures tie out; 2 wording bugs fixed | Sept: revenue ₹47,43,460 = Zoho P&L; spend ₹6,54,286 = COGS ₹3,37,265 + opex ₹3,17,021; net profit ₹40,89,174; books cash at 30 Sept ₹13,88,544 = HDFC ₹14,38,544 − petty cash ₹50,000; 31 Aug ₹14,94,829 ✅. **Fixed:** the P&L note said "from Tally’s books" on Zoho; GST said "GSTR-2B matching needs Zoho Books connected" while Zoho is connected. **MARGYN DEMO only:** Sept's tiles use a 27 Sept reading taken before the seed history existed (cash −₹50,000, receivables ₹1,00,000, Pulse 55 from zeros). A fresh account has no old readings, so it gets the books figures above. To clean MARGYN DEMO, delete its pre-30-Oct `snapshots` rows (Varad's OK) |
| **Pulse + "What would move it"** | ✅ pass | 69, Caution; 5 vitals all from Zoho; GST input credit "not measured", left out of the score and said so; the link opens Pulse with each vital's points and weight |
| **Forecast** | ✅ pass | Opening ₹24.7 L = Zoho cash; floor ₹5.8 L; self-check "last 9 weeks: within 79%, cash 4 weeks out within ₹6.5 L"; named "Learned from your books" |
| **Cash flow** | ✅ pass, ties out | Start of year ₹8.8 L = Zoho BS 31 Mar (HDFC ₹8,79,975); profit year to date ₹2.43 Cr = Zoho P&L 1 Apr–30 Oct (₹3,17,34,342 − ₹19,46,409 − ₹54,41,812 = ₹2,43,46,121); cash ▲ ₹15.9 L to ₹24.7 L = ₹24,67,574 − ₹8,79,975 ✅. (Zoho's own Cash Flow API ignores `from_date` and returns the current month; its October figures, opening ₹13,88,544 and ending ₹24,67,574, also agree) |
| **Books health / Send to my accountant** | ✅ pass | "Margyn Labs · Zoho Books" (= Zoho org name). 2 open findings, both real in Zoho: Petty Cash −₹50,000 (BS), Nov 2025 ₹23.1 L sales with ₹0 expenses (P&L). Send opens the list first; Margyn sends nothing itself |
| **Conversations** | ✅ pass | MARGYN DEMO's own history (old Tally questions from 11–15 Oct stay as history; a fresh account starts empty) |
| **Voice/chat `show_chart`** | ✅ pass | On Margin, "show me a graph" → "Sales by month, 2026-27" chart, per your Zoho Books; Oct ₹63.4 L, year ₹3.17 Cr = Zoho |
| **"Is all your data in?"** | ✅ Zoho rows shown; 1 bug fixed | All rows present (invoices 1,001 = Zoho, bills 63, postings 1,249, banks 3, items 10, item lines 526/1,053 "complete only after 2026-06-21", credit notes 9). **Fixed:** "1 of the 91 customers and suppliers in Zoho are in Margyn" (warn) and "1 contacts" in the header. A Zoho contact becomes a saved party only when Zoho has a phone, email or GSTIN for it, and only 1 does; all 48 invoiced customers show on Customers from their invoices. The sync now counts contacts with details (`count:contacts_with_details`); the check compares saved parties with that count and the header shows Zoho's 91. Tests in `zohoParity.test.js` + `zohoChasePreview.test.js` |
| **Channel health** | ✅ pass | Chases 3 delivered, Margyn updates 25 delivered, Bells "Not set up" (true), CFO pack "nothing sent yet" |
| Ledger | ❌ → **fixed** | The "Tally books" tab still showed on Zoho: the "Straight from TallyPrime…" intro line stayed visible, and that alone kept the tab. It's hidden now while Zoho/Odoo keep the books (checked in the live page: Entries · Position · Checks) |
| Margin "What stands out" | ❌ → **fixed** | "Item margin moved ₹0 from Aug to Sep: selling price 0, purchase cost 0, volume and mix 0". No item sold in those months had a purchase cost (sales-only Consulting/Goods), so there is no bridge. It's now left out (`tallyAnalytics.js`, test fails without the fix) |

### Round-2 PR: files
`app/js/27-live-work.js`, `app/js/19e-cfopack.js`, `app/js/11-connectors.js`, `app/js/24-whats-new.js`, `api/_lib/dataCompleteness.js`, `api/_lib/zohoParties.js`, `api/_zoho/sync.js`, `api/tally.js`, `api/_lib/tallyAnalytics.js`, tests `zohoParity.test.js`, `zohoChasePreview.test.js`, `tallyAnalytics.test.js`. No SQL.

### Still open
- Fix a (export import), once Varad has exported once from the test org.
- MARGYN DEMO clean-up (Varad's OK): pre-Zoho `snapshots`, and the 3+6 self-entered receivable/payable rows if the demo should show Zoho only.
- Retest the probe weekly. If Zoho support confirms a reports scope, revisit fix 0 after the demo.
- Not run this round: Watch WhatsApp pulses on a Zoho-only account (needs the investor account), WhatsApp questions/forwarding, Invoicing, Ops console.

### Round 3 (30 Oct, evening): Sanjay chase test + more fixes
- **Mihir/Tally safety:** every change in #136 behaves exactly as before on a Tally account (the margin-bridge change is Zoho/Odoo only; CFO pack still says "Tally’s books"; "Read Tally" stays on Tally). #136 merged (40c00c4).
- **Chase test set up on MARGYN DEMO:** Zoho contact **Iyer Retail Pvt Ltd** got mobile +91 9833325560 (Sanjay, Varad's number; written in Zoho on Varad's say-so). Zoho synced, so the number is in Margyn. Chase resumed with books customers on. Chase Test Co. switched off. Every other number Margyn holds (…1510, …2520, and another number ending 5560) is on Chase's opt-out list. Preview: **exactly 1 reminder with a phone**: Iyer Retail, ₹4,89,995, goes at the 10:30 am run on 31 Oct.
- **Fixed (PR #137, MERGED 4ae41f6):**
  - the reminder read "is due 303 days overdue"; it now reads "is due and now 303 days overdue";
  - chat said Zoho had "no successful sync on record"; the Zoho status now carries `last_synced_at`;
  - the margin tool note said "Single source (Tally)" on Zoho.

---

## Round 4 (31 Oct 2026): item lines on every plan, and the open gaps

Tests: `for f in api/_lib/__tests__/*.test.js; do node "$f"; done` → **57 of 57 files pass** (plus `aiCost.test.mjs`). New file `zohoExportImport.test.js` (60 checks); new sections in `zohoParity.test.js` (export parity, Watch parity) and `investorFunnel.test.js`.

**Mihir / Tally:** nothing in the Tally agent, Tally sync or any Tally reader changed. Shared files touched: `watchBrief.js` / `margynWatch.js` (one wording helper: "Tally books" stays "Tally books"; only a name ending in "Books" drops the extra word), `14-auth-import.js` (a Zoho export is spotted first; every other file goes the old way, 2 MB limit unchanged), `08-khata.js` (a note shown only when Zoho Books keeps the books). No SQL.

### Item lines: one answer per plan

| Plan | What happens now | Done by |
|---|---|---|
| **Any plan: fix a, Zoho's own export** | Owner exports Invoices, Bills, Credit Notes, Vendor Credits from Zoho and drops each file into **Import**. Margyn spots the export header (`importMapper.detectZohoExport`), skips the AI, matches each document to the active connection by Zoho id or number (`_zoho/exportImport.js`), writes `zoho_document_lines` with the same arithmetic as the API (`items.documentLines`: base currency, inclusive tax out, document discount spread) and marks it read in `zoho_line_state` at the version Margyn knows, so the queue only re-reads later edits. Void/draft skipped; unknown numbers listed; a line with an item Margyn doesn't know leaves that document to the API queue (never half-read). Zero Zoho calls. | Minutes |
| **Paid: Standard 2,000 / Professional 5,000 / Premium, Elite, Ultimate 10,000 a day** | (1) Plan names matched by keyword ("Standard (Annual)", "Professional Plan"); trials and unknown names get 1,000 (safe). (2) Zoho's own `X-Rate-Limit-Limit/-Remaining` headers, when sent, win over the table and are remembered (`zoho_sync_state` `api_limit`), so trials and support raises are used. (3) **Follow-on fill**: one run reads ~370 documents (240 s at Zoho's 100/min, the same on every plan), so after connect, after the 2:30 am run, and after each of its own runs, the fill calls itself again (`/api/zoho?action=fill-chain`, CRON_SECRET, at most 48 hops) while documents and allowance above the 200 reserve are left. | Professional with 3,000 documents: ~36 min after connect. Bigger: by next morning |
| **Free (1,000/day)** | Same follow-on fill inside ~600 documents a day; the card points to the export and the limit-raise email when it's more than a night. | 1,053 docs: 2 nights, or minutes with the export |

The **Zoho Books card** now says when it will be done ("done in about 36 minutes" / "by tomorrow morning" / "in about 3 days at Zoho's daily limit", `items.fillEta`). When it's days, it shows "Have a lot of history? Export … drop into Import" and "ask Zoho for a short limit raise". **Is all your data in?** says the same.

**Parity (Varad's bar: same exactness as the Tally books):** the same documents filled from the export and from the API give identical lines (item, qty, value, date) and identical `products` answers (all, below cost, one item) and Margin item table (`zohoParity.test.js`, `zohoExportImport.test.js`).

**Not yet confirmed live:** the export's exact column names (built from Zoho's documented field names, matched loosely; one question sent to the parent session asking Varad for a sample export), and whether Zoho's OAuth answers carry `X-Rate-Limit-*` headers (if not, the plan table is used, as before). The follow-on hop relies on Vercel finishing a function after its caller stops waiting; if a hop is ever lost, the next night carries on.

### Fix 0b: limit-raise email (in the app)
Zoho Books card → "ask Zoho for a short limit raise" opens a ready email with the org name, org ID, plan, calls a day needed (pending + 1,000, at least 5,000) for 7 days, and the read-only workflow. The owner sends it from their own address; Margyn sends nothing. Template text: `ZOHO-LIMIT-RAISE-EMAIL.md`.

### Fix 0: reports scope (research only, nothing changed)
Zoho Books' OAuth page lists 15 scopes: contacts, settings, estimates, invoices, customerpayments, creditnotes, projects, expenses, salesorders, purchaseorders, bills, debitnotes, vendorpayments, banking, accountants. **There is no reports scope**, and the page documents no reports endpoints (https://www.zoho.com/books/api/v3/oauth/). So `reports/salesbyitem` refusing our token is expected and fix 0 stays off. Only Zoho support could say otherwise; ask in the limit-raise thread after the demo.

### The other open gaps

| Gap | Result | How checked / fix |
|---|---|---|
| **Watch WhatsApp updates** (morning, 12:30, 3 pm, 5 pm, evening) on a Zoho-only account | ✅ runs, same figures as a Tally account, 1 wording bug fixed | `zohoParity.test.js`: the same business kept in Zoho and in Tally; every slot's text is identical figure for figure, Zoho never says Tally. Account listing includes Zoho (`runWatchAll`), the Tally mid-sync wait never holds a Zoho account (`syncState` reads Tally installs only), the sync-gap alarm is Tally-only (round 1). **Fixed:** "Your Zoho Books books as of …" → "Your Zoho Books as of …". |
| **WhatsApp questions** | ✅ | Same 12 books tools as app chat; `zohoParity.test.js` checks every tool's answer Zoho = Tally |
| **WhatsApp forwarded documents** | ✅ same as Tally | Lands in Suggestions for approve/reject; approval writes Margyn's own ledger only and queues a write that stays "saved in Margyn" (no writer exists for any app; no Zoho write scope). A forwarded invoice that's also in Zoho shows as its own manual source, as on Tally |
| **Invoicing** | ✅ works; honest note added | Margyn's own invoice maker, same on every account. On a Zoho account it now says an invoice made here stays in Margyn (Margyn never writes to Zoho), so raise invoices in Zoho to keep one set of figures |
| **Ops console** | ✅ + item-fill runs added | Investor funnel/timeline is Zoho-based already; now also shows item-fill runs and export imports as line counts only (no names, no message text; test) |
| Expenses / manual journals | ✅ covered by postings (P&L ties exactly, round 1) | — |
| Opening balances, TDS/TCS, several financial years | Not claimed by the app; live check still pending | Needs the investor's real books |
| Retainers / advances, multi-currency, inventory adjustments | Not read; multi-currency documents are converted to base currency per line (`bcy_rate`) | Say so if the investor uses them |

### Still open (needs Varad, not code)
1. Sample export from the test org to confirm the column names (one question sent).
2. MARGYN DEMO clean-up (pre-Zoho `snapshots`; 3+6 self-entered rows), only if the demo runs on MARGYN DEMO.
3. The investor account: `external_sends='off'` before connecting (deploy step 1 of round 2).

---

## Round 5 (30 Oct 2026, 18:00–23:30 IST): real Zoho exports, connect-only fill, item report, open list

Tested with Zoho's **real** export files (MARGYN DEMO org 60082308675, exported 30 Oct, read-only) and a read-only copy of the org's Margyn rows. Laptop only: **nothing pushed, no PR, nothing deployed.** Tests: **57 of 57 files pass** (+ `aiCost.test.mjs`).

**Varad's rule from this round:** connecting Zoho must bring everything in by itself. The export import stays as a backup nobody relies on; the app no longer points owners to it.

| # | Checked | How | Result | Fix (local, not live) |
|---|---|---|---|---|
| 1 | MARGYN DEMO shows Zoho only | Deleted 5 self-entered receivables (Bluecrate, Kirana, Sanjay, Acme, Northwind = ₹5,86,000), 6 payables (₹4,33,500), 86 pre-30-Oct `snapshots` (Varad ran the SQL). Backups in the browser's localStorage | ✅ Receivables ₹3,98,47,964 = Zoho AR; payables ₹65,80,298 = Zoho AP; Home "Your connected sources agree". Chase (Iyer Retail, 9833325560) untouched | — |
| 2 | Investor account sends off | Code read | ✅ runbook step exists (DEPLOY-2026-10-31-zoho-round2.md step 7). Catch: the `profiles` row exists only after the company form, so run the SQL after it (✅ "1 row affected") | — |
| 3 | Real export columns | 4 real CSVs through `parseZohoExport` | ✅ all four types detected. Credit notes export leaves "CreditNotes ID" blank → matched by number (works) | — |
| 4 | Account lines (rent, ads, "Return / discount": text, no Product ID) | Real files + fake DB seeded with real rows | ❌ 39 bills and the credit notes skipped as "unknown item" | ✅ dropped like the API does; amount kept for discount spread (`importMapper.js`, `exportImport.js`) |
| 5 | Export = API | 546 documents the API had read, rebuilt from the export | ✅ 546 / 546 identical (item, qty, value, date) | — |
| 6 | **Vendor credits never read** | Zoho list API live | ❌ list key is `vendor_credits`, Margyn read `vendorcredits`: always empty. APX-DN-1001 (₹4,750) missing → Oct Surgical Mask purchases 400/₹38,000 instead of 350/₹33,250 | ✅ key fixed; new cursor so the first run reads 12 months back (`items.js`) |
| 7 | **Item fill speed (connect-only path)** | `connector_logs` live: 7 runs read 68–118 docs each (~25/min). Zoho answers in ~0.5 s from India | ❌ each document waited on 3 database saves; 3 readers | ✅ saves batched (25 docs, 3 calls), 4 readers on Free / 8 on paid, allowance re-checked after each pause. Bench with Zoho at 2 s and DB at 0.6 s: **~300 docs per 4-min run (76/min)** on Free and paid. ETA now assumes 75/min (Professional, 3,000 docs: ~40 min) |
| 8 | Export import speed | Live drop on MARGYN DEMO | ❌ ~85 docs/min, cut off at the 300 s limit | ✅ batched writes (test: ≤3 writes per file) |
| 9 | Follow-on fill fires on Vercel | `connector_logs`, `zoho_sync_state` | ⏳ #138 went live 30 Oct after the nightly; today's free allowance was already spent (825 calls). **First real proof: 31 Oct 02:30 run** | Wired after connect, nightly and each hop (checked in code) |
| 10 | Sales / Purchases by Item, item × month | Margin engine `items_by_month` + chat `books_breakdown` on the real rows vs Zoho's reports (web session), Apr–Oct | ✅ **30 / 30 cells exact** (qty and ₹), returns netted as Zoho does; Oct net sales still ₹63,43,117 | ✅ new Margin panel "Sales and purchases by item" (month picker, Download), chat purchases by item (`quantity_bought`; before, "purchases by item" returned sales). Panel explains the ₹69,439 Oct gap to the P&L (credit notes with no item) |
| 11 | Running costs Nov 2025 ₹0 | Zoho P&L Nov 2025 | ✅ Zoho has no running costs that month either (net ₹23,12,821 both); Dec ₹6,38,002 = Zoho | none needed |
| 12 | Days to get paid 236 | Formula | ✅ DSO = owed ÷ last-90-day billing × 90; right for this demo (771 of 1,001 invoices overdue). Zoho's "24 days" is a different measure (paid invoices only) | — |
| 13 | "A typical invoice is paid in 333 days" | Real export: 98 closed invoices took 24.7 days on average (max 30) | ❌ FIFO put payments for new invoices on year-old unpaid ones | ✅ Zoho/Odoo: payments settle only invoices actually paid (each invoice's own balance); Tally unchanged. The wrong line disappears; forecast self-check typical miss 1 wk ₹2.40→2.24 L, 2 wk ₹3.86→3.64 L, 4 wk ₹6.48→5.26 L, 8 wk ₹12.07→12.97 L |
| 14 | "Sold more than bought" | Margin item table vs Zoho reports | ✅ true in the books: Hand Rub 557 sold / 200 bought, Thermometer 330 / 100; both sold below cost (₹160 vs ₹185, ₹240 vs ₹275) | — |
| 15 | Several financial years | Margin "Year by year" vs Zoho P&L | ✅ FY 2025-26 gross ₹1,32,95,400, net ₹1,13,54,147; FY 2026-27 gross ₹2,97,87,933, net ₹2,43,46,121: exact | — |
| 16 | Opening balances | Round 2: start-of-year cash ₹8,79,975 = Zoho BS 31 Mar | ✅ | — |
| 17 | TDS / TCS | All TDS/TCS export columns 0; no TDS account in the BS | n/a on this org. By design TDS sits in a balance-sheet account (never in profit) and Zoho closes the invoice, so Margyn shows it paid. Not testable without writing to Zoho | — |
| 18 | Margyn leads setup | Rendered in the live app (in-page preview only) | ✅ new: on an account with no books, Margyn opens Organisations and sources and offers Zoho / Tally / Odoo; Zoho opens its connect window; after connect Margyn says what's in, the item ETA, and opens Home | `25-margyn.js`, `11-connectors.js` |
| 19 | App points owners to manual export | Zoho card, data check | ❌ | ✅ removed; says Margyn keeps reading on its own + paid-plan limits + limit-raise email |

**Files (local):** `api/_lib/importMapper.js`, `api/_zoho/exportImport.js`, `api/_zoho/items.js`, `api/_lib/tallyAnalytics.js`, `api/_lib/booksEngine.js`, `api/_lib/booksTools.js`, `api/_lib/cashFlowModel.js`, `api/_lib/dataCompleteness.js`, `app/js/19i-margin.js`, `app/js/32-tabs.js`, `app/js/25-margyn.js`, `app/js/11-connectors.js`, `app/js/24-whats-new.js`; tests `zohoExportImport`, `zohoItemSync`, `zohoParity`, `cashFlowModel`; fixture `test-fixtures/zoho/export-real-2026-10-30.json`. No SQL. Mihir/Tally: the only shared logic touched (`cashFlowModel` matching) is Zoho/Odoo-only; Tally test proves it unchanged.

**Still open:** (a) prove the follow-on fill in the 31 Oct 02:30 run (`connector_logs` `sync_item_lines`, several entries minutes apart); (b) ship one PR on Varad's OK; after deploy, Sync now on MARGYN DEMO and check the vendor credit and all 1,054 documents read; (c) WhatsApp "onboard" text flow not built; (d) live WhatsApp checks on a Zoho-only account need sends, not run.
