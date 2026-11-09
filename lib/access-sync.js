const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = process.env.ACCESS_SYNC_SCRIPT || path.join(__dirname, '..', 'scripts', 'access-sync.ps1');
if (!fs.existsSync(SCRIPT_PATH)) console.error('[AccessSync] SCRIPT NOT FOUND:', SCRIPT_PATH);

// Estado para serializar y coalescer las ejecuciones.
// Nunca puede haber dos PowerShell a la vez, y si llegan muchas peticiones
// mientras una esta en curso solo se encola UNA pasada extra (no una por peticion).
let running = false;
let pending = false;
let currentRun = Promise.resolve('');

function runScript(jsonFile) {
  return new Promise((resolve) => {
    execFile('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', SCRIPT_PATH,
      '-JsonFile', jsonFile
    ], {
      timeout: 300000,
      // CRITICO: sin esto Windows crea una ventana de consola visible cada vez
      // que se sincroniza con Access. Esa ventana roba el foco mientras se
      // escribe en el TPV y hace imposible guardar los formularios.
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[AccessSync] Error:', error.message);
        if (stderr) console.error('[AccessSync] stderr:', stderr);
        resolve('[AccessSync] FAILED: ' + error.message);
      } else {
        const out = (stdout || '').trim();
        console.log('[AccessSync]', out);
        resolve(out);
      }
    });
  });
}

function syncToAccess(jsonFile) {
  if (running) {
    // Ya hay una sincronizacion en marcha: marcar que hace falta otra pasada
    // cuando termine y devolver la promesa actual (no bloquear ni acumular).
    pending = true;
    return currentRun;
  }

  running = true;
  currentRun = runScript(jsonFile).then(
    (out) => {
      running = false;
      if (pending) {
        pending = false;
        // Una sola pasada extra, en segundo plano, con el JSON mas reciente.
        syncToAccess(jsonFile).catch(() => {});
      }
      return out;
    },
    (err) => {
      running = false;
      if (pending) {
        pending = false;
        syncToAccess(jsonFile).catch(() => {});
      }
      throw err;
    }
  );
  return currentRun;
}

module.exports = { syncToAccess };
