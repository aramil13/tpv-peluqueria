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
function getR2() {
  const env = globalThis.__ENV;
  if (env && env['tpv-sync-data']) return env['tpv-sync-data'];
  return null;
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
  const r2 = getR2();
  if (r2) {
    try {
      const key = 'conv_' + phone + '.json';
      const obj = await r2.get(key);
      if (!obj) return [];
      const raw = await obj.json();
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
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
  const r2 = getR2();
  if (r2) {
    try {
      const key = 'conv_' + phone + '.json';
      await r2.put(key, JSON.stringify(toSave), { httpMetadata: { contentType: 'application/json' } });
    } catch (e) { }
    return;
  }
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
  const r2 = getR2();
  if (r2) {
    try { await r2.delete('conv_' + phone + '.json'); } catch {}
    return;
  }
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
  const r2 = getR2();
  if (r2) {
    try {
      const key = 'conv_' + phone + '_meta.json';
      const obj = await r2.get(key);
      if (!obj) return {};
      return await obj.json();
    } catch { return {}; }
  }
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
  const r2 = getR2();
  if (r2) {
    try { await r2.put('conv_' + phone + '_meta.json', JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } }); } catch {}
    return;
  }
  const kv = getKv();
  if (kv) {
    const key = KV_KEY_PREFIX + phone + ':meta';
    try {
      await kv.put(key, JSON.stringify(meta));
    } catch {}
  }
}

module.exports = { loadConversation, saveConversation, clearConversation, getConversationMeta, setConversationMeta };
