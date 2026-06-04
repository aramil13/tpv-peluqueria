const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

let mainWindow;
let syncHelperProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "TPV Agenda Peluquería",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('electron-app.html');
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function startSyncHelper() {
  // Si se define NO_LOCAL_SYNC=true no arranca el servidor local
  // (útil cuando se usa únicamente un servidor cloud)
  if (process.env.NO_LOCAL_SYNC === 'true' || process.env.NO_LOCAL_SYNC === '1') {
    console.log('Local sync-helper disabled (NO_LOCAL_SYNC is set)');
    return;
  }
  const helperPath = path.join(__dirname, 'sync-helper.js');
  const userDataPath = app.getPath('userData');
  const syncFile = path.join(userDataPath, 'appointments.json');
  console.log('Sync file location:', syncFile);
  
  syncHelperProcess = fork(helperPath, [], {
    env: { 
      ...process.env, 
      SYNC_FILE: syncFile,
      NO_LOCAL_SYNC: undefined 
    }
  });
  
  syncHelperProcess.on('error', (err) => {
    console.error('Failed to start sync-helper:', err);
  });
}

ipcMain.handle('send-whatsapp', async (event, { phone, text }) => {
  return new Promise((resolve) => {
    const data = JSON.stringify({ phone, text });
    const req = http.request('http://localhost:3457/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ sent: false, error: body }); }
      });
    });
    req.on('error', e => resolve({ sent: false, error: e.message }));
    req.write(data);
    req.end();
  });
});

app.on('ready', () => {
  startSyncHelper();
  createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    if (syncHelperProcess) syncHelperProcess.kill();
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});
