const { Redis } = require('@upstash/redis');

const kv = Redis.fromEnv();

const DATA_KEY = 'syncData';

async function readData() {
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
    return { appointments: [], clients: [], services: [], employees: [], products: [], projects: [], movements: [], sections: [], providers: [], settings: {}, lastModified: 0 };
  }
}

async function writeData(data) {
  try {
    data.lastModified = Date.now();
    await kv.set(DATA_KEY, data);
  } catch (e) {
    console.error('KV write error:', e.message);
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
