const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

let mainWindow;
let syncHelperProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    title: "TPV Agenda Peluquería",
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('electron-app.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

function ensureSyncEnv() {
  const userDataPath = app.getPath('userData');
  if (!process.env.SYNC_FILE) process.env.SYNC_FILE = path.join(userDataPath, 'appointments.json');
  if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(userDataPath, 'sync');
}

function startSyncHelper() {
  ensureSyncEnv();
  if (process.env.NO_LOCAL_SYNC === 'true' || process.env.NO_LOCAL_SYNC === '1') return;
  syncHelperProcess = fork(path.join(__dirname, 'sync-helper.js'), [], {
    env: { ...process.env, SYNC_FILE: process.env.SYNC_FILE, NO_LOCAL_SYNC: undefined }
  });
  syncHelperProcess.on('error', e => console.error('sync-helper error:', e));
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    ensureSyncEnv();
    startSyncHelper();
    createWindow();
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    if (syncHelperProcess) syncHelperProcess.kill();
    app.quit();
  }
});

app.on('activate', function () { if (mainWindow === null) createWindow(); });