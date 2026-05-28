const { app, BrowserWindow } = require('electron');
const path = require('path');
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
      contextIsolation: true
    }
  });

  mainWindow.loadFile('electron-app.html');
  // mainWindow.webContents.openDevTools();

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
