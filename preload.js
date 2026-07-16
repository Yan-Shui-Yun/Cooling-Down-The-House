const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    sendCoords: (coordsData) => ipcRenderer.send('write-memory', coordsData),
    onReceiveCoords: (callback) => ipcRenderer.on('sync-memory', (event, data) => callback(data)),
    openHelp: () => ipcRenderer.send("open-help"),
    setAlwaysOnTop: (value) => ipcRenderer.send("set-always-on-top", value),
    openUrl: (url) => ipcRenderer.send('open-external-url', url),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
    toggleBatchMode: (isEnabled) => ipcRenderer.send('toggle-batch-mode', isEnabled),
    recordAnchorPre: () => ipcRenderer.send('record-anchor-pre'),
    recordAnchorPost: () => ipcRenderer.send('record-anchor-post'),
    onAnchorUpdated: (callback) => ipcRenderer.on('anchor-updated', (event, data) => callback(data)),
    setCoordinateMode: (isLocal) => ipcRenderer.send('set-coord-mode', isLocal),
    nudge: (axis, amount) => ipcRenderer.send('nudge-furniture', { axis, amount }),
    resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
    sendHackToggle: (isEnable) => ipcRenderer.send('toggle-hack', isEnable)
});