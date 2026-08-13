const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork, execFile } = require('child_process');

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
  // Use the fixed sync directory (same file used by iniciar-sync-helper.bat and PowerShell scripts)
  const syncDir = path.join(__dirname, 'sync');
  if (!process.env.SYNC_FILE) process.env.SYNC_FILE = path.join(syncDir, 'appointments.json');
  if (!process.env.DATA_DIR) process.env.DATA_DIR = syncDir;
}

function reactivatePastAppointments() {
  const scriptPath = path.join(__dirname, 'scripts', 'reactivate-past-appointments.ps1');
  execFile('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', scriptPath
  ], { timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      console.error('[ReactivarCitas] Error:', error.message, stderr || '');
      return;
    }
    console.log('[ReactivarCitas]', (stdout || '').trim());
  });
}

function startSyncHelper() {
  ensureSyncEnv();
  if (process.env.NO_LOCAL_SYNC === 'true' || process.env.NO_LOCAL_SYNC === '1') return;
  const spawnHelper = () => {
    syncHelperProcess = fork(path.join(__dirname, 'sync-helper.js'), [], {
      env: { ...process.env, SYNC_FILE: process.env.SYNC_FILE, DATA_DIR: process.env.DATA_DIR, NO_LOCAL_SYNC: undefined }
    });
    syncHelperProcess.on('error', e => console.error('sync-helper error:', e));
    syncHelperProcess.on('exit', (code, signal) => {
      if (code !== 0 && !app.isQuitting) {
        console.warn(`sync-helper exited (code=${code}, signal=${signal}), restarting in 5s...`);
        setTimeout(spawnHelper, 5000);
      }
    });
  };
  spawnHelper();
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
    reactivatePastAppointments();
    startSyncHelper();
    createWindow();
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    if (syncHelperProcess) syncHelperProcess.kill();
    app.quit();
  }
});

app.on('activate', function () { if (mainWindow === null) createWindow(); });