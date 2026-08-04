const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    exit: () => ipcRenderer.send('exit'),
    openFile: () => ipcRenderer.send('dialog:openFile'),
    fullscreen: () => ipcRenderer.send('fullscreen'),
    unfullscreen: () => ipcRenderer.send('unfullscreen'),
    isFullscreen: () => !!ipcRenderer.sendSync('isFullscreen'),
    
    isSteam: () => false,
});