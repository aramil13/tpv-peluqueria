const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'access-sync.ps1');
let syncing = false;

function syncToAccess(jsonFile) {
  if (syncing) return Promise.resolve('[AccessSync] skipped (already running)');
  syncing = true;
  return new Promise((resolve) => {
    execFile('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', SCRIPT_PATH,
      '-JsonFile', jsonFile
    ], { timeout: 120000 }, (error, stdout, stderr) => {
      syncing = false;
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

module.exports = { syncToAccess };
