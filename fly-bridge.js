const path = require('path');
const http = require('http');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
try { require('dotenv').config({ path: path.join(__dirname, '.env.local') }); } catch (e) { /* .env.local opcional */ }
require('dotenv').config({ path: path.join(__dirname, '.env') });

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const PORT = parseInt(process.env.PORT) || 3457;
let DATA_DIR = process.env.DATA_DIR || '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
  console.log('[FLY] No se pudo crear ' + DATA_DIR + ' (' + e.message + '). Usando /tmp.');
  DATA_DIR = '/tmp';
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e2) {
    console.log('[FLY] Tampoco /tmp funciona. Usando directorio actual.');
    DATA_DIR = __dirname;
  }
}
const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) { console.log('[FLY] Error creando AUTH_DIR:', e.message); }
try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch (e) { console.log('[FLY] Error creando CONV_DIR:', e.message); }
process.env.DATA_DIR = DATA_DIR;

const SYNC_API_URL = (process.env.SYNC_URL || 'https://nymaraestilistas.es/api').replace(/\/+$/, '') + '/sync';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'tpv-secret-2026';

const { processWhatsAppMessage } = require('./lib/ai-assistant');
const { loadConversation, saveConversation, clearConversation } = require('./lib/conversation');
const { readData, writeData, mergeArray } = require('./lib/kv-data');

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

// Persistir phoneJidMap a disco para que sobreviva a reconexiones QR
const jidMapFile = path.join(AUTH_DIR, 'jid-map.json');
function saveJidMap() {
  try { fs.writeFileSync(jidMapFile, JSON.stringify(Object.fromEntries(phoneJidMap))); } catch {}
}
function loadJidMap() {
  try {
    if (fs.existsSync(jidMapFile)) {
      const obj = JSON.parse(fs.readFileSync(jidMapFile, 'utf8'));
      for (const [k, v] of Object.entries(obj)) phoneJidMap.set(k, v);
      console.log(`[JID-MAP] Cargados ${phoneJidMap.size} mapeos JID desde disco`);
    }
  } catch {}
}
function addJidMapping(phone, jid) { phoneJidMap.set(phone, jid); saveJidMap(); }
let currentQr = null;
let qrGeneratedThisSession = false;
let currentQrTimestamp = 0;
let lastDisconnectWas515 = false;
const QR_STABLE_TIME = 120000; // 2 minutos mínimo sin regenerar QR
const RECONNECT_DELAY = 15000;

setInterval(() => {
  if (processedIds.size > 1000) processedIds = new Set();
  if (outgoingMessageIds.size > 500) outgoingMessageIds = new Set();
}, 60000);

