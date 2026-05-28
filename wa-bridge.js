const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const path = require('path');
const pino = require('pino');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const logger = pino({ level: 'warn' });

const AUTH_DIR = path.join(__dirname, 'wa_auth');
const RECONNECT_DELAY = 15000;

let currentSock = null;
let processing = false;
let processedIds = new Set();
const messageQueue = [];
let queueProcessing = false;

const { processWhatsAppMessage } = require('./lib/ai-assistant');
const { loadConversation, clearConversation } = require('./lib/conversation');

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
        await currentSock.sendMessage(item.jid, { text: reply });
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
    messageQueue.shift();
  }
  queueProcessing = false;
}

function queueMessage(phone, text, jid) {
  messageQueue.push({ phone, text, jid });
  processQueue();
}

setInterval(() => {
  if (processedIds.size > 1000) processedIds = new Set();
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
      const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (logout) { console.log('Sesión cerrada. Elimina wa_auth/ y ejecuta de nuevo.'); return; }
      processing = false;
      console.log('Reconectando en ' + (RECONNECT_DELAY/1000) + 's...');
      setTimeout(start, RECONNECT_DELAY);
    }
    if (connection === 'open') {
      console.log(' WhatsApp conectado como asistente AI');
      processing = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    let delay = 0;
    for (const m of messages) {
      if (m.key.id && processedIds.has(m.key.id)) continue;
      if (m.key.id) processedIds.add(m.key.id);

      let jid = m.key.remoteJid || '';
      if (!isNormalChat(jid)) continue;

      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (!text.trim()) continue;

      const phone = jid.split('@')[0];

      const normalized = text.trim().toLowerCase();
      const history = await loadConversation('+' + phone);
      const hasHistory = history.length > 0;
      const isTrigger = normalized === 'hola nymara' || normalized.startsWith('hola nymara');
      const isGoodbye = normalized === 'adios nymara' || normalized.startsWith('adios nymara');
      if (isGoodbye && currentSock) {
        console.log(` [BYE] ${phone}: "${text.slice(0,40)}"`);
        await clearConversation('+' + phone);
        await currentSock.sendMessage(jid, { text: '¡Hasta luego! 👋 Si necesitas algo, aquí estaré. ¡Cuídate!' });
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
