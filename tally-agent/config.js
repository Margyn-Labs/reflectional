/**
 * config.js — where the agent keeps its install key and settings.
 *
 * Location (first that applies):
 *   Windows : %APPDATA%\Margyn\tally-agent.json
 *   macOS   : ~/Library/Application Support/Margyn/tally-agent.json
 *   Linux   : $XDG_CONFIG_HOME/margyn/tally-agent.json  or  ~/.config/margyn/tally-agent.json
 *
 * The install key is a real credential. On write we best-effort lock the file
 * down to the current user (chmod 600 on POSIX; icacls on Windows). This is a
 * prototype — a production build would use the OS credential store (Windows
 * Credential Manager / DPAPI).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function configDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Margyn');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Margyn');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'margyn');
}

const CONFIG_PATH = path.join(configDir(), 'tally-agent.json');

function currentFinancialYear() {
  const now = new Date();
  const y = now.getFullYear();
  // Indian FY starts 1 April.
  const startYear = now.getMonth() >= 3 ? y : y - 1;
  return {
    from: `${startYear}0401`,
    to: `${startYear + 1}0331`
  };
}

function load() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    file = {};
  }

  const fy = currentFinancialYear();

  return {
    path: CONFIG_PATH,
    apiBase: (process.env.MARGYN_API_BASE || file.apiBase || 'https://www.margynlabs.com').replace(/\/+$/, ''),
    tallyHost: process.env.TALLY_HOST || file.tallyHost || '127.0.0.1',
    tallyPort: parseInt(process.env.TALLY_PORT || file.tallyPort || '9000', 10),
    company: process.env.TALLY_COMPANY || file.company || '',
    fromDate: process.env.TALLY_FROM_DATE || file.fromDate || fy.from,
    // True only when someone pinned a start date; otherwise the agent reads the period from Tally itself.
    fromDateExplicit: !!(process.env.TALLY_FROM_DATE || file.fromDate),
    toDate: process.env.TALLY_TO_DATE || file.toDate || fy.to,
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || file.intervalMinutes || '15', 10),
    installId: file.installId || null,
    installKey: file.installKey || null,
    companyGuid: file.companyGuid || null,
    tallyProduct: file.tallyProduct || null,
    tallyVersion: file.tallyVersion || null,
    // Voucher sync memory: which request shape this Tally answers, AlterID high-water mark, backfill progress.
    syncState: file.syncState && typeof file.syncState === 'object' ? file.syncState : {}
  };
}

function save(patch) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* new file */ }

  const next = { ...existing, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });

  // Best-effort lock-down; never fatal.
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [CONFIG_PATH, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' });
    } else {
      fs.chmodSync(CONFIG_PATH, 0o600);
    }
  } catch (e) { /* ignore */ }

  return next;
}

module.exports = { load, save, CONFIG_PATH, currentFinancialYear };
