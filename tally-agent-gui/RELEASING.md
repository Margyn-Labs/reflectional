# Releasing a new Tally agent

Installed agents (0.2.0 and later) check
`https://pub-432244bb0d9047989ffc94163a2fea75.r2.dev/tally-agent/latest.yml` every 6 hours,
download a newer build, and install it silently between syncs. Nobody touches the client's PC.

1. Bump `version` in `tally-agent-gui/package.json` (and `tally-agent/package.json`, which the
   agent reports to Margyn).
2. Test: `cd tally-agent && node sync.e2e.test.js && node inventory.test.js`
3. Build (works on macOS; electron-builder brings its own Wine):
   `cd tally-agent-gui && npm install && npx electron-builder --win nsis --x64 --publish never`
4. In `dist/`: rename the exe to `Margyn-Tally-Agent-Setup.exe`, and in `latest.yml` replace
   `Margyn-Tally-Agent-Setup-<version>.exe` with `Margyn-Tally-Agent-Setup.exe` (same file, so the
   sha512 stays valid). Upload to R2 bucket `margyn-downloads`, folder `tally-agent/`, replacing the old ones:
   - `Margyn-Tally-Agent-Setup.exe` (the app's download link; new users)
   - `latest.yml` LAST (installed agents read it and update themselves)

Never upload a `latest.yml` whose exe isn't already in the folder.
