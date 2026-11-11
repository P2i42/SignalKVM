const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalKvm', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  readMonitor: () => ipcRenderer.invoke('ddc:read'),
  setInput: (source) => ipcRenderer.invoke('ddc:set', source),
  toggleNow: (selection) => ipcRenderer.invoke('ddc:toggle-now', selection),
  refreshMonitors: () => ipcRenderer.invoke('monitors:refresh'),
  selectMonitor: (monitorId) => ipcRenderer.invoke('monitors:select', monitorId),
  scanMonitor: (monitorId) => ipcRenderer.invoke('monitors:scan', monitorId),
  checkHotkey: (accelerator) => ipcRenderer.invoke('hotkey:check', accelerator),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  onConfig: (callback) => ipcRenderer.on('config', (_event, config) => callback(config)),
  onStatus: (callback) => ipcRenderer.on('status', (_event, status) => callback(status))
});
