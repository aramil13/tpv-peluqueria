const path = require('path');
const http = require('http');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const PORT = parseInt(process.env.PORT) || 3457;
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const SYNC_API_URL = (process.env.SYNC_URL || 'https://nymaraestilistas.es/api').replace(/\/+$/, '') + '/sync';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'tpv-secret-2026';

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch {}

process.env.DATA_DIR = DATA_DIR;

const { processWhatsAppMessage } = require('./lib/ai-assistant');
const { loadConversation, saveConversation, clearConversation } = require('./lib/conversation');

let currentSock = null;
let isConnected = false;
let bridgeState = 'stopped';
let processedIds = new Set();
const messageQueue = [];
let queueProcessing = false;
const phoneJidMap = new Map();
let outgoingMessageIds = new Set();
let stopped = false;
let reconnectTimer = null;
let currentQr = null;
const RECONNECT_DELAY = 15000;

async function start() {
  if (stopped) return;
  if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
  isConnected = false;
  bridgeState = 'starting';
  currentQr = null;

  let baileysMod;
  try {
    baileysMod = await import('@whiskeysockets/baileys');
  } catch (e) {
    console.error('[BRIDGE] Error al cargar Baileys:', e.message);
    setTimeout(start, RECONNECT_DELAY);
    return;
  }

  const { makeWASocket, DisconnectReason } = baileysMod;
  let state, saveCreds;

  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const { useRedisAuthState } = require('./lib/redis-auth');
      const auth = useRedisAuthState(UPSTASH_URL, UPSTASH_TOKEN, 'wa:');
      const creds = await auth.loadCreds();
      if (creds) auth.state.creds = creds;
      state = auth.state;
      saveCreds = auth.saveCreds;
      console.log('[BRIDGE] Auth en Upstash Redis');
    } catch (e) {
      console.error('[BRIDGE] Error Redis auth, usando archivos:', e.message);
      const auth = await baileysMod.useMultiFileAuthState(AUTH_DIR);
      state = auth.state; saveCreds = auth.saveCreds;
    }
  } else {
    console.log('[BRIDGE] Auth en archivos locales:', AUTH_DIR);
    const auth = await baileysMod.useMultiFileAuthState(AUTH_DIR);
    state = auth.state; saveCreds = auth.saveCreds;
  }

  if (!state.creds) {
    console.error('[BRIDGE] No se pudo inicializar autenticación');
    setTimeout(start, RECONNECT_DELAY);
    return;
  }

  const uid = Math.random().toString(36).substr(2, 8);
  let sock;
  try {
    sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      syncFullHistory: false,
      browser: ['WhatsApp/2.24.10', 'Windows', '10.0', uid],
      logger
    });
  } catch (e) {
    console.error('[BRIDGE] Error al crear conexión:', e.message);
    setTimeout(start, RECONNECT_DELAY);
    return;
  }

  currentSock = sock;
  bridgeState = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (stopped) return;
    if (qr) {
      currentQr = qr;
      qrcode.toFile(path.join(DATA_DIR, 'qr.png'), qr, { width: 400, margin: 2 }, () => {});
      qrcode.toString(qr, { type: 'terminal', small: true }, (err, url) => { if (!err) console.log(url); });
    }
    if (connection === 'close') {
      isConnected = false;
      bridgeState = 'stopped';
      const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (logout) {
        console.log('[BRIDGE] Sesión cerrada. Escanea QR de nuevo.');
        currentQr = null;
        return;
      }
      if (!stopped) {
        bridgeState = 'connecting';
        console.log('[BRIDGE] Reconectando en ' + (RECONNECT_DELAY/1000) + 's...');
        reconnectTimer = setTimeout(start, RECONNECT_DELAY);
      }
    }
    if (connection === 'open') {
      isConnected = true;
      bridgeState = 'connected';
      const myId = sock.user?.id || 'desconocido';
      const myPhone = myId.split(':')[0].split('@')[0];
      console.log('[BRIDGE] Conectado como +' + myPhone);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || stopped) return;
    for (const m of messages) {
      if (m.key.id && processedIds.has(m.key.id)) continue;
      if (m.key.id) processedIds.add(m.key.id);
      if (m.key.fromMe) {
        if (outgoingMessageIds.has(m.key.id)) { outgoingMessageIds.delete(m.key.id); continue; }
        continue;
      }
      if (m.key.remoteJid && m.key.remoteJid.includes('@g.us')) continue;
      if (m.key.remoteJid && m.key.remoteJid.includes('@broadcast')) continue;
      if (!m.message?.conversation && !m.message?.extendedTextMessage?.text) continue;

      const jid = m.key.remoteJid;
      const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
      phoneJidMap.set(phone, jid);
      const text = m.message.conversation || m.message.extendedTextMessage.text || '';
      console.log(` [IN] +${phone}: ${text.slice(0, 80)}`);
      messageQueue.push({ phone: '+' + phone, text, jid });
      if (!queueProcessing) processQueue();
    }
  });
}