async function start() {
  if (stopped) return;
  if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
  isConnected = false;
  bridgeState = 'starting';
  currentQr = null;

  if (lastDisconnectWas515) {
    console.log('[FLY] Error 515 previo. NO limpiando auth, reconectando con credenciales guardadas...');
    lastDisconnectWas515 = false;
    qrGeneratedThisSession = false;
  } else if (qrGeneratedThisSession && (Date.now() - currentQrTimestamp) > QR_STABLE_TIME) {
    console.log('[FLY] QR expiró hace >2min. Limpiando auth y generando QR nuevo...');
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'qr.png')); } catch {}
    qrGeneratedThisSession = false;
  } else if (qrGeneratedThisSession) {
    console.log('[FLY] QR aún vigente (<2min desde generación). Manteniendo auth y QR actual para que el usuario pueda escanear.');
  }

  const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
  let state, saveCreds;

  console.log('[FLY] Auth en archivos:', AUTH_DIR);
  const auth = await useMultiFileAuthState(AUTH_DIR);
  state = auth.state;
  saveCreds = auth.saveCreds;
  loadJidMap();

  const uid = Math.random().toString(36).substr(2, 8);
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    syncFullHistory: false,
    browser: ['WhatsApp/2.24.10', 'Windows', '10.0', uid],
    logger,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false
  });

  currentSock = sock;
  bridgeState = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (stopped) return;
    const { connection, lastDisconnect, qr } = update;
    if (!qr && !connection) {
      console.log('[FLY] connection.update parcial:', JSON.stringify(update).slice(0,200));
    }
    if (qr) {
      currentQr = qr;
      qrGeneratedThisSession = true;
      currentQrTimestamp = Date.now();
      bridgeState = 'awaiting_scan';
      console.log('\n[QR GENERADO] Escanea con WhatsApp (Ajustes > Dispositivos vinculados):');
      qrcode.generate(qr, { small: true });
      qrcodeImg.toFile(path.join(DATA_DIR, 'qr.png'), qr, { width: 400, margin: 2, errorCorrectionLevel: 'L' }, () => {
        console.log(' [QR] Guardado en ' + path.join(DATA_DIR, 'qr.png'));
      });
    }
    if (connection === 'close') {
      isConnected = false;
      const errCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message;
      const is515 = errCode === 515;
      const logout = errCode === DisconnectReason.loggedOut;
      console.log('[FLY] Conexión cerrada. Código:', errCode, 'Mensaje:', (errMsg||'ninguno').slice(0,100));
      if (logout) {
        console.log('[FLY] Sesión cerrada desde el móvil. Limpiando autenticación...');
        currentQr = null;
        bridgeState = 'stopped';
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
        if (!stopped) {
          bridgeState = 'connecting';
          reconnectTimer = setTimeout(start, 2000);
        }
        return;
      }
      if (qrGeneratedThisSession && !is515 && (Date.now() - currentQrTimestamp) > QR_STABLE_TIME) {
        console.log('[FLY] QR generado hace >2min sin ser escaneado. Limpiando auth para QR fresco...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
      } else if (qrGeneratedThisSession && !is515) {
        console.log('[FLY] QR generado hace <2min. Manteniendo QR para que el usuario pueda escanearlo.');
      }
      if (is515) {
        lastDisconnectWas515 = true;
        console.log('[FLY] Error 515 (transitorio). Manteniendo credenciales para reconexión.');
      }
      if (!stopped) {
        bridgeState = 'connecting';
        const reason = lastDisconnect?.error?.message || lastDisconnect?.error?.output?.statusCode || 'desconocido';
        console.log('[FLY] Reconectando en 5s... (razón: ' + reason + ')');
        reconnectTimer = setTimeout(start, 5000);
      }
    }
    if (connection === 'open') {
      isConnected = true;
      bridgeState = 'connected';
      currentQr = null;
      qrGeneratedThisSession = false;
      lastDisconnectWas515 = false;
      const myId = sock.user?.id || 'desconocido';
      const myPhone = myId.split(':')[0].split('@')[0];
      console.log('[FLY] Conectado como +' + myPhone);
      try { fs.unlinkSync(path.join(DATA_DIR, 'qr.png')); } catch {}
    }
  });

  sock.ev.on('messaging-history.set', () => { console.log('[FLY] Historial de mensajes recibido'); });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || stopped) return;
    for (const m of messages) {
      if (m.key.id && processedIds.has(m.key.id)) continue;
      if (m.key.id) processedIds.add(m.key.id);
      if (m.key.fromMe) {
        if (outgoingMessageIds.has(m.key.id)) { outgoingMessageIds.delete(m.key.id); continue; }
        console.log(' [PROCESS-SELF] mensaje desde el propio teléfono, procesando');
      }

      let jid = m.key.remoteJid || '';
      if (jid.includes('@g.us')) continue;
      if (jid.includes('@broadcast')) continue;
      if (!m.message?.conversation && !m.message?.extendedTextMessage?.text) continue;

      const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
      addJidMapping(phone, jid);
      const text = m.message.conversation || m.message.extendedTextMessage.text || '';
      const trimmed = text.trim();
      const history = await loadConversation('+' + phone);
      const hasHistory = history.length > 0;
      const isTrigger = trimmed === 'Hola Nymara';
      const isGoodbye = trimmed === 'Adios Nymara' || trimmed === 'Bye Nymara';
      if (isGoodbye && currentSock) {
        await clearConversation('+' + phone);
        const sent = await currentSock.sendMessage(jid, { text: '¡Hasta luego! 👋 Si necesitas algo, aquí estaré. ¡Cuídate!' });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        continue;
      }
      if (!hasHistory && !isTrigger) {
        console.log(` [IGNORE] ${phone}: "${text.slice(0,40)}"`);
        continue;
      }
      console.log(` [IN] ${phone}: ${text.slice(0, 60)}`);
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
      const qrAge = currentQrTimestamp ? Math.floor((Date.now() - currentQrTimestamp) / 1000) : 0;
      const qrExpired = qrAge > 120;
      const stateLabel = isConnected ? 'Conectado' : bridgeState === 'awaiting_scan' ? (qrExpired ? 'QR expirado - Regenera' : 'Esperando escaneo...') : bridgeState === 'starting' || bridgeState === 'connecting' ? 'Conectando...' : 'Desconectado';
      const stateColor = isConnected ? '#4ade80' : bridgeState === 'awaiting_scan' ? (qrExpired ? '#f59e0b' : '#22d3ee') : '#f59e0b';
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
#qrTimer{font-size:12px;color:#888;margin-bottom:10px;display:${hasQr?'block':'none'}}
.status{font-size:12px;color:#666;margin-top:10px}
#bridgeStatus{font-size:13px;margin-bottom:16px;padding:8px 16px;border-radius:8px;background:rgba(255,255,255,0.05);}
#restartBtn{background:#333;color:#fff;border:1px solid #555;padding:8px 20px;border-radius:8px;cursor:pointer;font-size:13px;margin-top:12px;display:none}
#restartBtn:hover{background:#444}
</style>
</head><body>
<h2>📱 Vincular WhatsApp</h2>
<p>Escanea este c&oacute;digo QR con tu m&oacute;vil</p>
<div id="bridgeStatus">Estado del bridge: <span style="color:${stateColor};font-weight:600;">${stateLabel}</span></div>
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
  <div id="qrTimer" class="status"></div>
  <div id="statusMsg" class="status"></div>
  <button id="restartBtn" onclick="restartBridge()">🔄 Regenerar QR</button>
<script>
function restartBridge(){
  document.getElementById('statusMsg').textContent='Regenerando QR...';
  document.getElementById('statusMsg').style.color='#f59e0b';
  var x=new XMLHttpRequest();
  x.open('POST','/restart',true);
  x.onload=function(){ document.getElementById('statusMsg').textContent='QR regenerado. Espera unos segundos...'; document.getElementById('qrTimer').style.display='none'; setTimeout(refresh,3000); };
  x.onerror=function(){ document.getElementById('statusMsg').textContent='Error al regenerar. Recarga la página.'; document.getElementById('statusMsg').style.color='#ef4444'; };
  x.send();
}
function updateQrAge(){
  var age=Math.floor((Date.now()-window._qrTs)/1000);
  if(age<120){
    var min=Math.floor(age/60), sec=age%60;
    document.getElementById('qrTimer').textContent='⏱ QR generado hace '+min+'m '+sec+'s (válido 2 min)';
    document.getElementById('qrTimer').style.color='#888';
    document.getElementById('restartBtn').style.display='inline-block';
  }else{
    document.getElementById('qrTimer').textContent='⚠️ QR expirado. Pulsa "Regenerar QR" para uno nuevo.';
    document.getElementById('qrTimer').style.color='#f59e0b';
    document.getElementById('restartBtn').style.display='inline-block';
  }
}
(function refresh(){
  var t=Date.now();
  document.getElementById('qrImg').onerror=function(){
    this.style.display='none';
    document.getElementById('loading').style.display='block';
    document.getElementById('loading').textContent='⏳ Generando QR, espera unos segundos...';
  };
  document.getElementById('qrImg').onload=function(){
    this.style.display='block';
    document.getElementById('loading').style.display='none';
    window._qrTs=t;
    document.getElementById('statusMsg').textContent='✅ QR listo. Escanea con WhatsApp';
    document.getElementById('statusMsg').style.color='#22d3ee';
    document.getElementById('qrTimer').style.display='block';
    updateQrAge();
  };
  document.getElementById('qrImg').src='/qr-img?t='+t;
  setTimeout(refresh,10000);
})();
setInterval(updateQrAge,1000);
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
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
      setJson(200, { ok: true, message: 'Sesión cerrada' });
      setTimeout(start, 1000);
      return;
    }

    // Restart (limpia auth y genera QR fresco)
    if ((req.method === 'GET' || req.method === 'POST') && url === '/restart') {
      if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
      currentQr = null;
      isConnected = false;
      bridgeState = 'stopped';
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
      try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
      setJson(200, { ok: true, message: 'Sesión limpiada. Generando QR nuevo...' });
      setTimeout(start, 1000);
      return;
    }

    setJson(404, { error: 'Not found' });
  } catch (e) {
    setJson(500, { error: e.message });
  }
});

