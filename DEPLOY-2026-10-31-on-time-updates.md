# Deploy: WhatsApp updates on time (10:30 means 10:30) + Zoho TDS

**Why:** Vercel's free plan runs each scheduled job at any minute inside its hour, so the 10:30 update and the payment reminders went out at about 11:09, 7:30 at about 8:12, 7:00 pm at about 7:19. The app code to fix this has been live since 4 Oct; the Supabase part was never run. This is that part. The same script also adds one column so Margyn can read TDS balances from Zoho (PR #143). It affects every account (Mihir's updates also become on time; their content doesn't change).

1. **Copy the secret.** Open vercel.com → **reflectional** → **Settings** → **Environment Variables** → find **CRON_SECRET** → click the eye icon → copy the value.
   ✅ You have a long string copied.
2. **Open the script.** In the Full repo folder open `sql/2026-10-31-on-time-crons.sql` and copy all of it.
3. **Paste in Supabase.** Open supabase.com → your project → **SQL Editor** → **New query** → paste.
4. **Put the secret in.** Find `PASTE-CRON-SECRET-HERE` (it appears twice, a few lines apart). Replace both with the value from step 1. Keep the single quotes around it.
5. **Run.** Click **Run**.
   ✅ The last result shows **6 rows**: margyn-ontime-morning, -chase, -noon, -afternoon, -late, -evening, all `active = true`.
6. **Zoho TDS (after PR #143 is merged):** open the app as MARGYN DEMO → **Organisations and sources** → Zoho Books → **Sync now**. Then ask Margyn "How much TDS do we have?"
   ✅ It says ₹1,796 deducted by customers (TDS Receivable) and ₹1,000 deducted by you (TDS Payable).
7. **Check tomorrow.** The 7:30 morning update lands at 7:30 (within a minute), the 10:30 one at 10:30.
   ✅ If anything goes wrong, Vercel's own clock still sends the update later in the hour, and never twice.

To undo: run `select cron.unschedule(jobname) from cron.job where jobname like 'margyn-ontime-%';`
