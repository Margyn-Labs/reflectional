# Deploy: Zoho Books works like Tally all day (1 Nov 2026)

What this ships: fresh Zoho figures before every WhatsApp update, which invoice each payment cleared (with TDS), Home cash right after Sync now, a fast Margin page on Zoho, "invoices" (not "bills") for what customers owe, Margyn tidying up old copies by itself, and the safety paths (Zoho access removed, Zoho slowing Margyn down, disconnect keep/remove).

Mihir (Tally) is not affected: every change is switched off on accounts that have Tally.

Takes about 10 minutes. One SQL script, then the merge, then a check.

---

## Part A: run the SQL (once)

1. Open **supabase.com** → sign in → open the **Margyn** project.
2. In the left bar, click **SQL Editor** → **New query**.
3. Open the file `sql/2026-11-01-zoho-parity.sql` (in the repo), select all, copy.
4. Paste it into the Supabase query box. Click **Run** (bottom right).
   - ✅ It says **Success. No rows returned**.
   - If it says an error, stop and send me a screenshot. Nothing is changed if it fails.

The script only **adds** columns. It deletes nothing.

## Part B: merge (I do this when you say "merge")

5. Say **merge** in the chat. I merge the PR; Vercel puts it live in about 2 minutes.
   - ✅ I'll reply with the commit and "LIVE".

## Part C: check on MARGYN DEMO (2 minutes)

6. Open **www.margynlabs.com/app.html** and sign in as **MARGYN DEMO**.
7. In the left bar, click **Organisations and sources**. On the **Zoho Books** row, click **Sync now**. Wait until the button says **Sync now** again.
   - ✅ No red "Sync failed".
8. Click **Home**.
   - ✅ The cash figure equals Zoho's bank balance today (HDFC minus petty cash), not last night's.
9. Open the Margyn panel (right side) and type: **What did Bluecrate's last payment clear?**
   - ✅ The answer names **INV-00762** and **₹1,796 TDS withheld**.
   - If it says it doesn't know yet: the payment details are read in the next update (12:30, 3 pm or 5 pm). Ask again after that.
10. Type: **Who owes us the most?**
    - ✅ The answer talks about **invoices**, not "bills".
11. Click **Margin** in the left bar, then click it again a minute later.
    - ✅ The second time it opens almost at once.
12. After the next scheduled update (12:30, 3 pm or 5 pm), click **Conversations**.
    - ✅ The update is there and its figures match Zoho at that time.

## What Margyn now cleans up by itself

- Old copies of the same Zoho organisation left by earlier reconnects (MARGYN DEMO had two: rows `5385c7b8…` and `4c4748f4…`). Removed after Part B, in tonight's 2:30 am run, or the next time you reconnect. The active one (`e5a18507…`) is never touched.
- Proposals that were waiting on one of those old copies: marked expired.
- Watch findings that were closed more than 400 days ago (only kinds that can be sent again anyway).
- Never on an account with Tally. Never snapshots. Each clean-up is written to `connector_logs` with counts only.

## If something looks wrong

- Nothing to undo in the database: the SQL only added empty columns.
- To roll back the code, say **revert** and I'll revert the PR (2 minutes).
