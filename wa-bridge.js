const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const path = require('path');
const http = require('http');
const pino = require('pino');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const logger = pino({ level: 'warn' });

const AUTH_DIR = path.join(__dirname, 'wa_auth');
const RECONNECT_DELAY = 15000;

let currentSock = null;
let isConnected = false;
let processing = false;
let processedIds = new Set();
const messageQueue = [];
let queueProcessing = false;
const phoneJidMap = new Map(); // teléfono (sin +) → jid real (ej: 34678092305 → 58300003553300@lid)
let outgoingMessageIds = new Set(); // IDs de mensajes enviados por el bot (para evitar bucles)

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

const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';

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

async function start() {
  if (currentSock) {
    try { currentSock.end(); } catch {}
    currentSock = null;
  }
  processing = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const uid = Math.random().toString(36).substr(2,8);
  const sock = makeWASocket({ printQRInTerminal: false, auth: state, syncFullHistory: false, browser: ['WhatsApp/2.24.10', 'Windows', '10.0', uid], logger });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscanea este código QR con WhatsApp (Ajustes > Dispositivos vinculados):');
      qrcode.generate(qr, { small: true });
      qrcodeImg.toFile(path.join(__dirname, 'qr.png'), qr, { width: 400, margin: 2 }, () => {});
      console.log('QR guardado como qr.png');
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
      // Revisar citas confirmadas inmediatamente al conectar
      setTimeout(checkConfirmedAppointments, 2000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
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

      console.log(` [DEBUG] JID=${jid} | realJid=${realJid} -> phone=${phone} -> +${phone}`);
      console.log(` [DEBUG] BUSINESS_PHONE=${BUSINESS_PHONE}`);
      if ('+' + phone !== BUSINESS_PHONE) {
        console.log(` [WARN] El teléfono del WhatsApp (+${phone}) NO coincide con BUSINESS_PHONE (${BUSINESS_PHONE}). Borra wa_auth/ y escanea con el número correcto.`);
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

console.log(' Iniciando bridge WhatsApp...');
start().catch(e => {
  console.error('FATAL', e);
  console.log('Reconectando en ' + (RECONNECT_DELAY/1000) + 's...');
  setTimeout(start, RECONNECT_DELAY);
});

// Servidor HTTP local para que el TPV envíe WhatsApps a través del bridge
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT) || 3457;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const server = http.createServer((req, res) => {
  console.log(` [BRIDGE-HTTP] ${req.method} ${req.url}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const setCors = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && (req.url === '/send' || req.url === '/api/send')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { phone, text } = JSON.parse(body);
        if (!phone || !text) {
          setCors(400, { error: 'phone and text required' });
          return;
        }
        if (!currentSock) {
          setCors(503, { error: 'Bridge no conectado' });
          return;
        }
        const jid = phone.includes('@') ? phone : phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        currentSock.sendMessage(jid, { text }).then(sent => {
          if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
          console.log(` [BRIDGE-SEND] Enviado a ${phone}: ${text.slice(0,60)}`);
          setCors(200, { sent: true });
        }).catch(e => {
          console.error(` [BRIDGE-SEND] Error enviando a ${phone}:`, e.message);
          setCors(500, { error: e.message });
        });
      } catch (e) {
        setCors(400, { error: e.message });
      }
    });
  } else if (req.method === 'GET' && (req.url === '/ping' || req.url === '/api/ping')) {
    setCors(200, { ok: true, connected: !!currentSock });
  } else {
    setCors(404, { error: 'not found' });
  }
});
server.on('error', e => {
  console.error(` [BRIDGE-HTTP] Error al iniciar servidor en puerto ${BRIDGE_PORT}: ${e.message}`);
});
server.listen(BRIDGE_PORT, () => {
  console.log(` Bridge HTTP server escuchando en http://localhost:${BRIDGE_PORT}`);
});

// Sincronizar datos desde la nube MERGEANDO con local (no sobrescribir)
const SYNC_API_URL = (process.env.VERCEL_SYNC_URL || 'https://nymaraestilistas.es/api').replace(/\/+$/, '') + '/sync';
async function syncAllFromCloud() {
  try {
    const resp = await fetch(SYNC_API_URL);
    if (!resp.ok) { console.log('[SYNC] Error fetching from cloud:', resp.status); return; }
    const cloud = await resp.json();
    const hasData = (cloud.clients && cloud.clients.length) || (cloud.services && cloud.services.length) || (cloud.appointments && cloud.appointments.length);
    if (!hasData) { console.log('[SYNC] Cloud data is empty, skipping local write'); return; }
    const local = readData();
    const merged = { ...local };
    const LIST_KEYS = ['appointments', 'clients', 'services', 'employees', 'products', 'sections', 'providers', 'projects', 'movements'];
    LIST_KEYS.forEach(k => {
      if (Array.isArray(cloud[k])) {
        merged[k] = mergeArray(Array.isArray(local[k]) ? local[k] : [], cloud[k]);
      }
    });
    if (cloud.settings && typeof cloud.settings === 'object') {
      merged.settings = { ...(local.settings || {}), ...cloud.settings };
    }
    merged.lastModified = Date.now();
    writeData(merged);
    console.log('[SYNC] Cloud merged into local: ' +
      (merged.appointments||[]).length + ' appointments, ' +
      (merged.clients||[]).length + ' clients');
  } catch (e) { console.log('[SYNC] Error syncing from cloud:', e.message); }
}
// Sincronizar al arrancar y cada 5 minutos
syncAllFromCloud();
setInterval(syncAllFromCloud, 300000);

// Polling para detectar citas WhatsApp y enviar notificaciones
async function checkConfirmedAppointments() {
  if (!isConnected || !currentSock) return;
  try {
    const resp = await fetch(SYNC_API_URL);
    if (!resp.ok) return;
    const data = await resp.json();
    const appts = (data.appointments||[]);

    // Confirmaciones de citas nuevas
    for (const appt of appts.filter(a =>
      a.source === 'whatsapp' && !a.pendingSalonConfirm && !a._whatsappConfirmed && !a._deleted
    )) {
      await sendApptNotification(appt, data, {
        text: `✅ Tu cita en Nymara Estilistas ha sido CONFIRMADA:\n\n📅 ${appt.date.split('-').reverse().join('-')}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${((data.services||[]).find(s=>s.id===(appt.serviceId||''))||{}).name||'Servicio'}\n👤 ${((data.employees||[]).find(e=>e.id===appt.employeeId)||{}).name||''}\n\n¡Te esperamos!`,
        clearFlag: '_whatsappConfirmed',
        setFlag: '_whatsappConfirmed'
      });
    }

    // Cancelaciones ACEPTADAS por el salón
    for (const appt of appts.filter(a => a._whatsappCancelledPending && !a._whatsappCancelledSent)) {
      await sendApptNotification(appt, data, {
        text: `✅ Tu solicitud de cancelación ha sido ACEPTADA. La cita del ${appt.date.split('-').reverse().join('-')} a las ${appt.time} ha sido cancelada.`,
        clearFlag: '_whatsappCancelledPending',
        setFlag: '_whatsappCancelledSent'
      });
    }

    // Cancelaciones RECHAZADAS por el salón
    for (const appt of appts.filter(a => a._whatsappCancelRejectedPending && !a._whatsappCancelRejectedSent)) {
      await sendApptNotification(appt, data, {
        text: `ℹ️ Tu solicitud de cancelación ha sido RECHAZADA. La cita del ${appt.date.split('-').reverse().join('-')} a las ${appt.time} sigue activa. Si necesitas ayuda, contacta con el salón.`,
        clearFlag: '_whatsappCancelRejectedPending',
        setFlag: '_whatsappCancelRejectedSent'
      });
    }
  } catch (e) { /* ignore polling errors */ }
}

async function sendApptNotification(appt, data, opts) {
  const client = (data.clients||[]).find(c => c.id === appt.clientId);
  if (!client) return;
  const cleanPhone = client.phone.replace(/[^0-9]/g, '');
  const mappedJid = phoneJidMap.get(cleanPhone);
  const jid = mappedJid || cleanPhone + '@s.whatsapp.net';
  console.log(` [AUTO-NOTIF] Intentando enviar a ${client.phone}: jid=${jid}`);
  try {
    const sent = await currentSock.sendMessage(jid, { text: opts.text });
    if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
    console.log(` [AUTO-NOTIF] Enviado OK a ${client.phone} para cita ${appt.date} ${appt.time}`);
    await fetch(SYNC_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointments: [{ ...appt, [opts.clearFlag]: false, [opts.setFlag]: true, _modified: Date.now() }] })
    });
  } catch (e) {
    console.error(` [AUTO-NOTIF] Error enviando a ${client.phone}: ${e.message}`);
  }
}
setInterval(checkConfirmedAppointments, 10000);
console.log(' Polling de citas confirmadas cada 10s');
