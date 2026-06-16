const qrcode = require('qrcode');
const path = require('path');
const pino = require('pino');

const { processWhatsAppMessage } = require('./ai-assistant');
const { loadConversation, clearConversation } = require('./conversation');
const { readData, writeData, mergeArray } = require('./kv-data');

const RECONNECT_DELAY = 15000;

function createBridge(opts = {}) {
  const {
    authDir,
    onQr = () => {},
    onConnection = () => {},
    onError = () => {},
    logger = pino({ level: 'warn' })
  } = opts;

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

  const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
  const SYNC_API_URL = (process.env.SYNC_URL || process.env.VERCEL_SYNC_URL || 'https://nymaraestilistas.es/api').replace(/\/+$/, '') + '/sync';

  // Persistir phoneJidMap a disco para que sobreviva a reconexiones QR
  const fs = require('fs');
  const jidMapFile = path.join(authDir, 'jid-map.json');
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

  async function start() {
    if (stopped) return;
    if (currentSock) {
      try { currentSock.end(); } catch {}
      currentSock = null;
    }
    isConnected = false;
    bridgeState = 'starting';
    onConnection({ connected: false, state: 'starting' });

    let baileysMod;
    try {
      baileysMod = await import('@whiskeysockets/baileys');
    } catch (e) {
      onError('Error al cargar Baileys: ' + e.message);
      setTimeout(start, RECONNECT_DELAY);
      return;
    }

    const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileysMod;

    let state, saveCreds;
    try {
      const auth = await useMultiFileAuthState(authDir);
      state = auth.state;
      saveCreds = auth.saveCreds;
      loadJidMap();
    } catch (e) {
      try {
        const authUtils = await import('@whiskeysockets/baileys/lib/Utils/auth-utils.js');
        const creds = authUtils.initAuthCreds();
        state = { creds, keys: { get: async () => ({}), set: async () => {} } };
        saveCreds = () => {};
      } catch (e2) {
        state = { creds: null, keys: { get: async () => ({}), set: async () => {} } };
        saveCreds = () => {};
      }
    }

    if (!state.creds) {
      onError('No se pudo inicializar autenticación');
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
      onError('Error al crear conexión: ' + e.message);
      setTimeout(start, RECONNECT_DELAY);
      return;
    }
    currentSock = sock;
    bridgeState = 'connecting';
    onConnection({ connected: false, state: 'connecting' });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (stopped) return;
      if (qr) {
        qrcode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
          if (!err) onQr(url);
        });
      }
      if (connection === 'close') {
        isConnected = false;
        bridgeState = 'stopped';
        onConnection({ connected: false, state: 'stopped', error: 'close' });
        const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        if (logout) {
          console.log('[BRIDGE] Sesión cerrada desde el móvil. Limpiando autenticación...');
          onConnection({ connected: false, state: 'stopped', error: 'logged_out' });
          try { require('fs').rmSync(authDir, { recursive: true, force: true }); } catch {}
          try { require('fs').mkdirSync(authDir, { recursive: true }); } catch {}
          if (!stopped) {
            reconnectTimer = setTimeout(start, 2000);
          }
          return;
        }
        if (!stopped) {
          bridgeState = 'connecting';
          onConnection({ connected: false, state: 'connecting', error: 'reconnecting' });
          reconnectTimer = setTimeout(start, RECONNECT_DELAY);
        }
      }
      if (connection === 'open') {
        isConnected = true;
        bridgeState = 'connected';
        const myId = sock.user?.id || 'desconocido';
        const myPhone = myId.split(':')[0].split('@')[0];
        onConnection({ connected: true, state: 'connected', phone: myPhone });
        setTimeout(checkConfirmedAppointments, 2000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || stopped) return;
      for (const m of messages) {
        if (m.key.id && processedIds.has(m.key.id)) continue;
        if (m.key.id) processedIds.add(m.key.id);
        if (m.key.fromMe) {
          if (outgoingMessageIds.has(m.key.id)) {
            outgoingMessageIds.delete(m.key.id);
            continue;
          }
        }
        let jid = m.key.remoteJid || '';
        if (!isNormalChat(jid)) continue;
        const realJid = m.key.remoteJidAlt || jid;
        const phone = realJid.split('@')[0];
        const fullPhone = phone.replace(/[^0-9]/g, '');
        const normPhone = fullPhone.slice(-9);
        addJidMapping(fullPhone, jid);
        addJidMapping(normPhone, jid);
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (!text.trim()) continue;
        if ('+' + phone !== BUSINESS_PHONE) {}
        const trimmed = text.trim();
        const history = await loadConversation('+' + phone);
        const hasHistory = history.length > 0;
        const isTrigger = trimmed === 'Hola Nymara';
        const isGoodbye = trimmed === 'Adios Nymara' || trimmed === 'Bye Nymara';
        if (isGoodbye && currentSock) {
          await clearConversation('+' + phone);
          const sent = await currentSock.sendMessage(jid, { text: '¡Hasta luego! 👋' });
          if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
          continue;
        }
        if (!hasHistory && !isTrigger) continue;
        queueMessage('+' + phone, text, jid);
      }
    });
  }

  async function checkConfirmedAppointments() {
    if (!isConnected || !currentSock || stopped) return;
    try {
      const resp = await fetch(SYNC_API_URL);
      if (!resp.ok) return;
      const data = await resp.json();
      const appts = data.appointments || [];
      for (const appt of appts.filter(a => !a.pendingSalonConfirm && !a._whatsappConfirmed && !a._deleted && !a.cancelledBy)) {
        const client = (data.clients||[]).find(c => c.id === appt.clientId);
        const svcIds = appt.serviceIds || (appt.serviceId ? [appt.serviceId] : []);
        const svcNames = svcIds.map(sid => ((data.services||[]).find(s => s.id === sid))?.name).filter(Boolean).join(', ') || 'Servicio';
        const empName = ((data.employees||[]).find(e => e.id === appt.employeeId)||{}).name || '';
        await sendApptNotification(appt, data, {
          text: `✅ Tu cita ha sido CONFIRMADA:\n\n📅 ${appt.date.split('-').reverse().join('-')}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${svcNames}${empName ? '\n👤 '+empName : ''}${client ? '\n👤 Cliente: '+client.name : ''}\n\n¡Te esperamos!`,
          clearFlag: '_whatsappConfirmed', setFlag: '_whatsappConfirmed'
        });
      }
      for (const appt of appts.filter(a => a._whatsappCancelledPending && !a._whatsappCancelledSent)) {
        await sendApptNotification(appt, data, {
          text: '✅ Cancelación ACEPTADA',
          clearFlag: '_whatsappCancelledPending', setFlag: '_whatsappCancelledSent'
        });
      }
      for (const appt of appts.filter(a => a._whatsappCancelRejectedPending && !a._whatsappCancelRejectedSent)) {
        await sendApptNotification(appt, data, {
          text: 'ℹ️ Cancelación RECHAZADA',
          clearFlag: '_whatsappCancelRejectedPending', setFlag: '_whatsappCancelRejectedSent'
        });
      }
      for (const appt of appts.filter(a => a.cancelledBy === 'salon' && (a.source === 'whatsapp' || a.source === 'online') && !a._cancelledBySalonSent)) {
        await sendApptNotification(appt, data, {
          text: '❌ Cita CANCELADA por el salón',
          clearFlag: '_cancelledBySalonNotified', setFlag: '_cancelledBySalonSent'
        });
      }
    } catch {}
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

  async function sendApptNotification(appt, data, opts) {
    const client = (data.clients||[]).find(c => c.id === appt.clientId);
    if (!client) return;
    const jid = await resolveJid(client.phone);
    try {
      await currentSock.sendMessage(jid, { text: opts.text });
      await fetch(SYNC_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointments: [{ ...appt, [opts.clearFlag]: false, [opts.setFlag]: true, _modified: Date.now() }] })
      });
    } catch {}
  }

  async function syncAllFromCloud() {
    if (stopped) return;
    try {
      const resp = await fetch(SYNC_API_URL);
      if (!resp.ok) return;
      const cloud = await resp.json();
      if (!cloud.clients?.length && !cloud.services?.length && !cloud.appointments?.length) return;
      const local = readData();
      const merged = { ...local };
      ['appointments','clients','services','employees','products','sections','providers'].forEach(k => {
        if (Array.isArray(cloud[k])) merged[k] = mergeArray(Array.isArray(local[k]) ? local[k] : [], cloud[k]);
      });
      if (cloud.settings && typeof cloud.settings === 'object')
        merged.settings = { ...(local.settings || {}), ...cloud.settings };
      merged.lastModified = Date.now();
      writeData(merged);
    } catch {}
  }

  function isNormalChat(jid) {
    if (!jid) return false;
    if (jid.includes('@g.us')) return false;
    if (jid.includes('@broadcast')) return false;
    return true;
  }

  async function processQueue() {
    if (queueProcessing || messageQueue.length === 0 || stopped) return;
    queueProcessing = true;
    while (messageQueue.length > 0) {
      const item = messageQueue.shift();
      try {
        const reply = await processWhatsAppMessage(item.phone, item.text);
        if (item.jid && currentSock) {
          const sent = await currentSock.sendMessage(item.jid, { text: reply });
          if (sent?.key?.id) outgoingMessageIds.add(sent.key.id);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 3000));
    }
    queueProcessing = false;
  }

  function queueMessage(phone, text, jid) {
    messageQueue.push({ phone, text, jid });
    processQueue();
  }

  function sendMessage(phone, text) {
    if (!currentSock || !isConnected) return Promise.resolve({ sent: false, error: 'No conectado' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const mappedJid = phoneJidMap.get(cleanPhone);
    const jid = mappedJid || (phone.includes('@') ? phone : cleanPhone + '@s.whatsapp.net');
    console.log(`[SEND] Enviando a ${cleanPhone} via ${jid}: ${text.slice(0,50)}`);
    return currentSock.sendMessage(jid, { text }).then(() => ({ sent: true })).catch(e => ({ sent: false, error: e.message }));
  }

  function getStatus() {
    return { connected: isConnected, state: bridgeState, phone: currentSock?.user?.id?.split(':')[0]?.split('@')[0] || '' };
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
    isConnected = false; bridgeState = 'stopped';
    onConnection({ connected: false, state: 'stopped' });
  }

  setInterval(() => {
    if (processedIds.size > 1000) processedIds = new Set();
    if (outgoingMessageIds.size > 500) outgoingMessageIds = new Set();
  }, 60000);

  setTimeout(syncAllFromCloud, 5000);
  setInterval(syncAllFromCloud, 300000);
  setInterval(checkConfirmedAppointments, 10000);

  start().catch(e => onError(e.message));

  return { stop, getStatus, sendMessage };
}

module.exports = { createBridge };