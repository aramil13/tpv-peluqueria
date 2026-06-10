const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const path = require('path');
const http = require('http');
const pino = require('pino');

const fs = require('fs');
try { require('dotenv').config({ path: require('path').join(__dirname, '.env.local') }); } catch (e) { /* Render usa env vars del dashboard */ }
const logger = pino({ level: 'warn' });
let DATA_DIR = process.env.DATA_DIR || '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
  console.log('[RENDER] No se pudo crear ' + DATA_DIR + ' (' + e.message + '). Usando /tmp en su lugar.');
  DATA_DIR = '/tmp';
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e2) {
    console.log('[RENDER] Tampoco /tmp funciona. Usando directorio local.');
    DATA_DIR = __dirname;
  }
}
process.env.DATA_DIR = DATA_DIR;
const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const RECONNECT_DELAY = 15000;

let currentSock = null;
let isConnected = false;
let processing = false;
let processedIds = new Set();
const messageQueue = [];
let queueProcessing = false;
const phoneJidMap = new Map();
let outgoingMessageIds = new Set();

const { processWhatsAppMessage } = require('./lib/ai-assistant');
const { loadConversation, clearConversation } = require('./lib/conversation');
const { readData, writeData, mergeArray } = require('./lib/kv-data');

const useDeepSeek = !!process.env.DEEPSEEK_API_KEY;
const useGroq = !!process.env.GROQ_API_KEY;
const useGemini = !!process.env.GEMINI_API_KEY;
const vercelUrl = process.env.VERCEL_SYNC_URL || '';
let aiMode = 'Ninguna';
if (useDeepSeek) aiMode = 'DeepSeek';
else if (useGroq) aiMode = 'Groq';
else if (useGemini) aiMode = 'Gemini';
console.log('AI: DeepSeek='+useDeepSeek+', Groq='+useGroq+', Gemini='+useGemini+' → '+aiMode);
console.log('VERCEL SYNC: '+(vercelUrl ? vercelUrl : 'NO CONFIGURADO'));
console.log('DATA_DIR:', DATA_DIR);
console.log('AUTH_DIR:', AUTH_DIR);
console.log('CONV_DIR:', CONV_DIR);

const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'tpv-secret-2026';
let bridgeEnabled = true; // Control remoto desde el EXE

