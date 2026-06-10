const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { fork } = require('child_process');
const { readData, writeData } = require('./lib/kv-data');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const RENDER_BRIDGE_URL = process.env.RENDER_BRIDGE_URL || 'https://tpv-peluqueria-bridge-whatsapp.onrender.com';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'tpv-secret-2026';

function renderFetch(endpoint, method = 'POST') {
  return new Promise(resolve => {
    const url = new URL(endpoint, RENDER_BRIDGE_URL);
    const data = JSON.stringify({ key: BRIDGE_API_KEY });
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000
    };
    const req = https.request(opts, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({ok:res.statusCode<400})); });
    req.on('error', () => resolve({ok:false}));
    req.write(data);
    req.end();
  });
}

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

function getDeepSeekKeyFromSettings() {
  try {
    const data = readData();
    return (data && data.settings && data.settings.deepseekApiKey) || '';
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

  const key = getDeepSeekKeyFromSettings() || process.env.DEEPSEEK_API_KEY || '';
  if (key) process.env.DEEPSEEK_API_KEY = key;

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
    try { return await waBridge.sendMessage(phone, text); } catch (e) { return { sent: false, error: e.message }; }
  }
  return new Promise(resolve => {
    const data = JSON.stringify({ phone, text });
    const req = http.request('http://localhost:3457/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ sent: false, error: body }); } });
    });
    req.on('error', e => resolve({ sent: false, error: e.message }));
    req.write(data); req.end();
  });
});

ipcMain.handle('get-bridge-status', () => {
  if (waBridge) return waBridge.getStatus();
  return { connected: false, state: 'stopped', phone: '' };
});

ipcMain.handle('set-deepseek-key', async (event, key) => {
  const data = readData();
  if (!data.settings) data.settings = {};
  data.settings.deepseekApiKey = key;
  writeData(data);
  if (key) { process.env.DEEPSEEK_API_KEY = key; startBridge(); }
  else { delete process.env.DEEPSEEK_API_KEY; stopBridge(); }
  return { ok: true };
});

ipcMain.handle('start-bridge', async () => { startBridge(); return { ok: true }; });
ipcMain.handle('stop-bridge', async () => { stopBridge(true); return { ok: true }; });

app.on('ready', () => {
  ensureSyncEnv();
  startSyncHelper();
  createWindow();
  const key = getDeepSeekKeyFromSettings() || process.env.DEEPSEEK_API_KEY;
  if (key) { process.env.DEEPSEEK_API_KEY = key; startBridge(); }
  // Desactivar bridge de Render al arrancar el EXE
  renderFetch('/disable').then(r => console.log('[RENDER] Bridge desactivado:', r.ok ? 'OK' : 'FALLO'));
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    stopBridge();
    if (syncHelperProcess) syncHelperProcess.kill();
    // Activar bridge de Render y abrir QR
    renderFetch('/enable').then(() => {
      shell.openExternal(RENDER_BRIDGE_URL + '/qr');
    });
    app.quit();
  }
});

app.on('activate', function () { if (mainWindow === null) createWindow(); });