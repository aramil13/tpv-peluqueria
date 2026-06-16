const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendWhatsApp: (phone, text) => ipcRenderer.invoke('send-whatsapp', { phone, text }),
  getBridgeStatus: () => ipcRenderer.invoke('get-bridge-status'),
  setGitHubToken: (key) => ipcRenderer.invoke('set-github-token', key),
  startBridge: () => ipcRenderer.invoke('start-bridge'),
  stopBridge: () => ipcRenderer.invoke('stop-bridge'),
  onBridgeStatus: (cb) => { ipcRenderer.on('bridge-status', (_, data) => cb(data)); },
  onBridgeQr: (cb) => { ipcRenderer.on('bridge-qr', (_, data) => cb(data)); },
  getFlyBridgeUrl: () => ipcRenderer.invoke('get-fly-bridge-url')
});
