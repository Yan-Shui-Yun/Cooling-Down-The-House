const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    sendCoords: (coordsData) => ipcRenderer.send('write-memory', coordsData),
    onReceiveCoords: (callback) => ipcRenderer.on('sync-memory', (event, data) => callback(data)),
    openHelp: () => ipcRenderer.send("open-help"),
    setAlwaysOnTop: (value) => ipcRenderer.send("set-always-on-top", value),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data))
});