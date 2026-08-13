const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = process.env.ACCESS_SYNC_SCRIPT || path.join(__dirname, '..', 'scripts', 'access-sync.ps1');
if (!fs.existsSync(SCRIPT_PATH)) console.error('[AccessSync] SCRIPT NOT FOUND:', SCRIPT_PATH);
let chain = Promise.resolve();
let queued = false;

function syncToAccess(jsonFile) {
  // Serialize runs: never two ps1 at once (Access file lock), never drop a call,
  // and never let the queue grow unbounded (coalesce while a run is queued).
  if (queued) return chain;
  queued = true;
  const run = chain.then(() => {
    queued = false;
    return new Promise((resolve) => {
      execFile('powershell', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', SCRIPT_PATH,
        '-JsonFile', jsonFile
      ], { timeout: 120000 }, (error, stdout, stderr) => {
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
  });
  chain = run.then(() => {}, () => {});
  return run;
}

module.exports = { syncToAccess };
