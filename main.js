const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { fork } = require('child_process');
const { readData, writeData } = require('./lib/kv-data');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const FLY_BRIDGE_URL = process.env.FLY_BRIDGE_URL || '';

let mainWindow;
let syncHelperProcess;
let waBridge = null;

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

function getGitHubTokenFromSettings() {
  try {
    const data = readData();
    return (data && data.settings && data.settings.githubToken) || '';
  } catch { return ''; }
}

function startBridge() {
  if (waBridge) { waBridge.stop(); waBridge = null; }

  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const authDir = path.join(exeDir, 'wa_auth');
  try { fs.mkdirSync(authDir, { recursive: true }); } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('bridge-status', { connected: false, state: 'error', error: 'No se pudo crear wa_auth: ' + e.message });
    return;
  }

  const key = getGitHubTokenFromSettings() || process.env.GITHUB_TOKEN || '';
  if (key) process.env.GITHUB_TOKEN = key;

  try {
    const { createBridge } = require('./lib/wa-bridge-core');
    waBridge = createBridge({
      authDir,
      onQr: (qrDataUrl) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('bridge-qr', qrDataUrl);
      },
      onConnection: (status) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('bridge-status', status);
      },
      onError: (msg) => {
        console.error('[BRIDGE]', msg);
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('bridge-status', { connected: false, state: 'error', error: msg });
      }
    });
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('bridge-status', { connected: false, state: 'error', error: 'Error al iniciar bridge: ' + e.message });
  }
}

function stopBridge(deleteAuth) {
  if (waBridge) { waBridge.stop(); waBridge = null; }
  if (deleteAuth) {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const authDir = path.join(exeDir, 'wa_auth');
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  }
}

ipcMain.handle('send-whatsapp', async (event, { phone, text }) => {
  if (waBridge) {
    try {
      const r = await waBridge.sendMessage(phone, text);
      if (r.sent) return r;
    } catch {}
  }
  if (FLY_BRIDGE_URL) {
    try {
      const data = JSON.stringify({ phone, text });
      return await new Promise((resolve) => {
        const req = https.request(FLY_BRIDGE_URL.replace(/\/+$/, '') + '/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 10000
        }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ sent: false }); } }); });
        req.on('error', () => resolve({ sent: false, error: 'Fly bridge no responde' }));
        req.write(data); req.end();
      });
    } catch {}
  }
  return { sent: false, error: 'Bridge no disponible' };
});

ipcMain.handle('get-fly-bridge-url', async () => FLY_BRIDGE_URL);

ipcMain.handle('get-bridge-status', () => {
  if (waBridge) return waBridge.getStatus();
  return { connected: false, state: 'stopped', phone: '' };
});

ipcMain.handle('set-github-token', async (event, key) => {
  const data = readData();
  if (!data.settings) data.settings = {};
  data.settings.githubToken = key;
  writeData(data);
  if (key) { process.env.GITHUB_TOKEN = key; startBridge(); }
  else { delete process.env.GITHUB_TOKEN; stopBridge(); }
  return { ok: true };
});

ipcMain.handle('start-bridge', async () => { startBridge(); return { ok: true }; });
ipcMain.handle('stop-bridge', async () => { stopBridge(true); return { ok: true }; });

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
    const key = getGitHubTokenFromSettings() || process.env.GITHUB_TOKEN;
    if (key) { process.env.GITHUB_TOKEN = key; startBridge(); }
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    stopBridge();
    if (syncHelperProcess) syncHelperProcess.kill();
    app.quit();
  }
});

app.on('activate', function () { if (mainWindow === null) createWindow(); });