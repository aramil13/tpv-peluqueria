const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const http = require('http');
const https = require('https');
const path = require('path');
const pino = require('pino');

const logger = pino({ level: 'warn' });

const AUTH_DIR = path.join(__dirname, 'wa_auth');
const API_URL = process.env.AI_API_URL || 'http://localhost:3456/api/ai-message';
const RECONNECT_DELAY = 15000;

let currentSock = null;
let processing = false;
let processedIds = new Set();

setInterval(() => {
  if (processedIds.size > 1000) processedIds = new Set();
}, 60000);

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', port: u.port,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => {
        try { resolve(JSON.parse(r)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
      if (m.key.fromMe && (text.startsWith(' Sara') || text.startsWith('Lo siento'))) continue;

      const phone = m.key.fromMe
        ? (sock.user?.id?.split(':')[0] || jid.split('@')[0])
        : jid.split('@')[0];

      console.log(` ${m.key.fromMe ? '[SELF]' : '[IN]'} ${phone}: ${text.slice(0, 60)}`);
      await new Promise(r => setTimeout(r, delay));
      delay = 1500;

      const data = await postJSON(API_URL, { phone: '+' + phone, text });
      const reply = data?.response || 'Lo siento, no pude procesar tu mensaje.';

      try {
        await sock.sendMessage(jid, { text: reply });
        console.log(` [OUT] ${phone}: ${reply.slice(0, 60)}`);
      } catch (e) {
        console.log(` [SEND FAIL] ${e.message}`);
      }
    }
  });
}

console.log(' Iniciando bridge WhatsApp...');
start().catch(e => console.error('FATAL', e));