async function processQueue() {
  if (queueProcessing || messageQueue.length === 0) return;
  queueProcessing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    try {
      const reply = await processWhatsAppMessage(item.phone, item.text);
      if (item.jid && currentSock) {
        const sent = await currentSock.sendMessage(item.jid, { text: reply });
        if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        console.log(` [OUT] ${item.phone.replace('+','')}: ${reply.slice(0, 60)}`);
      }
    } catch (e) {
      console.error('[QUEUE ERROR]', e.message);
      if (item.jid && currentSock) {
        try {
          await currentSock.sendMessage(item.jid, { text: 'Lo siento, hubo un error. Inténtalo de nuevo.' });
        } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  queueProcessing = false;
}

function queueMessage(phone, text, jid) {
  messageQueue.push({ phone, text, jid });
  processQueue();
}

setInterval(() => {
  if (processedIds.size > 1000) processedIds = new Set();
  if (outgoingMessageIds.size > 500) outgoingMessageIds = new Set();
}, 60000);

function isNormalChat(jid) {
  if (!jid) return false;
  if (jid.includes('@g.us')) return false;
  if (jid.includes('@broadcast')) return false;
  return true;
}

process.on('SIGTERM', () => {
  console.log('[RENDER-BRIDGE] SIGTERM recibido, cerrando conexiones...');
  if (currentSock) { try { currentSock.end(); } catch {} }
  process.exit(0);
});

async function start() {
  if (currentSock) {
    try { currentSock.end(); } catch {}
    currentSock = null;
  }
  processing = false;

  const hasCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  console.log('[AUTH] Sesión guardada:', hasCreds ? 'SI' : 'NO (se generará QR)');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    syncFullHistory: false,
    browser: ['Chrome', 'Windows', '10.0.0'],
    logger,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[QR GENERADO] Escanea con WhatsApp (Ajustes > Dispositivos vinculados):');
      qrcode.generate(qr, { small: true });
      qrcodeImg.toFile(path.join(DATA_DIR, 'qr.png'), qr, { width: 400, margin: 2, errorCorrectionLevel: 'L' }, () => {
        console.log(' [QR] Guardado en ' + path.join(DATA_DIR, 'qr.png'));
      });
    }
    if (connection === 'close') {
      isConnected = false;
      const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (logout) { console.log('Sesión cerrada. Elimina wa_auth/ y ejecuta de nuevo.'); return; }
      processing = false;
      console.log('Reconectando en ' + (RECONNECT_DELAY/1000) + 's...');
      setTimeout(start, RECONNECT_DELAY);
    }
    if (connection === 'open') {
      isConnected = true;
      const myId = sock.user?.id || 'desconocido';
      console.log(' WhatsApp conectado como asistente AI');
      console.log(' [CONECTADO COMO] ' + myId);
      processing = false;
      setTimeout(checkConfirmedAppointments, 2000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (!bridgeEnabled) { console.log(' [SKIP] Bridge desactivado por el EXE'); return; }
    let delay = 0;
    for (const m of messages) {
      if (m.key.id && processedIds.has(m.key.id)) continue;
      if (m.key.id) processedIds.add(m.key.id);

      if (m.key.fromMe) {
        if (outgoingMessageIds.has(m.key.id)) {
          outgoingMessageIds.delete(m.key.id);
          console.log(' [SKIP] mensaje enviado por el bot vía bridge (fromMe + ID conocido), ignorando');
          continue;
        }
        console.log(' [PROCESS-SELF] mensaje desde el propio teléfono, procesando');
      }

      let jid = m.key.remoteJid || '';
      if (!isNormalChat(jid)) continue;

      const realJid = m.key.remoteJidAlt || jid;
      const phone = realJid.split('@')[0];
      const normPhone = phone.replace(/[^0-9]/g, '').slice(-9);
      const fullPhone = phone.replace(/[^0-9]/g, '');

      phoneJidMap.set(fullPhone, jid);
      phoneJidMap.set(normPhone, jid);
      console.log(` [MAP] ${fullPhone} / ${normPhone} → ${jid}`);

      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (!text.trim()) continue;

      console.log(` [DEBUG] JID=${jid} | phone=${phone}`);
      if ('+' + phone !== BUSINESS_PHONE) {
        console.log(` [WARN] El teléfono del WhatsApp (+${phone}) NO coincide con BUSINESS_PHONE (${BUSINESS_PHONE}).`);
      }

      const normalized = text.trim().toLowerCase();
      const history = await loadConversation('+' + phone);
      const hasHistory = history.length > 0;
      const isTrigger = normalized === 'hola nymara';
      const isGoodbye = normalized === 'adios nymara' || normalized === 'bye nymara';
      if (isGoodbye && currentSock) {
        console.log(` [BYE] ${phone}: "${text.slice(0,40)}"`);
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
      delay = 1500;
      queueMessage('+' + phone, text, jid);
    }
  });
}

const PORT = parseInt(process.env.PORT) || 3457;
const server = http.createServer((req, res) => {
  const setJson = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health' || req.url === '/ping')) {
      setJson(200, { ok: true, connected: !!currentSock, uptime: process.uptime() });
      return;
    }
    if (req.method === 'GET' && req.url === '/qr') {
      const qrPath = path.join(DATA_DIR, 'qr.png');
      if (fs.existsSync(qrPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(fs.readFileSync(qrPath));
      } else {
        setJson(404, { error: 'QR no disponible. Espera a que se genere (puede tardar unos segundos).' });
      }
      return;
    }
    if (req.method === 'POST' && (req.url === '/disable' || req.url === '/enable')) {
      const isEnable = req.url === '/enable';
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { key } = JSON.parse(body || '{}');
          if (key !== BRIDGE_API_KEY) { setJson(403, { error: 'API key incorrecta' }); return; }
          bridgeEnabled = isEnable;
          console.log('[BRIDGE] ' + (isEnable ? 'ACTIVADO' : 'DESACTIVADO') + ' por el EXE');
          setJson(200, { ok: true, enabled: bridgeEnabled });
        } catch (e) { setJson(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { phone, text } = JSON.parse(body);
          if (!phone || !text) { setJson(400, { error: 'phone and text required' }); return; }
          if (!currentSock) { setJson(503, { error: 'Bridge no conectado' }); return; }
          const jid = phone.includes('@') ? phone : phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          currentSock.sendMessage(jid, { text }).then(sent => {
            if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
            setJson(200, { sent: true });
          }).catch(e => setJson(500, { error: e.message }));
        } catch (e) { setJson(400, { error: e.message }); }
      });
      return;
    }
    setJson(404, { error: 'not found' });
  } catch (e) {
    console.error('[HTTP ERROR]', e.message);
    try { res.writeHead(500); res.end('Internal error'); } catch {}
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(` Bridge HTTP server en puerto ${PORT}`);
});

