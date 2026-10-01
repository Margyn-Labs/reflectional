/**
 * main.js — Electron main process.
 *
 * Owns: tray icon, the small popup window, the background sync-loop timer,
 * and the IPC bridge to the renderer. Contains NO Tally-XML logic, no
 * pairing/cloud-auth logic of its own — all of that is required from
 * ../tally-agent/ via agent-lib.js and called as-is.
 *
 * Never sends the raw install key or pairing code to the renderer or to
 * console — only descriptive status strings.
 */

const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const { agent, config, tally } = require('./agent-lib');

// Self-update: installed agents fetch newer builds from Margyn's download bucket (see build.publish
// in package.json) and install them silently between syncs, so a fix never needs a visit to the
// client's machine. Optional at runtime: a missing module only disables updating.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { autoUpdater = null; }

let mainWindow = null;
let tray = null;
let syncTimer = null;

/* ------------------------------------------------------------------ */
/* Single instance — double-clicking the app again just focuses the    */
/* window that's already running instead of starting a second copy.    */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const MAX_LOG_LINES = 200;
const logBuffer = []; // { ts: number, msg: string }

const runtimeState = {
  syncing: false,
  lastSyncAt: null,      // epoch ms
  lastSyncCount: null,   // number of ledgers on the last successful sync
  lastSyncError: null    // string or null
};

function addLog(msg) {
  const entry = { ts: Date.now(), msg: String(msg) };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('margyn:log', entry);
  }
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('margyn:state', getDisplayState());
  }
}

/** Builds the state object sent to the renderer. Never includes installKey. */
function getDisplayState() {
  const cfg = config.load();
  return {
    paired: !!cfg.installKey,
    company: cfg.company || '',
    apiBase: cfg.apiBase,
    tallyHost: cfg.tallyHost,
    tallyPort: cfg.tallyPort,
    intervalMinutes: cfg.intervalMinutes,
    tallyProduct: cfg.tallyProduct,
    tallyVersion: cfg.tallyVersion,
    syncing: runtimeState.syncing,
    lastSyncAt: runtimeState.lastSyncAt,
    lastSyncCount: runtimeState.lastSyncCount,
    lastSyncError: runtimeState.lastSyncError,
    logs: logBuffer.slice(-50)
  };
}

/* ------------------------------------------------------------------ */
/* Sync loop — mirrors agent.js's `run` command (tick now, then every  */
/* intervalMinutes), reusing agent.runLedgerSync() as-is.              */
/* ------------------------------------------------------------------ */
async function doSync() {
  if (runtimeState.syncing) return; // don't overlap
  const cfg = config.load();
  if (!cfg.installKey) {
    addLog('Skipped sync — not paired yet.');
    return;
  }
  runtimeState.syncing = true;
  broadcastState();
  addLog(`Syncing from Tally at ${cfg.tallyHost}:${cfg.tallyPort} …`);
  try {
    // runFullSync does ledgers (hard) + vouchers + bills (soft-fail, logged
    // via config.load()'s own console — the GUI's log area shows the summary).
    const result = await agent.runFullSync(cfg, { dryRun: false });
    const led = result && result.ledgers;
    const count = (led && (led.received ?? led.upserted)) ?? null;
    runtimeState.lastSyncAt = Date.now();
    runtimeState.lastSyncCount = count;
    runtimeState.lastSyncError = null;
    const v = result && result.vouchers;
    const vtxt = !v ? 'no vouchers'
      : v.error ? 'vouchers skipped'
      : v.mode === 'unchanged' ? 'vouchers up to date'
      : `${v.received} vouchers`;
    addLog(`Sync complete — ${count == null ? '?' : count} ledgers, ${vtxt}.`);
  } catch (e) {
    runtimeState.lastSyncError = e.message;
    if (e.code === 'unauthorized') {
      addLog(`Sync failed — cloud rejected the install key. Re-pair from this window.`);
    } else {
      addLog(`Sync failed: ${e.message}`);
    }
  } finally {
    runtimeState.syncing = false;
    broadcastState();
  }
}

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  const cfg = config.load();
  if (!cfg.installKey) return; // nothing to loop until paired
  const everyMs = Math.max(1, cfg.intervalMinutes) * 60 * 1000;
  addLog(`Background sync loop started — every ${cfg.intervalMinutes} min.`);
  doSync(); // tick now, same as agent.js `run`
  syncTimer = setInterval(doSync, everyMs);
}

function stopSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/* ------------------------------------------------------------------ */
/* Window / tray                                                       */
/* ------------------------------------------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    frame: false, // small popup, not full app chrome
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  // Never actually destroy on close (there's no close button in this minimal
  // chrome anyway) — hide instead, tray keeps the process alive.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWindowNearTray() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  let y = process.platform === 'darwin'
    ? Math.round(trayBounds.y + trayBounds.height)
    : Math.round(trayBounds.y - windowBounds.height); // Windows taskbar tray is usually bottom-right

  // Clamp inside the display's work area so the window never opens off-screen.
  const wa = display.workArea;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - windowBounds.width);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - windowBounds.height);

  mainWindow.setPosition(x, y, false);
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip('Margyn Tally Agent');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Margyn Tally Agent', click: toggleWindowNearTray },
    { label: 'Sync now', click: () => doSync() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  // Left-click toggles the window (matches the task's "clicking the tray
  // icon opens a small window" requirement); right-click shows the menu
  // (standard tray convention on Windows, handled automatically by Electron
  // when both `click` and `on('right-click')` aren't both bound to setContextMenu).
  tray.on('click', toggleWindowNearTray);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

/* ------------------------------------------------------------------ */
/* IPC — the only surface the renderer touches. Renderer never requires */
/* agent-lib itself (contextIsolation + no nodeIntegration).            */
/* ------------------------------------------------------------------ */
ipcMain.handle('margyn:get-state', () => getDisplayState());

ipcMain.handle('margyn:pair', async (_evt, { code, company }) => {
  const cfg = config.load();
  try {
    const out = await agent.performPair({ code, company, cfg, onLog: addLog });
    startSyncLoop();
    broadcastState();
    return { ok: true, company: out.company_name || company };
  } catch (e) {
    addLog(`Pairing failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('margyn:sync-now', async () => {
  await doSync();
  return getDisplayState();
});

// Fast (~3s) reachability probe — separate from Sync now's up-to-30s XML
// round-trip, for quick iteration while changing Tally's settings on-site.
ipcMain.handle('margyn:test-connection', async (_evt, override) => {
  const cfg = config.load();
  const host = (override && override.tallyHost) || cfg.tallyHost;
  const port = (override && override.tallyPort) || cfg.tallyPort;
  const result = await tally.testConnection({ host, port, timeoutMs: 3000 });
  if (result.reachable) {
    addLog(`Test connection — port ${port} on ${host} is OPEN. (This confirms something is listening; click Sync now to confirm it's actually Tally and a company is loaded.)`);
  } else {
    addLog(`Test connection — port ${port} on ${host} is CLOSED (${result.code || result.reason}). Enable Tally's HTTP server on this port and load a company, then test again.`);
  }
  return result;
});

ipcMain.handle('margyn:save-settings', (_evt, patch) => {
  const clean = {};
  if (typeof patch.apiBase === 'string' && patch.apiBase.trim()) clean.apiBase = patch.apiBase.trim().replace(/\/+$/, '');
  if (typeof patch.tallyHost === 'string' && patch.tallyHost.trim()) clean.tallyHost = patch.tallyHost.trim();
  if (patch.tallyPort) clean.tallyPort = parseInt(patch.tallyPort, 10);
  if (patch.intervalMinutes) clean.intervalMinutes = parseInt(patch.intervalMinutes, 10);
  config.save(clean);
  addLog('Settings saved.');
  startSyncLoop(); // re-read new interval / restart with new values
  broadcastState();
  return getDisplayState();
});

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */
/* Start automatically when Windows starts — this is a background sync tool,
 * the user shouldn't have to remember to launch it. Skipped in dev (`npm
 * start`) so it doesn't register the dev binary as a login item. */
function configureAutoStart() {
  if (!app.isPackaged) return;
  try {
    const cfg = config.load();
    const wanted = cfg.autoStart !== false; // default on
    app.setLoginItemSettings({ openAtLogin: wanted, path: process.execPath, args: ['--hidden'] });
  } catch (e) { /* non-fatal */ }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  configureAutoStart();
  if (agent.setLogger) agent.setLogger(addLog); // agent's step-by-step lines land in Recent Activity
  addLog(`Margyn Tally Agent ${app.getVersion()} started.`);
  setupAutoUpdate();

  // On a fresh install (not paired yet) or a normal manual launch, show the
  // window so the user sees the pairing screen. When Windows auto-launches it
  // at login (`--hidden`), stay in the tray silently.
  const launchedHidden = process.argv.includes('--hidden');
  const cfg = config.load();
  if (!launchedHidden || !cfg.installKey) {
    toggleWindowNearTray();
  }

  startSyncLoop(); // no-op if not paired yet
});

function setupAutoUpdate() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    addLog(`Update ${info.version} downloaded. Installing it now; the agent restarts in a few seconds.`);
    const install = () => {
      if (runtimeState.syncing) { setTimeout(install, 30000); return; } // never cut a sync in half
      app.isQuitting = true;
      autoUpdater.quitAndInstall(true, true); // silent, relaunch after install
    };
    setTimeout(install, 5000);
  });
  autoUpdater.on('error', (e) => addLog(`Update check skipped (${String(e && e.message || e).slice(0, 120)}).`));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 60 * 1000);
  setInterval(check, 6 * 3600 * 1000);
}

app.on('window-all-closed', () => {
  // Tray app — do not quit when the window closes/hides. Windows and macOS
  // both keep running via the tray; this only matters on macOS by default,
  // but we override the same way everywhere for consistency during dev.
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
