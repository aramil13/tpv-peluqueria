const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
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
  let syncDir;
  if (app.isPackaged) {
    // Empaquetado: usar userData (escribible). Dentro de app.asar no se puede escribir.
    syncDir = path.join(app.getPath('userData'), 'sync');
  } else {
    // Desarrollo: carpeta sync del proyecto (compartida con el sync-helper independiente).
    syncDir = path.join(__dirname, 'sync');
  }
  if (!process.env.SYNC_FILE) process.env.SYNC_FILE = path.join(syncDir, 'appointments.json');
  if (!process.env.DATA_DIR) process.env.DATA_DIR = syncDir;
}

function resolveScript(name) {
  if (app.isPackaged) {
    // Empaquetado: los scripts se extraen (asarUnpack) a resources\app.asar.unpacked\scripts.
    // PowerShell NO puede leer dentro de app.asar, asi que hay que apuntar a la copia real en disco.
    const unpacked = path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'scripts', name);
    if (fs.existsSync(unpacked)) return unpacked;
    const destDir = path.join(app.getPath('userData'), 'scripts');
    const dest = path.join(destDir, name);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'scripts', name), dest);
    }
    return dest;
  }
  return path.join(__dirname, 'scripts', name);
}

function reactivatePastAppointments() {
  const scriptPath = resolveScript('reactivate-past-appointments.ps1');
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
      env: {
        ...process.env,
        SYNC_FILE: process.env.SYNC_FILE,
        DATA_DIR: process.env.DATA_DIR,
        NO_LOCAL_SYNC: undefined,
        ACCESS_SYNC_SCRIPT: resolveScript('access-sync.ps1')
      }
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