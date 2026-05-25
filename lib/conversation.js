const KV_KEY_PREFIX = 'conv:';
const MAX_HISTORY = 20;
const TTL_SECONDS = 86400;

let redis = null;

function getRedis() {
  if (!redis) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || '',
      token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
    });
  }
  return redis;
}

async function loadConversation(phone) {
  const key = KV_KEY_PREFIX + phone;
  try {
    const raw = await getRedis().lrange(key, 0, -1);
    return (raw || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function saveConversation(phone, messages) {
  const key = KV_KEY_PREFIX + phone;
  try {
    const r = getRedis();
    await r.del(key);
    if (messages.length > 0) {
      const pipeline = messages.slice(-MAX_HISTORY).map(m => ['rpush', key, JSON.stringify(m)]);
      await r.pipeline(...pipeline);
      await r.expire(key, TTL_SECONDS);
    }
  } catch {}
}

async function clearConversation(phone) {
  try {
    await getRedis().del(KV_KEY_PREFIX + phone);
  } catch {}
}

async function getConversationMeta(phone) {
  const key = KV_KEY_PREFIX + phone + ':meta';
  try {
    const raw = await getRedis().get(key);
    return raw || {};
  } catch { return {}; }
}

async function setConversationMeta(phone, meta) {
  const key = KV_KEY_PREFIX + phone + ':meta';
  try {
    await getRedis().set(key, meta);
    await getRedis().expire(key, TTL_SECONDS);
  } catch {}
}

module.exports = { loadConversation, saveConversation, clearConversation, getConversationMeta, setConversationMeta };
