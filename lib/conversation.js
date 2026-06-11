const KV_KEY_PREFIX = 'conv:';
const MAX_HISTORY = 10;

function getFs() {
  try { return require('fs'); } catch { return null; }
}
function getPath() {
  try { return require('path'); } catch { return null; }
}
function getKv() {
  return globalThis.__KV;
}
function getEnv() {
  return globalThis.__ENV || process.env;
}

const env = getEnv();
const p = getPath();
const CONV_DIR = env.DATA_DIR && p ? p.join(env.DATA_DIR, 'conversations') : (p ? p.join(__dirname, '..', 'conversations') : null);

const fs2 = getFs();
if (CONV_DIR && fs2 && !fs2.existsSync(CONV_DIR)) {
  fs2.mkdirSync(CONV_DIR, { recursive: true });
}

function filePath(phone) {
  const p2 = getPath();
  if (!p2 || !CONV_DIR) return '';
  return p2.join(CONV_DIR, phone.replace(/[^a-zA-Z0-9]/g, '_') + '.json');
}

async function loadConversation(phone) {
  const kv = getKv();
  if (kv) {
    const key = KV_KEY_PREFIX + phone;
    try {
      const raw = await kv.get(key, 'json');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  try {
    const fs3 = getFs();
    const fp = filePath(phone);
    if (!fs3 || !fp || !fs3.existsSync(fp)) {
      return [];
    }
    const raw = fs3.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (e) { return []; }
}

async function saveConversation(phone, messages) {
  const toSave = messages.slice(-MAX_HISTORY);
  const kv = getKv();
  if (kv) {
    const key = KV_KEY_PREFIX + phone;
    try {
      await kv.put(key, JSON.stringify(toSave));
    } catch (e) { }
    return;
  }
  try {
    const fs3 = getFs();
    if (!fs3 || !CONV_DIR) return;
    if (!fs3.existsSync(CONV_DIR)) {
      fs3.mkdirSync(CONV_DIR, { recursive: true });
    }
    const fp = filePath(phone);
    if (!fp) return;
    fs3.writeFileSync(fp, JSON.stringify(toSave), 'utf8');
  } catch (e) { }
}

async function clearConversation(phone) {
  const kv = getKv();
  if (kv) {
    try {
      await kv.delete(KV_KEY_PREFIX + phone);
    } catch {}
    return;
  }
  try { const fs3 = getFs(); if (fs3) { const fp = filePath(phone); if (fp) fs3.unlinkSync(fp); } } catch {}
}

async function getConversationMeta(phone) {
  const kv = getKv();
  if (kv) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      const raw = await kv.get(key, 'json');
      return raw || {};
    } catch { return {}; }
  }
  return {};
}

async function setConversationMeta(phone, meta) {
  const kv = getKv();
  if (kv) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      await kv.put(key, JSON.stringify(meta));
    } catch {}
  }
}

module.exports = { loadConversation, saveConversation, clearConversation, getConversationMeta, setConversationMeta };
