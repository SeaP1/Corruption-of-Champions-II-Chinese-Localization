const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require('path');

let win;

function createWindow()
{
    win = new BrowserWindow({
        width: 1920,
        minWidth: 640,
        height: 1200,
        minHeight: 360,
        frame: true,
        closable: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, '/preload.js')
        }
    });
    
    win.setIcon(path.join(__dirname, '/resources/bitmaps/icons/mstile-310x310.png'));
    win.loadURL(`file://${__dirname}/index.html`);
    
    win.on('maximize', () => win?.webContents.send('window-maximized'));
    win.on('unmaximize', () => win?.webContents.send('window-unmaximized'));
    
    win.on("close", () => {
        win = null;
        app.exit(0);
    });
}

async function handleFileOpen () {
    const { canceled, filePaths } = await dialog.showOpenDialog();
    if (!canceled) {
        return filePaths[0];
    }
}

app.whenReady().then(() => {
    ipcMain.on('exit', () => app.exit(0));
    ipcMain.on('dialog:openFile', handleFileOpen);
    ipcMain.on('fullscreen', () => BrowserWindow.getFocusedWindow()?.setFullScreen(true));
    ipcMain.on('unfullscreen', () => BrowserWindow.getFocusedWindow()?.setFullScreen(false));
    ipcMain.on('isFullscreen', (event) => event.returnValue = BrowserWindow.getFocusedWindow()?.isFullScreen());
    
    createWindow();
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== 'darwin') app.quit();
});