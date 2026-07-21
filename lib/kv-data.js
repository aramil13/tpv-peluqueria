const DATA_KEY = 'syncData';
const R2_KEY = 'syncData.json';

function getFs() {
  if (typeof __non_webpack_require__ !== 'undefined') return __non_webpack_require__('fs');
  try { return require('fs'); } catch { return null; }
}

function getPath() {
  if (typeof __non_webpack_require__ !== 'undefined') return __non_webpack_require__('path');
  try { return require('path'); } catch { return null; }
}

function getR2() {
  const env = globalThis.__ENV;
  if (env && env.R2_DATA) return env.R2_DATA;
  return null;
}

function getKv() {
  return globalThis.__KV;
}

function getEnv() {
  return globalThis.__ENV || process.env;
}

function getSyncFile() {
  const env = getEnv();
  const p = getPath();
  if (!p) return '';
  return env.SYNC_FILE || (env.DATA_DIR ? p.join(env.DATA_DIR, 'appointments.json') : p.join(__dirname, '..', 'sync', 'appointments.json'));
}

function getDataDir() {
  const env = getEnv();
  const p = getPath();
  if (!p) return '';
  return env.DATA_DIR || p.join(__dirname, '..', 'sync');
}

function readData() {
  const r2 = getR2();
  if (r2) return readFromR2(r2);
  const kv = getKv();
  if (kv) return readFromKv(kv);
  return readFromFile();
}

async function writeData(data) {
  const r2 = getR2();
  if (r2) return await writeToR2(r2, data);
  const kv = getKv();
  if (kv) return await writeToKv(kv, data);
  return writeToFile(data);
}

async function readFromR2(r2) {
  try {
    const obj = await r2.get(R2_KEY);
    if (!obj) return emptyData();
    const text = await obj.text();
    const raw = JSON.parse(text);
    return normalizeData(raw);
  } catch (e) {
    return emptyData();
  }
}

async function writeToR2(r2, data) {
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  (data.appointments || []).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
  data.lastModified = Date.now();
  await r2.put(R2_KEY, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
}

async function readFromKv(kv) {
  try {
    const raw = await kv.get(DATA_KEY, 'json');
    return normalizeData(raw || {});
  } catch (e) {
    return emptyData();
  }
}

async function writeToKv(kv, data) {
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  (data.appointments || []).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
  data.lastModified = Date.now();
  await kv.put(DATA_KEY, JSON.stringify(data));
}

function readFromFile() {
  try {
    const fs = getFs();
    const file = getSyncFile();
    if (fs && file && fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return normalizeData(raw);
    }
  } catch (e) { }
  return emptyData();
}

function writeToFile(data) {
  const fs = getFs();
  const dir = getDataDir();
  if (!fs || !dir) throw new Error('File system no disponible');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  (data.appointments || []).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
  data.lastModified = Date.now();
  fs.writeFileSync(getSyncFile(), JSON.stringify(data, null, 2), 'utf8');
}

function normalizeData(raw) {
  if (!Array.isArray(raw.clients)) raw.clients = [];
  if (!Array.isArray(raw.services)) raw.services = [];
  if (!Array.isArray(raw.employees)) raw.employees = [];
  if (!Array.isArray(raw.appointments)) raw.appointments = [];
  if (!Array.isArray(raw.products)) raw.products = [];
  if (!Array.isArray(raw.projects)) raw.projects = [];
  if (!Array.isArray(raw.movements)) raw.movements = [];
  if (!Array.isArray(raw.sections)) raw.sections = [];
  if (!Array.isArray(raw.providers)) raw.providers = [];
  if (!raw.settings) raw.settings = {};
  return raw;
}

function emptyData() {
  return { appointments: [], clients: [], services: [], employees: [], products: [], projects: [], movements: [], sections: [], providers: [], settings: {}, lastModified: 0 };
}

function mergeArray(local, remote) {
  const map = new Map();
  if (Array.isArray(local)) local.forEach(item => map.set(item.id, item));
  if (Array.isArray(remote)) remote.forEach(item => {
    if (map.has(item.id)) {
      const existing = map.get(item.id);
      if ((item._modified || 0) > (existing._modified || 0)) {
        if (item.cancelledBy) {
          if (item.cancelledBy !== 'client') delete item._deleted;
          if (existing._deleted && !existing.cancelledBy) return;
          map.set(item.id, item); return;
        }
        if (item._deleted) {
          if ((existing.cancelledBy) && !item.cancelledBy) return;
          map.set(item.id, item); return;
        }
        map.set(item.id, item);
      }
    } else {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

module.exports = { readData, writeData, mergeArray };
