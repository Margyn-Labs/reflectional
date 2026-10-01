# Margyn Tally Agent GUI — prototype

A small Windows system-tray app that wraps `../tally-agent`'s CLI logic so a
non-technical business owner never has to open Command Prompt. It does **not**
reimplement Tally XML, pairing, or cloud-ingest logic — it `require()`s
`../tally-agent/agent.js`, `config.js`, and `cloud.js` directly and calls the
same functions the CLI uses.

This is a **working prototype in dev mode**, not a signed installer. See
[What is NOT done yet](#what-is-not-done-yet).

---

## How it reuses `tally-agent/`

| File | Role |
|---|---|
| `agent-lib.js` | Resolves `../tally-agent` (dev: sibling directory on disk; packaged: `resources/tally-agent`, copied there at build time by `electron-builder`'s `extraResources`) and requires `agent.js` / `config.js` / `cloud.js` / `tallyClient.js` from there. No Tally logic lives in this repo. |
| `main.js` | Electron main process — tray icon, popup window, IPC handlers, the background sync-loop timer. Calls `agent.performPair(...)` and `agent.runLedgerSync(...)` exactly as `tally-agent/agent.js`'s own `pair`/`run` commands do. |
| `preload.js` | `contextBridge` — the renderer never gets Node integration or a reference to `agent-lib`; it only gets `window.margyn.{getState,pair,syncNow,saveSettings,onLog,onState}`. |
| `renderer/` | Plain HTML/CSS/JS UI. No framework. |

**One narrow change was made to `tally-agent/agent.js`** (nothing else in
`tally-agent/`, `api/`, or any other existing file was touched):

1. `cmdPair`'s body (Tally version probe → `cloud.pairComplete` → `config.save`)
   was extracted into a new `performPair({ code, company, cfg, onLog })`
   function so it can be called without the CLI's `readline` prompts.
   `cmdPair` itself now just collects `code`/`company` via prompts and calls
   `performPair` — **the computation is byte-identical to before**, just moved.
2. The CLI's `(async () => { ... })()` entrypoint at the bottom of the file is
   now guarded with `if (require.main === module)`, so that
   `require('./agent.js')` from this GUI does not also parse `process.argv`
   and call `process.exit()`. Running `node agent.js <command>` directly is
   completely unaffected.
3. `module.exports = { AGENT_VERSION, performPair, fetchLedgers, runLedgerSync }`
   was added at the bottom.

**`tallyClient.js`, `cloud.js`, and `config.js` were not touched at all.**

No Tally XML request/response shape, no pairing/auth design, and no cloud API
contract was changed. If you diff `tally-agent/agent.js` you'll see only the
refactor described above.

---

## Folder layout (required)

`tally-agent-gui/` must sit **next to** `tally-agent/` — same parent directory:

```
some-folder/
├── tally-agent/        # the CLI modules (agent.js, tallyClient.js, config.js, cloud.js)
└── tally-agent-gui/    # this Electron app
```

Dev mode requires them as siblings on disk. The packaged installer copies the
needed `tally-agent/*.js` files inside itself (see `extraResources` in
package.json), so the **installed app has no folder dependency** — that's only
a build-time requirement.

---

## Building the single downloadable installer (do this on Windows)

This produces one `.exe` a customer downloads and runs — no Node, no folder,
no terminal. Everything (Electron runtime + the app + the tally-agent modules)
is bundled inside.

```bash
cd tally-agent-gui
npm install
npm run dist
```

Output: `tally-agent-gui/dist/Margyn-Tally-Agent-Setup-0.1.0.exe`

That file is the deliverable — upload it to margynlabs.com for download. The
installer is **one-click** (`nsis.oneClick: true`): the customer double-clicks
it, it installs per-user (no admin prompt), and launches. It also registers
itself to **start automatically with Windows** (it's a background sync tool).

**Windows will show an "unknown publisher" SmartScreen warning** — the customer
clicks "More info" → "Run anyway". Removing that warning needs code signing,
which is deliberately out of scope for this pass (see below).

`npm run dist` must run **on Windows** — building a Windows NSIS installer from
macOS needs Wine and is unreliable. Build it once on the Windows box.

---

## Run in dev mode (for testing before you build the installer)

```bash
cd tally-agent-gui
npm install     # pulls electron + electron-builder as devDependencies
npm start       # electron .
```

On first run with no paired install, the window opens showing the pairing
form. Once paired, it shows the connected dashboard and starts the background
sync loop (ledgers + vouchers + bills, every N minutes).

Click the tray icon to open/close the window. Right-click the tray icon for
"Open", "Sync now", "Quit".

### Testing against the mock Tally server (no real Tally needed)

```bash
# terminal 1
cd tally-agent/
node mock-tally.js

# terminal 2
cd tally-agent-gui/
TALLY_COMPANY="Margyn Labs" npm start
```

Use a real pairing code from the Margyn app to pair, or — to test the sync
loop only, without pairing — see "What was tested" below.

---

## What was tested (in this dev environment)

This sandbox has no real Windows machine, no real TallyPrime, and — it turned
out — no usable on-screen display for an actual Electron window (the sandboxed
Electron process launched and then was killed by the sandbox before a window
could render; this looks like a sandbox/display restriction, not a bug in the
app — see below). What *was* verified:

- **`node --check` on every new file** (`main.js`, `preload.js`, `agent-lib.js`,
  `renderer/renderer.js`) — all pass.
- **`node --check tally-agent/agent.js`** after the export refactor — passes.
- **Module resolution**: `require('./agent-lib')` from `tally-agent-gui/`
  correctly resolves the sibling `../tally-agent/` directory in dev mode and
  requires `agent.js`/`config.js`/`cloud.js`/`tallyClient.js` from there,
  confirmed by printing each module's exported function names.
- **The exact Tally-reading code path `main.js`'s sync loop calls** —
  `agent.fetchLedgers(cfg)` (the same function `tally-check` and `sync` use
  internally) — run directly against `tally-agent/mock-tally.js` from a plain
  Node script (not through Electron, since Electron's window couldn't be
  verified here). It correctly returned 8 parsed mock ledgers with names,
  parents, and opening balances — proving the GUI's require-and-call path into
  `tally-agent/` is wired correctly end-to-end for the read side.
- **`require.main === module` guard**: confirmed that `require('./agent.js')`
  now returns the exports object without also running the CLI arg-parser /
  calling `process.exit()`.

## What was NOT tested here (needs a real Windows machine tomorrow)

- **The Electron window actually rendering and being interactive** — tray
  click, the pairing form, the paired dashboard, settings form. The dev
  sandbox this was built in could launch the Electron process (no crash, no
  error output) but it was killed a few seconds later, consistent with a
  sandboxed environment blocking GUI/WindowServer access rather than an app
  bug — but this is exactly the kind of thing that needs eyes-on confirmation
  on a real machine. **Do this first tomorrow**: `npm start` on a normal
  Windows/macOS desktop session and confirm the tray icon appears and the
  window opens/positions correctly.
- **`performPair` end-to-end against the real Margyn cloud** — not run here
  deliberately, to avoid making a network call against production
  (`https://app.margyn.in`) from an unattended dev sandbox with a throwaway
  code. Test tomorrow: generate a real pairing code in the Margyn app, run
  `npm start`, and pair through the GUI form.
- **A real TallyPrime/ERP 9 install** — everything here was tested against
  `mock-tally.js`, matching the same caveat `tally-agent/README.md` already
  carries for its own CLI testing.
- **Windows-specific tray/window positioning** — `toggleWindowNearTray()` in
  `main.js` assumes the tray icon is bottom-right (Windows convention) when
  positioning the popup above it; this logic is untested on an actual Windows
  taskbar. Confirm the window doesn't clip off-screen on a real Windows box,
  especially with the taskbar on a different edge or with display scaling.
- **`electron-builder` producing an actual `.exe`** — `npm run dist` was not
  run in this sandbox (no attempt made — packaging wasn't the goal per the
  task, and this environment can't produce or verify a Windows binary anyway).
  The `build` config in `package.json` (NSIS target, `extraResources` copying
  `tally-agent/{agent,config,cloud,tallyClient}.js` + `package.json` into
  `resources/tally-agent/`) is a **starting point config only** — expect to
  iterate on it once someone runs `npm run dist` on Windows.

---

## What is NOT done yet

- **Code signing** — not done. Customers get the "unknown publisher" SmartScreen
  warning; they click through it ("More info" → "Run anyway"). Removing it needs
  an EV/OV code-signing certificate — deliberately deferred, VP handles this.
- **Auto-update** — none. New versions = customer downloads and re-runs the
  installer (it upgrades in place).
- **A real icon** — `assets/*.png` are flat placeholder emerald (`#0E8F5C`)
  squares. `app-icon.png` is 256×256 (electron-builder's minimum, so the build
  works) but **a designer must replace all three** with the real Margyn mark
  before public download.
- **`npm run dist` has not actually been run** — the NSIS config is complete and
  `oneClick`/auto-start/single-instance are all wired, but a real Windows build
  producing a working `.exe` has not been verified. Expect one or two iterations
  the first time (icon conversion, path resolution in the packaged app).
- **The Electron window has never rendered on a real screen** — every test so
  far was the require-and-call path against `mock-tally.js`, plus syntax checks.
  Tray behaviour, window positioning, and the pairing/dashboard UI need eyes-on
  confirmation on real Windows.
- **Offline queue / retry-backoff for the sync loop** — same limitation as the
  CLI: a failed sync just waits for the next interval tick, nothing is spooled.
- **Multi-company per install** — same as the CLI; one paired install = one
  company. Re-pairing from the GUI would overwrite the existing config's
  `installKey`/`company` (this mirrors the CLI's own `pair` behavior exactly,
  not a new limitation introduced here).
- **Credential storage is still the CLI's plaintext-with-chmod-600 approach**
  (`tally-agent/config.js`) — not upgraded to Windows Credential Manager/DPAPI
  in this pass, matching the existing prototype's own documented limitation.
- **Settings validation** — the settings form accepts any text in the API
  base / host / port / interval fields; there's no inline validation (e.g.
  rejecting a non-numeric port). Minor, but worth tightening before a wider
  pilot.

---

## Bugs noticed in `tally-agent/` but NOT fixed (flagging per instructions)

- **`runLedgerSync`'s non-dry-run return value has no ledger count field of
  its own** — it returns whatever `cloud.ingest()` gives back
  (`{upserted, received, skipped}`), so the GUI's "ledgers synced" stat is
  read from `result.received ?? result.upserted`, which is a reasonable proxy
  but isn't the same thing `tally-check`/`dump-request` would show you
  (`rows.length` straight from Tally, before any server-side skip logic).
  If the cloud ever skips rows silently, the GUI's "ledger count" will read
  slightly differently than a literal Tally row count. Not fixed — flagging
  in case the intent was for `runLedgerSync` to also surface `rows.length`
  directly in its return value for exactly this kind of caller.
- Everything else in `tally-agent/README.md`'s own "What is NOT done yet"
  section (ERP 9 real-hardware confirmation, sign convention on non-zero
  closing balances, UTF-16 handling, offline queue, single-company-per-install)
  applies unchanged here too, since none of that logic was touched.

---

## File map

```
tally-agent-gui/
├── package.json        # electron + electron-builder, NSIS build config (starting point)
├── agent-lib.js         # resolves & requires ../tally-agent/{agent,config,cloud,tallyClient}.js
├── main.js              # Electron main process: tray, window, IPC, sync-loop timer
├── preload.js            # contextBridge — safe, minimal API surface for the renderer
├── renderer/
│   ├── index.html        # pairing view / paired-dashboard view / settings view
│   ├── style.css          # Margyn light-theme tokens (off-white canvas, emerald primary)
│   └── renderer.js         # plain JS, talks only to window.margyn
└── assets/
    ├── tray-icon.png       # PLACEHOLDER — flat emerald square, replace with real mark
    ├── tray-icon@2x.png    # PLACEHOLDER
    └── app-icon.png        # PLACEHOLDER
```
