const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

let window;
let server;
let quitting = false;
app.setName('Gantry Harness');
if (process.env.GANTRY_DESKTOP_HOME) app.setPath('userData', path.join(process.env.GANTRY_DESKTOP_HOME, 'desktop'));

// Finder and desktop launchers do not inherit the user's interactive PATH.
if (process.platform !== 'win32' && !process.env.GANTRY_DESKTOP_SMOKE) {
  try {
    const loginPath = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (loginPath) process.env.PATH = loginPath;
  } catch { /* Keep inherited PATH when the login shell is unavailable. */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });

  app.whenReady().then(async () => {
    const { createHarnessServer } = await import(pathToFileURL(path.join(__dirname, '../dist/server/app.js')).href);
    server = await createHarnessServer({
      port: 0,
      host: '127.0.0.1',
      gantryHome: process.env.GANTRY_DESKTOP_HOME || path.join(os.homedir(), '.gantry'),
      clientDistDir: path.join(__dirname, '../dist/client'),
    });
    const url = `http://127.0.0.1:${server.port}`;
    ipcMain.handle('gantry:choose-directory', async (event) => {
      if (event.sender !== window?.webContents) throw new Error('Unknown window');
      const result = await dialog.showOpenDialog(window, { title: 'Abrir projeto', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    window = new BrowserWindow({
      title: 'Gantry Harness', width: 1320, height: 860, minWidth: 390, minHeight: 480,
      backgroundColor: '#171715', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' }, { role: 'editMenu' },
      { label: 'Visualizar', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== url) event.preventDefault();
    });
    window.once('ready-to-show', () => {
      window.show();
      if (process.env.GANTRY_DESKTOP_SMOKE) {
        console.log(`GANTRY_DESKTOP_READY ${url}`);
        app.quit();
      }
    });
    await window.loadURL(url);
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Gantry Harness', `Não foi possível iniciar o aplicativo.\n${error.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    void server.close().finally(() => app.quit());
  });
}
