# Handoff: Margyn OS UI (branch worktree-margyn-os)

Approved plan + mocks: https://claude.ai/artifact/VgNGb2JDCRUppsYFQA36TX
VP rule: ship everything as ONE release; the app must never be half-broken.

## Done (2 commits on this branch)
- app/js/27-os.js: spaces/tabs/rail, space/tab routes (`#/collect/receivables`, old links redirect), section filter (a tab shows part of a page), ask bar, Margyn panel opens over the page (pin on wide screens), phone bottom bar, G-key shortcuts, voice scroll switches tab, role-based rail.
- app/js/28-os-live.js: Margyn's 8 named agents, activity record (every /api call while it runs, plus tally/odoo sync runs, product_events, forecast_runs, chase targets, docs), live pill in the top bar, Desk, Margyn › Live (animated system view), All work.
- app/js/29-os-pages.js: Collect, Chasing, Pay, Close checklist, Plan, Transactions, Documents, Rules, How it works.
- app/js/30-os-records.js: party Timeline + Thread, assign work (table record_notes).
- app/css/os.css; edits to app.html, 19a, 19b, 19d (forecast-off bug fix), 20-frame, 24-whats-new (release entry), 25-margyn.
- 2026-10-05-record-notes.sql (VP runs it; the app works without it, the threads say they are off).
- Tests: the 7 existing suites were updated to the new navigation and all pass. New: tools/ui-os-test.js (25 checks pass).

## Left
1. tools/ui-os-test.js step 9 (approver): the test's mgActor needs the `perms` shape 19g-team.js expects (mgCan reads it; it threw "reading 'includes'"). Copy the asMember() helper from tools/ui-frame-test.js (around line 340). Then run the full test.
2. Run all 8 suites plus api/_lib/__tests__/*.test.js. Run playwright with NODE_PATH="/Users/varad/Downloads/Full repo/node_modules" and serve with `node tools/serve-static.js "$PWD" <port>`.
3. Screenshot every space and tab at 1440 and 390 (tools/ui-shots.js; extend VIEWS) and fix anything that looks off.
4. tools/ui-contract.js: regenerate and check the diff.
5. Open the PR (Margyn-Labs/reflectional). Do NOT merge until VP has checked the Vercel preview.
6. After the merge: copy the changed files back to ~/Downloads/Full repo. VP runs the SQL (click-by-click steps).
7. Old manual worktree ~/Downloads/margyn-os (branch margyn-os-ui) holds the same 2 commits and can be removed.
