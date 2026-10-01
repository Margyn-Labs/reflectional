# Releasing a new Tally agent

Installed agents (0.2.0 and later) check
`https://pub-432244bb0d9047989ffc94163a2fea75.r2.dev/tally-agent/latest.yml` every 6 hours,
download a newer build, and install it silently between syncs. Nobody touches the client's PC.

1. Bump `version` in `tally-agent-gui/package.json` (and `tally-agent/package.json`, which the
   agent reports to Margyn).
2. Test: `cd tally-agent && node sync.e2e.test.js && node inventory.test.js`
3. Build (works on macOS; electron-builder brings its own Wine):
   `cd tally-agent-gui && npm install && npx electron-builder --win nsis --x64 --publish never`
4. Upload from `tally-agent-gui/dist/` to R2 bucket `margyn-downloads`, folder `tally-agent/`:
   - `Margyn-Tally-Agent-Setup-<version>.exe` and its `.blockmap`
   - a copy of the exe named `Margyn-Tally-Agent-Setup.exe` (the stable link in the app)
   - `latest.yml` LAST (uploading it is what tells installed agents to update)

Never upload a `latest.yml` whose exe isn't already in the folder.