console.log('[FLY] DATA_DIR:', DATA_DIR);
console.log('[FLY] AUTH_DIR:', AUTH_DIR);
console.log('[FLY] SYNC_URL:', SYNC_API_URL);

async function syncAllFromCloud() {
  try {
    const resp = await fetch(SYNC_API_URL);
    if (!resp.ok) { console.log('[SYNC] Error fetching from cloud:', resp.status); return; }
    const cloud = await resp.json();
    const hasData = (cloud.clients && cloud.clients.length) || (cloud.services && cloud.services.length) || (cloud.appointments && cloud.appointments.length);
    if (!hasData) { console.log('[SYNC] Cloud data empty, skipping'); return; }
    const local = readData();
    const merged = { ...local };
    const LIST_KEYS = ['appointments', 'clients', 'services', 'employees', 'products', 'sections', 'providers', 'projects', 'movements'];
    LIST_KEYS.forEach(k => {
      if (Array.isArray(cloud[k])) { merged[k] = mergeArray(Array.isArray(local[k]) ? local[k] : [], cloud[k]); }
    });
    if (cloud.settings && typeof cloud.settings === 'object') {
      merged.settings = { ...(local.settings || {}), ...cloud.settings };
    }
    merged.lastModified = Date.now();
    writeData(merged);
  } catch (e) { /* sync error */ }
}

