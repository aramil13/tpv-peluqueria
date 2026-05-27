const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

const SYNC_FILE = path.join(__dirname, '..', 'sync', 'appointments.json');

const hasRedisConfig = () => {
  return !!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
};

let kv = null;
if (hasRedisConfig()) {
  try {
    kv = (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
      ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
      : Redis.fromEnv();
  } catch (e) {
    console.warn('Redis init error, using file fallback:', e.message);
    kv = null;
  }
}

const DATA_KEY = 'syncData';

async function readData() {
  if (kv) {
    try {
      const raw = await kv.get(DATA_KEY);
      const data = raw || {};
      if (!Array.isArray(data.clients)) data.clients = [];
      if (!Array.isArray(data.services)) data.services = [];
      if (!Array.isArray(data.employees)) data.employees = [];
      if (!Array.isArray(data.appointments)) data.appointments = [];
      if (!Array.isArray(data.products)) data.products = [];
      if (!Array.isArray(data.projects)) data.projects = [];
      if (!Array.isArray(data.movements)) data.movements = [];
      if (!Array.isArray(data.sections)) data.sections = [];
      if (!Array.isArray(data.providers)) data.providers = [];
      if (!data.settings) data.settings = {};
      return data;
    } catch (e) {
      console.error('KV read error:', e.message);
    }
  }
  return readFileData();
}

function readFileData() {
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
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
  } catch (e) {
    console.error('File read error:', e.message);
  }
  return { appointments: [], clients: [], services: [], employees: [], products: [], projects: [], movements: [], sections: [], providers: [], settings: {}, lastModified: 0 };
}

async function writeData(data) {
  try {
    const today = new Date().toISOString().split('T')[0];
    (data.appointments||[]).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
    data.lastModified = Date.now();
    if (kv) {
      await kv.set(DATA_KEY, data);
    }
    writeFileData(data);
  } catch (e) {
    console.error('KV write error:', e.message);
    writeFileData(data);
  }
}

function writeFileData(data) {
  try {
    const dir = path.dirname(SYNC_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SYNC_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('File write error:', e.message);
  }
}

function mergeArray(local, remote) {
  const map = new Map();
  if (Array.isArray(local)) local.forEach(item => map.set(item.id, item));
  if (Array.isArray(remote)) remote.forEach(item => {
    if (map.has(item.id)) {
      const existing = map.get(item.id);
      if (item.cancelledBy) {
        if (item.cancelledBy !== 'client') delete item._deleted;
        if (existing._deleted && !existing.cancelledBy) return;
        map.set(item.id, item); return;
      }
      if (item._deleted) {
        if ((existing.cancelledBy) && !item.cancelledBy) return;
        map.set(item.id, item); return;
      }
      if (existing._deleted) return;
      if ((item._modified || 0) > (existing._modified || 0)) map.set(item.id, item);
    } else {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

module.exports = { readData, writeData, mergeArray };
