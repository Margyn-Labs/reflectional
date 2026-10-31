# How to test: clearer Zoho answers (after the merge)

Use MARGYN DEMO at **www.margynlabs.com/app.html**. Takes about 10 minutes.

## In the app
1. Open the app → click the **Margyn** button (bottom right) to open the chat.
2. Type **What should I do today?** → Enter.
   - ✅ It says **invoice** (like "invoice INV-00124"), not "bill", for customers.
   - ✅ For a customer it says both numbers, e.g. **"Gupta Exports owes ₹15.4 L; ₹13 L of it is more than a month late."**
3. Type **Who owes us the most money?**
   - ✅ Total **₹3.98 Cr**; Mehta Traders **₹15.5 L** first.
4. Type **What will our cash look like in 4 weeks?**
   - ✅ About **₹27.1 L** in week 4 (same as the **Cash** page forecast).
5. Type **How much cash do we have?**
   - ✅ **₹25.6 L**.

## On WhatsApp (the number saved on MARGYN DEMO)
6. Send the Margyn WhatsApp number: **What will our cash be in 4 weeks?**
   - ✅ It gives a week-4 figure with a range (around **₹27 L**), not "I don't have a forecast".
7. Send: **Who should I chase first?**
   - ✅ It says **invoice**, and gives each customer's full balance before the late part.

## Tomorrow morning (after 2:30 am)
8. Open **supabase.com** → **Margyn** → **Table Editor** → **connector_logs** → newest first.
   - ✅ Two rows with operation **cleanup_superseded** for MARGYN DEMO (the two old copies removed).
   - ✅ A **sync_payment_links** row from the night run.
9. Back in Margyn chat, type **Is INV-00762 paid?**
   - ✅ Still "Yes… payment 168… ₹1,796 TDS withheld" (nothing lost).

If a ✅ doesn't happen, send me a screenshot of that screen.
