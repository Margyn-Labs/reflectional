# Zoho safety drills (run on a NEW test account, never on Mihir's or MARGYN DEMO)

Four drills. Each takes 5–10 minutes. Do them in order. Tick each ✅ as you go.
If a ✅ doesn't happen, stop and send me a screenshot of that screen.

**Before you start**
1. Make a new Margyn account (a new email) at **www.margynlabs.com/app.html**.
2. Click **Organisations and sources** → **Zoho Books** → **Connect** → sign in to Zoho → **Accept** → pick your test organisation → **Confirm organization**.
   - ✅ The Zoho Books row says **Connected to …** and Home shows figures.

---

## Drill 1: Zoho stops Margyn's access, then you reconnect

3. In a new tab open **accounts.zoho.in** → sign in → **Security** (left) → **Connected Apps**.
4. Find **Margyn** → click **Remove** (or the bin icon) → confirm.
   - ✅ Margyn is gone from the list.
5. Back in Margyn: **Organisations and sources** → **Zoho Books** → **Sync now**.
   - ✅ The row turns red and says **Reconnect**, with the line *"Zoho Books stopped letting Margyn read your books… Press Reconnect and approve again: nothing Margyn already read is lost."*
   - ✅ At the top of the app, the Zoho source shows **Reconnect needed**.
6. Click **Reconnect** → sign in to Zoho → **Accept** → pick the **same** organisation → **Confirm organization**.
   - ✅ A message says **"Reconnected. Margyn kept everything it had read and caught up from where it stopped."**
   - ✅ It does **not** say "That organization is already connected".
7. Click **Home**.
   - ✅ The same figures as before step 3 (nothing lost, nothing doubled).

## Drill 2: Zoho tells Margyn to slow down

Zoho's free plan allows 1,000 calls a day. When Zoho says "too many calls", Margyn stops at once and carries on in the next run. You can't make Zoho say this on demand without using up the day, so this drill is a check after a busy day.

8. Open **supabase.com** → **Margyn** project → **Table Editor** → table **connector_logs**.
9. Click **Filter** → `error_message` **contains** `rate_limited` → **Apply**.
   - ✅ Either no rows (Zoho never had to slow Margyn down), or rows that say *"rate_limited: Zoho asked Margyn to slow down; the rest is read on the next run."*
10. If there were rows: look at the next row for the same account with operation **sync_all** or **refresh_money**.
    - ✅ It says **success**: the next run picked up where it stopped.

(The automated tests also force this every time: `api/_lib/__tests__/zohoSafety.test.js`, section "drill: rate limit mid-sync".)

## Drill 3: Disconnect and KEEP the data

11. **Organisations and sources** → **Zoho Books** → **Disconnect** → **Disconnect**.
12. The next box asks *"Keep the Zoho Books data Margyn copied?"* → click **Keep it**.
    - ✅ A message says **"Zoho Books disconnected. Your historical data stays visible in Margyn."**
    - ✅ The Zoho row now says **Not connected**.
13. In the Zoho tab: **accounts.zoho.in** → **Security** → **Connected Apps**.
    - ✅ Margyn is not listed (its access was given back).
14. In Margyn click **Home**.
    - ✅ Your past readings (Pulse and its history) are still there. Nothing new arrives until you reconnect.

## Drill 4: Reconnect, then disconnect and REMOVE the data

15. **Organisations and sources** → **Zoho Books** → **Connect** → sign in → **Accept** → same organisation → **Confirm organization**.
    - ✅ Connected again; Home shows figures. Only one copy: receivables total = Zoho's own total (not double).
16. **Zoho Books** → **Disconnect** → **Disconnect** → in the next box click **Remove it**.
    - ✅ A message says **"Zoho Books disconnected and the data Margyn copied from it is removed. Customer and supplier contacts in your party list stay."**
17. In Supabase → **Table Editor** → **connector_logs**, newest first.
    - ✅ A **disconnect** row for this account says **removed … synced rows** (a count only, no amounts).
18. Open **books.zoho.in** → your test organisation → **Sales** → **Invoices**.
    - ✅ All your invoices are still there in Zoho (Margyn never changes your books).

---

## What each drill proves
| Drill | What should happen |
|---|---|
| 1 | Access removed in Zoho → Margyn says "Reconnect" in plain words → Reconnect works and keeps the data |
| 2 | Zoho says "slow down" → Margyn stops, logs it, carries on next run |
| 3 | Disconnect + keep → Zoho access given back, password-like secret deleted from Margyn's vault, data stays |
| 4 | Disconnect + remove → same, and Margyn's copy is deleted; Zoho itself untouched |
