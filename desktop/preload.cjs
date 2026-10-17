const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gantryDesktop', {
  platform: process.platform,
  chooseDirectory: () => ipcRenderer.invoke('gantry:choose-directory'),
});
