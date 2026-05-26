const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const https = require('https');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'wa_auth');
const API_URL = 'https://nymaraestilistas.es/api/ai-message';

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ printQRInTerminal: false, auth: state, syncFullHistory: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscanea este código QR con WhatsApp (Ajustes > Dispositivos vinculados):');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (logout) { console.log('Sesión cerrada. Elimina wa_auth/ y ejecuta de nuevo.'); return; }
      console.log('Reconectando en 3s...');
      setTimeout(start, 3000);
    }
    if (connection === 'open') console.log(' WhatsApp conectado como asistente AI');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const jid = m.key.remoteJid || '';
      if (!jid.endsWith('@s.whatsapp.net') || jid.includes('@g.us')) continue;

      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (!text.trim()) continue;

      const phone = jid.split('@')[0];
      console.log(` [IN] ${phone}: ${text.slice(0, 60)}`);

      try {
        await sock.sendMessage(jid, { text: ' Sara está pensando...' });
        const data = await postJSON(API_URL, { phone: '+' + phone, text });
        const reply = data.response || 'Lo siento, no pude procesar tu mensaje.';
        await sock.sendMessage(jid, { text: reply });
        console.log(` [OUT] ${phone}: ${reply.slice(0, 60)}`);
      } catch (e) {
        console.error('[BRIDGE]', e.message);
        await sock.sendMessage(jid, { text: 'Lo siento, hubo un error. Intenta de nuevo.' });
      }
    }
  });
}

console.log(' Iniciando bridge WhatsApp...');
start().catch(e => console.error('FATAL', e));