console.log(' Iniciando bridge WhatsApp en Render...');
start().catch(e => {
  console.error('[FATAL START]', e?.message || e);
  setTimeout(start, RECONNECT_DELAY);
});

const SYNC_API_URL = (process.env.VERCEL_SYNC_URL || 'https://nymaraestilistas.es/api').replace(/\/+$/, '') + '/sync';
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
    console.log('[SYNC] Cloud merged:',
      (merged.appointments||[]).length + ' appts, ' + (merged.clients||[]).length + ' clients');
  } catch (e) { console.log('[SYNC] Error:', e.message); }
}
syncAllFromCloud();
setInterval(syncAllFromCloud, 300000);

async function checkConfirmedAppointments() {
  if (!isConnected || !currentSock) return;
  try {
    const resp = await fetch(SYNC_API_URL);
    if (!resp.ok) return;
    const data = await resp.json();
    const appts = (data.appointments||[]);
    for (const appt of appts.filter(a => a.source === 'whatsapp' && !a.pendingSalonConfirm && !a._whatsappConfirmed && !a._deleted)) {
      await sendNotif(appt, data, {
        text: `Tu cita ha sido CONFIRMADA:\n📅 ${appt.date.split('-').reverse().join('-')}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${((data.services||[]).find(s=>s.id===(appt.serviceId||''))||{}).name||'Servicio'}\n¡Te esperamos!`,
        clearFlag: '_whatsappConfirmed', setFlag: '_whatsappConfirmed'
      });
    }
    for (const appt of appts.filter(a => a._whatsappCancelledPending && !a._whatsappCancelledSent)) {
      await sendNotif(appt, data, { text: 'Cancelación ACEPTADA.', clearFlag: '_whatsappCancelledPending', setFlag: '_whatsappCancelledSent' });
    }
    for (const appt of appts.filter(a => a._whatsappCancelRejectedPending && !a._whatsappCancelRejectedSent)) {
      await sendNotif(appt, data, { text: 'Cancelación RECHAZADA. La cita sigue activa.', clearFlag: '_whatsappCancelRejectedPending', setFlag: '_whatsappCancelRejectedSent' });
    }
  } catch {}
}
async function sendNotif(appt, data, opts) {
  const client = (data.clients||[]).find(c => c.id === appt.clientId);
  if (!client) return;
  const cleanPhone = client.phone.replace(/[^0-9]/g, '');
  const jid = phoneJidMap.get(cleanPhone) || cleanPhone + '@s.whatsapp.net';
  try {
    const sent = await currentSock.sendMessage(jid, { text: opts.text });
    if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
    await fetch(SYNC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appointments: [{ ...appt, [opts.clearFlag]: false, [opts.setFlag]: true, _modified: Date.now() }] }) });
  } catch {}
}
setInterval(checkConfirmedAppointments, 10000);
console.log(' Polling cada 10s');
