const { Redis } = require('@upstash/redis');

function useRedisAuthState(redisUrl, redisToken, initAuthCreds, prefix = 'wa:') {
  const redis = new Redis({ url: redisUrl, token: redisToken });
  const KEY_CREDS = prefix + 'creds';
  const KEY_KEYS = prefix + 'keys';

  let creds = null;

  async function init() {
    try {
      const raw = await redis.get(KEY_CREDS);
      if (raw) {
        creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } else if (initAuthCreds) {
        creds = initAuthCreds();
        await redis.set(KEY_CREDS, JSON.stringify(creds));
      }
    } catch {
      if (initAuthCreds) {
        creds = initAuthCreds();
      }
    }
    return creds;
  }

  async function getKeys() {
    try {
      const raw = await redis.get(KEY_KEYS);
      if (!raw) return new Map();
      const map = new Map();
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      for (const [k, v] of Object.entries(obj)) {
        map.set(k, v);
      }
      return map;
    } catch { return new Map(); }
  }

  async function setKeys(keys) {
    try {
      const obj = {};
      for (const [k, v] of keys.entries()) {
        obj[k] = v;
      }
      await redis.set(KEY_KEYS, JSON.stringify(obj));
    } catch {}
  }

  return {
    init,
    state: {
      get creds() { return creds; },
      set creds(v) { creds = v; },
      keys: {
        get: async (type, ids) => {
          if (!ids || !ids.length) return {};
          const map = await getKeys();
          const result = {};
          for (const id of ids) {
            const val = map.get(type + '_' + id);
            if (val) result[id] = val;
          }
          return result;
        },
        set: async (data) => {
          const map = await getKeys();
          for (const [key, value] of Object.entries(data)) {
            if (value === null) map.delete(key);
            else map.set(key, value);
          }
          await setKeys(map);
        },
        setAll: async (data) => {
          const map = await getKeys();
          for (const [key, value] of Object.entries(data)) {
            if (value === null) map.delete(key);
            else map.set(key, value);
          }
          await setKeys(map);
        }
      }
    },
    saveCreds: async (c) => {
      creds = c;
      try { await redis.set(KEY_CREDS, JSON.stringify(c)); } catch {}
    },
    clear: async () => {
      creds = null;
      try { await redis.del(KEY_CREDS); await redis.del(KEY_KEYS); } catch {}
    }
  };
}

module.exports = { useRedisAuthState };
