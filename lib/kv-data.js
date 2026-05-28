const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SYNC_FILE = process.env.SYNC_FILE || path.join(DATA_DIR, 'appointments.json');
const DATA_KEY = 'syncData';

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const useRedis = !!(redisUrl && redisToken);

let kv = null;

if (useRedis) {
  const { Redis } = require('@upstash/redis');
  kv = new Redis({ url: redisUrl, token: redisToken });
}

function readData() {
  if (useRedis) {
    return readFromRedis();
  }
  return readFromFile();
}

function writeData(data) {
  if (useRedis) {
    return writeToRedis(data);
  }
  return writeToFile(data);
}

async function readFromRedis() {
  try {
    const raw = await kv.get(DATA_KEY);
    return normalizeData(raw || {});
  } catch (e) {
    console.error('KV read error:', e.message);
    return emptyData();
  }
}

async function writeToRedis(data) {
  try {
    const today = new Date().toISOString().split('T')[0];
    (data.appointments || []).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
    data.lastModified = Date.now();
    await kv.set(DATA_KEY, data);
  } catch (e) {
    console.error('KV write error:', e.message);
  }
}

function readFromFile() {
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      return normalizeData(raw);
    }
  } catch (e) { /* fall through */ }
  return emptyData();
}

function writeToFile(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const today = new Date().toISOString().split('T')[0];
    (data.appointments || []).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
    data.lastModified = Date.now();
    fs.writeFileSync(SYNC_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('KV write error:', e.message);
    return false;
  }
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