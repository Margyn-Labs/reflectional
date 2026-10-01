/**
 * renderer.js — plain browser JS, no Node integration (contextIsolation).
 * Talks to main.js only through window.margyn (see preload.js).
 */

const viewPair = document.getElementById('view-pair');
const viewPaired = document.getElementById('view-paired');
const viewSettings = document.getElementById('view-settings');

let previousView = 'pair'; // where "Back" returns to

function showView(name) {
  viewPair.classList.add('hidden');
  viewPaired.classList.add('hidden');
  viewSettings.classList.add('hidden');
  if (name === 'pair') viewPair.classList.remove('hidden');
  if (name === 'paired') viewPaired.classList.remove('hidden');
  if (name === 'settings') viewSettings.classList.remove('hidden');
}

function fmtTime(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderLogs(logs) {
  const area = document.getElementById('log-area');
  area.innerHTML = logs.map((l) => {
    const t = new Date(l.ts).toLocaleTimeString();
    return `<div class="log-line"><span class="log-time">${t}</span>  ${escapeHtml(l.msg)}</div>`;
  }).join('');
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function applyState(state) {
  if (!state) return;

  // Keep settings inputs in sync whenever we're not actively editing them.
  document.getElementById('input-apibase').value = state.apiBase || '';
  document.getElementById('input-tallyhost').value = state.tallyHost || '';
  document.getElementById('input-tallyport').value = state.tallyPort || '';
  document.getElementById('input-interval').value = state.intervalMinutes || '';

  if (!state.paired) {
    previousView = 'pair';
    if (viewSettings.classList.contains('hidden') === false) {
      // stay on settings if user is mid-edit there
    } else {
      showView('pair');
    }
    return;
  }

  previousView = 'paired';
  document.getElementById('kv-company').textContent = state.company || '—';
  document.getElementById('kv-last-sync').textContent = fmtTime(state.lastSyncAt);
  document.getElementById('kv-ledger-count').textContent =
    state.lastSyncCount == null ? '—' : String(state.lastSyncCount);

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const syncBtn = document.getElementById('btn-sync-now');
  const syncErr = document.getElementById('sync-error');

  if (state.syncing) {
    statusDot.className = 'dot dot-ok';
    statusText.textContent = 'Syncing…';
    syncBtn.disabled = true;
  } else if (state.lastSyncError) {
    statusDot.className = 'dot dot-warn';
    statusText.textContent = 'Sync issue';
    syncBtn.disabled = false;
    syncErr.textContent = state.lastSyncError;
    syncErr.classList.remove('hidden');
  } else {
    statusDot.className = 'dot dot-ok';
    statusText.textContent = 'Connected';
    syncBtn.disabled = false;
    syncErr.classList.add('hidden');
  }

  renderLogs(state.logs || []);

  if (viewSettings.classList.contains('hidden')) {
    showView('paired');
  }
}

/* ---------------- pairing ---------------- */
document.getElementById('btn-connect').addEventListener('click', async () => {
  const code = document.getElementById('input-code').value.trim();
  const company = document.getElementById('input-company').value.trim();
  const errEl = document.getElementById('pair-error');
  errEl.classList.add('hidden');

  if (!code || !company) {
    errEl.textContent = 'Enter both the pairing code and the company name.';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const result = await window.margyn.pair(code, company);
    if (!result.ok) {
      errEl.textContent = result.error || 'Pairing failed.';
      errEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

/* ---------------- sync now ---------------- */
document.getElementById('btn-sync-now').addEventListener('click', async () => {
  await window.margyn.syncNow();
});

/* ---------------- settings ---------------- */
document.getElementById('btn-show-settings-1').addEventListener('click', () => showView('settings'));
document.getElementById('btn-show-settings-2').addEventListener('click', () => showView('settings'));
document.getElementById('btn-back').addEventListener('click', async () => {
  const state = await window.margyn.getState();
  showView(state.paired ? 'paired' : 'pair');
});

document.getElementById('btn-test-connection').addEventListener('click', async () => {
  const resultEl = document.getElementById('test-connection-result');
  const btn = document.getElementById('btn-test-connection');
  const tallyHost = document.getElementById('input-tallyhost').value.trim();
  const tallyPort = parseInt(document.getElementById('input-tallyport').value, 10);

  resultEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  try {
    const result = await window.margyn.testConnection({ tallyHost, tallyPort });
    resultEl.classList.remove('hidden', 'success', 'error');
    if (result.reachable) {
      resultEl.classList.add('success');
      resultEl.textContent = `Port ${tallyPort} on ${tallyHost} is open. Click Sync now to confirm Tally answers and a company is loaded.`;
    } else {
      resultEl.classList.add('error');
      resultEl.textContent = `Port ${tallyPort} on ${tallyHost} is closed (${result.code || result.reason}). Enable Tally's HTTP server on this port with a company loaded, then test again.`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test connection';
  }
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const patch = {
    apiBase: document.getElementById('input-apibase').value,
    tallyHost: document.getElementById('input-tallyhost').value,
    tallyPort: document.getElementById('input-tallyport').value,
    intervalMinutes: document.getElementById('input-interval').value
  };
  const state = await window.margyn.saveSettings(patch);
  showView(state.paired ? 'paired' : 'pair');
});

/* ---------------- live updates ---------------- */
window.margyn.onState(applyState);
window.margyn.onLog((entry) => {
  // Full state re-push already carries recent logs; this just makes single
  // new lines appear immediately without waiting for the next state push.
  const area = document.getElementById('log-area');
  if (!area) return;
  const t = new Date(entry.ts).toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-time">${t}</span>  ${escapeHtml(entry.msg)}`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
});

/* ---------------- initial load ---------------- */
(async () => {
  const state = await window.margyn.getState();
  applyState(state);
})();
