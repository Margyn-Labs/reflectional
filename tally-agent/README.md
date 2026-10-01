# Margyn Tally Connector — prototype

A local desktop agent that pulls data out of a business owner's **TallyPrime** or
**Tally.ERP 9** installation and syncs it into Margyn's cloud, where it lands as
provenance-tagged **Signal** (never auto-trusted; corroborated later against bank
feeds via Account Aggregator and GST filings).

This is a **working prototype**, not a shippable installer. See
[What is NOT done](#what-is-not-done-yet).

## Supported environments

| | Supported |
|---|---|
| Tally product | **TallyPrime** (Release 2.1+) and **Tally.ERP 9** (Release 6.x). The agent detects which on pairing and records it; one tolerant parser handles both. |
| Agent host OS | **Windows 10 and Windows 11 only.** Nothing older. |
| Where the agent runs | The Tally machine, *or* any other Win 10/11 box on the same LAN pointing at Tally's IP (`TALLY_HOST`). This is how we support businesses whose Tally sits on an old/locked-down PC — the agent doesn't have to live there. |

Because we only target Win 10/11, the agent stays a **Node.js** build — no need
to drop to a Go/native binary for old-Windows reach.

---

## Pieces

| Piece | Path | What it is |
|---|---|---|
| Local agent | `tally-agent/` | Node.js CLI. Talks to Tally's XML/HTTP server, pushes JSON to the cloud. |
| Ingest endpoint | `api/tally.js` | One Vercel serverless function, `?action=` router (`pair-init`, `pair-complete`, `ingest`, `status`, `revoke`). Zero npm deps. |
| Schema | `2026-09-04-tally-connector.sql` | Supabase tables + RLS. Run in the SQL Editor before deploying `api/tally.js`. |
| App UI (WIP) | `app-tally-wip.html` + `app-html-integration.diff` | The "Connect Tally" connector card + pairing modal, on a copy of `app.html`. **Not merged into production.** |

---

## Language choice: why Node.js

Plain Node.js CLI (Node 18+ for global `fetch`), **zero dependencies**.

- Win 10/11-only support means we never need old-Windows reach, so there's no
  reason to drop to Go/.NET. Node stays.
- You maintain it — staying in JS keeps it iterable.
- Zero deps → packaging later is trivial: Node SEA or `pkg` produces a single
  `margyn-tally-agent.exe` to code-sign in one step.
- The Vercel zero-npm rule is a cloud-side function-limit thing; it doesn't apply
  to the agent — dep-free here is just a nicety.

---

## 1. Enable Tally's HTTP/XML server

On the machine where Tally runs:

**TallyPrime (Release 2.1+):**
1. **F1 (Help) → Settings → Advanced Configuration**.
2. Set **TallyPrime acts as** to **Both**.
3. **Port** = **9000**.
4. Accept and save (`Ctrl+A`).

**Tally.ERP 9 (Release 6.x):**
1. **F12 (Configure) → Advanced Configuration**.
2. Set **Tally.ERP 9 is acting as** to **Both**.
3. **Port** = **9000**.
4. Accept (`Ctrl+A`).

Then, either product: **open the company** you want to sync — requests only
resolve against a loaded company.

To sanity-check outside the agent, from the same machine:

```bash
curl -s http://localhost:9000 -H "Content-Type: text/xml" --data '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC></DESC></BODY></ENVELOPE>'
```

You should get an XML envelope back listing your company. If you get connection
refused, the HTTP server isn't on or the port differs.

> If Tally runs on a **different PC** on the LAN, set `TALLY_HOST` to that
> machine's IP and make sure Windows Firewall allows inbound TCP 9000.

---

## 2. Configure and run the agent

```bash
cd tally-agent
cp .env.example .env      # optional — edit values, or let `pair` prompt you
node --version            # must be >= 18
```

Key settings (env var **or** the config file written by `pair`):

| Setting | Default | Notes |
|---|---|---|
| `MARGYN_API_BASE` | `https://app.margyn.in` | Point at a Vercel preview URL to test against a branch. |
| `TALLY_HOST` / `TALLY_PORT` | `127.0.0.1` / `9000` | |
| `TALLY_COMPANY` | — | **Exact** company name from Tally's Gateway. Required. |
| `TALLY_FROM_DATE` / `TALLY_TO_DATE` | current Indian FY | `YYYYMMDD`. Closing balances are as-of `TO_DATE`. |
| `SYNC_INTERVAL_MINUTES` | `15` | Used by `run`. |

### Pair

In the Margyn app: **Connectors → Connect Tally → Generate pairing code**. Then:

```bash
node agent.js pair
```

Paste the code and the company name. On success the install key is written to:

- Windows: `%APPDATA%\Margyn\tally-agent.json`
- macOS: `~/Library/Application Support/Margyn/tally-agent.json`
- Linux: `~/.config/margyn/tally-agent.json`

The app window detects the pairing and updates itself.

### Test Tally connectivity (no cloud call)

```bash
node agent.js tally-check
```

Prints the first 15 ledgers with closing balances straight from Tally. Use this
to isolate Tally problems from cloud problems.

### Sync

```bash
node agent.js sync            # one sync: ledger closing balances -> cloud
node agent.js sync --dry-run  # print the exact JSON payload, send nothing
node agent.js run             # sync now, then every SYNC_INTERVAL_MINUTES
```

After a successful `sync`, the rows are in Supabase `tally_ledgers` with
`source='tally'`, `verification_status='signal'`, `synced_at`, `install_id`,
`company_name`. Check `tally_sync_runs` for the audit trail.

### Testing without a Windows machine — `mock-tally.js`

`mock-tally.js` stands in for TallyPrime's XML server, built from the real v6
export fixtures (see [How the real request was found](#how-the-real-request-was-found)):

```bash
node mock-tally.js               # listens on 9000
CB_MODE=full node mock-tally.js  # every ledger gets a closing balance, not just one
```

Then in another terminal:

```bash
TALLY_COMPANY="Margyn Labs" node agent.js tally-check
TALLY_COMPANY="Margyn Labs" node agent.js sync --dry-run
```

`CB_MODE` values: `sparse` (default — only one ledger gets a closing balance,
matching the real capture), `full` (every ledger gets one), `none` (nobody
does) — all three must parse without errors, `sparse`/`none` leaving
`closing_balance: null` on the ledgers that don't have one.

---

## Auth / pairing design

**Short-lived pairing code → long-lived, revocable, hashed per-install key. No OAuth.**

- Tally has no OAuth and the agent is a confidential client on the user's own
  machine — OAuth would be ceremony with no security gain.
- The app mints an **8-char code** (`tally_pairings`, SHA-256 hashed, 10-min TTL,
  locks after 5 bad attempts). Only the disposable code travels through
  copy/paste — never the real secret.
- `pair-complete` exchanges the code for a **32-byte random install key**
  (`mtly_…`). The cloud stores **only `sha256(key)`** in `tally_installs`. The
  raw key is returned exactly once and lives only in the agent's local config.
- Every agent call authenticates with `Authorization: Bearer <install_key>`.
- The key is scoped to one user + one company, and **revocable** from the app
  (`status='revoked'`) without touching the user's password or other connectors.
- A `tally_installs` table leak exposes no usable keys (hashes only). No raw
  credential is ever logged.

---

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **0** | Product/version detection (TallyPrime vs ERP 9) | **Done, confirmed on real TallyPrime.** `buildInfoRequest`/`parseInfo`, stored on `tally_installs`. |
| **1** | Ledger masters + opening/closing balances | **Done, confirmed end-to-end in PRODUCTION** (2026-09-05) — real ledgers synced through the real cloud, visible in Supabase. ERP 9 untested on real hardware yet (mock-only). |
| **2** | Vouchers — Sales, Purchase, Receipt, Payment, Journal (+ any type that shows in the Day Book) | **Done, confirmed on real TallyPrime** (2026-09-06). `buildVoucherRequest` = Tally's built-in **"Day Book"** report as a `TYPE=Data` date-range export (`SOURCECOLLECTION>Vouchers` failed — "Vouchers" isn't a real collection). Returns full verbose vouchers with nested `<LEDGERENTRIES.LIST>`; `parseVouchers` pulls type/number/date/party/GUID + the signed ledger-entry breakdown, headline `amount` = abs(party entry). Real 5-voucher response parsed correctly. |
| **3** | Bill-wise outstanding (receivables + payables aging) | **Done, confirmed on real TallyPrime** (2026-09-06). `buildBillsRequest` = Tally's built-in **"Bills Receivable"** report (`TYPE=Data`) — on the test install it returned bills of BOTH signs; `parseBills` reads the `<BILLFIXED>` + `<BILLCL>/<BILLDUE>/<BILLOVERDUE>` shape and derives direction from the sign of BILLCL. Overdue-days and d-mmm-yy dates handled. |
| later | Inventory/logistics vouchers (Delivery Note, POs, Stock Journal), Payroll vouchers | **Deliberately deferred.** Margyn doesn't have inventory or payroll providers integrated yet, so there's no vitals math that would consume this data. Ship as a version update once/if a pilot customer needs it — same connector, no architecture change required. |
| never (by design) | GST return data (GSTR-1/3B/2A/2B) | **Not a Tally pull.** This comes from the GSTN/GSP channel per the locked connector strategy — pulling it from Tally too would duplicate a pipeline that already exists elsewhere. |

`node agent.js sync` now runs all three (ledgers + vouchers + bills) by default — vouchers/bills are wrapped so a wrong request shape logs a warning and skips, it never blocks the proven ledger sync. Use `sync --ledgers-only` to fall back to the old narrow behavior.

### How the real request was found

This took several real-machine rounds to get right — worth recording so Phase
2/3 don't repeat the same dead ends.

**What didn't work:** defining a brand-new TDL collection from scratch
(`<TYPE>Ledger</TYPE>` + a list of `NATIVEMETHOD` fields — the obvious,
textbook way, and what every version of this file tried first) made real
TallyPrime **hang indefinitely** ("not responding" in Windows) rather than
answer or error. This happened whether the request asked for one field or
five, with or without `ClosingBalance`, with or without extra collection
attributes. Confirmed with curl directly against Tally (bypassing Node
entirely) so it's not a client-side bug — Tally itself never responds to this
class of request on this install.

**What worked:** Tally answers fine and fast to its own **built-in** collection
named `"List of Ledgers"` (found in a real, currently-used
[community integration script](https://gist.github.com/tejavarma-aln/306db4fbbd33465130c23ce3061d0011),
not invented) — but that alone only returns ledger names, nothing else. The
fix: don't define a new collection — build on top of the one that already
works, via `<SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>` plus
`<COMPUTE>` fields for everything else needed (name, parent, opening balance,
closing balance, GUID, master ID). That request answers instantly with real,
correct data on the same install that hung on the first approach.

**Response shape** (verified against a real captured response, not assumed):
`<LEDGER>` blocks with flat child tags — `MARGYNNAME`, `MARGYNPARENT`,
`MARGYNOPENING`, `MARGYNCLOSING`, `MARGYNGUID`, `MARGYNMASTERID` (the alias
names chosen in the request) — not nested `AMOUNT`/`ISDEBIT` blocks. `MASTERID`
comes with a leading space; `PARENT` can carry a leading Tally control
character (`&#4;`) on the P&L account specifically — both handled by the
parser. `MARGYNCLOSING` came back **empty for most ledgers** on the real test
(resolved for only 1 of 8) — treated as `null`, not an error; a ledger still
syncs on name + parent + opening balance alone.

**Still open:** sign convention for `MARGYNOPENING`/`MARGYNCLOSING` on a real
*non-zero credit* balance — every ledger in the real test happened to have a
zero balance. Revisit if a synced number looks inverted against Tally's own
display. Also: this exact request is untested against real Tally.ERP 9 and
against a non-Educational-mode TallyPrime — the `SOURCECOLLECTION` mechanism
is a Tally-engine-level feature, not specific to the install we tested on, but
"probably fine elsewhere" isn't "confirmed elsewhere."

---

## Deploy checklist

1. **Supabase SQL Editor** → paste and run `2026-09-04-tally-connector.sql`.
   Expect *"Success. No rows returned."*
2. Confirm Vercel env vars exist (already set for other connectors):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   **No new env vars are needed.**
3. Add **`api/tally.js`** via the GitHub web UI (new file → paste → commit to
   `main`). This is function **12/12** on the Hobby plan — do not add another
   `api/*.js` file after it without merging one.
4. Vercel auto-deploys from `main`. Verify:
   `curl -s https://app.margyn.in/api/tally?action=status` → `401 unauthorized`
   (endpoint is live, just unauthenticated).
5. On a test machine with TallyPrime: `node agent.js pair`, then
   `node agent.js tally-check`, then `node agent.js sync`. Confirm rows in
   `tally_ledgers`.
6. `app.html` UI: **not deployed this pass.** When ready, apply
   `app-html-integration.diff` (or lift the marked blocks from
   `app-tally-wip.html`) into `app.html` and deploy that separately.
7. Commit `2026-09-04-tally-connector.sql`, `api/tally.js`, and `tally-agent/`
   to the repo.

---

## What is NOT done yet

- **Installer** — no MSI/EXE. Run via `node agent.js`.
- **Code signing / registration** — you're handling this once the sync logic is proven.
- **Auto-update** — none.
- **Windows service wrapping** — `run` is a foreground console process. Wrap with
  `nssm` / `sc.exe` manually for now.
- **Vouchers (Phase 2)** and **bill-wise outstanding (Phase 3)** — schema and
  ingest paths exist; Tally request/response not finalised.
- **ERP 9 confirmation run** — detection + parser cover ERP 9, tested against the
  mock in `PRODUCT=erp9` mode, but not yet against a real ERP 9 install. Same
  one-run confirmation as TallyPrime.
- **Windows service wrapping** — `run` is a foreground console process. Wrap with
  `nssm` / `sc.exe` manually for now.
- **UTF-16 / special-character handling** — requests go out UTF-8; add
  `SVEXPORTFORMAT` UTF-16 negotiation if currency symbols come back garbled.
- **Offline queue / retry-backoff** — a failed sync just waits for the next
  interval; nothing is spooled to disk.
- **Multi-company per install** — one install = one company. Pair again for a
  second company.
- **Production `app.html` wiring** — lives only in `app-tally-wip.html`.
- **Vitals / Pulse Score** — deliberately untouched. The vitals engine consumes
  `tally_ledgers` downstream; this connector does no scoring.
