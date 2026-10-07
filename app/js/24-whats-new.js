/* ============================================================
   WHAT'S NEW — a card that floats over the app after each release and
   says what shipped and exactly how to use it.

   EVERY RELEASE THAT CHANGES SOMETHING A USER CAN SEE ADDS AN ENTRY AT THE
   TOP OF MG_RELEASES (newest first). The id must be new; that is what makes
   the card appear once for everyone. Write for the business owner, not for
   us: what it does for them, then how to use it (the exact words to say,
   the key to press, the page to open).

   Seen-state is saved on the account (profiles.preferences.whats_new_seen)
   so it doesn't come back on another device, with a localStorage copy for
   accounts without the preferences column. A first-time account sees only
   the newest release; after that, everything released since their last
   visit (up to three). Reopen any time from the search palette: "What's new".
   ============================================================ */
const MG_RELEASES = [
  {
    id:'2026-10-08-wa-paused', date:'8 Oct 2026', title:'When WhatsApp holds back an update',
    items:[
      { t:'Your update still reaches you', what:'WhatsApp sometimes pauses business messages to a number that has had many lately. When it pauses one of Margyn’s updates, Margyn now keeps it ready and sends it the moment you message Margyn on WhatsApp.',
        how:'Got a note that an update didn’t arrive? Send Margyn any message on WhatsApp (even “hi”) and the update comes straight through. Every update is also under <b>Conversations</b> → <b>Today’s updates</b>.' }
    ]
  },
  {
    id:'2026-10-07-books-health', date:'7 Oct 2026', title:'A books health check, every morning',
    items:[
      { t:'What your accountant should fix', what:'Every morning Margyn checks your books for the things that make them wrong: interest you paid filed as income, a month whose costs aren’t entered yet, an expense filed under Sales, cash in hand below zero, bills still open that were already paid, balances with no bill behind them, suppliers not kept bill by bill, money owed for over a year, and entries dated after today. Each one says what to fix and since when. Once it’s fixed in your books, it closes by itself.',
        how:'Open <b>Organisations and sources</b> → <b>Books health check</b>. Not one for you? Press <b>Ignore</b>; it comes back only if the amount changes by more than a quarter. Or ask Margyn: “what’s wrong in my books?”', act:'bookshealth' },
      { t:'Send it to your accountant', what:'One clean list of everything to fix, grouped and with amounts. Margyn never sends it by itself.',
        how:'<b>Books health check</b> → <b>Send to my accountant</b> → <b>Open in WhatsApp</b> (you press send) or <b>Copy</b>.', act:'bookshealth' }
    ]
  },
  {
    id:'2026-10-06-cash-flow', date:'6 Oct 2026', title:'Your cash flow statement, and how your overdraft and loans move',
    items:[
      { t:'Cash flow statement', what:'Where your cash came from and where it went, month by month this year, from every entry in your books. The owner view says what the money was for (customers, suppliers, salaries, assets, loans); the accountant view is the statement your CA or bank asks for, starting from profit. It checks itself against your books every time.',
        how:'Open <b>Cash flow</b> under Insight. Switch views at the top; <b>Export</b> gives your accountant a spreadsheet. Or ask Margyn: “why is cash down when I made a profit?”', act:'cashflow' },
      { t:'Overdraft and loans, day by day', what:'For each overdraft, cash credit and loan: what you owed at the end of every day this year, the peak, the average, how many days you used it, the interest the bank charged and what borrowing really costs you a year. Loans show whether they’re reducing, and EMIs already entered for later dates.',
        how:'<b>Cash</b> → <b>Overdraft and loans this year</b>. Press <b>Enter your limit</b> once to see how much of the limit you use and what’s left. Or ask Margyn: “how is my OD moving?”', act:'borrowing' }
    ]
  },
  {
    id:'2026-10-06-team-live', date:'6 Oct 2026', title:'Watch Margyn work, and work with your team',
    items:[
      { t:'See Margyn working', what:'Home’s “What I’m working on” now shows what is running this second, like syncing Zoho Books or checking payments, and under it what was just done, with the time. Margyn’s panel says what is running on every page.',
        how:'Open <b>Home</b> and look at “What I’m working on”.', act:'home' },
      { t:'See your team', what:'Faces next to the bell show who else is in Margyn and which page they are on. Open a customer or supplier and you see who else has it open, and when they are typing.',
        how:'Hover the faces next to the bell. Click them to manage your team.', act:'team' },
      { t:'A timeline and comments on every customer and supplier', what:'Timeline: everything about them from your apps, Margyn and your team, newest first. Comments: notes for your team. Write @Margyn to ask Margyn about them.',
        how:'<b>Customers</b> or <b>Vendors</b> → click a name → <b>Timeline</b> or <b>Comments</b>.', act:'customers' },
      { t:'An owner for everything in your Inbox', what:'Hand any item to a teammate. They get a card saying you handed it over, and so do you when Margyn or a teammate hands you something.',
        how:'<b>Inbox</b> → <b>Owner</b> under any item.', act:'inbox' },
      { t:'Approvals go to your apps', what:'Each approval is queued for the app it belongs in: a payment for Zoho Books, a journal for Tally. Until writing to an app is switched on, Margyn saves it and tells you to make the same change in that app.',
        how:'<b>Inbox</b> → <b>Sent to your apps</b>. What each app reads and writes: <b>Organisations and sources</b>.', act:'inbox' }
    ]
  },
  {
    id:'2026-10-05-updates-log', date:'5 Oct 2026', title:'See every WhatsApp update Margyn sent today',
    items:[
      { t:'Today’s updates', what:'A list of every update of the day: what went out and when, whether WhatsApp delivered it and it was read, and why Margyn stayed quiet or couldn’t send at a given time. Tap one to read exactly what was sent. Earlier days are one tap away.',
        how:'Conversations → WhatsApp updates → Today’s updates.', act:'history' }
    ]
  },
  {
    id:'2026-10-05-money-pulses', date:'5 Oct 2026', title:'Short money updates through the day',
    items:[
      { t:'Money pulses at 10:30, 12:30, 3 and 5', what:'Between the morning and evening updates, Margyn texts what moved since its last message: money in and out, what got better (a customer paid, late money down, a better-than-usual day) and what needs a look (more credit to a customer who is months late, a bill gone past due, an unusual payment out, a possible double entry, Tally not syncing). If nothing moved, it stays quiet, and it never sends more than four in a day.',
        how:'WhatsApp. Reply in your own words to ask about any line.', act:'history' },
      { t:'Today against a usual day', what:'The evening wrap now compares today’s collections, sales and payments with an average working day from the last four weeks, and says how late money moved.', how:'WhatsApp, around 7 pm.', act:'history' },
      { t:'Monday: last week in one look', what:'On Mondays the morning update adds last week against the week before, and the biggest money in and out.', how:'WhatsApp, Monday around 7:30 am.', act:'history' }
    ]
  },
  {
    id:'2026-10-05-daily-cadence', date:'5 Oct 2026', title:'Margyn’s WhatsApp updates now follow your day',
    items:[
      { t:'A fuller morning update', what:'Every morning: your bank and cash, what customers owe and how much is late, yesterday’s money in and out, what’s due this week, and where cash is likely to be in 7 days. Then up to three things that need you, mixed across collections, costs, sales and GST. Each one says why Margyn is raising it today and what it’s based on.',
        how:'WhatsApp, around 7:30 am. Preview it from Conversations → Preview today’s update.', act:'history' },
      { t:'Something you might have missed', what:'Each morning ends with one thing that’s hard to spot yourself, like a customer paying slower than they usually do, or a big customer quietly buying less.', how:'The “Worth knowing” line in the morning update.', act:'history' },
      { t:'Only changes during the day', what:'Around 10:30 am and 3 pm Margyn texts only if something changed, like a customer paying or a big payment going out. If nothing changed, it stays quiet.', how:'WhatsApp.', act:'history' },
      { t:'An evening follow-up', what:'In the evening Margyn checks each of the morning’s points again (paid, part paid, or nothing yet), sums up the day’s money, and tells you what’s due tomorrow.', how:'WhatsApp, around 7 pm. Reply with what a customer said and Margyn keeps it in mind.', act:'history' }
    ]
  },
  {
    id:'2026-10-04-receivables-tied', date:'4 Oct 2026', title:'What customers owe now matches Tally’s ledgers',
    items:[
      { t:'No more chasing paid bills', what:'Some customers’ bills were paid but never knocked off in Tally, so they looked overdue. Margyn now follows each customer’s ledger balance: bills already covered by payments are left out.',
        how:'Receivables (the note at the top says how much and for how many customers).', act:'receivables' },
      { t:'Nobody who owes you is missed', what:'Money a customer owes that Tally never split into bills now shows up too, dated from their invoices.', how:'Receivables and Customers.', act:'receivables' }
    ]
  },
  {
    id:'2026-10-04-data-check', date:'4 Oct 2026', title:'See that all your data is in',
    items:[
      { t:'Is all your data in?', what:'Margyn now checks, month by month, that every voucher Tally holds reached Margyn, that every ledger and open bill is stored, and that each one is counted somewhere in your figures. Anything that needs a look is listed in plain words.',
        how:'Organisations and sources → Is all your data in?', act:'connectors' },
      { t:'Salaries from Tally payroll', what:'Payroll vouchers in Tally are now counted in your running costs.', how:'Margin and Reports.', act:'margin' },
      { t:'Long lists stay whole', what:'Lists longer than 1,000 rows (conversations, ledger entries, invoices) were cut off at 1,000. They now load in full.', how:'Nothing to do.', act:'home' }
    ]
  },
  {
    id:'2026-10-04-payables-from-supplier-balances', date:'4 Oct 2026', title:'Everything you owe suppliers, not just a few bills',
    items:[
      { t:'Payables from your supplier balances', what:'If Tally doesn’t keep your suppliers’ bills one by one, Payables used to show only the few bills Tally did keep. Margyn now works out what you owe each supplier from your purchases and payments, oldest bills paid first, so every supplier shows up.',
        how:'Payables, or ask Margyn “what do I owe suppliers?”', act:'payables' },
      { t:'A cash floor that fits your business', what:'The forecast now warns you when cash is set to fall below where it usually bottoms out, instead of two weeks of spend. Set your own in Adjust.',
        how:'Cash → 13-week cash forecast → Adjust.', act:'cash' },
      { t:'Clearer report charts', what:'Margin now shows as dots on its own % scale beside the rupee bars, and the current month is marked “so far”.',
        how:'Reports.', act:'reports' }
    ]
  },
  {
    id:'2026-10-04-forecast-learned', date:'4 Oct 2026', title:'A cash forecast that learns from your books',
    items:[
      { t:'Learned, not assumed', what:'The 13-week forecast now learns from every entry in your books: how each customer actually pays (even the slow ones), how you pay suppliers, what you pay every month, and EMIs already entered for later dates.',
        how:'Cash → 13-week cash forecast.', act:'cash' },
      { t:'It checks itself', what:'Margyn re-makes the forecast as of each of your past weeks, using only what was known then, and compares it with what actually happened. The shaded range is as wide as it has really been off.',
        how:'Cash → How Margyn built this → Its track record.', act:'cash' },
      { t:'Week by week this year', what:'Cash, what customers owe, what you owe suppliers and days to collect, at the end of every week this year.',
        how:'Cash → Week by week this year.', act:'cash' },
      { t:'Your own assumptions are still there', what:'Prefer to set the figures yourself? Switch the forecast to “My own assumptions”.',
        how:'Home or Cash → forecast → Adjust.', act:'cash' }
    ]
  },
  {
    id:'2026-10-04-figures-from-the-books', date:'4 Oct 2026', title:'Every figure now agrees with your books',
    items:[
      { t:'Cash history from your books', what:'Cash, its change and the cash chart now come from your books day by day, so an old reading can’t make cash look like it jumped or fell. Runway and the Pulse Score follow.',
        how:'Home and Cash: the cash chart shows the last 90 days.', act:'cash' },
      { t:'A forecast that spreads what’s overdue', what:'Money customers already owe comes in over the next four weeks instead of all at once in week 3, and very old supplier bills that are likely disputed are left out (the forecast says how much).',
        how:'Cash → 13-week forecast. Change the assumptions there.', act:'cash' },
      { t:'Reports month by month from the books', what:'Revenue, spend and profit are each month’s own figures; cash is the balance at the end of each period. A month still in progress is marked and has no margin %.',
        how:'Reports.', act:'analytics' },
      { t:'CFO pack opens on the last full month', what:'The pack now covers every month in your books, and opens on last month instead of a month only a few days old.',
        how:'CFO pack → Month.', act:'cfopack' },
      { t:'Honest WhatsApp status', what:'Automations and Home now show whether each WhatsApp message is really going out. Margyn updates are listed with what WhatsApp delivered.',
        how:'Automations, or Admin → Channel health.', act:'agents' },
      { t:'Zoho Books and Odoo books, read the same way', what:'Margin, Reports, the CFO pack, Margyn’s answers and Margyn updates now read your books whether you keep them in Tally, Zoho Books or Odoo. With two connected, Margyn uses one everywhere and shows the other beside it, never added together.',
        how:'Margin. Ask Margyn anything about your books.', act:'margin' }
    ]
  },
  {
    id:'2026-10-04-books-as-of-today', date:'4 Oct 2026', title:'Cash as of today, not as of March',
    items:[
      { t:'Entries made ahead don’t count yet', what:'If your accountant enters EMIs or post-dated payments in Tally ahead of time, Tally takes them out of your bank balance straight away. Margyn now shows your cash, loans and costs as of today, and lists what’s already entered for later dates.',
        how:'Cash page, or ask Margyn “What payments are already entered for later?”', act:'cash' }
    ]
  },
  {
    id:'2026-10-04-delivery-receipts', date:'4 Oct 2026', title:'Know that each WhatsApp actually arrived',
    items:[
      { t:'Delivered, read, or why not', what:'Every update Margyn sends now shows what WhatsApp itself reported: delivered, read, or didn’t arrive and the reason. An update that doesn’t arrive is tried again next time instead of being counted as sent. Payment reminders to customers are tracked the same way.',
        how:'Conversations → Margyn noticed: the “Last update” line and the label under each point.', act:'history' }
    ]
  },
  {
    id:'2026-10-04-updates-and-times', date:'4 Oct 2026', title:'Sharper WhatsApp updates, and the right times everywhere',
    items:[
      { t:'Times in the app are correct', what:'Dates and times were showing 5½ hours late (an evening sync could read as after midnight). Every time is now India time. New entries and invoices made before 5:30 am also get today’s date, not yesterday’s.',
        how:'Nothing to do. Check “last synced” on any page.', act:'home' },
      { t:'WhatsApp updates you can act on', what:'Each update says when your Tally books are from, the money that came in, your bank and overdraft, then at most three things, one per customer, each with the amount, the bill and how late it is. “More than a month late” is kept apart from bills that only just fell due. A customer who paid this week isn’t sent as “chase them”. Points don’t repeat unless they get worse, and then the update says by how much.',
        how:'Conversations → Margyn noticed → Preview today’s update shows the next one exactly as it would go out, without sending it.', act:'history' },
      { t:'You always know who gets them', what:'The switch now reads Off, Test on Margyn’s phone, or Send to [owner]’s WhatsApp with the last four digits, and asks before it starts texting the owner.',
        how:'Conversations → Margyn noticed → WhatsApp updates.', act:'history' }
    ]
  },
  {
    id:'2026-10-03-explains-like-an-accountant', date:'3 Oct 2026', title:'Margyn explains every number',
    items:[
      { t:'Ask how any figure is worked out', what:'Margyn now shows the formula, the actual amounts that went into it, which system each one came from and whether your sources agree. Runway, cash, Pulse Score, margin, receivables, the cash forecast, GST, DSO and more.',
        how:'Ask “How is my runway calculated?” or “Why is my Pulse Score 59?” in the Margyn panel, on a call or on WhatsApp.', act:'home' },
      { t:'Margyn sees and works the whole screen', what:'On any page it can read what’s there, scroll, and press buttons like Save as PDF or a tab. Anything that changes your data still waits for your OK.',
        how:'Say “What does this say?” or “Click Save as PDF”.', act:'home' }
    ]
  },
  {
    id:'2026-10-03-follow-through', date:'3 Oct 2026', title:'Margyn comes back to you on its own',
    items:[
      { t:'Long answers report back', what:'When a question takes time, Margyn says it’s still on it after a few seconds and tells you the answer the moment it’s ready, on a call or in the panel, without you asking again. If you’ve looked away, a note by the Margyn button says it’s done.',
        how:'Ask something big, like “Why did margin drop this quarter?”, and carry on.', act:'home' },
      { t:'Heard the first time', what:'On a call, Margyn now decides you’ve finished speaking sooner and always answers, so you don’t have to repeat yourself. Typed messages sent while it’s busy are kept and answered next, not dropped.',
        how:'Press Talk, or type two questions back to back.', act:'home'},
      { t:'Talks like a person', what:'On a call, pause to think and Margyn waits. Cut in and it stops, answers you, then offers to finish what it was saying. It keeps track of everything you asked on the call and comes back to anything still open.',
        how:'Press Talk and just talk: interrupt it, change topic, come back.', act:'home' }
    ]
  },
  {
    id:'2026-10-03-navigator', date:'3 Oct 2026', title:'Type where you want to go, in any words',
    items:[
      { t:'Search understands what you mean', what:'Press ⌘K (Ctrl+K on Windows) and type the way you talk: “who owes me money”, “GST kholo”, “bills I have to pay”. Margyn puts the right page at the top as Best match, even with typos or in Hinglish.',
        how:'Press ⌘K, type, then Enter.', act:'home' }
    ]
  },
  {
    id:'2026-10-03-ask-your-books', date:'3 Oct 2026', title:'Ask your books anything',
    items:[
      { t:'Margyn reads every Tally entry', what:'Sales for any month or the whole year, profit, costs by ledger, a customer’s or vendor’s full story, product margins, who owes what and how late, cash, overdraft, interest and GST. In plain words, typed, spoken or on WhatsApp.',
        how:'Ask “How much did I sell this year?”, “Tell me about Alkem” or “Which products make me the most margin?” in the Margyn panel or on WhatsApp.', act:'home' },
      { t:'One place for every conversation', what:'Conversations now holds your app chats, calls and WhatsApp chats together, the questions you’ve asked sorted by topic, and the ones Margyn couldn’t answer before, with one tap to ask again.',
        how:'Open Conversations in the menu.', act:'history' },
      { t:'Margyn tells you what it noticed', what:'Margyn reads your books on its own and lists what needs a look: overdue money, customers who stopped ordering, bills over a year old, an unfinished month, GST due. Switch on WhatsApp updates and it texts you at most three points, mornings and evenings.',
        how:'Conversations > Margyn noticed. Reply STOP ALERTS on WhatsApp any time.', act:'history' },
      { t:'Kits, branches and more on Margin', what:'Kits you put together now have a cost (from their parts), so their margin shows. Margin also shows sales by branch, how much your biggest customers make up, and what else the books say.',
        how:'Open Margin under Insight.', act:'margin' }
    ]
  },
  {
    id:'2026-10-02-margyn-brain', date:'2 Oct 2026', title:'A sharper Margyn',
    items:[
      { t:'Margyn runs on Claude’s newest models', what:'Chat, WhatsApp, the daily briefing, findings and file import now use Claude Sonnet 5.5, and Deep answers use Claude Opus 5.5. Answers are sharper and less likely to be cut off.',
        how:'Ask Margyn anything, as before.', act:'home' },
      { t:'Margyn knows Margin and Channel health', what:'Ask “are my reminders actually going out?”, “how much did you recover after chasing?” or “what’s my gross margin?” and Margyn reads those pages for you, or opens them.',
        how:'Ask in the Margyn panel, typed or by voice.', act:'channels' }
    ]
  },
  {
    id:'2026-10-02-figures-check', date:'2 Oct 2026', title:'Every screen checked against your books',
    items:[
      { t:'Receivables ageing by invoice', what:'Receivables and Payables now age each invoice on its own. Before, a customer’s whole balance went into the bucket of their oldest invoice, so one old bill could make a big balance look 90+ days late. Home’s “past 60 days” uses the same rule.',
        how:'Open Receivables and look at the four age buckets.', act:'receivables' },
      { t:'CFO pack shows each month’s real P&L', what:'With Tally connected, revenue, spend and profit in the CFO pack are that month’s own figures from your books, compared with the month before.',
        how:'Open the CFO pack and pick a month.', act:'cfopack' },
      { t:'GST due, estimated from your books', what:'GST payable now shows last month’s output tax less input credit from your Tally duty ledgers, marked as an estimate. Where nothing measures a GST figure it says n/a instead of ₹0.',
        how:'See it on Home and on GST and tax.', act:'gst' },
      { t:'Months with costs not yet booked are flagged', what:'If a month’s running costs are far below a usual month (salaries or rent not entered yet), Margin marks it and its profit is left out of your averages.',
        how:'Open Margin, Month by month.', act:'margin' }
    ]
  },
  {
    id:'2026-10-02-tally-pulse-figures', date:'2 Oct 2026', title:'Pulse Score now runs on your real Tally figures',
    items:[
      { t:'Burn, profit and runway from Tally’s monthly P&L', what:'Revenue, monthly spend and profit on Home and in the Pulse Score now come from Tally’s own month-by-month P&L (average of the last six closed months), and update after every sync. Before, they could stay stuck at an early figure.',
        how:'Nothing to do. Open Home after the next Tally sync.', act:'home' },
      { t:'Sweep deposits count as cash', what:'Money your bank sweeps into a linked deposit (a “sweep” ledger under Deposits in Tally) is now counted in Cash, because the bank moves it back to your current account on its own.',
        how:'See each account on the Cash page.', act:'cash' }
    ]
  },
  {
    id:'2026-10-02-tally-agent-full-year', date:'2 Oct 2026', title:'Your whole financial year from Tally, checked against Tally',
    items:[
      { t:'Every voucher of the year, not just today’s', what:'The Tally agent now reads the full financial year month by month, and checks each month against Tally’s own voucher count. Margin shows “matches Tally’s own voucher count” when everything arrived.',
        how:'Install the new agent once on the PC that runs Tally (Connectors, Tally card, “download the new agent”). Pairing is kept. It updates itself from then on.', act:'connectors' },
      { t:'Deleted or edited vouchers stay in step', what:'If a voucher is changed or deleted in Tally, Margyn changes or removes it on the next sync, so ledgers keep tying out to Tally.',
        how:'Nothing to do. It happens on every sync.' },
      { t:'New financial year, no re-pairing', what:'When you open next year’s company in Tally (for example “… (2027-28)”), the agent moves to it by itself.',
        how:'Nothing to do.' }
    ]
  },
  {
    id:'2026-10-01-tally-first', date:'1 Oct 2026', title:'Your Tally books now drive everything',
    items:[
      { t:'No upload needed for scores and charts', what:'If Tally is connected, Margyn now builds your first Pulse Score straight from it, and Reports draws your months from Tally instead of waiting for two uploads.',
        how:'Open Reports or Pulse Score after your first Tally sync.' },
      { t:'Receivables, payables, Cash and GST read your whole book', what:'Totals used to be worked out from only the first few hundred entries. They now cover every open bill and every bank, cash and GST ledger.',
        how:'Open Receivables, Payables, Cash or GST and tax.' },
      { t:'No more absurd percentages', what:'When the sales side is incomplete, Margin hides the margin and days-to-pay and tells you why, instead of showing nonsense.',
        how:'Open Margin under Insight.', act:'margin' }
    ]
  },
  {
    id:'2026-10-01-password-reset', date:'1 Oct 2026', title:'Forgot your password?',
    items:[
      { t:'Reset it yourself', what:'If you can’t remember your password, you can now set a new one without asking us. We email you a link; it opens a screen where you choose the new password.',
        how:'On the log-in screen click “Forgot password?”, enter your email, then open the link we send you.' }
    ]
  },
  {
    id:'2026-09-30-margin-page', date:'30 Sept 2026', title:'See how much you really keep',
    items:[
      { t:'A Margin page, built from your Tally books', what:'Sales, purchases, running costs and profit month by month, plus returns, freight, who is slow to pay and what that waiting costs you. It uses only what your Tally agent already sends, so nothing new to install.',
        how:'Open Margin under Insight.', act:'margin' },
      { t:'It tells you how far to trust it', what:'Everything comes from one source, so each figure is labelled as a signal until bank and GST agree. If a ledger can’t be placed in the profit and loss, Margyn asks you once and remembers.',
        how:'Scroll to “Margyn needs your help” and confirm the ledgers it lists.' }
    ]
  },
  {
    id:'2026-09-30-smoother-calls', date:'30 Sept 2026', title:'Smoother calls with Margyn',
    items:[
      { t:'Everything in Roman letters', what:'What you say and what Margyn says now always shows in Roman letters, even when you speak Hindi. Margyn talks English by default, switches to easy Hinglish when you do, and switches back when you speak English.',
        how:'Just talk. Say “English please” to keep it in English.', act:'talk' },
      { t:'One hello, not three', what:'Starting a call from the Margyn panel gets a quick hi instead of a recap. Coming back within half an hour gets a short hello, not a “welcome back”.',
        how:'Nothing to do.' },
      { t:'Fewer silences', what:'Margyn waits for you to finish before answering, and always tells you what it just did. It can also open a customer or vendor who has nothing outstanding.',
        how:'Say “open Sanjay Pandey”, then “close this”.' },
      { t:'“Scroll down”', what:'Margyn can scroll the page or the side panel for you, or jump to a section by name. Background noise no longer shows up as words, and Margyn says hello once.',
        how:'Say “scroll down”, “go to the bottom” or “show me the forecast part”.' }
    ]
  },
  {
    id:'2026-09-30-hindi-close', date:'30 Sept 2026', title:'Speak Hindi, and ask Margyn to close things',
    items:[
      { t:'Hindi and Hinglish, written the way you say them', what:'When you talk to Margyn in Hindi or Hinglish, what you said now shows in Roman letters, not Urdu or another script. Margyn always understood you; now the written line matches.',
        how:'Just talk. Mix Hindi and English however you like.', act:'talk' },
      { t:'“Close this”', what:'Margyn can close whatever is open: the customer or vendor side panel, a pop-up, a card in the conversation, the page it opened, or the Margyn panel itself.',
        how:'Say or type “close this”, “close the side panel”, “go back”, or “band kar do”. “Close Margyn” hides the panel.' }
    ]
  },
  {
    id:'2026-09-30-one-margyn', date:'30 Sept 2026', title:'One Margyn, in one place',
    items:[
      { t:'The Margyn panel', what:'Margyn now sits on the right of every page. Type or talk in the same conversation, and whatever Margyn shows you (your P&L, who owes you, cash, a customer) appears right there, without leaving your page.',
        how:'Press <kbd>⌘</kbd> <kbd>J</kbd> (or <kbd>Ctrl</kbd> <kbd>J</kbd>), or choose <b>Margyn</b> in the top bar. Press <b>Talk</b> to speak instead of typing.', act:'panel' },
      { t:'Margyn can do more when you type', what:'Typed questions now get everything a call could do: open a page, draw a view, filter a list, open a customer, fill in and save a form, sync a source. You see each step as Margyn does it.',
        how:'Type “show me who owes us more than 60 days” or “add a vendor called Gupta Packaging”.' },
      { t:'Margyn says hello, and speaks up', what:'When you come back, Margyn tells you what happened while you were away and what needs you. If something goes wrong (a source stops syncing, cash is heading below your floor, a customer passes 60 days), Margyn tells you, at most a few times a day.',
        how:'Nothing to do. Choose <b>Later</b> on a note and Margyn won’t repeat it for a day. Set what Margyn calls you under <b>Profile</b>.' },
      { t:'Home is Margyn’s desk', what:'Home opens with Margyn’s read of the business, what it runs on its own, what needs your OK and what it’s working on. Your figures follow below.',
        how:'Open <b>Home</b>. Tap anything under “What I’m working on” to ask about it.' },
      { t:'One Margyn, not several bots', what:'Payment reminders, reconciliation and reading forwarded documents are all Margyn’s work now, with one voice. The old agent threads are under <b>Conversations</b>, and the background work is under <b>Automations</b>.',
        how:'Open <b>Conversations</b> to reread anything, then choose <b>Continue in Margyn</b>.' }
    ]
  },
  {
    id:'2026-09-30-channel-health', date:'30 Sept 2026', title:'See which messages are actually reaching people',
    items:[
      { t:'Channel health', what:'A new page shows whether your Opening and Closing Bell, payment chases and the CFO pack email are delivering. A message template WhatsApp hasn’t approved used to fail without a word; now it shows as not delivering, with the reason, and appears in your notifications.',
        how:'Open Channel health under Admin in the left menu, or press ⌘K and type “channel health”.' },
      { t:'Paid after Margyn chased', what:'The same page adds up the invoices that closed as paid after Margyn had chased them, and shows what is still being chased and what customers have promised.',
        how:'Open Channel health. It counts payments that followed a chase; it can’t prove the customer wouldn’t have paid anyway.' }
    ]
  },
  {
    id:'2026-09-30-open-items', date:'30 Sept 2026', title:'Receivables and payables count only what’s really open',
    items:[
      { t:'Drafts, voided and cancelled invoices no longer count', what:'A Zoho draft or voided invoice, or an Odoo draft or cancelled one, isn’t money anyone owes. They’re now left out of Receivables, Payables, the forecast, Ask Margyn and WhatsApp.',
        how:'Nothing to do. If a total went down today, this is why. They still show in Zoho or Odoo themselves.' },
      { t:'Deleted in Odoo, closed in Margyn', what:'An invoice or bill deleted in Odoo is now closed in Margyn on the next sync, the way Zoho and Tally already work. Its original amount stays on record.',
        how:'Nothing to do. It happens with the nightly Odoo sync.' }
    ]
  },
  {
    id:'2026-09-30-team-who', date:'30 Sept 2026', title:'See who did what, on every channel',
    items:[
      { t:'The Audit log names the person', what:'Every entry that’s added, settled or imported, and every change to your team, now shows who did it and whether it was in the app, by voice or on WhatsApp.',
        how:'Open <b>Audit log</b> under Admin. Search a name to see everything that person changed.' },
      { t:'One person, app and WhatsApp', what:'Link someone’s WhatsApp number to their login and Margyn treats them the same on both: a Viewer can ask on WhatsApp but not change anything, an Approver can approve.',
        how:'<b>Settings</b>, then <b>App logins</b>. Choose <b>Access</b> next to the person and enter their WhatsApp number.', act:'team' },
      { t:'Your own view', what:'People on your team can adjust their own forecast and metric choices without changing yours.',
        how:'Nothing to do. Your settings stay the business’s defaults.' }
    ]
  },
  {
    id:'2026-09-29-team-logins', date:'29 Sept 2026', title:'Your team can now sign in as themselves',
    items:[
      { t:'Invite your team', what:'Your finance lead, an approver or your CA can each have their own login. Margyn knows who is signed in and shows each person only what their role allows.',
        how:'Open <b>Settings</b>, then <b>App logins</b>. Enter their email, pick a role and choose <b>Create invite</b>. Send them the link or the code.', act:'team' },
      { t:'Joining with a code', what:'The person signs in with the email the invite was sent to and goes straight into your business.',
        how:'Open the link, or after signing in choose your initials at the top right, then <b>Join a team with a code</b>.' },
      { t:'Roles you can fine-tune', what:'Admin, Finance, Approver, Viewer and Advisor (CA). Turn any single permission on or off for one person, or suspend them in a click.',
        how:'In <b>App logins</b>, choose <b>Access</b> next to the person.' },
      { t:'Every open invoice, counted', what:'Receivables, Payables, Customers and Vendors now count every open invoice from Zoho, Tally and Odoo, not the first few hundred. Ask Margyn and WhatsApp use the same figures as the screen.',
        how:'Nothing to do. If a source is ever too large or can’t be read, the page says so in a line above the list.' }
    ]
  },
  {
    id:'2026-09-27-voice-keys', date:'27 Sept 2026', title:'Talking to Margyn got faster and more hands-free',
    items:[
      { t:'Start and end a call from the keyboard', what:'Talk to Margyn from anywhere in the app without reaching for the mouse.',
        how:'Press <kbd>⌥</kbd> <kbd>M</kbd> (or <kbd>Ctrl</kbd> <kbd>M</kbd>) to start. Press it again, or <kbd>Esc</kbd>, to end the call.', act:'talk' },
      { t:'Say goodbye and the call ends', what:'No need to find the End button.',
        how:'Say “Thank you, that’s all”, “Okay, that was it” or “End the conversation”.' },
      { t:'Margyn fills in and saves forms for you', what:'New customers, new vendors and ledger entries can be done start to finish by voice.',
        how:'Say “Add a vendor called Sanjay Pandey, phone 98565 25560”, then “Save it”.' },
      { t:'Connector status in a second', what:'Ask whether a source is working and hear when it last synced. When a sync finishes, Margyn tells you without being asked.',
        how:'Say “Is my Zoho connector working?” or “Sync Zoho”.' },
      { t:'A tidier workspace', what:'The floating workspace clears when you move to another page, and a change you’ve approved leaves after a few seconds.',
        how:'Nothing to do. Say “Clear the workspace” to empty it any time.' },
      { t:'CFO pack summaries match the pack', what:'A summary of the CFO pack now uses the month on screen, so every figure matches the pack.',
        how:'Open the CFO pack and say “Summarise this”.' }
    ]
  }
];
const MG_WN_KEY = 'whats_new_seen', MG_WN_LS = 'margyn_whats_new_seen';
const MG_WN_ACTS = {
  bookshealth:{ label:'Open the books check', run:() => { if(typeof mgShowBooksHealth === 'function') mgShowBooksHealth(); } },
  panel:{ label:'Open Margyn', run:() => { if(typeof mgrOpen === 'function') mgrOpen(true); } },
  margin:{ label:'Open Margin', run:() => { if(typeof showView === 'function') showView('margin'); } },
  cashflow:{ label:'Open Cash flow', run:() => { if(typeof showView === 'function') showView('cashflow'); } },
  borrowing:{ label:'Open Cash', run:() => { if(typeof showView === 'function') showView('cash'); setTimeout(() => { const el = document.getElementById('mgBorrowHist'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }, 120); } },
  home:{ label:'Open Home', run:() => { if(typeof showView === 'function') showView('home'); } },
  receivables:{ label:'Open Receivables', run:() => { if(typeof showView === 'function') showView('receivables'); } },
  cfopack:{ label:'Open CFO pack', run:() => { if(typeof showView === 'function') showView('cfopack'); } },
  gst:{ label:'Open GST and tax', run:() => { if(typeof showView === 'function') showView('gst'); } },
  cash:{ label:'Open Cash', run:() => { if(typeof showView === 'function') showView('cash'); } },
  connectors:{ label:'Open Connectors', run:() => { if(typeof showView === 'function') showView('connectors'); } },
  inbox:{ label:'Open Inbox', run:() => { if(typeof showView === 'function') showView('inbox'); } },
  customers:{ label:'Open Customers', run:() => { if(typeof showView === 'function') showView('customers'); } },
  talk:{ label:'Try it now', run:() => { if(typeof openRealtimeOverlay === 'function') openRealtimeOverlay(); } },
  team:{ label:'Invite someone', run:() => { if(typeof showView === 'function') showView('settings'); setTimeout(() => { const m = document.getElementById('setTeamMount'); if(m) m.scrollIntoView({ block:'start' }); }, 120); } }
};

function mgWnSeen(){
  let v = null;
  try { v = typeof mgPrefGet === 'function' ? mgPrefGet(MG_WN_KEY, null) : null; } catch(e){}
  if(!v){ try { v = localStorage.getItem(MG_WN_LS); } catch(e){} }
  return v || null;
}
function mgWnMarkSeen(id){
  try { localStorage.setItem(MG_WN_LS, id); } catch(e){}
  try { if(typeof mgPrefOn === 'function' && mgPrefOn()) mgPrefSet(MG_WN_KEY, id); } catch(e){}
}
/* Releases the user hasn't seen, newest first. */
function mgWnUnseen(){
  const seen = mgWnSeen();
  if(!seen) return MG_RELEASES.slice(0, 1);
  const i = MG_RELEASES.findIndex(r => r.id === seen);
  return (i < 0 ? MG_RELEASES.slice(0, 1) : MG_RELEASES.slice(0, i)).slice(0, 3);
}

/* force: open from the palette even when everything has been seen. */
function mgWhatsNew(force){
  if(document.querySelector('.mg-wn-scrim')) return;
  const list = force ? MG_RELEASES.slice(0, 1) : mgWnUnseen();
  if(!list.length) return;
  const items = list.flatMap(r => r.items);
  const head = list[0];
  const prevFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'mg-wn-scrim';
  scrim.innerHTML =
    '<div class="mg-wn" role="dialog" aria-modal="true" aria-labelledby="mgWnTitle">' +
      '<div class="mg-wn-h"><div class="mg-wn-kicker">What’s new · ' + escapeHtml(head.date) + '</div>' +
        '<h3 id="mgWnTitle">' + escapeHtml(head.title) + '</h3>' +
        '<p>' + (list.length > 1 ? escapeHtml(list.length + ' updates since you were last here.') : 'Here’s what changed and how to use it.') + '</p></div>' +
      '<div class="mg-wn-list">' + items.map((it, i) =>
        '<div class="mg-wn-item"><div class="mg-wn-n">' + (i + 1) + '</div><div>' +
          '<b>' + escapeHtml(it.t) + '</b><div class="what">' + escapeHtml(it.what) + '</div>' +
          '<div class="how"><span>How</span>' + it.how + '</div>' +   // `how` is our own copy above; it carries <kbd> markup
          (it.act && MG_WN_ACTS[it.act] ? '<button type="button" class="mg-btn" data-wn-act="' + it.act + '">' + escapeHtml(MG_WN_ACTS[it.act].label) + '</button>' : '') +
        '</div></div>').join('') + '</div>' +
      '<div class="mg-wn-f"><small>Find this again: search “What’s new”.</small><button type="button" class="mg-btn primary" data-wn-ok>Got it</button></div>' +
    '</div>';
  document.body.appendChild(scrim);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    mgWnMarkSeen(MG_RELEASES[0].id);
    if(prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch(e){}
  };
  const onKey = e => { if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', e => {
    const a = e.target.closest('[data-wn-act]');
    if(a){ close(); MG_WN_ACTS[a.dataset.wnAct].run(); return; }
    if(e.target === scrim || e.target.closest('[data-wn-ok]')) close();
  });
  scrim.querySelector('[data-wn-ok]').focus();
  if(typeof mtrack === 'function') mtrack('whats_new_shown', { release:MG_RELEASES[0].id, forced:!!force });
}

/* Once the app has loaded for a signed-in user, show anything new. Waits a
   beat so it lands on a drawn page, and never on top of another dialog. */
(function(){
  let checked = false;
  const base = refreshAll;
  refreshAll = async function(){
    const out = await base.apply(this, arguments);
    if(!checked && typeof currentUser !== 'undefined' && currentUser){
      checked = true;
      // Margyn's greeting (25-margyn.js) announces what's new in the panel
      // now, with a button for this card; it only pops up on its own without it.
      if(typeof mgrGreet !== 'function') setTimeout(() => { if(!document.querySelector('.mg-dialog-scrim') && !(typeof vxActive !== 'undefined' && vxActive)) mgWhatsNew(false); }, 1200);
    }
    return out;
  };
})();
