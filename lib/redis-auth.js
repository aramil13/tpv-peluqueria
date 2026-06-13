const { Redis } = require('@upstash/redis');

function serialize(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
    return { __buf: true, data: Buffer.from(val.data).toString('base64') };
  }
  if (Buffer.isBuffer(val)) {
    return { __buf: true, data: val.toString('base64') };
  }
  if (Array.isArray(val)) {
    return val.map(serialize);
  }
  if (typeof val === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = serialize(v);
    }
    return obj;
  }
  return val;
}

function deserialize(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && val.__buf && typeof val.data === 'string') {
    return Buffer.from(val.data, 'base64');
  }
  if (Array.isArray(val)) {
    return val.map(deserialize);
  }
  if (typeof val === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = deserialize(v);
    }
    return obj;
  }
  return val;
}

function useRedisAuthState(redisUrl, redisToken, initAuthCreds, prefix = 'wa:') {
  const redis = new Redis({ url: redisUrl, token: redisToken });
  const KEY_CREDS = prefix + 'creds';
  const KEY_KEYS = prefix + 'keys';

  let creds = null;

  async function init() {
    try {
      const raw = await redis.get(KEY_CREDS);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        creds = deserialize(parsed);
      } else if (initAuthCreds) {
        creds = initAuthCreds();
        await redis.set(KEY_CREDS, JSON.stringify(serialize(creds)));
      }
    } catch {
      if (initAuthCreds) creds = initAuthCreds();
    }
    return creds;
  }

  return {
    init,
    state: {
      get creds() { return creds; },
      set creds(v) { creds = v; },
      keys: {
        get: async (type, ids) => {
          if (!ids || !ids.length) return {};
          try {
            const raw = await redis.get(KEY_KEYS);
            if (!raw) return {};
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const result = {};
            for (const id of ids) {
              const key = type + '_' + id;
              if (obj[key] !== undefined) result[id] = deserialize(obj[key]);
            }
            return result;
          } catch { return {}; }
        },
        set: async (data) => {
          try {
            const raw = await redis.get(KEY_KEYS);
            const obj = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            for (const [key, value] of Object.entries(data)) {
              if (value === null) delete obj[key];
              else obj[key] = serialize(value);
            }
            await redis.set(KEY_KEYS, JSON.stringify(obj));
          } catch {}
        },
        setAll: async (data) => {
          try {
            const raw = await redis.get(KEY_KEYS);
            const obj = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            for (const [key, value] of Object.entries(data)) {
              if (value === null) delete obj[key];
              else obj[key] = serialize(value);
            }
            await redis.set(KEY_KEYS, JSON.stringify(obj));
          } catch {}
        }
      }
    },
    saveCreds: async (c) => {
      creds = c;
      try { await redis.set(KEY_CREDS, JSON.stringify(serialize(c))); } catch {}
    },
    clear: async () => {
      creds = null;
      try { await redis.del(KEY_CREDS); await redis.del(KEY_KEYS); } catch {}
    }
  };
}

module.exports = { useRedisAuthState };
