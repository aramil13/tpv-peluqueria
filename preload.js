const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendWhatsApp: (phone, text) => ipcRenderer.invoke('send-whatsapp', { phone, text })
});
