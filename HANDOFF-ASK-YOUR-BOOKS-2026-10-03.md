# Handoff: Ask your books, one conversation hub, Margyn Watch (2026-10-03)

Read this before touching `api/_lib/booksEngine.js`, `booksTools.js`, `margynWatch.js`, `tallyData.js`, `app/js/26-hub.js` or the Margyn prompts.

## Why
Every conversation in Care Hygiene's account (38 app/voice messages, 28 WhatsApp) was read on 2 Oct. The Tally data was complete (6,375 vouchers Apr–1 Oct, every month matching Tally's own count, item lines present). The AI was the problem:

| What Mihir asked | What Margyn said | Cause |
|---|---|---|
| Total sales this year | ₹1.18 Cr, "−3.4% margin" | Only a 10-line summary in the prompt; it read the last-30-days figure as the year. Real: ₹14.52 Cr |
| Top margin products (voice) | "margin view isn't available" | `get_margin` returned "loading" on first call; item margins existed |
| Who to chase | "Alkem ₹1.3 L" | Model misread ₹1,32,04,000 (₹1.32 Cr) |
| "70→60 days frees ₹5–10 L" | wrong maths | Model did its own arithmetic (real ≈ ₹80 L) |
| Cash dip below floor | "−₹1.11 Cr in week 2" | Forecast counts bank only; the business runs on an overdraft |
| "Start reminders" | asked for phone numbers | Promised what it couldn't do |
| WhatsApp: revenue / Pulse (×4) | "Zoho isn't connected" | WhatsApp tools only knew snapshots/Zoho; Tally ignored |
| WhatsApp: website | "app store" | Not told the URL |
| WhatsApp: top 3 actions | Alembic listed as a payable | Old bill-sign bug (fixed earlier by calibrateBills) |

## What was built
1. **Books engine** `api/_lib/booksEngine.js` (pure). Reads every synced voucher, ledger, bill and stock line. Counts exactly like the Margin page (reuses tallyAnalytics classification, implied sales lines, non-accounting exclusions, bill calibration). Money leaves as `₹1.32 Cr / ₹41.2 L / ₹45,300`. Functions: summary (any period), breakdown (by month/day/customer/vendor/ledger/item/branch, measures incl. any ledger and item margin), findEntries, partyProfile, products (incl. kit cost from Manufacturing Journals), moneyOwed (ageing, >1 year, what 10 days faster frees), cashAndDebt (bank, OD/loans from opening + entries, interest, GST estimate + due date), insights (what needs attention).
2. **Books tools** `api/_lib/booksTools.js`: 8 Claude tools over the engine. Same definitions for the Margyn panel/Ask page (server-side), voice (`/api/ask-margyn?action=books`, client `VX_BOOK_TOOLS`) and WhatsApp.
3. **One loader** `api/_lib/tallyData.js` (moved out of tally.js): warm-instance cache per account keyed on last sync. `forgetTallyBook` on classify.
4. **Analytics fixes** `tallyAnalytics.js`: kits get cost from Manufacturing Journals (`assemblyCosts`, flag `cost_from_assembly`); headlines never compare against a month whose running costs aren't booked, and say that month is unfinished. `?action=analytics` now also returns `insights, kits, branches, concentration, receivables_ageing, funding`.
5. **Prompts** (ask-margyn chat + voice, WhatsApp): "YOUR BOOKS" section: use the tools for any number, never "only 30 days", copy money exactly, Tally is the books (no "Signal" on every line), no promised reminders, make tables without asking. Context block: FY sales stated outright, 30-day figures labelled as such, overdraft note, top findings. `inr()` in formatMargynContext now writes lakh/crore.
6. **Margyn Watch** `api/_lib/margynWatch.js`: runs on the existing crons (07:30 morning, 10:30 midday = urgent/news only, 19:00 evening). Max 3 points, cooldowns per kind, re-sends only when the size moves >25%. Modes in `profiles.preferences.margyn_watch.mode`: `off` (default), `preview` (to `MARGYN_WATCH_PREVIEW_PHONE`, labelled, never into the owner's thread), `on` (owner's WhatsApp). Free text inside 24 h of the person's last message; otherwise `WHATSAPP_TEMPLATE_ALERT`; otherwise not sent (the app says why). STOP ALERTS / START ALERTS on WhatsApp. State in `margyn_signals`.
7. **Conversations hub** `app/js/26-hub.js` + `app/js/margyn-topics.js`: Ask-anything chips, Margyn noticed (with WhatsApp switch, mute, send now), What you've asked (topics across app/calls/WhatsApp, "couldn't answer" + Ask again), WhatsApp chats in the thread list. Server logs `question_asked {channel, topic, answered}` (no words) for the ops counters.
8. **Margin page**: What else your books say, Kits you put together, Sales by branch (from renamed sales voucher types), biggest customer / top-5 tiles. Home nudge for the top high-priority finding; forecast nudge says when an overdraft covers the dip.

## Setup the VP does (also in the chat reply, click by click)
- SQL: `2026-10-03-margyn-watch.sql` (margyn_signals, product_events allowlist, tally structure columns). Code works before it; Watch just can't keep history and the counters drop the new events.
- Vercel env (optional): `MARGYN_WATCH_PREVIEW_PHONE` = VP's WhatsApp number with country code, digits only (e.g. 9198xxxxxxxx). `WHATSAPP_TEMPLATE_ALERT` = Gupshup template id once approved.
- Gupshup template `margyn_update`, category UTILITY, English. Body:
  `Hi {{1}}, here is what Margyn noticed in your books today: {{2}} Reply to this message to ask about any of it.`
  Samples: {{1}} `Mihir`, {{2}} `(1) ₹3.82 Cr of the ₹5.55 Cr customers owe you is overdue. (2) September's running costs aren't fully in Tally yet.`
  Template parameters can't contain new lines; Watch joins points as "(1) … (2) …".

## Verify after deploy
- `/api/tally?action=analytics` on Care Hygiene: `insights` present; `kits` lists POST OP KIT etc. with `cost_per_unit`; headlines contain "Sep 2026 looks unfinished" and no Sep margin comparison.
- Ask in the panel: "How much did I sell this year?" → ₹14.5 Cr. "Which products make me the most margin?" → products tool. "Tell me about Alkem" → owes ₹1.32 Cr.
- WhatsApp from the owner's number: "What is my total revenue?" → Tally figure, not Zoho.

## Not done / next
- Agent-side reads (needs a new agent release): party phone/email/GSTIN/credit period from ledger masters, bill allocations on receipts (true days-to-pay per invoice), stock masters and closing stock, pending orders, previous FY.
- Customer reminders from Tally contacts: see the thought piece in the chat reply (not built on purpose).
- Two UI tests fail on main and here (CFO pack expects "August 2026"; seed data is date-bound). Pre-existing.
