const fs = require('fs');
const path = require('path');

const KV_KEY_PREFIX = 'conv:';
const MAX_HISTORY = 10;
const CONV_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'conversations') : path.join(__dirname, '..', 'conversations');

if (!fs.existsSync(CONV_DIR)) {
  fs.mkdirSync(CONV_DIR, { recursive: true });
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const useRedis = !!(redisUrl && redisToken);

let redis = null;

function getRedis() {
  if (!redis && useRedis) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: redisUrl, token: redisToken });
  }
  return redis;
}

function filePath(phone) {
  return path.join(CONV_DIR, phone.replace(/[^a-zA-Z0-9]/g, '_') + '.json');
}

async function loadConversation(phone) {
  if (useRedis) {
    const key = KV_KEY_PREFIX + phone;
    try {
      const raw = await getRedis().lrange(key, 0, -1);
      return (raw || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    } catch (e) { console.error('[CONV REDIS ERROR]', e.message); return []; }
  }
  try {
    const fp = filePath(phone);
    if (!fs.existsSync(fp)) {
      console.log('[CONV] No file for', phone);
      return [];
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    console.log('[CONV] Loaded', data.length, 'messages from', fp);
    return data;
  } catch (e) { console.error('[CONV FILE ERROR]', e.message); return []; }
}

async function saveConversation(phone, messages) {
  const toSave = messages.slice(-MAX_HISTORY);
  if (useRedis) {
    const key = KV_KEY_PREFIX + phone;
    try {
      const r = getRedis();
      await r.del(key);
      for (const m of toSave) {
        await r.rpush(key, JSON.stringify(m));
      }
    } catch (e) { console.error('[CONV REDIS ERROR]', e.message); }
    return;
  }
  try {
    if (!fs.existsSync(CONV_DIR)) {
      fs.mkdirSync(CONV_DIR, { recursive: true });
      console.log('[CONV] Created dir:', CONV_DIR);
    }
    const fp = filePath(phone);
    fs.writeFileSync(fp, JSON.stringify(toSave), 'utf8');
    console.log('[CONV] Saved', toSave.length, 'messages to', fp);
  } catch (e) { console.error('[CONV FILE ERROR]', e.message, e.stack); }
}

async function clearConversation(phone) {
  if (useRedis) {
    try {
      await getRedis().del(KV_KEY_PREFIX + phone);
    } catch {}
    return;
  }
  try { fs.unlinkSync(filePath(phone)); } catch {}
}

async function getConversationMeta(phone) {
  if (useRedis) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      const raw = await getRedis().get(key);
      return raw || {};
    } catch { return {}; }
  }
  return {};
}

async function setConversationMeta(phone, meta) {
  if (useRedis) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      await getRedis().set(key, meta);
    } catch {}
  }
}

module.exports = { loadConversation, saveConversation, clearConversation, getConversationMeta, setConversationMeta };
