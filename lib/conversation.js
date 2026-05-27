const fs = require('fs');
const path = require('path');

const KV_KEY_PREFIX = 'conv:';
const MAX_HISTORY = 20;
const TTL_SECONDS = 86400;
const CONV_DIR = path.join(__dirname, '..', 'sync', 'conversations');

let redis = null;

function ensureConvDir() {
  if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
}

function convFilePath(phone) {
  return path.join(CONV_DIR, phone.replace(/[^a-zA-Z0-9_:]/g, '_') + '.json');
}

function hasRedisConfig() {
  return !!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
}

function getRedis() {
  if (!redis && hasRedisConfig()) {
    try {
      const { Redis } = require('@upstash/redis');
      redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
        token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
      });
    } catch (e) {
      console.warn('Redis init error (conversation):', e.message);
    }
  }
  return redis;
}

function loadLocalConversation(phone) {
  try {
    const fp = convFilePath(phone);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  } catch (e) {
    console.error('Local conv read error:', e.message);
  }
  return [];
}

function saveLocalConversation(phone, messages) {
  try {
    ensureConvDir();
    const toSave = messages.slice(-MAX_HISTORY);
    fs.writeFileSync(convFilePath(phone), JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.error('Local conv write error:', e.message);
  }
}

function deleteLocalConversation(phone) {
  try {
    const fp = convFilePath(phone);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

async function loadConversation(phone) {
  const r = getRedis();
  if (r) {
    const key = KV_KEY_PREFIX + phone;
    try {
      const raw = await r.lrange(key, 0, -1);
      return (raw || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    } catch { return loadLocalConversation(phone); }
  }
  return loadLocalConversation(phone);
}

async function saveConversation(phone, messages) {
  const r = getRedis();
  if (r) {
    const key = KV_KEY_PREFIX + phone;
    try {
      await r.del(key);
      if (messages.length > 0) {
        const toSave = messages.slice(-MAX_HISTORY);
        for (const m of toSave) {
          await r.rpush(key, JSON.stringify(m));
        }
        await r.expire(key, TTL_SECONDS);
      }
    } catch {}
  }
  saveLocalConversation(phone, messages);
}

async function clearConversation(phone) {
  const r = getRedis();
  if (r) {
    try {
      await r.del(KV_KEY_PREFIX + phone);
    } catch {}
  }
  deleteLocalConversation(phone);
}

async function getConversationMeta(phone) {
  const r = getRedis();
  if (r) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      const raw = await r.get(key);
      return raw || {};
    } catch { return {}; }
  }
  return {};
}

async function setConversationMeta(phone, meta) {
  const r = getRedis();
  if (r) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      await r.set(key, meta);
      await r.expire(key, TTL_SECONDS);
    } catch {}
  }
}

module.exports = { loadConversation, saveConversation, clearConversation, getConversationMeta, setConversationMeta };