async function resolveJid(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const mapped = phoneJidMap.get(cleanPhone);
  if (mapped) return mapped;
  try {
    if (currentSock && typeof currentSock.onWhatsApp === 'function') {
      const result = await currentSock.onWhatsApp(cleanPhone);
      if (result && result.length > 0 && result[0].exists) {
        addJidMapping(cleanPhone, result[0].jid);
        return result[0].jid;
      }
    }
  } catch {}
  return cleanPhone + '@s.whatsapp.net';
}

async function checkConfirmedAppointments() {
  if (!isConnected || !currentSock) return;
  try {
    const resp = await fetch(SYNC_API_URL);
    if (!resp.ok) return;
    const data = await resp.json();
    const appts = (data.appointments||[]);

    // Confirmaciones de citas nuevas
    for (const appt of appts.filter(a =>
      a.source === 'whatsapp' && !a.pendingSalonConfirm && !a._whatsappConfirmed && !a._deleted && !a.cancelledBy
    )) {
      const client = (data.clients||[]).find(c => c.id === appt.clientId);
      if (!client) continue;
      const jid = await resolveJid(client.phone);
      const svcs = (appt.serviceIds || (appt.serviceId ? [appt.serviceId] : [])).map(sid => ((data.services||[]).find(s => s.id === sid))?.name).filter(Boolean).join(', ') || 'Servicio';
      const empName = ((data.employees||[]).find(e => e.id === appt.employeeId)||{}).name || '';
      try {
        const sent = await currentSock.sendMessage(jid, { text: `✅ Tu cita en Nymara Estilistas ha sido CONFIRMADA:\n\n📅 ${appt.date.split('-').reverse().join('-')}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${svcs}${empName ? '\n👤 '+empName : ''}\n\n¡Te esperamos!` });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        await fetch(SYNC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appointments: [{ ...appt, _whatsappConfirmed: true, _modified: Date.now() }] }) });
      } catch {}
    }

    // Cancelaciones solicitadas por cliente y ACEPTADAS por el salón
    for (const appt of appts.filter(a => a._whatsappCancelledPending && !a._whatsappCancelledSent)) {
      const client = (data.clients||[]).find(c => c.id === appt.clientId);
      if (!client) continue;
      const jid = await resolveJid(client.phone);
      try {
        const sent = await currentSock.sendMessage(jid, { text: `✅ Tu solicitud de cancelación ha sido ACEPTADA. La cita del ${appt.date.split('-').reverse().join('-')} a las ${appt.time} ha sido cancelada.` });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        await fetch(SYNC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appointments: [{ ...appt, _whatsappCancelledSent: true, _modified: Date.now() }] }) });
      } catch {}
    }

    // Cancelaciones solicitadas por cliente y RECHAZADAS por el salón
    for (const appt of appts.filter(a => a._whatsappCancelRejectedPending && !a._whatsappCancelRejectedSent)) {
      const client = (data.clients||[]).find(c => c.id === appt.clientId);
      if (!client) continue;
      const jid = await resolveJid(client.phone);
      try {
        const sent = await currentSock.sendMessage(jid, { text: `ℹ️ Tu solicitud de cancelación ha sido RECHAZADA. La cita del ${appt.date.split('-').reverse().join('-')} a las ${appt.time} sigue activa. Contacta con el salón si necesitas ayuda.` });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        await fetch(SYNC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appointments: [{ ...appt, _whatsappCancelRejectedSent: true, _modified: Date.now() }] }) });
      } catch {}
    }

    // Cancelaciones hechas DIRECTAMENTE por el salón desde la TPV
    for (const appt of appts.filter(a =>
      a.cancelledBy === 'salon' && (a.source === 'whatsapp' || a.source === 'online') && !a._cancelledBySalonSent
    )) {
      const client = (data.clients||[]).find(c => c.id === appt.clientId);
      if (!client) continue;
      const jid = await resolveJid(client.phone);
      const svcIds = appt.serviceIds || (appt.serviceId ? [appt.serviceId] : []);
      const svcNames = svcIds.map(sid => ((data.services||[]).find(s => s.id === sid))?.name).filter(Boolean).join(', ') || 'Servicio';
      try {
        const sent = await currentSock.sendMessage(jid, { text: `❌ Tu cita en Nymara Estilistas ha sido CANCELADA por el salón:\n📅 ${appt.date.split('-').reverse().join('-')}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${svcNames}\n\nSi tienes alguna duda, contacta con nosotros.` });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        await fetch(SYNC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appointments: [{ ...appt, _cancelledBySalonNotified: false, _cancelledBySalonSent: true, _modified: Date.now() }] }) });
      } catch {}
    }
  } catch {}
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[FLY] Fly.io WhatsApp Bridge corriendo en puerto ${PORT}`);
  console.log(`[FLY] QR: http://localhost:${PORT}/qr`);
  console.log(`[FLY] Sync: ${SYNC_API_URL}`);
  start().catch(e => {
    console.error('[FLY FATAL START]', e?.message || e);
    setTimeout(start, RECONNECT_DELAY);
  });
});

syncAllFromCloud();
setInterval(syncAllFromCloud, 600000);
setInterval(checkConfirmedAppointments, 30000);
