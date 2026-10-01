/**
 * preload.js — the only bridge between the renderer (plain HTML/JS, no
 * Node integration) and the main process. Exposes a small, explicit API;
 * the renderer can never require() agent-lib or touch the filesystem
 * directly, and never sees the install key or pairing code echoed back.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('margyn', {
  getState: () => ipcRenderer.invoke('margyn:get-state'),
  pair: (code, company) => ipcRenderer.invoke('margyn:pair', { code, company }),
  syncNow: () => ipcRenderer.invoke('margyn:sync-now'),
  testConnection: (override) => ipcRenderer.invoke('margyn:test-connection', override),
  saveSettings: (patch) => ipcRenderer.invoke('margyn:save-settings', patch),
  onLog: (callback) => ipcRenderer.on('margyn:log', (_evt, entry) => callback(entry)),
  onState: (callback) => ipcRenderer.on('margyn:state', (_evt, state) => callback(state))
});