async function processQueue() {
  if (queueProcessing || messageQueue.length === 0) return;
  queueProcessing = true;
  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    try {
      const reply = await processWhatsAppMessage(item.phone, item.text);
      if (item.jid && currentSock && isConnected) {
        const sent = await currentSock.sendMessage(item.jid, { text: reply });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        console.log(` [OUT] ${item.phone}: ${reply.slice(0, 80)}`);
      }
    } catch (e) {
      console.error('[QUEUE ERROR]', e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  queueProcessing = false;
}

async function sendMessage(phone, text) {
  if (!currentSock || !isConnected) return { sent: false, error: 'No conectado' };
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const mappedJid = phoneJidMap.get(cleanPhone);
  const jid = mappedJid || (phone.includes('@') ? phone : cleanPhone + '@s.whatsapp.net');
  try {
    await currentSock.sendMessage(jid, { text });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

const server = http.createServer((req, res) => {
  const setJson = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  const noCache = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };

  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }

    const url = req.url.split('?')[0];

    // Health / Ping
    if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/ping')) {
      setJson(200, { ok: true, connected: isConnected, state: bridgeState, uptime: process.uptime() });
      return;
    }

    // QR page
    if (req.method === 'GET' && (url === '/qr' || url === '/qr.html')) {
      const qrPath = path.join(DATA_DIR, 'qr.png');
      const hasQr = fs.existsSync(qrPath);
      const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bridge - QR</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
h2{font-size:20px;margin-bottom:8px}
p{font-size:14px;color:#aaa;margin-bottom:20px}
#qrImg{width:280px;height:280px;border:3px solid #333;border-radius:12px;background:#fff;padding:10px;margin-bottom:20px;display:${hasQr?'block':'none'}}
#loading{color:#888;font-size:14px;margin-bottom:20px;display:${hasQr?'none':'block'}}
.steps{background:#1a1a1a;border-radius:8px;padding:16px;max-width:400px;font-size:13px;color:#ccc;line-height:1.6;text-align:left;margin-bottom:20px}
.status{font-size:12px;color:#666;margin-top:10px}
</style>
</head><body>
<h2>📱 Vincular WhatsApp</h2>
<p>Escanea este c&oacute;digo QR con tu m&oacute;vil</p>
<div class="steps">
<ol>
<li>Abre <strong>WhatsApp</strong> en tu m&oacute;vil</li>
<li>Ve a <strong>Ajustes &gt; Dispositivos vinculados</strong></li>
<li>Toca <strong>Vincular un dispositivo</strong></li>
<li>Apunta la c&aacute;mara al QR de abajo</li>
</ol>
</div>
<img id="qrImg" src="/qr-img?t=${Date.now()}" alt="QR">
<div id="loading">⏳ Generando QR, espera unos segundos...</div>
<div id="statusMsg" class="status"></div>
<script>
(function refresh(){
  var t=Date.now();
  document.getElementById('qrImg').onerror=function(){ this.style.display='none'; document.getElementById('loading').style.display='block'; };
  document.getElementById('qrImg').onload=function(){ this.style.display='block'; document.getElementById('loading').style.display='none'; };
  document.getElementById('qrImg').src='/qr-img?t='+t;
  setTimeout(refresh,5000);
})();
</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(html);
      return;
    }

    // QR image
    if (req.method === 'GET' && url.startsWith('/qr-img')) {
      const qrPath = path.join(DATA_DIR, 'qr.png');
      if (fs.existsSync(qrPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png', ...noCache });
        res.end(fs.readFileSync(qrPath));
      } else {
        res.writeHead(204, noCache);
        res.end();
      }
      return;
    }

    // Status JSON
    if (req.method === 'GET' && url === '/status') {
      setJson(200, { connected: isConnected, state: bridgeState, phone: currentSock?.user?.id?.split(':')[0]?.split('@')[0] || '' });
      return;
    }

    // Sync GET
    if (req.method === 'GET' && url === '/sync') {
      try {
        const https = require('https');
        const syncReq = https.get(SYNC_API_URL, (syncRes) => {
          let data = '';
          syncRes.on('data', c => data += c);
          syncRes.on('end', () => {
            res.writeHead(syncRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        syncReq.on('error', () => setJson(503, { error: 'No se pudo conectar con API' }));
        syncReq.end();
      } catch { setJson(503, { error: 'Error al obtener datos' }); }
      return;
    }

    // Send message (POST /send)
    if (req.method === 'POST' && url === '/send') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { phone, text } = JSON.parse(body);
          if (!phone || !text) { setJson(400, { error: 'phone and text required' }); return; }
          const result = await sendMessage(phone, text);
          setJson(result.sent ? 200 : 503, result);
        } catch (e) { setJson(400, { error: e.message }); }
      });
      return;
    }

    // Logout
    if (req.method === 'POST' && url === '/logout') {
      if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
      currentQr = null;
      isConnected = false;
      bridgeState = 'stopped';
      // Clear auth
      if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
          const { useRedisAuthState } = require('./lib/redis-auth');
          const auth = useRedisAuthState(UPSTASH_URL, UPSTASH_TOKEN, 'wa:');
          auth.clear();
        } catch {}
      }
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
      setJson(200, { ok: true, message: 'Sesión cerrada' });
      setTimeout(start, 1000);
      return;
    }

    setJson(404, { error: 'Not found' });
  } catch (e) {
    setJson(500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BRIDGE] Fly.io WhatsApp Bridge corriendo en puerto ${PORT}`);
  console.log(`[BRIDGE] QR: http://localhost:${PORT}/qr`);
  console.log(`[BRIDGE] Sync: ${SYNC_API_URL}`);
  start();
});
